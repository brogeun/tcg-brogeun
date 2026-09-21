/**
 * GET /api/auth/verify?token=xxx
 * → 토큰 검증 + 사용자 생성/조회 + JWT 세션 발급 + / 로 redirect
 *
 * 사용자가 메일에서 링크를 클릭하면 이 엔드포인트로 옴.
 * 성공 시: session 쿠키 셋팅 + 홈으로 302 redirect.
 * 실패 시: 에러 메시지 페이지 표시.
 */
import { signJwt, sha256Hex } from '../../_shared/jwt.js';
import { jsonResponse } from '../../_shared/auth.js';

const SESSION_DAYS = 30;

function appReturnPage() {
  // 앱 링크에는 인증 토큰/코드/검증값을 절대로 담지 않는다.
  return new Response(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>앱에서 로그인 — TCG Hub</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f9fafb;margin:0;padding:24px;display:flex;align-items:center;justify-content:center;min-height:80vh}
main{max-width:420px;background:#fff;padding:32px;border-radius:14px;text-align:center}
h1{font-size:22px}p{color:#4b5563;line-height:1.65}
a{display:inline-block;padding:14px 24px;background:#066666;color:#fff;text-decoration:none;border-radius:10px;font-weight:700}
</style></head><body><main>
<h1>앱에서 로그인하기</h1>
<p>이메일 인증이 완료되었어요.<br>자동으로 열리지 않으면 아래 버튼을 눌러주세요.</p>
<a id="openApp" href="kr.tcghub.app://email-callback">TCG Hub 앱 열기</a>
<p>로그인을 요청한 휴대폰에서 열어주세요.</p>
</main><script>window.location.replace(document.getElementById('openApp').href);</script></body></html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

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
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return errorPage('잘못된 링크', '로그인 링크를 다시 요청해주세요.');
  let appChallenge;
  try {
    appChallenge = env.ADMIN_KV ? await env.ADMIN_KV.get(`email_app:${token}`) : null;
  } catch {
    return errorPage('서버 오류', '앱 로그인 요청을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.');
  }
  if (url.searchParams.get('app') === '1' && !appChallenge) {
    return errorPage('만료됨', '앱에서 로그인 링크를 다시 요청해주세요.');
  }
  // app=1을 지워도 앱용 링크는 브라우저 세션을 발급하지 않는다.
  return verifyToken(env, token, appChallenge);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, message: '잘못된 로그인 요청입니다.' }, 400); }
  const verifier = body?.verifier;
  if (typeof verifier !== 'string' || !/^[a-f0-9]{64}$/.test(verifier)) {
    return jsonResponse({ ok: false, message: '로그인 링크를 요청한 앱에서 다시 시도해주세요.' }, 400);
  }
  // 이메일 인증이 승인한 요청을, 원래 앱만 알고 있는 검증 원본으로 교환한다.
  const result = await verifyToken(env, 'app:' + await sha256Hex(verifier));
  if (result.status !== 302) {
    return jsonResponse({ ok: false, message: '이메일 인증을 완료했는지 확인해주세요. 링크가 만료되었다면 앱에서 다시 요청해주세요.' }, result.status);
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': result.headers.get('Set-Cookie'),
    },
  });
}

async function verifyToken(env, token, appChallenge = null) {
  if (!env.DB) return errorPage('서버 오류', 'D1 database not bound');
  if (!env.JWT_SECRET) return errorPage('서버 오류', 'JWT_SECRET not set');

  let tokenRow;
  try {
    tokenRow = await env.DB.prepare(
      'SELECT email, expires_at, used FROM magic_tokens WHERE token = ?'
    ).bind(token).first();
  } catch (e) {
    return errorPage('서버 오류', `DB 조회 실패: ${e.message || e}`);
  }

  if (!tokenRow) return errorPage('잘못된 링크', '존재하지 않는 토큰입니다.');
  if (tokenRow.used && appChallenge) {
    // 메일 미리보기나 브라우저 새로고침 후에도 미완료 앱으로 돌아갈 수 있다.
    const approval = await env.DB.prepare(
      'SELECT email, expires_at, used FROM magic_tokens WHERE token = ?'
    ).bind('app:' + appChallenge).first();
    if (approval && !approval.used && approval.expires_at > Math.floor(Date.now() / 1000)) return appReturnPage();
  }
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

  if (appChallenge) {
    try {
      await env.DB.prepare(
        'INSERT INTO magic_tokens (token, email, expires_at, used) VALUES (?, ?, ?, 0)'
      ).bind('app:' + appChallenge, email, now + 5 * 60).run();
    } catch {
      return errorPage('서버 오류', '앱 로그인 승인을 저장하지 못했습니다. 앱에서 다시 요청해주세요.');
    }
    return appReturnPage();
  }

  // JWT 발급
  const exp = now + SESSION_DAYS * 24 * 60 * 60;
  const jwt = await signJwt({ sub: user.id, email: user.email, exp }, env.JWT_SECRET);

  // 세션 cookie + redirect
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/?login=success',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
    },
  });
}
