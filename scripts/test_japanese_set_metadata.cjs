'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const {compileSetMetadata,writeSetMetadata,BUCKET_COUNT}=require('./build_japanese_set_metadata.cjs');
const {compileSnapshot}=require('./build_search_snapshot.cjs');
const {indexSetReferences,enrichSetCards}=require('../assets/japanese-catalog.js');
const repository=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(repository,'assets/japanese-catalog.js'),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const row=(url,extra={})=>({_catalogue:true,kind:'card',boxCode:'SV4K',setCode:'SV4K',sourceUrl:url,rarity:'C',...extra});
function legacy(cards,rows,setCode){
  // The previous openSetGrid contract, independent of the new projection/decoder.
  const refs=new Map();
  for(const reference of rows){
    if(!reference._catalogue||reference.kind!=='card'||String(reference.boxCode||reference.setCode||'').toUpperCase()!==setCode.toUpperCase())continue;
    const url=String(reference.sourceUrl||reference.url||'');if(url)refs.set(url,refs.has(url)?null:reference);
  }
  return cards.map(card=>{
    const ref=refs.get(String(card.url||card.sourceUrl||''));if(!ref)return card;
    const enriched={...card};
    if((!enriched.rarity||!String(enriched.rarity).trim())&&typeof ref.rarity==='string')enriched.rarity=ref.rarity;
    if(ref.unprintedNumber){enriched.unprintedNumber=true;enriched.inventoryNumber=ref.inventoryNumber;}
    return enriched;
  });
}
function temporary(rows,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tcghub-set-meta-'));
  const output=path.join(root,'japanese-set-metadata.json');
  return {root,output,...writeSetMetadata(rows,output,options)};
}
function browser(files,{intercept}={}){
  const requests=[],fetchOptions=[],context={URLSearchParams,AbortSignal,console};context.window=context;
  context.fetch=async(resource,options)=>{
    const url=String(resource);requests.push(url);fetchOptions.push(options);
    if(intercept){const result=await intercept(url,requests);if(result)return result;}
    const parsed=new URL(url,'https://tcghub.kr');
    assert.equal(parsed.origin,'https://tcghub.kr','metadata must not request another origin');
    assert.ok(parsed.pathname==='/data/japanese-set-metadata.json'||parsed.pathname.startsWith('/data/japanese-set-metadata/'),'set opening must not request full catalogue/search/price files');
    const file=path.join(files.root,parsed.pathname.replace(/^\/data\//,''));
    return {ok:fs.existsSync(file),status:fs.existsSync(file)?200:404,json:async()=>JSON.parse(fs.readFileSync(file,'utf8'))};
  };
  vm.createContext(context);vm.runInContext(source,context);
  return {context,api:context.JapaneseCatalog,requests,fetchOptions};
}

test('only unambiguous exact source URLs can fill the same three fields as before',async()=>{
  const rows=[row('https://source.test/a',{rarity:'R'}),row('https://source.test/dup'),row('https://source.test/dup'),
    row('https://source.test/unprinted',{rarity:'',unprintedNumber:true,inventoryNumber:'006'}),
    row('https://source.test/undefined',{unprintedNumber:true,inventoryNumber:undefined}),
    row('https://source.test/priority',{url:'https://source.test/ignored',rarity:'U'}),
    row('https://source.test/a?variant=mirror',{rarity:'AR'}),row(' https://source.test/a ',{rarity:'SR'}),
    row('https://source.test/other',{boxCode:'OTHER',rarity:'SAR'}),row('https://source.test/not-printed',{_catalogue:false,rarity:'UR'}),
    row('https://source.test/box',{kind:'box',rarity:'UR'})];
  const cards=['a','dup','unprinted','undefined','priority','ignored','other','not-printed','box'].map((tail,i)=>
    ({id:'keep-'+i,name:'Original '+i,url:'https://source.test/'+tail,rarity:'',number:String(i),image:'/image/'+i+'.png',productId:'market-'+i,minPrice:7654}));
  cards.push({url:'https://source.test/a',rarity:'RR'},{url:'https://source.test/a',rarity:'   '},
    {url:'https://source.test/a?variant=mirror',rarity:''},{url:' https://source.test/a ',rarity:''},
    {url:'https://source.test/a',sourceUrl:'https://source.test/other',rarity:''});
  const before=JSON.stringify({rows,cards}),files=temporary(rows);
  try{
    const {api,requests}=browser(files),refs=await api.ensureSetMetadata('sv4k');
    assert.deepEqual(plain(api.enrichSetCards(cards,refs)),plain(legacy(cards,rows,'SV4K')));
    assert.deepEqual(plain(enrichSetCards(cards,indexSetReferences(rows,'SV4K'))),plain(legacy(cards,rows,'SV4K')));
    assert.equal(refs.get('https://source.test/dup'),null,'identical duplicate records remain ambiguous');
    assert.equal(plain(api.enrichSetCards(cards,refs))[1].rarity,'');
    assert.equal(plain(api.enrichSetCards(cards,refs))[9].rarity,'RR');
    const unprinted=api.enrichSetCards(cards,refs)[3];assert.ok(Object.hasOwn(unprinted,'inventoryNumber'));assert.equal(unprinted.inventoryNumber,undefined);
    for(let i=0;i<9;i++)for(const field of ['id','name','number','image','productId','minPrice'])assert.equal(api.enrichSetCards(cards,refs)[i][field],cards[i][field]);
    assert.equal(JSON.stringify({rows,cards}),before,'source rows and cards remain untouched');
    assert.equal(requests.length,2);assert.equal(api.getSearchRows().length,0,'metadata does not create the global search index');
  }finally{fs.rmSync(files.root,{recursive:true,force:true});}
});

test('projection preserves a containing box, case folding, missing/empty rarity and numberless null values',async()=>{
  const rows=[row('a',{boxCode:'sV4K',setCode:'OTHER',rarity:null}),row('b',{rarity:'',unprintedNumber:true,inventoryNumber:null}),
    row('c',{rarity:23,unprintedNumber:true,inventoryNumber:0}),row('d',{rarity:' U '})];
  const files=temporary(rows),cards=['a','b','c','d'].map(url=>({url,rarity:'',image:'keep.webp',number:'existing'}));
  try{
    const {api}=browser(files),refs=await api.ensureSetMetadata('SV4K');
    assert.deepEqual(plain(api.enrichSetCards(cards,refs)),plain(legacy(cards,rows,'SV4K')));
    assert.equal(refs.size,4);assert.equal(api.enrichSetCards(cards,refs)[1].inventoryNumber,null);
    assert.equal(api.enrichSetCards(cards,refs)[2].inventoryNumber,0);
    assert.equal(api.enrichSetCards(cards,refs)[3].rarity,' U ','source values are not normalized');
  }finally{fs.rmSync(files.root,{recursive:true,force:true});}
});

test('a maximum of 16 packs plus one manifest covers every set and old generated digests do not accumulate',()=>{
  const rows=Array.from({length:256},(_,i)=>row('source-'+i,{boxCode:'SET-'+i,rarity:i%2?'C':'U'})),files=temporary(rows);
  try{
    assert.equal(files.files,17);assert.equal(files.manifest.setCount,256);assert.equal(files.manifest.buckets.length,BUCKET_COUNT);
    assert.equal(fs.readdirSync(path.join(files.root,'japanese-set-metadata')).length,16);
    const repeated=writeSetMetadata([...rows].reverse(),files.output);assert.deepEqual(repeated.manifest,files.manifest,'input ordering does not change exact-source projection');
    fs.writeFileSync(path.join(files.root,'japanese-set-metadata','unrelated.txt'),'retain');
    writeSetMetadata([...rows,row('new',{boxCode:'SET-0'})],files.output);
    assert.equal(fs.readdirSync(path.join(files.root,'japanese-set-metadata')).filter(file=>file.endsWith('.json')).length,16);
    assert.equal(fs.readFileSync(path.join(files.root,'japanese-set-metadata','unrelated.txt'),'utf8'),'retain');
    assert.throws(()=>compileSetMetadata(rows,{bucketCount:17}),/Invalid/);
    assert.throws(()=>writeSetMetadata(rows,files.output,{maxBucketBytes:16}),/asset budget/);
  }finally{fs.rmSync(files.root,{recursive:true,force:true});}
});

test('same-pack concurrent sets and repeated selections fetch only one manifest and one pack',async()=>{
  const files=temporary([row('a'),row('b',{boxCode:'OTHER'})],{bucketCount:1});
  try{
    const {api,requests}=browser(files);
    const [a,b,again]=await Promise.all([api.ensureSetMetadata('sv4k'),api.ensureSetMetadata('OTHER'),api.ensureSetMetadata('SV4K')]);
    assert.equal(a,again);assert.ok(a.has('a'));assert.ok(b.has('b'));assert.equal(requests.length,2);
    const unknown=await api.ensureSetMetadata('unknown-set');assert.equal(unknown.size,0);assert.equal(requests.length,2);
  }finally{fs.rmSync(files.root,{recursive:true,force:true});}
});

test('manifest failures and mismatched cached packs are never stored as a successful set',async()=>{
  const files=temporary([row('a')]);
  try{
    let manifestFails=1,badPack=true;
    const {api,requests}=browser(files,{intercept:async url=>{
      if(url.includes('japanese-set-metadata.json')&&manifestFails-->0)return {ok:false,status:503};
      if(url.includes('/bucket-')&&badPack)return {ok:true,json:async()=>({schemaVersion:1,version:'jp-set-metadata-v1',bucket:0,contentHash:'0'.repeat(64),sets:{SV4K:[]}})};
    }});
    await assert.rejects(api.ensureSetMetadata('SV4K'),/HTTP 503/);
    await assert.rejects(api.ensureSetMetadata('SV4K'),/Mismatched/);
    badPack=false;const refs=await api.ensureSetMetadata('SV4K');assert.equal(refs.get('a').rarity,'C');
    assert.ok(requests.filter(url=>url.includes('japanese-set-metadata.json')).length>=3);
  }finally{fs.rmSync(files.root,{recursive:true,force:true});}
});

test('invalid manifest destinations cannot send metadata requests outside the generated pack directory',async()=>{
  const files=temporary([row('a')]);
  try{
    const malicious=plain(files.manifest);malicious.buckets[0].url='https://other.invalid/steal.json';
    const {api,requests}=browser(files,{intercept:async()=>({ok:true,json:async()=>malicious})});
    await assert.rejects(api.ensureSetMetadata('SV4K'),/Invalid.*bucket/);assert.equal(requests.length,1);
  }finally{fs.rmSync(files.root,{recursive:true,force:true});}
});

test('the service worker refreshes the mutable metadata manifest and reuses exact hashed pack bytes',async()=>{
  const handlers=new Map(),stores=new Map(),requests=[];
  const context={URL,Response,location:{origin:'https://tcghub.kr'},self:{addEventListener:(name,fn)=>handlers.set(name,fn)},
    caches:{open:async name=>{if(!stores.has(name))stores.set(name,new Map());const store=stores.get(name);return {match:async req=>store.get(req.url)?.clone(),put:async(req,res)=>store.set(req.url,res)};}},
    fetch:async req=>{requests.push(req.url);return new Response('response-'+requests.length);}};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(repository,'sw.js'),'utf8'),context);
  async function get(name,cache='default'){let response;handlers.get('fetch')({request:{method:'GET',url:'https://tcghub.kr'+name,cache},respondWith:value=>{response=value;}});return (await response).text();}
  const pack='/data/japanese-set-metadata/bucket-03-0123456789abcdefabcd.json';
  const first=await get(pack);assert.equal(first,await get(pack));assert.equal(requests.length,1);
  const refreshed=await get(pack,'reload');assert.notEqual(refreshed,first);assert.equal(refreshed,await get(pack),'a validated retry refreshes the stored pack too');
  assert.notEqual(await get('/data/japanese-set-metadata.json?v=test'),await get('/data/japanese-set-metadata.json?v=test'));
});

