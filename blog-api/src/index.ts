/**
 * blog-api — Cloudflare Worker
 *
 * Post routes:
 *   GET    /api/posts           — list all posts
 *   GET    /api/posts/:slug     — get single post
 *   POST   /api/posts           — create post (admin)
 *   PUT    /api/posts/:slug     — update post (admin)
 *   DELETE /api/posts/:slug     — delete post (admin)
 *
 * Auth routes:
 *   POST   /api/auth/signup     — register (email + password + optional nickname)
 *   POST   /api/auth/login      — login, returns JWT
 *   GET    /api/auth/me         — get current user (Bearer token)
 *   POST   /api/auth/avatar     — upload profile image (auth required)
 *   GET    /api/auth/my-likes   — list posts liked by current user
 *
 * Comment routes:
 *   GET    /api/comments/:slug      — list comments for post
 *   POST   /api/comments/:slug      — add comment (auth required)
 *   DELETE /api/comments/id/:id     — delete comment (own or admin)
 *
 * Like routes:
 *   GET    /api/likes/:slug     — like count + whether current user liked
 *   POST   /api/likes/:slug     — toggle like (auth required)
 *
 * Secrets: GITHUB_TOKEN, ADMIN_PASSWORD, JWT_SECRET
 * D1 binding: DB
 */

export interface Env {
  GITHUB_TOKEN: string;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
  DB: D1Database;
  ADMIN_EMAIL?: string;
  ADMIN_LOGIN_EMAILS?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  CONTENT_BACKEND?: string;
  UPLOADS?: { put(file: File, request: Request): Promise<string> };
  COMMENT_BLOCKLIST?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGIN = 'https://xmin.blog';
const SITE = 'https://xmin.blog';
const CONTENT_PATH = 'src/content/blog';
const JWT_EXPIRY_SECS = 60 * 60 * 24 * 7; // 7 days
const DEFAULT_ADMIN_EMAIL = 'admin@xmin.blog';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function adminPrimaryEmail(env: Env): string {
  return normalizeEmail(env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL);
}

function adminLoginEmails(env: Env): string[] {
  const emails = [
    adminPrimaryEmail(env),
    DEFAULT_ADMIN_EMAIL,
    ...(env.ADMIN_LOGIN_EMAILS || '').split(','),
  ]
    .map(email => normalizeEmail(email))
    .filter(Boolean);
  return Array.from(new Set(emails));
}

function isAdminLoginEmail(email: string, env: Env): boolean {
  return adminLoginEmails(env).includes(normalizeEmail(email));
}

function commentBlocklist(env: Env): string[] {
  return (env.COMMENT_BLOCKLIST || '')
    .split(',')
    .map(term => term.trim().toLowerCase())
    .filter(Boolean);
}

function blockedCommentTerm(content: string, env: Env): string | null {
  const normalized = content.toLowerCase().normalize('NFKC');
  return commentBlocklist(env).find(term => normalized.includes(term.normalize('NFKC'))) || null;
}

// Best-effort in-memory throttling. This is intentionally local-process/local-isolate
// only; put nginx/Cloudflare rate limiting in front of the home server for hard limits.
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

// ─── CORS ─────────────────────────────────────────────────────────────────────

function corsHeaders(origin: string | null): Record<string, string> {
  const isLocalDevOrigin = !!origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  const allowed =
    origin === ALLOWED_ORIGIN || isLocalDevOrigin ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function xml(data: string, contentType: string, origin: string | null = null): Response {
  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': `${contentType}; charset=utf-8`,
      'Cache-Control': 'public, max-age=300',
      ...corsHeaders(origin),
    },
  });
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip')
    || request.headers.get('x-real-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown'
  );
}

function rateLimit(request: Request, bucket: string, limit: number, windowSecs: number, origin: string | null): Response | null {
  const now = Date.now();
  const key = `${bucket}:${clientIp(request)}`;
  const current = rateLimitBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowSecs * 1000 });
    return null;
  }
  current.count += 1;
  if (current.count > limit) {
    return json({ error: 'Too many requests' }, 429, origin);
  }
  return null;
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** PBKDF2-SHA256 password hash: returns "saltHex:hashHex" */
async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 10000, hash: 'SHA-256' }, key, 256,
  );
  const toHex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return `${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 10000, hash: 'SHA-256' }, key, 256,
  );
  const toHex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  const computed = toHex(new Uint8Array(bits));
  if (computed.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

/** Legacy admin password check (SHA-256 of raw password) */
async function verifyAdminPassword(provided: string, env: Env): Promise<boolean> {
  if (!provided) return false;
  const hash = await sha256hex(provided);
  const expected = await sha256hex(env.ADMIN_PASSWORD);
  if (hash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): string {
  return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
}

interface JWTPayload {
  sub: number;   // user id
  email: string;
  role: string;
  exp: number;
}

async function signJWT(payload: JWTPayload, secret: string): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const msg = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return `${msg}.${b64url(sig)}`;
}

async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sigB64] = parts;
    const msg = `${header}.${body}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const sigBytes = Uint8Array.from(b64urlDecode(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(msg));
    if (!valid) return null;
    const payload = JSON.parse(b64urlDecode(body)) as JWTPayload;
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function getAuthUser(request: Request, env: Env): Promise<JWTPayload | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return verifyJWT(auth.slice(7), env.JWT_SECRET);
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

interface GHFile { sha: string; content: string; encoding: string; }
interface GHTreeItem { path: string; type: string; sha: string; }

function b64DecodeUnicode(str: string): string {
  const binary = atob(str.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function githubConfig(env: Env) {
  return {
    owner: env.GITHUB_OWNER ?? 'xmin-02',
    repo: env.GITHUB_REPO ?? 'xminblog',
    branch: env.GITHUB_BRANCH ?? 'main',
    token: env.GITHUB_TOKEN,
  };
}

async function ghGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'blog-api-worker',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET /${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function ghPut(path: string, body: unknown, token: string): Promise<Response> {
  return fetch(`https://api.github.com/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'blog-api-worker',
    },
    body: JSON.stringify(body),
  });
}

async function ghDelete(path: string, body: unknown, token: string): Promise<Response> {
  return fetch(`https://api.github.com/${path}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'blog-api-worker',
    },
    body: JSON.stringify(body),
  });
}

// ─── Frontmatter helpers ──────────────────────────────────────────────────────

interface PostMeta {
  title: string; description: string; date: string;
  category: string; tags: string[]; draft: boolean;
  cover?: string;
  is_private?: boolean;
  password_hash?: string;
}
interface PostPayload extends PostMeta { content: string; password: string; private_password?: string; }

function buildMarkdown(meta: PostMeta, body: string): string {
  const tags = meta.tags.length
    ? `\ntags: [${meta.tags.map(t => `"${t}"`).join(', ')}]`
    : '\ntags: []';
  const cover = meta.cover ? `\ncover: "${meta.cover.replace(/"/g, '\\"')}"` : '';
  const privateFields = meta.is_private
    ? `\nis_private: true${meta.password_hash ? `\npassword_hash: "${meta.password_hash.replace(/"/g, '\\"')}"` : ''}`
    : '';
  return `---
title: "${meta.title.replace(/"/g, '\\"')}"
description: "${meta.description.replace(/"/g, '\\"')}"
date: ${meta.date}
category: "${meta.category.replace(/"/g, '\\"')}"${tags}
draft: ${meta.draft}${cover}${privateFields}
---

${body.trimStart()}
`;
}

