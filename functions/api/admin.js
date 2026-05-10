/**
 * Cloudflare Pages Function — 관리자 데이터 (이벤트 / 기타) 저장 + 조회
 *
 * 환경 바인딩:
 *   env.ADMIN_KV       — KV namespace (Settings > Functions > KV namespace bindings)
 *   env.ADMIN_PASSWORD — 환경 변수 (Settings > Environment variables, encrypted)
 *
 * 엔드포인트:
 *   GET  /api/admin?type=events|etc            — 데이터 조회 (공개, 누구나)
 *   POST /api/admin  Body: {type, items}       — 데이터 저장 (비번 필요)
 *      Header: X-Admin-Password: <password>
 */

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
      "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
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
  let auth = request.headers.get("X-Admin-Password") || "";
  // 클라이언트가 base64 인코딩 (한글/특수문자 헤더 통과용) — decode 시도, 실패 시 raw 사용
  try {
    const decoded = decodeURIComponent(escape(atob(auth)));
    if (decoded) auth = decoded;
  } catch {}
  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: "ADMIN_PASSWORD env not set" }, 500);
  }
  if (!auth || auth !== env.ADMIN_PASSWORD) {
    return json({ ok: false, error: "Unauthorized — wrong password" }, 401);
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
