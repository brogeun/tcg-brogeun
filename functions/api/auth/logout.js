/**
 * POST /api/auth/logout
 * → session 쿠키 만료 (Max-Age=0)
 */
import { jsonResponse } from '../../_shared/auth.js';

export async function onRequestPost() {
  return jsonResponse(
    { ok: true, message: '로그아웃되었습니다' },
    200,
    { 'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' }
  );
}
