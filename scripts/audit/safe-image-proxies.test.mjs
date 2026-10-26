import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const configurations=[];
for(const [name,parameter,exportName] of [['img.js','u','onRequest'],['casing-proxy-image.js','url','onRequestGet']]){
 const text=await readFile(new URL(`../../functions/api/${name}`,import.meta.url),'utf8');
 const module=await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
 configurations.push({name,parameter,handler:module[exportName]});
}
const png=Uint8Array.from([137,80,78,71,13,10,26,10]);
const jpeg=Uint8Array.from([255,216,255,224,0,1]);
const gif=new TextEncoder().encode('GIF89a000000');
const webp=new TextEncoder().encode('RIFF0000WEBPdata');
const avif=Uint8Array.from([0,0,0,24,...new TextEncoder().encode('ftypavif'),0,0,0,0,...new TextEncoder().encode('avifmif1')]);
const good=(bytes=png,mime='image/png')=>new Response(bytes,{headers:{'Content-Type':mime}});

async function invoke(config,{target='https://snkrdunk.com/image.png',fetcher=async()=>good(),method='GET',fastTimer=false}={}){
 const oldFetch=globalThis.fetch, oldTimeout=globalThis.setTimeout;
 const calls=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return fetcher(url,options,calls.length);};
 if(fastTimer)globalThis.setTimeout=(callback)=>oldTimeout(callback,0);
 try{
  const url=new URL(`https://tcghub.kr/api/${config.name.replace('.js','')}`);
  if(target!==null)url.searchParams.set(config.parameter,target);
  const response=await config.handler({request:new Request(url,{method})});
  const bytes=new Uint8Array(await response.arrayBuffer());
  return {response,bytes,body:new TextDecoder().decode(bytes),calls};
 }finally{globalThis.fetch=oldFetch;globalThis.setTimeout=oldTimeout;}
}

for(const config of configurations){
 test(`${config.name}: raster MIME/signatures pass unchanged with CORS and nosniff`,async()=>{
  for(const [bytes,mime] of [[png,'image/png'],[jpeg,'image/jpeg'],[gif,'image/gif'],[webp,'image/webp'],[avif,'image/avif']]){
   const r=await invoke(config,{fetcher:async()=>good(bytes,mime)});
   assert.equal(r.response.status,200);assert.deepEqual(r.bytes,bytes);
   assert.equal(r.response.headers.get('content-type'),mime);
   assert.equal(r.response.headers.get('access-control-allow-origin'),'*');
   assert.equal(r.response.headers.get('x-content-type-options'),'nosniff');
   assert.equal(r.calls[0].options.redirect,'manual');assert.ok(r.calls[0].options.signal instanceof AbortSignal);
  }
 });
 test(`${config.name}: HTTPS, exact host, port and credentials reject before fetch`,async()=>{
  for(const target of ['http://snkrdunk.com/a','https://snkrdunk.com:444/a','https://x@y@snkrdunk.com/a','https://snkrdunk.com.evil.example/a','https://child.snkrdunk.com/a','https://127.0.0.1/a','data:image/png;base64,AAAA']){
   const r=await invoke(config,{target});assert.equal(r.response.status,403);assert.equal(r.calls.length,0);
  }
  assert.equal((await invoke(config,{target:'no-url'})).response.status,400);
  assert.equal((await invoke(config,{target:null})).response.status,400);
 });
 test(`${config.name}: HTML, SVG, MIME spoof and missing MIME are blocked`,async()=>{
  for(const [body,mime] of [['<html>test</html>','text/html'],['<svg/>','image/svg+xml'],['<html>test</html>','image/png'],[png,'image/jpeg'],[png,'application/octet-stream']]){
   const r=await invoke(config,{fetcher:async()=>new Response(body,{headers:{'content-type':mime}})});
   assert.equal(r.response.status,502);assert.equal(r.body,'Image unavailable');
  }
 });
 test(`${config.name}: redirects recheck allowlist without fetching forbidden host`,async()=>{
  for(const next of ['https://127.0.0.1/private','http://snkrdunk.com/a','https://snkrdunk.com:444/a','https://user:pass@snkrdunk.com/a']){
   const r=await invoke(config,{fetcher:async()=>new Response(null,{status:302,headers:{location:next}})});
   assert.equal(r.response.status,502);assert.equal(r.calls.length,1);
  }
  const r=await invoke(config,{fetcher:async(url,options,n)=>n===1?new Response(null,{status:302,headers:{location:'https://cdn.snkrdunk.com/a.png'}}):good()});
  assert.equal(r.response.status,200);assert.equal(r.calls.length,2);
 });
 test(`${config.name}: follows at most three relative redirects`,async()=>{
  let r=await invoke(config,{fetcher:async(url,options,n)=>n<=3?new Response(null,{status:302,headers:{location:'/image.png'}}):good()});
  assert.equal(r.response.status,200);assert.equal(r.calls.length,4);
  r=await invoke(config,{fetcher:async()=>new Response(null,{status:302,headers:{location:'/image.png'}})});
  assert.equal(r.response.status,502);assert.equal(r.calls.length,4);
 });
 test(`${config.name}: declared and streamed bodies over 10MiB are bounded`,async()=>{
  let r=await invoke(config,{fetcher:async()=>new Response(png,{headers:{'content-type':'image/png','content-length':String(10*1024*1024+1)}})});
  assert.equal(r.response.status,502);
  let cancelled=false;
  r=await invoke(config,{fetcher:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(10*1024*1024));controller.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}}),{headers:{'content-type':'image/png'}})});
  assert.equal(r.response.status,502);assert.equal(cancelled,true);
 });
 test(`${config.name}: timeout aborts fetch and upstream errors remain generic`,async()=>{
  const r=await invoke(config,{fastTimer:true,fetcher:async(url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('PRIVATE upstream token')), {once:true}))});
  assert.equal(r.response.status,502);assert.equal(r.body,'Image unavailable');assert.ok(r.calls[0].options.signal.aborted);
  const failed=await invoke(config,{fetcher:async()=>{throw new Error('SECRET URL');}});
  assert.equal(failed.response.status,502);assert.equal(failed.body,'Image unavailable');
 });
}
