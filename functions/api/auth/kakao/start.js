/**
 * GET /api/auth/kakao/start
 * → 카카오 OAuth 시작: CSRF state 생성, state cookie 셋팅, 카카오 authorize URL 로 302 redirect.
 */

function genState(len = 32) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function onRequestGet({ request, env }) {
  if (!env.KAKAO_CLIENT_ID) {
    return new Response('KAKAO_CLIENT_ID env not set', { status: 500 });
  }
  const url = new URL(request.url);
  const origin = url.origin;
  const state = genState();
  // ?app=1 이면 앱(Capacitor) 모드 — 콜백을 deep link 로 처리
  const isApp = url.searchParams.get('app') === '1';

  // 카카오 authorize URL — 검수 없는 기본 스코프 (profile_nickname)
  const params = new URLSearchParams({
    client_id: env.KAKAO_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/kakao/callback`,
    response_type: 'code',
    state,
    // scope 생략 시 카카오는 동의항목 설정에 따라 자동 처리 (닉네임 필수만 받음)
  });
  const kakaoUrl = `https://kauth.kakao.com/oauth/authorize?${params.toString()}`;

  const cookies = [
    `k_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
  ];
  if (isApp) {
    cookies.push('k_oauth_app=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300');
  }

  return new Response(null, {
    status: 302,
    headers: [
      ['Location', kakaoUrl],
      ...cookies.map(c => ['Set-Cookie', c]),
    ],
  });
}
