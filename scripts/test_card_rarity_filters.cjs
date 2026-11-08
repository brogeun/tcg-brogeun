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

test('native no-symbol references require the exact Chinese printing and never replace a source or manufacturer grade',()=>{
  const card={id:'CN-TEST:001:holo',sourceId:'source-1',sourceUrl:'https://pikaqian.com/cards/source-1',name:'皮卡丘',number:'001',variant:'holo',rarity:'',raritySourceUnlisted:true};
  const entry={cardId:card.id,sourceId:card.sourceId,sourceUrl:card.sourceUrl,setCode:'CN-TEST',name:card.name,number:card.number,variant:card.variant,rarity:'',rarityOriginal:'',rarityStatus:'reference-unlisted',
    rarityEvidence:{schemaVersion:1,kind:'external-explicit',exactCardIdentity:true,value:'None',physicalPrintingConfirmed:false,references:[{provider:'Cryst',url:'https://tcg.mik.moe/card/source-1',literal:'无标记'}]}};
  const payload={schemaVersion:1,brand:'pokemon',language:'zh-CN',cards:{[card.sourceUrl]:entry}};
  const merge=(c=card,p=payload,options={brand:'pokemon-cn',setCode:'CN-TEST'})=>R.merge([c],p,options)[0];
  const result=merge();assert.equal(R.metadata(result).state,'reference-unlisted');assert.equal(result.rarity,'');assert(!result.rarityNotApplicable);assert.equal(result.rarityEvidence.physicalPrintingConfirmed,false);
  for(const patch of [{id:'another-printing'},{sourceId:'other'},{sourceUrl:card.sourceUrl+'2'},{name:'different'},{number:'002'},{variant:'reverse'}])assert.deepEqual(merge({...card,...patch}),{...card,...patch});
  for(const language of ['ja','en','zh-TW'])assert.deepEqual(merge(card,{...payload,language}),card);
  assert.deepEqual(merge(card,payload,{brand:'pokemon-cn',setCode:'CN-OTHER'}),card);
  assert.deepEqual(merge(card,payload,{brand:'pokemon',setCode:'CN-TEST'}),card);
  for(const literal of ['None','表記無し(-)','表記無し','レアリティなし','レアリティ表記無し','无标记']){
    const p={...payload,cards:{[card.sourceUrl]:{...entry,rarityEvidence:{...entry.rarityEvidence,references:[{...entry.rarityEvidence.references[0],literal}]}}}};
    assert.equal(R.metadata(merge(card,p)).state,'reference-unlisted',literal);
  }
  for(const literal of ['', '-', '—', 'unknown']){
    const p={...payload,cards:{[card.sourceUrl]:{...entry,rarityEvidence:{...entry.rarityEvidence,references:[{...entry.rarityEvidence.references[0],literal}]}}}};
    assert.equal(R.metadata(merge(card,p)).state,'source-unlisted',literal);
  }
  const known={...card,rarity:'Pikachu Rare'};assert.deepEqual(merge(known),known);
});

