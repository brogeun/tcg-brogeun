const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const source = fs.readFileSync(path.resolve(__dirname, '../functions/api/beezie-prices.js'), 'utf8');
const SNAPSHOT = 'https://raw.githubusercontent.com/brogeun/tcg-brogeun/data-beezie/data/beezie-prices.json';
const NOW = Date.parse('2026-10-20T15:20:00Z');
const SOURCE = 'official current Beezie catalogue + machine status API + labelled page average for active machines';

function paused() {
  const results = [[98, 'Wildcard'], [100, 'Gold TCG'], [104, 'Silver']].map(([id, name]) => ({
    id, sourceName: name, tier: name === 'Silver' ? 'Silver TCG' : name,
    url: 'https://beezie.com/claw/' + name.replaceAll(' ', '-') + '-' + id,
    ok: true, status: 'paused', checkedAt: NOW, stockCount: 0,
    price: null, avg: null, ev: null, method: 'official-status; no current quote',
    sourceEvidence: { httpStatus: 200, machineId: id, sourceName: name,
      sourceStatus: 'paused', stockCount: 0, checkedAt: NOW,
      url: 'https://api.beezie.com/claw/by-id/' + id },
  }));
  return { schemaVersion: 2, ok: true, source: SOURCE, fetchedAt: NOW, checkedAt: NOW,
    status: 'unavailable', pricesFresh: false,
    catalogue: { url: 'https://beezie.com/claw', httpStatus: 200, complete: true,
      machineIds: results.map(row => row.id), sourceNames: results.map(row => row.sourceName),
      htmlSha256: 'a'.repeat(64) }, results };
}

function active() {
  const data = paused();
  for (const row of data.results) {
    Object.assign(row, { status: 'active', stockCount: 3, price: 50, avg: 55, ev: 10,
      method: 'official-page-labelled-average' });
    Object.assign(row.sourceEvidence, { sourceStatus: 'active', stockCount: 3 });
  }
  data.status = 'available'; data.pricesFresh = true;
  return data;
}

function sandbox(payload = paused(), options = {}) {
  const calls = [], officialCalls = [], allCalls = [], puts = [];
  let now = NOW;
  class FakeDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    Request, Response, URL, AbortSignal, AbortController, TextEncoder, TextDecoder,
    Uint8Array, crypto: webcrypto, Date: FakeDate,
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds * (options.timerScale || 1)),
    clearTimeout,
    fetch: async (url, init) => {
      allCalls.push({ url, init });
      if (url !== SNAPSHOT) {
        assert.match(url, /^https:\/\/(?:beezie\.com\/claw|api\.beezie\.com\/claw\/by-id\/[1-9]\d*)$/,
          'Only fixed official current catalogue/status URLs are allowed');
        officialCalls.push({ url, init });
        if (options.officialFetch) return options.officialFetch(url, init);
        throw new Error('Synthetic official source outage');
      }
      calls.push({ url, init });
      if (options.failure) throw new Error('Synthetic source outage');
      if (options.fetch) return options.fetch(url, init);
      return new Response(options.invalidJson ? 'not JSON' : JSON.stringify(payload),
        { status: options.status || 200 });
    },
    caches: options.cache ? { default: {
      match: async key => options.cache(key),
      put: (key, value) => {
        if (options.cachePutThrows) throw new Error('Synthetic private cache failure');
        if (options.cachePutRejects) return Promise.reject(new Error('Synthetic private cache failure'));
        puts.push({ key, value });
        if (options.cachePut) return options.cachePut(key, value);
        return Promise.resolve();
      },
    }} : undefined,
  });
  if (options.cacheAccessThrows) Object.defineProperty(context, 'caches', { get() { throw new Error('private cache access'); } });
  vm.runInContext(source.replace(/\bexport /g, '') + '\nthis.api={onRequestGet};', context);
  return { calls, officialCalls, allCalls, puts, api: context.api, setNow(value) { now = value; } };
}

