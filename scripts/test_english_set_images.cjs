'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {build,kind,trustedProduct,pokemonLogo,POKEMON_SETS_SOURCE}=require('./build_english_set_images.cjs');
const root=path.resolve(__dirname,'..'),logo='https://static.tcgcollector.com/content/images/aa/bb/cc/'+'a'.repeat(64)+'.svg',oldLogo='https://static.tcgcollector.com/content/images/aa/bb/cc/'+'b'.repeat(64)+'.png';
const entry={code:'EN-TEST',name:'Test Set',language:'en',sourceId:'123',release:'2026.01.01',image:oldLogo,url:'https://www.tcgcollector.com/sets/123/test-set'};
const catalog={schemaVersion:1,sets:[entry]},box={productId:'12345',name:'Test Set Booster Box',sourceUrl:'https://www.tcgplayer.com/product/12345/pokemon-test-box',kind:'sealed'};
const picture={...box,image:'https://tcgplayer-cdn.tcgplayer.com/product/12345_400w.jpg',verified:true};
const shard={setCode:entry.code,language:'en',sealed:[box]},sources={schemaVersion:1,sets:[{code:entry.code,originalImageStatus:'broken',products:[picture],logo:{image:logo,sourceUrl:entry.url,verified:true}}]};
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function load(manifest,mode='ok'){
  const wrappers=[],ctx={CI_TAB:'pokemon',CI_QUERY:'',location:{hash:'',search:''},URLSearchParams,window:{openSetGrid(){}},renderCardInfo(){},document:{body:{dataset:{page:'home'}},getElementById(){return null},querySelectorAll(){return wrappers},addEventListener(){}},fetch:async url=>{
    if(url.startsWith('/data/english-set-images.json')){if(mode==='reject')throw Error('Network');if(mode==='pending')return new Promise(()=>{});return {ok:mode!=='404',json:async()=>manifest};}
    return {ok:true,json:async()=>url.startsWith('/data/english-catalog.json')?catalog:{schemaVersion:1,names:{}}};
  }};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'assets/english-catalog.js'),'utf8'),ctx);
  const api=ctx.window.EnglishCatalog;await api.ensureData();
  if(mode!=='pending')await api.ensureImages().catch(()=>{});
  await flush();return {api,ctx,wrappers};
}
test('all catalog set identities have an explicit image outcome without changing catalog data',()=>{
  const real=JSON.parse(fs.readFileSync(path.join(root,'data/english-catalog.json'),'utf8')),before=JSON.stringify(real),result=build(real,{schemaVersion:1,sets:[]});
  assert.equal(Object.keys(result.sets).length,real.sets.length);assert.equal(real.sets.length,348);assert.equal(JSON.stringify(real),before);
  assert.equal(result.coverage.missingImages,35);for(const row of real.sets)assert.equal(result.sets[row.code].code,row.code);
});
test('an exact reviewed box gets its own photo with a labeled refreshed logo fallback',()=>{
  const result=build(catalog,sources,{[entry.code]:shard}),row=result.sets[entry.code];assert.deepEqual(row.sources.map(row=>row.kind),['booster-box','logo']);assert.equal(row.sources[0].productId,box.productId);assert.equal(result.coverage.productPhotos,1);assert.equal(row.originalImageStatus,'broken');
});
test('cross-set, mismatched product image and unreviewed photos cannot bind to a set',()=>{
  assert.equal(build(catalog,sources,{[entry.code]:{...shard,setCode:'EN-OTHER'}}).coverage.productPhotos,0);
  const modified=plain(sources);modified.sets[0].products[0].image='https://tcgplayer-cdn.tcgplayer.com/product/99999_400w.jpg';assert.equal(build(catalog,modified,{[entry.code]:shard}).coverage.productPhotos,0);
  modified.sets[0].products[0]={...picture,verified:false};assert.equal(build(catalog,modified,{[entry.code]:shard}).coverage.productPhotos,0);
});

