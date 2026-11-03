'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const {snapshotFromInputs,writePortfolioSnapshot,latestHistory,bucket,compilePortfolioSnapshot}=require('./build_portfolio_quotes.cjs');
const root=path.resolve(__dirname,'..');
const api=()=>import(pathToFileURL(path.join(root,'functions/_shared/portfolio-summary.js')));
const routes=()=>import(pathToFileURL(path.join(root,'functions/api/portfolio/summary.js')));
const fx={rates:{JPY:8.7462,USD:1351.25,CNY:191.2},asOf:'2026-11-03',updated:'2026-11-03T00:00:00Z',basis:'previous-business-day-close'};

function fixture(){
  const products=[{id:'1',kind:'card',minPrice:12,currency:'JPY'},{id:'1',kind:'box',minPrice:999,currency:'USD'},
    {id:'2',kind:'box',minPrice:100,currency:'USD'},{id:'3',kind:'card',minPrice:1234,currency:'KRW'},
    {id:'4',kind:'card',minPrice:0,currency:'JPY'},{id:'5',kind:'card',minPrice:2,currency:'JPY'}];
  const details={cards:{1:{grades:{psa10:{lowest_ask:100,currency:'USD'},psa9:{recent_avg:1234,currency:'KRW'},raw:{currency:'USD'}},product:{lastPrice:1300,currency:'KRW'}},
    2:{product:{lastPrice:0,lowestAsk:9999,currency:'JPY'}},3:{product:{lowestAsk:25,currency:'USD'}},4:{grades:{raw:{lowest_ask:'0',currency:'JPY'}}}}};
  const rawHistories={1:{history:[{psa10_price:9,psa9_price:10,raw_price:12},{raw_price:0},{raw_price:15}]},
    5:{history:[{raw_price:50},{raw_price:0},{raw_price:75}]}};
  const histories=new Map(Object.entries(rawHistories).map(([id,data])=>[id,latestHistory(data.history)]));
  const boxIds=new Set(['3']),snapshot=snapshotFromInputs({products,details,histories,boxIds,fx});
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tcghub-portfolio-quotes-'));
  writePortfolioSnapshot(snapshot,path.join(folder,'portfolio-quotes.json'));
  return {folder,products,details,rawHistories,boxIds,snapshot,cleanup:()=>fs.rmSync(folder,{recursive:true,force:true})};
}
function assets(f,{modify,fail}={}){
  const requests=[];let active=0,maxActive=0;
  return {requests,maxActive:()=>maxActive,fetch:async request=>{
    requests.push(request.url);active++;maxActive=Math.max(maxActive,active);
    try{
      await Promise.resolve();const url=new URL(request.url);
      if(fail?.(url))return new Response('{}',{status:404,headers:{'content-type':'application/json'}});
      const name=url.pathname.replace(/^\/data\//,''),data=JSON.parse(fs.readFileSync(path.join(f.folder,name),'utf8'));
      return new Response(JSON.stringify(modify?modify(data,url):data),{headers:{'content-type':'application/json'}});
    }finally{active--;}
  }};
}

test('compact quote rows preserve actual legacy grade, currency, box and fallback valuation',async()=>{
  const f=fixture();try{
    const {valueHoldings}=await api(),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
    const start=html.indexOf('async function fetchCardMeta(cardId) {'),end=html.indexOf('let _PF_OWNER_ID',start);
    const ctx={console,Map,Promise,Math,AbortSignal,Date,USD_KRW:fx.rates.USD,JPY_KRW:fx.rates.JPY,
      window:{},BOX_ID_SET:f.boxIds,_PF_PRICE_CACHE:{},loadCardProductData:async()=>f.products,
      loadCardsDetail:async()=>f.details,fetch:async url=>{
        const history=f.rawHistories[String(url).match(/\/history\/([^/?]+)\.json/)?.[1]];
        return {ok:!!history,json:async()=>history};
      }};
    vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);
    const quotes=new Map(Object.entries(f.snapshot.quotes));
    const holdings=[];
    for(const id of ['1','2','3','4','5','unknown'])for(const grade of ['psa10','psa9','raw','box','bgs10_bl'])holdings.push({card_id:id,grade,qty:2,buy_price:91});
    const metas=new Map();for(const holding of holdings)if(!metas.has(holding.card_id))metas.set(holding.card_id,await ctx.fetchCardMeta(holding.card_id));
    let expected=0,cost=0;
    for(const h of holdings){const meta=metas.get(h.card_id),isBox=h.grade==='box'||meta.kind==='box'||f.boxIds.has(h.card_id);
      const amount=(isBox?meta.latestPrices.box:meta.latestPrices[h.grade])||h.buy_price;
      expected+=(amount||0)*(h.qty||0);cost+=(h.buy_price||0)*(h.qty||0);
      const one=valueHoldings([h],quotes,fx.rates);assert.equal(one.totalValueJpy,(amount||0)*(h.qty||0),h.card_id+'/'+h.grade);
    }
    const value=valueHoldings(holdings,quotes,fx.rates);assert.equal(value.totalValueJpy,expected);assert.equal(value.totalCostJpy,cost);
    assert.equal(value.totalValueKrw,Math.floor(expected*fx.rates.JPY));
    assert.equal(quotes.get('1')[0],false,'first metadata match wins over duplicate box');
    assert.equal(metas.get('1').latestPrices.raw,Math.round(15*fx.rates.USD/fx.rates.JPY),'existing history/detail currency behavior is preserved');
  }finally{f.cleanup();}
});

