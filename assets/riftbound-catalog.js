/* Riftbound English catalog. Shared Japanese set/card panels; separate source identities. */
(() => {
  'use strict';
  const VERSION='20260909-rb1', PAGE_SIZE=18;
  let data, ready, active, selected, page=1, query='', request=0, opener;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
  const validImage=url=>/^https:\/\/(?:cmsassets\.rgpub\.io\/sanity\/images|cdn\.sanity\.io\/images)\//.test(url||'');
  const image=(url,alt,cls='')=>validImage(url)?`<img class="${cls}" src="${esc(url)}" alt="${esc(alt)}" loading="lazy" onerror="this.hidden=true;this.parentElement.classList.add('rf-image-error')">`:'<span>이미지 없음</span>';
  const icon=n=>`<svg class="px-icon" viewBox="0 0 24 24" aria-hidden="true">${({expand:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',back:'<path d="m12 5-7 7 7 7M5 12h14"/>',share:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>'})[n]}</svg>`;
  function prepare(payload){
    if(payload.schemaVersion!==1||payload.brand!=='riftbound'||payload.language!=='en'||!Array.isArray(payload.sets))throw Error('Invalid catalog');
    const ids=new Set();
    for(const set of payload.sets){
      if(!/^RB-EN-[A-Z0-9]+$/.test(set.code)||!Array.isArray(set.cards))throw Error('Invalid set');
      for(const c of set.cards){
        if(ids.has(c.id)||c.setCode!==set.code||c.language!=='en'||c.brand!=='riftbound')throw Error('Invalid card identity');
        ids.add(c.id);
        const ko=Object.entries(payload.searchAliases||{}).filter(([,en])=>new RegExp('(^|[^a-z])'+en.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^a-z]|$)','i').test(c.name)).map(([name])=>name);
        c.searchText=normalize([c.name,c.number,c.rarity,...c.types,...c.domains,...ko].join(' '));
      }
    }
    if(ids.size!==payload.cardCount)throw Error('Incomplete catalog');
    return payload;
  }
  function load(){
    if(!ready)ready=fetch('/data/riftbound-catalog.json?v='+VERSION).then(r=>{if(!r.ok)throw Error();return r.json()}).then(prepare).then(value=>data=value).catch(e=>{ready=null;throw e});
    return ready;
  }
  function matching(cards,q){const words=String(q||'').trim().split(/\s+/).map(normalize).filter(Boolean);return cards.filter(c=>words.every(w=>c.searchText.includes(w)));}
  function pages(current,total){
    const first=Math.max(1,Math.min(current-2,total-4));
    const b=(n,label,text,disabled=false)=>`<button type="button" data-rf-page="${n}" aria-label="${label}" ${disabled?'disabled':''}>${text}</button>`;
    return b(1,'맨 처음 페이지','«',current===1)+b(current-1,'이전 페이지','‹',current===1)+Array.from({length:Math.min(5,total)},(_,i)=>first+i).map(n=>`<button type="button" data-rf-page="${n}" aria-label="${n}페이지" ${n===current?'aria-current="page"':''}>${n}</button>`).join('')+b(current+1,'다음 페이지','›',current===total)+b(total,'맨 마지막 페이지','»',current===total);
  }
  function languageBar(){
    let bar=document.getElementById('rfLanguages');
    if(!bar){bar=document.createElement('div');bar.id='rfLanguages';bar.className='enc-languages hub-secondary-tabs';bar.innerHTML='<button type="button" class="tab active" aria-pressed="true">영판</button>';document.getElementById('cardInfoList').before(bar);}
    bar.hidden=CI_TAB!=='riftbound';
    if(CI_TAB==='riftbound')document.getElementById('encLanguages').hidden=true;
  }
  async function render(){
    languageBar();const list=document.getElementById('cardInfoList');
    if(!data)list.innerHTML='<p role="status">리프트바운드 목록 불러오는 중…</p>';
    try{
      await load();if(CI_TAB!=='riftbound')return;
      const q=normalize(CI_QUERY),sets=data.sets.filter(s=>normalize(s.name+' '+s.code+' '+s.release).includes(q));
      list.innerHTML=sets.map(s=>`<button type="button" class="set-tile enc-set" data-rf-set="${esc(s.code)}" aria-label="${esc(s.name)} 수록 카드"><span class="set-tile-img">${image(s.image,s.name)}</span><span class="set-tile-body"><span class="set-tile-code">${esc(s.displayCode)}</span><span class="set-tile-name">${esc(s.name)}</span><span class="set-tile-meta">${s.release?'발매일: '+esc(s.release):'영문판 · 스타터 세트'}</span></span></button>`).join('')||'<p>검색 결과가 없습니다.</p>';
    }catch{if(CI_TAB==='riftbound')list.innerHTML='<p>목록을 불러오지 못했습니다. <button type="button" data-rf-retry>다시 시도</button></p>';}
  }
  function header(back=false){return `<div class="ci-panel-head">${back?`<button type="button" data-rf-back aria-label="수록 카드로 돌아가기">${icon('back')}</button>`:''}<button type="button" data-rf-expand aria-label="패널 전체화면 전환">${icon('expand')}</button><span class="enc-head-space"></span><button type="button" data-rf-share aria-label="리프트바운드 정보 공유">${icon('share')}</button><button type="button" data-rf-close aria-label="리프트바운드 정보 닫기">${icon('close')}</button></div>`;}
  function panel(html,title){
    const expanded=document.getElementById('anyModal')?.classList.contains('ci-expanded');openAnyModal(html,'wide');
    const modal=document.getElementById('anyModal');modal.classList.add('ci-panel');modal.classList.toggle('ci-expanded',!!expanded);modal._ciOpener=opener;
    const box=modal.querySelector('.modal-box');box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby',title);
    modal.querySelector('[data-rf-expand]').setAttribute('aria-pressed',String(!!expanded));modal.querySelector('button')?.focus({preventScroll:true});
  }
  function body(){
    if(!active||!document.getElementById('rfCardGrid'))return;
    const cards=matching(active.cards,query),total=Math.max(1,Math.ceil(cards.length/PAGE_SIZE));page=Math.max(1,Math.min(page,total));
    document.getElementById('rfCardGrid').innerHTML=cards.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE).map(c=>`<button type="button" class="set-card-item enc-card" data-rf-card="${esc(c.id)}" aria-label="${esc(c.name+' '+c.number)} 카드 정보"><span class="set-card-img rf-card-image">${image(c.image,c.name)}</span><span class="set-card-num"><strong>${esc(c.name)}</strong><span>${esc(c.number)}</span></span></button>`).join('')||'<p>검색 결과가 없습니다.</p>';
    document.getElementById('rfCardPages').innerHTML=pages(page,total);
    document.getElementById('rfCardCount').innerHTML=`총 ${active.cards.length} 카드 수록${query?' · 검색 '+cards.length+'장':''}<span>카드를 클릭하여 정보를 확인해보세요 · ${page} / ${total} 페이지</span>`;
  }
  function setPanel(){
    selected=null;
    panel(`${header()}<div class="ci-panel-info">${image(active.image,active.name,'ci-panel-thumb')}<div class="ci-panel-copy"><span class="ci-brand rf-brand">리프트바운드 · 영판</span><p>${esc(active.displayCode)}</p><h3 id="rfPanelTitle">${esc(active.name)}</h3><p>${active.release?'발매일: '+esc(active.release):'영문판 · 스타터 세트'}</p></div></div><div class="ci-panel-scroll enc-scroll"><div class="ci-panel-summary" id="rfCardCount"></div><label class="enc-search">카드 검색<input id="rfCardSearch" type="search" placeholder="한글·영문 이름 또는 번호" value="${esc(query)}"></label><div class="set-card-grid" id="rfCardGrid"></div></div><nav class="ci-panel-pages" id="rfCardPages" aria-label="수록 카드 페이지 이동"></nav>`,'rfPanelTitle');body();
  }
  function detail(id){
    const c=active?.cards.find(c=>c.id===id);if(!c)return;selected=c;
    const rows=[['언어','영문판'],['카드 번호',c.number],['희귀도',c.rarity],['카드 종류',c.types.join(' · ')],['도메인',c.domains.join(' · ')],['에너지',c.energy],['파워',c.power],['마이트',c.might],['태그',c.tags.join(' · ')],['일러스트',c.artists.join(', ')]];
    panel(`${header(true)}<div class="ci-panel-scroll enc-detail-scroll"><article class="px-detail enc-detail"><section class="px-summary" aria-label="카드 기본 정보"><div class="px-art rf-detail-art">${image(c.image,c.name)}</div><div class="px-summary-main"><div class="px-summary-top"><span class="px-badge">리프트바운드 · 영판</span></div><h1 class="px-title" id="rfCardTitle">${esc(c.name)}</h1><p class="px-pack">${esc(active.displayCode+' · '+active.name)}</p><p class="px-pack">${esc(c.number+' · '+c.rarity)}</p></div><div class="px-actions"><button type="button" class="px-btn primary" data-rf-back>수록 카드 보기</button></div></section><div class="px-content"><section class="px-price-box"><div class="px-current-label">PSA 10 기준</div><div class="px-current">—</div><p class="px-chart-note">가격 미수집</p></section><section><div class="px-section-head"><h2>카드 정보</h2></div><table class="px-table px-info"><tbody>${rows.filter(([,v])=>v!==null&&v!==undefined&&v!=='').map(([k,v])=>`<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></section>${c.ability?`<section><div class="px-section-head"><h2>카드 능력</h2></div><p class="rf-ability">${esc(c.ability)}</p></section>`:''}</div></article></div>`,'rfCardTitle');
  }
  async function open(code,cardId){
    const own=++request;opener=document.activeElement;
    panel(`${header()}<h3 class="enc-loading-title" id="rfPanelTitle">리프트바운드 · 영판</h3><div class="ci-panel-scroll">카드 불러오는 중…</div>`,'rfPanelTitle');
    try{
      await load();if(own!==request||!document.querySelector('#anyModal.open #rfPanelTitle'))return;
      active=data.sets.find(s=>s.code===code);if(!active)throw Error();page=1;query='';setPanel();if(cardId)detail(cardId);
    }catch{if(own===request&&document.querySelector('#anyModal.open #rfPanelTitle'))panel(`${header()}<h3 id="rfPanelTitle" class="enc-loading-title">카드를 불러오지 못했습니다.</h3><div class="ci-panel-scroll"><button type="button" data-rf-set="${esc(code)}">다시 시도</button></div>`,'rfPanelTitle');}
  }
  function href(set,id){const p=new URLSearchParams({set});if(id)p.set('card',id);return '/?'+p+'#cardinfo';}
  async function share(){if(!active)return;const url=new URL(href(active.code,selected?.id),location.origin).href;try{if(navigator.share)await navigator.share({title:selected?.name||active.name,url});else{await navigator.clipboard.writeText(url);showToast('링크를 복사했습니다');}}catch(e){if(e.name!=='AbortError')showToast('링크를 복사하지 못했습니다');}}
  const previousRender=renderCardInfo;
  renderCardInfo=function(){languageBar();if(CI_TAB==='riftbound')render();else previousRender();};
  document.addEventListener('input',e=>{if(e.target.id==='rfCardSearch'){query=e.target.value;page=1;body();}});
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-rf-set],[data-rf-card],[data-rf-page],[data-rf-back],[data-rf-close],[data-rf-expand],[data-rf-share],[data-rf-retry]');if(!b||b.disabled)return;
    e.preventDefault();e.stopPropagation();
    if(b.dataset.rfSet)open(b.dataset.rfSet);
    else if(b.dataset.rfCard)detail(b.dataset.rfCard);
    else if(b.dataset.rfPage){page=Number(b.dataset.rfPage);body();document.querySelector('#anyModal .ci-panel-scroll').scrollTop=0;}
    else if(b.hasAttribute('data-rf-back'))setPanel();
    else if(b.hasAttribute('data-rf-close')){request++;closeAnyModal();}
    else if(b.hasAttribute('data-rf-expand')){const on=document.getElementById('anyModal').classList.toggle('ci-expanded');b.setAttribute('aria-pressed',String(on));}
    else if(b.hasAttribute('data-rf-share'))share();
    else render();
  },true);
  languageBar();
  const params=new URLSearchParams(location.search),code=params.get('set');
  if(code?.startsWith('RB-EN-')&&location.hash==='#cardinfo'){
    CI_TAB='riftbound';document.querySelectorAll('#ciTabs .tab').forEach(b=>{b.classList.toggle('active',b.dataset.ci===CI_TAB);b.setAttribute('aria-pressed',String(b.dataset.ci===CI_TAB));});renderCardInfo();open(code,params.get('card'));
  }
  window.RiftboundCatalog={open,prepare,matching,href};
})();
