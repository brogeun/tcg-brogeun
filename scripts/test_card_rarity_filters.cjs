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