test('only distinct holding buckets load, at most four concurrently, with fixed release identity',async()=>{
  const f=fixture();try{
    const {loadHoldingQuotes}=await api(),holdings=Array.from({length:1000},(_,i)=>({card_id:String(i)})),binding=assets(f);
    const result=await loadHoldingQuotes({assets:binding,origin:'https://tcghub.kr/api/portfolio/summary',holdings});
    assert.equal(result.requests,17);assert.equal(binding.requests.length,17);assert(binding.maxActive()<=4);
    assert(result.quotes.has('1'));assert(!binding.requests.some(url=>/history|cards-meta/.test(url)));
    assert.equal(bucket('1'),(await api()).quoteBucket('1'));
  }finally{f.cleanup();}
});

test('missing, mixed and malformed public quote snapshots fail rather than publish partial totals',async()=>{
  const f=fixture();try{
    const {loadHoldingQuotes}=await api(),holdings=[{card_id:'1'}],run=binding=>loadHoldingQuotes({assets:binding,origin:'https://tcghub.kr/',holdings});
    await assert.rejects(run(assets(f,{fail:url=>url.pathname.includes('/portfolio-quotes/')})),/unavailable/);
    await assert.rejects(run(assets(f,{modify:(value,url)=>url.pathname.includes('/portfolio-quotes/')?{...value,sourceHash:'0'.repeat(64)}:value})),/mismatch/);
    await assert.rejects(run(assets(f,{modify:(value,url)=>url.pathname.includes('/portfolio-quotes/')?{...value,quotes:{...value.quotes,1:[true]}}:value})),/record/);
    await assert.rejects(run({fetch:async()=>new Response('<html>fallback</html>',{headers:{'content-type':'text/html'}})}),/JSON required/);
    const controller=new AbortController();
    // Test the actual explicit abort path even if a binding ignores request.signal.
    const aborted=loadHoldingQuotes({assets:{fetch:async()=>new Promise(()=>{})},origin:'https://tcghub.kr/',holdings,signal:controller.signal});
    controller.abort();await assert.rejects(aborted,/deadline/);
  }finally{f.cleanup();}
});

