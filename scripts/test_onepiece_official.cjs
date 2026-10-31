'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const bridge=require('../assets/contained-card-prices.js'),prices=require('../assets/card-price-fallback.js'),match=require('../assets/contained-card-match.js'),catalog=require('../assets/onepiece-official-catalog.js');
const manifest=read('data/onepiece-official-manifest.json'),search=read('data/onepiece-official-search.json');
test('all official product types, 5112 artworks and acquisition metadata reach the searchable catalogue',()=>{
 assert(manifest.sets.length>=63);assert(manifest.officialCards>=5112);assert.equal(search.cards.length,manifest.officialCards);
 assert.equal(new Set(search.cards.map(c=>c.officialId)).size,manifest.officialCards);
 const byId=new Map(search.cards.map(c=>[c.officialId,c]));
 for(const set of manifest.sets){const body=read('data/cards-by-set/'+(set.fileCode||set.code)+'.json');const cards=body.cards.filter(c=>c.officialId);assert.equal(cards.length,set.officialCardCount,set.code);for(const c of cards){assert(c.rarity&&c.printedNumber&&c.sourceUrl&&c.acquisition,c.officialId);assert.equal(c.language,'ja');assert(byId.has(c.officialId));}}
 for(const id of ['EB04-054_p1','OP10-045_p2','OP11-067_p2','OP14-029_p1','OP14-084_p2','ST15-005_p1'])assert.equal(byId.get(id)?.boxCode,'OP16',id);
 for(let n=1;n<=36;n++)assert(manifest.sets.some(s=>s.code==='ST'+String(n).padStart(2,'0')));
 assert(manifest.sets.find(s=>s.code==='PRB01').officialCardCount>=319);assert(manifest.sets.find(s=>s.code==='PRB02').officialCardCount>=316);
});
test('OP numbers of prizes remain promo acquisitions and do not become booster contents',()=>{
 for(const id of ['OP01-025_p4','OP04-112_p2','OP06-093_p2']){const c=search.cards.find(c=>c.officialId===id);assert(c,id);assert.equal(c.boxCode,'PROMO');assert.match(c.acquisition,/フラッグシップ/);assert(!read('data/cards-by-set/'+c.setCode+'.json').cards.some(x=>x.officialId===id));}
 catalog.configure(search);const rows=catalog.getSearchRows();assert.equal(rows.length,manifest.officialCards);assert(rows.some(c=>catalog.matches(c,'OP06-093')));assert(rows.some(c=>catalog.matches(c,'플래그십')));
 const promo=rows.find(c=>c.officialId==='OP06-093_p2');assert.match(catalog.href(promo),/set=PROMO/);assert.match(catalog.href(promo),/card=OP06-093_p2/);
});
test('reported real cards use shop quotes only after exact SNKR no-listing confirmation',async()=>{
 const all=read('data/all-cards.json').details,overrides=read('data/onepiece-card-overrides.json'),art=read('data/contained-card-market-links.json');
 const shops=prices.decodeYuyu(read('data/yuyutei-market/onepiece.json'));
 for(const[code,id]of[['OP16','OP16-005'],['OP16','OP16-007'],['OP17','OP17-002']]){
  const card=read('data/cards-by-set/'+code+'.json').cards.find(c=>c.fullId===id);
  const t=await bridge.prepareTarget({...card,brand:'onepiece',language:'ja',boxCode:code},{services:{match,loadProducts:async()=>all,loadOverrides:async()=>overrides,loadArtworkBindings:async()=>art,loadDetails:async()=>({cards:{}})}});
  assert(t.rarity);let requests=0;
  t.snkrProduct={...t.snkrProduct,minPrice:null,catalogAsk:null,grades:{},listingCount:0,priceStatus:'no-listings'};
  const q=await prices.lookup(t,{yuyuRows:shops,mercariReferences:[],loadSnkrQuote:async marketId=>{requests++;assert.equal(marketId,t.snkrdunkId);return {ok:true,id:marketId,fetchedAt:new Date().toISOString(),grades:{},noListingGrades:['raw']};}});
  assert.equal(requests,1,id);assert.equal(q.source,'yuyutei',id);
  const expected=shops.find(r=>r.cardNumber===id&&r.setCode===code&&r.rarity===t.rarity);assert(expected);assert.equal(q.amount,expected.price,id);
  if(Date.now()-Date.parse(expected.sourceAsOf)>36*3600000){assert.equal(q.stale,true,'Previous observation must remain dated');assert.match(prices.render(q,{convert:n=>n*8}),/이전 관측가/);}
 }
});
test('parallel and prize cards never accept the base Mercari listing merely by printed number',()=>{
 const target={game:'onepiece',brand:'onepiece',language:'ja',fullNumber:'OP06-093',setCode:'OP06',fullId:'OP06-093_p2',officialId:'OP06-093_p2',sourceCategory:'promotion',rarity:'SR'};
 const row={sourceUrl:'https://jp.mercari.com/item/m123',title:'OP06-093 ペローナ',price:{amount:100,currency:'JPY'},identity:{game:'onepiece',language:'ja',cardNumber:'OP06-093',grade:'raw',quantity:1}};
 assert.equal(prices.resolve(target,{mercariReferences:[row]}).status,'none');
});
test('visually reviewed flagship printings use independent market products with matching official artwork',async()=>{
 const all=read('data/all-cards.json').details,docs=read('data/contained-card-market-links.json'),extra=read('data/onepiece-reviewed-promo-links.json');
 docs.links.push(...extra.links);const cards=read('data/cards-by-set/ONEPIECE-PROMO.json').cards;
 for(const[id,market]of[['OP01-025_p4','106779'],['OP04-112_p2','282726'],['OP06-093_p2','165934']]){
  const card=cards.find(c=>c.officialId===id);assert(card);
  const t=await bridge.prepareTarget({...card,brand:'onepiece',language:'ja',boxCode:'PROMO'},{services:{match,loadProducts:async()=>all,loadOverrides:async()=>({}),loadArtworkBindings:async()=>docs,loadDetails:async()=>({cards:{}})}});
  assert.equal(t.snkrdunkStatus,'matched');assert.equal(t.snkrdunkId,market,id);assert.match(t.snkrProduct.name,/Flagship/);
 }
});
test('source markup remains syntactically valid and details contain acquisition while grids contain no prices',()=>{
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8');for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){if(m[1].trim()&&!m[0].startsWith('<script type="application/ld+json"'))new vm.Script(m[1]);}
 assert(html.includes('OnePieceCatalog?.mergeSearch'));assert(html.includes('officialId:c.officialId'));assert(html.includes('입수처 ·'));
 const grid=html.slice(html.indexOf('window.openSetGrid = async'),html.indexOf('async function getBoxIdBySetCode'));
 assert(!grid.includes('data-contained-price'));assert(!grid.includes('cpf-priced'));
});
