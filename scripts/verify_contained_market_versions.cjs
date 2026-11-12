'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const bridge=require(path.join(root,'assets/contained-card-prices.js')),match=require(path.join(root,'assets/contained-card-match.js')),fallback=require(path.join(root,'assets/card-price-fallback.js'));
const repairs=require(path.join(root,'assets/card-catalog-repairs.js'));repairs.configure(read('data/card-catalog-repairs.json'));
const products=repairs.products(read('data/all-cards.json').details),document=bridge.mergeArtworkBindings(read('data/contained-card-market-links.json'),null,read('data/contained-printing-reviews.json'));
const inventory=new Map();
for(const record of document.variants||[]){
 const code=record.boxCode;if(inventory.has(code))continue;
 const doc=repairs.setCards(read('data/cards-by-set/'+code+'.json'),code);
 inventory.set(code,new Map(doc.cards.map(c=>{const target={...c,brand:'pokemon',language:'ja',boxCode:code,setCode:c.setCode||code,number:c.number||'',fullId:c.fullId||''};return [match.artworkKey(target),target];})));
}
const targets=(document.variants||[]).map(r=>{const target=inventory.get(r.boxCode).get(match.artworkKey(r));assert(target,'Source membership no longer exists: '+match.artworkKey(r));return target;}),records=bridge.reviewedArtworkVariants(targets,products,document,match),details=read('data/cards-detail.json'),proofs=new Map((document.variants||[]).map(r=>[match.artworkKey(r),r]));
let memberships=0,marketVersions=0,priced=0;const keys=new Set();
for(const target of targets){
 const key=match.artworkKey(target);assert(!keys.has(key),'Duplicate version source identity');keys.add(key);
 const versions=records[key],proof=proofs.get(key);assert(versions,'Runtime rejected reviewed versions: '+key);assert.equal(versions.length,proof.versions.length);
 const t={...bridge.targetFor(target),snkrdunkStatus:'variant-linked',snkrVariants:versions.map(v=>({...v,product:bridge.withRawDetail(v.product,details)}))};
 const quote=fallback.resolve(t);assert.equal(quote.status,'variants');assert.equal(quote.amount,null);
 for(const v of quote.variants){const version=proof.versions.find(p=>p.id===v.id);assert(version);assert.equal(v.label,version.label);marketVersions++;if(v.quote.status==='priced'){assert(Number.isFinite(v.quote.amount)&&v.quote.amount>0);priced++;}}
 const html=fallback.render(quote,{convert:n=>n*10});assert(!html.includes('카드별 가격 연결 확인 필요'));memberships++;
}
console.log(JSON.stringify({memberships,marketVersions,currentlyPricedVersions:priced,invalid:0}));
