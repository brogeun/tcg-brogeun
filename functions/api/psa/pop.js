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
    // 같은 card_id + grade 로 등록된 cert 중 PSA 가 알려준 가장 최신 POP 숫자 반환
    // (단순 등록 카운트가 아니라, PSA 가 cert lookup 시 함께 보내준 진짜 POP)
    const row = await env.DB.prepare(
      `SELECT psa_total_pop, psa_pop_higher
       FROM psa_certs
       WHERE card_id = ? AND grade = ? AND psa_total_pop IS NOT NULL
       ORDER BY registered_at DESC
       LIMIT 1`
    ).bind(card_id, grade).first();

    // 등록된 cert 가 1개라도 있으면 그 POP 반환, 없으면 0
    return jsonResponse(
      {
        ok: true,
        card_id,
        grade,
        pop: row?.psa_total_pop || 0,
        pop_higher: row?.psa_pop_higher ?? null,
        source: row ? 'psa-api' : 'none',
      },
      200,
      { 'Cache-Control': 'public, max-age=300' },
    );
  } catch (e) {
    return serverError(`POP 조회 실패: ${e.message || e}`);
  }
};
