'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {compileSnapshot,FIELDS,writeSnapshot} = require('./build_search_snapshot.cjs');
const repository = path.resolve(__dirname,'..');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'tcghub-search-'));
  fs.mkdirSync(path.join(root,'assets'));
  fs.mkdirSync(path.join(root,'data'));
  fs.copyFileSync(path.join(repository,'index.html'),path.join(root,'index.html'));
  for (const name of ['japanese-card-names','card-catalog-repairs','japanese-catalog','onepiece-official-catalog','anniversary-market','promo-search'])
    fs.copyFileSync(path.join(repository,'assets',name+'.js'),path.join(root,'assets',name+'.js'));
  const write = (name,data) => fs.writeFileSync(path.join(root,'data',name+'.json'),JSON.stringify(data));
  const card = (id,name,extra={}) => ({id,name,brand:'pokemon',kind:'card',language:'ja',thumbnailUrl:'/images/'+id+'.png',productNumber:'pkmn-tcg-sv4k-001',...extra});
  write('cards-meta',{cards:[card('101','Charizard'),card('102','Pikachu'),card('103','Charizard [EN]',{language:'en'}),
    card('104','Psyduck [M2a 054/193] Mirror',{productNumber:'pkmn-tcg-m2a-054'}),
    card('201','DON!! Card',{brand:'onepiece',productNumber:'opc-tcg-op-17-don'}),card('301','Charizard [001/SV-P]')]});
  write('cards-prices',{prices:{101:[99999,'JPY',9],102:[1000,'JPY',3],103:[88888,'USD',6],201:[500,'JPY',4],301:[2000,'JPY',2]}});
  write('price-box-name-overrides',{});
  write('cards-meta-index',{});
  write('price-pokemon-box',{products:[]});
  write('manual-boxes-pokemon',{products:[{id:'401',name:'Ancient Roar Box',code:'SV4K',currency:'JPY',lastPrice:7000}]});
  write('price-onepiece-box',{products:[]});
  write('manual-boxes-onepiece',{products:[{id:'402',name:'Straw Hat Crew Starter Deck',code:'ST01',currency:'JPY',lastPrice:1000}]});
  for (const name of ['anniversary-market','futuristic-market']) write(name,{schemaVersion:1,products:{}});
  write('promo-search',{schemaVersion:1,cards:[]});
  for (const brand of ['pokemon','onepiece']) write('price-'+brand+'-card',{products:[]});
  write('card-catalog-repairs',{schemaVersion:1,pokemonImages:[],englishDonProductIds:[],onepieceDon:[{
    productId:'201',fullId:'OP17-DON-01',setCode:'OP17',boxCode:'OP17',name:'DON!! Card',nameKo:'돈 카드',versionLabel:'일반',image:'/images/onepiece/don.png'}]});
  write('japanese-card-names-ko',{schemaVersion:1,species:{Charizard:'리자몽',Pikachu:'피카츄'},byId:{101:{candidateCatalogueId:'JP:SV4K:001/066'}}});
  write('japanese-catalog',{schemaVersion:1,sets:[{code:'SV4K',name:'Ancient Roar'}],cards:[
    {id:'JP:SV4K:001/066',name:'Charizard',brand:'pokemon',kind:'card',language:'ja',setCode:'SV4K',boxCode:'SV4K',number:'001/066',productId:null,productIds:[],candidateProductIds:['101'],image:'/images/printed.png'},
    {id:'JP:SV4K:002/066',name:'Pikachu',brand:'pokemon',kind:'card',language:'ja',setCode:'SV4K',boxCode:'SV4K',number:'002/066',productId:'102',productIds:['102'],image:'/images/pikachu.png'},
    {id:'JP:M2a:054/193',name:'Psyduck',brand:'pokemon',kind:'card',language:'ja',setCode:'M2a',boxCode:'M2a',number:'054/193',productId:null,productIds:[],candidateProductIds:['104'],image:'/images/psyduck-base.png'}]});
  write('onepiece-official-search',{schemaVersion:1,cards:[
    {id:'JP:ONEPIECE:OP01:OP01-016_p1',name:'Nami',nameKo:'나미',brand:'onepiece',kind:'card',language:'ja',setCode:'OP01',boxCode:'OP01',number:'016',fullId:'OP01-016_p1',image:'/images/nami.png',productId:null},
    {id:'JP:ONEPIECE:OP17:OP01-016_p2',name:'Nami',nameKo:'나미 재록',brand:'onepiece',kind:'card',language:'ja',setCode:'OP01',boxCode:'OP17',number:'016',fullId:'OP01-016_p2',image:'/images/nami-reprint.png',productId:null},
    ...['PRB01','ST01','PROMO','LIMITED'].map((code,index)=>({id:'JP:ONEPIECE:'+code+':P-00'+(index+1),name:'Monkey D Luffy',nameKo:'루피',brand:'onepiece',kind:'card',language:'ja',setCode:'P',boxCode:code,number:'00'+(index+1),fullId:'P-00'+(index+1),image:'/images/luffy-'+index+'.png',productId:null}))]});
  write('onepiece-official-manifest',{schemaVersion:1,sets:[
    {code:'PRB01',name:'프리미엄 카드 베스트',category:'premium_booster'},
    {code:'ST01',name:'밀짚모자 일당 스타트덱',category:'starter'},
    {code:'PROMO',name:'배포 프로모 카드',category:'promotion'},
    {code:'LIMITED',name:'프리미엄 카드 컬렉션',category:'limited_product'}]});
  write('search-aliases',{'리자몽':['Charizard','リザードン']});
  return root;
}
function unpack(snapshot) {return snapshot.rows.map(values=>Object.fromEntries(snapshot.fields.map((field,index)=>{
  const value=values[index];
  return [field,typeof value==='number'&&Array.isArray(snapshot.dictionaries?.[field])?snapshot.dictionaries[field][value]:value];
})));}
test('snapshot preserves reviewed printed, market, promo and DON identities without candidate price leakage',async()=>{
  const root=fixture();
  try {
    const result=await compileSnapshot(root), rows=unpack(result), byId=new Map(rows.map(row=>[row.id,row]));
    assert.deepEqual(result.fields,FIELDS);
    assert.equal(new Set(rows.map(row=>row.id)).size,rows.length);
    assert.equal(byId.has('101'),false,'Reviewed duplicate market product remains suppressed');
    assert.equal(byId.has('103'),false,'Foreign edition never enters Japanese search');
    assert(byId.has('104'),'Unconfirmed mirror candidates remain independent search results');
    assert.equal(byId.get('104').href,'#price/104');
    assert.equal(byId.get('JP:M2a:054/193').minPrice,null,'The mirror candidate never supplies the base printing price');
    const unbound=byId.get('JP:SV4K:001/066');
    assert(unbound);
    assert.equal(unbound.minPrice,null,'Unconfirmed candidate never supplies the official artwork price');
    assert.equal(unbound.productId,null);
    assert.equal(unbound.href,'/?set=SV4K&card=001%2F066#cardinfo');
    const linked=byId.get('JP:SV4K:002/066');
    assert.equal(linked.minPrice,1000);
    assert.equal(linked.href,'#price/102');
    assert.equal(linked.thumbnailUrl,'/images/pikachu.png','Verified artwork survives market linking');
    const nami=byId.get('JP:ONEPIECE:OP01:OP01-016_p1');
    assert(nami,'Official One Piece rows must not disappear from normalized results');
    assert.equal(nami.displayName,'나미');
    assert.equal(nami.href,'/?set=OP01&card=OP01-016_p1#cardinfo');
    assert.equal(byId.get('201').cardType,'DON');
    assert.deepEqual(Array.from(byId.get('301').promoKeys),['sv-p:001']);
    assert.equal(byId.get('401').displayName,'고대의 포효');
    assert.match(byId.get('401').searchText,/고대의 포효/);
    assert.equal(byId.get('402').displayName,'밀짚모자 일당 스타트덱','Manifest-only sealed products receive the reviewed label');
    for(const [code,label] of [['PRB01','프리미엄 카드 베스트'],['ST01','밀짚모자 일당 스타트덱'],['PROMO','배포 프로모 카드'],['LIMITED','프리미엄 카드 컬렉션']]){
      const row=rows.find(row=>row.id.startsWith('JP:ONEPIECE:'+code+':'));
      assert(row);
      assert.equal(row.setName,label);
      assert(row.searchText.includes(label));
      assert(row.href.includes('set='+code+'&card='));
    }
    const reprint=byId.get('JP:ONEPIECE:OP17:OP01-016_p2');
    assert.match(reprint.setName,/세계.*최강/,'The containing box determines a reprint label');
    assert.equal(reprint.href,'/?set=OP17&card=OP01-016_p2#cardinfo');
    assert.equal(result.aliases['리자몽'][0],'Charizard');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('a missing optional-looking source fails the release instead of silently reducing search coverage',async()=>{
  const root=fixture();
  try {
    fs.unlinkSync(path.join(root,'data','promo-search.json'));
    await assert.rejects(compileSnapshot(root),/Incomplete search sources: data\/promo-search\.json/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('content-addressed shards preserve every row, dictionaries, aliases and release identity',async()=>{
  const root=fixture();
  try{
    const result=await compileSnapshot(root), output=path.join(root,'data','search-index-ja.json');
    writeSnapshot(result,output,{maxShardBytes:2500});
    const manifest=JSON.parse(fs.readFileSync(output,'utf8'));
    assert(manifest.shards.length>1);
    assert.deepEqual(manifest.rows,[]);
    const rows=manifest.shards.flatMap(url=>{
      assert.match(url,/^\/data\/search-index-ja\/part-\d{4}-[a-f0-9]{20}\.json$/);
      const file=path.join(root,url.slice(1)), shard=JSON.parse(fs.readFileSync(file,'utf8'));
      assert(fs.statSync(file).size<=2500);
      assert.equal(shard.schemaVersion,1);
      assert.equal(shard.sourceHash,manifest.sourceHash);
      return shard.rows;
    });
    assert.equal(JSON.stringify(rows),JSON.stringify(result.rows));
    assert.deepEqual(manifest.dictionaries,result.dictionaries);
    assert.deepEqual(manifest.aliases,result.aliases);
    assert.equal(rows.length,manifest.counts.total);
    assert.equal(rows.length,manifest.rowCount);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
