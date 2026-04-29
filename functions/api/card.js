// functions/api/card.js (Cloudflare Pages Functions)
// 추적 카드 종합 시세 + SNKRDUNK URL 임의 조회
// 호출 경로: /api/card?key=... | /api/card?snkrdunkUrl=...

let SCRAPINGBEE_KEY = null; // 핸들러 진입 시 env에서 설정

/* ─────────── 추적 카드 매핑 (사용자 지정 7장) ─────────── */
const TRACKED_CARDS = {
  megadream_pikachu: {
    nickname: "메가드림 피카츄",
    snkrdunk: "https://snkrdunk.com/apparels/730956",
    psa:      "https://www.psacard.com/cert/146223853/psa",
    hare2buy: "https://www.hare2buy.com/product/21964",
  },
  mac_pikachu: {
    nickname: "맥카츄",
    snkrdunk: "https://snkrdunk.com/apparels/671486",
    psa:      "https://www.psacard.com/cert/131166075/psa",
    hare2buy: null,
  },
  backdeck_pikachu: {
    nickname: "백덱츄",
    snkrdunk: "https://snkrdunk.com/apparels/737036",
    psa:      "https://www.psacard.com/cert/146442115/psa",
    hare2buy: "https://www.hare2buy.com/product/22778",
  },
  gogh_pikachu: {
    nickname: "고흐츄",
    snkrdunk: "https://snkrdunk.com/apparels/146897",
    psa:      "https://www.psacard.com/cert/100497157/psa",
    hare2buy: null,
  },
  art_charizard: {
    nickname: "아트 리자몽",
    snkrdunk: "https://snkrdunk.com/apparels/91400",
    psa:      "https://www.psacard.com/cert/79486554/psa",
    hare2buy: null,
  },
  inferno_sar: {
    nickname: "인페르노 SAR",
    snkrdunk: "https://snkrdunk.com/apparels/704401",
    psa:      "https://www.psacard.com/cert/132473397/psa",
    hare2buy: "https://www.hare2buy.com/product/21434",
  },
  mur_charizard: {
    nickname: "MUR 리자몽",
    snkrdunk: "https://snkrdunk.com/apparels/704407",
    psa:      "https://www.psacard.com/cert/143766146/psa",
    hare2buy: "https://www.hare2buy.com/product/21440",
  },
};

/* ─────────── 공통 유틸 ─────────── */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DIRECT_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8,ko;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
};

/* SNKRDUNK 등 봇 차단 약한 사이트는 직접 호출 (264.hl 검증 완료) */
async function getHtmlDirect(url, opts = {}) {
  const r = await fetch(url, { headers: DIRECT_HEADERS, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

/* ScrapingBee 경유 (PSA 등 봇 차단 강한 사이트용) */
async function getHtmlViaBee(url, opts = {}) {
  if (!SCRAPINGBEE_KEY) {
    // 키 없으면 직접 시도
    return getHtmlDirect(url, opts);
  }
  const params = new URLSearchParams({
    api_key: SCRAPINGBEE_KEY,
    url,
    render_js: opts.render_js ? "true" : "false",
    country_code: opts.country_code || "us",
    block_resources: "true",
  });
  const r = await fetch(`https://app.scrapingbee.com/api/v1/?${params}`);
  if (!r.ok) {
    const body = await r.text().catch(()=>"");
    throw new Error(`ScrapingBee ${r.status}: ${body.slice(0,150)}`);
  }
  return r.text();
}

/* 사이트별 라우팅 — direct 우선, 막히면 Bee 폴백 */
async function getHtmlSmart(url, opts = {}) {
  // SNKRDUNK: 항상 직접 (무료)
  if (url.includes("snkrdunk.com")) {
    return getHtmlDirect(url, opts);
  }
  // PSA: ScrapingBee (봇 차단 강함)
  if (url.includes("psacard.com")) {
    return getHtmlViaBee(url, opts);
  }
  // Hare2Buy: 직접 시도 → 실패 시 Bee
  if (url.includes("hare2buy.com")) {
    try {
      return await getHtmlDirect(url, opts);
    } catch (e) {
      return getHtmlViaBee(url, opts);
    }
  }
  // 기타: 기본 직접
  return getHtmlDirect(url, opts);
}

// 기존 호출처 호환 (예전 이름 alias)
const getHtml = getHtmlSmart;

function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
  const m = html.match(re);
  return m ? m[1].replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;/g,"'") : null;
}

function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[¥￥円,\s]/g, "").replace(/JPY/i, ""));
  return isFinite(n) ? n : null;
}

