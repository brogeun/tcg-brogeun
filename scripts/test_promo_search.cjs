'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const {eligibility, build, retainAndSupplement} = require('./build_promo_search.cjs');
const source = fs.readFileSync(path.join(root,'assets/promo-search.js'),'utf8');
const dataset = JSON.parse(fs.readFileSync(path.join(root,'data/promo-search.json'),'utf8'));
const existing = {id:'671486',name:'Pikachu P [M-P 020](Promo Card Pack "McDonald\'s Happy Set 2025")',nameLower:'pikachu p [m-p 020]',productNumber:'pkmn-tcg-m-p-020',brand:'pokemon',kind:'card',minPrice:777,currency:'JPY',listingCount:55,thumbnailUrl:'/existing-image.webp'};
function context(fail=false) {
  let broken=fail;
  const ctx={window:{},AbortSignal,console:{warn:()=>{}},fetch:async url=>{
    if(url.includes('promo-search.json'))return {ok:!broken,status:broken?503:200,json:async()=>dataset};
    return {ok:true,status:200,json:async()=>({products:[{id:'854159',lastPrice:25,currency:'JPY'},{id:'671486',lastPrice:1,currency:'USD'}]})};
  }};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  return {api:ctx.window.PromoSearch,recover:()=>{broken=false;}};
}
(async()=>{
  const {api}=context();
  const merged=await api.merge([existing,{...existing,id:'91253',name:'Hau: PROMO[SM-P 020]',nameLower:'hau: promo[sm-p 020]'}]);
  assert.equal(new Set(merged.map(card=>card.id)).size,merged.length);
  const preserved=merged.find(card=>card.id==='671486');
  for(const [key,value]of Object.entries(existing))if(key!=='nameLower')assert.equal(preserved[key],value,key+' changed');
  for(const query of ['020/M-P','M-P020','M-P 020','피카츄 020/M-P']) {
    const matches=api.filterCodeQuery(merged.filter(card=>card.nameLower.includes(query.includes('피카츄')?'020/m-p':query.toLowerCase())),query);
    assert.deepEqual(Array.from(matches,card=>card.id),['671486'],query);
  }
  assert.deepEqual(Array.from(api.codeKeys({brand:'pokemon',name:'Charizard: PROMO[PCG-P 002/PCG-P]'})),['pcg-p:002']);
  assert.equal(api.queryKey('PRB02-006'),null);
  assert.equal(api.queryKey('151'),null);
  assert.equal(api.filterCodeQuery(merged,'피카츄').length,merged.length);
  const added=merged.find(card=>card.id==='854159');assert.equal(added.currency,'JPY');assert.equal(added.minPrice,25);
  assert.equal(merged.find(card=>card.id==='835482').minPrice,null);
  for(const id of ['835482','881167','91241','91444','91712','411685','454036','836520','891273',...Array.from({length:10},(_,i)=>String(854158+i))])assert(merged.some(card=>card.id===id),id+' missing');
  const excludes=new Set(['126334','761078','761079']);
  for(const card of dataset.cards){assert(eligibility(card,excludes));assert.equal(card.language,'ja');assert(!('minPrice'in card));assert(!('listingQuote'in card));}
  for(const name of ['Pikachu PROMO [SC]','Luffy P [P-001][ZH]','Luffy P [P-001][Aisa ver.]','Pikachu P [S-P 001][Thailand ver.]','Pikachu P [SM195](Sun & Moon "Promotional Card")'])assert(!eligibility({id:'1',brand:'pokemon',kind:'card',name}),name);
  assert(eligibility({id:'531302',brand:'pokemon',kind:'card',name:'Ho-Oh P [SV-P 254](Promotional Cards "Sealed Battle")'}));
  assert(eligibility({id:'91644',brand:'pokemon',kind:'card',name:'Legend Box: PROMO[L-P 051/L-P]'}));
  const revised=build([{name:'old',data:{cards:[{id:'1',brand:'pokemon',kind:'card',name:'Pikachu P [M-P 001]'}]}},{name:'new',data:{cards:[{id:'1',brand:'pokemon',kind:'card',name:'Pikachu P [M-P 001][SC]'}]}}]);
  assert.equal(revised.cards.length,0,'Latest ineligible record must suppress an older eligible one');
  assert.equal(retainAndSupplement(dataset,[]),dataset,'Missing raw inputs must retain the saved catalogue');
  const supplemented=retainAndSupplement(dataset,[{name:'test-feed',brand:'pokemon',data:{products:[{id:'99999991',name:'Pikachu P [M-P 999](Promo Card Pack)',lastPrice:90000,currency:'JPY',image:'/new.webp'},{id:'99999992',name:'Pikachu P [M-P 999][SC]'},{id:'671486',name:'Wrong name',lastPrice:1}]}}]);
  assert.equal(supplemented.cards.length,dataset.cards.length+1);assert(supplemented.cards.some(card=>card.id==='99999991'));assert(!supplemented.cards.some(card=>card.id==='99999992'));assert(!('lastPrice'in supplemented.cards.find(card=>card.id==='99999991')));assert.deepEqual(supplemented.cards.find(card=>card.id==='671486'),dataset.cards.find(card=>card.id==='671486'));
  const failed=context(true);const fallback=await failed.api.merge([existing]);assert.equal(fallback.length,1);assert(failed.api.needsRetry());failed.recover();const retried=await failed.api.merge(fallback);assert(retried.some(card=>card.id==='854159'));assert(!failed.api.needsRetry());
  const candidate=path.join(root,'artifacts/promo-search-20261013/release/index.html');
  const html=fs.readFileSync(fs.existsSync(candidate)?candidate:path.join(root,'index.html'),'utf8');
  const gridStart=html.indexOf('function renderPriceSearchAsGrid('),gridEnd=html.indexOf('function renderSearchResultsTo(',gridStart);
  let gridProducts;
  const gridContext={document:{getElementById:()=>({innerHTML:''})},escapeHtml:value=>value,window:{PRICE_CAT:'box'},applyGradePrices:async()=>{},renderPriceGrid:products=>{gridProducts=products;}};
  vm.createContext(gridContext);vm.runInContext(html.slice(gridStart,gridEnd),gridContext);
  gridContext.renderPriceSearchAsGrid([{id:'854159',name:'Zoro',minPrice:25,currency:'JPY'}],'854159');
  await Promise.resolve();assert.equal(gridProducts[0].currency,'JPY');assert.equal(gridProducts[0].lastPrice,25);assert.equal(gridContext.window.PRICE_CAT,'box');
  const report={ok:true,metadataOnly:true,existingFieldsPreserved:true,idDeduplication:true,numberPrecision:true,multiCardAndForeignExcluded:true,failedCatalogRetried:true,gridCurrencyPreserved:true,cleanCheckoutCatalogueRetained:true,newFeedPromosAdded:true,catalogueCards:dataset.cards.length,assetSha256:Object.fromEntries(['assets/promo-search.js','data/promo-search.json'].map(name=>[name,require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')]))};
  if(process.env.TCG_PROMO_TEST_REPORT)fs.writeFileSync(process.env.TCG_PROMO_TEST_REPORT,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exitCode=1;});