function request(debug = false) {
  return new Request('https://tcghub.kr/api/beezie-prices' + (debug ? '?debug=1' : ''));
}

async function invoke(environment, debug = false, extraContext = {}) {
  const context = { request: request(debug), env: new Proxy({}, {
    get() { throw new Error('Credentials must not be accessed'); },
  }) };
  const response = await environment.api.onRequestGet({ ...context, ...extraContext });
  return { response, body: await response.json() };
}

test('fresh complete paused catalogue returns verified null quotes with no paid/retired requests', async () => {
  const env = sandbox();
  const { response, body } = await invoke(env);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'unavailable');
  assert.equal(body.pricesFresh, false);
  assert.equal(body.fetchedAt, NOW, 'The source timestamp must not be rewritten');
  assert.deepEqual(body.results.map(row => row.id), [98, 100, 104]);
  assert.ok(body.results.every(row => row.price === null && row.avg === null && row.ev === null));
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].url, SNAPSHOT);
  assert.equal(env.calls[0].init.redirect, 'manual');
  assert.equal(env.calls[0].init.headers.Authorization, undefined);
  assert.match(response.headers.get('cache-control'), /max-age=60/);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.doesNotMatch(source, /scrapingbee|SCRAPINGBEE|Platinum-TCG-92|Gold-TCG-91|Silver-TCG-90|Wildcard-89/);
});

test('active and mixed catalogues retain exact source quotes and availability', async () => {
  for (const mixed of [false, true]) {
    const data = active();
    if (mixed) {
      data.results[0] = paused().results[0];
      data.status = 'partially-unavailable'; data.pricesFresh = false;
    }
    const { response, body } = await invoke(sandbox(data));
    assert.equal(response.status, 200);
    assert.equal(body.results[1].price, 50);
    assert.equal(body.results[1].avg, 55);
    assert.equal(body.results[1].ev, 10);
    assert.equal(body.pricesFresh, !mixed);
  }
});

test('verified active empty-stock machine is unavailable without a fabricated quote', async () => {
  const data = paused();
  data.results[0].status = 'out-of-stock';
  data.results[0].sourceEvidence.sourceStatus = 'running';
  const { response, body } = await invoke(sandbox(data));
  assert.equal(response.status, 200);
  assert.equal(body.results[0].price, null);
});

test('stale, future, legacy, partial, mismatched identity and invalid quote payloads fail closed', async t => {
  const mutations = {
    stale(data) { data.fetchedAt = NOW - 1800001; data.checkedAt = data.fetchedAt; },
    future(data) { data.fetchedAt = NOW + 1; data.checkedAt = data.fetchedAt; },
    oldRow(data) { data.results[0].checkedAt = NOW - 1800001; data.results[0].sourceEvidence.checkedAt = data.results[0].checkedAt; },
    legacyIds(data) { data.schemaVersion = 1; data.results = [92, 91, 90, 89].map(id => ({ id, price: 100, avg: 110, ok: true })); },
    failedRow(data) { data.results[0].ok = false; },
    partial(data) { data.catalogue.complete = false; },
    missingMachine(data) { data.results.pop(); },
    duplicateId(data) { data.results[1].id = data.results[0].id; },
    wrongId(data) { data.results[0].sourceEvidence.machineId = 92; },
    wrongOfficialUrl(data) { data.results[0].sourceEvidence.url = 'https://untrusted.example/98'; },
    wrongCatalogue(data) { data.catalogue.url = 'https://untrusted.example/claw'; },
    wrongSource(data) { data.source = 'unverified source'; },
    numericStringId(data) { data.results[0].id = '98'; },
    wrongLabel(data) { data.results[0].tier = 'Gold TCG'; },
    fingerprint(data) { data.catalogue.htmlSha256 = 'unknown'; },
    fabricatedPaused(data) {
      data.results[0] = paused().results[0]; data.results[0].price = 30;
      data.status = 'partially-unavailable'; data.pricesFresh = false;
    },
    nullPrice(data) { data.results[0].price = null; },
    numericStringPrice(data) { data.results[0].price = '50'; },
    badEv(data) { data.results[0].ev = 999; },
    unlabelledAverage(data) { data.results[0].method = 'guessed'; },
    availability(data) { data.status = 'unavailable'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const data = active(); mutate(data);
      const env = sandbox(data);
      const { response, body } = await invoke(env);
      assert.equal(response.status, 503);
      assert.equal(body.ok, false);
      assert.deepEqual(body.results, []);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(env.calls.length, 1, 'The rejected quote snapshot is fetched once');
      assert.equal(env.officialCalls.length, 1, 'Only one bounded official status attempt follows a rejected snapshot');
    });
  }
});

