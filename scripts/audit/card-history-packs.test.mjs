import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {posix} from 'node:path';
import {test} from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../../functions/_middleware.js',import.meta.url),'utf8');
const generation='a'.repeat(64);
const original=Buffer.from('{\r\n"id":"1","name":"한국어 日本語","history":[{"date":"2026-11-06","raw_price":1e+4,"vol":0,"other":null}]}\r\n');
const record=body=>({body:body.toString(),bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});
function fixture({gen=generation,asset,staticResponse,manifestResponse}={}) {
  const calls=[],manifestCalls=[];let next=0;
  const scope=vm.createContext({URL,Request,Response,TextDecoder,TextEncoder,Uint8Array,atob,crypto:webcrypto,
    fetch(){throw Error('Unexpected network request');}});
  vm.runInContext(source.replace(/^export /gm,''),scope);
  const pack={schemaVersion:1,bucketSize:64,bucket:'0',files:{'1.json':record(original),'2.json':record(original)},unpacked:[]};
  return {calls,manifestCalls,scope,pack,get next(){return next;},invoke:async(path='/data/history/1.json',options={})=>scope.onRequest({
    request:new Request('https://tcghub.kr'+path,{method:options.method||'GET',headers:options.headers}),
    env:{ASSETS:{fetch:async request=>{
      if(new URL(request.url).pathname.endsWith('/manifest.json')) {
        manifestCalls.push(request.url);
        if(manifestResponse)return manifestResponse(request);
        const current=typeof gen==='function'?gen():gen;
        return current===null?new Response('missing',{status:404}):Response.json({schemaVersion:1,bucketSize:64,generation:current});
      }
      calls.push(request.url);return asset?asset(request,pack):Response.json(pack);
    }}},
    next:async()=>{next++;return staticResponse?staticResponse():new Response('original missing',{status:404});},
  })};
}

test('original history URL returns exact bytes, prices and fields with a body-bound ETag',async()=>{
  const app=fixture(),response=await app.invoke('/data/history/1.json?t=version');
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
  assert.equal(response.headers.get('Content-Length'),String(original.length));
  assert.match(response.headers.get('Content-Type'),/application\/json/);
  assert.equal(response.headers.get('ETag'),'"'+record(original).sha256+'"');
  assert.deepEqual(app.calls,[`https://tcghub.kr/data/card-history-packs-v1/${generation}/0.json`]);
  assert.equal(app.next,0);
});

