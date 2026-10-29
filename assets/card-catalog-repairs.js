/* Reviewed artwork and numberless DON!! identities; prices come only from exact live product IDs. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.CardCatalogRepairs=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  let data,ready;
  const quoteCache=new Map(),priceTokens=new WeakMap();
  const upper=value=>String(value||'').toUpperCase();
  function configure(next){
    if(next?.schemaVersion!==1||!Array.isArray(next.pokemonImages)||!Array.isArray(next.onepieceDon)||!Array.isArray(next.englishDonProductIds))throw Error('Invalid card catalogue repairs');
    const ids=new Set(),fullIds=new Set();
    for(const card of next.onepieceDon){
      if(!/^\d+$/.test(card.productId)||ids.has(card.productId)||fullIds.has(card.fullId)||
          !/^OP\d+-DON-\d{2}(?:_p1)?$/.test(card.fullId)||!card.image.startsWith('/images/onepiece/'))throw Error('Invalid reviewed DON!! identity');
      ids.add(card.productId);fullIds.add(card.fullId);
    }
    data=next;return api;
  }
  async function ensureData(){
    if(data)return data;
    if(!ready)ready=fetch('/data/card-catalog-repairs.json?v=20261030-1',{signal:AbortSignal.timeout(12000)}).then(r=>{
      if(!r.ok)throw Error('Card catalogue repairs HTTP '+r.status);
      return r.json();
    }).then(next=>{configure(next);return data;}).catch(error=>{
      ready=null;root.console?.warn('[catalogue] Reviewed supplements unavailable; retaining source catalogue.',error.message);return null;
    });
    return ready;
  }
  function printed(card,code){
    const source=String(card.sourceUrl||card.url||'');
    const repair=data?.pokemonImages.find(row=>row.number===card.number&&upper(row.setCode)===upper(code||card.setCode||card.boxCode)&&
      (row.catalogueId===card.id||row.sourceUrl===source));
    if(!repair)return card;
    return {...card,image:repair.image,...('thumbnailUrl' in card?{thumbnailUrl:repair.image}:{})};
  }
  function setCards(source,code){
    if(!source||!data)return source;
    const cards=(source.cards||[]).map(card=>printed(card,code));
    for(const card of data.onepieceDon.filter(row=>upper(row.setCode)===upper(code))){
      if(!cards.some(row=>row.fullId===card.fullId))cards.push({...card});
    }
    return {...source,cards,cardCount:cards.length};
  }
  function products(source){
    if(!data)return source;
    const reviewed=new Map(data.onepieceDon.map(card=>[card.productId,card]));
    const found=new Set();
    const decorate=(product,card)=>({...product,language:'ja',setCode:card.setCode,code:card.setCode,fullId:card.fullId,cardType:'DON',finish:card.finish,
      nameKo:card.nameKo+' · '+card.versionLabel,_koName:card.nameKo+' · '+card.versionLabel,
      thumbnailUrl:card.image,
      // Source titles call the Rocks Diamond "Gold Text". Search the reviewed
      // finish, so an explicit Gold query cannot select the Diamond printing.
      nameLower:[card.name,card.nameKo,String(card.marketName||'').replace(/\b(?:Gold\s+Text|Super\s+Parallel)\b/gi,''),card.setCode,'OP-17','돈 돈카드 don ドン',card.versionLabel,card.searchAliases].join(' ').toLowerCase()});
    const rows=source.map(product=>{
      if(product.brand!=='onepiece'||product.kind!=='card'||!/^opc-tcg-op-17-don$/i.test(product.productNumber||''))return product;
      const card=reviewed.get(String(product.id));
      if(!card)return data.englishDonProductIds.includes(String(product.id))?{...product,language:'en'}:product;
      found.add(String(product.id));
      return decorate(product,card);
    });
    for(const card of data.onepieceDon){
      if(found.has(card.productId)||source.some(product=>String(product.id)===card.productId))continue;
      const product={id:card.productId,brand:'onepiece',kind:'card',name:card.marketName,productNumber:'OPC-TCG-OP-17-DON',
        minPrice:null,currency:'JPY',listingCount:0};
      rows.push(decorate(product,card));
    }
    return rows;
  }
  async function liveQuote(id){
    const now=Date.now(),saved=quoteCache.get(id);
    if(saved&&saved.until>now)return saved.promise;
    const entry={until:now+60000};
    entry.promise=(async()=>{
      try{
        const response=await fetch('/api/card-grades?id='+encodeURIComponent(id),{signal:AbortSignal.timeout(12000)});
        if(!response.ok)throw Error('Live price HTTP '+response.status);
        const value=await response.json(),stamp=Date.parse(value.fetchedAt||'');
        if(value.ok!==true||String(value.id)!==id||!Number.isFinite(stamp)||stamp>now+300000||now-stamp>4200000)throw Error('Unverified live quote');
        const raw=value.grades?.raw;
        if(raw&&raw.currency==='JPY'&&Number.isFinite(raw.lowest_ask)&&raw.lowest_ask>0){
          entry.until=Math.max(now+1000,Math.min(now+1800000,stamp+3600000));
          return {amount:raw.lowest_ask,currency:'JPY',count:Number.isInteger(raw.active_count)&&raw.active_count>0?raw.active_count:null};
        }
        if(!raw&&Array.isArray(value.noListingGrades)&&value.noListingGrades.includes('raw')){
          entry.until=now+300000;return {amount:null,currency:'JPY',count:0};
        }
      }catch{/* Retain the recorded quote when the exact Japanese source is unavailable. */}
      return null;
    })();
    quoteCache.set(id,entry);return entry.promise;
  }
  async function hydratePrices(container,rows,{isCurrent=()=>true,formatKrw,formatOrig}={}){
    if(!container||!isCurrent())return;
    const token={};priceTokens.set(container,token);
    if(!data)await ensureData();
    if(!data||priceTokens.get(container)!==token||!isCurrent())return;
    const reviewed=new Set(data.onepieceDon.map(card=>card.productId)),byId=new Map(rows.map(row=>[String(row.id),row]));
    const entries=[];
    for(const host of container.querySelectorAll('[data-live-card-price]')){
      const id=String(host.dataset.liveCardPrice||''),row=byId.get(id);
      if(!row||!reviewed.has(id)||row.brand!=='onepiece'||row.kind==='box'||row.language&&row.language!=='ja')continue;
      entries.push({host,id});
    }
    let cursor=0;
    async function worker(){
      while(cursor<entries.length){
        const {host,id}=entries[cursor++];
        const current=()=>priceTokens.get(container)===token&&host.isConnected!==false&&isCurrent();
        if(!current())continue;
        const quote=await liveQuote(id);
        if(!quote||!current())continue;
        const main=host.querySelector('[data-card-price-main]'),origin=host.querySelector('[data-card-price-origin]');
        const stock=host.querySelector('[data-card-price-stock]'),note=host.querySelector('[data-card-price-note]');
        if(main)main.textContent=quote.amount===null?'매물 없음':formatKrw?formatKrw(quote.amount,quote.currency):'¥'+quote.amount.toLocaleString('ja-JP');
        if(origin)origin.textContent=quote.amount===null?'':formatOrig?formatOrig(quote.amount,quote.currency):'¥'+quote.amount.toLocaleString('ja-JP');
        if(stock)stock.textContent=quote.count===0?'':quote.count?quote.count+' 매물':'판매 중';
        if(note)note.textContent=quote.amount===null?'A급 매물 없음':'A급 매물 최저가';
      }
    }
    await Promise.all(Array.from({length:Math.min(3,entries.length)},worker));
  }
  const api={configure,ensureData,printed,setCards,products,hydratePrices};return api;
});

