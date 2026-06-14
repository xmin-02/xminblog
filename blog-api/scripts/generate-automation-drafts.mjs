#!/usr/bin/env node
/**
 * Generate review-ready blog drafts from vulnerability/news feeds.
 *
 * Default outputs:
 * - CVE watch drafts: one pending post per selected CVE.
 * - Security news digest: one pending daily briefing post.
 *
 * Production example:
 *   DATABASE_URL=postgresql://... npm run automate:drafts
 *
 * Local dry run:
 *   DB_DRIVER=sqlite SQLITE_PATH=./data/automation.sqlite \
 *   AUTOMATION_DRY_RUN=1 npm run automate:drafts -- --kind=all
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const { Pool } = pg;
pg.types.setTypeParser(20, value => Number(value));

const cwd = process.cwd();
const args = process.argv.slice(2);
const argSet = new Set(args);
const dbDriver = (process.env.DB_DRIVER || (process.env.DATABASE_URL ? 'postgres' : 'sqlite')).toLowerCase();
const dryRun = argSet.has('--dry-run') || process.env.AUTOMATION_DRY_RUN === '1' || process.env.AUTOMATION_DRY_RUN === 'true';
const kind = argValue('--kind', process.env.AUTOMATION_KIND || 'all');
const cveLookbackDays = numberValue('CVE_LOOKBACK_DAYS', 3);
const cveLimit = numberValue('CVE_DRAFT_LIMIT', numberValue('AUTOMATION_LIMIT', 10));
const newsLimit = numberValue('SECURITY_NEWS_ITEM_LIMIT', 8);
const automationTimeZone = process.env.AUTOMATION_TIME_ZONE || 'Asia/Seoul';
const automationUtcOffset = process.env.AUTOMATION_UTC_OFFSET || '+09:00';
const securityNewsWindowStartHour = Math.min(Math.max(numberValue('SECURITY_NEWS_WINDOW_START_HOUR', 9), 0), 23);
const securityNewsIncludeKev = ['1', 'true', 'on'].includes(String(process.env.SECURITY_NEWS_INCLUDE_KEV || '0').toLowerCase());
const minCvssScore = numberValue('CVE_MIN_CVSS_SCORE', 8.0);
const nvdMaxPages = numberValue('NVD_MAX_PAGES', 3);
const nvdResultsPerPage = Math.min(Math.max(numberValue('NVD_RESULTS_PER_PAGE', 200), 1), 2000);
const openaiApiKey = process.env.OPENAI_API_KEY || '';
const aiDraftsEnabled = !!openaiApiKey && !['0', 'false', 'off'].includes(String(process.env.AI_DRAFTS || '1').toLowerCase());
const aiDraftRequired = ['1', 'true', 'on'].includes(String(process.env.AI_DRAFT_REQUIRED || '0').toLowerCase());
const openaiDraftModel = process.env.OPENAI_DRAFT_MODEL || 'gpt-5.4-mini';
const openaiDraftMaxOutputTokens = numberValue('OPENAI_DRAFT_MAX_OUTPUT_TOKENS', 2600);
const aiDraftWarning = '> 주의: 이 글은 AI 자동 작성되었습니다. 반드시 재검증해야 합니다. 내용의 오류가 있을 경우 댓글 작성 부탁드립니다.';
const nvdBaseUrl = process.env.NVD_CVE_API_URL || 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const cisaKevUrl = process.env.CISA_KEV_JSON_URL || 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const cisaKevFallbackUrl = process.env.CISA_KEV_FALLBACK_JSON_URL || 'https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json';
const securityNewsFeeds = csvEnv('SECURITY_NEWS_FEEDS', [
  'https://www.boannews.com/media/news_rss.xml?mkind=1',
  'https://www.boannews.com/media/news_rss.xml?skind=5',
  'https://www.boannews.com/media/news_rss.xml?kind=5',
]);

function argValue(name, fallback = '') {
  const index = args.findIndex(arg => arg === name || arg.startsWith(`${name}=`));
  if (index < 0) return fallback;
  const raw = args[index];
  if (raw.includes('=')) return raw.slice(raw.indexOf('=') + 1);
  return args[index + 1] || fallback;
}

function numberValue(name, fallback) {
  const raw = process.env[name] ?? argValue(`--${name.toLowerCase().replaceAll('_', '-')}`, String(fallback));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function csvEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map(item => item.trim()).filter(Boolean);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function dateKey(date = new Date(), timeZone = automationTimeZone) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDaysToDateKey(day, delta) {
  const date = new Date(`${day}T00:00:00.000${automationUtcOffset}`);
  date.setUTCDate(date.getUTCDate() + delta);
  return dateKey(date);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function zonedDateTime(day, hour, minute = 0, second = 0, millisecond = 0) {
  return new Date(`${day}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${String(millisecond).padStart(3, '0')}${automationUtcOffset}`);
}

function securityNewsWindow(now = new Date()) {
  const reportDate = dateKey(now);
  const startDate = addDaysToDateKey(reportDate, -1);
  const endHour = (securityNewsWindowStartHour + 23) % 24;
  const start = zonedDateTime(startDate, securityNewsWindowStartHour, 0, 0, 0);
  const end = zonedDateTime(reportDate, endHour, 59, 59, 999);
  return {
    reportDate,
    startDate,
    endDate: reportDate,
    start,
    end,
    label: `${startDate} ${pad2(securityNewsWindowStartHour)}:00:00 ~ ${reportDate} ${pad2(endHour)}:59:59 ${automationTimeZone}`,
  };
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function dateTimeForNvd(date) {
  return date.toISOString();
}

function safeText(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function slugify(value) {
  return safeText(value, 120)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/g, '\\|').trim();
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

async function fetchText(url, options = {}) {
  const retries = Number(options.retries ?? 2);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': 'xmin-blog-automation/1.0 (+https://xmin.blog)',
          accept: options.accept || '*/*',
          ...(options.headers || {}),
        },
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${safeText(await response.text(), 300)}`);
      return await decodeResponseText(response);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(750 * (attempt + 1));
    }
  }
  throw lastError;
}

async function decodeResponseText(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const probe = new TextDecoder('latin1').decode(bytes.slice(0, 500));
  const contentType = response.headers.get('content-type') || '';
  const declared = contentType.match(/charset=([^;\s]+)/i)?.[1]
    || probe.match(/encoding=["']([^"']+)["']/i)?.[1]
    || 'utf-8';
  const encoding = declared.toLowerCase().replace(/^ks_c_5601-1987$/, 'euc-kr');
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function fetchJson(url, options = {}) {
  return JSON.parse(await fetchText(url, { ...options, accept: 'application/json' }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function responseOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text.trim();
  const parts = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === 'string') parts.push(content.text);
      if (typeof content?.refusal === 'string') parts.push(content.refusal);
    }
  }
  return parts.join('\n').trim();
}

function aiSystemPrompt() {
  return [
    'You write Korean markdown review drafts for xmin.blog, a security research blog by Sumin Joo / xmin.',
    'Use only the source data in the user message. Do not invent exploit status, affected versions, patches, products, dates, or references.',
    'If the source data is incomplete, write "확인 필요" instead of guessing.',
    'Keep the tone calm, technical, and attacker-perspective-aware, but do not include exploit code, payloads, step-by-step exploitation, or weaponized commands.',
    'Output markdown only. Do not include YAML frontmatter or fenced code blocks.',
  ].join('\n');
}

function aiInput(kind, source) {
  const requirements = kind === 'cve'
    ? [
        'Write a Korean CVE review draft.',
        'Required sections: 핵심 요약, 기술 배경, 공격자 관점에서 볼 부분, 영향 범위, 대응 및 패치, 메모, 참고 링크.',
        `Start with this exact blockquote warning: ${aiDraftWarning}`,
        'Write publish-ready prose. Do not write internal review instructions, TODO checklists, or "게시 전에는 특히 아래를 재검증해야 합니다" style sections.',
        'Do not include bullet lists about affected-version rechecks, patch rechecks, CVSS-vector rechecks, Deferred status rechecks, public exploit checks, or related research checks.',
        'In 참고 링크, render every URL as a clickable Markdown link like [source name](https://example.com).',
        'Do not include a top-level # heading because the blog renderer already shows the post title. Start section headings at ##.',
      ]
    : [
        'Write a Korean daily security-news briefing draft.',
        'Required sections: 오늘의 핵심 동향, 우선 확인할 이슈, 패치/완화 메모, 메모, 원문 링크.',
        'Summarize only the items inside collection_window. Mention the collection window near the beginning.',
        'Write publish-ready prose. Do not write internal review instructions or TODO checklists.',
        'If the source items array is empty, clearly say that no major new security-news items were collected for the day and keep the draft short.',
        'In 원문 링크, render every URL as a clickable Markdown link like [source name](https://example.com).',
        'Group duplicate or related items when obvious from titles/summaries, but do not merge facts that are not supported by the source data.',
        'Do not include a top-level # heading because the blog renderer already shows the post title. Start section headings at ##.',
      ];
  return `${requirements.join('\n')}\n\nSOURCE DATA JSON:\n${JSON.stringify(source, null, 2)}`;
}

async function generateAiDraft(kind, source, fallbackContent) {
  if (!aiDraftsEnabled) return { content: fallbackContent, ai_generated_content: false };
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openaiApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: openaiDraftModel,
        max_output_tokens: openaiDraftMaxOutputTokens,
        input: [
          {
            role: 'system',
            content: [{ type: 'input_text', text: aiSystemPrompt() }],
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: aiInput(kind, source) }],
          },
        ],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.error?.message || `OpenAI HTTP ${response.status}`);
    }
    const content = responseOutputText(data);
    if (!content || content.length < 300) throw new Error('OpenAI response was too short');
    return {
      content,
      ai_generated_content: true,
      ai_model: openaiDraftModel,
      ai_usage: data.usage || null,
    };
  } catch (error) {
    console.warn(`[warn] AI draft failed for ${kind}: ${error.message}`);
    if (aiDraftRequired) throw error;
    return {
      content: fallbackContent,
      ai_generated_content: false,
      ai_error: error.message,
    };
  }
}

class SQLiteStore {
  constructor(path, DatabaseSync) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }
  exec(sql) { this.db.exec(sql); }
  existingSource(sourceType, sourceId, slug = '') {
    const id = String(sourceId || '');
    const postSlug = String(slug || '');
    if (!id && !postSlug) return null;
    return this.db.prepare(`
      SELECT slug, review_status
      FROM posts
      WHERE (? <> '' AND source_type = ? AND source_id = ?)
         OR (? <> '' AND slug = ?)
      ORDER BY CASE WHEN ? <> '' AND source_type = ? AND source_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(id, sourceType, id, postSlug, postSlug, id, sourceType, id) ?? null;
  }
  insert(post) {
    if (dryRun) return;
    this.db.prepare(`
      INSERT INTO posts (
        slug, title, description, date, category, tags, draft, cover, is_private,
        password_hash, source_type, source_url, source_id, auto_generated,
        review_status, reviewed_at, content, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      post.slug,
      post.title,
      post.description,
      post.date,
      post.category,
      JSON.stringify(post.tags),
      post.draft ? 1 : 0,
      post.cover,
      post.is_private ? 1 : 0,
      null,
      post.source_type,
      post.source_url,
      post.source_id,
      post.auto_generated ? 1 : 0,
      post.review_status,
      null,
      post.content,
    );
  }
  close() { this.db.close(); }
}

class PostgresStore {
  constructor(databaseUrl) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }
  async exec(sql) { await this.pool.query(sql); }
  async existingSource(sourceType, sourceId, slug = '') {
    const id = String(sourceId || '');
    const postSlug = String(slug || '');
    if (!id && !postSlug) return null;
    const result = await this.pool.query(
      `SELECT slug, review_status
       FROM posts
       WHERE ($2 <> '' AND source_type = $1 AND source_id = $2)
          OR ($3 <> '' AND slug = $3)
       ORDER BY CASE WHEN $2 <> '' AND source_type = $1 AND source_id = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [sourceType, id, postSlug],
    );
    return result.rows[0] ?? null;
  }
  async insert(post) {
    if (dryRun) return;
    await this.pool.query(`
      INSERT INTO posts (
        slug, title, description, date, category, tags, draft, cover, is_private,
        password_hash, source_type, source_url, source_id, auto_generated,
        review_status, reviewed_at, content, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12, $13, $14, NULL, $15,
        extract(epoch from now())::bigint
      )
    `, [
      post.slug,
      post.title,
      post.description,
      post.date,
      post.category,
      JSON.stringify(post.tags),
      post.draft,
      post.cover,
      post.is_private,
      post.source_type,
      post.source_url,
      post.source_id,
      post.auto_generated,
      post.review_status,
      post.content,
    ]);
  }
  async close() { await this.pool.end(); }
}

