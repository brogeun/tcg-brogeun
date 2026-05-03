/**
 * GET /api/auth/verify?token=xxx
 * → 토큰 검증 + 사용자 생성/조회 + JWT 세션 발급 + / 로 redirect
 *
 * 사용자가 메일에서 링크를 클릭하면 이 엔드포인트로 옴.
 * 성공 시: session 쿠키 셋팅 + 홈으로 302 redirect.
 * 실패 시: 에러 메시지 페이지 표시.
 */
import { signJwt } from '../../_shared/jwt.js';

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
p{color:#4b5563;line-height:1.65;margin:0 0 20px}
a{display:inline-block;padding:10px 20px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px}
</style></head>
<body><div class="box">
  <div style="font-size:36px;margin-bottom:12px">⚠️</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <a href="/">← 홈으로</a>
</div></body></html>`, {
    status: 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return errorPage('서버 오류', 'D1 database not bound');
  if (!env.JWT_SECRET) return errorPage('서버 오류', 'JWT_SECRET not set');

  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return errorPage('잘못된 링크', '토큰이 없습니다.');

  let tokenRow;
  try {
    tokenRow = await env.DB.prepare(
      'SELECT email, expires_at, used FROM magic_tokens WHERE token = ?'
    ).bind(token).first();
  } catch (e) {
    return errorPage('서버 오류', `DB 조회 실패: ${e.message || e}`);
  }

  if (!tokenRow) return errorPage('잘못된 링크', '존재하지 않는 토큰입니다.');
  if (tokenRow.used) return errorPage('이미 사용됨', '이 링크는 이미 사용되었습니다. 다시 로그인 요청해주세요.');
  if (tokenRow.expires_at < Math.floor(Date.now() / 1000)) {
    return errorPage('만료됨', '링크가 만료되었습니다 (15분). 다시 로그인 요청해주세요.');
  }

  // mark used (race condition 방지)
  try {
    const upd = await env.DB.prepare(
      'UPDATE magic_tokens SET used = 1 WHERE token = ? AND used = 0'
    ).bind(token).run();
    if (upd.meta && upd.meta.changes === 0) {
      return errorPage('이미 사용됨', '이 링크는 이미 사용되었습니다.');
    }
  } catch (e) {
    return errorPage('서버 오류', `DB 갱신 실패: ${e.message || e}`);
  }

  const email = tokenRow.email;
  const now = Math.floor(Date.now() / 1000);

  // 사용자 조회/생성
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
        'INSERT INTO users (id, email, last_login) VALUES (?, ?, ?)'
      ).bind(userId, email, now).run();
    } catch (e) {
      return errorPage('서버 오류', `사용자 생성 실패: ${e.message || e}`);
    }
    user = { id: userId, email, name: null };
  } else {
    await env.DB.prepare(
      'UPDATE users SET last_login = ? WHERE id = ?'
    ).bind(now, user.id).run();
  }

  // JWT 발급
  const exp = now + SESSION_DAYS * 24 * 60 * 60;
  const jwt = await signJwt({ sub: user.id, email: user.email, exp }, env.JWT_SECRET);

  // 세션 cookie + redirect
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/?login=success',
      'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
    },
  });
}
