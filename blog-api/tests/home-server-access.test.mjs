import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { once } from 'node:events';

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'blog-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lines = [];
  const errors = [];
  let handler;
  let failLogging = false;
  const worker = { fetch: async () => new Response('ok') };
  const context = createContext({
    Buffer, URL, URLSearchParams, Headers, Request, Response, setTimeout, clearTimeout,
    console: {
      log(value) { if (failLogging) throw new Error('sink unavailable'); lines.push(value); },
      error(value) { if (failLogging) throw new Error('sink unavailable'); errors.push(value); },
    },
    process: { cwd: () => directory, env: { DB_DRIVER: 'postgres', DATABASE_URL: 'test-only',
      ADMIN_PASSWORD: 'test-only', JWT_SECRET: 'test-only', UPLOAD_DIR: directory } },
  });
  const url = new URL('../home-server.mjs', import.meta.url);
  const module = new SourceTextModule(await readFile(url, 'utf8'), {
    context, identifier: url.href, initializeImportMeta(meta) { meta.url = url.href; },
  });
  await module.link(async specifier => {
    let exports;
    if (specifier === 'node:http') {
      exports = { createServer(callback) { handler = callback; return { listen() {} }; } };
    } else if (specifier === 'pg') {
      exports = { default: { Pool: class { async query() { return { rows: [], rowCount: 0 }; } },
        types: { setTypeParser() {} } } };
    } else if (specifier === './dist/index.js') {
      exports = { default: worker };
    } else {
      exports = await import(specifier);
    }
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  async function request(url, headers = {}) {
    const req = { method: 'GET', url, headers: { host: 'blog.test', ...headers },
      socket: { remoteAddress: '172.18.0.5' } };
    const res = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    res.statusCode = 200;
    res.setHeader = () => {};
    const finished = once(res, 'finish');
    await handler(req, res);
    await finished;
    res.emit('finish'); // The registration must remain one-shot.
    res.emit('close');
    return res.statusCode;
  }
  return { request, handle: (req, res) => handler(req, res), lines, errors, worker, directory,
    breakLogger() { failLogging = true; } };
}

test('records bounded query evidence and claims while redacting credentials', async t => {
  const h = await harness(t);
  const query = new URLSearchParams({ q: "' UNION SELECT 1 --", file: '../../etc/passwd',
    __xmin_blue_canary: 'blue-route-canary', safe: 'hello\r\nworld' });
  const sensitive = ['credential', 'Cookie', 'PASSWORD', 'passwd', 'access_token', 'secret',
    'api-key', 'authorization', 'session_id', 'signature', 'sig', 'jwt'];
  for (const name of sensitive) query.append(name, `PRIVATE-${name}`);
  query.append('password', 'PRIVATE-duplicate');
  await h.request('/health?' + query + '&%74oken=PRIVATE-encoded', {
    'user-agent': 'agent\r\nforged', 'cf-ray': 'test-ray', 'cf-connecting-ip': '203.0.113.9',
    authorization: 'PRIVATE-header', cookie: 'PRIVATE-cookie', referer: 'PRIVATE-referrer',
  });
  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].includes('\n'), false);
  assert.equal(h.lines[0].includes('PRIVATE-'), false);
  const record = JSON.parse(h.lines[0]);
  assert.equal(record.event, 'http_access');
  assert.equal(record.service, 'blog-api');
  assert.equal(typeof record.path, 'string');
  assert.equal(Object.hasOwn(record, 'client_ip'), false);
  assert.equal(record.path.includes('UNION+SELECT'), true);
  assert.equal(record.remote_addr, '172.18.0.5');
  assert.equal(record['request_CF-Connecting-IP'], '203.0.113.9');
  assert.equal(record.ray_id, 'test-ray');
  const logged = new URL(record.path, 'http://test').searchParams;
  assert.equal(logged.get('q'), "' UNION SELECT 1 --");
  assert.equal(logged.get('file'), '../../etc/passwd');
  assert.equal(logged.get('__xmin_blue_canary'), 'blue-route-canary');
  for (const name of sensitive) assert.equal(logged.get(name), '[REDACTED]');
  assert.equal(logged.get('token'), '[REDACTED]');
  await h.request('/' + '💣'.repeat(5000), { 'user-agent': '\u0000'.repeat(5000),
    host: 'h'.repeat(3000), 'cf-ray': 'r'.repeat(3000), 'cf-connecting-ip': 'c'.repeat(3000) });
  assert.ok(Buffer.byteLength(h.lines[1] + '\n') < 8192);
  assert.doesNotThrow(() => JSON.parse(h.lines[1]));
});

test('finish logs once for uploads, 404s, and thrown errors without leaking the error', async t => {
  const h = await harness(t);
  await writeFile(join(h.directory, 'fixture.png'), 'fixture');
  assert.equal(await h.request('/uploads/fixture.png'), 200);
  h.worker.fetch = async () => new Response('missing', { status: 404 });
  assert.equal(await h.request('/missing'), 404);
  h.worker.fetch = async () => { throw new Error('PRIVATE-error-with-credentials'); };
  assert.equal(await h.request('/broken'), 500);
  assert.deepEqual(h.lines.map(line => JSON.parse(line).status), [200, 404, 500]);
  assert.deepEqual(h.lines.map(line => JSON.parse(line).path), ['/uploads/fixture.png', '/missing', '/broken']);
  assert.deepEqual(h.lines.map(line => JSON.parse(line).response_completed), [true, true, true]);
  assert.deepEqual(h.errors.map(line => JSON.parse(line)), [
    { event: 'http_error', service: 'blog-api', type: 'request_failed' },
  ]);
  assert.equal(h.lines.join('').includes('PRIVATE-error'), false);
  h.breakLogger();
  h.worker.fetch = async () => new Response('ok');
  assert.equal(await h.request('/logging-failed'), 200);
  h.worker.fetch = async () => { throw new Error('PRIVATE-error'); };
  assert.equal(await h.request('/error-logging-failed'), 500);
});

test('early response close records incomplete once without a synthetic 200', async t => {
  const h = await harness(t);
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.worker.fetch = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const res = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  res.statusCode = 200;
  res.setHeader = () => {};
  const handling = h.handle({ method: 'GET', url: '/aborted?token=PRIVATE&canary=keep',
    headers: { host: 'blog.test' }, socket: { remoteAddress: '172.18.0.5' } }, res);
  await waiting;
  const closed = once(res, 'close');
  res.destroy();
  await closed;
  assert.equal(h.lines.length, 1);
  const record = JSON.parse(h.lines[0]);
  assert.equal(record.response_completed, false);
  assert.equal(record.status, null);
  assert.equal(record.remote_addr, '172.18.0.5');
  assert.equal(record.path.includes('PRIVATE'), false);
  release(new Response(null));
  await handling;
  res.emit('finish');
  res.emit('close');
  assert.equal(h.lines.length, 1);
});
