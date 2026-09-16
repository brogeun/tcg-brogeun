import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=n=>readFileSync(new URL('../'+n,import.meta.url),'utf8');
const data=JSON.parse(read('data/anniversary-market.json'));
const audit=JSON.parse(read('data/anniversary-audit.json'));
let handler,modal='';
const ctx=vm.createContext({window:{},document:{addEventListener:(name,fn,capture)=>{if(name==='click'&&capture)handler=fn;},querySelectorAll:()=>[]},
  AbortSignal,Date,Map,console,fetch:async()=>({ok:true,json:async()=>data}),
  fmtKrw:(n,c)=>n==null?'—':'₩'+Math.floor(n*(c==='JPY'?8.75:1300)).toLocaleString('ko-KR'),
  closeAnyModal(){},openAnyModal:html=>{modal=html;},FX_READY:Promise.resolve()});
vm.runInContext(read('assets/anniversary-market.js'),ctx);
vm.runInContext(read('assets/home-market.js'),ctx);
const market=ctx.window.AnniversaryMarket;
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
assert.ok(modal.includes(card.name.replace(/"/g,'&quot;')));
for(const grade of card.grades)if(grade.lowestAsk)assert.ok(modal.includes('¥'+grade.lowestAsk.toLocaleString('ko-KR')));
assert.ok(market.render(data.products['892669']).includes('2장 묶음 상품 가격'));
assert.equal(JSON.parse(read('data/cards-by-set/M6a.json')).cards.filter(c=>!c.isBundle).length,176);
console.log('PASS: 225 source cards linked, 226 card products + 2 boxes, exact grade JPY, no stale fallback, modal click, bundle exclusion');

