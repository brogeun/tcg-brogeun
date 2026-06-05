/**
 * POST /api/auth/apple/native
 * Body: { identityToken: string, user?: { name?: { firstName, lastName }, email? }, nonce?: string }
 *
 * Apple Sign In (iOS Capacitor 네이티브 SDK, 또는 웹 Apple JS) 에서 받은 identityToken 을
 * 검증하고 JWT 세션을 발급한다.
 *
 * 허용 audience:
 *   - env.APPLE_BUNDLE_ID (iOS 앱, 기본 kr.tcghub.app)
 *   - env.APPLE_SERVICES_ID (웹 — 형이 Apple Developer 콘솔에서 등록 후 환경변수로 설정)
 */
import { signJwt } from '../../../_shared/jwt.js';
import { verifyAppleIdToken } from '../../../_shared/apple.js';

const SESSION_DAYS = 30;

function json(obj, status = 200, extraHeaders = []) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: [
      ['Content-Type', 'application/json'],
      ...extraHeaders,
    ],
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'DB not bound' }, 500);
  if (!env.JWT_SECRET) return json({ error: 'JWT_SECRET not set' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const idToken = body?.identityToken || body?.idToken;
  if (!idToken) return json({ error: 'identityToken required' }, 400);

  const audiences = [
    env.APPLE_BUNDLE_ID || 'kr.tcghub.app',
    env.APPLE_SERVICES_ID,
  ].filter(Boolean);

  let appleUser;
  try {
    appleUser = await verifyAppleIdToken(idToken, audiences);
  } catch (e) {
    return json({ error: `Token verification failed: ${e.message || e}` }, 401);
  }

  // Apple sub 는 user 고유 ID. email 은 첫 로그인에서만 제공될 수 있음 (private relay 가능).
  const appleSub = appleUser.sub;
  const emailFromToken = appleUser.email;
  const emailFromBody = body?.user?.email;
  const email = emailFromToken
    || emailFromBody
    || `apple_${appleSub.replace(/[^a-z0-9._-]/gi, '')}@tcghub.kr`;

  let displayName;
  const u = body?.user;
  if (u?.name?.firstName || u?.name?.lastName) {
    displayName = `${u.name.firstName || ''} ${u.name.lastName || ''}`.trim();
  } else {
    displayName = `Apple${appleSub.slice(-4)}`;
  }

  const now = Math.floor(Date.now() / 1000);

  // DB users 조회/생성 — Apple 은 별도 식별자 (email 매칭 + sub 기반 pseudo email 백업)
  let user;
  try {
    user = await env.DB.prepare(
      'SELECT id, email, name FROM users WHERE email = ?'
    ).bind(email).first();
  } catch (e) {
    return json({ error: `User lookup failed: ${e.message || e}` }, 500);
  }

  if (!user) {
    const userId = crypto.randomUUID();
    try {
      await env.DB.prepare(
        'INSERT INTO users (id, email, name, last_login) VALUES (?, ?, ?, ?)'
      ).bind(userId, email, displayName, now).run();
    } catch (e) {
      // name 컬럼 없을 수도 있음
      try {
        await env.DB.prepare(
          'INSERT INTO users (id, email, last_login) VALUES (?, ?, ?)'
        ).bind(userId, email, now).run();
      } catch (e2) {
        return json({ error: `User creation failed: ${e2.message || e2}` }, 500);
      }
    }
    user = { id: userId, email, name: displayName };
  } else {
    try {
      await env.DB.prepare(
        'UPDATE users SET last_login = ? WHERE id = ?'
      ).bind(now, user.id).run();
    } catch {}
  }

  // JWT 세션 발급
  const exp = now + SESSION_DAYS * 24 * 60 * 60;
  const jwt = await signJwt({ sub: user.id, email: user.email, exp }, env.JWT_SECRET);

  return json(
    {
      ok: true,
      user: { id: user.id, email: user.email, name: user.name || displayName },
    },
    200,
    [
      ['Set-Cookie', `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`],
    ]
  );
}
