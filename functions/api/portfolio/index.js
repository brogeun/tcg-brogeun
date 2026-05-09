/**
 * GET /api/portfolio
 * → 현재 사용자의 전체 포트폴리오 (holdings + transactions + watchlist)
 */
import { withAuth, jsonResponse, serverError } from '../../_shared/auth.js';

export const onRequestGet = withAuth(async ({ env, user }) => {
  if (!env.DB) return serverError('D1 not bound');
  try {
    const [holdingsRes, txRes, wlRes, certsRes] = await Promise.all([
      env.DB.prepare('SELECT * FROM holdings WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all(),
      env.DB.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC LIMIT 200').bind(user.id).all(),
      env.DB.prepare('SELECT * FROM watchlists WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all(),
      // psa_certs 가 없으면 catch — 테이블 마이그레이션 전 상태 보호
      env.DB.prepare(
        `SELECT id, cert_number, card_id, grade, holding_id, subject, card_number, registered_at
         FROM psa_certs WHERE user_id = ? ORDER BY registered_at DESC`
      ).bind(user.id).all().catch(() => ({ results: [] })),
    ]);
    return jsonResponse({
      ok: true,
      user: { id: user.id, email: user.email },
      holdings: holdingsRes.results || [],
      transactions: txRes.results || [],
      watchlists: wlRes.results || [],
      psa_certs: certsRes.results || [],
    });
  } catch (e) {
    return serverError(`Portfolio 조회 실패: ${e.message || e}`);
  }
});
