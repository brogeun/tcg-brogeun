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

test('publisher evidence fills a reviewed blank only for its exact edition and cannot replace a known grade',()=>{
  const card={url:'https://www.tcgcollector.com/cards/1/example',name:'Charizard',number:'4/102',raritySourceUnlisted:true};
  const proof={schemaVersion:1,kind:'manufacturer-exact-product-checklist',url:'https://assets.pokemon.com/checklist.pdf',value:'Classic Collection',exactEdition:true};
  const entry={sourceUrl:card.url,setCode:'CELEBRATIONS',name:card.name,number:card.number,rarity:'Classic Collection',rarityOriginal:'—',rarityStatus:'manufacturer-verified',rarityEvidence:proof};
  const payload={schemaVersion:1,brand:'pokemon',language:'en',cards:{[card.url]:entry}};
  const merge=(c=card,p=payload)=>R.merge([c],p,{brand:'pokemon-en',setCode:'CELEBRATIONS'})[0];
  assert.equal(merge().rarity,'Classic Collection');assert.equal(merge().raritySourceUrl,proof.url);
  assert.equal(merge().rarityOriginal,'—','the upstream blank is preserved');
  assert.equal(merge({...card,rarity:'Rare'}).rarity,'Rare','a printed legacy grade is never replaced automatically');
  for(const changed of [{exactEdition:false},{value:'Rare'},{url:'https://other.test/grade'},{kind:'symbol-absent'}]){
    const invalid={...payload,cards:{[card.url]:{...entry,rarityEvidence:{...proof,...changed}}}};
    assert.equal(R.metadata(merge(card,invalid)).state,'source-unlisted');
  }
  assert.equal(merge({...card,number:'4/100'}).rarity,undefined);
  assert.match(R.controlsHtml([card],[]),/무등급 확정이 아닙니다/);
});

test('external explicit grades, explicit None and conflicting references remain distinct and preserve quote identities',()=>{
  const card={url:'https://www.tcgcollector.com/cards/2/external',name:'Test',number:'1/39',image:'original.jpg',raritySourceUnlisted:true,psa10:{sourcePriceCents:1234}};
  const ref=literal=>({provider:'TCGdex',url:'https://github.com/tcgdex/cards-database/blob/review/card.ts',literal});
  const entry=(status,value,refs)=>({sourceUrl:card.url,setCode:'KSS',name:card.name,number:card.number,rarity:value,rarityOriginal:'—',rarityStatus:status,
    rarityEvidence:{schemaVersion:1,kind:'external-explicit',exactCardIdentity:true,value:value||'None',references:refs}});
  const payload=e=>({schemaVersion:1,brand:'pokemon',language:'en',cards:{[card.url]:e}});
  const merge=e=>R.merge([card],payload(e),{brand:'pokemon-en',setCode:'KSS'})[0];
  const common=merge(entry('reference-explicit','Common',[ref('Common')]));assert.equal(common.rarity,undefined);assert.equal(common.rarityReferenceValue,'Common');assert.equal(R.metadata(common).state,'reference-grade');assert.equal(common.image,card.image);assert.equal(common.psa10,card.psa10);assert.equal(common.rarityOriginal,'—');
  const none=merge(entry('reference-unlisted','',[ref('None')]));assert.equal(none.rarity,undefined);assert.equal(R.metadata(none).state,'reference-unlisted');assert(!none.rarityNotApplicable);
  const conflict=merge(entry('reference-conflict','',[ref('None'),{...ref('Common'),provider:'TCGplayer'}]));assert.equal(conflict.rarity,undefined);assert.equal(R.metadata(conflict).state,'reference-conflict');
  const invalid=entry('reference-unlisted','',[ref('')]);assert.equal(R.metadata(merge(invalid)).state,'source-unlisted','a missing value is never an explicit None');
  const other=entry('reference-explicit','Common',[ref('Common')]);other.number='2/39';assert.equal(merge(other).rarity,undefined);
  assert.equal(R.merge([{...card,rarity:'Rare'}],payload(entry('reference-explicit','Common',[ref('Common')])),{brand:'pokemon-en',setCode:'KSS'})[0].rarity,'Rare');
  const html=R.controlsHtml([none,conflict,common],[]);assert.match(html,/미표기 분류/);assert.match(html,/자료 간 등급 차이/);assert.match(html,/카드 번호별 대조 출처/);
  assert.match(R.evidenceHtml(common),/외부 DB 분류/);assert.match(R.evidenceHtml(common),/Common/);
});

test('documented no-printed-rarity is different from source blanks and a manufacturer no-grade conclusion',()=>{
  const card={rarity:'',raritySourceUnlisted:true,rarityDisclosureStatus:'verified-unprinted-rarity',rarityDisclosureEvidence:{references:[{provider:'wiki',url:'https://w.atwiki.jp/ws_wiki/pages/10897.html',literal:'no printed rarity'}]}};
  assert.equal(R.metadata(card).state,'documented-unprinted');assert(!card.rarityNotApplicable);assert.match(R.evidenceHtml(card),/희귀도 미표기 근거/);
  assert.equal(R.metadata({...card,rarity:'PR'}).state,'known','an explicit grade takes precedence');
});

