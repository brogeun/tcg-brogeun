'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const fixtures=fs.readFileSync(path.join(__dirname,'test_english_catalog_lazy.cjs'),'utf8');
const box={require,__dirname,module:{exports:{}},console,setImmediate,setTimeout,clearTimeout,URL,URLSearchParams};
vm.runInNewContext(fixtures.slice(0,fixtures.indexOf('\ntest('))+'\nmodule.exports={fixture,deferred,tick};',box);
const {fixture,deferred,tick}=box.module.exports;
function search(h){
  const row={id:'EN-TEST:EXACT-01',sourceId:'EXACT-01',language:'en',kind:'card',name:'English Card',displayName:'영문 카드',setName:'English Test',setCode:'EN-TEST',number:'001/001',image:'images/pokemon-en-sheets/test.webp',sprite:{col:0,row:0,cols:5,rows:4}};
  let indexCalls=0;
  Object.assign(h.ctx,{
    escapeHtml:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
    EnglishSearch:{async ensureData(){indexCalls++;return [row];},search:rows=>rows,href:()=> '/?set=EN-TEST&card=EXACT-01#cardinfo'},
    CardSearchClient:{async search(){return {results:[],total:0};}},
  });
  const source=fs.readFileSync(path.join(root,'assets/search-modal.js'),'utf8'),end=source.indexOf('  window.openGlobalSearch=open;');
  assert(end>0);
  vm.runInContext(source.slice(0,end)+`window.__searchDemand={render,
    setup(next){language=next;category='all';input={value:'English'};modal={hidden:false};list={innerHTML:'',scrollTop:0,replaceChildren(){this.innerHTML='';}};count={textContent:''};},
    markup:()=>list.innerHTML};})();`,h.ctx);
  return {api:h.ctx.__searchDemand,indexCalls:()=>indexCalls};
}

test('only an actual English query starts English metadata and pending metadata does not block its result',async()=>{
  const catalog=deferred(),names=deferred(),images=deferred();
  const h=fixture({page:'home',gates:{'/data/english-catalog.json':catalog,'/data/english-card-names-ko.json':names,'/data/english-set-images.json':images}}),s=search(h);
  assert.equal(h.englishCalls().length,0);s.api.setup('ja');await s.api.render();assert.equal(h.englishCalls().length,0);
  s.api.setup('en');const work=s.api.render();await tick();
  try{
    assert.equal(h.englishCalls().length,3);assert.equal(s.indexCalls(),1);
    assert.match(s.api.markup(),/영문 카드/);assert.match(s.api.markup(),/English card|English Card/);
    assert.match(s.api.markup(),/images\/pokemon-en-sheets\/test.webp/);assert.match(s.api.markup(),/card=EXACT-01/);
    assert.equal(h.ctx.EnglishCatalog.name({name:'English Card'}),'English Card','Required metadata is still pending');
  }finally{catalog.resolve();names.resolve();images.resolve();await work;}
  await h.ctx.EnglishCatalog.ensureData();s.api.setup('en');await s.api.render();assert.equal(h.englishCalls().length,3);
});

test('failed optional catalogue preparation never removes valid English search results',async()=>{
  const h=fixture({page:'home',failures:{'/data/english-catalog.json':1}}),s=search(h);s.api.setup('en');
  await s.api.render();await tick();assert.match(s.api.markup(),/영문 카드/);assert.match(s.api.markup(),/card=EXACT-01/);
  assert.equal(s.indexCalls(),1);assert.equal(h.catalogCalls().length,1);
  s.api.setup('en');await s.api.render();await tick();assert.match(s.api.markup(),/영문 카드/);assert.equal(h.catalogCalls().length,2,'A later actual query can retry the catalogue');
});

test('the actual published English metadata stays idle until demand and is read once',async()=>{
  const paths=['/data/english-catalog.json','/data/english-card-names-ko.json','/data/english-set-images.json'];
  const files=new Map(paths.map(name=>[name,fs.readFileSync(path.join(root,name.slice(1)))]));
  const h=fixture(),requested=[];let bytes=0;
  h.ctx.fetch=async url=>{
    const pathname=url.split('?')[0],body=files.get(pathname);assert(body,'Only English metadata is needed by this demand');
    requested.push(pathname);bytes+=body.length;return {ok:true,json:async()=>JSON.parse(body.toString())};
  };
  await tick();h.ctx.renderCardInfo();await tick();assert.equal(requested.length,0,'The Japanese default view reads none of the real English payload');
  const result=await h.ctx.EnglishCatalog.ensureData();await h.ctx.EnglishCatalog.ensureImages();
  assert.equal(result.sets.length,JSON.parse(files.get(paths[0])).sets.length);
  assert.equal(requested.length,3);assert.equal(new Set(requested).size,3);
  assert.equal(bytes,[...files.values()].reduce((total,body)=>total+body.length,0));
  await h.ctx.EnglishCatalog.ensureData();await h.ctx.EnglishCatalog.ensureImages();assert.equal(requested.length,3,'Warm demand reuses all three original snapshots');
});
