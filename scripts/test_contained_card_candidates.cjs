'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const bridge=require('../assets/contained-card-prices.js'),match=require('../assets/contained-card-match.js');
const candidates=require('../assets/contained-card-candidates.js');
const target={brand:'pokemon',language:'ja',boxCode:'ADV1',setCode:'ADV1',number:'001/055',
 name:'Koffing (ADV Expansion Pack 001/055)',sourceUrl:'https://www.tcgcollector.com/cards/28745/koffing-adv-expansion-pack-001-055'};
const make=(id,name='Koffing [ADV1 001/055]')=>({id:String(id),brand:'pokemon',kind:'card',language:'ja',name,
 productNumber:'pkmn-tcg-ADV1-001',thumbnailUrl:`https://cdn.snkrdunk.com/upload_bg_removed/${id}.webp?size=m`,minPrice:987654321,currency:'USD',grades:{raw:{lowest_ask:888888}}});
const services=products=>({match,loadProducts:async()=>products,loadArtworkBindings:async()=>({schemaVersion:1,links:[]}),
 loadDetails:async()=>{throw Error('Unconfirmed candidates must not load prices');},loadLiveQuote:async()=>{throw Error('No eager live quote');}});

test('ambiguous editions expose separate safe products without assigning a printed-card price',async()=>{
 const products=[make(431719,'Koffing :1ED [ADV1 001/055]'),make(431720),make(9,'Koffing [ADV1 001/055]')];
 products[2].language='en';products.push({...make(10),brand:'onepiece'},{...make(11),kind:'box'});
 const prepared=await bridge.prepareTarget(target,{services:services(products)});
 assert.equal(prepared.snkrdunkStatus,'ambiguous');assert.equal(prepared.snkrdunkId,undefined);assert.equal(prepared.snkrProduct,undefined);
 assert.deepEqual(prepared.marketCandidates.map(product=>product.id),['431719','431720']);
 for(const product of prepared.marketCandidates)assert.deepEqual(Object.keys(product).sort(),['id','name','productNumber','thumbnailUrl']);
 const html=candidates.render(prepared);assert.match(html,/판본 확인이 필요한 상품 2개/);assert.match(html,/data-contained-market-id="431719"/);
 assert.match(html,/data-contained-market-id="431720"/);assert.match(html,/1ED/);assert.match(html,/판본 표기 없음/);
 assert.doesNotMatch(html,/987654321|888888|USD|₩|onclick=/);
});

test('unlinked candidates are computed once, capped and never carry quotes or unsafe images',async()=>{
 let calls=0;const products=Array.from({length:16},(_,i)=>make(100+i));products[0].thumbnailUrl='https://user:password@cdn.snkrdunk.com/credential.webp';
 const resolve=()=>({status:'unlinked',id:null});resolve.candidates=()=>{calls++;return [...products,products[2]];};
 const custom={...match,createResolver:()=>resolve};
 const prepared=await bridge.prepareTarget({...target,marketCandidates:[{id:'bad',minPrice:123}]},{services:{...services(products),match:custom}});
 assert.equal(calls,1);assert.equal(prepared.snkrdunkStatus,'artwork-pending');assert.equal(prepared.marketCandidates.length,12);
 assert.equal(prepared.marketCandidates[0].thumbnailUrl,'');assert(!('minPrice' in prepared.marketCandidates[1]));
});

test('render escapes source text and rechecks numeric IDs, URL hosts, credentials and status',()=>{
 const hostile={...target,snkrdunkStatus:'artwork-pending',marketCandidates:[
  {id:'77',name:'<script>alert("quoted")</script>',productNumber:'X',thumbnailUrl:'javascript:alert(1)'},
  {id:'bad" onclick="alert(1)',name:'bad',thumbnailUrl:'https://cdn.snkrdunk.com/no.webp'},
  {id:'78',name:'Second',thumbnailUrl:'https://cdn.snkrdunk.com.evil.test/no.webp'},
  {id:'79',name:'Third',thumbnailUrl:'https://user:secret@cdn.snkrdunk.com/no.webp'}]};
 const html=candidates.render(hostile);assert.match(html,/&lt;script&gt;alert\(&quot;quoted&quot;\)&lt;\/script&gt;/);
 assert.doesNotMatch(html,/<script>|javascript:|evil\.test|user:secret|onclick=/);assert.match(html,/data-contained-market-id="77"/);
 assert.match(html,/原本|원본 카드 보기/);assert.match(html,/rel="noopener noreferrer"/);
 for(const status of ['matched','verified-link','conflict','unknown'])assert.doesNotMatch(candidates.render({...hostile,snkrdunkStatus:status}),/data-contained-market-id/);
 assert.equal(candidates.render({...hostile,language:'en'}),'');
 assert.equal(candidates.render({...target,snkrdunkStatus:'unlinked',sourceUrl:'https://tcgcollector.com.evil.test/card/1'}),'');
});

test('source-only cards keep an exact source link without a candidate section',()=>{
 const html=candidates.render({...target,snkrdunkStatus:'unlinked',marketCandidates:[]});
 assert.match(html,/원본 카드 보기/);assert.doesNotMatch(html,/판본 확인이 필요한 상품|상품 시세 보기/);
});

test('old expansion title Champion of the Sky is not a prize or limited printing',()=>{
 const own={...target,setCode:'ADV3',boxCode:'ADV3',number:'001/054',name:'Grimer (Rulers of the Heavens 001/054)'};
 const plain={...make(432419),name:'Grimer [ADV3 001/054](Expansion Pack Vol.3 "Champion of the Sky")',productNumber:'pkmn-tcg-ADV3-001'};
 assert.deepEqual(match.resolve(own,[plain]),{status:'matched',id:'432419'});
 const first={...plain,id:'432418',name:'Grimer :1ED [ADV3 001/054](Expansion Pack Vol.3 "Champion of the Sky")'};
 assert.equal(match.resolve(own,[plain,first]).status,'ambiguous');
 assert.equal(match.resolve(own,[first]).status,'artwork-pending');
 for(const name of ['Grimer Winner [ADV3 001/054](Expansion Pack Vol.3 "Champion of the Sky")',
  'Grimer Parallel [ADV3 001/054](Expansion Pack Vol.3 "Champion of the Sky")',
  'Grimer [ADV3 001/054](Expansion Pack Vol.3 "Champion of the Sky" Tournament Prize)',
  'Grimer [ADV3 001/054](Premium Card Collection Champion Prize)']){
  assert.notEqual(match.resolve(own,[{...plain,name}]).status,'matched',name);
 }
});
