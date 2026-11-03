const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const products=[
  {id:'145001',brand:'pokemon',kind:'box',code:'SV4K',name:'Ancient Roar Box',nameLower:'ancient roar box',productNumber:'SV4K',language:'ja'},
  {id:'136031',brand:'onepiece',kind:'box',code:'OP01',name:'Romance Dawn Box',nameLower:'romance dawn box',productNumber:'OP01',language:'ja'},
  {id:'500001',brand:'onepiece',kind:'card',name:'Nami Parallel OP01-016',nameLower:'nami parallel op01-016',productNumber:'OP01-016',language:'ja'},
  {id:'500002',brand:'pokemon',kind:'card',name:'Pansage [EN]',nameLower:'pansage en',productNumber:'pkmn-tcg-en-001',language:'en'},
  {id:'500003',brand:'onepiece',kind:'box',code:'PRB01',name:'Premium Card the Best Box',nameLower:'premium card the best box',productNumber:'PRB01',language:'ja'},
];
const sets={
  pokemon:[{code:'SV4K',name:'고대의 포효 (Ancient Roar)',boxId:'145001'}],
  onepiece:[{code:'OP01',name:'로맨스 던 (Romance Dawn)',boxId:'136031'},{code:'OP17',name:'세계 최강의 전사'}],
};
const official=[
  {id:'JP:ONEPIECE:OP01-016_p1',fullId:'OP01-016_p1',officialId:'OP01-016_p1',number:'016',setCode:'OP01',boxCode:'OP01',brand:'onepiece',kind:'card',language:'ja',name:'ナミ',nameKo:'나미',image:'/images/nami.webp',productId:'500001'},
  // A reprint keeps its printed set code but must be searchable by its box.
  {id:'JP:ONEPIECE:OP01-016_p2',fullId:'OP01-016_p2',officialId:'OP01-016_p2',number:'016',setCode:'OP01',boxCode:'OP17',brand:'onepiece',kind:'card',language:'ja',name:'ナミ',nameKo:'나미 재록',image:'/images/nami-reprint.webp',productId:null},
  ...['PRB01','ST01','PROMO','LIMITED'].map((code,i)=>({id:'JP:ONEPIECE:P-00'+(i+1),fullId:'P-00'+(i+1),officialId:'P-00'+(i+1),number:'00'+(i+1),setCode:'P',boxCode:code,brand:'onepiece',kind:'card',language:'ja',name:'モンキー・D・ルフィ',image:'/images/luffy-'+i+'.webp',productId:null})),
];
const manifest={schemaVersion:1,sets:[
  {code:'PRB01',name:'프리미엄 카드 베스트',category:'premium_booster'},
  {code:'ST01',name:'밀짚모자 일당 스타트덱',category:'starter'},
  {code:'PROMO',name:'배포 프로모 카드',category:'promotion'},
  {code:'LIMITED',name:'프리미엄 카드 컬렉션',category:'limited_product'},
]};
function fixture({fetchManifest=async()=>manifest,expireManifest=false}={}){
let manifestCalls=0;
const context={
  console,URLSearchParams,setTimeout:(fn,delay)=>expireManifest&&delay===5000 ? (queueMicrotask(fn),undefined) : setTimeout(fn,delay),clearTimeout,innerWidth:1440,
  document:{getElementById:()=>null},addEventListener(){},
  _ALL_CARDS_INDEX:products,_SEARCH_ALIASES:{},CARDINFO:sets,
  async fetch(url){assert.equal(url,'/data/onepiece-official-manifest.json');manifestCalls++;return {ok:true,json:fetchManifest};},
  async loadCardSearchData(){},async enrichPriceProductMetadata(){},
  isPriceBoxProduct:c=>c.kind==='box',
  getBoxKoreanName:c=>Object.values(sets).flat().find(s=>s.code===c.code)?.name || null,
  escapeHtml:value=>String(value||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
  fmtKrw:value=>String(value),fmtOrig:value=>String(value),
};
context.window=context;
vm.createContext(context);
for(const file of ['assets/japanese-card-names.js','assets/japanese-catalog.js','assets/onepiece-official-catalog.js'])vm.runInContext(read(file),context);
context.JapaneseCardNames.configure({schemaVersion:1,species:{Pansage:'야나프'}});
context.JapaneseCatalog.configure({schemaVersion:1,sets:sets.pokemon,cards:[
  {id:'JP:SV4K:001/066',boxCode:'SV4K',setCode:'SV4K',number:'001/066',name:'Pansage',brand:'pokemon',kind:'card',language:'ja',image:'/images/pansage.webp'},
]});
context.JapaneseCatalog.setProducts(products);
context.OnePieceCatalog.configure({schemaVersion:1,cards:official});
context.OnePieceCatalog.setProducts(products);
const html=read('index.html');
vm.runInContext(html.slice(html.indexOf('function searchCards('),html.indexOf('\nfunction renderSearchResults(',html.indexOf('function searchCards('))),context);

// Exercise the real dialog's index builder and result renderer without a browser.
// The hook only supplies the DOM hosts; catalogue and search modules stay real.
const source=read('assets/search-modal.js');
vm.runInContext(source.replace(/\}\)\(\);\s*$/,
  'window.__searchModalTest={ensureData,normalized,setHosts(hosts){modal=hosts.modal;input=hosts.input;list=hosts.list;count=hosts.count;category=hosts.category||"all";},render};})();'),context);
