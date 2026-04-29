// netlify/functions/snkrdunk.js
// SNKRDUNK(스니덩) 카드 시세 fetcher
//
// 호출 경로:
//   /.netlify/functions/snkrdunk?brand=pokemon          (포켓몬 카드 카테고리 상품 목록)
//   /.netlify/functions/snkrdunk?brand=onepiece         (원피스 카드 카테고리 상품 목록)
//   /.netlify/functions/snkrdunk?q=피카츄                (검색)
//   /.netlify/functions/snkrdunk?id=151755              (상품 ID)
//   /.netlify/functions/snkrdunk?url=https://snkrdunk.com/...
//   ?debug=1  → __NEXT_DATA__ 구조 미리보기 (파싱 실패 진단용)

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

// 브랜드명 (검색 키워드용 일본어)
const BRAND_KEYWORD = {
  pokemon: "ポケモンカード",
  onepiece: "ワンピースカード",
};

// 등급 필터 → 검색 키워드 매핑
const GRADE_KEYWORD = {
  all: "",
  unopened: " 未開封",     // 미개봉/박스
  psa10: " PSA10",         // PSA 10
  psa9: " PSA9",           // PSA 9
  a: " A品",                // A급
};

/* ─────────── 한국어 → 일본어 키워드 사전 (TCG 특화) ───────────
   SNKRDUNK는 영문 동의어는 알지만 한국어는 인식 못하므로 직접 변환.
   더 추가할 단어가 있으면 여기에 항목만 늘리면 됨. */
