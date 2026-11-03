'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {test}=require('node:test');
const {webcrypto}=require('node:crypto');
const engineAPI=require('../assets/card-search-engine.js');
const {compileFastpath,writeFastpath,publicRow,commonQueries}=require('./build_search_fastpath.cjs');
const snapshot={schemaVersion:1,sourceHash:'a'.repeat(64),aliases:{피카츄:['pikachu','ピカチュウ'],루피:['luffy']},rows:[
  {id:'100',name:'Pikachu',displayName:'피카츄',kind:'card',brand:'pokemon',language:'ja',href:'#price/100',minPrice:1000,currency:'JPY',number:'001/100',listingCount:10},
  {id:'101',name:'Pikachu Parallel',displayName:'피카츄 패러렐',kind:'card',brand:'pokemon',language:'ja',href:'#price/101',minPrice:2000,currency:'JPY',listingCount:3},
  {id:'JP:SV:001',name:'Pikachu',displayName:'피카츄',kind:'card',brand:'pokemon',language:'ja',href:'/?set=SV&card=001#cardinfo',minPrice:null,productId:null,number:'001/100'},
  {id:'900',name:'Pikachu Box',displayName:'피카츄',kind:'box',brand:'pokemon',language:'ja',href:'#price/900',minPrice:5000,currency:'JPY'},
  {id:'901',name:'Other 100 Box',displayName:'다른 100 박스',kind:'box',brand:'pokemon',language:'ja',href:'#price/901',number:'100'},
  {id:'don',name:'DON!! Card Luffy',displayName:'루피 돈 카드',kind:'card',cardType:'DON',brand:'onepiece',language:'ja',href:'#price/don'},
  {id:'koraidon',name:'Koraidon',displayName:'코라이돈',kind:'card',brand:'pokemon',language:'ja',href:'#price/koraidon'},
  {id:'promo',name:'Pikachu [001/SV-P]',displayName:'피카츄 프로모',kind:'card',brand:'pokemon',language:'ja',href:'#price/promo',promoKeys:['sv-p:001']},
  {id:'op1',name:'Luffy [OP01-001]',displayName:'루피',kind:'card',brand:'onepiece',language:'ja',href:'#price/op1',fullId:'OP01-001',number:'001',setCode:'OP01'},
  {id:'op2',name:'Luffy [OP01-001] Parallel',displayName:'루피 패러렐',kind:'card',brand:'onepiece',language:'ja',href:'#price/op2',fullId:'OP01-001',number:'001',setCode:'OP01'},
]};
const queries=['피카츄','ピカチュウ','Pikachu','피','피카츄박스','100','DON!!','001/SV-P','OP-01 001','없는이름','박스'];
const baseline=engineAPI.create(snapshot),directory=fs.mkdtempSync(path.join(os.tmpdir(),'tcghub-fastpath-'));
const compiled=compileFastpath(snapshot,{queries});
writeFastpath(compiled,directory);
test.after(()=>fs.rmSync(directory,{recursive:true,force:true}));

function api({timeout=2500}={}){
  const source=fs.readFileSync(path.join(__dirname,'../functions/api/card-search.js'),'utf8').replace('export async function onRequest','async function onRequest')+'\nmodule.exports={onRequest};';
  const context={module:{exports:{}},URL,Request,Response,Headers,TextEncoder,TextDecoder,AbortController,crypto:webcrypto,
    setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,timeout)),clearTimeout};
  vm.createContext(context);vm.runInContext(source,context);return context.module.exports.onRequest;
}
function assets(){
  const reads=[];
  const binding={fetch:async request=>{
    assert.equal(request.headers.get('Cookie'),null);assert.equal(request.headers.get('Authorization'),null);
    const pathname=new URL(request.url).pathname;reads.push(pathname);
    assert(pathname.startsWith('/data/search-fastpath/'));
    const bytes=fs.readFileSync(path.join(directory,path.basename(pathname)));
    return new Response(bytes,{headers:{'Content-Type':'application/json','Content-Length':String(bytes.length)}});
  }};
  return {binding,reads};
}
const request=(query,extra={},origin='https://tcghub.kr')=>new Request(origin+'/api/card-search?'+new URLSearchParams({q:query,...extra}),{headers:{Cookie:'private-session',Authorization:'private-secret'}});

test('deployment precomputation exactly matches every category including suffixes and numeric suppression',()=>{
  for(const query of queries){
    const groups=baseline.precompute(query,60);
    for(const category of ['all','card','box']){
      const expected=baseline.search(query,{category,limit:60});
      assert.deepEqual(groups[category],expected,query+' '+category);
      const entry=compiled.entries.find(entry=>entry.key===JSON.stringify([query.normalize('NFKC').trim().toLowerCase(),category,'all']));
      assert.deepEqual(entry.rows,expected.results.map(publicRow));assert.equal(entry.total,expected.total);
    }
  }
  assert(commonQueries(snapshot,{maxQueries:100}).includes('ピカチュウ'));
});

