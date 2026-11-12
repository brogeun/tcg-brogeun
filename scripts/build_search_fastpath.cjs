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
// Allow slower CI workers to finish all queries; physical budgets stay fixed.
const DEFAULT_BUILD_MS=240000;
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

function compileFastpath(snapshot,{queries,maxQueries=1000,maxResults=60,maxAcceleratedResults=600,maxBuildMs=DEFAULT_BUILD_MS}={}){
  if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.rows)||!snapshot.rows.length||typeof snapshot.sourceHash!=='string')throw Error('Invalid source search snapshot');
  if(maxResults!==60)throw Error('Search result page size must remain 60');
  if(![300,600].includes(maxAcceleratedResults))throw Error('Search acceleration coverage must be explicitly 300 or 600 results');
  const started=Date.now(),engine=engineAPI.create(snapshot),selected=queries||commonQueries(snapshot,{maxQueries});
  const entries=[],known=new Set(),rows=new Map(),pages=new Map();let queryCount=0;
  for(const query of selected){
    if(queryCount>0&&Date.now()-started>=maxBuildMs)throw Error('Search build time budget exceeded; refusing to reduce common-query coverage');
    const normalized=keyFor(query);if(known.has(normalized))continue;known.add(normalized);
    // Compute exact complete scopes once at build time, never in the Pages isolate.
    const scopes=engine.precompute(query,Infinity);
    for(const category of ['all','card','box']){
      const result=scopes[category],pageHashes=[];
      for(let offset=0;offset<Math.min(result.results.length,maxAcceleratedResults);offset+=maxResults){
        const publicRows=result.results.slice(offset,offset+maxResults).map(row=>{
          const id=String(row.id);if(!rows.has(id))rows.set(id,publicRow(row));return rows.get(id);
        });
        const encoded=JSON.stringify(publicRows);
        if(Buffer.byteLength(encoded)>500*1024)throw Error('A search result page exceeds the response byte budget');
        const hash=sha('page\0'+encoded);pageHashes.push(hash);
        if(!pages.has(hash))pages.set(hash,{hash,ids:publicRows.map(row=>String(row.id))});
      }
      const key=keyFor(query,category);
      // The first-page references also let audits compare the former accelerator byte for byte.
      entries.push({hash:sha(key),key,total:result.total,pageHashes,rows:result.results.slice(0,maxResults).map(row=>rows.get(String(row.id)))});
    }
    queryCount++;
  }
  if(!queryCount)throw Error('No complete fastpath query');
  const sourceHash=sha(snapshot.sourceHash+'\0'+fs.readFileSync(require.resolve('../assets/card-search-engine.js'))+'\0'+fs.readFileSync(__filename)+'\0'+JSON.stringify(entries.map(entry=>entry.key)));
  return {schemaVersion:2,sourceHash,catalogueHash:snapshot.sourceHash,rowCount:engine.size,maxResults,maxAcceleratedResults,queryCount,entries,pages,rows,
    coverage:{queries:queryCount,scopes:entries.length,requested:known.size,complete:true},buildMs:Date.now()-started};
}

