'use strict';
// Read-only production gate. No network, collectors, generated files or price writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 2 && args[0] === '--bundle-dir', 'Usage: node scripts/test_ja_production_gate.cjs [--bundle-dir DIRECTORY]');
const base = path.resolve(args[1] || path.join(__dirname, '..'));
const text = file => fs.readFileSync(path.join(base, file), 'utf8').replace(/^\uFEFF/, '');
const read = file => JSON.parse(text(file));
let checks = 0;
function check(name, fn) { fn(); checks++; }
const catalogue = read('data/japanese-catalog.json');
const dictionary = read('data/japanese-card-names-ko.json');
const metadata = read('data/cards-meta.json');
const originalMetadata = JSON.stringify(metadata);
const originalCatalogue = JSON.stringify(catalogue);
const html = text('index.html');
const browser = vm.createContext({URLSearchParams, console});
browser.window = browser;
vm.runInContext(text('assets/japanese-card-names.js'), browser);
vm.runInContext(text('assets/japanese-catalog.js'), browser);
const names = browser.JapaneseCardNames;
const api = browser.JapaneseCatalog;
names.configure(dictionary);
api.configure(catalogue);

check('reviewed catalogue remains present and internally consistent', () => {
  assert.equal(catalogue.schemaVersion, 1);
  assert.equal(dictionary.schemaVersion, 1);
  assert(catalogue.sets.length >= 193, 'A reviewed Japanese set was removed');
  assert(catalogue.cards.length >= 18344, 'A reviewed Japanese card was removed');
  assert.equal(new Set(catalogue.cards.map(card => card.id)).size, catalogue.cards.length);
  assert.equal(new Set(catalogue.sets.map(set => set.code)).size, catalogue.sets.length);
  assert.equal(catalogue.audit.setCount, catalogue.sets.length);
  assert.equal(catalogue.audit.cardCount, catalogue.cards.length);
  assert.deepEqual(catalogue.audit.missingSourceFiles, []);
  assert(!catalogue.audit.setCompleteness.some(set => set.complete === false));
  const counts = new Map();
  for (const card of catalogue.cards) {
    assert.match(card.id, /^JP:/);
    assert.equal(card.language, 'ja');
    assert.equal(names.language(card), 'ja', card.id + ' has a foreign edition marker');
    assert.equal(card.brand, 'pokemon');
    assert.equal(card.kind, 'card');
    const code = card.boxCode || card.setCode;
    counts.set(code, (counts.get(code) || 0) + 1);
    if (card.productId) {
      assert.match(card.productId, /^\d+$/, card.id + ' must use a marketplace price ID');
      assert.deepEqual(card.productIds, [card.productId]);
    } else assert.deepEqual(card.productIds, [], card.id + ' must not price an unverified candidate');
  }
  for (const set of catalogue.sets) assert.equal(counts.get(set.code), set.cardCount, set.code + ' count');
});

check('repaired source inventories retain the reviewed totals', () => {
  const totals = {S10P:88,S10D:88,CP1:34,CP2:27,CP3:32,CP4:140,CP5:38,CP6:103,VS:151,SD:127,'VS-MANAPHY':19,SV1S:108,SV1V:108,S8a:38,EBB:99,DS:20,LL:40,SC:25,SMP2:25,BSTXY:188,DP1:130,'DPt-MRP09':30,WCP:108,WEB:48,'ADV4-SEAL':83,'DP5-TW':65,ADV4:88};
  for (const [code, count] of Object.entries(totals)) assert.equal(catalogue.sets.find(set => set.code === code)?.cardCount, count, code);
});

// These are the only printed-card lists written by the daily anniversary job.
// Compare their identity, not their market supplements, prices or fetched dates.
for (const [code, printed, denominator, unnumbered] of [['M6a',165,'103',[169,176]], ['MF',44,'040',[45,49]]]) {
  check(code + ' daily source retains every exact card identity', () => {
    const source = read('data/cards-by-set/' + code + '.json');
    const cards = source.cards.filter(card => !card.marketSupplement);
    const expected = Array.from({length:printed}, (_, i) => String(i + 1).padStart(3, '0') + '/' + denominator);
    if (code === 'M6a') expected.push('R/RGB', 'G/RGB', 'B/RGB');
    for (let n = unnumbered[0]; n <= unnumbered[1]; n++) expected.push('No. ' + String(n).padStart(3, '0'));
    assert.equal(source.code, code);
    assert.equal(source.cardCount, source.cards.length);
    assert.equal(cards.length, expected.length);
    assert.equal(new Set(cards.map(card => card.sourceId)).size, cards.length);
    assert.deepEqual(cards.map(card => card.number).sort(), expected.sort());
    const saved = catalogue.cards.filter(card => card.setCode === code);
    assert.equal(saved.length, expected.length);
    const byNumber = new Map(saved.map(card => [card.number, card]));
    for (const card of cards) {
      const row = byNumber.get(card.number);
      assert(row, code + ' ' + card.number + ' missing from search');
      assert.equal(card.name, row.name, code + ' ' + card.number + ' title changed');
      assert.equal(String(card.sourceId), String(row.sourceId), code + ' ' + card.number + ' source ID changed');
      assert.equal(card.url, row.sourceUrl, code + ' ' + card.number + ' source changed');
      assert(!card.id, 'A collector source ID must not replace a market price ID');
    }
  });
}

