/**
 * POST /api/portfolio/holding
 * Body: { card_id, grade, buy_price, qty, buy_date?, note? }
 * → 보유 카드 1건 추가
 */
import { withAuth, jsonResponse, badRequest, serverError } from '../../_shared/auth.js';

const VALID_GRADES = new Set(['psa10', 'psa9', 'raw', 'box']);

export const onRequestPost = withAuth(async ({ request, env, user }) => {
  if (!env.DB) return serverError('D1 not bound');
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('JSON body 가 필요합니다');
  }

  const card_id = String(body.card_id || '').trim();
  const grade = String(body.grade || '').trim().toLowerCase();
  const buy_price = parseInt(body.buy_price);
  const qty = parseInt(body.qty || 1);
  const buy_date = body.buy_date ? String(body.buy_date).slice(0, 10) : null;
  const note = body.note ? String(body.note).slice(0, 500) : null;

  if (!card_id || !/^\d+$/.test(card_id)) return badRequest('올바른 카드 ID 가 필요합니다');
  if (!VALID_GRADES.has(grade)) return badRequest('grade 는 psa10/psa9/raw/box 중 하나');
  if (!buy_price || buy_price < 0) return badRequest('매수가 (buy_price) 가 필요합니다');
  if (!qty || qty < 1) return badRequest('수량 (qty) 은 1 이상');

  try {
    const result = await env.DB.prepare(
      `INSERT INTO holdings (user_id, card_id, grade, buy_price, qty, buy_date, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(user.id, card_id, grade, buy_price, qty, buy_date, note).run();
    return jsonResponse({
      ok: true,
      id: result.meta?.last_row_id,
      message: '보유 카드가 추가되었습니다',
    });
  } catch (e) {
    return serverError(`추가 실패: ${e.message || e}`);
  }
});
