import { getCurrentUser } from '../_shared/auth.js';
import { isAdminUser } from '../_shared/admin.js';

function allowedSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value) || !/^https:\/\/www\.tcgcollector\.com\//i.test(value)) throw new Error('Invalid source');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'www.tcgcollector.com' || url.port || url.username || url.password || url.hash || !/^\/sets\/\d{1,8}\/[a-z0-9-]+\/?$/i.test(url.pathname)) throw new Error('Invalid source');
  return url;
}

function allowedImageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value) || !/^https:\/\/static\.tcgcollector\.com\//i.test(value)) throw new Error('Invalid image');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'static.tcgcollector.com' || url.port || url.username || url.password || url.hash || !/^\/content\/images\/[a-z0-9/_-]+\.(?:jpe?g|png|webp)$/i.test(url.pathname)) throw new Error('Invalid image');
  return url;
}

async function safeFetch(value, validate, options) {
  let url = validate(value);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(url.href, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (![301,302,303,307,308].includes(response.status)) return response;
    const location = response.headers.get('Location');
    await response.body?.cancel();
    if (!location || hop === 3) throw new Error('Invalid upstream redirect');
    url = validate(new URL(location, url).href);
  }
  throw new Error('Invalid upstream redirect');
}

async function readBounded(response, limit) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty upstream body');
  let length = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new Error('Upstream body too large'); }
    chunks.push(value);
  }
  const data = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data.buffer;
}

// functions/api/scrape-set.js
// 세트 한 개 스크래핑 → 카드 이미지 R2 저장 + index.json 생성
// 관리자 전용 POST JSON: {code, brand, url}. GET 요청은 저장하지 않는다.
//
// R2 바인딩 필요: IMAGES (bucket: tcg-image)
// 저장 구조:
//   pokemon/M2a/index.json     ← 카드 메타 목록
//   pokemon/M2a/cards/{n}.jpg  ← 카드 이미지 (n = 카드번호 또는 인덱스)

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return jsonResp(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return jsonResp(403, { ok: false, error: '같은 사이트에서만 실행할 수 있습니다.' });
  }
  if (!env.JWT_SECRET || !env.DB) return jsonResp(503, { ok: false, error: 'Authentication unavailable' });
  const user = await getCurrentUser(request, env);
  if (!user) return jsonResp(401, { ok: false, error: '로그인이 필요합니다.' });
  if (!await isAdminUser(user, env)) return jsonResp(403, { ok: false, error: '관리자 계정만 실행할 수 있습니다.' });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) return jsonResp(415, { ok: false, error: 'JSON 요청이 필요합니다.' });
  let body;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error('missing body');
    let bytes = 0; const chunks = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) { await reader.cancel(); return jsonResp(413, { ok: false, error: '요청이 너무 큽니다.' }); }
      chunks.push(value);
    }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(joined));
  } catch { return jsonResp(400, { ok: false, error: 'JSON 본문을 확인해주세요.' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResp(400, { ok: false, error: 'JSON 객체가 필요합니다.' });
  const code = body.code;
  const brand = body.brand === undefined ? 'pokemon' : typeof body.brand === 'string' ? body.brand.toLowerCase() : '';
  if (typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(code) || !['pokemon', 'onepiece'].includes(brand)) {
    return jsonResp(400, { ok: false, error: 'code 또는 brand가 올바르지 않습니다.' });
  }
  let sourceUrl;
  try { sourceUrl = allowedSourceUrl(body.url).href; }
  catch { return jsonResp(400, { ok: false, error: 'TCG Collector 세트 주소가 필요합니다.' }); }
  if (!env.IMAGES) return jsonResp(503, { ok: false, error: 'Image storage unavailable' });

  try {
    // 1) 세트 페이지 fetch
    const r = await safeFetch(sourceUrl, allowedSourceUrl, {
      headers: { "User-Agent": UA, "Accept": "text/html" },
    });
    if (!r.ok) throw new Error(`set page HTTP ${r.status}`);
    const html = new TextDecoder().decode(await readBounded(r, 4 * 1024 * 1024));

    // 2) 카드 추출 (tcgcollector HTML 구조 기반 정규식)
    const cards = extractCards(html);
    if (cards.length === 0) {
      return jsonResp(500, { ok: false, error: "카드를 찾을 수 없습니다 (HTML 구조 변경 가능성)", htmlLength: html.length });
    }

    if (cards.length > 1500) return jsonResp(413, { ok: false, error: '세트의 카드 수가 제한을 초과합니다.' });
    // Validate every source before the first storage mutation.
    try { for (const card of cards) allowedImageUrl(card.sourceImage); }
    catch { return jsonResp(400, { ok: false, error: '허용되지 않는 이미지 주소가 포함되어 있습니다.' }); }

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
    if (successCount === 0) return jsonResp(502, { ok: false, error: '이미지를 저장하지 못해 기존 세트 목록을 유지했습니다.' });
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
  const r = await safeFetch(card.sourceImage, allowedImageUrl, {
    headers: { "User-Agent": UA, "Referer": "https://www.tcgcollector.com/" },
  });
  if (!r.ok) throw new Error(`image HTTP ${r.status}`);
  const blob = await readBounded(r, 8 * 1024 * 1024);
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

function jsonResp(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}
