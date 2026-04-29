// functions/api/scraped-sets.js
// 스크래핑 완료된 세트 목록 반환 — 프런트엔드가 어느 세트 카드 그리드 보여줄지 판단
// 사용: /api/scraped-sets

export async function onRequest(context) {
  const { env } = context;
  if (!env.IMAGES) {
    return jsonResp(500, { ok: false, error: "R2 binding missing" });
  }
  try {
    const list = await env.IMAGES.list({ prefix: "", delimiter: "/" });
    const brands = (list.delimitedPrefixes || []).map(p => p.replace("/", ""));
    const result = {};
    for (const brand of brands) {
      const setsList = await env.IMAGES.list({ prefix: `${brand}/`, delimiter: "/" });
      result[brand] = (setsList.delimitedPrefixes || [])
        .map(p => p.replace(`${brand}/`, "").replace("/", ""));
    }
    return jsonResp(200, { ok: true, brands: result });
  } catch (e) {
    return jsonResp(500, { ok: false, error: String(e && e.message || e) });
  }
}

function jsonResp(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
