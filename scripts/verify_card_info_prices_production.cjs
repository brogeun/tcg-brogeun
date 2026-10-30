'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const bridge=require('../assets/contained-card-prices.js'),match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js'),repairs=require('../assets/card-catalog-repairs.js');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const base=process.env.PRICE_VERIFY_ORIGIN||'https://tcghub.kr',version=process.env.DEPLOY_COMMIT||Date.now();
async function get(path,json=false){const r=await fetch(base+path+(path.includes('?')?'&':'?')+'audit='+version,{headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(30000)});assert(r.ok,path+' HTTP '+r.status);return json?r.json():r.text();}
async function run(){
 for(const path of ['assets/contained-card-match.js','assets/contained-card-prices.js','assets/card-price-fallback.js','assets/english-catalog.js','assets/price-expanded.js','sw.js']){
  const remote=await get('/'+path),local=fs.readFileSync(path,'utf8');
  assert.equal(crypto.createHash('sha256').update(remote).digest('hex'),crypto.createHash('sha256').update(local).digest('hex'),'Stale production asset: '+path);
 }
 const page=await get('/');assert(page.includes('20261030-price-audit2'),'Price audit scripts missing from deployed index');
 const bindings=await get('/data/contained-card-market-links.json',true),overrides=await get('/data/onepiece-card-overrides.json',true);
 assert.deepEqual(bindings,read('data/contained-card-market-links.json'),'Deployed artwork bindings differ');
 assert.deepEqual(overrides,read('data/onepiece-card-overrides.json'),'Deployed OP17 bindings differ');
 repairs.configure(await get('/data/card-catalog-repairs.json',true));
 const products=repairs.products(read('data/all-cards.json').details),byId=new Map(products.map(p=>[String(p.id),p]));
 const codes=[...new Set(['OP16','OP17',...bindings.links.map(r=>r.boxCode)])],sets=new Map();
 let next=0;
 await Promise.all(Array.from({length:6},async()=>{while(next<codes.length){const code=codes[next++];sets.set(code,repairs.setCards(await get('/data/cards-by-set/'+code+'.json',true),code).cards);}}));
 let resolved=0,priced=0;
 for(const row of bindings.links){
  const card=sets.get(row.boxCode).find(c=>c.image===row.image&&String(c.number||'')===String(row.number||'')&&String(c.fullId||'')===String(row.fullId||''));assert(card,row.boxCode+' '+row.number);
  const target=bridge.targetFor({...card,brand:row.brand,language:'ja',boxCode:row.boxCode}),p=byId.get(row.id);
  const links={...bridge.reviewedLinks([target],products,overrides,match),...bridge.reviewedArtworkLinks([target],products,bindings,match)},result=match.createResolver(products,links)(target);
  assert.equal(result.status,'matched',row.fullId||row.number);assert.equal(result.id,row.id);resolved++;
  const q=fallback.resolve({...target,snkrdunkId:row.id,snkrProduct:p});
  if(q.status==='priced'){priced++;const html=fallback.render(q,{convert:n=>Math.round(n*8.5)});assert(html.includes('₩'));assert(!/JPY|USD|[$¥]/.test(html));}
 }
 for(const [code,count] of [['OP16',149],['OP17',158]]){
  const cards=sets.get(code).filter(c=>new RegExp('^'+code+'-\\d+(?:_p\\d+)?$').test(c.fullId));assert.equal(cards.length,count);
  const targets=await bridge.prepareTargets(cards.map(c=>({...c,brand:'onepiece',language:'ja',boxCode:code})),{services:{match,loadProducts:async()=>products,loadOverrides:async()=>overrides,loadDetails:async()=>({cards:{}}),loadArtworkBindings:async()=>bindings}});
  assert(targets.every(t=>t.snkrdunkStatus==='matched'),code+' contains unresolved printing');assert.equal(new Set(targets.map(t=>t.snkrdunkId)).size,count);
 }
 const live=[];
 for(const id of ['881671','871063','871062']){
  const q=await get('/api/card-grades?id='+id,true);assert(q.ok&&String(q.id)===id);assert(q.grades?.raw?.lowest_ask>0,'Known Rocks raw price missing '+id);assert(['JPY','USD','KRW'].includes(q.grades.raw.currency));
  live.push({id,raw:q.grades.raw.lowest_ask,currency:q.grades.raw.currency});
 }
 console.log(JSON.stringify({origin:base,artworkBindings:resolved,priced,completeSets:{OP16:149,OP17:158},liveRocks:live}));
}
(async()=>{let last;for(let attempt=0;attempt<4;attempt++){try{await run();return;}catch(error){last=error;console.error('Production price check attempt '+(attempt+1)+': '+error.message);if(attempt<3)await new Promise(r=>setTimeout(r,15000));}}throw last;})().catch(e=>{console.error(e);process.exitCode=1;});
