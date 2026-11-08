'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const match=require('../assets/contained-card-match.js'),fallback=require('../assets/card-price-fallback.js'),bridge=require('../assets/contained-card-prices.js');
test('WCP searches the two original market namespaces without joining a different printed fraction',()=>{
 const t={brand:'pokemon',setCode:'WCP',boxCode:'WCP',number:'001/108',name:'Seedot',language:'ja'};
 const p={brand:'pokemon',id:'435001',kind:'card',name:'Seedot :1ED [PCG-WC 001/108](World Champions Pack)',productNumber:'pkmn-tcg-PCG-WCP-001'};
 assert.equal(match.sameIdentity(t,p),true);assert.equal(match.createResolver([p]).candidates(t).length,1);
 for(const patch of [{name:'Seedot [PCG-WC 001/100](World Champions Pack)'},{productNumber:'pkmn-tcg-en-WCP-001'},{language:'en'},{kind:'box'}])assert.equal(match.sameIdentity(t,{...p,...patch}),false);
 assert.notEqual(match.resolve(t,[p]).status,'matched');
});
test('a generic movie SKU requires the exact 2009 acquisition and complete printed number',()=>{
 const t={brand:'pokemon',language:'ja',boxCode:'DPt-MRP09',setCode:'DPt-MRP09',number:'010/022',name:'Spiky-eared Pichu',marketLinkPolicy:'verified-only'};
 const p={id:'614304',brand:'pokemon',kind:'card',productNumber:'pkmn-tcg-761',name:'Spiky-eared Pichu M [010/022](Promotional Cards"Movie Release Commemorative Random Pack 2009")'};
 assert.equal(match.sameIdentity(t,p),true);assert.equal(match.createResolver([p]).candidates(t).length,1);assert.equal(match.resolve(t,[p]).status,'unlinked');
 for(const name of ['Spiky-eared Pichu M [009/022](Movie Release Commemorative Random Pack 2009)','Spiky-eared Pichu M [042/DPt-P](Promotional Cards)','Spiky-eared Pichu M [010/022](Movie Release Commemorative Random Pack 2008)'])assert.equal(match.sameIdentity(t,{...p,name}),false);
});
const target={brand:'pokemon',game:'pokemon',language:'ja',grade:'raw',boxCode:'SD',setCode:'SD',number:'001/127',fullNumber:'001/127',sourceId:'ja-sd-1',name:'Venusaur V',image:'https://cdn.pooka.app/card/ja-sd-1.png?size=small',snkrdunkStatus:'unlinked',rarity:''};
const row={id:'yuyutei:poc:sd:10001',game:'pokemon',language:'ja',grade:'raw',setCode:'SD',sourceSetCode:'sd',cardNumber:'001/127',rarity:'TD',name:'フシギバナV',currency:'JPY',priceKind:'asking',price:500,sourceUrl:'https://yuyu-tei.jp/sell/poc/card/sd/10001',sourceAsOf:new Date().toISOString(),stockState:'in_stock'};
const binding={verification:'original-image-and-acquisition',language:'ja',officialId:target.sourceId,officialImage:target.image,cardNumber:'001/127',sourceSetCode:'sd',marketName:row.name,rarity:'TD',yuyuteiId:row.id,sourceSHA256:'a'.repeat(64),marketSHA256:'b'.repeat(64)};
const bindings={[fallback.targetKey(target)]:binding};
test('legacy cards with missing IDs and numbers keep image repairs scoped to their individual original URLs',()=>{
 const repairs=require('../assets/card-catalog-repairs.js'),placeholder='https://static.tcgcollector.com/build/images/default-card-image.png';
 const a={name:'Weedle',number:'',image:placeholder,url:'https://www.tcgcollector.com/cards/27080/weedle'},b={name:'Kakuna',number:'',image:placeholder,url:'https://www.tcgcollector.com/cards/27081/kakuna'},c={name:'Other',number:'',image:placeholder,url:'https://www.tcgcollector.com/cards/27082/other'};
 repairs.configure({schemaVersion:1,onepieceDon:[],englishDonProductIds:[],pokemonImages:[{catalogueId:'reviewed-source:a',setCode:'DP4-Bm',number:'',sourceUrl:a.url,image:'https://static.tcgcollector.com/front-a.webp'},{catalogueId:'reviewed-source:b',setCode:'DP4-Bm',number:'',sourceUrl:b.url,image:'https://static.tcgcollector.com/front-b.webp'}]});
 const fixed=repairs.setCards({cards:[a,b,c]},'DP4-Bm').cards;assert.equal(fixed[0].image,'https://static.tcgcollector.com/front-a.webp');assert.equal(fixed[1].image,'https://static.tcgcollector.com/front-b.webp');assert.equal(fixed[2].image,placeholder);assert(fixed.every(card=>card.number===''));assert.equal(a.image,placeholder);
});
test('an English translated series title does not override independent original Japanese product evidence',()=>{
 const p={id:'695870',brand:'pokemon',kind:'card',name:'Marnie [sD 120/127](Sword & Shield "V Starter Decks")',productNumber:'pkmn-tcg-sD-120',thumbnailUrl:'https://cdn.snkrdunk.com/reviewed.webp'};
 const proof={id:p.id,marketName:p.name,marketProductNumber:p.productNumber,marketImage:p.thumbnailUrl,sourceUrl:'https://snkrdunk.com/apparels/'+p.id,originalTitleJa:'マリィ [sD 120/127](ソード&シールド「Vスタートデッキ」)',sourceSHA256:'a'.repeat(64),marketSHA256:'b'.repeat(64),marketPageSHA256:'c'.repeat(64)};
 assert.equal(match.foreign(p),true);const doc={schemaVersion:1,japaneseProducts:[proof]},verified=bridge.reviewedJapaneseProducts([p],doc)[0];assert.equal(verified.language,'ja');assert.equal(match.foreign(verified),false);
 for(const patch of [{marketName:'Other title'},{marketImage:'https://cdn.snkrdunk.com/other.webp'},{marketPageSHA256:''},{originalTitleJa:'マリィ【英語版】'}])assert.equal(bridge.reviewedJapaneseProducts([p],{schemaVersion:1,japaneseProducts:[{...proof,...patch}]})[0].language,undefined);
 assert.equal(match.foreign({...verified,name:'Marnie [EN 120/127]'}),true);
});
test('a naturally unprinted starter-deck rarity can use independently checked source image and shop product',()=>{
 assert.notEqual(fallback.resolve(target,{yuyuRows:[row]}).status,'priced');
 const q=fallback.resolve(target,{yuyuRows:[row],bindings});assert.equal(q.status,'priced');assert.equal(q.source,'yuyutei');assert.equal(q.amount,500);assert.equal(q.currency,'JPY');
 for(const patch of [{sourceId:'ja-sd-2'},{image:'https://cdn.pooka.app/other.png'},{language:'en'},{fullNumber:'001/128'}])assert.notEqual(fallback.resolve({...target,...patch},{yuyuRows:[row],bindings}).status,'priced');
 for(const patch of [{name:'別のカード'},{sourceSetCode:'s1d'},{id:'yuyutei:poc:sd:10002'},{rarity:'SR'},{language:'en'}])assert.notEqual(fallback.resolve(target,{yuyuRows:[{...row,...patch}],bindings}).status,'priced');
 const forged={[fallback.targetKey(target)]:{...binding,marketSHA256:''}};assert.notEqual(fallback.resolve(target,{yuyuRows:[row],bindings:forged}).status,'priced');
});
test('Pokemon lookup loads the scoped reviewed registry and leaves existing SNKR priority in place',async()=>{
 const calls=[];const load=async url=>{calls.push(url);if(url==='/data/yuyutei-market/pokemon.json')return {source:'yuyutei',game:'pokemon',records:[row]};if(url==='/data/pokemon-reviewed-fallback-links.json')return {schemaVersion:1,source:'pokemon-original-image-audit',bindings};throw Error(url);};
 const q=await fallback.lookup(target,{fetchJson:load});assert.equal(q.source,'yuyutei');assert(calls.includes('/data/pokemon-reviewed-fallback-links.json'));
 const p={brand:'pokemon',kind:'card',language:'ja',id:'123',name:'Venusaur V [SD 001/127]',productNumber:'pkmn-tcg-SD-001',minPrice:1000,currency:'JPY',listingCount:2,priceStatus:'available'};
 const linked={...target,snkrdunkStatus:'matched',snkrdunkId:'123',snkrProduct:p};calls.length=0;const first=await fallback.lookup(linked,{fetchJson:load});assert.equal(first.source,'snkrdunk');assert.equal(first.amount,1000);assert.equal(calls.length,0);
});
test('the normal browser registry loader retains original Japanese product receipts',async()=>{
 const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
 const t={brand:'pokemon',language:'ja',boxCode:'SD',setCode:'SD',number:'120/127',image:'https://cdn.pooka.app/card/ja-sd-120.png',marketLinkPolicy:'verified-only'};
 const p={id:'695870',brand:'pokemon',kind:'card',name:'Marnie [sD 120/127](Sword & Shield "V Starter Decks")',productNumber:'pkmn-tcg-sD-120',thumbnailUrl:'https://cdn.snkrdunk.com/reviewed.webp'};
 const link={...t,id:p.id,marketName:p.name,marketProductNumber:p.productNumber,marketImage:p.thumbnailUrl,sourceSHA256:'a'.repeat(64),marketSHA256:'b'.repeat(64)};
 const receipt={...link,sourceUrl:'https://snkrdunk.com/apparels/'+p.id,originalTitleJa:'マリィ [sD 120/127](ソード&シールド「Vスタートデッキ」)',marketPageSHA256:'c'.repeat(64)};
 const doc={schemaVersion:1,links:[link],variants:[],japaneseProducts:[receipt]},calls=[];
 const context={module:{exports:{}},URL,AbortSignal,document:{},fetch:async url=>{calls.push(url);return {ok:true,json:async()=>url.includes('contained-card-market-links')?doc:{schemaVersion:1,links:[]}};}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../assets/contained-card-prices.js'),'utf8'),context);
 const prepared=await context.module.exports.prepareTarget(t,{services:{match,loadProducts:async()=>[p],loadDetails:async()=>({cards:{}})}});
 assert.equal(prepared.snkrdunkStatus,'matched');assert.equal(prepared.snkrdunkId,p.id);assert(calls.some(url=>url.includes('contained-card-market-links')));
});
