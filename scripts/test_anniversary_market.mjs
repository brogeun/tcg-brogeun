import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=n=>readFileSync(new URL('../'+n,import.meta.url),'utf8');
const data=JSON.parse(read('data/anniversary-market.json'));
const audit=JSON.parse(read('data/anniversary-audit.json'));
let handler,modal='',opened='';
const ctx=vm.createContext({window:{},document:{addEventListener:(name,fn,capture)=>{if(name==='click'&&capture)handler=fn;},querySelectorAll:()=>[]},
  AbortSignal,Date,Map,console,fetch:async()=>({ok:true,json:async()=>data}),
  fmtKrw:(n,c)=>n==null?'—':'₩'+Math.floor(n*(c==='JPY'?8.75:1300)).toLocaleString('ko-KR'),
  closeAnyModal(){},openAnyModal:html=>{modal=html;},FX_READY:Promise.resolve()});
vm.runInContext(read('assets/anniversary-market.js'),ctx);
vm.runInContext(read('assets/home-market.js'),ctx);
const market=ctx.window.AnniversaryMarket;
ctx.window.openSlidePanel=async id=>{opened=id;};
await market.load();
assert.equal(Object.keys(data.products).length,228);
assert.equal(audit.failures.length,0);
for(const code of ['M6a','MF']){
  assert.equal(audit.sets[code].unlinked.length,0);
  const catalog=JSON.parse(read('data/cards-by-set/'+code+'.json'));
  for(const card of catalog.cards){
    assert.ok(card.marketIds.length>0);
    for(const id of card.marketIds){
      const p=data.products[id];assert.ok(p);assert.equal(p.setCode,code);assert.equal(p.currency,'JPY');
      if(!card.unprintedNumber&&!card.marketSupplement)assert.equal(p.number.toUpperCase(),card.number.toUpperCase());
      for(const g of p.grades)assert.ok(g.lowestAsk===null || Number.isSafeInteger(g.lowestAsk)&&g.lowestAsk>0);
    }
  }
}
for(const id of ['881421','881423']){
  const p=data.products[id];assert.equal(p.grades[0].key,'box');
  assert.equal(market.quote({id}).value,p.grades[0].lowestAsk);
  assert.equal(ctx.window.HomeMarket.quote({id,lastPrice:99,currency:'USD'}).currency,'JPY');
}
const empty=Object.values(data.products).find(p=>p.kind==='card'&&!p.grades.find(g=>g.key==='raw')?.lowestAsk);
assert.ok(empty);
assert.equal(ctx.window.HomeMarket.quote({id:empty.id,lastPrice:999,currency:'USD'}),null);
const card=Object.values(data.products).find(p=>p.kind==='card'&&p.grades.find(g=>g.key==='raw')?.lowestAsk);
let stopped=false;
await handler({target:{closest:()=>({dataset:{anniversaryIds:JSON.stringify([card.id]),cardName:card.name},isConnected:true})},
  preventDefault(){},stopImmediatePropagation(){stopped=true;}});
assert.equal(stopped,true);
assert.equal(opened,String(card.id),'A card opens the existing shared price panel');
assert.equal(modal,'','Single products must not use an anniversary-only modal');
for(const grade of card.grades)if(grade.lowestAsk)assert.ok(market.renderSupplement(card).includes('¥'+grade.lowestAsk.toLocaleString('ko-KR')));
assert.ok(!market.renderSupplement(card).includes('<img'),'Only the common panel owns the product image');
assert.ok(market.renderSupplement(data.products['892669']).includes('2장 묶음 상품 가격'));
assert.equal(JSON.parse(read('data/cards-by-set/M6a.json')).cards.filter(c=>!c.isBundle).length,176);
console.log('PASS: 225 source cards linked, 226 card products + 2 boxes, exact grade JPY, shared panel click, bundle exclusion');

// Execute the actual common renderer with deterministic data and a minimal DOM.
const html=read('index.html');
const source=html.slice(html.indexOf('async function renderSlidePanel(productId)'),html.indexOf('\nfunction _krw(jpy)'));
const nodes=new Map();
function node(key){
  if(!nodes.has(key))nodes.set(key,{innerHTML:'',textContent:'',dataset:{},classList:{toggle(){},remove(){},add(){}},
    querySelector:selector=>node(key+' '+selector),querySelectorAll:()=>[],insertAdjacentHTML(position,markup){this.innerHTML+=markup;}});
  return nodes.get(key);
}
Object.assign(ctx,{
  AnniversaryMarket:market,HomeMarket:ctx.window.HomeMarket,HOME_TOP_CACHE:{},PRICE_CAT:'card',CURRENT_SLIDE_ID:null,
  JPY_KRW:8.75,USD_KRW:1300,escapeHtml:s=>String(s),isCardProduct:()=>true,
  enrichPriceProductMetadata:async()=>{},loadCardsDetail:async()=>({cards:{}}),
  fetch:async()=>({ok:false}),PriceProductInfo:{get:async()=>({sets:[]})}
});
ctx.window.PriceProductInfo=ctx.PriceProductInfo;
ctx.document.getElementById=node;
vm.runInContext(source,ctx);
for(const id of [String(card.id),String(empty.id),'892669']){
  nodes.clear();ctx.CURRENT_SLIDE_ID=id;
  await ctx.renderSlidePanel(id);
  assert.ok(node('slideCardImg').innerHTML.includes(data.products[id].thumbnailUrl));
  assert.ok(!node('slideCardImg').innerHTML.includes('style='),'Every product uses the same image CSS');
  assert.equal(node('slideName').textContent,data.products[id].name);
  assert.ok(node('slideBody').innerHTML.includes('포트폴리오 추가'));
  assert.ok(node('slideBody').innerHTML.includes('가격 · 거래량 히스토리'));
  assert.ok(node('slideBody .slide-price-box').innerHTML.includes('전체 등급 · 엔화 가격 보기'));
  assert.ok(node('slideBody .slide-chart-wrap').innerHTML.includes('아직 누적된 거래 내역이 없습니다'));
  if(id===String(empty.id))assert.ok(node('slideBody').innerHTML.includes('출품 없음'));
  if(id==='892669')assert.ok(node('slideBody .slide-price-box').innerHTML.includes('2장 묶음'));
}
console.log('PASS: real shared renderer, common artwork CSS, empty prices/history, supplementary grades, bundle warning');