test('network, redirects, HTTP and JSON failures return 503 without another quote source', async () => {
  for (const options of [{ failure: true }, { status: 201 }, { status: 302 }, { status: 404 }, { status: 500 }, { invalidJson: true }]) {
    const env = sandbox(paused(), options);
    const { response, body } = await invoke(env);
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.deepEqual(body.results, []);
    assert.equal(env.calls.length, 1);
  }
});

test('valid edge cache avoids source requests and cache cannot renew stale snapshots', async () => {
  const fresh = paused();
  const env = sandbox(fresh, { cache: () => new Response(JSON.stringify(fresh)) });
  const { response } = await invoke(env);
  assert.equal(response.status, 200);
  assert.equal(env.calls.length, 0);
  env.setNow(NOW + 1800001);
  const failed = await invoke(env);
  assert.equal(failed.response.status, 503);
  assert.equal(failed.body.ok, false);
  assert.equal(env.calls.length, 1);
});

test('cache lifetime is bounded by oldest source evidence and debug remains no-store', async () => {
  const data = paused();
  const before = NOW - 1800000 + 10000;
  data.results[0].checkedAt = before; data.results[0].sourceEvidence.checkedAt = before;
  const env = sandbox(data, { cache: () => undefined });
  const normal = await invoke(env);
  assert.equal(normal.response.headers.get('cache-control'), 'public, max-age=10, s-maxage=10');
  assert.equal(env.puts.length, 1);
  const debug = await invoke(env, true);
  assert.equal(debug.response.status, 200);
  assert.equal(debug.response.headers.get('cache-control'), 'no-store');
  assert.equal(debug.body.debug, true);
  assert.equal(env.puts.length, 1);
});

test('concurrent requests share one free source request', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const env = sandbox(paused(), { fetch: async () => { await held; return new Response(JSON.stringify(paused())); } });
  const first = invoke(env), second = invoke(env);
  release();
  assert.equal((await first).response.status, 200);
  assert.equal((await second).response.status, 200);
  assert.equal(env.calls.length, 1);
});

test('workerd-compatible manual mode rejects redirects without issuing another fetch', async () => {
  const env = sandbox(paused(), { fetch: async (url, init) => {
    if (!['manual', 'follow'].includes(init.redirect)) throw new TypeError('Synthetic unsupported redirect mode');
    return new Response(JSON.stringify(paused()));
  } });
  assert.equal((await invoke(env)).response.status, 200);
  assert.equal(env.calls[0].init.redirect, 'manual');
  assert.equal(env.calls.length, 1);
});

test('synchronous cache put/waitUntil errors and rejected cache writes cannot break a valid source', async () => {
  for (const options of [{ cachePutThrows: true }, { cachePutRejects: true }, {}]) {
    const env = sandbox(paused(), { cache: () => undefined, ...options });
    const extraContext = options.cachePutThrows || options.cachePutRejects ? {} : {
      waitUntil() { throw new Error('Synthetic private scheduling failure'); },
    };
    const result = await invoke(env, false, extraContext);
    assert.equal(result.response.status, 200);
    assert.equal(result.body.ok, true);
  }
});

