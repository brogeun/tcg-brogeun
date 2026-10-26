import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
const root=new URL('../../',import.meta.url);
const html=readFileSync(new URL('index.html',root),'utf8');
const expanded=readFileSync(new URL('assets/price-expanded.js',root),'utf8');
const flush=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const response=data=>({ok:true,json:async()=>data});
function elements(){
 const nodes=new Map();
 const node=id=>{
  if(!nodes.has(id)){
   const classes=new Set();
   nodes.set(id,{style:{},dataset:{},innerHTML:'',textContent:'',clientWidth:400,onclick:null,
    classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x),toggle(x,on){if(on)classes.add(x);else classes.delete(x);}},
    setAttribute(){},querySelector:s=>node(id+' '+s),querySelectorAll:()=>[]});
  }
  return nodes.get(id);
 };
 return {nodes,node};
}
function expandedHarness({live={ok:true,grades:{}},product={},staticGrades,history=[],fetchOverride}={}){
 const {node}=elements();const bodyClasses=new Set(['price-expanded']);
 const panel=node('panel');panel.dataset.productId='A';
 const productA={id:'A',name:'Card A [M2a 199/193]',_src:'price-pokemon-card',...product};
 const calls=[];
 const ctx=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){},body:{classList:{contains:x=>bodyClasses.has(x),toggle(x,on){if(on)bodyClasses.add(x);else bodyClasses.delete(x);}}},createElement:()=>({set innerHTML(v){this.value=v;},value:''})},AbortSignal,Date,Map,Set,URL,console,
  isCardProduct:()=>true,escapeHtml:s=>String(s??''),HOME_TOP_KO_NAMES:{},
  loadCardsDetail:async()=>({cards:{A:{grades:staticGrades||{psa10:{lowest_ask:123456,currency:'JPY'},raw:{lowest_ask:4000,currency:'JPY'}}}}}),
  enrichPriceProductMetadata:async()=>{},PriceProductInfo:{get:async()=>({sets:[]}),label:()=>''},getBoxKoreanName:()=>null,
  HomeMarket:{quote:p=>p.lastPrice?{value:p.lastPrice,currency:p.currency||'JPY',source:'수집 시점 출품가'}:null},ResizeObserver:class{observe(){}disconnect(){}},JPY_KRW:1,
  fmtKrw:(n,c)=>c+':'+n,fetch:async url=>{calls.push(url);if(fetchOverride)return fetchOverride(url);return response(String(url).includes('/api/')?live:{history});}
 });
 vm.runInContext(expanded,ctx);
 return {ctx,node,panel,product:productA,calls,render:()=>ctx.window.renderExpandedPriceDetail('A',productA,panel)};
}
const slideStart=html.indexOf('let CURRENT_SLIDE_ID =');
const slideSource=html.slice(slideStart,html.indexOf('\nfunction _krw(',slideStart));
function slideHarness({live={ok:true,grades:{}},history=[],staticGrades={},products,fetchOverride,fx=Promise.resolve()}={}){
 const {node}=elements();
 const ctx=vm.createContext({console,Date,Number,Math,Set,FX_READY:fx,PRICE_CAT:'card',JPY_KRW:1,location:{hash:'#price'},
  window:{},PRICE_CACHE:{pokemon:products||[{id:'A',name:'Card A',_srcFile:'price-pokemon-card'},{id:'B',name:'Card B',_srcFile:'price-pokemon-card'}]},HOME_TOP_CACHE:{},
  document:{getElementById:node,body:{style:{}}},CardFavorites:{sync(){}},enrichPriceProductMetadata:async()=>{},isCardProduct:()=>true,
  PriceProductInfo:{get:async()=>({sets:[]}),label:()=>''},HomeMarket:{quote:p=>p?.lastPrice?{value:p.lastPrice,currency:p.currency||'JPY'}:null},
  loadCardsDetail:async()=>({cards:{A:{grades:staticGrades},B:{grades:staticGrades}}}),escapeHtml:String,
  fetch:async url=>{if(fetchOverride)return fetchOverride(url);return response(String(url).includes('/history/')?{history}:live);}
 });
 ctx.window.PriceProductInfo=ctx.PriceProductInfo;vm.runInContext(slideSource,ctx);
 ctx.closeSlidePanel=ctx.window.closeSlidePanel;ctx.openSlidePanel=ctx.window.openSlidePanel;
 const setId=id=>vm.runInContext('CURRENT_SLIDE_ID = '+JSON.stringify(id),ctx);
 return {ctx,node,setId,render:id=>{setId(id);return ctx.renderSlidePanel(id);},close:()=>ctx.window.closeSlidePanel()};
}