async function createStore() {
  if (dbDriver === 'postgres') return new PostgresStore(requiredEnv('DATABASE_URL'));
  if (dbDriver === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    return new SQLiteStore(resolve(cwd, process.env.SQLITE_PATH || './data/blog.sqlite'), DatabaseSync);
  }
  throw new Error(`Unsupported DB_DRIVER: ${dbDriver}`);
}

async function loadSchema(store) {
  const file = dbDriver === 'postgres' ? '../schema.postgres.sql' : '../schema.sql';
  await store.exec(readFileSync(new URL(file, import.meta.url), 'utf8'));
}

async function loadKevCatalog() {
  try {
    return await fetchJson(cisaKevUrl);
  } catch (error) {
    console.warn(`[warn] CISA KEV primary failed: ${error.message}`);
    return fetchJson(cisaKevFallbackUrl);
  }
}

function kevMap(catalog) {
  const rows = Array.isArray(catalog?.vulnerabilities) ? catalog.vulnerabilities : [];
  return new Map(rows.map(row => [String(row.cveID || '').toUpperCase(), row]));
}

async function fetchNvdCves() {
  const end = new Date();
  const start = daysAgo(cveLookbackDays);
  const cves = [];
  const headers = {};
  if (process.env.NVD_API_KEY) headers.apiKey = process.env.NVD_API_KEY;
  for (let page = 0; page < nvdMaxPages; page++) {
    const startIndex = page * nvdResultsPerPage;
    const url = new URL(nvdBaseUrl);
    url.searchParams.set('pubStartDate', dateTimeForNvd(start));
    url.searchParams.set('pubEndDate', dateTimeForNvd(end));
    url.searchParams.set('resultsPerPage', String(nvdResultsPerPage));
    url.searchParams.set('startIndex', String(startIndex));
    url.searchParams.set('noRejected', '');
    const data = await fetchJson(url.toString(), { headers });
    const rows = Array.isArray(data?.vulnerabilities) ? data.vulnerabilities.map(row => row.cve).filter(Boolean) : [];
    cves.push(...rows);
    const total = Number(data?.totalResults || rows.length);
    if (startIndex + rows.length >= total || !rows.length) break;
    await sleep(process.env.NVD_API_KEY ? 700 : 6500);
  }
  return cves;
}

