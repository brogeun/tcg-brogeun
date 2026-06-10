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
    // 동적 sitemap — 박스 + 인기 카드 자동 포함
    const dynamicSitemap = await buildDynamicSitemap(context);
    return new Response(dynamicSitemap, {
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

async function buildDynamicSitemap(context) {
  const origin = new URL(context.request.url).origin;
  const urls = [
    { loc: 'https://tcghub.kr/', changefreq: 'daily', priority: '1.0' },
    { loc: 'https://tcghub.kr/#price', changefreq: 'daily', priority: '0.9' },
    { loc: 'https://tcghub.kr/#cardinfo', changefreq: 'weekly', priority: '0.9' },
    { loc: 'https://tcghub.kr/raffles', changefreq: 'daily', priority: '0.9' },
    { loc: 'https://tcghub.kr/events', changefreq: 'weekly', priority: '0.8' },
    { loc: 'https://tcghub.kr/#info', changefreq: 'weekly', priority: '0.7' },
  ];

  // 박스 + 인기 카드 자동 추가
  try {
    // 박스 — price-pokemon-box + price-onepiece-box
    for (const brand of ['pokemon', 'onepiece']) {
      try {
        const r = await fetch(`${origin}/data/price-${brand}-box.json`);
        if (r.ok) {
          const d = await r.json();
          for (const p of (d.products || []).slice(0, 30)) {
            if (p.id) urls.push({ loc: `https://tcghub.kr/price/${p.id}`, changefreq: 'daily', priority: '0.7' });
          }
        }
      } catch {}
    }
    // 인기 카드 — price-pokemon-card + price-onepiece-card
    for (const brand of ['pokemon', 'onepiece']) {
      try {
        const r = await fetch(`${origin}/data/price-${brand}-card.json`);
        if (r.ok) {
          const d = await r.json();
          for (const p of (d.products || []).slice(0, 30)) {
            if (p.id) urls.push({ loc: `https://tcghub.kr/price/${p.id}`, changefreq: 'daily', priority: '0.6' });
          }
        }
      } catch {}
    }
  } catch {}

  const urlEntries = urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;
}
