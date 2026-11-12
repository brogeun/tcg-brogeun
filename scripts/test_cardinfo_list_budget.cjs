'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function between(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert(a>=0&&b>a,start);return html.slice(a,b);}
function catalogue(){
 const list={innerHTML:''},categories={innerHTML:'',hidden:true},ctx=vm.createContext({window:{},document:{getElementById:id=>id==='onepieceCategoryFilters'?categories:list},escapeHtml:esc});
 vm.runInContext(between('const CARDINFO = {','/* ─────────── 세트 카드 그리드 모달'),ctx);
 return {ctx,list,categories,run:source=>vm.runInContext(source,ctx)};
}
test('every original box appears once across bounded pages without changing original catalogue rows',()=>{
 const h=catalogue(),before=h.run('JSON.stringify(CARDINFO)');
 for(const brand of ['pokemon','onepiece']){
  h.run(`CI_TAB=${JSON.stringify(brand)};CI_QUERY='';renderCardInfo();`);
  const count=h.run(`CARDINFO.${brand}.length`),codes=[];
  for(let page=1;page<=Math.ceil(count/24);page++){
   h.run(`CI_SET_PAGE=${page};renderCardInfo();`);
   const visible=[...h.list.innerHTML.matchAll(/class="set-tile"/g)];assert(visible.length<=24);
   codes.push(...[...h.list.innerHTML.matchAll(/class="set-tile-code">([^<]+)/g)].map(match=>match[1]));
  }
  assert.equal(codes.length,count);assert.equal(new Set(codes).size,count);
 }
 assert.equal(h.run('JSON.stringify(CARDINFO)'),before);
});
test('query, category and brand changes reset the page while an ordinary redraw preserves it',()=>{
 const h=catalogue();h.run('renderCardInfo();CI_SET_PAGE=3;renderCardInfo();');assert.equal(h.run('CI_SET_PAGE'),3);
 h.run("CI_QUERY='古';renderCardInfo();");assert.equal(h.run('CI_SET_PAGE'),1);
 h.run("CI_QUERY='';renderCardInfo();CI_SET_PAGE=3;CI_TAB='onepiece';renderCardInfo();");assert.equal(h.run('CI_SET_PAGE'),1);
 h.run("CARDINFO.onepiece=Array.from({length:60},(_,n)=>({code:'T'+n,name:'fixture',category:n%2?'starter':'booster'}));CI_SET_PAGE=2;renderCardInfo();CI_ONEPIECE_CATEGORY='starter';renderCardInfo();");
 assert.equal(h.run('CI_SET_PAGE'),1);assert.equal([...h.list.innerHTML.matchAll(/class="set-tile"/g)].length,24);
 h.run('CI_SET_PAGE=999;renderCardInfo();');assert.equal(h.run('CI_SET_PAGE'),2);
});
test('shared/off-page box headers use the same reviewed original artwork as list tiles',async()=>{
 const h=catalogue();h.run("CARDINFO.pokemon=[{code:'S8',name:'fixture',imageVersion:'fixture-v',imageScale:1.1}];");
 const nodes=new Map();let content='';
 const element=()=>({classList:{add(){},contains:()=>true,toggle:()=>true},setAttribute(){},addEventListener(){},focus(){},scrollTop:0,innerHTML:'',hidden:true});
 const scroll=element(),panel=element(),modal={...element(),querySelector:selector=>selector==='.ci-panel-scroll'?scroll:panel};
 Object.assign(h.ctx,{CI_PANEL_REQUEST:0,CI_CARD_PAGE_SIZE:18,ciIcon:()=>'',document:{getElementById(id){if(id==='anyModal')return modal;if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},querySelectorAll:()=>[],activeElement:null},
  openAnyModal(value){content=value;},fetch:async()=>({ok:false}),location:{href:'https://tcghub.kr/?set=S8#cardinfo'},navigator:{},URL,console});
 vm.runInContext(between('window.openSetGrid = async function','/* ─────────── 카드정보 set-code'),h.ctx);
 await h.ctx.window.openSetGrid('S8','fixture','');
 assert.match(content,/class="ci-panel-thumb" src="images\/box\/s8.webp\?v=fixture-v"/);
 assert.equal(h.run("cardInfoSetArtwork(CARDINFO.pokemon[0]).src"),'images/box/s8.webp?v=fixture-v');
});

