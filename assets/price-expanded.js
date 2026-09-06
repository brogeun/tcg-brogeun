/* Expanded detail uses existing routes, product lookup, portfolio and watch APIs. */
(() => {
  'use strict';
  const grades = [['psa10','PSA 10'],['psa9','PSA 9'],['raw','A급(미개봉)'],['bgs10_bl','BGS 10 BL'],['bgs10_gl','BGS 10 GL'],['bgs95','BGS 9.5']];
  let returnContext = null;
  let observer = null;
  const icon = name => `<svg class="px-icon" viewBox="0 0 24 24" aria-hidden="true">${({back:'<path d="m12 5-7 7 7 7M5 12h14"/>',star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',share:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',plus:'<path d="M12 5v14M5 12h14"/>',external:'<path d="M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'})[name] || ''}</svg>`;
  const decode = value => { const el=document.createElement('textarea'); el.innerHTML=String(value||''); return el.value; };
  const positive = value => Number.isFinite(Number(value)) && Number(value)>0;
  function quote(grade) {
    if (!grade) return null;
    const value=grade.lowest_ask ?? grade.recent_avg ?? grade.last5_avg ?? grade.avg ?? grade.avg_jpy;
    if (!positive(value)) return null;
    return {value:Number(value),currency:grade.currency || (grade.avg_jpy ? 'JPY' : 'USD'),source:grade.lowest_ask != null ? '현재 출품 최저가' : '최근 거래가'};
  }
  function sortedHistory(history) { return (Array.isArray(history)?history:[]).filter(r=>r && /^\d{4}-\d{2}-\d{2}$/.test(r.date)).slice().sort((a,b)=>a.date.localeCompare(b.date)); }
  function latest(history,key) { return history.slice().reverse().find(r=>positive(r[key]))?.[key] ?? null; }
  // Seven calendar days, not eight rows (sparse history may skip dates).
  function change7(history,key) {
    const rows=sortedHistory(history).filter(r=>positive(r[key]));
    const end=rows.at(-1); if (!end) return null;
    const date=new Date(end.date+'T00:00:00Z'); date.setUTCDate(date.getUTCDate()-7);
    const base=rows.find(r=>r.date===date.toISOString().slice(0,10));
    return base ? (Number(end[key])/Number(base[key])-1)*100 : null;
  }
  function changeHTML(value) {
    if (value==null || !Number.isFinite(value)) return '<span class="px-change flat">—</span>';
    if (Math.abs(value)<.05) return '<span class="px-change flat">변동 없음</span>';
    return `<span class="px-change ${value>0?'up':'down'}">${value>0?'▲ +':'▼ '}${value.toFixed(1)}%</span>`;
  }
  async function json(url) {
    try { const r=await fetch(url,{signal:AbortSignal.timeout(10000)}); return r.ok ? await r.json() : null; } catch { return null; }
  }
  function isBox(product,history) {
    const source=product._srcFile || product._src || '';
    if (isCardProduct(product.name) || product._productKind==='card' || /-card$/.test(source) || /^[A-Za-z]+\d*[A-Za-z]?-\d+/.test(String(product.productNumber||''))) return false;
    if (product._productKind==='box' || /-box$/.test(source) || /^manual-boxes/.test(source)) return true;
    return !history.some(r=>grades.some(([key])=>r[key+'_price']!=null));
  }
  function krw(q) { return q ? fmtKrw(q.value,q.currency) : '—'; }
  window.setExpandedPriceMode = enabled => {
    document.body.classList.toggle('price-expanded',enabled);
    if (!enabled) { observer?.disconnect(); observer=null; }
  };
  function back() {
    const context=returnContext; returnContext=null;
    window.setExpandedPriceMode(false);
    if (context) {
      go(context.path);
      window.scrollTo(0,context.scroll);
      openSlidePanel(context.id);
    } else if (window._DETAIL_NAV?.from) { goBackFromDetail(); }
    else { go('price'); }
  }
  document.addEventListener('click',event=>{
    if (event.target.closest('#slideFullBtn') && CURRENT_SLIDE_ID) {
      returnContext={id:String(CURRENT_SLIDE_ID),path:(location.hash||'#price').slice(1),scroll:window.scrollY};
    }
  },true);
  function routeChanged() {
    if (!/^#price\/[^/]+$/.test(location.hash)) {
      window.setExpandedPriceMode(false);
      const context=returnContext;
      if (context && location.hash==='#'+context.path) {
        returnContext=null; window.scrollTo(0,context.scroll); openSlidePanel(context.id);
      } else returnContext=null;
    }
  }
  window.addEventListener('popstate',routeChanged);
  window.addEventListener('hashchange',routeChanged);
  const head = () => `<header class="px-head"><button type="button" class="px-back" data-px-back>${icon('back')}뒤로가기</button><div class="px-nav"></div></header>`;
  window.renderExpandedPriceDetail = async (id, original, panel) => {
    const current=()=>panel.dataset.productId===String(id) && document.body.classList.contains('price-expanded');
    if (!current()) return;
    panel.innerHTML=`<article class="px-detail">${head()}<div class="px-empty" role="status">시세 정보를 불러오는 중입니다.</div></article>`;
    panel.querySelector('[data-px-back]').onclick=back;
    if (!original) {
      panel.querySelector('.px-empty').textContent='상품 정보를 찾을 수 없습니다. 시세 목록에서 다시 선택해 주세요.';
      return;
    }
    const product={...original};
    const [histData,detail]=await Promise.all([json(`/data/history/${encodeURIComponent(id)}.json`),loadCardsDetail(),enrichPriceProductMetadata([product],'box')]);
    if (!current()) return;
    const history=sortedHistory(histData?.history);
    const box=isBox(product,history);
    const brand=product._brand || product.brand || 'pokemon';
    const catalogInfo=await PriceProductInfo.get(product,brand,box);
    if (!current()) return;
    const sets=catalogInfo.sets;
    const originalName=decode(product.name);
    const name=decode((box && getBoxKoreanName(product,brand)) || HOME_TOP_KO_NAMES[String(id)] || product._koName || product.name_ko || originalName);
    const pack=decode(sets.map(PriceProductInfo.label).join(' / ') || product.set_name || product.pack || '');
    const release=sets.length ? sets.map(s=>`${sets.length>1?s.code+' · ':''}${s.release || '카드정보에 발매일 미등록'}`).join(' / ')
      : product.release_date || product.releaseDate || '카드정보에 발매일 미등록';
    const keys=box?[['box','박스']]:grades;
    const values={};
    const staticGrades=detail?.cards?.[id]?.grades || {};
    for (const [key] of keys) {
      values[key]=box ? null : quote(staticGrades[key]);
      const value=latest(history,key+'_price');
      if (!values[key] && positive(value)) values[key]={value:Number(value),currency:'JPY',source:'최근 거래가'};
    }
    if (box && !values.box && positive(product.lastPrice ?? product.lowestAsk)) values.box={value:Number(product.lastPrice ?? product.lowestAsk),currency:product.currency||'JPY',source:'상품 시세'};
    // A general ungraded product price must never be labelled PSA 10.
    const state={grade:box?'box':values.psa10?'psa10':values.raw?'raw':keys.find(([k])=>values[k])?.[0] || 'psa10',range:'all'};
    const extURL=(()=>{try{const u=new URL(product.url || `https://snkrdunk.com/apparels/${id}`);return u.protocol==='https:' && /(^|\.)snkrdunk\.com$/.test(u.hostname)?u.href:`https://snkrdunk.com/apparels/${id}`;}catch{return `https://snkrdunk.com/apparels/${id}`;}})();
    panel.innerHTML=`<article class="px-detail" data-product-kind="${box?'box':'card'}">${head()}
      <section class="px-summary" aria-label="상품 기본 정보">
        <div class="px-art">${product.image?`<img src="${escapeHtml(product.image)}" alt="${escapeHtml(name)}" referrerpolicy="no-referrer" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><span hidden>이미지 없음</span>`:'<span>이미지 없음</span>'}</div>
        <div class="px-summary-main"><div class="px-summary-top"><span class="px-badge ${brand==='onepiece'?'op':''}">${brand==='onepiece'?'원피스':'포켓몬'}</span><div class="px-tools"><button type="button" class="px-icon-btn" id="pxWatch" aria-label="관심 상품 추가" aria-pressed="false">${icon('star')}</button><button type="button" class="px-icon-btn" id="pxShare" aria-label="시세 링크 공유">${icon('share')}</button></div></div>
          <h1 class="px-title" title="${escapeHtml(name)}">${escapeHtml(name)}</h1>
          ${name!==originalName?`<p class="px-original" title="${escapeHtml(originalName)}">${escapeHtml(originalName)}</p>`:''}
          <p class="px-pack">${escapeHtml(pack || '카드정보에 확장팩 미등록')}</p>
        </div>
        <div class="px-actions"><button type="button" id="pxPortfolio" class="px-btn primary">${icon('plus')}포트폴리오 추가</button><a href="${escapeHtml(extURL)}" class="px-btn" target="_blank" rel="noopener noreferrer">${icon('external')}SNKRDUNK</a></div>
      </section>
      <div class="px-content"><section class="px-price-box" aria-label="등급별 현재 시세"><div class="px-price-head"><div aria-live="polite"><div class="px-current-label" id="pxLabel"></div><div class="px-current" id="pxCurrent"></div></div><div class="px-source">${icon('info')}<span id="pxSource"></span></div></div><div class="px-grades ${box?'is-box':''}">${keys.map(([key,label])=>`<button type="button" class="px-grade" data-px-grade="${key}" aria-pressed="false"><span class="px-grade-label">${label}</span><span class="px-grade-price"></span></button>`).join('')}</div></section>
      <section><div class="px-section-head"><h2>가격 · 거래량 히스토리</h2><select class="px-range" id="pxRange" aria-label="차트 기간"><option value="all">전체</option><option value="30">30일</option><option value="90">90일</option><option value="180">180일</option></select></div><div class="px-chart" id="pxChart"></div><div class="px-chart-note" id="pxChartNote"></div></section>
      <section><div class="px-section-head"><h2>${box?'박스 시세':'등급별 시세'}</h2></div><table class="px-table"><thead><tr><th scope="col">등급</th><th scope="col">가격</th><th scope="col">7일 변동</th></tr></thead><tbody id="pxGradeRows"></tbody></table><p class="px-chart-note">7일 변동은 최신 거래일과 7일 전 거래가 비교입니다. 비교 데이터가 없으면 —로 표시합니다.</p></section>
      <section><div class="px-section-head"><h2>${box?'상품 정보':'카드 정보'}</h2></div><table class="px-table px-info"><tbody>
        <tr><td>타입</td><td>${box?'박스':'카드'}</td></tr>
        ${!box?`<tr><td>희귀도</td><td>${escapeHtml(product.rarity || originalName.match(/\b(SAR|SR|SSR|AR|UR|MA|L|SEC|R|C)\b/)?.[1] || '—')}</td></tr>`:''}
        <tr><td>확장팩</td><td>${escapeHtml(pack || '카드정보에 확장팩 미등록')}</td></tr><tr><td>발매일</td><td>${escapeHtml(release)}</td></tr>
        <tr><td>데이터 출처</td><td>SNKRDUNK · 일일 자동 갱신</td></tr><tr><td>최근 거래 데이터</td><td>${escapeHtml(history.at(-1)?.date || '—')}</td></tr></tbody></table>
        ${!box && sets.length?`<div class="px-related">${sets.map(s=>`<button type="button" class="px-btn" data-px-set="${escapeHtml(s.code)}">${escapeHtml(PriceProductInfo.label(s))} 카드정보</button>`).join('')}</div>`:''}
      </section></div></article>`;
    panel.querySelector('[data-px-back]').onclick=back;
    const nav=window._DETAIL_NAV;
    const idx=nav?.list?.indexOf(String(id)) ?? -1;
    if (idx>=0) {
      const node=panel.querySelector('.px-nav');
      node.innerHTML=`<button class="px-icon-btn" type="button" aria-label="이전 상품" ${idx===0?'disabled':''}>${icon('back')}</button><span>${idx+1} / ${nav.list.length}</span><button class="px-icon-btn" type="button" aria-label="다음 상품" ${idx===nav.list.length-1?'disabled':''}><span style="transform:rotate(180deg);display:flex">${icon('back')}</span></button>`;
      node.children[0].onclick=()=>navDetailTo(nav.list[idx-1]);node.children[2].onclick=()=>navDetailTo(nav.list[idx+1]);
    }
    const watch=panel.querySelector('#pxWatch');
    function updateWatch(){const active=WATCHLIST.some(w=>String(w.snkrdunk_id || w.card_id)===String(id));watch.setAttribute('aria-pressed',String(active));watch.setAttribute('aria-label',active?'관심 상품 제거':'관심 상품 추가');watch.innerHTML=icon('star');}
    updateWatch();
    watch.onclick=async()=>{watch.disabled=true;try{await toggleCardWatch(String(id),watch);}finally{updateWatch();watch.disabled=false;}};
    panel.querySelector('#pxShare').onclick=async()=>{
      const url=`${location.origin}${location.pathname}#price/${encodeURIComponent(id)}`;
      if (navigator.share) {try {await navigator.share({title:name+' 시세 — TCG Hub',url});return;}catch(error){if(error.name==='AbortError')return;}}
      try {await navigator.clipboard.writeText(url);showToast('시세 링크를 복사했습니다','success');}catch{prompt('시세 링크를 복사하세요',url);}
    };
    panel.querySelector('#pxPortfolio').onclick=()=>{if(state.grade.startsWith('bgs'))return;const q=values[state.grade];openAddToPortfolio(String(id),name,product.image||'',q?.value||0,state.grade,q?.currency||'JPY');};
    panel.querySelectorAll('[data-px-set]').forEach(btn=>btn.onclick=()=>{const set=sets.find(s=>s.code===btn.dataset.pxSet);if(set){closePriceDetail();go('cardinfo');openSetGrid(set.code,set.name,set.url || '');}});
    function draw(){renderChart(panel.querySelector('#pxChart'),history,state.grade,state.range);panel.querySelector('#pxChartNote').textContent=`${keys.find(([k])=>k===state.grade)?.[1]} 거래가(KRW) · 거래량은 전체 등급 합계(제공된 경우) · BGS는 거래가 적어 참고용입니다.`;}
    function update(){
      if (!current()) return;
      const q=values[state.grade];
      panel.querySelector('#pxLabel').textContent=keys.find(([k])=>k===state.grade)[1]+' 기준';
      panel.querySelector('#pxCurrent').textContent=krw(q);
      panel.querySelector('#pxSource').textContent='SNKRDUNK · '+(q?.source || '가격 데이터 없음');
      const portfolio=panel.querySelector('#pxPortfolio');
      portfolio.disabled=state.grade.startsWith('bgs');
      portfolio.title=portfolio.disabled?'BGS는 시세 참고용입니다. 현재 포트폴리오는 PSA 10·PSA 9·A급·박스 등급을 지원합니다.':'선택한 등급으로 포트폴리오 추가';
      panel.querySelectorAll('[data-px-grade]').forEach(btn=>{const key=btn.dataset.pxGrade;btn.setAttribute('aria-pressed',String(key===state.grade));btn.querySelector('.px-grade-price').textContent=krw(values[key]);});
      panel.querySelector('#pxGradeRows').innerHTML=keys.map(([key,label])=>`<tr class="${key===state.grade?'is-selected':''}"><td>${label}</td><td>${krw(values[key])}</td><td>${changeHTML(change7(history,key+'_price'))}</td></tr>`).join('');
      draw();
    }
    panel.querySelectorAll('[data-px-grade]').forEach(btn=>btn.onclick=()=>{state.grade=btn.dataset.pxGrade;update();});
    panel.querySelector('#pxRange').onchange=event=>{state.range=event.target.value;draw();};
    // Align action buttons with the summary text on desktop, spanning both columns on mobile.
    update(); observer?.disconnect();observer=new ResizeObserver(draw);observer.observe(panel.querySelector('#pxChart'));
    // Static data renders immediately; live current asks update only this still-active product.
    if (!box) {
      const live=await json(`/api/card-grades?id=${encodeURIComponent(id)}`);
      if (!current() || !live?.ok) return;
      for (const [key] of keys) {const q=quote(live.grades?.[key]);if(q)values[key]=q;}
      update();
    }
  };
  function renderChart(target,history,grade,range) {
    const priceKey=grade+'_price';
    let rows=history;
    if (range!=='all' && rows.length) {const end=Date.parse(rows.at(-1).date);rows=rows.filter(r=>Date.parse(r.date)>=end-Number(range)*86400000);}
    rows=rows.filter(r=>positive(r[priceKey]));
    // Preserve the established neighbour-median outlier guard for the visual trend.
    rows=rows.filter((r,i,all)=>{const nearby=all.slice(Math.max(0,i-3),i+4).filter(n=>n!==r).map(n=>Number(n[priceKey])).sort((a,b)=>a-b);const m=nearby[Math.floor(nearby.length/2)];return !m || (r[priceKey]>=m*.5 && r[priceKey]<=m*2);});
    if (rows.length<2) {target.innerHTML='<div class="px-empty">선택한 등급·기간의 거래 데이터가 부족합니다.</div>';return;}
    const width=Math.max(240,Math.floor(target.clientWidth)),left=64,right=16,top=20,bottom=172;
    const vals=rows.map(r=>Number(r[priceKey])*JPY_KRW),min=Math.min(...vals),max=Math.max(...vals),spread=max-min||Math.max(max*.1,1);
    const first=Date.parse(rows[0].date),last=Date.parse(rows.at(-1).date);
    const x=i=>left+(Date.parse(rows[i].date)-first)/(last-first||1)*(width-left-right);
    const y=v=>top+8+(1-(v-min)/spread)*(bottom-top-16);
    const volumes=rows.map(r=>Math.max(0,Number(r.total_vol ?? r[grade+'_vol'])||0));const maxV=Math.max(...volumes,1);
    const points=vals.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const money=v=>v>=10000?'₩'+(v/10000).toLocaleString('ko-KR',{maximumFractionDigits:1})+'만':'₩'+Math.round(v).toLocaleString('ko-KR');
    const guides=[min+(max-min)/2,max,min].map(v=>`<path d="M${left} ${y(v)}H${width-right}" stroke="#D9D8D3" stroke-width=".5"/><text x="${left-8}" y="${y(v)+4}" text-anchor="end" fill="#888780" font-size="10">${money(v)}</text>`).join('');
    const barWidth=Math.max(1,Math.min(12,(width-left-right)/rows.length*.6));
    const bars=volumes.map((v,i)=>`<rect x="${x(i)-barWidth/2}" y="${bottom-v/maxV*56}" width="${barWidth}" height="${v/maxV*56}" fill="#066666" opacity=".12"/>`).join('');
    target.innerHTML=`<svg viewBox="0 0 ${width} 204" role="img" aria-label="${escapeHtml(grade)} 거래가 및 거래량, ${rows[0].date}부터 ${rows.at(-1).date}"><title>선택한 등급의 실제 거래 이력</title>${guides}${bars}<polygon points="${left},${bottom} ${points} ${x(rows.length-1)},${bottom}" fill="#19DFDF" opacity=".08"/><polyline points="${points}" fill="none" stroke="#066666" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>${vals.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="#066666" opacity=".01"><title>${rows[i].date} · ${money(v)} · 거래량 ${volumes[i]}</title></circle>`).join('')}<circle cx="${x(rows.length-1)}" cy="${y(vals.at(-1))}" r="3" fill="#066666"/>${[0,Math.floor((rows.length-1)/2),rows.length-1].map((i,n)=>`<text x="${n===0?left:n===2?width-right:width/2}" y="196" text-anchor="${n===0?'start':n===2?'end':'middle'}" fill="#888780" font-size="10">${rows[i].date.slice(0,7).replace('-','.')}</text>`).join('')}</svg>`;
  }
  window.PriceExpandedTest={quote,change7,isBox,sortedHistory};
})();
