'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),tick=()=>new Promise(setImmediate);
function deferred(){let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};}
const set={code:'EN-TEST',name:'English Test',displayCode:'ENT',language:'en',cardCount:1};
const card={sourceId:'EXACT-01',name:'English Card',number:'001/001',image:'images/pokemon-en-sheets/test.webp',sprite:{col:0,row:0,cols:5,rows:4}};
function fixture({search='',page='cardinfo',gates={},failures={},names=()=>({schemaVersion:1,names:{'English Card':'영문 카드'}})}={}){
  const calls=[],source=fs.readFileSync(path.join(__dirname,'test_chinese_catalog.cjs'),'utf8');
  const entry=source.indexOf('(async()=>{')>=0?source.indexOf('(async()=>{'):source.indexOf('(async () => {');
  assert(entry>0,'Reuse the existing catalogue DOM fixture without running its test entry point');
  const fixtureVM={...vm,createContext(ctx,...args){
    const fallback=ctx.fetch;ctx._FEATURE_ROUTE_RUN=1;ctx.document.body={dataset:{page}};
    ctx.fetch=async url=>{
      calls.push(url);const pathname=url.split('?')[0];
      if(gates[pathname])await gates[pathname].promise;
      if(failures[pathname]>0){failures[pathname]--;throw Error('Synthetic network error');}
      let data;
      if(pathname==='/data/english-catalog.json')data={schemaVersion:1,sets:[set]};
      else if(pathname==='/data/english-card-names-ko.json')data=names();
      else if(pathname==='/data/english-set-images.json')data={schemaVersion:1,language:'en',sets:{}};
      else if(pathname==='/data/english-sets/EN-TEST.json')data={...set,cards:[card]};
      else return fallback(url);
      return {ok:true,json:async()=>JSON.parse(JSON.stringify(data))};
    };
    return vm.createContext(ctx,...args);
  }};
  const box={require:id=>id==='node:vm'?fixtureVM:require(id),__dirname,module:{exports:{}},console,URL,URLSearchParams,setImmediate,setTimeout,clearTimeout};
  vm.runInNewContext(source.slice(0,entry)+'\nmodule.exports={harness};',box);
  const h=box.module.exports.harness({english:true,search});
  return {...h,calls,englishCalls:()=>calls.filter(url=>url.startsWith('/data/english-')),catalogCalls:()=>calls.filter(url=>url.startsWith('/data/english-catalog.json'))};
}

test('Japanese startup and Chinese selection keep every English JSON idle',async()=>{
  const h=fixture();await tick();assert.equal(h.englishCalls().length,0);
  assert.match(h.node('encLanguages').innerHTML,/data-enc-language="en"/);
  h.ctx.renderCardInfo();await tick();assert.equal(h.englishCalls().length,0);
  await h.click({dataset:{encLanguage:'zh-CN'}});assert.match(h.list.innerHTML,/data-cn-set="CN-TEST"/);
  assert.equal(h.englishCalls().length,0);
  const shared=fixture({search:'?set=CN-TEST&card=CARD-02'});await tick();
  assert.match(shared.modal.innerHTML,/cnCardTitle/);assert.equal(shared.englishCalls().length,0);
});

test('required English data is atomic and shared while optional image metadata remains pending',async()=>{
  const catalog=deferred(),names=deferred(),images=deferred();
  const h=fixture({gates:{'/data/english-catalog.json':catalog,'/data/english-card-names-ko.json':names,'/data/english-set-images.json':images}}),api=h.ctx.EnglishCatalog;
  const one=api.ensureData(),two=api.ensureData();assert.equal(one,two);
  assert.equal(api.ensureImages(),api.ensureImages());assert.equal(h.englishCalls().length,3);
  catalog.resolve();await tick();assert.equal(api.name(card),'English Card','A half-loaded catalogue cannot publish names or its rows');
  names.resolve();assert.equal((await one).sets[0].code,'EN-TEST');assert.equal(api.name(card),'영문 카드');
  assert.equal(h.englishCalls().length,3,'Pending optional images do not delay data or trigger duplicate downloads');
  assert.equal(h.list.innerHTML,'original-pokemon','An explicit search demand prepares data without rendering the hidden catalogue');
  images.resolve();await api.ensureImages();await api.ensureData();assert.equal(h.englishCalls().length,3);
});

test('English selection paints loading once, then renders rows without waiting for images',async()=>{
  const catalog=deferred(),images=deferred(),h=fixture({gates:{'/data/english-catalog.json':catalog,'/data/english-set-images.json':images}});
  await h.click({dataset:{encLanguage:'en'}});assert.match(h.list.innerHTML,/영문판 목록 불러오는 중/);
  h.ctx.renderCardInfo();assert.equal(h.catalogCalls().length,1);
  catalog.resolve();await tick();assert.match(h.list.innerHTML,/data-enc-set="EN-TEST"/);
  const before=h.englishCalls().length;h.ctx.renderCardInfo();assert.match(h.list.innerHTML,/data-enc-set="EN-TEST"/);
  assert.equal(h.englishCalls().length,before);images.resolve();
});

