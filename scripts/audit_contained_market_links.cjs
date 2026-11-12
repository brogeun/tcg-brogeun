'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const options=require('node:util').parseArgs({options:{root:{type:'string'},'inventory-audit':{type:'string'},'output-dir':{type:'string'}}}).values;
const root=path.resolve(options.root||process.cwd()),work=path.resolve(options['output-dir']||path.join(root,'.cache/unresolved-audit'));
fs.mkdirSync(work,{recursive:true});
const read=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
const old=JSON.parse(fs.readFileSync(path.resolve(options['inventory-audit']||path.join(work,'box-audit.json')),'utf8'));
const match=require(path.join(root,'assets/contained-card-match.js')),fallback=require(path.join(root,'assets/card-price-fallback.js'));
const repairs=require(path.join(root,'assets/card-catalog-repairs.js'));repairs.configure(read('data/card-catalog-repairs.json'));
const products=repairs.products(read('data/all-cards.json').details),base=read('data/contained-card-market-links.json'),promo=read('data/onepiece-reviewed-promo-links.json');
const artwork=require(path.join(root,'assets/contained-card-prices.js')).mergeArtworkBindings(base,promo,read('data/contained-printing-reviews.json'));
const pokemonFallbackPath=path.join(root,'data/pokemon-reviewed-fallback-links.json'),pokemonFallback=fs.existsSync(pokemonFallbackPath)?read('data/pokemon-reviewed-fallback-links.json'):{},pokemonBindings=pokemonFallback.schemaVersion===1&&pokemonFallback.source==='pokemon-original-image-audit'?pokemonFallback.bindings||{}:{};
const yuyuPath=path.join(root,'data/yuyutei-market/pokemon.json'),pokemonRows=fs.existsSync(yuyuPath)?fallback.decodeYuyu(read('data/yuyutei-market/pokemon.json')):[];
const candidateResolver=match.createResolver(products),savedDetails=read('data/cards-detail.json'),savedOverrides=read('data/onepiece-card-overrides.json');
const code=fs.readFileSync(path.join(root,'assets/contained-card-prices.js'),'utf8');
if(!code.includes('return {hydrate,prepareTarget,targetFor,'))throw Error('Production export changed');
const ctx={console,URL,AbortSignal,CardCatalogRepairs:{...repairs,quoteProduct:async product=>product}};vm.createContext(ctx);
vm.runInContext(code.replace('return {hydrate,prepareTarget,targetFor,','return {hydrate,prepareTargets,prepareTarget,targetFor,'),ctx);
const services={match,loadProducts:async()=>products,loadArtworkBindings:async()=>artwork,loadDetails:async()=>savedDetails,loadOverrides:async()=>savedOverrides,loadSetProducts:async()=>read('data/onepiece-eb05-market.json').products,loadSetCards:async()=>read('data/cards-by-set/EB05.json').cards,loadLiveQuote:async()=>{throw Error('Snapshot audit; no live request');}};
const report={observedAt:new Date().toISOString(),scope:'Japanese saved snapshots, all production artwork registries; price absence is not a live no-listing claim',artworkRegistries:{base:base.links.length,promo:promo.links?.length||0},sets:[]};
const pending=[],inc=(o,k)=>o[k]=(o[k]||0)+1;
const asset=u=>{try{const v=new URL(u);return v.hostname==='cdn.snkrdunk.com'?v.origin+v.pathname:'';}catch{return '';}};
async function main(){
 for(const row of old.rows){
  if(!['pokemon-ja','onepiece-ja'].includes(row.group))continue;
  const brand=row.group==='pokemon-ja'?'pokemon':'onepiece',doc=repairs.setCards(read(row.inventoryFiles[0]),row.code);
  const identities=doc.cards.map(c=>({...c,brand,language:'ja',boxCode:row.code,setCode:c.setCode||row.code,number:c.number||'',baseNumber:c.baseNumber||'',fullId:c.fullId||'',bundle:!!c.isBundle}));
  const targets=await ctx.ContainedCardPrices.prepareTargets(identities,{services}),result={group:row.group,code:row.code,cards:targets.length,links:{},quotes:{}};
  for(let i=0;i<targets.length;i++){
   const t=targets[i],q=fallback.resolve(t,{yuyuRows:t.brand==='pokemon'?pokemonRows:[],bindings:t.brand==='pokemon'?pokemonBindings:{}});inc(result.links,t.snkrdunkStatus||'unlinked');inc(result.quotes,q.status+':'+(q.reason||q.source||'none'));
   if(!['matched','verified-link','variant-linked'].includes(t.snkrdunkStatus)){
    const candidates=t.marketCandidates||candidateResolver.candidates(t);
    pending.push({group:row.group,code:row.code,status:t.snkrdunkStatus,reviewedFallbackSource:q.status==='priced'&&q.source==='yuyutei'&&q.verification==='exact_printing'?q.source:null,target:identities[i],candidates,exactAssetCandidates:candidates.filter(p=>asset(t.image)&&asset(t.image)===asset(p.thumbnailUrl||p.image)).map(p=>p.id)});
   }
  }
  report.sets.push(result);
  if(report.sets.length%20===0){fs.writeFileSync(path.join(work,'pending-current.json'),JSON.stringify(pending));fs.writeFileSync(path.join(work,'audit-current.json'),JSON.stringify(report));console.log(JSON.stringify({sets:report.sets.length,pending:pending.length,latest:row.code}));}
 }
 report.heldSnkrLinks=pending.filter(r=>!r.target.bundle&&r.status!=='paired-product').length;
 report.heldAutomaticLinks=pending.filter(r=>!r.target.bundle&&r.status!=='paired-product'&&!r.reviewedFallbackSource).length;
 report.reviewedFallbackMemberships=pending.filter(r=>!!r.reviewedFallbackSource).length;
 report.excludedBundleMemberships=pending.filter(r=>r.target.bundle||r.status==='paired-product').length;
 fs.writeFileSync(path.join(work,'pending-current.json'),JSON.stringify(pending));fs.writeFileSync(path.join(work,'audit-current.json'),JSON.stringify(report));
 const summary={};for(const s of report.sets){const t=summary[s.group]||(summary[s.group]={sets:0,cards:0,links:{}});t.sets++;t.cards+=s.cards;for(const[k,v]of Object.entries(s.links))t.links[k]=(t.links[k]||0)+v;}
 fs.writeFileSync(path.join(work,'audit-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({summary,exactAssets:pending.filter(p=>p.exactAssetCandidates.length).length}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
