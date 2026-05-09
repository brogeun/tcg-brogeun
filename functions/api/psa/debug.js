/**
 * GET /api/psa/debug?cert=149196422
 *   ↳ DB 에 저장된 raw_payload 반환 (PSA 응답 원본 확인용)
 *   ↳ 본인이 등록한 cert 만 조회 가능
 */
import { withAuth, jsonResponse, badRequest, serverError } from '../../_shared/auth.js';

export const onRequestGet = withAuth(async ({ request, env, user }) => {
  if (!env.DB) return serverError('D1 not bound');

  const url = new URL(request.url);
  const cert_number = (url.searchParams.get('cert') || '').replace(/\D/g, '');
  if (!cert_number) return badRequest('cert 파라미터 필요');

  try {
    const row = await env.DB.prepare(
      `SELECT cert_number, card_id, grade, user_id, subject, card_number,
              psa_total_pop, psa_pop_higher, raw_payload
       FROM psa_certs WHERE cert_number = ? LIMIT 1`
    ).bind(cert_number).first();
    if (!row) return jsonResponse({ ok: false, error: 'not_found' }, 404);
    if (row.user_id !== user.id) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

    let parsed = null;
    try { parsed = JSON.parse(row.raw_payload || '{}'); } catch {}

    return jsonResponse({
      ok: true,
      cert_number: row.cert_number,
      card_id: row.card_id,
      grade: row.grade,
      subject: row.subject,
      card_number: row.card_number,
      psa_total_pop: row.psa_total_pop,
      psa_pop_higher: row.psa_pop_higher,
      raw_payload_keys: parsed ? Object.keys(parsed) : null,
      raw_payload: parsed, // PSA API 응답 원본 — 어떤 필드명에 POP 있는지 확인
    });
  } catch (e) {
    return serverError(`debug 실패: ${e.message || e}`);
  }
});
