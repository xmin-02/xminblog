const SITE = 'https://xmin.blog';

export function GET() {
  return new Response([
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin/',
    'Disallow: /login/',
    'Disallow: /mypage/',
    '',
    `Sitemap: ${SITE}/sitemap.xml`,
    '',
  ].join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
