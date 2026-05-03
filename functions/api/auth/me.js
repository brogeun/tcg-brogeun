/**
 * GET /api/auth/me
 * → 현재 로그인된 사용자 정보 반환 (UI 의 로그인 상태 확인용)
 * 로그인 안 됐으면 { ok: true, user: null }
 */
import { getCurrentUser, jsonResponse } from '../../_shared/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getCurrentUser(request, env);
  return jsonResponse({ ok: true, user });
}
