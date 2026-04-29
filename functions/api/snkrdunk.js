// functions/api/snkrdunk.js
// Cloudflare Pages Functions 버전 — SNKRDUNK 카드 시세 fetcher
//
// 호출 경로:
//   /api/snkrdunk?brand=pokemon&type=box&page=1
//   /api/snkrdunk?q=피카츄
//   /api/snkrdunk?id=151755
//   /api/snkrdunk?url=https://snkrdunk.com/...

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8,ko;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
};

const BASE = "https://snkrdunk.com";

const BRAND_CATEGORY = {
  pokemon: `${BASE}/brands/pokemon/categories/6`,
  onepiece: `${BASE}/brands/onepiece/categories/6`,
};

const BRAND_KEYWORD = {
  pokemon: "ポケモンカード",
  onepiece: "ワンピースカード",
};

const GRADE_KEYWORD = {
  all: "",
  unopened: " 未開封",
  psa10: " PSA10",
  psa9: " PSA9",
  a: " A品",
};

/* 한국어 → 일본어 키워드 사전 */
const KO_TO_JA = {
  "미개봉":"未開封","박스":"BOX","부스터":"ブースター","부스터박스":"ブースターボックス",
  "프로모":"プロモ","스페셜":"スペシャル","한정":"限定","확장팩":"拡張パック","팩":"パック",
  "싱글":"シングル","한국어판":"韓国語版","일본어판":"日本語版",
  "피카츄":"ピカチュウ","리자몽":"リザードン","꼬부기":"ゼニガメ","거북왕":"カメックス",
  "이상해씨":"フシギダネ","이상해꽃":"フシギバナ","파이리":"ヒトカゲ","리자드":"リザード",
  "이브이":"イーブイ","뮤":"ミュウ","뮤츠":"ミュウツー","라프라스":"ラプラス","갸라도스":"ギャラドス",
  "잠만보":"カビゴン","팬텀":"ゲンガー","루기아":"ルギア","칠색조":"ホウオウ","아르세우스":"アルセウス",
  "자시안":"ザシアン","자마젠타":"ザマゼンタ","루피":"ルフィ","조로":"ゾロ","나미":"ナミ",
  "에이스":"エース","샹크스":"シャンクス","야마토":"ヤマト","카이도":"カイドウ","빅맘":"ビッグ・マム",
  "테라크리스탈":"テラスタル","메가":"メガ","이브이히어로즈":"イーブイヒーローズ",
  "스칼렛":"スカーレット","바이올렛":"バイオレット","낙원드래고나":"楽園ドラゴーナ",
};

function hasKorean(s){ return /[가-힯ᄀ-ᇿ㄰-㆏]/.test(s||""); }
function translateKoToJa(input){
  if(!input || !hasKorean(input)) return input;
  let out = input;
  const keys = Object.keys(KO_TO_JA).sort((a,b) => b.length - a.length);
  for(const k of keys){ if(out.includes(k)) out = out.split(k).join(KO_TO_JA[k]); }
  return out;
}

function toNum(v){
  if(v == null) return null;
  if(typeof v === "number") return isFinite(v) ? v : null;
  if(typeof v !== "string") return null;
  const n = parseFloat(v.replace(/[¥￥円,\s]/g, "").replace(/JPY/i, ""));
  return isFinite(n) ? n : null;
}
function validPrice(n, min=50, max=100000000){ return n != null && !isNaN(n) && n >= min && n <= max; }