function writeFastpath(compiled,directory,{maxShardBytes=900*1024,targetShardBytes=512*1024,maxFiles=192}={}){
  const headerBytes=Buffer.byteLength(JSON.stringify({schemaVersion:2,sourceHash:compiled.sourceHash,rows:{},queries:{},pages:{}}))+1;
  const rowBytes=new Map([...compiled.rows].map(([id,row])=>[id,Buffer.byteLength(JSON.stringify(id)+':'+JSON.stringify(row))+1]));
  const pageBytes=page=>Buffer.byteLength(JSON.stringify(page.hash)+':'+JSON.stringify({ids:page.ids}))+1;
  const bodyFor=(queries,pages)=>{
    const rows=Object.create(null),queryMap=Object.create(null),pageMap=Object.create(null);
    for(const query of queries)queryMap[query.hash]=query.value;
    for(const page of pages){pageMap[page.hash]={ids:page.ids};for(const id of page.ids)rows[id]=compiled.rows.get(id);}
    return JSON.stringify({schemaVersion:2,sourceHash:compiled.sourceHash,rows,queries:queryMap,pages:pageMap})+'\n';
  };
  function plan(limit){
    const bins=[],rowBins=new Map(),locations=new Map();
    // Page locations are explicit in descriptors, so exact pages can share
    // physical row dictionaries instead of being scattered by random hash prefixes.
    for(const page of compiled.pages.values()){
      const shares=new Map(),base=pageBytes(page);let full=base;
      for(const id of page.ids){const bytes=rowBytes.get(id);full+=bytes;for(const bin of rowBins.get(id)||[])shares.set(bin,(shares.get(bin)||0)+bytes);}
      const candidates=[...shares].sort((a,b)=>b[1]-a[1]||a[0].index-b[0].index);
      const fits=(bin,shared)=>bin.bytes+full-shared<=limit;
      let selected=candidates.find(([bin,shared])=>fits(bin,shared))?.[0];
      if(!selected)selected=bins.filter(bin=>!shares.has(bin)&&fits(bin,0)).sort((a,b)=>b.bytes-a.bytes)[0];
      if(!selected){selected={index:bins.length,bytes:headerBytes,rowBytes:0,rows:new Set(),pages:[]};bins.push(selected);}
      const added=full-(shares.get(selected)||0);if(selected.bytes+added>maxShardBytes)throw Error('A single search page exceeds its shard byte budget');
      selected.bytes+=added;selected.rowBytes+=full-base-(shares.get(selected)||0);selected.pages.push(page);locations.set(page.hash,selected.index);
      for(const id of page.ids)if(!selected.rows.has(id)){selected.rows.add(id);if(!rowBins.has(id))rowBins.set(id,[]);rowBins.get(id).push(selected);}
    }
    const records=compiled.entries.map(entry=>({hash:entry.hash,value:{key:entry.key,total:entry.total,pages:entry.pageHashes.map(hash=>[hash,locations.get(hash)])}}));
    const leaves=[];
    function split(prefix,items){const bytes=Buffer.byteLength(bodyFor(items,[]));if(bytes<=maxShardBytes){leaves.push({prefix,items,bytes});return;}if(prefix.length>=16)throw Error('A single search descriptor exceeds its byte budget');const groups=new Map();for(const item of items){const key=item.hash.slice(0,prefix.length+1);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}for(const [key,group]of groups)split(key,group);}
    const groups=new Map();for(const item of records){const key=item.hash.slice(0,2);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}for(const [prefix,items]of groups)split(prefix,items);
    if(leaves.length>1024)throw Error('Search lookup-prefix budget exceeded');
    const descriptors=[];
    for(const leaf of leaves.sort((a,b)=>b.bytes-a.bytes||a.prefix.localeCompare(b.prefix))){let bin=descriptors.find(bin=>bin.bytes+leaf.bytes<=limit);if(!bin){bin={bytes:0,leaves:[]};descriptors.push(bin);}bin.bytes+=leaf.bytes;bin.leaves.push(leaf);}
    return {bins,descriptors};
  }
  let planned=plan(Math.min(targetShardBytes,maxShardBytes));
  if(planned.bins.length+planned.descriptors.length>=maxFiles)planned=plan(maxShardBytes);
  if(planned.bins.length+planned.descriptors.length>=maxFiles)throw Error('Search fastpath exceeds its '+maxFiles+'-file asset budget ('+planned.bins.length+' page packs + '+planned.descriptors.length+' descriptor packs); common-query coverage was not reduced');
  const outputs=[],shards={},pageShards=[];
  function output(text,index){const bytes=Buffer.byteLength(text);if(bytes>maxShardBytes)throw Error('Search shard exceeds byte budget');const file='queries-'+index.toString(16).padStart(2,'0')+'-'+sha(text).slice(0,20)+'.json';outputs.push({file,text,bytes});return {path:'/data/search-fastpath/'+file,bytes};}
  for(const bin of planned.bins)pageShards.push(output(bodyFor([],bin.pages),outputs.length));
  for(const bin of planned.descriptors){const entry=output(bodyFor(bin.leaves.flatMap(leaf=>leaf.items),[]),outputs.length);for(const leaf of bin.leaves)shards[leaf.prefix]=entry;}
  const manifest={schemaVersion:2,sourceHash:compiled.sourceHash,catalogueHash:compiled.catalogueHash,rowCount:compiled.rowCount,maxResults:compiled.maxResults,maxAcceleratedResults:compiled.maxAcceleratedResults,queryCount:compiled.queryCount,coverage:compiled.coverage,shards,pageShards};
  const text=JSON.stringify(manifest)+'\n';if(Buffer.byteLength(text)>128*1024)throw Error('Search fastpath manifest exceeds byte budget');
  // Validate the complete physical plan before touching the current publication.
  fs.mkdirSync(directory,{recursive:true});for(const item of outputs)fs.writeFileSync(path.join(directory,item.file),item.text);fs.writeFileSync(path.join(directory,'manifest.json'),text);
  const written=new Set(outputs.map(item=>item.file));for(const file of fs.readdirSync(directory))if(/^queries-[a-f0-9]{2,16}-[a-f0-9]{20}\.json$/.test(file)&&!written.has(file))fs.unlinkSync(path.join(directory,file));
  return {queryCount:compiled.queryCount,maxAcceleratedResults:compiled.maxAcceleratedResults,scopes:compiled.entries.length,pages:compiled.pages.size,pagePacks:planned.bins.length,descriptorPacks:planned.descriptors.length,shards:outputs.length,totalBytes:outputs.reduce((a,b)=>a+b.bytes,Buffer.byteLength(text)),maxShardBytes:Math.max(...outputs.map(item=>item.bytes)),manifestBytes:Buffer.byteLength(text),buildMs:compiled.buildMs,coverage:compiled.coverage};
}

if(require.main===module){
  try{
    const arg=(name,fallback)=>{const at=process.argv.indexOf(name);return at>=0?process.argv[at+1]:fallback;};
    const root=path.resolve(__dirname,'..'),snapshot=readSnapshot(path.resolve(arg('--snapshot',path.join(root,'data/search-index-ja.json'))));
    const out=path.resolve(arg('--out',path.join(root,'data/search-fastpath')));
    const compiled=compileFastpath(snapshot,{maxQueries:Number(arg('--max-queries',1000)),maxAcceleratedResults:Number(arg('--max-accelerated-results',600)),maxBuildMs:Number(arg('--max-build-ms',DEFAULT_BUILD_MS))});
    if(!compiled.coverage.complete)console.warn('Search fastpath build budget retained '+compiled.coverage.queries+'/'+compiled.coverage.requested+' complete queries; all remaining queries use the complete legacy fallback.');
    console.log(JSON.stringify({output:out,sourceHash:compiled.sourceHash,...writeFastpath(compiled,out)}));
  }catch(error){console.error(error.stack||String(error));process.exitCode=1;}
}
module.exports={keyFor,publicRow,readSnapshot,commonQueries,compileFastpath,writeFastpath};
