import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read = name => readFileSync(new URL('../'+name,import.meta.url),'utf8');
const ctx=vm.createContext({window:{addEventListener(){}},document:{addEventListener(){},body:{classList:{contains:()=>true}},createElement:()=>({set innerHTML(v){this.value=v;},value:''})},AbortSignal,Date,Map,URL,console});
vm.runInContext(read('assets/home-market.js'),ctx);
const market=ctx.window.HomeMarket;
ctx.HomeMarket=market;
assert.equal(market.quote({lastPrice:0,lowestAsk:10,currency:'USD'}).value,10);
assert.equal(market.quote({lastPrice:NaN}),null);
assert.equal(market.quote({lastPrice:100,currency:'USD'}).currency,'USD');
assert.equal(market.tradeChange([{date:'2026-09-01',box_price:10}], 'box_price'),null);
const trades=[{date:'2026-09-12',box_price:23000,raw_price:120},{date:'2026-09-10',box_price:20000,raw_price:100},{date:'2026-09-12',box_price:23000,raw_price:120}];
assert.ok(Math.abs(market.tradeChange(trades,'box_price').percent-15)<1e-8);
assert.ok(Math.abs(market.tradeChange(trades,'raw_price').percent-20)<1e-8);
assert.equal(market.tradeChange(trades,'psa10_price'),null);
assert.equal(market.tradeChange([{date:'2026-09-10',box_price:10},{date:'2026-09-11',box_price:10}],'box_price').percent,0);
let calls=0;
ctx.fetch=async()=>{calls++;return {ok:true,json:async()=>({history:trades})};};
await Promise.all([market.history('same'),market.history('same')]);
assert.equal(calls,1,'concurrent history loads deduplicate');
ctx.fetch=async()=>({ok:false});
assert.equal(await market.history('retry'),null);
ctx.fetch=async()=>({ok:true,json:async()=>({history:trades})});
assert.equal((await market.history('retry')).length,3,'failed requests can retry');

ctx.escapeHtml=s=>String(s??'');
ctx.HOME_TOP_KO_NAMES={};
ctx.CARDINFO={pokemon:[],onepiece:[]};
ctx.HOME_TRADE_CHANGES={};
ctx.JPY_KRW=8.7462;
ctx.fmtKrw=(n,c)=>n==null?'—':'₩'+Math.floor(n*(c==='USD'?1351:ctx.JPY_KRW)).toLocaleString();
ctx.fmtOrig=(n,c)=>c+' '+n;
const html=read('index.html');
vm.runInContext(html.slice(html.indexOf('function _homeProductKind('),html.indexOf('const HOME_TRADE_CHANGES =')),ctx);
ctx.isCardProduct=n=>/\[.*\d+\/\d+/.test(n);
ctx.loadCardsDetail=async()=>({cards:{test:{grades:{psa10:{lowest_ask:999,currency:'USD'},raw:{lowest_ask:888,currency:'JPY'}}}}});
ctx.enrichPriceProductMetadata=async()=>{};
ctx.PriceProductInfo={get:async()=>({sets:[]}),label:()=>''};
ctx.getBoxKoreanName=()=>null;
ctx.ResizeObserver=class{observe(){} disconnect(){}};
ctx.fetch=async url=>({ok:true,json:async()=>String(url).includes('/api/')?{ok:true,grades:{raw:{lowest_ask:777,currency:'JPY'}}}:{history:trades}});
vm.runInContext(read('assets/price-expanded.js'),ctx);
for(const product of [
  {id:'test',name:'Example BOX',lastPrice:20900,currency:'JPY',_isTop10:true,_productKind:'box'},
  {id:'test',name:'Example [M2a 199/193]',lastPrice:1000,currency:'JPY',_isTop10:true,_productKind:'card'},
  {id:'test',name:'Example BOX',lastPrice:100,currency:'USD',_isTop10:true,_productKind:'box'}
]){
  const nodes={};const panel={dataset:{productId:'test'},innerHTML:'',querySelector(sel){return nodes[sel]??={textContent:'',innerHTML:'',clientWidth:400};},querySelectorAll(){return [];}};
  await ctx.window.renderExpandedPriceDetail('test',product,panel);
  const expected=ctx.fmtKrw(product.lastPrice,product.currency);
  assert.equal(nodes['#pxCurrent'].textContent,expected,'detail must equal home listing, not history or live different grade');
  const home=ctx._homePriceRowHTML(product,0);
  assert.ok(home.includes(expected));
  assert.equal(nodes['#pxSource'].textContent,'SNKRDUNK · 수집 시점 출품가');
  if(product._productKind==='card')assert.equal(nodes['#pxLabel'].textContent,'A급(미개봉) 기준');
}
assert.match(html,/const FX_READY =/);
assert.match(html,/async function showPriceDetailPanel\(productId\) \{\s*await FX_READY/);
assert.match(html,/async function renderSlidePanel\(productId\) \{\s*await FX_READY/);
assert.match(html,/await FX_READY;\s*renderHomeTopRow/);
assert.doesNotMatch(html,/현재 TOP 시세 원본에 등락률이 제공되지 않습니다/);
console.log('PASS: listing/history separation, JPY/USD home-detail parity, raw/PSA separation, live raw protection, trade changes, missing data, dedup/retry, FX ordering');
