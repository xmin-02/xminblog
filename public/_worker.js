const API_BASE = 'https://api.xmin.cloud';
const PROXY_PATHS = new Set(['/rss.xml', '/feed.xml', '/sitemap.xml']);

function copyHeaders(headers) {
  const next = new Headers();
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (lower === 'content-type' || lower === 'cache-control' || lower === 'etag' || lower === 'last-modified') {
      next.set(key, value);
    }
  }
  next.set('Access-Control-Allow-Origin', '*');
  return next;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function absoluteUrl(value, origin) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try { return new URL(raw, origin).toString(); } catch { return ''; }
}

function postPath(slug) {
  return `/post/${encodeURIComponent(slug)}/`;
}

function postCanonicalUrl(slug, origin) {
  return `${origin}${postPath(slug)}`;
}

function safeDecodeURIComponent(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalizePostLinks(value) {
  return String(value ?? '').replace(/https:\/\/xmin\.blog\/post\/\?slug=([^<\s"'&]+)/g, (_, slug) => {
    return `https://xmin.blog${postPath(safeDecodeURIComponent(slug))}`;
  });
}

function postSlugFromUrl(url) {
  if (url.pathname === '/post' || url.pathname === '/post/') {
    return url.searchParams.get('slug') || '';
  }
  const match = url.pathname.match(/^\/post\/([^/]+)\/?$/);
  return match ? safeDecodeURIComponent(match[1]) : '';
}

function lowerText(value) {
  return String(value || '').trim().toLowerCase();
}

function postTime(post) {
  const dateTime = post?.date ? new Date(post.date).getTime() : NaN;
  if (Number.isFinite(dateTime)) return dateTime;
  const updatedTime = post?.updated_at ? Number(post.updated_at) * 1000 : NaN;
  if (Number.isFinite(updatedTime)) return updatedTime;
  return 0;
}

function titleTokens(value) {
  return new Set(lowerText(value).split(/[^a-z0-9가-힣]+/).filter(token => token.length >= 3));
}

function relatedScore(current, candidate) {
  if (!candidate || candidate.slug === current.slug || candidate.draft || candidate.is_private) return -1;
  let score = 0;
  if (lowerText(candidate.category) && lowerText(candidate.category) === lowerText(current.category)) score += 8;

  const currentTags = new Set((current.tags || []).map(lowerText).filter(Boolean));
  for (const tag of candidate.tags || []) {
    if (currentTags.has(lowerText(tag))) score += 4;
  }

  const currentTokens = titleTokens(`${current.title || ''} ${current.description || ''}`);
  for (const token of titleTokens(`${candidate.title || ''} ${candidate.description || ''}`)) {
    if (currentTokens.has(token)) score += 1;
  }

  return score || (postTime(candidate) ? 0.1 : 0);
}

function pickRelatedPosts(current, posts, limit = 4) {
  return (Array.isArray(posts) ? posts : [])
    .map(post => ({ post, score: relatedScore(current, post) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || postTime(b.post) - postTime(a.post))
    .slice(0, limit)
    .map(item => item.post);
}

function renderRelatedPosts(related) {
  if (!related.length) return '';
  return `
            <aside class="mt-10 pt-6 border-t border-[var(--color-border)]" aria-label="관련 글">
              <p class="text-sm font-bold mb-4" style="font-family:var(--font-display);color:var(--color-text);">관련 글</p>
              <div class="grid gap-3 sm:grid-cols-2">
                ${related.map(post => `
                  <a href="${postPath(post.slug)}" class="block rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4 transition-colors hover:border-[var(--color-accent)]">
                    <span class="text-[10px] font-semibold uppercase tracking-wide" style="color:var(--color-accent);font-family:var(--font-mono);">${escapeHtml(post.category || 'post')}</span>
                    <span class="block mt-1 text-sm font-semibold leading-snug" style="color:var(--color-text);">${escapeHtml(post.title || post.slug)}</span>
                    ${post.description ? `<span class="block mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">${escapeHtml(post.description)}</span>` : ''}
                  </a>`).join('')}
              </div>
            </aside>`;
}

function setMeta(html, attr, value, tag) {
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<meta\\s+${escapedAttr}=["']${escapedValue}["'][^>]*>`, 'i');
  if (re.test(html)) return html.replace(re, tag);
  return html.replace('</head>', `${tag}\n</head>`);
}

function decodeBasicEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function contentParagraphs(content) {
  let text = String(content ?? '');
  text = text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|table|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = decodeBasicEntities(text)
    .replace(/```[a-z0-9_-]*\n?|\n?```/gi, '\n')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[>*-]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.split(/\n{2,}/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 24);
}

function renderInitialArticle(post, canonical, related = []) {
  const date = post.date ? new Date(post.date).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const tags = Array.isArray(post.tags) ? post.tags : [];
  const image = absoluteUrl(post.cover, canonical);
  const body = post.content
    ? contentParagraphs(post.content).map(p => `<p>${escapeHtml(p)}</p>`).join('\n')
    : '<p>이 글은 비공개이거나 본문을 불러올 수 없습니다.</p>';

  return `
          <article data-ssr-post>
            ${image ? `<div class="post-cover"><img src="${escapeHtml(image)}" alt="${escapeHtml(post.title || '')}" loading="eager" /></div>` : ''}
            <header class="mb-10 pb-8 border-b border-[var(--color-border)]">
              <div class="flex flex-wrap items-center gap-2 mb-4" style="font-family: var(--font-mono);">
                ${post.category ? `<span class="text-xs font-medium" style="color:var(--color-accent);">[${escapeHtml(post.category)}]</span>` : ''}
                ${date ? `<span class="text-xs text-[var(--color-text-secondary)]">${escapeHtml(date)}</span>` : ''}
              </div>
              <h1 class="text-2xl sm:text-3xl font-bold leading-snug mb-4 tracking-tight" style="font-family:var(--font-display);color:var(--color-text);">${escapeHtml(post.title || post.slug || '글')}</h1>
              ${post.description ? `<p class="text-base text-[var(--color-text-secondary)] leading-relaxed">${escapeHtml(post.description)}</p>` : ''}
              ${tags.length ? `<div class="flex flex-wrap gap-2 mt-4">${tags.map(tag => `<span class="px-2.5 py-1 rounded-full text-xs text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
            </header>
            <div class="prose prose-lg max-w-none" id="prose-content">
              ${body}
            </div>
            ${renderRelatedPosts(related)}
          </article>`;
}

function structuredData(post, canonical, image) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title || post.slug || '글',
    description: post.description || '',
    datePublished: post.date || undefined,
    dateModified: post.updated_at ? new Date(Number(post.updated_at) * 1000).toISOString() : post.date || undefined,
    mainEntityOfPage: canonical,
    url: canonical,
    image: image || undefined,
    author: {
      '@type': 'Person',
      name: 'Sumin Joo',
      alternateName: 'xmin',
      url: 'https://xmin.sh/',
    },
    publisher: {
      '@type': 'Person',
      name: 'Sumin Joo',
      alternateName: 'xmin',
      url: 'https://xmin.sh/',
    },
  }).replace(/</g, '\\u003c');
}

function injectPostHead(html, post, requestUrl, posts = []) {
  const title = `${post.title || post.slug || '글'} — xmin.blog`;
  const description = post.description || '주수민의 보안 리서치 노트 — 퍼징, 바이너리 분석, AI';
  const canonical = postCanonicalUrl(post.slug || requestUrl.searchParams.get('slug') || postSlugFromUrl(requestUrl), requestUrl.origin);
  const image = absoluteUrl(post.cover, requestUrl.origin);

  html = html.replace(/<title>.*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  html = html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${escapeHtml(canonical)}" />`);
  html = setMeta(html, 'name', 'description', `<meta name="description" content="${escapeHtml(description)}" />`);
  html = setMeta(html, 'property', 'og:title', `<meta property="og:title" content="${escapeHtml(title)}" />`);
  html = setMeta(html, 'property', 'og:description', `<meta property="og:description" content="${escapeHtml(description)}" />`);
  html = setMeta(html, 'property', 'og:type', `<meta property="og:type" content="article" />`);
  html = setMeta(html, 'property', 'og:url', `<meta property="og:url" content="${escapeHtml(canonical)}" />`);
  html = setMeta(html, 'name', 'twitter:card', '<meta name="twitter:card" content="summary_large_image" />');

  const extras = [
    (post.draft || post.is_private) ? '<meta name="robots" content="noindex, nofollow" />' : '',
    image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : '',
    image ? `<meta name="twitter:image" content="${escapeHtml(image)}" />` : '',
    post.date ? `<meta property="article:published_time" content="${escapeHtml(post.date)}" />` : '',
    post.category ? `<meta property="article:section" content="${escapeHtml(post.category)}" />` : '',
    ...(Array.isArray(post.tags) ? post.tags.map(tag => `<meta property="article:tag" content="${escapeHtml(tag)}" />`) : []),
    `<script type="application/ld+json">${structuredData(post, canonical, image)}</script>`,
  ].filter(Boolean).join('\n    ');

  if (extras) html = html.replace('</head>', `    ${extras}\n</head>`);
  html = html.replace(
    /<div id="post-container">[\s\S]*?<\/div>\s*<!-- Comments section/,
    `<div id="post-container">${renderInitialArticle(post, canonical, pickRelatedPosts(post, posts))}\n        </div>\n\n        <!-- Comments section`,
  );
  return html;
}

async function fetchPost(slug) {
  try {
    const response = await fetch(`${API_BASE}/api/posts/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchPublicPosts() {
  try {
    const response = await fetch(`${API_BASE}/api/posts`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const posts = await response.json();
    return Array.isArray(posts) ? posts.filter(post => !post.draft && !post.is_private) : [];
  } catch {
    return [];
  }
}

async function withDynamicPostMeta(request, env, url) {
  const assetUrl = new URL('/post/', url.origin);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  const type = response.headers.get('content-type') || '';
  const slug = postSlugFromUrl(url);
  if (!slug || !response.ok || !type.includes('text/html')) return response;

  const [post, posts] = await Promise.all([fetchPost(slug), fetchPublicPosts()]);
  if (!post || !post.slug) return response;

  const html = injectPostHead(await response.text(), post, url, posts);
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'public, max-age=120');
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isReadRequest = request.method === 'GET' || request.method === 'HEAD';
    if (isReadRequest && PROXY_PATHS.has(url.pathname)) {
      const upstream = `${API_BASE}/api${url.pathname}`;
      try {
        const response = await fetch(upstream, {
          headers: {
            Accept: request.headers.get('Accept') || '*/*',
          },
        });
        if (response.ok) {
          const headers = copyHeaders(response.headers);
          if (request.method === 'HEAD') {
            return new Response(null, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          }
          headers.delete('etag');
          return new Response(normalizePostLinks(await response.text()), {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
      } catch {
        // Fall through to the static asset so crawlers do not get a hard failure
        // if the home-server API is temporarily unreachable.
      }
    }

    if (isReadRequest && (url.pathname === '/post' || url.pathname === '/post/') && url.searchParams.get('slug')) {
      return Response.redirect(`${url.origin}${postPath(url.searchParams.get('slug'))}`, 301);
    }

    if (isReadRequest && postSlugFromUrl(url)) {
      return withDynamicPostMeta(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};
