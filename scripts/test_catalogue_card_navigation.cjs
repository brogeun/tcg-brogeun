/* Run the real catalogue navigation and contained-card selector with offline fixtures. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const html=()=>fs.readFileSync(process.env.TCG_CATALOGUE_INDEX||path.join(root,'index.html'),'utf8');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function between(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,'locate real source: '+start);return source.slice(a,b);}
function navigation({pokemon=[],onepiece=[],ensureManifest=async()=>{},registerSets=sets=>sets,prepareRoute=async()=>({ready:true})}={}){
  const opened=[],routes=[],closed=[],tabs=['pokemon','onepiece'].map(brand=>({dataset:{ci:brand},attributes:{},active:false,classList:{toggle(_name,value){this.owner.active=value;}},setAttribute(name,value){this.attributes[name]=value;}}));
  tabs.forEach(tab=>{tab.classList.owner=tab;});
  const onepieceAPI={ensureManifest,registerSets};
  const context=vm.createContext({CARDINFO:{pokemon,onepiece},CI_TAB:'pokemon',SLIDE_PANEL_REQUEST:1,window:{OnePieceCatalog:onepieceAPI,closeGlobalSearch(){closed.push(true);}},OnePieceCatalog:onepieceAPI,
    document:{body:{dataset:{page:'home'}},querySelectorAll:()=>tabs},openSetGrid(...args){opened.push(args);return 'opened';},go(page){routes.push(page);context.document.body.dataset.page=page;return prepareRoute(page);},renderCardInfo(){},console});
  const source=html(),start=source.search(/(?:async\s+)?function openJapaneseCatalogueCard\(/);
  assert(start>=0,'locate real navigation function');
  vm.runInContext(source.slice(start,source.indexOf('// Printed Japanese cards',start)),context,{filename:'index.html catalogue navigation'});
  return {context,opened,routes,closed,tabs,open:card=>context.openJapaneseCatalogueCard(card)};
}

test('unpriced Pokemon catalogue result opens its exact box and printed-card key',async()=>{
  const h=navigation({pokemon:[{code:'SV4K',name:'고대의 포효',url:'https://fixture.invalid/SV4K'}]});
  await h.open({brand:'pokemon',kind:'card',boxCode:'SV4K',setCode:'SV4K',number:'090/066',productId:null});
  assert.equal(h.opened.length,1);
  assert.deepEqual(h.opened[0].slice(0,3),['SV4K','고대의 포효','https://fixture.invalid/SV4K']);
  assert.equal(h.opened[0][3].cardKey,'090/066');
  assert.deepEqual(h.routes,['cardinfo']);assert.equal(h.closed.length,1);
});

test('One Piece promo artwork opens PROMO acquisition instead of its printed OP06 set',async()=>{
  const h=navigation({onepiece:[{code:'OP06',name:'선장의 날개'},{code:'PROMO',name:'프로모'}]});
  await h.open({brand:'onepiece',kind:'card',boxCode:'PROMO',setCode:'OP06',fullId:'OP06-093_p2'});
  assert.equal(h.opened.length,1);assert.equal(h.opened[0][0],'PROMO');assert.equal(h.opened[0][3].cardKey,'OP06-093_p2');
  assert.equal(h.context.CI_TAB,'onepiece');
  const active=h.tabs.find(tab=>tab.dataset.ci==='onepiece');
  assert.equal(active.active,true);assert.equal(active.attributes['aria-pressed'],'true');
  assert.equal(h.tabs.find(tab=>tab.dataset.ci==='pokemon').active,false);
});

test('a newly registered One Piece product waits for its manifest before lookup',async()=>{
  let release,registrations=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const h=navigation({onepiece:[{code:'OP01',name:'로맨스 던'}],ensureManifest:()=>pending,registerSets:sets=>{registrations++;return [...sets,{code:'ST36',fileCode:'ST36',name:'스타트덱 36'}];}});
  const result=h.open({brand:'onepiece',kind:'card',boxCode:'ST36',setCode:'OP10',fullId:'OP10-099_p2'});
  await Promise.resolve();assert.equal(h.opened.length,0,'no premature fallback to the printed set');
  release();await result;
  assert.equal(registrations,1);assert.equal(h.opened.length,1);assert.equal(h.opened[0][0],'ST36');assert.equal(h.opened[0][3].cardKey,'OP10-099_p2');
});

test('catalogue navigation uses officialId when no fullId is supplied',async()=>{
  const h=navigation({onepiece:[{code:'EB05',name:'히로인즈 Vol.2'}]});
  await h.open({brand:'onepiece',kind:'card',boxCode:'EB05',setCode:'EB05',officialId:'EB05-010_p2',number:'010'});
  assert.equal(h.opened.length,1);assert.equal(h.opened[0][3].cardKey,'EB05-010_p2');
});

test('a delayed manifest cannot replace a more recent card navigation',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const h=navigation({ensureManifest:()=>pending,registerSets:sets=>[...sets,{code:'ST36',name:'스타트덱 36'}]});
  const result=h.open({brand:'onepiece',kind:'card',boxCode:'ST36',fullId:'OP10-099_p2'});
  h.context.SLIDE_PANEL_REQUEST++;
  release();await result;
  assert.equal(h.opened.length,0);assert.equal(h.closed.length,0);assert.equal(h.routes.length,0);
});

test('catalogue navigation waits for route modules before opening its exact printing',async()=>{
  let release;const route=new Promise(resolve=>{release=resolve;});
  const h=navigation({pokemon:[{code:'SV4K',name:'fixture'}],prepareRoute:()=>route});
  const work=h.open({brand:'pokemon',kind:'card',boxCode:'SV4K',number:'090/066'});
  await Promise.resolve();assert.equal(h.opened.length,0);
  release({ready:true});await work;assert.equal(h.opened[0][3].cardKey,'090/066');
});
test('failed or departed feature routes do not open a catalogue over the current screen',async()=>{
  for(const result of [{ready:false},{ready:false,cancelled:true}]){
    const h=navigation({pokemon:[{code:'SV4K',name:'fixture'}],prepareRoute:async()=>result});
    await h.open({brand:'pokemon',kind:'card',boxCode:'SV4K',number:'090/066'});assert.equal(h.opened.length,0);
  }
});
test('a newer slide detail cancels a printed-card route that was awaiting its modules',async()=>{
  let release;const route=new Promise(resolve=>{release=resolve;});
  const h=navigation({pokemon:[{code:'SV4K',name:'fixture'}],prepareRoute:()=>route});
  const work=h.open({brand:'pokemon',kind:'card',boxCode:'SV4K',number:'090/066'});
  await Promise.resolve();h.context.SLIDE_PANEL_REQUEST++;release({ready:true});await work;
  assert.equal(h.opened.length,0);
});

test('EB05 official artwork key selects the correct page despite a different marketplace fullId',async()=>{
  const data=read('data/cards-by-set/EB05.json');
  const index=data.cards.findIndex(card=>card.officialId&&card.officialId!==card.fullId&&data.cards.indexOf(card)>=18);
  assert(index>=18,'real EB05 artwork with a distinct marketplace ID after page one');
  const target=data.cards[index],nodes=new Map(),focused=[],scrolled=[];
  let scroll,box;
  class Element {
    constructor(id=''){this.id=id;this.scrollTop=0;this.classList={add(){},toggle(){return false;},contains:()=>true};}
    get innerHTML(){return this._html||'';}
    set innerHTML(value){this._html=String(value);for(const match of this._html.matchAll(/\bid="([^"]+)"/g))if(match[1]!==this.id)nodes.set(match[1],new Element(match[1]));}
    setAttribute(){} addEventListener(){} focus(){}
    querySelector(selector){
      if(selector==='.ci-panel-scroll')return scroll;
      if(selector==='.modal-box')return box;
      const match=selector.match(/^\[data-card-index="(\d+)"\]$/);
      return match?{focus(){focused.push(Number(match[1]));},scrollIntoView(){scrolled.push(Number(match[1]));}}:null;
    }
  }
  scroll=new Element('scroll');box=new Element('box');const modal=new Element('anyModal');nodes.set('anyModal',modal);
  const context=vm.createContext({window:{},document:{getElementById:id=>nodes.get(id)||null,querySelectorAll:()=>[],activeElement:null},
    CI_PANEL_REQUEST:0,CI_CARD_PAGE_SIZE:18,CARDINFO:{pokemon:[],onepiece:[{code:'EB05',name:'히로인즈 Vol.2'}]},
    ciIcon:()=>'',escapeHtml:esc,openAnyModal(content){modal.innerHTML=content;},fetch:async()=>({ok:true,text:async()=>JSON.stringify(data)}),
    location:{href:'https://fixture.invalid/?set=EB05#cardinfo'},navigator:{},showToast(){},URL});
  vm.runInContext(between(html(),'window.openSetGrid = async function','/* ─────────── 카드정보 set-code'),context,{filename:'index.html contained-card selector'});
  const state={cardKey:target.officialId};
  await context.window.openSetGrid('EB05','히로인즈 Vol.2','',state);
  assert.equal(state.page,Math.floor(index/18)+1,'official artwork key determines its actual grid page');
  assert.deepEqual(focused,[index]);assert.deepEqual(scrolled,[index]);
});
