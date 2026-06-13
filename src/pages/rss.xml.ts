import { getCollection } from 'astro:content';

const SITE = 'https://xmin.blog';
const API_RSS = 'https://api.xmin.cloud/api/rss.xml';

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function fallbackRss() {
  const posts = (await getCollection('blog', ({ data }) => !data.draft && !data.is_private))
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());

  const items = posts.map((post) => {
    const slug = post.id.replace(/\.mdx?$/, '');
    const url = `${SITE}/post/?slug=${encodeURIComponent(slug)}`;
    return `    <item>\n      <title>${escapeXml(post.data.title)}</title>\n      <link>${escapeXml(url)}</link>\n      <guid isPermaLink="true">${escapeXml(url)}</guid>\n      <description>${escapeXml(post.data.description)}</description>\n      <pubDate>${post.data.date.toUTCString()}</pubDate>\n    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n  <channel>\n    <title>xmin.blog</title>\n    <link>${SITE}/</link>\n    <description>주수민의 보안 리서치 노트 — 퍼징, 바이너리 분석, AI</description>\n    <language>ko</language>\n${items}\n  </channel>\n</rss>\n`;
}

export async function GET() {
  try {
    const res = await fetch(API_RSS);
    if (res.ok) {
      return new Response(await res.text(), {
        headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
      });
    }
  } catch {
    // Build-time fallback keeps local/static builds usable if the API is unavailable.
  }

  return new Response(await fallbackRss(), {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
