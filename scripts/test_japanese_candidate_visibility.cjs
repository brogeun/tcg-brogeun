'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const names = require('../assets/japanese-card-names.js').create(read('data/japanese-card-names-ko.json'));
const source = fs.readFileSync(path.join(root, 'assets/japanese-catalog.js'), 'utf8');
function catalogue(data, products) {
  const context = {module:{exports:{}}, JapaneseCardNames:names, URLSearchParams};
  vm.runInNewContext(source, context);
  const api = context.module.exports;
  api.configure(data);
  api.setProducts(products);
  return api;
}
const codes = new Set(['SV4K', 'M2a', 'SV2a', 'SV8a']);
const data = read('data/japanese-catalog.json');
const selected = {...data, sets:data.sets.filter(set=>codes.has(set.code)), cards:data.cards.filter(card=>codes.has(card.boxCode || card.setCode))};
const prices = read('data/cards-prices.json').prices;
const products = read('data/cards-meta.json').cards.filter(card=>card.brand==='pokemon' && [...codes].some(code=>
  new RegExp('(?:^|[-\\s\\[])'+code+'(?:[-\\s]|$)', 'i').test([card.productNumber,card.name].join(' '))))
  .map(card=>({...card, id:String(card.id), nameLower:card.name.toLowerCase(), minPrice:prices[card.id]?.[0], currency:prices[card.id]?.[1]}));
const api = catalogue(selected, products);
const matches = query => api.getSearchRows().filter(card=>card.kind==='card' && api.matches(card, query));

test('M2a Psyduck base and both distinct mirrors remain searchable with their own market identity', () => {
  const canonical = api.find('JP:M2a:032/193');
  assert.equal(canonical.productId, '730078');
  assert.equal(api.find('730078'), undefined, 'confirmed base market duplicate stays suppressed');
  for (const [id, finish] of [['732652', /Monster Ball Mirror/], ['732653', /Energy Mark Mirror/]]) {
    const mirror = api.find(id);
    assert(mirror, 'candidate-only mirror disappeared: '+id);
    assert.match(mirror.name, finish);
    assert.equal(api.href(mirror), '#price/'+id);
    assert.notEqual(mirror.thumbnailUrl, canonical.thumbnailUrl);
    assert(matches('M2a').some(row=>row.id===id));
  }
});

test('151 and Terastal Festival retain Monster Ball and Master Ball market printings', () => {
  for (const id of ['127809', '128147', '471586', '471633']) {
    const row = api.find(id);
    assert(row, 'distinct Ball Mirror disappeared: '+id);
    assert.match(row.name, /(?:Monster|Master) Ball Mirror/);
    assert.equal(api.href(row), '#price/'+id);
  }
});

test('Ancient Roar keeps all 95 cards for Korean, English and set-code searches', () => {
  for (const query of ['고대의 포효', 'Ancient Roar', 'SV4K']) {
    const rows = matches(query);
    assert.equal(rows.length, 95, query);
    assert.equal(rows.filter(row=>row._catalogue).length, 95);
  }
});

test('restoring candidates never admits foreign editions into Japanese search', () => {
  const foreign = products.filter(product=>names.language(product)!=='ja');
  assert(foreign.length>0, 'fixture includes real foreign products');
  for (const product of foreign) assert.equal(api.find(product.id), undefined, product.id+' '+product.name);
  for (const row of api.getSearchRows()) assert.equal(names.language(row), 'ja');
});

test('unconfirmed candidates retain their own price without supplying a canonical price, artwork or link', () => {
  const image = '/images/printed-card.webp';
  const card = {id:'JP:X:001/100', brand:'pokemon', kind:'card', language:'ja', boxCode:'X', setCode:'X',
    number:'001/100', name:'Psyduck', productId:null, productIds:[], candidateProductIds:['123'], image, thumbnailUrl:image};
  const market = {id:'123', brand:'pokemon', kind:'card', language:'ja', name:'Psyduck: Mirror [X 001/100]',
    productNumber:'pkmn-tcg-X-001', thumbnailUrl:'/images/market-mirror.webp', minPrice:987654321, currency:'JPY'};
  const fixture = catalogue({schemaVersion:1, sets:[{code:'X', name:'Example'}], cards:[card]}, [market]);
  const printed = fixture.find(card.id);
  assert(fixture.find(market.id), 'unconfirmed market candidate remains visible');
  assert.equal(printed.productId, null);
  assert.equal(printed.minPrice, undefined);
  assert.equal(printed.thumbnailUrl, image);
  assert.equal(fixture.href(printed), '/?set=X&card=001%2F100#cardinfo');
  assert.equal(fixture.find(market.id).minPrice, 987654321);
  assert.equal(fixture.href(fixture.find(market.id)), '#price/123');
});

test('vintage search uses the repaired local artwork while preserving source identity and price links', () => {
  const sourceImage='https://static.tcgcollector.com/content/images/old-source.jpg';
  const localImage='/images/pokemon-vintage/Neo1/29521.webp';
  const card={id:'JP:Neo1:source-no-004',brand:'pokemon',kind:'card',language:'ja',boxCode:'Neo1',setCode:'Neo1',
    number:'',name:'Spinarak (Gold, Silver, to a New World... No. 004)',image:sourceImage,thumbnailUrl:sourceImage,
    localImage,productId:null,productIds:[]};
  const fixture=catalogue({schemaVersion:1,sets:[{code:'Neo1',name:'금, 은, 신세계로'}],cards:[card]},[]);
  const row=fixture.find(card.id);
  assert.equal(row.thumbnailUrl,localImage);
  assert.equal(row.image,sourceImage,'Artwork proof keys retain the original source image');
  assert.equal(row.productId,null);
  assert.equal(row.minPrice,undefined);
  assert.equal(fixture.href(row),'/?set=Neo1&card=JP%3ANeo1%3Asource-no-004#cardinfo');
});
