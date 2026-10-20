'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const library = require('../assets/japanese-card-names.js');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const data = read('data/japanese-card-names-ko.json');
const supplemental = read('data/japanese-product-labels-ko.json');
const catalogueSource = fs.readFileSync(path.join(root, 'assets/japanese-catalog.js'), 'utf8');
const english = ['488126', '488127', '509330', '739358', '739359'];
const candidates = {
  '391128': 'JP:CP4:113/131',
  '427857': 'JP:VS:009/141',
  '435166': 'JP:VS-MANAPHY:001/019'
};
const product = (id, extra = {}) => ({id, brand:'pokemon', kind:'card', name:'Beedrill',
  productNumber:'pkmn-tcg-cp4-113', language:'ja', thumbnailUrl:'https://example.test/uuid.webp', ...extra});
const printed = id => ({id, name:'Beedrill', brand:'pokemon', kind:'card', language:'ja',
  boxCode:'X', setCode:'X', number:'001/100', productId:null, productIds:[],
  image:'https://example.test/verified-print.png', thumbnailUrl:'https://example.test/verified-print.png'});
function catalogue(cards, names = library.create(data)) {
  const context = {module:{exports:{}}, JapaneseCardNames:names, URLSearchParams};
  vm.runInNewContext(catalogueSource, context);
  const api = context.module.exports;
  api.configure({schemaVersion:1, sets:[{code:'X', name:'Example'}], cards});
  return api;
}

test('all eight image-reviewed entries survive in the source and generated dictionary', () => {
  for (const id of [...english, ...Object.keys(candidates)]) {
    assert.deepEqual(data.byId[id], supplemental.byId[id]);
    assert.equal(data.byId[id].reviewedAt, '2026-10-20');
    assert(data.byId[id].reviewEvidence.image.startsWith('https://cdn.snkrdunk.com/'));
  }
});

test('reviewed English editions override misleading Japanese metadata without changing names', () => {
  const names = library.create(data);
  for (const id of english) {
    const row = product(id);
    const original = JSON.stringify(row);
    assert.equal(names.language(row), 'en');
    assert.equal(names.candidateCatalogueId(row), null);
    assert.equal(names.title(row), '독침붕');
    assert.equal(JSON.stringify(row), original);
  }
});

test('reviews never spread through productId, catalogue identities, another game, or boxes', () => {
  const names = library.create(data);
  for (const id of english) {
    for (const row of [product('777777', {productId:id}), product('JP:X:001/100', {productId:id}),
      product(id, {_catalogue:true}), product(id, {brand:'onepiece'}), product(id, {kind:'box'})]) {
      assert.equal(names.language(row), 'ja');
      assert.equal(names.candidateCatalogueId(row), null);
    }
  }
  assert.equal(names.language(product('777777')), 'ja');
});

test('reviewed Japanese duplicates hide only in search and never supply printed prices', () => {
  const cards = Object.values(candidates).map(printed);
  const originalCards = JSON.stringify(cards);
  const products = Object.keys(candidates).map(id => product(id, {minPrice:987654321, currency:'JPY'}));
  const originalProducts = JSON.stringify(products);
  const api = catalogue(cards);
  api.setProducts(products);
  for (const [id, target] of Object.entries(candidates)) {
    assert.equal(api.find(id), undefined);
    const row = api.find(target);
    assert(row);
    assert.equal(row.productId, null);
    assert.equal(JSON.stringify(row.productIds), '[]');
    assert.equal(row.minPrice, undefined);
    assert.equal(row.thumbnailUrl, 'https://example.test/verified-print.png');
    assert.equal(api.href(row), '/?set=X&card=001%2F100#cardinfo');
    assert.equal(api.getProduct(id).minPrice, 987654321, 'Original market detail remains intact');
  }
  assert.equal(JSON.stringify(products), originalProducts);
  assert.equal(JSON.stringify(cards), originalCards);
});

test('missing, foreign, wrong-brand, and non-card canonical targets never hide a market product', () => {
  const id = '391128', target = candidates[id];
  for (const cards of [[], [printed('JP:X:OTHER')], [printed(target)].map(row=>({...row,brand:'onepiece'})),
    [printed(target)].map(row=>({...row,kind:'box'})), [printed(target)].map(row=>({...row,name:'Beedrill [EN]'}))]) {
    const api = catalogue(cards);
    api.setProducts([product(id)]);
    assert(api.find(id), JSON.stringify(cards));
  }
});

test('unreviewed cards, boxes, and other-game products retain their original search rows', () => {
  for (const row of [product('777777'), product('391128', {brand:'onepiece'}), product('391128', {kind:'box'})]) {
    const api = catalogue(Object.values(candidates).map(printed));
    api.setProducts([row]);
    assert(api.find(row.id));
  }
});

test('review lookups follow each configured dictionary and retain existing Korean name overrides', () => {
  const reviewed = library.create({...data, byId:{'123':{language:'en',nameKo:'독침붕',candidateCatalogueId:'JP:X:001/100'}}});
  const plain = library.create({...data, byId:{}});
  assert.equal(reviewed.language(product('123')), 'en');
  assert.equal(reviewed.title(product('123', {name:'Wrong name'})), '독침붕');
  assert.equal(reviewed.candidateCatalogueId(product('123')), 'JP:X:001/100');
  assert.equal(plain.language(product('123')), 'ja');
  reviewed.configure({...data, byId:{}});
  assert.equal(reviewed.language(product('123')), 'ja');
  assert.equal(reviewed.candidateCatalogueId(product('123')), null);
});

test('lazy browser dictionary loading enables the same reviewed lookups', async () => {
  let requests = 0;
  const context = {window:{}, AbortSignal, fetch:async()=>{
    requests++;
    return {ok:true, json:async()=>data};
  }};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/japanese-card-names.js'), 'utf8'), context);
  const names = context.window.JapaneseCardNames;
  assert.equal(names.language(product(english[0])), 'ja');
  await Promise.all([names.ensureData(), names.ensureData()]);
  assert.equal(requests, 1);
  assert.equal(names.language(product(english[0])), 'en');
  assert.equal(names.candidateCatalogueId(product('391128')), candidates['391128']);
});
