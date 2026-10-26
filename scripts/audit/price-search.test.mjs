import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
const root=new URL('../../',import.meta.url),html=readFileSync(new URL('index.html',root),'utf8');
const code=html.slice(html.indexOf('function cancelPriceSearch('),html.indexOf('function renderSearchResultsTo('));
const flush=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function harness({grade=async()=>{},load=async()=>{},search=q=>[{id:q,name:q,minPrice:10,currency:'JPY'}]}={}){
 const nodes=new Map(),renders=[],handlers={},timers=[];let previews=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',innerHTML:'',textContent:'',style:{},dataset:{},hidden:false,onclick:null,scrollIntoView(){},classList:{add(){},remove(){},toggle(){}}});return nodes.get(id);};
 const ctx=vm.createContext({console:{warn(){}},Array,Number,Math,Date,URLSearchParams,Set,
  window:{PRICE_CAT:'window-sentinel',scrollTo(){},PortfolioScreen:{cancelChart(){}}},location:{hash:'#price',search:''},
  document:{body:{dataset:{page:'price'}},getElementById:node,querySelectorAll:()=>[],querySelector:()=>({classList:{add(){}}}),addEventListener:(event,handler)=>{(handlers[event]??=[]).push(handler);}},
  PRICE_CACHE:{},HOME_TOP_CACHE:{},PRICE_LOADING:false,PRICE_GRID_REQUEST:0,_SEARCH_PREVIEW_REQUEST:0,_SEARCH_TIMER:null,
  setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},loadCardSearchData:load,searchCards:search,
  escapeHtml:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),fmtKrw:(v,c)=>c+':'+v,
  JapaneseCatalog:{href:c=>c.productId?'#price/'+c.productId:'/?set='+c.id+'#cardinfo'},
  applyGradePrices:grade,renderPriceGrid:p=>{renders.push(p);node('priceGrid').innerHTML=p.map(x=>'<a data-id="'+x.id+'"></a>').join('');},
  renderSearchResultsTo(){previews++;},AUTH_READY:true,isAdminAccount:()=>false,initHome2(){},refreshPortfolio(){},
  history:{pushState(a,b,hash){ctx.location.hash=hash;},replaceState(a,b,hash){ctx.location.hash=hash;}}
 });
 ctx.window.JapaneseCatalog=ctx.JapaneseCatalog;
 vm.runInContext("let PRICE_CAT='box';let PRICE_BRAND='pokemon';",ctx);
 vm.runInContext(code,ctx);
 return {ctx,node,renders,handlers,timers,previews:()=>previews,render:(r,q,p)=>ctx.renderPriceSearchAsGrid(r,q,p),cancel:()=>ctx.cancelPriceSearch()};
}
const rows=n=>Array.from({length:n},(_,i)=>({_catalogue:true,id:'JP:'+i,name:'Pikachu '+i,thumbnailUrl:'/card/'+i+'.png'}));
const cardCount=h=>(h.node('priceGrid').innerHTML.match(/class="price-card"/g)||[]).length;
test('5,000 catalogue results render at most 60 cards, with total count and pagination',()=>{
 const h=harness();h.render(rows(5000),'Pikachu');assert.equal(cardCount(h),60);assert(h.node('priceStatus').innerHTML.includes('5000'));assert(h.node('priceStatus').innerHTML.includes('1–60'));assert.equal(h.node('priceSearchPages').hidden,false);
});
test('every result remains reachable without duplication across bounded pages',()=>{
 const h=harness(),all=rows(5000),seen=[];h.render(all,'Pikachu');
 for(let page=1;page<=84;page++){
  if(page>1)h.node('priceSearchPages').onclick({target:{closest:()=>({disabled:false,dataset:{priceSearchPage:String(page)}})}});
  assert(cardCount(h)<=60);seen.push(...[...h.node('priceGrid').innerHTML.matchAll(/href="\/\?set=([^"&]+)#cardinfo"/g)].map(x=>x[1]));
 }
 assert.equal(seen.length,5000);assert.equal(new Set(seen).size,5000);assert.equal(seen.at(-1),'JP:4999');assert(h.node('priceStatus').innerHTML.includes('4981–5000'));
});
test('small and empty searches hide pagination and retain escaped query output',()=>{
 const h=harness();h.render(rows(61),'large');h.render([],"<img onerror='x'>");assert.equal(h.node('priceSearchPages').hidden,true);assert(!h.node('priceStatus').innerHTML.includes('<img'));assert(h.node('priceStatus').innerHTML.includes('&lt;img'));
 h.render(rows(1),'single');assert.equal(cardCount(h),1);assert.equal(h.node('priceSearchPages').hidden,true);
});
test('catalogue links retain exact printed-card and market-product destinations',()=>{
 const h=harness();h.render([{_catalogue:true,id:'JP:printed',name:'Printed'},{id:'market',productId:'618442',name:'Market'}],'mixed');const body=h.node('priceGrid').innerHTML;
 assert(body.includes('href="/?set=JP:printed#cardinfo"'));assert(body.includes('href="#price/618442"'));
});
test('generic result decoration runs only for the current 60-result page',async()=>{
 let decorated=0;const h=harness({grade:async p=>{decorated=p.length;}});h.render(Array.from({length:5000},(_,i)=>({id:String(i),name:'Card',minPrice:25,currency:'JPY'})),'many');await flush();assert.equal(decorated,60);assert.equal(h.renders[0].length,60);assert.equal(h.renders[0][0].currency,'JPY');
});
test('late A grade decoration cannot overwrite B search',async()=>{
 const pending=deferred();let calls=0;const h=harness({grade:()=>++calls===1?pending.promise:Promise.resolve()});h.render([{id:'A'}],'A');h.render([{id:'B'}],'B');await flush();pending.resolve();await flush();assert.equal(h.renders.length,1);assert.equal(h.renders[0][0].id,'B');
});
test('an empty or catalogue B search also invalidates pending generic A',async()=>{
 for(const next of [[],rows(1)]){const pending=deferred(),h=harness({grade:()=>pending.promise});h.render([{id:'A'}],'A');h.render(next,'B');const before=h.node('priceGrid').innerHTML;pending.resolve();await flush();assert.equal(h.node('priceGrid').innerHTML,before);assert.equal(h.renders.length,0);}
});
test('leaving, changing brand or changing category blocks pending search rendering',async()=>{
 for(const kind of ['page','brand','category','hash']){
  const pending=deferred(),h=harness({grade:()=>pending.promise});h.render([{id:'A'}],'A');
  if(kind==='page')h.ctx.document.body.dataset.page='home';if(kind==='brand')vm.runInContext("PRICE_BRAND='onepiece'",h.ctx);if(kind==='category')vm.runInContext("PRICE_CAT='card'",h.ctx);if(kind==='hash')h.ctx.location.hash='#price/618442';
  pending.resolve();await flush();assert.equal(h.renders.length,0,kind);
 }
});
test('search decoration uses the lexical card category and always restores it',async()=>{
 const h=harness();h.ctx.renderPriceGrid=()=>{assert.equal(vm.runInContext('PRICE_CAT',h.ctx),'card');throw Error('render failed');};h.render([{id:'A'}],'A');await flush();assert.equal(vm.runInContext('PRICE_CAT',h.ctx),'box');assert.equal(h.ctx.window.PRICE_CAT,'window-sentinel');assert(h.node('priceGrid').innerHTML.includes('다시 시도'));
});
test('new search invalidates an in-flight catalogue grid request',()=>{
 const h=harness();h.ctx.PRICE_GRID_REQUEST=7;h.ctx.PRICE_LOADING=true;h.render(rows(1),'A');assert.equal(h.ctx.PRICE_GRID_REQUEST,8);assert.equal(h.ctx.PRICE_LOADING,false);
});
test('submit A awaiting index load cannot win after submit B',async()=>{
 const pending=deferred();let calls=0;const h=harness({load:()=>++calls===1?pending.promise:Promise.resolve()});const old=h.ctx.runPriceSearch('A');await h.ctx.runPriceSearch('B');await flush();pending.resolve();await old;await flush();assert.equal(h.renders.length,1);assert.equal(h.renders[0][0].id,'B');
});
test('cancellation hides pager, releases old results and cancels delayed index work',async()=>{
 const pending=deferred(),h=harness({load:()=>pending.promise});h.render(rows(200),'old');const old=h.ctx.runPriceSearch('A');h.cancel();assert.equal(h.ctx.renderPriceSearchAsGrid.results,null);assert.equal(h.node('priceSearchPages').hidden,true);pending.resolve();await old;assert.equal(h.renders.length,0);
});
test('actual go path invokes cancellation before a pending search completes',async()=>{
 const pending=deferred(),h=harness({grade:()=>pending.promise});h.render([{id:'A'}],'A');vm.runInContext(html.slice(html.indexOf('function parsePageRoute('),html.indexOf('// data-nav 클릭')),h.ctx);h.ctx.go('home');pending.resolve();await flush();assert.equal(h.renders.length,0);assert.equal(h.ctx.document.body.dataset.page,'home');
});
test('actual catalogue reload invalidates pending search before its network response',async()=>{
 const pending=deferred(),h=harness({grade:()=>pending.promise});h.render([{id:'A'}],'A');
 h.ctx.enrichPriceProductMetadata=async()=>{};h.ctx.isPriceBoxProduct=()=>true;h.ctx.fetch=async()=>({ok:true,json:async()=>({ok:true,products:[{id:'catalogue'}]})});
 const start=html.indexOf('async function loadPriceGrid()');vm.runInContext(html.slice(html.lastIndexOf('let PRICE_GRID_REQUEST =',start),html.indexOf('// 시세 상품 ID',start)),h.ctx);await h.ctx.loadPriceGrid();pending.resolve();await flush();assert.equal(h.renders.length,1);assert.equal(h.renders[0][0].id,'catalogue');
});
test('route query load does not replace a user-edited input or a newer submission',async()=>{
 for(const action of ['edit','submit']){
  const pending=deferred(),h=harness();h.ctx.location.hash='#price?q=A';h.ctx.initPrice=()=>pending.promise;
  vm.runInContext(html.slice(html.indexOf('function parsePageRoute('),html.indexOf('// data-nav 클릭')),h.ctx);h.ctx.initPriceRoute({query:'A',path:'price?q=A'});
  if(action==='edit')h.node('cardSearchInput').value='B';else await h.ctx.runPriceSearch('B');pending.resolve();await flush();assert(!h.renders.some(p=>p[0]?.id==='A'));
 }
});
test('a submitted search prevents an older dropdown preview reopening',async()=>{
 const pending=deferred();let loads=0;const h=harness({load:()=>++loads===1?pending.promise:Promise.resolve()});
 const start=html.indexOf('let _SEARCH_TIMER =');vm.runInContext(html.slice(start,html.indexOf('// 검색 인덱스 사전 워밍',start)),h.ctx);
 const input=h.node('cardSearchInput');input.id='cardSearchInput';input.value='old';h.handlers.input[0]({target:input});const old=h.timers[0]();await h.ctx.runPriceSearch('new');pending.resolve();await old;assert.equal(h.previews(),0);assert.equal(h.node('cardSearchResults').style.display,'none');
});
