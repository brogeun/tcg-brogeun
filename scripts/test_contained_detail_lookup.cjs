'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('index.html','utf8');
const product={id:'871062',name:'Rocks Manga [OP17-118]',brand:'onepiece',kind:'card',minPrice:510000,currency:'JPY',thumbnailUrl:'https://cdn.snkrdunk.com/rocks.webp'};
const extract=name=>{const start=source.indexOf('async function '+name+'(');assert(start>=0);return source.slice(start,source.indexOf('\n}\n',start)+3);};
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
