'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function homeHarness(){
  const tops={pokemon:deferred(),onepiece:deferred()},renders=[],histories=[],optional=deferred();
  let news=0,assets=0,optionalLoads=0;
  const ctx={console,Intl,Date,Promise,
    document:{body:{dataset:{page:'home'}},getElementById:()=>({childElementCount:1})},
    window:{AnniversaryMarket:{load:()=>{optionalLoads++;return optional.promise;}}},
    FX_READY:Promise.resolve(),loadHomeTop:brand=>tops[brand].promise,
    renderHomeNewsGrid:()=>news++,scheduleHomeAsset:()=>assets++,
    renderHomeTopRow:brand=>renders.push(brand),loadHomeTradeChanges:async rows=>histories.push(rows),
  };
  vm.createContext(ctx);
  const start=html.indexOf('async function initHome2() {');
  vm.runInContext(html.slice(start,html.indexOf("\ndocument.addEventListener('click', e => {",start)),ctx);
  return {ctx,tops,renders,histories,optional,news:()=>news,assets:()=>assets,optionalLoads:()=>optionalLoads};
}
test('home news and asset scheduling are independent of TOP10 and optional market stalls',async()=>{
  const h=homeHarness(),work=h.ctx.initHome2();
  assert.equal(h.news(),1);assert.equal(h.assets(),1);assert.equal(h.renders.length,0);
  for(const [brand,top] of Object.entries(h.tops))top.resolve(Array.from({length:10},(_,n)=>({id:brand+n})));
  await work;
  assert.equal(h.renders.length>=2,true,'base TOP10 appears while optional market is unresolved');
  assert.deepEqual(h.histories.map(rows=>rows.length),[3,3],'only six visible histories load initially');
  assert.equal(h.optionalLoads(),2);
  const before=h.renders.length;h.optional.resolve();await Promise.resolve();
  assert.equal(h.renders.length,before+2,'late supplement refreshes the existing home rows');
});
test('leaving home before TOP10 completes starts no optional snapshots or histories',async()=>{
  const h=homeHarness(),work=h.ctx.initHome2();h.ctx.document.body.dataset.page='cardinfo';
  Object.values(h.tops).forEach(top=>top.resolve([{id:'fixture'}]));await work;
  assert.equal(h.renders.length,0);assert.equal(h.histories.length,0);assert.equal(h.optionalLoads(),0);
});
test('valuation coalesces auth events, waits for two paints and resumes visible home',()=>{
  const frames=[],idle=[],timers=[],listeners=new Map();let valuations=0;
  const ctx={document:{hidden:false,body:{dataset:{page:'home'}},addEventListener:(name,fn)=>listeners.set(name,fn)},window:{
    addEventListener:(name,fn)=>listeners.set(name,fn),requestAnimationFrame:fn=>frames.push(fn),requestIdleCallback:fn=>idle.push(fn)},
    setTimeout:fn=>timers.push(fn),renderHomeAsset:()=>valuations++};
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('let _HOME_ASSET_RUN = 0;'),html.indexOf('async function renderHomeAsset() {')),ctx);
  ctx.scheduleHomeAsset();ctx.scheduleHomeAsset();assert.equal(frames.length,1);assert.equal(valuations,0);
  frames.shift()();assert.equal(valuations,0);frames.shift()();assert.equal(idle.length,1);
  ctx.document.body.dataset.page='cardinfo';idle.shift()();assert.equal(valuations,0);
  ctx.document.body.dataset.page='home';ctx.scheduleHomeAsset();frames.shift()();frames.shift()();idle.shift()();
  assert.equal(valuations,1);
  ctx.document.hidden=true;ctx.scheduleHomeAsset();assert.equal(frames.length,0);
  ctx.document.hidden=false;listeners.get('visibilitychange')();frames.shift()();frames.shift()();idle.shift()();
  assert.equal(valuations,2,'returning to the visible app resumes valuation without navigation');
});
test('TOP10 expansion fetches its seven newly visible histories and closing adds no requests',async()=>{
  const shown=new Set(),history=[],cache=Array.from({length:10},(_,n)=>({id:String(n)}));
  const classes={contains:k=>shown.has(k),toggle:k=>shown.has(k)?shown.delete(k):shown.add(k)};
  const ctx={window:{},document:{body:{dataset:{page:'home'}},getElementById:id=>id.endsWith('-more-list')?{classList:classes}:{classList:{toggle(){}},childNodes:[]}},
    HOME_TOP_CACHE:{pokemon:cache},loadHomeTradeChanges:async rows=>history.push(rows),renderHomeTopRow(){}};
  vm.createContext(ctx);const start=html.indexOf('window.toggleHomeTopMore = function(brand) {');
  vm.runInContext(html.slice(start,html.indexOf('let HOME_NEWS_INDEX',start)),ctx);
  ctx.window.toggleHomeTopMore('pokemon');await Promise.resolve();assert.equal(history[0].length,7);
  ctx.window.toggleHomeTopMore('pokemon');await Promise.resolve();assert.equal(history.length,1);
});
test('cached portfolio value waits for daily FX while other home widgets remain independent',async()=>{
  const fx=deferred(),elements={};
  for(const id of ['homeAssetValue','homeAssetChange','homeAssetHoldCount','homeAssetWatchCount'])elements[id]={style:{},textContent:''};
  const ctx={document:{hidden:false,body:{dataset:{page:'home'}},getElementById:id=>elements[id]},syncHomeAuthView(){},
    CURRENT_USER:{id:'fixture'},HOLDINGS:[{card_id:'1',grade:'raw',buy_price:100,qty:2}],WATCHLIST:[],
    _HOME_ASSET_RUN:0,_PF_PRICE_CACHE:{1:{latestPrices:{raw:150}}},BOX_ID_SET:new Set(),JPY_KRW:9.5,FX_READY:fx.promise};
  vm.createContext(ctx);const start=html.indexOf('async function renderHomeAsset() {');
  vm.runInContext(html.slice(start,html.indexOf('window.openPortfolioOrLogin',start)),ctx);
  const work=ctx.renderHomeAsset();await Promise.resolve();assert.equal(elements.homeAssetValue.textContent,'','fallback FX must not produce a settled value');
  ctx.JPY_KRW=10;fx.resolve();await work;assert.equal(elements.homeAssetValue.textContent,'₩3,000');
});
