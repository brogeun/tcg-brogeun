#!/usr/bin/env node
'use strict';

// A bounded, exact-query accelerator. Unknown queries and uncached pages keep
// the complete local search engine; no approximate result is published here.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const engineAPI=require('../assets/card-search-engine.js');
const keyFor=(query,category='all')=>JSON.stringify([String(query).normalize('NFKC').trim().toLowerCase(),category,'all']);
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const OMIT=new Set(['searchText','_searchText','_opSearch','nameLower','promoKeys']);
function publicRow(row){return Object.fromEntries(Object.entries(row).filter(([key])=>!OMIT.has(key)));}

function readSnapshot(filename){
  const snapshot=JSON.parse(fs.readFileSync(filename,'utf8'));
  if(!snapshot.shards)return snapshot;
  const base=path.dirname(filename);
  const parts=snapshot.shards.map(url=>{
    if(!/^\/data\/search-index-ja\/part-[\w-]+\.json$/.test(url))throw Error('Invalid search snapshot shard');
    const part=JSON.parse(fs.readFileSync(path.join(base,'search-index-ja',path.basename(url)),'utf8'));
    if(part.schemaVersion!==1||part.sourceHash!==snapshot.sourceHash||!Array.isArray(part.rows))throw Error('Mixed search snapshot');
    return part.rows;
  });
  const rows=parts.flat();if(rows.length!==snapshot.rowCount)throw Error('Incomplete search snapshot');
  return {...snapshot,rows};
}

