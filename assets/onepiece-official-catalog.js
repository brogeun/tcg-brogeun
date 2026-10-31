/* Official Japanese artwork identity and actual acquisition are independent. */
(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.OnePieceCatalog=api;})(typeof globalThis!=='undefined'?globalThis:this,function(root){
 'use strict';let catalog,manifest,manifestReady,searchReady,rows=[],products=[];
 const labels={booster:'부스터',extra_booster:'엑스트라',premium_booster:'프리미엄',starter:'스타트덱',promotion:'프로모',limited_product:'한정상품',family_deck:'패밀리 덱'};
 const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s‐‑–—−-]+/g,'');
 function configure(data){
  if(data?.schemaVersion!==1||!Array.isArray(data.cards)||data.cards.some(c=>c.language!=='ja'||c.brand!=='onepiece'||!/^JP:ONEPIECE:/.test(c.id)))throw Error('Invalid official One Piece search');
  if(new Set(data.cards.map(c=>c.id)).size!==data.cards.length)throw Error('Duplicate artwork');
  catalog=data;return setProducts(products);
 }
 function setProducts(source){products=source||[];const byId=new Map(products.map(p=>[String(p.id),p]));
  rows=(catalog?.cards||[]).map(c=>{const p=c.productId&&byId.get(c.productId),name=c.nameKo||c.name,terms=[c.name,c.nameKo,p?.name,p?.nameKo,c.fullId,c.number,c.setCode+' '+c.number,c.boxCode,c.acquisition,c.acquisitionLabel,c.categoryLabel,c.versionLabel];return {...c,_catalogue:true,catalogueId:c.id,displayName:name,thumbnailUrl:c.image,productNumber:c.fullId,nameLower:terms.filter(Boolean).join(' ').toLowerCase(),_opSearch: norm(terms.join(' ')),minPrice:p?.minPrice,currency:p?.currency||'JPY',listingCount:p?.listingCount||0};});return rows;
 }
 async function json(path){const r=await fetch(path,{cache:'no-cache'});if(!r.ok)throw Error('Official inventory HTTP '+r.status);return r.json();}
 function ensureManifest(){if(!manifestReady)manifestReady=json('/data/onepiece-official-manifest.json').then(d=>{if(d.schemaVersion!==1||!Array.isArray(d.sets))throw Error('Invalid official manifest');manifest=d;return d;}).catch(e=>{manifestReady=null;throw e;});return manifestReady;}
 function ensureData(){if(!searchReady)searchReady=json('/data/onepiece-official-search.json').then(d=>{configure(d);return d;}).catch(e=>{searchReady=null;throw e;});return searchReady;}
 function mergeSearch(existing){if(!rows.length)return existing;const covered=new Set(rows.map(c=>c.productId).filter(Boolean));return [...existing.filter(c=>!/^JP:ONEPIECE:/.test(c.id)&&!(c.brand==='onepiece'&&c.kind==='card'&&covered.has(String(c.id)))),...rows];}
 function matches(card,q){return card.brand==='onepiece'&&!!norm(q)&&norm(card._opSearch||card.nameLower).includes(norm(q));}
 function find(id){return rows.find(c=>c.id===id);}
 function registerSets(list){if(!manifest)return list;const byCode=new Map(list.map(s=>[s.code,s]));for(const s of manifest.sets){const old=byCode.get(s.code);byCode.set(s.code,old?{...old,category:s.category,officialCardCount:s.officialCardCount,officialComplete:true}:{...s,image:s.image||'/assets/onepiece-promo-cover.svg'});}return [...byCode.values()];}
 function href(card){const q=new URLSearchParams({set:card.boxCode,card:card.fullId});return '/?'+q+'#cardinfo';}
 return {ensureData,ensureManifest,configure,setProducts,mergeSearch,matches,find,registerSets,href,labels,getSearchRows:()=>rows};
});
