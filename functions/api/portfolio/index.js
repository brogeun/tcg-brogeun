/**
 * GET /api/portfolio
 * → 현재 사용자의 전체 포트폴리오 (holdings + transactions + watchlist)
 */
import { withAuth, jsonResponse, serverError } from '../../_shared/auth.js';

export const onRequestGet = withAuth(async ({ env, user }) => {
  if (!env.DB) return serverError('D1 not bound');
  try {
    const [holdingsRes, txRes, wlRes] = await Promise.all([
      env.DB.prepare('SELECT * FROM holdings WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all(),
      env.DB.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC LIMIT 200').bind(user.id).all(),
      env.DB.prepare('SELECT * FROM watchlists WHERE user_id = ? ORDER BY created_at DESC').bind(user.id).all(),
    ]);
    return jsonResponse({
      ok: true,
      user: { id: user.id, email: user.email },
      holdings: holdingsRes.results || [],
      transactions: txRes.results || [],
      watchlists: wlRes.results || [],
    });
  } catch (e) {
    return serverError(`Portfolio 조회 실패: ${e.message || e}`);
  }
});