test('debug returns only fixed failure codes and optional numeric source HTTP status', async () => {
  for (const [options, code] of [
    [{ failure: true }, 'SOURCE_FETCH'],
    [{ status: 403 }, 'SOURCE_HTTP'],
    [{ invalidJson: true }, 'SOURCE_JSON'],
    [{}, 'SNAPSHOT_INVALID'],
  ]) {
    const data = paused();
    if (!Object.keys(options).length) data.fetchedAt = NOW - 1800001;
    const normal = await invoke(sandbox(data, options));
    assert.equal(normal.body.errorCode, undefined);
    const result = await invoke(sandbox(data, options), true);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.errorCode, code);
    if (code === 'SOURCE_HTTP') assert.equal(result.body.sourceHttpStatus, 403);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(result.body), /Synthetic|private|https?:|stack/i);
  }
});

test('only the original GET route handler is exported', () => {
  assert.deepEqual([...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(match => match[1]), ['onRequestGet']);
  assert.doesNotMatch(source, /onRequestOptions/);
});

const OFFICIAL_CATALOGUE = 'https://beezie.com/claw';
const OFFICIAL_API = 'https://api.beezie.com/claw/by-id/';
const CURRENT = [{ id: 98, name: 'Wildcard' }, { id: 100, name: 'Gold TCG' }, { id: 104, name: 'Silver' }];

function ssrCatalogue(rows = CURRENT, state = 'success', queryKey = ['get-minimal-claws']) {
  const value = ['$', '$L1', null, { state: { queries: [{ queryKey, state: { status: state, data: rows } }] } }];
  const packet = [1, '19:' + JSON.stringify(value) + '\n'];
  return '<script>self.__next_f.push(' + JSON.stringify(packet) + ')</script>';
}

function officialFixture(options = {}) {
  const rows = options.rows || CURRENT;
  return async (url, init) => {
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers.Cookie, undefined);
    assert.equal(init.headers.Origin, 'https://beezie.com');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.cf.cacheTtl, 0);
    if (url === OFFICIAL_CATALOGUE) return new Response(options.html ?? ssrCatalogue(rows));
    const machine = rows.find(row => url === OFFICIAL_API + row.id);
    assert.ok(machine, 'A current SSR ID is required for every official API request');
    const claw = { ...machine, status: 'paused', clawStockCount: 0, priceUsdc: 999999999,
      averageValue: 999999999, wallet: 'must-not-be-returned', trader: 'must-not-be-returned' };
    if (options.mutate) options.mutate(claw);
    return new Response(JSON.stringify({ claw }));
  };
}

function officialInvoke(env, debug = false, extra = '') {
  return invoke(env, debug, { request: new Request('https://tcghub.kr/api/beezie-prices?source=official-status' +
    (debug ? '&debug=1' : '') + extra) });
}

function oldSnapshot() {
  const data = active();
  data.fetchedAt -= 1800001; data.checkedAt = data.fetchedAt;
  for (const row of data.results) { row.checkedAt = data.fetchedAt; row.sourceEvidence.checkedAt = row.checkedAt; }
  return data;
}

