const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('registry and reference helpers load before their detail consumers', () => {
  const html = read('index.html');
  const pos = name => html.indexOf('src="/assets/' + name);
  assert(pos('game-registry.js') >= 0);
  assert(pos('market-references.js') > pos('game-registry.js'));
  for (const consumer of ['price-expanded.js', 'english-catalog.js']) {
    assert(pos(consumer) > pos('market-references.js'), consumer);
  }
  assert(!html.includes('href="/market-references"'));
  assert(!html.includes('mr-game-shortcuts'));
  assert.match(html, /data-ci="nikke"/);
  assert.match(read('_redirects'), /^\/market-references\s+\/cardinfo\s+302$/m);
  assert(!read('assets/price-expanded.js').includes('MarketReferences?.sourceLinks'));
});

test('new game labels do not fall back to Pokemon', () => {
  const registry = require('../assets/game-registry.js');
  for (const [game, label] of [['weiss', '바이스'], ['digimon', '디지몬'], ['yugioh', '유희왕']]) {
    assert(registry.label(game).includes(label), game);
  }
  assert.equal(registry.label('unknown-game'), 'TCG');
  const html = read('index.html');
  assert(!html.includes("const brandLabel = c.brand === 'onepiece' ? '원피스' : '포켓몬'"));
});

test('reference snapshots prefer live data and retain last-good offline snapshots', async () => {
  const handlers = {};
  let offline = false;
  const stored = new Map();
  const context = {
    URL, Response, location: {origin: 'https://tcghub.kr'},
    self: {addEventListener: (name, fn) => handlers[name] = fn},
    caches: {open: async () => ({
      match: async req => stored.get(req.url),
      put: async (req, res) => stored.set(req.url, res),
    })},
    fetch: async () => {
      if (offline) throw new Error('offline');
      return new Response('fresh');
    },
  };
  vm.runInNewContext(read('sw.js'), context);
  for (const pathname of [
    '/data/us-market.json', '/data/us-market/base1.json',
    '/data/yuyutei-market.json', '/data/yuyutei-market/weiss_schwarz/nk1.0.json',
    '/data/mercari-references.json', '/data/snkrdunk-games.json',
    '/data/snkrdunk-games/weiss_schwarz-card-0000.json',
    '/data/price-digimon-card.json', '/data/reference-market-health.json',
    '/data/cards-meta-index.json', '/data/cards-meta-index/83.json',
    '/data/tcg-card-info.json', '/data/tcg-card-info/nikke/0123456789abcdef.json',
    '/assets/tcg-card-info.js', '/assets/card-price-fallback.js', '/assets/contained-card-prices.js',
    '/assets/game-registry.js', '/assets/market-references.js',
    '/market-references',
  ]) {
    const req = {url: context.location.origin + pathname, method: 'GET'};
    stored.set(req.url, new Response('old'));
    let promise;
    handlers.fetch({request: req, respondWith: p => promise = p});
    assert(promise, pathname);
    assert.equal(await (await promise).text(), 'fresh', pathname);
    offline = true;
    handlers.fetch({request: req, respondWith: p => promise = p});
    assert.equal(await (await promise).text(), 'fresh', pathname + ' offline');
    offline = false;
  }
});
