import { getCollection } from 'astro:content';

const SITE = 'https://xmin.blog';
const API_SITEMAP = 'https://api.xmin.cloud/api/sitemap.xml';

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function fallbackSitemap() {
  const posts = await getCollection('blog', ({ data }) => !data.draft && !data.is_private);
  const staticUrls = [
    { loc: `${SITE}/`, priority: '1.0' },
    { loc: `${SITE}/about/`, priority: '0.6' },
    { loc: `${SITE}/cve/`, priority: '0.6' },
    { loc: `${SITE}/security-news/`, priority: '0.6' },
  ];
  const postUrls = posts.map((post) => ({
    loc: `${SITE}/post/${encodeURIComponent(post.id.replace(/\.mdx?$/, ''))}/`,
    lastmod: post.data.date.toISOString(),
    priority: '0.8',
  }));

  const urls = [...staticUrls, ...postUrls].map((url) => `  <url>\n    <loc>${escapeXml(url.loc)}</loc>${url.lastmod ? `\n    <lastmod>${url.lastmod}</lastmod>` : ''}\n    <priority>${url.priority}</priority>\n  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export async function GET() {
  try {
    const res = await fetch(API_SITEMAP);
    if (res.ok) {
      return new Response(await res.text(), {
        headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      });
    }
  } catch {
    // Build-time fallback keeps local/static builds usable if the API is unavailable.
  }

  return new Response(await fallbackSitemap(), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
