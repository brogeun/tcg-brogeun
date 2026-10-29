'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const manifest=JSON.parse(read('data/card-catalog-repairs.json'));
const source=read('assets/card-catalog-repairs.js'),html=read('index.html');
const row=(id='871082',extra={})=>({id,brand:'onepiece',kind:'card',language:'ja',minPrice:33,currency:'USD',...extra});
const quote=(id,amount=3500,extra={})=>({ok:true,id,grades:{raw:{lowest_ask:amount,currency:'JPY'}},fetchedAt:new Date().toISOString(),...extra});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(fetcher){const ctx=vm.createContext({console,AbortSignal,fetch:fetcher});vm.runInContext(source,ctx);ctx.CardCatalogRepairs.configure(manifest);return ctx.CardCatalogRepairs;}
function host(id){const nodes=Object.fromEntries(['main','origin','stock','note'].map(name=>['[data-card-price-'+name+']',{textContent:'recorded '+name}]));return {dataset:{liveCardPrice:id},isConnected:true,nodes,querySelector:s=>nodes[s]};}
const container=(...hosts)=>({hosts,querySelectorAll(){return this.hosts;}});
const format={formatKrw:(n,c)=>{assert.equal(c,'JPY');return '₩'+(n*10).toLocaleString('en-US');},formatOrig:(n,c)=>{assert.equal(c,'JPY');return '¥'+n.toLocaleString('en-US');}};
test('the exact reported partial English query finds the two Japanese Rocks designs only',()=>{
  const api=setup(async()=>{throw Error('Search must not fetch prices synchronously');});
  const products=api.products(manifest.onepieceDon.map(card=>row(card.productId,{name:card.marketName,productNumber:'OPC-TCG-OP-17-DON'})).concat(row('882454',{name:'DON!! Card :Gold Text (Rocks Pirates)',productNumber:'OPC-TCG-OP-17-DON'})));
  const ctx=vm.createContext({console,URLSearchParams,CardCatalogRepairs:api,_ALL_CARDS_INDEX:products,_SEARCH_ALIASES:{}});ctx.window=ctx;
  for(const file of ['assets/japanese-card-names.js','assets/japanese-catalog.js'])vm.runInContext(read(file),ctx);
  ctx.JapaneseCardNames.configure({schemaVersion:1});ctx.JapaneseCatalog.configure({schemaVersion:1,sets:[],cards:[]});ctx.JapaneseCatalog.setProducts(products);
  vm.runInContext(html.slice(html.indexOf('function searchCards('),html.indexOf('function renderSearchResults(')),ctx);
  for(const query of ['don!! card (rock','don!! card rocks','록스 해적단','ロックス海賊団'])assert.deepEqual(Array.from(ctx.searchCards(query,Infinity),r=>r.id).sort(),['871082','881694'],query);
  assert(!ctx.searchCards('OP17 골드',Infinity).some(r=>r.id==='871082'),'Diamond must not inherit the source title\'s Gold Text label');
});
test('Japanese 3500 JPY quote replaces cached USD 33 without changing the stored product',async()=>{
  const calls=[],api=setup(async url=>{calls.push(url);return {ok:true,json:async()=>quote('871082')};});
  const product=row(),before=JSON.stringify(product),h=host(product.id);
  await api.hydratePrices(container(h),[product],format);
  assert.equal(h.nodes['[data-card-price-main]'].textContent,'₩35,000');
  assert.equal(h.nodes['[data-card-price-origin]'].textContent,'¥3,500');
  assert.equal(h.nodes['[data-card-price-stock]'].textContent,'판매 중');
  assert.equal(JSON.stringify(product),before);
  assert.deepEqual(calls,['/api/card-grades?id=871082']);
  await api.hydratePrices(container(host(product.id)),[product],format);assert.equal(calls.length,1);
});
test('foreign, wrong-brand, boxes and unreviewed product IDs never borrow a Japanese quote',async()=>{
  let calls=0;const api=setup(async()=>{calls++;throw Error('Unexpected request');});
  const rows=[row('882454'),row('871082',{language:'en'}),row('881694',{brand:'pokemon'}),row('871079',{kind:'box'})];
  await api.hydratePrices(container(...rows.map(r=>host(r.id))),rows,format);assert.equal(calls,0);
});
test('identity, currency, freshness and transport failures retain the recorded quote',async()=>{
  for(const value of [quote('882454'),quote('871082',3500,{grades:{raw:{lowest_ask:33,currency:'USD'}}}),quote('871082',3500,{fetchedAt:'2020-01-01T00:00:00Z'}),quote('871082',3500,{ok:false}),quote('871082',3500,{grades:{raw:{lowest_ask:'3500',currency:'JPY'}}}),null]){
    const api=setup(async()=>{if(!value)throw Error('offline');return {ok:true,json:async()=>value};}),h=host('871082');
    await api.hydratePrices(container(h),[row()],format);assert.equal(h.nodes['[data-card-price-main]'].textContent,'recorded main');
  }
});
test('explicit A-grade unavailability clears an obsolete price without displaying zero',async()=>{
  const api=setup(async()=>({ok:true,json:async()=>quote('871082',0,{grades:{},noListingGrades:['raw']})})),h=host('871082');
  await api.hydratePrices(container(h),[row()],format);assert.equal(h.nodes['[data-card-price-main]'].textContent,'매물 없음');assert.equal(h.nodes['[data-card-price-origin]'].textContent,'');
});
test('a late old search cannot overwrite a newer result or a detached row',async()=>{
  const a=deferred(),b=deferred(),api=setup(url=>url.endsWith('871082')?a.promise:b.promise),old=host('871082'),next=host('881694'),list=container(old);
  const first=api.hydratePrices(list,[row()],format);list.hosts=[next];const second=api.hydratePrices(list,[row('881694')],format);
  b.resolve({ok:true,json:async()=>quote('881694',1000)});await second;a.resolve({ok:true,json:async()=>quote('871082')});await first;
  assert.equal(old.nodes['[data-card-price-main]'].textContent,'recorded main');assert.equal(next.nodes['[data-card-price-origin]'].textContent,'¥1,000');
  next.isConnected=false;await api.hydratePrices(container(next),[row('881694')],format);assert.equal(next.nodes['[data-card-price-origin]'].textContent,'¥1,000');
});
test('only visible reviewed rows are fetched, with at most three requests at once',async()=>{
  let active=0,max=0,calls=0;const api=setup(async url=>{calls++;max=Math.max(max,++active);await new Promise(setImmediate);active--;const id=new URL(url,'https://tcghub.kr').searchParams.get('id');return {ok:true,json:async()=>quote(id)};});
  const rows=manifest.onepieceDon.map(card=>row(card.productId)),visible=rows.slice(0,5);
  await api.hydratePrices(container(...visible.map(r=>host(r.id)),host(visible[0].id)),rows,format);assert.equal(calls,5);assert(max<=3);
});
test('the actual dropdown formats JPY as KRW plus JPY and wires the live updater',()=>{
  const nodes={cardSearchInput:{value:'록스'}},box={style:{},innerHTML:''};nodes.cardSearchResults=box;let hydration;
  const repairs={hydratePrices:(element,rows,options)=>{hydration={element,rows,options};}};
  const ctx=vm.createContext({document:{getElementById:id=>nodes[id]},window:{CardCatalogRepairs:repairs},escapeHtml:String,fmtKrw:(n,c)=>c+':KRW:'+n,fmtOrig:(n,c)=>c+':'+n});
  vm.runInContext(html.slice(html.indexOf('function renderSearchResultsTo('),html.indexOf('// Shared favorite toggle',html.indexOf('function renderSearchResultsTo('))),ctx);
  ctx.renderSearchResultsTo('cardSearchResults',[row('871082',{name:'Rocks DON',productNumber:'OP17-DON',minPrice:3500,currency:'JPY'})],'록스');
  assert(box.innerHTML.includes('JPY:KRW:3500'));assert(box.innerHTML.includes('JPY:3500'));assert(!box.innerHTML.includes('$3500'));
  assert.equal(hydration.element,box);assert.equal(hydration.options.isCurrent(),true);nodes.cardSearchInput.value='new';assert.equal(hydration.options.isCurrent(),false);
});
