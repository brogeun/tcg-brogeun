const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  const calls = [], puts = [];
  let now = NOW;
  class FakeDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    Request, Response, URL, AbortSignal, Date: FakeDate,
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.equal(url, SNAPSHOT, 'Only the fixed public snapshot may be fetched');
      if (options.failure) throw new Error('Synthetic source outage');
      if (options.fetch) return options.fetch(url, init);
      return new Response(options.invalidJson ? 'not JSON' : JSON.stringify(payload),
        { status: options.status || 200 });
    },
    caches: options.cache ? { default: {
      match: async key => options.cache(key),
      put: async (key, value) => puts.push({ key, value }),
    }} : undefined,
  });
  vm.runInContext(source.replace(/\bexport /g, '') + '\nthis.api={onRequestGet};', context);
  return { calls, puts, api: context.api, setNow(value) { now = value; } };
}

function request(debug = false) {
  return new Request('https://tcghub.kr/api/beezie-prices' + (debug ? '?debug=1' : ''));
}

async function invoke(environment, debug = false) {
  const context = { request: request(debug), env: new Proxy({}, {
    get() { throw new Error('Credentials must not be accessed'); },
  }) };
  const response = await environment.api.onRequestGet(context);
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
  assert.equal(env.calls[0].init.redirect, 'error');
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
    fabricatedPaused(data) { data.results[0].price = 30; },
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
      assert.equal(env.calls.length, 1, 'A rejected snapshot must not trigger another source');
    });
  }
});

test('network, HTTP and JSON failures return 503 without another source', async () => {
  for (const options of [{ failure: true }, { status: 404 }, { status: 500 }, { invalidJson: true }]) {
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

test('only the original GET route handler is exported', () => {
  assert.deepEqual([...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(match => match[1]), ['onRequestGet']);
  assert.doesNotMatch(source, /onRequestOptions/);
});