function cveDescription(cve) {
  const descriptions = Array.isArray(cve.descriptions) ? cve.descriptions : [];
  return safeText(
    descriptions.find(item => item.lang === 'en')?.value
      || descriptions.find(item => item.lang === 'ko')?.value
      || descriptions[0]?.value
      || '',
    1200,
  );
}

function metricFor(cve) {
  const metrics = cve.metrics || {};
  const groups = [
    ['CVSS 4.0', metrics.cvssMetricV40],
    ['CVSS 3.1', metrics.cvssMetricV31],
    ['CVSS 3.0', metrics.cvssMetricV30],
    ['CVSS 2.0', metrics.cvssMetricV2],
  ];
  for (const [version, items] of groups) {
    if (!Array.isArray(items) || !items.length) continue;
    const primary = items.find(item => item.type === 'Primary') || items[0];
    const data = primary.cvssData || {};
    return {
      version,
      score: Number(data.baseScore ?? primary.baseScore ?? 0),
      severity: safeText(data.baseSeverity ?? primary.baseSeverity ?? 'UNKNOWN', 40).toUpperCase(),
      vector: safeText(data.vectorString ?? '', 200),
    };
  }
  return { version: 'CVSS', score: 0, severity: 'UNKNOWN', vector: '' };
}

function weaknessesFor(cve) {
  const weaknesses = Array.isArray(cve.weaknesses) ? cve.weaknesses : [];
  return unique(weaknesses.flatMap(group => (
    Array.isArray(group.description)
      ? group.description.map(item => item.value)
      : []
  ))).slice(0, 8);
}

