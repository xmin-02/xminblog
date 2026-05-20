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

function setMeta(html, attr, value, tag) {
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<meta\\s+${escapedAttr}=["']${escapedValue}["'][^>]*>`, 'i');
  if (re.test(html)) return html.replace(re, tag);
  return html.replace('</head>', `${tag}\n</head>`);
}

function injectPostHead(html, post, requestUrl) {
  const title = `${post.title || post.slug || '글'} — xmin.blog`;
  const description = post.description || 'xmin의 개인 블로그 — 보안, AI, 개발';
  const canonical = `${requestUrl.origin}/post/?slug=${encodeURIComponent(post.slug || requestUrl.searchParams.get('slug') || '')}`;
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
    image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : '',
    image ? `<meta name="twitter:image" content="${escapeHtml(image)}" />` : '',
    post.date ? `<meta property="article:published_time" content="${escapeHtml(post.date)}" />` : '',
    post.category ? `<meta property="article:section" content="${escapeHtml(post.category)}" />` : '',
    ...(Array.isArray(post.tags) ? post.tags.map(tag => `<meta property="article:tag" content="${escapeHtml(tag)}" />`) : []),
  ].filter(Boolean).join('\n    ');

  if (extras) html = html.replace('</head>', `    ${extras}\n</head>`);
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

async function withDynamicPostMeta(request, env, url) {
  const response = await env.ASSETS.fetch(request);
  const type = response.headers.get('content-type') || '';
  const slug = url.searchParams.get('slug');
  if (!slug || !response.ok || !type.includes('text/html')) return response;

  const post = await fetchPost(slug);
  if (!post || !post.slug) return response;

  const html = injectPostHead(await response.text(), post, url);
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
    if (request.method === 'GET' && PROXY_PATHS.has(url.pathname)) {
      const upstream = `${API_BASE}/api${url.pathname}`;
      try {
        const response = await fetch(upstream, {
          headers: {
            Accept: request.headers.get('Accept') || '*/*',
          },
        });
        if (response.ok) {
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: copyHeaders(response.headers),
          });
        }
      } catch {
        // Fall through to the static asset so crawlers do not get a hard failure
        // if the home-server API is temporarily unreachable.
      }
    }

    if (request.method === 'GET' && (url.pathname === '/post' || url.pathname === '/post/')) {
      return withDynamicPostMeta(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};
