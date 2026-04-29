// functions/api/cards.js
// 세트별 카드 목록 + 이미지 URL 반환 (R2에서 읽음)
// 사용: /api/cards?code=M2a&brand=pokemon

const R2_PUBLIC_URL = "https://pub-5c6b7ed6650f4b99b5b8c5e876818f41.r2.dev";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const qs = Object.fromEntries(url.searchParams.entries());

  const code = qs.code;
  const brand = (qs.brand || "pokemon").toLowerCase();

  if (!code) {
    return jsonResp(400, { ok: false, error: "code 파라미터 필요" });
  }
  if (!env.IMAGES) {
    return jsonResp(500, { ok: false, error: "R2 binding 'IMAGES' missing" });
  }

  try {
    const indexKey = `${brand}/${code}/index.json`;
    const obj = await env.IMAGES.get(indexKey);
    if (!obj) {
      return jsonResp(404, {
        ok: false,
        scraped: false,
        error: `세트 ${code}는 아직 스크래핑되지 않았습니다.`,
        hint: `먼저 /api/scrape-set?code=${code}&brand=${brand}&url=... 호출 필요`,
      });
    }

    const data = await obj.json();
    // 각 카드에 R2 public URL 추가
    const cardsWithUrl = (data.cards || []).map(c => ({
      ...c,
      imageUrl: c.savedKey ? `${R2_PUBLIC_URL}/${c.savedKey}` : null,
    }));

    return jsonResp(200, {
      ok: true,
      scraped: true,
      brand: data.brand,
      code: data.code,
      sourceUrl: data.sourceUrl,
      scrapedAt: data.scrapedAt,
      total: data.total,
      saved: data.saved,
      cards: cardsWithUrl,
    });
  } catch (e) {
    return jsonResp(500, { ok: false, error: String(e && e.message || e) });
  }
}

function jsonResp(status, body) {
  // 24시간 캐시 (스크래핑된 데이터는 자주 안 바뀜)
  const cacheCtrl = status === 200
    ? "public, max-age=86400, s-maxage=86400, stale-while-revalidate=172800"
    : "public, max-age=60";
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheCtrl,
      "access-control-allow-origin": "*",
    },
  });
}
