'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const directory=__dirname,root=path.resolve(directory,'..'),tick=()=>new Promise(setImmediate);
function fixtureFunctions(file,names,contextDefaults){
  const source=fs.readFileSync(path.join(directory,file),'utf8'),marker=source.indexOf('(async()=>{')>=0?'(async()=>{':'(async () => {';
  const end=source.indexOf(marker);assert(end>=0,'Existing offline fixture must have a separate test entry point');
  const fixtureVM=contextDefaults?{...vm,createContext(context,...options){Object.assign(context,contextDefaults);return vm.createContext(context,...options);}}:vm;
  const box={require:id=>id==='node:vm'?fixtureVM:require(id),__dirname:path.dirname(path.join(directory,file)),module:{exports:{}},console,URL,URLSearchParams,setImmediate,setTimeout,clearTimeout};
  vm.runInNewContext(source.slice(0,end)+'\nmodule.exports={'+names.join(',')+'};',box,{filename:file+' fixtures'});
  return box.module.exports;
}
const {harness:routingHarness}=fixtureFunctions('audit/routing.test.cjs',['harness']);
const {harness:catalogHarness,deferred}=fixtureFunctions('test_chinese_catalog.cjs',['harness','deferred'],{_FEATURE_ROUTE_RUN:1});
const html=fs.readFileSync(path.join(root,'index.html'),'utf8'),loader=fs.readFileSync(path.join(root,'assets/app-route-loader.js'),'utf8');
const exported={
  'centering-geometry.js':['CenteringGeometry',{}],'centering-result-cache.js':['CenteringResultCache',{}],
  'centering-tool.js':['CenteringTool',{setup(){}}],'admin-editor.js':['AdminEditorUI',{enter(){},access(){}}],
  'Sortable.min.js':['Sortable',{create(){}}],'chinese-catalog.js':['ChineseCatalog',{}],'english-catalog.js':['EnglishCatalog',{}],
  'english-search.js':['EnglishSearch',{}],'riftbound-catalog.js':['RiftboundCatalog',{}],'chiikawa-catalog.js':['ChiikawaCatalog',{}],
  'tcg-search-aliases.js':['TCGSearchAliases',{}],'tcg-card-info.js':['TCGCardInfo',{}],
  'collection-catalog-codec.js':['CollectionCatalogCodec',{}],'collections.js':['TCGCollections',{}],'korean-promos.js':['KoreanPromos',{}],
};
function routing(){
  const h=routingHarness(),ctx=h.ctx,nodes=[],timers=[],calls={home:0,cardinfo:0,centering:0,admin:0},events=[];
  class Element{
    constructor(tag){this.tagName=tag.toUpperCase();this.dataset={};this.style={};this.children=[];this.listeners=new Map();}
    set textContent(value){this.text=String(value);this.children=[];}get textContent(){return this.text||'';}
    getAttribute(key){return this[key]??null;}setAttribute(key,value){this[key]=value;}
    addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
    removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
    prepend(child){child.parent=this;this.children.unshift(child);}append(...children){children.forEach(child=>{child.parent=this;this.children.push(child);});}
    remove(){this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    querySelector(selector){return selector==='[data-feature-load]'?this.children.find(child=>Object.hasOwn(child.dataset,'featureLoad'))||null:null;}
    emit(type){this.done=true;for(const fn of [...(this.listeners.get(type)||[])])fn({target:this});}
  }
  for(const page of h.pages){page.children=[];for(const name of ['prepend','append','querySelector'])page[name]=Element.prototype[name];}
  const originalQueries=ctx.document.querySelectorAll;
  ctx.document.querySelectorAll=selector=>selector==='script[src]'?nodes.filter(n=>n.src&&!n.removed):selector==='link[rel="stylesheet"]'?nodes.filter(n=>n.href&&!n.removed):originalQueries(selector);
  ctx.document.createElement=tag=>new Element(tag);ctx.document.head={appendChild:node=>nodes.push(node)};
  ctx.document.hidden=false;ctx.location.href='https://tcghub.kr/#home';ctx.URL=URL;ctx.CURRENT_USER={id:'fixture',isAdmin:true};ctx.isAdminAccount=()=>ctx.CURRENT_USER?.isAdmin===true;
  ctx.initHome2=()=>calls.home++;ctx.initCardInfoScreen=()=>calls.cardinfo++;ctx.ensureAdminOriginals=async()=>{};ctx.renderAdminList=()=>calls.admin++;
  const actualTimer=setTimeout;
  ctx.setTimeout=(fn,ms)=>ms?actualTimer(fn,ms):(timers.push(fn),{fixtureTimer:true});ctx.clearTimeout=timer=>{if(!timer?.fixtureTimer)clearTimeout(timer);};
  Object.assign(ctx,ctx.window);ctx.window=ctx;
  vm.runInContext(loader,ctx,{filename:'app-route-loader.js'});
  function complete(node){
    if(node.src){const file=new URL(node.src,'https://tcghub.kr').pathname.split('/').pop();const [name,value]=exported[file];
      ctx[name]=name==='CenteringTool'?{setup:()=>calls.centering++}:value;events.push(file);
    }else node.sheet={};node.emit('load');
  }
  async function finish(){for(let i=0;i<60;i++){await tick();const pending=nodes.filter(n=>!n.done&&!n.removed);if(!pending.length){await tick();if(!nodes.some(n=>!n.done&&!n.removed))return;}pending.forEach(complete);}throw Error('Route assets did not settle');}
  return {...h,nodes,timers,calls,events,complete,finish,flushUI(){for(const fn of timers.splice(0))fn();}};
}
function cardInfoSetup(h,{pokemon=[],onepiece=[],registered=onepiece,manifest=Promise.resolve()}={}){
  const start=html.indexOf('let _CARDINFO_SETUP_STARTED=false;'),end=html.indexOf("\ndocument.addEventListener('keydown'",start);
  assert(start>=0&&end>start,'Locate the actual initial card-info setup');
  const opened=[],rendered=[];
  Object.assign(h.ctx,{CARDINFO:{pokemon,onepiece},CI_TAB:'pokemon',
    OnePieceCatalog:{ensureManifest:()=>manifest,registerSets:()=>registered},
    renderCardInfo:()=>rendered.push(h.ctx.CI_TAB),openSetGrid:(...args)=>opened.push(args)});
  vm.runInContext(html.slice(start,end),h.ctx,{filename:'index.html initial card-info setup'});
  return {opened,rendered};
}

test('initial feature navigation waits for DOMContentLoaded and then initializes dependencies in order',async()=>{
  const h=routing(),listeners=[];h.ctx.document.readyState='loading';
  h.ctx.document.addEventListener=(type,fn,options)=>listeners.push({type,fn,options});
  const work=h.ctx.go('centering');await tick();
  assert.equal(h.nodes.length,0,'Optional assets must wait for the core inline setup');assert.equal(h.calls.centering,0);
  assert.equal(listeners.length,1);assert.equal(listeners[0].type,'DOMContentLoaded');assert.equal(listeners[0].options.once,true);
  h.ctx.document.readyState='interactive';listeners[0].fn();await tick();
  assert.equal(h.nodes.length,1);assert(h.nodes[0].href.includes('centering-tool.css'));
  h.complete(h.nodes[0]);await tick();
  for(const [index,file]of ['centering-geometry.js','centering-result-cache.js','centering-tool.js'].entries()){
    assert.equal(h.nodes.length,index+2,'Only the next dependency may be added');
    assert(h.nodes[index+1].src.includes(file));assert.equal(h.calls.centering,0);
    h.complete(h.nodes[index+1]);await tick();
  }
  const result=await work;assert.equal(result.ready,true);h.flushUI();assert.equal(h.calls.centering,1);
  assert.deepEqual(h.events,['centering-geometry.js','centering-result-cache.js','centering-tool.js']);
});

test('a feature left before DOMContentLoaded does not start its optional downloads',async()=>{
  const h=routing(),listeners=[];h.ctx.document.readyState='loading';h.ctx.document.addEventListener=(_type,fn)=>listeners.push(fn);
  const work=h.ctx.go('centering');h.ctx.go('home');h.ctx.document.readyState='interactive';listeners.forEach(fn=>fn());
  const result=await work;assert.equal(result.cancelled,true);assert.equal(h.nodes.length,0);assert.equal(h.calls.centering,0);
});

test('the actual initial card-info setup opens an untouched manifest-based shared card',async()=>{
  const h=routing(),gate=deferred();h.ctx.location.search='?set=ST36&card=OP10-099_p2';
  const setup=cardInfoSetup(h,{manifest:gate.promise,registered:[{code:'ST36',name:'Starter 36',url:'https://fixture.invalid/ST36'}]});
  const work=h.ctx.go('cardinfo');await h.finish();await work;assert.equal(setup.opened.length,0);
  gate.resolve();await tick();assert.equal(setup.opened.length,1);assert.equal(setup.opened[0][0],'ST36');
  assert.equal(setup.opened[0][3].cardKey,'OP10-099_p2');assert.equal(h.ctx.CI_TAB,'onepiece');
});

test('earlier card-info visits cannot open a shared detail after leaving and returning with the same query',async()=>{
  for(const kind of ['manifest','timer']){
    const h=routing(),gate=deferred(),set=kind==='manifest'?{code:'ST36',name:'Starter 36'}:{code:'SV4K',name:'Ancient Roar'};
    h.ctx.location.search='?set='+set.code+'&card=exact-printing';
    const setup=cardInfoSetup(h,{manifest:gate.promise,pokemon:kind==='timer'?[set]:[],registered:kind==='manifest'?[set]:[]});
    const first=h.ctx.go('cardinfo');await h.finish();await first;
    assert.equal(setup.opened.length,0);h.ctx.go('home');const second=h.ctx.go('cardinfo');await second;
    assert.equal(h.ctx.location.hash,'#cardinfo');assert.equal(h.ctx.location.search,'?set='+set.code+'&card=exact-printing');
    gate.resolve();await tick();h.flushUI();
    assert.equal(setup.opened.length,0,'A previous visit cannot reopen its late '+kind+' detail on the new visit');
  }
});

test('real navigation waits for the complete feature profile and cancels departed routes',async()=>{
  const h=routing(),work=h.ctx.go('centering');assert.equal(typeof work?.then,'function','go exposes feature readiness to card navigation');
  assert.equal(h.ctx.document.body.dataset.page,'centering');assert.equal(h.calls.centering,0);
  h.ctx.go('home');await h.finish();await work;h.flushUI();assert.equal(h.calls.centering,0);assert.equal(h.calls.home,1);
});
test('two real card-info navigations initialize once and preserve shared set/card query',async()=>{
  const h=routing(),one=h.ctx.go('cardinfo'),two=h.ctx.go('cardinfo');assert.equal(h.calls.cardinfo,0);
  await h.finish();await Promise.all([one,two]);assert.equal(h.calls.cardinfo,1);
  assert.equal(h.ctx.location.search,'?set=OP01&card=OP01-001');assert.equal(h.ctx.location.hash,'#cardinfo');
  assert.equal(h.events.filter(file=>file==='collections.js').length,1);
});
test('feature network failure shows retry/reload and never reports a ready route',async()=>{
  const h=routing(),work=h.ctx.go('centering');await tick();h.nodes[0].emit('error');const result=await work;
  assert.equal(result?.ready,false,'A caller cannot open catalogue UI after failed route preparation');
  const state=h.pages.find(p=>p.name==='centering').children[0];assert.equal(state.children.length,2);
  const retry=state.children[0].onclick();await h.finish();await retry;h.flushUI();assert(h.calls.centering>0);
  assert.equal(h.pages.find(p=>p.name==='centering').children.length,0);
});
test('back navigation during a pending feature load cannot activate the departed tool',async()=>{
  const h=routing(),work=h.ctx.go('centering');h.ctx.location.hash='#price';h.ctx.pop({});
  await h.finish();await work;h.flushUI();assert.equal(h.ctx.document.body.dataset.page,'price');assert.equal(h.calls.centering,0);
});
test('late English shared-link data cannot override a newer tab or language intent',async()=>{
  for(const change of ['tab','language','route']){
    const gate=deferred(),h=catalogHarness({english:true,enGate:gate,search:'?set=EN-TEST'});
    h.ctx.document.body={dataset:{page:'cardinfo'}};
    if(change==='tab'){h.ctx._CI_USER_INTENT=1;h.ctx.CI_TAB='onepiece';}
    if(change==='language')await h.click({dataset:{encLanguage:'zh-CN'}});
    if(change==='route'){h.ctx.document.body.dataset.page='home';h.ctx.location.hash='#home';}
    gate.resolve();await tick();await tick();
    assert(!h.fetched.some(url=>url.includes('/english-sets/')),'late automatic English detail must respect '+change);
    assert(!h.modal.innerHTML.includes('id="encPanelTitle"'));
  }
});
test('an untouched English shared link still opens its exact source set',async()=>{
  const gate=deferred(),h=catalogHarness({english:true,enGate:gate,search:'?set=EN-TEST'});
  h.ctx.document.body={dataset:{page:'cardinfo'}};gate.resolve();await tick();await tick();
  assert(h.fetched.some(url=>url.includes('/english-sets/EN-TEST.json')));
});
function returnToSameCardInfo(h){
  const query=h.ctx.location.search,intent=h.ctx._CI_USER_INTENT,tab=h.ctx.CI_TAB;
  h.ctx._FEATURE_ROUTE_RUN++;h.ctx.document.body.dataset.page='home';h.ctx.location.hash='#home';
  h.ctx._FEATURE_ROUTE_RUN++;h.ctx.document.body.dataset.page='cardinfo';h.ctx.location.hash='#cardinfo';
  assert.equal(h.ctx.location.search,query);assert.equal(h.ctx._CI_USER_INTENT,intent);assert.equal(h.ctx.CI_TAB,tab);
}

test('English initial shared links and manual opens cannot resume across visits with the same query',async()=>{
  for(const initial of [true,false]){
    const gate=deferred(),h=catalogHarness({english:true,enGate:gate,search:initial?'?set=EN-TEST':'?same=query'});
    h.ctx.document.body={dataset:{page:'cardinfo'}};const work=initial?null:h.ctx.openSetGrid('EN-TEST');
    returnToSameCardInfo(h);gate.resolve();if(work)await work;await tick();await tick();
    assert(!h.fetched.some(url=>url.includes('/english-sets/')),'An English request from a previous visit cannot resume');
    assert(!h.modal.innerHTML.includes('id="encPanelTitle"'));
  }
});

test('Chinese catalog and card responses cannot resume across visits with the same query',async()=>{
  for(const stage of ['catalog','cards']){
    const gate=deferred(),h=catalogHarness(stage==='catalog'?{cnGate:gate,search:'?same=query'}:{cardGates:{'CN-TEST':gate},search:'?same=query'});
    h.ctx.document.body={dataset:{page:'cardinfo'}};const work=h.api.open('CN-TEST');await tick();const loading=h.modal.innerHTML;
    returnToSameCardInfo(h);gate.resolve();await work;await tick();
    assert.equal(h.modal.innerHTML,loading,'A Chinese '+stage+' response from the previous visit cannot update its panel');
    if(stage==='catalog')assert(!h.fetched.some(url=>url.includes('/chinese-sets/')));
  }
});

test('late English and Chinese rarity enrichment cannot update a later visit to the same card-info route',async()=>{
  for(const language of ['en','zh-CN']){
    const gate=deferred();let started=false;
    const h=catalogHarness({english:language==='en',search:'?same=query',rarity:{async enrich(cards){started=true;await gate.promise;return cards;}}});
    h.ctx.document.body={dataset:{page:'cardinfo'}};
    const work=language==='en'?h.ctx.EnglishCatalog.open('EN-TEST'):h.api.open('CN-TEST');await tick();await tick();
    assert(started,'The fixture must reach the pending '+language+' rarity enrichment');const loading=h.modal.innerHTML;
    returnToSameCardInfo(h);gate.resolve();await work;assert.equal(h.modal.innerHTML,loading);
  }
});

test('late manually opened English and Chinese sets respect departed routes',async()=>{
  const englishGate=deferred(),en=catalogHarness({english:true,enGate:englishGate});en.ctx.document.body={dataset:{page:'cardinfo'}};
  const english=en.ctx.openSetGrid('EN-TEST');en.ctx.document.body.dataset.page='home';en.ctx.location.hash='#home';englishGate.resolve();await english;await tick();
  assert(!en.fetched.some(url=>url.includes('/english-sets/')));
  const chineseGate=deferred(),zh=catalogHarness({cnGate:chineseGate});zh.ctx.document.body={dataset:{page:'cardinfo'}};
  const chinese=zh.api.open('CN-TEST');zh.ctx.document.body.dataset.page='home';zh.ctx.location.hash='#home';chineseGate.resolve();await chinese;
  assert(!zh.fetched.some(url=>url.includes('/chinese-sets/')));
});
test('Chinese card responses cannot replace a newer card-info tab intent',async()=>{
  const gate=deferred(),h=catalogHarness({cardGates:{'CN-TEST':gate}});h.ctx.document.body={dataset:{page:'cardinfo'}};
  const work=h.api.open('CN-TEST');await tick();const loading=h.modal.innerHTML;h.ctx._CI_USER_INTENT=1;h.ctx.CI_TAB='onepiece';gate.resolve();await work;
  assert.equal(h.modal.innerHTML,loading);
});
