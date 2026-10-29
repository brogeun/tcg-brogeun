'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const SOURCE=fs.readFileSync(path.join(__dirname,'../assets/tcg-card-info.js'),'utf8');
const tick=()=>new Promise(setImmediate);
function fixture(){
  const games=['nikke','weiss_schwarz','union_arena','dragon_ball_fusion_world','yugioh','digimon'];
  const manifest={schemaVersion:1,games:games.map(game=>({id:game,label:game,setCount:2,sets:['a','b'].map(id=>({id:game+'-'+id,code:game.toUpperCase()+'-'+id,name:game+' Set '+id,file:`/data/tcg-card-info/${game}/${id}.json`,cardCount:2,coverType:'card',image:'https://cdn.snkrdunk.com/card.webp'}))}))};
  const files=new Map([['/data/tcg-card-info.json',manifest]]);
  for(const game of manifest.games)for(const set of game.sets){const underlying=game.id==='nikke'?'union_arena':game.id;const cards=[1,2].map((number)=>{const id=String(games.indexOf(game.id)*100+(set.id.endsWith('-a')?0:10)+number),fullCardNumber=underlying==='weiss_schwarz'?'NIK/S117-001SP':'UA18BT/NIK-1-00'+number;return {id,name:`${game.id} Card ${number}`,fullCardNumber,rarity:number===1?'SR':'SP',game:underlying,language:'ja',variant:'Exact variant '+number,image:'https://cdn.snkrdunk.com/card.webp',snkrProduct:{id,brand:underlying,kind:'card',name:'source',minPrice:100+number,currency:'JPY',url:'https://snkrdunk.com/apparels/'+id}};});files.set(set.file,{schemaVersion:1,game:game.id,set:{...set},cards});}
  return {manifest,files};
}
function runtime(files,options={}){
  const elements=new Map(),listeners=new Map(),requests=[],oldRenders=[],oldOpens=[],quoteTargets=[],tabs=[];
  let context,closed=0,cancelled=0;
  class Element{
    constructor(id=''){this.id=id;this.dataset={};this.attributes={};this._html='';this.textContent='';this.hidden=false;this.isConnected=true;this.value='';this.scrollTop=0;const classes=new Set();this.classList={add:(...v)=>v.forEach(x=>classes.add(x)),remove:(...v)=>v.forEach(x=>classes.delete(x)),contains:x=>classes.has(x),toggle:(x,force)=>{const on=force===undefined?!classes.has(x):force;if(on)classes.add(x);else classes.delete(x);return on;}};}
    set innerHTML(html){this._html=String(html);for(const match of this._html.matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element(match[1]));}
    get innerHTML(){return this._html;}
    setAttribute(key,value){this.attributes[key]=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=String(value);}
    hasAttribute(key){return Object.hasOwn(this.attributes,key);}
    querySelector(selector){if(selector==='[data-tci-shell]')return this._html.includes('data-tci-shell')?get('shell'):null;if(selector==='.modal-box')return get('box');if(selector==='.tci-scroll')return this._html.includes('tci-scroll')?get('scroll'):null;if(selector==='[data-tci-close]')return this._html.includes('data-tci-close')?get('close'):null;return null;}
    querySelectorAll(){return [];}
    closest(selector){if(selector.startsWith('#ciTabs'))return this.dataset.ci?this:null;return Object.keys(this.dataset).some(key=>key.startsWith('tci'))?this:null;}
    focus(){document.activeElement=this;}
  }
  function get(id){if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);}
  const document={getElementById:get,activeElement:get('opener'),querySelectorAll:selector=>selector.startsWith('#ciTabs')?tabs:[],addEventListener(type,fn,capture=false){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push({fn,capture});}};
  for(const game of ['pokemon','onepiece','riftbound','chiikawa','nikke','weiss_schwarz','union_arena','dragon_ball_fusion_world','yugioh','digimon']){const tab=new Element();tab.dataset.ci=game;tabs.push(tab);}
  get('rfLanguages').hidden=true;get('encLanguages').hidden=false;get('ciLanguageTabs').hidden=false;
  context={document,console,URL,URLSearchParams,Intl,Map,Set,Date,Promise,setTimeout,clearTimeout,CI_TAB:options.initialGame||'pokemon',CI_QUERY:'',CI_PANEL_REQUEST:0,
    location:{hash:'#cardinfo',search:options.search||'',origin:'https://tcghub.kr',pathname:'/'},navigator:{clipboard:{writeText:async()=>{}}},addEventListener(){},
    renderCardInfo(...args){oldRenders.push(args);return 'old-render';},openSetGrid(...args){oldOpens.push(args);return 'old-open';},
    openAnyModal(html){get('anyModal').innerHTML=html;get('anyModal').classList.add('open');},closeAnyModal(){closed++;context.CI_PANEL_REQUEST++;get('anyModal').classList.remove('open');get('anyModal').innerHTML='';},
    EnglishCatalog:{cancelPending(){cancelled++;}},ChineseCatalog:{cancelPending(){cancelled++;}},ChiikawaCatalog:{close(){}},
    fetch:async address=>{const key=address.split('?')[0];requests.push(key);return {ok:files.has(key),json:async()=>{const value=files.get(key);return typeof value==='function'?value():value;}};},
    CardPriceFallback:{lookup:async(target,opts)=>{quoteTargets.push(target);return options.lookup?options.lookup(target,opts):{status:'priced',amount:101,currency:'JPY',source:'snkrdunk',sourceUrl:target.snkrProduct?.url};},render(result){return result.status==='priced'?`<strong>JPY ${result.amount}</strong><small>SNKRDUNK · 상품 호가</small>`:'가격 정보 없음';}}
  };
  context.window=context;
  document.addEventListener('click',event=>{const tab=event.target.closest('#ciTabs [data-ci]');if(tab){context.CI_TAB=tab.dataset.ci;context.renderCardInfo();}},false);
  vm.runInNewContext(SOURCE,context);
  function dispatch(type,target,extra={}){const event={target,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};for(const {fn}of [...listeners.get(type)||[]].sort((a,b)=>Number(b.capture)-Number(a.capture))){fn(event);if(event.stopped)break;}return event;}
  function action(attribute,value=''){const element=new Element();element.setAttribute(attribute,value);return dispatch('click',element);}
  return {context,api:context.TCGCardInfo,get,requests,oldRenders,oldOpens,quoteTargets,dispatch,action,tab(game){return dispatch('click',tabs.find(tab=>tab.dataset.ci===game));},closed:()=>closed,cancelled:()=>cancelled};
}