test('an English response cannot repaint a newer Japanese, Chinese or One Piece selection',async()=>{
  for(const next of ['ja','zh-CN','onepiece']){
    const catalog=deferred(),h=fixture({gates:{'/data/english-catalog.json':catalog}});
    await h.click({dataset:{encLanguage:'en'}});
    if(next==='onepiece'){h.ctx.CI_TAB='onepiece';h.ctx.renderCardInfo();}else await h.click({dataset:{encLanguage:next}});
    const current=h.list.innerHTML;catalog.resolve();await tick();assert.equal(h.list.innerHTML,current,next);
    assert(!h.list.innerHTML.includes('data-enc-set="EN-TEST"'),next);
  }
});

test('an invalid required response publishes nothing and the visible list can retry',async()=>{
  let valid=false;
  const h=fixture({names:()=>valid?{schemaVersion:1,names:{'English Card':'영문 카드'}}:{schemaVersion:1,names:null}});
  await h.click({dataset:{encLanguage:'en'}});assert.match(h.list.innerHTML,/data-enc-retry-list/);
  assert.equal(h.ctx.EnglishCatalog.name(card),'English Card');
  valid=true;await h.click({attributes:['data-enc-retry-list']});assert.match(h.list.innerHTML,/data-enc-set="EN-TEST"/);
  assert.equal(h.ctx.EnglishCatalog.name(card),'영문 카드');assert.equal(h.catalogCalls().length,2);
});

test('optional image failure cannot reject required data and can be retried independently',async()=>{
  const h=fixture({failures:{'/data/english-set-images.json':1}}),api=h.ctx.EnglishCatalog;
  await api.ensureData();assert.equal(api.name(card),'영문 카드');
  await api.ensureImages();assert.equal(h.calls.filter(url=>url.startsWith('/data/english-set-images.json')).length,2);
  assert.equal(h.catalogCalls().length,1);
});

test('an untouched English shared link opens its exact card with optional images pending',async()=>{
  const images=deferred(),h=fixture({search:'?set=EN-TEST&card=EXACT-01',gates:{'/data/english-set-images.json':images}});
  await tick();await tick();assert.match(h.modal.innerHTML,/id="encCardTitle"/);assert.match(h.modal.innerHTML,/영문 카드/);
  assert.equal(h.calls.filter(url=>url.startsWith('/data/english-sets/')).length,1);images.resolve();
});

test('pending English shared links respect language, tab, user intent and route generations',async()=>{
  for(const change of ['language','tab','intent','route']){
    const catalog=deferred(),h=fixture({search:'?set=EN-TEST&card=EXACT-01',gates:{'/data/english-catalog.json':catalog}});
    if(change==='language')await h.click({dataset:{encLanguage:'zh-CN'}});
    if(change==='tab'){h.ctx.CI_TAB='onepiece';h.ctx.renderCardInfo();}
    if(change==='intent')h.ctx._CI_USER_INTENT=1;
    if(change==='route'){
      h.ctx._FEATURE_ROUTE_RUN++;h.ctx.document.body.dataset.page='home';h.ctx.location.hash='#home';
      h.ctx._FEATURE_ROUTE_RUN++;h.ctx.document.body.dataset.page='cardinfo';h.ctx.location.hash='#cardinfo';
    }
    const markup=h.modal.innerHTML;catalog.resolve();await tick();await tick();
    assert.equal(h.calls.filter(url=>url.startsWith('/data/english-sets/')).length,0,change);
    assert.equal(h.modal.innerHTML,markup,change);
  }
});

test('failed shared catalogue demand retries the original exact card without reloading the page',async()=>{
  const h=fixture({search:'?set=EN-TEST&card=EXACT-01',failures:{'/data/english-catalog.json':1}});
  await tick();assert.match(h.list.innerHTML,/data-enc-retry-set="EN-TEST"/);
  assert.match(h.list.innerHTML,/data-enc-retry-card="EXACT-01"/);
  await h.click({dataset:{encRetrySet:'EN-TEST',encRetryCard:'EXACT-01'}});await tick();
  assert.match(h.modal.innerHTML,/id="encCardTitle"/);assert.match(h.modal.innerHTML,/영문 카드/);
  assert.equal(h.catalogCalls().length,2);
});

test('failed English set requests never reopen a globally closed or replaced dialog',async()=>{
  for(const action of ['close','replace']){
    const pending=deferred(),h=fixture({gates:{'/data/english-sets/EN-TEST.json':pending}});
    const work=h.ctx.EnglishCatalog.open('EN-TEST',false,'EXACT-01');await tick();
    assert.match(h.modal.innerHTML,/id="encPanelTitle"/);
    // Native/global close removes the class without incrementing English's token.
    if(action==='close')h.ctx.closeAnyModal();else h.ctx.openAnyModal('<h2 id="anotherModal">다른 화면</h2>');
    const before=h.modal.innerHTML;pending.reject(Error('Synthetic failed set download'));await work;
    assert.equal(h.modal.innerHTML,before,action);
    assert.equal(h.modal.classList.contains('open'),action==='replace',action);
  }
});

test('an English set download can retry the same card while its error dialog stays current',async()=>{
  const h=fixture({failures:{'/data/english-sets/EN-TEST.json':1}});
  await h.ctx.EnglishCatalog.open('EN-TEST',false,'EXACT-01');assert.match(h.modal.innerHTML,/data-enc-retry-set="EN-TEST"/);
  await h.click({dataset:{encRetrySet:'EN-TEST',encRetryCard:'EXACT-01'}});await tick();
  assert.match(h.modal.innerHTML,/id="encCardTitle"/);assert.match(h.modal.innerHTML,/영문 카드/);
  assert.equal(h.calls.filter(url=>url.startsWith('/data/english-sets/')).length,2);
});