test('all production catalogue sets preserve the previous exact enrichment and image/price identities',async()=>{
  const originalFiles=['data/japanese-catalog.json','data/card-catalog-repairs.json','data/cards-meta.json','data/cards-prices.json'];
  const before=originalFiles.map(shaFile=>sha(path.join(repository,shaFile)));
  let references;const snapshot=await compileSnapshot(repository,{onJapaneseRows:rows=>{references=rows;}});
  assert.ok(references.length>18000);assert.equal(snapshot.rowCount,snapshot.rows.length);
  const files=temporary(references);let compared=0;
  try{
    const {api,requests}=browser(files);
    for(const code of Object.keys(files.manifest.sets)){
      const candidates=references.filter(row=>row._catalogue&&row.kind==='card'&&String(row.boxCode||row.setCode||'').toUpperCase()===code);
      const cards=candidates.flatMap((ref,i)=>[
        {...plain(ref),url:String(ref.sourceUrl||ref.url||''),rarity:'',image:'original-'+i+'.webp',minPrice:1234},
        {url:String(ref.sourceUrl||ref.url||''),rarity:'PRESERVE',id:'original-'+i,number:'keep-number',localImage:'keep-local.webp',productId:'keep-market-id',minPrice:4321},
      ]);
      const refs=await api.ensureSetMetadata(code);
      assert.deepEqual(plain(api.enrichSetCards(cards,refs)),plain(legacy(cards,references,code)),code+' legacy output changed');
      compared+=cards.length;
    }
    let inventorySets=0,inventoryCards=0;
    const directory=path.join(repository,'data/cards-by-set');
    const originalInventoryHashes=[];
    for(const file of fs.readdirSync(directory).filter(file=>file.endsWith('.json'))){
      const filename=path.join(directory,file),inventory=JSON.parse(fs.readFileSync(filename,'utf8'));
      const code=String(inventory.code||file.slice(0,-5)).toUpperCase();
      if(!Object.hasOwn(files.manifest.sets,code)||!Array.isArray(inventory.cards))continue;
      originalInventoryHashes.push([filename,sha(filename)]);
      const refs=await api.ensureSetMetadata(code),original=JSON.stringify(inventory);
      assert.deepEqual(plain(api.enrichSetCards(inventory.cards,refs)),plain(legacy(inventory.cards,references,code)),file+' actual inventory changed');
      assert.equal(JSON.stringify(inventory),original);inventorySets++;inventoryCards+=inventory.cards.length;
    }
    assert.ok(inventorySets>=190,'full production parity must include actual Japanese set inventories');
    assert.ok(inventoryCards>=18000,'full production parity must include every original Japanese contained card');
    for(const [file,before] of originalInventoryHashes)assert.equal(sha(file),before,'original inventory was rewritten');
    assert.equal(requests.length,17,'all sets together remain bounded to one manifest and 16 packs');
    assert.equal(api.getSearchRows().length,0);
    assert.deepEqual(originalFiles.map(file=>sha(path.join(repository,file))),before,'original data must never be rewritten');
    console.log(JSON.stringify({setMetadataParity:{sets:files.manifest.setCount,cardsCompared:compared,references:files.manifest.referenceCount,
      files:files.files,manifestBytes:files.manifestBytes,totalBytes:files.totalBytes,maximumBucketBytes:files.maximumBucketBytes,inventorySets,inventoryCards}}));
  }finally{fs.rmSync(files.root,{recursive:true,force:true});}
});

