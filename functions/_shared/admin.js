// Administrator identity is determined on the server, never by browser storage.
const ADMIN_EMAIL = 'yhk3213@gmail.com';

export async function isAdminUser(user, env) {
  if (!user?.id || String(user.email || '').trim().toLowerCase() !== ADMIN_EMAIL || !env.DB) return false;
  try {
    const row = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(user.id).first();
    return !!row && row.id === user.id && String(row.email || '').trim().toLowerCase() === ADMIN_EMAIL;
  } catch {
    return false;
  }
}
