const test=require('node:test');
const assert=require('node:assert/strict');
const R=require('../assets/card-rarity-filters.js');

test('only explicit source rarity creates choices; no name/grade/parallel/price inference',()=>{
  const cards=[{name:'MUR Charizard',grade:'psa10',fullId:'OP01-001_p1',price:10000},
    {rarity:'AR'},{rarity:'SAR'},{rarity:'RR'},{rarity:'',rarityNotApplicable:true}];
  assert.deepEqual(R.options(cards).map(o=>o.key),['known:AR','known:RR','known:SAR','unknown','not-applicable']);
  assert(!R.controlsHtml(cards,[]).includes('known:MUR'));
  assert.equal(R.metadata(cards[0]).state,'unknown');
  assert.equal(R.metadata(cards[4]).state,'not-applicable');
});

test('rarity selections are OR and text predicates are AND before pages/count',()=>{
  const cards=Array.from({length:55},(_,i)=>({id:i,rarity:i<30?'AR':i<54?'SAR':'RR',name:i%2?'odd':'even'}));
  const result=R.page(cards,{selected:['known:AR','known:SAR'],predicate:c=>c.name==='even',page:8,pageSize:18});
  assert.equal(result.count,27);assert.equal(result.pages,2);assert.equal(result.page,2);assert.equal(result.items.length,9);
  assert(result.filtered.every(c=>c.rarity!=='RR'&&c.id%2===0));
  assert.equal(cards.length,55,'source array is immutable');
});

test('unknown/not-applicable accessible, removed filters normalize, empty results have one safe page',()=>{
  const cards=[{id:1,rarity:'AR'},{id:2},{id:3,rarityNotApplicable:true}];
  assert.deepEqual(R.filter(cards,['unknown']).map(c=>c.id),[2]);
  assert.deepEqual(R.filter(cards,['not-applicable']).map(c=>c.id),[3]);
  assert.equal(R.filter(cards,['known:MUR']).length,3,'obsolete/nonexistent choice resets to all');
  const zero=R.page(cards,{selected:['known:AR'],predicate:()=>false,page:4});
  assert.equal(zero.count,0);assert.equal(zero.page,1);assert.equal(zero.pages,1);
});

test('a verified blank source is separate from unchecked and not-applicable rarity',()=>{
  const card={url:'https://www.tcgcollector.com/cards/1/test',number:'001/100',name:'Test'};
  const entry={...card,sourceUrl:card.url,setCode:'SET',rarity:'',rarityOriginal:'—',rarityStatus:'source-unlisted'};
  const payload={schemaVersion:1,brand:'pokemon',language:'ja',cards:{[card.url]:entry}};
  const merged=R.merge([card],payload,{brand:'pokemon',setCode:'SET'})[0];
  assert.deepEqual(R.metadata(merged),{key:'source-unlisted',label:'원문 등급 미표기',state:'source-unlisted'});
  assert.equal(R.metadata(card).state,'unknown');assert(!merged.rarityNotApplicable);
  assert.equal(R.metadata(R.merge([{...card,number:'002/100'}],payload,{brand:'pokemon',setCode:'SET'})[0]).state,'unknown');
  assert.equal(R.metadata({...merged,rarity:'R'}).state,'known','an explicit value always wins');
});

test('original rarity labels preserved and escaped; case/width variants do not duplicate options',()=>{
  const cards=[{rarity:' AR '},{rarity:'ＡＲ'},{rarity:'Special Illustration Rare'},{rarity:'<img onerror=x>'}];
  assert.equal(R.options(cards).find(o=>o.key==='known:AR').count,2);
  assert(R.options(cards).some(o=>o.label==='Special Illustration Rare'));
  const html=R.controlsHtml(cards,[]);assert(html.includes('&lt;img onerror=x&gt;'));assert(!html.includes('<img onerror=x>'));
  assert(!R.metadata({rarity:'Special Illustration Rare'}).key.includes('known:SAR'));
});