test('existing catalog render/open pass through with zero additional network requests',()=>{
  const {files}=fixture(),r=runtime(files);assert.equal(r.context.renderCardInfo('x'),'old-render');assert.equal(r.context.openSetGrid('EN-X','name'),'old-open');assert.equal(r.oldOpens[0][0],'EN-X');assert.equal(r.requests.length,0);
});
test('new tab capture loads only the manifest and hides old language bars',async()=>{
  const {files}=fixture(),r=runtime(files);const event=r.tab('union_arena');await tick();assert.equal(event.stopped,true);assert.deepEqual(r.requests,['/data/tcg-card-info.json']);assert.equal(r.oldRenders.length,0);assert.match(r.get('cardInfoList').innerHTML,/union_arena Set a/);assert.equal(r.get('encLanguages').hidden,true);assert.equal(r.get('rfLanguages').hidden,true);
});
test('entering a new game closes an inherited old catalog modal',async()=>{
  const {files}=fixture(),r=runtime(files);r.context.openAnyModal('<h3>Old English catalogue</h3>');r.get('anyModal').classList.add('ci-panel');r.tab('union_arena');await tick();assert.equal(r.get('anyModal').classList.contains('open'),false);assert.equal(r.closed(),1);
});
test('opening one set fetches one small file, keeps full number and paints one price inside the tile',async()=>{
  const {files}=fixture(),r=runtime(files);r.tab('union_arena');await tick();await r.api.open('union_arena','union_arena-a');await tick();assert.deepEqual(r.requests,['/data/tcg-card-info.json','/data/tcg-card-info/union_arena/a.json']);assert.match(r.get('tciCardGrid').innerHTML,/UA18BT\/NIK-1-001/);assert.match(r.get('tciPrice0').innerHTML,/JPY 101/);assert.equal(r.oldOpens.length,0);assert.equal(r.quoteTargets[0].game,'union_arena');assert.equal(r.quoteTargets[0].catalogSource,'SNKRDUNK');assert.equal(r.quoteTargets[0].snkrdunkId,r.quoteTargets[0].id);
});
test('card click opens inline detail in the same modal and back preserves the card filter',async()=>{
  const {files}=fixture(),r=runtime(files);await r.api.open('weiss_schwarz','weiss_schwarz-a');const input=r.get('tciCardSearch');input.value='NIK/S117-001SP';r.dispatch('input',input);r.api.detail('101');await tick();assert.equal(r.api.state().selected,'101');assert.match(r.get('anyModal').innerHTML,/NIK\/S117-001SP/);assert.match(r.get('anyModal').innerHTML,/바이스슈발츠/);assert.doesNotMatch(r.get('anyModal').innerHTML,/#price\//);assert.match(r.get('tciDetailPrice').innerHTML,/JPY/);r.action('data-tci-back');assert.equal(r.api.state().selected,null);assert.equal(r.api.state().query,'NIK/S117-001SP');assert.equal(r.oldOpens.length,0);
});
test('Nikke keeps underlying game for pricing rather than inferring a new card identity',async()=>{
  const {files}=fixture(),r=runtime(files);await r.api.open('nikke','nikke-a');await tick();assert.equal(r.api.state().game,'nikke');assert.equal(r.quoteTargets[0].game,'union_arena');assert.match(r.get('tciCardGrid').innerHTML,/유니온아레나/);
});
test('new-to-old tab restores language visibility and old render without rewriting old navigation',async()=>{
  const {files}=fixture(),r=runtime(files);await r.api.open('union_arena','union_arena-a');r.tab('pokemon');await tick();assert.equal(r.context.CI_TAB,'pokemon');assert.equal(r.get('encLanguages').hidden,false);assert.equal(r.get('rfLanguages').hidden,true);assert.equal(r.oldRenders.length,1);assert.equal(r.get('anyModal').classList.contains('open'),false);assert.equal(r.context.openSetGrid('SV4a','old'),'old-open');
});
test('late set response cannot replace a newer new-game tab',async()=>{
  const {files}=fixture();let release;const original=files.get('/data/tcg-card-info/union_arena/a.json');files.set('/data/tcg-card-info/union_arena/a.json',()=>new Promise(resolve=>release=()=>resolve(original)));const r=runtime(files),opening=r.api.open('union_arena','union_arena-a');await tick();r.tab('digimon');await tick();release();await opening;assert.equal(r.context.CI_TAB,'digimon');assert.equal(r.api.state().set,null);assert.match(r.get('cardInfoList').innerHTML,/digimon Set a/);assert.equal(r.get('anyModal').classList.contains('open'),false);
});
test('late set response cannot replace an unrelated shared modal',async()=>{
  const {files}=fixture();let release;const original=files.get('/data/tcg-card-info/union_arena/a.json');files.set('/data/tcg-card-info/union_arena/a.json',()=>new Promise(resolve=>release=()=>resolve(original)));const r=runtime(files),opening=r.api.open('union_arena','union_arena-a');await tick();r.context.openAnyModal('<h3>Other modal</h3>');release();await opening;assert.equal(r.get('anyModal').innerHTML,'<h3>Other modal</h3>');
});
test('source records with unknown printed number remain visible without inventing one',async()=>{
  const {files}=fixture();files.get('/data/tcg-card-info/union_arena/a.json').cards[0].fullCardNumber='';const r=runtime(files);await r.api.open('union_arena','union_arena-a');await tick();assert.match(r.get('tciCardGrid').innerHTML,/번호 확인 중/);assert.equal(r.quoteTargets[0].fullNumber,'');
});
test('additional set parts load only on demand and reject a different set in the same game',async()=>{
  const {files}=fixture(),main=files.get('/data/tcg-card-info/union_arena/a.json'),part='/data/tcg-card-info/union_arena/a-part02.json';main.shards=[part];const r=runtime(files);await r.api.open('union_arena','union_arena-a');assert.ok(!r.requests.includes(part));files.set(part,{...main,set:{...main.set,id:'wrong-set'},cards:[]});assert.equal(await r.api.more(),false);assert.equal(r.api.state().set,'union_arena-a');
});
test('failed part on an unknown-card deep link is attempted once instead of looping',async()=>{
  const {files}=fixture(),part='/data/tcg-card-info/union_arena/a-part02.json';files.get('/data/tcg-card-info/union_arena/a.json').shards=[part];const r=runtime(files);await r.api.open('union_arena','union_arena-a','999999');assert.equal(r.requests.filter(url=>url===part).length,1);assert.equal(r.api.state().selected,null);
});
test('only the visible page receives bounded price lookups',async()=>{
  const {files}=fixture(),main=files.get('/data/tcg-card-info/union_arena/a.json'),template=main.cards[0];main.cards=Array.from({length:30},(_,index)=>({...template,id:String(1000+index),snkrProduct:{...template.snkrProduct,id:String(1000+index)}}));const r=runtime(files);await r.api.open('union_arena','union_arena-a');await tick();assert.equal(r.quoteTargets.length,18);r.action('data-tci-page','2');await tick();assert.equal(r.quoteTargets.length,30);
});
test('unsafe files and mismatched card/source identity are rejected',()=>{
  const {files,manifest}=fixture(),r=runtime(files);assert.equal(r.api.dataPath('/data/tcg-card-info/union_arena/a.json'),true);assert.equal(r.api.dataPath('/data/tcg-card-info/../secret.json'),false);assert.equal(r.api.dataPath('https://evil.test/cards.json'),false);const data=structuredClone(files.get('/data/tcg-card-info/union_arena/a.json'));data.cards[0].snkrProduct.id='different';assert.throws(()=>r.api.prepareSet(data,'union_arena',manifest.games.find(game=>game.id==='union_arena').sets[0]),/identity/);
});
test('untrusted source titles are escaped and shared links retain game/set/card',async()=>{
  const {files}=fixture();files.get('/data/tcg-card-info/union_arena/a.json').cards[0].name='<script>alert(1)</script>';const r=runtime(files);await r.api.open('union_arena','union_arena-a');assert.match(r.get('tciCardGrid').innerHTML,/&lt;script&gt;/);assert.doesNotMatch(r.get('tciCardGrid').innerHTML,/<script>/);const address=new URL(r.api.href('union_arena','union_arena-a','201'),'https://tcghub.kr');assert.equal(address.hash,'#cardinfo');assert.equal(address.searchParams.get('brand'),'union_arena');assert.equal(address.searchParams.get('card'),'201');
});
test('actual six-game manifest and one real set per game retain valid source identities',()=>{
  const root=path.resolve(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'data/tcg-card-info.json'),'utf8')),{files}=fixture(),r=runtime(files);r.api.prepareManifest(manifest);assert.equal(manifest.games.length,6);for(const game of manifest.games){assert.ok(game.sets.length>0);const set=game.sets[0],data=JSON.parse(fs.readFileSync(path.join(root,set.file.slice(1)),'utf8')),prepared=r.api.prepareSet(data,game.id,set);assert.equal(prepared.viewGame,game.id);assert.ok(prepared.cards.length>0);for(const card of prepared.cards){const target=r.api.target(card);assert.equal(target.fullNumber,card.fullCardNumber);assert.equal(target.game,card.game);assert.equal(target.snkrdunkId,String(card.snkrProduct.id));}}
});