test('a reviewed package cover survives absent quotes and retains its own catalogue identity',async()=>{
 const review=plain(sources),row=review.sets[0];row.products[0].catalogueCoverOnly=true;
 row.packageCover={scope:'catalogue-package-image-only',language:'en',catalogName:entry.name,catalogRelease:entry.release,catalogUrl:entry.url,productId:box.productId,productName:box.name,productUrl:box.sourceUrl,provider:'TCGCSV',providerGroupId:42,providerSourceUrl:'https://tcgcsv.com/tcgplayer/3/42/products',providerSHA256:'a'.repeat(64),imageSHA256:'b'.repeat(64),memberCodes:[entry.code,'EN-SECOND']};
 const before=JSON.stringify(catalog),result=build(catalog,review,{});
 assert.equal(result.coverage.productPhotos,1);assert.equal(JSON.stringify(catalog),before);
 assert.equal(result.sets[entry.code].sources[0].scope,'catalogue-package-image-only');
 const {api}=await load(result);assert.equal(api.imageSources(entry)[0].label,'공용 패키지 · 구성 덱');
 for(const patch of [{language:'ja'},{catalogName:'Different edition'},{catalogRelease:'2025.01.01'},{productId:'99999'},{productName:'Different product'},{providerSourceUrl:'https://example.com/products'},{providerSHA256:''},{imageSHA256:''},{memberCodes:['EN-OTHER']}]){
  const wrong=plain(review);Object.assign(wrong.sets[0].packageCover,patch);assert.equal(build(catalog,wrong,{}).coverage.productPhotos,0,JSON.stringify(patch));
 }
});
test('cases and multiple editions never silently become a single box cover',()=>{
  assert.equal(kind('Test Booster Box Case'),null);assert.equal(kind('Test Booster Pack Art Bundle [Set of 4]'),null);
  const other={...box,productId:'12346',sourceUrl:'https://www.tcgplayer.com/product/12346/pokemon-test-box-first-edition',name:'Test Set Booster Box [1st Edition]'},review=plain(sources);review.sets[0].products.push({...other,image:'https://tcgplayer-cdn.tcgplayer.com/product/12346_400w.jpg',verified:true});const result=build(catalog,review,{[entry.code]:{...shard,sealed:[box,other]}});assert.equal(result.coverage.productPhotos,0);assert.equal(result.coverage.ambiguousProducts,1);assert.equal(result.sets[entry.code].sources[0].kind,'logo');
});
test('an ETB, bundle, pack and deck retain their actual product labels',()=>{
  assert.equal(kind('Test Elite Trainer Box'),'elite-trainer-box');assert.equal(kind('Test Booster Bundle'),'booster-bundle');assert.equal(kind('Test Booster Pack'),'booster-pack');assert.equal(kind('Test Theme Deck'),'theme-deck');assert.equal(kind('Promo Card'),null);assert(trustedProduct(picture.image,'12345'));
});