test('active expanded detail clears unavailable PSA quotes and never refills from history',async()=>{
 const h=expandedHarness({live:{ok:true,grades:{raw:{lowest_ask:5000,currency:'JPY'}},noListingGrades:['psa10','psa9']},history:[{date:'2026-10-25',psa10_price:88888,psa9_price:77777}]});
 await h.render();
 assert.equal(h.node('panel #pxCurrent').textContent,'출품 없음');
 assert.equal(h.node('panel #pxSource').textContent,'SNKRDUNK · 현재 출품 없음');
 const rows=h.node('panel #pxGradeRows').innerHTML;
 for(const old of ['123456','88888','77777'])assert(!rows.includes(old));
 assert(rows.includes('JPY:5000'));
 assert(h.calls.some(x=>x.includes('/api/card-grades?id=A&v=3')),'active detail must use the same cache schema version');
});
test('explicit raw absence also clears a collected home raw quote',async()=>{
 const h=expandedHarness({product:{_isTop10:true,lastPrice:222222,currency:'JPY'},live:{ok:true,grades:{},noListingGrades:['raw']}});await h.render();
 assert.equal(h.node('panel #pxCurrent').textContent,'출품 없음');assert(!h.node('panel #pxGradeRows').innerHTML.includes('222222'));
});
test('an available live raw quote preserves the deliberate home source-price display',async()=>{
 const h=expandedHarness({product:{_isTop10:true,lastPrice:222222,currency:'JPY'},live:{ok:true,grades:{raw:{lowest_ask:333333,currency:'JPY'}}}});await h.render();
 assert.equal(h.node('panel #pxCurrent').textContent,'JPY:222222');
});
test('failed live responses and incomplete availability do not invent absent grades',async()=>{
 for(const variant of ['network','not-ok','partial']){
  const h=expandedHarness({live:variant==='not-ok'?{ok:false,grades:{},noListingGrades:['psa10']}:{ok:true,grades:{}},fetchOverride:variant==='network'?async url=>{if(url.includes('/api/'))throw Error('offline');return response({history:[]});}:undefined});
  await h.render();assert.equal(h.node('panel #pxCurrent').textContent,'JPY:123456');
 }
});
test('older expanded render for the same product cannot replace a newer result',async()=>{
 const pending=deferred();let apiCalls=0;
 const h=expandedHarness({fetchOverride:async url=>url.includes('/api/')?(++apiCalls===1?pending.promise:response({ok:true,grades:{psa10:{lowest_ask:222222,currency:'JPY'}}})):response({history:[]})});
 const old=h.render();while(apiCalls===0)await flush();await h.render();assert.equal(h.node('panel #pxCurrent').textContent,'JPY:222222');
 pending.resolve(response({ok:true,grades:{psa10:{lowest_ask:111111,currency:'JPY'}}}));await old;assert.equal(h.node('panel #pxCurrent').textContent,'JPY:222222');
});
test('expanded mode cancellation prevents a late request updating the closed view',async()=>{
 const pending=deferred();let apiCalls=0;
 const h=expandedHarness({fetchOverride:async url=>{if(url.includes('/api/')){apiCalls++;return pending.promise;}return response({history:[]});}});
 const old=h.render();while(apiCalls===0)await flush();h.ctx.window.setExpandedPriceMode(false);const before=h.node('panel #pxCurrent').textContent;
 pending.resolve(response({ok:true,grades:{psa10:{lowest_ask:111111,currency:'JPY'}}}));await old;assert.equal(h.node('panel #pxCurrent').textContent,before);
});
test('slide clears unavailable saved, historical and product-grade fallback prices',async()=>{
 const h=slideHarness({staticGrades:{psa10:{lowest_ask:123456,currency:'JPY'},raw:{lowest_ask:4000,currency:'JPY'}},history:[{date:'2026-10-25',psa10_price:88888}],products:[{id:'A',name:'Card A',_srcFile:'price-pokemon-card',_grade:'PSA10',lastPrice:99999}],live:{ok:true,grades:{raw:{lowest_ask:5000,currency:'JPY'}},noListingGrades:['psa10']}});
 await h.render('A');const body=h.node('slideBody').innerHTML;for(const old of ['123456','88888','99999'])assert(!body.includes(old));assert(body.includes('출품 없음'));assert(body.includes('5,000'));
});
test('unknown generic card product price is never fabricated as a PSA 10 fallback',async()=>{
 const h=slideHarness({products:[{id:'A',name:'Card A',_srcFile:'price-pokemon-card',lastPrice:99999}]});await h.render('A');assert(!h.node('slideBody').innerHTML.includes('99,999'));
});
test('slide latest B remains visible after an older A quote request completes',async()=>{
 const pending=deferred(),entered=deferred();
 const h=slideHarness({fetchOverride:async url=>{if(url.includes('/history/'))return response({history:[]});if(url.includes('id=A')){entered.resolve();return pending.promise;}return response({ok:true,grades:{}});}});
 const old=h.render('A');await entered.promise;await h.render('B');pending.resolve(response({ok:true,grades:{}}));await old;assert.equal(h.node('slideName').textContent,'Card B');
});
test('closing a slide invalidates all pending renders',async()=>{
 const pending=deferred(),entered=deferred();
 const h=slideHarness({fetchOverride:async url=>{if(url.includes('/history/'))return response({history:[]});entered.resolve();return pending.promise;}});
 const old=h.render('A');await entered.promise;h.close();h.node('slideName').textContent='closed-marker';pending.resolve(response({ok:true,grades:{}}));await old;assert.equal(h.node('slideName').textContent,'closed-marker');
});
test('closing and reopening the same slide discards the first generation',async()=>{
 const pending=deferred();let calls=0;
 const h=slideHarness({fetchOverride:async url=>{if(url.includes('/history/'))return response({history:[]});return ++calls===1?pending.promise:response({ok:true,grades:{raw:{lowest_ask:222222,currency:'JPY'}}});}});
 const old=h.render('A');while(calls===0)await flush();h.close();await h.render('A');const before=h.node('slideBody').innerHTML;
 pending.resolve(response({ok:true,grades:{raw:{lowest_ask:111111,currency:'JPY'}}}));await old;assert.equal(h.node('slideBody').innerHTML,before);assert(before.includes('222,222'));
});
test('late FX completion cannot revive a closed slide',async()=>{
 const pending=deferred();const h=slideHarness({fx:pending.promise});const old=h.render('A');h.close();h.node('slideName').textContent='closed-marker';pending.resolve();await old;assert.equal(h.node('slideName').textContent,'closed-marker');
});
test('a departed price route cannot be reactivated by delayed FX',async()=>{
 const pending=deferred(),{node}=elements();let activated=0;
 const ctx=vm.createContext({console,FX_READY:pending.promise,PRICE_DETAIL_REQUEST:0,PRICE_CACHE:{},HOME_TOP_CACHE:{pokemon:[{id:'A',name:'Card A'}]},location:{hash:'#price/A'},document:{body:{dataset:{page:'price'}},getElementById:node},window:{setExpandedPriceMode(){activated++;},renderExpandedPriceDetail:async()=>{}},parsePageRoute:input=>({productId:input.slice(7)})});
 const start=html.indexOf('async function showPriceDetailPanel('),counter=html.lastIndexOf('let PRICE_DETAIL_REQUEST =',start);
 vm.runInContext(html.slice(counter<0?start:counter,html.indexOf('\n/* ─────────── PSA10 Pop',start)),ctx);
 const old=ctx.showPriceDetailPanel('A');ctx.location.hash='#home';ctx.document.body.dataset.page='home';pending.resolve();await old;assert.equal(activated,0);assert.equal(node('priceDetailPanel').innerHTML,'');
});
test('price catalogue cache never replaces the official home ranking, including secondary fetch failure',async()=>{
 for(const failure of [false,true]){
  const {node}=elements();let calls=0;
  const ctx=vm.createContext({PRICE_BRAND:'pokemon',PRICE_CAT:'card',PRICE_LOADING:false,HOME_TOP_CACHE:{pokemon:[{id:'actual-home-rank-1'}]},PRICE_CACHE:{},document:{getElementById:node},window:{},Math,Date,console,
   enrichPriceProductMetadata:async x=>x,isPriceBoxProduct:x=>x.kind==='box',applyGradePrices:async x=>x,renderPriceGrid(){},escapeHtml:String,
   fetch:async url=>{if(++calls===2&&failure)throw Error('secondary offline');return response({ok:true,products:[{id:url.includes('-card')?'grid-card':'grid-box',kind:url.includes('-card')?'card':'box'}]});}});
  const start=html.indexOf('async function loadPriceGrid()');vm.runInContext(html.slice(html.lastIndexOf('let PRICE_GRID_REQUEST =',start),html.indexOf('\n// 시세 상품 ID',start)),ctx);await ctx.loadPriceGrid();
  assert.equal(ctx.HOME_TOP_CACHE.pokemon.length,1);assert.equal(ctx.HOME_TOP_CACHE.pokemon[0].id,'actual-home-rank-1');assert(ctx.PRICE_CACHE.pokemon.some(x=>x.id==='grid-card'));
 }
});
test('a generic catalogue cache item is passed to expanded detail without TOP 10 identity',async()=>{
 const {node}=elements();let original;
 const ctx=vm.createContext({console,FX_READY:Promise.resolve(),PRICE_DETAIL_REQUEST:0,PRICE_CACHE:{pokemon:[{id:'A',name:'Grid Card',lastPrice:99999}]},HOME_TOP_CACHE:{},location:{hash:'#price/A'},document:{body:{dataset:{page:'price'}},getElementById:node},window:{setExpandedPriceMode(){},renderExpandedPriceDetail:async(id,p)=>{original=p;}},parsePageRoute:input=>({productId:input.slice(7)})});
 const start=html.indexOf('async function showPriceDetailPanel('),counter=html.lastIndexOf('let PRICE_DETAIL_REQUEST =',start);vm.runInContext(html.slice(counter<0?start:counter,html.indexOf('\n/* ─────────── PSA10 Pop',start)),ctx);await ctx.showPriceDetailPanel('A');assert.equal(original._isTop10,false);assert.equal(original.name,'Grid Card');
});
