/**
 * GET /sitemap.xml — 동적 생성
 * 정적 페이지 + 카드 상세 페이지(/price/:id) 전체를 포함.
 * /price/[id].js 가 카드별 OG + JSON-LD 를 이미 서빙하므로,
 * 사이트맵에 등록만 하면 구글이 카드 2.4만 페이지를 인덱싱할 수 있음.
 * ("리자몽 ex 시세" 같은 롱테일 검색 유입 → 앱 설치 퍼널)
 *
 * cards-meta-index.json 기반, Cache API 로 24시간 캐시.
 * ※ 사이트맵 1개 한도는 URL 50,000개 — 카드가 4만 개를 넘으면 sitemap index 로 분리할 것.
 */

const ORIGIN = 'https://tcghub.kr';

const STATIC_URLS = [
  { loc: `${ORIGIN}/`, changefreq: 'daily', priority: '1.0' },
  { loc: `${ORIGIN}/raffles`, changefreq: 'daily', priority: '0.9' },
  { loc: `${ORIGIN}/events`, changefreq: 'weekly', priority: '0.8' },
];

function escXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function onRequestGet({ request, env }) {
  // 24시간 엣지 캐시 (메타 인덱스 3.4MB 를 매 요청마다 읽지 않도록)
  const cache = caches.default;
  const cacheKey = new Request(`${ORIGIN}/sitemap.xml`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 카드 ID 목록 로드 — 실패해도 정적 페이지만으로 서빙
  let cardIds = [];
  try {
    const url = new URL(request.url);
    url.pathname = '/data/cards-meta-index.json';
    url.search = '';
    const resp = env.ASSETS
      ? await env.ASSETS.fetch(new Request(url))
      : await fetch(url);
    if (resp.ok) cardIds = Object.keys(await resp.json());
  } catch (e) {
    // 무시 — 정적 URL 만 포함
  }

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const u of STATIC_URLS) {
    parts.push(`<url><loc>${u.loc}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`);
  }
  for (const id of cardIds) {
    parts.push(`<url><loc>${ORIGIN}/price/${escXml(encodeURIComponent(id))}</loc><changefreq>weekly</changefreq><priority>0.6</priority></url>`);
  }
  parts.push('</urlset>');

  const res = new Response(parts.join('\n'), {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
  try { await cache.put(cacheKey, res.clone()); } catch (e) { /* 캐시 실패 무시 */ }
  return res;
}