const KO_TO_JA = {
  // 공통/필터
  "미개봉": "未開封",
  "박스": "BOX",
  "부스터": "ブースター",
  "부스터박스": "ブースターボックス",
  "프로모": "プロモ",
  "스페셜": "スペシャル",
  "한정": "限定",
  "확장팩": "拡張パック",
  "팩": "パック",
  "싱글": "シングル",
  "한국어판": "韓国語版",
  "일본어판": "日本語版",

  // 포켓몬 캐릭터
  "피카츄": "ピカチュウ",
  "리자몽": "リザードン",
  "꼬부기": "ゼニガメ",
  "거북왕": "カメックス",
  "이상해씨": "フシギダネ",
  "이상해꽃": "フシギバナ",
  "파이리": "ヒトカゲ",
  "리자드": "リザード",
  "이브이": "イーブイ",
  "샤미드": "シャワーズ",
  "쥬피썬더": "サンダース",
  "부스터": "ブースター",
  "에브이": "イーブイ",
  "뮤": "ミュウ",
  "뮤츠": "ミュウツー",
  "라프라스": "ラプラス",
  "갸라도스": "ギャラドス",
  "잠만보": "カビゴン",
  "푸린": "プリン",
  "야돈": "ヤドン",
  "야도란": "ヤドラン",
  "성원숭": "オコリザル",
  "팬텀": "ゲンガー",
  "프리져": "フリーザー",
  "썬더": "サンダー",
  "파이어": "ファイヤー",
  "루기아": "ルギア",
  "칠색조": "ホウオウ",
  "셀레비": "セレビィ",
  "라티아스": "ラティアス",
  "라티오스": "ラティオス",
  "레쿠쟈": "レックウザ",
  "디아루가": "ディアルガ",
  "펄기아": "パルキア",
  "기라티나": "ギラティナ",
  "아르세우스": "アルセウス",
  "비크티니": "ビクティニ",
  "제크로무": "ゼクロム",
  "레시라무": "レシラム",
  "큐레무": "キュレム",
  "제르네아스": "ゼルネアス",
  "이벨타르": "イベルタル",
  "솔가레오": "ソルガレオ",
  "루나아라": "ルナアーラ",
  "자시안": "ザシアン",
  "자마젠타": "ザマゼンタ",
  "뮤츠ex": "ミュウツーex",

  // 포켓몬 세트/시리즈
  "테라크리스탈": "テラスタル",
  "테라스타": "テラスタル",
  "메가": "メガ",
  "메가에볼루션": "メガシンカ",
  "메가진화": "メガシンカ",
  "이브이히어로즈": "イーブイヒーローズ",
  "이브이즈": "イーブイズ",
  "스칼렛": "スカーレット",
  "바이올렛": "バイオレット",
  "검과방패": "剣と盾",
  "소드실드": "ソード&シールド",
  "썬앤문": "サン&ムーン",
  "신비의보물": "神秘の宝石",
  "신비의보석": "神秘の宝石",
  "흑염의지배자": "黒煙の支配者",
  "151": "151",
  "스노우해저드": "スノーハザード",
  "클레이버스트": "クレイバースト",
  "트리플렛비트": "トリプレットビート",
  "고대로어": "古代の咆哮",
  "미래의일격": "未来の一閃",
  "와일드포스": "ワイルドフォース",
  "사이버저지": "サイバージャッジ",
  "샤이니트레저": "シャイニートレジャー",
  "테라스탈페스타": "テラスタルフェスタ",
  "낙원드래고나": "楽園ドラゴーナ",

  // 원피스 캐릭터
  "루피": "ルフィ",
  "조로": "ゾロ",
  "쵸파": "チョッパー",
  "초파": "チョッパー",
  "나미": "ナミ",
  "우솝": "ウソップ",
  "상디": "サンジ",
  "로빈": "ロビン",
  "프랭키": "フランキー",
  "브룩": "ブルック",
  "징베": "ジンベエ",
  "에이스": "エース",
  "사보": "サボ",
  "샹크스": "シャンクス",
  "흰수염": "白ひげ",
  "뉴게이트": "ニューゲート",
  "카이도": "カイドウ",
  "빅맘": "ビッグ・マム",
  "쿠로히게": "黒ひげ",
  "검은수염": "黒ひげ",
  "야마토": "ヤマト",
  "킹": "キング",
  "퀸": "クイーン",
  "잭": "ジャック",
  "도플라밍고": "ドフラミンゴ",
  "크로커다일": "クロコダイル",
  "트라팔가로": "トラファルガー",
  "로": "ロー",
  "베가펑크": "ベガパンク",
  "이매진": "イム",
  "이무": "イム",
  "코비": "コビー",
  "갈프": "ガープ",
  "센고쿠": "センゴク",
  "아카이누": "赤犬",
  "아오키지": "青雉",
  "키자루": "黄猿",
  "후지토라": "藤虎",
  "보아한콕": "ボア・ハンコック",
  "한콕": "ハンコック",
  "보니": "ボニー",
  "리쥬": "リジュ",
  "야마토ex": "ヤマト",

  // 원피스 세트
  "비탄의기억": "悲嘆の記憶",
  "각성": "覚醒",
  "왕좌의비기": "王座の系譜",
};

// 한국어가 포함되어 있는지
function hasKorean(s) {
  return /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(s || "");
}

// 한국어 토큰을 일본어로 치환 (긴 단어부터 매칭)
function translateKoToJa(input) {
  if (!input || !hasKorean(input)) return input;
  let out = input;
  const keys = Object.keys(KO_TO_JA).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (out.includes(k)) out = out.split(k).join(KO_TO_JA[k]);
  }
  return out;
}

/* ─────────── 숫자 파싱 ─────────── */
function toNum(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace(/[¥￥円,\s]/g, "").replace(/JPY/i, ""));
  return isFinite(n) ? n : null;
}

function validPrice(n, min = 50, max = 100000000) {
  return n != null && !isNaN(n) && n >= min && n <= max;
}

