'use strict';
// A bounded, metadata-only projection of the same reviewed Japanese rows used
// by the search compiler. No catalogue, price or artwork source is rewritten.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {indexSetReferences}=require('../assets/japanese-catalog.js');
const VERSION='jp-set-metadata-v1';
const BUCKET_COUNT=16;
const MAX_BUCKET_BYTES=8*1024*1024;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const compare=(a,b)=>a<b?-1:a>b?1:0;

function compileSetMetadata(rows,{bucketCount=BUCKET_COUNT}={}){
  if(!Array.isArray(rows)||!Number.isInteger(bucketCount)||bucketCount<1||bucketCount>BUCKET_COUNT)throw Error('Invalid set-metadata inputs');
  const codes=new Set();
  for(const row of rows)if(row?._catalogue&&row.kind==='card'){
    const code=String(row.boxCode||row.setCode||'').toUpperCase();
    if(code)codes.add(code);
  }
  const groups=Array.from({length:bucketCount},()=>Object.create(null)),sets=Object.create(null);
  let referenceCount=0,ambiguousCount=0;
  for(const code of [...codes].sort(compare)){
    const refs=indexSetReferences(rows,code),encoded=[];
    for(const [url,ref] of [...refs].sort((a,b)=>compare(a[0],b[0]))){
      // A one-column row is an ambiguity tombstone, even if duplicate source
      // records agree. No name/number/product-ID fallback may revive it.
      if(!ref){encoded.push([url]);ambiguousCount++;continue;}
      const row=[url,typeof ref.rarity==='string'?ref.rarity:null];
      if(ref.unprintedNumber){row.push(true);if(ref.inventoryNumber!==undefined)row.push(ref.inventoryNumber);}
      encoded.push(row);
    }
    const bucket=parseInt(hash(code).slice(0,8),16)%bucketCount;
    sets[code]=bucket;groups[bucket][code]=encoded;referenceCount+=encoded.length;
  }
  const packs=groups.map((sets,bucket)=>{
    const content={schemaVersion:1,version:VERSION,bucket,sets};
    return {...content,contentHash:hash(JSON.stringify(content))};
  });
  return {packs,sets,setCount:codes.size,referenceCount,ambiguousCount};
}

function writeSetMetadata(rows,output,{publicPrefix='/data/japanese-set-metadata/',bucketCount=BUCKET_COUNT,maxBucketBytes=MAX_BUCKET_BYTES}={}){
  if(typeof publicPrefix!=='string'||!/^\/data\/japanese-set-metadata\/$/.test(publicPrefix))throw Error('Invalid metadata public prefix');
  const compiled=compileSetMetadata(rows,{bucketCount}),folder=path.join(path.dirname(output),'japanese-set-metadata');
  fs.mkdirSync(folder,{recursive:true});
  const buckets=[],current=new Set();let totalBytes=0,maximumBucketBytes=0;
  for(const pack of compiled.packs){
    const body=JSON.stringify(pack)+'\n',bytes=Buffer.byteLength(body);
    if(bytes>maxBucketBytes)throw Error('Set metadata bucket exceeds its asset budget');
    const filename='bucket-'+String(pack.bucket).padStart(2,'0')+'-'+hash(body).slice(0,20)+'.json';
    fs.writeFileSync(path.join(folder,filename),body);current.add(filename);totalBytes+=bytes;maximumBucketBytes=Math.max(maximumBucketBytes,bytes);
    buckets.push({url:publicPrefix+filename,contentHash:pack.contentHash,bytes});
  }
  const manifest={schemaVersion:1,version:VERSION,sourceHash:hash(JSON.stringify(compiled.packs.map(pack=>pack.contentHash))),
    setCount:compiled.setCount,referenceCount:compiled.referenceCount,ambiguousCount:compiled.ambiguousCount,buckets,sets:compiled.sets};
  const body=JSON.stringify(manifest)+'\n';
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,body);
  // This directory contains only disposable generated packs. An old digest must
  // not accumulate on every deployment and exhaust Pages' total asset count.
  for(const entry of fs.readdirSync(folder))if(/^bucket-\d{2}-[a-f0-9]{20}\.json$/.test(entry)&&!current.has(entry))fs.unlinkSync(path.join(folder,entry));
  return {manifest,files:buckets.length+1,manifestBytes:Buffer.byteLength(body),totalBytes:totalBytes+Buffer.byteLength(body),maximumBucketBytes};
}
module.exports={VERSION,BUCKET_COUNT,MAX_BUCKET_BYTES,compileSetMetadata,writeSetMetadata};
