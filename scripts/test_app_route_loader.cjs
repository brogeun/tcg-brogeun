'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../assets/app-route-loader.js'),'utf8');
const tick=()=>new Promise(setImmediate);
const exportsByFile={
  'centering-geometry.js':['CenteringGeometry',{}],
  'centering-result-cache.js':['CenteringResultCache',{}],
  'centering-tool.js':['CenteringTool',{setup(){}}],
  'admin-editor.js':['AdminEditorUI',{enter(){}}],
  'Sortable.min.js':['Sortable',{create(){}}],
  'market-references.js':['MarketReferences',{mountEnglishCard(){}}],
  'portfolio-screen.js':['PortfolioScreen',{holdings(){},status(){}}],
  'chinese-catalog.js':['ChineseCatalog',{}],
  'english-catalog.js':['EnglishCatalog',{ensureData(){}}],
  'english-search.js':['EnglishSearch',{}],
  'riftbound-catalog.js':['RiftboundCatalog',{}],
  'chiikawa-catalog.js':['ChiikawaCatalog',{}],
  'tcg-search-aliases.js':['TCGSearchAliases',{}],
  'tcg-card-info.js':['TCGCardInfo',{}],
  'collection-catalog-codec.js':['CollectionCatalogCodec',{}],
  'collections.js':['TCGCollections',{}],
  'korean-promos.js':['KoreanPromos',{}],
};
function fixture({missingExports,missingPortfolioMount=false,preloadSupported=false}={}){
  const nodes=[],loaded=[],elements=new Map(),context={URL,location:{href:'https://tcghub.kr/#home'},setTimeout,clearTimeout};
  class Node{
    constructor(tag){this.tagName=tag.toUpperCase();this.dataset={};this.listeners=new Map();this.done=false;this.relList={supports:name=>preloadSupported&&name==='preload'};}
    getAttribute(name){return this[name]??null;}
    addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
    removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
    remove(){this.removed=true;}
    emit(name){this.done=true;for(const fn of [...(this.listeners.get(name)||[])])fn({target:this});}
  }
  context.document={
    body:{dataset:{page:'home'}},
    getElementById:id=>elements.get(id)||null,
    createElement:tag=>new Node(tag),
    querySelectorAll:selector=>nodes.filter(node=>!node.removed&&(selector.startsWith('script')?node.tagName==='SCRIPT':node.tagName==='LINK'&&node.rel==='stylesheet')),
    head:{appendChild:node=>nodes.push(node)},
  };
  context.window=context;vm.createContext(context);vm.runInContext(source,context);
  function complete(node){
    if(node.done)return;
    if(node.src){
      const file=new URL(node.src,context.location.href).pathname.split('/').pop();
      const entry=exportsByFile[file];assert(entry,'Every inserted script is a declared application feature');
      if(!missingExports?.test(file))context[entry[0]]=entry[1];
      if(file==='portfolio-screen.js'&&!missingPortfolioMount)elements.set('pfxStatus',new Node('div'));
      loaded.push(file);
    }else if(node.rel==='stylesheet')node.sheet={};
    node.emit('load');
  }
  async function finish({skip}={}){
    for(let i=0;i<80;i++){
      await tick();const pending=nodes.filter(n=>!n.done&&!n.removed&&!skip?.test(n.src||n.href));
      if(!pending.length){await tick();if(!nodes.some(n=>!n.done&&!n.removed&&!skip?.test(n.src||n.href)))return;}
      for(const node of pending)complete(node);
    }
    throw Error('Feature loading did not settle');
  }
  return {context,nodes,loaded,complete,finish,api:context.AppRouteLoader};
}