function search(){
 const timers=new Map(),handlers={},clicks=[],renders=[],input={value:'',style:{},focus(){this.focused=true;},addEventListener:(name,fn)=>handlers[name]=fn},clear={style:{},addEventListener:(name,fn)=>{handlers['clear:'+name]=fn;}},list={querySelector:()=>null,scrollIntoView(){}};
 let sequence=0;const ctx=vm.createContext({window:{},CI_QUERY:'',CI_SET_PAGE:3,_FEATURE_ROUTE_RUN:1,
  document:{body:{dataset:{page:'cardinfo'}},getElementById:id=>id==='cardInfoSearchInput'?input:id==='cardInfoSearchClear'?clear:list,addEventListener:(name,fn)=>clicks.push(fn)},
  setTimeout(fn,delay){const id=++sequence;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),renderCardInfo:()=>renders.push({query:ctx.CI_QUERY,page:ctx.CI_SET_PAGE})});
 vm.runInContext(between('(function bindCardInfoSearch(){','let _CARDINFO_SETUP_STARTED='),ctx);
 return {ctx,input,clear,handlers,timers,renders,flush(){const jobs=[...timers.values()];timers.clear();jobs.forEach(job=>job.fn());}};
}
test('box search coalesces typing into one 180ms render and resets the list page',()=>{
 const h=search();h.input.value='고';h.handlers.input({});h.input.value='고대';h.handlers.input({});
 assert.equal(h.renders.length,0);assert.equal(h.timers.size,1);assert.equal([...h.timers.values()][0].delay,180);
 h.flush();assert.deepEqual(h.renders,[{query:'고대',page:1}]);
});
test('IME intermediate values never render and the final input/composition pair renders once',()=>{
 const h=search();h.handlers.compositionstart();h.input.value='ㄱ';h.handlers.input({isComposing:true});h.input.value='고';h.handlers.input({isComposing:true});
 assert.equal(h.timers.size,0);assert.equal(h.ctx.CI_QUERY,'');assert.ok(h.ctx.window._CI_USER_INTENT>0);
 h.handlers.compositionend({});h.handlers.input({isComposing:false});assert.equal(h.timers.size,1);h.flush();
 assert.deepEqual(h.renders,[{query:'고',page:1}]);
});
test('clear is immediate and old search work cannot render after leaving and revisiting the route',()=>{
 const h=search();h.input.value='피카츄';h.handlers.input({});h.handlers['clear:click']();
 assert.equal(h.timers.size,0);assert.deepEqual(h.renders,[{query:'',page:1}]);assert.equal(h.input.focused,true);
 h.input.value='나미';h.handlers.input({});h.ctx._FEATURE_ROUTE_RUN++;h.ctx.document.body.dataset.page='home';h.flush();assert.equal(h.renders.length,1);
 h.ctx.document.body.dataset.page='cardinfo';h.input.value='루피';h.handlers.input({});h.ctx._FEATURE_ROUTE_RUN++;h.flush();assert.equal(h.renders.length,1);
});
test('changing a box filter can commit the pending input without an extra intermediate render',()=>{
 const h=search();h.input.value='고대';h.handlers.input({});h.ctx.window.flushCardInfoSearch({render:false});
 assert.equal(h.ctx.CI_QUERY,'고대');assert.equal(h.ctx.CI_SET_PAGE,1);assert.equal(h.timers.size,0);assert.equal(h.renders.length,0);
});
test('the real English box adapter returns to page one when its shared box query changes',async()=>{
 const nodes=new Map(),clicks=[],sets=Array.from({length:60},(_,n)=>({code:'EN-'+n,name:'Alpha '+n,displayCode:'EN'+n,release:'2026-01-01'}));
 const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',dataset:{},classList:{add(){},remove(){}},remove(){},scrollIntoView(){}});return nodes.get(id);};
 const ctx=vm.createContext({URLSearchParams,window:{ChineseCatalog:{initialLanguage:'en'}},CI_TAB:'pokemon',CI_QUERY:'',renderCardInfo(){},location:{hash:'#cardinfo',search:''},
  document:{body:{dataset:{page:'cardinfo'}},getElementById:node,querySelectorAll:()=>[],addEventListener:(type,handler)=>{if(type==='click')clicks.push(handler);}},
  fetch:async url=>({ok:true,json:async()=>String(url).includes('english-catalog.json')?{schemaVersion:1,sets}:{schemaVersion:1,names:{}}})});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/english-catalog.js'),'utf8'),ctx);
 for(let i=0;i<10;i++)await Promise.resolve();
 const button={disabled:false,dataset:{encPage:'2'},hasAttribute:name=>name==='data-enc-page'};clicks[0]({target:{closest:()=>button},preventDefault(){},stopPropagation(){}});
 assert.match(node('cardInfoList').innerHTML,/data-enc-set="EN-24"/);
 ctx.CI_QUERY='Alpha';ctx.renderCardInfo();assert.match(node('cardInfoList').innerHTML,/data-enc-set="EN-0"/);
 assert.doesNotMatch(node('cardInfoList').innerHTML,/data-enc-set="EN-24"/);
});