test('stale snapshot falls back to exactly four free current-source GETs and fresh null status', async () => {
  const env = sandbox(oldSnapshot(), { officialFetch: officialFixture() });
  const { response, body } = await invoke(env);
  assert.equal(response.status, 200);
  assert.equal(body.schemaVersion, 2);
  assert.equal(body.source, SOURCE);
  assert.equal(body.collectionMethod, 'official-status-only');
  assert.equal(body.fetchedAt, NOW);
  assert.equal(body.checkedAt, NOW);
  assert.equal(body.status, 'unavailable');
  assert.equal(body.pricesFresh, false);
  assert.equal(body.catalogue.htmlSha256, createHash('sha256').update(ssrCatalogue()).digest('hex'));
  assert.deepEqual(body.catalogue.machineIds, [98, 100, 104]);
  assert.deepEqual(body.catalogue.sourceNames, ['Wildcard', 'Gold TCG', 'Silver']);
  assert.equal(env.calls.length, 1);
  assert.deepEqual(env.officialCalls.map(row => row.url), [OFFICIAL_CATALOGUE, ...CURRENT.map(row => OFFICIAL_API + row.id)]);
  for (const row of body.results) {
    assert.equal(row.checkedAt, NOW);
    assert.equal(row.sourceEvidence.checkedAt, NOW);
    assert.equal(row.sourceEvidence.httpStatus, 200);
    assert.equal(row.sourceEvidence.machineId, row.id);
    assert.equal(row.stockCount, 0);
    assert.equal(row.price, null); assert.equal(row.avg, null); assert.equal(row.ev, null);
  }
  assert.doesNotMatch(JSON.stringify(body), /must-not-be-returned|priceUsdc|averageValue|wallet|trader/);
});

test('fresh GitHub active quotes win even when live status is cached; bad quote cache is discarded', async () => {
  const data = active();
  const env = sandbox(data, { officialFetch: officialFixture(), cache: () => new Response(JSON.stringify(oldSnapshot())) });
  assert.equal((await officialInvoke(env)).response.status, 200);
  const normal = await invoke(env);
  assert.equal(normal.response.status, 200);
  assert.equal(normal.body.status, 'available');
  assert.equal(normal.body.results[0].avg, data.results[0].avg);
  assert.equal(env.officialCalls.length, 4);
  assert.equal(env.calls.length, 1);
});

test('recognized empty-stock active status yields unavailable; positive-stock active never invents average', async () => {
  for (const status of ['active', 'started', 'running', 'open']) {
    const empty = sandbox(paused(), { officialFetch: officialFixture({ mutate(row) { row.status = status; } }) });
    const result = await officialInvoke(empty);
    assert.equal(result.response.status, 200);
    assert.ok(result.body.results.every(row => row.status === 'out-of-stock' && row.avg === null && row.ev === null));
    const activeEnv = sandbox(active(), { officialFetch: officialFixture({ mutate(row) {
      row.status = status; row.clawStockCount = 2; row.averageValue = 123456; row.priceUsdc = 1000000;
    } }) });
    const rejected = await officialInvoke(activeEnv, true);
    assert.equal(rejected.response.status, 503);
    assert.equal(rejected.body.errorCode, 'OFFICIAL_ACTIVE');
    assert.deepEqual(rejected.body.results, []);
    assert.equal(activeEnv.officialCalls.length, 2);
  }
});

test('official identity, status and stock schema errors fail without consulting old quote values', async t => {
  const cases = {
    wrongId(row) { row.id = 92; }, wrongName(row) { row.name = 'Different'; },
    unknownState(row) { row.status = 'closed'; }, pausedWithStock(row) { row.clawStockCount = 1; },
    stringStock(row) { row.clawStockCount = '0'; }, negativeStock(row) { row.clawStockCount = -1; },
    stringId(row) { row.id = String(row.id); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const env = sandbox(active(), { officialFetch: officialFixture({ mutate }) });
    const result = await officialInvoke(env, true);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.errorCode, 'OFFICIAL_SCHEMA');
    assert.deepEqual(result.body.results, []);
  });
});

