const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const start=html.indexOf('const CARDINFO = ')+17;
const end=html.indexOf('\n};',start)+2;
const catalog=new Function('return ('+html.slice(start,end)+')')();
const api=require('../assets/price-product-info.js');
const data={meta:read('data/cards-meta-index.json'),cardToBox:read('data/card-to-box.json').cards,overrides:read('data/price-box-name-overrides.json'),manual:{pokemon:read('data/manual-boxes-pokemon.json').products,onepiece:read('data/manual-boxes-onepiece.json').products}};
data.cardOverrides=read('data/price-card-name-overrides.json');
const result=(id,brand,box,extra={})=>api.resolve({id,...extra},brand,box,catalog,data);
for(const [id,code,date] of [['846048','M6','2026.07.31'],['806644','M5','2026.05.22'],['743533','M3','2026.01.23'],['722239','M2a','2025.11.28']]){
 const match=result(id,'pokemon',id!=='722239');
 assert.equal(match.sets[0]?.code,code,id);assert.equal(match.sets[0]?.release,date,id);
}
// Registered boxes without a CARDINFO.boxId still resolve through their exact manual product ID.
for(const brand of ['pokemon','onepiece'])for(const product of data.manual[brand]){
 const set=catalog[brand].find(s=>s.code.toLowerCase()===String(product.code).toLowerCase());
 if(set){assert(result(product.id,brand,true).sets.some(s=>s===set),`${brand} ${product.id} ${set.code}`);}
}
// All recorded card-to-box IDs retain every valid catalog link, including reprints.
let mappedCardIds=0;
for(const [id,links] of Object.entries(data.cardToBox))for(const brand of ['pokemon','onepiece']){
 const expected=[...new Set(links.map(l=>l.setCode).filter(code=>catalog[brand].some(s=>s.code===code)))];
 if(!expected.length)continue;
 const match=result(id,brand,false);assert.deepEqual(match.sets.map(s=>s.code).sort(),expected.sort());mappedCardIds++;
}
assert.equal(result('not-registered','pokemon',false,{name:'[SAR] Example [M5 123/098]'}).sets[0].code,'M5');
assert.equal(result('not-registered','pokemon',false,{productNumber:'pkmn-tcg-M6-001'}).sets[0].code,'M6');
assert.equal(result('not-registered','onepiece',false,{code:'OP-16-095'}).sets[0].code,'OP16');
assert.equal(result('not-registered','pokemon',true,{name:'Similar Abyss Box'}).sets.length,0);
assert.equal(result('887992','onepiece',false,{name:'Monkey.D.Luffy P [P-099] (Promotional Card)'}).sets.length,0);
assert.equal(result('846050','pokemon',true).sets[0].code,'M6');
assert.equal(result('846049','pokemon',true).sets[0].code,'M6');
assert.equal(result('864496','onepiece',true).sets[0].code,'OP17');
const counts={};const unmatched={};
for(const brand of ['pokemon','onepiece']){
 const products=new Map();
 for(const file of [`manual-boxes-${brand}`,`price-${brand}-box`,`price-${brand}-card`,`top10-${brand}`])for(const p of read(`data/${file}.json`).products || []){
  const previous=products.get(String(p.id)) || {};
  products.set(String(p.id),{...previous,...p,code:p.code || previous.code,_srcFile:file});
 }
 counts[brand]={checked:products.size,matched:0,unregistered:0};unmatched[brand]=[];
 for(const product of products.values()){
  const extra=data.overrides[product.id] || data.meta[product.id] || {};
  const p={...product,name:/^Card #/.test(product.name)?extra.name || product.name:product.name};
  const isCard=extra.kind==='card' || /-card$/.test(p._srcFile) || /\[[^\]]*\d+[^\]]*\]/.test(p.name);
  const match=result(product.id,brand,!isCard,p);
  if(match.sets.length)counts[brand].matched++;else{counts[brand].unregistered++;unmatched[brand].push({id:p.id,name:p.name,reason:match.via});}
 }
}
console.log(JSON.stringify({ok:true,catalogSets:{pokemon:catalog.pokemon.length,onepiece:catalog.onepiece.length},mappedCardIds,products:counts,unmatched},null,2));