check('all catalogue labels are Korean apart from printed model codes', () => {
  const unresolved = catalogue.cards.map(card => [card.id, names.unresolved(card)]).filter(row => row[1]);
  assert.deepEqual(unresolved, [], 'Untranslated catalogue titles');
});

const market = metadata.cards.map(card => ({...card, id:String(card.id), nameLower:String(card.name || '').toLowerCase(), productNumber:String(card.productNumber || '').toLowerCase()}));
const reviewedDuplicates = {
  '391128':'JP:CP4:113/131',
  '427857':'JP:VS:009/141',
  '435166':'JP:VS-MANAPHY:001/019'
};
for (const id of Object.keys(reviewedDuplicates)) {
  const product = market.find(card => card.id === id);
  assert(product, 'Reviewed duplicate fixture absent: ' + id);
  product.minPrice = 987654321;
  product.currency = 'JPY';
}
// A nonzero candidate price proves that an unverified artwork cannot supply it.
for (const [id, value] of [['96640',123456], ['454482',999999]]) {
  const product = market.find(card => card.id === id);
  assert(product, 'Known market fixture absent: ' + id);
  product.minPrice = value;
  product.currency = 'JPY';
}
market.push(
  {id:'999990001',brand:'pokemon',kind:'card',name:'Beedrill [EN]',language:'ja',nameLower:'beedrill [en]',minPrice:1},
  {id:'999990002',brand:'pokemon',kind:'card',name:'Beedrill',language:'ja',nameLower:'beedrill',image:'https://example.test/pkmn-tcg-en-test.webp',minPrice:2}
);
const originalMarket = JSON.stringify(market);
api.setProducts(market);
browser._ALL_CARDS_INDEX = market;
browser._SEARCH_ALIASES = read('data/search-aliases.json');
const searchStart = html.indexOf('function searchCards(');
const searchEnd = html.indexOf('function renderSearchResults(', searchStart);
assert(searchStart >= 0 && searchEnd > searchStart, 'The deployed search handler is missing');
vm.runInContext(html.slice(searchStart, searchEnd), browser);
const search = query => browser.searchCards(query, Infinity);
check('DON resource-card queries never broaden into Pokemon names or McDonald promos', () => {
  const don = search('Don!! card');
  assert(don.length > 0, 'DON cards must remain searchable');
  const ids = don.map(card => card.id).sort();
  for (const query of ['don!!','don card','DON!!CARD','\uFF24\uFF2F\uFF2E\uFF01\uFF01 \uFF43\uFF41\uFF52\uFF44','돈카드','돈 카드','돈','ドン!!カード']) {
    assert.deepEqual(search(query).map(card => card.id).sort(), ids, query);
  }
  for (const card of don) {
    assert.equal(card.brand, 'onepiece', card.name);
    assert.equal(card.kind, 'card', card.name);
    assert.match(card.name, /^DON\s*!+/i, card.name);
  }
  assert(ids.includes('730301'), 'Mihawk DON card missing');
  assert(!ids.includes('671488'), 'McDonald Riolu must not match DON');
  assert(!ids.includes('671486'), 'McDonald Pikachu must not match DON');
  const zoro = search('Don!! card Zoro');
  assert(zoro.length > 0);
  assert(zoro.every(card => /zoro/i.test(card.name)), 'Additional character term was ignored');
  assert.equal(search('Don!! card no-such-character-987654').length, 0);
  assert.equal(search('Don!! card 671488').length, 0, 'Product ID must not bypass card type');
  assert.deepEqual(Array.from(search('Don!! card 730301'), card => card.id), ['730301']);
  assert(search('Koraidon').some(card => card.brand === 'pokemon'), 'Normal Pokemon search was lost');
  assert.equal(api.prepareQuery('코라이돈').type, null);
  assert.equal(api.prepareQuery('Donquixote Doflamingo').type, null);
  for (const card of [
    {brand:'pokemon',kind:'card',name:'Koraidon: PROMO [SV-P 049]',_searchText:'doncard'},
    {brand:'pokemon',kind:'card',name:'Riolu (Promo Card Pack McDonald\'s)',_searchText:'doncard'},
    {brand:'onepiece',kind:'box',name:'DON!! Card Collection',_searchText:'doncard'},
    {brand:'onepiece',kind:'card',name:'Donquixote Doflamingo',_searchText:'doncard'}
  ]) assert.equal(api.matches(card, 'Don!! card'), false, card.name);
});
const bees = search('독침붕');
check('reviewed foreign editions and duplicate market IDs cannot alter Japanese printing identities', () => {
  for (const id of ['488126','488127','509330','739358','739359']) {
    const product = market.find(card => card.id === id);
    assert(product, 'Reviewed foreign fixture absent: ' + id);
    assert.equal(names.language(product), 'en');
    assert.equal(search(id).length, 0, id + ' is a reviewed English printing');
  }
  for (const [id, target] of Object.entries(reviewedDuplicates)) {
    assert.equal(names.candidateCatalogueId(market.find(card => card.id === id)), target);
    assert.equal(api.find(id), undefined, id + ' must not duplicate the existing printing');
    const row = api.find(target), original = catalogue.cards.find(card => card.id === target);
    assert(row && original);
    assert.equal(row.productId, null);
    assert.deepEqual(row.productIds, []);
    assert.equal(row.minPrice, undefined, 'A reviewed duplicate is not a price link');
    assert.equal(row.thumbnailUrl, original.thumbnailUrl || original.image || '');
    assert.equal(api.href(row), '/?' + new URLSearchParams({set:original.boxCode || original.setCode,
      card:original.number || original.sourceId || original.id}) + '#cardinfo');
  }
});
check('Japanese Beedrill search returns all 33 cards in Korean', () => {
  assert.equal(bees.length, 33);
  assert.equal(new Set(bees.map(card => card.id)).size, 33);
  assert.equal(bees.filter(card => /Spirit Link/i.test(card.name)).length, 1);
  for (const card of bees) assert.equal(names.unresolved(card), '', card.id);
});
check('Koga name and spacing aliases resolve to the correct card', () => {
  for (const query of ['독수의독침붕','독수의 독침붕','독수 독침붕','Koga Beedrill']) {
    const found = search(query);
    assert.equal(found.length, 1, query);
    assert.match(names.title(found[0]), /독수의 독침붕/);
  }
});
check('foreign title and image editions never enter Japanese search', () => {
  for (const id of ['999990001','999990002','261177','756336']) assert.equal(search(id).length, 0, id);
});

