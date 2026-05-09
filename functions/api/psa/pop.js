/**
 * GET /api/psa/pop?card_id=12345&grade=10
 *   ↳ 우리 D1 누적 PSA cert 카운트 (해당 card_id + grade)
 *
 * 인증 불필요 (public 정보)
 * 캐시 5분
 */
import { jsonResponse, badRequest, serverError } from '../../_shared/auth.js';

export const onRequestGet = async ({ request, env }) => {
  if (!env.DB) return serverError('D1 not bound');

  const url = new URL(request.url);
  const card_id = url.searchParams.get('card_id') || '';
  const gradeRaw = url.searchParams.get('grade') || '10';
  const grade = parseInt(gradeRaw);

  if (!card_id || !/^\d+$/.test(card_id)) return badRequest('card_id 가 필요합니다');
  if (!grade || grade < 1 || grade > 10) return badRequest('grade 잘못됨');

  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS pop FROM psa_certs WHERE card_id = ? AND grade = ?`
    ).bind(card_id, grade).first();

    return jsonResponse(
      { ok: true, card_id, grade, pop: row?.pop || 0 },
      200,
      { 'Cache-Control': 'public, max-age=300' },
    );
  } catch (e) {
    return serverError(`POP 조회 실패: ${e.message || e}`);
  }
};