function parseFrontmatter(raw: string): { meta: Partial<PostMeta>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const fm = match[1];
  const body = match[2].trimStart();
  const meta: Partial<PostMeta> = {};
  const str = (key: string) => {
    const m = fm.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
    return m ? m[1] : undefined;
  };
  const bool = (key: string) => {
    const m = fm.match(new RegExp(`^${key}:\\s*(true|false)`, 'm'));
    return m ? m[1] === 'true' : undefined;
  };
  const arr = (key: string): string[] => {
    const m = fm.match(new RegExp(`^${key}:\\s*\\[(.*)\\]`, 'm'));
    if (!m) return [];
    return m[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  };
  meta.title = str('title');
  meta.description = str('description');
  meta.date = str('date');
  meta.category = str('category');
  meta.tags = arr('tags');
  meta.draft = bool('draft') ?? false;
  meta.cover = str('cover');
  meta.is_private = bool('is_private') ?? false;
  meta.password_hash = str('password_hash');
  return { meta, body };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function isSafeSlug(slug: string): boolean {
  return !!slug && !slug.includes('/') && !slug.includes('\\') && !slug.includes('..') && /^[\p{L}\p{N}-]+$/u.test(slug);
}

async function postExists(slug: string, env: Env): Promise<boolean> {
  const row = await env.DB.prepare('SELECT slug FROM posts WHERE slug = ? LIMIT 1').bind(slug).first<{ slug: string }>();
  return !!row;
}

async function validatePostSlug(slug: string, env: Env, origin: string | null): Promise<Response | null> {
  if (!isSafeSlug(slug)) return json({ error: 'Invalid slug' }, 400, origin);
  if (!(await postExists(slug, env))) return json({ error: 'Post not found' }, 404, origin);
  return null;
}


function contentBackend(env: Env): 'github' | 'db' {
  return env.CONTENT_BACKEND === 'db' ? 'db' : 'github';
}

function postTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return raw.split(',').map(tag => tag.trim()).filter(Boolean);
  }
}

function dbBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function dbPostSummary(row: any) {
  return {
    slug: String(row.slug),
    title: row.title ?? row.slug,
    description: row.description ?? '',
    date: row.date ?? '',
    category: row.category ?? '',
    tags: postTags(row.tags),
    draft: dbBool(row.draft),
    cover: row.cover ?? '',
    is_private: dbBool(row.is_private),
  };
}

function publicPostSummary(slug: string, meta: Partial<PostMeta>) {
  return {
    slug,
    title: meta.title ?? slug,
    description: meta.description ?? '',
    date: meta.date ?? '',
    category: meta.category ?? '',
    tags: meta.tags ?? [],
    draft: meta.draft ?? false,
    cover: meta.cover ?? '',
    is_private: meta.is_private ?? false,
  };
}

async function isAdminRequest(request: Request, env: Env): Promise<boolean> {
  const authUser = await getAuthUser(request, env);
  return authUser?.role === 'admin';
}

async function requireAdminRequest(request: Request, env: Env, origin: string | null): Promise<JWTPayload | Response> {
  const authUser = await getAuthUser(request, env);
  if (!authUser) return json({ error: 'Unauthorized' }, 401, origin);
  if (authUser.role !== 'admin') return json({ error: 'Forbidden' }, 403, origin);
  return authUser;
}

async function ensureAdminUserId(env: Env): Promise<number> {
  const primaryEmail = adminPrimaryEmail(env);
  for (const email of adminLoginEmails(env)) {
    const adminRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>();
    if (adminRow) return adminRow.id;
  }
  const inserted = await env.DB.prepare(
    'INSERT INTO users (email, password_hash, nickname, role) VALUES (?, ?, ?, ?) RETURNING id',
  ).bind(primaryEmail, 'admin-jwt', 'xmin', 'admin').first<{ id: number }>();
  if (!inserted) throw new Error('Failed to create admin user row');
  return inserted.id;
}

async function getDbUserIdForAuth(user: JWTPayload, env: Env): Promise<number> {
  return user.sub === 0 ? ensureAdminUserId(env) : user.sub;
}

// ─── Auth handlers ────────────────────────────────────────────────────────────