test('filter focus follows a replaced inline panel container after redraw',()=>{
  let focused=false,received;
  const clicked={dataset:{cardRarity:'known:AR'},closest(){return this;}};
  const live={querySelectorAll:()=>[{dataset:{cardRarity:'known:AR'},focus(options){focused=options.preventScroll;}}]};
  const original={id:'ciRarityFilters',contains:button=>button===clicked,ownerDocument:{getElementById:()=>live},querySelectorAll:()=>[]};
  R.mount(original,{cards:[{rarity:'AR'}],selected:[],onChange:next=>received=next});
  original.onclick({target:clicked,preventDefault(){},stopPropagation(){}});
  assert.deepEqual(received,['known:AR']);assert(focused,'focus uses live replacement, not detached original');
});


test('supplemental rarity needs exact source URL, set, full fraction and original name',()=>{
  const card={url:'https://www.tcgcollector.com/cards/1/example',name:'ピカチュウ',number:'103/073'};
  const entry={sourceUrl:card.url,setCode:'SV1a',name:card.name,number:card.number,rarity:'SAR',rarityOriginal:'SAR',rarityStatus:'source-explicit'};
  const payload={schemaVersion:1,brand:'pokemon',language:'ja',cards:{[card.url]:entry}};
  assert.equal(R.merge([card],payload,{brand:'pokemon',setCode:'SV1a'})[0].rarity,'SAR');
  for(const changed of [{name:'other'},{number:'103/100'},{url:card.url+'2'}])assert.equal(R.merge([{...card,...changed}],payload,{brand:'pokemon',setCode:'SV1a'})[0].rarity,undefined);
  assert.equal(R.merge([{...card,rarity:'AR'}],payload,{brand:'pokemon',setCode:'SV1a'})[0].rarity,'AR');
  assert.equal(R.merge([card],payload,{brand:'pokemon',setCode:'M6'})[0].rarity,undefined);
  assert.equal(R.merge([card],payload,{brand:'pokemon-en',setCode:'SV1a'})[0].rarity,undefined,'Japanese metadata cannot enter the English panel');
});

test('One Piece supplementary rarity never inherits another parallel printing',()=>{
  const payload={cards:{'OP01-001':{rarity:'L',rarityStatus:'official-unambiguous'},'OP01-001_p1':{rarity:'SP',rarityStatus:'needs-exact-evidence'}}};
  assert.equal(R.merge([{fullId:'OP01-001_p2'}],payload,{brand:'onepiece'})[0].rarity,undefined);
  assert.equal(R.merge([{fullId:'OP01-001_p1'}],payload,{brand:'onepiece'})[0].rarity,undefined);
  assert.equal(R.merge([{fullId:'OP01-001'}],payload,{brand:'onepiece'})[0].rarity,'L');
});

test('M6a uses literal manufacturer categories and labels its catalogue classification',()=>{
  const fs=require('node:fs'),path=require('node:path'),base=path.join(__dirname,'..');
  const cards=JSON.parse(fs.readFileSync(path.join(base,'data/cards-by-set/M6a.json'))).cards;
  const payload=JSON.parse(fs.readFileSync(path.join(base,'data/collections/sources/pokemon-jp-rarity-metadata.json')));
  const enriched=R.merge(cards,payload,{brand:'pokemon',setCode:'M6a'}),entries=R.options(enriched);
  assert.equal(enriched.filter(c=>R.metadata(c).state==='unknown').length,0);
  assert.equal(entries.find(e=>e.key==='known:C').count,45);
  assert.equal(entries.find(e=>e.key==='known:R').count,18);
  assert.match(entries.find(e=>e.key==='known:C').label,/공식 분류 C/);
  assert.equal(entries.find(e=>e.key==='known:NATSU').count,31);
  assert.equal(entries.find(e=>e.key==='known:ENE').count,8);
  assert(!enriched.some(c=>c.rarityNotApplicable));
  assert(cards.some(c=>!c.rarity),'original rows remain immutable');
});


test('optional metadata deadline covers body reads and a failure permits retry without credentials',async()=>{
  let options;
  const pending=await R.ensureMetadata('pokemon',{timeoutMs:10,fetchImpl:async(url,opts)=>{options=opts;return {ok:true,json:()=>new Promise(()=>{})};}});
  assert.equal(pending,null);assert.equal(options.credentials,'omit');
  let retries=0;const result=await R.ensureMetadata('pokemon',{fetchImpl:async()=>{retries++;return {ok:true,json:async()=>({cards:{}})};}});
  assert.deepEqual(result,{cards:{}});assert.equal(retries,1);
});

