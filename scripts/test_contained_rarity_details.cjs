'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const R=require('../assets/card-rarity-filters.js');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sourceCard={name:'Reviewed Card',number:'001/100',rarity:'',rarityOriginal:'—',raritySourceUnlisted:true,
  rarityReferenceValue:'Common',rarityReferenceDisagreement:true,
  rarityEvidence:{schemaVersion:1,kind:'external-explicit',exactCardIdentity:true,value:'Common',
    references:[{provider:'TCGdex',literal:'Common',url:'https://github.com/tcgdex/cards-database/blob/review/card.ts'}],
    otherReferences:[{provider:'Other DB',literal:'None',url:'https://example.test/reviewed-card'}]}};
function between(start,end){const a=html.indexOf(start),b=html.indexOf(end,a);assert(a>=0&&b>a);return html.slice(a,b);}
function gridIdentity(card){
  const mark='data-card-identity="${escapeHtml(JSON.stringify(';
  const start=html.indexOf(mark)+mark.length,end=html.indexOf('))}"',start);
  assert(start>=mark.length&&end>start);
  return JSON.parse(JSON.stringify(vm.runInNewContext('('+html.slice(start,end)+')',{
    c:card,cardBrand:'pokemon',setCode:'TEST',cardSetCode:'TEST',
  })));
}

test('real grid identities preserve external grade, explicit None, conflicts and provenance without inventing a source grade',()=>{
  for(const card of [sourceCard,{...sourceCard,rarityReferenceValue:undefined,rarityReferenceUnlisted:true},
    {...sourceCard,rarityReferenceValue:undefined,rarityReferenceConflict:true}]){
    const identity=gridIdentity(card);
    assert.equal(identity.rarity,'');assert.equal(identity.number,card.number);
    assert.deepEqual(R.metadata(identity),R.metadata(card));
    assert.equal(R.evidenceHtml(identity),R.evidenceHtml(card));
    assert.deepEqual(identity.rarityEvidence,card.rarityEvidence);
  }
});

async function clickCard(identity,priced){
  let listener,modalHTML='',slideArgs;
  const origin={},modal={classList:{contains:()=>true}};
  const item={isConnected:true,dataset:{cardIdentity:JSON.stringify(identity),cardName:identity.name},querySelector:()=>({currentSrc:'/selected-printing.webp'})};
  const target={fullNumber:identity.number,snkrdunkId:'900001'};
  const price=priced?{status:'priced',source:'snkrdunk',amount:100,currency:'JPY'}:{status:'unknown'};
  const ctx=vm.createContext({CI_PANEL_REQUEST:1,_LAST_OPENED_SET:null,escapeHtml:esc,
    document:{addEventListener:(type,fn)=>{listener=fn;},getElementById:id=>id==='anyModal'?modal:origin},
    window:{CardRarityFilters:R,ContainedCardPrices:{prepareTarget:async()=>target},CardPriceFallback:{resolve:()=>price,lookup:async()=>price,render:()=>'<span>price unchanged</span>'}},
    closeAnyModal(){},openAnyModal:value=>{modalHTML=value;},openSlidePanel:(...args)=>{slideArgs=args;},
  });
  vm.runInContext(between('let CI_CARD_DETAIL_REQUEST = 0;','// 박스로 돌아가기'),ctx);
  await listener({target:{closest:selector=>selector==='.set-card-item[data-card-search]'?item:null}});
  return {modalHTML,slideArgs};
}

test('real unpriced-card click displays external reference grade and source, preserving the original blank',async()=>{
  const identity=gridIdentity(sourceCard),result=await clickCard(identity,false);
  assert.match(result.modalHTML,/Common · 참고/);
  assert.match(result.modalHTML,/TCGdex: Common/);assert.match(result.modalHTML,/Other DB: None/);
  assert.match(result.modalHTML,/제조사 확정과 구분/);assert.match(result.modalHTML,/selected-printing.webp/);
  assert.equal(identity.rarity,'');assert.equal(result.slideArgs,undefined);
  const none=await clickCard(gridIdentity({...sourceCard,rarityReferenceValue:undefined,rarityReferenceUnlisted:true}),false);
  assert.match(none.modalHTML,/미표기 분류 · 외부 DB/);
  const conflict=await clickCard(gridIdentity({...sourceCard,rarityReferenceValue:undefined,rarityReferenceConflict:true}),false);
  assert.match(conflict.modalHTML,/자료 간 등급 차이/);
});

test('real priced-card click forwards the selected printing rarity and evidence to the price panel',async()=>{
  const identity=gridIdentity(sourceCard),result=await clickCard(identity,true);
  assert.equal(result.modalHTML,'');assert.equal(result.slideArgs[0],'900001');
  assert.equal(result.slideArgs[1],'/selected-printing.webp');
  assert.deepEqual(JSON.parse(JSON.stringify(result.slideArgs[2])),identity);
});

test('real price panel renders selected rarity provenance without changing quote or leaking it to unrelated products',async()=>{
  const stopped=Error('body rendered');let bodyHTML='';
  const body={set innerHTML(value){bodyHTML=value;throw stopped;}};
  const nodes=new Map();
  const product={id:'900001',brand:'pokemon',name:'Market Card [TEST 001/100]',image:'/market.webp',minPrice:100,currency:'JPY',reviewedPrice:true,grades:{raw:{lowest_ask:100,currency:'JPY'}}};
  const ctx=vm.createContext({console,FX_READY:Promise.resolve(),SLIDE_PANEL_REQUEST:1,CURRENT_SLIDE_ID:product.id,
    HOME_TOP_CACHE:{pokemon:[product]},PRICE_CACHE:{},PRICE_CAT:'card',SLIDE_RETURN_SET:null,JPY_KRW:10,
    document:{getElementById:id=>{if(id==='slideBody')return body;if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);}},
    fetch:async()=>({ok:false}),loadCardsDetail:async()=>({cards:{[product.id]:{grades:{raw:{lowest_ask:100,currency:'JPY'}}}}}),isCardProduct:()=>true,
    enrichPriceProductMetadata:async()=>{},escapeHtml:esc,window:{CardRarityFilters:R},
    HomeMarket:{quote:()=>null},
  });
  const render=between('async function renderSlidePanel(','function _krw(');
  vm.runInContext(render,ctx);
  await assert.rejects(()=>ctx.renderSlidePanel(product.id,1,'/selected-printing.webp',gridIdentity(sourceCard)),error=>error===stopped);
  assert.match(bodyHTML,/<td>희귀도<\/td><td>Common · 참고<\/td>/);
  assert.match(bodyHTML,/TCGdex: Common/);assert.match(bodyHTML,/Other DB: None/);
  assert.match(bodyHTML,/₩1,000/,'the original market quote stays unchanged');
  assert.match(nodes.get('slideCardImg').innerHTML,/selected-printing.webp/);
  await assert.rejects(()=>ctx.renderSlidePanel(product.id,1),error=>error===stopped);
  assert.doesNotMatch(bodyHTML,/TCGdex|Common · 참고|<td>희귀도<\/td>/,'ordinary market opens have no stale catalogue rarity');
});