const linked = bees.find(card => card.boxCode === 'S10P' && card.number === '069/067');
const unlinked = search('독수의독침붕')[0];
check('verified price links and unpriced source cards remain separate', () => {
  assert.equal(linked.productId, '96640');
  assert.equal(linked.minPrice, 123456);
  assert.equal(api.href(linked), '#price/96640');
  assert.equal(search('S10P069')[0].id, linked.id);
  assert.equal(unlinked.productId, null);
  assert.equal(unlinked.minPrice, undefined, 'An unverified candidate price must not be shown');
  assert.match(api.href(unlinked), /^\/\?set=Gym2&card=.+#cardinfo$/);
  assert.equal(unlinked.unprintedNumber, true);
  assert.match(unlinked.displayName, /독수의 독침붕 \[목록 018\]/);
  assert.equal(api.getProduct('96640').id, '96640');
});
check('the actual dropdown uses safe price or source-list destinations', () => {
  const start = html.indexOf('// 결과 클릭 → 카드 상세 페이지로');
  const end = html.indexOf('// 검색바 외부 클릭 시 결과 닫기', start);
  assert(start >= 0 && end > start);
  function click(id) {
    let listener;
    const location = {hash:'',href:''};
    const document = {addEventListener:(_type, fn) => {listener = fn;},getElementById:() => ({style:{},value:''})};
    vm.runInNewContext(html.slice(start, end), {window:{JapaneseCatalog:api},JapaneseCatalog:api,document,location});
    listener({target:{closest:selector => selector === '.search-result-item' ? {dataset:{cardId:id}} : null}});
    return location;
  }
  assert.equal(click(linked.id).href, '#price/96640');
  assert.equal(click(unlinked.id).href, api.href(unlinked));
  assert.equal(click('123456').hash, '#price/123456');
});
check('deployed entry points load the Japanese modules and shared links', () => {
  assert.match(html, /<script[^>]+src=["']\/assets\/japanese-card-names\.js(?:\?[^"']*)?["']/);
  assert.match(html, /<script[^>]+src=["']\/assets\/japanese-catalog\.js(?:\?[^"']*)?["']/);
  assert.match(text('assets/search-modal.js'), /JapaneseCatalog\.href\(c\)/);
  const worker = text('sw.js');
  for (const file of ['/data/japanese-catalog.json','/data/japanese-card-names-ko.json','/assets/japanese-card-names.js','/assets/japanese-catalog.js']) assert(worker.includes(file), 'Fresh cache policy missing ' + file);
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) if (!/\bsrc=|application\/(?:ld\+)?json/.test(script[1])) new vm.Script(script[2]);
});
check('runtime search preserves every original product, price, ID and artwork', () => {
  assert.equal(JSON.stringify(market), originalMarket);
  assert.equal(JSON.stringify(metadata), originalMetadata);
  assert.equal(JSON.stringify(catalogue), originalCatalogue);
});
console.log(JSON.stringify({passed:true,checks,sets:catalogue.sets.length,cards:catalogue.cards.length,beedrillResults:bees.length,koreanCatalogueTitles:true,sourceIdentities:['M6a:176','MF:49'],originalProductsPreserved:true,externalWrites:false}));
