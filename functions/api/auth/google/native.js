/**
 * POST /api/auth/google/native
 * Body: { idToken: string }
 *
 * Capacitor 네이티브 SDK (안드로이드/iOS Google Sign-In) 로 받은 idToken 을 서버에서 검증.
 * → users 조회/생성 → JWT 발급 → session cookie 셋팅 → JSON 응답
 *
 * 사용 시점: 앱 (WebView) 안에서 startGoogleLogin() 호출 시.
 * 브라우저는 기존 /api/auth/google/start 사용.
 */
import { signJwt } from '../../../_shared/jwt.js';

const SESSION_DAYS = 30;

const json = (obj, status = 200, extraHeaders = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  },
});

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: 'D1 not bound' }, 500);
  if (!env.JWT_SECRET) return json({ ok: false, error: 'JWT_SECRET not set' }, 500);
  if (!env.GOOGLE_CLIENT_ID) return json({ ok: false, error: 'GOOGLE_CLIENT_ID not set' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid JSON body' }, 400); }

  const { idToken } = body || {};
  if (!idToken || typeof idToken !== 'string') {
    return json({ ok: false, error: 'idToken required' }, 400);
  }

  // 1) Google tokeninfo 로 idToken 검증
  let userinfo;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    userinfo = await r.json();
    if (!r.ok || !userinfo.email) {
      return json({ ok: false, error: 'idToken 검증 실패', detail: userinfo }, 401);
    }
  } catch (e) {
    return json({ ok: false, error: `검증 중 오류: ${e.message || e}` }, 500);
  }

  // 2) audience 검증 — idToken 의 aud 가 우리 클라이언트 ID 와 일치해야
  // Web/Android/iOS 클라이언트 ID 모두 허용 (env 에 설정된 만큼)
  const validAuds = [
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_ID_ANDROID,
    env.GOOGLE_CLIENT_ID_IOS,
  ].filter(Boolean);
  if (validAuds.length && !validAuds.includes(userinfo.aud)) {
    return json({ ok: false, error: 'aud 불일치 — 클라이언트 ID 매칭 실패', aud: userinfo.aud }, 401);
  }

  // 3) email_verified 체크
  if (userinfo.email_verified === 'false' || userinfo.email_verified === false) {
    return json({ ok: false, error: '이메일 미인증 Google 계정' }, 401);
  }

  const email = String(userinfo.email).toLowerCase().trim();
  const name = userinfo.name || null;
  const now = Math.floor(Date.now() / 1000);

  // 4) DB 사용자 조회/생성 (이메일 매직링크와 동일한 users 테이블 — 같은 user 통합)
  let user;
  try {
    user = await env.DB.prepare(
      'SELECT id, email, name FROM users WHERE email = ?'
    ).bind(email).first();
  } catch (e) {
    return json({ ok: false, error: `사용자 조회 실패: ${e.message || e}` }, 500);
  }

  if (!user) {
    const userId = crypto.randomUUID();
    try {
      await env.DB.prepare(
        'INSERT INTO users (id, email, name, last_login) VALUES (?, ?, ?, ?)'
      ).bind(userId, email, name, now).run();
    } catch {
      // name 컬럼 없는 스키마 대비 — name 빼고 재시도
      try {
        await env.DB.prepare(
          'INSERT INTO users (id, email, last_login) VALUES (?, ?, ?)'
        ).bind(userId, email, now).run();
      } catch (e2) {
        return json({ ok: false, error: `사용자 생성 실패: ${e2.message || e2}` }, 500);
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

  // 5) JWT 발급 + session cookie 셋팅
  const exp = now + SESSION_DAYS * 24 * 60 * 60;
  const jwt = await signJwt({ sub: user.id, email: user.email, exp }, env.JWT_SECRET);

  return json(
    { ok: true, user: { id: user.id, email: user.email, name: user.name } },
    200,
    { 'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}` },
  );
}
