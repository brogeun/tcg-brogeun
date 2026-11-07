'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..'),read=f=>JSON.parse(fs.readFileSync(path.join(ROOT,f),'utf8'));
const match=require('../assets/contained-card-match.js');
const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const found=html.match(/const CARDINFO\s*=\s*([\s\S]*?\n});/);assert(found,'CARDINFO source');
const catalog=vm.runInNewContext('('+found[1]+')',{}, {timeout:1000});

test('short Pokemon set names do not match a nested namespace from another set',()=>{
 const card={brand:'pokemon',language:'ja',boxCode:'SD',setCode:'SD',number:'001/127',name:'Venusaur V'};
 const wrong={id:'109394',brand:'pokemon',kind:'card',name:'Palkia LV.X [DP3](Expansion Pack "Shining Darkness")',productNumber:'pkmn-tcg-DP3-SD-0001'};
 assert.equal(match.sameIdentity(card,wrong),false);
 assert.equal(match.resolve(card,[wrong]).status,'unlinked');
 const own={...wrong,id:'999',name:'Venusaur V [SD 001/127]',productNumber:'pkmn-tcg-SD-001'};
 assert.equal(match.sameIdentity(card,own),true);
 assert.equal(match.resolve(card,[own]).id,'999');
});

test('Manaphy movie deck uses its reviewed full namespace and requires artwork proof',()=>{
 const card={brand:'pokemon',language:'ja',boxCode:'VS-MANAPHY',setCode:'VS-MANAPHY',number:'005/019',name:'Manaphy',marketLinkPolicy:'verified-only'};
 const own={id:'435170',brand:'pokemon',kind:'card',name:'of the blue sea Manaphy [2006 VS 005/019]',productNumber:'pkmn-tcg-PCG-MVS-M-005'};
 assert.equal(match.sameIdentity(card,own),true);
 assert.equal(match.sameIdentity(card,{...own,productNumber:'pkmn-tcg-PCG-MVS-L-005'}),false);
 assert.notEqual(match.resolve(card,[own]).status,'matched');
 assert.equal(match.createResolver([own]).candidates(card).length,1);
});

test('all 23 sealed variants remain distinct products of eight multi-product catalogues',()=>{
 const reviews=read('config/registered-box-market-links.json').variants,manual=read('data/manual-boxes-pokemon.json').products;
 assert.equal(reviews.length,23);assert.equal(new Set(reviews.map(r=>r.parentCode)).size,8);
 for(const review of reviews){
  const set=catalog.pokemon.find(s=>s.code===review.parentCode),variant=set?.boxVariants?.find(v=>v.id===review.id),product=manual.find(p=>String(p.id)===review.id);
  assert(variant);assert.equal(variant.label,review.label);assert(product);assert.equal(product.marketVariantOf,review.parentCode);assert.equal(product.code,undefined);assert.equal(product.name,review.sourceName);assert.equal(product.productNumber,review.sourceProductNumber);
  assert.equal(product.identityEvidence.scope,'sealed-variant-only');
  if(product.priceStatus==='available')assert(product.lastPrice>0);else assert.equal(product.lastPrice,null);
 }
});

test('multi-edition sets never silently route to the first edition or fetch a guessed box',async()=>{
 const source=html.match(/async function getBoxIdBySetCode\(code, brand\) \{[\s\S]*?\n\}/)[0];let requests=0;
 const context={CARDINFO:catalog,console,fetch:()=>{requests++;throw Error('Unexpected lookup');}};vm.createContext(context);vm.runInContext(source,context);
 for(const set of catalog.pokemon.filter(s=>s.boxVariants))assert.equal(await context.getBoxIdBySetCode(set.code,'pokemon'),null);
 assert.equal(requests,0);
});

test('choosing a reviewed edition navigates to that exact sealed SKU',async()=>{
 const source=html.match(/window\.gotoBoxPriceFromSet = async function\(code\) \{[\s\S]*?\n\};/)[0];let markup='',closed=0;
 const handlers=new Map(),buttons=['480863','86178'].map(id=>({dataset:{boxVariantId:id},addEventListener:(event,fn)=>handlers.set(id,fn)}));
 const modal={querySelectorAll:()=>buttons,querySelector:()=>null};
 const context={window:{},CARDINFO:catalog,document:{getElementById:()=>modal},location:{hash:''},openAnyModal:html=>{markup=html;},closeAnyModal:()=>closed++,escapeHtml:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'),openSetGrid:()=>{}};
 vm.createContext(context);vm.runInContext(source,context);await context.window.gotoBoxPriceFromSet('EBB');
 assert.match(markup,/초판 · 1ED 박스/);assert.match(markup,/재판 박스/);assert.equal(context.location.hash,'');
 handlers.get('86178')();assert.equal(context.location.hash,'#price/86178');assert.equal(closed,1);
});
