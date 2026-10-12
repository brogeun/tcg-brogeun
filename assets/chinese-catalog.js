/* Mainland Chinese boosters and cards retain their own printed identities. */
(() => {
  'use strict';
  const VERSION='20261012-cn-names1', PAGE_SIZE=24, CARDS_PER_PAGE=18;
  let catalog, ready, searchReady, page=1, lastQuery='', renderRequest=0, request=0;
  let active, currentCard, opener, cardPage=1, cardQuery='', cardScroll=0, linkNotice='';
  const cardCache=new Map();
  let market, marketReady, marketFailed=false;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
  const official=url=>/^https:\/\/(?:[a-z0-9-]+\.)?pokemon\.cn\//.test(url||'');
  const sourceURL=url=>official(url)||/^https:\/\/pikaqian\.com\/(?:sets|cards)\/[a-zA-Z0-9.-]+$/.test(url||'');
  const isImage=url=>official(url)||/^\/?images\/pokemon-cn\/CN-[A-Z0-9-]+\.(?:png|jpe?g|webp)$/.test(url||'')||/^\/?images\/pokemon-cn-cards\/[a-zA-Z0-9/_-]+\.(?:png|jpe?g|webp)$/.test(url||'')||/^https:\/\/images\.pikaqian\.com\/originals\/[a-zA-Z0-9.-]+\/[a-f0-9-]+\.png$/.test(url||'')||/^https:\/\/cdn\.pokemon-tcg\.cn\/cards\/[a-fA-F0-9]+\.png$/.test(url||'');
  const imageURL=url=>String(url||'').startsWith('images/')?'/'+url:url;
  const image=(url,alt,cls='',fallback='')=>isImage(url)?'<img class="'+cls+'" src="'+esc(imageURL(url))+'" alt="'+esc(alt)+'" loading="lazy" '+(isImage(fallback)&&fallback!==url?'data-fallback="'+esc(imageURL(fallback))+'" onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;delete this.dataset.fallback;}else{this.hidden=true}"':'onerror="this.hidden=true"')+'>':'<span class="cn-no-image">이미지 없음</span>';
  const name=c=>c.nameKo||c.name;
  const cardId=c=>String(c.id||c.sourceId||'');
  const variantName=c=>c.variantLabel||c.variant||'';
  const art=c=>image(c.image,name(c));
  function prepare(data){
    if(data?.schemaVersion!==1||data.language!=='zh-CN'||!Array.isArray(data.sets))throw Error('Invalid Chinese catalog');
    const codes=new Set();
    for(const set of data.sets){
      if(!/^CN-[A-Z0-9-]+$/.test(set.code||'')||codes.has(set.code)||!set.name||!set.originalName||!official(set.sourceUrl))throw Error('Invalid Chinese booster');
      if(set.variants!==undefined&&!Array.isArray(set.variants))throw Error('Invalid booster variants');
      codes.add(set.code);
      set.searchText=normalize([set.name,set.originalName,set.code,set.release,set.series,...(set.aliases||[])].join(' '));
    }
    return data;
  }
  function ensureData(){
    if(!ready)ready=fetch('/data/chinese-catalog.json?v='+VERSION).then(r=>{if(!r.ok)throw Error();return r.json();}).then(prepare).then(data=>catalog=data).catch(e=>{ready=null;throw e;});
    return ready;
  }
  const auctionURL=url=>/^https:\/\/www\.cardhobby\.com\.cn\/market\/item\/[1-9][0-9]*$/.test(url||'');
  const cnyAmount=n=>'¥'+n.toLocaleString('ko-KR',{minimumFractionDigits:0,maximumFractionDigits:2})+' CNY';
  function priceParts(amount,unit=''){
    const converted=window.TCGFX?.convert?.(amount,'CNY');
    const available=typeof converted==='number'&&Number.isSafeInteger(converted)&&converted>=0;
    const suffix=unit?' / '+unit:'';
    return {primary:(available?'₩'+converted.toLocaleString('ko-KR'):cnyAmount(amount))+suffix,
      secondary:available?cnyAmount(amount)+suffix:'원화 환산 불가'};
  }
  function price(amount,unit=''){
    const parts=priceParts(amount,unit);
    return '<span class="cn-price" data-cn-cny="'+esc(amount)+'"'+(unit?' data-cn-price-unit="'+esc(unit)+'"':'')+'><span class="cn-price-primary" data-cn-price-primary>'+esc(parts.primary)+'</span><span class="cn-price-original" data-cn-price-original>'+esc(parts.secondary)+'</span></span>';
  }
  function fxNote(){
    const state=window.TCGFX?.getState?.(),rate=state?.rates?.CNY;
    if(!state?.cnyReady||typeof rate!=='number'||!Number.isFinite(rate)||rate<=0)return '중국 위안(CNY) 원금액 · 환율을 불러오지 못해 원화로 환산할 수 없어요.';
    const date=state.date?marketDate(state.date):'기준일 미확인';
    return '원화 환산 · '+date+' 환율 · 1 CNY = ₩'+rate.toLocaleString('ko-KR',{maximumFractionDigits:4});
  }
  const fxNoteHTML=()=>'<p class="cn-fx-note" data-cn-fx-note>'+esc(fxNote())+'</p>';
  function refreshPrices(){
    const modal=document.getElementById('anyModal');
    if(!modal?.classList.contains('open')||!modal.classList.contains('cn-panel'))return;
    for(const el of modal.querySelectorAll('[data-cn-cny]')){
      const amount=Number(el.dataset.cnCny);if(!Number.isFinite(amount)||amount<=0)continue;
      const parts=priceParts(amount,el.dataset.cnPriceUnit||'');
      const primary=el.querySelector('[data-cn-price-primary]'),original=el.querySelector('[data-cn-price-original]');
      if(primary)primary.textContent=parts.primary;if(original)original.textContent=parts.secondary;
    }
    for(const el of modal.querySelectorAll('[data-cn-fx-note]'))el.textContent=fxNote();
  }
  const marketDate=date=>String(date||'').replace(/-/g,'.');
  function validQuote(q){
    return q&&Number.isSafeInteger(q.priceMinor)&&q.priceMinor>0&&/^\d{4}-\d{2}-\d{2}$/.test(q.date||'')&&Number.isSafeInteger(q.auctionCount)&&q.auctionCount>0&&Number.isSafeInteger(q.totalAuctionCount)&&q.totalAuctionCount>=q.auctionCount&&auctionURL(q.sourceUrl)&&Array.isArray(q.history)&&q.history.length&&q.history.every(p=>Number.isSafeInteger(p.priceMinor)&&p.priceMinor>0&&/^\d{4}-\d{2}-\d{2}$/.test(p.date||'')&&Number.isSafeInteger(p.auctionCount)&&p.auctionCount>0&&auctionURL(p.sourceUrl));
  }
  function prepareMarket(data){
    if(data?.schemaVersion!==1||data.language!=='zh-CN'||data.market!=='CN'||data.currency!=='CNY'||data.source!=='cardhobby'||data.priceKind!=='auction_end_price'||!data.cards||Array.isArray(data.cards)||!data.boxes||Array.isArray(data.boxes))throw Error('Invalid Chinese market');
    for(const [id,c] of Object.entries(data.cards)){
      if(c.sourceId!==id||!c.sourceSetCode||!c.number||!c.name||!c.variant||!c.grades||Object.entries(c.grades).some(([g,q])=>!['psa10','raw'].includes(g)||!validQuote(q)))throw Error('Invalid Chinese card quote');
    }
    for(const [code,entries] of Object.entries(data.boxes)){
      if(!/^CN-[A-Z0-9-]+$/.test(code)||!Array.isArray(entries)||entries.some(b=>b.targetId!=='BOX:'+code+':'+b.cardsPerPack||!Number.isSafeInteger(b.cardsPerPack)||b.cardsPerPack<1||typeof b.configurationVerified!=='boolean'||b.configurationVerified&&(!Number.isSafeInteger(b.packsPerBox)||b.packsPerBox<1)||!validQuote(b)))throw Error('Invalid Chinese box quote');
    }
    return data;
  }
  function ensureMarket(){
    if(!marketReady)marketReady=fetch('/data/chinese-market.json?v='+VERSION).then(r=>{if(!r.ok)throw Error();return r.json();}).then(prepareMarket).then(data=>{marketFailed=false;market=data;return data;}).catch(()=>{marketFailed=true;marketReady=null;market=null;return null;});
    return marketReady;
  }
  function cardQuotes(card){
    const entry=market?.cards?.[card.sourceId];
    return entry&&['sourceId','sourceSetCode','number','name','variant'].every(k=>entry[k]===card[k])?entry.grades:{};
  }
  function history(q,label){
    return '<details class="cn-auction-history"><summary>'+esc(label)+' 가격 기록 · '+q.totalAuctionCount+'건</summary><p>같은 날짜의 경매 종료가격 중간값 · 배송비 제외 · 원화는 현재 적용 환율로 환산합니다.</p><div class="cn-history-scroll"><table><thead><tr><th>경매 날짜</th><th>가격</th><th>경매</th><th>출처</th></tr></thead><tbody>'+q.history.slice().reverse().map(p=>'<tr><td>'+esc(marketDate(p.date))+'</td><td>'+price(p.priceMinor/100)+'</td><td>'+p.auctionCount+'건</td><td><a href="'+esc(p.sourceUrl)+'" target="_blank" rel="noopener noreferrer">보기 ↗</a></td></tr>').join('')+'</tbody></table></div></details>';
  }
  function unavailable(){return marketFailed?'가격 자료를 불러오지 못했어요. <button type="button" data-cn-price-retry>다시 불러오기</button>':'이번 수집에서 일치하는 가격 기록을 찾지 못했어요.';}
  function cardMarket(card){
    const grades=cardQuotes(card),main=grades.psa10||grades.raw,label=grades.psa10?'PSA 10':'A급(미감정)';
    return '<section class="px-price-box cn-price-box" aria-label="등급별 최근 경매 종료가"><div class="px-price-head"><div><div class="px-current-label">최근 경매 종료가'+(main?' · '+label:'')+'</div><div class="px-current">'+(main?price(main.priceMinor/100):'—')+'</div></div><div class="px-source">'+(main?'카드하비 · '+esc(marketDate(main.date)):'가격 미확보')+'</div></div><div class="px-grades">'+[['psa10','PSA 10'],['raw','A급(미감정)']].map(([g,n])=>'<div class="px-grade"><span class="px-grade-label">'+n+'</span><span class="px-grade-price">'+(grades[g]?price(grades[g].priceMinor/100):'—')+'</span>'+(grades[g]?'<small>'+esc(marketDate(grades[g].date))+'</small>':'<small>가격 미확보</small>')+'</div>').join('')+'</div><p class="cn-price-note">'+(main?'배송비 제외 · 같은 날 경매 종료가격의 중간값. 등급과 상태는 판매자 표기 기준입니다.':unavailable())+'</p>'+(main?fxNoteHTML():'')+[['psa10','PSA 10'],['raw','A급(미감정)']].filter(([g])=>grades[g]).map(([g,n])=>history(grades[g],n)).join('')+'</section>';
  }
  function boxMarket(set){
    const entries=market?.boxes?.[set.code]||[];
    return '<section class="cn-market"><h4>미개봉 박스 경매 가격</h4>'+(entries.length?fxNoteHTML()+entries.map(b=>'<div class="cn-box-quote"><strong>'+b.cardsPerPack+'장 팩 형식'+(b.packsPerBox?' · '+b.packsPerBox+'팩 / 박스':'')+'</strong><div class="cn-box-price">'+price(b.priceMinor/100)+'</div><p>'+esc(marketDate(b.date))+' · 카드하비 · 배송비 제외</p>'+(!b.configurationVerified?'<p class="cn-config-pending">구성 확인 필요 · 박스당 팩 수 미확인'+(b.sellerReportedPacksPerBox?' (일부 판매자 '+b.sellerReportedPacksPerBox+'팩 표기)':'')+'. 경매 참고 기록입니다.'+(auctionURL(b.sellerConfigurationSourceUrl)?' <a href="'+esc(b.sellerConfigurationSourceUrl)+'" target="_blank" rel="noopener noreferrer">판매자 구성 ↗</a>':'')+'</p>':'<p class="cn-config-verified">박스 구성 확인됨'+(official(b.configurationSourceUrl)?' · <a href="'+esc(b.configurationSourceUrl)+'" target="_blank" rel="noopener noreferrer">공식 구성 ↗</a>':'')+'</p>')+history(b,b.cardsPerPack+'장 팩 박스')+'</div>').join(''):'<p>가격 미확보 · '+unavailable()+'</p>')+'</section>';
  }
  function prepareCards(data,code){
    if(data?.schemaVersion!==1||data.language!=='zh-CN'||data.code!==code||data.complete!==true||!Array.isArray(data.cards)||!data.cards.length||data.cardCount!==data.cards.length||data.expectedCardCount!==data.cardCount)throw Error('Incomplete Chinese card set');
    const ids=new Set();
    for(const card of data.cards){
      const id=cardId(card);
      if(!id||ids.has(id)||!card.name||!card.number||!isImage(card.image)||(card.language&&card.language!=='zh-CN')||(card.setCode&&card.setCode!==code))throw Error('Invalid Chinese card');
      ids.add(id);card.id=id;
      card.searchText=normalize([name(card),card.name,card.nameEn,card.number,card.rarity,variantName(card),card.variant,...(card.aliases||[])].join(' '));
    }
    return data;
  }
  async function ensureCards(code){
    if(cardCache.has(code))return cardCache.get(code);
    const pending=fetch('/data/chinese-sets/'+encodeURIComponent(code)+'.json?v='+VERSION).then(r=>{if(!r.ok)throw Error();return r.json();}).then(data=>prepareCards(data,code)).catch(e=>{cardCache.delete(code);throw e;});
    cardCache.set(code,pending);return pending;
  }
  function ensureSearch(){
    if(!searchReady)searchReady=fetch('/data/chinese-search.json?v='+VERSION).then(r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{if(data?.schemaVersion!==1||data.language!=='zh-CN'||!Array.isArray(data.cards))throw Error('Invalid Chinese search');return data;}).catch(e=>{searchReady=null;throw e;});
    return searchReady;
  }
  function matching(sets,query){
    const words=String(query||'').trim().split(/\s+/).map(normalize).filter(Boolean);
    return sets.filter(set=>words.every(word=>set.searchText.includes(word)));
  }
  function searchPriceLabel(row){
    if(marketFailed)return '가격 조회 실패';
    if(row.kind==='box')return market?.boxes?.[row.setCode]?.length?'박스 가격 기록':'가격 미확보';
    const grades=cardQuotes(row);
    return grades.psa10?'PSA 10 가격 기록':grades.raw?'A급 가격 기록':'가격 미확보';
  }
  async function search(query,kind='all'){
    if(!String(query||'').trim())return [];
    const [data]=await Promise.all([ensureData(),ensureMarket()]),byCode=new Map(data.sets.map(s=>[s.code,s]));
    const boxes=kind==='card'?[]:matching(data.sets,query).map(set=>({id:set.code,setCode:set.code,kind:'box',language:'zh-CN',name:set.name,originalName:set.originalName,displayName:set.name,setName:set.name,thumbnailUrl:imageURL(set.image)}));
    if(kind==='box')return boxes.map(row=>({...row,priceLabel:searchPriceLabel(row)}));
    const index=await ensureSearch(),words=String(query).trim().split(/\s+/).map(normalize).filter(Boolean);
    const cards=index.cards.filter(c=>{const set=byCode.get(c.setCode);return set&&words.every(word=>normalize([c.nameKo,c.name,c.nameEn,c.number,c.rarity,variantName(c),c.variant,set.searchText,...(c.aliases||[])].join(' ')).includes(word));}).map(c=>({...c,id:cardId(c),kind:'card',language:'zh-CN',displayName:name(c),originalName:c.name,setName:byCode.get(c.setCode).name,thumbnailUrl:imageURL(c.image)}));
    return [...boxes,...cards].map(row=>({...row,priceLabel:searchPriceLabel(row)}));
  }
  function href(row){const query=new URLSearchParams({set:typeof row==='string'?row:row.setCode||row.code});if(typeof row!=='string'&&row.kind==='card')query.set('card',cardId(row));return '/?'+query+'#cardinfo';}
  function pagination(current,total,attribute='data-cn-page'){
    const first=Math.max(1,Math.min(current-2,total-4));
    const button=(n,label,text,disabled=false)=>'<button type="button" '+attribute+'="'+n+'" aria-label="'+label+'" '+(disabled?'disabled':'')+'>'+text+'</button>';
    return button(1,'처음 페이지','«',current===1)+button(current-1,'이전 페이지','‹',current===1)+Array.from({length:Math.min(5,total)},(_,i)=>first+i).map(n=>'<button type="button" '+attribute+'="'+n+'" aria-label="'+n+'페이지" '+(n===current?'aria-current="page"':'')+'>'+n+'</button>').join('')+button(current+1,'다음 페이지','›',current===total)+button(total,'마지막 페이지','»',current===total);
  }
  async function render(){
    const own=++renderRequest,list=document.getElementById('cardInfoList');if(!list)return;
    list.classList.add('enc-set-list');
    if(!catalog)list.innerHTML='<p role="status">중판 박스 목록 불러오는 중…</p>';
    try{
      const [data]=await Promise.all([ensureData(),ensureMarket()]);
      if(own!==renderRequest||CI_TAB!=='pokemon'||list.dataset.catalogLanguage!=='zh-CN')return;
      const query=String(CI_QUERY||'');if(query!==lastQuery){page=1;lastQuery=query;}
      const sets=matching(data.sets,query),total=Math.max(1,Math.ceil(sets.length/PAGE_SIZE));page=Math.max(1,Math.min(page,total));
      list.innerHTML='<p class="cn-catalog-note">중국 본토 간체판 · 확장팩 '+data.sets.length+'종</p>'+sets.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE).map(set=>'<button type="button" class="set-tile enc-set cn-set" data-cn-set="'+esc(set.code)+'" aria-label="'+esc(set.name)+' 중판 수록 카드"><span class="set-tile-img">'+image(set.image,set.originalName)+'</span><span class="set-tile-body"><span class="set-tile-code">중판 · '+esc(set.series||'포켓몬')+'</span><span class="set-tile-name">'+esc(set.name)+'</span><span class="set-tile-meta">'+esc(set.originalName)+'</span><span class="set-tile-meta">발매일: '+esc(set.release||'미확인')+(set.cardCount?' · '+set.cardCount+'종':'')+'</span><span class="cn-tile-market">'+(market?.boxes?.[set.code]?.length?'박스 경매 가격 기록 있음':'박스 가격 미확보')+'</span></span></button>').join('')+(!sets.length?'<p>검색 결과가 없습니다.</p>':'')+(total>1?'<nav class="ci-panel-pages enc-pages" aria-label="중판 확장팩 페이지 이동">'+pagination(page,total)+'</nav>':'');
    }catch{
      if(own===renderRequest&&CI_TAB==='pokemon'&&list.dataset.catalogLanguage==='zh-CN')list.innerHTML='<p>중판 목록을 불러오지 못했습니다. <button type="button" data-cn-retry>다시 시도</button></p>';
    }
  }
  const icon=n=>'<svg class="px-icon" viewBox="0 0 24 24" aria-hidden="true">'+({back:'<path d="m15 5-7 7 7 7"/>',expand:'<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',share:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>'})[n]+'</svg>';
  function header(back=false){return '<div class="ci-panel-head">'+(back?'<button type="button" data-cn-back aria-label="수록 카드로 돌아가기">'+icon('back')+'</button>':'')+'<button type="button" data-cn-expand aria-label="패널 전체화면 전환">'+icon('expand')+'</button><span class="enc-head-space"></span><button type="button" data-cn-share aria-label="중판 '+(back?'카드':'확장팩')+' 정보 공유">'+icon('share')+'</button><button type="button" data-cn-close aria-label="중판 정보 닫기">'+icon('close')+'</button></div>';}
  function panel(html,title='cnPanelTitle'){
    const expanded=document.getElementById('anyModal')?.classList.contains('ci-expanded');openAnyModal(html,'wide');
    const modal=document.getElementById('anyModal');modal.classList.add('ci-panel','cn-panel');modal.classList.toggle('ci-expanded',!!expanded);modal._ciOpener=opener;
    const box=modal.querySelector('.modal-box');box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-labelledby',title);
    modal.querySelector('[data-cn-expand]')?.setAttribute('aria-pressed',String(!!expanded));modal.querySelector('button')?.focus({preventScroll:true});
  }
  function variants(set){
    const entries=set.variants||[],hasPrice=v=>Number.isFinite(v.msrpCny)&&v.msrpCny>0&&v.msrpUnit;
    return (entries.some(hasPrice)?fxNoteHTML():'')+entries.map(v=>{
      const rows=[['팩당 카드',Number.isSafeInteger(v.cardsPerPack)&&v.cardsPerPack>0?v.cardsPerPack+'장':null],['박스당 팩',Number.isSafeInteger(v.packsPerBox)&&v.packsPerBox>0?v.packsPerBox+'팩':null],['구성',v.contents],['공식 권장가',hasPrice(v)?v.msrpCny:null]];
      return '<section class="cn-variant"><h4>'+esc(v.name||'상품 구성')+'</h4><dl>'+rows.filter(([,value])=>value).map(([label,value])=>'<div><dt>'+label+'</dt><dd>'+(label==='공식 권장가'?price(value,v.msrpUnit):esc(value))+'</dd></div>').join('')+'</dl></section>';
    }).join('');
  }
  function setBody(){
    if(!active||!document.getElementById('cnCardGrid'))return;
    const words=String(cardQuery).trim().split(/\s+/).map(normalize).filter(Boolean),filtered=active.cards.filter(c=>words.every(w=>c.searchText.includes(w))),total=Math.max(1,Math.ceil(filtered.length/CARDS_PER_PAGE));cardPage=Math.max(1,Math.min(cardPage,total));
    document.getElementById('cnCardGrid').innerHTML=filtered.slice((cardPage-1)*CARDS_PER_PAGE,cardPage*CARDS_PER_PAGE).map(c=>'<button type="button" class="set-card-item enc-card cn-card" data-cn-card="'+esc(c.id)+'" aria-label="'+esc(name(c)+' '+c.number+' '+variantName(c)+' 카드 정보')+'"><span class="set-card-img enc-card-image">'+art(c)+'</span><span class="set-card-num"><strong>'+esc(name(c))+'</strong><span>'+esc(c.number)+' · '+esc(c.rarity||'—')+'</span>'+(c.variant?'<span class="cn-card-variant">'+esc(variantName(c))+'</span>':'')+'</span></button>').join('')||'<p>검색 결과가 없습니다.</p>';
    document.getElementById('cnCardPages').innerHTML=pagination(cardPage,total,'data-cn-card-page');
    document.getElementById('cnCardCount').innerHTML='총 '+(active.printedCardCount||new Set(active.cards.map(c=>c.number)).size)+'개 번호 · 버전 '+active.cardCount+'종'+(words.length?' · 검색 '+filtered.length+'장':'')+'<span>카드를 누르면 상세 정보를 볼 수 있어요 · '+cardPage+' / '+total+' 페이지</span>';
  }
  function setModal(restore=false){
    const previous=currentCard;currentCard=null;
    panel(header()+'<div class="ci-panel-info">'+image(active.image,active.originalName,'ci-panel-thumb')+'<div class="ci-panel-copy"><span class="ci-brand pokemon">포켓몬 · 중판</span><h3 id="cnPanelTitle">'+esc(active.name)+'</h3><p>'+esc(active.originalName)+'</p><p>발매일: '+esc(active.release||'미확인')+'</p></div></div><div class="ci-panel-scroll enc-scroll cn-scroll">'+(linkNotice?'<p class="cn-link-notice" role="status">'+esc(linkNotice)+'</p>':'')+boxMarket(active)+'<div class="ci-panel-summary" id="cnCardCount"></div><label class="enc-search">카드 검색<input id="cnCardSearch" type="search" placeholder="한글·중국어 이름 또는 번호" value="'+esc(cardQuery)+'"></label><div class="set-card-grid" id="cnCardGrid"></div><details class="cn-product-info"><summary>박스 구성·발매 정보</summary><p class="cn-description">'+esc(active.description||'중국 본토 간체판 확장팩입니다.')+'</p><div class="cn-variants">'+variants(active)+'</div><a class="cn-official" href="'+esc(active.sourceUrl)+'" target="_blank" rel="noopener noreferrer">공식 상품 소개 ↗</a></details></div><nav id="cnCardPages" class="ci-panel-pages" aria-label="수록 카드 페이지 이동"></nav>');setBody();
    if(restore){document.querySelector('#anyModal .cn-scroll').scrollTop=cardScroll;Array.from(document.querySelectorAll('[data-cn-card]')).find(b=>b.dataset.cnCard===previous?.id)?.focus({preventScroll:true});}
  }
  async function open(code,id=null){
    if(!/^CN-[A-Z0-9-]+$/.test(code))return;
    window.EnglishCatalog?.cancelPending?.();const own=++request;opener=document.activeElement;active=null;currentCard=null;linkNotice='';
    panel(header()+'<h3 id="cnPanelTitle" class="enc-loading-title">포켓몬 · 중판</h3><div class="ci-panel-scroll">수록 카드 불러오는 중…</div>');
    try{
      const data=await ensureData(),set=data.sets.find(s=>s.code===code);
      if(!set){if(own===request&&document.querySelector('#anyModal.open #cnPanelTitle'))panel(header()+'<h3 id="cnPanelTitle" class="enc-loading-title">확장팩을 찾지 못했습니다.</h3><div class="ci-panel-scroll">중판 박스 목록에서 확장팩을 선택해 주세요.</div>');return;}
      const [cards]=await Promise.all([ensureCards(code),ensureMarket()]);if(own!==request||!document.querySelector('#anyModal.open #cnPanelTitle'))return;
      active={...cards,...set,cards:cards.cards,cardCount:cards.cardCount};cardPage=1;cardQuery='';cardScroll=0;
      if(id&&!cards.cards.some(c=>c.id===String(id)))linkNotice='공유된 카드를 찾지 못했습니다. 이 확장팩의 카드 목록을 확인해 주세요.';
      setModal();if(id&&!linkNotice)detail(id);
    }catch{
      if(own===request&&document.querySelector('#anyModal.open #cnPanelTitle'))panel(header()+'<h3 id="cnPanelTitle" class="enc-loading-title">수록 카드를 불러오지 못했습니다.</h3><div class="ci-panel-scroll"><button type="button" data-cn-set="'+esc(code)+'"'+(id?' data-cn-card-id="'+esc(id)+'"':'')+'>다시 시도</button></div>');
    }
  }
  function detail(id){
    const c=active?.cards.find(c=>c.id===String(id));if(!c)return;
    cardScroll=document.querySelector('#anyModal .cn-scroll')?.scrollTop??cardScroll;currentCard=c;
    const rows=[['언어','중국 본토 간체판'],['카드 번호',c.number],['희귀도',c.rarity||'—'],['카드 버전',variantName(c)||'—'],['확장팩',active.name],['발매일',active.release||'미확인']];
    const source=sourceURL(c.sourceUrl)?c.sourceUrl:sourceURL(active.cardSourceUrl)?active.cardSourceUrl:null;
    panel(header(true)+'<div class="ci-panel-scroll enc-detail-scroll"><article class="px-detail enc-detail cn-detail"><section class="px-summary" aria-label="카드 기본 정보"><div class="px-art enc-detail-art">'+art(c)+'</div><div class="px-summary-main"><div class="px-summary-top"><span class="px-badge">포켓몬 · 중판</span></div><h1 class="px-title" id="cnCardTitle">'+esc(name(c))+'</h1>'+(name(c)!==c.name?'<p class="px-original">'+esc(c.name)+'</p>':'')+'<p class="px-pack">'+esc(active.name)+'</p><p class="px-pack">'+esc(c.number)+' · '+esc(c.rarity||'—')+(c.variant?' · '+esc(variantName(c)):'')+'</p></div><div class="px-actions"><button type="button" class="px-btn primary" data-cn-back>수록 카드 보기</button>'+(source?'<a class="px-btn" href="'+esc(source)+'" target="_blank" rel="noopener noreferrer">카드 원문 ↗</a>':'')+'</div></section><div class="px-content">'+cardMarket(c)+'<section><div class="px-section-head"><h2>카드 정보</h2></div><table class="px-table px-info"><tbody>'+rows.map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+esc(v)+'</td></tr>').join('')+'</tbody></table></section></div></article></div>','cnCardTitle');
  }
  async function share(){
    if(!active)return;const url=new URL(href(currentCard?{...currentCard,setCode:active.code,kind:'card'}:active.code),location.href).href;
    try{if(navigator.share)await navigator.share({title:currentCard?name(currentCard):active.name,url});else{await navigator.clipboard.writeText(url);showToast('링크를 복사했습니다');}}catch(e){if(e.name!=='AbortError')showToast('링크를 복사하지 못했습니다');}
  }
  window.addEventListener('tcg:fx-updated',refreshPrices);
  window.TCGFX?.ready?.then(refreshPrices).catch(()=>{});
  document.addEventListener('input',e=>{if(e.target.id==='cnCardSearch'){cardQuery=e.target.value;cardPage=1;setBody();}});
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-cn-set],[data-cn-page],[data-cn-card],[data-cn-card-page],[data-cn-back],[data-cn-close],[data-cn-expand],[data-cn-share],[data-cn-retry],[data-cn-price-retry]');if(!b||b.disabled)return;
    e.preventDefault();e.stopPropagation();
    if(b.hasAttribute('data-cn-price-retry')){const own=request;ensureMarket().then(()=>{if(own===request&&active){if(currentCard)detail(currentCard.id);else setModal();}});}
    else if(b.dataset.cnSet)open(b.dataset.cnSet,b.dataset.cnCardId||null);
    else if(b.dataset.cnPage){page=Number(b.dataset.cnPage);render();document.getElementById('encLanguages')?.scrollIntoView({block:'start'});}
    else if(b.dataset.cnCard)detail(b.dataset.cnCard);
    else if(b.dataset.cnCardPage){cardPage=Number(b.dataset.cnCardPage);setBody();document.querySelector('#anyModal .cn-scroll').scrollTop=0;}
    else if(b.hasAttribute('data-cn-back'))setModal(true);
    else if(b.hasAttribute('data-cn-close')){request++;closeAnyModal();}
    else if(b.hasAttribute('data-cn-expand')){const on=document.getElementById('anyModal').classList.toggle('ci-expanded');b.setAttribute('aria-pressed',String(on));}
    else if(b.hasAttribute('data-cn-share'))share();
    else render();
  },true);
  const query=new URLSearchParams(location.search),code=query.get('set'),shared=code?.startsWith('CN-')&&location.hash==='#cardinfo';
  window.ChineseCatalog={prepare,prepareCards,prepareMarket,ensureMarket,cardQuotes,ensureData,ensureCards,ensureSearch,matching,search,href,isImage,art,render,open,detail,setBody,cancelPending(){request++;},initialLanguage:shared?'zh-CN':'ja'};
  if(shared){CI_TAB='pokemon';open(code,query.get('card'));}
})();
