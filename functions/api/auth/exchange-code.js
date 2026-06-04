/**
 * POST /api/auth/exchange-code
 * Body: { code: string }   (kakao callback 이 deep link 로 보내준 1회용 code)
 *
 * → 1회용 code 검증 (KV)
 * → user 조회
 * → JWT 발급 + session cookie 설정
 * → JSON 응답
 *
 * 사용: Capacitor 앱이 카카오 OAuth 콜백 (deep link `kr.tcghub.app://kakao-callback?code=XXX`) 받은 직후
 *      WebView 안에서 이 엔드포인트 POST 호출 → cookie 적용 → 새로고침
 */
import { signJwt } from '../../_shared/jwt.js';

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
  if (!env.ADMIN_KV) return json({ ok: false, error: 'ADMIN_KV not bound' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid JSON body' }, 400); }

  const { code } = body || {};
  if (!code || typeof code !== 'string') {
    return json({ ok: false, error: 'code required' }, 400);
  }

  // 1) KV 에서 code 조회
  const kvKey = `oauth_code:${code}`;
  let stored;
  try {
    stored = await env.ADMIN_KV.get(kvKey, 'json');
  } catch (e) {
    return json({ ok: false, error: `code 조회 실패: ${e.message || e}` }, 500);
  }
  if (!stored || !stored.user_id) {
    return json({ ok: false, error: '코드가 만료되었거나 유효하지 않습니다' }, 401);
  }

  // 2) 즉시 삭제 (1회용)
  try { await env.ADMIN_KV.delete(kvKey); } catch {}

  // 3) JWT 발급 + cookie 설정
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_DAYS * 24 * 60 * 60;
  const jwt = await signJwt({ sub: stored.user_id, email: stored.email, exp }, env.JWT_SECRET);

  // 4) 마지막 로그인 시간 업데이트
  try {
    await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(now, stored.user_id).run();
  } catch {}

  return json(
    { ok: true, user: { id: stored.user_id, email: stored.email, name: stored.name || null, provider: stored.provider || null } },
    200,
    { 'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}` },
  );
}
