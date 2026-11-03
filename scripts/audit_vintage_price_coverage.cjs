'use strict';
// Exercise the production identity/artwork/price pipeline against exact snapshots.
// This is an offline coverage audit. It never invents a quote or sends shop requests.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js');
const repairs=require('../assets/card-catalog-repairs.js');repairs.configure(read('data/card-catalog-repairs.json'));
const originalProducts=read('data/all-cards.json').details,products=repairs.products(originalProducts);
const artwork=read('data/contained-card-market-links.json');
const detailPath=fs.existsSync(path.join(root,'data/cards-detail.json'))?'data/cards-detail.json':'.cache/price-vintage/cards-detail.json';
const details=read(detailPath);
const japanese=read('data/japanese-catalog.json'),sourceReferences=new Map();
for(const card of japanese.cards){const url=card.sourceUrl||card.url;if(!url)continue;const key=String(card.boxCode||card.setCode).toUpperCase()+'|'+url;sourceReferences.set(key,sourceReferences.has(key)?null:card);}
const source=fs.readFileSync(path.join(root,'assets/contained-card-prices.js'),'utf8');
if(!source.includes('return {hydrate,prepareTarget,targetFor,'))throw Error('Audit export requires review after a production module change');
const context={console,URL,AbortSignal,CardCatalogRepairs:repairs};vm.createContext(context);
vm.runInContext(source.replace('return {hydrate,prepareTarget,targetFor,','return {hydrate,prepareTargets,prepareTarget,targetFor,'),context);
const bridge=context.ContainedCardPrices,resolver=match.createResolver(products);
const selected=process.argv.slice(2);
const defaultCodes=fs.existsSync(path.join(root,'.cache/vintage-box-integrity.json'))
 ?read('.cache/vintage-box-integrity.json').imageHttpSamples.filter(row=>row.status!==200).map(row=>row.code)
 :read('data/pokemon-vintage-image-repairs.json').images.map(row=>row.setCode);
const codes=selected.length?selected:[...new Set(defaultCodes)].sort();
if(codes.some(code=>!/^[A-Za-z0-9_-]+$/.test(code)))throw Error('Unsafe set code');
const services={match,loadProducts:async()=>products,loadArtworkBindings:async()=>artwork,loadDetails:async()=>details,loadOverrides:async()=>({})};
const count=(obj,key)=>obj[key]=(obj[key]||0)+1;
async function main(){
 const rows=[];let totalCards=0;
 for(const code of codes){
  const source=repairs.setCards(read('data/cards-by-set/'+code+'.json'),code);
  const identities=source.cards.map(card=>{
   const reference=sourceReferences.get(code.toUpperCase()+'|'+String(card.url||card.sourceUrl||''));
   return {...card,brand:'pokemon',language:'ja',boxCode:code,setCode:String(card.setCode||code).toUpperCase(),
    number:card.number||'',baseNumber:card.baseNumber||'',fullId:card.fullId||'',id:card.id||'',
    image:card.image||'',name:card.name||'',bundle:!!card.isBundle,unprintedNumber:!!(card.unprintedNumber||reference?.unprintedNumber)};
  });
  const targets=await bridge.prepareTargets(identities,{services}),proofs=bridge.reviewedArtworkLinks(targets,products,artwork,match);
  const row={code,cards:targets.length,statuses:{},autoMatched:0,artworkVerifiedMatched:0,catalogMinPricePositive:0,rawDetailPositive:0,
   resolvedSnapshotPriceAvailable:0,printedFractions:0,numberMissing:0,unprintedNumber:0,priceStatuses:{},pendingExamples:[]};
  totalCards+=targets.length;
  for(const target of targets){
   count(row.statuses,target.snkrdunkStatus||'unknown');
   if(/\d+\/\d+/.test(target.number||''))row.printedFractions++;
   if(!target.number)row.numberMissing++;
   if(target.unprintedNumber)row.unprintedNumber++;
   if(target.snkrdunkStatus==='matched'){
    if(proofs[match.artworkKey(target)])row.artworkVerifiedMatched++;else row.autoMatched++;
    const original=products.find(p=>String(p.id)===String(target.snkrdunkId));
    if(original?.minPrice>0)row.catalogMinPricePositive++;
    if(target.snkrProduct?.grades?.raw?.lowest_ask>0)row.rawDetailPositive++;
    const quote=fallback.resolve(target);count(row.priceStatuses,quote.status+':'+(quote.reason||quote.source||'none'));
    if(quote.status==='priced')row.resolvedSnapshotPriceAvailable++;
   }else if(row.pendingExamples.length<8){
    row.pendingExamples.push({name:target.name,number:target.number,setCode:target.setCode,status:target.snkrdunkStatus,
      candidates:resolver.candidates(target).slice(0,3).map(p=>({id:p.id,name:p.name,number:p.productNumber}))});
   }
  }
  rows.push(row);console.log(JSON.stringify({code,cards:row.cards,statuses:row.statuses,priced:row.resolvedSnapshotPriceAvailable}));
 }
 const summary={sets:rows.length,cards:totalCards,statuses:{},autoMatched:0,artworkVerifiedMatched:0,catalogMinPricePositive:0,rawDetailPositive:0,resolvedSnapshotPriceAvailable:0,printedFractions:0,numberMissing:0,unprintedNumber:0};
 for(const row of rows){for(const [key,value] of Object.entries(row.statuses))summary.statuses[key]=(summary.statuses[key]||0)+value;for(const key of Object.keys(summary))if(typeof summary[key]==='number'&&!['sets','cards'].includes(key))summary[key]+=row[key]||0;}
 summary.linkedRate=Number(((summary.statuses.matched||0)/totalCards*100).toFixed(2));summary.snapshotPricedRate=Number((summary.resolvedSnapshotPriceAvailable/totalCards*100).toFixed(2));
 const report={baseline:'fbd6a2673b9f9b47601c0e46b83896e0eee61a39',observedAt:new Date().toISOString(),scope:'image-failing-old-Pokemon-sets',priceScope:'offline-snapshot-no-live-requests',summary,sets:rows};
 fs.mkdirSync(path.join(root,'.cache/price-vintage'),{recursive:true});
 fs.writeFileSync(path.join(root,'.cache/price-vintage/runtime-coverage.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({summary}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
