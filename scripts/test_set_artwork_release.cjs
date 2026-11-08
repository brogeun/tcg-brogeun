'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {build}=require('./build_english_set_images.cjs'),artwork=require('../assets/japanese-set-artwork.js');
const root=path.resolve(__dirname,'..'),read=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
test('published artwork reproduces the exact reviewed English set and sealed identities',()=>{
 const catalog=read('data/english-catalog.json'),review=read('config/english-set-image-sources.json'),provider=read('config/pokemon-tcg-english-sets.json');
 const shards=Object.fromEntries(review.sets.filter(r=>r.products?.length).map(r=>[r.code,read('data/us-market/'+r.code+'.json')]));
 const before=JSON.stringify({catalog,shards}),rebuilt=build(catalog,review,shards,provider);
 assert.deepEqual(read('data/english-set-images.json'),rebuilt);assert.equal(rebuilt.coverage.productPhotos,211);assert.equal(rebuilt.coverage.rejectedProducts,0);assert.equal(rebuilt.coverage.missingImages,10);assert.equal(JSON.stringify({catalog,shards}),before);
});
test('Japanese packaging uses exact reviewed official URLs and all shared local assets exist',()=>{
 const review=read('config/japanese-packaging-images.json');assert.equal(review.entries.length,10);
 for(const row of review.entries){assert.equal(row.language,'ja');assert.equal(new URL(row.sourceUrl).origin,'https://www.pokemon-card.com');assert.equal(new URL(row.image).origin,'https://www.pokemon-card.com');assert.equal(row.image,row.originalImage);assert.equal(artwork.image({code:row.code}),row.image);assert.equal(artwork.kind({code:row.code}),'pack');}
 for(const image of Object.values(artwork.local))assert(fs.statSync(path.join(root,image)).size>0,image);
});
test('generated Japanese search uses the same artwork and does not add a price',()=>{
 const catalog=require('../assets/japanese-catalog.js');const data={schemaVersion:1,sets:[{code:'SV1S',name:'Scarlet ex',image:'/images/sets/SV1S.jpg'},{code:'BSTXY',name:'The Best of XY',image:'/images/sets/BSTXY.jpg'}],cards:[]},before=JSON.stringify(data);
 const rows=catalog.configure(data),box=rows.find(r=>r.id==='JPSET:SV1S'),pack=rows.find(r=>r.id==='JPSET:BSTXY');assert.equal(box.thumbnailUrl,'/images/box/SV1S.webp');assert.equal(pack.thumbnailUrl,artwork.image({code:'BSTXY'}));assert.equal(pack.language,'ja');assert.equal(pack.minPrice,undefined);assert.equal(JSON.stringify(data),before);
});