function referencesFor(cve) {
  return (Array.isArray(cve.references?.referenceData) ? cve.references.referenceData : [])
    .map(ref => ({
      url: safeText(ref.url, 1000),
      source: safeText(ref.source, 120),
      tags: Array.isArray(ref.tags) ? ref.tags.map(String) : [],
    }))
    .filter(ref => ref.url)
    .slice(0, 12);
}

function cpeProduct(cpe) {
  const parts = String(cpe || '').split(':');
  if (parts.length < 6) return '';
  const vendor = decodeURIComponent(parts[3] || '').replace(/_/g, ' ');
  const product = decodeURIComponent(parts[4] || '').replace(/_/g, ' ');
  return [vendor, product].filter(part => part && part !== '*').join(' ');
}

function affectedProducts(cve) {
  const products = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.cpeMatch)) {
      for (const match of node.cpeMatch) {
        if (match?.vulnerable === false) continue;
        const product = cpeProduct(match?.criteria || match?.cpe23Uri);
        if (product) products.push(product);
      }
    }
    if (Array.isArray(node.nodes)) node.nodes.forEach(walk);
  };
  (Array.isArray(cve.configurations) ? cve.configurations : []).forEach(walk);
  return unique(products).slice(0, 8);
}

function exploitSignal(refs, kev) {
  if (kev) return 'CISA KEV 등록';
  if (refs.some(ref => ref.tags.map(tag => tag.toLowerCase()).includes('exploit'))) return 'exploit reference';
  return '공개 익스플로잇 신호 미확인';
}

