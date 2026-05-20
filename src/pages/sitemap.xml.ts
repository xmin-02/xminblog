import { getCollection } from 'astro:content';

const SITE = 'https://xmin.blog';

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET() {
  const posts = await getCollection('blog', ({ data }) => !data.draft && !data.is_private);
  const staticUrls = [
    { loc: `${SITE}/`, priority: '1.0' },
    { loc: `${SITE}/about/`, priority: '0.6' },
  ];
  const postUrls = posts.map((post) => ({
    loc: `${SITE}/blog/${encodeURIComponent(post.id.replace(/\.mdx?$/, ''))}/`,
    lastmod: post.data.date.toISOString(),
    priority: '0.8',
  }));

  const urls = [...staticUrls, ...postUrls].map((url) => `  <url>\n    <loc>${escapeXml(url.loc)}</loc>${url.lastmod ? `\n    <lastmod>${url.lastmod}</lastmod>` : ''}\n    <priority>${url.priority}</priority>\n  </url>`).join('\n');

  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
