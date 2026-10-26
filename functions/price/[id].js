/** Card-specific, snapshot-backed sharing and search metadata. */
const ORIGIN = 'https://tcghub.kr';
const MAX_QUOTE_AGE_MS = 36 * 60 * 60 * 1000;

function response(body, status, extra = {}) {
  return new Response(body, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=600' : 'no-store',
    ...extra,
  } });
}

function unavailable(status, message) {
  return response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${message} | TCG Hub</title></head><body>${message}</body></html>`, status, { 'X-Robots-Tag': 'noindex' });
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeName(value) {
  return String(value).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function recent(value, now) {
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && stamp <= now + 60 * 1000 && now - stamp <= MAX_QUOTE_AGE_MS;
}

function replaceMeta(html, attribute, key, value) {
  const tag = `<meta ${attribute}="${key}" content="${escapeAttr(value)}">`;
  const pattern = new RegExp(`<meta\\s+${attribute}=["']${key}["'][^>]*>`, 'i');
  return pattern.test(html) ? html.replace(pattern, () => tag) : html.replace('</head>', () => `${tag}\n</head>`);
}

export async function onRequestGet({ request, env, params }) {
  const cardId = String(params?.id || '');
  // Only IDs represented by the numeric public metadata index are supported.
  if (!/^\d{1,20}$/.test(cardId)) return unavailable(404, '카드를 찾을 수 없습니다');
  const requestOrigin = new URL(request.url).origin;
  let meta;
  try {
    const resp = await fetch(`${requestOrigin}/data/cards-meta-index.json`);
    if (!resp.ok) throw new Error('metadata unavailable');
    meta = await resp.json();
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('invalid metadata');
  } catch {
    // An upstream failure must not turn real cards into cacheable 404s.
    return unavailable(503, '카드 정보를 잠시 불러올 수 없습니다');
  }
  const card = Object.hasOwn(meta, cardId) ? meta[cardId] : null;
  if (!card || typeof card.name !== 'string' || !card.name.trim()) return unavailable(404, '카드를 찾을 수 없습니다');

  let html;
  try {
    const url = new URL(request.url);
    url.pathname = '/index.html'; url.search = '';
    const resp = env.ASSETS
      ? await env.ASSETS.fetch(new Request(url, { headers: request.headers }))
      : await fetch(url);
    if (!resp.ok) throw new Error('page unavailable');
    html = await resp.text();
    if (!html || !html.includes('</head>')) throw new Error('invalid page');
  } catch {
    return unavailable(503, '페이지를 잠시 불러올 수 없습니다');
  }

  const cleanName = decodeName(card.name);
  const cardCode = typeof card.code === 'string' ? card.code : '';
  const cardBrand = ({ pokemon: '포켓몬', onepiece: '원피스' })[card.brand] || 'TCG';
  const ogImage = `${ORIGIN}/images/brand-logo.png`;
  const ogUrl = `${ORIGIN}/price/${cardId}`;
  let krwPrice = null;
  try {
    const detailResp = await fetch(`${requestOrigin}/data/cards-detail.json`);
    if (detailResp.ok) {
      const detail = await detailResp.json();
      const item = detail?.cards?.[cardId];
      const quote = item?.grades?.psa10;
      const amount = quote?.lowest_ask;
      // Missing/stale/zero prices are unknown; they never establish a free item.
      if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && recent(item?.fetchedAt || detail?.fetchedAt, Date.now())) {
        if (quote.currency === 'KRW') krwPrice = Math.floor(amount);
        else if (['USD', 'JPY', 'CNY'].includes(quote.currency)) {
          const fxResp = await fetch(`${requestOrigin}/data/fx-rates.json`);
          if (fxResp.ok) {
            const fx = await fxResp.json();
            const rate = fx?.rates?.[quote.currency];
            if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && recent(fx.updated, Date.now())) krwPrice = Math.floor(amount * rate);
          }
        }
      }
    }
  } catch { /* Keep the named card page available without an unverified price. */ }
  if (!Number.isSafeInteger(krwPrice) || krwPrice <= 0) krwPrice = null;

  const ogTitle = `${cleanName} - ${krwPrice === null ? '시세' : `PSA10 참고 호가 ₩${krwPrice.toLocaleString('ko-KR')}`} | TCG Hub`;
  const ogDesc = `${cardBrand} TCG 카드 ${cleanName}${cardCode ? ` [${cardCode}]` : ''}의 SNKRDUNK 시세, PSA10·PSA9·A급 등급별 가격, 거래량 차트를 TCG Hub에서 확인하세요.`;
  for (const [key, value] of Object.entries({ 'og:title': ogTitle, 'og:description': ogDesc, 'og:image': ogImage, 'og:url': ogUrl })) html = replaceMeta(html, 'property', key, value);
  for (const [key, value] of Object.entries({ 'description': ogDesc, 'twitter:title': ogTitle, 'twitter:description': ogDesc, 'twitter:image': ogImage })) html = replaceMeta(html, 'name', key, value);
  html = html.replace(/<title>[^<]*<\/title>/i, () => `<title>${escapeAttr(ogTitle)}</title>`);
  const canonical = `<link rel="canonical" href="${ogUrl}">`;
  html = /<link\s+rel=["']canonical["'][^>]*>/i.test(html)
    ? html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, () => canonical)
    : html.replace('</head>', () => `${canonical}\n</head>`);

  const product = { '@context': 'https://schema.org', '@type': 'Product', name: cleanName,
    description: ogDesc, image: ogImage, brand: { '@type': 'Brand', name: cardBrand } };
  if (krwPrice !== null) product.offers = { '@type': 'Offer', price: String(krwPrice), priceCurrency: 'KRW', url: ogUrl };
  // JSON serialization preserves names accurately; escaping '<' prevents script termination.
  const jsonLd = JSON.stringify(product).replace(/</g, '\\u003c');
  html = html.replace('</head>', () => `<script type="application/ld+json">${jsonLd}</script>\n</head>`);
  return response(html, 200);
}
