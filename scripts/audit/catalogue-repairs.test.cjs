'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const text=file=>fs.readFileSync(path.join(root,file),'utf8'),read=file=>JSON.parse(text(file));
const repairs=require('../../assets/card-catalog-repairs.js').configure(read('data/card-catalog-repairs.json'));
const manifest=read('data/card-catalog-repairs.json'),catalogue=read('data/japanese-catalog.json');
const match=require('../../assets/contained-card-match.js');
const metadata=read('data/cards-meta.json').cards;
const products=repairs.products(metadata.map(card=>({...card,id:String(card.id),nameLower:card.name.toLowerCase(),minPrice:17,currency:'USD',listingCount:3})));
function searchContext(){
  const browser={URLSearchParams,console,CardCatalogRepairs:repairs};browser.window=browser;
  vm.createContext(browser);
  for(const file of ['japanese-card-names.js','japanese-catalog.js'])vm.runInContext(text('assets/'+file),browser);
  browser.JapaneseCardNames.configure(read('data/japanese-card-names-ko.json'));
  browser.JapaneseCatalog.configure(catalogue);browser.JapaneseCatalog.setProducts(products);
  browser._ALL_CARDS_INDEX=products;browser._SEARCH_ALIASES=read('data/search-aliases.json');
  const html=text('index.html'),start=html.indexOf('function searchCards('),end=html.indexOf('function renderSearchResults(',start);
  vm.runInContext(html.slice(start,end),browser);return browser;
}
test('all restored reprints have one searchable exact market destination without duplicate rows',()=>{
  const b=searchContext(),rows=b.JapaneseCatalog.getSearchRows();
  for(const card of manifest.onepieceReprints){
    const matched=rows.filter(row=>row.id===card.productId);
    assert.equal(matched.length,1,card.fullId);
    assert.equal(matched[0].fullId,card.fullId);
    assert.equal(matched[0].catalogueId,card.id);
    assert.equal(b.JapaneseCatalog.href(matched[0]),'#price/'+card.productId);
    assert(b.searchCards('OP17 '+card.nameKo,Infinity).some(row=>row.id===card.productId),card.fullId);
  }
});
test('reported OP17 Rocks parallel is searchable by spaced, compact, Korean and Japanese names',()=>{
  const b=searchContext();
  for(const q of ['OP17','OP-17','OP 17','OP17 돈','록스 해적단','ロックス海賊団','돈카드']){
    const result=b.searchCards(q,Infinity);
    assert(result.some(row=>row.id==='871082'),q);
    assert(!result.some(row=>manifest.englishDonProductIds.includes(row.id)),q+' must stay Japanese');
  }
  const rocks=b.JapaneseCatalog.find('871082');assert.match(rocks.nameKo,/록스 해적단.*다이아몬드/);
  assert.equal(b.JapaneseCatalog.href(rocks),'#price/871082');
  for(const q of ['OP17 다이아','OP17 다이아몬드','록스 diamond'])assert.deepEqual(Array.from(b.searchCards(q,Infinity).filter(c=>c.cardType==='DON'),c=>c.id),['871082']);
  assert.deepEqual(Array.from(b.searchCards('OP17 골드',Infinity).filter(c=>c.cardType==='DON'),c=>c.id).sort(),['871079','871080','871081']);
});
test('OP17 contains all eight numberless designs once and retains all 169 official numbered cards',()=>{
  const source=read('data/cards-by-set/OP17.json');
  const before=source.cards.filter(card=>card.cardType!=='DON'),after=repairs.setCards({...source,cards:before},'OP17');
  assert.equal(before.length,169);assert.equal(after.cards.length,177);assert.equal(after.cardCount,177);
  assert.deepEqual(after.cards.slice(0,169),before);
  assert.equal(repairs.setCards(after,'OP17').cards.length,177);
  assert.equal(new Set(after.cards.map(card=>card.fullId)).size,177);
  assert.equal(repairs.setCards({cards:[],code:'OP16'},'OP16').cards.length,0);
});
test('DON identity never borrows another design, finish or English product price',()=>{
  const resolver=match.createResolver(products);
  for(const card of manifest.onepieceDon){
    const target={...card,brand:'onepiece',boxCode:'OP17',language:'ja'};
    assert.equal(resolver(target).id,card.productId,card.fullId);
    assert.equal(resolver(target).status,'matched');
    for(const other of manifest.onepieceDon.filter(row=>row.fullId!==card.fullId))assert(!match.sameIdentity(target,products.find(p=>p.id===other.productId)));
    const product=products.find(p=>p.id===card.productId);
    assert(!match.sameIdentity(target,{...product,language:'en'}));
    assert(!match.sameIdentity(target,{...product,setCode:'OP16'}));
    assert(!match.sameIdentity(target,{...product,cardType:undefined}));
    assert.equal(match.resolve(target,[product,{...product,id:'999999'}]).status,'ambiguous');
  }
});
test('reviewed DON metadata preserves current quotes and never reassigns product IDs',()=>{
  const original={...metadata.find(p=>String(p.id)==='871082'),minPrice:999,currency:'USD',priceCheckedAt:'2026-10-29T01:00:00Z',listingCount:20};
  const saved=JSON.stringify(original),updated=repairs.products([original]).find(p=>p.id==='871082');
  assert.equal(updated.minPrice,999);assert.equal(updated.currency,'USD');assert.equal(updated.priceCheckedAt,original.priceCheckedAt);assert.equal(updated.listingCount,20);assert.equal(JSON.stringify(original),saved);
  const absent=repairs.products([]);assert.equal(absent.length,8+manifest.onepieceReprints.length);assert(absent.every(p=>p.minPrice===null));
  const conflict={...original,brand:'pokemon'};assert.equal(repairs.products([conflict]).find(p=>p.id==='871082'),conflict);
  const unrelated={id:'1',brand:'onepiece',kind:'card',productNumber:'OP17-001'};assert.equal(repairs.products([unrelated])[0],unrelated);
});
test('four reported Pokemon images are repaired in both search and source grids without identity changes',()=>{
  const b=searchContext();
  for(const repair of manifest.pokemonImages){
    const original=catalogue.cards.find(card=>card.id===repair.catalogueId),before=JSON.stringify(original);
    const row=b.JapaneseCatalog.find(repair.catalogueId);
    assert.equal(row.thumbnailUrl,repair.image);assert.equal(row.image,repair.image);
    assert.equal(row.productId,original.productId);assert.deepEqual(Array.from(row.productIds),original.productIds);assert.equal(row.number,original.number);
    assert.equal(JSON.stringify(original),before);
    const source=read('data/cards-by-set/'+repair.setCode+'.json'),card=source.cards.find(c=>c.url===repair.sourceUrl);
    assert.equal(card.image,repair.image);
    const unrelated={...original,id:'JP:wrong',sourceUrl:'https://example.invalid',url:''};
    assert.equal(repairs.printed(unrelated),unrelated);
  }
});
test('all replacement image files match their reviewed hashes and are included in deployment assets',()=>{
  for(const card of [...manifest.onepieceDon,...manifest.pokemonImages]){
    const bytes=fs.readFileSync(path.join(root,card.image));assert(bytes.length>1000);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),card.sha256);
    assert.equal(bytes.toString('ascii',0,4),'RIFF');assert.equal(bytes.toString('ascii',8,12),'WEBP');
  }
  const html=text('index.html');assert(html.indexOf('/assets/card-catalog-repairs.js')<html.indexOf('/assets/japanese-catalog.js'));
  assert(text('sw.js').includes("'/data/card-catalog-repairs.json'"));
});