function rankCves(cves, kevByCve) {
  return cves
    .map(cve => {
      const id = String(cve.id || '').toUpperCase();
      const metric = metricFor(cve);
      const kev = kevByCve.get(id);
      const refs = referencesFor(cve);
      const exploitRefs = refs.filter(ref => ref.tags.map(tag => tag.toLowerCase()).includes('exploit')).length;
      const rank = metric.score + (kev ? 10 : 0) + exploitRefs * 1.5;
      return { cve, id, metric, kev, refs, rank };
    })
    .filter(item => item.id && (item.kev || item.metric.score >= minCvssScore))
    .sort((a, b) => b.rank - a.rank || String(b.cve.published || '').localeCompare(String(a.cve.published || '')))
    .slice(0, cveLimit);
}

function cveTitle(item) {
  const products = item.kev
    ? [item.kev.vendorProject, item.kev.product].filter(Boolean).join(' ')
    : affectedProducts(item.cve)[0] || '';
  return safeText(`[CVE] ${item.id}${products ? ` ${products}` : ''}`, 100);
}

function cvePostSlug(item) {
  const affected = affectedProducts(item.cve);
  return slugify(`${item.id} ${affected[0] || item.kev?.vendorProject || ''}`) || item.id.toLowerCase();
}

function cveImpactPhrase(description) {
  const text = String(description || '').toLowerCase();
  if (/remote code execution|execute arbitrary code|code execution/.test(text)) return '임의 코드 실행';
  if (/privilege escalation|escalat(?:e|ion).*privilege|gain elevated/.test(text)) return '권한 상승';
  if (/authentication bypass|bypass authentication|auth bypass/.test(text)) return '인증 우회';
  if (/information disclosure|information leak|data leak|expos(?:e|ure)/.test(text)) return '정보 노출';
  if (/denial of service|\bdos\b|crash/.test(text)) return '서비스 거부';
  if (/cross-site scripting|\bxss\b/.test(text)) return '스크립트 실행';
  if (/sql injection|\bsqli\b/.test(text)) return 'SQL 인젝션';
  return '보안 영향';
}