async function handleSignup(request: Request, env: Env, origin: string | null): Promise<Response> {
  let body: { email?: string; password?: string; nickname?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { email, password, nickname } = body;
  if (!email || !password) return json({ error: 'email and password required' }, 400, origin);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email' }, 400, origin);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400, origin);
  if (isAdminLoginEmail(email, env)) return json({ error: 'Email not available' }, 409, origin);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return json({ error: 'Email already registered' }, 409, origin);

  const hash = await hashPassword(password);
  const displayName = nickname?.trim() || email.split('@')[0];
  const result = await env.DB.prepare(
    'INSERT INTO users (email, password_hash, nickname, role) VALUES (?, ?, ?, ?) RETURNING id, email, nickname, role, avatar_url',
  ).bind(email, hash, displayName, 'user').first<{ id: number; email: string; nickname: string; role: string; avatar_url?: string }>();

  if (!result) return json({ error: 'Failed to create user' }, 500, origin);

  const token = await signJWT(
    { sub: result.id, email: result.email, role: result.role, exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECS },
    env.JWT_SECRET,
  );
  return json({ token, user: { id: result.id, email: result.email, nickname: displayName, role: result.role, avatar_url: result.avatar_url || '' } }, 201, origin);
}

async function handleLogin(request: Request, env: Env, origin: string | null): Promise<Response> {
  let body: { email?: string; password?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { email, password } = body;
  if (!email || !password) return json({ error: 'email and password required' }, 400, origin);

  // Special admin login
  if (isAdminLoginEmail(email, env)) {
    const ok = await verifyAdminPassword(password, env);
    if (!ok) return json({ error: 'Invalid credentials' }, 401, origin);
    const adminEmail = adminPrimaryEmail(env);
    const adminId = await ensureAdminUserId(env);
    const adminRow = await env.DB.prepare(
      'SELECT nickname, avatar_url FROM users WHERE id = ?',
    ).bind(adminId).first<{ nickname?: string; avatar_url?: string }>();
    const token = await signJWT(
      { sub: 0, email: adminEmail, role: 'admin', exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECS },
      env.JWT_SECRET,
    );
    return json({ token, user: { id: 0, email: adminEmail, nickname: adminRow?.nickname || 'xmin', role: 'admin', avatar_url: adminRow?.avatar_url || '' } }, 200, origin);
  }

  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, nickname, role, avatar_url FROM users WHERE email = ?',
  ).bind(email).first<{ id: number; email: string; password_hash: string; nickname: string; role: string; avatar_url?: string }>();

  if (!user) return json({ error: 'Invalid credentials' }, 401, origin);
  const ok = await checkPassword(password, user.password_hash);
  if (!ok) return json({ error: 'Invalid credentials' }, 401, origin);

  const token = await signJWT(
    { sub: user.id, email: user.email, role: user.role, exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECS },
    env.JWT_SECRET,
  );
  return json({ token, user: { id: user.id, email: user.email, nickname: user.nickname, role: user.role, avatar_url: user.avatar_url || '' } }, 200, origin);
}

async function handleMe(request: Request, env: Env, origin: string | null): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401, origin);

  const userId = await getDbUserIdForAuth(user, env);
  const row = await env.DB.prepare(
    'SELECT id, email, nickname, role, avatar_url FROM users WHERE id = ?',
  ).bind(userId).first<{ id: number; email: string; nickname: string; role: string; avatar_url?: string }>();

  if (!row) return json({ error: 'User not found' }, 404, origin);
  return json(user.sub === 0 ? { ...row, id: 0, email: adminPrimaryEmail(env), role: 'admin' } : row, 200, origin);
}

async function updateProfile(request: Request, env: Env, origin: string | null): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401, origin);

  let body: { nickname?: string; avatar_url?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const nickname = body.nickname?.trim() || user.email.split('@')[0];
  if (nickname.length > 40) return json({ error: 'Nickname too long' }, 400, origin);
  const hasAvatarUrl = Object.prototype.hasOwnProperty.call(body, 'avatar_url');
  const userId = await getDbUserIdForAuth(user, env);
  let row: { id: number; email: string; nickname: string; role: string; avatar_url?: string } | null;
  if (hasAvatarUrl) {
    const avatarUrl = body.avatar_url?.trim() || '';
    if (avatarUrl.length > 500) return json({ error: 'Avatar URL too long' }, 400, origin);
    if (avatarUrl && !/^(https:\/\/[^\s]+|\/uploads\/[^\s]+)$/i.test(avatarUrl)) {
      return json({ error: 'Avatar URL must be HTTPS or a local upload URL' }, 400, origin);
    }
    row = await env.DB.prepare(
      'UPDATE users SET nickname = ?, avatar_url = ? WHERE id = ? RETURNING id, email, nickname, role, avatar_url',
    ).bind(nickname, avatarUrl, userId).first<{ id: number; email: string; nickname: string; role: string; avatar_url?: string }>();
  } else {
    row = await env.DB.prepare(
      'UPDATE users SET nickname = ? WHERE id = ? RETURNING id, email, nickname, role, avatar_url',
    ).bind(nickname, userId).first<{ id: number; email: string; nickname: string; role: string; avatar_url?: string }>();
  }

  if (!row) return json({ error: 'User not found' }, 404, origin);
  return json(user.sub === 0 ? { ...row, id: 0, email: adminPrimaryEmail(env), role: 'admin' } : row, 200, origin);
}

async function changePassword(request: Request, env: Env, origin: string | null): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401, origin);
  if (user.sub === 0) return json({ error: 'Admin password is managed by server secrets' }, 400, origin);

  let body: { old_password?: string; new_password?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid JSON' }, 400, origin); }
  if (!body.old_password || !body.new_password) return json({ error: 'old_password and new_password required' }, 400, origin);
  if (body.new_password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400, origin);

  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.sub)
    .first<{ password_hash: string }>();
  if (!row) return json({ error: 'User not found' }, 404, origin);
  if (!(await checkPassword(body.old_password, row.password_hash))) {
    return json({ error: 'Invalid current password' }, 401, origin);
  }

  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(body.new_password), user.sub)
    .run();
  return json({ message: 'Password changed' }, 200, origin);
}

async function getMyComments(request: Request, env: Env, origin: string | null): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401, origin);

  const userId = await getDbUserIdForAuth(user, env);

  const rows = await env.DB.prepare(`
    SELECT id, post_slug, content, created_at
    FROM comments
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).bind(userId).all<{ id: number; post_slug: string; content: string; created_at: number }>();

  return json(rows.results ?? [], 200, origin);
}

async function getMyLikes(request: Request, env: Env, origin: string | null): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401, origin);

  const userId = await getDbUserIdForAuth(user, env);

  const rows = await env.DB.prepare(`
    SELECT post_slug, created_at
    FROM likes
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).bind(userId).all<{ post_slug: string; created_at: number }>();

  return json(rows.results ?? [], 200, origin);
}

// ─── Comments handlers ────────────────────────────────────────────────────────

async function getComments(slug: string, env: Env, origin: string | null): Promise<Response> {
  const invalid = await validatePostSlug(slug, env, origin);
  if (invalid) return invalid;
  const rows = await env.DB.prepare(`
    SELECT c.id, c.content, c.created_at, u.nickname, u.avatar_url, u.id as user_id
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.post_slug = ?
    ORDER BY c.created_at ASC
  `).bind(slug).all<{ id: number; content: string; created_at: number; nickname: string; avatar_url?: string; user_id: number }>();

  return json(rows.results ?? [], 200, origin);
}