test('frozen first-resume evidence still proves its246 classifications and3 historical holds',()=>{
  const fs=require('node:fs'),path=require('node:path'),root=path.join(__dirname,'..'),read=f=>JSON.parse(fs.readFileSync(path.join(root,f)));
  const review=read('data/collections/sources/rarity-resume-ja-cn-20261103.json'),bundle=read('data/collections/sources/pokemon-rarity-recheck/part-5000.json');
  // Reconstruct the historical37 Chinese decisions from the frozen evidence.
  // The live overlay can now include CN149 after its exact-image review.
  const cn={schemaVersion:1,brand:'pokemon',language:'zh-CN',cards:Object.fromEntries(review.rows
    .filter(row=>row.language==='zh-CN'&&row.proposedState==='reference-unlisted')
    .map(row=>[row.sourceUrl,{sourceUrl:row.sourceUrl,setCode:row.setCode,cardId:row.id,sourceId:row.sourceId,
      variant:row.variant,name:row.name,number:row.number,rarity:'',rarityOriginal:'',rarityStatus:'reference-unlisted',
      rarityEvidence:{schemaVersion:1,kind:'external-explicit',exactCardIdentity:true,value:'None',
        physicalPrintingConfirmed:false,references:row.references}}]))};
  const jpSets=new Map(read('data/japanese-catalog.json').sets.map(s=>[s.code.toUpperCase(),s]));let adopted=0,grades=0,candidates=0,ordinal=0;
  for(const row of review.rows){
    const set=jpSets.get(row.setCode.toUpperCase()),file=row.language==='zh-CN'?'data/chinese-sets/'+row.setCode+'.json':'data/cards-by-set/'+(set.fileCode||set.code)+'.json';
    const matches=read(file).cards.filter(c=>(c.sourceUrl||c.url)===row.sourceUrl);assert.equal(matches.length,1,row.sourceUrl);const card=matches[0],before=JSON.stringify(card);
    let payload=cn;if(row.language==='ja'){const member=bundle.sets[row.setCode.toUpperCase()];payload={...member,cards:Object.fromEntries(Object.entries(member.cards).map(([sourceUrl,c])=>[sourceUrl,{...c,sourceUrl,setCode:member.setCode}]))};}
    const result=R.merge([card],payload,{brand:row.language==='zh-CN'?'pokemon-cn':'pokemon',setCode:row.setCode})[0];
    assert.equal(JSON.stringify(card),before,'original source remains immutable');
    for(const key of Object.keys(card).filter(k=>!['rarityOriginal','rarityEvidence','raritySourceUnlisted'].includes(k)))assert.deepEqual(result[key],card[key],row.sourceUrl+' '+key);
    assert.equal(result.rarity,card.rarity);assert(!result.rarityNotApplicable);
    if(row.proposedState==='reference-candidate'){
      candidates++;assert.equal(R.metadata(result).state,R.metadata(card).state);assert.equal(result.rarityReferenceValue,undefined);
      if(row.language==='zh-CN'){assert.equal(row.number,'149');assert.equal(payload.cards[row.sourceUrl],undefined);assert.deepEqual(result,card);}
      else{assert(['041/040','042/040'].includes(row.number));assert.equal(result.rarityEvidence.kind,'external-candidate');assert.match(R.evidenceHtml(result),/등급 적용 보류/);}
    }else{
      adopted++;assert.equal(R.metadata(result).state,row.proposedState);assert.equal(result.rarityEvidence.physicalPrintingConfirmed,false);
      if(row.proposedState==='reference-grade'){grades++;assert.equal(row.setCode,'S10b');assert.equal(row.number,'053/071');assert.equal(result.rarityReferenceValue,'R');assert.equal(result.rarityEvidence.references[0].literal,'R(レア)');}
      if(row.catalogueNumberIsOrdinal){ordinal++;assert.match(row.number,/^No\. 04[5-9]$/);assert.equal(result.rarityEvidence.identityMethod,'named-fixed-set-energy');assert.match(R.evidenceHtml(result),/목록의 No\. 번호는 인쇄 번호가 아니며/);}
    }
  }
  assert.equal(adopted,246);assert.equal(grades,1);assert.equal(candidates,3);assert.equal(ordinal,5);assert.equal(Object.keys(cn.cards).length,37);
  const en=read('data/collections/sources/rarity-resume-en-20261103.json'),overlay=read('data/collections/sources/rarity-resume-en-20261103-overlay.json');
  assert.equal(en.recoveredReferenceGrade,0);assert.equal(en.withheldEditionMismatch,26);assert.equal(en.rows.length,26);assert(en.rows.every(row=>row.referenceStatus==='withheld-edition-mismatch'));assert.deepEqual(overlay.cards,{});assert.deepEqual(overlay.sets,{});
});