test('public bundle opens requested member and reuses one cached fetch without mixing another set',async()=>{
  const {files,manifest}=fixture(),game=manifest.games.find(item=>item.id==='union_arena'),a=game.sets[0],b=game.sets[1],bodyA=files.get(a.file),bodyB=files.get(b.file),bundle='/data/tcg-card-info/union_arena/public-0000.json';a.file=b.file=bundle;files.set(bundle,{schemaVersion:1,bundleVersion:1,game:'union_arena',sets:{[a.id]:bodyA,[b.id]:bodyB}});const r=runtime(files);await r.api.open('union_arena',a.id);assert.equal(r.api.state().set,a.id);assert.match(r.get('tciCardGrid').innerHTML,/data-tci-card="201"/);assert.doesNotMatch(r.get('tciCardGrid').innerHTML,/data-tci-card="211"/);await r.api.open('union_arena',b.id);assert.equal(r.api.state().set,b.id);assert.match(r.get('tciCardGrid').innerHTML,/data-tci-card="211"/);assert.doesNotMatch(r.get('tciCardGrid').innerHTML,/data-tci-card="201"/);assert.deepEqual(r.requests,['/data/tcg-card-info.json',bundle]);
});
test('public bundle rejects wrong view game or bundle version',()=>{
  const {files,manifest}=fixture(),r=runtime(files),set=manifest.games.find(item=>item.id==='union_arena').sets[0],flat=files.get(set.file);for(const patch of [{game:'digimon'},{bundleVersion:2},{schemaVersion:2}]){const bundle={schemaVersion:1,bundleVersion:1,game:'union_arena',sets:{[set.id]:flat},...patch};assert.throws(()=>r.api.prepareSet(bundle,'union_arena',set),/bundle/);}
});
test('public bundle requires own set member and rejects prototype keys',()=>{
  const {files,manifest}=fixture(),r=runtime(files),set=manifest.games.find(item=>item.id==='union_arena').sets[0],flat=files.get(set.file);assert.throws(()=>r.api.prepareSet({schemaVersion:1,bundleVersion:1,game:'union_arena',sets:Object.create({[set.id]:flat})},'union_arena',set),/bundle/);for(const key of ['__proto__','constructor','prototype']){const member={...flat,set:{...flat.set,id:key}},members=Object.create(null);members[key]=member;assert.throws(()=>r.api.prepareSet({schemaVersion:1,bundleVersion:1,game:'union_arena',sets:members},'union_arena',{...set,id:key}),/bundle/);}
});
test('public bundle rejects mismatched inner set identity',()=>{
  const {files,manifest}=fixture(),r=runtime(files),set=manifest.games.find(item=>item.id==='union_arena').sets[0],flat=files.get(set.file),bundle={schemaVersion:1,bundleVersion:1,game:'union_arena',sets:{[set.id]:{...flat,set:{...flat.set,id:'other'}}}};assert.throws(()=>r.api.prepareSet(bundle,'union_arena',set),/Set identity/);
});
test('flat additional parts remain lazy and valid after public base bundle',async()=>{
  const {files,manifest}=fixture(),game=manifest.games.find(item=>item.id==='union_arena'),set=game.sets[0],flat=files.get(set.file),part='/data/tcg-card-info/union_arena/a-part02.json',bundle='/data/tcg-card-info/union_arena/public-0000.json';flat.shards=[part];const extra={...flat.cards[0],id:'999',snkrProduct:{...flat.cards[0].snkrProduct,id:'999'}};files.set(part,{schemaVersion:1,game:'union_arena',set:{...flat.set},cards:[extra]});files.set(bundle,{schemaVersion:1,bundleVersion:1,game:'union_arena',sets:{[set.id]:flat}});set.file=bundle;const r=runtime(files);await r.api.open('union_arena',set.id);assert.ok(!r.requests.includes(part));assert.equal(await r.api.more(),true);assert.ok(r.requests.includes(part));assert.match(r.get('tciCardGrid').innerHTML,/data-tci-card="999"/);assert.equal(r.api.state().set,set.id);
});