async function addComment(slug: string, request: Request, env: Env, origin: string | null): Promise<Response> {
  const invalid = await validatePostSlug(slug, env, origin);
  if (invalid) return invalid;
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Login required to comment' }, 401, origin);

  let body: { content?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const content = body.content?.trim();
  if (!content || content.length < 1) return json({ error: 'Comment cannot be empty' }, 400, origin);
  if (content.length > 1000) return json({ error: 'Comment too long (max 1000 chars)' }, 400, origin);
  if (blockedCommentTerm(content, env)) return json({ error: 'Blocked comment content' }, 400, origin);

  const userId = await getDbUserIdForAuth(user, env);
  const userRow = await env.DB.prepare(
    'SELECT nickname, avatar_url FROM users WHERE id = ?',
  ).bind(userId).first<{ nickname: string; avatar_url?: string }>();
  if (!userRow) return json({ error: 'User not found' }, 404, origin);
  const nickname = userRow.nickname || user.email.split('@')[0];
  const avatarUrl = userRow.avatar_url || '';

  const now = Math.floor(Date.now() / 1000);
  const duplicate = await env.DB.prepare(
    'SELECT id FROM comments WHERE post_slug = ? AND user_id = ? AND content = ? AND created_at > ? LIMIT 1',
  ).bind(slug, userId, content, now - 60).first<{ id: number }>();
  if (duplicate) return json({ error: '잠시 후 다시 댓글을 남겨주세요' }, 429, origin);

  const result = await env.DB.prepare(
    'INSERT INTO comments (post_slug, user_id, content) VALUES (?, ?, ?) RETURNING id, created_at',
  ).bind(slug, userId, content).first<{ id: number; created_at: number }>();

  if (!result) return json({ error: 'Failed to save comment' }, 500, origin);
  return json({ id: result.id, content, created_at: result.created_at, nickname, avatar_url: avatarUrl, user_id: userId }, 201, origin);
}

async function deleteComment(id: number, request: Request, env: Env, origin: string | null): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401, origin);

  const comment = await env.DB.prepare('SELECT user_id FROM comments WHERE id = ?').bind(id).first<{ user_id: number }>();
  if (!comment) return json({ error: 'Comment not found' }, 404, origin);

  const isAdmin = user.role === 'admin';
  const isOwn = comment.user_id === user.sub;
  if (!isAdmin && !isOwn) return json({ error: 'Forbidden' }, 403, origin);

  await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
  return json({ message: 'Deleted' }, 200, origin);
}

// ─── Likes handlers ───────────────────────────────────────────────────────────

async function getLikes(slug: string, request: Request, env: Env, origin: string | null): Promise<Response> {
  const invalid = await validatePostSlug(slug, env, origin);
  if (invalid) return invalid;
  const countRow = await env.DB.prepare('SELECT COUNT(*) as count FROM likes WHERE post_slug = ?').bind(slug).first<{ count: number }>();
  const count = countRow?.count ?? 0;

  const user = await getAuthUser(request, env);
  let liked = false;
  if (user) {
    const userId = await getDbUserIdForAuth(user, env);
    const row = await env.DB.prepare('SELECT id FROM likes WHERE post_slug = ? AND user_id = ?').bind(slug, userId).first();
    liked = !!row;
  }

  return json({ count, liked }, 200, origin);
}

async function toggleLike(slug: string, request: Request, env: Env, origin: string | null): Promise<Response> {
  const invalid = await validatePostSlug(slug, env, origin);
  if (invalid) return invalid;
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Login required to like' }, 401, origin);

  const userId = await getDbUserIdForAuth(user, env);
  const existing = await env.DB.prepare('SELECT id FROM likes WHERE post_slug = ? AND user_id = ?').bind(slug, userId).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM likes WHERE post_slug = ? AND user_id = ?').bind(slug, userId).run();
  } else {
    await env.DB.prepare('INSERT INTO likes (post_slug, user_id) VALUES (?, ?)').bind(slug, userId).run();
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) as count FROM likes WHERE post_slug = ?').bind(slug).first<{ count: number }>();
  return json({ count: countRow?.count ?? 0, liked: !existing }, 200, origin);
}

// ─── Post handlers ────────────────────────────────────────────────────────────

async function listPosts(request: Request, env: Env, origin: string | null): Promise<Response> {
  const isAdmin = await isAdminRequest(request, env);

  if (contentBackend(env) === 'db') {
    const rows = await env.DB.prepare(
      isAdmin
        ? `SELECT slug, title, description, date, category, tags, draft, cover, is_private FROM posts ORDER BY date DESC, created_at DESC`
        : `SELECT slug, title, description, date, category, tags, draft, cover, is_private FROM posts WHERE draft = ? AND is_private = ? ORDER BY date DESC, created_at DESC`,
    );
    const result = isAdmin ? await rows.all<any>() : await rows.bind(false, false).all<any>();
    return json((result.results ?? []).map(dbPostSummary), 200, origin);
  }

  const { owner, repo, branch, token } = githubConfig(env);
  try {
    const tree = await ghGet<{ tree: GHTreeItem[] }>(
      `repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, token,
    );
    const mdFiles = tree.tree.filter(
      item => item.type === 'blob' && item.path.startsWith(`${CONTENT_PATH}/`) && item.path.endsWith('.md'),
    );
    const posts = await Promise.all(
      mdFiles.map(async item => {
        const slug = item.path.replace(`${CONTENT_PATH}/`, '').replace(/\.md$/, '');
        try {
          const file = await ghGet<GHFile>(`repos/${owner}/${repo}/contents/${item.path}?ref=${branch}`, token);
          const { meta } = parseFrontmatter(b64DecodeUnicode(file.content));
          return publicPostSummary(slug, meta);
        } catch {
          return publicPostSummary(slug, {});
        }
      }),
    );
    const visiblePosts = isAdmin ? posts : posts.filter(post => !post.draft && !post.is_private);
    visiblePosts.sort((a, b) => (b.date > a.date ? 1 : -1));
    return json(visiblePosts, 200, origin);
  } catch (err) {
    return json({ error: 'Failed to load posts' }, 500, origin);
  }
}

type PublicMetaPost = {
  slug: string;
  title: string;
  description: string;
  date: string;
  updated_at?: number | string | null;
};

async function listPublicMetaPosts(env: Env, origin: string | null): Promise<PublicMetaPost[]> {
  if (contentBackend(env) === 'db') {
    const result = await env.DB.prepare(`
      SELECT slug, title, description, date, updated_at
      FROM posts
      WHERE draft = ? AND is_private = ?
      ORDER BY date DESC, created_at DESC
    `).bind(false, false).all<PublicMetaPost>();
    return (result.results ?? []).map(post => ({
      ...post,
      description: post.description ?? '',
      date: post.date ?? '',
    }));
  }

  const res = await listPosts(new Request(`${SITE}/api/posts`), env, origin);
  if (!res.ok) return [];
  return await res.json() as PublicMetaPost[];
}

function postCanonicalUrl(slug: string): string {
  return `${SITE}/post/?slug=${encodeURIComponent(slug)}`;
}

function toRssDate(value: string | number | null | undefined): string {
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
}

function toIsoDate(value: string | number | null | undefined): string {
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function getRssFeed(env: Env, origin: string | null): Promise<Response> {
  const posts = await listPublicMetaPosts(env, origin);
  const items = posts.map((post) => {
    const url = postCanonicalUrl(post.slug);
    return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(url)}</link>
      <guid isPermaLink="true">${escapeXml(url)}</guid>
      <description>${escapeXml(post.description)}</description>
      <pubDate>${escapeXml(toRssDate(post.date))}</pubDate>
    </item>`;
  }).join('\n');

  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>xmin.blog</title>
    <link>${SITE}/</link>
    <description>주수민의 보안 리서치 노트 — 퍼징, 바이너리 분석, AI</description>
    <language>ko</language>
${items}
  </channel>
</rss>
`, 'application/rss+xml', origin);
}

async function getSitemap(env: Env, origin: string | null): Promise<Response> {
  const posts = await listPublicMetaPosts(env, origin);
  const staticUrls = [
    { loc: `${SITE}/`, priority: '1.0' },
    { loc: `${SITE}/about/`, priority: '0.6' },
    { loc: `${SITE}/cve/`, priority: '0.6' },
    { loc: `${SITE}/security-news/`, priority: '0.6' },
  ];
  const postUrls = posts.map(post => ({
    loc: postCanonicalUrl(post.slug),
    lastmod: toIsoDate(post.updated_at || post.date),
    priority: '0.8',
  }));
  const urls = [...staticUrls, ...postUrls].map(url => `  <url>
    <loc>${escapeXml(url.loc)}</loc>${'lastmod' in url ? `
    <lastmod>${escapeXml(url.lastmod)}</lastmod>` : ''}
    <priority>${url.priority}</priority>
  </url>`).join('\n');

  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`, 'application/xml', origin);
}

