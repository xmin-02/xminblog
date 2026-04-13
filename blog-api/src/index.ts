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
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGIN = 'https://xmin.blog';
const CONTENT_PATH = 'src/content/blog';
const JWT_EXPIRY_SECS = 60 * 60 * 24 * 7; // 7 days
const ADMIN_EMAIL = 'admin@xmin.blog';

// ─── CORS ─────────────────────────────────────────────────────────────────────

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin === ALLOWED_ORIGIN || origin === 'http://localhost:4321' ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
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

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
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
}
interface PostPayload extends PostMeta { content: string; password: string; }

function buildMarkdown(meta: PostMeta, body: string): string {
  const tags = meta.tags.length
    ? `\ntags: [${meta.tags.map(t => `"${t}"`).join(', ')}]`
    : '\ntags: []';
  return `---
title: "${meta.title.replace(/"/g, '\\"')}"
description: "${meta.description.replace(/"/g, '\\"')}"
date: ${meta.date}
category: "${meta.category.replace(/"/g, '\\"')}"${tags}
draft: ${meta.draft}
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

// ─── Auth handlers ────────────────────────────────────────────────────────────

async function handleSignup(request: Request, env: Env, origin: string | null): Promise<Response> {
  let body: { email?: string; password?: string; nickname?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { email, password, nickname } = body;
  if (!email || !password) return json({ error: 'email and password required' }, 400, origin);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email' }, 400, origin);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400, origin);
  if (email === ADMIN_EMAIL) return json({ error: 'Email not available' }, 409, origin);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return json({ error: 'Email already registered' }, 409, origin);

  const hash = await hashPassword(password);
  const displayName = nickname?.trim() || email.split('@')[0];
  const result = await env.DB.prepare(
    'INSERT INTO users (email, password_hash, nickname, role) VALUES (?, ?, ?, ?) RETURNING id, email, nickname, role',
  ).bind(email, hash, displayName, 'user').first<{ id: number; email: string; nickname: string; role: string }>();

  if (!result) return json({ error: 'Failed to create user' }, 500, origin);

  const token = await signJWT(
    { sub: result.id, email: result.email, role: result.role, exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECS },
    env.JWT_SECRET,
  );
  return json({ token, user: { id: result.id, email: result.email, nickname: displayName, role: result.role } }, 201, origin);
}

async function handleLogin(request: Request, env: Env, origin: string | null): Promise<Response> {
  let body: { email?: string; password?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { email, password } = body;
  if (!email || !password) return json({ error: 'email and password required' }, 400, origin);

  // Special admin login
  if (email === ADMIN_EMAIL) {
    const ok = await verifyAdminPassword(password, env);
    if (!ok) return json({ error: 'Invalid credentials' }, 401, origin);
    const token = await signJWT(
      { sub: 0, email: ADMIN_EMAIL, role: 'admin', exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECS },
      env.JWT_SECRET,
    );
    return json({ token, user: { id: 0, email: ADMIN_EMAIL, nickname: 'xmin', role: 'admin' } }, 200, origin);
  }

  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, nickname, role FROM users WHERE email = ?',
  ).bind(email).first<{ id: number; email: string; password_hash: string; nickname: string; role: string }>();

  if (!user) return json({ error: 'Invalid credentials' }, 401, origin);
  const ok = await checkPassword(password, user.password_hash);
  if (!ok) return json({ error: 'Invalid credentials' }, 401, origin);

  const token = await signJWT(
    { sub: user.id, email: user.email, role: user.role, exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECS },
    env.JWT_SECRET,
  );
  return json({ token, user: { id: user.id, email: user.email, nickname: user.nickname, role: user.role } }, 200, origin);
}

async function handleMe(request: Request, env: Env, origin: string | null): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401, origin);

  if (user.sub === 0) {
    return json({ id: 0, email: ADMIN_EMAIL, nickname: 'xmin', role: 'admin' }, 200, origin);
  }

  const row = await env.DB.prepare(
    'SELECT id, email, nickname, role FROM users WHERE id = ?',
  ).bind(user.sub).first<{ id: number; email: string; nickname: string; role: string }>();

  if (!row) return json({ error: 'User not found' }, 404, origin);
  return json(row, 200, origin);
}

// ─── Comments handlers ────────────────────────────────────────────────────────

async function getComments(slug: string, env: Env, origin: string | null): Promise<Response> {
  const rows = await env.DB.prepare(`
    SELECT c.id, c.content, c.created_at, u.nickname, u.id as user_id
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.post_slug = ?
    ORDER BY c.created_at ASC
  `).bind(slug).all<{ id: number; content: string; created_at: number; nickname: string; user_id: number }>();

  return json(rows.results ?? [], 200, origin);
}

async function addComment(slug: string, request: Request, env: Env, origin: string | null): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Login required to comment' }, 401, origin);

  let body: { content?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const content = body.content?.trim();
  if (!content || content.length < 1) return json({ error: 'Comment cannot be empty' }, 400, origin);
  if (content.length > 1000) return json({ error: 'Comment too long (max 1000 chars)' }, 400, origin);

  // Resolve user_id: admin (sub=0) is stored lazily in the DB on first comment
  let userId = user.sub;
  let nickname = 'xmin';
  if (user.sub !== 0) {
    const row = await env.DB.prepare('SELECT nickname FROM users WHERE id = ?').bind(user.sub).first<{ nickname: string }>();
    if (!row) return json({ error: 'User not found' }, 404, origin);
    nickname = row.nickname;
  } else {
    // Ensure admin has a DB row (created on first use, let AUTOINCREMENT assign id)
    const adminRow = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(ADMIN_EMAIL).first<{ id: number }>();
    if (!adminRow) {
      const inserted = await env.DB.prepare(
        'INSERT INTO users (email, password_hash, nickname, role) VALUES (?, ?, ?, ?) RETURNING id',
      ).bind(ADMIN_EMAIL, 'admin-jwt', 'xmin', 'admin').first<{ id: number }>();
      userId = inserted?.id ?? 1;
    } else {
      userId = adminRow.id;
    }
  }

  const result = await env.DB.prepare(
    'INSERT INTO comments (post_slug, user_id, content) VALUES (?, ?, ?) RETURNING id, created_at',
  ).bind(slug, userId, content).first<{ id: number; created_at: number }>();

  if (!result) return json({ error: 'Failed to save comment' }, 500, origin);
  return json({ id: result.id, content, created_at: result.created_at, nickname, user_id: userId }, 201, origin);
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
  const countRow = await env.DB.prepare('SELECT COUNT(*) as count FROM likes WHERE post_slug = ?').bind(slug).first<{ count: number }>();
  const count = countRow?.count ?? 0;

  const user = await getAuthUser(request, env);
  let liked = false;
  if (user) {
    const row = await env.DB.prepare('SELECT id FROM likes WHERE post_slug = ? AND user_id = ?').bind(slug, user.sub).first();
    liked = !!row;
  }

  return json({ count, liked }, 200, origin);
}

async function toggleLike(slug: string, request: Request, env: Env, origin: string | null): Promise<Response> {
  const user = await getAuthUser(request, env);
  if (!user) return json({ error: 'Login required to like' }, 401, origin);

  const existing = await env.DB.prepare('SELECT id FROM likes WHERE post_slug = ? AND user_id = ?').bind(slug, user.sub).first();
  if (existing) {
    await env.DB.prepare('DELETE FROM likes WHERE post_slug = ? AND user_id = ?').bind(slug, user.sub).run();
  } else {
    await env.DB.prepare('INSERT INTO likes (post_slug, user_id) VALUES (?, ?)').bind(slug, user.sub).run();
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) as count FROM likes WHERE post_slug = ?').bind(slug).first<{ count: number }>();
  return json({ count: countRow?.count ?? 0, liked: !existing }, 200, origin);
}

// ─── Post handlers ────────────────────────────────────────────────────────────

async function listPosts(env: Env, origin: string | null): Promise<Response> {
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
          return { slug, title: meta.title ?? slug, description: meta.description ?? '', date: meta.date ?? '', category: meta.category ?? '', tags: meta.tags ?? [], draft: meta.draft ?? false };
        } catch {
          return { slug, title: slug, description: '', date: '', category: '', tags: [], draft: false };
        }
      }),
    );
    posts.sort((a, b) => (b.date > a.date ? 1 : -1));
    return json(posts, 200, origin);
  } catch (err) {
    return json({ error: String(err) }, 500, origin);
  }
}

async function getPost(slug: string, env: Env, origin: string | null): Promise<Response> {
  const { owner, repo, branch, token } = githubConfig(env);
  const filePath = `${CONTENT_PATH}/${slug}.md`;
  try {
    const file = await ghGet<GHFile>(`repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, token);
    const { meta, body } = parseFrontmatter(b64DecodeUnicode(file.content));
    return json({ slug, ...meta, content: body, sha: file.sha }, 200, origin);
  } catch (err) {
    const msg = String(err);
    return json({ error: msg }, msg.includes('404') ? 404 : 500, origin);
  }
}

