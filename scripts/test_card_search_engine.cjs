const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {performance}=require('node:perf_hooks');
const root=path.resolve(__dirname,'..'),api=require('../assets/card-search-engine.js');
const rows=[
  {id:'JP:SV4K:066',name:'リザードン SAR [SV4K 066/066]',displayName:'리자몽 SAR [SV4K 066/066]',setName:'고대의 포효 (Ancient Roar)',number:'066/066',setCode:'SV4K',brand:'pokemon',kind:'card',listingCount:4,href:'/?set=SV4K&card=066%2F066#cardinfo'},
  {id:'JP:SV4K:066:mirror',name:'リザードン SAR Mirror [SV4K 066/066]',displayName:'리자몽 SAR 미러 [SV4K 066/066]',setName:'고대의 포효',number:'066/066',setCode:'SV4K',brand:'pokemon',kind:'card',listingCount:2},
  {id:'JPSET:SV4K',name:'Ancient Roar',displayName:'고대의 포효',setName:'고대의 포효',setCode:'SV4K',brand:'pokemon',kind:'box'},
  {id:'box-other',name:'Groudon Box',displayName:'그란돈 박스',brand:'pokemon',kind:'box'},
  {id:'op-1',name:'Monkey D. Luffy [OP01-001]',displayName:'몽키 D. 루피 [OP01-001]',fullId:'OP01-001',number:'001',setCode:'OP01',brand:'onepiece',kind:'card'},
  {id:'op-2',name:'Monkey D. Luffy [OP01-001] Parallel',displayName:'몽키 D. 루피 [OP01-001] 패러렐',fullId:'OP01-001',number:'001',setCode:'OP01',brand:'onepiece',kind:'card'},
  {id:'500001',name:'DON!! Card Luffy',displayName:'루피 돈!! 카드',brand:'onepiece',kind:'card',cardType:'DON'},
  {id:'500002',name:'Groudon',displayName:'그란돈',brand:'pokemon',kind:'card'},
  {id:'500003',name:'Koraidon',displayName:'코라이돈',brand:'pokemon',kind:'card'},
  {id:'500004',name:'Donald Duck',displayName:'도널드 덕',brand:'onepiece',kind:'card'},
  {id:'promo-1',name:'Pikachu [001/SV-P]',displayName:'피카츄 [001/SV-P]',brand:'pokemon',kind:'card',number:'001/SV-P',promoKeys:['sv-p:001']},
  {id:'promo-2',name:'Pikachu [001/S-P]',displayName:'피카츄 [001/S-P]',brand:'pokemon',kind:'card',number:'001/S-P',promoKeys:['s-p:001']},
  {id:'99999',name:'Numbered card',displayName:'번호 카드',brand:'pokemon',kind:'card',number:'099/99999'},
  {id:'name-exact',name:'Charizard',displayName:'리자몽',brand:'pokemon',kind:'card',listingCount:0},
  {id:'name-substring',name:'Dark Charizard',displayName:'어둠의 리자몽',brand:'pokemon',kind:'card',listingCount:999},
  {id:'unrelated-numeric',name:'Unrelated listing',displayName:'관계없는 카드',searchText:'19399999123',brand:'pokemon',kind:'card'},
  {id:'unrelated-op-number',name:'Other [OP01-010]',displayName:'다른 카드',number:'010',fullId:'OP01-010',setCode:'OP01',searchText:'OP01 001 listing',brand:'onepiece',kind:'card'},
];
const snapshot={schemaVersion:1,version:'test',rows,aliases:{리자몽:['charizard','リザードン'],루피:['luffy'],피카츄:['pikachu']}};
const engine=api.create(snapshot),ids=(query,options)=>engine.search(query,{limit:Infinity,...options}).results.map(row=>row.id);
assert.equal(engine.size,rows.length);
assert.equal(api.normalize('고대의 포효'),api.normalize('고대 포효'));
for(const query of ['OP01-001','OP-01 001','ＯＰ０１－００１','OP 01-001'])assert.deepEqual(ids(query),['op-1','op-2'],query);
assert.deepEqual(ids('고대박스'),['JPSET:SV4K']);
assert.deepEqual(ids('고대의 포효 box'),['JPSET:SV4K']);
assert(ids('SV4K').includes('JPSET:SV4K'));
assert(!ids('SV4K',{category:'card'}).includes('JPSET:SV4K'));
assert.equal(ids('리자몽')[0],'name-exact','Exact name outranks a popular substring');
assert(ids('리자몽').includes('JP:SV4K:066:mirror'),'Different artworks keep distinct identities');
assert.deepEqual(ids('99999'),['99999'],'Exact product ID remains searchable');
for(const query of ['DON!!','DON','돈','돈 카드','ドン!!'])assert.deepEqual(ids(query),['500001'],query);
assert.deepEqual(ids('DON!! 루피'),['500001']);
for(const query of ['SV-P001','SV-P 001','001/SV-P','001／SV-P'])assert.deepEqual(ids(query),['promo-1'],query);
assert.deepEqual(ids('001/S-P'),['promo-2']);
assert.deepEqual(ids('리자몽',{brand:'onepiece'}),[]);
assert.deepEqual(ids('존재하지않는완전다른카드'),[]);
assert.deepEqual(ids(''),[]);
const full=engine.search('리자몽',{limit:Infinity}),page=engine.search('리자몽',{offset:1,limit:2});
assert.equal(page.total,full.total);assert.deepEqual(page.results,full.results.slice(1,3));
const fields=Object.keys(rows[0]);
const tupleSnapshot={schemaVersion:1,fields,rows:[fields.map(key=>rows[0][key])]};
assert.equal(api.create(tupleSnapshot).search('066/066').results[0].id,rows[0].id);
const dictionarySnapshot={...tupleSnapshot,dictionaries:{kind:['card'],brand:['pokemon']},rows:tupleSnapshot.rows.map(tuple=>tuple.map((value,index)=>['kind','brand'].includes(fields[index])?0:value))};
assert.equal(api.create(dictionarySnapshot).search('066/066').results[0].kind,'card');
assert.throws(()=>api.create({schemaVersion:2,rows:[]}));
assert.throws(()=>api.create({schemaVersion:1,fields:['id','id'],rows:[]}));
assert.throws(()=>api.create({schemaVersion:1,rows:[{id:'x',kind:'unknown'}]}));

