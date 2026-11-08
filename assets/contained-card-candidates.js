/* Unconfirmed market products remain separate from the printed card's price. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ContainedCardCandidates=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function safeURL(value,hosts){
    try{const url=new URL(String(value||''));return url.protocol==='https:'&&hosts.includes(url.hostname)&&!url.username&&!url.password&&(!url.port||url.port==='443')?url.href:'';}catch{return '';}
  }
  const marketImage=value=>safeURL(value,['cdn.snkrdunk.com']);
  const sourceURL=target=>safeURL(target?.currentSourceUrl||target?.sourceUrl||target?.url,['www.tcgcollector.com','tcgcollector.com','pooka.app','www.pooka.app','www.pokemon-card.com','pokemon-card.com','www.onepiece-cardgame.com','onepiece-cardgame.com']);
  function render(target){
    if(!target||!['pokemon','onepiece'].includes(target.brand)||target.language!=='ja')return '';
    const source=sourceURL(target),sourceLink=source?`<a class="ci-source-card-link" href="${esc(source)}" target="_blank" rel="noopener noreferrer">원본 카드 보기</a>`:'';
    if(target.snkrdunkStatus==='variant-linked'&&Array.isArray(target.snkrVariants)){
      const buttons=target.snkrVariants.filter(v=>/^\d+$/.test(String(v?.id))&&v.label).slice(0,4).map(v=>`<button class="btn" type="button" data-contained-market-id="${esc(v.id)}" data-contained-market-image="${esc(marketImage(v.product?.thumbnailUrl||v.product?.image))}" style="font-size:12px;padding:9px 12px;cursor:pointer">${esc(v.label)} 시세·거래내역</button>`).join('');
      return `<section class="ci-market-versions" aria-label="판본별 시세 선택" style="margin:18px auto 0;max-width:680px"><div style="display:flex;justify-content:center;flex-wrap:wrap;gap:8px;margin-bottom:12px">${buttons}</div>${sourceLink}</section>`;
    }
    if(!['ambiguous','artwork-pending','unlinked'].includes(target.snkrdunkStatus))return sourceLink;
    const products=[...new Map((Array.isArray(target.marketCandidates)?target.marketCandidates:[]).filter(product=>/^\d+$/.test(String(product?.id)))
      .map(product=>[String(product.id),{id:String(product.id),name:String(product.name||''),thumbnailUrl:marketImage(product.thumbnailUrl),productNumber:String(product.productNumber||'')}])).values()].slice(0,12);
    if(!products.length)return sourceLink;
    const cards=products.map(product=>{
      const first=/\b(?:1ED|1ST(?:\s+EDITION)?|FIRST\s+EDITION)\b/i.test(product.name);
      const label=first?'1ED':/\b(?:UNLIMITED|RESALE|REPRINT)\b/i.test(product.name)?'재판':'판본 표기 없음';
      const image=product.thumbnailUrl?`<img src="${esc(product.thumbnailUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="width:72px;height:100px;object-fit:contain;flex:none">`:'<span aria-hidden="true" style="display:block;width:72px;min-height:100px;flex:none;background:#f3f4f6"></span>';
      return `<li class="ci-market-candidate" style="display:flex;align-items:center;gap:12px;padding:12px;border:1px solid #e5e7eb;border-radius:12px;text-align:left;min-width:0">${image}<div style="min-width:0;flex:1"><span style="font-size:11px;color:#64748b">${esc(label)}</span><p style="font-size:12px;line-height:1.5;overflow-wrap:anywhere;margin:4px 0 10px">${esc(product.name)}</p><button class="btn" type="button" data-contained-market-id="${product.id}" data-contained-market-image="${esc(product.thumbnailUrl)}" style="font-size:12px;padding:7px 10px;cursor:pointer">상품 시세 보기</button></div></li>`;
    }).join('');
    return `<section class="ci-market-candidates" aria-label="판본 확인이 필요한 상품" style="margin:22px auto 0;max-width:680px"><h4 style="font-size:14px;margin:0 0 6px">판본 확인이 필요한 상품 ${products.length}개</h4><p style="font-size:12px;color:#64748b;margin:0 0 12px">상품 사진을 비교한 뒤 선택해주세요</p><ul style="list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:10px;padding:0;margin:0 0 14px">${cards}</ul>${sourceLink}</section>`;
  }
  return {render};
});
