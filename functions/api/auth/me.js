/**
 * GET /api/auth/me
 * → 현재 로그인된 사용자 정보 반환 (UI 의 로그인 상태 확인용)
 * 로그인 안 됐으면 { ok: true, user: null }
 * 로그인 됐으면 DB 에서 name 도 함께 조회해 반환 (카카오 닉네임 표시용)
 */
import { getCurrentUser, jsonResponse } from '../../_shared/auth.js';
import { isAdminUser } from '../../_shared/admin.js';

export async function onRequestGet({ request, env }) {
  const user = await getCurrentUser(request, env);
  if (!user) return jsonResponse({ ok: true, user: null });

  // DB 에서 name 추가 조회
  let name = null;
  try {
    if (env.DB) {
      const row = await env.DB.prepare('SELECT name FROM users WHERE id = ?').bind(user.id).first();
      name = row?.name || null;
    }
  } catch {}

  // 카카오 user 여부 판별 (가짜 이메일 패턴: kakao_*@tcghub.kr)
  const isKakao = /^kakao_\d+@tcghub\.kr$/i.test(user.email || '');
  // 표시용 라벨 — 카카오면 닉네임, 아니면 이메일
  const displayName = isKakao ? (name || '카카오 사용자') : (user.email || '');

  return jsonResponse({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name,
      provider: isKakao ? 'kakao' : 'email',
      displayName,
      isAdmin: await isAdminUser(user, env),
    },
  });
}