function boards({auto=[],admin=[],reject=false}={}){
 const elements=new Map(),panels=['news','events','etc','cardshow','grading'].map(hubpanel=>({dataset:{hubpanel},style:{display:hubpanel==='news'?'':'none'}}));
 const counters={homeNews:0,homeEvents:0,homeEtc:0,recommendations:0,rows:0,fetches:0};
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const ctx=vm.createContext({window:{HubNewsDetail:{isDirectNews:()=>false,card(item){counters.rows++;return '<article>'+esc(item.title)+'</article>';}}},URL,location:{origin:'https://tcghub.kr'},console,escapeHtml:esc,
  EVENTS:[{id:'event',title:'event original',content:'full event'}],ETC_LIST:[{id:'etc',title:'etc original',content:'full etc'}],CARDSHOWS:[{id:'show',title:'show original',date:'2027-01-01'}],GRADING_LIST:[{id:'grading',title:'grading original'}],
  renderHomeNewsGrid:()=>counters.homeNews++,renderHomeEventsCarousel:()=>counters.homeEvents++,renderHomeEtcCarousel:()=>counters.homeEtc++,renderHomeRecommendations:()=>counters.recommendations++,
  _eventsCarouselRestart(){},_etcCarouselRestart(){},
  loadPublicBoardData:async()=>{if(reject)throw Error('fixture failure');return admin;},
  fetch:async()=>{counters.fetches++;await pending;if(reject)throw Error('fixture failure');return {ok:true,json:async()=>({items:auto})};},
  document:{body:{dataset:{page:'home'}},getElementById:id=>elements.get(id),querySelectorAll:()=>panels}});
 ctx.HubNewsDetail=ctx.window.HubNewsDetail;
 class Element{
  constructor(page,panel){this.page=page;this.panel=panel;this._html='';this.style={};}
  get innerHTML(){return this._html;}set innerHTML(value){this._html=String(value);}
  get childNodes(){return this._html?[{}]:[];}
  set textContent(value){this._html=String(value);}
  closest(selector){if(selector==='.page')return {classList:{contains:()=>ctx.document.body.dataset.page===this.page}};return panels.find(panel=>panel.dataset.hubpanel===this.panel)||null;}
 }
 for(const [id,page,panel]of [['newsList','hub','news'],['eventList','events'],['eventListHub','hub','events'],['etcList','etc'],['etcListHub','hub','etc'],['cardshowListHub','hub','cardshow'],['gradingListHub','hub','grading']])elements.set(id,new Element(page,panel));
 for(const id of ['newsPagination','newsPageStatus','newsPageButtons'])elements.set(id,new Element());
 vm.runInContext(between('const HUB_NEWS_PAGE_SIZE =','// Home and news use the same source'),ctx);
 vm.runInContext(between('function newsImageUrl(','function renderHubNewsPage('),ctx);
 vm.runInContext(between('function renderHubNewsPage()',"document.getElementById('newsPageButtons').addEventListener"),ctx);
 vm.runInContext(between('function renderEvents()','// API 에서 데이터 로드 후 렌더'),ctx);
 vm.runInContext(between('function showHubPanel(which)','function applyHubTab(top)'),ctx);
 return {ctx,elements,counters,release,run:source=>vm.runInContext(source,ctx),show(page,panel='news'){ctx.document.body.dataset.page=page;ctx.showHubPanel(panel);}};
}
test('hidden full boards produce no row markup while home summaries and original arrays still update',()=>{
 const h=boards(),before=h.run('JSON.stringify([EVENTS,ETC_LIST,CARDSHOWS,GRADING_LIST])');
 h.run('renderEvents();renderEtc();renderCardshows();renderGrading();');
 assert.equal(h.counters.rows,0);assert(h.counters.homeEvents>0);assert(h.counters.homeEtc>0);assert(h.counters.recommendations>0);
 for(const [id,element]of h.elements)if(id.endsWith('List')||id.endsWith('ListHub'))assert.equal(element.innerHTML,'');
 assert.equal(h.run('JSON.stringify([EVENTS,ETC_LIST,CARDSHOWS,GRADING_LIST])'),before);
});
test('events render in one visible destination and the old duplicate DOM is released on navigation',()=>{
 const h=boards();h.show('events');assert.match(h.elements.get('eventList').innerHTML,/event original/);assert.equal(h.elements.get('eventListHub').innerHTML,'');
 h.show('hub','events');assert.equal(h.elements.get('eventList').innerHTML,'');assert.match(h.elements.get('eventListHub').innerHTML,/event original/);
 h.run("EVENTS=[{id:'event',title:'saved change'}];renderEvents();");assert.match(h.elements.get('eventListHub').innerHTML,/saved change/);
 h.show('home');assert.equal(h.elements.get('eventListHub').innerHTML,'');h.show('hub','events');assert.match(h.elements.get('eventListHub').innerHTML,/saved change/);
});
test('switching hub subpanels mounts only the selected full board',()=>{
 const h=boards();h.show('hub','grading');assert.match(h.elements.get('gradingListHub').innerHTML,/grading original/);
 h.show('hub','etc');assert.equal(h.elements.get('gradingListHub').innerHTML,'');assert.match(h.elements.get('etcListHub').innerHTML,/etc original/);
 h.show('hub','cardshow');assert.equal(h.elements.get('etcListHub').innerHTML,'');assert.match(h.elements.get('cardshowListHub').innerHTML,/show original/);
});
test('news loads for home without hidden list DOM and mounts the existing 15-row page on entry',async()=>{
 const auto=Array.from({length:20},(_,n)=>({id:'n'+n,title:'news '+n,date:'2026-11-'+String(20-n).padStart(2,'0')}));
 const h=boards({auto}),work=h.ctx.loadNews();assert.equal(h.elements.get('newsList').innerHTML,'');h.release();await work;
 assert.equal(h.counters.homeNews,1);assert.equal(h.elements.get('newsList').innerHTML,'');assert.equal(h.run('HUB_NEWS_ITEMS.length'),20);
 h.show('hub','news');assert.equal([...h.elements.get('newsList').innerHTML.matchAll(/class="hub-news-card"/g)].length,15);assert.equal(h.counters.fetches,1);
 h.show('home');assert.equal(h.elements.get('newsList').innerHTML,'');h.show('hub','news');assert.equal(h.counters.fetches,1);
});
test('a news response arriving after leaving cannot repopulate hidden DOM',async()=>{
 const h=boards({auto:[{id:'one',title:'late news',date:'2026-11-13'}]});h.show('hub','news');const work=h.ctx.loadNews();assert.match(h.elements.get('newsList').innerHTML,/불러오는 중/);
 h.show('home');h.release();await work;assert.equal(h.elements.get('newsList').innerHTML,'');assert.equal(h.counters.homeNews,1);
 h.show('hub','news');assert.match(h.elements.get('newsList').innerHTML,/late news/);
});
test('a hidden failed news load retains its error state for later visible rendering',async()=>{
 const h=boards({reject:true}),work=h.ctx.loadNews();h.release();await work;assert.equal(h.elements.get('newsList').innerHTML,'');
 h.show('hub','news');assert.match(h.elements.get('newsList').innerHTML,/뉴스를 불러오지 못했습니다/);
});