test('catalogue requires exactly one successful safe JSON query and 1..16 unique current identities', async t => {
  const bad = {
    missing: '<a href="/claw/Gold-TCG-100">Gold TCG</a>',
    empty: ssrCatalogue([]), duplicate: ssrCatalogue([CURRENT[0], CURRENT[0]]),
    duplicateLabel: ssrCatalogue([{ id: 1, name: 'Silver' }, { id: 2, name: 'Silver TCG' }]),
    failed: ssrCatalogue(CURRENT, 'error'), wrongQuery: ssrCatalogue(CURRENT, 'success', ['get-minimal-claws', 'other']),
    multiple: ssrCatalogue() + ssrCatalogue(),
    tooMany: ssrCatalogue(Array.from({ length: 17 }, (_, i) => ({ id: i + 1, name: 'Machine ' + i }))),
    unsafeLabel: ssrCatalogue([{ id: 1, name: '../not-current' }]),
    unsafeId: ssrCatalogue([{ id: 9007199254740992, name: 'Machine' }]),
    executable: '<script>self.__next_f.push((globalThis.INJECTED=true,[1,"19:[]"]))</script>',
    unclosedPrefixes: 'self.__next_f.push('.repeat(100000),
  };
  for (const [name, html] of Object.entries(bad)) await t.test(name, async () => {
    const env = sandbox(paused(), { officialFetch: officialFixture({ html }) });
    const result = await officialInvoke(env, true);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.errorCode, 'OFFICIAL_SCHEMA');
    assert.equal(env.officialCalls.length, 1);
  });
});

test('official catalogue maximum is 17 sequential requests, with no caller-controlled source URL', async () => {
  const rows = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, name: 'Machine ' + i }));
  const fixture = officialFixture({ rows });
  let inFlight = 0, maximumInFlight = 0;
  const env = sandbox(paused(), { officialFetch: async (url, init) => {
    inFlight++; maximumInFlight = Math.max(maximumInFlight, inFlight);
    try { return await fixture(url, init); } finally { inFlight--; }
  } });
  const result = await officialInvoke(env, false, '&url=https%3A%2F%2Funtrusted.example&sourceUrl=elsewhere');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.results.length, 16);
  assert.equal(env.officialCalls.length, 17);
  assert.equal(env.calls.length, 0);
  assert.equal(maximumInFlight, 1);
});

test('official redirects, HTTP429, transport and JSON errors fail once with no retry', async t => {
  for (const [name, fetcher, code, status] of [
    ['redirect', () => new Response('', { status: 302, headers: { Location: 'https://untrusted.example' } }), 'OFFICIAL_HTTP', 302],
    ['throttle', () => new Response('', { status: 429 }), 'OFFICIAL_HTTP', 429],
    ['transport', () => { throw new Error('private upstream details'); }, 'OFFICIAL_FETCH'],
    ['json', (url, init) => url === OFFICIAL_CATALOGUE ? officialFixture()(url, init) : new Response('not JSON'), 'OFFICIAL_JSON'],
  ]) await t.test(name, async () => {
    const env = sandbox(paused(), { officialFetch: fetcher });
    const result = await officialInvoke(env, true);
    assert.equal(result.response.status, 503);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(result.body.errorCode, code);
    if (status) assert.equal(result.body.sourceHttpStatus, status);
    assert.ok(env.officialCalls.length <= 2);
    assert.doesNotMatch(JSON.stringify(result.body), /private|untrusted|Location|stack/);
  });
});

test('catalogue and machine streaming byte limits reject before parsing, including multibyte text', async t => {
  for (const name of ['catalogue-declared', 'catalogue-streamed', 'machine-streamed', 'machine-multibyte']) {
    await t.test(name, async () => {
      let cancelled = false;
      const env = sandbox(paused(), { officialFetch: async (url, init) => {
        if (name.startsWith('machine') && url === OFFICIAL_CATALOGUE) return officialFixture()(url, init);
        const content = name === 'machine-multibyte' ? '한'.repeat(22000) : 'a'.repeat(name.startsWith('catalogue') ? 2000001 : 64001);
        const bytes = new TextEncoder().encode(content);
        const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
        return new Response(stream, name.endsWith('declared') ? { headers: { 'Content-Length': String(bytes.length) } } : {});
      } });
      const result = await officialInvoke(env, true);
      assert.equal(result.response.status, 503);
      assert.equal(result.body.errorCode, 'OFFICIAL_TOO_LARGE');
      assert.equal(cancelled, true);
      assert.ok(env.officialCalls.length <= 2);
    });
  }
});