async function createPost(payload: PostPayload, env: Env, origin: string | null): Promise<Response> {
  const { owner, repo, branch, token } = githubConfig(env);
  const slug = slugify(payload.title);
  if (!slug) return json({ error: 'Could not derive slug from title' }, 400, origin);

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
  const { owner, repo, branch, token } = githubConfig(env);
  const filePath = `${CONTENT_PATH}/${slug}.md`;
  let currentSha: string;
  try {
    const existing = await ghGet<GHFile>(`repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, token);
    currentSha = existing.sha;
  } catch (err) {
    return json({ error: `Post not found: ${err}` }, 404, origin);
  }
  const encoded = btoa(unescape(encodeURIComponent(buildMarkdown(payload, payload.content))));
  const res = await ghPut(`repos/${owner}/${repo}/contents/${filePath}`, { message: `chore: update post "${payload.title}"`, content: encoded, sha: currentSha, branch }, token);
  if (!res.ok) return json({ error: `GitHub error: ${await res.text()}` }, 500, origin);
  return json({ slug, message: 'Post updated' }, 200, origin);
}

async function deletePost(slug: string, env: Env, origin: string | null): Promise<Response> {
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

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── Auth routes ──────────────────────────────────────────────────────────
    if (url.pathname === '/api/auth/signup' && method === 'POST') {
      return handleSignup(request, env, origin);
    }
    if (url.pathname === '/api/auth/login' && method === 'POST') {
      return handleLogin(request, env, origin);
    }
    if (url.pathname === '/api/auth/me' && method === 'GET') {
      return handleMe(request, env, origin);
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
      if (method === 'POST') return addComment(slug, request, env, origin);
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    // ── Like routes ──────────────────────────────────────────────────────────
    const likeMatch = url.pathname.match(/^\/api\/likes\/(.+)$/);
    if (likeMatch) {
      const slug = decodeURIComponent(likeMatch[1]);
      if (method === 'GET') return getLikes(slug, request, env, origin);
      if (method === 'POST') return toggleLike(slug, request, env, origin);
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    // ── Post routes ──────────────────────────────────────────────────────────
    if (!url.pathname.startsWith('/api/posts')) {
      return json({ error: 'Not found' }, 404, origin);
    }

    const slugMatch = url.pathname.match(/^\/api\/posts\/(.+)$/);
    const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : null;

    if (method === 'GET') {
      if (slug) return getPost(slug, env, origin);
      return listPosts(env, origin);
    }

    // Mutating post routes — require admin password
    let body: Partial<PostPayload> = {};
    try { body = await request.json() as Partial<PostPayload>; } catch { return json({ error: 'Invalid JSON body' }, 400, origin); }

    const password = (body.password as string) ?? request.headers.get('X-Admin-Password') ?? '';
    if (!(await verifyAdminPassword(password, env))) {
      return json({ error: 'Unauthorized' }, 401, origin);
    }

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
