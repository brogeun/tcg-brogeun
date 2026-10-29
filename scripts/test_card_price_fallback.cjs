const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const api=require('../assets/card-price-fallback.js');
const target={game:'onepiece',language:'ja',fullNumber:'OP17-001',setCode:'OP17',rarity:'L',name:'Edward Newgate',id:'catalog-card-1',snkrdunkId:'123'};
const row={id:'yuyutei:opc:op17:10001',game:'onepiece',language:'ja',grade:'raw',setCode:'OP17',sourceSetCode:'op17',cardNumber:'OP17-001',rarity:'L',name:'Edward Newgate',price:50,currency:'JPY',priceKind:'asking',stockState:'in_stock',sourceAsOf:'2026-10-29T12:45:47Z',sourceUrl:'https://yuyu-tei.jp/sell/opc/card/op17/10001'};
const product={id:'123',brand:'onepiece',kind:'card',language:'ja',productNumber:'OPTCG-OP17-001',name:'Edward Newgate',minPrice:10,currency:'USD',listingCount:2,priceStatus:'available',url:'https://snkrdunk.com/apparels/123',priceCheckedAt:'2026-10-29T12:00:00Z'};
const mercari={id:'mercari:m47783276036',sourceUrl:'https://jp.mercari.com/item/m47783276036',title:'OP17-001',price:{amount:500,currency:'JPY'},observedAt:'2026-10-29T12:00:00Z',saleStatus:'unknown',verification:'unverified',valuationEligible:false,identity:{game:'onepiece',language:null,cardNumbers:['OP17-001'],grade:null,quantity:null,bundle:null}};

