/**
 * Cloudflare Pages middleware — sitemap.xml, robots.txt 강제 응답
 * (정적 파일 + _redirects SPA fallback 이 가로채는 문제 해결)
 */

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">

  <url>
    <loc>https://tcghub.kr/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>

  <url>
    <loc>https://tcghub.kr/#price</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>

  <url>
    <loc>https://tcghub.kr/#cardinfo</loc>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>

  <url>
    <loc>https://tcghub.kr/raffles</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>

  <url>
    <loc>https://tcghub.kr/events</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>

  <url>
    <loc>https://tcghub.kr/#info</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>

</urlset>`;

const ROBOTS_TXT = `# TCG Hub robots.txt

User-agent: *
Allow: /

Disallow: /api/
Disallow: /admin/

Sitemap: https://tcghub.kr/sitemap.xml

Crawl-delay: 1
`;

export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.pathname === '/sitemap.xml') {
    return new Response(SITEMAP_XML, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  if (url.pathname === '/robots.txt') {
    return new Response(ROBOTS_TXT, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // 다른 요청은 그대로 통과
  return context.next();
}