function cveOneLineDescription(item, description, affected, weaknesses) {
  const kevProduct = item.kev ? [item.kev.vendorProject, item.kev.product].filter(Boolean).join(' ') : '';
  const target = affected[0] || kevProduct || item.id;
  const weakness = weaknesses[0] ? `${weaknesses[0]} 관련 ` : '';
  const severity = item.metric.severity && item.metric.severity !== 'UNKNOWN' ? `${item.metric.severity} 등급의 ` : '';
  const impact = cveImpactPhrase(description);
  return safeText(`${target}에서 ${weakness}${severity}취약점이 공개되었으며, ${impact} 가능성이 있어 영향 범위와 패치 여부를 확인해야 합니다.`, 220);
}

async function cvePost(item) {
  const cve = item.cve;
  const id = item.id;
  const desc = cveDescription(cve);
  const weaknesses = weaknessesFor(cve);
  const affected = affectedProducts(cve);
  const refs = item.refs;
  const kev = item.kev;
  const sourceUrl = `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(id)}`;
  const title = cveTitle(item);
  const tags = unique([
    'cve',
    'automation',
    item.metric.severity.toLowerCase(),
    kev ? 'kev' : '',
    ...weaknesses.map(w => w.toLowerCase()).filter(w => /^cwe-\d+/i.test(w)).slice(0, 2),
  ]);

  const oneLineDescription = cveOneLineDescription(item, desc, affected, weaknesses);

  const fallbackBody = `${aiDraftWarning}

## 개요

| 항목 | 내용 |
| --- | --- |
| CVE | ${escapeMarkdown(id)} |
| 심각도 | ${escapeMarkdown(`${item.metric.severity} ${item.metric.score || 'N/A'} (${item.metric.version})`)} |
| 공개일 | ${escapeMarkdown(String(cve.published || 'N/A'))} |
| 수정일 | ${escapeMarkdown(String(cve.lastModified || 'N/A'))} |
| 상태 | ${escapeMarkdown(String(cve.vulnStatus || 'N/A'))} |
| KEV | ${escapeMarkdown(kev ? `등록됨 (${kev.dateAdded || 'date unknown'})` : '미등록')} |

## 요약

${desc || 'NVD 설명을 확인한 뒤 요약을 보강하세요.'}

## 공격자 관점 체크

- 악용 신호: ${exploitSignal(refs, kev)}
- 영향 제품: ${affected.length ? affected.join(', ') : 'NVD CPE 확인 필요'}
- 약점 분류: ${weaknesses.length ? weaknesses.join(', ') : 'CWE 확인 필요'}
- CVSS vector: ${item.metric.vector || '확인 필요'}

## 메모

이 글은 자동 수집된 CVE 데이터를 바탕으로 정리했습니다. 환경과 제품 버전에 따라 실제 영향은 달라질 수 있으므로 운영 중인 구성과 공급사 권고를 함께 확인하는 편이 좋습니다.

${kev ? `## CISA KEV 정보

- 취약점명: ${safeText(kev.vulnerabilityName, 300) || 'N/A'}
- 요구 조치: ${safeText(kev.requiredAction, 500) || 'N/A'}
- 마감일: ${safeText(kev.dueDate, 80) || 'N/A'}
- 랜섬웨어 악용: ${safeText(kev.knownRansomwareCampaignUse, 80) || 'Unknown'}
` : ''}
## 참고 링크

- [NVD 상세](${sourceUrl})
${refs.map(ref => `- [${ref.source || new URL(ref.url).hostname}](${ref.url})${ref.tags.length ? ` — ${ref.tags.join(', ')}` : ''}`).join('\n')}
`;
  const aiDraft = await generateAiDraft('cve', {
    cve: id,
    title,
    description: desc,
    metric: item.metric,
    published: cve.published || null,
    last_modified: cve.lastModified || null,
    status: cve.vulnStatus || null,
    kev: kev ? {
      date_added: kev.dateAdded || null,
      vendor_project: kev.vendorProject || null,
      product: kev.product || null,
      vulnerability_name: kev.vulnerabilityName || null,
      required_action: kev.requiredAction || null,
      due_date: kev.dueDate || null,
      known_ransomware_campaign_use: kev.knownRansomwareCampaignUse || null,
    } : null,
    affected_products: affected,
    weaknesses,
    exploit_signal: exploitSignal(refs, kev),
    references: [
      { source: 'NVD', url: sourceUrl },
      ...refs.map(ref => ({ source: ref.source, url: ref.url, tags: ref.tags })),
    ],
  }, fallbackBody);
  const content = aiDraft.content;
  const finalTags = aiDraft.ai_generated_content ? unique([...tags, 'ai-draft']) : tags;

  return {
    slug: cvePostSlug(item),
    title,
    description: oneLineDescription,
    date: isoDate(new Date(cve.published || Date.now())),
    category: 'cve',
    tags: finalTags,
    draft: true,
    cover: '',
    is_private: false,
    source_type: 'cve',
    source_url: sourceUrl,
    source_id: id,
    auto_generated: true,
    review_status: 'pending',
    content,
    ai_generated_content: aiDraft.ai_generated_content,
    ai_model: aiDraft.ai_model || null,
  };
}

