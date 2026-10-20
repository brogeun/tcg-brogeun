/**
 * Relay the verified public data-branch snapshot. Never collect machine prices
 * in a Pages request or replace an unavailable quote with an estimate.
 */
const SNAPSHOT_URL = 'https://raw.githubusercontent.com/brogeun/tcg-brogeun/data-beezie/data/beezie-prices.json';
const SOURCE = 'official current Beezie catalogue + machine status API + labelled page average for active machines';
const MAX_AGE_MS = 30 * 60 * 1000;
const CACHE_SECONDS = 60;
const SOURCE_STATES = new Set(['active', 'started', 'running', 'open']);
const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};
let pendingSnapshot = null;

function requireValid(condition) {
  if (!condition) throw new Error('Invalid or stale Beezie snapshot');
}

function fresh(value, now) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 &&
    value <= now && now - value <= MAX_AGE_MS;
}

function validate(payload, now) {
  requireValid(payload && payload.schemaVersion === 2 && payload.ok === true &&
    payload.source === SOURCE && fresh(payload.fetchedAt, now) &&
    payload.checkedAt === payload.fetchedAt);
  const rows = payload.results;
  const catalogue = payload.catalogue;
  requireValid(Array.isArray(rows) && rows.length >= 1 && rows.length <= 16 &&
    catalogue && catalogue.complete === true && catalogue.httpStatus === 200 &&
    catalogue.url === 'https://beezie.com/claw' &&
    /^[a-f0-9]{64}$/.test(catalogue.htmlSha256) &&
    Array.isArray(catalogue.machineIds) && catalogue.machineIds.length === rows.length &&
    Array.isArray(catalogue.sourceNames) && catalogue.sourceNames.length === rows.length);
  const ids = new Set(), names = new Set(), tiers = new Set();
  let active = 0, oldest = payload.fetchedAt;
  for (const [index, row] of rows.entries()) {
    requireValid(row && row.ok === true && Number.isSafeInteger(row.id) && row.id > 0 &&
      typeof row.sourceName === 'string' && row.sourceName.length <= 80 &&
      /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/.test(row.sourceName) &&
      row.tier === (row.sourceName === 'Silver' ? 'Silver TCG' : row.sourceName) &&
      row.url === 'https://beezie.com/claw/' + row.sourceName.replaceAll(' ', '-') + '-' + row.id &&
      !ids.has(row.id) && !names.has(row.sourceName) && !tiers.has(row.tier) &&
      catalogue.machineIds[index] === row.id && catalogue.sourceNames[index] === row.sourceName &&
      fresh(row.checkedAt, now) && row.checkedAt <= payload.fetchedAt &&
      Number.isSafeInteger(row.stockCount) && row.stockCount >= 0);
    ids.add(row.id); names.add(row.sourceName); tiers.add(row.tier);
    oldest = Math.min(oldest, row.checkedAt);
    const evidence = row.sourceEvidence;
    requireValid(evidence && evidence.httpStatus === 200 && evidence.machineId === row.id &&
      evidence.sourceName === row.sourceName && evidence.checkedAt === row.checkedAt &&
      evidence.stockCount === row.stockCount &&
      evidence.url === 'https://api.beezie.com/claw/by-id/' + row.id);
    if (row.status === 'paused' || row.status === 'out-of-stock') {
      requireValid(row.stockCount === 0 &&
        (row.status === 'paused' ? evidence.sourceStatus === 'paused' : SOURCE_STATES.has(evidence.sourceStatus)) &&
        row.price === null && row.avg === null && row.ev === null);
      continue;
    }
    requireValid(row.status === 'active' && SOURCE_STATES.has(evidence.sourceStatus) &&
      row.stockCount > 0 && row.method === 'official-page-labelled-average' &&
      typeof row.price === 'number' && Number.isFinite(row.price) && row.price > 0 &&
      typeof row.avg === 'number' && Number.isFinite(row.avg) && row.avg > 0 &&
      typeof row.ev === 'number' && Number.isFinite(row.ev) &&
      Math.abs(row.ev - (row.avg / row.price - 1) * 100) <= 0.02);
    active++;
  }
  const status = active === rows.length ? 'available' : active ? 'partially-unavailable' : 'unavailable';
  requireValid(payload.status === status && payload.pricesFresh === (active === rows.length));
  return Math.max(0, Math.min(CACHE_SECONDS, Math.floor((oldest + MAX_AGE_MS - now) / 1000)));
}

function json(payload, status, cacheControl) {
  return new Response(JSON.stringify(payload), {
    status, headers: { ...CORS, 'Cache-Control': cacheControl },
  });
}

async function fetchSnapshot() {
  if (!pendingSnapshot) {
    pendingSnapshot = (async () => {
      const response = await fetch(SNAPSHOT_URL, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        cf: { cacheEverything: true, cacheTtl: 30 },
      });
      if (!response.ok) throw new Error('Snapshot source unavailable');
      const text = await response.text();
      if (text.length > 128000) throw new Error('Snapshot exceeds expected size');
      return JSON.parse(text);
    })().finally(() => { pendingSnapshot = null; });
  }
  return pendingSnapshot;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const debug = url.searchParams.get('debug') === '1';
  const cache = globalThis.caches?.default;
  const key = new Request(new URL('/api/beezie-prices?snapshot=verified-v2', url));
  try {
    let payload;
    if (cache && !debug) {
      try {
        const cached = await cache.match(key);
        if (cached?.ok) {
          payload = await cached.json();
          validate(payload, Date.now());
        }
      } catch {
        payload = null;
      }
    }
    payload ||= await fetchSnapshot();
    const ttl = validate(payload, Date.now());
    const response = json({ ...payload, debug }, 200,
      debug || !ttl ? 'no-store' : 'public, max-age=' + ttl + ', s-maxage=' + ttl);
    if (cache && !debug && ttl) {
      const write = cache.put(key, response.clone()).catch(() => {});
      if (typeof context.waitUntil === 'function') context.waitUntil(write);
      else await write;
    }
    return response;
  } catch {
    return json({ ok: false, error: 'Beezie 최신 자료를 확인하지 못했습니다.', results: [] }, 503, 'no-store');
  }
}