function commonQueries(snapshot,{maxQueries=1000}={}){
  const rows=engineAPI.decode(snapshot),scores=new Map();
  function add(value,weight=1){
    const query=String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ');
    if(!query||query.length>48||!/[\p{L}\p{N}]/u.test(query)||/^\d+$/.test(query))return;
    const key=query.toLowerCase(),entry=scores.get(key);
    if(entry)entry.score+=weight;else scores.set(key,{query,score:weight});
  }
  const head=value=>String(value||'').split(/\s*\[/)[0].split(/\s*\(/)[0].replace(/\s+(?:SAR|SR|RRR?|AR|HR|UR|SSR|CHR|CSR|SA|SEC|SP|TR|PR|UC|C|L|P)(?:-P)?\s*$/i,'').trim();
  for(const row of rows){
    add(head(row.displayName),row.brand==='onepiece'?6:3);add(head(row.name),row.brand==='onepiece'?4:2);
    if(row.brand==='onepiece')add(head(row.name).replace(/\./g,' ').split(/\s+/).at(-1),5);
    if(row.kind==='box'){add(row.displayName,12);add(row.name,8);add(row.setCode,12);add(row.boxCode,12);}
  }
  const aliasGroups=new Map();
  for(const [key,values]of Object.entries(snapshot.aliases||{})){
    if(key.startsWith('_'))continue;
    const group=[key,...(Array.isArray(values)?values:[values])].filter(value=>typeof value==='string');
    for(const value of group){add(value,value===key?8:4);const folded=keyFor(value);if(!aliasGroups.has(folded))aliasGroups.set(folded,new Set());for(const alias of group)aliasGroups.get(folded).add(alias);}
  }
  // Identity-sensitive searches get exact compiled responses, too.
  for(const term of ['DON!!','DON','돈 카드','001/SV-P','OP01-001','OP-01 001'])add(term,10000);
  const ranked=[...scores.values()].sort((a,b)=>b.score-a.score||a.query.localeCompare(b.query));
  const chosen=new Map();
  function choose(query){if(query&&chosen.size<maxQueries)chosen.set(keyFor(query),query);}
  function family(query,prefixes=true){
    const names=[query,...(aliasGroups.get(keyFor(query))||[])];
    for(const name of names)choose(name);
    if(prefixes)for(const name of names)if(/^[\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(name))
      for(let length=1;length<Math.min(name.length,3);length++)choose(name.slice(0,length));
  }
  // Keep commonly used hub entry terms and their *existing* reviewed language
  // aliases together. No alias or product identity is invented by this seed.
  for(const query of ['피카츄','리자몽','뮤','뮤츠','이브이','블래키','님피아','팬텀','루기아','레쿠쟈','나미','루피','조로','샹크스','에이스','핸콕'])
    if(scores.has(query.toLowerCase()))family(query);
  // Sealed-set lookups have a small finite vocabulary and must not be pushed
  // out by hundreds of character-name spelling prefixes.
  for(const row of rows)if(row.kind==='box'){choose(row.setCode);choose(row.boxCode);}
  // Interleave roots and language families, reserving room for more finished
  // labels after the most frequently repeated card names and their prefixes.
  for(const {query}of ranked){if(chosen.size>=Math.floor(maxQueries*.85))break;family(query);}
  for(const entry of ranked)choose(entry.query);
  return [...chosen.values()];
}

function compileFastpath(snapshot,{queries,maxQueries=1000,maxResults=60,maxBuildMs=110000}={}){
  if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.rows)||!snapshot.rows.length||typeof snapshot.sourceHash!=='string')throw Error('Invalid source search snapshot');
  const started=Date.now(),engine=engineAPI.create(snapshot),selected=queries||commonQueries(snapshot,{maxQueries});
  const entries=[],known=new Set();let queryCount=0;
  for(const query of selected){
    // The budget is checked between complete queries. Every emitted query has
    // all three independently computed category scopes and exact full totals.
    if(queryCount>0&&Date.now()-started>=maxBuildMs)break;
    const normalized=keyFor(query);if(known.has(normalized))continue;known.add(normalized);
    const scopes=engine.precompute(query,maxResults);
    for(const category of ['all','card','box']){
      const result=scopes[category];
      const key=keyFor(query,category);
      entries.push({hash:sha(key),key,total:result.total,rows:result.results.map(publicRow)});
    }
    queryCount++;
  }
  if(!queryCount)throw Error('No complete fastpath query');
  const sourceHash=sha(snapshot.sourceHash+'\0'+fs.readFileSync(require.resolve('../assets/card-search-engine.js'))+'\0'+fs.readFileSync(__filename)+'\0'+JSON.stringify(entries.map(entry=>entry.key)));
  return {schemaVersion:1,sourceHash,catalogueHash:snapshot.sourceHash,rowCount:engine.size,maxResults,queryCount,entries,
    coverage:{queries:queryCount,scopes:entries.length,requested:selected.length,complete:queryCount===selected.length},buildMs:Date.now()-started};
}

function writeFastpath(compiled,directory,{maxShardBytes=900*1024,targetShardBytes=512*1024,maxFiles=192}={}){
  fs.mkdirSync(directory,{recursive:true});
  const shards={},sizes=[],written=new Set(),bodyFor=entries=>{
    const rows=Object.create(null),queries=Object.create(null);
    for(const entry of entries){
      const ids=entry.rows.map(row=>String(row.id));
      for(const row of entry.rows)rows[String(row.id)]=row;
      queries[entry.hash]={key:entry.key,total:entry.total,ids};
    }
    return JSON.stringify({schemaVersion:1,sourceHash:compiled.sourceHash,rows,queries})+'\n';
  };
  function write(prefix,entries,lookupPrefixes=[prefix]){
    const text=bodyFor(entries),bytes=Buffer.byteLength(text);
    if(bytes>maxShardBytes){
      if(prefix.length>=16)throw Error('A single fastpath query exceeds its byte budget');
      const groups=new Map();for(const entry of entries){const key=entry.hash.slice(0,prefix.length+1);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(entry);}
      for(const [key,group]of groups)write(key,group);return;
    }
    if(sizes.length>=maxFiles-1)throw Error('Search fastpath exceeds its '+maxFiles+'-file asset budget; reduce --max-queries before publication.');
    const file='queries-'+prefix+'-'+sha(text).slice(0,20)+'.json';
    fs.writeFileSync(path.join(directory,file),text);sizes.push(bytes);written.add(file);
    for(const lookup of lookupPrefixes)shards[lookup]={path:'/data/search-fastpath/'+file,bytes};
  }
  const groups=new Map();for(const entry of compiled.entries){const prefix=entry.hash.slice(0,2);if(!groups.has(prefix))groups.set(prefix,[]);groups.get(prefix).push(entry);}
  // Adjacent digest prefixes share a physical file. Keep the exact lookup
  // keys so every compiled query remains reachable; split only oversized pairs.
  for(let value=0;value<256;value+=2){
    const prefixes=[value,value+1].map(number=>number.toString(16).padStart(2,'0')).filter(prefix=>groups.has(prefix));
    if(!prefixes.length)continue;
    const entries=prefixes.flatMap(prefix=>groups.get(prefix));
    if(Buffer.byteLength(bodyFor(entries))<=targetShardBytes)write(value.toString(16).padStart(2,'0'),entries,prefixes);
    else for(const prefix of prefixes)write(prefix,groups.get(prefix));
  }
  const manifest={schemaVersion:1,sourceHash:compiled.sourceHash,catalogueHash:compiled.catalogueHash,rowCount:compiled.rowCount,maxResults:compiled.maxResults,queryCount:compiled.queryCount,coverage:compiled.coverage,shards};
  const text=JSON.stringify(manifest)+'\n';if(Buffer.byteLength(text)>128*1024)throw Error('Search fastpath manifest exceeds byte budget');
  fs.writeFileSync(path.join(directory,'manifest.json'),text);
  // Remove only obsolete files created by this generator after a valid new
  // manifest exists. Unknown files in the output directory are preserved.
  for(const file of fs.readdirSync(directory))if(/^queries-[a-f0-9]{2,16}-[a-f0-9]{20}\.json$/.test(file)&&!written.has(file))fs.unlinkSync(path.join(directory,file));
  return {queryCount:compiled.queryCount,scopes:compiled.entries.length,shards:sizes.length,totalBytes:sizes.reduce((a,b)=>a+b,Buffer.byteLength(text)),maxShardBytes:Math.max(...sizes),manifestBytes:Buffer.byteLength(text),buildMs:compiled.buildMs,coverage:compiled.coverage};
}

if(require.main===module){
  try{
    const arg=(name,fallback)=>{const at=process.argv.indexOf(name);return at>=0?process.argv[at+1]:fallback;};
    const root=path.resolve(__dirname,'..'),snapshot=readSnapshot(path.resolve(arg('--snapshot',path.join(root,'data/search-index-ja.json'))));
    const out=path.resolve(arg('--out',path.join(root,'data/search-fastpath')));
    const compiled=compileFastpath(snapshot,{maxQueries:Number(arg('--max-queries',1000)),maxBuildMs:Number(arg('--max-build-ms',110000))});
    if(!compiled.coverage.complete)console.warn('Search fastpath build budget retained '+compiled.coverage.queries+'/'+compiled.coverage.requested+' complete queries; all remaining queries use the complete legacy fallback.');
    console.log(JSON.stringify({output:out,sourceHash:compiled.sourceHash,...writeFastpath(compiled,out)}));
  }catch(error){console.error(error.stack||String(error));process.exitCode=1;}
}
module.exports={keyFor,publicRow,readSnapshot,commonQueries,compileFastpath,writeFastpath};