test('success status is shared for sixty seconds across debug/source options without rewriting evidence time', async () => {
  const env = sandbox(oldSnapshot(), { officialFetch: officialFixture() });
  const first = await invoke(env);
  assert.equal(first.response.status, 200);
  env.setNow(NOW + 59000);
  for (const extra of ['', '&random=1', '&random=2']) {
    const next = await officialInvoke(env, true, extra);
    assert.equal(next.response.status, 200);
    assert.equal(next.response.headers.get('cache-control'), 'no-store');
    assert.equal(next.body.fetchedAt, NOW);
  }
  assert.equal(env.officialCalls.length, 4);
  env.setNow(NOW + 60001);
  const refreshed = await officialInvoke(env);
  assert.equal(refreshed.body.fetchedAt, NOW + 60001);
  assert.equal(env.officialCalls.length, 8);
});

test('failed status has a shared twelve-second cooldown that debug/query variants cannot bypass', async () => {
  const env = sandbox(oldSnapshot(), { officialFetch: () => new Response('', { status: 429 }) });
  for (const extra of ['', '&random=1', '&random=2']) {
    const failed = await officialInvoke(env, true, extra);
    assert.equal(failed.response.status, 503);
    assert.equal(failed.response.headers.get('cache-control'), 'no-store');
    assert.equal(failed.body.errorCode, 'OFFICIAL_HTTP');
    assert.equal(failed.body.sourceHttpStatus, 429);
  }
  assert.equal(env.officialCalls.length, 1);
  env.setNow(NOW + 11999);
  await invoke(env);
  assert.equal(env.officialCalls.length, 1);
  env.setNow(NOW + 12001);
  await officialInvoke(env);
  assert.equal(env.officialCalls.length, 2);
});

test('concurrent normal/debug/forced-status callers share one official traversal', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const fixture = officialFixture();
  const env = sandbox(oldSnapshot(), { officialFetch: async (url, init) => {
    if (url === OFFICIAL_CATALOGUE) await held;
    return fixture(url, init);
  } });
  const pending = [officialInvoke(env), officialInvoke(env, true), invoke(env), officialInvoke(env, true, '&random=1')];
  release();
  for (const result of await Promise.all(pending)) assert.equal(result.response.status, 200);
  assert.equal(env.officialCalls.length, 4);
  assert.equal(env.calls.length, 1);
});

test('Cache API shares success and cooldown across isolates and cannot extend official source lifetime', async () => {
  for (const fail of [false, true]) {
    const stored = new Map();
    const options = { officialFetch: fail ? () => new Response('', { status: 429 }) : officialFixture(),
      cache: key => stored.get(key.url)?.clone(), cachePut: (key, value) => { stored.set(key.url, value); } };
    const first = sandbox(oldSnapshot(), options);
    assert.equal((await officialInvoke(first)).response.status, fail ? 503 : 200);
    assert.equal(stored.size, 1);
    const second = sandbox(oldSnapshot(), options);
    const cached = await officialInvoke(second, true, '&random=1');
    assert.equal(cached.response.status, fail ? 503 : 200);
    assert.equal(second.officialCalls.length, 0);
    if (!fail) assert.equal(cached.body.fetchedAt, NOW);
    second.setNow(NOW + (fail ? 12001 : 60001));
    assert.equal((await officialInvoke(second)).response.status, fail ? 503 : 200);
    assert.equal(second.officialCalls.length, fail ? 1 : 4);
  }
});

test('cache failures and hanging lookups cannot prevent verified official status or remove module cooldown', async () => {
  for (const options of [
    { cacheAccessThrows: true },
    { cache: () => { throw new Error('private cache read'); }, cachePutThrows: true },
    { cache: () => undefined, cachePutRejects: true },
    { cache: () => new Promise(() => {}), timerScale: .01 },
  ]) {
    const env = sandbox(oldSnapshot(), { officialFetch: officialFixture(), ...options });
    assert.equal((await officialInvoke(env)).response.status, 200);
    assert.equal((await officialInvoke(env, true)).response.status, 200);
    assert.equal(env.officialCalls.length, 4);
  }
});

