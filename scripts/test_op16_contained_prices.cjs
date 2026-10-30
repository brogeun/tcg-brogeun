'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const bridge=require('../assets/contained-card-prices.js'),match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
test('all 149 OP16 regular artworks retain independent exact SNKR products',async()=>{
 const cards=read('data/cards-by-set/OP16.json').cards.filter(c=>/^OP16-\d+(?:_p\d+)?$/.test(c.fullId)),products=read('data/all-cards.json').details;
 assert.equal(cards.length,149);const ids=new Set(),artwork=read('data/contained-card-market-links.json');
 const services={match,loadProducts:async()=>products,loadOverrides:async()=>read('data/onepiece-card-overrides.json'),loadDetails:async()=>({cards:{}}),loadArtworkBindings:async()=>artwork};
 for(const card of cards){
  const target=await bridge.prepareTarget({...card,brand:'onepiece',language:'ja',boxCode:'OP16'},{services});
  assert.equal(target.snkrdunkStatus,'matched',card.fullId);assert(!ids.has(target.snkrdunkId),card.fullId);ids.add(target.snkrdunkId);
  if(target.snkrProduct.minPrice>0){const quote=fallback.resolve(target);assert.equal(quote.source,'snkrdunk');assert.equal(quote.status,'priced');}
 }
});
