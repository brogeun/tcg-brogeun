'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..');
const read=name=>JSON.parse(fs.readFileSync(path.join(ROOT,name),'utf8'));
function runtime(extraFiles=new Map()){
  const requests=[];
  const context={window:{},document:{readyState:'complete',getElementById:()=>null},Intl,URL,Map,Set,Date,console,
    fetch:async url=>{requests.push(url);try{const pathname=url.split('?')[0];return {ok:true,json:async()=>extraFiles.has(pathname)?(typeof extraFiles.get(pathname)==='function'?extraFiles.get(pathname)():extraFiles.get(pathname)):read(pathname.replace(/^\//,''))};}catch{return {ok:false};}}};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT,'assets/market-references.js'),'utf8'),context);
  return {api:context.window.MarketReferences,requests};
}
test('loading the shared market module does not eagerly request manifests or shards',()=>{
  const {api,requests}=runtime();assert.equal(typeof api.mountEnglishCard,'function');assert.deepEqual(requests,[]);
});
test('USD values use source dollars and missing/zero prices stay unpriced',()=>{
  const {api}=runtime();assert.equal(api.amount(1.25,'USD'),'$1.25');assert.equal(api.amount(0),'—');assert.equal(api.amount(null),'—');assert.equal(api.amount(undefined),'—');assert.equal(api.amount(NaN),'—');
});
test('US printing prices remain separate and do not become PSA or completed sales',()=>{
  const {api}=runtime();const html=api.printingHTML({Normal:{marketPrice:1.25,lowPrice:1,midPrice:2,highPrice:3},Holofoil:{marketPrice:5.75,lowPrice:4,midPrice:6,highPrice:9},'Reverse Holofoil':{marketPrice:null,lowPrice:null}});
  assert.match(html,/\$1\.25/);assert.match(html,/\$5\.75/);assert.match(html,/Reverse Holofoil/);assert.match(html,/호가 중간값/);assert.match(html,/추정 참고가/);assert.doesNotMatch(html,/PSA|실거래가|판매완료/);
});
test('external source links reject script URLs and unrelated hosts',()=>{
  const {api}=runtime();assert.equal(api.safeUrl('javascript:alert(1)'), '');assert.equal(api.safeUrl('https://evil.test',['tcgplayer.com']),'');assert.equal(api.safeUrl('https://tcgplayer.com.evil.test',['tcgplayer.com']),'');assert.match(api.safeUrl('https://www.tcgplayer.com/product/123',['tcgplayer.com']),/^https:/);
});
const sourceHrefs=html=>[...html.matchAll(/href="([^"]+)"/g)].map(match=>new URL(match[1].replace(/&amp;/g,'&'),'https://tcghub.kr'));
test('source links preserve exact full numbers and explicit game aliases without network requests',()=>{
  const {api,requests}=runtime(),html=api.sourceLinks({_brand:'union-arena',fullCardNumber:'UA18BT/NIK-1-019★',grade:'PSA10',name:'Ignored name',lastPrice:12345}),urls=sourceHrefs(html);
  assert.equal(urls.length,2);assert.equal(urls[0].pathname,'/market-references');assert.equal(urls[0].searchParams.get('source'),'yuyu');assert.equal(urls[1].searchParams.get('source'),'mercari');for(const url of urls){assert.equal(url.searchParams.get('game'),'union_arena');assert.equal(url.searchParams.get('q'),'UA18BT/NIK-1-019★');assert.equal(url.searchParams.has('price'),false);assert.equal(url.searchParams.has('grade'),false);}assert.deepEqual(requests,[]);
});
test('PSA detail links are clearly raw-shop and candidate references',()=>{
  const {api}=runtime(),html=api.sourceLinks({brand:'weis-schwarz',fullCardNumber:'NIK/S117-087SP',grade:'PSA10'});assert.match(html,/미감정 판매가 참고/);assert.match(html,/참고 매물/);assert.doesNotMatch(html,/PSA10|PSA 10|감정가|실거래가/);assert.equal(sourceHrefs(html)[0].searchParams.get('game'),'weiss_schwarz');
});
test('source links escape user-controlled values and never infer game or number from name plus price',()=>{
  const {api}=runtime(),number='OP13-001"><script>bad</script>',html=api.sourceLinks({brand:'unknown"><img src=x onerror=alert(1)>',fullCardNumber:number});assert.doesNotMatch(html,/<script>|<img|onerror=/);for(const url of sourceHrefs(html)){assert.equal(url.searchParams.get('q'),number);assert.equal(url.searchParams.has('game'),false);}const neutral=sourceHrefs(api.sourceLinks({brand:'NIKKE',name:'Card 12345',lastPrice:99999}));assert.ok(neutral.every(url=>!url.searchParams.has('q')&&!url.searchParams.has('game')));
});
test('printed full numbers outrank truncated provider SKUs and known prefixes stay explicit',()=>{
  const {api}=runtime();assert.equal(sourceHrefs(api.sourceLinks({brand:'weiss_schwarz',name:'Dorothy SR [NIK/S117-087S]',productNumber:'WS-TCG-NIK/S117-087'}))[0].searchParams.get('q'),'NIK/S117-087S');assert.equal(sourceHrefs(api.sourceLinks({brand:'pokemon-card',name:'Psyduck AR [M2a 199/193]'}))[0].searchParams.get('q'),'M2a 199/193');assert.equal(sourceHrefs(api.sourceLinks({brand:'yu-gi-oh',code:'YGO-QCCP-JP001'}))[0].searchParams.get('q'),'QCCP-JP001');assert.equal(api.sourceLinks({kind:'box',brand:'pokemon'}),'');
});
test('unsupported and unknown games receive Mercari references without a misleading Yuyutei link',()=>{
  const {api}=runtime();for(const brand of ['yugioh','yu-gi-oh','dragon_ball_fusion_world','dragon-ball-super-card-game','NIKKE','unknown']){const html=api.sourceLinks({brand,fullCardNumber:'QCCP-JP001'}),urls=sourceHrefs(html);assert.equal(urls.length,1);assert.equal(urls[0].searchParams.get('source'),'mercari');assert.doesNotMatch(html,/미감정 판매가 참고|유유테이/);}for(const brand of ['pokemon','onepiece','weis-schwarz','union-arena','digimoncard'])assert.equal(sourceHrefs(api.sourceLinks({brand,cardNumber:'001'})).length,2);
});
test('reference search tolerates source separator spelling while retaining full number and suffix',()=>{
  const {api}=runtime();assert.equal(api.queryMatches('UA18BT/NIK-1-019 SR★★','UA18BT-NIK-1-019'),true);assert.equal(api.queryMatches('199/193 AR Psyduck M2a','M2a 199/193'),true);assert.equal(api.queryMatches('NIK/S117-087S','NIK/S117-087SP'),false);
});
test('same-number and same-rarity Yuyutei parallels retain exact product identity',()=>{
  const {api}=runtime();const rows=api.yuyuRows({game:'onepiece',sourceGame:'opc',columns:['sourceSetCode','sourceProductId','setCode','cardNumber','rarity','name','price','stock','stockState'],rows:[['op17','10155','OP17','OP17-118','P-SEC','Card',3980,1,'in_stock'],['op17','10156','OP17','OP17-118','P-SEC','Card parallel',398000,null,'in_stock_quantity_unknown']]});
  assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);assert.notEqual(rows[0].sourceUrl,rows[1].sourceUrl);assert.match(api.yuyuItem(rows[0]),/3,980/);assert.match(api.yuyuItem(rows[1]),/398,000/);
});
test('Yuyutei stock unknown is distinct from out of stock and known quantity',()=>{
  const {api}=runtime();assert.equal(api.stockLabel({stockState:'unknown',stock:null}),'재고 미확인');assert.equal(api.stockLabel({stockState:'out_of_stock',stock:0}),'품절');assert.equal(api.stockLabel({stockState:'in_stock',stock:3}),'재고 3개');assert.equal(api.stockLabel({stockState:'in_stock_quantity_unknown',stock:null}),'재고 있음 · 수량 미확인');
});
test('blocked shop refresh is explicit and legacy all-failed retention is never reported as a successful refresh',()=>{
  const {api}=runtime();assert.equal(api.yuyuRefreshDelayed({lastRun:{outcome:'blocked'},requestsThisRun:0,games:[]}),true);assert.equal(api.yuyuRefreshDelayed({requestsThisRun:140,games:[{coverage:{recordsFetchedThisRun:0,failedSets:100}},{coverage:{recordsFetchedThisRun:0,failedSets:40}}]}),true);
  assert.equal(api.yuyuRefreshDelayed({requestsThisRun:140,games:[{coverage:{recordsFetchedThisRun:1,failedSets:139}}]}),false);assert.equal(api.yuyuRefreshDelayed({requestsThisRun:0,games:[{coverage:{recordsFetchedThisRun:0,failedSets:140}}]}),false);assert.equal(api.yuyuRefreshDelayed({lastRun:{outcome:'success'},requestsThisRun:140,games:[{coverage:{recordsFetchedThisRun:0,failedSets:140}}]}),false);assert.equal(api.yuyuRefreshDelayed({requestsThisRun:140,games:[{coverage:{failedSets:140}}]}),false);
});
test('source titles, attributes and image URLs cannot inject markup',()=>{
  const {api}=runtime();const html=api.yuyuItem({id:'" onclick="alert(1)',name:'<script>alert(1)</script>',variant:'<img src=x onerror=alert(1)>',image:'javascript:alert(1)',price:1,sourceUrl:'javascript:alert(1)'});
  assert.doesNotMatch(html,/<script>|<img src=x|src="javascript:|href="javascript:/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&quot; onclick=&quot;/);
});
test('Mercari unknown candidate stays outside valuation and retains its own display price',()=>{
  const {api}=runtime();const html=api.mercariItem({id:'mercari:m123',title:'Candidate',price:{amount:19000,currency:'JPY'},saleStatus:'unknown',verification:'unverified',valuationEligible:false,fetchStatus:'ok',observedAt:'2026-10-29T00:00:00Z',sourceUrl:'https://jp.mercari.com/item/m123'});
  assert.match(html,/参考|참고 매물/);assert.match(html,/판매 상태 미확인/);assert.match(html,/자동 평가액 제외/);assert.match(html,/19,000/);assert.doesNotMatch(html,/판매완료 확인/);
});
test('Mercari failed refresh shows retained information without inventing a new observation time',()=>{
  const {api}=runtime();const html=api.mercariItem({id:'m123',price:{amount:10,currency:'JPY'},saleStatus:'unknown',verification:'unverified',valuationEligible:false,fetchStatus:'error',stale:true},new Date().toISOString());assert.match(html,/확인 미확인/);assert.match(html,/이전 확인 정보, 갱신 지연/);
});
test('SNKRDUNK listing currency and graded asks remain separate',()=>{
  const {api}=runtime();const html=api.snkrItem({name:'Card',minPrice:100,currency:'USD',kind:'card',url:'https://snkrdunk.com/apparels/123',grades:{raw:{currency:'JPY',availability:'listed',lowest_ask:39800,active_count:1},psa10:{currency:'JPY',availability:'no-listing'}}});
  assert.match(html,/상태 미지정 최저 호가/);assert.match(html,/\$100\.00/);assert.match(html,/39,800/);assert.match(html,/PSA 10/);assert.match(html,/판매등록 없음/);assert.doesNotMatch(html,/PSA 10[^]*?\$100\.00|A급|마지막 체결/);
});
test('SNKRDUNK native-only ask retains its original currency without inventing USD conversion',()=>{
  const {api}=runtime();const html=api.snkrItem({name:'Native quote',minPrice:null,currency:'USD',catalogAsk:{amount:12000,currency:'JPY',kind:'lowest_listing_ask',condition:'unspecified'}});assert.match(html,/12,000/);assert.match(html,/상태 미지정 최저 호가 · JPY/);assert.doesNotMatch(html,/\$12,000|참고가 · USD/);
});
function pageRuntime(files,search){
  const elements=new Map(),requests=[];let click;
  const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',value:'',hidden:false,handlers:{},classList:{toggle(){}},addEventListener(type,handler){this.handlers[type]=handler;},scrollIntoView(){}});return elements.get(id);};
  const root={querySelectorAll:()=>[],querySelector:()=>element('kind'),addEventListener(type,handler){if(type==='click')click=handler;}};
  const context={window:{},document:{readyState:'complete',getElementById:id=>id==='marketReferences'?root:element(id)},location:{search},Intl,URL,URLSearchParams,Map,Set,Date,console,setTimeout,clearTimeout,fetch:async url=>{const pathname=url.split('?')[0];requests.push(pathname);return {ok:files.has(pathname),json:async()=>{const data=files.get(pathname);return typeof data==='function'?data():data;}};}};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT,'assets/market-references.js'),'utf8'),context);
  return {element,requests,loadAll(){click({target:{closest:()=>({dataset:{mrLoadAll:'true'}})}});},switchSource(source){click({target:{closest:()=>({dataset:{mrSource:source}})}});}};
}
test('dotted shop set filenames load and delayed old shop response cannot overwrite the selected source',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve),files=new Map([
    ['/data/yuyutei-market.json',{games:[{game:'weiss_schwarz',sourceGame:'ws',shard:'/data/yuyutei-market/weiss_schwarz.json'}]}],
    ['/data/yuyutei-market/weiss_schwarz.json',{game:'weiss_schwarz',sourceGame:'ws',columns:[],rows:[],sets:[{sourceSetCode:'dcext1.0',name:'Dotted set',recordCount:1,shard:'/data/yuyutei-market/weiss_schwarz/dcext1.0.json'}]}],
    ['/data/yuyutei-market/weiss_schwarz/dcext1.0.json',()=>pending],
    ['/data/us-market.json',{sets:[{code:'EN-X',name:'US set',matchedCount:1,file:'/data/us-market/EN-X.json'}]}],
    ['/data/us-market/EN-X.json',{setCode:'EN-X',cards:{'1':{name:'Current US Card',printings:{}}}}]
  ]);
  const page=pageRuntime(files,'?source=yuyu&game=weiss_schwarz');await new Promise(setImmediate);assert.ok(page.requests.includes('/data/yuyutei-market/weiss_schwarz/dcext1.0.json'));
  page.switchSource('us');await new Promise(setImmediate);assert.match(page.element('mrResults').innerHTML,/Current US Card/);
  release({records:[{name:'Stale Shop Card',sourceSetCode:'dcext1.0'}]});await new Promise(setImmediate);page.element('mrFilters').handlers.submit({preventDefault(){}});assert.match(page.element('mrResults').innerHTML,/Current US Card/);assert.doesNotMatch(page.element('mrResults').innerHTML,/Stale Shop Card/);
});
test('published shard traversal is rejected before a fetch is issued',async()=>{
  const page=pageRuntime(new Map([['/data/us-market.json',{sets:[{code:'EN-X',name:'Bad source',matchedCount:1,file:'/data/us-market/../outside.json'}]}]]),'?source=us');await new Promise(setImmediate);assert.ok(!page.requests.some(url=>url.includes('/../')));assert.match(page.element('mrResults').innerHTML,/지금 불러올 수 없습니다/);
});
test('card-detail reference link searches all collected shop sets instead of only the initial set',async()=>{
  const files=new Map([
    ['/data/yuyutei-market.json',{games:[{game:'onepiece',sourceGame:'opc',shard:'/data/yuyutei-market/onepiece.json'}]}],
    ['/data/yuyutei-market/onepiece.json',{game:'onepiece',sourceGame:'opc',columns:['sourceSetCode','sourceProductId','cardNumber','name','price'],rows:[['op13','10001','OP13-001','Older Exact Card',1200]],sets:[{sourceSetCode:'op17',name:'Latest',shard:'/data/yuyutei-market/onepiece/op17.json'},{sourceSetCode:'op13',name:'Older',shard:'/data/yuyutei-market/onepiece/op13.json'}]}]
  ]);const page=pageRuntime(files,'?source=yuyu&game=onepiece&q=OP13-001');await new Promise(setImmediate);assert.match(page.element('mrResults').innerHTML,/Older Exact Card/);assert.equal(page.requests.length,2);assert.ok(!page.requests.includes('/data/yuyutei-market/onepiece/op17.json'));
});
test('direct unsupported Yuyutei game explicitly stays unavailable instead of falling back to Pokemon',async()=>{
  const page=pageRuntime(new Map([['/data/yuyutei-market.json',{games:[{game:'pokemon',sourceGame:'poc',shard:'/data/yuyutei-market/pokemon.json'}]}]]),'?source=yuyu&game=yugioh&q=QCCP-JP001');await new Promise(setImmediate);assert.match(page.element('mrResults').innerHTML,/해당 종목의 수집 자료가 없습니다/);assert.equal(page.requests.length,1);assert.equal(page.element('mrSet').disabled,true);page.element('mrFilters').handlers.submit({preventDefault(){}});assert.match(page.element('mrResults').innerHTML,/해당 종목의 수집 자료가 없습니다/);assert.ok(!page.requests.includes('/data/yuyutei-market/pokemon.json'));
});
test('retained shop prices show refresh-delay label and preserve original observation date',async()=>{
  const observed='2026-10-19T00:00:00Z',files=new Map([
    ['/data/yuyutei-market.json',{lastRun:{outcome:'blocked'},generatedAt:'2026-10-30T00:00:00Z',games:[{game:'onepiece',sourceGame:'opc',shard:'/data/yuyutei-market/onepiece.json',status:'partial',coverage:{recordsFetchedThisRun:0,failedSets:140,collectedSets:1,discoveredSets:1}}]}],
    ['/data/yuyutei-market/onepiece.json',{game:'onepiece',sourceGame:'opc',sourceAsOf:observed,generatedAt:'2026-10-30T00:00:00Z',columns:['sourceSetCode','sourceProductId','cardNumber','name','price','sourceAsOf'],rows:[['op13','10001','OP13-001','Retained Shop Card',1200,observed]],sets:[{sourceSetCode:'op13',name:'OP13'}]}]
  ]);const page=pageRuntime(files,'?source=yuyu&game=onepiece&q=OP13-001');await new Promise(setImmediate);assert.match(page.element('mrCoverage').textContent,/갱신 지연 · 이전 확인 가격 유지/);assert.match(page.element('mrCoverage').textContent,/2026.*10.*19/);assert.match(page.element('mrResults').innerHTML,/Retained Shop Card/);assert.equal(files.get('/data/yuyutei-market/onepiece.json').sourceAsOf,observed);assert.doesNotMatch(page.element('mrCoverage').textContent,/2026.*10.*30/);
});
test('large SNKRDUNK snapshots merge every shard and deduplicate exact product IDs',async()=>{
  const meta={source:'SNKRDUNK',brand:'weiss_schwarz',kind:'card'},files=new Map([
    ['/data/price-weiss_schwarz-card.json',{...meta,totalCount:2,products:[{id:'1',name:'Base'}],shards:['/data/snkrdunk-games/weiss_schwarz-card-0001.json']}],
    ['/data/snkrdunk-games/weiss_schwarz-card-0001.json',{...meta,products:[{id:'1',name:'Duplicate'},{id:'2',name:'Second'}]}]
  ]);const {api,requests}=runtime(files),snapshot=await api.loadSnapshot('/data/price-weiss_schwarz-card.json');assert.equal(snapshot.products.length,2);assert.equal(snapshot.products[0].name,'Base');assert.equal(snapshot.products[1].name,'Second');assert.equal(requests.length,2);
});
test('missing SNKRDUNK shard data cannot silently appear as a complete snapshot',async()=>{
  const {api}=runtime(new Map([['/data/price-weiss_schwarz-card.json',{source:'SNKRDUNK',brand:'weiss_schwarz',kind:'card',totalCount:2,products:[{id:'1'}]}]]));await assert.rejects(api.loadSnapshot('/data/price-weiss_schwarz-card.json'),/Incomplete/);
});
function largeSourceFixture(){
  const meta={source:'SNKRDUNK',brand:'weiss_schwarz',kind:'card'},base='/data/price-weiss_schwarz-card.json',shard='/data/snkrdunk-games/weiss_schwarz-card-0001.json';return new Map([
    ['/data/snkrdunk-games.json',{games:[{id:'weiss_schwarz',cardUrl:base,cardCount:2,listingComplete:false}]}],
    [base,{...meta,totalCount:2,products:[{id:'1',name:'Initial Base Card'}],shards:[shard]}],
    [shard,{...meta,products:[{id:'2',name:'Second Shard Card'}]}]
  ]);
}
test('default SNKRDUNK game renders base immediately without eager shard requests and labels partial scope',async()=>{
  const page=pageRuntime(largeSourceFixture(),'?source=snkr&game=weiss_schwarz');await new Promise(setImmediate);assert.match(page.element('mrResults').innerHTML,/Initial Base Card/);assert.equal(page.requests.length,2);assert.match(page.element('mrCoverage').innerHTML,/1개 표시 \/ 수집 목록 총 2개/);assert.match(page.element('mrCoverage').innerHTML,/일부 목록에서 검색 중/);assert.match(page.element('mrCoverage').innerHTML,/전체 목록 불러오기/);page.loadAll();await new Promise(setImmediate);assert.match(page.element('mrResults').innerHTML,/Second Shard Card/);assert.equal(page.requests.length,3);
});
test('SNKRDUNK query deep links search the full sharded source',async()=>{
  const page=pageRuntime(largeSourceFixture(),'?source=snkr&game=weiss_schwarz&q=Second');await new Promise(setImmediate);assert.match(page.element('mrResults').innerHTML,/Second Shard Card/);assert.equal(page.requests.length,3);
});
test('full SNKRDUNK loader caps concurrency at four and stops queued requests when superseded',async()=>{
  const meta={source:'SNKRDUNK',brand:'weiss_schwarz',kind:'card'},paths=Array.from({length:8},(_,index)=>`/data/snkrdunk-games/weiss_schwarz-card-${String(index+1).padStart(4,'0')}.json`),files=new Map([['/data/price-weiss_schwarz-card.json',{...meta,totalCount:9,products:[{id:'0'}],shards:paths}]]);let active=0,maxActive=0,current=true;const releases=[];for(const [index,path]of paths.entries())files.set(path,async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>releases.push(()=>{active--;resolve();}));return {...meta,products:[{id:String(index+1)}]};});const {api,requests}=runtime(files),pending=api.loadSnapshot('/data/price-weiss_schwarz-card.json',{isCurrent:()=>current});await new Promise(setImmediate);assert.equal(maxActive,4);assert.equal(requests.length,5);current=false;releases.forEach(release=>release());await assert.rejects(pending,/superseded/);assert.equal(requests.length,5);
});
test('current Mercari references render actual URLs and respect recorded eligibility',()=>{
  const {api}=runtime(),data=read('data/mercari-references.json');assert.ok(Array.isArray(data.references));for(const row of data.references){const html=api.mercariItem(row,data.updatedAt);assert.match(html,/메루카리 원문/);if(!row.valuationEligible)assert.match(html,/자동 평가액 제외/);if(row.saleStatus==='unknown')assert.match(html,/판매 상태 미확인/);}
});
test('current US matched card mounts lazily from only manifest plus its shard',async()=>{
  const manifest=read('data/us-market.json'),set=manifest.sets.find(row=>row.matchedCount>0);assert.ok(set,'At least one US set must be matched');const shard=read((set.file||`/data/us-market/${set.code}.json`).slice(1)),[sourceId,card]=Object.entries(shard.cards)[0];assert.ok(card);const {api,requests}=runtime(),element={isConnected:true,innerHTML:''};await api.mountEnglishCard(element,{setCode:set.code,sourceId});assert.equal(requests.length,2);assert.match(element.innerHTML,/미국 시장 참고가/);assert.match(element.innerHTML,/TCGplayer/);assert.match(element.innerHTML,/판본별 Market Price/);assert.ok(element.innerHTML.includes(card.sourceUrl.replace(/&/g,'&amp;')));
});
test('current US missing source ID shows no price instead of a fabricated default printing',async()=>{
  const set=read('data/us-market.json').sets[0];const {api}=runtime(),element={isConnected:true,innerHTML:''};await api.mountEnglishCard(element,{setCode:set.code,sourceId:'not-an-existing-source-id'});assert.match(element.innerHTML,/연결된 미국 시장 가격이 아직 없습니다/);assert.doesNotMatch(element.innerHTML,/\$0\.00|mr-printing-name/);
});
test('current Yuyutei indices decode exact IDs without collapsing products',()=>{
  const {api}=runtime(),manifest=read('data/yuyutei-market.json');assert.ok(manifest.games.length);for(const game of manifest.games){const index=read(game.shard.slice(1)),rows=api.yuyuRows(index),ids=new Set(rows.map(row=>row.id));assert.equal(ids.size,rows.length);for(const row of rows.slice(0,12)){const html=api.yuyuItem(row,index.sourceAsOf);assert.ok(html.includes(row.id));assert.match(html,/유유테이/);assert.match(row.sourceUrl,/^https:\/\/yuyu-tei\.jp\/sell\//);}}
});
test('English catalog still uses the existing independent PSA10 block with separate US hosts',()=>{
  const source=fs.readFileSync(path.join(ROOT,'assets/english-catalog.js'),'utf8');assert.match(source,/const p=c\.psa10,valid=validPrice\(p\)/);assert.match(source,/id="encUSCardMarket"/);assert.match(source,/id="encUSSetMarket"/);assert.match(source,/mountEnglishCard/);assert.match(source,/mountEnglishSet/);
});
