/* Reviewed artwork and numberless DON!! identities; never supplies market prices. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.CardCatalogRepairs=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  let data,ready;
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
      nameLower:[card.name,card.nameKo,card.setCode,'OP-17','돈 돈카드 don ドン',card.versionLabel,card.searchAliases].join(' ').toLowerCase()});
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
  const api={configure,ensureData,printed,setCards,products};return api;
});
