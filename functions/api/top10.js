// functions/api/top10.js
// 홈 화면용 — SNKRDUNK 브랜드 카테고리 페이지에서 TOP 10 카드만 가져옴
// 캐시: 24시간 (Cloudflare s-maxage)
// 사용: /api/top10?brand=pokemon  또는  /api/top10?brand=onepiece

const BASE = "https://snkrdunk.com";
const URLS = {
  pokemon:  `${BASE}/brands/pokemon/categories/6`,
  onepiece: `${BASE}/brands/onepiece/categories/6`,
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const brand = (url.searchParams.get("brand") || "pokemon").toLowerCase();
  if (!URLS[brand]) return json(400, { ok: false, error: "brand must be pokemon or onepiece" });

  try {
    const html = await fetchHtml(URLS[brand], env);
    const products = extractTop10(html);
    return json(200, {
      ok: true,
      brand,
      source: URLS[brand],
      count: products.length,
      products,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
}

/* ─────────── HTML 가져오기 (ScrapingBee 있으면 경유) ─────────── */
async function fetchHtml(target, env) {
  const apiKey = env?.SCRAPINGBEE_KEY;
  if (apiKey) {
    const params = new URLSearchParams({
      api_key: apiKey, url: target,
      render_js: "false", country_code: "jp", block_resources: "true",
    });
    const r = await fetch(`https://app.scrapingbee.com/api/v1/?${params}`, { redirect: "follow" });
    if (!r.ok) throw new Error(`ScrapingBee HTTP ${r.status}`);
    return await r.text();
  }
  const r = await fetch(target, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`SNKRDUNK HTTP ${r.status}`);
  return await r.text();
}

/* ─────────── __NEXT_DATA__ 파싱 → 상위 10개 ─────────── */
function extractTop10(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let data;
  try { data = JSON.parse(m[1]); } catch { return []; }

  const out = [];
  const seen = new Set();
  walk(data, (it) => {
    if (out.length >= 10) return;
    const id = it.id ?? it.productId ?? it.product_id;
    const name = it.name ?? it.productName ?? it.title ?? it.product_name;
    if (!id || !name || seen.has(String(id))) return;
    const image = it.image ?? it.imageUrl ?? it.image_url ?? it.thumbnail ?? it.thumb;
    const lastPrice = num(it.lastPrice ?? it.latestPrice ?? it.last_price ?? it.lastTradedPrice);
    const lowestAsk = num(it.lowestAsk ?? it.lowest_ask ?? it.minAskPrice);
    // 가격 없는 항목 스킵
    if (!validPrice(lastPrice) && !validPrice(lowestAsk)) return;
    seen.add(String(id));
    out.push({
      id: String(id),
      name: String(name),
      image: image ? String(image) : null,
      lastPrice: validPrice(lastPrice) ? lastPrice : null,
      lowestAsk: validPrice(lowestAsk) ? lowestAsk : null,
      url: `${BASE}/apparels/${id}`,
    });
  });
  return out;
}

function walk(obj, fn, depth = 0) {
  if (depth > 14 || obj == null) return;
  if (Array.isArray(obj)) {
    for (const v of obj) walk(v, fn, depth + 1);
  } else if (typeof obj === "object") {
    fn(obj);
    for (const v of Object.values(obj)) walk(v, fn, depth + 1);
  }
}
function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace(/[¥￥円,\s]/g, ""));
  return isFinite(n) ? n : null;
}
function validPrice(n) { return n != null && !isNaN(n) && n >= 50 && n <= 100000000; }

function json(status, body) {
  const ttl = status === 200 ? 86400 : 60;  // 24시간 캐시
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`,
      "access-control-allow-origin": "*",
    },
  });
}