/* ─────────── SNKRDUNK JSON API 클라이언트 (264.hl 가이드 기반) ───────────
   /v1/streetwears/{id}/used-listings JSON 직접 호출 — 인증 불필요.
   응답: [{id, listingUID, price: "US $88", condition: "PSA 10", isSold: bool}, ...]
*/

/* SNKRDUNK URL에서 product ID 추출 */
function extractSnkrdunkId(url) {
  const m = String(url || "").match(/\/(?:apparels|products|trading-cards|streetwears)\/(\d+)/);
  return m ? m[1] : null;
}

/* USD 텍스트("US $88") → 숫자 88 */
function parseUsd(s) {
  if (s == null) return null;
  const m = String(s).match(/([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  return isFinite(n) ? n : null;
}

/* USD → JPY 환율 (캐시 30분) */
let _FX_CACHE = { rate: null, ts: 0 };
async function getUsdJpyRate() {
  if (_FX_CACHE.rate && Date.now() - _FX_CACHE.ts < 24 * 60 * 60 * 1000) return _FX_CACHE.rate;
  try {
    const r = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    const j = await r.json();
    const rate = parseFloat(j?.rates?.JPY);
    if (isFinite(rate) && rate > 50) {
      _FX_CACHE = { rate, ts: Date.now() };
      return rate;
    }
  } catch (e) {}
  return _FX_CACHE.rate || 150; // 폴백
}

/* ULID(첫10자) → timestamp(초) — sold/listed 시점 추출용 */
const _CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulidToTimestamp(ulid) {
  if (!ulid || typeof ulid !== "string") return null;
  let ts = 0;
  for (const c of ulid.slice(0, 10).toUpperCase()) {
    const idx = _CROCKFORD.indexOf(c);
    if (idx < 0) return null;
    ts = ts * 32 + idx;
  }
  return ts / 1000; // Unix seconds
}

/* SNKRDUNK 매물 페이지 1개 가져오기 */
async function fetchSnkrUsedListingsPage(cardId, page = 1, perPage = 50) {
  const url = `https://snkrdunk.com/en/v1/streetwears/${cardId}/used-listings?page=${page}&perPage=${perPage}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "application/json",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`SNKR JSON HTTP ${r.status}`);
  const data = await r.json();
  return Array.isArray(data) ? data : (data?.items || data?.data || []);
}

/* SNKRDUNK 박스 여부 판정 (sizes 엔드포인트가 비어있지 않으면 박스) */
async function fetchSnkrIsBox(cardId) {
  try {
    const url = `https://snkrdunk.com/en/v1/streetwears/${cardId}/sizes`;
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
    if (!r.ok) return false;
    const data = await r.json();
    const arr = Array.isArray(data) ? data : (data?.items || []);
    return arr.length > 0;
  } catch (e) { return false; }
}

/* SNKRDUNK 종합 fetch — 등급별 매물수/최저가, 최근 sold, 박스 여부 */
async function fetchSnkrdunkFull(cardId) {
  // 활성 매물 + sold 첫 4페이지 동시 fetch
  const [activeRaw, soldRaw, isBox, fxRate] = await Promise.all([
    fetchSnkrUsedListingsPage(cardId, 1, 50).catch(() => []),
    Promise.all([2, 3, 4].map(p => fetchSnkrUsedListingsPage(cardId, p, 50).catch(() => []))).then(a => a.flat()),
    fetchSnkrIsBox(cardId),
    getUsdJpyRate(),
  ]);

  // 페이지 1과 추가 페이지를 합치되 ID 중복 제거
  const seen = new Set();
  const all = [];
  for (const it of [...activeRaw, ...soldRaw]) {
    const uid = it?.listingUID || it?.id;
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    all.push(it);
  }

  // 등급별 그룹
  const byGrade = {}; // { "PSA 10": { activeMin, activeCount, recentSolds: [] } }
  for (const it of all) {
    const cond = (it.condition || "").trim();
    if (!cond) continue;
    if (!byGrade[cond]) byGrade[cond] = { activeMin: null, activeCount: 0, recentSolds: [] };
    const usd = parseUsd(it.price);
    if (it.isSold) {
      // sold
      const ts = ulidToTimestamp(it.listingUID);
      byGrade[cond].recentSolds.push({ usd, jpy: usd != null ? Math.round(usd * fxRate) : null, ts, uid: it.listingUID });
    } else {
      // active
      byGrade[cond].activeCount++;
      if (usd != null && (byGrade[cond].activeMin == null || usd < byGrade[cond].activeMin)) {
        byGrade[cond].activeMin = usd;
      }
    }
  }

  // 정렬 (최근 거래일 역순)
  for (const g of Object.values(byGrade)) {
    g.recentSolds.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    g.recentSolds = g.recentSolds.slice(0, 5);
  }

  // 대표 등급 우선순위로 메인 가격 결정
  const priorityGrades = ["PSA 10", "PSA 9", "A", "B", "Box (Sealed)"];
  let primaryGrade = priorityGrades.find(g => byGrade[g]?.activeMin != null || byGrade[g]?.recentSolds.length > 0);
  if (!primaryGrade) primaryGrade = Object.keys(byGrade)[0] || null;

  // 메인 가격 (USD)
  const primaryGradeData = primaryGrade ? byGrade[primaryGrade] : null;
  const lowestAskUsd = primaryGradeData?.activeMin || null;
  const lastSoldUsd = primaryGradeData?.recentSolds?.[0]?.usd || null;

  return {
    cardId,
    isBox,
    fxRate,
    byGrade,                   // 등급별 상세
    primaryGrade,              // 대표 등급
    lowestAsk: lowestAskUsd,   // USD
    lastPrice: lastSoldUsd,    // USD
    lowestAskJpy: lowestAskUsd != null ? Math.round(lowestAskUsd * fxRate) : null,
    lastPriceJpy: lastSoldUsd != null ? Math.round(lastSoldUsd * fxRate) : null,
    askCount: primaryGradeData?.activeCount || 0,
    totalActive: Object.values(byGrade).reduce((s, g) => s + g.activeCount, 0),
    totalSoldRecent: Object.values(byGrade).reduce((s, g) => s + g.recentSolds.length, 0),
  };
}

/* ─────────── SNKRDUNK 파서 (확장: 거래 이력 + 매물 + 거래량) ─────────── */
function parseSnkrdunk(html, sourceUrl) {
  let lastPrice = null, lowestAsk = null, highestBid = null;
  let name = null, nameJa = null, image = null, productId = null;
  let askCount = null, bidCount = null;
  let priceHistory = [];   // [{date:'2026-04-25', price:69000, volume:3}, ...]
  let recentTrades = [];   // [{ts:..., price:..., grade:..., qty:...}, ...]
  let totalSales = null;

  // __NEXT_DATA__ 추출 — SNKRDUNK Next.js의 SSR 데이터
  const nextMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const idMatch = sourceUrl.match(/\/(apparels|products)\/([^/?#]+)/);
      const wantId = idMatch ? idMatch[2] : null;

      const found = findProductInTree(data, wantId);
      if (found) {
        name = found.name || found.productName || found.englishName || null;
        nameJa = found.japaneseName || found.nameJa || found.localName || null;
        image = found.image || found.imageUrl || found.thumbnail || found.imagePath || null;
        lastPrice = num(found.lastPrice ?? found.latestPrice ?? found.lastTradedPrice);
        lowestAsk = num(found.lowestAsk ?? found.lowest_ask ?? found.minAskPrice ?? found.askPrice);
        highestBid = num(found.highestBid ?? found.highest_bid ?? found.maxBidPrice ?? found.bidPrice);
        askCount = num(found.askCount ?? found.asksCount ?? found.totalAsks);
        bidCount = num(found.bidCount ?? found.bidsCount ?? found.totalBids);
        totalSales = num(found.totalSales ?? found.tradeCount ?? found.salesCount);
        productId = found.id || wantId;

        // 거래 이력 (있으면)
        const histArr = found.priceHistory || found.tradeHistory || found.history || found.transactions;
        if (Array.isArray(histArr)) {
          priceHistory = histArr.slice(0, 365).map(h => ({
            date: h.date || h.tradedAt || h.timestamp || null,
            price: num(h.price ?? h.tradePrice ?? h.amount),
            volume: num(h.volume ?? h.qty ?? h.quantity ?? 1),
          })).filter(h => h.date && h.price != null);
        }
      }

      // 트리 전체에서 추가로 거래 이력 / 매물 수 찾기 (다양한 위치 가능)
      if (priceHistory.length === 0) {
        priceHistory = findArrayByKeys(data, ['priceHistory','tradeHistory','transactions','salesHistory'], 365)
          .map(h => ({
            date: h.date || h.tradedAt || h.timestamp || null,
            price: num(h.price ?? h.tradePrice ?? h.amount),
            volume: num(h.volume ?? h.qty ?? h.quantity ?? 1),
          })).filter(h => h.date && h.price != null);
      }
      if (recentTrades.length === 0) {
        recentTrades = findArrayByKeys(data, ['recentTransactions','recentTrades','latestTransactions'], 30)
          .map(t => ({
            ts: t.tradedAt || t.timestamp || t.date,
            price: num(t.price ?? t.amount),
            grade: t.condition || t.grade || t.conditionName,
            qty: num(t.quantity ?? t.qty ?? 1),
          })).filter(t => t.price != null);
      }
    } catch(e) {}
  }

  // 폴백 1: og 태그
  if (!name) name = meta(html, "og:title");
  if (!image) image = meta(html, "og:image");
  // twitter:image
  if (!image) image = meta(html, "twitter:image");

  // 폴백 2: 본문에서 SNKRDUNK 이미지 CDN 패턴 찾기
  if (!image) {
    const cdnPatterns = [
      /https?:\/\/[^"'\s]*snkrdunk[^"'\s]*\.(?:jpg|jpeg|png|webp)/i,
      /https?:\/\/image\.snkrdunk\.com\/[^"'\s]+/i,
      /https?:\/\/img\.snkrdunk\.com\/[^"'\s]+/i,
      /https?:\/\/[^"'\s]*\.b-cdn\.net\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/i,
      /https?:\/\/[^"'\s]*cloudfront[^"'\s]+\/items\/[^"'\s]+\.(?:jpg|jpeg|png|webp)/i,
    ];
    for (const re of cdnPatterns) {
      const m = html.match(re);
      if (m) { image = m[0]; break; }
    }
  }

  // 폴백 3: <img> 태그에서 큰 이미지 (data-src 포함)
  if (!image) {
    const imgPatterns = [
      /<img[^>]+(?:src|data-src)=["']([^"']+\/(?:items|products|apparels)\/[^"']+\.(?:jpg|jpeg|png|webp))["']/i,
      /<img[^>]+(?:src|data-src)=["']([^"']+main[^"']+\.(?:jpg|jpeg|png|webp))["']/i,
    ];
    for (const re of imgPatterns) {
      const m = html.match(re);
      if (m) { image = m[1]; break; }
    }
  }

  if (!lastPrice) {
    const counts = {};
    const re = /¥\s?([\d,]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const n = num(m[1]);
      if (n != null && n >= 100 && n <= 10000000) counts[n] = (counts[n] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
    if (sorted.length) lastPrice = Number(sorted[0][0]);
  }

  return {
    ok: !!(name || lastPrice || image),
    name,
    nameJa,
    image,
    lastPrice,
    lowestAsk,
    highestBid,
    askCount,
    bidCount,
    totalSales,
    priceHistory,        // 차트용
    recentTrades,        // 거래 내역 표용
    productId: productId ? String(productId) : null,
    url: sourceUrl,
  };
}

/* 트리에서 특정 키 이름의 배열 값 찾기 (priceHistory 등) */
function findArrayByKeys(root, keys, max = 100) {
  let result = [];
  const keySet = new Set(keys);
  function walk(obj, depth = 0) {
    if (result.length >= max || depth > 16 || obj == null) return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    if (typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (keySet.has(k) && Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
        result = v.slice(0, max);
        return;
      }
      walk(v, depth + 1);
    }
  }
  walk(root);
  return result;
}

function findProductInTree(root, wantId) {
  let result = null;
  function walk(obj, depth = 0) {
    if (result || depth > 20 || obj == null) return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item, depth + 1);
      return;
    }
    if (typeof obj !== "object") return;
    const idVal = obj.id ?? obj.productId ?? obj.product_id;
    if (idVal != null && wantId && String(idVal) === String(wantId)) {
      result = obj;
      return;
    }
    // wantId 없으면 가장 가능성 있는 첫 product 객체 사용
    if (!wantId && idVal != null && (obj.name || obj.productName || obj.imageUrl || obj.image)) {
      if (!result) result = obj;
    }
    for (const v of Object.values(obj)) walk(v, depth + 1);
  }
  walk(root);
  return result;
}

/* ─────────── PSA Cert 파서 (다중 폴백) ─────────── */
function parsePsa(html, sourceUrl) {
  const ogTitle = meta(html, "og:title");
  const ogImage = meta(html, "og:image");
  const ogDesc  = meta(html, "og:description");
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];

  // 검색 대상 텍스트 풀: og:title, <title>, og:description, <h1>
  const sources = [ogTitle, titleTag, ogDesc, h1].filter(Boolean).map(s => s.replace(/\s+/g, ' ').trim());
  const combined = sources.join(" | ");

  // 1) 등급: PSA 10 / PSA 9.5 / GEM MT 10 / MINT 9 등
  let grade = null;
  for (const txt of sources) {
    const m = txt.match(/PSA\s*(?:GEM\s*MT\s*|MINT\s*)?(\d+(?:\.\d+)?)/i);
    if (m) { grade = "PSA " + m[1]; break; }
  }
  // 폴백: 페이지 본문에서 PSA 등급 찾기 (본문 스캔, 가장 자주 나오는 등급)
  if (!grade) {
    const counts = {};
    const re = /PSA\s+(10|9(?:\.5)?|8(?:\.5)?|7|6|5|4|3|2|1)\b/gi;
    let m;
    while ((m = re.exec(html)) !== null) counts[m[1]] = (counts[m[1]] || 0) + 1;
    const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
    if (sorted.length) grade = "PSA " + sorted[0][0];
  }

  // 2) 년도
  let year = null;
  for (const txt of sources) {
    const m = txt.match(/\b(19[89]\d|20[0-2]\d)\b/);
    if (m) { year = m[0]; break; }
  }

  // 3) 카드 번호 (#001/015 / SV-P 173 / S8a-G 001/015 등)
  let cardNumber = null;
  for (const txt of sources) {
    const m = txt.match(/#\s*([A-Z0-9][\w\-\/]+)/i);
    if (m) { cardNumber = m[1]; break; }
  }
  if (!cardNumber) {
    const m = combined.match(/\b([A-Z]{1,3}-?[0-9]{1,3}[A-Z]?(?:\s+\d{1,3}\/\d{1,3})?)\b/);
    if (m) cardNumber = m[1].trim();
  }

  // 4) 카드 이름 — og:title 또는 <title>에서 정리
  let cardName = null;
  const rawTitle = ogTitle || titleTag || "";
  if (rawTitle) {
    cardName = rawTitle
      .replace(/^PSA\s*(?:GEM\s*MT\s*|MINT\s*)?\d+(?:\.\d+)?\s*[-–:|]\s*/i, "")  // "PSA 10 - " 제거
      .replace(/\s*[-–:|]\s*PSA(?:\s*Card\s*Facts)?\s*$/i, "")                    // " - PSA" / "| PSA Card Facts" 제거
      .replace(/^\s*\d{4}\s+/, "")                                                // 앞 년도 제거
      .replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#x27;/g,"'")
      .trim();
    if (!cardName || cardName.length < 3) cardName = rawTitle;
  }

  // 5) 이미지 — og:image 우선, 없으면 본문에서 큰 이미지 찾기
  let cardImage = ogImage;
  if (!cardImage) {
    const imgMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+(?:psacard|cloudfront|ssl-images)[^"']+\.(?:jpg|jpeg|png|webp))["']/gi)];
    if (imgMatches.length) cardImage = imgMatches[0][1];
  }

  // 인증번호
  const certMatch = sourceUrl.match(/\/cert\/(\d+)/);
  const certNumber = certMatch ? certMatch[1] : null;

  // ok 조건 완화: 인증번호가 URL에 있으면 항상 ok=true (최소한 PSA 페이지 링크는 살아있음)
  return {
    ok: !!(certNumber || ogTitle || cardName || grade),
    rawTitle: rawTitle || null,
    cardName,
    grade,
    year,
    cardNumber,
    certNumber,
    image: cardImage,
    description: ogDesc,
    url: sourceUrl,
  };
}

/* ─────────── Hare2Buy 파서 ─────────── */
function parseHare2buy(html, sourceUrl) {
  const ogTitle = meta(html, "og:title");
  const ogImage = meta(html, "og:image");
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const name = ogTitle || titleTag;

  // 매입가 추출 — 다중 패턴 (한/일/영어)
  let buybackPrice = null;
  const patterns = [
    /買取価格[\s\S]{0,150}?[¥￥]\s?([\d,]+)/i,                    // 買取価格 ... ¥금액
    /買取金額[\s\S]{0,150}?[¥￥]\s?([\d,]+)/i,
    /매입\s*(?:가격|단가)?[\s\S]{0,150}?[¥￥]\s?([\d,]+)/i,
    /buyback[^<]{0,80}?[¥￥]\s?([\d,]+)/i,
    /class="[^"]*(?:buy|price)[^"]*"[^>]*>\s*[¥￥]?\s?([\d,]+)/i,
    /<strong[^>]*>[¥￥]\s?([\d,]+)/i,
    /data-(?:buy|price)[^=]*=["']\s*([\d,]+)/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const n = num(m[1]);
      if (n != null && n >= 50 && n <= 100000000) { buybackPrice = n; break; }
    }
  }

  // 폴백: 페이지에서 가장 자주 등장하는 ¥금액
  if (!buybackPrice) {
    const counts = {};
    const re = /[¥￥]\s?([\d,]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const n = num(m[1]);
      if (n != null && n >= 100 && n <= 10000000) counts[n] = (counts[n] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
    if (sorted.length) buybackPrice = Number(sorted[0][0]);
  }

  // 재고/품절
  let status = null;
  if (/売切|完売|在庫切れ|品切れ|sold\s*out/i.test(html)) status = "sold_out";
  else if (/在庫あり|販売中|in\s*stock/i.test(html)) status = "in_stock";

  return {
    ok: !!(name || buybackPrice || ogImage),
    name: name ? name.replace(/&amp;/g,"&").replace(/&quot;/g,'"') : null,
    image: ogImage,
    buybackPrice,
    status,
    url: sourceUrl,
  };
}

/* ─────────── Cloudflare Pages Functions 핸들러 ─────────── */
export async function onRequest(context) {
  const { request, env } = context;
  SCRAPINGBEE_KEY = env?.SCRAPINGBEE_KEY || null;
  const url = new URL(request.url);
  const qs = Object.fromEntries(url.searchParams.entries());
  const key = qs.key;

  // 모드 0: 임의 SNKRDUNK URL 조회 (포트폴리오 추가용)
  if (qs.snkrdunkUrl) {
    if (!qs.snkrdunkUrl.startsWith("https://snkrdunk.com/")) {
      return json(400, { ok: false, error: "snkrdunkUrl must start with https://snkrdunk.com/" });
    }
    try {
      const html = await getHtmlSmart(qs.snkrdunkUrl, { country_code: "jp" });
      const data = parseSnkrdunk(html, qs.snkrdunkUrl);
      return json(200, {
        ok: true,
        type: "snkrdunkUrl",
        url: qs.snkrdunkUrl,
        data,
        fetchedAt: new Date().toISOString(),
      });
    } catch (e) {
      return json(500, { ok: false, error: String(e && e.message || e), url: qs.snkrdunkUrl });
    }
  }

  // 모드 1: 전체 목록 — 카드 키/닉네임만
  if (!key || key === "all") {
    return json(200, {
      ok: true,
      type: "list",
      cards: Object.entries(TRACKED_CARDS).map(([k, v]) => ({
        key: k,
        nickname: v.nickname,
        hasSnkrdunk: !!v.snkrdunk,
        hasPsa: !!v.psa,
        hasHare2buy: !!v.hare2buy,
      })),
    });
  }

  // 모드 2: 특정 카드 종합
  const card = TRACKED_CARDS[key];
  if (!card) return json(404, { ok: false, error: `unknown key: ${key}` });

  // SNKRDUNK는 JSON API로 가격 데이터 + HTML로 이미지/이름 동시 fetch
  const snkrCardId = card.snkrdunk ? extractSnkrdunkId(card.snkrdunk) : null;
  const tasks = [
    snkrCardId    ? safeJsonFetch(snkrCardId)                                                : Promise.resolve(null),
    card.snkrdunk ? safeParse(card.snkrdunk, parseSnkrdunk, { country_code: "jp" })          : Promise.resolve(null),
    card.psa      ? safeParse(card.psa,      parsePsa,      { country_code: "us", render_js: true }) : Promise.resolve(null),
    card.hare2buy ? safeParse(card.hare2buy, parseHare2buy, { country_code: "jp" })          : Promise.resolve(null),
  ];

  const [snkrJson, snkrHtml, psaResult, hare2buyResult] = await Promise.all(tasks);

  // SNKRDUNK 결합: JSON API 데이터(가격/매물수) + HTML 데이터(이미지/이름)
  let snkrdunkResult = null;
  if (snkrJson?.ok || snkrHtml?.ok) {
    snkrdunkResult = {
      ok: true,
      url: card.snkrdunk,
      data: {
        // 이미지/이름은 HTML에서
        name: snkrHtml?.data?.name || null,
        nameJa: snkrHtml?.data?.nameJa || null,
        image: snkrHtml?.data?.image || null,
        productId: snkrCardId,
        // 가격/매물수는 JSON API에서 (정확)
        ...(snkrJson?.data ? {
          isBox: snkrJson.data.isBox,
          fxRate: snkrJson.data.fxRate,
          byGrade: snkrJson.data.byGrade,
          primaryGrade: snkrJson.data.primaryGrade,
          lowestAsk: snkrJson.data.lowestAskJpy,    // JPY 기준으로 표시
          lastPrice: snkrJson.data.lastPriceJpy,    // JPY 기준으로 표시
          lowestAskUsd: snkrJson.data.lowestAsk,
          lastPriceUsd: snkrJson.data.lastPrice,
          askCount: snkrJson.data.askCount,
          totalActive: snkrJson.data.totalActive,
          totalSales: snkrJson.data.totalSoldRecent,
          // 최근 거래 (모든 등급 합쳐서 시간순)
          recentTrades: Object.entries(snkrJson.data.byGrade || {}).flatMap(([cond, g]) =>
            (g.recentSolds || []).map(s => ({
              ts: s.ts ? new Date(s.ts * 1000).toISOString() : null,
              price: s.jpy,
              priceUsd: s.usd,
              grade: cond,
              uid: s.uid,
            }))
          ).sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0)).slice(0, 10),
        } : {
          // JSON API 실패 시 HTML 데이터로 폴백
          lastPrice: snkrHtml?.data?.lastPrice || null,
          lowestAsk: snkrHtml?.data?.lowestAsk || null,
          askCount: null,
          totalSales: null,
        }),
      },
    };
  }

  // 이미지 폴백 우선순위: SNKRDUNK → PSA → Hare2Buy
  const heroImage =
    snkrdunkResult?.data?.image ||
    psaResult?.data?.image ||
    hare2buyResult?.data?.image ||
    null;

  // 카드 이름: PSA의 cardName 우선 → SNKRDUNK name → 닉네임
  const officialName =
    psaResult?.data?.cardName ||
    snkrdunkResult?.data?.name ||
    card.nickname;

  return json(200, {
    ok: true,
    type: "card",
    key,
    nickname: card.nickname,
    officialName,
    heroImage,
    snkrdunk: snkrdunkResult,
    psa:      psaResult,
    hare2buy: hare2buyResult,
    fetchedAt: new Date().toISOString(),
  });
}

/* SNKRDUNK JSON API safe wrapper */
async function safeJsonFetch(cardId) {
  try {
    const data = await fetchSnkrdunkFull(cardId);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function safeParse(url, parser, opts) {
  try {
    const html = await getHtml(url, opts);
    const data = parser(html, url);
    return { ok: true, data, url };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), url };
  }
}

function json(status, body) {
  // 24시간 CDN 캐시 (성공) / 1분 (실패)
  const cacheCtrl = status === 200 && body.ok
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
