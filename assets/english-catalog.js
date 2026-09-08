/* English data uses the Japanese catalog panel and price-detail styles. */
(() => {
  'use strict';
  const VERSION='20260908-en4',cache=new Map(),size=24,cardsPerPage=18;
  let catalog=null,names={},language='ja',page=1,active=null,currentCard=null,cardPage=1,cardQuery='',request=0,opener=null;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money=c=>Number.isSafeInteger(c)&&c>0?'$'+(c/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):null;
  const name=c=>names[c.name]||c.name;
  const searchText=s=>String(s||'').toLocaleLowerCase().replace(/\s/g,'');
  const validPrice=p=>p?.language==='en'&&p.grade==='PSA 10'&&p.currency==='USD';
  const supportedSale=url=>/^https:\/\/www\.ebay\.(?:com|co\.uk|ca|com\.au|de|es|fr|it)\/itm\/\d+$/.test(url||'');
  const sourceURL=p=>validPrice(p)&&/^https:\/\/www\.pricecharting\.com\/game\/pokemon-[a-z0-9-]+\/[a-z0-9%'()-]+$/.test(p.sourceUrl||'')?p.sourceUrl:'';
  const icon=n=>`<svg class="px-icon" viewBox="0 0 24 24" aria-hidden="true">${({expand:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',back:'<path d="m12 5-7 7 7 7M5 12h14"/>',share:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',external:'<path d="M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'})[n]||''}</svg>`;
  function art(card,detail=false){
    const s=card.sprite;
    if(!/^images\/pokemon-en-sheets\/[A-Za-z0-9-]+\.webp$/.test(card.image||'')||!s||![s.col,s.row,s.cols,s.rows].every(Number.isInteger)||s.col<0||s.row<0||s.col>=s.cols||s.row>=s.rows)return '<span class="enc-no-art">이미지 없음</span>';
    return `<span class="enc-art ${detail?'enc-art-detail':''}" role="img" aria-label="${esc(name(card))}"><img src="/${esc(card.image)}" alt="" loading="lazy" style="width:${s.cols*100}%;height:${s.rows*100}%;left:${-s.col*100}%;top:${-s.row*100}%" onerror="this.hidden=true;this.parentElement.setAttribute('aria-label','이미지 로딩 실패')"></span>`;
  }
  function pages(current,total,attr){
    const first=Math.max(1,Math.min(current-2,total-4));
    return `<button type="button" ${attr}="1" aria-label="맨 처음 페이지" ${current<=1?'disabled':''}>«</button><button type="button" ${attr}="${current-1}" aria-label="이전 페이지" ${current<=1?'disabled':''}>‹</button>`+Array.from({length:Math.min(5,total)},(_,i)=>first+i).map(n=>`<button type="button" ${attr}="${n}" aria-label="${n}페이지" ${current===n?'aria-current="page"':''}>${n}</button>`).join('')+`<button type="button" ${attr}="${current+1}" aria-label="다음 페이지" ${current>=total?'disabled':''}>›</button><button type="button" ${attr}="${total}" aria-label="맨 마지막 페이지" ${current>=total?'disabled':''}>»</button>`;
  }
  function ensureLanguages(){
    document.getElementById('ciLanguageTabs')?.remove();const list=document.getElementById('cardInfoList');if(!list)return;
    let bar=document.getElementById('encLanguages');if(!bar){bar=document.createElement('div');bar.id='encLanguages';bar.className='enc-languages hub-secondary-tabs';list.before(bar);}
    bar.hidden=CI_TAB!=='pokemon';bar.innerHTML=['ja','en'].map(l=>`<button class="tab ${language===l?'active':''}" type="button" data-enc-language="${l}" aria-pressed="${language===l}">${l==='en'?'영판':'일판'}</button>`).join('');
  }
  function render(){
    ensureLanguages();const list=document.getElementById('cardInfoList');if(!list)return;list.classList.add('enc-set-list');
    if(!catalog){list.innerHTML='<p role="status">영문판 목록 불러오는 중…</p>';return;}
    const q=searchText(CI_QUERY),sets=catalog.sets.filter(s=>searchText([s.name,s.code,s.displayCode,s.release].join(' ')).includes(q));
    const total=Math.max(1,Math.ceil(sets.length/size));page=Math.min(page,total);
    list.innerHTML=`<p class="enc-summary">영문판 ${sets.length}개 세트${q?'':` · 수록 ${catalog.cardCount.toLocaleString()}장`}</p>`+sets.slice((page-1)*size,page*size).map(s=>`<button type="button" class="set-tile enc-set" data-enc-set="${esc(s.code)}" aria-label="${esc(s.name)} 수록 카드"><span class="set-tile-img">${/^https:\/\/static\.tcgcollector\.com\//.test(s.image||'')?`<img src="${esc(s.image)}" alt="" loading="lazy" onerror="this.hidden=true">`:'<span>포켓몬</span>'}</span><span class="set-tile-body"><span class="set-tile-code">${esc(s.displayCode||s.code)}</span><span class="set-tile-name">${esc(s.name)}</span><span class="set-tile-meta">발매일: ${esc(s.release||'미정')}</span></span></button>`).join('')+(!sets.length?'<p>검색 결과가 없습니다.</p>':'')+`<nav class="ci-panel-pages enc-pages" aria-label="세트 페이지 이동">${pages(page,total,'data-enc-page')}</nav>`;
  }
  function quote(card){const p=card.psa10;if(!validPrice(p))return 'PSA10 미수집';return money(p.sourcePriceCents)?`PSA10 ${p.status==='available'?'참고가':p.status==='unverified'?'참고가 · 확인 필요':'추정가'} ${money(p.sourcePriceCents)}`:p.status==='no-price'?'PSA10 가격 없음':'PSA10 미수집';}
  function header(back=false){return `<div class="ci-panel-head">${back?`<button type="button" data-enc-back aria-label="수록 카드로 돌아가기">${icon('back')}</button>`:''}<button type="button" data-enc-expand aria-label="패널 전체화면 전환" aria-pressed="false">${icon('expand')}</button><span class="enc-head-space"></span><button type="button" data-enc-share aria-label="${back?'카드':'세트'} 정보 공유">${icon('share')}</button><button type="button" data-enc-close aria-label="${back?'카드':'세트'} 정보 닫기">${icon('close')}</button></div>`;}
  function panel(html,title){
    const expanded=document.getElementById('anyModal')?.classList.contains('ci-expanded');openAnyModal(html,'wide');const modal=document.getElementById('anyModal');
    modal.classList.add('ci-panel');modal.classList.toggle('ci-expanded',!!expanded);modal._ciOpener=opener;
    const box=modal.querySelector('.modal-box');box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby',title);
    modal.querySelector('[data-enc-expand]')?.setAttribute('aria-pressed',String(!!expanded));
    modal.querySelector('button')?.focus({preventScroll:true});
  }
  function setBody(){
    if(!active||!document.getElementById('encCardGrid'))return;
    const q=searchText(cardQuery),filtered=active.cards.filter(c=>searchText(name(c)+' '+c.name+' '+c.number).includes(q));const total=Math.max(1,Math.ceil(filtered.length/cardsPerPage));cardPage=Math.min(cardPage,total);
    document.getElementById('encCardGrid').innerHTML=filtered.slice((cardPage-1)*cardsPerPage,cardPage*cardsPerPage).map(c=>`<button type="button" class="set-card-item enc-card" data-enc-card="${esc(c.sourceId)}" aria-label="${esc(name(c))} ${esc(c.number)} 카드 정보"><span class="set-card-img enc-card-image">${art(c)}</span><span class="set-card-num"><strong>${esc(name(c))}</strong><span>${esc(c.number)}</span></span></button>`).join('')||'<p>검색 결과가 없습니다.</p>';
    document.getElementById('encCardPages').innerHTML=pages(cardPage,total,'data-enc-card-page');document.getElementById('encCardCount').innerHTML=`총 ${active.cardCount} 카드 수록${q?` · 검색 ${filtered.length}장`:''}<span>카드를 클릭하여 시세를 확인해보세요 · ${cardPage} / ${total} 페이지</span>`;
  }
  function setModal(){
    currentCard=null;
    panel(`${header()}<div class="ci-panel-info">${/^https:\/\/static\.tcgcollector\.com\//.test(active.image||'')?`<img class="ci-panel-thumb" src="${esc(active.image)}" alt="" onerror="this.style.visibility='hidden'">`:'<div class="ci-panel-thumb"></div>'}<div class="ci-panel-copy"><span class="ci-brand pokemon">포켓몬 · 영판</span><p>${esc(active.displayCode||active.code)}</p><h3 id="encPanelTitle">${esc(active.name)}</h3><p>발매일: ${esc(active.release||'미정')}</p></div></div><div class="ci-panel-scroll enc-scroll"><div class="ci-panel-summary" id="encCardCount"></div><label class="enc-search">카드 검색<input id="encCardSearch" type="search" placeholder="한글·영문 이름 또는 번호" value="${esc(cardQuery)}"></label><div class="set-card-grid" id="encCardGrid"></div></div><nav id="encCardPages" class="ci-panel-pages" aria-label="수록 카드 페이지 이동"></nav>`,'encPanelTitle');setBody();
  }
  async function open(code,keep=false,cardId=null){
    const token=++request;opener=document.activeElement;
    try{
      await ready;const set=catalog.sets.find(s=>s.code===code);if(!set||token!==request)return;
      panel(`${header()}<h3 class="enc-loading-title" id="encPanelTitle">${esc(set.name)} · 영판</h3><div class="ci-panel-scroll">카드 불러오는 중…</div>`,'encPanelTitle');let data=cache.get(code);
      if(!data){const r=await fetch(`/data/english-sets/${encodeURIComponent(code)}.json?v=${VERSION}`);if(!r.ok)throw Error();data=await r.json();if(data.language!=='en'||data.code!==code||data.cards?.length!==set.cardCount)throw Error();cache.set(code,data);if(cache.size>8)cache.delete(cache.keys().next().value);}
      if(token!==request||!document.getElementById('anyModal')?.classList.contains('open')||!document.getElementById('encPanelTitle'))return;
      active=data;if(!keep){cardPage=1;cardQuery='';}setModal();if(cardId)detail(cardId);
    }catch{if(token===request&&document.getElementById('anyModal')?.classList.contains('open')&&document.getElementById('encPanelTitle'))panel(`${header()}<h3 class="enc-loading-title" id="encPanelTitle">영문판 카드</h3><div class="ci-panel-scroll">카드를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>`,'encPanelTitle');}
  }
  function dailySales(sales){const days=new Map();for(const s of sales){const d=days.get(s.date)||{date:s.date,total:0,count:0};d.total+=s.priceCents;d.count++;days.set(s.date,d);}return [...days.values()].sort((a,b)=>a.date.localeCompare(b.date)).map(d=>({...d,price:Math.round(d.total/d.count)}));}
  function historyHTML(sales){
    const rows=dailySales(sales);if(!rows.length)return '<div class="px-empty">수집된 PSA10 판매 기록이 없습니다.</div>';
    const start=Date.parse(rows[0].date),duration=Date.parse(rows.at(-1).date)-start;
    const max=Math.max(...rows.map(r=>r.price)),min=Math.min(...rows.map(r=>r.price)),spread=max-min||Math.max(max*.1,100),vol=Math.max(...rows.map(r=>r.count)),x=i=>70+(duration?(Date.parse(rows[i].date)-start)/duration*480:240),y=r=>max===min?95:145-(r.price-min)/spread*100;
    return `<svg viewBox="0 0 580 204" role="img" aria-label="공개 판매 기록 날짜별 평균 가격과 기록 수"><path d="M65 45H555M65 145H555" stroke="#EDECE8" fill="none"/>${rows.map((r,i)=>`<rect x="${x(i)-6}" y="${180-r.count/vol*45}" width="12" height="${r.count/vol*45}" fill="#CFE8E5"><title>${r.date} · 공개 기록 ${r.count}건</title></rect>`).join('')}<polyline points="${rows.map((r,i)=>`${x(i)},${y(r)}`).join(' ')}" stroke="#087D7D" stroke-width="2" fill="none"/>${rows.map((r,i)=>`<circle cx="${x(i)}" cy="${y(r)}" r="3" fill="#087D7D"><title>${r.date} · 평균 ${money(r.price)} · ${r.count}건</title></circle>`).join('')}<g fill="#888780" font-size="11"><text x="5" y="47">${money(max)}</text><text x="5" y="147">${money(min)}</text><text x="65" y="198">${rows[0].date}</text>${rows.length>1?`<text x="555" y="198" text-anchor="end">${rows.at(-1).date}</text>`:''}</g></svg>`;
  }
  function detail(id){
    const c=active?.cards.find(c=>String(c.sourceId)===String(id));if(!c)return;currentCard=c;
    const p=c.psa10,valid=validPrice(p),source=sourceURL(p),value=valid?money(p.sourcePriceCents):null;
    const sales=valid?(p.sales||[]).filter(s=>Number.isSafeInteger(s.priceCents)&&s.priceCents>0&&/^\d{4}-\d{2}-\d{2}$/.test(s.date||'')&&supportedSale(s.url)):[];
    const gradeNames=['PSA 10','PSA 9','미감정','BGS 10 BL','BGS 10 GL','BGS 9.5'];
    panel(`${header(true)}<div class="ci-panel-scroll enc-detail-scroll"><article class="px-detail enc-detail"><section class="px-summary" aria-label="카드 기본 정보"><div class="px-art enc-detail-art">${art(c,true)}</div><div class="px-summary-main"><div class="px-summary-top"><span class="px-badge">포켓몬 · 영판</span></div><h1 class="px-title" id="encCardTitle">${esc(name(c))}</h1>${name(c)!==c.name?`<p class="px-original">${esc(c.name)}</p>`:''}<p class="px-pack">${esc(active.displayCode||active.code)} · ${esc(active.name)}</p><p class="px-pack">${esc(c.number)} · ${esc(c.rarity)}</p></div><div class="px-actions"><button type="button" class="px-btn primary" data-enc-back>수록 카드 보기</button>${source?`<a class="px-btn" href="${esc(source)}" target="_blank" rel="noopener noreferrer">${icon('external')}PriceCharting</a>`:''}</div></section><div class="px-content"><section class="px-price-box" aria-label="등급별 현재 시세"><div class="px-price-head"><div><div class="px-current-label">PSA 10 기준 · USD</div><div class="px-current">${value||'—'}</div></div><div class="px-source">${icon('info')}<span>${value?'PriceCharting · 추정 참고가':valid?'원문 가격 없음':'가격 미수집'}</span></div></div><div class="px-grades">${gradeNames.map((g,i)=>`<div class="px-grade" ${!i?'aria-current="true"':''}><span class="px-grade-label">${g}</span><span class="px-grade-price">${i?'미수집':value||'—'}</span></div>`).join('')}</div><p class="px-chart-note">${value?'현재 참고가격이며 실제 판매가 한 건을 뜻하지 않습니다.':'가격이 확인되면 표시됩니다. 미수집 가격은 0원으로 계산하지 않습니다.'}</p></section><section><div class="px-section-head"><h2>가격 · 거래량 히스토리</h2></div><div class="px-chart">${historyHTML(sales)}</div><p class="px-chart-note">공개된 PSA10 판매 기록의 날짜별 평균 가격(USD) · 막대는 확인된 기록 수입니다. 전체 시장 거래량이나 전체 기간 자료가 아닙니다.</p></section><section><div class="px-section-head"><h2>판매 기록</h2><span class="px-chart-note">확인된 ${sales.length}건</span></div>${sales.length?`<table class="px-table enc-sales"><thead><tr><th scope="col">판매일</th><th scope="col">판매가 · USD</th><th scope="col">출처</th></tr></thead><tbody>${sales.map(s=>`<tr><td>${esc(s.date)}</td><td>${money(s.priceCents)}</td><td><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(s.date)} ${money(s.priceCents)} 판매 원문">eBay ↗</a></td></tr>`).join('')}</tbody></table>`:'<p class="px-chart-note">수집된 판매 내역이 없습니다.</p>'}</section><section><div class="px-section-head"><h2>카드 정보</h2></div><table class="px-table px-info"><tbody><tr><td>언어</td><td>영문판</td></tr><tr><td>카드 번호</td><td>${esc(c.number)}</td></tr><tr><td>희귀도</td><td>${esc(c.rarity||'—')}</td></tr><tr><td>확장팩</td><td>${esc(active.name)}</td></tr><tr><td>발매일</td><td>${esc(active.release||'미정')}</td></tr><tr><td>가격 출처</td><td>${valid?'PriceCharting':'미수집'}</td></tr><tr><td>가격 확인일</td><td>${valid?esc(p.fetchedAt?.slice(0,10)||'—'):'—'}</td></tr></tbody></table></section></div></article></div>`,'encCardTitle');
  }
  async function share(){
    if(!active)return;const url=new URL(location.href);url.search='';url.searchParams.set('set',active.code);if(currentCard)url.searchParams.set('card',currentCard.sourceId);url.hash='cardinfo';
    try{if(navigator.share)await navigator.share({title:currentCard?name(currentCard):active.name,url:url.href});else{await navigator.clipboard.writeText(url.href);showToast('링크를 복사했습니다');}}catch(e){if(e.name!=='AbortError')showToast('링크를 복사하지 못했습니다');}
  }
  const originalRender=renderCardInfo,originalOpen=window.openSetGrid;
  renderCardInfo=function(){document.getElementById('cardInfoList')?.classList.remove('enc-set-list');if(language==='en'&&CI_TAB==='pokemon')render();else{originalRender();ensureLanguages();}};
  window.openSetGrid=function(code,...args){if(code.startsWith('EN-'))return open(code);request++;return originalOpen(code,...args);};
  const ready=Promise.all(['/data/english-catalog.json','/data/english-card-names-ko.json'].map(async url=>{const r=await fetch(url+'?v='+VERSION);if(!r.ok)throw Error();return r.json();})).then(([data,ko])=>{if(data.schemaVersion!==1||!Array.isArray(data.sets)||ko.schemaVersion!==1||!ko.names)throw Error();catalog=data;names=ko.names;return data;});
  document.addEventListener('input',e=>{if(e.target.id==='encCardSearch'){cardQuery=e.target.value;cardPage=1;setBody();}});
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-enc-language],[data-enc-set],[data-enc-page],[data-enc-card-page],[data-enc-card],[data-enc-back],[data-enc-share],[data-enc-expand],[data-enc-close]');if(!b||b.disabled)return;e.preventDefault();e.stopPropagation();
    if(b.dataset.encLanguage){language=b.dataset.encLanguage;page=1;renderCardInfo();}
    else if(b.dataset.encSet)open(b.dataset.encSet);
    else if(b.dataset.encPage){page=Number(b.dataset.encPage);render();document.getElementById('encLanguages').scrollIntoView({block:'start'});}
    else if(b.dataset.encCardPage){cardPage=Number(b.dataset.encCardPage);setBody();document.querySelector('.enc-scroll').scrollTop=0;}
    else if(b.dataset.encCard)detail(b.dataset.encCard);
    else if(b.hasAttribute('data-enc-back'))setModal();
    else if(b.hasAttribute('data-enc-share'))share();
    else if(b.hasAttribute('data-enc-expand')){const on=document.getElementById('anyModal').classList.toggle('ci-expanded');b.setAttribute('aria-pressed',String(on));}
    else if(b.hasAttribute('data-enc-close')){request++;closeAnyModal();}
  },true);
  ensureLanguages();
  ready.then(()=>{renderCardInfo();const query=new URLSearchParams(location.search),code=query.get('set');if(code?.startsWith('EN-')&&location.hash==='#cardinfo'){language='en';CI_TAB='pokemon';renderCardInfo();open(code,false,query.get('card'));}}).catch(()=>{if(language==='en')document.getElementById('cardInfoList').innerHTML='<p>영문판 목록을 불러오지 못했습니다. 새로고침해 주세요.</p>';});
  window.EnglishCatalog={art,quote,open,name,dailySales,historyHTML};
})();
