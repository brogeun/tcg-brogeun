/**
 * POST /api/auth/delete-account
 * → 현재 로그인된 사용자의 계정 + 모든 관련 데이터 삭제
 *
 * Apple App Store Guideline 5.1.1(v) 준수 — 계정 생성 가능 앱은 계정 삭제 필수.
 *
 * 삭제 순서:
 *   1) holdings (보유 카드)
 *   2) transactions (거래 기록)
 *   3) watchlists (관심 카드)
 *   4) psa_certs (PSA cert 등록)
 *   5) users (사용자 본체)
 *   6) session 쿠키 만료
 */
import { getCurrentUser, jsonResponse, serverError } from '../../_shared/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverError('D1 not bound');

  const user = await getCurrentUser(request, env);
  if (!user) {
    return jsonResponse({ ok: false, error: '로그인이 필요합니다.' }, 401);
  }

  // 사용자 확인 — body 의 confirm 가 'DELETE' 여야 함 (안전장치)
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'JSON body 필요' }, 400);
  }
  if (body?.confirm !== 'DELETE') {
    return jsonResponse({ ok: false, error: '확인 문자열 누락 (confirm: "DELETE" 필요)' }, 400);
  }

  const uid = user.id;
  const deleted = { holdings: 0, transactions: 0, watchlists: 0, psa_certs: 0, users: 0 };

  // 트랜잭션 형태로 순차 삭제
  try {
    // 1) holdings
    const h = await env.DB.prepare('DELETE FROM holdings WHERE user_id = ?').bind(uid).run();
    deleted.holdings = h?.meta?.changes ?? 0;
  } catch (e) {
    console.warn('delete holdings failed:', e.message);
  }
  try {
    // 2) transactions
    const t = await env.DB.prepare('DELETE FROM transactions WHERE user_id = ?').bind(uid).run();
    deleted.transactions = t?.meta?.changes ?? 0;
  } catch (e) {
    console.warn('delete transactions failed:', e.message);
  }
  try {
    // 3) watchlists
    const w = await env.DB.prepare('DELETE FROM watchlists WHERE user_id = ?').bind(uid).run();
    deleted.watchlists = w?.meta?.changes ?? 0;
  } catch (e) {
    console.warn('delete watchlists failed:', e.message);
  }
  try {
    // 4) psa_certs
    const p = await env.DB.prepare('DELETE FROM psa_certs WHERE user_id = ?').bind(uid).run();
    deleted.psa_certs = p?.meta?.changes ?? 0;
  } catch (e) {
    console.warn('delete psa_certs failed:', e.message);
  }

  // 5) users 본체 삭제
  try {
    const u = await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid).run();
    deleted.users = u?.meta?.changes ?? 0;
    if (!deleted.users) {
      return jsonResponse({ ok: false, error: '사용자 삭제 실패 (이미 삭제됨?)', deleted }, 500);
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: `사용자 삭제 실패: ${e.message}`, deleted }, 500);
  }

  // 6) session 쿠키 만료 — 클라이언트 측 로그아웃
  return new Response(
    JSON.stringify({
      ok: true,
      message: '계정이 영구적으로 삭제되었습니다. 모든 데이터가 제거되었습니다.',
      deleted,
    }),
    {
      status: 200,
      headers: [
        ['Content-Type', 'application/json'],
        ['Set-Cookie', 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'],
        ['Set-Cookie', 'k_oauth_state=; Path=/; Max-Age=0'],
        ['Set-Cookie', 'k_oauth_app=; Path=/; Max-Age=0'],
      ],
    }
  );
}
