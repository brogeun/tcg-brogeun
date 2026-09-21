import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=n=>readFileSync(new URL('../'+n,import.meta.url),'utf8');
const data=JSON.parse(read('data/futuristic-market.json'));
let handler,modal='';
const context=vm.createContext({window:{},document:{addEventListener:(n,f,c)=>{if(c)handler=f;},querySelectorAll:()=>[]},
  AbortSignal,Date,console,fetch:async url=>({ok:true,json:async()=>JSON.parse(read(url.includes('futuristic-market')?'data/futuristic-market.json':'data/anniversary-market.json'))}),
  fmtKrw:(n,c)=>'KRW '+n,closeAnyModal(){},openAnyModal:h=>{modal=h;}});
vm.runInContext(read('assets/anniversary-market.js'),context);
const market=context.window.AnniversaryMarket;await market.load();
const catalog=JSON.parse(read('data/cards-by-set/FURBOX.json'));
for(const card of catalog.cards){
 assert.equal(card.marketIds.length,2);
 for(const id of card.marketIds){
  const p=market.product(id);assert.equal(p.number,card.number);assert.equal(p.kind,'card');
  assert.ok(p.sales.trades.length>0);assert.equal(p.sales.totalCount,p.sales.trades.length);
  assert.equal(market.gradeQuote(id,'psa10')?.value??null,p.grades.find(g=>g.key==='psa10')?.lowestAsk??null,'Only the matching grade supplies PSA10');
  const h=market.renderSupplement(p);assert.ok(h.includes('최근 실제 거래 내역'));assert.ok(h.includes('¥'+p.sales.trades[0].price.toLocaleString('ko-KR')));
  const history=JSON.parse(read('data/history/'+id+'.json')).history;
  assert.equal(history.reduce((n,r)=>n+(r.total_vol||0),0),p.sales.totalCount);
  assert.ok(history.some(r=>r.raw_price>0));assert.ok(history.every(r=>!r.box_price));if(p.packaging==='sealed')assert.ok(history.every(r=>!r.psa10_price));
 }
 const item={dataset:{anniversaryIds:JSON.stringify(card.marketIds),cardName:card.name},isConnected:true};
 await handler({target:{closest:()=>item},preventDefault(){},stopImmediatePropagation(){}});
 assert.ok(modal.includes('개봉 · 등급별 시세'));assert.ok(modal.includes('미개봉 · 1팩'));
 for(const id of card.marketIds)assert.ok(modal.includes('data-am-id="'+id+'"'));
}
const html=read('index.html');assert.ok(html.includes("['M6a','MF','FURBOX'].includes(setCode)"));assert.ok(!html.includes('📭 SNKRDUNK 거래 데이터 없음'));
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/\bsrc=|application\/ld\+json/i.test(m[1])&&m[2].trim())new vm.Script(m[2]);
console.log('PASS: both cards, four exact products, opened/sealed choices, actual trades, daily volume, no raw-to-PSA10 fallback, inline scripts');
