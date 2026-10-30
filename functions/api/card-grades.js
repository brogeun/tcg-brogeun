// functions/api/card-grades.js
// GET /api/card-grades?id=819813
// SNKRDUNK used-listings 실시간 조회 → PSA10 / PSA9 / A급(raw) 최저가
//
// 용도: cards-detail.json(인기 카드)·data/history(백필)에 없는
//       신상 카드의 등급별 시세 폴백 (프론트 renderGradesPanel 3순위)
// 캐시: 엣지 1시간 — 같은 카드 반복 조회 시 SNKRDUNK 요청 없음
// 스크래퍼(scrape_snkrdunk.py)의 fetch_grade_listings 로직과 동일 기준:
//   active(isOnlyOnSale) 매물만, SNKRDUNK 화면과 같은 실제 최저가 채택

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
  // 계산 기준이 바뀔 때 이전 1시간 캐시와 섞이지 않도록 버전을 포함한다.
  const cacheKey = new Request(`https://tcghub.kr/api/card-grades?id=${id}&v=4`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 가장 정확한 경로: 일본 상품 페이지가 렌더링에 사용하는 condition chip의
  // usedMinPrice. SNKRDUNK 화면과 동일한 JPY 값이며 별도 환율 역산이 필요 없다.
  try {
    const page = await fetch(`https://snkrdunk.com/apparels/${id}`, {
      signal: AbortSignal.timeout(3000),
      headers: {
        ...API_HEADERS,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja-JP,ja;q=0.9',
      },
    });
    if (page.ok) {
      const html = await page.text();
      const conditionToGrade = { 18: 'raw', 22: 'psa10', 23: 'psa9' };
      const exactGrades = {};
      const noListingGrades = new Set();
      let conflictingAvailability = false;
      const objects = html.match(/\{[^{}]{0,1200}"conditionId":(?:18|22|23)[^{}]{0,1200}\}/g) || [];
      for (const object of objects) {
        const condition = object.match(/"conditionId":(18|22|23)/);
        const minPrice = object.match(/"usedMinPrice":(\d+)/);
        if (!condition) continue;
        const grade = conditionToGrade[Number(condition[1])];
        const amount = minPrice ? Number(minPrice[1]) : 0;
        const noListing = /"hasListing"\s*:\s*false/.test(object);
        if (noListing) {
          if (amount > 0 || exactGrades[grade]) { conflictingAvailability = true; break; }
          noListingGrades.add(grade);
          continue;
        }
        if (amount > 0 && noListingGrades.has(grade)) { conflictingAvailability = true; break; }
        if (!grade || !amount) continue;
        exactGrades[grade] = {
          lowest_ask: amount,
          currency: 'JPY',
          live: true,
          source: 'snkrdunk usedMinPrice',
        };
      }
      if (!conflictingAvailability && (Object.keys(exactGrades).length || noListingGrades.size)) {
        const exactResponse = json(
          { ok: true, id, grades: exactGrades, noListingGrades: [...noListingGrades], fetchedAt: new Date().toISOString() },
          200,
          { 'Cache-Control': 'public, max-age=3600' }
        );
        try {
          await cache.put(cacheKey, exactResponse.clone());
        } catch {
          /* 캐시 실패 무시 */
        }
        return exactResponse;
      }
    }
  } catch {
    // 페이지 구조/일시 장애 시 아래 used-listings API로 폴백한다.
  }

  // Query each condition independently. PSA10-only queries cannot establish raw availability.
  const conditionGrades = { 18: 'raw', 22: 'psa10', 23: 'psa9' };
  const results = await Promise.all(Object.entries(conditionGrades).map(async ([condition, grade]) => {
    const pairs = [], seen = new Set(), deadline = Date.now() + 6000;
    let complete = false, successful = false, invalidPrice = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const response = await fetch(
          'https://snkrdunk.com/en/v1/products/SW---' + id + '/used-listings' +
          '?conditionId=' + condition + '&page=' + page + '&perPage=50&isOnlyOnSale=true',
          { headers: API_HEADERS, signal: AbortSignal.timeout(remaining) }
        );
        if (!response.ok) break;
        const data = await response.json();
        const batch = data.usedListings || data.usedTradingCards;
        if (!Array.isArray(batch)) break;
        successful = true;
        for (const item of batch) {
          if (item.isSold) continue;
          if (gradeOf(item.condition) !== grade) { invalidPrice = true; continue; }
          const uid = item.listingUID || item.id;
          if (uid && seen.has(uid)) continue;
          if (uid) seen.add(uid);
          const amount = Number(item.priceAmount || 0);
          const declared = String(item.currency || '').toUpperCase();
          const [value, parsedCurrency] = amount > 0 && ['JPY','USD','KRW'].includes(declared)
            ? [amount, declared] : parsePrice(item.price);
          const currency = parsedCurrency || (amount > 0 ? declared : '') || 'USD';
          if (value > 0 && ['JPY','USD','KRW'].includes(currency)) pairs.push([value, currency]);
          else invalidPrice = true;
        }
        if (batch.length < 50) { complete = true; break; }
      } catch { break; }
    }
    if (pairs.length) {
      const counts = new Map();
      for (const [, currency] of pairs) counts.set(currency, (counts.get(currency) || 0) + 1);
      const currency = [...counts].sort((a,b) => b[1] - a[1])[0][0];
      const prices = pairs.filter(pair => pair[1] === currency).map(pair => pair[0]);
      return { grade, quote: { lowest_ask: Math.min(...prices), currency, active_count: prices.length,
        after_filter: prices.length, live: true, source: 'snkrdunk used-listings' }, complete };
    }
    return { grade, absent: successful && complete && !invalidPrice, complete };
  }));
  const grades = {}, noListingGrades = [], unavailableGrades = [];
  for (const result of results) {
    if (result.quote) grades[result.grade] = result.quote;
    else if (result.absent) noListingGrades.push(result.grade);
    else unavailableGrades.push(result.grade);
  }
  if (!Object.keys(grades).length && !noListingGrades.length) {
    return json({ ok: false, id, error: 'SNKRDUNK temporarily unavailable', unavailableGrades,
      fetchedAt: new Date().toISOString() }, 503, { 'Cache-Control': 'no-store' });
  }
  const partial = results.some(result => !result.complete);
  const res = json({ ok: true, id, grades, noListingGrades, unavailableGrades, partial,
    fetchedAt: new Date().toISOString() }, 200,
    { 'Cache-Control': 'public, max-age=' + (partial ? 60 : 3600) });
  try { await cache.put(cacheKey, res.clone()); } catch { /* Cache failure does not invalidate evidence. */ }
  return res;
}
