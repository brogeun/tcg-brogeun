/* Global search dialog: existing search data, ID-based names and product classification. */
(() => {
  const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>';
  const closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  let modal, input, list, count, opener, timer, version=0, category='all', language='ja', visible=30, composing=false, ready;
  const normalized=new Map();
  const placeholder=()=>(language==='zh-CN'?'중판':language==='en'?'영판':'일판')+' 카드 및 박스 이름 검색';
  function cardTitle(c) {
    if(c.brand==='pokemon' && window.JapaneseCardNames) return JapaneseCardNames.title(c);
    if(c.brand==='onepiece' && c.cardType==='DON' && c.nameKo)return c.nameKo;
    let title=c.name.replace(/\s*\((?:Enhanced|High Class|Booster|Expansion|Promotional|Starter)\b.*$/i,'').trim();
    return title;
  }
  function ensureData() {
    if (ready && !window.PromoSearch?.needsRetry()) return ready;
    ready=(async()=>{
      await loadCardSearchData();
      if (!_ALL_CARDS_INDEX?.length) throw new Error('검색 데이터를 불러오지 못했어요.');
      await window.JapaneseCardNames?.ensureData();
      const searchRows=window.JapaneseCatalog?.getSearchRows() || _ALL_CARDS_INDEX;
      const boxes=searchRows.filter(c=>c.kind==='box'&&!c._catalogue).map(c=>({...c}));
      await enrichPriceProductMetadata(boxes,'box');
      // Current price feed precedes manual fallback; keep its price for duplicate IDs.
      const boxMap=new Map();
      boxes.forEach(c=>{if(!boxMap.has(c.id))boxMap.set(c.id,c)});
      normalized.clear();
      for(const raw of searchRows){
        const c=boxMap.get(raw.id)||raw;
        if(window.JapaneseCardNames ? JapaneseCardNames.language(c)!=='ja' : ['en','zh','zh-cn','zh-tw','cn'].includes(String(c.language||'').toLowerCase())||[c.setCode,c.code,c.id].some(value=>/^(?:EN|CN)-/i.test(String(value||''))))continue;
        const kind=c.kind==='box' ? (c._catalogue || isPriceBoxProduct(c)?'box':'card') : 'card';
        const sets=CARDINFO[c.brand]||[];
        const code=(c.code||c.productNumber||'').toUpperCase();
        const set=sets.find(s=>(kind==='box' && String(s.boxId)===c.id) || (code && (code===s.code.toUpperCase() || code.startsWith(s.code.toUpperCase()+'-') || code.startsWith('PKMN-TCG-'+s.code.toUpperCase()+'-'))));
        const name=kind==='box' ? (getBoxKoreanName(c,c.brand)||c._koName||c.name) : cardTitle(c);
        normalized.set(c.id,{...c,kind,displayName:name,setName:c.setName || set?.name || c.productNumber?.toUpperCase() || (c.brand==='onepiece'?'원피스':'포켓몬')});
      }
    })().catch(error=>{ready=null;if(!_ALL_CARDS_INDEX?.length)_ALL_CARDS_INDEX=null;throw error});
    return ready;
  }
  function build() {
    modal=document.createElement('div');modal.id='searchDialog';modal.hidden=true;
    modal.innerHTML='<section class="gs-panel" role="dialog" aria-modal="true" aria-label="카드 및 박스 검색"><div class="gs-header"><div class="gs-field"><input id="gsInput" autocomplete="off" enterkeyhint="search" aria-label="카드 및 박스 이름 검색" placeholder="카드 및 박스 이름을 검색해주세요"><button class="gs-icon" id="gsRun" aria-label="검색 실행">'+icon+'</button></div><button class="gs-icon" id="gsClose" aria-label="검색 닫기">'+closeIcon+'</button></div><div class="gs-filters" role="group" aria-label="검색 종류"><button class="gs-filter" data-kind="all" aria-pressed="true">전체</button><button class="gs-filter" data-kind="card" aria-pressed="false">카드</button><button class="gs-filter" data-kind="box" aria-pressed="false">박스</button></div><div class="gs-results" id="gsResults"></div><div class="gs-count" id="gsCount" role="status" aria-live="polite"></div></section>';
    document.body.append(modal);input=modal.querySelector('input');list=modal.querySelector('.gs-results');count=modal.querySelector('.gs-count');
    list.addEventListener('error',event=>{
      const img=event.target;
      if(img.tagName!=='IMG'||!img.classList.contains('gs-thumb'))return;
      const fallback=document.createElement('span');fallback.className='gs-thumb gs-image-missing';
      fallback.textContent='이미지 준비 중';img.replaceWith(fallback);
    },true);
    const languages=document.createElement('div');languages.className='gs-languages';languages.setAttribute('role','group');languages.setAttribute('aria-label','검색 언어');
    languages.innerHTML='<button class="gs-language" data-language="ja" aria-pressed="true">일판</button><button class="gs-language" data-language="en" aria-pressed="false">영판</button><button class="gs-language" data-language="zh-CN" aria-pressed="false">중판</button>';
    modal.querySelector('.gs-filters').before(languages);
    languages.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{
      language=btn.dataset.language;visible=30;clearTimeout(timer);
      languages.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===btn)));
      input.placeholder=placeholder();
      render();
    });
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
  // Transparent CDN margins must not determine the mobile card's visible size.
  const searchArtwork=new Map(), artworkWaiters=[];
  let artworkActive=0;
  function measureSearchArtwork(src) {
    if(searchArtwork.has(src))return searchArtwork.get(src);
    const pending=(async()=>{
      if(artworkActive>=3)await new Promise(resolve=>artworkWaiters.push(resolve));
      else artworkActive++;
      try {
        const needed=innerWidth<=768&&!modal?.hidden&&list&&[...list.querySelectorAll('.gs-row[data-kind="card"]>img.gs-thumb')].some(img=>(img.currentSrc||img.src)===src);
        if(!needed){searchArtwork.delete(src);return null;}
        const probe=new Image();
        await new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>{probe.src='';reject(new Error('Artwork timeout'));},10000);
          probe.onload=()=>{clearTimeout(timeout);resolve()};
          probe.onerror=()=>{clearTimeout(timeout);reject(new Error('Artwork unavailable'))};
          probe.src='/api/img?u='+encodeURIComponent(src);
        });
        const factor=Math.min(1,512/Math.max(probe.naturalWidth,probe.naturalHeight));
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(1,Math.round(probe.naturalWidth*factor));
        canvas.height=Math.max(1,Math.round(probe.naturalHeight*factor));
        const context=canvas.getContext('2d',{willReadFrequently:true});
        if(!context)return null;
        context.drawImage(probe,0,0,canvas.width,canvas.height);
        const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
        let left=canvas.width,top=canvas.height,right=0,bottom=0;
        for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]>0){
          left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);
        }
        if(right<=left||bottom<=top||left===0&&top===0&&right===canvas.width&&bottom===canvas.height)return null;
        // Include edge pixels when the measurement canvas was downscaled.
        left=Math.max(0,left-1);top=Math.max(0,top-1);right=Math.min(canvas.width,right+1);bottom=Math.min(canvas.height,bottom+1);
        return {width:probe.naturalWidth,height:probe.naturalHeight,bounds:[left*probe.naturalWidth/canvas.width,top*probe.naturalHeight/canvas.height,right*probe.naturalWidth/canvas.width,bottom*probe.naturalHeight/canvas.height]};
      } catch { return null; }
      finally {const next=artworkWaiters.shift();if(next)next();else artworkActive--;}
    })();
    searchArtwork.set(src,pending);
    if(searchArtwork.size>180)searchArtwork.delete(searchArtwork.keys().next().value);
    return pending;
  }
  async function fitSearchArtwork(img) {
    if(innerWidth>768||modal?.hidden||!img.complete||!img.naturalWidth||!img.isConnected)return;
    const src=img.currentSrc||img.src,row=img.closest('.gs-row');
    if(row?.dataset.kind!=='card'||!/^https:\/\/cdn\.snkrdunk\.com\/upload_bg_removed\//.test(src)||img.parentElement.classList.contains('gs-card-art'))return;
    const art=await measureSearchArtwork(src);
    if(!art||!img.isConnected||modal.hidden||innerWidth>768||(img.currentSrc||img.src)!==src||img.parentElement.classList.contains('gs-card-art'))return;
    const [left,top,right,bottom]=art.bounds,w=right-left,h=bottom-top;
    const scale=Math.min(96*.98/w,134*.98/h),host=document.createElement('span');
    host.className='gs-thumb gs-card-art'+(img.classList.contains('gs-card-thumb')?' gs-card-thumb':'');
    for(const [key,value] of Object.entries({width:art.width*scale,height:art.height*scale,left:(96-w*scale)/2-left*scale,top:(134-h*scale)/2-top*scale}))host.style.setProperty('--gs-art-'+key,value+'px');
    img.replaceWith(host);host.append(img);img.classList.remove('gs-thumb','gs-card-thumb');
  }
  function watchSearchArtwork() {
    if(!list||modal.hidden||typeof innerWidth!=='number'||innerWidth>768)return;
    list.querySelectorAll('.gs-row[data-kind="card"]>img.gs-thumb').forEach(img=>{
      img.addEventListener('load',()=>fitSearchArtwork(img),{once:true});
      if(img.complete)fitSearchArtwork(img);
    });
  }
  window.addEventListener('resize',watchSearchArtwork);

  async function render(keepScroll=false){
    const own=++version,q=input.value.trim();
    if(!q){list.replaceChildren();count.textContent='';return}
    if(!keepScroll){list.replaceChildren();list.scrollTop=0;}
    count.textContent='검색 중...';
    try{
      const chinese=language==='zh-CN' ? await ChineseCatalog.search(q,category) : null;
      const english=language==='en' ? await EnglishSearch.ensureData() : (language==='ja' ? (await ensureData(),null) : null);
      if(own!==version||modal.hidden)return;
      const unique=new Map();
      if(chinese) chinese.forEach(c=>{if(category==='all'||c.kind===category)unique.set(c.setCode+':'+c.kind+':'+c.id,c)});
      else if(english) EnglishSearch.search(english,q,category).forEach(c=>unique.set(c.id,c));
      else {
      searchCards(q,Infinity).forEach(raw=>{const c=normalized.get(raw.id);if(c&&(category==='all'||c.kind===category))unique.set(c.id,c)});
      // ID-based Korean box names also remain searchable after metadata enrichment.
      normalized.forEach(c=>{if(c.displayName.toLowerCase().includes(q.toLowerCase())&&(category==='all'||c.kind===category))unique.set(c.id,c)});
      }
      const plan=language==='ja' ? window.JapaneseCatalog?.prepareQuery?.(q) : null;
      const matched=plan?.type ? [...unique.values()].filter(c=>JapaneseCatalog.acceptsQuery(c,plan)) : [...unique.values()];
      const results=(language==='ja'&&window.PromoSearch ? PromoSearch.filterCodeQuery(matched,q) : matched);
      count.textContent=results.length ? results.length+'개 결과 · '+Math.min(visible,results.length)+'개 표시' : '';
      list.innerHTML=results.length ? results.slice(0,visible).map(c=>{
        const safe=escapeHtml;
        if(c.language==='en') {
          const image=c.kind==='card' ? '<span class="gs-thumb gs-en-art">'+EnglishCatalog.art(c)+'</span>' : (/^https:\/\//.test(c.thumbnailUrl||'') ? '<img class="gs-thumb" loading="lazy" src="'+safe(c.thumbnailUrl)+'" alt="">' : '<span class="gs-thumb"></span>');
          return '<a class="gs-row" data-id="'+safe(c.id)+'" data-language="en" data-kind="'+c.kind+'" href="'+safe(EnglishSearch.href(c))+'">'+image+'<div style="min-width:0"><div class="gs-name" title="'+safe(c.displayName+' / '+c.name)+'">'+safe(c.name)+'</div><div class="gs-meta">영판 · '+(c.kind==='box'?'박스 · 수록 목록':safe(c.number))+' · '+safe(c.setName)+'</div></div><span class="gs-price">'+(c.kind==='box'?'수록 카드':'상세 보기')+'</span></a>';
        }
        if(c.language==='zh-CN') {
          const thumbnail=String(c.thumbnailUrl||'').replace(/^images\//,'/images/');
          const image=ChineseCatalog.isImage(c.thumbnailUrl) ? '<img class="gs-thumb" loading="lazy" referrerpolicy="no-referrer" src="'+safe(thumbnail)+'" alt="">' : '<span class="gs-thumb"></span>';
          return '<a class="gs-row" data-id="'+safe(c.setCode+':'+c.id)+'" data-language="zh-CN" data-kind="'+safe(c.kind)+'" href="'+safe(ChineseCatalog.href(c))+'">'+image+'<div style="min-width:0"><div class="gs-name" title="'+safe((c.displayName||c.nameKo||c.name)+' / '+(c.originalName||c.name))+'">'+safe(c.displayName||c.nameKo||c.name)+'</div><div class="gs-meta">중판 · '+(c.kind==='card'?'카드 · '+safe(c.number)+(c.variantLabel||c.variant?' · '+safe(c.variantLabel||c.variant):''):'박스 · 수록 목록')+' · '+safe(c.setName)+'</div></div><span class="gs-price">'+safe(c.priceLabel||'가격 미확보')+'</span></a>';
        }
        const image=/^(https?:\/\/|\/)/.test(c.thumbnailUrl||'') ? '<img class="gs-thumb" loading="lazy" referrerpolicy="no-referrer" src="'+safe(c.thumbnailUrl)+'" alt="">' : '<span class="gs-thumb"></span>';
        const price=Number(c.minPrice)>0 ? fmtKrw(Number(c.minPrice),c.currency) : '시세 없음';
        const href=window.JapaneseCatalog ? JapaneseCatalog.href(c) : '#price/'+encodeURIComponent(c.id);
        const label=c._catalogue && !c.productId ? (c.kind==='box'?'수록 목록':'카드 정보') : price;
        return '<a class="gs-row" data-id="'+safe(c.id)+'" data-kind="'+c.kind+'" href="'+safe(href)+'">'+image+'<div style="min-width:0"><div class="gs-name" title="'+safe(c.displayName+' / '+c.name)+'">'+safe(c.displayName)+'</div><div class="gs-meta" title="'+safe(c.setName)+'">'+(c.kind==='box'?'박스':'카드')+' · '+safe(c.setName)+(c._catalogue&&c.number?' · '+safe(c.number):'')+'</div></div><span class="gs-price" title="'+safe(fmtOrig(c.minPrice,c.currency))+'">'+label+'</span></a>';
      }).join('')+(results.length>visible?'<button id="gsMore" class="gs-filter" style="margin:16px 0;width:100%">검색 결과 더 보기</button>':'') : '<div class="gs-state">“'+escapeHtml(q)+'” 검색 결과가 없습니다.<br>이름이나 세트코드, 상품 ID를 확인해주세요.</div>';
      watchSearchArtwork();
    }catch(error){if(own!==version||modal.hidden)return;list.innerHTML='<div class="gs-state">검색 데이터를 불러오지 못했어요.<br>검색 버튼을 눌러 다시 시도해주세요.</div>';count.textContent=''}
  }
  function open(query=''){
    if(!modal)build();
    opener=document.activeElement?.id==='globalSearch' ? document.getElementById('mobileSearchToggle') : document.activeElement;
    composing=false;clearTimeout(timer);category='all';visible=30;
    modal.querySelectorAll('.gs-filter[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind==='all')));
    input.placeholder=placeholder();
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
