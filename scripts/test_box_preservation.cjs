'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {checkSnapshot,diskIO,loadBaseline} = require('./verify_box_preservation.cjs');
const image = '/images/pokemon-vintage/Test/tcg-129.webp';
const sha256 = '1'.repeat(64);
const source = ['booster-box','123','https://example.test/box.jpg','https://example.test/product/123'];
function fixture() {
  const baseline = {schemaVersion:1,
    english:[{code:'EN-TEST',sourceId:'17',url:'https://example.test/set/17',minCards:2,sources:[source]}],
    boxes:[{game:'nikke',id:'BOX:123',code:'TEST',sourceGame:'weiss_schwarz',image:'https://example.test/box.jpg',coverType:'box',minCards:2,setIds:[{id:'0123456789abcdef',code:'TEST',sourceGame:'weiss_schwarz',minCards:2}]}],
    vintage:[{setCode:'Test',sourceId:'129',sourceUrl:'https://example.test/card/129',localImage:image,sha256,bytes:3}]};
  const set={id:'0123456789abcdef',code:'TEST',sourceGame:'weiss_schwarz',cardCount:2,file:'/data/tcg-card-info/nikke/0123456789abcdef.json'};
  const documents={
    'data/english-catalog.json':{sets:[{code:'EN-TEST',sourceId:'17',url:'https://example.test/set/17',cardCount:2}]},
    'data/english-set-images.json':{sets:{'EN-TEST':{sources:[{kind:source[0],productId:source[1],image:source[2],sourceUrl:source[3]}]}}},
    'data/tcg-card-info.json':{games:[{id:'nikke',sets:[set],boxes:[{id:'BOX:123',code:'TEST',sourceGame:'weiss_schwarz',image:'https://example.test/box.jpg',coverType:'box',cardCount:2,setIds:[set.id]}]}]},
    'data/pokemon-vintage-image-repairs.json':{images:[{...baseline.vintage[0]}]},
    'data/tcg-card-info/nikke/0123456789abcdef.json':{schemaVersion:1,game:'nikke',set:{...set},cards:[{id:'one'},{id:'two'}]}
  };
  const io={json:name=>{assert(documents[name],'Missing fixture '+name);return documents[name];},
    exists:()=>true,cardInfo:name=>documents[name],vintage:()=>true};
  return {baseline,documents,io};
}
test('existing snapshot passes; new sets, covers, cards and mutable quotes are allowed',()=>{
  const {baseline,documents:d,io}=fixture();
  d['data/english-catalog.json'].sets.push({code:'EN-NEW',sourceId:'99',url:'https://example.test/set/99',cardCount:1});
  d['data/english-catalog.json'].sets[0].cardCount++;
  d['data/english-set-images.json'].sets['EN-TEST'].sources.push({kind:'logo',image:'https://example.test/new-logo.png'});
  d['data/tcg-card-info.json'].games[0].boxes[0].price=500;
  d['data/tcg-card-info/nikke/0123456789abcdef.json'].cards[0].rarity='R';
  d['data/tcg-card-info/nikke/0123456789abcdef.json'].cards.push({id:'new'});
  assert.equal(checkSnapshot(baseline,io).passed,true);
});
test('same-count English identity replacement is rejected',()=>{
  const {baseline,documents:d,io}=fixture();
  d['data/english-catalog.json'].sets[0].code='EN-OTHER';
  assert.throws(()=>checkSnapshot(baseline,io),/English set removed/);
});
test('same-count box identity replacement is rejected',()=>{
  const {baseline,documents:d,io}=fixture();
  d['data/tcg-card-info.json'].games[0].boxes[0].id='BOX:999';
  assert.throws(()=>checkSnapshot(baseline,io),/Box removed/);
});
function migratedCover() {
  const f=fixture(),b=f.baseline.boxes[0],c=f.documents['data/tcg-card-info.json'].games[0].boxes[0];
  b.image='https://cdn.snkrdunk.com/upload_bg_removed/old.webp?size=m';
  c.image='https://cdn.snkrdunk.com/upload_bg_removed/current.webp?size=m';
  c.name='NIKKE Booster Box';
  f.source={source:'SNKRDUNK',brand:'weiss_schwarz',kind:'box',product:{id:'123',brand:'weiss_schwarz',kind:'box',name:c.name,
    productNumber:'WS-TCG-TEST',image:c.image,url:'https://snkrdunk.com/apparels/123'}};
  f.io.boxProduct=(game,id)=>{assert.equal(game,'weiss_schwarz');assert.equal(id,'123');return f.source;};
  return f;
}
test('same sealed SKU may refresh its remote cover from the independent source snapshot',()=>{
  const {baseline,io}=migratedCover();
  const result=checkSnapshot(baseline,io);
  assert.equal(result.sourceCoverUpdates.length,1);
  assert.equal(result.sourceCoverUpdates[0].id,'BOX:123');
  assert.equal(result.networkRequests,0);
});
test('remote cover refresh rejects wrong SKU, game, kind, code, URL, name and unobserved image',()=>{
  for(const patch of [{id:'999'},{brand:'digimon'},{kind:'card'},{productNumber:'WS-TCG-OTHER'},
      {url:'https://snkrdunk.com/apparels/999'},{name:'Other Booster Box'},
      {image:'https://cdn.snkrdunk.com/upload_bg_removed/other.webp'}]) {
    const {baseline,io,source}=migratedCover();Object.assign(source.product,patch);
    assert.throws(()=>checkSnapshot(baseline,io),/image changed/);
  }
  for(const patch of [{source:'OTHER'},{brand:'digimon'},{kind:'card'}]) {
    const {baseline,io,source}=migratedCover();Object.assign(source,patch);
    assert.throws(()=>checkSnapshot(baseline,io),/image changed/);
  }
});
test('source cover updates cannot replace a reviewed local image or use an untrusted host',()=>{
  for(const field of ['old','new']) {
    const {baseline,io,documents:d}=migratedCover();
    if(field==='old')baseline.boxes[0].image='/images/reviewed.webp';
    else d['data/tcg-card-info.json'].games[0].boxes[0].image='https://example.test/wrong.webp';
    assert.throws(()=>checkSnapshot(baseline,io),/image changed/);
  }
});
test('required product cover cannot be replaced by a logo or wrong product',()=>{
  const {baseline,documents:d,io}=fixture();
  d['data/english-set-images.json'].sets['EN-TEST'].sources[0].kind='logo';
  assert.throws(()=>checkSnapshot(baseline,io),/cover: removed/);
});
test('existing local cover must remain present',()=>{
  const {baseline,documents:d,io}=fixture();
  const b=baseline.boxes[0],c=d['data/tcg-card-info.json'].games[0].boxes[0];
  b.image=c.image='/images/box/test.webp';
  io.exists=()=>false;
  assert.throws(()=>checkSnapshot(baseline,io),/missing local cover/);
});
test('same-count linked set replacement is rejected',()=>{
  const {baseline,documents:d,io}=fixture();
  d['data/tcg-card-info.json'].games[0].boxes[0].setIds=['fedcba9876543210'];
  assert.throws(()=>checkSnapshot(baseline,io),/printed set relationship removed/);
});
test('linked inventory file cannot silently shrink',()=>{
  const {baseline,documents:d,io}=fixture();
  d['data/tcg-card-info/nikke/0123456789abcdef.json'].cards.pop();
  assert.throws(()=>checkSnapshot(baseline,io),/printed inventory file shrank/);
});
test('equal manifest total cannot hide a removed artwork',()=>{
  const {baseline,documents:d,io}=fixture();
  d['data/pokemon-vintage-image-repairs.json'].images[0].localImage='/images/pokemon-vintage/Test/tcg-130.webp';
  assert.throws(()=>checkSnapshot(baseline,io),/Reviewed artwork removed/);
});
test('reviewed image bytes cannot be redefined by rewriting the manifest',()=>{
  const {baseline,documents:d,io}=fixture();
  d['data/pokemon-vintage-image-repairs.json'].images[0].sha256='2'.repeat(64);
  assert.throws(()=>checkSnapshot(baseline,io),/reviewed sha256 changed/);
});
test('actual source and packed bundle layouts retain the original public paths',()=>{
  const {baseline,documents:d}=fixture();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tcghub-preservation-'));
  const write=(name,value)=>{const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(value));};
  try {
    for(const [name,doc] of Object.entries(d))write(name,doc);
    const original=path.join(root,image.slice(1));
    fs.mkdirSync(path.dirname(original),{recursive:true});fs.writeFileSync(original,'abc');
    assert.equal(checkSnapshot(baseline,diskIO(root)).passed,true);
    fs.unlinkSync(original);
    fs.unlinkSync(path.join(root,'data/tcg-card-info/nikke/0123456789abcdef.json'));
    const cardPack='data/tcg-card-info-packs/nikke/0.json';
    write(cardPack,{schemaVersion:1,game:'nikke',files:{'0123456789abcdef.json':JSON.stringify(d['data/tcg-card-info/nikke/0123456789abcdef.json'])}});
    const vintagePack='data/pokemon-vintage-packs-v2/Test/2.json';
    write(vintagePack,{schemaVersion:2,bucketSize:64,setCode:'Test',bucket:'2',files:{'tcg-129.webp':{contentType:'image/webp',sha256,bytes:3,data:'YWJj'}}});
    assert.equal(checkSnapshot(baseline,diskIO(root)).passed,true);
    write(vintagePack,{schemaVersion:2,setCode:'Test',files:{}});
    assert.throws(()=>checkSnapshot(baseline,diskIO(root)),/missing from output/);
    write(vintagePack,{schemaVersion:2,setCode:'Test',files:{'tcg-129.webp':{sha256,bytes:3,data:'YWJj'}}});
    write(cardPack,{schemaVersion:1,game:'nikke',files:{}});
    assert.throws(()=>checkSnapshot(baseline,diskIO(root)),/pack lost source/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('real split baseline loader rejects missing parts, stale counts and escaping paths',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tcghub-preservation-index-'));
  const file=path.join(root,'box-preservation-baseline.json');
  const part=path.join(root,'box-preservation-baseline/english-00.json');
  const header={schemaVersion:1,parts:[{kind:'english',file:'box-preservation-baseline/english-00.json'}],counts:{english:1,boxes:0,vintage:0}};
  const save=()=>fs.writeFileSync(file,JSON.stringify(header));
  try {
    fs.mkdirSync(path.dirname(part));fs.writeFileSync(part,JSON.stringify([{code:'EN-TEST'}]));save();
    assert.equal(loadBaseline(file).english[0].code,'EN-TEST');
    header.counts.english=2;save();
    assert.throws(()=>loadBaseline(file),/part count changed/);
    header.counts.english=1;header.parts[0].file='../escape.json';save();
    assert.throws(()=>loadBaseline(file),/Unsafe preservation part path/);
    header.parts[0].file='box-preservation-baseline/english-00.json';save();fs.unlinkSync(part);
    assert.throws(()=>loadBaseline(file),/ENOENT/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