function decodeXml(value = '') {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function linkValue(xml) {
  const rssLink = tagValue(xml, 'link');
  if (rssLink) return rssLink;
  const atom = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  return atom ? decodeXml(atom[1]) : '';
}

function parseFeedItems(xml, feedUrl) {
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ].map(match => match[0]);
  const sourceTitle = tagValue(xml, 'title') || new URL(feedUrl).hostname;
  return blocks.map(block => {
    const publishedRaw = tagValue(block, 'pubDate') || tagValue(block, 'dc:date') || tagValue(block, 'published') || tagValue(block, 'updated');
    const publishedAt = publishedRaw ? new Date(publishedRaw) : new Date();
    return {
      title: safeText(tagValue(block, 'title'), 220),
      link: safeText(linkValue(block), 1000),
      summary: safeText(tagValue(block, 'description') || tagValue(block, 'summary') || tagValue(block, 'content'), 700),
      publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
      source: safeText(sourceTitle, 120),
    };
  }).filter(item => item.title && item.link);
}

async function fetchSecurityFeedItems(window) {
  const allItems = [];
  for (const feed of securityNewsFeeds) {
    try {
      const xml = await fetchText(feed, { accept: 'application/rss+xml, application/atom+xml, text/xml' });
      allItems.push(...parseFeedItems(xml, feed));
    } catch (error) {
      console.warn(`[warn] feed failed ${feed}: ${error.message}`);
    }
  }
  const byLink = new Map();
  for (const item of allItems) {
    if (item.publishedAt < window.start || item.publishedAt > window.end) continue;
    if (!byLink.has(item.link)) byLink.set(item.link, item);
  }
  return Array.from(byLink.values())
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, newsLimit);
}