test('HEAD, weak/multiple conditional tags and concurrent requests share one pack',async()=>{
  const app=fixture();
  const responses=await Promise.all(Array.from({length:18},()=>app.invoke()));
  assert.equal(app.calls.length,1);
  for(const response of responses)assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
  const head=await app.invoke(undefined,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  for(const value of ['"'+record(original).sha256+'"','W/"'+record(original).sha256+'"','"other", W/"'+record(original).sha256+'"','*']) {
    const cached=await app.invoke(undefined,{headers:{'If-None-Match':value}});
    assert.equal(cached.status,304);assert.equal(await cached.text(),'');
  }
  assert.equal(app.calls.length,1);
});

test('local/unpacked publications retain their original static response',async()=>{
  const app=fixture({gen:null,staticResponse:()=>new Response(original,{headers:{'Content-Type':'application/json'}})});
  assert.deepEqual(Buffer.from(await (await app.invoke()).arrayBuffer()),original);
  assert.equal(app.calls.length,0);assert.equal(app.next,1);
  for(const known of [false,true]) {
    const next=fixture({asset:(_req,p)=>known?Response.json({...p,unpacked:['3.json']}):new Response('missing',{status:404}),
      staticResponse:()=>new Response(original,{headers:{'Content-Type':'application/json'}})});
    const result=await next.invoke(known?'/data/history/3.json':'/data/history/1.json');
    assert.equal(result.status,200);assert.deepEqual(Buffer.from(await result.arrayBuffer()),original);assert.equal(next.next,1);
  }
});

test('missing records and SPA fallbacks cannot become price history JSON',async()=>{
  const missing=fixture();assert.equal((await missing.invoke('/data/history/3.json')).status,404);assert.equal(missing.next,0);
  const fallback=fixture({asset:()=>new Response('missing',{status:404}),staticResponse:()=>new Response('<html>SPA</html>',{headers:{'Content-Type':'text/html'}})});
  assert.equal((await fallback.invoke()).status,404);
});

test('unknown paths, traversal attempts and write methods never load a price pack',async()=>{
  for(const path of ['/data/history/0.json','/data/history/01.json','/data/history/1.json/extra','/data/history/1%2f2.json','/data/history/private.json']) {
    const app=fixture();assert.equal((await app.invoke(path)).status,404);assert.equal(app.calls.length,0);
  }
  const app=fixture();assert.equal((await app.invoke(undefined,{method:'POST'})).status,405);assert.equal(app.calls.length,0);
  await app.invoke('/api/auth/me');assert.equal(app.calls.length,0);assert.equal(app.next,1);
});

test('bucket boundaries and long numeric IDs use exact integer arithmetic',async()=>{
  for(const id of ['63','64','65','99999999999999999999']) {
    const bucket=(BigInt(id)/64n).toString(),body=Buffer.from(JSON.stringify({id,history:[]}));
    const app=fixture({asset:()=>Response.json({schemaVersion:1,bucketSize:64,bucket,files:{[id+'.json']:record(body)},unpacked:[]})});
    assert.deepEqual(Buffer.from(await (await app.invoke('/data/history/'+id+'.json')).arrayBuffer()),body);
    assert.ok(app.calls[0].endsWith('/'+bucket+'.json'));
  }
});

test('invalid identities, lengths, hashes and failed transports fail closed and allow retry',async()=>{
  const changes=[{schemaVersion:2},{bucket:'1'},{bucketSize:128},{files:[]},{unpacked:['1.json']},{unpacked:['64.json']},{unpacked:['3.json','3.json']}];
  for(const change of changes) {
    const app=fixture({asset:(_req,p)=>Response.json({...p,...change})});
    assert.equal((await app.invoke()).status,503);
  }
  for(const change of [{bytes:1},{sha256:'0'.repeat(64)},{body:'{"invented":true}'},{sha256:'invalid'}]) {
    let broken=true;
    const app=fixture({asset:(_req,p)=>Response.json({...p,files:{...p.files,'1.json':{...p.files['1.json'],...(broken?change:{})}}})});
    assert.equal((await app.invoke()).status,503);broken=false;
    assert.equal((await app.invoke()).status,200);assert.equal(app.calls.length,2);
  }
  for(const asset of [()=>new Response('{broken',{headers:{'Content-Type':'application/json'}}),()=>new Response('failed',{status:503})]) {
    assert.equal((await fixture({asset}).invoke()).status,503);
  }
});

test('declared and streamed oversized packs are cancelled before serving data',async()=>{
  for(const declared of [true,false]) {
    let cancelled=false;
    const app=fixture({asset:()=>new Response(new ReadableStream({
      start(controller){controller.enqueue(new Uint8Array(8*1024*1024+1));},cancel(){cancelled=true;},
    }),{headers:{'Content-Type':'application/json',...(declared?{'Content-Length':String(8*1024*1024+1)}:{})}})});
    assert.equal((await app.invoke()).status,503);assert.equal(cancelled,true);
  }
});

test('one live worker follows updated deployment data without reusing an earlier cached price',async()=>{
  let current=generation;
  const app=fixture({gen:()=>current,asset:(_req,p)=>Response.json(current===generation?p:{...p,files:{'1.json':record(Buffer.from('{"raw_price":222}'))}})});
  assert.deepEqual(Buffer.from(await (await app.invoke()).arrayBuffer()),original);
  current='b'.repeat(64);
  assert.equal((await (await app.invoke()).json()).raw_price,222);
  assert.equal(app.calls.length,2);assert.equal(app.manifestCalls.length,2);
  assert.ok(app.calls[1].includes('/'+current+'/'));
});

test('malformed, stale-format and oversized manifests cannot return old price data',async()=>{
  for(const manifest of [{schemaVersion:2,bucketSize:64,generation},{schemaVersion:1,bucketSize:128,generation},
    {schemaVersion:1,bucketSize:64,generation:'old'},null]) {
    const app=fixture({manifestResponse:()=>Response.json(manifest)});
    assert.equal((await app.invoke()).status,503);assert.equal(app.calls.length,0);
  }
  let cancelled=false;
  const app=fixture({manifestResponse:()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(new Uint8Array(4097));},cancel(){cancelled=true;},
  }),{headers:{'Content-Type':'application/json'}})});
  assert.equal((await app.invoke()).status,503);assert.equal(cancelled,true);assert.equal(app.calls.length,0);
});

