'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
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

function portfolioRefreshHarness({page='portfolio',loading=false}={}){
  const screen=deferred(),listeners=[],requests=[],counts={reads:0,forced:0,renders:0,home:0,sync:0};
  const elements={pfLoginGate:{style:{}},pfMain:{style:{}},pfHoldCount:{},pfWatchCount:{}};
  const owner={id:'fixture'};
  const ctx={Promise,Set,CURRENT_USER:owner,console,
    document:{readyState:loading?'loading':'complete',body:{dataset:{page}},getElementById:id=>elements[id],
      addEventListener:(type,fn)=>{assert.equal(type,'DOMContentLoaded');listeners.push(fn);}},
    _PF_OWNER_ID:null,_PF_REFRESH_RUN:0,_PF_REFRESH_WORK:null,_PF_REFRESH_USER:null,_HOME_ASSET_RUN:0,
    HOLDINGS:[],WATCHLIST:[],PSA_CERTS:[],_PORTFOLIO_READY:null,_PORTFOLIO_USER:null,
    syncPortfolioOwner:()=>counts.sync++,
    loadPortfolio:async()=>{counts.reads++;return {holdings:[],watchlists:[]};},
    fetchPortfolio:async()=>{counts.forced++;return {holdings:[],watchlists:[]};},
    ensureBoxIdSet:async()=>{},loadCardMeta:async()=>{},renderHomeAsset:()=>counts.home++,
    renderHoldings:()=>counts.renders++,renderWatchlist(){},renderDistributionCharts(){},renderAggChart(){},
  };
  ctx.window=ctx;
  ctx.AppRouteLoader={ensure(profile,options){
    assert.equal(profile,'portfolio');requests.push(options);
    return screen.promise.then(()=>({ready:options.isCurrent(),cancelled:!options.isCurrent()}));
  }};
  vm.createContext(ctx);
  const start=html.indexOf('function refreshPortfolio('),end=html.indexOf('\nfunction renderHoldings(',start);
  vm.runInContext(html.slice(start,end),ctx);
  return {ctx,owner,counts,requests,listeners,screen,elements,
    domReady(){ctx.document.readyState='interactive';listeners.splice(0).forEach(fn=>fn());},
    mount(){elements.pfxStatus={};ctx.PortfolioScreen={status(){},cancelChart(){}};screen.resolve();},
  };
}

test('portfolio auth and hash refreshes wait for the screen and share one data refresh',async()=>{
  const h=portfolioRefreshHarness({loading:true}),one=h.ctx.refreshPortfolio(),two=h.ctx.refreshPortfolio();
  await Promise.resolve();assert.equal(h.requests.length,0,'Mount waits for core DOM setup');assert.equal(h.counts.reads,0);
  h.domReady();await Promise.resolve();assert.equal(h.requests.length,2,'Route loader owns the shared asset request');
  assert.equal(h.counts.reads,0);h.mount();await Promise.all([one,two]);
  assert.equal(h.counts.reads,1);assert.equal(h.counts.renders,2,'Initial empty view and one settled render');
});

test('a departed portfolio or changed account cannot replay an earlier pending refresh',async()=>{
  for(const change of ['page','owner']){
    const h=portfolioRefreshHarness(),work=h.ctx.refreshPortfolio();await Promise.resolve();
    if(change==='page')h.ctx.document.body.dataset.page='home';else h.ctx.CURRENT_USER={id:'another-owner'};
    h.mount();await work;assert.equal(h.counts.reads,0,change);assert.equal(h.counts.renders,0,change);
  }
});

test('portfolio screen failure leaves route recovery in control and force survives screen loading',async()=>{
  const h=portfolioRefreshHarness(),work=h.ctx.refreshPortfolio();await Promise.resolve();
  h.screen.reject(new Error('network'));await work;assert.equal(h.counts.reads,0);assert.equal(h.counts.renders,0);
  const forced=portfolioRefreshHarness(),refresh=forced.ctx.refreshPortfolio({force:true});await Promise.resolve();
  forced.mount();await refresh;assert.equal(forced.counts.forced,1);assert.equal(forced.counts.reads,0);
});

test('background home portfolio refresh does not request the optional screen',async()=>{
  const h=portfolioRefreshHarness({page:'home'});await h.ctx.refreshPortfolio();
  assert.equal(h.requests.length,0);assert.equal(h.counts.reads,1);assert.equal(h.counts.home,1);assert.equal(h.counts.renders,0);
});

test('home fallback keeps card metadata localization without loading the portfolio screen',async()=>{
  const product={id:'101',name:'Original',brand:'pokemon',kind:'card',thumbnailUrl:'card.png'};
  let catalogCalls=0;
  const ctx={console,Date,AbortSignal,Promise,_PF_PRICE_CACHE:{},BOX_ID_SET:new Set(),JPY_KRW:10,USD_KRW:1500,HOME_TOP_KO_NAMES:{},
    loadCardProductData:async()=>[product],loadCardsDetail:async()=>({cards:{101:{grades:{raw:{lowest_ask:100,currency:'JPY'}}}}}),
    fetch:async()=>({ok:true,json:async()=>({history:[]})}),
    PriceProductInfo:{get:async()=>{catalogCalls++;return {sets:[{code:'TEST',name:'Fixture set'}]};},label:s=>s.name},
    JapaneseCardNames:{ensureDisplayData:async()=>true,title:()=> '한글 카드명'},
  };
  ctx.window=ctx;vm.createContext(ctx);
  const start=html.indexOf('async function fetchCardMeta('),end=html.indexOf('\nlet _PF_OWNER_ID',start);
  vm.runInContext(html.slice(start,end),ctx);
  const result=await ctx.fetchCardMeta('101');assert.equal(catalogCalls,1);assert.equal(result.koName,'한글 카드명');
  assert.equal(result.pack,'Fixture set');assert.equal(result.latestPrices.raw,100);assert.equal(ctx.PortfolioScreen,undefined);
});
