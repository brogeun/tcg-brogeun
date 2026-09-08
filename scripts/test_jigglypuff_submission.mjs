import assert from 'node:assert/strict';
import {MergeGame,VERSION,verifyReplay} from '../games/jigglypuff/engine.mjs';

// Isolated DOM, fetch and storage only; this test never contacts a service or browser.
const storageKey='jigglypuff-pending-v3';
const ids=['rank-start','nickname','retry','discard','submission','rank-rule','rank-primary','rank-secondary','rank-body','my-rank','rank-status','auth-status','login','refresh'];
let instance=0;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const response=data=>({ok:true,json:async()=>({ok:true,...data})});
function storage(initial){
 const values=new Map(initial===undefined?[]:[[storageKey,initial]]);
 return{values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
}
function element(){
 const listeners=new Map();
 return{textContent:'',value:'',disabled:false,hidden:true,children:[],className:'',append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},addEventListener(type,listener){listeners.set(type,listener);},click(){return listeners.get('click')?.();}};
}
async function harness(saved=storage(),post=async()=>response({ranked:true})){
 const elements=new Map(ids.map(id=>[id,element()])),requests=[];
 globalThis.document={getElementById:id=>{assert(elements.has(id),`known DOM id: ${id}`);return elements.get(id);},createElement:element};
 globalThis.sessionStorage=saved;globalThis.localStorage=storage();
 globalThis.fetch=async(url,options)=>{
  const request={url,body:options.body?JSON.parse(options.body):null};requests.push(request);
  return request.body?post(request):response({loggedIn:true,rows:[],mine:null});
 };
 const rankings=await import(`../games/jigglypuff/leaderboard.js?submission-test=${++instance}`);
 rankings.init();await settle();
 return{rankings,saved,requests,get:id=>elements.get(id)};
}

const game=new MergeGame(11,'endless'),drops=[];
while(!game.over&&game.ticks<100000){
 if(game.ticks%65===0){const x=[240,100,360,180,300][Math.floor(game.ticks/65)%5];if(game.drop(x))drops.push([game.ticks,x]);}
 game.step();game.events.length=0;
}
assert(game.over);
const replay={version:VERSION,ticks:game.ticks,drops};
assert.deepEqual(verifyReplay(11,replay,'endless'),game.result());
const session={sessionId:'11111111-1111-4111-8111-111111111111',mode:'endless'};

// A failed request retains the exact completed replay before the network request.
const saved=storage();
let sentBody;
const first=await harness(saved,async request=>{
 sentBody=request.body;
 assert.equal(JSON.parse(saved.getItem(storageKey)).mode,'endless');
 throw Error('isolated network failure');
});
first.rankings.matchStatus(true);assert.equal(first.get('submission').textContent,'랭킹 경기 · 종료 후 자동 등록');
first.rankings.matchStatus(false);assert.equal(first.get('submission').textContent,'');
const submittedReplay=structuredClone(replay);
await first.rankings.submit(session,submittedReplay);
submittedReplay.drops[0][1]=0;
const record=JSON.parse(saved.getItem(storageKey));
assert.deepEqual(record.replay,replay,'capture is independent of later controller mutation');
assert.deepEqual(sentBody,{action:'finish',sessionId:session.sessionId,replay});
assert(!('mode' in sentBody),'finish payload cannot choose the authoritative server mode');
assert.match(first.get('submission').textContent,/무한 만들기.*등록 실패/);
const failedStatus=first.get('submission').textContent;
first.rankings.matchStatus(false);first.rankings.setMode('speed');await settle();
assert.equal(first.get('submission').textContent,failedStatus);
assert.equal(first.get('retry').hidden,false);assert.equal(first.get('discard').hidden,false);
assert.equal(first.get('rank-start').disabled,true);

