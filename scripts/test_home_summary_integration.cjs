'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const clientSource=fs.readFileSync(path.join(root,'assets/portfolio-summary-client.js'),'utf8');
const homeStart=html.indexOf('async function renderHomeAsset() {'),homeEnd=html.indexOf('window.openPortfolioOrLogin',homeStart);
const ownerStart=html.indexOf('let _PF_OWNER_ID = null;'),ownerEnd=html.indexOf('function renderHoldings()',ownerStart);
assert(homeStart>=0&&homeEnd>homeStart&&ownerStart>=0&&ownerEnd>ownerStart,'Current home and portfolio lifecycle functions must remain testable');

const fx={rates:{JPY:10,USD:1351,CNY:191},asOf:'2026-11-03',basis:'previous-business-day-close'};
function summary(userId='a',overrides={}){
  return {ok:true,userId,holdingsCount:50,watchCount:4,totalValueJpy:500,totalCostJpy:400,
    sourceHash:'a'.repeat(64),fx:structuredClone(fx),...overrides};
}
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};

function harness({fetchSummary,legacyHoldings=[],cachedMeta={}}={}){
  const counts={summary:0,portfolio:0,metadata:0,boxes:0,products:0,search:0,detail:0,invalidations:0},elements={};
  for(const id of ['homeAssetValue','homeAssetChange','homeAssetHoldCount','homeAssetWatchCount','pfLoginGate','pfMain'])elements[id]={style:{},textContent:'',innerHTML:''};
  const context={console,Date,Math,Promise,Set,Map,AbortController,setTimeout,clearTimeout,
    document:{hidden:false,body:{dataset:{page:'home'}},getElementById:id=>elements[id]},
    window:{CardFavorites:{sync(){}},PortfolioScreen:{cancelChart(){},status(){}}},syncHomeAuthView(){},
    CURRENT_USER:{id:'a'},HOLDINGS:legacyHoldings,WATCHLIST:[],PSA_CERTS:[],BOX_ID_SET:new Set(),
    _PF_PRICE_CACHE:cachedMeta,_PORTFOLIO_READY:null,_PORTFOLIO_USER:null,
    FX_READY:Promise.resolve(),FX_AS_OF:fx.asOf,FX_BASIS:fx.basis,JPY_KRW:fx.rates.JPY,USD_KRW:fx.rates.USD,CNY_KRW:fx.rates.CNY,
    fetch:async(url,options)=>{
      assert.equal(url,'/api/portfolio/summary');assert.equal(options.credentials,'include');assert.equal(options.cache,'no-store');
      counts.summary++;return fetchSummary?fetchSummary(context.CURRENT_USER.id,counts.summary):json(summary(context.CURRENT_USER.id));
    },
    loadPortfolio:async()=>{counts.portfolio++;return {holdings:legacyHoldings,watchlists:[]};},
    fetchPortfolio:async()=>{counts.portfolio++;return {holdings:legacyHoldings,watchlists:[],psa_certs:[]};},
    ensureBoxIdSet:async()=>{counts.boxes++;return context.BOX_ID_SET;},
    loadCardMeta:async id=>{counts.metadata++;context._PF_PRICE_CACHE[id]={kind:'card',latestPrices:{raw:180}};},
    loadCardProductData:async()=>{counts.products++;return [];},loadCardSearchData:async()=>{counts.search++;},
    loadCardsDetail:async()=>{counts.detail++;return {cards:{}};},
  };
  vm.createContext(context);vm.runInContext(clientSource,context);
  const invalidate=context.window.PortfolioSummaryClient.invalidate;
  context.window.PortfolioSummaryClient.invalidate=()=>{counts.invalidations++;invalidate();};
  vm.runInContext('let _HOME_ASSET_RUN=0;\n'+html.slice(homeStart,homeEnd)+'\n'+html.slice(ownerStart,ownerEnd),context);
  const renderHome=context.renderHomeAsset;
  let homeWork;
  context.renderHomeAsset=(...args)=>(homeWork=renderHome(...args));
  return {ctx:context,elements,counts,homeSettled:()=>homeWork};
}

