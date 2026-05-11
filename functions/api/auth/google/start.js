/**
 * GET /api/auth/google/start
 * → Google OAuth 시작: CSRF state 생성, state cookie 셋팅, Google authorize URL 로 302 redirect.
 *
 * 흐름: 사용자가 "Google로 로그인" 클릭 → 이 엔드포인트 → Google → /callback 으로 돌아옴.
 */

function genState(len = 32) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  // base64url
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function onRequestGet({ request, env }) {
  if (!env.GOOGLE_CLIENT_ID) {
    return new Response('GOOGLE_CLIENT_ID env not set', { status: 500 });
  }
  const url = new URL(request.url);
  const origin = url.origin; // https://tcghub.kr
  const state = genState();

  // Google authorize URL — openid + email + profile 스코프
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
    include_granted_scopes: 'true',
  });
  const googleUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // state 를 HttpOnly cookie 에 저장 (5분 TTL)
  return new Response(null, {
    status: 302,
    headers: {
      'Location': googleUrl,
      'Set-Cookie': `g_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
    },
  });
}