function recentKevNews(catalog, window) {
  return (Array.isArray(catalog?.vulnerabilities) ? catalog.vulnerabilities : [])
    .filter(row => {
      const addedAt = new Date(`${row.dateAdded}T12:00:00Z`);
      return !Number.isNaN(addedAt.getTime()) && addedAt >= window.start && addedAt <= window.end;
    })
    .sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')))
    .slice(0, newsLimit)
    .map(row => ({
      title: `CISA KEV 추가: ${row.cveID} ${safeText(row.vendorProject)} ${safeText(row.product)}`.trim(),
      link: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(row.cveID)}`,
      summary: safeText(row.shortDescription || row.vulnerabilityName || row.requiredAction, 700),
      publishedAt: new Date(`${row.dateAdded}T00:00:00Z`),
      source: 'CISA KEV',
    }));
}

async function securityNewsPost(feedItems, kevItems, window) {
  const today = window.reportDate;
  const items = [...feedItems, ...kevItems]
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, newsLimit);

  const sourceId = `security-news:${today}`;
  const fallbackBody = `${aiDraftWarning}

## 오늘의 보안 동향

수집 기준: ${window.label}

${items.length ? items.map((item, index) => `### ${index + 1}. ${item.title}

- 출처: ${item.source}
- 공개일: ${isoDate(item.publishedAt)}
- 링크: [원문](${item.link})
- 요약: ${item.summary || '본문 확인 후 요약을 보강하세요.'}
`).join('\n') : '이번 수집 기준 구간에서 자동 수집된 주요 보안 뉴스 항목은 없습니다.'}

## 메모

이 글은 공개 보안 공지와 신뢰할 수 있는 피드를 바탕으로 자동 정리했습니다. 각 조직의 환경에 따라 우선순위가 달라질 수 있으므로 실제 적용 여부는 원문과 운영 환경을 함께 확인해야 합니다.
`;
  const aiDraft = await generateAiDraft('security-news', {
    date: today,
    collection_window: {
      label: window.label,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      time_zone: automationTimeZone,
    },
    items: items.map(item => ({
      title: item.title,
      source: item.source,
      published_at: isoDate(item.publishedAt),
      link: item.link,
      summary: item.summary,
    })),
  }, fallbackBody);
  const content = aiDraft.content;

  return {
    slug: `security-news-${today}`,
    title: `${today} 보안 동향 브리핑`,
    description: items.length
      ? `${window.startDate} 09시부터 ${window.endDate} 08시 59분까지 수집한 보안뉴스 ${items.length}건 브리핑입니다.`
      : `${window.startDate} 09시부터 ${window.endDate} 08시 59분까지 수집된 신규 보안뉴스는 없습니다.`,
    date: today,
    category: 'security-news',
    tags: aiDraft.ai_generated_content
      ? ['security-news', 'automation', 'daily-brief', 'ai-draft']
      : ['security-news', 'automation', 'daily-brief'],
    draft: true,
    cover: '',
    is_private: false,
    source_type: 'security-news',
    source_url: items[0]?.link || 'https://www.boannews.com/custom/news_rss.asp',
    source_id: sourceId,
    auto_generated: true,
    review_status: 'pending',
    content,
    ai_generated_content: aiDraft.ai_generated_content,
    ai_model: aiDraft.ai_model || null,
  };
}

async function insertIfNew(store, post) {
  const existing = await store.existingSource(post.source_type, post.source_id, post.slug);
  if (existing) return skippedResult(existing);
  await store.insert(post);
  return {
    status: dryRun ? 'dry-run' : 'created',
    slug: post.slug,
    source_id: post.source_id,
    ai_generated_content: !!post.ai_generated_content,
    ai_model: post.ai_model || undefined,
  };
}

function skippedResult(existing) {
  return { status: 'skipped', slug: existing.slug, reason: `existing ${existing.review_status}` };
}

async function runCveDrafts(store, catalog) {
  const cves = await fetchNvdCves();
  const selected = rankCves(cves, kevMap(catalog));
  const results = [];
  for (const item of selected) {
    const existing = await store.existingSource('cve', item.id, cvePostSlug(item));
    if (existing) {
      results.push(skippedResult(existing));
      continue;
    }
    results.push(await insertIfNew(store, await cvePost(item)));
  }
  return { fetched: cves.length, selected: selected.length, results };
}

async function runSecurityNewsDraft(store, catalog) {
  const window = securityNewsWindow();
  const today = window.reportDate;
  const sourceId = `security-news:${today}`;
  const existing = await store.existingSource('security-news', sourceId, `security-news-${today}`);
  if (existing) return { window: window.label, feed_items: 0, kev_items: 0, results: [skippedResult(existing)] };

  const feedItems = await fetchSecurityFeedItems(window);
  const kevItems = securityNewsIncludeKev ? recentKevNews(catalog, window) : [];
  const post = await securityNewsPost(feedItems, kevItems, window);
  if (!post) return { window: window.label, feed_items: feedItems.length, kev_items: kevItems.length, results: [] };
  return {
    window: window.label,
    feed_items: feedItems.length,
    kev_items: kevItems.length,
    results: [await insertIfNew(store, post)],
  };
}

async function main() {
  if (!['all', 'cve', 'security-news'].includes(kind)) {
    throw new Error('Invalid --kind. Use all, cve, or security-news.');
  }

  const store = await createStore();
  await loadSchema(store);
  const catalog = await loadKevCatalog();
  const summary = {
    dry_run: dryRun,
    kind,
    ai_drafts: aiDraftsEnabled,
    ai_model: aiDraftsEnabled ? openaiDraftModel : null,
    cve: null,
    security_news: null,
  };

  try {
    if (kind === 'all' || kind === 'cve') summary.cve = await runCveDrafts(store, catalog);
    if (kind === 'all' || kind === 'security-news') summary.security_news = await runSecurityNewsDraft(store, catalog);
  } finally {
    await store.close();
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
