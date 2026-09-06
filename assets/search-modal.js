/* Global search dialog: existing search data, ID-based names and product classification. */
(() => {
  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';
  const closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  let modal, input, list, count, opener, timer, version=0, category='all', visible=30, composing=false, ready;
  const normalized=new Map();
  let pokemonNames=[];
  function cardTitle(c) {
    let title=c.name.replace(/\s*\((?:Enhanced|High Class|Booster|Expansion|Promotional|Starter)\b.*$/i,'').trim();
    if(c.brand==='pokemon') {
      const match=pokemonNames.find(n=>title.toLowerCase().startsWith(n.en.toLowerCase()) && !/[a-z]/i.test(title.charAt(n.en.length)));
      if(match) title=match.ko+title.slice(match.en.length);
    }
    return title;
  }
  function ensureData() {
    if (ready) return ready;
    ready=(async()=>{
      await loadCardSearchData();
      if (!_ALL_CARDS_INDEX?.length) throw new Error('검색 데이터를 불러오지 못했어요.');
      try {
        const response=await fetch('/data/pokemon-names-pokeapi.json');
        if(response.ok) pokemonNames=(await response.json()).filter(n=>n.en&&n.ko).sort((a,b)=>b.en.length-a.en.length);
      } catch { /* Keep original names when the existing Korean dictionary is unavailable. */ }
      const boxes=_ALL_CARDS_INDEX.filter(c=>c.kind==='box').map(c=>({...c}));
      await enrichPriceProductMetadata(boxes,'box');
      // Current price feed precedes manual fallback; keep its price for duplicate IDs.
      const boxMap=new Map();
      boxes.forEach(c=>{if(!boxMap.has(c.id))boxMap.set(c.id,c)});
      for(const raw of _ALL_CARDS_INDEX){
        const c=boxMap.get(raw.id)||raw;
        const kind=c.kind==='box' ? (isPriceBoxProduct(c)?'box':'card') : 'card';
        const sets=CARDINFO[c.brand]||[];
        const code=(c.code||c.productNumber||'').toUpperCase();
        const set=sets.find(s=>(kind==='box' && String(s.boxId)===c.id) || (code && (code===s.code.toUpperCase() || code.startsWith(s.code.toUpperCase()+'-') || code.startsWith('PKMN-TCG-'+s.code.toUpperCase()+'-'))));
        const name=kind==='box' ? (getBoxKoreanName(c,c.brand)||c._koName||c.name) : cardTitle(c);
        normalized.set(c.id,{...c,kind,displayName:name,setName:set?.name || c.productNumber?.toUpperCase() || (c.brand==='onepiece'?'원피스':'포켓몬')});
      }
    })().catch(error=>{ready=null;if(!_ALL_CARDS_INDEX?.length)_ALL_CARDS_INDEX=null;throw error});
    return ready;
  }
  function build() {
    modal=document.createElement('div');modal.id='searchDialog';modal.hidden=true;
    modal.innerHTML='<section class="gs-panel" role="dialog" aria-modal="true" aria-label="카드 및 박스 검색"><div class="gs-header"><div class="gs-field"><input id="gsInput" autocomplete="off" enterkeyhint="search" aria-label="카드 및 박스 이름 검색" placeholder="카드 및 박스 이름을 검색해주세요"><button class="gs-icon" id="gsRun" aria-label="검색 실행">'+icon+'</button></div><button class="gs-icon" id="gsClose" aria-label="검색 닫기">'+closeIcon+'</button></div><div class="gs-filters" role="group" aria-label="검색 종류"><button class="gs-filter" data-kind="all" aria-pressed="true">전체</button><button class="gs-filter" data-kind="card" aria-pressed="false">카드</button><button class="gs-filter" data-kind="box" aria-pressed="false">박스</button></div><div class="gs-results" id="gsResults"></div><div class="gs-count" id="gsCount" role="status" aria-live="polite"></div></section>';
    document.body.append(modal);input=modal.querySelector('input');list=modal.querySelector('.gs-results');count=modal.querySelector('.gs-count');
    modal.querySelector('#gsClose').onclick=close;
    modal.querySelector('#gsRun').onclick=()=>{clearTimeout(timer);visible=30;render()};
    modal.onclick=e=>{if(e.target===modal)close()};
    modal.querySelectorAll('.gs-filter').forEach(btn=>btn.onclick=()=>{
      category=btn.dataset.kind;visible=30;
      modal.querySelectorAll('.gs-filter').forEach(b=>b.setAttribute('aria-pressed',String(b===btn)));
      render();
    });
    input.addEventListener('compositionstart',()=>{composing=true;clearTimeout(timer);version++});
    input.addEventListener('compositionend',()=>{composing=false;schedule()});
    input.addEventListener('input',()=>{if(!composing)schedule()});
    input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.isComposing&&!composing){e.preventDefault();clearTimeout(timer);visible=30;render()}});
    modal.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&!e.isComposing&&!composing){e.stopPropagation();close();return}
      if(e.key==='Tab'){
        const focusable=[...modal.querySelectorAll('button,input,a')].filter(e=>!e.disabled&&e.getClientRects().length);
        const first=focusable[0],last=focusable[focusable.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
      }
    });
    list.addEventListener('click',e=>{
      if(e.target.closest('#gsMore')){visible+=30;render(true);return}
      if(e.target.closest('.gs-row'))close();
    });
  }
  function schedule(){version++;clearTimeout(timer);visible=30;if(!input.value.trim()){list.replaceChildren();count.textContent='';return}timer=setTimeout(render,180)}
  async function render(keepScroll=false){
    const own=++version,q=input.value.trim();
    if(!q){list.replaceChildren();count.textContent='';return}
    if(!keepScroll){list.replaceChildren();list.scrollTop=0;}
    count.textContent='검색 중...';
    try{
      await ensureData();
      if(own!==version||modal.hidden)return;
      const unique=new Map();
      searchCards(q,Infinity).forEach(raw=>{const c=normalized.get(raw.id);if(c&&(category==='all'||c.kind===category))unique.set(c.id,c)});
      // ID-based Korean box names also remain searchable after metadata enrichment.
      normalized.forEach(c=>{if(c.displayName.toLowerCase().includes(q.toLowerCase())&&(category==='all'||c.kind===category))unique.set(c.id,c)});
      const results=[...unique.values()];
      count.textContent=results.length ? results.length+'개 결과 · '+Math.min(visible,results.length)+'개 표시' : '';
      list.innerHTML=results.length ? results.slice(0,visible).map(c=>{
        const safe=escapeHtml;
        const image=/^(https?:\/\/|\/)/.test(c.thumbnailUrl||'') ? '<img class="gs-thumb" loading="lazy" referrerpolicy="no-referrer" src="'+safe(c.thumbnailUrl)+'" alt="">' : '<span class="gs-thumb"></span>';
        const price=Number(c.minPrice)>0 ? fmtKrw(Number(c.minPrice),c.currency) : '시세 없음';
        return '<a class="gs-row" data-id="'+safe(c.id)+'" data-kind="'+c.kind+'" href="#price/'+encodeURIComponent(c.id)+'">'+image+'<div style="min-width:0"><div class="gs-name" title="'+safe(c.displayName+' / '+c.name)+'">'+safe(c.displayName)+'</div><div class="gs-meta" title="'+safe(c.setName)+'">'+(c.kind==='box'?'박스':'카드')+' · '+safe(c.setName)+'</div></div><span class="gs-price" title="'+safe(fmtOrig(c.minPrice,c.currency))+'">'+price+'</span></a>';
      }).join('')+(results.length>visible?'<button id="gsMore" class="gs-filter" style="margin:16px 0;width:100%">검색 결과 더 보기</button>':'') : '<div class="gs-state">“'+escapeHtml(q)+'” 검색 결과가 없습니다.<br>이름이나 세트코드, 상품 ID를 확인해주세요.</div>';
    }catch(error){if(own!==version||modal.hidden)return;list.innerHTML='<div class="gs-state">검색 데이터를 불러오지 못했어요.<br>검색 버튼을 눌러 다시 시도해주세요.</div>';count.textContent=''}
  }
  function open(query=''){
    if(!modal)build();
    opener=document.activeElement?.id==='globalSearch' ? document.getElementById('mobileSearchToggle') : document.activeElement;
    composing=false;clearTimeout(timer);category='all';visible=30;
    modal.querySelectorAll('.gs-filter').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind==='all')));
    if(modal.hidden){modal._previousOverflow=document.body.style.overflow;modal._previousHtmlOverflow=document.documentElement.style.overflow}
    modal.hidden=false;document.body.style.overflow='hidden';document.documentElement.style.overflow='hidden';
    input.value=query;list.replaceChildren();count.textContent='';render();
    if(innerWidth>768)input.focus({preventScroll:true});else modal.querySelector('#gsClose').focus({preventScroll:true});
  }
  function close(){
    if(!modal||modal.hidden)return;
    version++;clearTimeout(timer);modal.hidden=true;document.body.style.overflow=modal._previousOverflow||'';document.documentElement.style.overflow=modal._previousHtmlOverflow||'';opener?.focus?.({preventScroll:true});
  }
  window.openGlobalSearch=open;
  window.closeGlobalSearch=close;
  // Header entry points share one dialog across all app pages.
  document.getElementById('mobileSearchToggle')?.addEventListener('click',()=>open());
  document.getElementById('globalSearch')?.addEventListener('focus',()=>open());
  window.addEventListener('hashchange',close);

})();
