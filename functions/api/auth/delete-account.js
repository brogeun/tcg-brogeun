/** Delete the account and its owned records in one D1 transaction. */
import { getCurrentUser, jsonResponse, serverError } from '../../_shared/auth.js';

const OWNED_TABLES = [
  'collection_mutations', 'user_card_states', 'collections',
  'cert_registration_requests', 'psa_certs', 'bgs_certs',
  'transactions', 'watchlists', 'holdings',
  'kanto151_save_backups', 'kanto151_saves',
  'volleyball_records', 'volleyball_sessions',
  'jigglypuff_mode_records', 'jigglypuff_mode_sessions',
  'jigglypuff_records', 'jigglypuff_sessions',
];

export async function onRequestPost({ request, env }) {
  if (!env.DB || typeof env.DB.batch !== 'function') return jsonResponse({ ok: false, error: 'unavailable', message: 'Account deletion is unavailable' }, 503);
  const user = await getCurrentUser(request, env);
  if (!user) return jsonResponse({ ok: false, error: '로그인이 필요합니다.' }, 401);
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: 'JSON body 필요' }, 400); }
  if (body?.confirm !== 'DELETE') return jsonResponse({ ok: false, error: '확인 문자열 누락 (confirm: "DELETE" 필요)' }, 400);

  try {
    // Older installations may not have every optional feature table.
    const schema = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const existing = new Set((schema.results || []).map(row => row.name));
    const names = OWNED_TABLES.filter(name => existing.has(name));
    const statements = names.map(name => env.DB.prepare(`DELETE FROM ${name} WHERE user_id = ?`).bind(user.id));
    if (existing.has('magic_tokens')) {
      names.push('magic_tokens');
      statements.push(env.DB.prepare('DELETE FROM magic_tokens WHERE email = ?').bind(user.email));
    }
    names.push('users');
    statements.push(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id));
    // D1 batches roll back the complete sequence if any statement fails.
    const results = await env.DB.batch(statements);
    const deleted = Object.fromEntries(names.map((name, i) => [name, results[i]?.meta?.changes || 0]));
    if (deleted.users !== 1) return serverError('Account deletion could not be confirmed');
    return jsonResponse({ ok: true, message: '계정이 영구적으로 삭제되었습니다.', deleted }, 200, {
      'Set-Cookie': 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    });
  } catch {
    return serverError('계정 삭제를 완료하지 못했습니다. 데이터는 유지되었습니다. 잠시 후 다시 시도해주세요.');
  }
}
