'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const match=require('../assets/contained-card-match.js'),bridge=require('../assets/contained-card-prices.js'),fallback=require('../assets/card-price-fallback.js');
const source={brand:'onepiece',language:'ja',boxCode:'OP16',setCode:'OP16',number:'001_P1',fullId:'OP16-001_p1',image:'/images/onepiece/OP16-001_p1.png'};
const product={id:'900001',brand:'onepiece',language:'ja',kind:'card',name:'Ace L-P [OP16-001]',productNumber:'OP16-001',thumbnailUrl:'https://cdn.snkrdunk.com/upload_bg_removed/reviewed.webp?size=m',minPrice:1200,currency:'JPY',listingCount:1};
function record(target=source,p=product){return {...target,id:p.id,marketName:p.name,marketProductNumber:p.productNumber,marketImage:p.thumbnailUrl,sourceSHA256:'a'.repeat(64),marketSHA256:'b'.repeat(64)};}

test('reviewed artwork repairs a missing OP16 variant without assigning the plain card price',()=>{
 const plain={...product,id:'900002',name:'Ace L [OP16-001]',thumbnailUrl:'https://cdn.snkrdunk.com/upload_bg_removed/plain.webp'};
 assert.notEqual(match.resolve(source,[product,plain]).status,'matched');
 const links=bridge.reviewedArtworkLinks([source],[product,plain],{schemaVersion:1,links:[record()]},match);
 assert.equal(match.createResolver([product,plain],links)(source).id,product.id);
 for(const patch of [{fullId:'OP16-001_p2'},{image:'/images/onepiece/OP16-001_p2.png'},{setCode:'OP17'},{number:'002_P1'},{language:'en'}]){
  assert.deepEqual(bridge.reviewedArtworkLinks([{...source,...patch}],[product],{schemaVersion:1,links:[record()]},match),{});
 }
 for(const patch of [{name:'Different edition [OP16-001]'},{productNumber:'OP16-002'},{language:'en'},{thumbnailUrl:'https://cdn.snkrdunk.com/upload_bg_removed/other.webp'}]){
  assert.deepEqual(bridge.reviewedArtworkLinks([source],[{...product,...patch}],{schemaVersion:1,links:[record()]},match),{});
 }
});

test('same printed Pokemon number with different artwork keeps separate reviewed products',()=>{
 const make=(id,image)=>({brand:'pokemon',language:'ja',boxCode:'SV2A',setCode:'SV2A',number:'001/165',image});
 const a=make('1','https://static.tcgcollector.com/a.webp'),b=make('2','https://static.tcgcollector.com/b.webp');
 const x={...product,id:'900010',brand:'pokemon',name:'Bulbasaur C [SV2a 001/165]',productNumber:'PKMN-TCG-SV2A-001',thumbnailUrl:'https://cdn.snkrdunk.com/a.webp'};
 const y={...x,id:'900011',name:'Bulbasaur Mirror [SV2a 001/165]',thumbnailUrl:'https://cdn.snkrdunk.com/b.webp'};
 const links=bridge.reviewedArtworkLinks([a,b],[x,y],{schemaVersion:1,links:[record(a,x),record(b,y)]},match),resolve=match.createResolver([x,y],links);
 assert.equal(resolve(a).id,x.id);assert.equal(resolve(b).id,y.id);
});

test('source product IDs require identical artwork and cannot become implicit official ID links',()=>{
 const own={...source,id:product.id,image:product.thumbnailUrl};
 assert.equal(match.createResolver([product],bridge.reviewedArtworkLinks([own],[product],null,match))(own).id,product.id);
 assert.deepEqual(bridge.reviewedArtworkLinks([{...source,id:product.id}],[product],null,match),{});
});

test('a pending artwork link is not reported as confirmed absence and never queries other shops',async()=>{
 let calls=0;const result=await fallback.lookup({...source,game:'onepiece',fullNumber:'OP16-001',snkrdunkStatus:'artwork-pending'},{fetchJson:async()=>{calls++;throw Error('Unconfirmed SNKR must block fallback');}});
 assert.equal(result.status,'unknown');assert.equal(result.reason,'unlinked-artwork');assert.equal(calls,0);
 assert.doesNotMatch(fallback.render(result),/확인된 가격 없음/);
});

test('price lookup does not wait indefinitely for the display FX request',async()=>{
 globalThis.TCGFX={ready:new Promise(()=>{}),convert:n=>n*10};
 try{
  const result=await Promise.race([fallback.lookup({...source,game:'onepiece',fullNumber:'OP16-001',snkrdunkId:product.id,snkrProduct:product}),new Promise((_,reject)=>setTimeout(()=>reject(Error('Price lookup hung behind FX')),1000))]);
  assert.equal(result.source,'snkrdunk');assert.equal(result.amount,1200);
 }finally{delete globalThis.TCGFX;}
});

