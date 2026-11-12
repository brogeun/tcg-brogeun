'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const test=require('node:test');
const match=require('../assets/contained-card-match.js');
const bridge=require('../assets/contained-card-prices.js');
const fallback=require('../assets/card-price-fallback.js');
const read=name=>JSON.parse(fs.readFileSync('data/'+name+'.json','utf8'));
const registry=read('contained-printing-reviews');
const products=read('all-cards').details;
const unavailable={ok:false};
function card(set,number){
  const source=read('cards-by-set/'+set).cards.find(row=>(row.fullId||row.number)===number);
  assert(source,set+' '+number);
  return {...source,brand:set.startsWith('OP')?'onepiece':'pokemon',language:'ja',boxCode:set,setCode:source.setCode||set,bundle:!!source.isBundle};
}
const sourceServices=loadLiveQuote=>({match,fallback,loadProducts:async()=>products,
  loadArtworkBindings:async()=>registry,loadOverrides:async()=>({}),loadDetails:async()=>({cards:{}}),loadLiveQuote,
  fallbackOptions:{yuyuRows:[],bindings:{},mercariReferences:[]}});
function grade(id,amount){
  return {ok:true,id:String(id),fetchedAt:new Date().toISOString(),grades:amount?{raw:{lowest_ask:amount,currency:'JPY'}}:{},noListingGrades:amount?[]:['raw']};
}
test('each reviewed single selects its exact SKU, live raw grade and source URL',async()=>{
  for(const proof of registry.links){
    const target=await bridge.prepareTarget(card(proof.boxCode,proof.fullId||proof.number),{services:sourceServices(async id=>{
      assert.equal(id,proof.id);
      return grade(id,7603);
    })});
    const price=fallback.resolve(target);
    assert.equal(target.snkrdunkId,proof.id);
    assert.equal(price.amount,7603);
    assert.equal(price.sourceUrl,'https://snkrdunk.com/apparels/'+proof.id);
    assert.equal(price.condition,'raw');
  }
});
test('no raw listing permits the matching shop while a failed primary request stays unknown',async()=>{
  const input=card('OP05','OP05-118');
  const shop=fallback.decodeYuyu(read('yuyutei-market/onepiece')).filter(row=>row.cardNumber==='OP05-118');
  const options={bindings:read('onepiece-reviewed-fallback-links').bindings,yuyuRows:shop,mercariReferences:[]};
  const noRaw=await bridge.prepareTarget(input,{services:sourceServices(async id=>grade(id,null))});
  let redundant=0;
  const out=await fallback.lookup(noRaw,{...options,loadSnkrQuote:async()=>{redundant++;return unavailable;}});
  assert.equal(redundant,0);
  assert.notEqual(out.source,'snkrdunk');
  const failed=await bridge.prepareTarget(input,{services:sourceServices(async()=>unavailable)});
  assert.equal((await fallback.lookup(failed,options)).status,'unknown');
});
test('first edition and unspecified printing keep separate quotes',async()=>{
  for(const proof of registry.variants){
    const target=await bridge.prepareTarget(card(proof.boxCode,proof.fullId||proof.number),{services:sourceServices(async id=>grade(id,Number(id)))});
    const out=fallback.resolve(target);
    assert.equal(out.status,'variants');
    assert.equal(target.snkrdunkId,undefined);
    assert.deepEqual(out.variants.map(v=>[v.id,v.label,v.quote.amount]),proof.versions.map(v=>[v.id,v.label,Number(v.id)]));
  }
});
test('LEGEND halves never receive the other half or the set quote as their own price',async()=>{
  const samples=[
    ['L1-Bhg','015/070',[],['93186','93187']],
    ['L1-Bss','030/070',['335043'],['93184','93185']],
    ['L3','072/080',['863573','863574'],['93173','93175']],
    ['L3','071/080',['708188','708191'],['93171','93176']],
    ['M6a','151/103',['892649'],['892669']],
    ['M6a','152/103',['892650'],['892669']],
    ['M6a','151-152/103',[],['892669']]
  ];
  for(const [set,number,singles,sets] of samples){
    const target=await bridge.prepareTarget(card(set,number),{services:sourceServices(async id=>grade(id,Number(id)))});
    const out=await fallback.lookup(target);
    assert.equal(out.status,'legend-offers');
    assert.equal(out.valuationEligible,false);
    assert.equal(out.amount,null);
    assert.deepEqual(out.offers.filter(o=>o.kind==='single').map(o=>o.id).sort(),singles.sort());
    assert.deepEqual(out.offers.filter(o=>o.kind==='set').map(o=>o.id).sort(),sets.sort());
    for(const offer of out.offers)assert.equal(offer.quote.amount,Number(offer.id));
    assert.match(fallback.render(out,{convert:a=>a}),/두 장 세트 가격/);
  }
});
