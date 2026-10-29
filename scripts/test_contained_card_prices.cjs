const test=require('node:test'),assert=require('node:assert/strict');
const bridge=require('../assets/contained-card-prices.js'),match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js');
const pokemon={brand:'pokemon',language:'ja',boxCode:'SV2A',setCode:'SV2A',number:'001/165_art',fullId:'001/165_art',rarity:'C',name:'Bulbasaur'};
const op={brand:'onepiece',language:'ja',boxCode:'OP17',setCode:'OP17',number:'001',fullId:'OP17-001',rarity:'L',name:'Newgate'};
function fixture(identities){const hosts=identities.map(identity=>({isConnected:true,innerHTML:'',closest:()=>({dataset:{cardIdentity:JSON.stringify(identity)}})}));return {hosts,container:{querySelectorAll:()=>hosts}};}
const product={id:'123',brand:'onepiece',name:'Newgate L[OPTCG-OP17-001]',kind:'card',productNumber:'OPTCG-OP17-001',currency:'USD',minPrice:10,listingCount:2,url:'https://snkrdunk.com/apparels/123'};
function services(extra={}){return {match,fallback,loadProducts:async()=>[product],loadDetails:async()=>({cards:{}}),loadOverrides:async()=>({}),...extra};}
test('target preserves Pokemon fraction and OP actual reprint code/variant',()=>{
 assert.equal(bridge.targetFor(pokemon).fullNumber,'001/165');
 const t=bridge.targetFor({...op,boxCode:'PRB01',fullId:'OP17-001_p2',variant:'p2'});assert.equal(t.fullNumber,'OP17-001');assert.equal(t.setCode,'OP17');assert.equal(t.boxCode,'PRB01');assert.equal(t.variant,'p2');
});
test('official numeric ID is never an implicit SNKR link',()=>{assert.equal(bridge.targetFor({...pokemon,id:'123',snkrdunkId:'123'}).snkrdunkId,undefined);});
test('strict resolver for Pokemon and OP sees full official identity',async()=>{
 const {hosts,container}=fixture([pokemon,op]),seen=[];
 const s=services({match:{sameIdentity:()=>true,createResolver:()=>t=>{seen.push(t);return {status:'unlinked'};}},fallback:{lookup:async()=>({status:'none'}),render:()=>'-'}});
 await bridge.hydrate(container,{services:s});assert.equal(seen.length,2);assert.equal(seen[0].brand,'pokemon');assert.equal(seen[1].fullId,'OP17-001');assert.deepEqual(hosts.map(h=>h.innerHTML),['-','-']);
});
test('matched raw detail price prevents any provider fetch and keeps per-card time',async()=>{
 const {hosts,container}=fixture([op]);let providers=0;
 const s=services({loadDetails:async()=>({fetchedAt:'2099-01-01',cards:{123:{fetchedAt:'2026-10-28T01:00:00Z',grades:{raw:{lowest_ask:800,currency:'JPY',active_count:2},psa10:{lowest_ask:90000,currency:'JPY'}}}}}),fallback:{...fallback,lookup:(t,o)=>fallback.lookup(t,{...o,fetchJson:async()=>{providers++;throw Error('must not fetch');}})}});
 const [r]=await bridge.hydrate(container,{services:s});assert.equal(r.source,'snkrdunk');assert.equal(r.amount,800);assert.equal(r.observedAt,'2026-10-28T01:00:00Z');assert.equal(providers,0);assert.match(hosts[0].innerHTML,/800/);assert.doesNotMatch(hosts[0].innerHTML,/90000|2099/);
});
test('same number p1 does not inherit plain price or old heuristic priority',async()=>{
 const {container}=fixture([{...op,fullId:'OP17-001_p1',variant:'p1'}]);const received=[];
 await bridge.hydrate(container,{services:services({fallback:{lookup:async t=>{received.push(t);return {status:'none'};},render:()=>'-'}})});
 assert.equal(received[0].snkrdunkId,undefined);
});
test('reviewed override needs exact full key and strict sameIdentity',async()=>{
 const t={...op,fullId:'OP17-001_p1',variant:'p1'};
 const links=bridge.reviewedLinks([t],[product],{'OP17-001_P1':'123'},match);assert.equal(links['onepiece:OP17:OP17-001_P1'].id,'123');
 assert.deepEqual(bridge.reviewedLinks([t],[product],{'OP17-001_P2':'123'},match),{});
 assert.deepEqual(bridge.reviewedLinks([t],[{...product,productNumber:'OPTCG-OP02-120'}],{'OP17-001_P1':'123'},match),{});
});
test('unknown unprinted/bundled targets never request fallback providers',async()=>{
 const {container}=fixture([{...pokemon,unprintedNumber:true},{...op,bundle:true}]);let lookups=0;
 await bridge.hydrate(container,{services:services({fallback:{...fallback,lookup:async()=>{lookups++;}}})});assert.equal(lookups,0);
});
test('foreign grids are not decorated',async()=>{const {hosts,container}=fixture([{...pokemon,language:'en'},{...op,brand:'chiikawa'}]);let loads=0;await bridge.hydrate(container,{services:services({loadProducts:async()=>{loads++;return [];}})});assert.equal(loads,0);assert.ok(hosts.every(h=>h.innerHTML===''));});
test('closed/page-switched modal rejects late products result',async()=>{
 const {hosts,container}=fixture([op]);let finish,current=true;const wait=new Promise(r=>finish=r);
 const promise=bridge.hydrate(container,{isCurrent:()=>current,services:services({loadProducts:async()=>wait})});current=false;finish([product]);await promise;assert.equal(hosts[0].innerHTML,'');
});
test('per-host token prevents an older hydrate overwriting a newer result',async()=>{
 const {hosts,container}=fixture([op]);let finish;const wait=new Promise(r=>finish=r);
 const old=bridge.hydrate(container,{services:services({loadProducts:async()=>wait})});await bridge.hydrate(container,{services:services()});const shown=hosts[0].innerHTML;finish([]);await old;assert.equal(hosts[0].innerHTML,shown);
});
test('local workers never exceed four concurrent fallbacks',async()=>{
 const {container}=fixture(Array.from({length:12},()=>op));let active=0,maximum=0;
 await bridge.hydrate(container,{services:services({loadProducts:async()=>[],fallback:{lookup:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,1));active--;return {status:'none'};},render:()=>'-'}})});assert.equal(maximum,4);
});
test('raw merge never uses global timestamp or substitutes PSA grade',()=>{
 const p=bridge.withRawDetail(product,{fetchedAt:'2099',cards:{123:{grades:{raw:{lowest_ask:10,currency:'JPY'},psa10:{lowest_ask:100}}}}});assert.equal(p.gradeCheckedAt,null);assert.equal(p.grades.psa10,undefined);assert.equal(p.grades.raw.lowest_ask,10);
});
test('failed source catalogue is unknown and never triggers fallback providers',async()=>{
 const {hosts,container}=fixture([op]);let lookup=0;
 const result=await bridge.hydrate(container,{services:services({loadProducts:async()=>{throw Error('offline');},fallback:{...fallback,lookup:async()=>{lookup++;}}})});
 assert.equal(result[0].status,'unknown');assert.equal(lookup,0);assert.match(hosts[0].innerHTML,/가격 확인 지연/);
});
test('failed details retains a generic SNKR quote but does not invent absence',async()=>{
 for(const present of [true,false]){
  const {hosts,container}=fixture([op]);let lookup=0;
  const r=await bridge.hydrate(container,{services:services({loadProducts:async()=>[{...product,minPrice:present?10:null}],loadDetails:async()=>{throw Error('offline');},fallback:{...fallback,lookup:async(t,o)=>{lookup++;return fallback.lookup(t,o);}}})});
  assert.equal(r[0].status,present?'priced':'unknown');assert.equal(lookup,present?1:0);assert.match(hosts[0].innerHTML,present?/SNKRDUNK/:/가격 확인 지연/);
 }
});
test('one failed host lookup is caught and cannot leave a spinner or reject others',async()=>{
 const {hosts,container}=fixture([op,op]);let calls=0;
 await bridge.hydrate(container,{services:services({loadProducts:async()=>[],fallback:{...fallback,lookup:async()=>{if(++calls===1)throw Error('bad host');return {status:'none'};}}})});
 assert.match(hosts[0].innerHTML,/가격 확인 지연/);assert.match(hosts[1].innerHTML,/확인된 가격 없음/);
});
test('prepareTarget shares strict identity and raw detail pipeline without fallback requests',async()=>{
 let calls=0;
 const t=await bridge.prepareTarget(op,{services:services({fallback:{lookup:()=>{calls++;throw Error('no fallback');}},loadDetails:async()=>({fetchedAt:'2099',cards:{123:{fetchedAt:'2026-10-28T00:00:00Z',grades:{raw:{lowest_ask:800,currency:'JPY'}}}}})})});
 assert.equal(t.snkrdunkId,'123');assert.equal(t.snkrProduct.gradeCheckedAt,'2026-10-28T00:00:00Z');assert.equal(t.fullNumber,'OP17-001');assert.equal(calls,0);
 const p=await bridge.prepareTarget({...op,fullId:'OP17-001_p1'},{services:services()});assert.equal(p.snkrdunkId,undefined);
});
test('prepareTarget records unavailable sources instead of confirmed absence',async()=>{
 const t=await bridge.prepareTarget(op,{services:services({loadProducts:async()=>{throw Error('offline');}})});assert.equal(t.sourceUnavailable,true);assert.equal(t.snkrdunkStatus,'unknown');assert.equal(t.snkrdunkId,undefined);
});
test('reusing a host for a foreign grid invalidates an earlier async hydrate',async()=>{
 let identity=op,finish;const host={isConnected:true,innerHTML:'',closest:()=>({dataset:{cardIdentity:JSON.stringify(identity)}})},container={querySelectorAll:()=>[host]},wait=new Promise(r=>finish=r);
 const old=bridge.hydrate(container,{services:services({loadProducts:async()=>wait})});identity={...op,language:'en'};await bridge.hydrate(container,{services:services()});finish([product]);await old;assert.equal(host.innerHTML,'');
});
