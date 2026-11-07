'use strict';
const fs=require('node:fs'),path=require('node:path');
const LABELS={'booster-box':'부스터 박스','elite-trainer-box':'엘리트 트레이너 박스','booster-bundle':'부스터 번들','booster-pack':'부스터 팩','theme-deck':'구성 덱',collection:'컬렉션 상품',logo:'세트 로고'};
const RANK={'booster-box':0,'elite-trainer-box':1,'booster-bundle':2,'booster-pack':3,'theme-deck':4,collection:5};
const POKEMON_SETS_SOURCE='https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/sets/en.json';
// Reviewed 2026-11-04: one exact promo entity whose providers use different names.
const REVIEWED_LOGO_ALIASES={'EN-TCG11149':{providerSetId:'swshp',catalogName:'Sword & Shield Promos',providerName:'SWSH Black Star Promos',series:'Sword & Shield',release:'2019-11-15',printedTotal:307}};
const logoName=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]/g,'');
const logoDate=value=>String(value||'').replace(/[./]/g,'-');
function trustedLogo(image){return typeof image==='string'&&(/^https:\/\/static\.tcgcollector\.com\/content\/images\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:png|webp|svg|jpe?g)$/.test(image)||/^https:\/\/images\.pokemontcg\.io\/[a-z0-9-]{1,32}\/logo\.png$/.test(image));}
function pokemonLogo(entry,logo,dataset){
  if(logo?.verified!==true||logo.provider!=='pokemon-tcg-data'||logo.sourceUrl!==POKEMON_SETS_SOURCE||!Array.isArray(dataset))return null;
  const alias=REVIEWED_LOGO_ALIASES[entry.code],reviewedAlias=row=>alias&&entry.language==='en'&&entry.name===alias.catalogName&&entry.cardCount===alias.printedTotal&&logoDate(entry.release)===alias.release&&row.id===alias.providerSetId&&row.name===alias.providerName&&row.series===alias.series&&row.printedTotal===alias.printedTotal&&logoDate(row.releaseDate)===alias.release;
  const matches=dataset.filter(row=>(logoName(row.name)===logoName(entry.name)&&logoDate(row.releaseDate)===logoDate(entry.release))||reviewedAlias(row));
  if(matches.length!==1||matches[0].id!==logo.providerSetId||logo.image!==matches[0].images?.logo||logo.image!==`https://images.pokemontcg.io/${matches[0].id}/logo.png`||!trustedLogo(logo.image))return null;
  return {kind:'logo',label:LABELS.logo,image:logo.image,provider:'pokemon-tcg-data',providerSetId:matches[0].id,sourceUrl:POKEMON_SETS_SOURCE,...(reviewedAlias(matches[0])?{mapping:{method:'reviewed-name-alias',catalogName:alias.catalogName,providerName:alias.providerName,release:alias.release,printedTotal:alias.printedTotal}}:{})};
}
function trustedProduct(image,id){return /^\d+$/.test(String(id||''))&&typeof image==='string'&&new RegExp('^https://(?:product-images\\.tcgplayer\\.com/(?:fit-in/\\d+x\\d+/)?'+id+'\\.(?:jpg|png|webp)|tcgplayer-cdn\\.tcgplayer\\.com/product/'+id+'_(?:in_\\d+x\\d+|\\d+w)\\.(?:jpg|png|webp))$').test(image);}
function kind(name){
  if(typeof name!=='string'||/\b(?:case|display case|empty|code card|code only|sleeve|protector)\b/i.test(name))return null;
  if(/\bbooster (?:box|display)\b/i.test(name))return 'booster-box';
  if(/\belite trainer box\b/i.test(name))return 'elite-trainer-box';
  if(/\bbooster bundle\b/i.test(name))return 'booster-bundle';
  if(/\bbooster pack\b/i.test(name)&&!/\bart bundle\b|\bset of\b/i.test(name))return 'booster-pack';
  if(/\b(?:theme deck|trainer kit|starter set)\b/i.test(name))return 'theme-deck';
  if(/\b(?:premium collection|collection box|poster collection|binder collection|mini tin)\b/i.test(name))return 'collection';
  return null;
}
function build(catalog,review,shards={},pokemonSets=[]){
  if(catalog?.schemaVersion!==1||!Array.isArray(catalog.sets)||new Set(catalog.sets.map(row=>row.code)).size!==catalog.sets.length)throw Error('Invalid English catalog');
  if(review?.schemaVersion!==1||!Array.isArray(review.sets))throw Error('Invalid image source review');
  const catalogCodes=new Set(catalog.sets.map(row=>row.code)),byCode=new Map();for(const row of review.sets){if(!/^EN-[A-Z0-9-]+$/.test(row.code||'')||!catalogCodes.has(row.code))throw Error('Unknown source set '+row.code);if(byCode.has(row.code))throw Error('Duplicate source set '+row.code);byCode.set(row.code,row);}
  const sets={},coverage={catalogSets:catalog.sets.length,productPhotos:0,refreshedLogos:0,pokemonTCGLogos:0,originalLogos:0,missingImages:0,ambiguousProducts:0,rejectedProducts:0};
  for(const entry of catalog.sets){
    if(entry.language!=='en'||!/^EN-[A-Z0-9-]+$/.test(entry.code))throw Error('Invalid English set identity');
    const source=byCode.get(entry.code)||{},shard=shards[entry.code],candidates=[];let sources=[];
    for(const product of source.products||[]){
      const match=shard?.setCode===entry.code&&shard?.language==='en'&&Array.isArray(shard.sealed)&&[...shard.sealed,...(shard.sealedCatalogue||[])].find(row=>String(row.productId)===String(product.productId)&&row.name===product.name&&row.sourceUrl===product.sourceUrl);
      const imageKind=kind(product.name);
      if(!match||!imageKind||product.verified!==true||!trustedProduct(product.image,product.productId)||!new RegExp('^https://www\\.tcgplayer\\.com/product/'+product.productId+'(?:/[A-Za-z0-9%._~-]+)?$').test(product.sourceUrl||'')){coverage.rejectedProducts++;continue;}
      const shared=match.scope==='shared-trainer-kit-package'&&shard.sharedPackage?.scope===match.scope&&shard.sharedPackage.memberCodes?.includes(entry.code)&&shard.sharedPackage.productId===String(product.productId)&&imageKind==='theme-deck';
      if(match.scope==='shared-trainer-kit-package'&&!shared){coverage.rejectedProducts++;continue;}
      candidates.push({kind:imageKind,label:shared?'트레이너 키트 · 공용 패키지':LABELS[imageKind],image:product.image,productId:String(product.productId),name:product.name,sourceUrl:product.sourceUrl,...(shared?{scope:match.scope,memberCodes:shard.sharedPackage.memberCodes}:{})});
    }
    if(candidates.length){
      const priority=Math.min(...candidates.map(row=>RANK[row.kind])),top=candidates.filter(row=>RANK[row.kind]===priority);
      // Distinct product IDs/editions are never silently collapsed to a cover.
      const unique=[...new Map(top.map(row=>[row.productId,row])).values()];
      if(unique.length===1){sources.push(unique[0]);coverage.productPhotos++;}else coverage.ambiguousProducts++;
    }
    const logo=source.logo,primaryLogo=pokemonLogo(entry,logo,pokemonSets);
    if(primaryLogo){sources.push(primaryLogo);coverage.refreshedLogos++;coverage.pokemonTCGLogos++;}
    else if(logo?.verified===true&&!logo.provider&&logo.sourceUrl===entry.url&&trustedLogo(logo.image)&&logo.image.startsWith('https://static.tcgcollector.com/')){
      sources.push({kind:'logo',label:LABELS.logo,image:logo.image,sourceUrl:entry.url});coverage.refreshedLogos++;
    }
    if(trustedLogo(entry.image)&&!sources.some(row=>row.image===entry.image)&&source.originalImageStatus!=='broken'){
      sources.push({kind:'logo',label:LABELS.logo,image:entry.image,sourceUrl:entry.url});coverage.originalLogos++;
    }
    if(!sources.length)coverage.missingImages++;
    sets[entry.code]={code:entry.code,name:entry.name,status:sources.length?'available':'missing',...(source.originalImageStatus==='broken'?{originalImageStatus:'broken'}:{}),sources};
  }
  return {schemaVersion:1,language:'en',coverage,sets};
}
function main(args=process.argv.slice(2)){
  let root=path.resolve(__dirname,'..'),sourcePath=null,pokemonPath=null;for(let i=0;i<args.length;i++){if(args[i]==='--root')root=path.resolve(args[++i]);else if(args[i]==='--sources')sourcePath=path.resolve(args[++i]);else if(args[i]==='--pokemon-sets')pokemonPath=path.resolve(args[++i]);else throw Error('Unknown option '+args[i]);}
  sourcePath=sourcePath||path.join(root,'config/english-set-image-sources.json');
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'data/english-catalog.json'),'utf8')),review=JSON.parse(fs.readFileSync(sourcePath,'utf8')),shards={};
  const catalogCodes=new Set(catalog.sets.map(row=>row.code));for(const row of review.sets||[]){if(!/^EN-[A-Z0-9-]+$/.test(row.code||'')||!catalogCodes.has(row.code))throw Error('Unknown source set '+row.code);if(!row.products?.length)continue;const file=path.join(root,'data/us-market',row.code+'.json');if(fs.existsSync(file))shards[row.code]=JSON.parse(fs.readFileSync(file,'utf8'));}
  pokemonPath=pokemonPath||path.join(root,'config/pokemon-tcg-english-sets.json');const pokemonSets=fs.existsSync(pokemonPath)?JSON.parse(fs.readFileSync(pokemonPath,'utf8')):[];
  const manifest=build(catalog,review,shards,pokemonSets);fs.mkdirSync(path.join(root,'data'),{recursive:true});fs.writeFileSync(path.join(root,'data/english-set-images.json'),JSON.stringify(manifest)+'\n');console.log(JSON.stringify(manifest.coverage));return manifest;
}
if(require.main===module)main();module.exports={build,kind,trustedLogo,trustedProduct,pokemonLogo,logoName,logoDate,POKEMON_SETS_SOURCE,main};
