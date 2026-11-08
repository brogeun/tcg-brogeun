'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),vm=require('node:vm');
const bridge=require('../assets/contained-card-prices.js'),match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js'),repairs=require('../assets/card-catalog-repairs.js');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const base=process.env.PRICE_VERIFY_ORIGIN||'https://tcghub.kr',version=process.env.DEPLOY_COMMIT||Date.now();
async function get(path,json=false){const r=await fetch(base+path+(path.includes('?')?'&':'?')+'audit='+version,{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(30000)});assert(r.ok,path+' HTTP '+r.status);return json?r.json():r.text();}
async function verifyPriceAssets({get:fetchAsset=get,readSource=path=>fs.readFileSync(path,'utf8')}={}){
 const page=(await fetchAsset('/')).replace(/<!--[\s\S]*?-->/g,''),origin=new URL(base).origin;
 const tags=[...page.matchAll(/<script\b([^>]*)>/gi)].flatMap(tag=>{
  const src=tag[1].match(/(?:^|\s)src\s*=\s*(["'])([^"']+)\1/i);
  return src?[{src:src[2],attributes:tag[1],index:tag.index}]:[];
 });
 const pathname=src=>new URL(src,base).pathname;
 const tagsFor=path=>tags.filter(tag=>pathname(tag.src)===path);
 const core=['contained-card-match.js','contained-card-prices.js','card-price-fallback.js','price-expanded.js'];
 const positions=new Map(),sources=new Map();
 async function checkSource(src){
  const url=new URL(src,base);assert.equal(url.origin,origin,'Price asset must use the deployed origin: '+src);
  assert(!url.hash&&!url.username&&!url.password,'Invalid price asset URL: '+src);
  const path=url.pathname;assert(/^\/assets\/[a-z0-9._-]+\.js$/i.test(path),'Invalid price script path: '+path);
  const remote=await fetchAsset(path+url.search),local=readSource(path.slice(1));
  assert.equal(crypto.createHash('sha256').update(remote).digest('hex'),crypto.createHash('sha256').update(local).digest('hex'),'Stale production asset: '+path.slice(1));
  sources.set(path,remote);return remote;
 }
 for(const file of core){
  const path='/assets/'+file,found=tagsFor(path);assert.equal(found.length,1,'Price script must be linked once: '+path);
  positions.set(path,found[0].index);await checkSource(found[0].src);
 }
 const featureFiles=['english-catalog.js','tcg-card-info.js'],lazy=featureFiles.filter(file=>!tagsFor('/assets/'+file).length);
 let profile=[];
 if(lazy.length){
  const found=tagsFor('/assets/app-route-loader.js');assert.equal(found.length,1,'Price audit feature loader must be linked once');
  const tag=found[0],navigation=page.lastIndexOf('go(initialPage)');
  assert(!/(?:^|\s)(?:async|defer)(?:\s|=|$)/i.test(tag.attributes),'Price audit feature loader must be ready before navigation');
  assert(navigation>=0&&tag.index<navigation&&page.includes('AppRouteLoader.ensure('),'Price audit feature loader is not wired before route activation');
  const source=await checkSource(tag.src),context={window:{},URL,location:{href:base+'/#home'},document:{
   addEventListener(){throw Error('Manifest inspection must not install listeners');},
   querySelectorAll(){throw Error('Manifest inspection must not load route assets');}
  }};
  vm.runInNewContext(source,context,{filename:tag.src,timeout:1000});
  assert.equal(typeof context.window.AppRouteLoader?.ensure,'function','Invalid deployed feature loader');
  profile=context.window.AppRouteLoader.manifest?.cardinfo?.scripts;
  assert(Array.isArray(profile)&&profile.length,'Missing deployed cardinfo script profile');
  profile=Array.from(profile);assert(profile.every(src=>typeof src==='string'),'Invalid deployed cardinfo script profile');
 }
 for(const file of featureFiles){
  const path='/assets/'+file,eager=tagsFor(path),declared=profile.filter(src=>pathname(src)===path);
  assert.equal(eager.length+declared.length,1,'Price feature must be linked once: '+path);
  if(eager.length){positions.set(path,eager[0].index);await checkSource(eager[0].src);}
  else{positions.set(path,page.length+profile.indexOf(declared[0]));await checkSource(declared[0]);}
 }
 for(const [before,after]of [['contained-card-match.js','contained-card-prices.js'],['card-price-fallback.js','tcg-card-info.js'],['contained-card-prices.js','tcg-card-info.js'],['english-catalog.js','tcg-card-info.js']])
  assert(positions.get('/assets/'+before)<positions.get('/assets/'+after),'Price script dependency order: '+before+' before '+after);
 const remote=await fetchAsset('/sw.js');
 assert.equal(crypto.createHash('sha256').update(remote).digest('hex'),crypto.createHash('sha256').update(readSource('sw.js')).digest('hex'),'Stale production asset: sw.js');
 return {lazy:lazy.length>0,scripts:[...sources.keys()]};
}
async function run(){
 await verifyPriceAssets();
 const bindings=await get('/data/contained-card-market-links.json',true),overrides=await get('/data/onepiece-card-overrides.json',true);
 assert.deepEqual(bindings,read('data/contained-card-market-links.json'),'Deployed artwork bindings differ');
 assert.deepEqual(overrides,read('data/onepiece-card-overrides.json'),'Deployed OP17 bindings differ');
 repairs.configure(await get('/data/card-catalog-repairs.json',true));
 const products=bridge.reviewedJapaneseProducts(repairs.products(read('data/all-cards.json').details),bindings),byId=new Map(products.map(p=>[String(p.id),p]));
 const setKey=row=>row.brand+'|'+row.boxCode;
 const codes=[...new Map([{brand:'onepiece',boxCode:'OP16'},{brand:'onepiece',boxCode:'OP17'},...bindings.links].map(row=>[setKey(row),{brand:row.brand,boxCode:row.boxCode}])).values()],sets=new Map();
 let next=0;
 await Promise.all(Array.from({length:6},async()=>{while(next<codes.length){const source=codes[next++],code=source.boxCode,file=source.brand==='onepiece'&&['PROMO','LIMITED'].includes(code)?'ONEPIECE-'+code:code;sets.set(setKey(source),repairs.setCards(await get('/data/cards-by-set/'+file+'.json',true),code).cards);}}));
 const reviewedTargets=bindings.links.map(row=>{
  const card=sets.get(setKey(row)).find(c=>c.image===row.image&&String(c.number||'')===String(row.number||'')&&String(c.fullId||'')===String(row.fullId||''));assert(card,row.boxCode+' '+row.number);
  return bridge.targetFor({...card,brand:row.brand,language:'ja',boxCode:row.boxCode,setCode:card.setCode||row.boxCode});
 });
 const links={...bridge.reviewedLinks(reviewedTargets,products,overrides,match),...bridge.reviewedArtworkLinks(reviewedTargets,products,bindings,match)},resolve=match.createResolver(products,links);
 let resolved=0,priced=0;
 for(let index=0;index<bindings.links.length;index++){
  const row=bindings.links[index],target=reviewedTargets[index],p=byId.get(row.id),result=resolve(target);
  assert.equal(result.status,'matched',[row.brand,row.boxCode,row.fullId||row.number||row.image,row.id].join(' '));assert.equal(result.id,row.id);resolved++;
  const q=fallback.resolve({...target,snkrdunkId:row.id,snkrProduct:p});
  if(q.status==='priced'){priced++;const html=fallback.render(q,{convert:n=>Math.round(n*8.5)});assert(html.includes('₩'));assert(!/JPY|USD|[$¥]/.test(html));}
 }
 for(const [code,count] of [['OP16',149],['OP17',158]]){
  const cards=sets.get('onepiece|'+code).filter(c=>new RegExp('^'+code+'-\\d+(?:_p\\d+)?$').test(c.fullId));assert.equal(cards.length,count);
  const services={match,loadProducts:async()=>products,loadOverrides:async()=>overrides,loadDetails:async()=>({cards:{}}),loadArtworkBindings:async()=>bindings};
  const targets=await Promise.all(cards.map(c=>bridge.prepareTarget({...c,brand:'onepiece',language:'ja',boxCode:code,setCode:c.setCode||code},{services})));
  assert(targets.every(t=>t.snkrdunkStatus==='matched'),code+' contains unresolved printing');assert.equal(new Set(targets.map(t=>t.snkrdunkId)).size,count);
 }
 const live=[];
 for(const id of ['881671','871063','871062']){
  const q=await get('/api/card-grades?id='+id,true);assert(q.ok&&String(q.id)===id);assert(q.grades?.raw?.lowest_ask>0,'Known Rocks raw price missing '+id);assert(['JPY','USD','KRW'].includes(q.grades.raw.currency));
  live.push({id,raw:q.grades.raw.lowest_ask,currency:q.grades.raw.currency});
 }
 console.log(JSON.stringify({origin:base,artworkBindings:resolved,priced,completeSets:{OP16:149,OP17:158},liveRocks:live}));
}
module.exports={verifyPriceAssets,run};
if(require.main===module)(async()=>{let last;for(let attempt=0;attempt<4;attempt++){try{await run();return;}catch(error){last=error;console.error('Production price check attempt '+(attempt+1)+': '+error.message);if(attempt<3)await new Promise(r=>setTimeout(r,15000));}}throw last;})().catch(e=>{console.error(e);process.exitCode=1;});
