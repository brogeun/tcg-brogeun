import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const text=await readFile(new URL('../../functions/api/card.js',import.meta.url),'utf8');
const api=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
const html='<meta property="og:title" content="Local product">';
async function invoke(target,fetcher=async()=>new Response(html),{fastTimer=false,key,method='GET'}={}){
 const oldFetch=globalThis.fetch,oldTimeout=globalThis.setTimeout,calls=[];
 globalThis.fetch=async(url,options={})=>{calls.push({url:String(url),options});return fetcher(String(url),options,calls.length);};
 if(fastTimer)globalThis.setTimeout=(fn)=>oldTimeout(fn,1);
 try{
  const url=new URL('https://tcghub.kr/api/card');if(target!==null)url.searchParams.set('snkrdunkUrl',target);if(key)url.searchParams.set('key',key);
  const response=await api.onRequest({request:new Request(url,{method}),env:{}});
  return {response,body:await response.json(),calls};
 }finally{globalThis.fetch=oldFetch;globalThis.setTimeout=oldTimeout;}
}

test('legacy card URL lookup rejects untrusted targets before any upstream request',async()=>{
 for(const target of ['https://snkrdunk.com.bad.invalid/apparels/123','https://snkrdunk.com@bad.invalid/apparels/123','https://name@snkrdunk.com/apparels/123','https://snkrdunk.com:444/apparels/123','http://snkrdunk.com/apparels/123','https://snkrdunk.com./apparels/123','file:///snkrdunk.com/apparels/123']){
  const r=await invoke(target);assert.equal(r.response.status,400,target);assert.equal(r.calls.length,0,target);
 }
});
test('legacy card URL lookup preserves valid Unicode product metadata and normalizes fragments',async()=>{
 const r=await invoke('https://SNKRDUNK.com/apparels/123?x=1#local',async()=>new Response('<meta property="og:title" content="리자몽 ポケモン">'));
 assert.equal(r.response.status,200);assert.equal(r.body.data.name,'리자몽 ポケモン');assert.equal(r.body.url,'https://snkrdunk.com/apparels/123?x=1');
 assert.equal(r.calls[0].options.redirect,'manual');assert.ok(r.calls[0].options.signal instanceof AbortSignal);
});
test('legacy card lookup rejects foreign, downgraded and credential-bearing redirects without requesting them',async()=>{
 for(const location of ['https://outside.invalid/private','//outside.invalid/private','http://snkrdunk.com/private','https://snkrdunk.com:444/private','https://user@snkrdunk.com/private']){
  const r=await invoke('https://snkrdunk.com/apparels/123',async()=>new Response(null,{status:302,headers:{Location:location}}));
  assert.equal(r.response.status,500);assert.equal(r.calls.length,1,location);assert.equal(r.calls[0].options.redirect,'manual');
 }
});
test('trusted relative redirects remain supported up to three hops',async()=>{
 const r=await invoke('https://snkrdunk.com/start',async(_url,_options,n)=>n<4?new Response(null,{status:307,headers:{Location:'/hop'+n}}):new Response(html));
 assert.equal(r.response.status,200);assert.equal(r.body.data.name,'Local product');assert.equal(r.calls.length,4);
 assert.ok(r.calls.every(x=>new URL(x.url).hostname==='snkrdunk.com'&&x.options.redirect==='manual'));
});
test('redirect loops have a fixed request budget',async()=>{
 const r=await invoke('https://snkrdunk.com/start',async()=>new Response(null,{status:302,headers:{Location:'/loop'}}));
 assert.equal(r.response.status,500);assert.equal(r.calls.length,4);
});
test('redirects without Location fail closed',async()=>{
 const r=await invoke('https://snkrdunk.com/start',async()=>new Response(null,{status:302}));
 assert.equal(r.response.status,500);assert.equal(r.calls.length,1);
});
test('non-success source responses do not publish product metadata',async()=>{
 const r=await invoke('https://snkrdunk.com/start',async()=>new Response(html,{status:429}));
 assert.equal(r.response.status,500);assert.equal(r.body.ok,false);assert.equal(r.calls.length,1);
});
test('a reported foreign final source cannot become trusted product metadata',async()=>{
 const r=await invoke('https://snkrdunk.com/start',async()=>{const response=new Response(html);Object.defineProperty(response,'url',{value:'https://outside.invalid/'});return response;});
 assert.equal(r.response.status,500);assert.equal(r.body.ok,false);
});
test('declared or streamed HTML larger than 5MiB is rejected and cancelled',async()=>{
 for(const declared of [true,false]){
  let cancelled=false;
  const r=await invoke('https://snkrdunk.com/start',async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(5*1024*1024+1));},cancel(){cancelled=true;}}),{headers:declared?{'Content-Length':String(5*1024*1024+1)}:{}}));
  assert.equal(r.response.status,500);assert.equal(cancelled,true);
 }
});
test('a pending upstream fetch is bounded by the shared deadline',async()=>{
 const r=await invoke('https://snkrdunk.com/start',async(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true})),{fastTimer:true});
 assert.equal(r.response.status,500);assert.equal(r.calls.length,1);
});
test('list mode stays local, keeps all seven tracked cards and performs no paid or network calls',async()=>{
 const r=await invoke(null,()=>{throw new Error('must remain local');},{key:'all'});
 assert.equal(r.response.status,200);assert.equal(r.body.type,'list');assert.equal(r.body.cards.length,7);assert.equal(r.calls.length,0);
});
test('unknown tracked keys remain a local 404 without provider calls',async()=>{
 const r=await invoke(null,()=>{throw new Error('must remain local');},{key:'not-a-card'});
 assert.equal(r.response.status,404);assert.equal(r.calls.length,0);
});