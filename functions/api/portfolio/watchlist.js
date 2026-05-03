/**
 * POST /api/portfolio/watchlist
 * Body: { card_id, grade?, target_price?, alert_direction? (above|below) }
 * → 관심 목록 추가
 */
import { withAuth, jsonResponse, badRequest, serverError } from '../../_shared/auth.js';

const VALID_GRADES = new Set(['psa10', 'psa9', 'raw', 'box', '']);
const VALID_DIRECTIONS = new Set(['above', 'below', null, '']);

export const onRequestPost = withAuth(async ({ request, env, user }) => {
  if (!env.DB) return serverError('D1 not bound');
  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('JSON body 가 필요합니다');
  }

  const card_id = String(body.card_id || '').trim();
  const grade = (body.grade || '').toLowerCase() || null;
  const target_price = body.target_price ? parseInt(body.target_price) : null;
  const alert_direction = body.alert_direction ? String(body.alert_direction).toLowerCase() : null;

  if (!card_id || !/^\d+$/.test(card_id)) return badRequest('card_id 잘못됨');
  if (grade && !VALID_GRADES.has(grade)) return badRequest('grade 잘못됨');
  if (alert_direction && !['above', 'below'].includes(alert_direction)) return badRequest('alert_direction 잘못됨');

  try {
    const result = await env.DB.prepare(
      `INSERT INTO watchlists (user_id, card_id, grade, target_price, alert_direction)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, card_id, grade) DO UPDATE SET
         target_price = excluded.target_price,
         alert_direction = excluded.alert_direction`
    ).bind(user.id, card_id, grade, target_price, alert_direction).run();
    return jsonResponse({
      ok: true,
      id: result.meta?.last_row_id,
      message: '관심 목록에 추가되었습니다',
    });
  } catch (e) {
    return serverError(`추가 실패: ${e.message || e}`);
  }
});
