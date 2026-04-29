// netlify/functions/beezie-prices.js
// 서버에서 beezie.com 4개 클로머신 페이지를 가져와 Claw Price / Average Value 추출
//
// 호출 경로:
//   /.netlify/functions/beezie-prices         (실제 값만)
//   /.netlify/functions/beezie-prices?debug=1 (HTML 샘플 포함 - 파싱 실패 원인 파악용)

const MACHINES = [
  { tier: "Platinum TCG", url: "https://beezie.com/claw/Platinum-TCG-87" },
  { tier: "Gold TCG",     url: "https://beezie.com/claw/Gold-TCG-86"     },
  { tier: "Silver TCG",   url: "https://beezie.com/claw/Silver-TCG-85"   },
  { tier: "Wildcard",     url: "https://beezie.com/claw/Wildcard-84"     },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PRICE_KEYS = [
  "clawPrice", "claw_price", "pullPrice", "pull_price",
  "price", "unitPrice", "cost", "priceUsd", "priceUSD",
  "entryPrice", "entry_price", "pricePerPull", "pullCost",
];

const AVG_KEYS = [
  "averageValue", "avgValue", "average_value", "average", "avg",
  "expectedValue", "expected_value", "ev", "evValue",
  "totalValue", "total_value", "fmv", "fairMarketValue",
  "estimatedValue", "estimated_value", "estValue",
  "meanValue", "mean_value", "expectedReturn",
  "payout", "payoutValue", "payout_value",
  "estimatedWorth", "worth", "value",
  "averagePayout", "avgPayout", "average_payout",
];

/* ─────────── 숫자 파싱 헬퍼 ─────────── */
function toNum(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = parseFloat(v.replace(/[$,\s]/g, ""));
  return isFinite(n) ? n : null;
}

function validNum(n, min = 0.01, max = 100000) {
  return n != null && !isNaN(n) && n > min && n < max;
}

/* ─────────── 딥 서치: JSON 트리에서 특정 키 찾기 ─────────── */
function findDeep(obj, keys, depth = 0, budget = { n: 50000 }) {
  if (obj == null || depth > 18 || budget.n <= 0) return null;
  budget.n--;
  if (typeof obj !== "object") return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      const n = toNum(obj[k]);
      if (validNum(n)) return n;
    }
  }
  const children = Array.isArray(obj) ? obj : Object.values(obj);
  for (const v of children) {
    const r = findDeep(v, keys, depth + 1, budget);
    if (r != null) return r;
  }
  return null;
}

/* 모든 (key,value) 페어 평면화 */
function flattenPairs(obj, out = [], depth = 0, budget = { n: 50000 }) {
  if (obj == null || depth > 18 || budget.n <= 0) return out;
  budget.n--;
  if (typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const v of obj) flattenPairs(v, out, depth + 1, budget);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" || typeof v === "string") {
      out.push([k, v]);
    } else if (v && typeof v === "object") {
      flattenPairs(v, out, depth + 1, budget);
    }
  }
  return out;
}