async function run(){
  const asyncEngine=await api.createAsync(snapshot);
  assert.deepEqual(asyncEngine.search('리자몽'),engine.search('리자몽'));
  const clientSource=fs.readFileSync(path.join(root,'assets/card-search-client.js'),'utf8');
  let workers=0,initRequests=0;
  class FakeWorker{
    constructor(){workers++;this.stopped=false;}
    postMessage(message){
      if(message.type==='init')initRequests++;
      setTimeout(()=>{if(!this.stopped)this.onmessage({data:{id:message.id,result:message.type==='init'?{size:engine.size}:engine.search(message.query,message.options)}});},message.query==='리자몽'?20:0);
    }
    terminate(){this.stopped=true;}
  }
  const ctx={window:{},Worker:FakeWorker,AbortController,setTimeout,clearTimeout,fetch(){throw Error('Main thread must not fetch or parse search data with a working worker');}};
  vm.createContext(ctx);vm.runInContext(clientSource,ctx);const client=ctx.window.CardSearchClient;
  await Promise.all([client.warm(),client.warm()]);
  assert.equal(workers,1);assert.equal(initRequests,1,'Concurrent preparation shares one worker');
  const old=client.search('리자몽'),recent=client.search('루피');
  assert.equal((await old).cancelled,true);assert.equal((await recent).total,3);
  const preview=client.search('리자몽',{lane:'price-preview'}),grid=client.search('루피',{lane:'price-grid'});
  assert(!(await preview).cancelled);assert(!(await grid).cancelled,'Independent search surfaces must not cancel each other');
  const closed=client.search('리자몽');client.cancel();assert.equal((await closed).cancelled,true);
  client.reset();

  let fallbackFetches=0;
  const fallbackCtx={window:{CardSearchEngine:api},AbortController,setTimeout,clearTimeout,fetch:async()=>{fallbackFetches++;return {ok:true,json:async()=>snapshot};}};
  vm.createContext(fallbackCtx);vm.runInContext(clientSource,fallbackCtx);
  const fallbackClient=fallbackCtx.window.CardSearchClient;
  await Promise.all([fallbackClient.warm(),fallbackClient.warm()]);
  assert.equal(fallbackFetches,1,'Unsupported workers use one yielding fallback snapshot');
  assert.equal((await fallbackClient.search('고대박스')).results[0].id,'JPSET:SV4K');
  fallbackClient.reset();

  const messages=[],imports=[];
  const workerCtx={self:{postMessage:message=>messages.push(message)},CardSearchEngine:api,AbortController,setTimeout,clearTimeout,importScripts:url=>imports.push(url),fetch:async()=>({ok:true,json:async()=>snapshot})};
  vm.createContext(workerCtx);vm.runInContext(fs.readFileSync(path.join(root,'assets/card-search-worker.js'),'utf8'),workerCtx);
  await workerCtx.self.onmessage({data:{type:'search',id:1,query:'OP-01 001',options:{limit:30}}});
  assert.equal(messages[0].result.total,2);assert(imports[0].includes('card-search-engine.js'));

  // Manifest shards load at most three at a time and retain their declared
  // order even when network completions arrive in a different order.
  const shardPaths=Array.from({length:4},(_,i)=>'/data/search-index-ja/part-000'+i+'-fixture.json');
  const manifest={...snapshot,rows:[],rowCount:rows.length,sourceHash:'fixture-release',shards:shardPaths};
  let active=0,maxActive=0,broken='missing';
  const shardFetch=async(url,{signal}={})=>{
    if(url.includes('search-index-ja.json?'))return {ok:true,json:async()=>manifest};
    const index=shardPaths.indexOf(url);assert(index>=0,'Only manifest-declared local shards may be fetched');
    active++;maxActive=Math.max(maxActive,active);
    try{
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(resolve,5-index);
        signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('Aborted'));},{once:true});
      });
      if(index===1&&broken==='missing')return {ok:false,status:404};
      return {ok:true,json:async()=>({schemaVersion:1,sourceHash:index===1&&broken==='mixed'?'older-release':'fixture-release',rows:rows.filter((_,i)=>Math.floor(i*4/rows.length)===index)})};
    }finally{active--;}
  };
  const shardedReplies=[],shardedCtx={self:{postMessage:message=>shardedReplies.push(message)},CardSearchEngine:api,AbortController,setTimeout,clearTimeout,importScripts(){},fetch:shardFetch};
  vm.createContext(shardedCtx);vm.runInContext(fs.readFileSync(path.join(root,'assets/card-search-worker.js'),'utf8'),shardedCtx);
  await shardedCtx.self.onmessage({data:{type:'init',id:1}});
  assert(shardedReplies.at(-1).error.includes('404'));assert(!shardedReplies.at(-1).result,'A missing shard must not publish partial search');
  broken='mixed';await shardedCtx.self.onmessage({data:{type:'init',id:2}});
  assert(shardedReplies.at(-1).error.includes('mismatch'),'Different releases must not merge');
  broken=null;manifest.rowCount++;
  await shardedCtx.self.onmessage({data:{type:'init',id:3}});
  assert(shardedReplies.at(-1).error.includes('Incomplete'),'Row-count loss must fail');
  manifest.rowCount--;
  await shardedCtx.self.onmessage({data:{type:'init',id:4}});
  assert.equal(shardedReplies.at(-1).result.size,rows.length,'A failed manifest is retriable');
  await shardedCtx.self.onmessage({data:{type:'search',id:5,query:'OP-01 001',options:{limit:30}}});
  assert.deepEqual(shardedReplies.at(-1).result.results.map(row=>row.id),['op-1','op-2']);
  assert(maxActive<=3,'Snapshot shard concurrency must be bounded to three');
  const shardedFallbackCtx={window:{CardSearchEngine:api},AbortController,setTimeout,clearTimeout,fetch:shardFetch};
  vm.createContext(shardedFallbackCtx);vm.runInContext(clientSource,shardedFallbackCtx);
  broken='missing';await assert.rejects(shardedFallbackCtx.window.CardSearchClient.warm(),/404/);
  broken=null;await shardedFallbackCtx.window.CardSearchClient.warm();
  assert.equal((await shardedFallbackCtx.window.CardSearchClient.search('고대박스')).results[0].id,'JPSET:SV4K');
  shardedFallbackCtx.window.CardSearchClient.reset();

  // The same exact query must remain complete when it occurs near the end
  // of a catalogue larger than the real production dataset.
  const large={schemaVersion:1,rows:Array.from({length:100000},(_,i)=>({id:'fixture:'+i,name:'Fixture card '+i,displayName:'테스트 카드 '+i,number:String(i).padStart(6,'0'),brand:'pokemon',kind:'card'}))};
  large.rows.push(...rows);
  const start=performance.now(),largeEngine=api.create(large),indexed=performance.now();
  assert.equal(largeEngine.search('고대박스').results[0].id,'JPSET:SV4K');
  assert.deepEqual(largeEngine.search('OP-01 001').results.map(row=>row.id),['op-1','op-2']);
  console.log('PASS: aliases, Korean box names, identifiers, DON/promo identity, variants, ranking, complete pages, worker isolation, independent lanes, fallback, bounded ordered shards and missing/mixed/incomplete manifest retry.');
  console.log(large.rows.length.toLocaleString('en-US')+'-row synthetic check: index '+Math.round(indexed-start)+'ms, two worker-compatible queries '+Math.round(performance.now()-indexed)+'ms (local runtime, not a device benchmark).');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