// Reload restores locally but never automatically submits. Switching modes and
// resetting while retry is in flight must retain the completed record's identity.
let release;
const restored=await harness(saved,request=>new Promise(resolve=>{
 assert.equal(request.url,'/api/games/jigglypuff?mode=endless');
 assert.deepEqual(request.body,{action:'finish',sessionId:session.sessionId,replay});
 release=()=>resolve(response({ranked:true}));
}));
assert.equal(restored.requests.filter(request=>request.body).length,0);
assert.match(restored.get('submission').textContent,/무한 만들기.*복구/);
assert.equal(restored.get('retry').hidden,false);
await assert.rejects(()=>restored.rankings.prepare(),/이전 기록/);
const retry=restored.get('retry').click();
assert.equal(restored.get('retry').disabled,true);assert.equal(restored.get('discard').disabled,true);
restored.get('discard').click();assert(saved.getItem(storageKey),'in-flight records cannot be discarded');
restored.rankings.setMode('speed');restored.rankings.matchStatus(false);
assert.match(restored.get('submission').textContent,/무한 만들기.*검증/);
release();await retry;await settle();
assert.equal(saved.getItem(storageKey),null);
assert.match(restored.get('submission').textContent,/무한 만들기.*등록 완료/);
assert.equal(restored.get('retry').hidden,true);assert.equal(restored.get('rank-start').disabled,false);
const successStatus=restored.get('submission').textContent;
restored.rankings.matchStatus(false);assert.equal(restored.get('submission').textContent,successStatus);
restored.rankings.matchStatus(true);restored.rankings.matchStatus(false);assert.equal(restored.get('submission').textContent,'');

// Malformed or incompatible recovery data stays local and requires explicit
// discard. It cannot be posted, erase itself, or silently overwrite a new game.
const invalidRecords=[
 '{broken JSON',
 JSON.stringify({...record,mode:'wrong'}),
 JSON.stringify({...record,replay:{...replay,version:VERSION-1}}),
 JSON.stringify({...record,replay:{...replay,ticks:Number.MAX_SAFE_INTEGER}}),
 JSON.stringify({...record,replay:{...replay,drops:[[0,240],[1,240]]}}),
 JSON.stringify({...record,replay:{...replay,drops:[[0,481]]}}),
 JSON.stringify({...record,replay:{...replay,drops:[]}}),
 JSON.stringify({...record,replay:{...replay,drops:Array.from({length:4097},(_,i)=>[i*60,240])}}),
 ' '.repeat(131073),
];
for(const raw of invalidRecords){
 const invalid=await harness(storage(raw));
 assert.equal(invalid.requests.filter(request=>request.body).length,0);
 assert.equal(invalid.saved.getItem(storageKey),raw);
 assert.equal(invalid.get('retry').hidden,true);assert.equal(invalid.get('discard').hidden,false);
 assert.equal(invalid.get('rank-start').disabled,true);
 await invalid.get('retry').click();assert.equal(invalid.requests.filter(request=>request.body).length,0);
 await invalid.get('discard').click();assert.equal(invalid.saved.getItem(storageKey),null);
 assert.equal(invalid.get('rank-start').disabled,false);
}

const discarded=await harness(storage(JSON.stringify(record)));
await discarded.get('discard').click();assert.equal(discarded.saved.getItem(storageKey),null);
assert.match(discarded.get('submission').textContent,/무한 만들기.*등록을 포기/);

// Private-browser storage errors leave normal play and manual retry usable.
const deniedStorage={getItem(){throw Error('storage denied');},setItem(){throw Error('storage denied');},removeItem(){throw Error('storage denied');}};
let fail=true;
const privateBrowser=await harness(deniedStorage,async()=>{if(fail)throw Error('offline');return response({ranked:false});});
globalThis.localStorage=deniedStorage;
assert.equal(privateBrowser.get('rank-start').disabled,false);
await privateBrowser.rankings.submit({...session,mode:'speed'},replay);
assert.match(privateBrowser.get('submission').textContent,/푸린 만들기.*새로고침하면 기록이 사라질 수/);
fail=false;await privateBrowser.get('retry').click();
assert.match(privateBrowser.get('submission').textContent,/푸린 만들기.*시간 랭킹에는 등록되지/);
assert.equal(privateBrowser.get('rank-start').disabled,false);

console.log('PASS: durable failed replay, validated/manual recovery, mode identity, unchanged finish payload, retry/discard locking, match status, malformed-data isolation and denied storage.');
