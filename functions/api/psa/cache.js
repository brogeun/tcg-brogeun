/**
 * POST /api/psa/cache  — 워커가 받아온 PSA cert 페이지 HTML 을 파싱·캐시 저장 + 대기열 제거
 * body: { cert_number, html }   보호: 헤더 x-psa-worker-key === env.PSA_WORKER_KEY
 */
import { parsePsaCertPage } from './_parse.js';

export async function onRequestPost({ env, request }) {
  if (!env.DB) return new Response('D1 not bound', { status: 500 });
  const key = request.headers.get('x-psa-worker-key') || '';
  if (!env.PSA_WORKER_KEY || key !== env.PSA_WORKER_KEY) {
    return new Response('unauthorized', { status: 401 });
  }

  let body;
  try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }
  const certNumber = String(body.cert_number || '').replace(/\D/g, '');
  const html = String(body.html || '');
  if (!certNumber) return new Response('cert_number 필요', { status: 400 });

  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS psa_cert_cache (cert_number TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS psa_cert_pending (cert_number TEXT PRIMARY KEY, card_id TEXT, requested_at INTEGER)'
  ).run();

  const cert = html ? parsePsaCertPage(html, certNumber) : null;
  const data = cert || { CertNumber: certNumber, notFound: true };

  await env.DB.prepare(
    'INSERT OR REPLACE INTO psa_cert_cache (cert_number, data, fetched_at) VALUES (?, ?, ?)'
  ).bind(certNumber, JSON.stringify(data), Date.now()).run();

  await env.DB.prepare('DELETE FROM psa_cert_pending WHERE cert_number = ?').bind(certNumber).run();

  return new Response(JSON.stringify({ ok: true, parsed: !!cert }), {
    headers: { 'content-type': 'application/json' },
  });
}
