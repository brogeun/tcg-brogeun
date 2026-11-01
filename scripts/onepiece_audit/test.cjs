'use strict';
const fs=require('fs'),path=require('path'),test=require('node:test'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const fallback=require('../../assets/card-price-fallback.js');
const target={game:'onepiece',brand:'onepiece',language:'ja',grade:'raw',setCode:'OP01',boxCode:'PROMO',fullNumber:'OP01-025',fullId:'OP01-025_p4',officialId:'OP01-025_p4',rarity:'SR',image:'/official-zoro.png',snkrdunkStatus:'unlinked'};
const row={id:'yuyutei:opc:promo:10001',game:'onepiece',language:'ja',grade:'raw',cardNumber:'OP01-025',setCode:'PROMO',sourceSetCode:'promo',rarity:'P-SR',name:'ロロノア・ゾロ(フラッグシップ優勝)',price:10000,currency:'JPY',priceKind:'asking',sourceUrl:'https://yuyu-tei.jp/sell/opc/card/promo/10001',sourceAsOf:new Date().toISOString()};
const proof={verification:'original-image-and-acquisition',language:'ja',officialId:target.officialId,officialImage:target.image,yuyuteiId:row.id,cardNumber:row.cardNumber,sourceSetCode:row.sourceSetCode,rarity:row.rarity,marketName:row.name,sourceSHA256:'a'.repeat(64),marketSHA256:'b'.repeat(64)};
test('a verified OP-number promo uses its exact shop printing across acquisition namespaces',()=>{
 const bindings={[fallback.targetKey(target)]:proof};assert.equal(fallback.resolve(target,{yuyuRows:[row],bindings}).source,'yuyutei');
 for(const change of [{officialId:'OP01-025_p3'},{marketName:'別カード'},{marketSHA256:''},{cardNumber:'OP01-026'},{officialImage:'/different.png'}]){
  assert.notEqual(fallback.resolve(target,{yuyuRows:[row],bindings:{[fallback.targetKey(target)]:{...proof,...change}}}).source,'yuyutei');
 }
});
test('SNKRDUNK retains priority over a verified shop promo and current quote checks still gate fallback',()=>{
 const p={id:'123',brand:'onepiece',kind:'card',language:'ja',productNumber:'OP01-025',name:'Roronoa Zoro SR [OP01-025]',minPrice:500,currency:'JPY',priceStatus:'available',listingCount:1,sourceUrl:'https://snkrdunk.com/apparels/123'};
 const bindings={[fallback.targetKey(target)]:proof};
 assert.equal(fallback.resolve({...target,snkrProduct:p,snkrdunkId:'123',snkrdunkStatus:'matched'},{yuyuRows:[row],bindings}).source,'snkrdunk');
 assert.notEqual(fallback.resolve({...target,snkrdunkStatus:'artwork-pending'},{yuyuRows:[row],bindings}).source,'yuyutei');
});
test('lazy shop proofs are loaded only after primary price is absent',async()=>{
 const seen=[],bindings={[fallback.targetKey(target)]:proof};
 const result=await fallback.lookup(target,{yuyuRows:[row],mercariReferences:[],fetchJson:async p=>{seen.push(p);return {schemaVersion:1,source:'onepiece-original-image-audit',bindings};}});
 assert.equal(result.source,'yuyutei');assert.deepEqual(seen,['/data/onepiece-reviewed-fallback-links.json']);
});
test('all saved recovery proofs are consumed and blocked prices stay unlinked',()=>{
 const bridge=require('../../assets/contained-card-prices.js'),match=require('../../assets/contained-card-match.js'),repairs=require('../../assets/card-catalog-repairs.js');repairs.configure(read('data/card-catalog-repairs.json'));
 const products=bridge.mergeSetProducts(repairs.products(read('data/all-cards.json').details),read('data/onepiece-eb05-market.json').products),manifest=read('data/onepiece-official-manifest.json'),sources=new Map();
 for(const set of manifest.sets)for(const c of read('data/cards-by-set/'+(set.fileCode||set.code)+'.json').cards)if(c.officialId)sources.set(c.officialId,{...c,brand:'onepiece',language:'ja',boxCode:set.code});
 const report=read('data/onepiece-market-link-audit-20261101.json'),proofs=read('data/onepiece-reviewed-promo-links.json').links.filter(r=>r.auditRun==='20261101-recovery'),search=read('data/onepiece-official-search.json'),byOfficial=new Map(search.cards.map(c=>[c.officialId,c])),keys=new Set();
 for(const p of proofs){const c=sources.get(p.officialId);assert(c,p.officialId);const t=bridge.targetFor(c),k=match.artworkKey(t);assert(!keys.has(k));keys.add(k);const links=bridge.reviewedArtworkLinks([t],products,{schemaVersion:1,links:[p]},match),result=match.createResolver(products,links)(t);assert.equal(result.status,'matched',p.officialId);assert.equal(result.id,p.id,p.officialId);assert.equal(byOfficial.get(p.officialId).productId,p.id);}
 for(const b of report.blockedPreviousLinks){assert.equal(sources.get(b.officialId).marketLinkPolicy,'verified-only');assert.equal(byOfficial.get(b.officialId).productId,null,b.officialId);}
 assert.equal(search.officialCards,report.officialCards);assert.equal(search.linkedProducts,report.linkedAfter);assert.equal(search.cards.length-search.linkedProducts,report.remaining);
 const shop=read('data/onepiece-reviewed-fallback-links.json');for(const [key,b]of Object.entries(shop.bindings)){assert.equal(b.verification,'original-image-and-acquisition');assert(sources.has(b.officialId));assert.match(b.sourceSHA256,/^[a-f0-9]{64}$/);assert.match(b.marketSHA256,/^[a-f0-9]{64}$/);}
});
