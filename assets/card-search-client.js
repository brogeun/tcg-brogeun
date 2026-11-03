/* A single lazy worker shared by search entry points. Compatibility work yields to input. */
(() => {
  'use strict';
  const version='20261103-search1';
  let worker=null,ready=null,engine=null,fallbackReady=null,sequence=0,queryVersion=0,engineScript;
  const pending=new Map(),latest=new Map();
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
  function warm() {
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
  async function search(query,options={}) {
    const lane=options.lane||'global',requestId=++queryVersion;latest.set(lane,requestId);
    const current=()=>latest.get(lane)===requestId;
    if(!String(query||'').trim())return {results:[],total:0,requestId};
    await warm();
    if(!current())return {results:[],total:0,requestId,cancelled:true};
    let result;
    if(worker){
      try {result=await request('search',{query,options});}
      catch(error){stopWorker(error);if(error.code==='SEARCH_SNAPSHOT')throw error;await fallback();ready=Promise.resolve({size:engine.size});}
    }
    if(!result){await yieldTask();if(!current())return {results:[],total:0,requestId,cancelled:true};result=engine.search(query,options);}
    return current()?{...result,requestId}:{results:[],total:0,requestId,cancelled:true};
  }
  function cancel(lane='global'){latest.set(lane,++queryVersion);}
  function reset(){latest.clear();queryVersion++;stopWorker(new Error('Search reset'));ready=null;engine=null;fallbackReady=null;}
  window.CardSearchClient={warm,search,cancel,reset};
})();
