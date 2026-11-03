/* The worker owns snapshot parsing and query work, leaving taps and scrolling free. */
'use strict';
importScripts('/assets/card-search-engine.js?v=20261104-search3');
let ready;
async function snapshotJSON(signal) {
  async function read(path,cache) {
    const response=await fetch(path,{cache,signal});
    if(!response.ok)throw new Error('Search snapshot HTTP '+response.status);
    return response.json();
  }
  const snapshot=await read('/data/search-index-ja.json?v=20261104-search3','no-cache');
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
function load() {
  if (!ready) ready = (async () => {
    const controller = new AbortController(), timeout=setTimeout(()=>controller.abort(),40000);
    try {
      return CardSearchEngine.create(await snapshotJSON(controller.signal));
    } finally {clearTimeout(timeout);controller.abort();}
  })().catch(error=>{ready=null;throw error;});
  return ready;
}
self.onmessage=async event=>{
  const {type,id,query,options}=event.data||{};
  if(type!=='init'&&type!=='search')return;
  try {
    const engine=await load();
    const result=type==='init'?{size:engine.size}:engine.search(query,options);
    self.postMessage({id,result});
  } catch(error) {self.postMessage({id,error:String(error?.message||'검색 데이터를 불러오지 못했어요.')});}
};
