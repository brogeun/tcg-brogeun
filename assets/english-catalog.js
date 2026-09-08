/* English-only catalog; keep existing Japanese/One Piece routes and market logic. */
(() => {
  'use strict';
  let catalog=null, language='ja', page=1, active=null, cardPage=1, cardQuery='', request=0;
  const cache=new Map(), size=24, cardsPerPage=18;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=c=>Number.isSafeInteger(c)&&c>0?'$'+(c/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):null;
  const asset=p=>'/'+String(p||'').replace(/^\//,'');
  function art(card,detail=false){
    const s=card.sprite;
    const safe=/^images\/pokemon-en-sheets\/[A-Za-z0-9-]+\.webp$/.test(card.image||'');
    if(!safe||!s||![s.col,s.row,s.cols,s.rows].every(Number.isInteger)||s.col<0||s.row<0||s.col>=s.cols||s.row>=s.rows)return '<span class="enc-no-art">이미지 없음</span>';
    return `<span class="enc-art ${detail?'enc-art-detail':''}" role="img" aria-label="${esc(card.name)}"><img src="${esc(asset(card.image))}" alt="" loading="lazy" style="width:${s.cols*100}%;height:${s.rows*100}%;left:${-s.col*100}%;top:${-s.row*100}%" onerror="this.hidden=true;this.parentElement.setAttribute('aria-label','이미지 로딩 실패')"></span>`;
  }
  function pagination(current,pages,attr){return `<nav class="enc-pages" aria-label="페이지 이동"><button type="button" ${attr}="${current-1}" ${current<=1?'disabled':''}>이전</button><span>${current} / ${pages}</span><button type="button" ${attr}="${current+1}" ${current>=pages?'disabled':''}>다음</button></nav>`;}
  function ensureLanguages(){
    document.getElementById('ciLanguageTabs')?.remove();
    const list=document.getElementById('cardInfoList');if(!list)return;
    let bar=document.getElementById('encLanguages');
    if(!bar){bar=document.createElement('div');bar.id='encLanguages';bar.className='enc-languages';list.before(bar);}
    bar.hidden=CI_TAB!=='pokemon';
    bar.innerHTML=['ja','en'].map(l=>`<button type="button" data-enc-language="${l}" aria-pressed="${language===l}">${l==='en'?'영판':'일판'}</button>`).join('');
  }
  function render(){
    ensureLanguages();
    const list=document.getElementById('cardInfoList');if(!list)return;
    list.classList.add('enc-set-list');
    if(!catalog){list.innerHTML='<p role="status">영문판 목록 불러오는 중…</p>';return;}
    const q=String(CI_QUERY||'').trim().toLowerCase();
    const sets=catalog.sets.filter(s=>[s.name,s.code,s.displayCode,s.release].join(' ').toLowerCase().includes(q));
    const pages=Math.max(1,Math.ceil(sets.length/size));page=Math.min(page,pages);
    list.innerHTML=`<p class="enc-summary">영문판 ${sets.length}개 세트${q?'':` · 수록 ${catalog.cardCount.toLocaleString()}장`}</p>`+
      sets.slice((page-1)*size,page*size).map(s=>`<button type="button" class="set-tile enc-set" data-enc-set="${esc(s.code)}" aria-label="${esc(s.name)} 수록 카드"><span class="set-tile-img">${/^https:\/\/static\.tcgcollector\.com\//.test(s.image||'')?`<img src="${esc(s.image)}" alt="" loading="lazy" onerror="this.hidden=true">`:'<span>Pokémon</span>'}</span><span class="set-tile-body"><span class="set-tile-code">${esc(s.displayCode||s.code)}</span><span class="set-tile-name">${esc(s.name)}</span><span class="set-tile-meta">${esc(s.release||'발매일 미정')} · ${s.cardCount}장</span></span></button>`).join('')+
      (!sets.length?'<p>검색 결과가 없습니다.</p>':'')+pagination(page,pages,'data-enc-page');
  }
  function quote(card){const p=card.psa10;if(p?.language!=='en'||p.grade!=='PSA 10'||p.currency!=='USD')return 'PSA10 미수집';return money(p.sourcePriceCents)?`PSA10 ${p.status==='available'?'참고가':p.status==='unverified'?'참고가 · 확인 필요':'추정가'} ${money(p.sourcePriceCents)}`:p.status==='no-price'?'PSA10 가격 없음':'PSA10 미수집';}
  const supportedSale=url=>/^https:\/\/www\.ebay\.(?:com|co\.uk|ca|com\.au|de|es|fr|it)\/itm\/\d+$/.test(url||'');
  function setBody(){
    if(!active)return;
    const q=cardQuery.toLowerCase(),filtered=active.cards.filter(c=>(c.name+' '+c.number).toLowerCase().includes(q));
    const pages=Math.max(1,Math.ceil(filtered.length/cardsPerPage));cardPage=Math.min(cardPage,pages);
    document.getElementById('encCardGrid').innerHTML=filtered.slice((cardPage-1)*cardsPerPage,cardPage*cardsPerPage).map(c=>`<button type="button" class="enc-card" data-enc-card="${esc(c.sourceId)}" aria-label="${esc(c.name)} ${esc(c.number)} 카드 정보">${art(c)}<strong>${esc(c.name)}</strong><span>${esc(c.number)} · ${esc(c.rarity)}</span><small>${esc(quote(c))}</small></button>`).join('')||'<p>검색 결과가 없습니다.</p>';
    document.getElementById('encCardPages').innerHTML=pagination(cardPage,pages,'data-enc-card-page');
    document.getElementById('encCardCount').textContent=`총 ${active.cardCount}장 · 검색 ${filtered.length}장`;
  }
  function setModal(){
    openAnyModal(`<div class="modal-head"><h3>${esc(active.name)} · 영판</h3><button type="button" class="modal-close" aria-label="닫기" onclick="closeAnyModal()">✕</button></div><div class="modal-body enc-body"><div class="enc-set-tools"><span id="encCardCount"></span><button type="button" class="btn" data-enc-share>세트 공유</button></div><label class="enc-search">카드 검색<input id="encCardSearch" type="search" placeholder="카드명 또는 번호" value="${esc(cardQuery)}"></label><div class="enc-grid" id="encCardGrid"></div><div id="encCardPages"></div></div>`,'wide');
    setBody();
  }
  async function open(code,keep=false){
    const token=++request;
    try{
      await ready;
      const set=catalog.sets.find(s=>s.code===code);if(!set)return;
      openAnyModal('<div class="modal-head"><h3>영문판 카드</h3><button class="modal-close" onclick="closeAnyModal()">✕</button></div><div class="modal-body">카드 불러오는 중…</div>','wide');
      let data=cache.get(code);
      if(!data){const r=await fetch(`/data/english-sets/${encodeURIComponent(code)}.json?v=20260908-en2`);if(!r.ok)throw Error();data=await r.json();if(data.language!=='en'||data.code!==code||data.cards?.length!==set.cardCount)throw Error();cache.set(code,data);if(cache.size>8)cache.delete(cache.keys().next().value);}
      if(token!==request)return;
      active=data;if(!keep){cardPage=1;cardQuery='';}setModal();
    }catch{if(token===request)openAnyModal('<div class="modal-head"><h3>영문판 카드</h3><button class="modal-close" onclick="closeAnyModal()">✕</button></div><div class="modal-body">카드를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>');}
  }
  function detail(id){
    const c=active?.cards.find(c=>c.sourceId===id);if(!c)return;
    const p=c.psa10,valid=p?.language==='en'&&p.grade==='PSA 10'&&p.currency==='USD';
    const sales=valid?(p.sales||[]).filter(s=>Number.isSafeInteger(s.priceCents)&&s.priceCents>0&&supportedSale(s.url)):[];
    const source=valid&&/^https:\/\/www\.pricecharting\.com\/game\/pokemon-[a-z0-9-]+\/[a-z0-9%'()-]+$/.test(p.sourceUrl||'')?p.sourceUrl:'';
    openAnyModal(`<div class="modal-head"><h3>카드 정보 · 영판</h3><button type="button" class="modal-close" aria-label="닫기" onclick="closeAnyModal()">✕</button></div><div class="modal-body enc-body enc-detail"><button class="btn" type="button" data-enc-back>← ${esc(active.name)} 수록 카드</button>${art(c,true)}<h3>${esc(c.name)}</h3><p>${esc(active.name)} · ${esc(c.number)} · ${esc(c.rarity)}</p><section class="enc-price"><strong>${esc(quote(c))}</strong>${valid?`<p>${sales.length?'PriceCharting 참고가입니다. 아래 판매 기록은 일부 공개된 내역입니다.':'PSA10 추정가 또는 참고가이며, 확인된 판매 기록이 없을 수 있습니다.'}</p><small>자료 확인: ${esc(p.fetchedAt?.slice(0,10)||'확인일 없음')} · USD</small>`:'<p>PSA10 가격과 거래 내역을 아직 수집하지 않았습니다.</p>'}${sales.length?`<details><summary>확인된 판매 기록 ${sales.length}건</summary>${sales.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.date)} <strong>${money(s.priceCents)}</strong> ↗</a>`).join('')}<p>확인된 기록 수이며 전체 시장 거래량은 아닙니다.</p></details>`:''}${source?`<a class="btn" href="${esc(source)}" target="_blank" rel="noopener noreferrer">PriceCharting PSA10 원문 ↗</a>`:''}</section></div>`);
  }
  const originalRender=renderCardInfo, originalOpen=window.openSetGrid;
  renderCardInfo=function(){document.getElementById('cardInfoList')?.classList.remove('enc-set-list');if(language==='en'&&CI_TAB==='pokemon')render();else{originalRender();ensureLanguages();}};
  window.openSetGrid=function(code,...args){if(code.startsWith('EN-'))return open(code);return originalOpen(code,...args);};
  const ready=fetch('/data/english-catalog.json?v=20260908-en2').then(r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{if(data.schemaVersion!==1||!Array.isArray(data.sets))throw Error();catalog=data;return data;});
  document.addEventListener('input',e=>{if(e.target.id==='encCardSearch'){cardQuery=e.target.value;cardPage=1;setBody();}});
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-enc-language],[data-enc-set],[data-enc-page],[data-enc-card-page],[data-enc-card],[data-enc-back],[data-enc-share]');if(!b)return;
    e.preventDefault();e.stopPropagation();
    if(b.dataset.encLanguage){language=b.dataset.encLanguage;page=1;renderCardInfo();}
    else if(b.dataset.encSet)open(b.dataset.encSet);
    else if(b.dataset.encPage){page=Number(b.dataset.encPage);render();document.getElementById('encLanguages').scrollIntoView({block:'start'});}
    else if(b.dataset.encCardPage){cardPage=Number(b.dataset.encCardPage);setBody();document.querySelector('.enc-body').scrollTop=0;}
    else if(b.dataset.encCard)detail(b.dataset.encCard);
    else if(b.hasAttribute('data-enc-back'))setModal();
    else if(b.hasAttribute('data-enc-share')){const url=new URL(location.href);url.search='';url.searchParams.set('set',active.code);url.hash='cardinfo';navigator.clipboard.writeText(url.href).then(()=>showToast('세트 링크를 복사했습니다')).catch(()=>showToast('링크를 복사하지 못했습니다'));}
  },true);
  ensureLanguages();
  ready.then(()=>{renderCardInfo();const code=new URLSearchParams(location.search).get('set');if(code?.startsWith('EN-')&&location.hash==='#cardinfo'){language='en';CI_TAB='pokemon';renderCardInfo();open(code);}}).catch(()=>{if(language==='en')document.getElementById('cardInfoList').innerHTML='<p>영문판 목록을 불러오지 못했습니다. 새로고침해 주세요.</p>';});
  window.EnglishCatalog={art,quote,open};
})();