/* ─────────── HTML → {price, avg} 추출 ─────────── */
function parseHtml(html) {
  if (!html) return { price: null, avg: null, method: "empty" };
  let price = null, avg = null;
  const methods = [];

  // 1) __NEXT_DATA__ (Next.js prerender payload)
  const nm = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  let nextData = null;
  if (nm) {
    try {
      nextData = JSON.parse(nm[1]);
      const p = findDeep(nextData, PRICE_KEYS);
      const a = findDeep(nextData, AVG_KEYS);
      if (validNum(p)) { price = p; methods.push("price:__NEXT_DATA__"); }
      if (validNum(a)) { avg = a; methods.push("avg:__NEXT_DATA__"); }
    } catch (e) { /* noop */ }
  }

  // 1b) __NEXT_DATA__에서 키 이름이 달라도 문맥으로 추측
  if (nextData && (price == null || avg == null)) {
    const pairs = flattenPairs(nextData);
    const numberKeys = pairs
      .filter(([k, v]) => {
        const n = toNum(v);
        return validNum(n, 1, 10000) && /price|cost|value|payout|avg|average|worth|ev|amount|dollar|usd/i.test(k);
      })
      .map(([k, v]) => [k, toNum(v)]);

    if (avg == null) {
      const avgHit = numberKeys.find(([k]) => /average|avg|expected|payout|fmv|worth|fair|mean|ev(?!ent)/i.test(k));
      if (avgHit) { avg = avgHit[1]; methods.push("avg:nextdata-heur:" + avgHit[0]); }
    }
    if (price == null) {
      const priceHit = numberKeys.find(([k]) => /price|cost|entry|unit|pull/i.test(k));
      if (priceHit) { price = priceHit[1]; methods.push("price:nextdata-heur:" + priceHit[0]); }
    }
  }

  // 2) RSC / self-hosted stream JSON 조각
  if (price == null || avg == null) {
    const candidates = html.match(/\{[^{}]*(?:claw|average|avg|payout|value|price)[^{}]*\}/gi) || [];
    for (const frag of candidates) {
      try {
        const clean = frag.replace(/\\"/g, '"').replace(/\\n/g, "");
        const obj = JSON.parse(clean);
        if (price == null) {
          const p = findDeep(obj, PRICE_KEYS);
          if (validNum(p)) { price = p; methods.push("price:rsc-frag"); }
        }
        if (avg == null) {
          const a = findDeep(obj, AVG_KEYS);
          if (validNum(a)) { avg = a; methods.push("avg:rsc-frag"); }
        }
      } catch (e) { /* skip */ }
    }
  }

  // 3) Regex: 공격적인 키 패턴 스캔
  if (avg == null) {
    const avgPatterns = [
      /"average[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"avg[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"expected[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"total[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"estimated[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"payout[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"fair[_ ]*market[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"average[_ ]*payout"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /\\"averageValue\\"\s*:\s*\\?"?\$?\s*([\d.,]+)/i,
      /\\"expectedValue\\"\s*:\s*\\?"?\$?\s*([\d.,]+)/i,
    ];
    for (const re of avgPatterns) {
      const m = html.match(re);
      if (m) {
        const n = toNum(m[1]);
        if (validNum(n)) { avg = n; methods.push("avg:regex"); break; }
      }
    }
  }

  if (price == null) {
    const pricePatterns = [
      /"claw[_ ]*price"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"pull[_ ]*price"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"unit[_ ]*price"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"entry[_ ]*price"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"price[_ ]*per[_ ]*pull"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /\\"clawPrice\\"\s*:\s*\\?"?\$?\s*([\d.,]+)/i,
      /\\"price\\"\s*:\s*\\?"?\$?\s*([\d.,]+)/i,
    ];
    for (const re of pricePatterns) {
      const m = html.match(re);
      if (m) {
        const n = toNum(m[1]);
        if (validNum(n)) { price = n; methods.push("price:regex"); break; }
      }
    }
  }

  // 4) HTML 텍스트 근접 매칭: "Average Value" 라벨 뒤 첫 $숫자
  if (avg == null) {
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const m = text.match(/Average\s*Value[^$0-9]*\$?\s*([\d,]+(?:\.\d+)?)/i)
           || text.match(/Expected\s*Value[^$0-9]*\$?\s*([\d,]+(?:\.\d+)?)/i)
           || text.match(/Total\s*Value[^$0-9]*\$?\s*([\d,]+(?:\.\d+)?)/i);
    if (m) {
      const n = toNum(m[1]);
      if (validNum(n)) { avg = n; methods.push("avg:text-label"); }
    }
  }

  if (price == null) {
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const m = text.match(/Claw\s*Price[^$0-9]*\$?\s*([\d,]+(?:\.\d+)?)/i)
           || text.match(/Pull\s*Price[^$0-9]*\$?\s*([\d,]+(?:\.\d+)?)/i);
    if (m) {
      const n = toNum(m[1]);
      if (validNum(n)) { price = n; methods.push("price:text-label"); }
    }
  }

  return { price, avg, method: methods.join("|") || "none" };
}

/* ─────────── 디버그용: HTML에서 특정 키워드 주변 스니펫 추출 ─────────── */
function extractSnippets(html, keyword, context = 120, max = 4) {
  if (!html) return [];
  const re = new RegExp(keyword, "gi");
  const snippets = [];
  let m;
  while ((m = re.exec(html)) !== null && snippets.length < max) {
    const start = Math.max(0, m.index - context);
    const end = Math.min(html.length, m.index + keyword.length + context);
    snippets.push(html.slice(start, end).replace(/\s+/g, " "));
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return snippets;
}

/* ─────────── 단일 머신 fetch ─────────── */
async function fetchOne(m, debug) {
  const t0 = Date.now();
  try {
    const res = await fetch(m.url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
        "Referer": "https://beezie.com/",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
    });
    const html = await res.text();
    const { price, avg, method } = parseHtml(html);
    const ev = (price && avg) ? (avg / price - 1) * 100 : null;

    const base = {
      tier: m.tier,
      url: m.url,
      price, avg, ev,
      httpStatus: res.status,
      ms: Date.now() - t0,
      ok: price != null && avg != null,
      method,
    };

    if (debug) {
      base.debug = {
        htmlLength: html.length,
        hasNextData: /__NEXT_DATA__/.test(html),
        avgSnippets:     extractSnippets(html, "average", 160, 3),
        avgValSnippets:  extractSnippets(html, "avgValue", 160, 3),
        expValSnippets:  extractSnippets(html, "expected", 160, 3),
        valueSnippets:   extractSnippets(html, '"value"', 160, 3),
        payoutSnippets:  extractSnippets(html, "payout", 160, 3),
        clawSnippets:    extractSnippets(html, "claw", 100, 3),
        dollarMatches:   (html.match(/\$\s*[\d,]+(?:\.\d+)?/g) || []).slice(0, 15),
      };
    }
    return base;
  } catch (e) {
    return {
      tier: m.tier,
      url: m.url,
      price: null, avg: null, ev: null,
      error: String(e && e.message || e),
      ms: Date.now() - t0,
      ok: false,
    };
  }
}

exports.handler = async (event) => {
  try {
    const params = (event && event.queryStringParameters) || {};
    const debug = params.debug === "1";

    const results = await Promise.all(MACHINES.map(m => fetchOne(m, debug)));
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": debug ? "no-store" : "public, max-age=60, s-maxage=60",
        "access-control-allow-origin": "*",
      },
      body: JSON.stringify({
        ok: true,
        fetchedAt: Date.now(),
        debug,
        results,
      }, null, debug ? 2 : 0),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: String(e && e.message || e) }),
    };
  }
};
