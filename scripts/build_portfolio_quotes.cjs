#!/usr/bin/env node
'use strict';

// Build only public market quotes. No holdings, account IDs or personal records
// are read here; private totals are calculated by the authenticated endpoint.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createContext}=require('./build_search_snapshot.cjs');
const SHARDS=16;
const MAX_SHARD_BYTES=1024*1024;
const FIELDS=['isBox','psa10','psa10Currency','psa9','psa9Currency','raw','rawCurrency','box','boxCurrency'];

function bucket(id){let hash=2166136261;for(const c of String(id)){hash^=c.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0)%SHARDS;}
function latestHistory(points){
  const latest={psa10:null,psa9:null,raw:null};
  for(let i=points.length-1;i>=0;i--){
    for(const grade of Object.keys(latest))if(latest[grade]==null&&points[i]?.[grade+'_price'])latest[grade]=points[i][grade+'_price'];
    if(latest.psa10&&latest.psa9&&latest.raw)break;
  }
  return latest;
}
function makeQuote(id,products,details,histories,boxIds){
  const meta=products.get(String(id)),card=details?.cards?.[id],grades=card?.grades||null,detailProduct=card?.product||card||null;
  const history=histories.get(String(id))||{},pick=grade=>grades?.[grade]?.lowest_ask||grades?.[grade]?.recent_avg||history[grade]||null;
  let box=meta?.minPrice||null,boxCurrency=meta?.currency||'JPY';
  if(detailProduct?.lastPrice??detailProduct?.lowestAsk){box=detailProduct.lastPrice??detailProduct.lowestAsk;boxCurrency=detailProduct.currency||'JPY';}
  // The current browser converts even a history fallback with the corresponding
  // detail-grade currency. Preserve that existing rule, including its rounding.
  return [meta?.kind==='box'||boxIds.has(String(id)),pick('psa10'),grades?.psa10?.currency??null,
    pick('psa9'),grades?.psa9?.currency??null,pick('raw'),grades?.raw?.currency??null,box,boxCurrency];
}
function validateFX(fx){
  if(!fx||!['JPY','USD','CNY'].every(key=>typeof fx.rates?.[key]==='number'&&Number.isFinite(fx.rates[key])&&fx.rates[key]>0)
    ||!/^\d{4}-\d{2}-\d{2}$/.test(fx.asOf||'')||fx.basis!=='previous-business-day-close')throw Error('Complete daily FX snapshot required for portfolio quotes');
  return {rates:{JPY:fx.rates.JPY,USD:fx.rates.USD,CNY:fx.rates.CNY},asOf:fx.asOf,updated:fx.updated??null,basis:fx.basis};
}
function snapshotFromInputs({products,details={cards:{}},histories=new Map(),boxIds=new Set(),fx}){
  const productMap=new Map();for(const product of products)if(product?.id!=null&&!productMap.has(String(product.id)))productMap.set(String(product.id),product);
  const ids=[...new Set([...productMap.keys(),...Object.keys(details.cards||{}),...histories.keys(),...boxIds])].sort();
  const quotes=Object.fromEntries(ids.map(id=>[id,makeQuote(id,productMap,details,histories,boxIds)]));
  const rates=validateFX(fx),sourceHash=crypto.createHash('sha256').update(JSON.stringify({quotes,fx:rates})).digest('hex');
  return {schemaVersion:1,kind:'portfolio-quotes',sourceHash,generatedAt:new Date().toISOString(),rowCount:ids.length,shardCount:SHARDS,fields:FIELDS,fx:rates,quotes};
}
async function compilePortfolioSnapshot(root){
  const state=createContext(root);
  const products=await state.run('loadCardProductData()', 'portfolio-product-sources.js');
  if(state.missing.size)throw Error('Incomplete portfolio product sources: '+[...state.missing].sort().join(', '));
  if(state.run('PromoSearch.needsRetry()', 'portfolio-promo-status.js'))throw Error('Incomplete portfolio promotion supplement');
  const read=name=>JSON.parse(fs.readFileSync(path.join(root,'data',name+'.json'),'utf8'));
  const boxIds=new Set(),fallback=[];
  for(const brand of ['pokemon','onepiece']){
    for(const file of ['price-'+brand+'-box','manual-boxes-'+brand])for(const product of read(file).products||[])if(product.id)boxIds.add(String(product.id));
    // Same first-match order as fetchCardMeta() when the primary product pool
    // has no metadata for an older saved product ID.
    for(const file of ['price-'+brand+'-box','price-'+brand+'-card','top10-'+brand]){
      for(const product of read(file).products||[])fallback.push({id:String(product.id),name:product.name,thumbnailUrl:product.image,brand,
        minPrice:product.lastPrice??product.lowestAsk,currency:product.currency||'JPY',kind:file.includes('box')?'box':'card'});
    }
  }
  const histories=new Map(),historyRoot=path.join(root,'data/history');
  if(!fs.existsSync(historyRoot))throw Error('Complete public history directory required');
  // Each history is reduced immediately; the builder never retains all chart
  // points in memory and the runtime endpoint never downloads these files.
  for(const file of fs.readdirSync(historyRoot).sort()){
    if(!file.endsWith('.json'))continue;
    const data=JSON.parse(fs.readFileSync(path.join(historyRoot,file),'utf8'));
    histories.set(file.slice(0,-5),latestHistory(Array.isArray(data.history)?data.history:[]));
  }
  return snapshotFromInputs({products:[...products,...fallback],details:read('cards-detail'),histories,boxIds,fx:read('fx-rates')});
}
function writePortfolioSnapshot(snapshot,output){
  const directory=path.join(path.dirname(output),'portfolio-quotes');fs.mkdirSync(directory,{recursive:true});
  const groups=Array.from({length:SHARDS},()=>({}));
  for(const [id,quote] of Object.entries(snapshot.quotes))groups[bucket(id)][id]=quote;
  const shards=[];let totalBytes=0;
  for(let n=0;n<SHARDS;n++){
    const body=JSON.stringify({schemaVersion:1,sourceHash:snapshot.sourceHash,bucket:n,quotes:groups[n]})+'\n';
    const bytes=Buffer.byteLength(body);if(bytes>MAX_SHARD_BYTES)throw Error('Portfolio quote shard exceeds its public asset budget');
    const hash=crypto.createHash('sha256').update(body).digest('hex').slice(0,20),file='part-'+n.toString(16).padStart(2,'0')+'-'+hash+'.json';
    fs.writeFileSync(path.join(directory,file),body);shards.push({bucket:n,file:'/data/portfolio-quotes/'+file,rowCount:Object.keys(groups[n]).length});totalBytes+=bytes;
  }
  const {quotes,...manifest}=snapshot,body=JSON.stringify({...manifest,shards})+'\n';
  fs.writeFileSync(output,body);return {rowCount:snapshot.rowCount,shards:SHARDS,totalBytes:totalBytes+Buffer.byteLength(body),sourceHash:snapshot.sourceHash};
}
async function main(){
  const rootArg=process.argv.indexOf('--root'),outArg=process.argv.indexOf('--out');
  const root=path.resolve(rootArg>=0?process.argv[rootArg+1]:path.join(__dirname,'..'));
  const output=path.resolve(outArg>=0?process.argv[outArg+1]:path.join(root,'data/portfolio-quotes.json'));
  const snapshot=await compilePortfolioSnapshot(root);console.log(JSON.stringify(writePortfolioSnapshot(snapshot,output)));
}
if(require.main===module)main().catch(error=>{console.error(error.stack||String(error));process.exitCode=1;});
module.exports={FIELDS,SHARDS,MAX_SHARD_BYTES,bucket,latestHistory,makeQuote,validateFX,snapshotFromInputs,compilePortfolioSnapshot,writePortfolioSnapshot};
