/**
 * Cloudflare Pages middleware — robots.txt 강제 응답
 * (정적 파일 + _redirects SPA fallback 이 가로채는 문제 해결)
 *
 * ※ sitemap.xml 가로채기는 제거됨 (2026-06-11)
 *   → functions/sitemap.xml.js 가 카드 2.4만 페이지 전체를 동적 생성하므로
 *     미들웨어가 가로채면 안 됨. /sitemap.xml 요청은 context.next() 로 통과.
 */

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

  if (url.pathname === '/robots.txt') {
    return new Response(ROBOTS_TXT, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // 다른 요청은 그대로 통과 (/sitemap.xml 포함 — functions/sitemap.xml.js 가 처리)
  return context.next();
}
