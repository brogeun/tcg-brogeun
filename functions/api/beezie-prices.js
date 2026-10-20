/**
 * Prefer verified data-branch quotes. When unavailable, the official public
 * catalogue/status API can verify only paused/empty machines, never prices.
 */
const SNAPSHOT_URL = 'https://raw.githubusercontent.com/brogeun/tcg-brogeun/data-beezie/data/beezie-prices.json';
const SOURCE = 'official current Beezie catalogue + machine status API + labelled page average for active machines';
const MAX_AGE_MS = 30 * 60 * 1000;
const CACHE_SECONDS = 60;
const CATALOGUE_URL = 'https://beezie.com/claw';
const OFFICIAL_API = 'https://api.beezie.com/claw/by-id/';
const REQUEST_MS = 8000;
const SNAPSHOT_MS = 2500;
const FAILURE_MS = 12000;
const CATALOGUE_BYTES = 2000000;
const MACHINE_BYTES = 64000;
const SOURCE_STATES = new Set(['active', 'started', 'running', 'open']);
const DEBUG_CODES = new Set(['SOURCE_FETCH', 'SOURCE_HTTP', 'SOURCE_BODY', 'SOURCE_JSON', 'SOURCE_TOO_LARGE', 'SNAPSHOT_INVALID',
  'OFFICIAL_FETCH', 'OFFICIAL_HTTP', 'OFFICIAL_BODY', 'OFFICIAL_JSON', 'OFFICIAL_TOO_LARGE',
  'OFFICIAL_SCHEMA', 'OFFICIAL_ACTIVE', 'OFFICIAL_TIMEOUT']);
const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
};
let pendingSnapshot = null;
let pendingOfficial = null;
let officialRecord = null;

function sourceError(code) {
  const error = new Error('Beezie snapshot unavailable');
  error.code = code;
  return error;
}

function requireValid(condition) {
  if (!condition) throw sourceError('SNAPSHOT_INVALID');
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

function deadline(milliseconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return { signal: controller.signal, end: Date.now() + milliseconds, close: () => clearTimeout(timer) };
}

function bounded(promise, signal, code = 'OFFICIAL_TIMEOUT') {
  return new Promise((resolve, reject) => {
    const abort = () => reject(sourceError(code));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function limitedBody(response, limit, signal, prefix, end) {
  if (signal.aborted) throw sourceError(prefix === 'SOURCE' ? 'SOURCE_BODY' : 'OFFICIAL_TIMEOUT');
  const declared = response.headers?.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* best effort */ }
    throw sourceError(prefix + '_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw sourceError(prefix + '_BODY');
  const chunks = [];
  let total = 0, reads = 0, complete = false;
  try {
    while (true) {
      if (signal.aborted || Date.now() >= end) throw sourceError(prefix === 'SOURCE' ? 'SOURCE_BODY' : 'OFFICIAL_TIMEOUT');
      if (++reads > 4096) throw sourceError(prefix + '_BODY');
      const { done, value } = await bounded(reader.read(), signal,
        prefix === 'SOURCE' ? 'SOURCE_BODY' : 'OFFICIAL_TIMEOUT');
      if (done) { complete = true; break; }
      total += value.byteLength;
      if (total > limit) throw sourceError(prefix + '_TOO_LARGE');
      if (value.byteLength) chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (DEBUG_CODES.has(error?.code)) throw error;
    throw sourceError(prefix + '_BODY');
  } finally {
    if (!complete) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* best effort */ } }
    try { reader.releaseLock(); } catch { /* A cancelled read can still be settling. */ }
  }
}

function decode(bytes, prefix) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw sourceError(prefix + '_BODY'); }
}

async function fetchSnapshot() {
  if (!pendingSnapshot) {
    pendingSnapshot = (async () => {
      const scope = deadline(SNAPSHOT_MS);
      try {
        let response;
        try {
          response = await bounded(fetch(SNAPSHOT_URL, {
            headers: { Accept: 'application/json' }, redirect: 'manual', signal: scope.signal,
            cf: { cacheEverything: true, cacheTtl: 30 },
          }), scope.signal, 'SOURCE_FETCH');
        } catch { throw sourceError('SOURCE_FETCH'); }
        if (response.status !== 200) {
          try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* best effort */ }
          const error = sourceError('SOURCE_HTTP'); error.httpStatus = response.status; throw error;
        }
        const text = decode(await limitedBody(response, 128000, scope.signal, 'SOURCE', scope.end), 'SOURCE');
        try { return JSON.parse(text); } catch { throw sourceError('SOURCE_JSON'); }
      } finally { scope.close(); }
    })().finally(() => { pendingSnapshot = null; });
  }
  return pendingSnapshot;
}

