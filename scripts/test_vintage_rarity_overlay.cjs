const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const R=require('../assets/card-rarity-filters.js');
const root=path.resolve(__dirname,'..');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));

test('all 322 Neo cards receive exact-source rarities while blank printed numbers and source rows stay unchanged',async()=>{
  const index=read('data/collections/sources/pokemon-jp-rarity-metadata.json');
  const bundle=read('data/collections/sources/pokemon-rarity-recheck/part-7100.json');
  let count=0;
  for(const code of ['Neo1','Neo2','Neo3','Neo4']){
    const cards=read('data/cards-by-set/'+code+'.json').cards,before=JSON.stringify(cards);
    const payload=await R.ensureSetMetadata(index,code,{fetchImpl:async url=>{
      assert.equal(url,'/data/collections/sources/pokemon-rarity-recheck/part-7100.json?v=20261104-vintage1');
      return {ok:true,json:async()=>bundle};
    }});
    const enriched=R.merge(cards,payload,{brand:'pokemon',setCode:code});
    assert.equal(enriched.length,cards.length);
    assert.equal(enriched.filter(card=>R.metadata(card).state==='unknown').length,0);
    assert(enriched.every(card=>card.number===''));
    assert.equal(JSON.stringify(cards),before);
    for(const card of enriched){
      const evidence=payload.cards[card.url];
      assert.equal(evidence.sourceUrl,card.url);
      assert.equal(evidence.name,card.name);
      assert.equal(evidence.number,card.number);
      assert(evidence.rarityOriginal);
    }
    const unrelated={...cards[0],name:'Different source title'};
    assert.equal(R.merge([unrelated],payload,{brand:'pokemon',setCode:code})[0].rarity,'');
    const explicit={...cards[0],rarity:'Prior explicit grade'};
    assert.equal(R.merge([explicit],payload,{brand:'pokemon',setCode:code})[0].rarity,'Prior explicit grade');
    count+=enriched.length;
  }
  assert.equal(count,322);
});

test('15 additional old sets preserve all 1302 identities while only 1281 explicit source grades are adopted',async()=>{
  const index=read('data/collections/sources/pokemon-jp-rarity-metadata.json');
  const codes=['CL1','CL2','CL3','CL4','Gym1','Gym2','DP2','DP3','DP4-Bd','DP5','DP6','Pt1','Pt2','Pt3','Pt4'];
  const fetched=new Set();let known=0,unknown=0,total=0;
  for(const code of codes){
    const cards=read('data/cards-by-set/'+code+'.json').cards,before=JSON.stringify(cards);
    const payload=await R.ensureSetMetadata(index,code,{fetchImpl:async url=>{
      const file=url.split('?')[0].replace(/^\//,'');
      assert.match(file,/^data\/collections\/sources\/pokemon-rarity-recheck\/part-710[1-4]\.json$/);
      const bytes=fs.readFileSync(path.join(root,file));assert(bytes.length<350000,'Load only the bounded requested rarity shard');
      fetched.add(file);return {ok:true,json:async()=>JSON.parse(bytes)};
    }});
    const enriched=R.merge(cards,payload,{brand:'pokemon',setCode:code});
    assert.equal(JSON.stringify(cards),before);assert.equal(enriched.length,cards.length);
    for(let n=0;n<cards.length;n++){
      const card=cards[n],result=enriched[n],state=R.metadata(result).state;
      if(state==='unknown')unknown++;else{known++;assert(payload.cards[card.url].rarityOriginal);}
      for(const key of ['name','number','image','localImage','url','currentSourceUrl','marketProductId','productId'])assert.equal(result[key],card[key]);
      if(card.rarity)assert.equal(result.rarity,card.rarity);
    }
    total+=cards.length;
  }
  assert.equal(fetched.size,4);assert.equal(total,1302);assert.equal(known,1281);assert.equal(unknown,21);
});
