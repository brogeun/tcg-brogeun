// Public exact-query acceleration. It never downloads or prepares the complete
// card catalogue inside a Pages isolate. A cache miss is explicit, not empty.
const MANIFEST='/data/search-fastpath/manifest.json';
const MANIFEST_LIMIT=128*1024,SHARD_LIMIT=900*1024,CACHE_LIMIT=2*1024*1024,RESPONSE_LIMIT=512*1024;
let manifestCache=null,cacheBytes=0,activeReads=0;
const shardCache=new Map(),pendingShards=new Map(),waiters=[];
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>String(value).normalize('NFKC').trim().toLowerCase();
const queryKey=(query,category)=>JSON.stringify([canonical(query),category,'all']);
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const fail=(code='unavailable')=>{const error=new Error(code);error.code=code;throw error;};
function response(body,status=200){let text=JSON.stringify(body);if(new TextEncoder().encode(text).byteLength>RESPONSE_LIMIT){text=JSON.stringify({ok:false,code:'unavailable'});status=503;}return new Response(text,{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
function aborted(signal){return signal.reason||new Error('Search asset timeout');}
function bounded(promise,signal){
  if(signal.aborted)return Promise.reject(aborted(signal));
  return new Promise((resolve,reject)=>{
    const stop=()=>{signal.removeEventListener('abort',stop);reject(aborted(signal));};
    signal.addEventListener('abort',stop,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',stop);resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});
  });
}
async function permit(signal){
  if(signal.aborted)throw aborted(signal);
  if(activeReads<2){activeReads++;return;}
  if(waiters.length>=16)fail('busy');
  await new Promise((resolve,reject)=>{
    const job={resolve:()=>{signal.removeEventListener('abort',stop);resolve();}};
    const stop=()=>{const at=waiters.indexOf(job);if(at>=0)waiters.splice(at,1);signal.removeEventListener('abort',stop);reject(aborted(signal));};
    signal.addEventListener('abort',stop,{once:true});waiters.push(job);
  });
}
function release(){const next=waiters.shift();if(next)next.resolve();else activeReads--;}
async function staticJSON(context,path,limit){
  if(!context.env.ASSETS?.fetch)fail();
  const remaining=context.deadline?context.deadline-Date.now():2500;if(remaining<=0)fail();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(2500,remaining));let acquired=false;
  try{
    await permit(controller.signal);acquired=true;
    const target=new URL(path,new URL(context.request.url).origin);
    // Incoming cookies, credentials and headers never reach the static reader.
    const request=new Request(target,{method:'GET',redirect:'manual',signal:controller.signal,headers:{Accept:'application/json'}});
    const asset=await bounded(context.env.ASSETS.fetch(request),controller.signal);
    if(context.deadline&&Date.now()>=context.deadline)fail();
    if(!asset.ok||asset.status>=300||!/^application\/json(?:\s*;|$)/i.test(asset.headers.get('Content-Type')||''))fail();
    if(asset.url&&new URL(asset.url).origin!==target.origin)fail();
    const declared=asset.headers.get('Content-Length');
    if(declared&&(!/^\d+$/.test(declared)||Number(declared)>limit)){asset.body?.cancel().catch(()=>{});fail();}
    const reader=asset.body?.getReader();if(!reader)fail();
    const chunks=[];let size=0;
    try{
      for(;;){const {done,value}=await bounded(reader.read(),controller.signal);if(done)break;size+=value.byteLength;if(size>limit){reader.cancel().catch(()=>{});fail();}chunks.push(value);}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!object(data))fail();return {data,size};
    }finally{if(controller.signal.aborted)reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
  }finally{clearTimeout(timer);controller.abort();if(acquired)release();}
}
function validateManifest(data){
  if(![1,2].includes(data.schemaVersion)||!/^[a-f0-9]{64}$/.test(data.sourceHash||'')||!Number.isSafeInteger(data.rowCount)||data.rowCount<1||!Number.isSafeInteger(data.queryCount)||data.queryCount<1||!Number.isSafeInteger(data.maxResults)||data.maxResults<1||data.maxResults>60||data.schemaVersion===2&&data.maxResults!==60||!object(data.shards))fail();
  const entries=Object.entries(data.shards);if(!entries.length||entries.length>1024)fail();
  if(data.schemaVersion===2&&(![300,600].includes(data.maxAcceleratedResults)||!Array.isArray(data.pageShards)||data.pageShards.length>191))fail();
  const physical=new Set();
  for(const [prefix,entry]of [...entries,...(data.schemaVersion===2?data.pageShards.map(entry=>['00',entry]):[])]){
    if(!/^[a-f0-9]{2,16}$/.test(prefix)||!object(entry)||!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>SHARD_LIMIT||typeof entry.path!=='string'||!/^\/data\/search-fastpath\/queries-[a-f0-9]{2,16}-[a-f0-9]{20}\.json$/.test(entry.path))fail();
    physical.add(entry.path);
  }
  if(data.schemaVersion===2&&physical.size>191)fail();
  return data;
}
function manifestFor(context){
  const origin=new URL(context.request.url).origin,assets=context.env.ASSETS;
  if(manifestCache&&manifestCache.origin===origin&&manifestCache.assets===assets&&manifestCache.expires>Date.now())return manifestCache.promise;
  const entry={origin,assets,expires:Date.now()+30000};
  entry.promise=staticJSON(context,MANIFEST,MANIFEST_LIMIT).then(({data})=>validateManifest(data)).catch(error=>{if(manifestCache===entry)manifestCache=null;throw error;});
  manifestCache=entry;return entry.promise;
}
async function shardFor(context,manifest,entry){
  const origin=new URL(context.request.url).origin,key=origin+':'+entry.path,assets=context.env.ASSETS;
  const saved=shardCache.get(key);if(saved&&saved.assets===assets&&saved.sourceHash===manifest.sourceHash&&saved.data.schemaVersion===manifest.schemaVersion)return saved.data;
  const pending=pendingShards.get(key);if(pending&&pending.assets===assets&&pending.sourceHash===manifest.sourceHash&&pending.schemaVersion===manifest.schemaVersion)return pending.promise;
  const job={assets,sourceHash:manifest.sourceHash,schemaVersion:manifest.schemaVersion};
  job.promise=staticJSON(context,entry.path,SHARD_LIMIT).then(({data,size})=>{
    if(size!==entry.bytes||data.schemaVersion!==manifest.schemaVersion||data.sourceHash!==manifest.sourceHash||!object(data.rows)||!object(data.queries)||manifest.schemaVersion===2&&!object(data.pages))fail();
    while(shardCache.size&&(cacheBytes+size>CACHE_LIMIT||shardCache.size>=8)){
      const oldest=shardCache.keys().next().value;cacheBytes-=shardCache.get(oldest).size;shardCache.delete(oldest);
    }
    if(shardCache.has(key)){cacheBytes-=shardCache.get(key).size;shardCache.delete(key);}
    shardCache.set(key,{data,size,assets,sourceHash:manifest.sourceHash});cacheBytes+=size;return data;
  }).finally(()=>{if(pendingShards.get(key)===job)pendingShards.delete(key);});
  pendingShards.set(key,job);return job.promise;
}
function integer(value,fallback){if(value===null)return fallback;if(!/^\d{1,7}$/.test(value))return null;const number=Number(value);return Number.isSafeInteger(number)?number:null;}
export async function onRequest(context){
  if(context.request.method!=='GET')return new Response('Method not allowed',{status:405,headers:{Allow:'GET'}});
  context={request:context.request,env:context.env,deadline:Date.now()+3000};
  const params=new URL(context.request.url).searchParams,query=params.get('q')||'',category=params.get('category')||'all',brand=params.get('brand')||'all';
  const limit=integer(params.get('limit'),30),offset=integer(params.get('offset'),0);
  if(query.length>200||!query.trim()||!['all','card','box'].includes(category)||!['all','pokemon','onepiece'].includes(brand)||limit===null||offset===null||limit<1||limit>300)return response({ok:false,code:'invalid_query'},400);
  // Unsupported scopes retain complete legacy semantics. Never
  // estimate their total or filter a cached first page into a different scope.
  if(brand!=='all'||params.has('language')&&params.get('language')!=='ja'||limit>60)return response({ok:false,code:'fastpath_miss'},404);
  const expected=params.get('release');if(expected&&!/^[a-f0-9]{64}$/.test(expected))return response({ok:false,code:'invalid_release'},400);
  try{
    const manifest=await manifestFor(context);
    if(expected&&expected!==manifest.sourceHash)return response({ok:false,code:'release_changed',sourceHash:manifest.sourceHash},409);
    if(offset+limit>(manifest.schemaVersion===1?manifest.maxResults:manifest.maxAcceleratedResults))return response({ok:false,code:'fastpath_miss'},404);
    const key=queryKey(query,category),digest=await hash(key);
    const lookup=digest=>{for(let length=2;length<=16;length++)if(Object.hasOwn(manifest.shards,digest.slice(0,length)))return manifest.shards[digest.slice(0,length)];return null;};
    const entry=lookup(digest);if(!entry)return response({ok:false,code:'fastpath_miss'},404);
    const shard=await shardFor(context,manifest,entry),found=Object.hasOwn(shard.queries,digest)?shard.queries[digest]:null;
    if(!found)return response({ok:false,code:'fastpath_miss'},404);
    if(!object(found)||found.key!==key||!Number.isSafeInteger(found.total)||found.total<0||found.total>manifest.rowCount)fail();
    function rowFrom(data,id){
      const row=typeof id==='string'&&Object.hasOwn(data.rows,id)?data.rows[id]:null;
      if(!object(row)||row.id!==id||row.language!=='ja'||!['pokemon','onepiece'].includes(row.brand)||!['card','box'].includes(row.kind)||category!=='all'&&row.kind!==category||typeof row.name!=='string'||typeof row.displayName!=='string'||typeof row.href!=='string')fail();
      return row;
    }
    let results;
    if(manifest.schemaVersion===1){
      if(!Array.isArray(found.ids)||found.ids.length!==Math.min(found.total,manifest.maxResults))fail();
      results=found.ids.slice(offset,offset+limit).map(id=>rowFrom(shard,id));
    }else{
      const size=manifest.maxResults;
      if(!Array.isArray(found.pages)||found.pages.length!==Math.ceil(Math.min(found.total,manifest.maxAcceleratedResults)/size)||found.pages.some(ref=>!Array.isArray(ref)||ref.length!==2||typeof ref[0]!=='string'||!/^[a-f0-9]{64}$/.test(ref[0])||!Number.isSafeInteger(ref[1])||ref[1]<0||ref[1]>=manifest.pageShards.length)||new Set(found.pages.map(ref=>ref[0])).size!==found.pages.length)fail();
      results=[];
      if(offset<found.total){
        const first=Math.floor(offset/size),last=Math.floor((Math.min(found.total,offset+limit)-1)/size);
        const pages=await Promise.all(Array.from({length:last-first+1},async(_,i)=>{
          const pageIndex=first+i,[pageHash,fileId]=found.pages[pageIndex],pageEntry=manifest.pageShards[fileId];
          const data=await shardFor(context,manifest,pageEntry),page=Object.hasOwn(data.pages,pageHash)?data.pages[pageHash]:null;
          if(!object(page)||!Array.isArray(page.ids)||page.ids.length!==Math.min(size,found.total-pageIndex*size)||new Set(page.ids).size!==page.ids.length)fail();
          const rows=page.ids.map(id=>rowFrom(data,id));
          // The page digest includes every public field, including original prices and links.
          if(await hash('page\0'+JSON.stringify(rows))!==pageHash)fail();
          return rows;
        }));
        results=pages.flat().slice(offset-first*size,offset-first*size+limit);
      }
    }
    if(Date.now()>=context.deadline)fail();
    if(results.length!==Math.min(limit,Math.max(0,found.total-offset))||new Set(results.map(row=>row.id)).size!==results.length)fail();
    return response({ok:true,schemaVersion:1,sourceHash:manifest.sourceHash,query:canonical(query),category,brand,offset,limit,results,total:found.total});
  }catch(error){return response({ok:false,code:error.code==='busy'?'busy':'unavailable'},503);}
}