test('set supplements load only the requested reviewed local shard and retry after body timeout',async()=>{
  let requests=0;const url='/data/collections/sources/pokemon-rarity-recheck/S4a.json?v=review1';
  const payload={setShards:{S4A:url}};
  for(const [code,address]of [['S4A','https://other.test/x.json'],['S4A','/data/collections/sources/pokemon-rarity-recheck/S8b.json?v=x'],['OTHER',url]]) {
    assert.equal(await R.ensureSetMetadata({setShards:{[code]:address}},'S4a',{fetchImpl:async()=>{requests++;}}),null);
  }
  assert.equal(requests,0);
  assert.equal(await R.ensureSetMetadata(payload,'S4a',{timeoutMs:5,fetchImpl:async()=>({ok:true,json:()=>new Promise(()=>{})})}),null);
  const result=await R.ensureSetMetadata(payload,'S4a',{fetchImpl:async(address,opts)=>{requests++;assert.equal(address,url);assert.equal(opts.credentials,'omit');return {ok:true,json:async()=>({cards:{}})};}});
  assert.deepEqual(result,{cards:{}});assert.equal(requests,1);
});

test('one cached bundle supplies only its exact set member',async()=>{
  const url='/data/collections/sources/pokemon-rarity-recheck/part-0000.json?v=test1';let requests=0;
  const member={schemaVersion:1,brand:'pokemon',language:'ja',setCode:'S4a',cards:{}};
  const fetchImpl=async()=>{requests++;return {ok:true,json:async()=>({schemaVersion:1,bundleVersion:1,cards:{},sets:{S4A:member,S8B:{...member,setCode:'WRONG'}}})};};
  assert.deepEqual(await R.ensureSetMetadata({setShards:{S4A:url}},'S4a',{fetchImpl}),member);
  assert.equal(await R.ensureSetMetadata({setShards:{S8B:url}},'S8b',{fetchImpl}),null);
  assert.equal(requests,1);
});

test('compact bundle identities expand exactly and still require original name and fraction',async()=>{
  const sourceUrl='https://www.tcgcollector.com/cards/123/test';
  const member={schemaVersion:1,brand:'pokemon',language:'ja',setCode:'S4a',compactIdentity:true,cards:{[sourceUrl]:{name:'Original',number:'001/190',rarity:'R',rarityStatus:'source-explicit'}}};
  const url='/data/collections/sources/pokemon-rarity-recheck/part-0001.json?v=compacttest';
  const payload=await R.ensureSetMetadata({language:'ja',setShards:{S4A:url}},'S4a',{fetchImpl:async()=>({ok:true,json:async()=>({bundleVersion:1,cards:{},sets:{S4A:member}})})});
  const card={url:sourceUrl,name:'Original',number:'001/190'};
  assert.equal(R.merge([card],payload,{brand:'pokemon',setCode:'S4a'})[0].rarity,'R');
  assert.equal(R.merge([{...card,number:'001/191'}],payload,{brand:'pokemon',setCode:'S4a'})[0].rarity,undefined);
  assert.equal(member.cards[sourceUrl].sourceUrl,undefined,'cached compact data is immutable');
});

test('rarities start behind one picker and keep the picker open during multiple choices',()=>{
  const html=R.controlsHtml([{rarity:'AR'},{rarity:'SAR'}],[]);assert.match(html,/<details class="ci-rarity-picker">/);assert.doesNotMatch(html,/<details[^>]* open/);assert.match(html,/<summary>희귀도 필터/);assert.match(html,/data-card-rarity-close/);
  let next;const oldPicker={open:true,querySelector:()=>null},livePicker={open:false},clicked={dataset:{cardRarity:'known:AR'},closest(){return this;}};
  const live={querySelector:()=>livePicker,querySelectorAll:()=>[]};const container={id:'ciRarityFilters',querySelector:()=>oldPicker,contains:()=>true,ownerDocument:{getElementById:()=>live}};
  R.mount(container,{cards:[{rarity:'AR'},{rarity:'SAR'}],onChange:keys=>next=keys});container.onclick({target:clicked,preventDefault(){},stopPropagation(){}});assert.deepEqual(next,['known:AR']);assert.equal(livePicker.open,true);
  const close={dataset:{cardRarityClose:''},closest(){return this;}};container.onclick({target:close,preventDefault(){},stopPropagation(){}});assert.equal(oldPicker.open,false);
});