test('malformed selected rows and a pack removed by a later deployment recover through a fresh manifest',async()=>{
  const files=temporary([row('a')]);
  try{
    let corrupt=1,packRequests=0;
    const {api,fetchOptions}=browser(files,{intercept:async url=>{
      if(!url.includes('/bucket-'))return;packRequests++;
      if(corrupt-->0){const parsed=JSON.parse(fs.readFileSync(path.join(files.root,url.replace(/^\/data\//,'')),'utf8'));parsed.sets.SV4K=[['a','C',false]];return {ok:true,json:async()=>parsed};}
    }});
    assert.equal((await api.ensureSetMetadata('SV4K')).get('a').rarity,'C');assert.equal(packRequests,2,'bad decoded rows must evict the cached pack');assert.ok(fetchOptions.some(options=>options?.cache==='reload'),'a decoder retry must bypass a corrupted SW cache entry');
    const late=browser(files);await late.api.ensureSetMetadata('UNKNOWN'); // cache only the old manifest
    writeSetMetadata([row('a',{rarity:'AR'})],files.output);
    assert.equal((await late.api.ensureSetMetadata('SV4K')).get('a').rarity,'AR');
    assert.equal(late.requests.filter(url=>url.includes('japanese-set-metadata.json')).length,2);
  }finally{fs.rmSync(files.root,{recursive:true,force:true});}
});

function gridBrowser(files,intercept){
  const b=browser(files,{intercept}),nodes=new Map();
  class Element{
    constructor(id=''){this.id=id;this.scrollTop=0;this.classes=new Set();this.classList={add:(...names)=>names.forEach(name=>this.classes.add(name)),contains:name=>this.classes.has(name),toggle:name=>this.classes.has(name)?(this.classes.delete(name),false):(this.classes.add(name),true)};}
    get innerHTML(){return this.content||'';}
    set innerHTML(content){this.content=String(content);for(const match of this.content.matchAll(/\bid="([^"]+)"/g))if(match[1]!==this.id)nodes.set(match[1],new Element(match[1]));}
    setAttribute(){}addEventListener(){}focus(){}
    querySelector(selector){if(selector==='.ci-panel-scroll')return scroll;if(selector==='.modal-box')return box;return null;}
  }
  const modal=new Element('anyModal'),scroll=new Element('scroll'),box=new Element('box');nodes.set('anyModal',modal);
  const inventories={SV4K:{cards:[{id:'source-a',name:'A-card',number:'001',url:'a',image:'/keep-a.webp'}]},SV4M:{cards:[{id:'source-b',name:'B-card',number:'002',url:'b',image:'/keep-b.webp'}]}};
  Object.assign(b.context,{CI_PANEL_REQUEST:0,CI_CARD_PAGE_SIZE:18,URL,
    CARDINFO:{pokemon:[{code:'SV4K',name:'A-set'},{code:'SV4M',name:'B-set'}],onepiece:[]},
    document:{getElementById:id=>nodes.get(id)||null,querySelectorAll:()=>[],activeElement:null},
    ciIcon:()=>'',escapeHtml:value=>String(value||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'),
    openAnyModal(content){modal.innerHTML=content;modal.classes.add('open');},
    location:{href:'https://tcghub.kr/#cardinfo'},navigator:{},showToast(){},
    CardCatalogRepairs:{ensureData:async()=>{},setCards:data=>data},JapaneseCardNames:{ensureData:async()=>{},title:card=>card.name},
  });
  const fetchMetadata=b.context.fetch,allRequests=[];
  b.context.fetch=async(url,options)=>{
    allRequests.push(String(url));const code=String(url).match(/^\/data\/cards-by-set\/([^.?]+)\.json/)?.[1];
    if(code)return {ok:!!inventories[code],text:async()=>JSON.stringify(inventories[code])};
    return fetchMetadata(url,options);
  };
  const html=fs.readFileSync(path.join(repository,'index.html'),'utf8');
  const start=html.indexOf('window.openSetGrid = async function'),end=html.indexOf('/* ─────────── 카드정보 set-code',start);
  vm.runInContext(html.slice(start,end),b.context);
  return {...b,modal,nodes,allRequests,open:code=>b.context.openSetGrid(code,code,'')};
}

test('real contained-card panel ignores a late previous-set response and never loads the full catalogue',async()=>{
  const files=temporary([row('a',{rarity:'R'}),row('b',{boxCode:'SV4M',rarity:'U'})]);
  try{
    let release;const held=new Promise(resolve=>{release=resolve;});
    const aURL=files.manifest.buckets[files.manifest.sets.SV4K].url;
    const b=gridBrowser(files,async url=>{if(url===aURL)await held;});
    const previous=b.open('SV4K');
    for(let i=0;i<40&&!b.requests.includes(aURL);i++)await Promise.resolve();
    assert.ok(b.requests.includes(aURL),'the first panel must reach its selected metadata request');
    await b.open('SV4M');const current=b.nodes.get('setGridContent').innerHTML;
    assert.match(current,/B-card/);assert.match(current,/keep-b\.webp/);assert.match(current,/&quot;rarity&quot;:&quot;U&quot;/);assert.doesNotMatch(current,/A-card/);
    release();await previous;assert.equal(b.nodes.get('setGridContent').innerHTML,current,'the old panel cannot overwrite the current set');
    assert.ok(!b.allRequests.some(url=>/japanese-catalog\.json|cards-meta|cards-prices|search-index/.test(url)));
    assert.equal(b.api.getSearchRows().length,0);
  }finally{fs.rmSync(files.root,{recursive:true,force:true});}
});

test('real contained-card panel remains closed when its selected metadata finishes loading',async()=>{
  const files=temporary([row('a',{rarity:'R'})]);
  try{
    let release;const held=new Promise(resolve=>{release=resolve;});
    const url=files.manifest.buckets[files.manifest.sets.SV4K].url;
    const b=gridBrowser(files,async resource=>{if(resource===url)await held;}),opening=b.open('SV4K');
    for(let i=0;i<40&&!b.requests.includes(url);i++)await Promise.resolve();
    assert.ok(b.requests.includes(url));b.modal.classes.delete('open');const before=b.nodes.get('setGridContent').innerHTML;
    release();await opening;assert.equal(b.nodes.get('setGridContent').innerHTML,before);assert.equal(b.modal.classes.has('open'),false);
  }finally{fs.rmSync(files.root,{recursive:true,force:true});}
});
