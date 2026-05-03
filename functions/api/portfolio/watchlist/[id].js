/**
 * DELETE /api/portfolio/watchlist/:id
 * → 관심 목록 1건 제거
 */
import { withAuth, jsonResponse, badRequest, serverError } from '../../../_shared/auth.js';

export const onRequestDelete = withAuth(async ({ env, params, user }) => {
  if (!env.DB) return serverError('D1 not bound');
  const id = parseInt(params.id);
  if (!id) return badRequest('id 잘못됨');

  const row = await env.DB.prepare('SELECT user_id FROM watchlists WHERE id = ?').bind(id).first();
  if (!row) return jsonResponse({ ok: false, error: 'not_found' }, 404);
  if (row.user_id !== user.id) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

  try {
    await env.DB.prepare('DELETE FROM watchlists WHERE id = ?').bind(id).run();
    return jsonResponse({ ok: true, message: '제거되었습니다' });
  } catch (e) {
    return serverError(`제거 실패: ${e.message || e}`);
  }
});