test('API reads a bounded manifest and one result shard, preserves totals/pages and sends no credentials',async()=>{
  const handle=api(),{binding,reads}=assets();
  for(const query of queries)for(const category of ['all','card','box']){
    const response=await handle({request:request(query,{category,limit:'1',offset:'0'}),env:{ASSETS:binding}});
    assert.equal(response.status,200);const value=await response.json(),expected=baseline.search(query,{category,limit:1});
    assert.deepEqual(value.results,expected.results.map(publicRow));assert.equal(value.total,expected.total);assert.equal(value.sourceHash,compiled.sourceHash);
  }
  assert.equal(reads.filter(url=>url.endsWith('/manifest.json')).length,1);
  const page=await handle({request:request('피카츄',{offset:'1',limit:'2'}),env:{ASSETS:binding}});
  assert.deepEqual((await page.json()).results,baseline.search('피카츄',{offset:1,limit:2}).results.map(publicRow));
  const before=reads.length;const repeated=await handle({request:request('피카츄',{offset:'1',limit:'2'}),env:{ASSETS:binding}});assert.equal(repeated.status,200);assert.equal(reads.length,before,'Decoded byte-bounded shard cache reuses exact releases');
});

test('unknown queries/scopes/deeper pages are explicit misses and release mismatches cannot mix rows',async()=>{
  const handle=api(),{binding,reads}=assets();
  for(const extra of [{brand:'pokemon'},{language:'en'},{offset:'60',limit:'30'},{limit:'300'}]){
    const result=await handle({request:request('피카츄',extra),env:{ASSETS:binding}});assert.equal(result.status,404);assert.equal((await result.json()).code,'fastpath_miss');
  }
  assert.equal(reads.length,0);
  const unknown=await handle({request:request('미리 계산하지 않은 쿼리'),env:{ASSETS:binding}});assert.equal(unknown.status,404);
  const changed=await handle({request:request('피카츄',{release:'f'.repeat(64)}),env:{ASSETS:binding}});assert.equal(changed.status,409);assert.equal((await changed.json()).sourceHash,compiled.sourceHash);
  const malformed=await handle({request:request('피카츄',{offset:'-1'}),env:{ASSETS:binding}});assert.equal(malformed.status,400);
});

test('missing, mixed or oversized static assets fail closed without a full-catalogue fallback',async()=>{
  const handle=api();
  for(const fetch of [async()=>new Response('<html>',{headers:{'Content-Type':'text/html'}}),async()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'99999999'}})]){
    assert.equal((await handle({request:request('피카츄'),env:{ASSETS:{fetch}}})).status,503);
  }
  const good=assets(),mixed={fetch:async req=>{
    const response=await good.binding.fetch(req);if(new URL(req.url).pathname.endsWith('manifest.json'))return response;
    const data=await response.json();data.sourceHash='f'.repeat(64);const body=JSON.stringify(data)+'\n';return new Response(body,{headers:{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body))}});
  }};
  assert.equal((await handle({request:request('피카츄'),env:{ASSETS:mixed}})).status,503);
});

test('hung ASSETS fetches and bodies have real deadlines, release permits, and later requests recover',async()=>{
  const handle=api({timeout:20}),good=assets();let mode='fetch';
  const binding={fetch:req=>mode==='fetch'?new Promise(()=>{}):mode==='body'?Promise.resolve({ok:true,status:200,headers:new Headers({'Content-Type':'application/json'}),body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:()=>Promise.resolve(),releaseLock(){}})}}):good.binding.fetch(req)};
  assert.equal((await handle({request:request('피카츄'),env:{ASSETS:binding}})).status,503);
  mode='body';assert.equal((await handle({request:request('피카츄'),env:{ASSETS:binding}})).status,503);
  mode='fetch';await Promise.all(['https://first.example','https://second.example','https://queued.example'].map(origin=>handle({request:request('피카츄',{},origin),env:{ASSETS:binding}})));
  mode='good';assert.equal((await handle({request:request('피카츄'),env:{ASSETS:binding}})).status,200);
});