function officialValid(condition) {
  if (!condition) throw sourceError('OFFICIAL_SCHEMA');
}

function discoverMachines(html) {
  // The same successful SSR query as the Python collector; never execute RSC text.
  const packets = [];
  const prefix = 'self.__next_f.push(';
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf(prefix, cursor);
    if (start < 0) break;
    const end = html.indexOf('</script>', start + prefix.length);
    if (end < 0) break;
    cursor = end + '</script>'.length;
    const encoded = html.slice(start + prefix.length, end);
    if (!encoded.endsWith(')')) continue;
    try {
      const packet = JSON.parse(encoded.slice(0, -1));
      if (Array.isArray(packet) && packet[0] === 1 && typeof packet[1] === 'string') packets.push(packet[1]);
    } catch { /* Only JSON packets are accepted. */ }
  }
  const catalogues = [];
  let budget = 50000;
  for (const line of packets.join('').split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0 || !line.includes('get-minimal-claws')) continue;
    let value;
    try { value = JSON.parse(line.slice(colon + 1)); } catch { continue; }
    const stack = [value];
    while (stack.length) {
      officialValid(--budget >= 0);
      const item = stack.pop();
      if (!item || typeof item !== 'object') continue;
      if (!Array.isArray(item) && Array.isArray(item.queryKey) && item.queryKey.length === 1 &&
          item.queryKey[0] === 'get-minimal-claws') {
        officialValid(item.state?.status === 'success' && Array.isArray(item.state.data));
        catalogues.push(item.state.data);
      }
      for (const child of Object.values(item)) if (child && typeof child === 'object') stack.push(child);
    }
  }
  officialValid(catalogues.length === 1 && catalogues[0].length >= 1 && catalogues[0].length <= 16);
  const ids = new Set(), names = new Set(), tiers = new Set();
  return catalogues[0].map(row => {
    officialValid(row && Number.isSafeInteger(row.id) && row.id > 0 && typeof row.name === 'string' &&
      row.name.length <= 80 && /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/.test(row.name));
    const tier = row.name === 'Silver' ? 'Silver TCG' : row.name;
    officialValid(!ids.has(row.id) && !names.has(row.name) && !tiers.has(tier));
    ids.add(row.id); names.add(row.name); tiers.add(tier);
    return { id: row.id, sourceName: row.name, tier,
      url: 'https://beezie.com/claw/' + row.name.replaceAll(' ', '-') + '-' + row.id };
  });
}

async function officialGet(url, limit, scope) {
  if (scope.signal.aborted || Date.now() >= scope.end) throw sourceError('OFFICIAL_TIMEOUT');
  let response;
  try {
    response = await bounded(fetch(url, {
      headers: { Accept: 'application/json,text/html', Origin: 'https://beezie.com',
        Referer: 'https://beezie.com/', 'User-Agent': 'Mozilla/5.0 (compatible; TCGHUB-public-status/1.0; +https://tcghub.kr)',
        'Cache-Control': 'no-cache' },
      redirect: 'manual', signal: scope.signal, cf: { cacheEverything: false, cacheTtl: 0 },
    }), scope.signal);
  } catch (error) {
    if (error?.code === 'OFFICIAL_TIMEOUT' || scope.signal.aborted) throw sourceError('OFFICIAL_TIMEOUT');
    throw sourceError('OFFICIAL_FETCH');
  }
  if (response.status !== 200) {
    try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* best effort */ }
    const error = sourceError('OFFICIAL_HTTP'); error.httpStatus = response.status; throw error;
  }
  if (response.redirected || (response.url && response.url !== url)) {
    try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* best effort */ }
    throw sourceError('OFFICIAL_SCHEMA');
  }
  return limitedBody(response, limit, scope.signal, 'OFFICIAL', scope.end);
}