const api=context.__searchModalTest;
async function search(query,category='all'){
  const hosts={modal:{hidden:false},input:{value:query},list:{innerHTML:'',scrollTop:0,replaceChildren(){this.innerHTML=''}},count:{textContent:''},category};
  api.setHosts(hosts);await api.render();return hosts;
}
return {context,api,search,manifestCalls:()=>manifestCalls};
}
(async()=>{
  let resolveManifest;
  const pendingManifest=new Promise(resolve=>{resolveManifest=resolve});
  const {context,api,search,manifestCalls}=fixture({fetchManifest:()=>pendingManifest});
  const pendingIndex=api.ensureData();
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(manifestCalls(),1,'The asynchronously loaded manifest must be requested');
  assert.equal(api.normalized.size,0,'Do not permanently cache labels before the manifest arrives');
  resolveManifest(manifest);await pendingIndex;
  for(const row of official)assert(api.normalized.has(row.id),'Official artwork disappeared from the dialog: '+row.id);
  assert(!api.normalized.has('500001'),'Covered market duplicate must stay replaced by official artwork');
  assert(!api.normalized.has('500002'),'English products must stay out of Japanese search');
  let result=await search('OP-01');
  assert.match(result.list.innerHTML,/data-id="JP:ONEPIECE:OP01-016_p1"/);
  assert.match(result.list.innerHTML,/ナミ|나미/);
  result=await search('로맨스던','card');
  assert.match(result.list.innerHTML,/data-id="JP:ONEPIECE:OP01-016_p1"/,'Korean box-name searches include their official cards');
  assert.doesNotMatch(result.list.innerHTML,/data-id="136031"/,'Card filter must exclude boxes');
  result=await search('세계최강의전사','card');
  assert.match(result.list.innerHTML,/data-id="JP:ONEPIECE:OP01-016_p2"/,'Reprints resolve their containing box, not their original printed set');
  assert.doesNotMatch(result.list.innerHTML,/data-id="JP:ONEPIECE:OP01-016_p1"/);
  result=await search('고대의포효','card');
  assert.match(result.list.innerHTML,/data-id="JP:SV4K:001\/066"/);
  result=await search('고대 포효','box');
  assert.match(result.list.innerHTML,/data-id="145001"/);
  assert.doesNotMatch(result.list.innerHTML,/data-kind="card"/);
  result=await search('나미');
  assert.match(result.list.innerHTML,/set=OP17&amp;card=OP01-016_p2#cardinfo/,'Unlinked official cards keep the exact reprint destination');
  assert.match(result.list.innerHTML,/class="gs-name"[^>]*>나미</,'Korean names are preserved');
  result=await search('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(result.list.innerHTML,/<img src=x/);
  assert.match(result.list.innerHTML,/&lt;img/);
  for(const [code,query] of [['PRB01','프리미엄 카드 베스트'],['ST01','밀짚모자 일당 스타트덱'],['PROMO','배포 프로모 카드'],['LIMITED','프리미엄 카드 컬렉션']]){
    result=await search(query,'card');
    assert.match(result.list.innerHTML,new RegExp('set='+code+'&amp;card='),'Manifest-only box names must find their contained cards: '+code);
    assert.doesNotMatch(result.list.innerHTML,/set=OP01&amp;card=/,'Three-word fallback must stay bounded to matching labels');
  }
  result=await search('프리미엄 없는 베스트','card');
  assert.doesNotMatch(result.list.innerHTML,/class="gs-row"/,'Every query word is required');
  result=await search('프리미엄 카드 베스트','box');
  assert.match(result.list.innerHTML,/data-id="500003"/,'Manifest-only market boxes receive Korean labels too');
  assert(!context.CARDINFO.onepiece.some(set=>set.code==='PRB01'),'Search enrichment must work without racing the external CARDINFO registration');
  assert.equal(manifestCalls(),1,'Successful labels remain cached');

  let attempts=0;
  const retry=fixture({fetchManifest:async()=>{if(++attempts===1)throw Error('Temporary manifest failure');return manifest}});
  result=await retry.search('OP01');
  assert.match(result.list.innerHTML,/data-id="JP:ONEPIECE:OP01-016_p1"/,'Manifest failure must preserve existing search results');
  assert.equal(retry.manifestCalls(),1);
  result=await retry.search('프리미엄 카드 베스트','card');
  assert.equal(retry.manifestCalls(),2,'A failed manifest must be retried on the next search');
  assert.match(result.list.innerHTML,/set=PRB01&amp;card=/);

  let recoverManifest;
  const unavailableManifest=new Promise(resolve=>{recoverManifest=resolve});
  const timeout=fixture({fetchManifest:()=>unavailableManifest,expireManifest:true});
  result=await timeout.search('OP01');
  assert.match(result.list.innerHTML,/data-id="JP:ONEPIECE:OP01-016_p1"/,'A pending manifest must not block all search forever');
  recoverManifest(manifest);await Promise.resolve();
  result=await timeout.search('프리미엄 카드 베스트','card');
  assert.match(result.list.innerHTML,/set=PRB01&amp;card=/,'A late manifest must refresh missing labels on the next search');
  console.log('PASS: official dialog results, filters, Korean names, exact reprint routes, delayed manifest labels, manifest failure/timeout recovery and bounded three-word searches');
})().catch(error=>{console.error(error);process.exitCode=1});
