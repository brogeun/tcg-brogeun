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

  // The static /index.html rewrite canonicalizes this legacy destination to
  // /. Serve the app here so old Card Info links keep their intended route.
  if (/^\/cardinfo\/?$/.test(url.pathname)) {
    if (!['GET','HEAD'].includes(context.request.method)) return new Response('Method not allowed', {status:405,headers:{Allow:'GET, HEAD'}});
    const target = new URL('/', url);
    target.search = url.search;
    try {
      const response = context.env.ASSETS
        ? await context.env.ASSETS.fetch(new Request(target))
        : await fetch(target);
      if (!response.ok || !/\btext\/html\b/i.test(response.headers.get('Content-Type') || '')) return new Response('Page unavailable', {status:503});
      return new Response(context.request.method === 'HEAD' ? null : response.body, {status:200,headers:response.headers});
    } catch {
      return new Response('Page unavailable', {status:503});
    }
  }

  // Serve the original set URLs from packed static assets. This keeps every
  // card and old client URL while avoiding Pages' per-deployment file limit.
  if (url.pathname.startsWith('/data/tcg-card-info/')) {
    const match = url.pathname.match(/^\/data\/tcg-card-info\/([a-z_]+)\/([0-9a-f]{16}(?:-part[0-9]{2,6})?\.json)$/);
    if (!match) return new Response('Not found', {status:404});
    if (!['GET','HEAD'].includes(context.request.method)) return new Response('Method not allowed', {status:405,headers:{Allow:'GET, HEAD'}});
    const [,game,file] = match;
    const target = new URL('/data/tcg-card-info-packs/'+game+'/'+file.slice(0,2)+'.json', url);
    try {
      const response = context.env.ASSETS
        ? await context.env.ASSETS.fetch(new Request(target))
        : await fetch(target, {cf:{cacheTtl:3600}});
      // Other existing publication paths retain their unpacked static files.
      if (response.status === 404) return context.next();
      if (!response.ok) return new Response('Card data unavailable', {status:503});
      if (!/\bapplication\/json\b/i.test(response.headers.get('Content-Type') || '')) return context.next();
      const pack = await response.json();
      // A legacy SPA fallback is not a pack and must never masquerade as JSON.
      if (pack.schemaVersion !== 1 || pack.game !== game || !pack.files || typeof pack.files !== 'object') return new Response('Card data unavailable', {status:503});
      if (!Object.hasOwn(pack.files, file) || typeof pack.files[file] !== 'string') return context.next();
      return new Response(context.request.method === 'HEAD' ? null : pack.files[file], {
        headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'},
      });
    } catch {
      return new Response('Card data unavailable', {status:503});
    }
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

  // 다른 요청은 그대로 통과 (/sitemap.xml 포함 — functions/sitemap.xml.js 가 처리)
  return context.next();
}
