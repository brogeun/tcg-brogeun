/* A contained card keeps one price source. A listing reference is never a valuation. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.CardPriceFallback=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const aliases={weiss:'weiss_schwarz','weis-schwarz':'weiss_schwarz','weiss-schwarz':'weiss_schwarz',unionarena:'union_arena','union-arena':'union_arena',dragonball:'dragon_ball_fusion_world','dragon-ball-super-card-game':'dragon_ball_fusion_world','yu-gi-oh':'yugioh',digimoncard:'digimon','pokemon-card':'pokemon','one-piece-card-game':'onepiece'};
  const games=new Set(['pokemon','onepiece','weiss_schwarz','union_arena','dragon_ball_fusion_world','yugioh','digimon','chiikawa']);
  const yuyuGames=new Set(['pokemon','onepiece','weiss_schwarz','union_arena','digimon']);
  const game=value=>aliases[String(value||'').toLowerCase()]||String(value||'').toLowerCase();
  const norm=value=>String(value??'').normalize('NFKC').trim().toUpperCase().replace(/[‐‑–—−]/g,'-').replace(/\s+/g,'');
  const rarity=value=>({'DOUBLERARE(RR)':'RR','ARTRARE(AR)':'AR','SPECIALARTRARE(SAR)':'SAR'})[norm(value)]||norm(value);
  const language=value=>({ja:'ja',jp:'ja',japanese:'ja','日本語':'ja',en:'en',eng:'en',english:'en',ko:'ko',kr:'ko',korean:'ko',zh:'zh',cn:'zh',chinese:'zh'})[String(value||'').toLowerCase()]||'unknown';
  const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
  const currency=value=>['JPY','USD','KRW'].includes(value)?value:null;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cache=new Map(),tokens=new WeakMap();
  function fullNumber(target){return norm(target.fullNumber||target.fullCardNumber||target.cardNumber||target.number||'');}
  function productNumber(row,g){
    const printedPatterns={weiss_schwarz:/^[A-Z0-9_.+-]+\/[A-Z0-9_.+-]+-[A-Z0-9_.+-]+$/,union_arena:/^(?:UA|EX|PC)[A-Z0-9]*[/-][A-Z0-9/_.+-]+$/,dragon_ball_fusion_world:/^(?:FB|FS|SB|ST|FP|E)[0-9]+-[A-Z0-9-]+$/,yugioh:/^[A-Z0-9]+-[A-Z0-9]+$/,digimon:/^[A-Z]+[0-9]*-[A-Z0-9-]+$/,onepiece:/^(?:OP|ST|EB|PRB)\d+-\d+[A-Z]*$/};
    // The source title can distinguish T01 from T01R while its productNumber
    // reuses T01. Preserve the original full bracket, including E5 qualifiers.
    for(const match of String(row.name||'').matchAll(/\[([^\]]+)\]/g)){
      const value=match[1].normalize('NFKC').trim().toUpperCase().replace(/\s+/g,' ').replace(/^(?:WS-TCG-|UATCG-|DBSC-TCG-|DBSCG-|DBFW-|YGO-OCG-TCG-|YGO-OCG-|YGO-TCG-|DGCG-TCG-|DGCG-)/,'');
      if(printedPatterns[g]?.test(value.split(' ')[0]))return norm(value);
    }
    const explicit=row.fullNumber||row.fullCardNumber||row.cardNumber;if(explicit)return norm(explicit);
    let value=norm(row.productNumber||row.code);
    const unwrapped=value.replace(/^(?:WS-TCG-|UATCG-|DBSC-TCG-|DBSCG-|DBFW-|YGO-OCG-TCG-|YGO-OCG-|YGO-TCG-|DGCG-TCG-|DGCG-)/,'');
    if(printedPatterns[g]?.test(unwrapped))return unwrapped;
    const patterns={onepiece:/^(?:OPTCG-|OPC-TCG-)?(?:JP-)?((?:OP|ST|EB|PRB)\d+-\d+[A-Z]*)$/,digimon:/^(?:(?:DCG|DIGIMON)-)?(?:JP-)?((?:BT|EX|ST|LM)\d+-\d+[A-Z]*)$/,dragon_ball_fusion_world:/^(?:(?:DBSCG|DBFW)-)?(?:JP-)?((?:FB|FS|FP)\d+-\d+[A-Z]*)$/,yugioh:/^(?:YGO-)?(?:JP-)?([A-Z0-9]+-JP\d+[A-Z]*)$/};
    if(patterns[g])return value.match(patterns[g])?.[1]||'';
    if(g==='weiss_schwarz')return value.replace(/^WS-TCG-(?:JP-)?/,'').replace(/^([A-Z0-9]+)-(S\d+|W\d+)-/,'$1/$2-');
    if(g==='union_arena')return value.replace(/^UATCG-/,'').replace(/^(UA\d+BT|UAPR)-/,'$1/');
    if(g==='pokemon')return norm((String(row.name||'').match(/\b(\d+\/\d+)\b/)||[])[1]||'');
    return '';
  }
  function setCode(target){return norm(target.setCode||target.boxCode||'');}
  function sameSet(target,row){
    const own=setCode(target),other=norm(row.setCode),g=game(target.game||target.brand),number=fullNumber(target);
    if(!own)return g!=='pokemon';
    if(own===other)return true;
    // The Japanese M-series uses M6a locally and M06a at this shop. Require
    // the complete printed fraction; this never merges split or reprint sets.
    if(g==='pokemon'&&/^\d+\/\d+$/.test(number)){
      const m=value=>value.replace(/^M0([1-9])([A-Z]?)$/,'M$1$2');
      if(/^M0?[1-9][A-Z]?$/.test(own)&&/^M0?[1-9][A-Z]?$/.test(other))return m(own)===m(other);
    }
    if(g==='union_arena'&&/^UA\d+BT\/[A-Z0-9]+-\d+-[A-Z0-9]+$/.test(number))return own===number.slice(0,number.lastIndexOf('-'))&&other===number.split('/')[0];
    return false;
  }
  function foreign(product){
    const lang=language(product.language);
    return !['ja','unknown'].includes(lang)||/(?:^|-)(?:EN|ENG|CN|ZH|KR|KO|FR|DE|IT|ES|PT)(?:-|$)/i.test(product.productNumber||product.code||'')||/\[(?:EN|ENG|CHN|CN|KR|KOR)\]|\b(?:ENGLISH|KOREAN|CHINESE)\s+(?:VER|VERSION|EDITION)/i.test(product.name||product.title||'');
  }
  function japanese(target,product){return language(target.language)==='ja'||target.japaneseEdition===true||language(product?.language)==='ja'||/(?:^|-)(?:JP|JA)(?:-|$)/i.test(product?.productNumber||product?.code||'');}
  function variantSignature(value){
    const text=norm(value),parts=[];
    for(const [key,pattern] of [['parallel',/PARALLEL|ALTERNATE|ALTERNATIVE|ALTART|パラレル/],['comic',/COMIC|コミック/],['masterball',/MASTER.?BALL|マスターボール/],['monsterball',/MONSTER.?BALL|モンスターボール/],['reverse',/REVERSE|MIRROR|ミラー/],['promo',/PROMO|プロモ/],['winner',/WINNER|優勝/],['anniversary',/ANNIVERSARY|周年/]])if(pattern.test(text))parts.push(key);
    const stars=text.match(/[★☆]+/g);if(stars)parts.push('stars:'+stars.join(''));
    return parts.sort().join('|');
  }
  function numberedArtwork(target){return /(?:^|[_-])P\d+(?:$|[_-])/i.test([target.fullId,target.variantSuffix,target.variant].filter(Boolean).join('_'));}
  function targetKey(target){return [game(target.game||target.brand),setCode(target),fullNumber(target),norm(target.rarity),norm(target.fullId||target.variant)].join(':');}
  function bindingFor(target,bindings){return bindings?.[targetKey(target)]||bindings?.bindings?.[targetKey(target)]||null;}
  function sameGame(target,row){return game(target.game||target.brand)===game(row.game||row.brand||row.identity?.game);}
  function empty(notes=[]){return {status:'none',source:null,amount:null,currency:null,priceKind:null,condition:null,sourceUrl:null,observedAt:null,stale:false,stockState:null,saleStatus:null,verification:null,valuationEligible:false,notes,candidates:[]};}
  function safeSource(url,source){
    try{const u=new URL(url),host={snkrdunk:'snkrdunk.com',yuyutei:'yuyu-tei.jp',mercari:'jp.mercari.com'}[source];return u.protocol==='https:'&&host&&(u.hostname===host||u.hostname==='www.'+host)&&!u.username&&!u.password?u.href:null;}catch{return null;}
  }
  function quote(source,amount,cur,row,extra={}){return {...empty(),status:'priced',source,amount,currency:cur,sourceUrl:safeSource(row.sourceUrl||row.url,source),observedAt:row.sourceAsOf||row.observedAt||row.priceCheckedAt||row.fetchedAt||null,...extra};}
  function snkrQuote(target,products,bindings){
    // Official catalogue numeric IDs use a different namespace. Only an
    // explicitly resolved market ID/product or reviewed binding is a link.
    const binding=bindingFor(target,bindings),wanted=String(target.snkrdunkId||target.snkrProduct?.id||binding?.snkrdunkId||'');
    if(!/^\d+$/.test(wanted))return null;
    const row=products.find(item=>String(item.id)===wanted);
    if(!row||row.kind==='box'||!sameGame(target,row)||foreign(row))return null;
    const declared=productNumber(row,game(target.game||target.brand));if(fullNumber(target)&&declared&&fullNumber(target)!==declared)return null;
    const directCatalog=target.catalogSource==='SNKRDUNK'&&String(target.snkrProduct?.id)===String(row.id)&&
      (String(target.snkrdunkId||'')===String(row.id)||String(target.id||'')==='snkrdunk:'+row.id)&&
      (!fullNumber(target)||!declared||fullNumber(target)===declared);
    if(!japanese(target,row)&&!directCatalog)return null;
    const edition=japanese(target,row)?{editionVerification:'japanese_evidence'}:{editionVerification:'unconfirmed',verification:'same_catalog_product',notes:['판본 언어 미확인']};
    const finish=result=>({...result,...edition});
    const targetGrade=norm(target.grade||'raw');if(!['RAW','UNGRADED'].includes(targetGrade))return null;
    const raw=row.grades?.raw;
    if(raw&&positive(raw.lowest_ask)&&currency(raw.currency)&&raw.availability!=='no-listing'&&raw.active_count!==0){
      return finish(quote('snkrdunk',raw.lowest_ask,raw.currency,row,{priceKind:'lowest_listing_ask',condition:'raw',observedAt:row.gradeCheckedAt||raw.checkedAt||row.priceCheckedAt||row.fetchedAt||null,stale:row.gradeStatus==='previous-retained-after-error',verification:'same_product'}));
    }
    const ask=row.catalogAsk;
    if(row.priceStatus==='no-listings'||row.listingCount===0)return null;
    if(ask&&positive(ask.amount)&&currency(ask.currency)&&ask.kind==='lowest_listing_ask')return finish(quote('snkrdunk',ask.amount,ask.currency,row,{priceKind:'lowest_listing_ask',condition:'unspecified',observedAt:ask.checkedAt||row.priceCheckedAt||null,verification:'same_product',fxBasis:row.priceSource||null}));
    // Legacy snapshots expose current catalogue asks through minPrice. lastPrice
    // and recorded-trade charts are deliberately never substitutes for an ask.
    if(positive(row.minPrice)&&currency(row.currency)&&!['unverified','invalid','error'].includes(row.priceStatus))return finish(quote('snkrdunk',row.minPrice,row.currency,row,{priceKind:'lowest_listing_ask',condition:'unspecified',verification:'same_product',fxBasis:row.priceSource||null}));
    return null;
  }
  function yuyuMatch(target,row,bindings){
    if(!sameGame(target,row)||language(row.language)!=='ja'||foreign(row)||norm(row.grade||'raw')!=='RAW'||row.currency!=='JPY'||row.priceKind!=='asking'||!positive(row.price))return false;
    if(!fullNumber(target)||fullNumber(target)!==norm(row.cardNumber)||!japanese(target))return false;
    if(!sameSet(target,row))return false;
    const binding=bindingFor(target,bindings);
    if(binding?.yuyuteiId){return binding.language==='ja'&&String(binding.yuyuteiId)===String(row.id)&&(!binding.rarity||rarity(binding.rarity)===rarity(row.rarity))&&(!target.rarity||rarity(target.rarity)===rarity(row.rarity));}
    if(numberedArtwork(target)||!rarity(target.rarity)||['-','UNKNOWN'].includes(rarity(target.rarity))||rarity(target.rarity)!==rarity(row.rarity))return false;
    if(target.sourceSetCode&&norm(target.sourceSetCode)!==norm(row.sourceSetCode))return false;
    const own=variantSignature([target.variant,target.rarity,target.name].filter(Boolean).join(' '));
    const other=variantSignature([row.variant,row.rarity,row.name].filter(Boolean).join(' '));
    return own===other;
  }
  function mercariCandidates(target,rows){
    if(!fullNumber(target)||!japanese(target))return [];
    return rows.filter(row=>{
      const identity=row.identity||{},hint=row.matchHints||{},rowGame=game(identity.game||hint.game);
      if(rowGame!==game(target.game||target.brand)||foreign({...identity,name:row.title})||norm(identity.grade||'raw')!=='RAW'||identity.bundle===true||identity.quantity>1)return false;
      if(/\b(?:PSA|BGS|CGC|ARS)\s*\d|鑑定|\bENGLISH\b|英語版|韓国語版|中国語版/i.test(row.title||''))return false;
      if(![...(identity.cardNumbers||[]),identity.cardNumber,...(hint.cardNumbers||[])].some(value=>norm(value)===fullNumber(target)))return false;
      if(/(?:\d+\s*(?:枚|点)|まとめ売り|セット売り|\bLOT\b|\bBUNDLE\b)/i.test(row.title||''))return false;
      return positive(row.price?.amount)&&currency(row.price?.currency)&&!!safeSource(row.sourceUrl,'mercari');
    }).map(row=>quote('mercari',row.price.amount,row.price.currency,row,{status:'candidate',title:row.title||'',priceKind:'displayed_listing_price',condition:'unverified',saleStatus:['active','sold'].includes(row.saleStatus)?row.saleStatus:'unknown',verification:row.verification||'unverified',valuationEligible:false,stale:!!row.stale||row.fetchStatus==='error',notes:['동일 판본 확인 필요','자동 평가액 제외']})).slice(0,3);
  }
  function resolve(target,{snkrProducts=[],yuyuRows=[],mercariReferences=[],bindings={}}={}){
    const g=game(target?.game||target?.brand);
    if(!target||!games.has(g)||!['ja','unknown'].includes(language(target.language))||!['RAW','UNGRADED'].includes(norm(target.grade||'raw')))return empty(['일본판 미감정 카드만 지원']);
    const own=target.snkrProduct,products=own?[own,...snkrProducts.filter(row=>String(row.id)!==String(own.id))]:snkrProducts;
    const snkr=snkrQuote(target,products,bindings);if(snkr)return snkr;
    const matched=[...new Map(yuyuRows.filter(row=>yuyuMatch(target,row,bindings)).map(row=>[row.id,row])).values()];
    if(matched.length===1){const row=matched[0];return quote('yuyutei',row.price,'JPY',row,{priceKind:'shop_asking',condition:'raw',stockState:row.stockState||'unknown',stale:!!row.stale||row.notObservedInLatestSnapshot===true,verification:'exact_printing',notes:row.stockState==='out_of_stock'?['품절 상품의 표시가']:[]});}
    const candidates=mercariCandidates(target,mercariReferences);
    if(candidates.length)return {...candidates[0],candidates};
    return empty(matched.length>1?['같은 번호의 판본을 확정할 수 없음']:['확인된 가격 없음']);
  }
  async function json(path){
    if(!cache.has(path))cache.set(path,fetch(path,{cache:'no-cache'}).then(async response=>{if(!response.ok)throw Error('Source unavailable');return response.json();}).catch(error=>{cache.delete(path);throw error;}));
    return cache.get(path);
  }
  function decodeYuyu(data){
    if(!data||data.source!=='yuyutei')return [];
    if(Array.isArray(data.records))return data.records;
    return (data.rows||[]).map(values=>{const row=Object.fromEntries((data.columns||[]).map((key,index)=>[key,values[index]]));return {...row,id:`yuyutei:${data.sourceGame}:${row.sourceSetCode}:${row.sourceProductId}`,game:data.game,language:data.language||'ja',grade:'raw',currency:data.currency,priceKind:data.priceKind,sourceUrl:`https://yuyu-tei.jp/sell/${data.sourceGame}/card/${row.sourceSetCode}/${row.sourceProductId}`};});
  }
  async function lookup(target,options={}){
    const snkrProducts=options.snkrProducts||[],bindings=options.bindings||{},provided=options.snkrProduct?{...target,snkrProduct:options.snkrProduct}:target;
    let result=resolve(provided,{snkrProducts,bindings});
    if(result.status==='priced'||!japanese(provided,provided.snkrProduct)||!['RAW','UNGRADED'].includes(norm(provided.grade||'raw'))||!['ja','unknown'].includes(language(provided.language)))return result;
    const current=options.isCurrent||(()=>true),load=options.fetchJson||json,g=game(provided.game||provided.brand);
    let rows=options.yuyuRows||[];
    if(options.yuyuRows===undefined&&yuyuGames.has(g)){try{const data=await load(`/data/yuyutei-market/${g}.json`);if(!current())return empty(['조회 취소']);if(game(data.game)!==g)throw Error('Wrong source game');rows=decodeYuyu(data);}catch{rows=[];}}
    result=resolve(provided,{snkrProducts,yuyuRows:rows,bindings});if(result.status==='priced'||!current())return result;
    let references=options.mercariReferences||[];
    if(options.mercariReferences===undefined){try{const data=await load('/data/mercari-references.json');if(!current())return empty(['조회 취소']);if(data.source!=='mercari')throw Error('Wrong source');references=data.references||[];}catch{references=[];}}
    return resolve(provided,{snkrProducts,yuyuRows:rows,mercariReferences:references,bindings});
  }
  function render(result,{compact=false}={}){
    if(!result||result.status==='none')return '<span class="card-price-fallback cpf-none">확인된 가격 없음</span>';
    const labels={snkrdunk:'SNKRDUNK',yuyutei:'유유테이',mercari:'메루카리'},label=result.status==='candidate'?'참고 매물 · 판본 확인 필요':result.source==='snkrdunk'&&result.condition==='unspecified'?'상태 미지정 상품 호가':result.source==='yuyutei'&&result.stockState==='out_of_stock'?'품절 표시가':result.source==='yuyutei'?'판매가':'미감정 최저 호가';
    const price=new Intl.NumberFormat(result.currency==='JPY'?'ja-JP':'ko-KR',{style:'currency',currency:result.currency,maximumFractionDigits:result.currency==='JPY'||result.currency==='KRW'?0:2}).format(result.amount);
    const url=safeSource(result.sourceUrl,result.source),source=url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(labels[result.source])}</a>`:esc(labels[result.source]);
    const time=result.observedAt&&!Number.isNaN(Date.parse(result.observedAt))?new Date(result.observedAt).toISOString().slice(0,10):'확인일 미상';
    const status=result.source==='mercari'?` · ${result.saleStatus==='sold'?'판매완료 매물 표시가':result.saleStatus==='active'?'판매중 확인':'판매상태 미확인'} · 평가액 제외`:'';
    return `<span class="card-price-fallback cpf-${esc(result.status)}${compact?' cpf-compact':''}"><strong>${esc(price)}</strong> <small>${esc(result.currency)} · ${esc(label)}</small><small>${source} · ${esc(time)}${result.stale?' · 이전 관측가':''}${result.editionVerification==='unconfirmed'?' · 판본 언어 미확인':''}${esc(status)}</small></span>`;
  }
  async function decorate(element,target,options={}){
    if(!element)return empty();const token={};tokens.set(element,token);const current=()=>tokens.get(element)===token&&element.isConnected!==false&&(!options.isCurrent||options.isCurrent());
    const result=await lookup(target,{...options,isCurrent:current});if(current())element.innerHTML=render(result,{compact:options.compact!==false});return result;
  }
  async function hydrate(container,targets=[],options={}){
    let cursor=0;const list=Array.from(targets),results=new Array(list.length);
    async function worker(){while(cursor<list.length){const index=cursor++,entry=list[index],target=entry.target||entry,element=entry.element||container?.querySelector(`[data-card-price-id="${String(target.id||'').replace(/[^0-9A-Za-z_-]/g,'')}"]`);results[index]=await decorate(element,target,options);}}
    await Promise.all(Array.from({length:Math.min(4,list.length)},worker));return results;
  }
  return {resolve,lookup,render,decorate,hydrate,decodeYuyu,fullNumber,variantSignature,targetKey};
});
