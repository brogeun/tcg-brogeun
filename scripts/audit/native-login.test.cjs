const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const root=path.resolve(__dirname,'../..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const start=html.indexOf('(function _setupAppDeepLinkListener()');
const end=html.indexOf('\n})();',start);
assert(start>=0&&end>start);
const code=html.slice(start,end+6);
const flush=()=>new Promise(setImmediate);
async function harness(launch,{verifier='local-verifier'}={}){
 const calls=[],toasts=[],values=new Map(),location={href:''};let listener,closed=0;
 if(verifier)values.set('tcghub_email_verifier',verifier);
 const app={addListener(name,fn){assert.equal(name,'appUrlOpen');listener=fn;},getLaunchUrl:async()=>launch};
 const context={URL,JSON,console,localStorage:{getItem:k=>values.get(k)||null,removeItem:k=>values.delete(k)},showToast:x=>toasts.push(x),
  window:{location,Capacitor:{isNativePlatform:()=>true,Plugins:{App:app,Browser:{close:async()=>{closed++;}}}}},
  fetch:async(url,options)=>{calls.push({url,body:JSON.parse(options.body),credentials:options.credentials});return {ok:true,json:async()=>({ok:true})};}};
 vm.runInNewContext(code,context);await flush();
 return {calls,toasts,values,location,get closed(){return closed;},emit:async url=>{await listener({url});await flush();}};
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
