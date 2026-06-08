/**
 * GET /raffles
 * → 응모 페이지 전용 HTML (OG 메타 동적 교체)
 *
 * 카카오톡/페이스북/트위터에서 https://tcghub.kr/raffles 공유 시
 * 응모 페이지 미리보기가 나타나도록.
 *
 * 실제 페이지 로딩은 index.html 그대로 — JS 라우터가 pathname 보고 응모 탭 자동 전환.
 */

const OG_TITLE = '응모 페이지 - TCG Hub';
const OG_DESC = '포켓몬 · 원피스 TCG 박스 응모 정보. 아마존 JP 한정 박스 응모, 그레이딩 이벤트, 오리파 등 한곳에서.';
const OG_IMAGE = 'https://tcghub.kr/images/brand-logo.png';
const OG_URL = 'https://tcghub.kr/raffles';

export async function onRequestGet({ request, env, next }) {
  // 정적 index.html 가져옴 (Pages 의 ASSETS binding 활용)
  let html;
  try {
    if (env.ASSETS) {
      const url = new URL(request.url);
      url.pathname = '/index.html';
      const resp = await env.ASSETS.fetch(new Request(url, { headers: request.headers }));
      html = await resp.text();
    } else {
      // 폴백 — origin 의 / 로 fetch
      const origin = new URL(request.url).origin;
      const resp = await fetch(`${origin}/index.html`);
      html = await resp.text();
    }
  } catch (e) {
    return new Response('Failed to load page', { status: 500 });
  }

  if (!html) return new Response('No HTML', { status: 500 });

  // OG 메타 교체 — 기존 og:title, og:description, og:image, og:url 모두 새 값으로
  html = html
    .replace(/<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${OG_TITLE}">`)
    .replace(/<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${OG_DESC}">`)
    .replace(/<meta\s+property=["']og:image["'][^>]*>/i, `<meta property="og:image" content="${OG_IMAGE}">`)
    .replace(/<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${OG_URL}">`)
    .replace(/<title>[^<]*<\/title>/i, `<title>${OG_TITLE}</title>`);

  // og:title 등이 원본에 없으면 head 끝에 추가
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