test('actual runtime enrichment accounts for all 3381 original rows and preserves their source grades, artwork and quotes',async()=>{
  const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),vm=require('node:vm'),root=path.join(__dirname,'..');
  const cached=new Map(),read=f=>{if(!cached.has(f))cached.set(f,JSON.parse(fs.readFileSync(path.join(root,f))));return cached.get(f);};
  const directory='data/collections/sources/',archive=f=>JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root,directory,f))));
  const targets=fs.readdirSync(path.join(root,directory)).filter(f=>/^rarity-crossdb-20261101-(ja|en)-\d+\.json.gz$/.test(f)).flatMap(f=>archive(f).rows);
  const others=archive('rarity-crossdb-20261101-cn-ws-0000.json.gz').rows[0].proposals;
  targets.push(...others.filter(row=>row.language==='zh-CN').map(row=>({...row,sourceUrl:row.sourceFields.sourceUrl})));
  const runtime={module:{exports:{}},AbortController,setTimeout,clearTimeout};vm.runInNewContext(fs.readFileSync(path.join(root,'assets/card-rarity-filters.js'),'utf8'),runtime);const actual=runtime.module.exports;
  const jpSets=new Map(read('data/japanese-catalog.json').sets.map(s=>[s.code.toUpperCase(),s])),counts={},remaining={ja:0,en:0,'zh-CN':0},observed=new Map();
  const identity=row=>row.language+'|'+row.setCode.toUpperCase()+'|'+row.sourceUrl;
  const fetchImpl=async url=>{const f=url.split('?')[0].replace(/^\//,'');assert(f.startsWith(directory),'runtime metadata stays local and credential-free');return fs.existsSync(path.join(root,f))?{ok:true,json:async()=>read(f)}:{ok:false};};
  for(const row of targets){
    const set=jpSets.get(row.setCode.toUpperCase()),file=row.language==='ja'?'data/cards-by-set/'+(set.fileCode||set.code)+'.json':row.language==='en'?'data/english-sets/'+row.setCode+'.json':'data/chinese-sets/'+row.setCode+'.json';
    const matches=read(file).cards.filter(c=>(c.url||c.sourceUrl)===row.sourceUrl);assert.equal(matches.length,1,row.sourceUrl);const card=matches[0],before=JSON.stringify(card);assert.equal(card.number,row.number);
    const brand=row.language==='ja'?'pokemon':row.language==='en'?'pokemon-en':'pokemon-cn',result=(await actual.enrich([card],{brand,setCode:row.setCode,fetchImpl}))[0],state=actual.metadata(result).state;
    observed.set(identity(row),{state,name:card.name,number:card.number,rarity:card.rarity});
    counts[state]=(counts[state]||0)+1;if(['source-unlisted','unknown','reference-conflict'].includes(state))remaining[row.language]++;
    assert.equal(JSON.stringify(card),before);
    for(const key of Object.keys(card).filter(k=>!['rarityOriginal','rarityEvidence','raritySourceUnlisted'].includes(k)))assert.deepEqual(result[key],card[key],row.sourceUrl+' '+key);
  }
  const disclosures=read(directory+'rarity-disclosures.json').cards.weiss_schwarz,ids=new Set(Object.keys(disclosures));let documented=0;
  for(const file of fs.readdirSync(path.join(root,'data/tcg-card-info/weiss_schwarz')))for(const card of read('data/tcg-card-info/weiss_schwarz/'+file).cards||[]){
    if(!ids.has(String(card.snkrdunkId||card.id)))continue;
    assert.equal(actual.metadata(card).state,'documented-unprinted');assert.match(actual.evidenceHtml(card),/希|レアリティ|rarity/i);assert.equal(card.rarity,'');documented++;
  }
  assert.equal(documented,9);counts['documented-unprinted']=documented;
  const review=read(directory+'rarity906-review-20261104.json'),totals=review;
  const expected={'reference-grade':totals.referenceGrade,'reference-unlisted':totals.explicitExternalUnlisted,
    'reference-conflict':totals.referenceConflict,'source-unlisted':totals.noAdoptableClassification,
    'documented-unprinted':totals.documentedUnprintedRarity};
  for(const [state,value]of Object.entries(expected))assert(Number.isInteger(value)&&value>=0,state+' must have an explicit review count');
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map(state=>[state,counts[state]||0])),expected);
  assert.equal(counts.unknown||0,0,'every row in the frozen audited cohort has a reviewed state');
  assert.equal(Object.values(counts).reduce((a,b)=>a+b,0),3381);
  assert.equal(Object.values(expected).reduce((a,b)=>a+b,0),3381,'the latest report accounts for the complete original cohort');
  assert.equal(Object.values(remaining).reduce((a,b)=>a+b,0),totals.remainingUnresolvedIncludingConflicts);
  assert.deepEqual(remaining,review.languageRemaining);
  const adopted=review.adoptedRows;
  assert(Array.isArray(adopted));
  assert.equal(new Set(adopted.map(identity)).size,adopted.length,'new decisions are unique panel rows');
  assert.equal(review.previousRemaining,906);
  assert.equal(906-adopted.length,totals.remainingUnresolvedIncludingConflicts,'each new accepted decision removes exactly one previously unresolved row');
  assert.equal(totals.additionalReferenceGrades+totals.additionalExplicitNoSymbolReferences,adopted.length);
  assert.equal(adopted.filter(row=>row.proposedState==='reference-grade').length,totals.additionalReferenceGrades);
  assert.equal(adopted.filter(row=>row.proposedState==='reference-unlisted').length,totals.additionalExplicitNoSymbolReferences);
  assert.equal(totals.referenceGrade,852+totals.additionalReferenceGrades);
  assert.equal(totals.explicitExternalUnlisted,1614+totals.additionalExplicitNoSymbolReferences);
  const crypto=require('node:crypto'),rawHashes=new Map();
  for(const row of adopted){
    const actualRow=observed.get(identity(row));assert(actualRow,'a new decision belongs to the original3381-row cohort: '+identity(row));
    assert.equal(actualRow.name,row.name);assert.equal(actualRow.number,row.number);
    assert.equal(actualRow.state,row.proposedState,identity(row)+' actual runtime agrees with the adopted report');
    assert(!actualRow.rarity,'an accepted reference decision never replaces an original source grade');
    assert(!['known','reference-grade','reference-unlisted','documented-unprinted'].includes(row.previousState),'an already resolved row cannot be counted as new progress');
    assert.match(row.rawFileSha256,/^[a-f0-9]{64}$/);
    if(!rawHashes.has(row.rawFile)){
      const digest=body=>crypto.createHash('sha256').update(body).digest('hex');
      const bytes=fs.readFileSync(path.resolve(root,row.rawFile)),current=digest(bytes);
      let identityHash=current,identityBytes=bytes;
      if(identityHash!==row.rawFileSha256){
        const repairs=read('config/verified-image-url-repairs.json');
        if(repairs.targetFiles.includes(row.rawFile)){
          const originalUrls=new Map();
          for(const proof of repairs.bindings){
            assert(!originalUrls.has(proof.image)||originalUrls.get(proof.image)===proof.oldImage,'Reviewed URL reversal must be unambiguous');
            originalUrls.set(proof.image,proof.oldImage);
          }
          identityBytes=Buffer.from(bytes.toString('utf8').replace(/https:\/\/static\.tcgcollector\.com\/content\/images\/[^"\s\\<>]+/g,url=>originalUrls.get(url)||url));
          identityHash=digest(identityBytes);
        }
      }
      if(identityHash!==row.rawFileSha256){
        assert.match(row.rawFile,/^data\/cards-by-set\/[A-Za-z0-9+_-]+\.json$/,'Only separately reviewed image migrations may change snapshot bytes');
        const source=JSON.parse(identityBytes),review=read('data/pokemon-vintage-image-repairs.json');
        const identities=new Map(review.images.filter(proof=>proof.setCode===source.code).map(proof=>[proof.sourceUrl,proof]));
        assert.equal(identities.size,source.cards.length,'Display migration proves the complete original inventory');
        const projected={...source,cards:source.cards.map(card=>{
          const proof=identities.get(card.url||card.sourceUrl);assert(proof,'Exact original source URL remains reviewed');
          assert.equal(card.image,proof.originalImage);
          assert.equal(card.localImage,proof.localImage);assert.equal(card.imageSourceUrl,proof.imageSourceUrl);
          assert.equal(card.currentSourceUrl,proof.canonicalSourceUrl||proof.sourceUrl);
          const original={...card};delete original.localImage;delete original.imageSourceUrl;delete original.currentSourceUrl;return original;
        })};
        const canonical=JSON.stringify(projected,null,2)+'\n';
        const windows=canonical.replace(/\n/g,'\r\n');
        // Historical Windows snapshots retained CRLF except the rewritten
        // cardCount header and final newline. Preserve that exact digest too.
        const legacyWindows=windows.replace(/(\"cardCount\": \d+,)\r\n/,'$1\n').replace(/}\r\n$/,'}\n');
        const hashes=[digest(canonical),digest(windows),digest(legacyWindows)];
        assert(hashes.includes(row.rawFileSha256),row.rawFile+' changed fields beyond reviewed display paths or line endings');
        identityHash=row.rawFileSha256;
      }
      rawHashes.set(row.rawFile,identityHash);
    }
    assert.equal(rawHashes.get(row.rawFile),row.rawFileSha256,row.rawFile+' original identity snapshot remains exact');
  }
});

test('Chinese catalogue service-worker requests bypass both stale worker and HTTP caches online, retaining offline fallback',async()=>{
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const source=fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8');
  async function requestThroughWorker(online){
    const request=new Request('https://tcghub.kr/assets/chinese-catalog.js?v=20261030-rarity1');
    let fetchHandler,responsePromise,stored=new Response('old-worker-cached-chinese-js'),cacheReads=0,cacheWrites=0;const calls=[];
    const cache={async match(req){assert.equal(req.url,request.url);cacheReads++;return stored.clone();},async put(req,res){assert.equal(req.url,request.url);cacheWrites++;stored=res;}};
    const runtime={URL,Response,location:{origin:'https://tcghub.kr'},
      self:{addEventListener(type,handler){if(type==='fetch')fetchHandler=handler;}},
      caches:{async open(name){assert.match(name,/-static$/);return cache;}},
      async fetch(req,options){calls.push({req,options});if(!online)throw Error('offline');return new Response(options?.cache==='no-cache'?'fresh-chinese-js':'old-http-cached-chinese-js');},
    };
    vm.runInNewContext(source,runtime,{filename:'sw.js'});
    fetchHandler({request,respondWith(promise){responsePromise=promise;}});
    assert(responsePromise,'the real service-worker fetch handler must own the catalogue request');
    const response=await responsePromise;
    return {body:await response.text(),calls,cacheReads,cacheWrites,cachedBody:await stored.text(),request};
  }
  const online=await requestThroughWorker(true);
  assert.equal(online.body,'fresh-chinese-js','a cached previous release cannot hide the current online catalogue');
  assert.equal(online.calls.length,1);assert.equal(online.calls[0].req,online.request);assert.equal(online.calls[0].options?.cache,'no-cache','revalidate the HTTP cache as well as the service-worker cache');
  assert.equal(online.cacheReads,0,'network-first must not read the stale response while online');assert.equal(online.cacheWrites,1);assert.equal(online.cachedBody,'fresh-chinese-js');
  const offline=await requestThroughWorker(false);
  assert.equal(offline.body,'old-worker-cached-chinese-js');assert.equal(offline.calls.length,1,'try the network before the offline fallback');assert.equal(offline.calls[0].options?.cache,'no-cache');
  assert.equal(offline.cacheReads,1);assert.equal(offline.cacheWrites,0);
});

// Detail provenance uses the same release gate as its source-rarity contract.
require('./test_contained_rarity_details.cjs');

// The bounded remaining-rarity decisions share the existing release gate.
require('./test_rarity906_review.cjs');