test('excessive empty stream fragments are cancelled without unbounded memory or a blocked deadline', async () => {
  let reads = 0, cancelled = false;
  const env = sandbox(oldSnapshot(), { officialFetch: () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array()); },
    cancel() { cancelled = true; },
  })) });
  const result = await officialInvoke(env, true);
  assert.equal(result.response.status, 503);
  assert.equal(result.body.errorCode, 'OFFICIAL_BODY');
  assert.equal(cancelled, true);
  assert.ok(reads <= 4097);
  assert.equal(env.officialCalls.length, 1);
});

test('a returned redirected or mismatched response URL is rejected and its body is cancelled', async () => {
  for (const properties of [{ redirected: true }, { url: 'https://untrusted.example/' }]) {
    let cancelled = false;
    const env = sandbox(paused(), { officialFetch: () => {
      const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
      for (const [name, value] of Object.entries(properties)) Object.defineProperty(response, name, { value });
      return response;
    } });
    const result = await officialInvoke(env, true);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.errorCode, 'OFFICIAL_SCHEMA');
    assert.equal(cancelled, true);
    assert.equal(env.officialCalls.length, 1);
  }
});

test('one overall deadline covers fetch and streamed body; cancellation stops further machine requests', async t => {
  for (const mode of ['fetch', 'body']) await t.test(mode, async () => {
    let cancelled = false;
    const env = sandbox(paused(), { timerScale: .01, officialFetch: async (url, init) => {
      if (url === OFFICIAL_CATALOGUE) return officialFixture()(url, init);
      if (mode === 'fetch') return new Promise(() => {});
      return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }));
    } });
    const started = Date.now();
    const result = await officialInvoke(env, true);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.errorCode, 'OFFICIAL_TIMEOUT');
    assert.ok(Date.now() - started < 1000);
    assert.equal(env.officialCalls.length, 2);
    assert.ok(env.officialCalls.every(call => call.init.signal.aborted));
    if (mode === 'body') assert.equal(cancelled, true);
    await officialInvoke(env, true);
    assert.equal(env.officialCalls.length, 2, 'Timed-out requests share the same cooldown');
  });
});

test('a hanging GitHub request leaves the official fallback time within the same overall deadline', async () => {
  const env = sandbox(oldSnapshot(), { timerScale: .02, fetch: () => new Promise(() => {}), officialFetch: officialFixture() });
  const started = Date.now();
  const result = await invoke(env);
  assert.equal(result.response.status, 200);
  assert.ok(Date.now() - started < 1000);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].init.signal.aborted, true);
  assert.equal(env.officialCalls.length, 4);
});

test('saved official SSR and API fixtures replay with the exact catalogue byte hash', async t => {
  const folder = path.resolve(__dirname, '../../samples/beezie-public');
  if (!fs.existsSync(path.join(folder, 'claw-index.txt'))) return t.skip('Audit-only official fixtures are not packaged');
  const env = sandbox(oldSnapshot(), { officialFetch: (url) => {
    const filename = url === OFFICIAL_CATALOGUE ? 'claw-index.txt' : 'api-' + url.split('/').pop() + '.txt';
    return new Response(fs.readFileSync(path.join(folder, filename)));
  } });
  const result = await invoke(env);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.catalogue.machineIds, [98, 100, 104]);
  assert.equal(result.body.catalogue.htmlSha256, createHash('sha256').update(fs.readFileSync(path.join(folder, 'claw-index.txt'))).digest('hex'));
  assert.ok(result.body.results.every(row => row.status === 'paused' && row.price === null && row.avg === null && row.ev === null));
});
