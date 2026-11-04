import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=n=>readFileSync(new URL('../'+n,import.meta.url),'utf8');
const data=JSON.parse(read('data/futuristic-market.json'));
const snapshotSource='SNKRDUNK grade charts + paginated sales history; relative trade dates use collection time (JST)';
const backfillSource='backfill v2 (sales-chart/used per grade + sales-history vol)';
function assertCompatibleHistory(product,document){
 assert.equal(String(document.id),String(product.id),'History must belong to the exact product');
 assert.equal(document.currency,product.currency,'History must retain the product currency');
 assert.ok([snapshotSource,backfillSource].includes(document.source),'History must have a recognised collector');
 const snapshotAt=Date.parse(product.sales.fetchedAt),historyAt=Date.parse(document.updatedAt);
 assert.ok(Number.isFinite(snapshotAt)&&Number.isFinite(historyAt),'Both collection times are required');
 assert.ok(historyAt>=snapshotAt,'History must not predate the saved trade list');
 assert.ok(Array.isArray(document.history)&&document.history.length>0,'Complete history rows are required');
 let volume=0,previous='';
 for(const row of document.history){
  assert.match(row.date,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(row.date+'T00:00:00Z').toISOString().slice(0,10),row.date,'History dates must be valid');
  assert.ok(row.date>previous,'History dates must be ordered and unique');previous=row.date;
  const count=row.total_vol===undefined?0:row.total_vol;
  assert.ok(Number.isSafeInteger(count)&&count>=0,'Daily trade volumes must be nonnegative integers');
  volume+=count;assert.ok(Number.isSafeInteger(volume),'Total trade volume must be safe');
 }
 if(historyAt===snapshotAt)assert.equal(volume,product.sales.totalCount,'The same collection must retain every trade exactly');
 else{
  assert.equal(document.source,backfillSource,'Only an independently refreshed backfill may have a newer history');
  assert.ok(volume>=product.sales.totalCount,'A newer complete backfill must retain prior trade coverage');
 }
 return volume;
}
// A shared chart may advance after the four-product trade-list snapshot.
// Keep exact equality for one collection and reject stale or untrusted replacements.
const proofProduct={id:'897035',currency:'JPY',sales:{fetchedAt:'2026-10-31T00:45:41Z',totalCount:2}};
const proofHistory={id:'897035',currency:'JPY',source:snapshotSource,updatedAt:proofProduct.sales.fetchedAt,history:[{date:'2026-10-30',total_vol:2,raw_price:100}]};
const newerHistory={...proofHistory,source:backfillSource,updatedAt:'2026-11-04T00:50:41Z',history:[...proofHistory.history,{date:'2026-11-03',total_vol:1,raw_price:120}]};
assert.equal(assertCompatibleHistory(proofProduct,proofHistory),2);
assert.equal(assertCompatibleHistory(proofProduct,newerHistory),3);
assert.throws(()=>assertCompatibleHistory(proofProduct,{...proofHistory,history:[{date:'2026-10-30',total_vol:3}]}),/same collection/);
assert.throws(()=>assertCompatibleHistory(proofProduct,{...newerHistory,updatedAt:'2026-10-30T00:00:00Z'}),/predate/);
assert.throws(()=>assertCompatibleHistory(proofProduct,{...newerHistory,source:snapshotSource}),/independently refreshed/);
assert.throws(()=>assertCompatibleHistory(proofProduct,{...newerHistory,source:'unverified'}),/recognised/);
assert.throws(()=>assertCompatibleHistory(proofProduct,{...newerHistory,id:'897036'}),/exact product/);
assert.throws(()=>assertCompatibleHistory(proofProduct,{...newerHistory,currency:'KRW'}),/currency/);
assert.throws(()=>assertCompatibleHistory(proofProduct,{...newerHistory,updatedAt:'unknown'}),/collection times/);
assert.throws(()=>assertCompatibleHistory(proofProduct,{...newerHistory,history:[{date:'2026-10-30',total_vol:1}]}),/prior trade coverage/);
assert.throws(()=>assertCompatibleHistory(proofProduct,{...newerHistory,history:[...proofHistory.history,...proofHistory.history]}),/ordered and unique/);
assert.throws(()=>assertCompatibleHistory(proofProduct,{...newerHistory,history:[{date:'2026-10-30',total_vol:-1}]}),/nonnegative integers/);
let handler,modal='',opened=null;
const context=vm.createContext({window:{openSlidePanel:async id=>{opened=id;}},document:{addEventListener:(n,f,c)=>{if(c)handler=f;},querySelectorAll:()=>[]},
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
  const historyDocument=JSON.parse(read('data/history/'+id+'.json'));
  assertCompatibleHistory(p,historyDocument);
  const history=historyDocument.history;
  assert.ok(history.some(r=>r.raw_price>0));assert.ok(history.every(r=>!r.box_price));if(p.packaging==='sealed')assert.ok(history.every(r=>!r.psa10_price));
 }
 const openedId=card.marketIds.find(id=>market.product(id).packaging==='opened');
 for(const ids of [card.marketIds,[...card.marketIds].reverse()]) {
  const item={dataset:{anniversaryIds:JSON.stringify(ids),cardName:card.name},isConnected:true};
  opened=null;modal='';
  await handler({target:{closest:selector=>selector.includes('set-card-item')?item:null},preventDefault(){},stopImmediatePropagation(){}});
  assert.equal(opened,String(openedId));assert.equal(modal,'','Open card details without an intermediate choice');
 }
 for(const id of card.marketIds) {
  const p=market.product(id),supplement=market.renderSupplement(p);
  for(const variantId of card.marketIds)assert.ok(supplement.includes('data-am-variant="'+variantId+'"'));
  assert.ok(supplement.includes('data-am-variant="'+id+'" aria-pressed="true"'));
  const variant={dataset:{amVariant:String(id)}};
  await handler({target:{closest:()=>variant},preventDefault(){},stopImmediatePropagation(){}});
  assert.equal(opened,String(id));
 }
}
const html=read('index.html');assert.ok(html.includes("['M6a','MF','FURBOX'].includes(setCode)"));assert.ok(!html.includes('📭 SNKRDUNK 거래 데이터 없음'));
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/\bsrc=|application\/ld\+json/i.test(m[1])&&m[2].trim())new vm.Script(m[2]);
console.log('PASS: both cards open directly, four exact products, opened/sealed transitions, actual trades, versioned daily volume, stale/foreign/incomplete history rejection, no raw-to-PSA10 fallback, inline scripts');

