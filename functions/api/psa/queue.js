/**
 * GET /api/psa/queue  — 대기 중인 cert 번호 목록 (가정용 PC 워커가 폴링)
 * 보호: 헤더 x-psa-worker-key === env.PSA_WORKER_KEY
 */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return new Response('D1 not bound', { status: 500 });
  const key = request.headers.get('x-psa-worker-key') || '';
  if (!env.PSA_WORKER_KEY || key !== env.PSA_WORKER_KEY) {
    return new Response('unauthorized', { status: 401 });
  }
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS psa_cert_pending (cert_number TEXT PRIMARY KEY, card_id TEXT, requested_at INTEGER)'
    ).run();
    const res = await env.DB.prepare(
      'SELECT cert_number FROM psa_cert_pending ORDER BY requested_at ASC LIMIT 20'
    ).all();
    const certs = (res.results || []).map((r) => r.cert_number);
    return new Response(JSON.stringify({ ok: true, certs }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
