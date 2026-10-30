'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const bridge=require('../assets/contained-card-prices.js'),match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js'),repairs=require('../assets/card-catalog-repairs.js');
repairs.configure(read('data/card-catalog-repairs.json'));
const products=new Map(repairs.products(read('data/all-cards.json').details).map(p=>[String(p.id),p])),doc=read('data/contained-card-market-links.json'),setCache=new Map();
test('every published artwork proof resolves its actual source card and market product',()=>{
 assert.equal(doc.schemaVersion,1);assert(doc.links.length>=300);
 const keys=new Set();let priced=0;
 for(const row of doc.links){
  assert(!/\b(?:1ED|1ST|FIRST EDITION|NO RARITY|UNLIMITED|SERIAL|SIGNED)\b/i.test(row.marketName),'Edition requires separate verification');
  assert(row.distance<=8&&row.detailDistance<=14&&row.artDistance<=12&&row.margin>=10,'Unsupported image confidence');
  const filename='data/cards-by-set/'+row.boxCode+'.json';if(!setCache.has(filename))setCache.set(filename,repairs.setCards(read(filename),row.boxCode).cards);
  const card=setCache.get(filename).find(c=>c.image===row.image&&String(c.number||'')===String(row.number||'')&&String(c.fullId||'')===String(row.fullId||''));assert(card,'Source artwork missing: '+row.boxCode+' '+row.number);
  const target=bridge.targetFor({...card,brand:row.brand,language:'ja',boxCode:row.boxCode,setCode:card.setCode||row.boxCode}),product=products.get(row.id);assert(product,row.id);
  const key=match.artworkKey(target);assert(!keys.has(key),'Duplicate artwork binding');keys.add(key);
  const links=bridge.reviewedArtworkLinks([target],[product],{schemaVersion:1,links:[row]},match),resolved=match.createResolver([product],links)(target);
  assert.equal(resolved.status,'matched',row.boxCode+' '+row.number);assert.equal(resolved.id,row.id);
  if(product.minPrice>0){const q=fallback.resolve({...target,snkrdunkId:row.id,snkrProduct:product});assert.equal(q.status,'priced',row.boxCode+' '+row.number);assert.equal(q.source,'snkrdunk');priced++;}
 }
 assert(priced>0);
});
