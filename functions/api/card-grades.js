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
  const cacheKey = new Request(`https://tcghub.kr/api/card-grades?id=${id}&v=2`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // 가장 정확한 경로: 일본 상품 페이지가 렌더링에 사용하는 condition chip의
  // usedMinPrice. SNKRDUNK 화면과 동일한 JPY 값이며 별도 환율 역산이 필요 없다.
  try {
    const page = await fetch(`https://snkrdunk.com/apparels/${id}`, {
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
      const objects = html.match(/\{[^{}]{0,1200}"conditionId":(?:18|22|23)[^{}]{0,1200}\}/g) || [];
      for (const object of objects) {
        const condition = object.match(/"conditionId":(18|22|23)/);
        const minPrice = object.match(/"usedMinPrice":(\d+)/);
        if (!condition || !minPrice) continue;
        const grade = conditionToGrade[Number(condition[1])];
        const amount = Number(minPrice[1]);
        if (!grade || !amount) continue;
        exactGrades[grade] = {
          lowest_ask: amount,
          currency: 'JPY',
          live: true,
          source: 'snkrdunk usedMinPrice',
        };
      }
      if (Object.keys(exactGrades).length) {
        const exactResponse = json(
          { ok: true, id, grades: exactGrades, fetchedAt: new Date().toISOString() },
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
    // 문자열 price 는 접속 지역에 따라 ¥/$/₩로 현지화된다. API가 함께 주는
    // priceAmount/currency 를 우선 사용해야 숫자와 통화가 어긋나지 않는다.
    const amount = Number(it.priceAmount || 0);
    const itemCurrency = (it.currency || '').toUpperCase() || null;
    const [amt, cur] = amount > 0 ? [amount, itemCurrency] : parsePrice(it.price);
    if (amt && amt > 0) byGrade[g].push([amt, cur]);
  }

  const grades = {};
  for (const [g, pairs] of Object.entries(byGrade)) {
    if (!pairs.length) continue;
    const jpy = pairs.filter(([, c]) => c === 'JPY').length;
    const usd = pairs.filter(([, c]) => c === 'USD').length;
    const krw = pairs.filter(([, c]) => c === 'KRW').length;
    const currency = krw > jpy && krw > usd ? 'KRW' : (jpy > usd ? 'JPY' : 'USD');
    let prices = pairs.filter(([, c]) => c === currency || !c).map(([p]) => p);
    if (!prices.length) prices = pairs.map(([p]) => p);
    prices.sort((a, b) => a - b);
    grades[g] = {
      // 현재 출품 최저가는 낮다는 이유로 이상치 제거하면 안 된다.
      // SNKRDUNK 등급 탭의 헤드라인과 동일하게 실제 최소값을 사용한다.
      lowest_ask: prices[0],
      currency,
      active_count: prices.length,
      after_filter: prices.length,
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