test('history and image routes share the original bounded cache budget',async()=>{
  const app=fixture({asset:req=>{
    const bucket=new URL(req.url).pathname.split('/').at(-1).replace('.json','');
    const id=(BigInt(bucket)*64n+1n).toString();
    return Response.json({schemaVersion:1,bucketSize:64,bucket,files:{[id+'.json']:record(original)},unpacked:[],padding:'x'.repeat(6*1024*1024)});
  }});
  for(let i=0;i<5;i++)assert.equal((await app.invoke('/data/history/'+(i*64+1)+'.json')).status,200);
  const sizes=vm.runInContext('[...staticAssetPacks.values()].map(entry=>entry.bytes)',app.scope);
  assert.ok(sizes.length<=4);assert.ok(sizes.reduce((a,b)=>a+b,0)<=20*1024*1024);
});

test('cold requests bound transient parsing and keep duplicate pending requests shared',async()=>{
  let active=0,maximum=0;
  const app=fixture({asset:async req=>{
    active++;maximum=Math.max(active,maximum);
    await new Promise(resolve=>setTimeout(resolve,2));active--;
    const bucket=new URL(req.url).pathname.split('/').at(-1).replace('.json','');
    const id=(BigInt(bucket)*64n+1n).toString();
    return Response.json({schemaVersion:1,bucketSize:64,bucket,files:{[id+'.json']:record(original)},unpacked:[]});
  }});
  const ids=Array.from({length:12},(_,index)=>index*64+1);
  const responses=await Promise.all([...ids,...ids].map(id=>app.invoke('/data/history/'+id+'.json')));
  assert.equal(maximum,1);assert.equal(app.calls.length,ids.length);
  for(const response of responses)assert.equal(response.status,200);
  assert.equal(vm.runInContext('staticAssetLoads.size',app.scope),0);
});

test('the actual production verifier accepts edge-compressed weak ETags and rejects changed bodies or tag digests',async()=>{
  const program=readFileSync(new URL('../verify_card_history_production.mjs',import.meta.url),'utf8')
    .replace(/^import .*;$/gm,'').replace(/^const root=.*;$/m,"const root='/fixture';");
  const originals={'1.json':original,'2.json':Buffer.from('{"id":"2","raw_price":222}'),'64.json':Buffer.from('{"id":"64","history":[]}')};
  const manifest={sourceFiles:3,generation,fileCountSaved:1,sourceBytesPreserved:Object.values(originals).reduce((sum,body)=>sum+body.length,0)};
  async function run({weak=true,changedBody=false,changedTag=false}={}) {
    const output=[];
    const scope=vm.createContext({assert,createHash,JSON,Buffer,join:posix.join,AbortSignal,setTimeout,process:{env:{}},
      readFileSync(path,encoding){
        const raw=path.endsWith('/manifest.json')?Buffer.from(JSON.stringify(manifest)):originals[posix.basename(path)];
        assert.ok(raw,'Unexpected verification fixture path: '+path);return encoding?raw.toString(encoding):raw;
      },readdirSync:()=>Object.keys(originals),statSync:path=>({size:originals[posix.basename(path)].length}),
      existsSync:path=>path==='/fixture/_deploy/data/history/64.json',console:{log:value=>output.push(JSON.parse(value))},
      fetch:async(url,options={})=>{
        const name=posix.basename(new URL(url).pathname);
        if(name==='manifest.json')return Response.json(manifest);
        const body=changedBody?Buffer.from('{"invented":true}'):originals[name];
        const digest=changedTag?'0'.repeat(64):record(body).sha256;
        const headers={'Content-Type':'application/json','ETag':(weak?'W/':'')+'"'+digest+'"'};
        if(options.headers?.['If-None-Match'])return new Response(null,{status:304,headers});
        return new Response(options.method==='HEAD'?null:body,{headers});
      },
    });
    await vm.runInContext('(async()=>{'+program+'})()',scope);
    return output;
  }
  for(const weak of [false,true]) {
    const output=await run({weak});assert.equal(output[0].originalHistoryUrlsVerified,3);assert.equal(output[0].conditionalHistoryVerified,true);
  }
  await assert.rejects(run({changedBody:true}),/original history bytes differ/);
  await assert.rejects(run({changedTag:true}),/1\.json|2\.json/);
});