test('authenticated summary is owner scoped, private, uncached and deleted users are rejected',async()=>{
  const f=fixture();try{
    const {onRequestGet}=await routes(),{signJwt}=await import(pathToFileURL(path.join(root,'functions/_shared/jwt.js')));
    const users=new Map([['a',{id:'a',email:'a@example.test'}],['b',{id:'b',email:'b@example.test'}]]),holdings={a:[{card_id:'1',grade:'raw',qty:2,buy_price:91}],b:[{card_id:'2',grade:'raw',qty:1,buy_price:32}]};
    const queries=[],binding=assets(f),env={JWT_SECRET:'isolated-portfolio-summary-test-key',ASSETS:binding,DB:{prepare:sql=>({bind:id=>({
      first:async()=>{queries.push({sql,id});return sql.includes('FROM users')?users.get(id):{count:id==='a'?4:7};},
      all:async()=>{queries.push({sql,id});return {results:holdings[id]};},
    })})}};
    const token=async id=>signJwt({sub:id,email:users.get(id).email,exp:Math.floor(Date.now()/1000)+60},env.JWT_SECRET);
    const request=async(id,extra='')=>onRequestGet({env,request:new Request('https://tcghub.kr/api/portfolio/summary'+extra,{headers:id?{Cookie:'session='+await token(id)}:{}})});
    assert.equal((await request(null)).status,401);assert.equal(binding.requests.length,0,'unauthorized callers never access market snapshots');
    const response=await request('a','?userId=b'),a=await response.json();assert.equal(response.status,200);
    assert.equal(a.userId,'a');assert.equal(a.holdingsCount,1);assert.equal(a.watchCount,4);
    assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('vary'),'Cookie');
    const b=await(await request('b')).json();assert.equal(b.userId,'b');assert.equal(b.watchCount,7);assert.notEqual(a.totalValueJpy,b.totalValueJpy);
    assert(!JSON.stringify(a).includes('email'));assert(!JSON.stringify(a).includes('holdings"'));
    holdings.a[0].qty=3;assert.equal((await(await request('a')).json()).totalValueJpy,a.totalValueJpy/2*3,'successful changes are read again without cached personal totals');
    let activeUser='a';
    const client={window:{},AbortController,setTimeout,clearTimeout,Date,fetch:async(url,options)=>{
      assert.equal(url,'/api/portfolio/summary');assert.equal(options.credentials,'include');assert.equal(options.cache,'no-store');
      return request(activeUser);
    }};
    vm.createContext(client);vm.runInContext(fs.readFileSync(path.join(root,'assets/portfolio-summary-client.js'),'utf8'),client);
    const fromServer=await client.window.PortfolioSummaryClient.get('a');
    assert.equal(fromServer.totalValueJpy,a.totalValueJpy/2*3,'actual endpoint JSON is accepted without a legacy fallback');
    assert.equal(fromServer.holdingsCount,1);assert.equal(fromServer.fx.asOf,fx.asOf);assert.equal(fromServer.fx.rates.JPY,fx.rates.JPY);
    activeUser='b';const switched=await client.window.PortfolioSummaryClient.get('b');assert.equal(switched.userId,'b');assert.equal(switched.totalValueJpy,b.totalValueJpy);
    client.window.PortfolioSummaryClient.invalidate();
    await assert.rejects(client.window.PortfolioSummaryClient.get('a'),/identity or snapshot changed/,'another account response is never accepted by the real client');
    const old=await token('a');users.delete('a');const deleted=await onRequestGet({env,request:new Request('https://tcghub.kr/api/portfolio/summary',{headers:{Cookie:'session='+old}})});assert.equal(deleted.status,401);
    assert(queries.every(query=>['a','b'].includes(query.id)),'every private SQL read is bound to the authenticated user');
  }finally{f.cleanup();}
});

