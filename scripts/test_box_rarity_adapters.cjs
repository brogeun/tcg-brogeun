/* Execute real provider render/detail/return functions with an offline DOM fixture. */
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const R=require('../assets/card-rarity-filters.js');
const root=path.resolve(__dirname,'..');
const indexPath=process.env.TCG_RARITY_INDEX||path.join(root,'index.html');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
class Element {
  constructor(id=''){this.id=id;this.innerHTML='';this.textContent='';this.scrollTop=0;this.dataset={};this.hidden=false;}
  querySelectorAll(selector){
    if(selector!=='button[data-card-rarity]')return [];
    return [...this.innerHTML.matchAll(/data-card-rarity="([^"]*)"/g)].map(m=>({owner:this,dataset:{cardRarity:m[1]},disabled:false,focus(){},closest(){return this;}}));
  }
  querySelector(){return null;}
  contains(button){return button.owner===this;}
  focus(){}
}
function between(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,'locate real provider functions: '+start);return source.slice(a,b);}
function setup(kind){
  const ids=new Map(),mounted=new Map();let scroll=new Element('scroll'),panelHTML='';
  const document={getElementById:id=>ids.get(id)||null,querySelector:()=>scroll,querySelectorAll:()=>[]};
  const panel=html=>{panelHTML=html;ids.clear();for(const m of html.matchAll(/\bid="([^"]+)"/g))ids.set(m[1],new Element(m[1]));scroll=ids.get('ckPanelScroll')||new Element('scroll');};
  const fixture={code:'FIXTURE',name:'Fixture',originalName:'Fixture',displayCode:'F',release:'2026.01.01',productType:'booster',cards:Array.from({length:64},(_,i)=>({
    id:'id'+i,sourceId:String(i),number:String(i).padStart(3,'0'),name:'Fixture Card '+i,nameJa:'Card '+i,
    rarity:i<30?'AR':i<54?'SAR':i<62?'RR':'',searchText:('fixturecard'+i).toLowerCase(),
    image:'',types:[],domains:[],tags:[],artists:[],sourceUrls:[],
  })),cardCount:64};
  const source=fs.readFileSync(path.join(root,'assets',kind.file),'utf8');
  const api={...R,mount(container,config){if(container)mounted.set(container.id,config);R.mount(container,config);}};
  const ctx=vm.createContext({window:{CardRarityFilters:api},document,fixture,esc,normalize:s=>String(s||'').toLowerCase().replace(/\s+/g,''),searchText:s=>String(s||'').toLowerCase().replace(/\s+/g,''),
    name:c=>c.name,art:()=>'',image:()=>'',imageHTML:()=>'',badges:()=>'',header:()=>'',toolbar:()=>'',icon:()=>'',setFactsHTML:()=>'',releaseHTML:()=>'',
    panel,present:panel,owns:()=>true,shell:()=>({querySelectorAll:()=>[]}),pages:(p,n)=>p+'/'+n,pagination:(p,n)=>p+'/'+n,pager:(p,n)=>p+'/'+n,
    variants:()=>'',boxMarket:()=>'',cardMarket:()=>'',variantName:c=>c.variant||'',validPrice:()=>false,sourceURL:()=>'',money:()=>null,supportedSale:()=>false,historyHTML:()=>'',rarityLabel:c=>c.rarity||'미확인',inclusionLabel:()=>'',sourceName:()=>'',
    matches:(c,q)=>c.searchText.includes(String(q||'').replace(/\s+/g,'').toLowerCase()),matching:(cards,q)=>cards.filter(c=>c.searchText.includes(String(q||'').replace(/\s+/g,'').toLowerCase())),
  });
  let code;
  if(kind.id==='ck'){
    code="let activeSet=fixture,selectedCard=null,page=1,cardQuery='',cardRarities=[],gridScroll=0,focusCardId='',modalRequest=0;const PAGE_SIZE=18,PRODUCT_TYPES={booster:'부스터'};"+
      between(source,'  function gridBody(','  function sourceName(')+between(source,'  function detail(id) {','  async function open(');
  }else if(kind.id==='rf'){
    code="let active=fixture,selected=null,page=1,query='',cardRarities=[],cardScroll=0;const PAGE_SIZE=18;"+between(source,'  function body(){','  async function open(');
  }else{
    code="let active=fixture,currentCard=null,cardPage=1,cardQuery='',cardRarities=[],cardScroll=0,linkNotice='';const cardsPerPage=18,CARDS_PER_PAGE=18;"+
      between(source,'  function setBody(){','  async function open(')+between(source,'  function detail(id){','  async function share(');
  }
  vm.runInContext(code,ctx,{filename:kind.file});
  const render=()=>vm.runInContext(kind.panel+'()',ctx);
  const update=()=>vm.runInContext(kind.body+'()',ctx);
  const grid=()=>ids.get(kind.id+'CardGrid');
  const count=()=>{const node=ids.get(kind.id+'CardCount');return node.innerHTML+node.textContent;};
  const rows=()=>[...grid().innerHTML.matchAll(new RegExp('data-'+kind.id+'-card="([^"]+)"','g'))].map(m=>m[1]);
  const clickRarity=key=>{const container=ids.get(kind.id+'RarityFilters');const button=container.querySelectorAll('button[data-card-rarity]').find(b=>b.dataset.cardRarity===key);assert(button,'real mounted choice '+key);container.onclick({target:button,preventDefault(){},stopPropagation(){}});};
  return {ctx,fixture,render,update,rows,count,clickRarity,ids,mounted,scroll:()=>scroll,panelHTML:()=>panelHTML};
}

const kinds=[
  {id:'enc',file:'english-catalog.js',panel:'setModal',body:'setBody',page:'cardPage',query:'cardQuery'},
  {id:'cn',file:'chinese-catalog.js',panel:'setModal',body:'setBody',page:'cardPage',query:'cardQuery'},
  {id:'rf',file:'riftbound-catalog.js',panel:'setPanel',body:'body',page:'page',query:'query'},
  {id:'ck',file:'chiikawa-catalog.js',panel:'gridPanel',body:'gridBody',page:'page',query:'cardQuery'},
];
for(const kind of kinds)test(kind.id+' real box adapter: OR, search, filtered counts/pages, detail return and unknown',()=>{
  const h=setup(kind);h.render();assert.equal(h.rows().length,18);assert(h.count().includes('1 / 4'));
  assert(h.panelHTML().includes('ci-rarity-summary'));assert(!h.ids.get(kind.id+'RarityFilters').innerHTML.includes('known:MUR'));
  h.clickRarity('known:AR');assert(h.count().includes('30'));assert(h.count().includes('1 / 2'));
  h.clickRarity('known:SAR');assert(h.count().includes('54'));assert(h.count().includes('1 / 3'));
  vm.runInContext(kind.page+'=3',h.ctx);h.update();assert.equal(h.rows().length,18);
  h.scroll().scrollTop=311;vm.runInContext('detail('+JSON.stringify(kind.id==='enc'?'40':'id40')+')',h.ctx);
  assert(!h.panelHTML().includes('RarityFilters'),'card detail has no box filter');
  vm.runInContext(kind.panel+'(true)',h.ctx);assert(h.count().includes('3 / 3'));assert.equal(h.scroll().scrollTop,311);
  assert.equal(h.mounted.get(kind.id+'RarityFilters').selected.length,2,'return retains both choices');
  vm.runInContext(kind.query+'="Fixture Card 42"',h.ctx);h.update();assert.equal(h.rows().length,1);assert(h.count().includes('1 / 1'));
  vm.runInContext(kind.query+'=""',h.ctx);h.update();h.clickRarity('');assert(h.count().includes('1 / 4'));
  h.clickRarity('unknown');assert.equal(h.rows().length,2);assert(h.count().includes('1 / 1'));
  vm.runInContext(kind.query+'="no-match"',h.ctx);h.update();assert.equal(h.rows().length,0);assert(h.count().includes('1 / 1'));
});

test('JP/OP inline box path includes helper and restoration, not collection markup',()=>{
  const html=fs.readFileSync(indexPath,'utf8');
  const inline=between(html,'window.openSetGrid = async function','/* ─────────── 카드정보 set-code');
  assert(inline.includes('CardRarityFilters'),'JP/OP real inline route integrates helper');
  assert(inline.includes('RarityFilters'),'JP/OP inline panel provides mounted filter container');
  assert(/viewState\.rarities/.test(inline),'restore filter state is persisted');
  assert(html.indexOf('card-rarity-filters.js')<html.indexOf('english-catalog.js'),'helper loads before providers');
  const wrapper=between(html,'window.openSetGrid = function(setCode, setName, externalUrl, restore = {})','function openJapaneseCatalogueCard');
  assert(wrapper.includes('rarities'),'last-set return wrapper preserves rarity selection');
});

for(const brand of ['pokemon','onepiece'])test(brand+' actual inline openSetGrid filters before count/pages and restores selection',async()=>{
  const html=fs.readFileSync(indexPath,'utf8');
  const inline=between(html,'window.openSetGrid = async function','/* ─────────── 카드정보 set-code');
  const nodes=new Map();
  class Node extends Element {
    constructor(id=''){super(id);this.classList={add(){},toggle(){return false;},contains:()=>true};}
    get innerHTML(){return this._html||'';}
    set innerHTML(value){this._html=value;for(const m of String(value).matchAll(/\bid="([^"]+)"/g))if(m[1]!==this.id)nodes.set(m[1],new Node(m[1]));}
    setAttribute(){}
    addEventListener(){}
    querySelector(selector){return selector==='.ci-panel-scroll'?scroll:selector==='.modal-box'?box:null;}
  }
  const scroll=new Node('scroll'),box=new Node('box'),modal=new Node('anyModal');nodes.set('anyModal',modal);
  const sourceCards=Array.from({length:42},(_,i)=>({number:String(i+1).padStart(3,'0'),fullId:'OP01-'+String(i+1).padStart(3,'0'),name:'Fixture '+i,rarity:i<21?'AR':i<40?'SAR':'',image:''}));
  const viewState={page:2,scrollTop:180,rarities:['known:AR']};
  const ctx=vm.createContext({window:{CardRarityFilters:R},document:{getElementById:id=>nodes.get(id)||null,querySelectorAll:()=>[],activeElement:null},
    CI_PANEL_REQUEST:0,CI_CARD_PAGE_SIZE:18,CARDINFO:{pokemon:brand==='pokemon'?[{code:'TEST',name:'Fixture'}]:[],onepiece:brand==='onepiece'?[{code:'TEST',name:'Fixture'}]:[]},
    ciIcon:()=>'',escapeHtml:esc,openAnyModal(content){modal.innerHTML=content;},fetch:async()=>({ok:true,text:async()=>JSON.stringify({cards:sourceCards})}),
    location:{href:'https://fixture.invalid/#cardinfo'},navigator:{},showToast(){},URL,
  });
  vm.runInContext(inline,ctx);
  await ctx.window.openSetGrid('TEST','Fixture','',viewState);
  const summary=()=>nodes.get('setGridContent').innerHTML;
  const gridRows=()=>[...summary().matchAll(/data-card-index="(\d+)"/g)].length;
  assert(summary().includes('필터 21장'));assert(summary().includes('2 / 2 페이지'));assert.equal(gridRows(),3);assert.equal(scroll.scrollTop,180);
  const choose=key=>{const container=nodes.get('ciRarityFilters'),button=container.querySelectorAll('button[data-card-rarity]').find(b=>b.dataset.cardRarity===key);assert(button);container.onclick({target:button,preventDefault(){},stopPropagation(){}});};
  choose('known:SAR');assert(summary().includes('필터 40장'));assert(summary().includes('1 / 3 페이지'));assert.equal(viewState.page,1);assert.equal(scroll.scrollTop,0);
  nodes.get('ciPanelPages').onclick({target:{closest:()=>({disabled:false,dataset:{page:'3'}})}});
  assert(summary().includes('3 / 3 페이지'));assert.equal(gridRows(),4);
  const restored={...viewState,scrollTop:240,rarities:viewState.rarities.slice()};
  await ctx.window.openSetGrid('TEST','Fixture','',restored);
  assert(summary().includes('3 / 3 페이지'));assert.equal(scroll.scrollTop,240);assert.equal(restored.rarities.length,2);
  choose('');choose('unknown');assert(summary().includes('필터 2장'));assert.equal(gridRows(),2);assert(summary().includes('1 / 1 페이지'));
  assert(!nodes.get('ciRarityFilters').innerHTML.includes('known:MUR'));
});