async function collectOfficialStatus(scope) {
  const catalogueBytes = await officialGet(CATALOGUE_URL, CATALOGUE_BYTES, scope);
  const machines = discoverMachines(decode(catalogueBytes, 'OFFICIAL'));
  const digest = await bounded(crypto.subtle.digest('SHA-256', catalogueBytes), scope.signal);
  const htmlSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const results = [];
  for (const machine of machines) {
    const bytes = await officialGet(OFFICIAL_API + machine.id, MACHINE_BYTES, scope);
    let payload;
    try { payload = JSON.parse(decode(bytes, 'OFFICIAL')); } catch { throw sourceError('OFFICIAL_JSON'); }
    const claw = payload?.claw;
    officialValid(claw && claw.id === machine.id && claw.name === machine.sourceName &&
      typeof claw.status === 'string' && Number.isSafeInteger(claw.clawStockCount) && claw.clawStockCount >= 0);
    if (SOURCE_STATES.has(claw.status) && claw.clawStockCount > 0) throw sourceError('OFFICIAL_ACTIVE');
    officialValid(claw.clawStockCount === 0 && (claw.status === 'paused' || SOURCE_STATES.has(claw.status)));
    const checkedAt = Date.now(), status = claw.status === 'paused' ? 'paused' : 'out-of-stock';
    results.push({ ...machine, ok: true, checkedAt, stockCount: 0, status,
      price: null, avg: null, ev: null, method: 'official-status; no current quote',
      error: status === 'paused' ? 'Beezie 일시 중지 · 재고 없음' : 'Beezie 재고 없음',
      sourceEvidence: { httpStatus: 200, sourceStatus: claw.status, stockCount: 0,
        sourceName: machine.sourceName, machineId: machine.id, url: OFFICIAL_API + machine.id, checkedAt } });
  }
  if (scope.signal.aborted || Date.now() >= scope.end) throw sourceError('OFFICIAL_TIMEOUT');
  const fetchedAt = Date.now();
  const payload = { schemaVersion: 2, ok: true, fetchedAt, checkedAt: fetchedAt,
    status: 'unavailable', pricesFresh: false, source: SOURCE,
    timestampMeaning: 'current official source check; unavailable rows contain no current quote',
    collectionMethod: 'official-status-only',
    catalogue: { url: CATALOGUE_URL, httpStatus: 200, complete: true,
      machineIds: machines.map(row => row.id), sourceNames: machines.map(row => row.sourceName), htmlSha256 }, results };
  validate(payload, Date.now());
  return payload;
}

async function cachedJson(cache, key, scope) {
  if (!cache || scope.signal.aborted) return null;
  const readScope = deadline(Math.max(1, Math.min(200, scope.end - Date.now())));
  try {
    const response = await bounded(cache.match(key), readScope.signal);
    if (!response?.ok) return null;
    const bytes = await limitedBody(response, 128000, readScope.signal, 'SOURCE', readScope.end);
    return JSON.parse(decode(bytes, 'SOURCE'));
  } catch { return null; }
  finally { readScope.close(); }
}

function putCache(context, cache, key, payload, seconds) {
  if (!cache || !seconds) return;
  try {
    const write = Promise.resolve(cache.put(key, json(payload, 200, 'public, max-age=' + seconds))).catch(() => {});
    if (typeof context.waitUntil === 'function') context.waitUntil(write);
  } catch { /* Cache failure cannot replace a verified source response. */ }
}

function validOfficialRecord(record, now) {
  if (!record || !Number.isFinite(record.until) || record.until <= now) return false;
  if (record.kind === 'failure') return record.until <= now + FAILURE_MS && DEBUG_CODES.has(record.code);
  if (record.kind !== 'success' || record.until !== record.payload?.fetchedAt + CACHE_SECONDS * 1000 ||
      record.until > now + CACHE_SECONDS * 1000) return false;
  try {
    validate(record.payload, now);
    return record.payload.collectionMethod === 'official-status-only' &&
      record.payload.status === 'unavailable' && record.payload.results.every(row =>
        (row.status === 'paused' || row.status === 'out-of-stock') && row.price === null && row.avg === null && row.ev === null);
  } catch { return false; }
}

