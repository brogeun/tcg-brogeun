import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../../functions/_middleware.js',import.meta.url),'utf8');
const original=Buffer.from('RIFF reviewed exact WEBP artwork bytes');
const sha=createHash('sha256').update(original).digest('hex');
const file='tcg-29518.webp',bucket='461';
const image={contentType:'image/webp',sha256:sha,bytes:original.length,data:original.toString('base64')};
const pack={schemaVersion:2,bucketSize:64,setCode:'Neo1',bucket,files:{[file]:image,'tcg-29519.webp':{...image,data:Buffer.alloc(original.length,42).toString('base64')}}};
function runtime(asset=()=>Response.json(pack)) {
  const calls=[];let next=0;
  const context=vm.createContext({URL,Request,Response,TextDecoder,Uint8Array,atob,fetch(){throw Error('Unexpected external request');}});
  vm.runInContext(source.replace(/^export /gm,''),context);
  return {
    calls,get next(){return next;},
    invoke:async(path='/images/pokemon-vintage/Neo1/'+file,options={})=>context.onRequest({
      request:new Request('https://tcghub.kr'+path,{method:options.method||'GET',headers:options.headers}),
      env:{ASSETS:{fetch:async request=>{calls.push(request.url);return asset(request);}}},
      next:async()=>{next++;return new Response('original static missing',{status:404});},
    }),
  };
}

test('one original image URL returns only its exact binary bytes and MIME',async()=>{
  const app=runtime(),response=await app.invoke('/images/pokemon-vintage/Neo1/'+file+'?v=preserve');
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
  assert.equal(response.headers.get('Content-Type'),'image/webp');
  assert.equal(response.headers.get('Content-Length'),String(original.length));
  assert.equal(response.headers.get('ETag'),'"'+sha+'"');
  assert.equal(response.headers.get('Cache-Control'),'public, max-age=86400');
  assert.deepEqual(app.calls,['https://tcghub.kr/data/pokemon-vintage-packs-v2/Neo1/461.json']);
  assert.equal(app.next,0);
});

test('eighteen simultaneous lazy image requests fetch and parse one shared pack',async()=>{
  const app=runtime();
  const responses=await Promise.all(Array.from({length:18},()=>app.invoke()));
  assert.equal(app.calls.length,1);
  for(const response of responses)assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
});

test('HEAD and conditional 304 keep image headers without returning pack or image bodies',async()=>{
  const app=runtime();
  const head=await app.invoke(undefined,{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('Content-Type'),'image/webp');
  const cached=await app.invoke(undefined,{headers:{'If-None-Match':'"'+sha+'"'}});
  assert.equal(cached.status,304);assert.equal(await cached.text(),'');assert.equal(app.calls.length,1);
});

test('Pooka PNG image IDs use their explicit Pooka bucket',async()=>{
  const name='pooka-ja-dp1-108.png';
  const app=runtime(()=>Response.json({schemaVersion:2,bucketSize:64,setCode:'DP1',bucket:'pooka',files:{[name]:{...image,contentType:'image/png'}}}));
  const response=await app.invoke('/images/pokemon-vintage/DP1/'+name);
  assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
  assert.deepEqual(app.calls,['https://tcghub.kr/data/pokemon-vintage-packs-v2/DP1/pooka.json']);
});

test('invalid paths and write methods do not read a static pack',async()=>{
  for(const path of ['/images/pokemon-vintage/Neo1/tcg-29518.webp/extra','/images/pokemon-vintage/Neo%2F1/'+file,
    '/images/pokemon-vintage/Neo1/%2e%2e%2f'+file,'/images/pokemon-vintage/Neo1/tcg-00029518.webp']) {
    const app=runtime(),response=await app.invoke(path);assert.equal(response.status,404,path);assert.equal(app.calls.length,0,path);
  }
  const app=runtime(),response=await app.invoke(undefined,{method:'POST'});
  assert.equal(response.status,405);assert.equal(app.calls.length,0);
});

test('missing packs preserve unpacked publications and absent records return 404',async()=>{
  for(const asset of [()=>new Response('missing',{status:404}),()=>new Response('<html>SPA</html>',{headers:{'Content-Type':'text/html'}})]) {
    const app=runtime(asset),response=await app.invoke();assert.equal(response.status,404);assert.equal(app.next,1);
  }
  const app=runtime(),response=await app.invoke('/images/pokemon-vintage/Neo1/tcg-29517.webp');
  assert.equal(response.status,404);assert.equal(app.next,0);
});

test('malformed packs, wrong identities and invalid image metadata fail closed',async()=>{
  const bad=[
    ()=>Response.json({...pack,setCode:'Neo2'}),()=>Response.json({...pack,bucket:'1845'}),
    ()=>Response.json({...pack,schemaVersion:1}),()=>Response.json({...pack,bucketSize:16}),
    ()=>new Response('{broken',{headers:{'Content-Type':'application/json'}}),
    ()=>new Response('failed',{status:503}),
    ...[{contentType:'image/png'},{bytes:1},{sha256:'wrong'},{data:'!'.repeat(image.data.length)}].map(change=>
      ()=>Response.json({...pack,files:{[file]:{...image,...change}}})),
  ];
  for(const asset of bad){const app=runtime(asset);assert.equal((await app.invoke()).status,503);assert.equal(app.next,0);}
});

test('declared and streamed oversized packs stop before serving an image',async()=>{
  for(const declared of [true,false]) {
    let cancelled=false;
    const app=runtime(()=>new Response(new ReadableStream({
      start(controller){controller.enqueue(new Uint8Array(8*1024*1024+1));},cancel(){cancelled=true;},
    }),{headers:{'Content-Type':'application/json',...(declared?{'Content-Length':String(8*1024*1024+1)}:{})}}));
    assert.equal((await app.invoke()).status,503);assert.equal(cancelled,true);
  }
});

test('the worker retains at most four requested packs',async()=>{
  const app=runtime(request=>{
    const group=Number(new URL(request.url).pathname.split('/').pop().replace('.json',''));
    return Response.json({...pack,bucket:String(group),files:{['tcg-'+group*64+'.webp']:image}});
  });
  for(let group=461;group<466;group++)assert.equal((await app.invoke('/images/pokemon-vintage/Neo1/tcg-'+group*64+'.webp')).status,200);
  assert.equal(app.calls.length,5);
  assert.equal((await app.invoke('/images/pokemon-vintage/Neo1/tcg-'+461*64+'.webp')).status,200);
  assert.equal(app.calls.length,6);
});

test('only vintage image URLs invoke the new route and ordinary static images stay unchanged',async()=>{
  const routes=JSON.parse(readFileSync(new URL('../../_routes.json',import.meta.url),'utf8'));
  assert(routes.include.includes('/images/pokemon-vintage/*'));
  assert(!routes.include.includes('/images/*'));
  assert(!routes.include.some(value=>value.includes('pokemon-vintage-packs')));
  const app=runtime();await app.invoke('/images/sets/Neo1.jpg');assert.equal(app.calls.length,0);assert.equal(app.next,1);
});