test('actual home summary hit renders totals/counts without loading full holdings, search or metadata',async()=>{
  const h=harness();await h.ctx.renderHomeAsset();
  assert.equal(h.elements.homeAssetValue.textContent,'₩5,000');
  assert.equal(h.elements.homeAssetHoldCount.textContent,'50종');assert.equal(h.elements.homeAssetWatchCount.textContent,'4종');
  assert.equal(h.elements.homeAssetChange.className,'asset-change up');assert.match(h.elements.homeAssetChange.textContent,/25\.0%/);
  assert.equal(h.counts.summary,1);
  for(const name of ['portfolio','metadata','boxes','products','search','detail'])assert.equal(h.counts[name],0,name+' must stay off the summary hit path');
  await h.ctx.renderHomeAsset();assert.equal(h.counts.summary,1,'same-owner home redraw reuses its bounded private summary cache');
});

test('any FX snapshot mismatch falls back to the existing local valuation instead of using mixed conversion',async()=>{
  for(const mismatch of [
    value=>{value.fx.asOf='2026-11-02';},
    value=>{value.fx.rates.JPY=9;},
    value=>{value.fx.rates.USD=1400;},
    value=>{value.fx.rates.CNY=190;},
    value=>{value.fx.basis='unverified';},
  ]){
    const data=summary();mismatch(data);
    const holding={card_id:'legacy',grade:'raw',buy_price:100,qty:2};
    const h=harness({fetchSummary:async()=>json(data),legacyHoldings:[holding]});
    await h.ctx.renderHomeAsset();
    assert.equal(h.elements.homeAssetValue.textContent,'₩3,600','legacy 180JPY x2 x current10KRW must win over API500JPY');
    assert.equal(h.elements.homeAssetHoldCount.textContent,'1종');assert.equal(h.counts.metadata,1);assert.equal(h.counts.boxes,1);
  }
});

test('actual home ignores a late previous-account response and keeps the new account value',async()=>{
  const pending=[];
  const h=harness({fetchSummary:(owner)=>new Promise(resolve=>pending.push({owner,resolve}))});
  h.ctx.syncPortfolioOwner();const old=h.ctx.renderHomeAsset();await flush();assert.equal(pending.length,1);
  h.ctx.CURRENT_USER={id:'b'};h.ctx.syncPortfolioOwner();
  const current=h.ctx.renderHomeAsset();await flush();assert.equal(pending.length,2);
  pending[1].resolve(json(summary('b',{totalValueJpy:900,totalCostJpy:600,holdingsCount:3,watchCount:1})));await current;
  pending[0].resolve(json(summary('a')));await old;
  assert.equal(h.elements.homeAssetValue.textContent,'₩9,000');assert.equal(h.elements.homeAssetHoldCount.textContent,'3종');
  assert.equal(h.elements.homeAssetWatchCount.textContent,'1종');assert.equal(h.counts.portfolio,0);assert.equal(h.counts.metadata,0);
});

test('route departure or hidden app prevents late summary data from touching the home or starting fallback work',async()=>{
  for(const leave of [ctx=>{ctx.document.body.dataset.page='cardinfo';},ctx=>{ctx.document.hidden=true;}]){
    let resolve;
    const h=harness({fetchSummary:()=>new Promise(r=>resolve=r)}),work=h.ctx.renderHomeAsset();await flush();
    h.elements.homeAssetValue.textContent='retained';leave(h.ctx);resolve(json(summary()));await work;
    assert.equal(h.elements.homeAssetValue.textContent,'retained');assert.equal(h.counts.portfolio,0);assert.equal(h.counts.metadata,0);
  }
});

test('successful mutation force-refresh invalidates the real client cache and home reads new server totals',async()=>{
  let current=500;
  const h=harness({fetchSummary:async owner=>{
    const body=JSON.stringify(summary(owner,{totalValueJpy:current}));
    return new Response(new ReadableStream({start(controller){
      setImmediate(()=>{controller.enqueue(new TextEncoder().encode(body));controller.close();});
    }}),{headers:{'Content-Type':'application/json'}});
  }});
  h.ctx.syncPortfolioOwner();await h.ctx.renderHomeAsset();assert.equal(h.elements.homeAssetValue.textContent,'₩5,000');
  assert.equal(h.counts.summary,1);h.counts.invalidations=0;current=700;
  await h.ctx.refreshPortfolio({force:true});
  // Refresh starts the real home render without awaiting it. Wait for that
  // exact task, including Response.json(), across Node/browser stream queues.
  await h.homeSettled();
  assert(h.counts.invalidations>=1,'the real mutation refresh invalidates the private summary');
  assert.equal(h.counts.summary,2,'successful mutation must refetch instead of reusing the previous cached summary');
  assert.equal(h.elements.homeAssetValue.textContent,'₩7,000');
  assert.equal(h.counts.metadata,0,'empty updated holdings do not trigger the full metadata valuation');
});
