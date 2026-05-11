/**
 * GET /api/auth/google/callback?code=...&state=...
 * → Google 에서 돌아오는 콜백.
 *
 * 1. state CSRF 검증 (cookie 값과 비교)
 * 2. code 를 access_token 으로 교환 (POST oauth2.googleapis.com/token)
 * 3. access_token 으로 userinfo 가져오기 (GET googleapis.com/oauth2/v3/userinfo)
 * 4. DB 에서 users 조회/생성 (이메일 매직링크와 동일 user 통합)
 * 5. JWT 발급 + session cookie 셋팅 + 홈으로 redirect
 */
import { signJwt } from '../../../_shared/jwt.js';

const SESSION_DAYS = 30;

function errorPage(title, message) {
  return new Response(`
<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><title>로그인 실패 — TCG Hub</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f9fafb;margin:0;padding:24px;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{max-width:420px;background:#fff;padding:32px;border-radius:14px;border:1px solid #e5e7eb;text-align:center}
h1{color:#dc2626;margin:0 0 12px;font-size:20px}
p{color:#4b5563;line-height:1.65;margin:0 0 20px;word-break:break-word}
a{display:inline-block;padding:10px 20px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px}
</style></head>
<body><div class="box">
  <div style="font-size:36px;margin-bottom:12px">⚠️</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <a href="/">← 홈으로</a>
</div></body></html>`, {
    status: 400,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // state cookie 청소
      'Set-Cookie': 'g_oauth_state=; Path=/; Max-Age=0',
    },
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return errorPage('서버 오류', 'D1 database not bound');
  if (!env.JWT_SECRET) return errorPage('서버 오류', 'JWT_SECRET not set');
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return errorPage('서버 오류', 'GOOGLE_CLIENT_ID / SECRET env not set');
  }

  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return errorPage('Google 로그인 취소', `Google 에서 거부되었습니다: ${errorParam}`);
  }
  if (!code || !state) {
    return errorPage('잘못된 요청', 'code 또는 state 파라미터가 없습니다.');
  }

  // CSRF state 검증
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)g_oauth_state=([^;]+)/);
  if (!m || m[1] !== state) {
    return errorPage('보안 오류', 'CSRF state 검증 실패. 다시 시도해주세요.');
  }

  // 1) code → access_token 교환
  let tokenData;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${origin}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return errorPage('토큰 교환 실패', JSON.stringify(tokenData));
    }
  } catch (e) {
    return errorPage('서버 오류', `토큰 교환 중 오류: ${e.message || e}`);
  }

  // 2) access_token → userinfo 조회
  let userinfo;
  try {
    const uiRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    userinfo = await uiRes.json();
    if (!uiRes.ok || !userinfo.email) {
      return errorPage('사용자 정보 조회 실패', JSON.stringify(userinfo));
    }
  } catch (e) {
    return errorPage('서버 오류', `사용자 정보 조회 중 오류: ${e.message || e}`);
  }

  const email = String(userinfo.email).toLowerCase().trim();
  const name = userinfo.name || null;
  const now = Math.floor(Date.now() / 1000);

  // 3) DB 사용자 조회/생성 (이메일 매직링크와 동일한 users 테이블 — 같은 user 통합)
  let user;
  try {
    user = await env.DB.prepare(
      'SELECT id, email, name FROM users WHERE email = ?'
    ).bind(email).first();
  } catch (e) {
    return errorPage('서버 오류', `사용자 조회 실패: ${e.message || e}`);
  }

  if (!user) {
    const userId = crypto.randomUUID();
    try {
      await env.DB.prepare(
        'INSERT INTO users (id, email, name, last_login) VALUES (?, ?, ?, ?)'
      ).bind(userId, email, name, now).run();
    } catch (e) {
      // name 컬럼 없을 수도 있음 — name 빼고 재시도
      try {
        await env.DB.prepare(
          'INSERT INTO users (id, email, last_login) VALUES (?, ?, ?)'
        ).bind(userId, email, now).run();
      } catch (e2) {
        return errorPage('서버 오류', `사용자 생성 실패: ${e2.message || e2}`);
      }
    }
    user = { id: userId, email, name };
  } else {
    try {
      await env.DB.prepare(
        'UPDATE users SET last_login = ? WHERE id = ?'
      ).bind(now, user.id).run();
    } catch {}
  }

  // 4) JWT 발급
  const exp = now + SESSION_DAYS * 24 * 60 * 60;
  const jwt = await signJwt({ sub: user.id, email: user.email, exp }, env.JWT_SECRET);

  // 5) session cookie 셋팅 + state cookie 청소 + 홈으로 redirect
  return new Response(null, {
    status: 302,
    headers: [
      ['Location', '/?login=success'],
      ['Set-Cookie', `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`],
      ['Set-Cookie', 'g_oauth_state=; Path=/; Max-Age=0'],
    ],
  });
}
