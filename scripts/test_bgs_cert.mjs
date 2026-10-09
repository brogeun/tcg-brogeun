// Offline HTTP-handler tests: fake provider/catalogue fetches and in-memory SQLite only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { onRequestPost } from '../functions/api/bgs/cert.js';
import { signJwt } from '../functions/_shared/jwt.js';

const localCard = { name: 'Nami SR[OP07-051]', code: 'OP07-051', brand: 'onepiece' };
const providerCard = {
  item_id: '0016097088', final_grade: '9.5', label: 'gold', player_name: 'NAMI',
  card_key: 'OP07051', set_name: 'ONE PIECE OP07', year: '2024',
  pop_report: '1234', fgB100: '0', fg100: '30', fg95: '1204',
};

async function fixture(t, { card = localCard, cardId = '22222', cards = null, bgs = providerCard, catalogue = 'index', providerResponse = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE bgs_certs (
    id INTEGER PRIMARY KEY, cert_number TEXT UNIQUE, card_id TEXT, user_id INTEGER,
    final_grade TEXT, label TEXT, card_key TEXT, player_name TEXT, set_name TEXT,
    pop_total INTEGER, pop_bl10 INTEGER, pop_gl10 INTEGER, pop_95 INTEGER, raw_payload TEXT)`);
  const env = {
    JWT_SECRET: 'bgs-handler-test-fixture-only',
    DB: { prepare(sql) { return { bind(...args) { return {
      async first() { return db.prepare(sql).get(...args) || null; },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { last_row_id: Number(result.lastInsertRowid) } };
      },
    }; } }; } },
  };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push(url.href);
    if (url.origin === 'https://beckett.com') {
      assert.equal(url.pathname, '/api/grading/lookup');
      assert.equal(url.searchParams.get('category'), 'BGS');
      assert.equal(url.searchParams.get('serialNumber'), '0016097088');
      const response = new Response(providerResponse.body ?? JSON.stringify(bgs), {
        status: providerResponse.status ?? 200,
        headers: { 'Content-Type': providerResponse.contentType ?? 'application/json; charset=utf-8' },
      });
      Object.defineProperty(response, 'url', { value: providerResponse.url ?? url.href });
      Object.defineProperty(response, 'redirected', { value: providerResponse.redirected ?? false });
      return response;
    }
    assert.equal(url.origin, 'https://example.test', 'unexpected outbound request');
    assert.ok(['/data/cards-meta-index.json', '/data/all-cards.json', `/data/history/${cardId}.json`].includes(url.pathname));
    if (!card) return new Response('', { status: 404 });
    const catalogueCards = cards || { [cardId]: card };
    if (catalogue === 'index' && url.pathname.endsWith('cards-meta-index.json')) return Response.json(catalogueCards);
    if (catalogue === 'all' && url.pathname.endsWith('all-cards.json')) {
      return Response.json({ details: Object.entries(catalogueCards).map(([id, entry]) => {
        const { code, ...metadata } = entry;
        return { id, ...metadata, productNumber: code };
      }) });
    }
    if (catalogue === 'history' && url.pathname.endsWith(`/${cardId}.json`)) {
      return Response.json({ product_name: card.name, product_number: card.code, brand: card.brand });
    }
    return new Response('', { status: 404 });
  });
  const session = await signJwt({ sub: 1, exp: Math.floor(Date.now() / 1000) + 60 }, env.JWT_SECRET);
  return {
    db, calls,
    async call({ authenticated = true } = {}) {
      const response = await onRequestPost({ env, request: new Request('https://example.test/api/bgs/cert', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: `session=${session}` } : {}) },
        body: JSON.stringify({ cert_number: '0016097088', card_id: cardId }),
      }) });
      return { http: response.status, ...await response.json() };
    },
    rows() { return db.prepare('SELECT * FROM bgs_certs').all(); },
  };
}

for (const [code, card_key] of [['OP07-051', 'OP07051'], ['OP07051', 'OP07-051'], ['OP07-051', 'OP07-051']]) {
  test(`BGS exact card registers across separator spelling: ${code} / ${card_key}`, async t => {
    const bgs = { ...providerCard, card_key };
    const f = await fixture(t, { card: { name: 'Nami SR', code, brand: 'onepiece' }, bgs });
    const response = await f.call();
    assert.equal(response.http, 200);
    assert.equal(response.ok, true);
    assert.equal(response.population_verified, true);
    assert.equal(response.cert.cert_number, '0016097088');
    assert.deepEqual(response.cert.pop, { total: 1234, bl10: 0, gl10: 30, g95: 1204 });
    const [saved] = f.rows();
    assert.equal(f.rows().length, 1);
    assert.equal(saved.card_id, '22222');
    assert.equal(saved.user_id, 1);
    assert.equal(saved.pop_bl10, 0);
    assert.deepEqual(JSON.parse(saved.raw_payload), bgs);
  });
}

for (const card of [
  { name: 'Robin', code: '' },
  { name: 'Nami', code: '' },
  { name: 'Nami', code: '   ' },
  { name: 'Nami', code: 'onepiece-22222' },
]) {
  test(`BGS cannot approve missing printed metadata: ${JSON.stringify(card)}`, async t => {
    const f = await fixture(t, { card });
    const response = await f.call();
    assert.equal(response.http, 503);
    assert.equal(response.error, 'card_metadata_incomplete');
    assert.equal(f.rows().length, 0);
  });
}

test('BGS may use a printed number in brackets when catalogue code is absent', async t => {
  const f = await fixture(t, { card: { ...localCard, code: '' } });
  assert.equal((await f.call()).http, 200);
  assert.equal(f.rows().length, 1);
});

for (const card of [
  { name: 'Nami SR', code: 'OP07-052' },
  { name: 'Nami SR[OP07-051]', code: 'OP07-052' },
  { name: 'Nami SR', code: 'OP08-051' },
  { name: 'Nami SR', code: 'OP07-51' },
  { name: 'Nami SR', code: 'OP0751' },
]) {
  test(`BGS same name with a contradictory explicit code returns 422: ${JSON.stringify(card)}`, async t => {
    const f = await fixture(t, { card });
    const response = await f.call();
    assert.equal(response.http, 422);
    assert.equal(response.error, 'card_mismatch');
    assert.equal(f.rows().length, 0);
  });
}

for (const bgs of [
  { ...providerCard, card_key: 'OP07052' },
  { ...providerCard, card_key: '051' },
  { ...providerCard, player_name: 'ROBIN' },
  { ...providerCard, player_name: 'NAMI ROBIN' },
  { ...providerCard, set_name: 'ONE PIECE OP07 FIRST EDITION' },
]) {
  test(`BGS rejects mismatched provider identity: ${bgs.player_name} / ${bgs.card_key} / ${bgs.set_name}`, async t => {
    const f = await fixture(t, { bgs });
    const response = await f.call();
    assert.equal(response.http, 422);
    assert.equal(response.error, 'card_mismatch');
    assert.equal(f.rows().length, 0);
  });
}

for (const bgs of [{ ...providerCard, card_key: '' }, { ...providerCard, player_name: '' }]) {
  test(`BGS incomplete provider metadata remains retryable: ${bgs.card_key || 'missing number'} / ${bgs.player_name || 'missing subject'}`, async t => {
    const f = await fixture(t, { bgs });
    const response = await f.call();
    assert.equal(response.http, 503);
    assert.equal(response.error, 'card_metadata_incomplete');
    assert.equal(f.rows().length, 0);
  });
}

test('BGS unavailable catalogue metadata keeps lookup_failed and never writes', async t => {
  const f = await fixture(t, { card: null });
  const response = await f.call();
  assert.equal(response.http, 503);
  assert.equal(response.error, 'lookup_failed');
  assert.equal(f.calls.length, 4, 'provider plus all three catalogue fallbacks are exercised');
  assert.equal(f.rows().length, 0);
});

for (const catalogue of ['all', 'history']) {
  test(`BGS catalogue ${catalogue} fallback uses the same strict identity checks`, async t => {
    const f = await fixture(t, { catalogue, card: { ...localCard, code: 'OP07-052' } });
    const response = await f.call();
    assert.equal(response.http, 422);
    assert.equal(response.error, 'card_mismatch');
    assert.equal(f.rows().length, 0);
  });
}

test('BGS still requires authentication before network or storage', async t => {
  const f = await fixture(t);
  assert.equal((await f.call({ authenticated: false })).http, 401);
  assert.equal(f.calls.length, 0);
  assert.equal(f.rows().length, 0);
});


for (const [description, providerResponse] of [
  ['maintenance redirect returning HTML', { url: 'https://maintenance.beckett.com/', redirected: true, contentType: 'text/html', body: '<h1>Maintenance</h1>' }],
  ['maintenance host claiming JSON', { url: 'https://maintenance.beckett.com/api/grading/lookup', redirected: true }],
  ['HTML at lookup endpoint', { contentType: 'text/html', body: '<h1>Maintenance</h1>' }],
  ['JSON payload with a non-JSON media type', { contentType: 'text/plain' }],
  ['redirect to an unrelated host', { url: 'https://beckett.com.attacker.test/api/grading/lookup', redirected: true }],
  ['redirect to a login page', { url: 'https://www.beckett.com/login', redirected: true }],
  ['unfollowed maintenance redirect', { status: 302 }],
  ['temporary provider outage', { status: 503 }],
  ['invalid JSON', { body: '{not-json' }],
  ['non-record JSON', { body: '[]' }],
]) {
  test(`BGS ${description} is retryable 503, never not_found or a registration`, async t => {
    const f = await fixture(t, { providerResponse });
    const response = await f.call();
    assert.equal(response.http, 503);
    assert.equal(response.error, 'bgs_lookup_unavailable');
    assert.equal(f.rows().length, 0);
    assert.equal(f.calls.length, 1, 'unavailable provider must not trigger catalogue lookup');
  });
}

test('BGS canonical www host still accepts a valid JSON lookup response', async t => {
  const f = await fixture(t, { providerResponse: {
    url: 'https://www.beckett.com/api/grading/lookup?category=BGS&serialNumber=0016097088', redirected: true,
  } });
  assert.equal((await f.call()).http, 200);
});

for (const item_id of ['16097088', 16097088, '0016097089', ' 0016097088', null]) {
  test(`BGS rejects a returned cert identity different from the exact requested string: ${JSON.stringify(item_id)}`, async t => {
    const f = await fixture(t, { bgs: { ...providerCard, item_id } });
    const response = await f.call();
    assert.equal(response.http, 422);
    assert.equal(response.error, 'cert_number_mismatch');
    assert.equal(f.rows().length, 0);
    assert.equal(f.calls.length, 1);
  });
}

test('BGS records lacking the optional item_id still require full card matching', async t => {
  const bgs = { ...providerCard };
  delete bgs.item_id;
  const f = await fixture(t, { bgs });
  assert.equal((await f.call()).http, 200);
});

test('BGS explicit unregistered JSON keeps the existing not_found response', async t => {
  const f = await fixture(t, { bgs: { ...providerCard, final_grade: '0.0' } });
  const response = await f.call();
  assert.equal(response.http, 404);
  assert.equal(response.error, 'not_found');
  assert.equal(f.rows().length, 0);
});

for (const value of [undefined, null, '', '-1', -1, '1.5', 1.5, '1.0', '1234cards', '1,23', '1e3', '0x10', true, [], {}, '9007199254740992', Number.MAX_SAFE_INTEGER + 1]) {
  test(`BGS invalid or absent POP stays null without claiming POP verified: ${JSON.stringify(value)}`, async t => {
    const f = await fixture(t, { bgs: { ...providerCard, pop_report: value, fgB100: value, fg100: value, fg95: value } });
    const response = await f.call();
    assert.equal(response.http, 200, 'missing population does not invalidate an otherwise matching card');
    assert.equal(response.ok, true);
    assert.equal(response.population_verified, false);
    assert.deepEqual(response.cert.pop, { total: null, bl10: null, gl10: null, g95: null });
    assert.doesNotMatch(response.message, /인증 완료|POP 반영/);
    assert.match(response.message, /확인되지 않았습니다/);
    const [saved] = f.rows();
    assert.deepEqual([saved.pop_total, saved.pop_bl10, saved.pop_gl10, saved.pop_95], [null, null, null, null]);
  });
}

for (const [value, expected] of [[0, 0], ['0', 0], ['1,234', 1234], [' 12 ', 12], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
  test(`BGS valid complete POP integer remains verified: ${JSON.stringify(value)}`, async t => {
    const f = await fixture(t, { bgs: { ...providerCard, pop_report: value, fgB100: value, fg100: value, fg95: value } });
    const response = await f.call();
    assert.equal(response.http, 200);
    assert.equal(response.population_verified, true);
    assert.deepEqual(response.cert.pop, { total: expected, bl10: expected, gl10: expected, g95: expected });
  });
}

test('BGS partial POP preserves the available counts and clearly marks missing counts', async t => {
  const f = await fixture(t, { bgs: { ...providerCard, fgB100: undefined } });
  const response = await f.call();
  assert.equal(response.http, 200);
  assert.equal(response.population_verified, false);
  assert.deepEqual(response.cert.pop, { total: 1234, bl10: null, gl10: 30, g95: 1204 });
  assert.doesNotMatch(response.message, /인증 완료|POP 반영/);
});


// Actual catalogue entries: preserve the existing (incorrect) brand value to ensure
// the printed One Piece number, not an assumed brand cleanup, identifies the family.
const luffyVariants = {
  '135437': { name: 'Monkey D Luffy SEC [OP05-119] (Booster Pack Awakening of the New Era)', code: 'OP05-119', brand: 'pokemon' },
  '135438': { name: 'Monkey D Luffy SEC-P [OP05-119] (Booster Pack Awakening of the New Era)', code: 'OP05-119', brand: 'pokemon' },
  '135439': { name: 'Monkey.D.Luffy SEC-SP (Comic Parallel) [OP05-119](Booster Pack "Awakening Of The New Era")', code: 'OP05-119', brand: 'pokemon' },
};
const luffyRecord = { ...providerCard, player_name: 'MONKEY D LUFFY', card_key: 'OP05119', set_name: 'ONE PIECE AWAKENING OF THE NEW ERA', year: '2023' };
const explicitLuffyVariants = [['135437', 'Base'], ['135438', 'Parallel'], ['135439', 'Comic Parallel']];

for (const catalogue of ['index', 'all', 'history']) {
  for (const [cardId, card] of Object.entries(luffyVariants)) {
    test(`BGS ${catalogue} cannot approve ambiguous OP05-119 variant ${cardId} without edition evidence`, async t => {
      const f = await fixture(t, { card, cardId, cards: luffyVariants, catalogue, bgs: luffyRecord });
      const response = await f.call();
      assert.equal(response.http, 503);
      assert.equal(response.error, 'card_variant_unconfirmed');
      assert.match(response.message, /판본|일반판/);
      assert.doesNotMatch(response.message, /다른 카드/);
      assert.equal(f.rows().length, 0);
    });
  }
  for (const [cardId, variety] of explicitLuffyVariants) {
    test(`BGS ${catalogue} registers the matching explicitly identified ${variety} edition only`, async t => {
      const f = await fixture(t, { card: luffyVariants[cardId], cardId, cards: luffyVariants, catalogue, bgs: { ...luffyRecord, variety } });
      const response = await f.call();
      assert.equal(response.http, 200);
      assert.equal(response.population_verified, true);
      assert.equal(response.cert.pop.bl10, 0);
      assert.equal(f.rows().length, 1);
      assert.equal(f.rows()[0].card_id, cardId);
    });
  }
}

for (const [actualCardId, variety] of explicitLuffyVariants) {
  for (const cardId of Object.keys(luffyVariants).filter(id => id !== actualCardId)) {
    test(`BGS explicit ${variety} edition cannot register a different OP05-119 variant ${cardId}`, async t => {
      const f = await fixture(t, { card: luffyVariants[cardId], cardId, cards: luffyVariants, bgs: { ...luffyRecord, variety } });
      const response = await f.call();
      assert.equal(response.http, 422);
      assert.equal(response.error, 'card_mismatch');
      assert.equal(f.rows().length, 0);
    });
  }
}
