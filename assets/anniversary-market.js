/* Only the two audited 30th-anniversary Japanese sets use this snapshot. */
(() => {
  let snapshot=null, pending=null;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function load() {
    if(snapshot)return snapshot;
    if(!pending)pending=(async()=>{
      try{
        const r=await fetch('/data/anniversary-market.json?t='+Math.floor(Date.now()/3600000),{signal:AbortSignal.timeout(15000)});
        if(!r.ok)throw Error('Snapshot unavailable');
        const d=await r.json();
        if(d.schemaVersion!==1||!d.products)throw Error('Invalid snapshot');
        snapshot=d;return d;
      }catch{return null;}
      finally{pending=null;}
    })();
    return pending;
  }
  const product=id=>snapshot?.products?.[String(id)] || null;
  const gradeQuote=(id,key)=>{
    const p=product(id),g=p?.grades?.find(g=>g.key===key);
    return Number.isSafeInteger(g?.lowestAsk)&&g.lowestAsk>0?{value:g.lowestAsk,currency:'JPY',source:'일본 스니덩 판매가 · 수집 시점'}:null;
  };
  const quote=p=>{const known=product(p?.id);return known?gradeQuote(p.id,known.kind==='box'?'box':'raw'):null;};
  function products(){
    return Object.values(snapshot?.products || {}).map(p=>{
      const q=gradeQuote(p.id,p.kind==='box'?'box':'raw');
      return {...p,url:p.sourceUrl,image:p.thumbnailUrl,lastPrice:q?.value??null,minPrice:q?.value??null,
        nameLower:p.name.toLowerCase(),_productKind:p.kind,_brand:'pokemon',_grade:p.kind==='card'?'raw':undefined};
    });
  }
  // Supplement the shared detail, never create a second product/image layout.
  function renderSupplement(p) {
    if(!p)return '';
    const yen=v=>Number.isSafeInteger(v)&&v>0?'¥'+v.toLocaleString('ko-KR'):'출품 없음';
    const won=v=>Number.isSafeInteger(v)&&v>0?fmtKrw(v,'JPY'):'—';
    const stamp=new Date(p.fetchedAt);
    const stale=!Number.isFinite(stamp.getTime())||Date.now()-stamp.getTime()>48*3600000;
    return `<div class="am-market-note">
      ${/2 Piece Set/i.test(p.name)?'<p style="color:#a16207">2장 묶음 상품 가격입니다. 개별 카드 1장 가격이 아닙니다.</p>':''}
      <p style="font-size:12px;color:#888">${stale?'갱신 지연 · 마지막 수집':'수집'} ${Number.isFinite(stamp.getTime())?stamp.toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'확인 필요'} KST</p>
      <details><summary style="cursor:pointer;font-size:12px">전체 등급 · 엔화 가격 보기</summary>
      <table class="slide-grade-table px-table"><thead><tr><th>등급</th><th>엔화</th><th>원화</th></tr></thead><tbody>
      ${p.grades.map(g=>`<tr><td>${esc(g.label)}</td><td>${yen(g.lowestAsk)}</td><td>${won(g.lowestAsk)}</td></tr>`).join('')}</tbody></table></details>
      <p style="font-size:12px;color:#888">등급별 판매 등록가입니다. 배송비·수수료는 포함하지 않으며, 원화는 사이트 공통 환율로 환산합니다.</p></div>`;
  }
  let request=0;
  document.addEventListener('click',async event=>{
    const item=event.target.closest('.set-card-item[data-anniversary-ids]');
    if(!item)return;
    event.preventDefault();event.stopImmediatePropagation();
    const token=++request;
    let ids=[];try{ids=JSON.parse(item.dataset.anniversaryIds);}catch{}
    await load();
    if(typeof FX_READY!=='undefined')await FX_READY;
    if(token!==request||!item.isConnected)return;
    const rows=ids.map(product).filter(Boolean);
    const name=item.dataset.cardName || '';
    closeAnyModal();
    if(rows.length===1){await window.openSlidePanel(String(rows[0].id));return;}
    openAnyModal(`<div class="modal-head"><h3>카드 상품 선택</h3><button class="modal-close" aria-label="닫기" onclick="closeAnyModal()">✕</button></div>
      <div class="modal-body" style="padding:20px;text-align:center">
        <button class="btn" onclick="reopenLastSet()" style="margin-bottom:16px">← 수록 카드로</button>
        ${rows.length>1?`<p>같은 번호의 상품입니다. 이미지와 버전을 확인해 선택해 주세요.</p><div id="amChoices">${rows.map(p=>`<button class="btn" data-am-id="${esc(p.id)}" style="white-space:normal;margin:4px">${esc(p.name)}</button>`).join('')}</div>`:''}
        <div id="amContent">${rows.length?'상품을 선택해 주세요.':`<h3>${esc(name)}</h3><p>번호·버전이 일치하는 스니덩 상품 연결을 확인 중입니다.</p><p style="font-size:12px;color:#888">거래가 없다는 뜻은 아닙니다. 확인되지 않은 다른 카드의 가격은 표시하지 않습니다.</p>`}</div>
      </div>`);
    document.querySelectorAll('[data-am-id]').forEach(btn=>btn.onclick=()=>{closeAnyModal();window.openSlidePanel(btn.dataset.amId);});
  },true);
  window.AnniversaryMarket={load,product,products,quote,gradeQuote,renderSupplement};
})();
