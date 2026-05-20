#!/usr/bin/env node
/**
 * Import existing Astro markdown posts into the server-managed posts table.
 *
 * Production use on vm-public:
 *   CONTENT_ROOT=../src/content/blog \
 *   DATABASE_URL=postgresql://... \
 *   UPLOAD_DIR=/opt/xminblog/blog-api/data/uploads \
 *   PUBLIC_UPLOAD_BASE=https://api.xmin.cloud/uploads \
 *   npm run import:markdown
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
pg.types.setTypeParser(20, value => Number(value));

const cwd = process.cwd();
const dbDriver = (process.env.DB_DRIVER || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')).toLowerCase();
const contentRoot = resolve(cwd, process.env.CONTENT_ROOT || '../src/content/blog');
const uploadDir = resolve(cwd, process.env.UPLOAD_DIR || './data/uploads');
const publicUploadBase = (process.env.PUBLIC_UPLOAD_BASE || '/uploads').replace(/\/+$/, '');
const mirrorRemoteImages = process.env.MIRROR_REMOTE_IMAGES !== '0' && process.env.MIRROR_REMOTE_IMAGES !== 'false';
const maxImageBytes = Number(process.env.MAX_MIRROR_IMAGE_BYTES || 10 * 1024 * 1024);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseScalar(value = '') {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

function parseArray(value = '') {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if ((ch === '"' || ch === "'") && inner[i - 1] !== '\\') {
      quote = quote === ch ? '' : quote || ch;
      current += ch;
      continue;
    }
    if (ch === ',' && !quote) {
      items.push(parseScalar(current));
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(parseScalar(current));
  return items.map(String).filter(Boolean);
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === 'tags') meta[key] = parseArray(value);
    else meta[key] = parseScalar(value);
  }
  return { meta, body: match[2].trimStart() };
}

function safeSlugFromFilename(file) {
  const slug = basename(file, extname(file));
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    throw new Error(`Unsafe slug derived from ${file}`);
  }
  return slug;
}

function extensionFromContentType(contentType) {
  const clean = contentType.split(';')[0].trim().toLowerCase();
  if (clean === 'image/jpeg') return 'jpg';
  if (clean === 'image/png') return 'png';
  if (clean === 'image/webp') return 'webp';
  if (clean === 'image/gif') return 'gif';
  if (clean === 'image/svg+xml') return 'svg';
  return '';
}

function extensionFromUrl(url) {
  try {
    const ext = extname(new URL(url).pathname).replace(/^\./, '').toLowerCase();
    return /^[a-z0-9]{2,8}$/.test(ext) ? ext : '';
  } catch {
    return '';
  }
}

function uploadUrlFor(name) {
  return `${publicUploadBase}/${encodeURIComponent(name)}`;
}

async function mirrorRemoteImage(url, slug, index) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'xmin-blog-migration/1.0' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('image/')) throw new Error(`not an image: ${contentType || 'unknown content-type'}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxImageBytes) throw new Error(`image too large: ${bytes.length} bytes`);
  const ext = extensionFromContentType(contentType) || extensionFromUrl(url) || 'img';
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const safeSlug = slug.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || 'post';
  const name = `${safeSlug}-${String(index).padStart(2, '0')}-${hash}.${ext}`;
  mkdirSync(uploadDir, { recursive: true });
  const path = join(uploadDir, name);
  try {
    await stat(path);
  } catch {
    writeFileSync(path, bytes, { flag: 'wx' });
  }
  return uploadUrlFor(name);
}

async function maybeMirrorImages(body, slug) {
  if (!mirrorRemoteImages) return { body, mirrored: 0, failed: 0 };
  const markdownImage = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
  const replacements = [];
  let match;
  let index = 1;
  while ((match = markdownImage.exec(body))) {
    replacements.push({ raw: match[0], alt: match[1], url: match[2], index: index++ });
  }
  let nextBody = body;
  let mirrored = 0;
  let failed = 0;
  const seen = new Map();
  for (const image of replacements) {
    try {
      const localUrl = seen.get(image.url) || await mirrorRemoteImage(image.url, slug, image.index);
      seen.set(image.url, localUrl);
      nextBody = nextBody.replace(image.raw, `![${image.alt}](${localUrl})`);
      mirrored += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[warn] ${slug}: could not mirror ${image.url}: ${error.message}`);
    }
  }
  return { body: nextBody, mirrored, failed };
}

class SQLiteD1 {
  constructor(path, DatabaseSync) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }
  exec(sql) { this.db.exec(sql); }
  upsert(post) {
    this.db.prepare(`
      INSERT INTO posts (slug, title, description, date, category, tags, draft, cover, is_private, password_hash, content, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        date = excluded.date,
        category = excluded.category,
        tags = excluded.tags,
        draft = excluded.draft,
        cover = excluded.cover,
        is_private = excluded.is_private,
        password_hash = excluded.password_hash,
        content = excluded.content,
        updated_at = excluded.updated_at
    `).run(post.slug, post.title, post.description, post.date, post.category, JSON.stringify(post.tags), post.draft ? 1 : 0, post.cover, post.is_private ? 1 : 0, post.password_hash || null, post.content);
  }
  close() { this.db.close(); }
}

class PostgresStore {
  constructor(databaseUrl) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }
  async exec(sql) { await this.pool.query(sql); }
  async upsert(post) {
    await this.pool.query(`
      INSERT INTO posts (slug, title, description, date, category, tags, draft, cover, is_private, password_hash, content, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, extract(epoch from now())::bigint)
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        date = excluded.date,
        category = excluded.category,
        tags = excluded.tags,
        draft = excluded.draft,
        cover = excluded.cover,
        is_private = excluded.is_private,
        password_hash = excluded.password_hash,
        content = excluded.content,
        updated_at = excluded.updated_at
    `, [post.slug, post.title, post.description, post.date, post.category, JSON.stringify(post.tags), post.draft, post.cover, post.is_private, post.password_hash || null, post.content]);
  }
  async close() { await this.pool.end(); }
}

async function createStore() {
  if (dbDriver === 'postgres') return new PostgresStore(requiredEnv('DATABASE_URL'));
  if (dbDriver === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    return new SQLiteD1(resolve(cwd, process.env.SQLITE_PATH || './data/blog.sqlite'), DatabaseSync);
  }
  throw new Error(`Unsupported DB_DRIVER: ${dbDriver}`);
}

async function main() {
  const files = (await readdir(contentRoot)).filter(file => file.endsWith('.md')).sort();
  if (!files.length) throw new Error(`No markdown files found in ${contentRoot}`);
  const store = await createStore();
  await store.exec(readFileSync(new URL(dbDriver === 'postgres' ? '../schema.postgres.sql' : '../schema.sql', import.meta.url), 'utf8'));

  let imported = 0;
  let mirrored = 0;
  let failedImages = 0;
  try {
    for (const file of files) {
      const slug = safeSlugFromFilename(file);
      const raw = await readFile(join(contentRoot, file), 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const mirroredBody = await maybeMirrorImages(body, slug);
      mirrored += mirroredBody.mirrored;
      failedImages += mirroredBody.failed;
      const post = {
        slug,
        title: String(meta.title || slug),
        description: String(meta.description || ''),
        date: String(meta.date || new Date().toISOString().slice(0, 10)),
        category: String(meta.category || ''),
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        draft: Boolean(meta.draft),
        cover: String(meta.cover || ''),
        is_private: Boolean(meta.is_private),
        password_hash: meta.password_hash ? String(meta.password_hash) : null,
        content: mirroredBody.body,
      };
      await store.upsert(post);
      imported += 1;
      console.log(`[ok] ${slug}`);
    }
  } finally {
    await store.close();
  }

  console.log(JSON.stringify({ imported, mirrored_images: mirrored, failed_images: failedImages, content_root: contentRoot, upload_dir: uploadDir, mirror_remote_images: mirrorRemoteImages }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