test('contained prices use the market catalogue even if search catalogue initialization fails',async()=>{
 const context={URL,AbortSignal,console,ContainedCardMatch:match,loadCardProductData:async()=>[product],loadCardSearchData:async()=>{throw Error('Search initialization must not gate prices');}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/contained-card-prices.js'),'utf8'),context);
 const plain={...source,number:'001',fullId:'OP16-001'};
 const prepared=await context.ContainedCardPrices.prepareTarget(plain,{services:{loadOverrides:async()=>({'OP16-001':product.id}),loadDetails:async()=>({cards:{}})}});
 assert.equal(prepared.snkrdunkId,product.id);assert.equal(prepared.sourceUnavailable,false);
});

test('a missing USD catalogue ask checks the exact Japanese SNKR price before other shops',async()=>{
 const p={...product,minPrice:null,listingCount:0,priceStatus:'no-listings'};
 let shops=0,live=0;const target={...source,game:'onepiece',fullNumber:'OP16-001',snkrdunkId:p.id,snkrProduct:p};
 const quote=await fallback.lookup(target,{loadSnkrQuote:async id=>{live++;return {ok:true,id,fetchedAt:new Date().toISOString(),grades:{raw:{lowest_ask:7700,currency:'JPY'}},noListingGrades:[]};},fetchJson:async()=>{shops++;throw Error('JP SNKR price must win');}});
 assert.equal(quote.source,'snkrdunk');assert.equal(quote.amount,7700);assert.equal(quote.currency,'JPY');assert.equal(live,1);assert.equal(shops,0);
});

test('an exact shop fallback is allowed only after Japanese SNKR confirms no raw listing',async()=>{
 const p={...product,name:'Ace L [OP16-001]',minPrice:null,listingCount:0,priceStatus:'no-listings'};
 const target={...source,game:'onepiece',number:'001',fullId:'OP16-001',fullNumber:'OP16-001',rarity:'L',snkrdunkId:p.id,snkrProduct:p};
 const row={id:'shop:1',game:'onepiece',language:'ja',grade:'raw',setCode:'OP16',cardNumber:'OP16-001',rarity:'L',name:'Ace',price:100,currency:'JPY',priceKind:'asking',sourceUrl:'https://yuyu-tei.jp/sell/opc/card/op16/10001'};
 let live=0;const quote=await fallback.lookup(target,{loadSnkrQuote:async id=>{live++;return {ok:true,id,fetchedAt:new Date().toISOString(),grades:{},noListingGrades:['raw']};},yuyuRows:[row],mercariReferences:[]});
 assert.equal(live,1);assert.equal(quote.source,'yuyutei');assert.equal(quote.amount,100);
});

test('a failed or inconclusive Japanese SNKR request cannot be called no price',async()=>{
 for(const load of [async()=>{throw Error('offline');},async id=>({ok:true,id,fetchedAt:new Date().toISOString(),grades:{}})]){
  let shops=0;const p={...product,minPrice:null,listingCount:0,priceStatus:'no-listings'};
  const quote=await fallback.lookup({...source,game:'onepiece',fullNumber:'OP16-001',snkrdunkId:p.id,snkrProduct:p},{loadSnkrQuote:load,fetchJson:async()=>{shops++;return {};}});
  assert.equal(quote.status,'unknown');assert.equal(shops,0);
 }
});

test('an owned additional-game product with unknown edition can recover its exact Japanese quote',async()=>{
 const p={...product,brand:'dragon_ball_fusion_world',language:'unknown',name:'Source [FB11-020]',productNumber:'DBSC-TCG-FB11-020',minPrice:null,listingCount:0,priceStatus:'no-listings'};
 const quote=await fallback.lookup({game:p.brand,language:'unknown',catalogSource:'SNKRDUNK',fullNumber:'FB11-020',snkrdunkId:p.id,snkrProduct:p},{loadSnkrQuote:async id=>({ok:true,id,fetchedAt:new Date().toISOString(),grades:{raw:{lowest_ask:4500,currency:'JPY'}}})});
 assert.equal(quote.source,'snkrdunk');assert.equal(quote.amount,4500);assert.equal(quote.editionVerification,'unconfirmed');
});

test('a late FX response refreshes the visible won amount without re-querying a price',()=>{
 let available=false,listener,strong={textContent:''};const host={dataset:{cpfRender:'1'},querySelector:()=>strong};
 const context={module:{exports:{}},TCGFX:{convert:n=>Math.floor(n*1300),getState:()=>({available})},document:{querySelectorAll:()=>[host]},addEventListener:(name,fn)=>{if(name==='tcg:fx-updated')listener=fn;}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/card-price-fallback.js'),'utf8'),context);
 const quote={status:'priced',source:'snkrdunk',amount:10,currency:'USD'};
 assert.match(context.module.exports.render(quote),/환율 확인 중/);
 available=true;listener();assert.equal(strong.textContent,'₩13,000');assert.equal(quote.amount,10);assert.equal(quote.currency,'USD');
});
