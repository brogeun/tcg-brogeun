import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
const root=new URL('../../',import.meta.url),html=readFileSync(new URL('index.html',root),'utf8'),namesSource=readFileSync(new URL('assets/japanese-card-names.js',root),'utf8'),expanded=readFileSync(new URL('assets/price-expanded.js',root),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function names(fetch){
 const timers=[],cleared=[],module={exports:{}};
 vm.runInNewContext(namesSource,{module,fetch,AbortSignal,console,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>cleared.push(id)});
 return {api:module.exports,timers,cleared};
}
test('display dictionary abort is optional while strict ensureData still rejects it',async()=>{
 const h=names(async()=>{throw new DOMException('dictionary timeout','TimeoutError');});assert.equal(await h.api.ensureDisplayData(),false);await assert.rejects(h.api.ensureData(),/dictionary timeout/);
});
test('HTTP errors and invalid dictionary schema remain strict but produce display fallback',async()=>{
 for(const mode of ['http','schema']){const h=names(async()=>mode==='http'?{ok:false,status:503}:{ok:true,json:async()=>({schemaVersion:2})});assert.equal(await h.api.ensureDisplayData(),false);await assert.rejects(h.api.ensureData());}
});
test('the display budget expires without aborting a shared strict dictionary load',async()=>{
 const network=deferred();let signal;
 const h=names(async(url,options)=>{signal=options.signal;return network.promise;});
 const strict=h.api.ensureData(),display=h.api.ensureDisplayData();assert.equal(h.timers.length,1);assert.equal(h.timers[0].ms,1500);h.timers[0].fn();assert.equal(await display,false);assert.equal(signal.aborted,false);
 network.resolve({ok:true,json:async()=>({schemaVersion:1,names:{Pikachu:'피카츄'}})});await strict;assert.equal(h.api.title({name:'Pikachu',brand:'pokemon'}),'피카츄');assert.equal(await h.api.ensureDisplayData(),true);assert.equal(h.timers.length,1);
});
function nodes(){const map=new Map();const get=id=>{if(!map.has(id))map.set(id,{style:{},dataset:{},textContent:'',innerHTML:'',clientWidth:400,querySelector:s=>get(id+' '+s),querySelectorAll:()=>[]});return map.get(id);};return get;}
const product={id:'verified',name:'Original verified product [M2a 199/193] (Source edition)',kind:'card',lastPrice:100,currency:'JPY'};
test('normal price JSON renders for both brands and categories when optional names fail',async()=>{
 for(const brand of ['pokemon','onepiece'])for(const category of ['box','card']){
  const get=nodes();let displayLoads=0;
  const api={ensureDisplayData:async()=>{displayLoads++;return false;},title(){throw Error('must retain original name');}};
  const ctx=vm.createContext({console,Date,Math,PRICE_BRAND:brand,PRICE_CAT:category,PRICE_LOADING:false,PRICE_CACHE:{},HOME_TOP_CACHE:{},window:{JapaneseCardNames:api},JapaneseCardNames:api,
   document:{getElementById:get},fetch:async()=>({ok:true,json:async()=>({ok:true,products:[{...product,kind:category}]})}),enrichPriceProductMetadata:async p=>p,isPriceBoxProduct:p=>p.kind==='box',applyGradePrices:async p=>p,
   escapeHtml:String,getBoxKoreanName:()=>null,fmtKrw:(v,c)=>c+':'+v,fmtOrig:(v,c)=>c+':'+v});
  const start=html.indexOf('let PRICE_GRID_REQUEST ='),end=html.indexOf('// 시세 상품 ID',start);vm.runInContext(html.slice(start,end),ctx);
  const render=html.indexOf('function renderPriceGrid(');vm.runInContext(html.slice(render,html.indexOf('function changePricePage(',render)),ctx);await ctx.loadPriceGrid();
  assert(get('priceGrid').innerHTML.includes(product.name),brand+'/'+category);assert(get('priceGrid').innerHTML.includes('JPY:100'));assert.equal(get('priceStatus').textContent,'');assert.equal(displayLoads,brand==='pokemon'&&category==='card'?1:0);
 }
});
test('core price HTTP failures still prevent a fabricated price grid',async()=>{
 const get=nodes();let rendered=0;
 const ctx=vm.createContext({console:{error(){}},Date,Math,PRICE_BRAND:'pokemon',PRICE_CAT:'box',PRICE_LOADING:false,window:{},document:{getElementById:get},fetch:async()=>({ok:false,status:503}),escapeHtml:String,renderPriceGrid:()=>rendered++});
 const start=html.indexOf('let PRICE_GRID_REQUEST =');vm.runInContext(html.slice(start,html.indexOf('// 시세 상품 ID',start)),ctx);await ctx.loadPriceGrid();assert.equal(rendered,0);assert(get('priceStatus').textContent.includes('503'));
});
test('expanded detail keeps a verified quote and full source name without display names',async()=>{
 const get=nodes(),panel=get('panel');panel.dataset.productId='verified';let calls=0;
 const api={ensureDisplayData:async()=>false,title(){calls++;throw Error('no localization');}};
 const ctx=vm.createContext({window:{JapaneseCardNames:api,addEventListener(){}},JapaneseCardNames:api,document:{addEventListener(){},body:{classList:{contains:()=>true}},createElement:()=>({set innerHTML(v){this.value=v;},value:''})},AbortSignal,Date,Map,Set,URL,console,
  isCardProduct:()=>true,escapeHtml:String,HOME_TOP_KO_NAMES:{},loadCardsDetail:async()=>({cards:{verified:{grades:{psa10:{lowest_ask:100,currency:'JPY'}}}}}),enrichPriceProductMetadata:async()=>{},PriceProductInfo:{get:async()=>({sets:[]}),label:()=>''},getBoxKoreanName:()=>null,HomeMarket:{quote:()=>null},ResizeObserver:class{observe(){}disconnect(){}},JPY_KRW:1,fmtKrw:(v,c)=>c+':'+v,fetch:async()=>({ok:true,json:async()=>({ok:true,history:[],grades:{}})})});
 vm.runInContext(expanded,ctx);await ctx.window.renderExpandedPriceDetail('verified',{...product,_src:'price-pokemon-card'},panel);assert(panel.innerHTML.includes(product.name));assert.equal(get('panel #pxCurrent').textContent,'JPY:100');assert.equal(calls,0);
});
test('slide retains the source name and current quote without optional display names',async()=>{
 const get=nodes();let calls=0;const api={ensureDisplayData:async()=>false,title(){calls++;throw Error('no localization');}};
 const ctx=vm.createContext({console,Date,Number,Math,Set,FX_READY:Promise.resolve(),PRICE_CAT:'card',JPY_KRW:1,window:{JapaneseCardNames:api},JapaneseCardNames:api,PRICE_CACHE:{pokemon:[{...product,_srcFile:'price-pokemon-card'}]},HOME_TOP_CACHE:{},document:{getElementById:get},enrichPriceProductMetadata:async()=>{},isCardProduct:()=>true,PriceProductInfo:{get:async()=>({sets:[]}),label:()=>''},HomeMarket:{quote:()=>null},loadCardsDetail:async()=>({cards:{}}),escapeHtml:String,fetch:async url=>({ok:true,json:async()=>url.includes('/history/')?{history:[]}:{ok:true,grades:{raw:{lowest_ask:100,currency:'JPY'}}}})});
 ctx.window.PriceProductInfo=ctx.PriceProductInfo;const start=html.indexOf('let CURRENT_SLIDE_ID =');vm.runInContext(html.slice(start,html.indexOf('\nfunction _krw(',start)),ctx);vm.runInContext("CURRENT_SLIDE_ID='verified'",ctx);await ctx.renderSlidePanel('verified');assert.equal(get('slideName').textContent,product.name);assert(get('slideBody').innerHTML.includes('100'));assert.equal(calls,0);
});
test('portfolio metadata preserves verified prices and original name without strict display-name waits',async()=>{
 let strictCalls=0,displayCalls=0;
 const api={ensureDisplayData:async()=>{displayCalls++;return false;},ensureData:async()=>{strictCalls++;throw new DOMException('dictionary timeout','TimeoutError');},title(){throw Error('no localization');}};
 const info={get:async()=>({sets:[]}),label:()=>''};
 const ctx=vm.createContext({console,Date,Math,AbortSignal,Set,window:{PortfolioScreen:{},PriceProductInfo:info,JapaneseCardNames:api},PriceProductInfo:info,JapaneseCardNames:api,
  loadCardProductData:async()=>[{...product,brand:'pokemon'}],loadCardsDetail:async()=>({cards:{verified:{grades:{psa10:{lowest_ask:100,currency:'JPY'}}}}}),fetch:async()=>({ok:true,json:async()=>({history:[]})}),
  _PF_PRICE_CACHE:{},BOX_ID_SET:new Set(),HOME_TOP_KO_NAMES:{},getBoxKoreanName:()=>null});
 const start=html.indexOf('async function fetchCardMeta(');vm.runInContext(html.slice(start,html.indexOf('\nlet _PF_OWNER_ID =',start)),ctx);
 const result=await ctx.fetchCardMeta('verified');assert.equal(result.name,product.name);assert.equal(result.latestPrices.psa10,100);assert.equal(ctx._PF_PRICE_CACHE.verified.latestPrices.psa10,100);assert.equal(strictCalls,0);assert.equal(displayCalls,1);
});