function recordResult(record) {
  if (record.kind === 'success') return record.payload;
  const error = sourceError(record.code);
  if (Number.isInteger(record.httpStatus)) error.httpStatus = record.httpStatus;
  throw error;
}

async function officialStatus(context, cache, key, scope) {
  if (validOfficialRecord(officialRecord, Date.now())) return recordResult(officialRecord);
  if (!pendingOfficial) {
    pendingOfficial = (async () => {
      const cached = await cachedJson(cache, key, scope);
      if (validOfficialRecord(cached, Date.now())) { officialRecord = cached; return recordResult(cached); }
      try {
        const payload = await collectOfficialStatus(scope);
        officialRecord = { kind: 'success', until: payload.fetchedAt + CACHE_SECONDS * 1000, payload };
        putCache(context, cache, key, officialRecord, CACHE_SECONDS);
        return payload;
      } catch (error) {
        const code = DEBUG_CODES.has(error?.code) ? error.code : 'OFFICIAL_SCHEMA';
        officialRecord = { kind: 'failure', until: Date.now() + FAILURE_MS, code };
        if (Number.isInteger(error.httpStatus)) officialRecord.httpStatus = error.httpStatus;
        putCache(context, cache, key, officialRecord, FAILURE_MS / 1000);
        throw error;
      }
    })().finally(() => { pendingOfficial = null; });
  }
  return bounded(pendingOfficial, scope.signal);
}

export async function onRequestGet(context) {
  const scope = deadline(REQUEST_MS);
  const url = new URL(context.request.url);
  const debug = url.searchParams.get('debug') === '1';
  const forceOfficial = url.searchParams.get('source') === 'official-status';
  let cache;
  try { cache = globalThis.caches?.default; } catch { /* Cache availability is optional. */ }
  const key = new Request(new URL('/api/beezie-prices?snapshot=verified-v2', url));
  const officialKey = new Request(new URL('/api/beezie-prices?official-status-cache=v1', url));
  let primaryError;
  try {
    let payload, usedOfficial = forceOfficial;
    if (!forceOfficial) {
      try {
        if (!debug) {
          payload = await cachedJson(cache, key, scope);
          if (payload) {
            try { validate(payload, Date.now()); } catch { payload = null; }
          }
        }
        if (scope.signal.aborted) throw sourceError('OFFICIAL_TIMEOUT');
        payload ||= await bounded(fetchSnapshot(), scope.signal);
        validate(payload, Date.now());
      } catch (error) { primaryError = error; payload = null; usedOfficial = true; }
    }
    if (usedOfficial) payload = await officialStatus(context, cache, officialKey, scope);
    const ttl = validate(payload, Date.now());
    const response = json({ ...payload, debug }, 200,
      debug || !ttl ? 'no-store' : 'public, max-age=' + ttl + ', s-maxage=' + ttl);
    // Keep live status out of the quote cache so a fresh GitHub quote wins.
    if (!usedOfficial && !debug) putCache(context, cache, key, payload, ttl);
    return response;
  } catch (error) {
    const body = { ok: false, error: 'Beezie 최신 자료를 확인하지 못했습니다.', results: [] };
    if (debug) {
      const diagnostic = primaryError || error;
      body.errorCode = DEBUG_CODES.has(diagnostic?.code) ? diagnostic.code : 'SNAPSHOT_INVALID';
      if (body.errorCode.endsWith('_HTTP') && Number.isInteger(diagnostic.httpStatus) &&
          diagnostic.httpStatus >= 100 && diagnostic.httpStatus <= 599) body.sourceHttpStatus = diagnostic.httpStatus;
      if (primaryError) body.officialStatusErrorCode = DEBUG_CODES.has(error?.code) ? error.code : 'OFFICIAL_SCHEMA';
    }
    return json(body, 503, 'no-store');
  } finally { scope.close(); }
}
