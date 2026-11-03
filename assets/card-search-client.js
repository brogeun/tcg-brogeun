/* A single lazy worker shared by search entry points. Compatibility work yields to input. */
(() => {
  'use strict';
  const version='20261104-search3';
  let worker=null,ready=null,engine=null,fallbackReady=null,sequence=0,queryVersion=0,engineScript;
  const pending=new Map(),latest=new Map(),remotePending=new Map();
  let remoteVersion=null,remoteUnavailableUntil=0;
  const yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0));
  function stopWorker(error) {
    worker?.terminate();worker=null;ready=null;
    for(const request of pending.values()){clearTimeout(request.timeout);request.reject(error);}
    pending.clear();
  }
  function request(type,payload={}) {
    const id=++sequence;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('검색 준비 시간이 초과됐어요. 다시 검색해주세요.'));},type==='init'?45000:25000);
      pending.set(id,{resolve,reject,timeout});
      try {worker.postMessage({type,id,...payload});}
      catch(error){clearTimeout(timeout);pending.delete(id);reject(error);}
    });
  }
  async function snapshotJSON(signal) {
    async function read(path,cache) {
      const response=await fetch(path,{cache,signal});
      if(!response.ok)throw new Error('Search snapshot HTTP '+response.status);
      return response.json();
    }
    const snapshot=await read('/data/search-index-ja.json?v='+version,'no-cache');
    if(snapshot.shards===undefined)return snapshot;
    if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.rows)||snapshot.rows.length||typeof snapshot.sourceHash!=='string'||!snapshot.sourceHash||!Array.isArray(snapshot.shards)||!snapshot.shards.length||new Set(snapshot.shards).size!==snapshot.shards.length||!Number.isSafeInteger(snapshot.rowCount)||snapshot.rowCount<1)throw new Error('Invalid search snapshot manifest');
    const parts=new Array(snapshot.shards.length);let next=0;
    await Promise.all(Array.from({length:Math.min(3,parts.length)},async()=>{
      while(next<parts.length){
        const index=next++,path=snapshot.shards[index];
        if(typeof path!=='string'||!/^\/data\/search-index-ja\/part-[\w-]+\.json$/.test(path))throw new Error('Invalid search shard path');
        const part=await read(path,'force-cache');
        if(part.schemaVersion!==1||part.sourceHash!==snapshot.sourceHash||!Array.isArray(part.rows))throw new Error('Search shard release mismatch');
        parts[index]=part.rows;
      }
    }));
    const rows=parts.flat();
    if(rows.length!==snapshot.rowCount)throw new Error('Incomplete search snapshot');
    return {...snapshot,rows};
  }
  function fallback() {
    if(fallbackReady)return fallbackReady;
    fallbackReady=(async()=>{
      if(!window.CardSearchEngine){
        if(!engineScript)engineScript=new Promise((resolve,reject)=>{
          const script=document.createElement('script');script.src='/assets/card-search-engine.js?v='+version;
          script.onload=resolve;script.onerror=()=>{script.remove();engineScript=null;reject(new Error('검색 도구를 불러오지 못했어요.'));};
          document.head.append(script);
        });
        await engineScript;
      }
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),40000);
      try {
        engine=await window.CardSearchEngine.createAsync(await snapshotJSON(controller.signal),yieldTask);
        return {size:engine.size};
      } finally {clearTimeout(timeout);controller.abort();}
    })().catch(error=>{fallbackReady=null;throw error;});
    return fallbackReady;
  }
  function warmLocal() {
    if(ready)return ready;
    ready=(async()=>{
      if(typeof Worker==='function'){
        try{
          worker=new Worker('/assets/card-search-worker.js?v='+version);
          worker.onmessage=event=>{
            const reply=event.data||{},job=pending.get(reply.id);if(!job)return;
            clearTimeout(job.timeout);pending.delete(reply.id);
            if(reply.error){const error=new Error(reply.error);error.code='SEARCH_SNAPSHOT';job.reject(error);}else job.resolve(reply.result);
          };
          worker.onerror=()=>stopWorker(new Error('검색 작업을 시작하지 못했어요.'));
          return await request('init');
        }catch(error){stopWorker(error);if(error.code==='SEARCH_SNAPSHOT')throw error;}
      }
      return fallback();
    })().catch(error=>{ready=null;throw error;});
    return ready;
  }
  const canonical=value=>String(value).normalize('NFKC').trim().toLowerCase();
  // Opening an empty search must not download the complete catalogue. The
  // compiled server path needs no warm-up; local workers start only on a miss.
  function warm(){return Promise.resolve({mode:'server-fastpath'});}
  function remoteBounded(promise,signal){
    if(signal.aborted)return Promise.reject(signal.reason||new Error('Search aborted'));
    return new Promise((resolve,reject)=>{
      const stop=()=>{signal.removeEventListener('abort',stop);reject(signal.reason||new Error('Search aborted'));};
      signal.addEventListener('abort',stop,{once:true});
      Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',stop);resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});
    });
  }
  async function remoteSearch(query,options,lane,requestId){
    const category=['card','box'].includes(options.category)?options.category:'all',brand=options.brand||'all';
    const offset=Math.max(0,Math.floor(Number(options.offset)||0));
    const limit=options.limit===Infinity?Infinity:Math.max(1,Math.min(300,Math.floor(Number(options.limit)||30)));
    if(brand!=='all'||limit>60||offset+limit>60||String(query).length>200){const error=new Error('Search fastpath miss');error.miss=true;throw error;}
    const controller=new AbortController(),job={controller,requestId};remotePending.set(lane,job);
    const timeout=setTimeout(()=>controller.abort(),3500);
    try{
      for(let attempt=0;attempt<2;attempt++){
        const params=new URLSearchParams({q:String(query),category,brand,offset:String(offset),limit:String(limit)});
        const expectedRelease=remoteVersion;if(expectedRelease)params.set('release',expectedRelease);
        const response=await remoteBounded(fetch('/api/card-search?'+params,{credentials:'omit',cache:'no-store',signal:controller.signal}),controller.signal);
        if(Number(response.headers?.get?.('Content-Length'))>512*1024)throw new Error('Search response exceeds budget');
        const value=await remoteBounded(response.json(),controller.signal);
        if(response.status===409&&value.code==='release_changed'&&/^[a-f0-9]{64}$/.test(value.sourceHash||'')&&attempt===0){remoteVersion=value.sourceHash;continue;}
        if(response.status===404&&value.code==='fastpath_miss'){const error=new Error('Search fastpath miss');error.miss=true;throw error;}
        if(!response.ok||value.ok!==true||value.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(value.sourceHash||'')||value.query!==canonical(query)||value.category!==category||value.brand!==brand||value.offset!==offset||value.limit!==limit||!Array.isArray(value.results)||!Number.isSafeInteger(value.total)||value.total<0||value.results.length!==Math.min(limit,Math.max(0,value.total-offset)))throw new Error('Invalid search fastpath response');
        if(expectedRelease&&value.sourceHash!==expectedRelease)throw new Error('Search release mismatch');
        const ids=new Set();
        for(const row of value.results){if(!row||typeof row.id!=='string'||ids.has(row.id)||!['card','box'].includes(row.kind)||category!=='all'&&row.kind!==category||row.language!=='ja'||!['pokemon','onepiece'].includes(row.brand)||typeof row.name!=='string'||typeof row.displayName!=='string'||typeof row.href!=='string')throw new Error('Invalid search result');ids.add(row.id);}
        remoteVersion=value.sourceHash;return {results:value.results,total:value.total};
      }
      throw new Error('Search release changed repeatedly');
    }finally{clearTimeout(timeout);if(remotePending.get(lane)===job)remotePending.delete(lane);}
  }
  async function search(query,options={}) {
    const lane=options.lane||'global',requestId=++queryVersion;latest.set(lane,requestId);
    remotePending.get(lane)?.controller.abort();
    const current=()=>latest.get(lane)===requestId;
    if(!String(query||'').trim())return {results:[],total:0,requestId};
    if(Date.now()>=remoteUnavailableUntil){
      try{
        const result=await remoteSearch(query,options,lane,requestId);
        return current()?{...result,requestId}:{results:[],total:0,requestId,cancelled:true};
      }catch(error){
        if(!current())return {results:[],total:0,requestId,cancelled:true};
        if(!error.miss)remoteUnavailableUntil=Date.now()+30000;
      }
    }
    if(!worker&&!engine&&!ready){await new Promise(resolve=>setTimeout(resolve,240));if(!current())return {results:[],total:0,requestId,cancelled:true};}
    await warmLocal();
    if(!current())return {results:[],total:0,requestId,cancelled:true};
    let result;
    if(worker){
      try {result=await request('search',{query,options});}
      catch(error){stopWorker(error);if(error.code==='SEARCH_SNAPSHOT')throw error;await fallback();ready=Promise.resolve({size:engine.size});}
    }
    if(!result){await yieldTask();if(!current())return {results:[],total:0,requestId,cancelled:true};result=engine.search(query,options);}
    return current()?{...result,requestId}:{results:[],total:0,requestId,cancelled:true};
  }
  function cancel(lane='global'){latest.set(lane,++queryVersion);remotePending.get(lane)?.controller.abort();}
  function reset(){latest.clear();queryVersion++;for(const job of remotePending.values())job.controller.abort();remotePending.clear();remoteVersion=null;remoteUnavailableUntil=0;stopWorker(new Error('Search reset'));ready=null;engine=null;fallbackReady=null;}
  window.CardSearchClient={warm,search,cancel,reset};
})();
