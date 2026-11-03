'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('let _SEARCH_TIMER = null;');
const end = html.indexOf('function renderSearchResultsTo(', start);
assert(start >= 0 && end > start);

function harness(search) {
  const listeners = new Map(), timers = new Map(), calls = [], previews = [], hydration = [];
  let timerId = 0, legacy = 0, grades = 0;
  const elements = new Map();
  for (const id of ['priceGrid','priceStatus','priceListInfo','priceSearchPages','cardSearchResults','homeSearchResults','cardSearchClear','homeSearchClear']) {
    elements.set(id, {id, innerHTML:'',textContent:'',style:{},hidden:false,scrollIntoView(){}});
  }
  const ctx = {
    console, WeakSet, Promise,
    document: {body:{dataset:{page:'price'}},getElementById:id=>elements.get(id)||null,
      addEventListener:(name, fn)=>{ if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn); }},
    window:{CardSearchClient:{search:async(q,options)=>{calls.push({q,options});return search(q,options);},warm:()=>Promise.resolve()},
      CardCatalogRepairs:{hydratePrices:(...args)=>hydration.push(args)}},
    location:{hash:'#price'},
    PRICE_BRAND:'pokemon',PRICE_CAT:'card',PRICE_GRID_REQUEST:0,PRICE_LOADING:false,
    escapeHtml:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    fmtKrw:amount=>'₩'+amount,fmtOrig:amount=>'¥'+amount,
    loadCardSearchData:async()=>{legacy++;}, searchCards:()=>[],
    applyGradePrices:async()=>{grades++;}, renderPriceGrid:()=>{},
    renderSearchResultsTo:(...args)=>previews.push(args),
    setTimeout:(fn)=>{const id=++timerId;timers.set(id,fn);return id;},
    clearTimeout:id=>timers.delete(id)
  };
  vm.createContext(ctx);vm.runInContext(html.slice(start,end),ctx);
  return {ctx,elements,calls,previews,hydration,listeners,legacy:()=>legacy,grades:()=>grades,
    fire:(name,event)=>{for(const fn of listeners.get(name)||[])fn(event);},
    flushTimers:async()=>{const pending=[...timers.values()];timers.clear();for(const fn of pending)await fn();}};
}
const rows = (offset, length=60) => Array.from({length},(_,i)=>({id:'JP:ONEPIECE:OP01-'+(offset+i),
  name:'Luffy '+(offset+i),displayName:'루피 '+(offset+i),kind:'card',brand:'onepiece',
  href:'/?set=OP01&card=OP01-'+(offset+i)+'#cardinfo',thumbnailUrl:'/images/card.png',
  minPrice:100+offset+i,currency:'JPY',setName:'로맨스 던',number:String(offset+i),_catalogue:true}));

(async()=>{
  const h=harness(async(q,o)=>({results:rows(o.offset||0,Math.min(o.limit,137-(o.offset||0))),total:137}));
  await h.ctx.runPriceSearch('루피',2);
  assert.equal(h.calls[0].options.limit,60);
  assert.equal(h.calls[0].options.offset,60);
  assert.equal(h.calls[0].options.lane,'price-grid');
  assert.equal(h.legacy(),0,'Prepared search must not load full product metadata');
  assert.equal(h.grades(),0,'Prepared search must not load full grade details');
  assert.equal((h.elements.get('priceGrid').innerHTML.match(/class="price-card"/g)||[]).length,60);
  assert.match(h.elements.get('priceGrid').innerHTML,/href="\/\?set=OP01&amp;card=OP01-60#cardinfo"/);
  assert.match(h.elements.get('priceStatus').innerHTML,/137<\/b>개 · 61–120 표시/);
  assert.match(h.elements.get('priceSearchPages').innerHTML,/2 \/ 3/);
  h.elements.get('priceSearchPages').onclick({target:{closest:()=>({dataset:{priceSearchPage:'3'},disabled:false})}});
  await new Promise(setImmediate);
  assert.equal(h.calls.at(-1).options.offset,120);
  assert.match(h.elements.get('priceStatus').innerHTML,/121–137 표시/);
  assert.equal((h.elements.get('priceGrid').innerHTML.match(/class="price-card"/g)||[]).length,17);

  let resolveOld;
  const stale=harness((q)=>q==='old'?new Promise(resolve=>{resolveOld=resolve;}):Promise.resolve({results:rows(9,1),total:1}));
  const old=stale.ctx.runPriceSearch('old');
  await stale.ctx.runPriceSearch('new');
  const shown=stale.elements.get('priceGrid').innerHTML;
  resolveOld({results:rows(1,1),total:1});await old;
  assert.equal(stale.elements.get('priceGrid').innerHTML,shown,'Late old search cannot replace newer results');
  let resolveNavigation;
  const navigated=harness(()=>new Promise(resolve=>{resolveNavigation=resolve;}));
  const pending=navigated.ctx.runPriceSearch('루피');navigated.ctx.document.body.dataset.page='home';
  resolveNavigation({results:rows(1,1),total:1});await pending;
  assert.equal(navigated.elements.get('priceGrid').innerHTML,'','Navigation cancels in-flight grid rendering');

  const ime=harness(async()=>({results:rows(1,1),total:1}));
  const input={id:'cardSearchInput',value:'리자몽'};
  ime.fire('compositionstart',{target:input});
  ime.fire('input',{target:input,isComposing:true});
  ime.fire('keydown',{target:input,key:'Enter',isComposing:true,preventDefault(){throw Error('IME Enter must not submit');}});
  await ime.flushTimers();assert.equal(ime.calls.length,0);
  ime.fire('compositionend',{target:input});await ime.flushTimers();
  assert.equal(ime.calls.length,1);assert.equal(ime.calls[0].options.lane,'price-preview');
  assert.equal(ime.calls[0].options.limit,30);assert.equal(ime.previews.length,1);
  input.value='';ime.fire('input',{target:input});await ime.flushTimers();
  assert.equal(ime.elements.get('cardSearchResults').style.display,'none');
  assert.equal(ime.calls.length,1,'Clearing search cannot schedule stale empty work');
  const linked=harness(async()=>({results:rows(1,1),total:1}));
  let initialLoads=0;
  linked.ctx.initPrice=()=>{initialLoads++;return Promise.resolve();};
  vm.runInContext(html.slice(html.indexOf('function initPriceRoute(route) {'),html.indexOf('function activatePage(',html.indexOf('function initPriceRoute(route) {'))),linked.ctx);
  linked.ctx.initPriceRoute({path:'price',query:'Pikachu'});
  await new Promise(setImmediate);
  assert.equal(initialLoads,1);
  assert.equal(linked.calls.length,1,'A shared price-search route uses the bounded client too');
  assert.equal(linked.calls[0].options.lane,'price-grid');
  assert.equal(linked.legacy(),0,'A shared search route must not force the complete catalogue');
  const beforeDeparture=linked.calls.length;
  linked.ctx.initPriceRoute({path:'price',query:'late'});
  linked.ctx.document.body.dataset.page='home';
  await new Promise(setImmediate);
  assert.equal(linked.calls.length,beforeDeparture,'A departed shared search starts no request');
  console.log('Fast price search: bounded paging, complete totals, exact routes, stale guards and Korean IME passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