test('every published external reference matches the current card and preserves its original rarity, image and price fields',()=>{
  const fs=require('node:fs'),path=require('node:path'),base=path.join(__dirname,'..');
  const read=f=>JSON.parse(fs.readFileSync(path.join(base,f)));
  const jpSets=new Map(read('data/japanese-catalog.json').sets.filter(s=>s.brand==='pokemon').map(s=>[s.code.toUpperCase(),s]));
  let checked=0,grades=0;
  for(const [locale,brand,folder] of [['jp','pokemon','cards-by-set'],['en','pokemon-en','english-sets']]){
    const index=read('data/collections/sources/pokemon-'+locale+'-rarity-crossdb.json');
    for(const [code,url] of Object.entries(index.setShards)){
      const member=read(url.slice(1).split('?')[0]).sets[code];
      const sourceCode=locale==='jp' ? jpSets.get(code).fileCode||jpSets.get(code).code : code;
      const sourceFile='data/'+folder+'/'+sourceCode+'.json';
      const cards=read(sourceFile).cards;
      for(const [source,entry] of Object.entries(member.cards)){
        const matches=cards.filter(c=>(c.url||c.sourceUrl)===source);assert.equal(matches.length,1,source);const card=matches[0],before=JSON.stringify(card);
        assert.equal(entry.name,card.name);assert.equal(entry.number,card.number);
        const payload={...member,cards:{[source]:{...entry,sourceUrl:source,setCode:code}}};
        const result=R.merge([{...card,raritySourceUnlisted:true}],payload,{brand,setCode:code})[0];
        assert.equal(result.rarity,card.rarity,'reference grades never rewrite the original field');assert.equal(JSON.stringify(card),before);
        for(const key of Object.keys(card).filter(k=>!['rarityOriginal','rarityEvidence','raritySourceUnlisted'].includes(k)))assert.deepEqual(result[key],card[key],key);
        const expected={'reference-explicit':'reference-grade','reference-unlisted':'reference-unlisted','reference-conflict':'reference-conflict','reference-candidate':'source-unlisted'}[entry.rarityStatus];
        assert.equal(R.metadata(result).state,expected,source);
        checked++;if(expected==='reference-grade')grades++;
      }
    }
  }
  assert(checked>2000);assert(grades>700);
});

test('deep review keeps upstream blanks and exact identities while restoring only supported publisher classifications',()=>{
  const fs=require('node:fs'),path=require('node:path'),base=path.join(__dirname,'..');
  const read=f=>JSON.parse(fs.readFileSync(path.join(base,f)));
  let verified=0;
  for(const file of ['part-2000.json','part-2001.json'])for(const [code,set] of Object.entries(read('data/collections/sources/pokemon-rarity-recheck/'+file).sets)){
    const payload={...set,cards:Object.fromEntries(Object.entries(set.cards).map(([url,c])=>[url,{...c,sourceUrl:url,setCode:set.setCode}]))};
    const rows=read('data/english-sets/'+code+'.json').cards;
    for(const card of rows){
      const entry=set.cards[card.url||card.sourceUrl];if(entry?.rarityStatus!=='manufacturer-verified')continue;
      verified++;assert.equal(entry.rarityOriginal,'—');assert(!card.rarity,'raw source grade remains blank');
      const result=R.merge([card],payload,{brand:'pokemon-en',setCode:code})[0];
      assert.equal(result.rarity,entry.rarity);assert.equal(result.raritySourceUnlisted,false);
      assert.equal(result.name,card.name);assert.equal(result.number,card.number);
      assert.deepEqual(result.grades,card.grades,'grade quotes are not changed by rarity enrichment');
    }
  }
  assert.equal(verified,52);
  const cn=read('data/chinese-sets/CN-30TH.json').cards,reviewed=cn.filter(c=>c.manufacturerCategory);
  assert.equal(reviewed.length,68);
  assert.equal(reviewed.filter(c=>c.rarity==='Pikachu Rare').length,30);
  for(const c of reviewed){
    assert.equal(c.manufacturerCategory.fieldIsRarity,false);
    if(c.rarity==='Pikachu Rare'){
      assert(intBetween(c.number,17,46));assert.equal(c.rarityOriginal,'');assert.equal(c.rarityEvidence.symbolDefinitionInterpretation,true);
      assert.match(c.rarityEvidence.imageSha256,/^[a-f0-9]{64}$/);
    }else{assert.equal(c.rarity,'');assert.equal(R.metadata(c).state,'source-unlisted');assert(!c.rarityNotApplicable);}
  }
  function intBetween(n,a,b){return Number(n)>=a&&Number(n)<=b;}
});
