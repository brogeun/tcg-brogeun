import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const info=require('../assets/price-product-info.js');
const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const html=read('index.html');
const start=html.indexOf('const CARDINFO = {');
const list={innerHTML:''},filters={};
const ctx=vm.createContext({
  window:{JapaneseSetArtwork:require('../assets/japanese-set-artwork.js')},
  document:{getElementById:id=>id==='cardInfoList'?list:filters},
  escapeHtml:String,
});
const end=html.indexOf('let CI_PANEL_REQUEST',start);
assert.ok(start>=0&&end>start,'The catalogue and set tile renderer must be available');
vm.runInContext(html.slice(start,end)+';globalThis.catalog=CARDINFO;',ctx);
for(const [code,count,boxId,numbered,pending] of [['M6a',176,'881421',165,8],['MF',49,'881423',44,0]]){
  const data=JSON.parse(read('data/cards-by-set/'+code+'.json'));
  const set=ctx.catalog.pokemon.find(s=>s.code===code);
  assert.equal(set.boxId,boxId);
  assert.equal(set.release,'2026.09.16');
  assert.ok(set.image.startsWith('https://cdn.snkrdunk.com/'));
  ctx.requestedSet=code;
  vm.runInContext('CI_QUERY=requestedSet;renderCardInfo();',ctx);
  const photo=set.imageVersion?`${set.image}?v=${set.imageVersion}`:set.image;
  assert.ok(list.innerHTML.includes(`src="${photo}"`),code+' must display its reviewed box photo');
  assert.equal(info.resolve({id:boxId},'pokemon',true,ctx.catalog).sets[0].code,code);
  const original=data.cards.filter(c=>!c.marketSupplement);
  assert.equal(original.length,count);
  assert.equal(data.cardCount,data.cards.length);
  assert.equal(new Set(data.cards.map(c=>c.sourceId)).size,data.cardCount);
  assert.equal(new Set(data.cards.map(c=>c.url)).size,data.cardCount);
  assert.ok(data.pendingImageCount<=pending);
  assert.equal(data.cards.filter(c=>c.imageStatus==='pending').length,data.pendingImageCount);
  for(let n=1;n<=numbered;n++)assert.ok(data.cards.some(c=>c.number===`${String(n).padStart(3,'0')}/${code==='M6a'?'103':'040'}`));
  for(const card of data.cards){
    assert.ok(!card.id,'Collector IDs must not be used as market IDs');
    assert.ok(card.url.startsWith(card.marketSupplement?'https://snkrdunk.com/apparels/':'https://www.tcgcollector.com/cards/'));
    if(card.imageStatus==='pending')assert.equal(card.image,'');
    else assert.ok(/^https:\/\/(static.tcgcollector.com\/content\/images|cdn.snkrdunk.com)\//.test(card.image));
    if(card.number.startsWith('No.'))assert.equal(card.unprintedNumber,true);
  }
  if(code==='M6a')for(const color of ['R','G','B'])assert.ok(data.cards.some(c=>c.number===color+'/RGB'));
}
assert.match(html,/이미지 준비 중/);
assert.match(html,/c.unprintedNumber \? ''/);
console.log('PASS: M6a 176 + MF 49 entries, every numbered card, RGB Mew, unnumbered energies, pending images, unique source IDs, exact box-price links');
