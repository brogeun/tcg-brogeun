// functions/api/card-grades.js
// GET /api/card-grades?id=819813
// SNKRDUNK used-listings 실시간 조회 → PSA10 / PSA9 / A급(raw) 최저가
//
// 용도: cards-detail.json(인기 카드)·data/history(백필)에 없는
//       신상 카드의 등급별 시세 폴백 (프론트 renderGradesPanel 3순위)
// 캐시: 엣지 1시간 — 같은 카드 반복 조회 시 SNKRDUNK 요청 없음
// 스크래퍼(scrape_snkrdunk.py)의 fetch_grade_listings 로직과 동일 기준:
//   active(isOnlyOnSale) 매물만, median 50% 미만 outlier 제거, 최저가 채택

const API_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
  'Referer': 'https://snkrdunk.com/',
};

const MAX_PAGES = 4; // 50건 × 4 = 200 listing — 라이브 응답속도 우선

function parsePrice(raw) {
  if (raw == null) return [null, null];
  if (typeof raw === 'object') {
    const amt = Number(raw.amount || 0);
    const cur = (raw.currency || '').toUpperCase() || null;
    return amt > 0 ? [amt, cur] : [null, null];
  }
  if (typeof raw === 'number') return raw > 0 ? [raw, null] : [null, null];
  const s = String(raw);
  let m = s.match(/¥\s*([\d,]+)/);
  if (m) return [parseFloat(m[1].replace(/,/g, '')), 'JPY'];
  m = s.match(/\$\s*([\d,.]+)/);
  if (m) return [parseFloat(m[1].replace(/,/g, '')), 'USD'];
  m = s.match(/([\d,.]+)/);
  if (m) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    return v > 0 ? [v, null] : [null, null];
  }
  return [null, null];
}

function gradeOf(cond) {
  const c = (cond || '').trim().toUpperCase().replace(/\s+/g, '');
  if (c.startsWith('PSA10') && !c.startsWith('PSA100')) return 'psa10';
  if (c.startsWith('PSA9') && !c.startsWith('PSA90') && !c.startsWith('PSA99')) return 'psa9';
  if (c === 'A') return 'raw';
  return null;
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').replace(/[^0-9]/g, '');
  if (!id) return json({ ok: false, error: 'id required' }, 400);

  // 1시간 엣지 캐시
  const cache = caches.default;
  const cacheKey = new Request(`https://tcghub.kr/api/card-grades?id=${id}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // active listings 수집 (중복 제거)
  const seen = new Set();
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let data;
    try {
      const r = await fetch(
        `https://snkrdunk.com/en/v1/products/SW---${id}/used-listings` +
        `?conditionId=22&page=${page}&perPage=50&isOnlyOnSale=true`,
        { headers: API_HEADERS }
      );
      if (!r.ok) break;
      data = await r.json();
    } catch {
      break;
    }
    const batch = data.usedListings || data.usedTradingCards || [];
    if (!batch.length) break;
    let added = 0;
    for (const it of batch) {
      const uid = it.listingUID || it.id;
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        items.push(it);
        added++;
      }
    }
    if (!added || batch.length < 50) break;
  }

  // 등급별 가격 집계 (통화는 다수파 채택, en API 기본 USD)
  const byGrade = { psa10: [], psa9: [], raw: [] };
  for (const it of items) {
    if (it.isSold) continue;
    const g = gradeOf(it.condition);
    if (!g) continue;
    const [amt, cur] = parsePrice(it.price);
    if (amt && amt > 0) byGrade[g].push([amt, cur]);
  }

  const grades = {};
  for (const [g, pairs] of Object.entries(byGrade)) {
    if (!pairs.length) continue;
    const jpy = pairs.filter(([, c]) => c === 'JPY').length;
    const usd = pairs.filter(([, c]) => c === 'USD').length;
    const currency = jpy > usd ? 'JPY' : 'USD';
    const prices = pairs.map(([p]) => p);
    const sorted = [...prices].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    let cleaned = prices.filter((p) => p >= med * 0.5);
    if (!cleaned.length) cleaned = prices;
    cleaned.sort((a, b) => a - b);
    grades[g] = {
      lowest_ask: cleaned[0],
      currency,
      active_count: prices.length,
      after_filter: cleaned.length,
      live: true,
    };
  }

  const res = json(
    { ok: true, id, grades, fetchedAt: new Date().toISOString() },
    200,
    { 'Cache-Control': 'public, max-age=3600' }
  );
  try {
    await cache.put(cacheKey, res.clone());
  } catch {
    /* 캐시 실패 무시 */
  }
  return res;
}
