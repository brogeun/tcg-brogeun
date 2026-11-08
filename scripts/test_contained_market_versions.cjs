'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const bridge=require('../assets/contained-card-prices.js'),match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js');
const candidates=require('../assets/contained-card-candidates.js');
const target={brand:'pokemon',language:'ja',boxCode:'XY3',setCode:'XY3',number:'001/096',name:'Bellsprout (Rising Fist 001/096)',image:'https://static.tcgcollector.com/reviewed-card.jpg'};
const products=[
 {id:'390213',brand:'pokemon',kind:'card',language:'ja',name:'Bellsprout C :1ED [XY3 001/096](Expansion Pack "Rising Fist")',productNumber:'pkmn-tcg-XY3-001',thumbnailUrl:'https://cdn.snkrdunk.com/first.webp',minPrice:900,currency:'JPY',listingCount:2},
 {id:'390214',brand:'pokemon',kind:'card',language:'ja',name:'Bellsprout C [XY3 001/096](Expansion Pack "Rising Fist")',productNumber:'pkmn-tcg-XY3-001',thumbnailUrl:'https://cdn.snkrdunk.com/regular.webp',minPrice:300,currency:'JPY',listingCount:4}
];
function registry(){return {schemaVersion:1,links:[],variants:[{...target,sourceSHA256:'a'.repeat(64),versionCount:2,versions:products.map((p,i)=>({id:p.id,label:i?'일반판':'1ED',marketName:p.name,marketProductNumber:p.productNumber,marketImage:p.thumbnailUrl,marketSHA256:'b'.repeat(64)}))}]};}
const services=(doc=registry(),rows=products)=>({match,loadProducts:async()=>rows,loadArtworkBindings:async()=>doc,loadDetails:async()=>({cards:{}})});

test('verified editions retain two named products and never choose the cheapest one as the card price',async()=>{
 const prepared=await bridge.prepareTarget(target,{services:services()});
 assert.equal(prepared.snkrdunkStatus,'variant-linked');assert.equal(prepared.snkrProduct,undefined);assert.equal(prepared.snkrdunkId,undefined);
 assert.deepEqual(prepared.snkrVariants.map(v=>[v.label,v.id]),[['1ED','390213'],['일반판','390214']]);
 const q=fallback.resolve(prepared);assert.equal(q.status,'variants');assert.equal(q.amount,null);
 assert.deepEqual(q.variants.map(v=>[v.label,v.quote.amount]),[['1ED',900],['일반판',300]]);
 const html=fallback.render(q,{convert:n=>n*10});assert.match(html,/1ED/);assert.match(html,/일반판/);assert.match(html,/₩9,000/);assert.match(html,/₩3,000/);assert.doesNotMatch(html,/카드별 가격 연결 확인 필요/);
 assert.match(html,/https:\/\/snkrdunk.com\/apparels\/390213/);
 const choices=candidates.render(prepared);assert.match(choices,/data-contained-market-id="390213"/);assert.match(choices,/data-contained-market-id="390214"/);assert.match(choices,/1ED 시세·거래내역/);assert.doesNotMatch(choices,/판본 확인이 필요한 상품|사진을 비교한 뒤/);
});

test('version receipts bind the exact source, number, language and current market images',()=>{
 for(const patch of [{image:'https://static.tcgcollector.com/other.jpg'},{setCode:'XY4'},{number:'002/096'},{language:'en'},{brand:'onepiece'},{bundle:true}])
  assert.deepEqual(bridge.reviewedArtworkVariants([{...target,...patch}],products,registry(),match),{});
 for(const patch of [{name:'Different [XY3 001/096]'},{thumbnailUrl:'https://cdn.snkrdunk.com/replaced.webp'},{productNumber:'pkmn-tcg-XY3-002'},{language:'en'}])
  assert.deepEqual(bridge.reviewedArtworkVariants([target],[{...products[0],...patch},products[1]],registry(),match),{});
});

test('incomplete or duplicate version evidence remains unconfirmed',async()=>{
 for(const mutate of [r=>r.variants[0].versions.pop(),r=>r.variants[0].versions[1].id=products[0].id,r=>r.variants[0].versions[1].label='1ED',r=>r.variants[0].versions[0].marketSHA256='',r=>r.variants[0].sourceSHA256='']){
  const doc=registry();mutate(doc);const p=await bridge.prepareTarget(target,{services:services(doc)});assert.equal(p.snkrdunkStatus,'ambiguous');assert.equal(p.snkrVariants,undefined);
 }
});

test('one verified first edition is displayed as that named edition without becoming a generic card quote',async()=>{
 const doc=registry();doc.variants[0].versionCount=1;doc.variants[0].versions=doc.variants[0].versions.slice(0,1);
 const p=await bridge.prepareTarget({...target,marketLinkPolicy:'verified-only'},{services:services(doc,products.slice(0,1))});
 assert.equal(p.snkrdunkStatus,'variant-linked');const quote=fallback.resolve(p);assert.equal(quote.status,'variants');assert.equal(quote.amount,null);assert.equal(quote.variants.length,1);assert.equal(quote.variants[0].label,'1ED');assert.equal(quote.variants[0].quote.amount,900);
});

test('current raw grade details update each edition independently',async()=>{
 const s=services();s.loadDetails=async()=>({cards:{390213:{fetchedAt:'2026-11-08T05:00:00Z',grades:{raw:{lowest_ask:1200,currency:'JPY'}}}}});
 const p=await bridge.prepareTarget(target,{services:s}),q=fallback.resolve(p);
 assert.deepEqual(q.variants.map(v=>v.quote.amount),[1200,300]);
});

test('an established single-artwork binding keeps its existing direct quote',async()=>{
 const doc=registry();doc.links=[{...target,id:products[0].id,marketName:products[0].name,marketProductNumber:products[0].productNumber,marketImage:products[0].thumbnailUrl,sourceSHA256:'a'.repeat(64),marketSHA256:'b'.repeat(64)}];
 const p=await bridge.prepareTarget(target,{services:services(doc)});assert.equal(p.snkrdunkStatus,'matched');assert.equal(p.snkrdunkId,'390213');assert.equal(p.snkrVariants,undefined);
});

test('missing edition prices check their own SNKR product and do not borrow another shop edition',async()=>{
 const rows=products.map(p=>({...p,minPrice:null,listingCount:0,priceStatus:'no-listings'}));
 const p=await bridge.prepareTarget(target,{services:services(registry(),rows)});let shops=0;const ids=[];
 const q=await fallback.lookup(p,{loadSnkrQuote:async id=>{ids.push(id);return {ok:true,id,fetchedAt:new Date().toISOString(),grades:id==='390213'?{raw:{lowest_ask:1100,currency:'JPY'}}:{},noListingGrades:id==='390214'?['raw']:[]};},fetchJson:async()=>{shops++;throw Error('Unknown shop edition');}});
 assert.equal(shops,0);assert.deepEqual(ids.sort(),['390213','390214']);assert.equal(q.variants[0].quote.amount,1100);assert.equal(q.variants[1].quote.status,'none');
});

test('version names are escaped and all displayed prices remain in won',()=>{
 const q={status:'variants',variants:[{label:'<script>bad</script>',quote:{status:'priced',source:'snkrdunk',amount:10,currency:'JPY'}}]};
 const html=fallback.render(q,{convert:n=>n*10});assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/₩100/);assert.doesNotMatch(html,/¥|\$10/);
});
