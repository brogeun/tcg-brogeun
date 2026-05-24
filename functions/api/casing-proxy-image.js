/**
 * TCG Casing — 카드 이미지 CORS proxy
 *
 * SNKRDUNK CDN 등 외부 CDN 이미지에 CORS 헤더가 없어 frontend canvas 에서 픽셀 읽기 차단됨.
 * Backend 가 server-side 로 fetch 한 뒤 same-origin 으로 반환 → canvas tainted 회피.
 *
 * 사용: GET /api/casing-proxy-image?url=<encoded URL>
 *
 * 보안: 화이트리스트 도메인만 허용 (남용 방지)
 */

const ALLOWED_HOSTS = new Set([
  'stockx-360.imgix.net',
  'imgs-snkrdunk.imgix.net',
  'snkrdunk.com',
  'cdn.snkrdunk.com',
  'stockx.imgix.net',
  // 우리 도메인 + 흔한 CDN
  'tcghub.kr',
  'cdn.jsdelivr.net',
  'raw.githubusercontent.com',
]);

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('url query param required', { status: 400 });
  }
  let parsed;
  try { parsed = new URL(target); }
  catch { return new Response('invalid url', { status: 400 }); }

  if (!/^https?:$/.test(parsed.protocol)) {
    return new Response('only http(s) allowed', { status: 400 });
  }
  // 호스트 화이트리스트 — 끝나는 부분으로 매칭 (서브도메인 허용)
  const host = parsed.hostname.toLowerCase();
  const isAllowed = Array.from(ALLOWED_HOSTS).some(h => host === h || host.endsWith('.' + h));
  if (!isAllowed) {
    return new Response(`host not allowed: ${host}`, { status: 403 });
  }

  try {
    const resp = await fetch(parsed.href, {
      // 일부 CDN 은 referer 체크 — 우리 도메인으로 위장
      headers: { 'Referer': 'https://tcghub.kr/', 'User-Agent': 'Mozilla/5.0 (compatible; tcghub/1.0)' },
      cf: { cacheTtl: 86400, cacheEverything: true }, // 24h cache
    });
    if (!resp.ok) {
      return new Response(`upstream ${resp.status}`, { status: resp.status });
    }
    // 응답 헤더 — CORS 허용 + content-type 유지 + 캐시
    const ct = resp.headers.get('Content-Type') || 'image/jpeg';
    return new Response(resp.body, {
      status: 200,
      headers: {
        'Content-Type': ct,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    });
  } catch (e) {
    return new Response(`fetch failed: ${e.message}`, { status: 502 });
  }
}
