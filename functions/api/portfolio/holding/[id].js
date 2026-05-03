/**
 * PUT/DELETE /api/portfolio/holding/:id
 * → 특정 보유 카드 수정 / 삭제 (본인 것만)
 */
import { withAuth, jsonResponse, badRequest, serverError } from '../../../_shared/auth.js';

const VALID_GRADES = new Set(['psa10', 'psa9', 'raw', 'box']);

export const onRequestPut = withAuth(async ({ request, env, params, user }) => {
  if (!env.DB) return serverError('D1 not bound');
  const id = parseInt(params.id);
  if (!id) return badRequest('id 가 잘못되었습니다');

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('JSON body 가 필요합니다');
  }

  // 본인 소유 확인
  const row = await env.DB.prepare(
    'SELECT user_id FROM holdings WHERE id = ?'
  ).bind(id).first();
  if (!row) return jsonResponse({ ok: false, error: 'not_found' }, 404);
  if (row.user_id !== user.id) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

  // 갱신할 필드
  const updates = [];
  const args = [];
  if (body.grade != null) {
    if (!VALID_GRADES.has(String(body.grade).toLowerCase())) return badRequest('grade 잘못됨');
    updates.push('grade = ?');
    args.push(String(body.grade).toLowerCase());
  }
  if (body.buy_price != null) {
    const p = parseInt(body.buy_price);
    if (!p || p < 0) return badRequest('buy_price 잘못됨');
    updates.push('buy_price = ?');
    args.push(p);
  }
  if (body.qty != null) {
    const q = parseInt(body.qty);
    if (!q || q < 1) return badRequest('qty 는 1 이상');
    updates.push('qty = ?');
    args.push(q);
  }
  if (body.buy_date !== undefined) {
    updates.push('buy_date = ?');
    args.push(body.buy_date ? String(body.buy_date).slice(0, 10) : null);
  }
  if (body.note !== undefined) {
    updates.push('note = ?');
    args.push(body.note ? String(body.note).slice(0, 500) : null);
  }
  if (!updates.length) return badRequest('갱신할 필드가 없습니다');

  updates.push('updated_at = (unixepoch())');
  args.push(id);

  try {
    await env.DB.prepare(
      `UPDATE holdings SET ${updates.join(', ')} WHERE id = ?`
    ).bind(...args).run();
    return jsonResponse({ ok: true, message: '수정되었습니다' });
  } catch (e) {
    return serverError(`수정 실패: ${e.message || e}`);
  }
});

export const onRequestDelete = withAuth(async ({ env, params, user }) => {
  if (!env.DB) return serverError('D1 not bound');
  const id = parseInt(params.id);
  if (!id) return badRequest('id 잘못됨');

  const row = await env.DB.prepare(
    'SELECT user_id FROM holdings WHERE id = ?'
  ).bind(id).first();
  if (!row) return jsonResponse({ ok: false, error: 'not_found' }, 404);
  if (row.user_id !== user.id) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

  try {
    await env.DB.prepare('DELETE FROM holdings WHERE id = ?').bind(id).run();
    return jsonResponse({ ok: true, message: '삭제되었습니다' });
  } catch (e) {
    return serverError(`삭제 실패: ${e.message || e}`);
  }
});
