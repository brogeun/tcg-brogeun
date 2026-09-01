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

  let data;
  if (cert) {
    data = cert;
  } else {
    // 파싱 실패 — '진짜 없는 cert' 페이지인지, 챌린지/오류 페이지인지 구분.
    // 챌린지/오류를 notFound 로 영구 저장하면 멀쩡한 cert 가 오염되므로, 그런 경우는
    // 캐시도 대기열 제거도 하지 않고 그대로 둔다 (워커가 다음 주기에 재시도).
    const low = String(html).toLowerCase();
    const looksNotFound = low.includes('cert') &&
      (low.includes('not found') || low.includes('invalid') ||
       low.includes('no certification') || low.includes("doesn't exist"));
    if (!looksNotFound) {
      return new Response(JSON.stringify({ ok: false, skipped: true, note: '실제 데이터 아님 — 캐시 안 함' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    data = { CertNumber: certNumber, notFound: true };
  }

  await env.DB.prepare(
    'INSERT OR REPLACE INTO psa_cert_cache (cert_number, data, fetched_at) VALUES (?, ?, ?)'
  ).bind(certNumber, JSON.stringify(data), Date.now()).run();

  await env.DB.prepare('DELETE FROM psa_cert_pending WHERE cert_number = ?').bind(certNumber).run();

  return new Response(JSON.stringify({ ok: true, parsed: !!cert }), {
    headers: { 'content-type': 'application/json' },
  });
}
