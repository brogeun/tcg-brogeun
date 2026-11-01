/* Offline audit of the same exact-source rarity overlays used by the panels. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),R=require('../assets/card-rarity-filters.js');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const exists=file=>fs.existsSync(path.join(root,file));
function shardPayload(file,code){
  const data=read(file.replace(/^\//,'').split('?')[0]),entry=data.bundleVersion===1?data.sets?.[code.toUpperCase()]:data;
  return entry?.compactIdentity ? {...entry,cards:Object.fromEntries(Object.entries(entry.cards).map(([sourceUrl,c])=>[sourceUrl,{...c,sourceUrl,setCode:entry.setCode}]))}:entry;
}
const report={schemaVersion:1,observedAt:new Date().toISOString(),scope:'Panel rows, including separate printings and commercial aggregates. Counts are not deduplicated physical cards across boxes.',catalogues:{}};
function count(cards){
  const states={known:0,unknown:0,notApplicable:0,'source-unlisted':0};
  for(const c of cards){const s=R.metadata(c).state;states[s==='not-applicable'?'notApplicable':s]++;}
  return {total:cards.length,...states};
}
function record(name,sets){
  const totals={total:0,known:0,unknown:0,notApplicable:0,'source-unlisted':0};
  for(const s of sets)for(const k of Object.keys(totals))totals[k]+=s[k];
  report.catalogues[name]={...totals,sets:sets.length,unresolvedSets:sets.filter(s=>s.unknown).sort((a,b)=>b.unknown-a.unknown)};
}
const jp=read('data/japanese-catalog.json');
const pokemon=read('data/collections/sources/pokemon-jp-rarity-metadata.json');
const sets=[];
for(const s of jp.sets.filter(s=>s.brand==='pokemon')){
  const file='data/cards-by-set/'+(s.fileCode||s.code)+'.json';if(!exists(file))continue;
  const bySource=new Map();
  for(const c of jp.cards.filter(c=>c.kind==='card'&&String(c.boxCode||c.setCode||'').toUpperCase()===s.code.toUpperCase())){
    const source=c.sourceUrl||c.url;if(source)bySource.set(source,bySource.has(source)?null:c);
  }
  let cards=read(file).cards||[];
  cards=cards.map(c=>{const ref=bySource.get(c.url||c.sourceUrl);return ref&&!c.rarity?{...c,rarity:ref.rarity}:c;});
  cards=R.merge(cards,pokemon,{brand:'pokemon',setCode:s.code});
  const shard=pokemon.setShards?.[s.code.toUpperCase()];
  if(shard)cards=R.merge(cards,shardPayload(shard,s.code),{brand:'pokemon',setCode:s.code});
  sets.push({code:s.code,...count(cards)});
}
record('pokemon-ja',sets);
const op=read('data/collections/sources/onepiece-printing-metadata.json');
record('onepiece-ja',read('data/onepiece-official-manifest.json').sets.flatMap(s=>{
  const file='data/cards-by-set/'+(s.fileCode||s.code)+'.json';if(!exists(file))return [];
  return [{code:s.code,...count(R.merge(read(file).cards,op,{brand:'onepiece',setCode:s.code}))}];
}));
for(const kind of ['english','chinese','chiikawa','riftbound']){
  const supplement=kind==='english'&&exists('data/collections/sources/pokemon-en-rarity-recheck.json') ? read('data/collections/sources/pokemon-en-rarity-recheck.json') : null;
  record(kind,read('data/'+kind+'-catalog.json').sets.flatMap(s=>{
    const file='data/'+kind+'-sets/'+s.code+'.json';
    let cards=s.cards||(exists(file)?read(file).cards:null);
    if(cards&&supplement){cards=R.merge(cards,supplement,{brand:'pokemon-en',setCode:s.code});const shard=supplement.setShards?.[s.code.toUpperCase()];
      if(shard)cards=R.merge(cards,shardPayload(shard,s.code),{brand:'pokemon-en',setCode:s.code});}
    return cards?[{code:s.code,...count(cards)}]:[];
  }));
}
for(const g of read('data/tcg-card-info.json').games){
  const rows=[];
  for(const s of g.sets){
    const queue=[s.file],seen=new Set(),cards=[];
    while(queue.length){const f=queue.shift();if(seen.has(f))throw Error('Repeated shard '+f);seen.add(f);
      const d=read(f.replace(/^\//,''));cards.push(...d.cards.map(c=>c.rarityStatus==='not_applicable'?{...c,rarityNotApplicable:true}:c));queue.push(...(d.shards||[]));}
    rows.push({code:s.id,...count(cards)});
  }
  record(g.id,rows);
}
const output=process.argv.indexOf('--output');
if(output>=0)fs.writeFileSync(path.resolve(process.argv[output+1]),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(report.catalogues).map(([k,{unresolvedSets,...v}])=>[k,v]))));
