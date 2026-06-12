/**
 * GET /api/bgs/pop?card_id=12345
 *   ↳ 해당 카드의 최신 BGS POP (블랙라벨10 / 골드라벨10 / 총합)
 *   ↳ 가장 최근 등록된 cert 의 스냅샷 반환
 *
 * 인증 불필요 (public) · 캐시 5분
 */
import { jsonResponse, badRequest, serverError } from '../../_shared/auth.js';

export const onRequestGet = async ({ request, env }) => {
  if (!env.DB) return serverError('D1 not bound');

  const url = new URL(request.url);
  const card_id = url.searchParams.get('card_id') || '';
  if (!card_id || !/^\d+$/.test(card_id)) return badRequest('card_id 가 필요합니다');

  try {
    const row = await env.DB.prepare(
      `SELECT pop_total, pop_bl10, pop_gl10, pop_95, registered_at
       FROM bgs_certs
       WHERE card_id = ? AND pop_total IS NOT NULL
       ORDER BY registered_at DESC
       LIMIT 1`
    ).bind(card_id).first();

    if (!row) {
      return jsonResponse({ ok: true, pop: null }, 200, { 'Cache-Control': 'public, max-age=300' });
    }
    return jsonResponse({
      ok: true,
      pop: {
        total: row.pop_total,
        bl10: row.pop_bl10,
        gl10: row.pop_gl10,
        g95: row.pop_95,
      },
      updated_at: row.registered_at,
    }, 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (e) {
    return serverError(`DB 조회 실패: ${e.message || e}`);
  }
};
