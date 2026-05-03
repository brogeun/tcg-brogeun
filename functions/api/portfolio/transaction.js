/**
 * POST /api/portfolio/transaction
 * Body: { card_id, grade, type (buy|sell), price, qty, date, note? }
 * → 거래 내역 1건 추가
 */
import { withAuth, jsonResponse, badRequest, serverError } from '../../_shared/auth.js';

const VALID_GRADES = new Set(['psa10', 'psa9', 'raw', 'box']);
const VALID_TYPES = new Set(['buy', 'sell']);

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
  const type = String(body.type || '').trim().toLowerCase();
  const price = parseInt(body.price);
  const qty = parseInt(body.qty);
  const date = body.date ? String(body.date).slice(0, 10) : null;
  const note = body.note ? String(body.note).slice(0, 500) : null;

  if (!card_id || !/^\d+$/.test(card_id)) return badRequest('card_id 잘못됨');
  if (!VALID_GRADES.has(grade)) return badRequest('grade 잘못됨');
  if (!VALID_TYPES.has(type)) return badRequest('type 은 buy/sell');
  if (!price || price < 0) return badRequest('price 잘못됨');
  if (!qty || qty < 1) return badRequest('qty 는 1 이상');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return badRequest('date 형식 (YYYY-MM-DD)');

  try {
    const result = await env.DB.prepare(
      `INSERT INTO transactions (user_id, card_id, grade, type, price, qty, date, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(user.id, card_id, grade, type, price, qty, date, note).run();
    return jsonResponse({
      ok: true,
      id: result.meta?.last_row_id,
      message: '거래가 기록되었습니다',
    });
  } catch (e) {
    return serverError(`기록 실패: ${e.message || e}`);
  }
});
