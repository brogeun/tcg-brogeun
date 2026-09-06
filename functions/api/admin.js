/**
 * Cloudflare Pages Function — 관리자 데이터 (이벤트 / 기타) 저장 + 조회
 *
 * 환경 바인딩:
 *   env.ADMIN_KV       — KV namespace (Settings > Functions > KV namespace bindings)
 *   env.JWT_SECRET / env.DB — 로그인 세션 및 관리자 계정 확인
 *
 * 엔드포인트:
 *   GET  /api/admin?type=events|etc            — 데이터 조회 (공개, 누구나)
 *   POST /api/admin  Body: {type, items}       — 관리자 로그인 세션 필요
 */
import { getCurrentUser } from '../_shared/auth.js';
import { isAdminUser } from '../_shared/admin.js';

const ALLOWED_TYPES = new Set(["events", "etc", "cardshow", "grading", "news"]);
const KEY_PREFIX = "admin_";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

export async function onRequestOptions() {
  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type");
  if (!ALLOWED_TYPES.has(type)) {
    return json({ ok: false, error: "type must be one of: events, etc, cardshow, grading, news" }, 400);
  }
  if (!env.ADMIN_KV) {
    return json({ ok: false, error: "KV namespace not bound (ADMIN_KV)" }, 500);
  }
  try {
    const stored = await env.ADMIN_KV.get(KEY_PREFIX + type, "json");
    return json({ ok: true, type, items: Array.isArray(stored) ? stored : [] });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  // JSON + same-origin writes prevent cookie-authenticated cross-site submissions.
  const origin = request.headers.get('Origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return json({ ok: false, error: '다른 사이트에서는 게시할 수 없습니다.' }, 403);
  }
  if (!env.JWT_SECRET) return json({ ok: false, error: 'Authentication unavailable' }, 503);
  const user = await getCurrentUser(request, env);
  if (!user) return json({ ok: false, error: '관리자 계정으로 로그인해 주세요.' }, 401);
  if (!await isAdminUser(user, env)) return json({ ok: false, error: '관리자 계정만 게시할 수 있습니다.' }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    return json({ ok: false, error: 'Content-Type must be application/json' }, 415);
  }
  if (!env.ADMIN_KV) {
    return json({ ok: false, error: "KV namespace not bound" }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Body must be JSON" }, 400);
  }
  const { type, items } = body || {};
  if (!ALLOWED_TYPES.has(type)) {
    return json({ ok: false, error: "type must be one of: events, etc, cardshow, grading, news" }, 400);
  }
  if (!Array.isArray(items)) {
    return json({ ok: false, error: "items must be an array" }, 400);
  }
  // 안전 — 항목 500개, 게시판 전체 24MB (KV value 한계 25MiB)
  if (items.length > 500) {
    return json({ ok: false, error: "Max 500 items" }, 413);
  }
  const serialized = JSON.stringify(items);
  if (serialized.length > 24 * 1024 * 1024) {
    return json({ ok: false, error: "Total payload over 24MB" }, 413);
  }
  try {
    await env.ADMIN_KV.put(KEY_PREFIX + type, serialized);
    return json({ ok: true, type, count: items.length });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}
