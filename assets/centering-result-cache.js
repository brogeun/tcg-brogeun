/* Exact-input result reuse. Memory only; never stores request bodies or photos. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.CenteringResultCache=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const MAX_TTL=30*60*1000,MAX_ENTRIES=2;
  const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const ownerKey=value=>typeof value==='string'&&value.trim()?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):null;
  const hashKey=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)?value.toLowerCase():null;
  const validRevision=value=>Number.isSafeInteger(value)&&value>=0;
  const clone=value=>typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));

  function canonical(value,seen=new Set(),depth=0){
    if(depth>20)throw new TypeError('Request nesting is too deep');
    if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
    if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
    if(typeof value!=='object'||seen.has(value))throw new TypeError('Request is not JSON data');
    const proto=Object.getPrototypeOf(value);
    if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)throw new TypeError('Request is not a plain object');
    seen.add(value);
    const text=Array.isArray(value)?'['+value.map(item=>canonical(item,seen,depth+1)).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key],seen,depth+1)).join(',')+'}';
    seen.delete(value);return text;
  }
  function containsInput(value,seen=new Set(),depth=0){
    if(depth>20)return true;
    if(typeof value==='string')return /^data:image\//i.test(value)||value.length>100&&/^(?:\/9j\/|iVBORw0KGgo)/.test(value);
    if(!value||typeof value!=='object')return false;
    if(seen.has(value))return true;seen.add(value);
    const found=Object.keys(value).some(key=>/^(?:frontImage|backImage|detailImages|requestBody|request|image_url|imageData|dataURL|photo|body|image)$/i.test(key)||containsInput(value[key],seen,depth+1));
    seen.delete(value);return found;
  }
  function cacheable(response){
    return record(response)&&!Object.hasOwn(response,'error')&&record(response.analysis)&&['ready','partial','retake'].includes(response.analysis.status)&&!containsInput(response);
  }

  function create(options={}){
    const ttl=Number.isFinite(options.ttlMs)&&options.ttlMs>0?Math.min(MAX_TTL,options.ttlMs):MAX_TTL;
    const capacity=Number.isSafeInteger(options.maxEntries)&&options.maxEntries>0?Math.min(MAX_ENTRIES,options.maxEntries):MAX_ENTRIES;
    const now=typeof options.now==='function'?options.now:Date.now;
    const digest=typeof options.digest==='function'?options.digest:bytes=>globalThis.crypto.subtle.digest('SHA-256',bytes);
    const entries=new Map();let selectedOwner=null;
    const time=()=>{try{const value=now();return typeof value==='number'&&Number.isFinite(value)?value:NaN;}catch{return NaN;}};
    function clear(){entries.clear();}
    function selectOwner(value){const next=ownerKey(value);if(next!==selectedOwner){clear();selectedOwner=next;}return selectedOwner;}
    const authorized=value=>selectedOwner!==null&&ownerKey(value)===selectedOwner;
    function purge(){const timestamp=time();if(!Number.isFinite(timestamp)){clear();return null;}for(const [hash,entry] of entries)if(entry.expiresAt<=timestamp)entries.delete(hash);return timestamp;}
    function touch(hash,entry){entries.delete(hash);entries.set(hash,entry);}
    function copy(hash,entry){try{const result=clone(entry.response);touch(hash,entry);return result;}catch{entries.delete(hash);return null;}}
    function get(value,hash){if(!authorized(value)||purge()===null)return null;const key=hashKey(hash),entry=key&&entries.get(key);return entry?copy(key,entry):null;}
    function getRevision(value,revision){
      if(!authorized(value)||!validRevision(revision)||purge()===null)return null;
      for(const [hash,entry] of entries)if(entry.revision===revision)return copy(hash,entry);
      return null;
    }
    function bindRevision(value,hash,revision){
      if(!authorized(value)||!validRevision(revision)||purge()===null)return false;
      const key=hashKey(hash),entry=key&&entries.get(key);if(!entry)return false;
      for(const other of entries.values())if(other!==entry&&other.revision===revision)other.revision=null;
      entry.revision=revision;touch(key,entry);return true;
    }
    function put(value,hash,revision,response){
      if(!authorized(value)||!validRevision(revision))return false;
      const timestamp=purge(),key=hashKey(hash);if(timestamp===null||!key)return false;
      let saved;try{if(!cacheable(response))return false;saved=clone(response);}catch{return false;}
      const prior=entries.get(key),expiresAt=prior?prior.expiresAt:timestamp+ttl;
      for(const other of entries.values())if(other.revision===revision)other.revision=null;
      touch(key,{response:saved,revision,expiresAt});
      while(entries.size>capacity)entries.delete(entries.keys().next().value);
      return true;
    }
    async function fingerprint(requestBody){
      try{
        const bytes=new TextEncoder().encode(canonical(requestBody));
        const result=await digest(bytes);
        const hash=result instanceof ArrayBuffer?new Uint8Array(result):ArrayBuffer.isView(result)?new Uint8Array(result.buffer,result.byteOffset,result.byteLength):null;
        return hash?.byteLength===32?Array.from(hash,value=>value.toString(16).padStart(2,'0')).join(''):null;
      }catch{return null;}
    }
    // get/getRevision return cloned responses. bindRevision reuses a hash after reupload.
    // selectOwner(null) clears account data. Reuse never extends the original TTL.
    return {selectOwner,getRevision,fingerprint,get,put,bindRevision,clear};
  }
  return {create};
});