function client({remote,delay=0,timerCap=Infinity}={}){
  const handle=api(),data=assets();let workers=0,initializations=0,apiCalls=0;
  class Worker{
    constructor(){workers++;this.stopped=false;}
    terminate(){this.stopped=true;}
    postMessage(message){if(message.type==='init')initializations++;setTimeout(()=>{if(!this.stopped)this.onmessage({data:{id:message.id,result:message.type==='init'?{size:baseline.size}:baseline.search(message.query,message.options)}});},0);}
  }
  const context={window:{},Worker,URLSearchParams,AbortController,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,timerCap)),clearTimeout,Date,
    fetch:async(url,options)=>{
      assert(url.startsWith('/api/card-search?'));assert.equal(options.credentials,'omit');apiCalls++;
      if(delay)await new Promise((resolve,reject)=>{const id=setTimeout(resolve,delay);options.signal.addEventListener('abort',()=>{clearTimeout(id);reject(new Error('Aborted'));},{once:true});});
      return remote?remote(url,options,apiCalls):handle({request:new Request('https://tcghub.kr'+url),env:{ASSETS:data.binding}});
    }};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../assets/card-search-client.js'),'utf8'),context);
  return {api:context.window.CardSearchClient,stats:()=>({workers,initializations,apiCalls})};
}
test('opening empty search and common API hits never warm the full local worker',async()=>{
  const c=client();await c.api.warm();await c.api.warm();assert.deepEqual(c.stats(),{workers:0,initializations:0,apiCalls:0});
  await c.api.search('');assert.equal(c.stats().apiCalls,0);
  const result=await c.api.search('피카츄');assert.equal(result.total,baseline.search('피카츄').total);assert.equal(c.stats().workers,0);
  const miss=await c.api.search('not-precomputed');assert.equal(miss.total,baseline.search('not-precomputed').total);assert.equal(c.stats().workers,1);assert.equal(c.stats().initializations,1);c.api.reset();
});
test('API failures, unsupported pages and brand scopes keep exact local results with one shared worker',async()=>{
  const c=client({remote:async()=>new Response('{}',{status:503})});
  for(const options of [{},{brand:'pokemon'},{offset:60,limit:30}]){
    const result=await c.api.search('피카츄',options),expected=baseline.search('피카츄',options);
    assert.equal(JSON.stringify(result.results),JSON.stringify(expected.results));assert.equal(result.total,expected.total);
  }
  assert.equal(c.stats().workers,1);assert.equal(c.stats().initializations,1);assert.equal(c.stats().apiCalls,1);c.api.reset();
});
test('a transport that ignores AbortSignal still times out and reaches the complete fallback',async()=>{
  const c=client({timerCap:25,remote:()=>new Promise(()=>{})});
  const result=await c.api.search('피카츄');assert.equal(result.total,baseline.search('피카츄').total);assert.equal(c.stats().workers,1);c.api.reset();
});
test('stale-query cancellation stays lane-specific and a cancelled API does not start a worker',async()=>{
  const c=client({delay:15}),first=c.api.search('피카츄'),second=c.api.search('DON!!');
  assert.equal((await first).cancelled,true);assert.equal((await second).total,1);assert.equal(c.stats().workers,0);
  const a=c.api.search('피카츄',{lane:'price-preview'}),b=c.api.search('DON!!',{lane:'global'});assert(!(await a).cancelled);assert(!(await b).cancelled);
  const closed=c.api.search('피카츄');c.api.cancel();assert.equal((await closed).cancelled,true);assert.equal(c.stats().workers,0);c.api.reset();
});
test('a partial-query miss yields to the next typed common query before warming the catalogue',async()=>{
  const c=client(),partial=c.api.search('not-precomputed');
  await new Promise(resolve=>setTimeout(resolve,20));
  const complete=await c.api.search('피카츄');assert.equal(complete.total,baseline.search('피카츄').total);
  assert.equal((await partial).cancelled,true);assert.equal(c.stats().workers,0);c.api.reset();
});
test('a deployment change is retried once without a catalogue download',async()=>{
  const c=client({remote:async(url,options,count)=>{
    if(count===1)return new Response(JSON.stringify({code:'release_changed',sourceHash:compiled.sourceHash}),{status:409});
    assert.equal(new URL(url,'https://tcghub.kr').searchParams.get('release'),compiled.sourceHash);
    const expected=baseline.search('피카츄');return new Response(JSON.stringify({ok:true,schemaVersion:1,sourceHash:compiled.sourceHash,query:'피카츄',category:'all',brand:'all',offset:0,limit:30,total:expected.total,results:expected.results.map(publicRow)}));
  }});
  assert.equal((await c.api.search('피카츄')).total,baseline.search('피카츄').total);assert.equal(c.stats().apiCalls,2);assert.equal(c.stats().workers,0);c.api.reset();
});

test('generation has a hard physical-file budget and preserves unknown output files',()=>{
  const out=fs.mkdtempSync(path.join(os.tmpdir(),'tcghub-fastpath-budget-'));
  try{
    fs.writeFileSync(path.join(out,'keep.txt'),'user file');
    assert.throws(()=>writeFastpath(compiled,out,{maxFiles:1}),/file asset budget/);
    const result=writeFastpath(compiled,out);assert(result.shards+1<=192);assert.equal(fs.readFileSync(path.join(out,'keep.txt'),'utf8'),'user file');
  }finally{fs.rmSync(out,{recursive:true,force:true});}
});
