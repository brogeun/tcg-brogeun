const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const manifest=JSON.parse(read('data/card-catalog-repairs.json'));
function fixture(){
  const requests=[];
  const b={console,URL,URLSearchParams,AbortSignal,Date,Map,Set,WeakMap,fetch:async url=>{
    const id=new URL(url,'https://tcghub.kr').searchParams.get('id');requests.push(id);
    const index=manifest.onepieceReprints.findIndex(c=>c.productId===id);
    assert(index>=0,'Only the exact reviewed Japanese product may be requested');
    return {ok:true,json:async()=>({ok:true,id,fetchedAt:new Date().toISOString(),grades:{raw:{lowest_ask:10000+index,currency:'JPY',active_count:2}}})};
  }};b.window=b;vm.createContext(b);
  for(const name of ['card-catalog-repairs','contained-card-match','contained-card-prices','card-price-fallback'])vm.runInContext(read('assets/'+name+'.js'),b);
  b.CardCatalogRepairs.configure(manifest);
  return {b,requests,products:b.CardCatalogRepairs.products([])};
}
test('all 11 image-reviewed reprints link to their own Japanese product and current JPY raw ask',async()=>{
  const {b,requests,products}=fixture();
  assert.equal(manifest.onepieceReprints.length,11);
  const services={loadProducts:async()=>products,loadDetails:async()=>({cards:{}}),loadOverrides:async()=>({})};
  for(const [index,card] of manifest.onepieceReprints.entries()){
    const identity={...card,brand:'onepiece',language:'ja'};
    const target=await b.ContainedCardPrices.prepareTarget(identity,{services});
    assert.equal(target.snkrdunkId,card.productId,card.fullId);
    assert.equal(target.snkrdunkStatus,'matched');
    const price=b.CardPriceFallback.resolve(target);
    assert.equal(price.status,'priced',card.fullId);assert.equal(price.amount,10000+index);assert.equal(price.currency,'JPY');
    const detail=await b.CardCatalogRepairs.quoteProduct({id:card.productId,brand:'onepiece',currency:'USD',lastPrice:17});
    assert.equal(detail.lastPrice,price.amount);assert.equal(detail.reviewedPrice,true);assert.equal(detail.cardType,undefined);
    assert.equal(detail.fullId,card.fullId);assert.equal(detail.boxCode,'OP17');
    assert.equal(b.CardCatalogRepairs.catalogueRows().find(c=>c.fullId===card.fullId).productId,card.productId);
  }
  assert.equal(requests.length,11,'Each ID is fetched once across grid and detail');
});
test('bindings reject original editions, English metadata, another set/artwork and stale override guesses',()=>{
  const {b,products}=fixture();
  for(const card of manifest.onepieceReprints){
    const row=products.find(p=>p.id===card.productId),target={...card,brand:'onepiece',language:'ja'};
    const bound=(t,p)=>Object.keys(b.CardCatalogRepairs.verifiedLinks([t],[p])).length;
    assert.equal(bound(target,row),1);
    for(const changed of [{...row,id:'880000'},{...row,language:'en'},{...row,name:row.name+'[EN]'},
      {...row,name:'Original edition '+row.name},{...row,productNumber:'OP17-001'},
      {...row,fullId:row.fullId+'_wrong'},{...row,boxCode:'EB04'},{...row,kind:'box'}])assert.equal(bound(target,changed),0);
    for(const changed of [{...target,boxCode:card.setCode},{...target,fullId:card.setCode+'-'+card.baseNumber},
      {...target,language:'en'},{...target,image:'/images/wrong.png'}])assert.equal(bound(changed,row),0);
    assert.equal(Object.keys(b.ContainedCardPrices.reviewedLinks([target],[row],{[card.fullId.toUpperCase()]:card.productId},b.ContainedCardMatch)).length,0);
  }
});
