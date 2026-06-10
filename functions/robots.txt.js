/**
 * GET /robots.txt
 * → Cloudflare Function 으로 직접 서빙
 */

const ROBOTS_TXT = `# TCG Hub robots.txt

User-agent: *
Allow: /

Disallow: /api/
Disallow: /admin/
Disallow: /#admin
Disallow: /#casing

Sitemap: https://tcghub.kr/sitemap.xml

Crawl-delay: 1
`;

export async function onRequestGet() {
  return new Response(ROBOTS_TXT, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
