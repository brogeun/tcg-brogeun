/**
 * Cloudflare Pages Function — Beezie 4개 클로머신 가격 fetch
 * 호출: /api/beezie-prices  (또는 ?debug=1)
 *
 * Netlify Function 에서 이주 — Cloudflare Pages 환경 호환
 */

const MACHINES = [
  { tier: "Platinum TCG", url: "https://beezie.com/claw/Platinum-TCG-92" },
  { tier: "Gold TCG",     url: "https://beezie.com/claw/Gold-TCG-91"     },
  { tier: "Silver TCG",   url: "https://beezie.com/claw/Silver-TCG-90"   },
  { tier: "Wildcard",     url: "https://beezie.com/claw/Wildcard-89"     },
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
function flattenPairs(obj, out = [], depth = 0, budget = { n: 50000 }) {
  if (obj == null || depth > 18 || budget.n <= 0) return out;
  budget.n--;
  if (typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (const v of obj) flattenPairs(v, out, depth + 1, budget);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" || typeof v === "string") out.push([k, v]);
    else if (v && typeof v === "object") flattenPairs(v, out, depth + 1, budget);
  }
  return out;
}

function parseHtml(html) {
  if (!html) return { price: null, avg: null, method: "empty" };
  let price = null, avg = null;
  const methods = [];
  // 1) __NEXT_DATA__
  const nm = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  let nextData = null;
  if (nm) {
    try {
      nextData = JSON.parse(nm[1]);
      const p = findDeep(nextData, PRICE_KEYS);
      const a = findDeep(nextData, AVG_KEYS);
      if (validNum(p)) { price = p; methods.push("price:__NEXT_DATA__"); }
      if (validNum(a)) { avg = a; methods.push("avg:__NEXT_DATA__"); }
    } catch (e) {}
  }
  if (nextData && (price == null || avg == null)) {
    const pairs = flattenPairs(nextData);
    const numberKeys = pairs.filter(([k, v]) => {
      const n = toNum(v);
      return validNum(n, 1, 10000) && /price|cost|value|payout|avg|average|worth|ev|amount|dollar|usd/i.test(k);
    }).map(([k, v]) => [k, toNum(v)]);
    if (avg == null) {
      const avgHit = numberKeys.find(([k]) => /average|avg|expected|payout|fmv|worth|fair|mean|ev(?!ent)/i.test(k));
      if (avgHit) { avg = avgHit[1]; methods.push("avg:nextdata-heur:" + avgHit[0]); }
    }
    if (price == null) {
      const priceHit = numberKeys.find(([k]) => /price|cost|entry|unit|pull/i.test(k));
      if (priceHit) { price = priceHit[1]; methods.push("price:nextdata-heur:" + priceHit[0]); }
    }
  }
  // 2) RSC fragments
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
      } catch (e) {}
    }
  }
  // 3) Regex 패턴 스캔
  if (avg == null) {
    const avgPatterns = [
      /"average[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"avg[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"expected[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"payout[_ ]*value"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /\\"averageValue\\"\s*:\s*\\?"?\$?\s*([\d.,]+)/i,
    ];
    for (const re of avgPatterns) {
      const m = html.match(re);
      if (m) { const n = toNum(m[1]); if (validNum(n)) { avg = n; methods.push("avg:regex"); break; } }
    }
  }
  if (price == null) {
    const pricePatterns = [
      /\$\s*([\d,]+(?:\.\d+)?)\s*\+\s*\d+\s*points/i,  // 새 Beezie 페이지: "$NNN +NNN points"
      /"claw[_ ]*price"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"pull[_ ]*price"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /"unit[_ ]*price"\s*:\s*"?\$?\s*([\d.,]+)/i,
      /\\"clawPrice\\"\s*:\s*\\?"?\$?\s*([\d.,]+)/i,
    ];
    for (const re of pricePatterns) {
      const m = html.match(re);
      if (m) { const n = toNum(m[1]); if (validNum(n)) { price = n; methods.push("price:regex"); break; } }
    }
  }
  // 4) HTML 텍스트 라벨
  if (avg == null) {
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const m = text.match(/Average\s*Value[^$0-9]*\$?\s*([\d,]+(?:\.\d+)?)/i);
    if (m) { const n = toNum(m[1]); if (validNum(n)) { avg = n; methods.push("avg:text-label"); } }
  }
  if (price == null) {
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const m = text.match(/Claw\s*Price[^$0-9]*\$?\s*([\d,]+(?:\.\d+)?)/i);
    if (m) { const n = toNum(m[1]); if (validNum(n)) { price = n; methods.push("price:text-label"); } }
  }
  return { price, avg, method: methods.join("|") || "none" };
}

async function fetchOne(m, scrapingbeeKey) {
  const t0 = Date.now();
  try {
    // ScrapingBee 통해 JavaScript 렌더링 후 HTML 받기 (Beezie 는 Next.js 라 JS 필수)
    const targetUrl = scrapingbeeKey
      ? `https://app.scrapingbee.com/api/v1/?api_key=${scrapingbeeKey}` +
        `&url=${encodeURIComponent(m.url)}&render_js=true&wait=2000&country_code=us`
      : m.url; // fallback (작동 안 함)

    const res = await fetch(targetUrl, {
      headers: scrapingbeeKey ? {} : {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://beezie.com/",
      },
      redirect: "follow",
      cf: { cacheTtl: 60 },
    });
    const html = await res.text();
    const { price, avg, method } = parseHtml(html);
    const ev = (price && avg) ? (avg / price - 1) * 100 : null;
    return {
      tier: m.tier, url: m.url, price, avg, ev,
      httpStatus: res.status, ms: Date.now() - t0,
      ok: price != null && avg != null,
      method, via: scrapingbeeKey ? "scrapingbee" : "direct",
    };
  } catch (e) {
    return {
      tier: m.tier, url: m.url, price: null, avg: null, ev: null,
      error: String(e?.message || e), ms: Date.now() - t0, ok: false,
    };
  }
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const debug = url.searchParams.get("debug") === "1";
    const sbKey = env.SCRAPINGBEE_KEY;
    if (!sbKey) {
      return new Response(JSON.stringify({
        ok: false,
        error: "SCRAPINGBEE_KEY 환경변수 없음 (Cloudflare 대시보드에서 설정)",
      }), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    const results = await Promise.all(MACHINES.map(m => fetchOne(m, sbKey)));
    return new Response(JSON.stringify({
      ok: true,
      fetchedAt: Date.now(),
      debug,
      results,
    }), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": debug ? "no-store" : "public, max-age=60, s-maxage=60",
        "access-control-allow-origin": "*",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
