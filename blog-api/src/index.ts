/**
 * blog-api — Cloudflare Worker
 *
 * Routes:
 *   GET    /api/posts           — list all posts (reads GitHub tree)
 *   GET    /api/posts/:slug     — get single post with raw content
 *   POST   /api/posts           — create new post
 *   PUT    /api/posts/:slug     — update existing post
 *   DELETE /api/posts/:slug     — delete post
 *
 * Secrets (set with `wrangler secret put <NAME>`):
 *   GITHUB_TOKEN   — GitHub PAT with repo contents write access
 *   ADMIN_PASSWORD — plain-text password; worker hashes and compares
 *
 * Optional env vars (wrangler.toml [vars]):
 *   GITHUB_OWNER   (default: "xmin-02")
 *   GITHUB_REPO    (default: "xminblog")
 *   GITHUB_BRANCH  (default: "main")
 */

export interface Env {
  GITHUB_TOKEN: string;
  ADMIN_PASSWORD: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGIN = 'https://xmin.blog';
const CONTENT_PATH = 'src/content/blog';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function githubConfig(env: Env) {
  return {
    owner: env.GITHUB_OWNER ?? 'xmin-02',
    repo: env.GITHUB_REPO ?? 'xminblog',
    branch: env.GITHUB_BRANCH ?? 'main',
    token: env.GITHUB_TOKEN,
  };
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin === ALLOWED_ORIGIN || origin === 'http://localhost:4321' ? origin : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

async function sha256hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyPassword(provided: string, env: Env): Promise<boolean> {
  if (!provided) return false;
  const hash = await sha256hex(provided);
  const expected = await sha256hex(env.ADMIN_PASSWORD);
  // Constant-time comparison
  if (hash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

interface GHFile {
  sha: string;
  content: string; // base64
  encoding: string;
}

interface GHTreeItem {
  path: string;
  type: string;
  sha: string;
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub GET /${path} → ${res.status}: ${text}`);
  }
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
  title: string;
  description: string;
  date: string;
  category: string;
  tags: string[];
  draft: boolean;
}

interface PostPayload extends PostMeta {
  content: string;
  password: string;
}

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
  const d = bool('draft');
  meta.draft = d ?? false;

  return { meta, body };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function listPosts(env: Env, origin: string | null): Promise<Response> {
  const { owner, repo, branch, token } = githubConfig(env);
  try {
    const tree = await ghGet<{ tree: GHTreeItem[] }>(
      `repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
      token,
    );
    const mdFiles = tree.tree.filter(
      item => item.type === 'blob' && item.path.startsWith(`${CONTENT_PATH}/`) && item.path.endsWith('.md'),
    );

    const posts = await Promise.all(
      mdFiles.map(async item => {
        const slug = item.path.replace(`${CONTENT_PATH}/`, '').replace(/\.md$/, '');
        try {
          const file = await ghGet<GHFile>(`repos/${owner}/${repo}/contents/${item.path}?ref=${branch}`, token);
          const raw = atob(file.content.replace(/\n/g, ''));
          const { meta } = parseFrontmatter(raw);
          return {
            slug,
            title: meta.title ?? slug,
            description: meta.description ?? '',
            date: meta.date ?? '',
            category: meta.category ?? '',
            tags: meta.tags ?? [],
            draft: meta.draft ?? false,
          };
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
    const raw = atob(file.content.replace(/\n/g, ''));
    const { meta, body } = parseFrontmatter(raw);
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
  const markdown = buildMarkdown(payload, payload.content);
  const encoded = btoa(unescape(encodeURIComponent(markdown)));

  // Check if file already exists
  let existingSha: string | undefined;
  try {
    const existing = await ghGet<GHFile>(`repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, token);
    existingSha = existing.sha;
  } catch {
    // File doesn't exist — good for create
  }

  if (existingSha) {
    return json({ error: `Post with slug "${slug}" already exists. Use PUT to update.` }, 409, origin);
  }

  const res = await ghPut(
    `repos/${owner}/${repo}/contents/${filePath}`,
    {
      message: `feat: add post "${payload.title}"`,
      content: encoded,
      branch,
    },
    token,
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: `GitHub error: ${text}` }, 500, origin);
  }
  return json({ slug, message: 'Post created' }, 201, origin);
}

async function updatePost(slug: string, payload: PostPayload, env: Env, origin: string | null): Promise<Response> {
  const { owner, repo, branch, token } = githubConfig(env);
  const filePath = `${CONTENT_PATH}/${slug}.md`;

  // Get current file SHA
  let currentSha: string;
  try {
    const existing = await ghGet<GHFile>(`repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, token);
    currentSha = existing.sha;
  } catch (err) {
    return json({ error: `Post not found: ${err}` }, 404, origin);
  }

  const markdown = buildMarkdown(payload, payload.content);
  const encoded = btoa(unescape(encodeURIComponent(markdown)));

  const res = await ghPut(
    `repos/${owner}/${repo}/contents/${filePath}`,
    {
      message: `chore: update post "${payload.title}"`,
      content: encoded,
      sha: currentSha,
      branch,
    },
    token,
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: `GitHub error: ${text}` }, 500, origin);
  }
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

  const res = await ghDelete(
    `repos/${owner}/${repo}/contents/${filePath}`,
    {
      message: `chore: delete post "${slug}"`,
      sha: currentSha,
      branch,
    },
    token,
  );

  if (!res.ok) {
    const text = await res.text();
    return json({ error: `GitHub error: ${text}` }, 500, origin);
  }
  return json({ slug, message: 'Post deleted' }, 200, origin);
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const method = request.method.toUpperCase();

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Only handle /api/posts routes
    if (!url.pathname.startsWith('/api/posts')) {
      return json({ error: 'Not found' }, 404, origin);
    }

    // Parse slug from path: /api/posts/:slug
    const slugMatch = url.pathname.match(/^\/api\/posts\/(.+)$/);
    const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : null;

    // GET requests don't require auth
    if (method === 'GET') {
      if (slug) return getPost(slug, env, origin);
      return listPosts(env, origin);
    }

    // All mutating requests require auth
    let body: Partial<PostPayload> = {};
    try {
      body = await request.json() as Partial<PostPayload>;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, origin);
    }

    const password = (body.password as string) ?? request.headers.get('X-Admin-Password') ?? '';
    if (!(await verifyPassword(password, env))) {
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

    if (method === 'DELETE' && slug) {
      return deletePost(slug, env, origin);
    }

    return json({ error: 'Method not allowed' }, 405, origin);
  },
} satisfies ExportedHandler<Env>;