test('same Japanese SNKR USD ask stops all fallback requests',async()=>{
 let calls=0;const result=await api.lookup(target,{snkrProduct:product,fetchJson:async()=>{calls++;throw Error('must not load');}});
 assert.equal(result.source,'snkrdunk');assert.equal(result.amount,10);assert.equal(result.currency,'USD');assert.equal(calls,0);
 assert.doesNotMatch(api.render(result),/유유테이|메르카리|market-references/);
});
test('native KRW generic ask stays KRW and condition unspecified',()=>{
 const result=api.resolve(target,{snkrProducts:[{...product,catalogAsk:{amount:14000,currency:'KRW',kind:'lowest_listing_ask'}}],yuyuRows:[row]});
 assert.equal(result.source,'snkrdunk');assert.equal(result.currency,'KRW');assert.equal(result.condition,'unspecified');assert.match(api.render(result),/상태 미지정 상품 호가/);
});
test('explicit same catalog product can retain unknown edition without provider calls',async()=>{
 let calls=0;const unknown={...product,language:'unknown'};
 const t={...target,language:'unknown',catalogSource:'SNKRDUNK',snkrProduct:unknown};
 const result=await api.lookup(t,{fetchJson:async()=>{calls++;throw Error('no fallback');}});
 assert.equal(result.source,'snkrdunk');assert.equal(result.editionVerification,'unconfirmed');assert.equal(calls,0);assert.match(api.render(result),/판본 언어 미확인/);
 assert.equal(api.resolve({...t,catalogSource:null},{snkrProducts:[unknown],yuyuRows:[row]}).status,'none');
 assert.equal(api.resolve({...t,snkrdunkId:null,id:'123'},{snkrProducts:[unknown]}).status,'none');
 assert.equal(api.resolve({...t,snkrdunkId:null,id:'snkrdunk:123'},{snkrProducts:[unknown]}).source,'snkrdunk');
});
test('actual source T01R bracket overrides reused T01 product code and preserves E5',()=>{
 const p={...product,id:'472606',brand:'weiss_schwarz',language:'unknown',name:'Rapi [NIK/S117-T01R]',code:'WS-TCG-NIK/S117-T01',productNumber:'WS-TCG-NIK/S117-T01'};
 const t={game:'weiss_schwarz',language:'unknown',fullNumber:'NIK/S117-T01R',catalogSource:'SNKRDUNK',snkrdunkId:'472606',snkrProduct:p};
 assert.equal(api.resolve(t).source,'snkrdunk');assert.equal(api.resolve({...t,fullNumber:'NIK/S117-T01'}).status,'none');
 const e={...p,name:'Rapi [NIK/S117-001SP E5]'};assert.equal(api.resolve({...t,fullNumber:'NIK/S117-001SP E5',snkrProduct:e}).source,'snkrdunk');
 assert.equal(api.resolve({...t,fullNumber:'NIK/S117-001SP',snkrProduct:e}).status,'none');
});
test('actual source wrappers and hyphenated UA numbers preserve same catalog identity',()=>{
 for(const [game,code,number] of [['union_arena','UATCG-UA50BT-IYS-1-046','UA50BT-IYS-1-046'],['dragon_ball_fusion_world','DBSC-TCG-FB11-020','FB11-020'],['yugioh','YGO-OCG-TCG-YAC1-JP001','YAC1-JP001'],['digimon','DGCG-TCG-EX13-043','EX13-043']]){
  const p={...product,brand:game,language:'unknown',name:'Source product',code,productNumber:code};
  const t={game,language:'unknown',fullNumber:number,catalogSource:'SNKRDUNK',snkrdunkId:'123',snkrProduct:p};assert.equal(api.resolve(t).source,'snkrdunk',game);
 }
});
test('current raw JPY ask wins over catalog and PSA',()=>{
 const result=api.resolve(target,{snkrProducts:[{...product,grades:{raw:{lowest_ask:800,currency:'JPY',availability:'listed'},psa10:{lowest_ask:50000,currency:'JPY'}}}]});
 assert.equal(result.amount,800);assert.equal(result.condition,'raw');
});
test('historical chart and PSA do not replace missing current raw/catalog price',()=>{
 const result=api.resolve(target,{snkrProducts:[{...product,minPrice:null,grades:{psa10:{lowest_ask:50000,currency:'JPY'},raw:{chart_latest_price:900,currency:'JPY'}}}],yuyuRows:[row]});
 assert.equal(result.source,'yuyutei');assert.equal(result.amount,50);
});
test('zero offers invalidate generic SNKR price and allow exact shop fallback',()=>{
 assert.equal(api.resolve(target,{snkrProducts:[{...product,listingCount:0}],yuyuRows:[row]}).source,'yuyutei');
});
test('wrong game, foreign edition, full-number conflict cannot provide SNKR price',()=>{
 for(const changed of [{brand:'digimon'},{language:'en'},{productNumber:'OPTCG-OP02-120'}])assert.equal(api.resolve(target,{snkrProducts:[{...product,...changed}],yuyuRows:[row]}).source,'yuyutei');
});
test('official numeric IDs are never treated as resolved SNKR product IDs',()=>{
 const t={game:'pokemon',language:'ja',fullNumber:'001/165',setCode:'SV2A',rarity:'C',id:'123'};
 assert.equal(api.resolve(t,{snkrProducts:[{...product,brand:'pokemon',name:'Different card',productNumber:'pkmn-tcg-SV2A-099'}]}).status,'none');
 assert.equal(api.resolve({...t,snkrdunkId:'123'},{snkrProducts:[{...product,brand:'pokemon',name:'Different card [SV2A 099/165]'}]}).status,'none');
});
test('wrong target language or grade never loads fallback',async()=>{
 for(const changed of [{language:'en'},{grade:'PSA10'}]){let calls=0;assert.equal((await api.lookup({...target,...changed},{fetchJson:async()=>{calls++;}})).status,'none');assert.equal(calls,0);}
});
test('same-number parallel is separated by rarity and artwork ambiguity',()=>{
 const parallel={...row,id:'parallel',rarity:'P-L',name:'Edward Newgate(パラレル)',price:980};
 assert.equal(api.resolve(target,{yuyuRows:[row,parallel]}).amount,50);
 assert.equal(api.resolve({...target,rarity:'P-L',variant:'Parallel'},{yuyuRows:[row,parallel]}).amount,980);
 assert.equal(api.resolve({...target,rarity:'L',fullId:'OP17-001_p1'},{yuyuRows:[row]}).status,'none');
 assert.equal(api.resolve({...target,rarity:null},{yuyuRows:[row]}).status,'none');
});
test('multiple identical number/rarity editions are ambiguous, no cheapest selection',()=>{
 assert.equal(api.resolve(target,{yuyuRows:[row,{...row,id:'reprint',price:20}]}).status,'none');
});
test('exact source binding resolves artwork but cannot contradict rarity',()=>{
 const t={...target,fullId:'OP17-001_p1'},bindings={[api.targetKey(t)]:{yuyuteiId:row.id,language:'ja',rarity:'L'}};
 assert.equal(api.resolve(t,{yuyuRows:[row],bindings}).source,'yuyutei');
 assert.equal(api.resolve(t,{yuyuRows:[{...row,rarity:'P-L'}],bindings}).status,'none');
});
test('Weiss and Union Arena slashes and complete card numbers survive',()=>{
 const t={game:'union_arena',language:'ja',fullNumber:'UA18BT/NIK-1-019',setCode:'UA18BT',rarity:'SR',name:'Modernia'};
 const base={...row,game:'union_arena',cardNumber:t.fullNumber,setCode:t.setCode,rarity:'SR',name:'Modernia',price:320};
 assert.equal(api.fullNumber(t),'UA18BT/NIK-1-019');assert.equal(api.resolve(t,{yuyuRows:[base,{...base,id:'p',rarity:'SR★★',name:'Modernia(パラレル)',price:39800}]}).amount,320);
 assert.equal(api.fullNumber({fullNumber:'NIK/S117-001SP'}),'NIK/S117-001SP');
});
test('Pokemon printed fraction requires the same printed set',()=>{
 const t={game:'pokemon',language:'ja',setCode:'SV9A',fullNumber:'001/063',rarity:'C'};
 assert.equal(api.resolve(t,{yuyuRows:[{...row,game:'pokemon',setCode:'SV9A',cardNumber:'001/063',rarity:'C',name:'Pokémon'}]}).source,'yuyutei');
 assert.equal(api.resolve(t,{yuyuRows:[{...row,game:'pokemon',setCode:'SV9',cardNumber:'001/063',rarity:'C'}]}).status,'none');
});
test('only proven Pokemon M-series zero-padding and full UA namespace formats alias',()=>{
 const t={game:'pokemon',language:'ja',setCode:'M6A',fullNumber:'001/103',rarity:'C'};
 const r={...row,game:'pokemon',setCode:'M06A',cardNumber:'001/103',rarity:'C',name:'Japanese card'};
 assert.equal(api.resolve(t,{yuyuRows:[r]}).source,'yuyutei');
 assert.equal(api.resolve({...t,fullNumber:'001/150'},{yuyuRows:[r]}).status,'none');
 assert.equal(api.resolve({...t,setCode:'M6B'},{yuyuRows:[r]}).status,'none');
 assert.equal(api.resolve({...t,setCode:''},{yuyuRows:[r]}).status,'none');
 const ua={game:'union_arena',language:'ja',setCode:'UA18BT/NIK-1',fullNumber:'UA18BT/NIK-1-019',rarity:'SR',name:'Modernia'};
 assert.equal(api.resolve(ua,{yuyuRows:[{...row,game:'union_arena',setCode:'UA18BT',cardNumber:ua.fullNumber,rarity:'SR',name:'Modernia'}]}).source,'yuyutei');
});
test('Mercari unknown proof is a reference candidate, never a valuation',()=>{
 const r=api.resolve(target,{mercariReferences:[mercari]});assert.equal(r.status,'candidate');assert.equal(r.amount,500);assert.equal(r.saleStatus,'unknown');assert.equal(r.valuationEligible,false);assert.match(api.render(r),/판매상태 미확인/);
});
test('Mercari wrong card, game, foreign, grade and lots are rejected',()=>{
 for(const changed of [{cardNumbers:['OP02-120']},{game:'digimon'},{language:'en'},{grade:'PSA10'},{quantity:4},{bundle:true}])assert.equal(api.resolve(target,{mercariReferences:[{...mercari,identity:{...mercari.identity,...changed}}]}).status,'none');
 assert.equal(api.resolve(target,{mercariReferences:[{...mercari,title:'OP17-001 4枚セット'}]}).status,'none');
 for(const title of ['OP17-001 PSA10','OP17-001 ENGLISH 2ND ANNIVERSARY','OP17-001 英語版'])assert.equal(api.resolve(target,{mercariReferences:[{...mercari,title}]}).status,'none');
});
test('Yuyu is lazy, compact decoded once, and prevents Mercari loading',async()=>{
 const calls=[];const data={source:'yuyutei',game:'onepiece',language:'ja',sourceGame:'opc',currency:'JPY',priceKind:'asking',columns:Object.keys(row),rows:[Object.values(row)]};
 const result=await api.lookup(target,{fetchJson:async p=>{calls.push(p);return data;}});assert.equal(result.source,'yuyutei');assert.deepEqual(calls,['/data/yuyutei-market/onepiece.json']);
});
test('late async result cannot overwrite reused card DOM',async()=>{
 let finish;const pending=new Promise(resolve=>finish=resolve),element={isConnected:true,innerHTML:''};
 const old=api.decorate(element,target,{fetchJson:async()=>pending});
 await api.decorate(element,target,{snkrProduct:product});const shown=element.innerHTML;
 finish({source:'yuyutei',game:'onepiece',records:[row]});await old;assert.equal(element.innerHTML,shown);
});
test('source URLs and titles are escaped; no generic source buttons',()=>{
 const result=api.resolve(target,{mercariReferences:[{...mercari,title:'<img onerror=alert(1)>'}]});
 assert.doesNotMatch(api.render(result),/<img|market-references|javascript:/);assert.doesNotMatch(api.render({...result,sourceUrl:'javascript:alert(1)'}),/href=/);
});
test('actual compact fixture proves base and parallel prices remain separate',()=>{
 const file=path.join(__dirname,'../data/yuyutei-market/union_arena.json');if(!fs.existsSync(file))return;
 const rows=api.decodeYuyu(JSON.parse(fs.readFileSync(file,'utf8'))),base=rows.find(r=>r.cardNumber==='UA18BT/NIK-1-019'&&r.rarity==='SR');
 assert.ok(base,'checked original product fixture is present');
 const t={game:'union_arena',language:'ja',fullNumber:base.cardNumber,setCode:base.setCode,rarity:'SR',name:'Modernia'};
 assert.equal(api.resolve(t,{yuyuRows:rows}).amount,320);
 const parallel=api.resolve({...t,rarity:'SR★★',variant:'Parallel'},{yuyuRows:rows});assert.equal(parallel.amount,39800);
});
test('only the three documented rarity ontology labels map to their exact codes',()=>{
 for(const [label,code] of [['Double Rare (RR)','RR'],['Art Rare (AR)','AR'],['Special Art Rare (SAR)','SAR']]){
  const t={game:'pokemon',language:'ja',setCode:'M6A',fullNumber:'009/103',rarity:label};
  const r={...row,game:'pokemon',setCode:'M06A',cardNumber:'009/103',rarity:code,name:'Japanese card'};
  assert.equal(api.resolve(t,{yuyuRows:[r]}).source,'yuyutei');
  assert.equal(api.resolve({...t,fullId:'009/103_p1'},{yuyuRows:[r]}).status,'none');
  assert.equal(api.resolve({...t,rarity:'-'},{yuyuRows:[r]}).status,'none');
  assert.equal(api.resolve({...t,rarity:undefined},{yuyuRows:[r]}).status,'none');
  assert.equal(api.resolve({...t,rarity:'Unknown Rare ('+code+')'},{yuyuRows:[r]}).status,'none');
 }
});
test('actual M6a 009/103 official card falls back to the exact RR shop row at JPY80',()=>{
 const file=path.join(__dirname,'../data/yuyutei-market/pokemon.json');
 const rows=api.decodeYuyu(JSON.parse(fs.readFileSync(file,'utf8')));
 const actual=rows.find(r=>r.sourceSetCode==='m06a'&&r.sourceProductId==='10009');
 assert.ok(actual,'original Yuyu observed product is present');assert.equal(actual.cardNumber,'009/103');assert.equal(actual.rarity,'RR');assert.equal(actual.price,80);
 const official={id:'89745',game:'pokemon',language:'ja',setCode:'M6a',fullNumber:'009/103',rarity:'Double Rare (RR)',name:'Fuecoco ex'};
 const result=api.resolve(official,{yuyuRows:rows});
 assert.equal(result.status,'priced');assert.equal(result.source,'yuyutei');assert.equal(result.amount,80);assert.equal(result.currency,'JPY');assert.equal(result.priceKind,'shop_asking');assert.equal(result.stockState,actual.stockState);assert.equal(result.observedAt,actual.sourceAsOf);assert.equal(result.sourceUrl,'https://yuyu-tei.jp/sell/poc/card/m06a/10009');
 assert.equal(api.resolve({...official,variant:'Master Ball'},{yuyuRows:rows}).status,'none');
});

test('an explicitly owned source product with unconfirmed printed number keeps its own current ask',async()=>{
  const api=require('../assets/card-price-fallback.js');let requests=0;
  const product={id:'871339',brand:'dragon_ball_fusion_world',kind:'card',language:'unknown',name:'Source card with unconfirmed printed number',url:'https://snkrdunk.com/apparels/871339',minPrice:2,currency:'USD',listingCount:3,priceStatus:'available',catalogAsk:{amount:2700,currency:'KRW',kind:'lowest_listing_ask',condition:'unspecified'}};
  const target={id:'871339',game:'dragon_ball_fusion_world',language:'unknown',grade:'raw',catalogSource:'SNKRDUNK',snkrdunkId:'871339',snkrProduct:product,fullCardNumber:''};
  const result=await api.lookup(target,{fetchJson:async()=>{requests++;throw Error('Fallback must not be loaded');}});
  assert.equal(result.source,'snkrdunk');assert.equal(result.amount,2700);assert.equal(result.currency,'KRW');assert.equal(result.editionVerification,'unconfirmed');assert.equal(requests,0);
});
