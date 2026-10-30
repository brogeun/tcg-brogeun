'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const bridge=require('../assets/contained-card-prices.js'),match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js');
const read=name=>JSON.parse(fs.readFileSync(path.join(__dirname,'..',name),'utf8'));
const cards=read('data/cards-by-set/OP17.json').cards,products=read('data/all-cards.json').details,overrides=read('data/onepiece-card-overrides.json');
const services={match,loadProducts:async()=>products,loadOverrides:async()=>overrides,loadDetails:async()=>({cards:{}})};
const identity=card=>({...card,brand:'onepiece',language:'ja',boxCode:'OP17'});

test('reported Rocks manga card and the two other printings retain separate SNKR prices',async()=>{
 for(const [fullId,id,ask] of [['OP17-118','881671',1200],['OP17-118_p1','871063',2300],['OP17-118_p2','871062',510000]]){
  const card=cards.find(c=>c.fullId===fullId);assert(card,fullId);
  const target=await bridge.prepareTarget(identity(card),{services});
  assert.equal(target.snkrdunkId,id,fullId);assert.equal(target.snkrdunkStatus,'matched');
  let requests=0;const quote=await fallback.lookup(target,{fetchJson:async()=>{requests++;throw Error('SNKR price must block other sources');}});
  assert.equal(quote.source,'snkrdunk');assert.equal(quote.status,'priced');assert.equal(requests,0);
  const rendered=fallback.render({...quote,amount:ask,currency:'JPY'},{convert:n=>Math.floor(n*8.5131)});
  assert(rendered.includes('\u20a9'+Math.floor(ask*8.5131).toLocaleString('ko-KR')));assert.doesNotMatch(rendered,/JPY|USD|[$\u00a5]/);
 }
});

test('every 158 OP17 printed artworks resolves its reviewed product without changing editions',async()=>{
 const printings=cards.filter(c=>/^OP17-\d+(?:_p\d+)?$/.test(c.fullId));assert.equal(printings.length,158);
 const selected=new Set();let priced=0;
 for(const card of printings){
  const target=await bridge.prepareTarget(identity(card),{services});
  assert.equal(target.snkrdunkStatus,'matched',card.fullId);assert.equal(target.snkrdunkId,overrides[card.fullId.toUpperCase()],card.fullId);
  assert(!selected.has(target.snkrdunkId),'Two artworks cannot share a price product');selected.add(target.snkrdunkId);
  assert(!match.foreign(target.snkrProduct),card.fullId);
  if(Number(target.snkrProduct.minPrice)>0){const quote=fallback.resolve(target);assert.equal(quote.status,'priced',card.fullId);assert.equal(quote.source,'snkrdunk');priced++;}
 }
 assert(priced>100,'Existing source prices disappeared');
});
