const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const {webcrypto,createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const start=html.indexOf('(function _setupAppDeepLinkListener()');
const end=html.indexOf('\n})();',start);
assert(start>=0&&end>start);
const code=html.slice(start,end+6);
const flush=()=>new Promise(setImmediate);
const sharedStorage=()=>({local:new Map(),session:new Map()});
async function harness(launch,{verifier='local-verifier',stores=sharedStorage(),blocked=false,cryptoAvailable=true,respond=async()=>({ok:true})}={}){
 const calls=[],toasts=[],values=stores.local,location={href:''};let listener,closed=0,launchTask;
 if(verifier)values.set('tcghub_email_verifier',verifier);
 const storage=(kind,map)=>({getItem:k=>{if(blocked===true||blocked===kind)throw Error('storage blocked');return map.get(k)||null;},setItem:(k,v)=>{if(blocked===true||blocked===kind)throw Error('storage blocked');map.set(k,String(v));},removeItem:k=>{if(blocked===true||blocked===kind)throw Error('storage blocked');map.delete(k);}});
 const app={addListener(name,fn){assert.equal(name,'appUrlOpen');listener=fn;},getLaunchUrl:()=>({then(fn){launchTask=Promise.resolve(launch).then(fn);return launchTask;}})};
 const context={URL,JSON,TextEncoder,crypto:cryptoAvailable?webcrypto:{},console:{error(){},warn(){}},localStorage:storage('local',stores.local),sessionStorage:storage('session',stores.session),showToast:x=>toasts.push(x),
  window:{location,Capacitor:{isNativePlatform:()=>true,Plugins:{App:app,Browser:{close:async()=>{closed++;}}}}},
  fetch:async(url,options)=>{const entry={url,body:JSON.parse(options.body),credentials:options.credentials};calls.push(entry);const data=await respond(entry);return {ok:data.ok!==false,json:async()=>data};}};
 vm.runInNewContext(code,context);await launchTask;await flush();
 return {calls,toasts,values,stores,location,get closed(){return closed;},emit:async url=>{await listener({url});await flush();}};
}

 test('cold Kakao launch exchanges the code and returns to the logged-in page',async()=>{
  const h=await harness({url:'kr.tcghub.app://kakao-callback?code=local-code'});
  assert.deepEqual(h.calls,[{url:'/api/auth/exchange-code',body:{code:'local-code'},credentials:'include'}]);
  assert.equal(h.location.href,'/?login=success');
 });
 test('warm Kakao callback remains supported',async()=>{
  const h=await harness(undefined);await h.emit('kr.tcghub.app://kakao-callback?code=warm-code');
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.code,'warm-code');
 });
 test('duplicate warm/cold delivery does not exchange one Kakao code twice',async()=>{
  const h=await harness({url:'kr.tcghub.app://kakao-callback?code=duplicate-code'});
  await Promise.all([h.emit('kr.tcghub.app://kakao-callback?code=duplicate-code'),h.emit('kr.tcghub.app://kakao-callback?code=duplicate-code')]);
  assert.equal(h.calls.length,1);
 });
 test('cold email callback still verifies and removes its local verifier',async()=>{
  const h=await harness({url:'kr.tcghub.app://email-callback'});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/auth/verify');
  assert.equal(h.values.has('tcghub_email_verifier'),false);assert.equal(h.location.href,'/?login=success');
 });
 test('cold email callback with query parameters reaches the same verifier',async()=>{
  const h=await harness({url:'kr.tcghub.app://email-callback?source=mail'});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'/api/auth/verify');
 });
 test('external URLs cannot close the browser or use account credentials',async()=>{
  const h=await harness({url:'https://attacker.invalid/kakao-callback?code=bad'});
  assert.equal(h.calls.length,0);assert.equal(h.closed,0);
 });
 test('unrelated app URLs are ignored without side effects',async()=>{
  const h=await harness({url:'kr.tcghub.app://unrelated?code=bad'});
  assert.equal(h.calls.length,0);assert.equal(h.closed,0);
 });
 test('Kakao callback without a code is ignored',async()=>{
  const h=await harness({url:'kr.tcghub.app://kakao-callback'});
  assert.equal(h.calls.length,0);assert.equal(h.closed,0);
 });
 test('a completed cold Kakao callback is not exchanged or allowed to close another browser after WebView reload',async()=>{
  const stores=sharedStorage(),used=new Set();let exchanges=0;
  const respond=async entry=>{exchanges++;const ok=!used.has(entry.body.code);used.add(entry.body.code);return{ok,...(!ok?{error:'single use code already consumed'}:{})};};
  const launch={url:'kr.tcghub.app://kakao-callback?code=reload-code'};
  const first=await harness(launch,{stores,respond}),second=await harness(launch,{stores,respond});
  assert.equal(first.calls.length,1);assert.equal(second.calls.length,0);assert.equal(second.closed,0);assert.equal(second.toasts.length,0);assert.equal(exchanges,1);
  const fingerprint=createHash('sha256').update('reload-code').digest('hex');
  for(const map of [stores.local,stores.session]){
   assert.equal(map.get('tcghub_kakao_callback_sha256'),fingerprint);assert.equal(map.get('tcghub_kakao_launch_sha256'),fingerprint);
   for(const [key,value]of map)if(key.startsWith('tcghub_kakao_')){assert.match(value,/^[a-f0-9]{64}$/);assert(!value.includes('reload-code'));}
  }
 });
 test('cold A stays remembered across warm B and subsequent reload while a fresh warm C still works',async()=>{
  const stores=sharedStorage(),launch={url:'kr.tcghub.app://kakao-callback?code=cold-A'};
  const first=await harness(launch,{stores});await first.emit('kr.tcghub.app://kakao-callback?code=warm-B');assert.equal(first.calls.length,2);
  const second=await harness(launch,{stores});await second.emit('kr.tcghub.app://kakao-callback?code=warm-B');assert.equal(second.calls.length,0);assert.equal(second.closed,0);
  await second.emit('kr.tcghub.app://kakao-callback?code=warm-C');assert.equal(second.calls.length,1);assert.equal(second.calls[0].body.code,'warm-C');
  assert.equal(stores.local.get('tcghub_kakao_launch_sha256'),createHash('sha256').update('cold-A').digest('hex'));
  assert.equal(stores.local.get('tcghub_kakao_callback_sha256'),createHash('sha256').update('warm-C').digest('hex'));
 });
 test('an already successful warm code can become a new Activity launch without a later replay',async()=>{
  const stores=sharedStorage(),first=await harness(undefined,{stores});await first.emit('kr.tcghub.app://kakao-callback?code=known-warm');
  const launch={url:'kr.tcghub.app://kakao-callback?code=known-warm'},second=await harness(launch,{stores});assert.equal(second.calls.length,0);assert.equal(second.closed,0);
  await second.emit('kr.tcghub.app://kakao-callback?code=new-warm');const third=await harness(launch,{stores});assert.equal(third.calls.length,0);assert.equal(third.closed,0);
 });
 test('a rejected exchange is not remembered and the same code can be retried successfully',async()=>{
  const stores=sharedStorage();let attempts=0;
  const h=await harness({url:'kr.tcghub.app://kakao-callback?code=retry-code'},{stores,respond:async()=>++attempts===1?{ok:false,error:'temporary rejection'}:{ok:true}});
  assert.equal(stores.local.get('tcghub_kakao_callback_sha256'),undefined);await h.emit('kr.tcghub.app://kakao-callback?code=retry-code');assert.equal(h.calls.length,2);assert.equal(h.location.href,'/?login=success');
  await h.emit('kr.tcghub.app://kakao-callback?code=fresh-after-retry');assert.equal(h.calls.length,3);
  const reloaded=await harness({url:'kr.tcghub.app://kakao-callback?code=retry-code'},{stores});assert.equal(reloaded.calls.length,0);assert.equal(reloaded.closed,0);
 });
 test('network failure also leaves a Kakao code available for explicit retry',async()=>{
  const stores=sharedStorage();let attempts=0;
  const h=await harness(undefined,{stores,respond:async()=>{if(++attempts===1)throw Error('offline');return{ok:true};}});
  await h.emit('kr.tcghub.app://kakao-callback?code=network-retry');assert.equal(stores.local.get('tcghub_kakao_callback_sha256'),undefined);await h.emit('kr.tcghub.app://kakao-callback?code=network-retry');assert.equal(h.calls.length,2);assert.equal(h.location.href,'/?login=success');
 });
 test('blocked storage or unavailable crypto preserves successful same-process login and duplicate suppression',async()=>{
  for(const options of [{blocked:true},{cryptoAvailable:false}]){
   const h=await harness({url:'kr.tcghub.app://kakao-callback?code=fallback-code'},options);await h.emit('kr.tcghub.app://kakao-callback?code=fallback-code');assert.equal(h.calls.length,1);assert.equal(h.closed,1);assert.equal(h.location.href,'/?login=success');
   for(const map of [h.stores.local,h.stores.session])assert(![...map.keys()].some(key=>key.startsWith('tcghub_kakao_')));
  }
 });
 test('session storage alone can suppress the reload when local storage is blocked',async()=>{
  const stores=sharedStorage(),launch={url:'kr.tcghub.app://kakao-callback?code=session-fallback'};
  const first=await harness(launch,{stores,blocked:'local'}),second=await harness(launch,{stores,blocked:'local'});assert.equal(first.calls.length,1);assert.equal(second.calls.length,0);assert.equal(second.closed,0);
 });
 test('email callback without a verifier never closes another provider browser',async()=>{
  const h=await harness({url:'kr.tcghub.app://email-callback'},{verifier:null});assert.equal(h.calls.length,0);assert.equal(h.closed,0);
 });
 test('pending and completed email callbacks keep verification single-shot before closing the browser',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r),h=await harness(undefined,{respond:()=>pending});
  const first=h.emit('kr.tcghub.app://email-callback');await flush();await h.emit('kr.tcghub.app://email-callback');assert.equal(h.calls.length,1);assert.equal(h.closed,1);resolve({ok:true});await first;await h.emit('kr.tcghub.app://email-callback');assert.equal(h.calls.length,1);assert.equal(h.closed,1);
 });