test('a reviewed unpriced trainer-kit package is shared explicitly without inventing a quote',async()=>{
  const kit={...box,name:'Test Trainer Kit',scope:'shared-trainer-kit-package'},pictureKit={...picture,name:kit.name},review={schemaVersion:1,sets:[{code:entry.code,products:[pictureKit]}]},kitShard={...shard,sealed:[],sealedCatalogue:[kit],sharedPackage:{scope:kit.scope,productId:String(kit.productId),memberCodes:[entry.code,'EN-OTHER']}};
  const result=build(catalog,review,{[entry.code]:kitShard}),source=result.sets[entry.code].sources[0];
  assert.equal(source.scope,'shared-trainer-kit-package');assert.equal(source.label,'트레이너 키트 · 공용 패키지');assert.equal(source.kind,'theme-deck');assert.equal(source.price,undefined);
  const {api}=await load(result);assert.match(api.setImage(entry),/공용 패키지/);
  const wrong={...kitShard,sharedPackage:{...kitShard.sharedPackage,memberCodes:['EN-OTHER']}};assert.equal(build(catalog,review,{[entry.code]:wrong}).coverage.productPhotos,0);
});
test('frontend displays exact product and logo labels without exposing arbitrary image URLs',async()=>{
  const manifest=build(catalog,sources,{[entry.code]:shard}),{api}=await load(manifest);assert.deepEqual(plain(api.imageSources(entry)).map(row=>row.kind),['booster-box','logo']);const html=api.setImage(entry);assert.match(html,/부스터 박스/);assert.match(html,/Test Set Booster Box/);assert(!api.trustedSetImage('javascript:alert(1)','logo'));assert(!api.trustedSetImage('https://tcgplayer-cdn.tcgplayer.com.evil.test/product/12345_400w.jpg','booster-box','12345'));
});
test('failed image progresses to the next source and then a visible neutral state',async()=>{
  const manifest=build(catalog,sources,{[entry.code]:shard}),{api}=await load(manifest);const empty={hidden:true},label={hidden:false,textContent:''},img={dataset:{encSourceIndex:'0'},hidden:false,removeAttribute(key){delete this[key]},closest(){return wrapper}},wrapper={dataset:{encImageCode:entry.code},querySelector(selector){return selector==='img'?img:selector==='.enc-set-image-empty'?empty:label}};
  api.advanceSetImage(img);assert.equal(img.src,logo);assert.equal(label.textContent,'세트 로고');assert.equal(empty.hidden,true);
  api.advanceSetImage(img);assert.equal(img.hidden,true);assert.equal(empty.hidden,false);assert.equal(label.hidden,true);assert.equal(img.src,undefined);assert.match(img.alt,/이미지 미확인/);
});
test('image metadata failures and unfinished requests never block catalog APIs or quote data',async()=>{
  for(const mode of ['reject','404','pending']){const {api}=await load(null,mode);assert.equal(api.quote({psa10:{language:'ja',grade:'PSA 10',currency:'JPY',sourcePriceCents:99}}),'PSA10 미수집');assert.match(api.setImage({...entry,image:''}),/이미지 미확인/);}
});
test('missing covers include the set code and never emit an empty src request',async()=>{
  const {api}=await load({schemaVersion:1,language:'en',sets:{}}),html=api.setImage({...entry,image:''},true);assert.match(html,/ci-panel-thumb/);assert.match(html,/TEST/);assert.match(html,/이미지 미확인/);assert.doesNotMatch(html,/src=""|visibility='hidden'/);
});
test('duplicate reviews fail rather than allowing source order to override identity',()=>{
  assert.throws(()=>build(catalog,{schemaVersion:1,sets:[{code:entry.code},{code:entry.code}]}),/Duplicate source set/);
});
test('primary dataset logos require independently matching ID, name and exact date and retain provenance',()=>{
  const image='https://images.pokemontcg.io/test1/logo.png',dataset=[{id:'test1',name:'Test Set',releaseDate:'2026/01/01',images:{logo:image}}],logo={provider:'pokemon-tcg-data',providerSetId:'test1',sourceUrl:POKEMON_SETS_SOURCE,image,verified:true},review={schemaVersion:1,sets:[{code:entry.code,originalImageStatus:'broken',logo}]};
  const result=build(catalog,review,{},dataset),source=result.sets[entry.code].sources[0];assert.equal(result.coverage.pokemonTCGLogos,1);assert.equal(source.sourceUrl,POKEMON_SETS_SOURCE);assert.equal(source.providerSetId,'test1');assert.notEqual(source.sourceUrl,entry.url);
  assert.equal(pokemonLogo({...entry,name:'Other Set'},logo,dataset),null);assert.equal(pokemonLogo({...entry,release:'2026.01.02'},logo,dataset),null);assert.equal(pokemonLogo(entry,{...logo,providerSetId:'other1'},dataset),null);assert.equal(pokemonLogo(entry,{...logo,sourceUrl:entry.url},dataset),null);assert.equal(pokemonLogo(entry,logo,[]),null);assert.equal(pokemonLogo(entry,logo,[...dataset,...dataset]),null);
});
test('primary logo punctuation normalization preserves edition words and release conflicts',()=>{
  const image='https://images.pokemontcg.io/tk1a/logo.png',dataset=[{id:'tk1a',name:'EX Trainer Kit Latias',releaseDate:'2004/06/01',images:{logo:image}}],logo={provider:'pokemon-tcg-data',providerSetId:'tk1a',sourceUrl:POKEMON_SETS_SOURCE,image,verified:true};
  assert(pokemonLogo({...entry,name:'EX Trainer Kit (Latias)',release:'2004.06.01'},logo,dataset));assert.equal(pokemonLogo({...entry,name:'EX Trainer Kit 2 (Latias)',release:'2004.06.01'},logo,dataset),null);assert.equal(pokemonLogo({...entry,name:'EX Trainer Kit (Latias)',release:'2005.06.01'},logo,dataset),null);
});
test('frontend permits only canonical primary logo URLs and keeps the logo label',async()=>{
  const image='https://images.pokemontcg.io/test1/logo.png',{api}=await load({schemaVersion:1,language:'en',sets:{[entry.code]:{code:entry.code,originalImageStatus:'broken',sources:[{kind:'logo',image,provider:'pokemon-tcg-data',providerSetId:'test1',sourceUrl:POKEMON_SETS_SOURCE}]}}});
  assert(api.trustedSetImage(image,'logo'));assert(!api.trustedSetImage('https://images.pokemontcg.io.evil.test/test1/logo.png','logo'));assert(!api.trustedSetImage('https://images.pokemontcg.io/test1/secret.png','logo'));assert.match(api.setImage(entry),/세트 로고/);assert.match(api.setImage(entry),/images.pokemontcg.io\/test1\/logo.png/);
});
test('reviewed SWSH promo alias is limited to the exact code, source ID, names, release and printed count',()=>{
  const promo={code:'EN-TCG11149',name:'Sword & Shield Promos',language:'en',release:'2019.11.15',cardCount:307},dataset=[{id:'swshp',name:'SWSH Black Star Promos',series:'Sword & Shield',printedTotal:307,releaseDate:'2019/11/15',images:{logo:'https://images.pokemontcg.io/swshp/logo.png'}}],logo={provider:'pokemon-tcg-data',providerSetId:'swshp',sourceUrl:POKEMON_SETS_SOURCE,image:dataset[0].images.logo,verified:true};
  const accepted=pokemonLogo(promo,logo,dataset);assert.equal(accepted.providerSetId,'swshp');assert.equal(accepted.mapping.method,'reviewed-name-alias');
  for(const changed of [{cardCount:306},{release:'2018.11.15'},{code:'EN-OTHER'},{name:'Sword and Shield Promos'},{language:'ja'}])assert.equal(pokemonLogo({...promo,...changed},logo,dataset),null);
  for(const changed of [{printedTotal:306},{releaseDate:'2020/11/15'},{id:'sm'},{name:'Other Black Star Promos'},{series:'Sun & Moon'}])assert.equal(pokemonLogo(promo,logo,[{...dataset[0],...changed}]),null);
  assert.equal(pokemonLogo(promo,{...logo,providerSetId:'sm'},dataset),null);
});