async function readPostFile(slug: string, env: Env): Promise<{ file: GHFile; meta: Partial<PostMeta>; body: string }> {
  const { owner, repo, branch, token } = githubConfig(env);
  const filePath = `${CONTENT_PATH}/${slug}.md`;
  const file = await ghGet<GHFile>(`repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, token);
  const { meta, body } = parseFrontmatter(b64DecodeUnicode(file.content));
  return { file, meta, body };
}

async function readPostRow(slug: string, env: Env): Promise<any | null> {
  return env.DB.prepare(
    `SELECT slug, title, description, date, category, tags, draft, cover, is_private, password_hash, content FROM posts WHERE slug = ?`,
  ).bind(slug).first<any>();
}

async function getPost(slug: string, request: Request, env: Env, origin: string | null): Promise<Response> {
  if (!isSafeSlug(slug)) return json({ error: 'Invalid slug' }, 400, origin);
  const isAdmin = await isAdminRequest(request, env);

  if (contentBackend(env) === 'db') {
    const row = await readPostRow(slug, env);
    if (!row) return json({ error: 'Post not found' }, 404, origin);
    const summary = dbPostSummary(row);
    if (summary.draft && !isAdmin) return json({ error: 'Post not found' }, 404, origin);
    const content = summary.is_private && !isAdmin ? null : row.content;
    return json({ ...summary, content }, 200, origin);
  }

  try {
    const { file, meta, body } = await readPostFile(slug, env);
    if (meta.draft && !isAdmin) return json({ error: 'Post not found' }, 404, origin);
    const content = meta.is_private && !isAdmin ? null : body;
    return json({ ...publicPostSummary(slug, meta), content, sha: isAdmin ? file.sha : undefined }, 200, origin);
  } catch (err) {
    const msg = String(err);
    return json({ error: 'Post not found' }, msg.includes('404') ? 404 : 500, origin);
  }
}

async function verifyPostPassword(slug: string, request: Request, env: Env, origin: string | null): Promise<Response> {
  if (!isSafeSlug(slug)) return json({ error: 'Invalid slug' }, 400, origin);
  let body: { password?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid JSON' }, 400, origin); }
  if (!body.password) return json({ error: 'Password required' }, 400, origin);

  if (contentBackend(env) === 'db') {
    const row = await readPostRow(slug, env);
    if (!row) return json({ error: 'Post not found' }, 404, origin);
    const summary = dbPostSummary(row);
    if (summary.draft) return json({ error: 'Post not found' }, 404, origin);
    if (!summary.is_private) return json({ ...summary, content: row.content }, 200, origin);
    if (!row.password_hash || !(await checkPassword(body.password, row.password_hash))) {
      return json({ error: 'Invalid password' }, 401, origin);
    }
    return json({ ...summary, content: row.content }, 200, origin);
  }

  try {
    const { meta, body: content } = await readPostFile(slug, env);
    if (meta.draft) return json({ error: 'Post not found' }, 404, origin);
    if (!meta.is_private) return json({ ...publicPostSummary(slug, meta), content }, 200, origin);
    if (!meta.password_hash || !(await checkPassword(body.password, meta.password_hash))) {
      return json({ error: 'Invalid password' }, 401, origin);
    }
    return json({ ...publicPostSummary(slug, meta), content }, 200, origin);
  } catch (err) {
    const msg = String(err);
    return json({ error: 'Post not found' }, msg.includes('404') ? 404 : 500, origin);
  }
}

async function preparePrivateFields(payload: PostPayload, existingHash?: string): Promise<string | undefined> {
  if (payload.is_private) {
    if (payload.private_password) return hashPassword(payload.private_password);
    if (existingHash) return existingHash;
    throw new Error('private_password is required for private posts');
  }
  return undefined;
}

async function createPost(payload: PostPayload, env: Env, origin: string | null): Promise<Response> {
  const slug = slugify(payload.title);
  if (!slug) return json({ error: 'Could not derive slug from title' }, 400, origin);
  if (!isSafeSlug(slug)) return json({ error: 'Invalid slug' }, 400, origin);

  if (contentBackend(env) === 'db') {
    try {
      payload.password_hash = await preparePrivateFields(payload);
    } catch (err) {
      return json({ error: (err as Error).message }, 400, origin);
    }

    const existing = await env.DB.prepare('SELECT slug FROM posts WHERE slug = ?').bind(slug).first();
    if (existing) return json({ error: `Post "${slug}" already exists` }, 409, origin);

    await env.DB.prepare(`
      INSERT INTO posts (slug, title, description, date, category, tags, draft, cover, is_private, password_hash, content, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      slug,
      payload.title,
      payload.description ?? '',
      payload.date,
      payload.category,
      JSON.stringify(payload.tags ?? []),
      !!payload.draft,
      payload.cover ?? '',
      !!payload.is_private,
      payload.password_hash ?? null,
      payload.content,
      Math.floor(Date.now() / 1000),
    ).run();
    return json({ slug, message: 'Post created' }, 201, origin);
  }

  const { owner, repo, branch, token } = githubConfig(env);
  try {
    payload.password_hash = await preparePrivateFields(payload);
  } catch (err) {
    return json({ error: (err as Error).message }, 400, origin);
  }

  const filePath = `${CONTENT_PATH}/${slug}.md`;
  try {
    await ghGet<GHFile>(`repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, token);
    return json({ error: `Post "${slug}" already exists` }, 409, origin);
  } catch { /* doesn't exist — good */ }

  const encoded = btoa(unescape(encodeURIComponent(buildMarkdown(payload, payload.content))));
  const res = await ghPut(`repos/${owner}/${repo}/contents/${filePath}`, { message: `feat: add post "${payload.title}"`, content: encoded, branch }, token);
  if (!res.ok) return json({ error: `GitHub error: ${await res.text()}` }, 500, origin);
  return json({ slug, message: 'Post created' }, 201, origin);
}

async function updatePost(slug: string, payload: PostPayload, env: Env, origin: string | null): Promise<Response> {
  if (!isSafeSlug(slug)) return json({ error: 'Invalid slug' }, 400, origin);

  if (contentBackend(env) === 'db') {
    const existing = await readPostRow(slug, env);
    if (!existing) return json({ error: 'Post not found' }, 404, origin);
    try {
      payload.password_hash = await preparePrivateFields(payload, existing.password_hash ?? undefined);
    } catch (err) {
      return json({ error: (err as Error).message }, 400, origin);
    }

    await env.DB.prepare(`
      UPDATE posts
      SET title = ?, description = ?, date = ?, category = ?, tags = ?, draft = ?, cover = ?, is_private = ?, password_hash = ?, content = ?, updated_at = ?
      WHERE slug = ?
    `).bind(
      payload.title,
      payload.description ?? '',
      payload.date,
      payload.category,
      JSON.stringify(payload.tags ?? []),
      !!payload.draft,
      payload.cover ?? '',
      !!payload.is_private,
      payload.password_hash ?? null,
      payload.content,
      Math.floor(Date.now() / 1000),
      slug,
    ).run();
    return json({ slug, message: 'Post updated' }, 200, origin);
  }

  const { owner, repo, branch, token } = githubConfig(env);
  const filePath = `${CONTENT_PATH}/${slug}.md`;
  let currentSha: string;
  let currentMeta: Partial<PostMeta>;
  try {
    const existing = await ghGet<GHFile>(`repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, token);
    currentSha = existing.sha;
    currentMeta = parseFrontmatter(b64DecodeUnicode(existing.content)).meta;
  } catch (err) {
    return json({ error: `Post not found: ${err}` }, 404, origin);
  }
  try {
    payload.password_hash = await preparePrivateFields(payload, currentMeta.password_hash);
  } catch (err) {
    return json({ error: (err as Error).message }, 400, origin);
  }
  const encoded = btoa(unescape(encodeURIComponent(buildMarkdown(payload, payload.content))));
  const res = await ghPut(`repos/${owner}/${repo}/contents/${filePath}`, { message: `chore: update post "${payload.title}"`, content: encoded, sha: currentSha, branch }, token);
  if (!res.ok) return json({ error: `GitHub error: ${await res.text()}` }, 500, origin);
  return json({ slug, message: 'Post updated' }, 200, origin);
}

