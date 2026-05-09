/**
 * DELETE /api/psa/cert/:id
 * → 일반 사용자 차단. POP 데이터 무결성 보호.
 *   잘못 등록된 cert 가 있다면 관리자(env.ADMIN_PASSWORD 헤더)만 삭제 가능.
 */
import { jsonResponse, badRequest, serverError } from '../../../_shared/auth.js';

export const onRequestDelete = async ({ request, env, params }) => {
  if (!env.DB) return serverError('D1 not bound');

  // 관리자 비밀번호 헤더 확인 (POP 무결성 보호)
  const adminHeader = request.headers.get('x-admin-password');
  if (!env.ADMIN_PASSWORD || adminHeader !== env.ADMIN_PASSWORD) {
    return jsonResponse({
      ok: false,
      error: 'forbidden',
      message: 'PSA Cert# 는 등록 후 사용자가 임의로 제거할 수 없습니다. POP 데이터 무결성 보호. 잘못 등록된 경우 관리자에게 문의해주세요.',
    }, 403);
  }

  const id = parseInt(params.id);
  if (!id) return badRequest('id 가 잘못되었습니다');

  try {
    await env.DB.prepare('DELETE FROM psa_certs WHERE id = ?').bind(id).run();
    return jsonResponse({ ok: true, message: '관리자 삭제 완료' });
  } catch (e) {
    return serverError(`삭제 실패: ${e.message || e}`);
  }
};
