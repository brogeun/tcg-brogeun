const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const path=require('node:path'),root=path.resolve(__dirname,'../..');
const text=p=>fs.readFileSync(path.join(root,p),'utf8');
const manifest=JSON.parse(text('data/card-catalog-repairs.json'));
function context(response){
  let calls=0;
  const b={console,URL,URLSearchParams,AbortSignal,Date,Map,Set,WeakMap,
    fetch:async()=>{calls++;return {ok:true,json:async()=>response};}};
  b.window=b;vm.createContext(b);
  for(const file of ['card-catalog-repairs','contained-card-match','contained-card-prices','card-price-fallback'])vm.runInContext(text('assets/'+file+'.js'),b);
  b.CardCatalogRepairs.configure(manifest);
  return {b,calls:()=>calls};
}
const response=(id,amount)=>({id,ok:true,fetchedAt:new Date().toISOString(),grades:amount?{raw:{lowest_ask:amount,currency:'JPY',active_count:2}}:{},noListingGrades:amount?[]:['raw']});
test('the search, contained-card bridge and detail share one exact JPY observation',async()=>{
  const {b,calls}=context(response('871082',3500));
  const raw=b.CardCatalogRepairs.products([]).find(p=>p.id==='871082');
  const old={...raw,minPrice:33,currency:'USD',listingCount:9,grades:{raw:{lowest_ask:44,currency:'USD'}}};
  const target=manifest.onepieceDon.find(p=>p.productId==='871082');
  const prepared=await b.ContainedCardPrices.prepareTarget({...target,brand:'onepiece',language:'ja',boxCode:'OP17'},
    {services:{loadProducts:async()=>[old],loadOverrides:async()=>({}),loadDetails:async()=>({cards:{871082:{grades:{raw:{lowest_ask:33,currency:'USD'}}}}})}});
  const quoted=b.CardPriceFallback.resolve(prepared);
  assert.equal(quoted.amount,3500);assert.equal(quoted.currency,'JPY');
  const detail=await b.CardCatalogRepairs.quoteProduct({...old,lastPrice:33});
  assert.equal(detail.lastPrice,3500);assert.equal(detail.currency,'JPY');assert.equal(detail.kind,'card');
  assert.equal((await b.CardCatalogRepairs.liveQuote('871082')).amount,3500);assert.equal(calls(),1);
  assert.match(detail.nameKo,/다이아몬드/);assert.equal(detail.setCode,'OP17');
});
test('no listings, wrong IDs and stale observations cannot fall back to a USD ask',async()=>{
  for(const reply of [response('871082',null),response('871081',3500),{...response('871082',3500),fetchedAt:'2020-01-01T00:00:00Z'}]){
    const {b}=context(reply);
    const row=await b.CardCatalogRepairs.quoteProduct({id:'871082',brand:'onepiece',minPrice:33,lastPrice:33,currency:'USD',catalogAsk:{amount:33,currency:'USD'}});
    assert.equal(row.minPrice,null);assert.equal(row.lastPrice,null);assert.equal(row.currency,'JPY');assert.equal(row.catalogAsk,null);
    assert.equal(row.grades.raw,undefined);
  }
});
test('unrelated products and foreign editions retain their own metadata',async()=>{
  const {b,calls}=context(response('871082',3500));
  for(const row of [{id:'871082',brand:'pokemon'},{id:'871082',brand:'onepiece',language:'en'},{id:'12345',brand:'onepiece'}])assert.equal(await b.CardCatalogRepairs.quoteProduct(row),row);
  assert.equal(calls(),0);
});
test('expanded detail classifies numberless DON as a card even without history',()=>{
  const b={document:{addEventListener(){}},isCardProduct:name=>/^DON!!\s*Card\b/.test(name)||/\[[^\]]*\d+[^\]]*\]/.test(name)};
  b.window=b;b.addEventListener=()=>{};vm.createContext(b);vm.runInContext(text('assets/price-expanded.js'),b);
  for(const p of [{name:'DON!! Card :Gold Text (Rocks Pirates)'},{kind:'card',name:'Unknown'},{cardType:'DON',name:'Unknown'}])assert.equal(b.PriceExpandedTest.isBox(p,[]),false);
  assert.equal(b.PriceExpandedTest.isBox({kind:'box',name:'Booster Box'},[]),true);
});
test('OP17 retains 169 official numbered cards and 8 DON designs, with exact reprint identity',()=>{
  const {b}=context(response('871082',3500)),source=JSON.parse(text('data/cards-by-set/OP17.json'));
  assert.equal(source.cardCount,177);assert.equal(source.cards.length,177);
  assert.equal(source.cards.filter(c=>c.cardType!=='DON').length,169);
  assert.equal(b.CardCatalogRepairs.setCards(source,'OP17').cards.length,177);
  for(const card of manifest.onepieceReprints){
    assert.equal(b.ContainedCardMatch.resolve({...card,brand:'onepiece'},[{id:'1',brand:'onepiece',productNumber:card.setCode+'-'+card.baseNumber,kind:'card'}]).id,null);
    assert.equal(b.CardCatalogRepairs.catalogueRows().find(c=>c.fullId===card.fullId).productId,card.productId);
  }
});
