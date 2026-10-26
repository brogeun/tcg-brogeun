import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../../functions/price/[id].js', import.meta.url), 'utf8');
const { onRequestGet } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const html = '<!doctype html><html><head><title>Home</title><link rel="canonical" href="https://tcghub.kr/"><meta property="og:title" content="Home"><meta property="og:url" content="https://tcghub.kr/"><meta name="twitter:title" content="Home"></head><body>Site</body></html>';
const fresh = new Date().toISOString();
const stale = new Date(Date.now() - 48 * 3600000).toISOString();
const defaults = () => ({
  meta: { '123': { name: 'Pikachu "ex" &amp; Friends', code: 'A123', brand: 'pokemon' } },
  detail: { fetchedAt: fresh, cards: { '123': { fetchedAt: fresh, grades: { psa10: { lowest_ask: 44500, currency: 'JPY' } } } } },
  fx: { updated: fresh, rates: { JPY: 8.4512, USD: 1326 } },
});

async function request({ id = '123', fixtures = defaults(), metaStatus = 200, fxStatus = 200 } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/cards-meta-index.json')) return Response.json(fixtures.meta, { status: metaStatus });
    if (path.endsWith('/cards-detail.json')) return Response.json(fixtures.detail);
    if (path.endsWith('/fx-rates.json')) return Response.json(fixtures.fx, { status: fxStatus });
    throw new Error(`Unexpected fetch ${path}`);
  };
  try {
    const response = await onRequestGet({ request: new Request(`https://tcghub.kr/price/${id}`), params: { id }, env: { ASSETS: { fetch: async () => new Response(html) } } });
    const text = await response.text();
    const match = text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    return { response, text, product: match ? JSON.parse(match[1]) : null };
  } finally { globalThis.fetch = original; }
}

test('fresh PSA10 quote uses current FX, self canonical and accurate JSON names', async () => {
  const { response, text, product } = await request();
  assert.equal(response.status, 200);
  assert.equal(product.offers.price, String(Math.floor(44500 * 8.4512)));
  assert.equal(product.name, 'Pikachu "ex" & Friends');
  assert.ok(!('availability' in product.offers));
  assert.match(text, /rel="canonical" href="https:\/\/tcghub.kr\/price\/123"/);
  assert.match(text, /name="twitter:title" content="Pikachu/);
  assert.match(text, /PSA10 참고 호가/);
});

test('known box without PSA10 data does not advertise zero or InStock', async () => {
  const fixtures = defaults(); fixtures.detail.cards['123'].grades = {};
  const { response, text, product } = await request({ fixtures });
  assert.equal(response.status, 200); assert.ok(!('offers' in product));
  assert.ok(!text.includes('₩0')); assert.ok(!text.includes('InStock'));
});

test('unknown numeric and malformed IDs return noindex 404 without Product', async () => {
  for (const id of ['456', 'does-not-exist-audit', '123"><script>']) {
    const { response, product } = await request({ id });
    assert.equal(response.status, 404); assert.equal(product, null);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  }
});

test('temporary metadata failure returns 503 rather than inventing or deleting a product', async () => {
  const { response, product } = await request({ metaStatus: 503 });
  assert.equal(response.status, 503); assert.equal(product, null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('stale card-level quote stays hidden even when aggregate snapshot is fresh', async () => {
  const fixtures = defaults(); fixtures.detail.cards['123'].fetchedAt = stale;
  const { product } = await request({ fixtures }); assert.ok(!('offers' in product));
});

test('invalid/zero quotes and missing/old FX never produce an offer', async () => {
  const cases = [];
  for (const amount of [0, -5, '44500', null]) { const f=defaults(); f.detail.cards['123'].grades.psa10.lowest_ask=amount; cases.push(f); }
  const oldFx=defaults(); oldFx.fx.updated=stale; cases.push(oldFx);
  const missingFx=defaults(); missingFx.fx.rates={}; cases.push(missingFx);
  const unknownCurrency=defaults(); delete unknownCurrency.detail.cards['123'].grades.psa10.currency; cases.push(unknownCurrency);
  for (const fixtures of cases) { const { product } = await request({ fixtures }); assert.ok(!('offers' in product)); }
  const { product } = await request({ fxStatus: 503 }); assert.ok(!('offers' in product));
});

test('KRW needs no FX and names containing script terminators remain JSON text', async () => {
  const fixtures=defaults(); fixtures.meta['123'].name='Card </script><img src=x> $&';
  fixtures.detail.cards['123'].grades.psa10={ lowest_ask: 12345, currency: 'KRW' };
  const { text, product } = await request({ fixtures });
  assert.equal(product.name, 'Card </script><img src=x> $&');
  assert.equal(product.offers.price, '12345');
  assert.ok(!text.includes('</script><img src=x>'));
  assert.ok(text.includes('\\u003c/script>'));
});
