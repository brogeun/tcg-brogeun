/**
 * GET /api/auth/kakao/callback?code=...&state=...
 * → 카카오 OAuth 콜백 처리.
 *
 * 1. state CSRF 검증
 * 2. code → access_token 교환 (POST kauth.kakao.com/oauth/token)
 * 3. access_token → user info (GET kapi.kakao.com/v2/user/me)
 * 4. DB users 조회/생성 (kakao_id 기반 가짜 이메일 사용 — 다른 provider 와 분리)
 * 5. JWT 발급 + session cookie + 홈 redirect
 */
import { signJwt } from '../../../_shared/jwt.js';

const SESSION_DAYS = 30;

function errorPage(title, message, isApp = false) {
  const appLink = isApp
    ? `<a href="kr.tcghub.app://kakao-cancel" style="margin-left:8px;background:#6b7280">📱 앱으로 돌아가기</a>`
    : '';
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
  <a href="/">← 홈으로</a>${appLink}
</div></body></html>`, {
    status: 400,
    headers: [
      ['Content-Type', 'text/html; charset=utf-8'],
      ['Set-Cookie', 'k_oauth_state=; Path=/; Max-Age=0'],
      ['Set-Cookie', 'k_oauth_app=; Path=/; Max-Age=0'],
    ],
  });
}

function isAppRequest(request) {
  const cookie = request.headers.get('Cookie') || '';
  return /(?:^|;\s*)k_oauth_app=1/.test(cookie);
}

export async function onRequestGet({ request, env }) {
  const isApp = isAppRequest(request);
  if (!env.DB) return errorPage('서버 오류', 'D1 database not bound', isApp);
  if (!env.JWT_SECRET) return errorPage('서버 오류', 'JWT_SECRET not set', isApp);
  if (!env.KAKAO_CLIENT_ID) return errorPage('서버 오류', 'KAKAO_CLIENT_ID env not set', isApp);

  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) {
    return errorPage('카카오 로그인 취소', `카카오에서 거부되었습니다: ${errorParam}`, isApp);
  }
  if (!code || !state) {
    return errorPage('잘못된 요청', 'code 또는 state 파라미터가 없습니다.', isApp);
  }

  // CSRF state 검증
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)k_oauth_state=([^;]+)/);
  if (!m || m[1] !== state) {
    return errorPage('보안 오류', 'CSRF state 검증 실패. 다시 시도해주세요.', isApp);
  }

  // 1) code → access_token 교환
  let tokenData;
  try {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.KAKAO_CLIENT_ID,
      redirect_uri: `${origin}/api/auth/kakao/callback`,
      code,
    });
    // 카카오 Client Secret 설정한 경우 함께 전송
    if (env.KAKAO_CLIENT_SECRET) {
      tokenBody.append('client_secret', env.KAKAO_CLIENT_SECRET);
    }
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: tokenBody,
    });
    tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return errorPage('토큰 교환 실패', JSON.stringify(tokenData), isApp);
    }
  } catch (e) {
    return errorPage('서버 오류', `토큰 교환 중 오류: ${e.message || e}`, isApp);
  }

  // 2) access_token → user info 조회
  let userinfo;
  try {
    const uiRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    userinfo = await uiRes.json();
    if (!uiRes.ok || !userinfo.id) {
      return errorPage('사용자 정보 조회 실패', JSON.stringify(userinfo), isApp);
    }
  } catch (e) {
    return errorPage('서버 오류', `사용자 정보 조회 중 오류: ${e.message || e}`, isApp);
  }

  const kakaoId = String(userinfo.id);
  const nickname = userinfo.kakao_account?.profile?.nickname
                || userinfo.properties?.nickname
                || `카카오${kakaoId.slice(-4)}`;

  // 가짜 이메일 — 다른 provider 와 분리 (이메일 매직링크/구글 user 와 통합 안 됨)
  const pseudoEmail = `kakao_${kakaoId}@tcghub.kr`;
  const now = Math.floor(Date.now() / 1000);

  // 3) DB users 조회/생성
  let user;
  try {
    user = await env.DB.prepare(
      'SELECT id, email, name FROM users WHERE email = ?'
    ).bind(pseudoEmail).first();
  } catch (e) {
    return errorPage('서버 오류', `사용자 조회 실패: ${e.message || e}`, isApp);
  }

  if (!user) {
    const userId = crypto.randomUUID();
    try {
      await env.DB.prepare(
        'INSERT INTO users (id, email, name, last_login) VALUES (?, ?, ?, ?)'
      ).bind(userId, pseudoEmail, nickname, now).run();
    } catch (e) {
      // name 컬럼 없을 수도 있음 — name 빼고 재시도
      try {
        await env.DB.prepare(
          'INSERT INTO users (id, email, last_login) VALUES (?, ?, ?)'
        ).bind(userId, pseudoEmail, now).run();
      } catch (e2) {
        return errorPage('서버 오류', `사용자 생성 실패: ${e2.message || e2}`, isApp);
      }
    }
    user = { id: userId, email: pseudoEmail, name: nickname };
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

  // 5) app 모드 (Capacitor 앱) 인지 확인 — 임시 1회용 코드 발급 + deep link redirect
  if (isApp && env.ADMIN_KV) {
    // 5-1) 임시 1회용 코드 생성 (UUID), KV 에 5분 저장
    const oneTimeCode = crypto.randomUUID();
    try {
      await env.ADMIN_KV.put(
        `oauth_code:${oneTimeCode}`,
        JSON.stringify({ user_id: user.id, email: user.email, name: user.name || null, provider: 'kakao' }),
        { expirationTtl: 300 }, // 5분
      );
    } catch (e) {
      return errorPage('서버 오류', `임시 코드 저장 실패: ${e.message || e}`, isApp);
    }
    // 5-2) deep link 로 redirect — 앱이 이 URL 받고 exchange-code 호출해서 진짜 세션 받음
    const deepLink = `kr.tcghub.app://kakao-callback?code=${encodeURIComponent(oneTimeCode)}`;
    return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${deepLink}"></head><body><script>location.href=${JSON.stringify(deepLink)};</script><p style="font-family:sans-serif;padding:24px">앱으로 돌아가는 중...</p></body></html>`, {
      status: 200,
      headers: [
        ['Content-Type', 'text/html; charset=utf-8'],
        ['Set-Cookie', 'k_oauth_state=; Path=/; Max-Age=0'],
        ['Set-Cookie', 'k_oauth_app=; Path=/; Max-Age=0'],
      ],
    });
  }

  // 6) 브라우저 모드 — 기존대로 session cookie + redirect
  return new Response(null, {
    status: 302,
    headers: [
      ['Location', '/?login=success'],
      ['Set-Cookie', `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`],
      ['Set-Cookie', 'k_oauth_state=; Path=/; Max-Age=0'],
    ],
  });
}
