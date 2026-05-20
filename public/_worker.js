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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && PROXY_PATHS.has(url.pathname)) {
      const upstream = `${API_BASE}/api${url.pathname}`;
      const response = await fetch(upstream, {
        headers: {
          Accept: request.headers.get('Accept') || '*/*',
        },
      });
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: copyHeaders(response.headers),
      });
    }

    return env.ASSETS.fetch(request);
  },
};