async function deletePost(slug: string, env: Env, origin: string | null): Promise<Response> {
  if (!isSafeSlug(slug)) return json({ error: 'Invalid slug' }, 400, origin);

  if (contentBackend(env) === 'db') {
    const existing = await env.DB.prepare('SELECT slug FROM posts WHERE slug = ?').bind(slug).first();
    if (!existing) return json({ error: 'Post not found' }, 404, origin);
    await env.DB.prepare('DELETE FROM posts WHERE slug = ?').bind(slug).run();
    return json({ slug, message: 'Post deleted' }, 200, origin);
  }

  const { owner, repo, branch, token } = githubConfig(env);
  const filePath = `${CONTENT_PATH}/${slug}.md`;
  let currentSha: string;
  try {
    const existing = await ghGet<GHFile>(`repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, token);
    currentSha = existing.sha;
  } catch (err) {
    return json({ error: `Post not found: ${err}` }, 404, origin);
  }
  const res = await ghDelete(`repos/${owner}/${repo}/contents/${filePath}`, { message: `chore: delete post "${slug}"`, sha: currentSha, branch }, token);
  if (!res.ok) return json({ error: `GitHub error: ${await res.text()}` }, 500, origin);
  return json({ slug, message: 'Post deleted' }, 200, origin);
}

async function recordView(slug: string, request: Request, env: Env, origin: string | null): Promise<Response> {
  if (!isSafeSlug(slug)) return json({ error: 'Invalid slug' }, 400, origin);
  let body: { viewer_id?: string; referrer?: string };
  try { body = await request.json() as typeof body; } catch { body = {}; }
  const viewerId = (body.viewer_id ?? '').slice(0, 128);
  if (!viewerId) return json({ error: 'viewer_id required' }, 400, origin);

  const now = Math.floor(Date.now() / 1000);
  const recent = await env.DB.prepare(
    'SELECT id FROM page_views WHERE post_slug = ? AND viewer_id = ? AND created_at > ? LIMIT 1',
  ).bind(slug, viewerId, now - 1800).first();
  if (!recent) {
    await env.DB.prepare('INSERT INTO page_views (post_slug, viewer_id, referrer, created_at) VALUES (?, ?, ?, ?)')
      .bind(slug, viewerId, (body.referrer ?? '').slice(0, 500), now)
      .run();
  }
  return json({ recorded: !recent }, 200, origin);
}

async function getAdminStats(request: Request, env: Env, origin: string | null): Promise<Response> {
  const admin = await requireAdminRequest(request, env, origin);
  if (admin instanceof Response) return admin;

  const postsRes = await listPosts(request, env, origin);
  const posts = await postsRes.json() as Array<ReturnType<typeof publicPostSummary>>;
  const titleBySlug = new Map(posts.map(post => [post.slug, post.title]));
  const dayCutoff = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;

  const [users, comments, likes, views, viewsByDay, topViews, topLikes, topComments, recentComments, recentUsers] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) as count FROM comments').first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) as count FROM likes').first<{ count: number }>(),
    env.DB.prepare('SELECT COUNT(*) as count FROM page_views').first<{ count: number }>(),
    env.DB.prepare(`
      SELECT date(created_at, 'unixepoch') as day, COUNT(*) as views
      FROM page_views
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `).bind(dayCutoff).all<{ day: string; views: number }>(),
    env.DB.prepare(`
      SELECT post_slug, COUNT(*) as views
      FROM page_views
      GROUP BY post_slug
      ORDER BY views DESC
      LIMIT 10
    `).all<{ post_slug: string; views: number }>(),
    env.DB.prepare(`
      SELECT post_slug, COUNT(*) as likes
      FROM likes
      GROUP BY post_slug
      ORDER BY likes DESC
      LIMIT 10
    `).all<{ post_slug: string; likes: number }>(),
    env.DB.prepare(`
      SELECT post_slug, COUNT(*) as comments
      FROM comments
      GROUP BY post_slug
      ORDER BY comments DESC
      LIMIT 10
    `).all<{ post_slug: string; comments: number }>(),
    env.DB.prepare(`
      SELECT c.id, c.post_slug, c.content, c.created_at, u.nickname
      FROM comments c JOIN users u ON c.user_id = u.id
      ORDER BY c.created_at DESC
      LIMIT 10
    `).all<{ id: number; post_slug: string; content: string; created_at: number; nickname: string }>(),
    env.DB.prepare('SELECT id, email, nickname, role, created_at FROM users ORDER BY created_at DESC LIMIT 10')
      .all<{ id: number; email: string; nickname: string; role: string; created_at: number }>(),
  ]);

  const withTitles = <T extends { post_slug: string }>(rows: T[]) =>
    rows.map(row => ({ ...row, title: titleBySlug.get(row.post_slug) ?? row.post_slug }));
  const categoryCounts = new Map<string, number>();
  for (const post of posts) {
    if (post.category) categoryCounts.set(post.category, (categoryCounts.get(post.category) ?? 0) + 1);
  }

  return json({
    summary: {
      total_posts: posts.length,
      published_posts: posts.filter(post => !post.draft && !post.is_private).length,
      draft_posts: posts.filter(post => post.draft).length,
      private_posts: posts.filter(post => post.is_private).length,
      total_users: users?.count ?? 0,
      total_comments: comments?.count ?? 0,
      total_likes: likes?.count ?? 0,
      total_views: views?.count ?? 0,
    },
    views_by_day: viewsByDay.results ?? [],
    top_by_views: withTitles(topViews.results ?? []),
    top_by_likes: withTitles(topLikes.results ?? []),
    top_by_comments: withTitles(topComments.results ?? []),
    categories: Array.from(categoryCounts.entries()).map(([category, count]) => ({ category, count })),
    recent_comments: recentComments.results ?? [],
    recent_users: recentUsers.results ?? [],
  }, 200, origin);
}

type ValidatedImage = {
  bytes: Uint8Array;
  ext: 'jpg' | 'png' | 'webp' | 'gif';
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
};

function sniffImage(bytes: Uint8Array): Pick<ValidatedImage, 'ext' | 'mime'> | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return { ext: 'gif', mime: 'image/gif' };
  }
  return null;
}

function mimeMatches(declared: string, detected: string): boolean {
  const normalized = declared.toLowerCase();
  return normalized === detected || (normalized === 'image/jpg' && detected === 'image/jpeg');
}

async function validatedImageFromForm(
  request: Request,
  origin: string | null,
  options: { allowGif: boolean; maxBytes: number },
): Promise<ValidatedImage | Response> {
  const form = await request.formData();
  const fileEntry = form.get('file');
  if (typeof fileEntry === 'string' || !fileEntry || !('arrayBuffer' in fileEntry)) {
    return json({ error: 'file required' }, 400, origin);
  }
  const file = fileEntry as File;
  if (file.size > options.maxBytes) {
    return json({ error: `File too large (max ${Math.floor(options.maxBytes / 1024 / 1024)}MB)` }, 400, origin);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detected = sniffImage(bytes);
  if (!detected) return json({ error: 'Unsupported image format' }, 400, origin);
  if (!options.allowGif && detected.mime === 'image/gif') {
    return json({ error: 'GIF avatars are not allowed' }, 400, origin);
  }
  if (file.type && !mimeMatches(file.type, detected.mime)) {
    return json({ error: 'Image MIME type does not match file content' }, 400, origin);
  }
  return { bytes, ...detected };
}

function randomUploadName(ext: ValidatedImage['ext']): string {
  return `${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
}

function uploadFileFromImage(image: ValidatedImage): File {
  return new File([image.bytes], randomUploadName(image.ext), {
    type: image.mime,
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
}

async function uploadImage(request: Request, env: Env, origin: string | null): Promise<Response> {
  const admin = await requireAdminRequest(request, env, origin);
  if (admin instanceof Response) return admin;
  const image = await validatedImageFromForm(request, origin, { allowGif: true, maxBytes: 5 * 1024 * 1024 });
  if (image instanceof Response) return image;

  if (env.UPLOADS) {
    const url = await env.UPLOADS.put(uploadFileFromImage(image), request);
    return json({ url }, 201, origin);
  }

  const path = `public/uploads/${randomUploadName(image.ext)}`;
  const { owner, repo, branch, token } = githubConfig(env);
  const content = bytesToBase64(image.bytes);
  const res = await ghPut(`repos/${owner}/${repo}/contents/${path}`, {
    message: 'chore: upload image',
    content,
    branch,
  }, token);
  if (!res.ok) return json({ error: `GitHub error: ${await res.text()}` }, 500, origin);
  return json({ url: `/${path.replace(/^public\//, '')}` }, 201, origin);
}

async function uploadAvatar(request: Request, env: Env, origin: string | null): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401, origin);

  const image = await validatedImageFromForm(request, origin, { allowGif: false, maxBytes: 2 * 1024 * 1024 });
  if (image instanceof Response) return image;

  const userId = await getDbUserIdForAuth(user, env);
  let avatarUrl: string;
  if (env.UPLOADS) {
    avatarUrl = await env.UPLOADS.put(uploadFileFromImage(image), request);
  } else {
    const path = `public/uploads/avatars/${randomUploadName(image.ext)}`;
    const { owner, repo, branch, token } = githubConfig(env);
    const res = await ghPut(`repos/${owner}/${repo}/contents/${path}`, {
      message: 'chore: upload profile avatar',
      content: bytesToBase64(image.bytes),
      branch,
    }, token);
    if (!res.ok) return json({ error: `GitHub error: ${await res.text()}` }, 500, origin);
    avatarUrl = `/${path.replace(/^public\//, '')}`;
  }

  const row = await env.DB.prepare(
    'UPDATE users SET avatar_url = ? WHERE id = ? RETURNING id, email, nickname, role, avatar_url',
  ).bind(avatarUrl, userId).first<{ id: number; email: string; nickname: string; role: string; avatar_url?: string }>();

  if (!row) return json({ error: 'User not found' }, 404, origin);
  return json(user.sub === 0 ? { ...row, id: 0, email: adminPrimaryEmail(env), role: 'admin' } : row, 201, origin);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/health' && method === 'GET') {
      return json({ ok: true }, 200, origin);
    }

    if ((url.pathname === '/api/rss.xml' || url.pathname === '/api/feed.xml') && method === 'GET') {
      return getRssFeed(env, origin);
    }
    if (url.pathname === '/api/sitemap.xml' && method === 'GET') {
      return getSitemap(env, origin);
    }

    // ── Auth routes ──────────────────────────────────────────────────────────
    if (url.pathname === '/api/auth/signup' && method === 'POST') {
      const limited = rateLimit(request, 'signup', 5, 60 * 10, origin);
      if (limited) return limited;
      return handleSignup(request, env, origin);
    }
    if (url.pathname === '/api/auth/login' && method === 'POST') {
      const limited = rateLimit(request, 'login', 10, 60 * 10, origin);
      if (limited) return limited;
      return handleLogin(request, env, origin);
    }
    if (url.pathname === '/api/auth/me' && method === 'GET') {
      return handleMe(request, env, origin);
    }
    if (url.pathname === '/api/auth/profile' && method === 'PUT') {
      return updateProfile(request, env, origin);
    }
    if (url.pathname === '/api/auth/avatar' && method === 'POST') {
      const limited = rateLimit(request, 'avatar', 20, 60 * 10, origin);
      if (limited) return limited;
      return uploadAvatar(request, env, origin);
    }
    if (url.pathname === '/api/auth/change-password' && method === 'POST') {
      return changePassword(request, env, origin);
    }
    if (url.pathname === '/api/auth/my-comments' && method === 'GET') {
      return getMyComments(request, env, origin);
    }
    if (url.pathname === '/api/auth/my-likes' && method === 'GET') {
      return getMyLikes(request, env, origin);
    }

    // ── Admin / upload / analytics routes ───────────────────────────────────
    if (url.pathname === '/api/admin/stats' && method === 'GET') {
      return getAdminStats(request, env, origin);
    }
    if (url.pathname === '/api/upload' && method === 'POST') {
      const limited = rateLimit(request, 'upload', 30, 60 * 10, origin);
      if (limited) return limited;
      return uploadImage(request, env, origin);
    }
    const viewMatch = url.pathname.match(/^\/api\/views\/(.+)$/);
    if (viewMatch) {
      const slug = decodeURIComponent(viewMatch[1]);
      if (method === 'POST') {
        const limited = rateLimit(request, 'views', 120, 60, origin);
        if (limited) return limited;
        return recordView(slug, request, env, origin);
      }
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    // ── Comment routes ───────────────────────────────────────────────────────
    const commentIdMatch = url.pathname.match(/^\/api\/comments\/id\/(\d+)$/);
    if (commentIdMatch) {
      if (method === 'DELETE') return deleteComment(parseInt(commentIdMatch[1]), request, env, origin);
      return json({ error: 'Method not allowed' }, 405, origin);
    }
    const commentSlugMatch = url.pathname.match(/^\/api\/comments\/(.+)$/);
    if (commentSlugMatch) {
      const slug = decodeURIComponent(commentSlugMatch[1]);
      if (method === 'GET') return getComments(slug, env, origin);
      if (method === 'POST') {
        const limited = rateLimit(request, 'comments', 20, 60 * 10, origin);
        if (limited) return limited;
        return addComment(slug, request, env, origin);
      }
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    // ── Like routes ──────────────────────────────────────────────────────────
    const likeMatch = url.pathname.match(/^\/api\/likes\/(.+)$/);
    if (likeMatch) {
      const slug = decodeURIComponent(likeMatch[1]);
      if (method === 'GET') return getLikes(slug, request, env, origin);
      if (method === 'POST') {
        const limited = rateLimit(request, 'likes', 60, 60, origin);
        if (limited) return limited;
        return toggleLike(slug, request, env, origin);
      }
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    // ── Post routes ──────────────────────────────────────────────────────────
    const verifyMatch = url.pathname.match(/^\/api\/posts\/(.+)\/verify$/);
    if (verifyMatch) {
      const slug = decodeURIComponent(verifyMatch[1]);
      if (method === 'POST') {
        const limited = rateLimit(request, 'private-post-verify', 20, 60 * 10, origin);
        if (limited) return limited;
        return verifyPostPassword(slug, request, env, origin);
      }
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    if (!url.pathname.startsWith('/api/posts')) {
      return json({ error: 'Not found' }, 404, origin);
    }

    const slugMatch = url.pathname.match(/^\/api\/posts\/(.+)$/);
    const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : null;

    if (method === 'GET') {
      if (slug) return getPost(slug, request, env, origin);
      return listPosts(request, env, origin);
    }

    // Mutating post routes — require a live admin JWT. The old password/header
    // fallback is intentionally not accepted on write endpoints anymore.
    let body: Partial<PostPayload> = {};
    try { body = await request.json() as Partial<PostPayload>; } catch { /* empty body ok for DELETE with JWT */ }

    const admin = await requireAdminRequest(request, env, origin);
    if (admin instanceof Response) return admin;

    if (method === 'POST' && !slug) {
      const p = body as PostPayload;
      if (!p.title || !p.date || !p.category || !p.content) {
        return json({ error: 'title, date, category, and content are required' }, 400, origin);
      }
      return createPost(p, env, origin);
    }
    if (method === 'PUT' && slug) {
      const p = body as PostPayload;
      if (!p.title || !p.date || !p.category || !p.content) {
        return json({ error: 'title, date, category, and content are required' }, 400, origin);
      }
      return updatePost(slug, p, env, origin);
    }
    if (method === 'DELETE' && slug) return deletePost(slug, env, origin);

    return json({ error: 'Method not allowed' }, 405, origin);
  },
} satisfies ExportedHandler<Env>;
