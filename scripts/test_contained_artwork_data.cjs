'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const bridge=require('../assets/contained-card-prices.js'),match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js'),repairs=require('../assets/card-catalog-repairs.js');
repairs.configure(read('data/card-catalog-repairs.json'));
const doc=read('data/contained-card-market-links.json'),products=new Map(bridge.reviewedJapaneseProducts(repairs.products(read('data/all-cards.json').details),doc).map(p=>[String(p.id),p])),setCache=new Map();
test('every published artwork proof resolves its actual source card and market product',()=>{
 assert.equal(doc.schemaVersion,1);assert(doc.links.length>=300);
 const keys=new Set();let priced=0;
 for(const row of doc.links){
  assert(!/\b(?:1ED|1ST|FIRST EDITION|NO RARITY|UNLIMITED|SERIAL|SIGNED)\b/i.test(row.marketName),'Edition requires separate verification');
  const calibrated=row.method==='op17-calibrated-artwork-comparison';
  const unique=row.method==='strict-unique-source-artwork-comparison-and-visual-review';
  const originalPage=['separated-candidate-full-card-image-and-original-product-page','official-acquisition-and-full-card-image','original-acquisition-illustration-and-text-review','original-japanese-title-and-independent-full-card-image'].includes(row.method);
  const energy=row.method==='visual-complete-original-card-energy-symbol-M6a-anniversary-emblem-review';
  if(originalPage||energy){
   for(const field of ['sourceSHA256','marketSHA256','marketPageSHA256'])assert.match(row[field]||'',/^[a-f0-9]{64}$/,field+' receipt missing');
   assert.equal(row.marketPageUrl,'https://snkrdunk.com/apparels/'+row.id);
   assert.match(row.marketImage,/^https:\/\/cdn\.snkrdunk\.com\//);assert(Number.isFinite(Date.parse(row.reviewedAt)),'Original review time missing');
   if(originalPage){assert.match(row.currentMarketSHA256||'',/^[a-f0-9]{64}$/);assert.match(row.currentMarketImage||'',/^https:\/\/cdn\.snkrdunk\.com\//);}
   if(energy){assert.equal(row.brand,'pokemon');assert.equal(row.boxCode,'M6a');assert.equal(row.unprintedNumber,true);assert(['892661','892662','892663','892665','892667','892668'].includes(row.id));assert(new RegExp('^https://www\\.tcgcollector\\.com/cards/'+row.sourceId+'/').test(row.sourcePageUrl));}
  }
  else if(unique)assert(row.candidateCount===1&&row.distance<=4&&row.detailDistance<=6&&row.artDistance<=4&&row.meanPixelDifference<=25&&row.reviewedBy==='assistant-vision','Unsupported unique-image confidence');
  else assert(row.distance<=(calibrated?14:8)&&row.detailDistance<=(calibrated?18:14)&&row.artDistance<=(calibrated?18:12)&&row.margin>=10,'Unsupported image confidence');
  if(calibrated)assert.equal(row.brand,'onepiece');
  const code=row.brand==='onepiece'&&['PROMO','LIMITED'].includes(row.boxCode)?'ONEPIECE-'+row.boxCode:row.boxCode;
  const filename='data/cards-by-set/'+code+'.json';if(!setCache.has(filename))setCache.set(filename,repairs.setCards(read(filename),row.boxCode).cards);
  const card=setCache.get(filename).find(c=>c.image===row.image&&String(c.number||'')===String(row.number||'')&&String(c.fullId||'')===String(row.fullId||''));assert(card,'Source artwork missing: '+row.boxCode+' '+row.number);
  const target=bridge.targetFor({...card,brand:row.brand,language:'ja',boxCode:row.boxCode,setCode:card.setCode||row.boxCode}),product=products.get(row.id);assert(product,row.id);
  const key=match.artworkKey(target);assert(!keys.has(key),'Duplicate artwork binding');keys.add(key);
  const links=bridge.reviewedArtworkLinks([target],[product],{schemaVersion:1,links:[row]},match),resolved=match.createResolver([product],links)(target);
  assert.equal(resolved.status,'matched',row.boxCode+' '+row.number);assert.equal(resolved.id,row.id);
  if(product.minPrice>0){const q=fallback.resolve({...target,snkrdunkId:row.id,snkrProduct:product});assert.equal(q.status,'priced',row.boxCode+' '+row.number);assert.equal(q.source,'snkrdunk');priced++;}
 }
 assert(priced>0);
});
