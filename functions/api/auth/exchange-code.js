/** Native Kakao code exchange. D1 is the single-use authority. */
import { signJwt, sha256Hex } from '../../_shared/jwt.js';

const SESSION_DAYS = 30;
const CODE_PREFIX = 'oauth-kakao:';
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const invalid = () => json({ ok: false, error: 'invalid_or_expired_code' }, 401);
const unavailable = () => json({ ok: false, error: 'login_unavailable' }, 503);
const readToken = (db, token) => db.prepare('SELECT email, expires_at, used FROM magic_tokens WHERE token = ?').bind(token).first();

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({ ok: false, error: 'cross_origin' }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) return json({ ok: false, error: 'json_required' }, 415);
  if (!env.DB || typeof env.DB.prepare !== 'function' || !env.JWT_SECRET) return unavailable();
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const code = body?.code;
  if (typeof code !== 'string' || !code.length || code.length > 256 || code !== code.trim()) return json({ ok: false, error: 'invalid_code' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const token = CODE_PREFIX + await sha256Hex(code);
  let row, user, legacy = false;
  try {
    row = await readToken(env.DB, token);
    if (!row) {
      // Grace for codes issued by the preceding deployment. Preserve their
      // original KV expiration; never grant a fresh five minutes on migration.
      if (!env.ADMIN_KV || typeof env.ADMIN_KV.list !== 'function') return invalid();
      const key = 'oauth_code:' + code;
      const stored = await env.ADMIN_KV.get(key, 'json');
      if (!stored?.user_id) return invalid();
      user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(stored.user_id).first();
      if (!user || typeof user.email !== 'string' || !user.email) return invalid();
      const listed = await env.ADMIN_KV.list({ prefix: key, limit: 1 });
      const entry = listed?.keys?.find(item => item.name === key);
      const expires = entry?.expiration;
      if (!Number.isSafeInteger(expires) || expires <= now || expires > now + 300) return invalid();
      await env.DB.prepare('INSERT OR IGNORE INTO magic_tokens (token, email, expires_at, used) SELECT ?, email, ?, 0 FROM users WHERE id = ? AND email = ?').bind(token, expires, user.id, user.email).run();
      row = await readToken(env.DB, token);
      legacy = true;
    }
    if (!row || row.used !== 0 || !Number.isSafeInteger(row.expires_at) || row.expires_at <= now) return invalid();
    user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(row.email).first();
    if (!user || typeof user.email !== 'string' || !user.email) return invalid();
    // SQLite/D1 serializes this conditional update. Concurrent callers and
    // stale KV replicas can never claim an already consumed credential.
    const claimed = await env.DB.prepare('UPDATE magic_tokens SET used = 1 WHERE token = ? AND used = 0 AND expires_at > unixepoch() AND email = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND email = ?) RETURNING token').bind(token, user.email, user.id, user.email).first();
    if (!claimed) return invalid();
    const updated = await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(now, user.id).run();
    if (updated?.meta?.changes !== 1) return invalid();
  } catch { return unavailable(); }
  if (legacy) { try { await env.ADMIN_KV.delete('oauth_code:' + code); } catch {} }
  const exp = now + SESSION_DAYS * 24 * 60 * 60;
  const jwt = await signJwt({ sub: user.id, email: user.email, exp }, env.JWT_SECRET);
  return json({ ok: true, user: { id: user.id, email: user.email, name: user.name || null, provider: 'kakao' } }, 200, {
    'Set-Cookie': `session=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  });
}
