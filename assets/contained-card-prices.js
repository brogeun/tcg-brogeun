/* Existing Japanese grids keep their official identity and use one price host. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.ContainedCardPrices=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const tokens=new WeakMap();let overridePromise,eb05Promise;
  const upper=value=>String(value||'').normalize('NFKC').trim().toUpperCase();
  function targetFor(identity){
    const target={...identity,game:identity.brand,language:identity.language||'ja',grade:'raw'};
    if(identity.brand==='pokemon')target.fullNumber=String(identity.number||'').split('_')[0];
    else if(identity.brand==='onepiece'){
      const full=String(identity.fullId||'').replace(/_[^_]+$/,'');
      const number=String(identity.number||identity.baseNumber||'').split('_')[0];
      target.fullNumber=/^[A-Za-z0-9]+-\d+[A-Za-z]*$/.test(full)?full:
        /^[A-Za-z0-9]+-\d+[A-Za-z]*$/.test(number)?number:
        identity.setCode&&/^\d+$/.test(number)?identity.setCode+'-'+number.padStart(3,'0'):'';
    }
    // The reviewed numberless EB05 artwork ID encodes its exact market product.
    if(identity.brand==='onepiece'&&upper(identity.boxCode)==='EB05'){
      const don=upper(identity.fullId).match(/^EB05-DON_SNKR(\d+)$/);
      if(don){target.marketProductId=don[1];target.productNumber='OPC-TCG-EB-05-DON';}
    }
    // Official source IDs and market product IDs are separate namespaces.
    delete target.snkrdunkId;delete target.snkrProduct;return target;
  }
  async function defaultProducts(){
    if(typeof loadCardSearchData!=='function')throw Error('Market catalogue unavailable');
    await loadCardSearchData();
    if(typeof _ALL_CARDS_INDEX==='undefined'||!Array.isArray(_ALL_CARDS_INDEX))throw Error('Market catalogue unavailable');
    return _ALL_CARDS_INDEX;
  }
  async function defaultSetProducts(){
    if(!eb05Promise)eb05Promise=fetch('/data/onepiece-eb05-market.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('EB05 snapshot unavailable');return r.json();}).then(d=>{if(d.code!=='EB05'||!Array.isArray(d.products))throw Error('Invalid EB05 snapshot');return d.products;}).catch(e=>{eb05Promise=null;throw e;});
    return eb05Promise;
  }
  function mergeSetProducts(products,extra){
    const rows=new Map(products.map(p=>[String(p.id),p]));
    for(const p of extra){
      if(p.brand!=='onepiece'||p.kind!=='card'||!/^\d+$/.test(String(p.id))||!/Extra Booster "Heroines Edition Vol\.2"/.test(p.name||''))continue;
      const old=rows.get(String(p.id)),stamp=row=>Date.parse(row?.priceCheckedAt||row?.fetchedAt||'')||0;
      const selected=old&&stamp(old)>=stamp(p)?old:p;
      rows.set(String(p.id),{...selected,setSnapshot:'EB05'});
    }
    return [...rows.values()];
  }
  async function defaultDetails(){if(typeof loadCardsDetail!=='function')throw Error('Market details unavailable');return await loadCardsDetail();}
  async function defaultOverrides(){
    if(!overridePromise)overridePromise=fetch('/data/onepiece-card-overrides.json',{cache:'no-cache'}).then(r=>r.ok?r.json():{}).catch(()=>{overridePromise=null;return {};});
    return overridePromise;
  }
  function reviewedLinks(targets,products,overrides,match){
    const links={};
    for(const target of targets){
      if(target.brand!=='onepiece'||!target.fullId)continue;
      const key=upper(target.fullId),id=overrides?.[key],product=products.find(row=>String(row.id)===String(id));
      if(!id||!product||!match.sameIdentity(target,product))continue;
      links[[target.brand,upper(target.boxCode),key].join(':')]={id:String(id),brand:target.brand,fullId:key};
    }
    return links;
  }
  function withRawDetail(product,details){
    const card=details?.cards?.[String(product.id)],raw=card?.grades?.raw;
    if(!raw)return {...product};
    if(product.setSnapshot==='EB05'&&(Date.parse(card.fetchedAt||'')||0)<(Date.parse(product.priceCheckedAt||'')||0))return {...product};
    const merged={...product,grades:{...(product.grades||{}),raw:{...raw}},gradeCheckedAt:card.fetchedAt||null};
    if(!card.fetchedAt){merged.priceCheckedAt=null;merged.fetchedAt=null;}
    return merged;
  }
  async function prepareTargets(identities,{isCurrent=()=>true,services={}}={}){
    const targets=identities.map(targetFor),match=services.match||root.ContainedCardMatch;
    const unavailable=()=>targets.map(target=>({...target,snkrdunkStatus:'unknown',sourceUnavailable:true}));
    if(!match||!isCurrent())return unavailable();
    let products;try{products=await(services.loadProducts||defaultProducts)();if(!Array.isArray(products))throw Error('Invalid market catalogue');}catch{return unavailable();}
    if(!isCurrent())return unavailable();
    if(targets.some(t=>t.brand==='onepiece'&&upper(t.boxCode)==='EB05'))try{products=mergeSetProducts(products,await(services.loadSetProducts||defaultSetProducts)());}catch{}
    if(!isCurrent())return unavailable();
    let overrides={};if(targets.some(target=>target.brand==='onepiece'))try{overrides=await(services.loadOverrides||defaultOverrides)();}catch{}
    if(!isCurrent())return unavailable();
    const links=reviewedLinks(targets,products,overrides,match),resolve=match.createResolver(products,links,services.candidateProofs||{});
    for(const target of targets){
      if(!['pokemon','onepiece'].includes(target.brand)||target.language!=='ja'||target.bundle===true||target.quantity>1||target.kind==='box'){target.snkrdunkStatus='unlinked';continue;}
      const result=resolve(target);target.snkrdunkStatus=result.status;
      if(result.status==='matched'){
        const product=products.find(row=>String(row.id)===String(result.id));
        if(product){target.snkrdunkId=String(result.id);target.snkrProduct=product;}
      }
    }
    let details={cards:{}},detailsFailed=false;
    if(targets.some(target=>target.snkrProduct))try{details=await(services.loadDetails||defaultDetails)();if(!details?.cards||typeof details.cards!=='object')throw Error('Invalid detail catalogue');}catch{details={cards:{}};detailsFailed=true;}
    if(!isCurrent())return unavailable();
    return targets.map(target=>target.snkrProduct?{...target,snkrProduct:withRawDetail(target.snkrProduct,details),detailsStatus:detailsFailed?'unavailable':'available'}:target);
  }
  async function prepareTarget(identity,options={}){return (await prepareTargets([identity],options))[0];}
  async function hydrate(container,{isCurrent=()=>true,services={}}={}){
    const match=services.match||root.ContainedCardMatch,fallback=services.fallback||root.CardPriceFallback;
    if(!container||!match||!fallback)return [];
    const entries=[];
    for(const host of container.querySelectorAll('[data-contained-price]')){
      const token={};tokens.set(host,token);
      const item=host.closest('.set-card-item[data-card-identity]');let identity;
      try{identity=JSON.parse(item?.dataset.cardIdentity||'null');}catch{continue;}
      if(!identity||!['pokemon','onepiece'].includes(identity.brand)||identity.language!=='ja')continue;
      const current=()=>tokens.get(host)===token&&host.isConnected!==false&&isCurrent();
      entries.push({host,identity,current});
    }
    if(!entries.length||!isCurrent())return [];
    const delayed=entry=>{const result={status:'unknown',source:'snkrdunk',notes:['SNKRDUNK 가격 확인 지연']};if(entry.current())entry.host.innerHTML='<span class="card-price-fallback cpf-none">SNKRDUNK 가격 확인 지연</span>';return result;};
    let targets;try{targets=await prepareTargets(entries.map(entry=>entry.identity),{isCurrent,services});}catch{return entries.map(delayed);}
    if(!isCurrent())return [];
    let cursor=0;const results=new Array(entries.length);
    async function worker(){
      while(cursor<entries.length){const index=cursor++,entry=entries[index];if(!entry.current())continue;
        try{
        const target=targets[index];
        if(target.sourceUnavailable){results[index]=delayed(entry);continue;}
        let result;
        if(target.detailsStatus==='unavailable'&&target.snkrProduct){result=fallback.resolve(target);if(result.status!=='priced'){results[index]=delayed(entry);continue;}}
        if(target.bundle===true||target.quantity>1||target.kind==='box'||target.unprintedNumber||!target.fullNumber){
          result=target.snkrProduct&&!target.bundle&&!(target.quantity>1)&&target.kind!=='box'?fallback.resolve(target):fallback.resolve({...target,language:'unavailable'});
        }else result=await fallback.lookup(target,{isCurrent:entry.current});
        if(entry.current()){entry.host.innerHTML=fallback.render(result,{compact:true});results[index]=result;}
        }catch{results[index]=delayed(entry);}
      }
    }
    await Promise.all(Array.from({length:Math.min(4,entries.length)},worker));return results;
  }
  return {hydrate,prepareTarget,targetFor,reviewedLinks,withRawDetail,mergeSetProducts};
});
