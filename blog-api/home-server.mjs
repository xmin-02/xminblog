#!/usr/bin/env node
/**
 * Home-server adapter for the blog API.
 *
 * It runs the same Cloudflare Worker fetch handler on a plain Node HTTP server
 * and provides a small D1-compatible database wrapper. Production should use
 * PostgreSQL on vm-db; SQLite remains available only for local smoke tests.
 */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import worker from './dist/index.js';

const { Pool } = pg;
pg.types.setTypeParser(20, value => Number(value)); // int8 / BIGSERIAL / COUNT(*)
const cwd = process.cwd();
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const dbDriver = (process.env.DB_DRIVER || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')).toLowerCase();
const dbPath = resolve(cwd, process.env.SQLITE_PATH || './data/blog.sqlite');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

class SQLiteD1Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new SQLiteD1Statement(this.db, this.sql, params);
  }

  first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }

  all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }

  run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid ?? 0),
      },
    };
  }
}

class SQLiteD1Database {
  constructor(path, DatabaseSync) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  }

  prepare(sql) {
    return new SQLiteD1Statement(this.db, sql);
  }

  exec(sql) {
    this.db.exec(sql);
  }
}

function postgresSql(sql) {
  let index = 0;
  return sql
    .replace(/date\(created_at,\s*'unixepoch'\)/gi, "to_char(to_timestamp(created_at), 'YYYY-MM-DD')")
    .replace(/\?/g, () => `$${++index}`);
}

class PostgresD1Statement {
  constructor(pool, sql, params = []) {
    this.pool = pool;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new PostgresD1Statement(this.pool, this.sql, params);
  }

  async first() {
    const result = await this.pool.query(postgresSql(this.sql), this.params);
    return result.rows[0] ?? null;
  }

  async all() {
    const result = await this.pool.query(postgresSql(this.sql), this.params);
    return { results: result.rows };
  }

  async run() {
    const result = await this.pool.query(postgresSql(this.sql), this.params);
    return { success: true, meta: { changes: result.rowCount ?? 0 } };
  }
}

class PostgresD1Database {
  constructor(databaseUrl) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  prepare(sql) {
    return new PostgresD1Statement(this.pool, sql);
  }

  async exec(sql) {
    await this.pool.query(sql);
  }
}

async function initDb(db) {
  if (dbDriver === 'postgres') {
    await db.exec(readFileSync(new URL('./schema.postgres.sql', import.meta.url), 'utf8'));
    return;
  }

  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

  const columns = db.prepare('PRAGMA table_info(users)').all().results.map(row => row.name);
  if (!columns.includes('avatar_url')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT;');
  }
}

function toRequest(req) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const hostHeader = req.headers.host || `${host}:${port}`;
  const url = `${protocol}://${hostHeader}${req.url || '/'}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const hasBody = !['GET', 'HEAD'].includes(req.method || 'GET');
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

async function writeResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function createDb() {
  if (dbDriver === 'postgres') {
    return new PostgresD1Database(requiredEnv('DATABASE_URL'));
  }
  if (dbDriver === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    return new SQLiteD1Database(dbPath, DatabaseSync);
  }
  throw new Error(`Unsupported DB_DRIVER: ${dbDriver}`);
}

const DB = await createDb();
await initDb(DB);

const env = {
  GITHUB_TOKEN: requiredEnv('GITHUB_TOKEN'),
  ADMIN_PASSWORD: requiredEnv('ADMIN_PASSWORD'),
  JWT_SECRET: requiredEnv('JWT_SECRET'),
  GITHUB_OWNER: process.env.GITHUB_OWNER,
  GITHUB_REPO: process.env.GITHUB_REPO,
  GITHUB_BRANCH: process.env.GITHUB_BRANCH,
  DB,
};

const server = createServer(async (req, res) => {
  try {
    const request = toRequest(req);
    const response = await worker.fetch(request, env);
    await writeResponse(res, response);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

server.listen(port, host, () => {
  console.log(`blog-api home server listening on http://${host}:${port}`);
  console.log(`DB driver: ${dbDriver}`);
  if (dbDriver === 'sqlite') console.log(`SQLite DB: ${dbPath}`);
});
