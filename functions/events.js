/**
 * GET /events
 * → 이벤트 페이지 전용 HTML (OG 메타 동적 교체)
 *
 * 카카오톡/페이스북/트위터에서 https://tcghub.kr/events 공유 시
 * 이벤트 페이지 미리보기가 나타나도록.
 */

const OG_TITLE = '이벤트 페이지 - TCG Hub';
const OG_DESC = '포켓몬 · 원피스 TCG 이벤트 정보. 카드쇼, 그레이딩 이벤트, 발매 일정 등 최신 소식을 한곳에서.';
const OG_IMAGE = 'https://tcghub.kr/images/brand-logo.png';
const OG_URL = 'https://tcghub.kr/events';

export async function onRequestGet({ request, env }) {
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

  html = html
    .replace(/<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${OG_TITLE}">`)
    .replace(/<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${OG_DESC}">`)
    .replace(/<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${OG_IMAGE}">`)
    .replace(/<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${OG_URL}">`)
    .replace(/<title>[^<]*<\/title>/i, `<title>${OG_TITLE}</title>`);

  if (!/<meta\s+property=["']og:title["']/i.test(html)) {
    const ogBlock = `
    <meta property="og:type" content="website">
    <meta property="og:url" content="${OG_URL}">
    <meta property="og:title" content="${OG_TITLE}">
    <meta property="og:description" content="${OG_DESC}">
    <meta property="og:image" content="${OG_IMAGE}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${OG_TITLE}">
    <meta name="twitter:description" content="${OG_DESC}">
    <meta name="twitter:image" content="${OG_IMAGE}">`;
    html = html.replace('</head>', `${ogBlock}\n</head>`);
  }

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
    },
  });
}