test('home and Japanese search load no optional feature code',async()=>{
  const f=fixture();assert.equal((await f.api.ensure('home')).ready,true);
  assert.equal((await f.api.ensureSearch('ja')).ready,true);assert.equal(f.nodes.length,0);
});
test('double navigation shares one ordered centering dependency chain',async()=>{
  const f=fixture();const one=f.api.ensure('centering'),two=f.api.ensure('centering');await f.finish();
  assert.equal((await one).ready,true);assert.equal((await two).ready,true);
  assert.deepEqual(f.loaded,['centering-geometry.js','centering-result-cache.js','centering-tool.js']);
  assert.equal(f.nodes.length,4);assert(f.nodes.filter(n=>n.src).every(n=>n.async===false));
  await f.api.ensure('centering');assert.equal(f.nodes.length,4,'Revisit must not evaluate feature bindings again');
});
test('portfolio loads its stylesheet before its mounted presentation and shares repeat visits',async()=>{
  const f=fixture(),one=f.api.ensure('portfolio'),two=f.api.ensure('portfolio');
  assert.equal(f.nodes.length,1);assert(f.nodes[0].href.includes('portfolio-screen.css'));
  assert.equal(f.context.PortfolioScreen,undefined);f.complete(f.nodes[0]);await tick();
  assert.equal(f.nodes.length,2);assert(f.nodes[1].src.includes('portfolio-screen.js'));
  f.complete(f.nodes[1]);assert.equal((await one).ready,true);assert.equal((await two).ready,true);
  assert(f.context.document.getElementById('pfxStatus'));
  await f.api.ensure('portfolio');assert.equal(f.nodes.length,2,'Revisiting must preserve the mounted portfolio and its event bindings');
  assert.deepEqual(f.loaded,['portfolio-screen.js']);
});
test('an exported portfolio API without its mounted DOM is not ready',async()=>{
  const f=fixture({missingPortfolioMount:true}),work=f.api.ensure('portfolio');
  const rejected=assert.rejects(work,error=>error.code==='FEATURE_INIT'&&error.requiresReload===true);
  await f.finish();await rejected;
  assert.equal(typeof f.context.PortfolioScreen.holdings,'function','The early API export alone cannot prove mount succeeded');
  assert.equal(f.context.document.getElementById('pfxStatus'),null);
  const before=f.nodes.length;await assert.rejects(f.api.ensure('portfolio'),error=>error.requiresReload===true);
  assert.equal(f.nodes.length,before,'A partially mounted portfolio cannot safely run again');
});
test('card-info and foreign search share adapters in the original wrapping order',async()=>{
  const f=fixture(),cardinfo=f.api.ensure('cardinfo'),english=f.api.ensureSearch('en'),chinese=f.api.ensureSearch('zh-CN');
  await f.finish();await Promise.all([cardinfo,english,chinese]);
  for(const file of ['market-references.js','chinese-catalog.js','english-catalog.js'])assert.equal(f.loaded.filter(name=>name===file).length,1);
  const original=['market-references.js','chinese-catalog.js','english-catalog.js','riftbound-catalog.js','chiikawa-catalog.js','tcg-search-aliases.js','tcg-card-info.js','collection-catalog-codec.js','collections.js','korean-promos.js'];
  assert.deepEqual(f.loaded.filter(name=>name!=='english-search.js'),original);
  const stylesheetURLs=f.nodes.filter(n=>n.href).map(n=>n.href);assert.equal(new Set(stylesheetURLs).size,stylesheetURLs.length);
});
test('card-info preloads two upcoming scripts while execution retains the established order',async()=>{
  const f=fixture({preloadSupported:true}),work=f.api.ensure('cardinfo');
  const hints=()=>f.nodes.filter(node=>node.rel==='preload');
  assert.equal(hints().length,2,'Only the first two downloads are hinted before styles settle');
  assert.deepEqual(hints().map(node=>node.dataset.appRoutePreload),['references','chinese']);
  hints().forEach(node=>f.complete(node));assert.equal(f.loaded.length,0,'Completed hints never execute a wrapper');
  f.nodes.filter(node=>node.rel==='stylesheet').forEach(node=>f.complete(node));await tick();
  assert.equal(f.nodes.filter(node=>node.src).length,1,'Only the first executable script is inserted');
  assert.deepEqual(hints().map(node=>node.dataset.appRoutePreload),['references','chinese','english']);
  f.complete(hints().at(-1));assert.equal(f.loaded.length,0,'A later ready download cannot overtake the first script');
  await f.finish();assert.equal((await work).ready,true);
  assert.deepEqual(f.loaded,['market-references.js','chinese-catalog.js','english-catalog.js','riftbound-catalog.js','chiikawa-catalog.js','tcg-search-aliases.js','tcg-card-info.js','collection-catalog-codec.js','collections.js','korean-promos.js']);
  assert(f.nodes.filter(node=>node.src).every(node=>node.async===false));
  assert.equal(new Set(hints().map(node=>node.href)).size,hints().length,'Each hinted URL is shared across the chain');
  assert(hints().every(node=>node.removed),'Consumed hints do not accumulate in the DOM');
});
test('a departed profile stops queued execution and resumes without reexecuting successful assets',async()=>{
  const f=fixture({preloadSupported:true});let current=true;
  const first=f.api.ensure('cardinfo',{isCurrent:()=>current});
  f.nodes.filter(node=>node.rel==='stylesheet').forEach(node=>f.complete(node));await tick();
  const executing=f.nodes.find(node=>node.src);assert(executing.src.includes('market-references.js'));
  current=false;const count=f.nodes.length;f.complete(executing);await tick();
  assert.equal((await first).cancelled,true);assert.equal(f.nodes.length,count,'Departure adds no later scripts or hints');
  assert.deepEqual(f.loaded,['market-references.js']);
  current=true;const second=f.api.ensure('cardinfo',{isCurrent:()=>current});await f.finish();assert.equal((await second).ready,true);
  assert.equal(f.nodes.filter(node=>node.src?.includes('market-references.js')).length,1);
  assert.equal(f.nodes.filter(node=>node.rel==='stylesheet').length,8);
  assert.equal(new Set(f.loaded).size,10);assert.equal(f.loaded.length,10);
});
test('a newer current caller keeps a shared profile alive after its first caller departs',async()=>{
  const f=fixture();let firstCurrent=true,secondCurrent=true;
  const first=f.api.ensure('cardinfo',{isCurrent:()=>firstCurrent});firstCurrent=false;
  const second=f.api.ensure('cardinfo',{isCurrent:()=>secondCurrent});
  await f.finish();assert.equal((await first).cancelled,true);assert.equal((await second).ready,true);
  assert.equal(f.loaded.length,10);assert.equal(new Set(f.loaded).size,10);
});
test('an active language search can finish shared assets after card-info navigation is cancelled',async()=>{
  const f=fixture({preloadSupported:true});let current=true;
  const cardinfo=f.api.ensure('cardinfo',{isCurrent:()=>current}),english=f.api.ensureSearch('en');current=false;
  await f.finish();assert.equal((await cardinfo).cancelled,true);assert.equal((await english).ready,true);
  assert.deepEqual(f.loaded,['market-references.js','chinese-catalog.js','english-catalog.js','english-search.js']);
});
test('a timed-out profile releases demand and a later visit resumes the existing stylesheet download',async()=>{
  const f=fixture();await assert.rejects(f.api.ensure('cardinfo',{timeoutMs:5}),error=>error.code==='FEATURE_TIMEOUT');
  f.nodes.filter(node=>node.rel==='stylesheet').forEach(node=>f.complete(node));await tick();
  assert.equal(f.nodes.filter(node=>node.src).length,0,'Expired demand cannot start the first wrapper');
  const retry=f.api.ensure('cardinfo');await f.finish();assert.equal((await retry).ready,true);
  assert.equal(f.nodes.filter(node=>node.rel==='stylesheet').length,8);assert.equal(f.loaded.length,10);
});
test('preload failures are optional and a failed executed dependency still blocks later wrappers',async()=>{
  const f=fixture({preloadSupported:true}),work=f.api.ensure('cardinfo');
  f.nodes.find(node=>node.rel==='preload').emit('error');await f.finish();assert.equal((await work).ready,true);
  assert.equal(f.loaded.filter(name=>name==='market-references.js').length,1);
  const g=fixture({preloadSupported:true,missingExports:/chinese-catalog/}),broken=g.api.ensure('cardinfo');
  const rejected=assert.rejects(broken,error=>error.code==='FEATURE_INIT'&&error.requiresReload===true);
  await g.finish();await rejected;assert.deepEqual(g.loaded,['market-references.js','chinese-catalog.js']);
});
test('a departed route never activates and stale failures do not replace the new screen',async()=>{
  const f=fixture();let current=true,activated=0;
  const work=f.api.ensure('centering',{isCurrent:()=>current,activate:()=>activated++});current=false;
  await f.finish();const result=await work;assert.equal(result.cancelled,true);assert.equal(activated,0);
  const before=f.nodes.length;await f.api.ensure('cardinfo',{isCurrent:()=>false});assert.equal(f.nodes.length,before);
  const g=fixture();current=true;
  const stale=g.api.ensure('cardinfo',{isCurrent:()=>current});current=false;g.nodes[0].emit('error');
  assert.equal((await stale).cancelled,true);
});
test('real network failures clear only failed assets and allow a bounded retry',async()=>{
  const f=fixture(),first=f.api.ensure('centering');f.complete(f.nodes[0]);await tick();
  const failed=f.nodes.find(n=>n.src?.includes('centering-geometry'));failed.emit('error');
  await assert.rejects(first,error=>error.code==='FEATURE_NETWORK');
  const retry=f.api.ensure('centering');await f.finish();assert.equal((await retry).ready,true);
  assert.equal(f.nodes.filter(n=>n.src?.includes('centering-geometry')).length,2);
  assert.equal(f.nodes.filter(n=>n.href).length,1,'Successful stylesheet stays shared');
});
test('a timed-out caller can retry without evaluating the pending adapter twice',async()=>{
  const f=fixture();await assert.rejects(f.api.ensure('centering',{timeoutMs:5}),error=>error.code==='FEATURE_TIMEOUT');
  assert.equal(f.nodes.length,1);const retry=f.api.ensure('centering',{timeoutMs:1000});
  assert.equal(f.nodes.length,1,'Timeout must retain the underlying singleflight download');
  await f.finish();assert.equal((await retry).ready,true);assert.equal(f.loaded.filter(name=>name==='centering-tool.js').length,1);
});
test('executed but incomplete modules require reload instead of double wrapping globals',async()=>{
  const f=fixture({missingExports:/centering-geometry/}),first=f.api.ensure('centering');
  const rejected=assert.rejects(first,error=>error.code==='FEATURE_INIT'&&error.requiresReload===true);
  await f.finish();await rejected;
  const count=f.nodes.length;await assert.rejects(f.api.ensure('centering'),error=>error.requiresReload===true);
  assert.equal(f.nodes.length,count,'Partially executed module must not run again');
});
test('blocked drag library does not prevent administrator editing from becoming ready',async()=>{
  const f=fixture(),work=f.api.ensure('admin');await f.finish({skip:/Sortable/});assert.equal((await work).ready,true);
  const optional=f.nodes.find(n=>n.src?.includes('Sortable'));assert(optional);optional.emit('error');await tick();
  assert.equal((await f.api.ensure('admin')).ready,true);
  assert.equal(f.nodes.filter(n=>n.src?.includes('admin-editor')).length,1);
  assert.equal(f.nodes.filter(n=>n.src?.includes('Sortable')).length,2,'A later visit can retry the optional drag library');
});
test('late drag-library success initializes the visible administrator list without reentry',async()=>{
  const f=fixture();let bound=0;f.context.document.body.dataset.page='admin';f.context._initAdminSortable=()=>bound++;
  const work=f.api.ensure('admin');await f.finish({skip:/Sortable/});await work;assert.equal(bound,0);
  f.complete(f.nodes.find(n=>n.src?.includes('Sortable')));await tick();assert.equal(bound,1);
  const g=fixture();g.context._initAdminSortable=()=>bound++;
  const departed=g.api.ensure('admin');await g.finish({skip:/Sortable/});await departed;
  g.complete(g.nodes.find(n=>n.src?.includes('Sortable')));await tick();assert.equal(bound,1,'Late success does not initialize a departed admin screen');
});
test('manifest contains only existing local assets and the established editor dependencies',()=>{
  const f=fixture();for(const profile of Object.values(f.api.manifest))for(const url of [...profile.styles,...profile.scripts,...profile.background]){
    const parsed=new URL(url,'https://tcghub.kr');
    if(parsed.origin==='https://tcghub.kr')assert(fs.existsSync(path.join(__dirname,'..',parsed.pathname)));
    else assert.equal(parsed.origin,'https://cdn.jsdelivr.net');
  }
});
