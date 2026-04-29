// functions/api/scrape-set.js
// 세트 한 개 스크래핑 → 카드 이미지 R2 저장 + index.json 생성
// 사용: /api/scrape-set?code=M2a&brand=pokemon&url=https://www.tcgcollector.com/sets/...
//
// R2 바인딩 필요: IMAGES (bucket: tcg-image)
// 저장 구조:
//   pokemon/M2a/index.json     ← 카드 메타 목록
//   pokemon/M2a/cards/{n}.jpg  ← 카드 이미지 (n = 카드번호 또는 인덱스)

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const qs = Object.fromEntries(url.searchParams.entries());

  if (!env.IMAGES) {
    return jsonResp(500, { ok: false, error: "R2 바인딩 'IMAGES' 누락. Cloudflare Pages → Settings → Functions → R2 bindings 추가 필요" });
  }

  const code = qs.code;
  const brand = (qs.brand || "pokemon").toLowerCase();
  const sourceUrl = qs.url;

  if (!code || !sourceUrl) {
    return jsonResp(400, { ok: false, error: "필수 파라미터: code, url (선택: brand=pokemon|onepiece)" });
  }
  if (!sourceUrl.startsWith("https://www.tcgcollector.com/")) {
    return jsonResp(400, { ok: false, error: "url은 tcgcollector.com 주소여야 합니다" });
  }

  try {
    // 1) 세트 페이지 fetch
    const r = await fetch(sourceUrl, {
      headers: { "User-Agent": UA, "Accept": "text/html" },
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`set page HTTP ${r.status}`);
    const html = await r.text();

    // 2) 카드 추출 (tcgcollector HTML 구조 기반 정규식)
    const cards = extractCards(html);
    if (cards.length === 0) {
      return jsonResp(500, { ok: false, error: "카드를 찾을 수 없습니다 (HTML 구조 변경 가능성)", htmlLength: html.length });
    }

    // 3) 각 카드 이미지 다운로드 → R2 업로드 (병렬, 최대 8개씩)
    const results = [];
    for (let i = 0; i < cards.length; i += 8) {
      const batch = cards.slice(i, i + 8);
      const settled = await Promise.allSettled(
        batch.map(c => downloadAndUpload(c, brand, code, env.IMAGES))
      );
      settled.forEach((s, idx) => {
        if (s.status === "fulfilled") results.push(s.value);
        else results.push({ ...batch[idx], error: String(s.reason) });
      });
    }

    // 4) index.json 작성 → R2에 저장
    const successCount = results.filter(c => !c.error && c.savedKey).length;
    const indexJson = {
      brand,
      code,
      sourceUrl,
      scrapedAt: new Date().toISOString(),
      total: cards.length,
      saved: successCount,
      cards: results,
    };
    await env.IMAGES.put(
      `${brand}/${code}/index.json`,
      JSON.stringify(indexJson, null, 2),
      { httpMetadata: { contentType: "application/json" } }
    );

    return jsonResp(200, {
      ok: true,
      brand, code,
      total: cards.length,
      saved: successCount,
      indexUrl: `${brand}/${code}/index.json`,
      sample: results.slice(0, 3),
    });
  } catch (e) {
    return jsonResp(500, { ok: false, error: String(e && e.message || e) });
  }
}

/* tcgcollector HTML에서 카드 정보 추출 */
function extractCards(html) {
  const cards = [];
  // 패턴 1: card-image-grid item — 보통 <li class="card-image-grid-item">...</li>
  const itemRe = /<li[^>]*class="[^"]*card-image-grid-item[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  let idx = 0;
  while ((m = itemRe.exec(html)) !== null) {
    idx++;
    const block = m[1];
    // 이미지 URL 추출 (src 또는 data-src)
    const imgM = block.match(/<img[^>]+(?:src|data-src)="([^"]+)"/i);
    if (!imgM) continue;
    let imageUrl = imgM[1];
    // tcgcollector 이미지가 _250 사이즈면 _500 또는 풀 사이즈로 변환 시도
    imageUrl = imageUrl.replace(/_250\.(jpg|png)/i, "_500.$1");

    // 카드 이름 추출
    const nameM = block.match(/alt="([^"]+)"/i) || block.match(/<a[^>]+title="([^"]+)"/i);
    const name = nameM ? nameM[1].trim() : `Card ${idx}`;

    // 카드 번호 추출 (예: 001/108)
    const numM = block.match(/\b(\d+)\s*\/\s*\d+\b/) || block.match(/<span[^>]*class="[^"]*card-info[^"]*"[^>]*>[\s\S]*?(\d+)/i);
    const number = numM ? numM[1].padStart(3, "0") : String(idx).padStart(3, "0");

    cards.push({
      idx,
      number,
      name,
      sourceImage: imageUrl,
    });
  }

  // 폴백 패턴 2: 직접 <img> 태그에서 카드 이미지 패턴 매칭
  if (cards.length === 0) {
    const imgRe = /<img[^>]+(?:src|data-src)="([^"]+\/(?:cards|card-images)\/[^"]+\.(?:jpg|png|webp))"[^>]*alt="([^"]*)"/g;
    while ((m = imgRe.exec(html)) !== null) {
      idx++;
      cards.push({
        idx,
        number: String(idx).padStart(3, "0"),
        name: m[2] || `Card ${idx}`,
        sourceImage: m[1].replace(/_250\.(jpg|png)/i, "_500.$1"),
      });
    }
  }

  return cards;
}

/* 카드 이미지 다운로드 + R2 업로드 */
async function downloadAndUpload(card, brand, setCode, bucket) {
  const r = await fetch(card.sourceImage, {
    headers: { "User-Agent": UA, "Referer": "https://www.tcgcollector.com/" },
  });
  if (!r.ok) throw new Error(`image HTTP ${r.status}`);
  const blob = await r.arrayBuffer();
  const ext = card.sourceImage.match(/\.(jpg|jpeg|png|webp)/i)?.[1]?.toLowerCase() || "jpg";
  const key = `${brand}/${setCode}/cards/${card.number}.${ext}`;
  await bucket.put(key, blob, {
    httpMetadata: {
      contentType: ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg",
      cacheControl: "public, max-age=2592000", // 30일
    },
  });
  return {
    idx: card.idx,
    number: card.number,
    name: card.name,
    savedKey: key,
  };
}

function jsonResp(status, body) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
