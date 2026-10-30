const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const bridge=require('../assets/contained-card-prices.js'),match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js');
const read=f=>JSON.parse(fs.readFileSync(path.join(__dirname,'..',f),'utf8'));
const cards=read('data/cards-by-set/EB05.json').cards,products=read('data/onepiece-eb05-market.json').products;
const identity=c=>({...c,brand:'onepiece',language:'ja',boxCode:'EB05'});
const merged=bridge.mergeSetProducts([],products);
test('all 100 contained artworks have a distinct reviewed Japanese product',()=>{
 const links=bridge.reviewedSetLinks(cards.map(identity),merged,cards,match);
 assert.equal(Object.keys(links).length,100);assert.equal(new Set(Object.values(links).map(p=>p.id)).size,100);
 for(const c of cards){const t=identity(c),result=match.resolve(bridge.targetFor(t),merged,links);assert.equal(result.status,'matched',c.fullId);assert.equal(result.id,c.marketProductId,c.fullId);}
});
test('same number cannot cross artwork, edition, box, printed number or market ID',()=>{
 const card=cards.find(c=>c.marketProductId==='911917'),target=identity(card);
 for(const altered of [{...target,image:cards.find(c=>c.marketProductId==='911918').image},{...target,language:'en'},{...target,boxCode:'EB03'},{...target,number:'061'}])assert.deepEqual(bridge.reviewedSetLinks([altered],merged,cards,match),{});
 for(const altered of [{language:'en'},{fullId:'EB05-055_SNKR911918'},{productNumber:'EB05-061'},{id:'123'}])assert.deepEqual(bridge.reviewedSetLinks([target],merged.map(p=>p.id===card.marketProductId?{...p,...altered}:p),cards,match),{});
});
test('all source-checked Japanese A-grade asks and absences survive the actual price pipeline',async()=>{
 let priced=0;
 for(const c of cards){const p=products.find(p=>p.id===c.marketProductId),quote={ok:true,id:p.id,fetchedAt:new Date().toISOString(),grades:p.grades,noListingGrades:p.noListingGrades};
 const t=await bridge.prepareTarget(identity(c),{services:{match,loadProducts:async()=>[],loadSetProducts:async()=>products,loadSetCards:async()=>cards,loadOverrides:async()=>({}),loadDetails:async()=>({cards:{}}),loadLiveQuote:async()=>quote}});
 assert.equal(t.snkrdunkId,p.id,c.fullId);assert.equal(t.sourceUnavailable,false,c.fullId);const result=fallback.resolve(t);
 if(p.minPrice>0){priced++;assert.equal(result.amount,p.minPrice,c.fullId);assert.equal(result.currency,'JPY');assert.equal(result.condition,'raw');}else assert.equal(result.status,'none',c.fullId);
 }assert.equal(priced,products.filter(p=>p.minPrice>0).length);
});
test('no listing clears an old USD ask and stale/mismatched quotes fail closed',()=>{
 const p={id:'911918',minPrice:327,currency:'USD',catalogAsk:{amount:327,currency:'USD',kind:'lowest_listing_ask'}};
 const q={ok:true,id:p.id,fetchedAt:new Date().toISOString(),grades:{},noListingGrades:['raw']};
 const clean=bridge.withLiveQuote(p,q);assert.equal(clean.minPrice,null);assert.equal(clean.catalogAsk,null);assert.equal(clean.listingCount,0);
 for(const bad of [{...q,id:'911917'},{...q,fetchedAt:'2020-01-01'},{...q,noListingGrades:[]},{...q,grades:{raw:{lowest_ask:327,currency:'USD'}}}])assert.throws(()=>bridge.withLiveQuote(p,bad));
});
test('live source failure cannot resurrect the recorded snapshot',async()=>{
 const c=cards.find(c=>c.marketProductId==='911919');const t=await bridge.prepareTarget(identity(c),{services:{match,loadProducts:async()=>[],loadSetProducts:async()=>products,loadSetCards:async()=>cards,loadOverrides:async()=>({}),loadDetails:async()=>({cards:{}}),loadLiveQuote:async()=>{throw Error('offline')}}});assert.equal(t.sourceUnavailable,true);
});