test('deploy builder uses the actual current product loader and keeps foreign, fallback and orphan history IDs',async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tcghub-portfolio-build-'));
  try{
    fs.mkdirSync(path.join(folder,'assets'));fs.mkdirSync(path.join(folder,'data/history'),{recursive:true});
    fs.copyFileSync(path.join(root,'index.html'),path.join(folder,'index.html'));
    for(const name of ['japanese-card-names','card-catalog-repairs','japanese-catalog','onepiece-official-catalog','anniversary-market','promo-search'])fs.copyFileSync(path.join(root,'assets',name+'.js'),path.join(folder,'assets',name+'.js'));
    const write=(name,data)=>fs.writeFileSync(path.join(folder,'data',name+'.json'),JSON.stringify(data));
    write('cards-meta',{cards:[{id:'101',name:'Pikachu',kind:'card',brand:'pokemon',language:'ja'},{id:'103',name:'Pikachu EN',kind:'card',brand:'pokemon',language:'en'}]});
    write('cards-prices',{prices:{101:[99,'USD',1],103:[10,'USD',2]}});
    write('price-box-name-overrides',{});write('cards-meta-index',{});
    for(const brand of ['pokemon','onepiece']){
      write('price-'+brand+'-box',{products:[]});write('top10-'+brand,{products:[]});
      write('manual-boxes-'+brand,{products:brand==='pokemon'?[{id:'401',name:'Example Box',code:'SV4K',currency:'JPY',lastPrice:7000}]:[]});
      write('price-'+brand+'-card',{products:brand==='pokemon'?[{id:'501',name:'Saved old product',lastPrice:321,currency:'JPY'}]:[]});
    }
    for(const name of ['anniversary-market','futuristic-market'])write(name,{schemaVersion:1,products:{}});
    write('promo-search',{schemaVersion:1,cards:[]});write('card-catalog-repairs',{schemaVersion:1,pokemonImages:[],englishDonProductIds:[],onepieceDon:[]});
    write('cards-detail',{cards:{101:{grades:{raw:{lowest_ask:88,currency:'USD'}}}}});write('fx-rates',fx);
    write('history/101',{history:[{raw_price:44}]});write('history/999',{history:[{raw_price:12}]});
    const result=await compilePortfolioSnapshot(folder);
    for(const id of ['101','103','401','501','999'])assert(Object.hasOwn(result.quotes,id),id+' remains available to saved holdings');
    assert.equal(result.quotes['101'][5],88);assert.equal(result.quotes['101'][6],'USD');
    assert.equal(result.quotes['401'][0],true);assert.equal(result.quotes['401'][7],7000);
    assert.equal(result.quotes['501'][7],321);assert.equal(result.quotes['999'][5],12);
    fs.unlinkSync(path.join(folder,'data/cards-meta.json'));
    await assert.rejects(compilePortfolioSnapshot(folder),/Incomplete portfolio product sources/,'missing primary sources cannot publish a reduced summary snapshot');
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test('entire summary has a deadline even when a database read stalls',async()=>{
  const {createPortfolioSummary}=await routes(),{signJwt}=await import(pathToFileURL(path.join(root,'functions/_shared/jwt.js')));
  const secret='isolated-portfolio-summary-deadline-key',user={id:'fixture',email:'fixture@example.test'};
  const env={JWT_SECRET:secret,DB:{prepare:sql=>({bind:()=>({first:async()=>sql.includes('FROM users')?user:new Promise(()=>{}),all:async()=>new Promise(()=>{})})})}};
  const token=await signJwt({sub:user.id,exp:Math.floor(Date.now()/1000)+60},secret);
  const response=await createPortfolioSummary({deadlineMs:10})({env,request:new Request('https://tcghub.kr/api/portfolio/summary',{headers:{Cookie:'session='+token}})});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{ok:false,error:'summary_unavailable'});
  const stalledAuth={...env,DB:{prepare:()=>({bind:()=>({first:async()=>new Promise(()=>{})})})}};
  const authResponse=await createPortfolioSummary({deadlineMs:10})({env:stalledAuth,request:new Request('https://tcghub.kr/api/portfolio/summary',{headers:{Cookie:'session='+token}})});
  assert.equal(authResponse.status,503,'the deleted-user authorization lookup has the same finite response deadline');
});
