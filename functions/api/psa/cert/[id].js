/**
 * DELETE /api/psa/cert/:id
 * → 본인이 등록한 cert 1건 삭제
 */
import { withAuth, jsonResponse, badRequest, serverError } from '../../../_shared/auth.js';

export const onRequestDelete = withAuth(async ({ env, params, user }) => {
  if (!env.DB) return serverError('D1 not bound');
  const id = parseInt(params.id);
  if (!id) return badRequest('id 가 잘못되었습니다');

  const row = await env.DB.prepare(
    'SELECT user_id FROM psa_certs WHERE id = ?'
  ).bind(id).first();
  if (!row) return jsonResponse({ ok: false, error: 'not_found' }, 404);
  if (row.user_id !== user.id) return jsonResponse({ ok: false, error: 'forbidden' }, 403);

  try {
    await env.DB.prepare('DELETE FROM psa_certs WHERE id = ?').bind(id).run();
    return jsonResponse({ ok: true, message: '삭제되었습니다' });
  } catch (e) {
    return serverError(`삭제 실패: ${e.message || e}`);
  }
});
