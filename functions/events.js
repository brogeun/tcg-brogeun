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

  const metadata = [
    ['property', 'og:type', 'website'],
    ['property', 'og:title', OG_TITLE],
    ['property', 'og:description', OG_DESC],
    ['property', 'og:image', OG_IMAGE],
    ['property', 'og:url', OG_URL],
    ['name', 'description', OG_DESC],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', OG_TITLE],
    ['name', 'twitter:description', OG_DESC],
    ['name', 'twitter:image', OG_IMAGE],
    ['name', 'twitter:url', OG_URL],
  ];
  for (const [attribute, name, value] of metadata) {
    const pattern = new RegExp(`<meta\\b[^>]*\\b${attribute}=["']${name}["'][^>]*>`, 'i');
    const tag = `<meta ${attribute}="${name}" content="${value}">`;
    html = pattern.test(html) ? html.replace(pattern, tag) : html.replace(/<\/head>/i, `${tag}\n</head>`);
  }
  const canonical = `<link rel="canonical" href="${OG_URL}">`;
  const canonicalPattern = /<link\b[^>]*\brel=["']canonical["'][^>]*>/i;
  html = canonicalPattern.test(html) ? html.replace(canonicalPattern, canonical) : html.replace(/<\/head>/i, `${canonical}\n</head>`);
  const title = `<title>${OG_TITLE}</title>`;
  html = /<title>[^<]*<\/title>/i.test(html) ? html.replace(/<title>[^<]*<\/title>/i, title) : html.replace(/<\/head>/i, `${title}\n</head>`);

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
    },
  });
}