/* ─────────── __NEXT_DATA__ 추출 ─────────── */
function extractNextData(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/* ─────────── OG 태그 ─────────── */
function extractMeta(html, prop) {
  const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
  const m = html.match(re);
  return m ? m[1] : null;
}

/* 박스 vs 싱글카드 분류 — 이름에 박스/팩 키워드 있으면 box */
function classifyProductType(name) {
  const s = String(name || "").toLowerCase();
  const boxKeywords = [
    /\bbox\b/i, /ボックス/, /拡張パック/, /booster/i, /バインダー/, /デッキ/, /スターター/i,
    /high\s*class\s*pack/i, /スペシャル.*セット/, /pack/i,
  ];
  for (const re of boxKeywords) {
    if (re.test(s)) return "box";
  }
  return "card";
}

/* ─────────── 상품 객체 정규화 ─────────── */
function normalizeProduct(item) {
  if (!item || typeof item !== "object") return null;
  const id = item.id ?? item.productId ?? item.product_id ?? null;
  const name = item.name ?? item.productName ?? item.title ?? item.product_name ?? null;
  const image = item.image ?? item.imageUrl ?? item.image_url ?? item.thumbnail ?? item.thumb ?? item.imagePath ?? null;
  const lastPrice = toNum(item.lastPrice ?? item.latestPrice ?? item.last_price ?? item.currentPrice ?? item.lastTradedPrice ?? item.latestTradedPrice);
  const lowestAsk = toNum(item.lowestAsk ?? item.lowest_ask ?? item.minAskPrice ?? item.askPrice);
  const highestBid = toNum(item.highestBid ?? item.highest_bid ?? item.maxBidPrice ?? item.bidPrice);

  if (id == null || !name) return null;
  const productType = classifyProductType(name);
  return {
    id: String(id),
    name: String(name),
    image: image ? String(image) : null,
    type: productType, // "box" or "card"
    lastPrice: validPrice(lastPrice) ? lastPrice : null,
    lowestAsk: validPrice(lowestAsk) ? lowestAsk : null,
    highestBid: validPrice(highestBid) ? highestBid : null,
    url: `${BASE}/apparels/${id}`, // 카드는 /apparels/ 패스 사용
  };
}

/* ─────────── 트리에서 모든 상품 객체 추출 ─────────── */
function harvestProducts(root, max = 60) {
  const out = [];
  const seen = new Set();
  function walk(obj, depth = 0) {
    if (out.length >= max || depth > 16 || obj == null) return;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (out.length >= max) return;
        const p = normalizeProduct(item);
        if (p && !seen.has(p.id)) {
          out.push(p); seen.add(p.id);
        }
        if (item && typeof item === "object") walk(item, depth + 1);
      }
    } else if (typeof obj === "object") {
      // 객체 자체가 product인지 검사
      const p = normalizeProduct(obj);
      if (p && !seen.has(p.id)) { out.push(p); seen.add(p.id); }
      for (const v of Object.values(obj)) walk(v, depth + 1);
    }
  }
  walk(root);
  return out;
}

