'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('index.html','utf8');
const product={id:'871062',name:'Rocks Manga [OP17-118]',brand:'onepiece',kind:'card',minPrice:510000,currency:'JPY',thumbnailUrl:'https://cdn.snkrdunk.com/rocks.webp'};
const extract=name=>{const start=source.indexOf('async function '+name+'(');assert(start>=0);return source.slice(start,source.indexOf('\n}\n',start)+3);};
test('the real slide renderer keeps selected local artwork after market metadata enrichment',async()=>{
 const stopped=Error('image rendered');let html='';
 const imageHost={set innerHTML(value){html=value;throw stopped;}};
 const badImage='https://www.onepiece-cardgame.com/images/cardlist/card/OP01-016_p9.png';
 const selectedImage='/images/onepiece-official/OP01-016_p9.webp';
 const ctx=vm.createContext({console,FX_READY:Promise.resolve(),SLIDE_PANEL_REQUEST:1,CURRENT_SLIDE_ID:product.id,HOME_TOP_CACHE:{onepiece:[{...product,image:badImage,reviewedPrice:true}]},PRICE_CACHE:{},PRICE_CAT:'card',
  fetch:async()=>({ok:false}),loadCardsDetail:async()=>({cards:{}}),isCardProduct:()=>true,enrichPriceProductMetadata:async rows=>{rows[0].image=badImage;},
  escapeHtml:value=>String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;'),
  document:{getElementById:id=>id==='slideCardImg'?imageHost:{}},window:{}});
 vm.runInContext(extract('renderSlidePanel'),ctx);
 await assert.rejects(()=>ctx.renderSlidePanel(product.id,1,selectedImage),error=>error===stopped);
 assert.match(html,/src="\/images\/onepiece-official\/OP01-016_p9.webp"/);
 assert.doesNotMatch(html,/src="https:\/\/www.onepiece-cardgame.com/);
});
test('opening a known SNKR product in the slide panel succeeds while search metadata is unavailable',async()=>{
 const stopped=Error('product reached detail renderer');let seen;
 const ctx=vm.createContext({console,FX_READY:Promise.resolve(),SLIDE_PANEL_REQUEST:1,CURRENT_SLIDE_ID:'871062',HOME_TOP_CACHE:{},PRICE_CACHE:{},PRICE_CAT:'onepiece',
  loadCardProductData:async()=>[product],loadCardSearchData:async()=>{throw Error('Search metadata offline');},fetch:async()=>({ok:false}),
  isCardProduct:()=>true,enrichPriceProductMetadata:async()=>{},
  window:{PriceProductInfo:{get:async p=>{seen=p;throw stopped;}}},
  PriceProductInfo:{get:async p=>{seen=p;throw stopped;}}});
 vm.runInContext(extract('renderSlidePanel'),ctx);
 await assert.rejects(()=>ctx.renderSlidePanel('871062',1),error=>error===stopped);
 assert.equal(seen.id,'871062');assert.equal(seen.minPrice,510000);
});
test('opening the full detail page shares the raw product catalogue without search initialization',async()=>{
 let seen;const panel={dataset:{},style:{},innerHTML:''};
 const ctx=vm.createContext({console,FX_READY:Promise.resolve(),PRICE_DETAIL_REQUEST:0,HOME_TOP_CACHE:{},PRICE_CACHE:{},
  document:{body:{dataset:{page:'price'}},getElementById:()=>panel},location:{hash:'#price/871062'},parsePageRoute:()=>({productId:'871062'}),
  loadCardProductData:async()=>[product],loadCardSearchData:async()=>{throw Error('Search offline');},fetch:async()=>({ok:false}),
  window:{renderExpandedPriceDetail:async(id,p)=>{seen=p;}}});
 vm.runInContext(extract('showPriceDetailPanel'),ctx);await ctx.showPriceDetailPanel('871062');
 assert.equal(seen.id,'871062');assert.equal(seen.lowestAsk,510000);assert.equal(seen.currency,'JPY');
});

test('live cached quotes preserve their actual currency and artwork in the full detail view',async()=>{
 const bridge=require('../assets/contained-card-prices.js');
 bridge.cacheProduct({...product,grades:{raw:{lowest_ask:500,currency:'USD'}},currency:'USD',minPrice:500,gradeCheckedAt:new Date().toISOString()});
 const prepared=bridge.getPreparedProduct('871062');assert.equal(prepared.image,product.thumbnailUrl);
 let seen;const panel={dataset:{},style:{},innerHTML:''};
 const ctx=vm.createContext({console,FX_READY:Promise.resolve(),PRICE_DETAIL_REQUEST:0,HOME_TOP_CACHE:{onepiece:[product]},PRICE_CACHE:{},
  document:{body:{dataset:{page:'price'}},getElementById:()=>panel},location:{hash:'#price/871062'},parsePageRoute:()=>({productId:'871062'}),
  fetch:async()=>({ok:false}),window:{ContainedCardPrices:bridge,renderExpandedPriceDetail:async(id,p)=>{seen=p;}}});
 vm.runInContext(extract('showPriceDetailPanel'),ctx);await ctx.showPriceDetailPanel('871062');
 assert.equal(seen.grades.raw.lowest_ask,500);assert.equal(seen.grades.raw.currency,'USD');assert.equal(seen.image,product.thumbnailUrl);
});
