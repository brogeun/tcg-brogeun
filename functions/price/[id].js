/**
 * GET /price/:id
 * → 카드/박스별 동적 OG 메타 + JSON-LD Product 마크업
 *
 * 효과:
 *  - 카톡/페북 공유 시 카드명·가격·이미지 정확히 표시
 *  - 구글 검색 결과에 가격·이미지 rich snippet 표시
 *  - 각 카드가 독립 SEO 페이지로 인덱싱
 */

export async function onRequestGet({ request, env, params }) {
  const cardId = params.id;
  if (!cardId) {
    return new Response('Card ID required', { status: 400 });
  }

  // index.html 가져오기
  let html;
  try {
    if (env.ASSETS) {
      const url = new URL(request.url);
      url.pathname = '/index.html';
      const resp = await env.ASSETS.fetch(new Request(url, { headers: request.headers }));
      html = await resp.text();
    } else {
      const origin = new URL(request.url).origin;
      const resp = await fetch(`${origin}/index.html`);
      html = await resp.text();
    }
  } catch (e) {
    return new Response('Failed to load page', { status: 500 });
  }
  if (!html) return new Response('No HTML', { status: 500 });

  // 카드 메타 정보 조회 (cards-meta-index.json + cards-detail.json)
  let cardName = 'TCG 카드';
  let cardCode = '';
  let cardBrand = 'TCG';
  let cardPrice = 0;
  let cardCurrency = 'KRW';
  let cardImage = 'https://tcghub.kr/images/brand-logo.png';

  try {
    const origin = new URL(request.url).origin;
    // 1) 메타 인덱스 (이름, 코드, 브랜드)
    const metaResp = await fetch(`${origin}/data/cards-meta-index.json`);
    if (metaResp.ok) {
      const meta = await metaResp.json();
      const m = meta[cardId];
      if (m) {
        cardName = m.name || cardName;
        cardCode = m.code || '';
        cardBrand = m.brand === 'pokemon' ? '포켓몬' : (m.brand === 'onepiece' ? '원피스' : 'TCG');
      }
    }
    // 2) cards-detail.json (가격, 이미지)
    const detailResp = await fetch(`${origin}/data/cards-detail.json`);
    if (detailResp.ok) {
      const detail = await detailResp.json();
      const c = detail.cards?.[cardId];
      if (c) {
        const psa10 = c.grades?.psa10;
        if (psa10?.lowest_ask) {
          cardPrice = psa10.lowest_ask;
          cardCurrency = psa10.currency || 'USD';
        }
      }
    }
  } catch (e) {
    // 메타 못 가져와도 진행
  }

  // 가격 KRW 환산 (대략)
  let krwPrice = cardPrice;
  if (cardCurrency === 'USD') krwPrice = Math.floor(cardPrice * 1380);
  else if (cardCurrency === 'JPY') krwPrice = Math.floor(cardPrice * 9.5);

  // 카드명 정제 (HTML entity 디코드)
  const cleanName = cardName.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  // OG 메타 값
  const ogTitle = `${cleanName} - 시세 ₩${krwPrice.toLocaleString()} | TCG Hub`;
  const ogDesc = `${cardBrand} TCG 카드 ${cleanName}${cardCode ? ` [${cardCode}]` : ''}의 실시간 SNKRDUNK 시세, PSA10·PSA9·A급 등급별 가격, 거래량 차트를 TCG Hub 에서 확인하세요.`;
  const ogImage = cardImage;
  const ogUrl = `https://tcghub.kr/price/${cardId}`;

  // HTML 의 OG 메타 교체
  html = html
    .replace(/<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${escapeAttr(ogTitle)}">`)
    .replace(/<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${escapeAttr(ogDesc)}">`)
    .replace(/<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${ogImage}">`)
    .replace(/<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${ogUrl}">`)
    .replace(/<title>[^<]*<\/title>/i, `<title>${escapeAttr(ogTitle)}</title>`)
    .replace(/<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${escapeAttr(ogDesc)}">`);

  // JSON-LD Product 마크업 추가
  const productJsonLd = `
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "${escapeAttr(cleanName)}",
  "description": "${escapeAttr(ogDesc)}",
  "image": "${ogImage}",
  "brand": {
    "@type": "Brand",
    "name": "${cardBrand}"
  },
  "offers": {
    "@type": "Offer",
    "price": "${krwPrice}",
    "priceCurrency": "KRW",
    "availability": "https://schema.org/InStock",
    "url": "${ogUrl}"
  }
}
</script>`;
  html = html.replace('</head>', `${productJsonLd}\n</head>`);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
    },
  });
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
