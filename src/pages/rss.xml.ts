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
  const posts = (await getCollection('blog', ({ data }) => !data.draft && !data.is_private))
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

  const items = posts.map((post) => {
    const slug = post.id.replace(/\.mdx?$/, '');
    const url = `${SITE}/blog/${encodeURIComponent(slug)}/`;
    return `    <item>\n      <title>${escapeXml(post.data.title)}</title>\n      <link>${escapeXml(url)}</link>\n      <guid>${escapeXml(url)}</guid>\n      <description>${escapeXml(post.data.description)}</description>\n      <pubDate>${post.data.date.toUTCString()}</pubDate>\n    </item>`;
  }).join('\n');

  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>xmin.blog</title>\n    <link>${SITE}/</link>\n    <description>xmin의 개인 블로그 — 보안, AI, 개발</description>\n    <language>ko</language>\n${items}\n  </channel>\n</rss>\n`, {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