/* ─────────── HTTP fetch (ScrapingBee 우선, 없으면 직접) ─────────── */
async function getHtml(url) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (apiKey) {
    return getHtmlViaScrapingBee(url, apiKey);
  }
  // 폴백: 직접 호출 (개발/테스트용 — SNKRDUNK이 차단할 가능성 높음)
  const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function getHtmlViaScrapingBee(targetUrl, apiKey) {
  // ScrapingBee 옵션:
  //  render_js=false → SNKRDUNK Next.js는 SSR이라 JS 렌더링 불필요(콜 비용 1 → 5콜 절약)
  //  premium_proxy=false → 일반 프록시로 충분, 막히면 true로 (콜 비용 ×10)
  //  country_code=jp → 일본 IP로 (SNKRDUNK 응답 안정적)
  const params = new URLSearchParams({
    api_key: apiKey,
    url: targetUrl,
    render_js: "false",
    country_code: "jp",
    block_resources: "true", // 이미지/css/font 로딩 안 함 (속도 ↑)
  });
  const beeUrl = `https://app.scrapingbee.com/api/v1/?${params}`;
  const res = await fetch(beeUrl, { redirect: "follow" });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`ScrapingBee HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }
  return await res.text();
}

/* ─────────── 가격 정규식 백업 ─────────── */
function findPriceInHtml(html) {
  const patterns = [/¥\s?([\d,]+)/g, /([\d,]+)\s?円/g, /JPY\s?([\d,]+)/gi];
  const counts = {};
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const n = toNum(m[1]);
      if (validPrice(n)) counts[n] = (counts[n] || 0) + 1;
    }
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.length ? Number(sorted[0][0]) : null;
}

/* ─────────── 상품 상세 파싱 ─────────── */
function parseProduct(html, sourceUrl) {
  const next = extractNextData(html);
  let result = null;
  if (next) {
    const all = harvestProducts(next, 60);
    if (sourceUrl) {
      const idMatch = sourceUrl.match(/\/products\/([^/?#]+)/);
      if (idMatch) {
        const want = idMatch[1];
        result = all.find(p => p.id === want) || null;
      }
    }
    if (!result && all.length) result = all[0];
  }
  if (!result) {
    const ogTitle = extractMeta(html, "og:title");
    const ogImage = extractMeta(html, "og:image");
    const fallbackPrice = findPriceInHtml(html);
    if (ogTitle || ogImage || fallbackPrice) {
      result = {
        id: null,
        name: ogTitle,
        image: ogImage,
        lastPrice: validPrice(fallbackPrice) ? fallbackPrice : null,
        lowestAsk: null,
        highestBid: null,
        url: sourceUrl,
      };
    }
  }
  if (result && sourceUrl) result.url = sourceUrl;
  return result;
}

/* ─────────── 디버그 ─────────── */
function htmlSample(html) {
  return {
    length: html.length,
    hasNextData: html.includes("__NEXT_DATA__"),
    head500: html.slice(0, 500),
    yenMatches: (html.match(/¥\s?[\d,]+/g) || []).slice(0, 8),
    yenCircleMatches: (html.match(/[\d,]+\s?円/g) || []).slice(0, 8),
    ogTitle: extractMeta(html, "og:title"),
    ogImage: extractMeta(html, "og:image"),
  };
}

function nextDataKeys(next) {
  // __NEXT_DATA__ 의 props.pageProps 구조 미리보기
  try {
    const pp = next?.props?.pageProps;
    if (!pp) return null;
    return {
      keys: Object.keys(pp).slice(0, 20),
      sample: JSON.stringify(pp, (k, v) => typeof v === "string" && v.length > 200 ? v.slice(0,200)+"…" : v).slice(0, 1500),
    };
  } catch { return null; }
}

/* ─────────── 핸들러 ─────────── */
exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1" || qs.debug === "true";

  try {
    /* 모드 1: 브랜드 카테고리 (포켓몬/원피스) + 박스/카드 필터 + 페이지네이션 */
    if (qs.brand && BRAND_CATEGORY[qs.brand]) {
      const productType = (qs.type || "all").toLowerCase(); // box / card / all
      const page = Math.max(1, parseInt(qs.page || "1", 10));
      const grade = (qs.grade || "all").toLowerCase();
      const gradeKey = GRADE_KEYWORD.hasOwnProperty(grade) ? grade : "all";

      let url, sourceType;
      if (gradeKey !== "all") {
        // 등급 필터: 검색 모드
        const keyword = (BRAND_KEYWORD[qs.brand] || "") + GRADE_KEYWORD[gradeKey];
        url = `${BASE}/search?keyword=${encodeURIComponent(keyword.trim())}&page=${page}`;
        sourceType = "search";
      } else {
        // 카테고리 페이지 (페이지네이션)
        url = `${BRAND_CATEGORY[qs.brand]}?page=${page}`;
        sourceType = "category";
      }

      const html = await getHtml(url);
      const next = extractNextData(html);
      let products = next ? harvestProducts(next, 200) : [];

      // 박스/카드 필터 적용
      if (productType === "box") {
        products = products.filter(p => p.type === "box");
      } else if (productType === "card") {
        products = products.filter(p => p.type === "card");
      }

      const body = {
        ok: true,
        type: sourceType,
        brand: qs.brand,
        productType,
        grade: gradeKey,
        page,
        source: url,
        count: products.length,
        products,
      };
      if (debug) {
        body.debug = htmlSample(html);
        body.debug.nextData = next ? nextDataKeys(next) : null;
      }
      return json(200, body);
    }

    /* 모드 2: URL 직접 지정 */
    if (qs.url) {
      if (!qs.url.startsWith(BASE)) return json(400, { ok: false, error: "url must start with " + BASE });
      const html = await getHtml(qs.url);
      const data = parseProduct(html, qs.url);
      const body = { ok: true, type: "product", product: data };
      if (debug) body.debug = htmlSample(html);
      return json(200, body);
    }

    /* 모드 3: 상품 ID */
    if (qs.id) {
      const url = `${BASE}/products/${encodeURIComponent(qs.id)}`;
      const html = await getHtml(url);
      const data = parseProduct(html, url);
      const body = { ok: true, type: "product", product: data };
      if (debug) body.debug = htmlSample(html);
      return json(200, body);
    }

    /* 모드 4: 검색 (한국어 자동 번역 지원) */
    if (qs.q) {
      const original = qs.q;
      const translated = translateKoToJa(original);
      const wasTranslated = translated !== original;

      // 시도할 키워드: 번역된 일본어 우선 → 안되면 원본
      const queries = wasTranslated ? [translated, original] : [original];
      const allProducts = [];
      const seen = new Set();
      let usedUrl = null;
      let lastHtml = null;

      for (const q of queries) {
        const tries = [
          `${BASE}/search?keyword=${encodeURIComponent(q)}`,
          `${BASE}/search?q=${encodeURIComponent(q)}`,
        ];
        for (const u of tries) {
          try {
            const html = await getHtml(u);
            lastHtml = html;
            if (!html.includes("__NEXT_DATA__")) continue;
            usedUrl = u;
            const next = extractNextData(html);
            const products = next ? harvestProducts(next, 30) : [];
            for (const p of products) {
              if (!seen.has(p.id)) { allProducts.push(p); seen.add(p.id); }
            }
            if (allProducts.length >= 12) break;
          } catch { /* 다음 후보 */ }
        }
        if (allProducts.length >= 12) break;
      }

      if (!lastHtml) return json(502, { ok: false, error: "all search URLs failed" });
      const body = {
        ok: true, type: "search",
        q: original,
        translated: wasTranslated ? translated : null,
        source: usedUrl,
        count: allProducts.length,
        products: allProducts,
      };
      if (debug) body.debug = htmlSample(lastHtml);
      return json(200, body);
    }

    return json(400, {
      ok: false,
      error: "missing query param. use ?brand=, ?q=, ?id=, or ?url=",
      examples: [
        "/.netlify/functions/snkrdunk?brand=pokemon",
        "/.netlify/functions/snkrdunk?brand=onepiece",
        "/.netlify/functions/snkrdunk?q=피카츄",
        "/.netlify/functions/snkrdunk?id=151755",
      ],
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e && e.message || e) });
  }
};

function json(status, body) {
  // 성공 응답은 6시간 CDN 캐시 + 24시간 stale-while-revalidate
  // 실패 응답은 1분만 캐시 (재시도 빠르게)
  const cacheCtrl = status === 200
    ? "public, max-age=86400, s-maxage=86400, stale-while-revalidate=172800"
    : "public, max-age=60";
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheCtrl,
      "netlify-cdn-cache-control": cacheCtrl,
      "access-control-allow-origin": "*",
    },
    body: JSON.stringify(body),
  };
}