function extractNextData(html){
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if(!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
function extractMeta(html, prop){
  const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
  const m = html.match(re);
  return m ? m[1] : null;
}

function classifyProductType(name){
  const s = String(name || "").toLowerCase();
  const boxKeywords = [/\bbox\b/i, /ボックス/, /拡張パック/, /booster/i, /バインダー/, /デッキ/, /スターター/i, /high\s*class\s*pack/i, /pack/i];
  for(const re of boxKeywords) if(re.test(s)) return "box";
  return "card";
}

function normalizeProduct(item){
  if(!item || typeof item !== "object") return null;
  const id = item.id ?? item.productId ?? item.product_id ?? null;
  const name = item.name ?? item.productName ?? item.title ?? item.product_name ?? null;
  const image = item.image ?? item.imageUrl ?? item.image_url ?? item.thumbnail ?? item.thumb ?? item.imagePath ?? null;
  const lastPrice = toNum(item.lastPrice ?? item.latestPrice ?? item.last_price ?? item.currentPrice ?? item.lastTradedPrice ?? item.latestTradedPrice);
  const lowestAsk = toNum(item.lowestAsk ?? item.lowest_ask ?? item.minAskPrice ?? item.askPrice);
  const highestBid = toNum(item.highestBid ?? item.highest_bid ?? item.maxBidPrice ?? item.bidPrice);
  if(id == null || !name) return null;
  return {
    id: String(id), name: String(name),
    image: image ? String(image) : null,
    type: classifyProductType(name),
    lastPrice: validPrice(lastPrice) ? lastPrice : null,
    lowestAsk: validPrice(lowestAsk) ? lowestAsk : null,
    highestBid: validPrice(highestBid) ? highestBid : null,
    url: `${BASE}/apparels/${id}`,
  };
}

function harvestProducts(root, max=60){
  const out = []; const seen = new Set();
  function walk(obj, depth=0){
    if(out.length >= max || depth > 16 || obj == null) return;
    if(Array.isArray(obj)){
      for(const item of obj){
        if(out.length >= max) return;
        const p = normalizeProduct(item);
        if(p && !seen.has(p.id)){ out.push(p); seen.add(p.id); }
        if(item && typeof item === "object") walk(item, depth+1);
      }
    } else if(typeof obj === "object"){
      const p = normalizeProduct(obj);
      if(p && !seen.has(p.id)){ out.push(p); seen.add(p.id); }
      for(const v of Object.values(obj)) walk(v, depth+1);
    }
  }
  walk(root);
  return out;
}

/* HTTP fetch — SCRAPINGBEE_KEY 있으면 경유, 없으면 직접 */
async function getHtml(url, env){
  const apiKey = env?.SCRAPINGBEE_KEY;
  if(apiKey){
    const params = new URLSearchParams({
      api_key: apiKey, url, render_js: "false",
      country_code: "jp", block_resources: "true",
    });
    const beeUrl = `https://app.scrapingbee.com/api/v1/?${params}`;
    const res = await fetch(beeUrl, { redirect: "follow" });
    if(!res.ok) throw new Error(`ScrapingBee HTTP ${res.status}`);
    return await res.text();
  }
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function findPriceInHtml(html){
  const patterns = [/¥\s?([\d,]+)/g, /([\d,]+)\s?円/g, /JPY\s?([\d,]+)/gi];
  const counts = {};
  for(const re of patterns){
    let m;
    while((m = re.exec(html)) !== null){
      const n = toNum(m[1]);
      if(validPrice(n)) counts[n] = (counts[n] || 0) + 1;
    }
  }
  const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
  return sorted.length ? Number(sorted[0][0]) : null;
}

function parseProduct(html, sourceUrl){
  const next = extractNextData(html);
  let result = null;
  if(next){
    const all = harvestProducts(next, 60);
    if(sourceUrl){
      const idMatch = sourceUrl.match(/\/(?:apparels|products)\/([^/?#]+)/);
      if(idMatch){
        const want = idMatch[1];
        result = all.find(p => p.id === want) || null;
      }
    }
    if(!result && all.length) result = all[0];
  }
  if(!result){
    const ogTitle = extractMeta(html, "og:title");
    const ogImage = extractMeta(html, "og:image");
    const fallbackPrice = findPriceInHtml(html);
    if(ogTitle || ogImage || fallbackPrice){
      result = { id: null, name: ogTitle, image: ogImage,
        lastPrice: validPrice(fallbackPrice) ? fallbackPrice : null,
        lowestAsk: null, highestBid: null, url: sourceUrl };
    }
  }
  if(result && sourceUrl) result.url = sourceUrl;
  return result;
}

/* ─────────── Cloudflare Pages Function 핸들러 ─────────── */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const qs = Object.fromEntries(url.searchParams.entries());

  try {
    /* 모드 1: 브랜드 카테고리 + 박스/카드 필터 + 페이지네이션 */
    if(qs.brand && BRAND_CATEGORY[qs.brand]){
      const productType = (qs.type || "all").toLowerCase();
      const page = Math.max(1, parseInt(qs.page || "1", 10));
      const grade = (qs.grade || "all").toLowerCase();
      const gradeKey = GRADE_KEYWORD.hasOwnProperty(grade) ? grade : "all";

      let targetUrl;
      if(gradeKey !== "all"){
        const keyword = (BRAND_KEYWORD[qs.brand] || "") + GRADE_KEYWORD[gradeKey];
        targetUrl = `${BASE}/search?keyword=${encodeURIComponent(keyword.trim())}&page=${page}`;
      } else {
        targetUrl = `${BRAND_CATEGORY[qs.brand]}?page=${page}`;
      }

      const html = await getHtml(targetUrl, env);
      const next = extractNextData(html);
      let products = next ? harvestProducts(next, 200) : [];

      if(productType === "box") products = products.filter(p => p.type === "box");
      else if(productType === "card") products = products.filter(p => p.type === "card");

      return makeJson(200, {
        ok: true, type: "category", brand: qs.brand, productType, grade: gradeKey,
        page, source: targetUrl, count: products.length, products,
      });
    }

    /* 모드 2: URL 직접 지정 */
    if(qs.url){
      if(!qs.url.startsWith(BASE)) return makeJson(400, { ok: false, error: "url must start with " + BASE });
      const html = await getHtml(qs.url, env);
      return makeJson(200, { ok: true, type: "product", product: parseProduct(html, qs.url) });
    }

    /* 모드 3: 상품 ID */
    if(qs.id){
      const targetUrl = `${BASE}/apparels/${encodeURIComponent(qs.id)}`;
      const html = await getHtml(targetUrl, env);
      return makeJson(200, { ok: true, type: "product", product: parseProduct(html, targetUrl) });
    }

    /* 모드 4: 검색 (한국어 자동 번역) */
    if(qs.q){
      const original = qs.q;
      const translated = translateKoToJa(original);
      const wasTranslated = translated !== original;
      const queries = wasTranslated ? [translated, original] : [original];
      const allProducts = []; const seen = new Set();
      let usedUrl = null; let lastHtml = null;

      for(const q of queries){
        const tries = [
          `${BASE}/search?keyword=${encodeURIComponent(q)}`,
          `${BASE}/search?q=${encodeURIComponent(q)}`,
        ];
        for(const u of tries){
          try {
            const html = await getHtml(u, env);
            lastHtml = html;
            if(!html.includes("__NEXT_DATA__")) continue;
            usedUrl = u;
            const next = extractNextData(html);
            const products = next ? harvestProducts(next, 30) : [];
            for(const p of products){
              if(!seen.has(p.id)){ allProducts.push(p); seen.add(p.id); }
            }
            if(allProducts.length >= 12) break;
          } catch {}
        }
        if(allProducts.length >= 12) break;
      }

      if(!lastHtml) return makeJson(502, { ok: false, error: "all search URLs failed" });
      return makeJson(200, {
        ok: true, type: "search", q: original,
        translated: wasTranslated ? translated : null,
        source: usedUrl, count: allProducts.length, products: allProducts,
      });
    }

    return makeJson(400, {
      ok: false,
      error: "missing query param. use ?brand=, ?q=, ?id=, or ?url=",
    });
  } catch(e){
    return makeJson(500, { ok: false, error: String(e && e.message || e) });
  }
}

function makeJson(status, body){
  const cacheCtrl = status === 200
    ? "public, max-age=86400, s-maxage=86400, stale-while-revalidate=172800"
    : "public, max-age=60";
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheCtrl,
      "access-control-allow-origin": "*",
    },
  });
}
