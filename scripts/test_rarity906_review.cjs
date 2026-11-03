const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.join(__dirname,'..'),directory='data/collections/sources/';
const cache=new Map();
const read=file=>{if(!cache.has(file))cache.set(file,JSON.parse(fs.readFileSync(path.join(root,file))));return cache.get(file);};
const jpSets=new Map(read('data/japanese-catalog.json').sets.filter(set=>set.brand==='pokemon').map(set=>[set.code.toUpperCase(),set]));

function runtime(){
  const context={module:{exports:{}},AbortController,setTimeout,clearTimeout};
  vm.runInNewContext(fs.readFileSync(path.join(root,'assets/card-rarity-filters.js'),'utf8'),context);
  return context.module.exports;
}

function originalCard(row){
  const set=jpSets.get(row.setCode.toUpperCase());
  const file=row.language==='zh-CN'?'data/chinese-sets/'+row.setCode+'.json':
    'data/cards-by-set/'+(set.fileCode||set.code)+'.json';
  const matches=read(file).cards.filter(card=>(card.url||card.sourceUrl)===row.sourceUrl);
  assert.equal(matches.length,1,row.sourceUrl);
  return matches[0];
}

const fetchImpl=async(url,options)=>{
  assert.equal(options.credentials,'omit');
  assert(url.startsWith('/'+directory),'metadata fetch stays inside reviewed local sources');
  const file=url.slice(1).split('?')[0];
  return fs.existsSync(path.join(root,file))?{ok:true,json:async()=>read(file)}:{ok:false};
};

function unchangedSourceFields(before,after,label){
  for(const key of Object.keys(before).filter(key=>!['rarityOriginal','rarityEvidence','raritySourceUnlisted'].includes(key)))
    assert.deepEqual(after[key],before[key],label+' '+key);
  assert.equal(after.rarity,before.rarity,label+' original rarity');
  assert(!after.rarityNotApplicable,label+' no invented manufacturer no-grade classification');
}

test('the exact seven Japanese decisions and CN149 enter runtime without changing source grades, artwork, variant or quotes',async()=>{
  const review=read(directory+'rarity906-ja-cn-20261104.json'),R=runtime();
  assert.equal(review.rows.length,8);
  let grades=0,noSymbol=0;
  for(const row of review.rows){
    const card=originalCard(row),snapshot=JSON.stringify(card),brand=row.language==='zh-CN'?'pokemon-cn':'pokemon';
    const result=(await R.enrich([card],{brand,setCode:row.setCode,fetchImpl}))[0];
    assert.equal(JSON.stringify(card),snapshot,row.sourceUrl+' source object remains immutable');
    unchangedSourceFields(card,result,row.sourceUrl);
    assert.equal(R.metadata(result).state,row.proposedState,row.sourceUrl);
    assert.equal(result.rarityEvidence.exactCardIdentity,true);
    assert.equal(result.rarityEvidence.physicalPrintingConfirmed,false);
    assert.equal(result.rarityEvidence.schemaVersion,1);
    assert(result.rarityEvidence.resolutionNote,'each formerly held/conflicting decision explains its bounded resolution');
    if(row.proposedState==='reference-grade'){
      grades++;
      assert.equal(result.rarityReferenceValue,'SuperRare Holo');
      assert(result.rarityEvidence.references.every(reference=>reference.literal==='SuperRare Holo'));
      assert(result.rarityEvidence.otherReferences.some(reference=>reference.literal==='Secret Rare'));
      assert.equal(row.globalAliasCreated,false);
      assert(['e3','e5'].includes(row.setCode));
    }else{
      noSymbol++;
      assert.equal(row.proposedState,'reference-unlisted');
      assert.equal(result.rarityReferenceValue,undefined,'finish and regulation marks are not converted into ranks');
      assert.equal(result.rarityReferenceUnlisted,true);
      if(row.setCode==='MF'){
        assert(['041/040','042/040'].includes(row.number));
        assert(result.rarityEvidence.references.every(reference=>reference.literal==='レアリティ表記無し'));
        assert(result.rarityEvidence.otherReferences.some(reference=>reference.literal==='AR'));
      }
      if(row.setCode==='SM12a'){
        assert.equal(row.number,'012/173');
        assert.equal(card.rarity||'','');
        assert(result.rarityEvidence.otherReferences.some(reference=>reference.literal==='Rare Holo'));
      }
      if(row.language==='zh-CN'){
        assert.equal(row.number,'149');assert.equal(result.id,'CN-30TH:149:holo');
        assert.equal(result.variant,'holo');
        assert.equal(row.imageIdentityEvidence.sourceAndProviderRGBAEqual,true);
        assert.match(row.imageIdentityEvidence.decodedRGBAsha256,/^[a-f0-9]{64}$/);
        assert.equal(result.rarityEvidence.references[0].literal,'无标记');
      }
    }
  }
  assert.equal(grades,4);assert.equal(noSymbol,4);
});

test('the new eight decisions cannot escape their exact source, native name, fraction, set or Chinese printing',async()=>{
  const review=read(directory+'rarity906-ja-cn-20261104.json'),R=runtime();
  for(const row of review.rows){
    const card=originalCard(row),brand=row.language==='zh-CN'?'pokemon-cn':'pokemon';
    const mutations=[{name:card.name+' another card'},{number:card.number+'x'},
      {...(card.url?{url:card.url+'-another-printing'}:{}),...(card.sourceUrl?{sourceUrl:card.sourceUrl+'-another-printing'}:{})}];
    if(row.language==='zh-CN')mutations.push({id:card.id+'-another-printing'},{sourceId:card.sourceId+'-other'},{variant:'reverse'});
    for(const patch of mutations){
      const changed={...card,...patch};
      const result=(await R.enrich([changed],{brand,setCode:row.setCode,fetchImpl}))[0];
      assert.deepEqual(result,changed,row.sourceUrl+' rejects changed '+Object.keys(patch).join(','));
    }
    const wrongSet=(await R.enrich([card],{brand,setCode:'OUTSIDE_REVIEW_SCOPE',fetchImpl}))[0];
    assert.deepEqual(wrongSet,card,row.sourceUrl+' rejects another set');
    const known={...card,rarity:'R'};
    const knownResult=(await R.enrich([known],{brand,setCode:row.setCode,fetchImpl}))[0];
    assert.deepEqual(knownResult,known,row.sourceUrl+' cannot replace an existing source/manufacturer grade');
  }
});

test('Crystal taxonomy resolution does not install Secret Rare as a global alias of SuperRare Holo',()=>{
  const R=runtime(),card={url:'https://www.tcgcollector.com/cards/0/outside-crystal-review',name:'Other',number:'1/1',raritySourceUnlisted:true};
  const entry={sourceUrl:card.url,setCode:'OTHER',name:card.name,number:card.number,rarity:'SuperRare Holo',rarityOriginal:'—',rarityStatus:'reference-explicit',
    rarityEvidence:{schemaVersion:1,kind:'external-explicit',exactCardIdentity:true,value:'SuperRare Holo',
      references:[{provider:'Other DB',url:'https://example.org/other-card',literal:'Secret Rare'}]}};
  const payload={schemaVersion:1,brand:'pokemon',language:'ja',cards:{[card.url]:entry}};
  const result=R.merge([card],payload,{brand:'pokemon',setCode:'OTHER'})[0];
  assert.deepEqual(result,card);
  assert.equal(R.metadata(result).state,'source-unlisted');
});
