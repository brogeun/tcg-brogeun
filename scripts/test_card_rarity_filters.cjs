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
});

test('One Piece supplementary rarity never inherits another parallel printing',()=>{
  const payload={cards:{'OP01-001':{rarity:'L',rarityStatus:'official-unambiguous'},'OP01-001_p1':{rarity:'SP',rarityStatus:'needs-exact-evidence'}}};
  assert.equal(R.merge([{fullId:'OP01-001_p2'}],payload,{brand:'onepiece'})[0].rarity,undefined);
  assert.equal(R.merge([{fullId:'OP01-001_p1'}],payload,{brand:'onepiece'})[0].rarity,undefined);
  assert.equal(R.merge([{fullId:'OP01-001'}],payload,{brand:'onepiece'})[0].rarity,'L');
});

test('optional metadata deadline covers body reads and a failure permits retry without credentials',async()=>{
  let options;
  const pending=await R.ensureMetadata('pokemon',{timeoutMs:10,fetchImpl:async(url,opts)=>{options=opts;return {ok:true,json:()=>new Promise(()=>{})};}});
  assert.equal(pending,null);assert.equal(options.credentials,'omit');
  let retries=0;const result=await R.ensureMetadata('pokemon',{fetchImpl:async()=>{retries++;return {ok:true,json:async()=>({cards:{}})};}});
  assert.deepEqual(result,{cards:{}});assert.equal(retries,1);
});
