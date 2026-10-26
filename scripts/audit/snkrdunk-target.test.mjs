import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
const source=readFileSync(new URL('../../functions/api/snkrdunk.js',import.meta.url),'utf8');
const api=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const html='<meta property="og:title" content="Mock product">';
async function call(target,fetcher,{paid=false}={}){
 const outbound=[];
 globalThis.fetch=async(url,options)=>{outbound.push({url:String(url),redirect:options?.redirect});return fetcher(String(url),options,outbound.length);};
 const query=new URL('https://tcghub.kr/api/snkrdunk');query.searchParams.set('url',target);
 const response=await api.onRequest({request:new Request(query),env:paid?{SCRAPINGBEE_KEY:'audit-dummy-key'}:{}});
 return {status:response.status,body:await response.json(),outbound};
}
test('prefix lookalikes and userinfo host confusion are rejected before either direct or paid forwarding',async()=>{
 for(const target of ['https://snkrdunk.com.attacker.invalid/path','https://snkrdunk.com@attacker.invalid/path',
  'https://snkrdunk.com@127.0.0.1/path','https://snkrdunk.com:8443/path',
  'http://snkrdunk.com/path','file:///snkrdunk.com/path','https://snkrdunk.com./path']){
  for(const paid of [false,true]){
   const result=await call(target,()=>{throw new Error('must not fetch');},{paid});
   assert.equal(result.status,400,target);assert.equal(result.outbound.length,0,target);
  }
 }
});
test('an exact HTTPS host remains usable and is normalized before direct fetch',async()=>{
 const result=await call('https://SNKRDUNK.com/apparels/123?x=1#unused',()=>new Response(html,{status:200}));
 assert.equal(result.status,200);assert.equal(result.outbound[0].url,'https://snkrdunk.com/apparels/123?x=1');
 assert.equal(result.outbound[0].redirect,'manual');
});
test('cross-host direct redirects are blocked before requesting the destination',async()=>{
 for(const location of ['https://attacker.invalid/path','//attacker.invalid/path','https://snkrdunk.com@attacker.invalid/path']){
  const result=await call('https://snkrdunk.com/apparels/123',()=>new Response(null,{status:302,headers:{Location:location}}));
  assert.equal(result.status,500);assert.equal(result.outbound.length,1);assert.equal(new URL(result.outbound[0].url).hostname,'snkrdunk.com');
 }
});
test('direct redirects cannot downgrade HTTPS or introduce a custom port',async()=>{
 for(const location of ['http://snkrdunk.com/path','https://snkrdunk.com:8443/path']){
  const result=await call('https://snkrdunk.com/apparels/123',()=>new Response(null,{status:307,headers:{Location:location}}));
  assert.equal(result.status,500);assert.equal(result.outbound.length,1);
 }
});
test('up to three trusted relative redirects remain usable',async()=>{
 const result=await call('https://snkrdunk.com/start',(_url,_options,n)=>n<=3?
  new Response(null,{status:302,headers:{Location:'/hop'+n}}):new Response(html,{status:200}));
 assert.equal(result.status,200);assert.equal(result.outbound.length,4);
 assert.ok(result.outbound.every(r=>new URL(r.url).hostname==='snkrdunk.com'&&r.redirect==='manual'));
});
test('a longer redirect loop stops at the fixed request budget',async()=>{
 const result=await call('https://snkrdunk.com/start',(_url,_options,n)=>new Response(null,{status:302,headers:{Location:'/hop'+n}}));
 assert.equal(result.status,500);assert.equal(result.outbound.length,4);
});
test('a redirect with no location is rejected without another request',async()=>{
 const result=await call('https://snkrdunk.com/start',()=>new Response(null,{status:301}));
 assert.equal(result.status,500);assert.equal(result.outbound.length,1);
});
test('paid mode receives only the validated target and does not follow service redirects carrying its key',async()=>{
 const result=await call('https://snkrdunk.com/apparels/123',()=>new Response(null,{status:302,headers:{Location:'https://attacker.invalid/'}}),{paid:true});
 assert.equal(result.status,500);assert.equal(result.outbound.length,1);
 const destination=new URL(result.outbound[0].url);
 assert.equal(destination.hostname,'app.scrapingbee.com');assert.equal(destination.searchParams.get('url'),'https://snkrdunk.com/apparels/123');
 assert.equal(result.outbound[0].redirect,'manual');
});
test('paid mode still returns successful provider content for the exact trusted target',async()=>{
 const result=await call('https://snkrdunk.com/apparels/123',()=>new Response(html,{status:200}),{paid:true});
 assert.equal(result.status,200);assert.equal(result.outbound.length,1);assert.equal(result.body.product.name,'Mock product');
});
