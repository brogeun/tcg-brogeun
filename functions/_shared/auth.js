/**
 * 인증 헬퍼 — 보호된 엔드포인트에서 사용
 */
import { verifyJwt } from './jwt.js';

export async function getCurrentUser(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  const payload = await verifyJwt(match[1], env.JWT_SECRET);
  if (!payload || !payload.sub) return null;
  return { id: payload.sub, email: payload.email };
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function unauthorized(message = '로그인이 필요합니다') {
  return jsonResponse({ ok: false, error: 'unauthorized', message }, 401);
}

export function badRequest(message) {
  return jsonResponse({ ok: false, error: 'bad_request', message }, 400);
}

export function serverError(message) {
  return jsonResponse({ ok: false, error: 'server_error', message }, 500);
}

/**
 * 인증 필수 엔드포인트 wrapper
 * 사용: export const onRequestPost = withAuth(async ({ request, env, user }) => { ... });
 */
export function withAuth(handler) {
  return async (context) => {
    const user = await getCurrentUser(context.request, context.env);
    if (!user) return unauthorized();
    return handler({ ...context, user });
  };
}
