/* Additional games live inside Card Information; printed identities stay intact. */
(() => {
  'use strict';
  // Japanese EB05 belongs to the existing One Piece card-information grid.
  if(typeof CARDINFO!=='undefined'&&Array.isArray(CARDINFO.onepiece)&&!CARDINFO.onepiece.some(set=>set.code==='EB05')){
    CARDINFO.onepiece.unshift({code:'EB05',name:'히로인즈 에디션 Vol.2 (Heroines Edition Vol.2)',release:'2026.10.31',boxId:'910479',image:'https://cdn.snkrdunk.com/upload_bg_removed/946f3236-1a32-4c20-bdaa-7a9484dde258.webp?size=l',url:'https://www.onepiece-cardgame.com/cardlist/?series=550205'});
  }

  if(window.TCGCardInfo||typeof renderCardInfo!=='function'||typeof openSetGrid!=='function')return;
  const GAMES={nikke:'니케',weiss_schwarz:'바이스슈발츠',union_arena:'유니온아레나',dragon_ball_fusion_world:'드래곤볼 퓨전월드',yugioh:'유희왕',digimon:'디지몬'};
  const PAGE_SIZE=18,SET_SIZE=24,VERSION='20261031-official-contents4',files=new Map(),pages=new Map(),seriesState=new Map(),languageState=new Map();
  let manifest=null,pendingManifest=null,listToken=0,session=0,priceToken=0,active=null,selected=null,cardQuery='',rarity='',cardPage=1,gridScroll=0,opener=null,entered=false,lastListQuery='';
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const compact=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[\s/_\-.]+/g,'');
  const isOwn=game=>Object.hasOwn(GAMES,game),ownTab=()=>typeof CI_TAB!=='undefined'&&isOwn(CI_TAB),modal=()=>document.getElementById('anyModal');
  const textMatch=(text,query)=>String(query||'').trim().split(/\s+/).every(word=>compact(text).includes(compact(word)));
  const url=value=>{try{const parsed=new URL(value);return parsed.protocol==='https:'&&!parsed.username&&!parsed.password?parsed.href:'';}catch{return '';}};
  function releaseText(value){const text=String(value||'');if(/^\d{4}-\d{2}-\d{2}$/.test(text))return text;const date=new Date(text);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date):text.slice(0,10);}
  function dataPath(value){return typeof value==='string'&&/^\/data\/tcg-card-info(?:\/[A-Za-z0-9_.-]+)*\.json$/.test(value)&&!value.split('/').some(part=>part==='.'||part==='..');}
  async function json(path){
    if(!dataPath(path))throw Error('Invalid catalogue path');
    if(!files.has(path)){files.set(path,fetch(path+'?v='+VERSION,{cache:'no-cache'}).then(async response=>{if(!response.ok)throw Error('Catalogue unavailable');return response.json();}).catch(error=>{files.delete(path);throw error;}));if(files.size>8)files.delete(files.keys().next().value);}
    return files.get(path);
  }
  function prepareManifest(data){
    if(data?.schemaVersion!==1||!Array.isArray(data.games))throw Error('Invalid catalogue manifest');
    const games=new Set();for(const game of data.games){if(!isOwn(game.id)||games.has(game.id)||!Array.isArray(game.sets))throw Error('Invalid catalogue game');games.add(game.id);const ids=new Set();for(const set of game.sets){if(!set.id||ids.has(String(set.id))||!dataPath(set.file)||!set.file.startsWith('/data/tcg-card-info/'+game.id+'/'))throw Error('Invalid set identity');ids.add(String(set.id));}const boxes=new Set();for(const box of game.boxes||[]){if(!String(box.id).startsWith('BOX:')||boxes.has(box.id)||!isOwn(box.sourceGame)||!Array.isArray(box.setIds)||new Set(box.setIds).size!==box.setIds.length||[...box.setIds,...(box.relatedSetIds||[])].some(id=>!ids.has(id)))throw Error('Invalid box membership');boxes.add(box.id);}}
    return data;
  }
  function ensureManifest(){if(manifest)return Promise.resolve(manifest);if(!pendingManifest)pendingManifest=json('/data/tcg-card-info.json').then(prepareManifest).then(data=>manifest=data).catch(error=>{pendingManifest=null;files.delete('/data/tcg-card-info.json');throw error;});return pendingManifest;}
  function bars(hide){
    const list=document.getElementById('cardInfoList');
    if(hide){entered=true;for(const id of ['rfLanguages','encLanguages','ciLanguageTabs']){const element=document.getElementById(id);if(element){if(!languageState.has(element))languageState.set(element,element.hidden);element.hidden=true;}}list?.classList.remove('enc-set-list','ck-set-list');list?.classList.add('tci-set-list');if(list)list.dataset.catalogLanguage='tcg-'+CI_TAB;}
    else if(entered){entered=false;for(const [element,hidden]of languageState)if(element.isConnected!==false)element.hidden=hidden;languageState.clear();list?.classList.remove('tci-set-list');if(list?.dataset.catalogLanguage?.startsWith('tcg-'))delete list.dataset.catalogLanguage;}
  }
  function cancelOld(){if(typeof CI_PANEL_REQUEST==='number')CI_PANEL_REQUEST++;window.EnglishCatalog?.cancelPending?.();window.ChineseCatalog?.cancelPending?.();window.ChiikawaCatalog?.close?.();if(modal()?.classList.contains('ci-panel')&&modal()?.classList.contains('open')&&!modal()?.querySelector('[data-tci-shell]'))closeAnyModal();}
  function invalidate(close=false){listToken++;session++;priceToken++;if(close&&modal()?.querySelector('[data-tci-shell]'))closeAnyModal();active=null;selected=null;}
  function selectTab(game){CI_TAB=game;document.querySelectorAll('#ciTabs [data-ci]').forEach(button=>{const on=button.dataset.ci===game;button.classList.toggle('active',on);button.setAttribute('aria-pressed',String(on));});bars(true);}
  function pager(page,total,attribute){return `<button type="button" ${attribute}="${page-1}"${page<=1?' disabled':''}>이전</button><span>${page} / ${total}</span><button type="button" ${attribute}="${page+1}"${page>=total?' disabled':''}>다음</button>`;}
  function seriesFilter(game){
    if(!['weiss_schwarz','union_arena'].includes(game.id))return '';
    const values=[...new Map((game.boxes||[]).map(box=>[box.seriesId,box.series])).entries()].sort((a,b)=>a[1].localeCompare(b[1],'ko'));
    return `<div class="tci-series-filter"><label for="tciSeries">작품 선택</label><select id="tciSeries"><option value="">전체 작품</option>${values.map(([id,label])=>`<option value="${esc(id)}"${seriesState.get(game.id)===id?' selected':''}>${esc(label)}</option>`).join('')}</select></div>`;
  }
  async function render(){
    if(!ownTab())return;bars(true);const gameId=CI_TAB,token=++listToken,list=document.getElementById('cardInfoList');if(!list)return;
    list.innerHTML='<p class="tci-message" role="status">수록 카드 목록을 불러오는 중…</p>';
    try{const data=await ensureManifest();if(token!==listToken||CI_TAB!==gameId)return;const game=data.games.find(item=>item.id===gameId),query=typeof CI_QUERY==='string'?CI_QUERY:'';
      const series=seriesState.get(gameId)||'',key=gameId+'|'+series+'|'+query;
      if(lastListQuery!==key){pages.set(gameId,1);lastListQuery=key;}
      // Card-image fallbacks and promotional groupings are never box tiles.
      const boxes=Array.isArray(game?.boxes)?game.boxes:[],sets=boxes.filter(set=>(!series||set.seriesId===series)&&textMatch([set.name,set.code,set.series,set.sourceGame,set.releasedAt].join(' '),query)),total=Math.max(1,Math.ceil(sets.length/SET_SIZE)),page=Math.min(pages.get(gameId)||1,total);pages.set(gameId,page);
      list.innerHTML=seriesFilter(game||{id:gameId})+`<div class="tci-list-note"><strong>${esc(series?boxes.find(box=>box.seriesId===series)?.series:GAMES[gameId])}</strong><span>${sets.length.toLocaleString()}개 박스 · 박스를 선택하면 봉입 카드가 열립니다</span></div>`+sets.slice((page-1)*SET_SIZE,page*SET_SIZE).map(set=>`<button type="button" class="set-tile tci-set" data-tci-set="${esc(set.id)}" data-tci-game="${esc(gameId)}"><span class="tci-cover">${url(set.image)?`<img src="${esc(url(set.image))}" alt="${esc(set.name)} 박스" loading="lazy" decoding="async">`:`<span class="tci-cover-fallback">박스 이미지 준비 중</span>`}</span><span class="set-tile-body"><span class="set-tile-code">${esc(set.code||GAMES[set.sourceGame]||'')}</span><span class="set-tile-name">${esc(set.name)}</span><span class="set-tile-meta">${set.cardCount?'등록 카드 '+Number(set.cardCount).toLocaleString()+'종':'봉입 카드 등록 준비 중'}${set.releasedAt&&String(set.releasedAt)>'1900'?' · '+esc(releaseText(set.releasedAt)):''}</span></span></button>`).join('')+(!sets.length?'<p class="tci-message">조건에 맞는 박스가 없습니다.</p>':'')+(total>1?`<nav class="tci-pager tci-list-pager" aria-label="박스 페이지">${pager(page,total,'data-tci-set-page')}</nav>`:'');
    }catch{if(token===listToken&&CI_TAB===gameId)list.innerHTML='<p class="tci-message">목록을 불러오지 못했습니다. <button type="button" data-tci-retry-list>다시 시도</button></p>';}
  }
  function owns(token=session){return token===session&&ownTab()&&active?.viewGame===CI_TAB&&modal()?.classList.contains('open')&&!!modal()?.querySelector('[data-tci-shell]');}
  function header(back=false){return `<div class="ci-panel-head tci-toolbar">${back?'<button type="button" data-tci-back aria-label="수록 카드로 돌아가기">←</button>':''}<span class="tci-toolbar-title">${esc(GAMES[active?.viewGame]||'카드 정보')}</span><button type="button" data-tci-expand aria-label="전체화면 전환">⛶</button><button type="button" data-tci-share aria-label="카드 정보 공유">공유</button><button type="button" data-tci-close aria-label="카드 정보 닫기">×</button></div>`;}
  function present(body,titleId){
    const expanded=modal()?.classList.contains('ci-expanded');cancelOld();openAnyModal(`<div class="tci-shell" data-tci-shell>${body}</div>`,'wide');const element=modal();element.classList.add('ci-panel');element.classList.toggle('ci-expanded',!!expanded);element._ciOpener=opener;
    const box=element.querySelector('.modal-box');box?.setAttribute('role','dialog');box?.setAttribute('aria-modal','true');box?.setAttribute('aria-labelledby',titleId);element.querySelector('[data-tci-close]')?.focus({preventScroll:true});
  }
  function art(card,large=false){const image=url(card.image||card.snkrProduct?.image||card.fallbackImage),fallback=url(card.fallbackImage);return `<span class="tci-art${large?' tci-art-large':''}">${image?`<img src="${esc(image)}"${fallback&&fallback!==image?` data-tci-fallback="${esc(fallback)}"`:''} alt="${esc(card.name)}" loading="lazy" decoding="async">`:'<span class="tci-no-image">이미지 없음</span>'}</span>`;}
  function numberText(card){return card.fullCardNumber||(card.numberStatus==='unprinted'?'번호 표기 없음':'번호 확인 중');}
  function rarityText(card){return card.rarityLabel||card.rarity||(card.rarityStatus==='not_applicable'?'희귀도 표기 없음':'희귀도 확인 중');}
  function cardMatches(card,id){return String(card.id)===String(id)||String(card.snkrdunkId)===String(id)||(Array.isArray(card.aliases)&&card.aliases.includes(String(id)));}
  function printedNumber(value,game){const n=String(value||'').normalize('NFKC').trim().toUpperCase();return game==='union_arena'?n.replace(/^((?:UA[0-9]+(?:BT|ST|DC)|EX[0-9]+BT|PC[0-9]+BT))-/,'$1/'):n;}
  function officialBinding(card){const p=card.snkrProduct,b=card.marketBinding;return card.catalogSource==='OFFICIAL'&&card.language==='ja'&&String(card.id).startsWith('official:'+card.game+':')&&b?.verified===true&&b.method==='exact-product-number-rarity-unique-variant'&&(!b.derivationMethod||(b.derivationMethod==='verified-unchanged-native-reprint'&&b.sourceNativeProductId===card.printingFamilyId&&b.sourceNativeProductId!==card.officialProductId&&b.sourceOfficialCardId===card.officialCardId))&&b.game===card.game&&b.officialProductId===card.officialProductId&&b.officialCardId===card.officialCardId&&b.fullCardNumber===card.fullCardNumber&&String(b.snkrdunkId)===String(card.snkrdunkId)&&String(p?.id)===String(card.snkrdunkId)&&p?.brand===card.game&&printedNumber(p?.fullCardNumber,card.game)===printedNumber(card.fullCardNumber,card.game);}
  function target(card){
    const exact=card.snkrProduct&&String(card.snkrProduct.id)===String(card.id),value={...card,brand:card.game,fullNumber:card.fullCardNumber,number:card.fullCardNumber,snkrProduct:card.snkrProduct,...(exact?{catalogSource:'SNKRDUNK',snkrdunkId:String(card.snkrProduct.id)}:{})};
    if(officialBinding(card)){
      const source={...value,fullNumber:card.snkrProduct.fullCardNumber},resolve=window.CardPriceFallback?.resolve;
      if(typeof resolve!=='function')return source;
      const quote=resolve(source);if(quote.status==='priced'&&quote.source==='snkrdunk')return source;
    }
    return value;
  }
  function coverageText(set){if(set.coverage==='official-edition-unverified')return '공식 재판 봉입 구성 확인 중 · 현재 등록된 카드';if(set.coverage==='official-not-published')return '공식 전체 카드 목록 공개 대기';if(set.coverage==='release-pending')return '출시 예정 · 수록 목록 확인 중';if(set.officialCatalogueComplete||set.officialMembershipComplete||set.officialComplete)return `공식 상품 목록 ${Number(set.officialCardCount||set.cardCount).toLocaleString()}종${set.marketSupplementCount?' · 대조 중인 시장 판본 '+Number(set.marketSupplementCount).toLocaleString()+'종':''}${set.officialCatalogueComplete&&!set.officialMembershipComplete?' · 봉입 규격 대조 중':''}`;if(set.coverage==='official-list-unavailable')return '공식 수록 목록 확인 중 · 현재 등록된 카드만 표시';return '수집된 카드 기준, 전체 목록과 다를 수 있습니다';}
  function priceHTML(result,compactView=true){
    if(window.CardPriceFallback?.render)return window.CardPriceFallback.render(result,{compact:compactView});
    if(result?.status==='priced'&&Number.isFinite(result.amount)&&result.amount>0){const value=result.currency==='KRW'?result.amount:window.TCGFX?.convert?.(result.amount,result.currency),price=Number.isFinite(value)&&value>0?'₩'+Math.floor(value).toLocaleString('ko-KR'):'환율 확인 중';return `<strong>${esc(price)}</strong><small>${esc(result.source||'SNKRDUNK')}</small>`;}
    return '<span class="tci-price-empty">가격 정보 없음</span>';
  }
  async function lookup(card,isCurrent){
    await window.TCGFX?.ready;
    if(window.CardPriceFallback?.lookup)return window.CardPriceFallback.lookup(target(card),{snkrProduct:card.snkrProduct,isCurrent});
    const product=card.snkrProduct||{},ask=product.catalogAsk;
    if(product.minPrice>0)return {status:'priced',amount:product.minPrice,currency:product.currency,source:'snkrdunk',sourceUrl:product.url,observedAt:product.priceCheckedAt};
    if(ask?.amount>0)return {status:'priced',amount:ask.amount,currency:ask.currency,source:'snkrdunk',sourceUrl:product.url,observedAt:ask.checkedAt};
    return {status:'none'};
  }
  async function fillPrices(cards,detail=false){
    const token=session,quoteToken=++priceToken,valid=()=>owns(token)&&quoteToken===priceToken;let index=0;
    async function worker(){while(index<cards.length&&valid()){const i=index++,card=cards[i];try{const result=await lookup(card,valid);if(!valid())return;const element=document.getElementById(detail?'tciDetailPrice':'tciPrice'+i);if(element)element.innerHTML=priceHTML(result,!detail);}catch{if(valid()){const element=document.getElementById(detail?'tciDetailPrice':'tciPrice'+i);if(element)element.innerHTML='<span class="tci-price-empty">가격 확인 지연</span>';}}}}
    await Promise.all(Array.from({length:Math.min(4,cards.length)},worker));
  }
  function gridBody(){
    if(!owns()||!active)return;const cards=active.showRelated?active.relatedCards:active.cards,rows=cards.filter(card=>(!rarity||(rarity==='__not_applicable'?card.rarityStatus==='not_applicable':card.rarity===rarity))&&textMatch([card.name,card.snkrProduct?.name,card.fullCardNumber,card.rarity,card.rarityLabel,card.game].join(' '),cardQuery)),total=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));cardPage=Math.min(cardPage,total);const visible=rows.slice((cardPage-1)*PAGE_SIZE,cardPage*PAGE_SIZE),grid=document.getElementById('tciCardGrid');if(!grid)return;
    grid.innerHTML=visible.map(card=>`<article class="set-card-item tci-card"><button type="button" class="tci-card-open" data-tci-card="${esc(card.id)}" aria-label="${esc(card.name)} ${esc(card.fullCardNumber)} 카드 정보">${art(card)}<span class="tci-card-number">${esc(numberText(card))}</span><strong>${esc(card.name)}</strong><span class="tci-card-meta">${esc(rarityText(card))}${(active.set.officialCatalogueComplete||active.set.officialMembershipComplete)&&card.catalogSource==='SNKRDUNK'?' · 시장 판본 대조 중':''}${active.viewGame==='nikke'?' · '+esc(GAMES[card.game]||card.game):''}</span></button></article>`).join('')||'<p class="tci-message">조건에 맞는 카드가 없습니다.</p>';
    const count=document.getElementById('tciCardCount');if(count)count.textContent=`${cards.length.toLocaleString()}개 ${active.showRelated?'관련 프로모':'등록 카드'}${active.total>active.cards.length?' / 총 '+active.total.toLocaleString()+'개':''} · 검색 ${rows.length.toLocaleString()}개`;const navigation=document.getElementById('tciCardPages');if(navigation)navigation.innerHTML=pager(cardPage,total,'data-tci-page');
  }
  function gridPanel(){
    if(!active)return;selected=null;present(`${header()}<div class="ci-panel-info tci-set-info">${active.box&&url(active.set.image)?`<img class="tci-box-thumbnail" src="${esc(url(active.set.image))}" alt="박스">`:''}<div><span class="tci-brand">${esc(GAMES[active.viewGame])}${active.box?' · '+esc(active.set.series||''):''}</span><h3 id="tciSetTitle">${esc(active.set.name)}</h3><p>${esc(active.set.code||'')} · ${active.box?'수록 카드':'등록된 수록 카드'} · ${esc(coverageText(active.set))}</p></div></div><div class="ci-panel-scroll tci-scroll">${active.relatedCards?.length?`<div class="tci-inclusion-tabs"><button type="button" class="tci-more" data-tci-inclusion="main" aria-pressed="${!active.showRelated}">상품 등록 카드 ${active.cards.length}</button><button type="button" class="tci-more" data-tci-inclusion="related" aria-pressed="${!!active.showRelated}">관련 프로모 ${active.relatedCards.length}</button></div>${active.showRelated?'<p class="tci-message">공식 목록에 연결된 프로모입니다. 박스 봉입 여부는 카드별로 확인이 필요합니다.</p>':''}`:''}<div id="tciCardCount" class="tci-count"></div><div class="tci-filters"><label>카드 검색<input id="tciCardSearch" type="search" value="${esc(cardQuery)}" placeholder="카드 이름 · 전체 카드 번호"></label><label>희귀도<select id="tciRarity"><option value="">전체</option>${[...new Set((active.showRelated?active.relatedCards:active.cards).map(card=>card.rarity).filter(Boolean))].sort().map(value=>`<option value="${esc(value)}"${value===rarity?' selected':''}>${esc(value)}</option>`).join('')}${(active.showRelated?active.relatedCards:active.cards).some(card=>card.rarityStatus==='not_applicable')?`<option value="__not_applicable"${rarity==='__not_applicable'?' selected':''}>표기 없음</option>`:''}</select></label></div><div class="set-card-grid tci-grid" id="tciCardGrid"></div>${active.parts.length?'<button type="button" class="tci-more" data-tci-more>추가 수록 카드 불러오기</button>':''}</div><nav class="ci-panel-pages tci-pager" id="tciCardPages" aria-label="수록 카드 페이지"></nav>`,'tciSetTitle');gridBody();const scroll=modal()?.querySelector('.tci-scroll');if(scroll)scroll.scrollTop=gridScroll;
  }
  function detail(id){
    if(!owns())return;const card=[...active.cards,...(active.relatedCards||[])].find(item=>cardMatches(item,id));if(!card)return;gridScroll=modal()?.querySelector('.tci-scroll')?.scrollTop||0;selected=card;
    const original=url(card.snkrProduct?.url||card.sourceUrl),language=card.language==='ja'?'일본어판':card.language==='en'?'영문판':'판본 확인 필요';
    present(`${header(true)}<div class="ci-panel-scroll tci-scroll"><article class="tci-detail">${art(card,true)}<div class="tci-detail-copy"><span class="tci-brand">${esc(GAMES[card.game]||card.game)} · ${esc(language)}</span><h3 id="tciCardTitle">${esc(card.name)}</h3><p class="tci-detail-number">${esc(numberText(card))}</p><p>${esc(rarityText(card))} · ${esc(active.set.name)}</p><div class="tci-price-host tci-detail-price" id="tciDetailPrice" aria-live="polite">가격 확인 중…</div>${original?`<a class="tci-original" href="${esc(original)}" target="_blank" rel="noopener noreferrer">원문 카드 보기 ↗</a>`:''}<p class="tci-detail-note">판본·희귀도·카드 상태를 함께 확인해 주세요.</p></div></article></div>`,'tciCardTitle');fillPrices([card],true);
  }
  function prepareSet(data,game,set){
    if(data&&Object.hasOwn(data,'bundleVersion')){const key=String(set.id);if(data.schemaVersion!==1||data.bundleVersion!==1||data.game!==game||!data.sets||typeof data.sets!=='object'||Array.isArray(data.sets)||['__proto__','prototype','constructor'].includes(key)||!Object.hasOwn(data.sets,key))throw Error('Invalid catalogue bundle');data=data.sets[key];}
    if(data?.schemaVersion!==1||data.game!==game||String(data.set?.id)!==String(set.id)||!Array.isArray(data.cards))throw Error('Set identity mismatch');
    const ids=new Set();for(const card of data.cards){if(!card.id||ids.has(String(card.id))||!isOwn(card.game)||typeof card.fullCardNumber!=='string'||(card.snkrProduct&&String(card.snkrProduct.id)!==String(card.id)&&!officialBinding(card)))throw Error('Invalid printed card identity');ids.add(String(card.id));}
    for(const part of data.shards||[])if(!dataPath(part)||!part.startsWith('/data/tcg-card-info/'+game+'/'))throw Error('Invalid set part');
    return {viewGame:game,set:{...set,...data.set},cards:data.cards.slice(),parts:[...(data.shards||[])],total:set.cardCount||data.cards.length};
  }
  async function open(game,setId,cardId=''){
    if(String(setId).startsWith('BOX:'))return openBox(game,setId,cardId);
    if(!isOwn(game))return;invalidate();cancelOld();selectTab(game);const token=++session;opener=document.activeElement;cardPage=1;cardQuery='';rarity='';gridScroll=0;
    active={viewGame:game,set:{name:GAMES[game]},cards:[],parts:[],total:0};present(`${header()}<h3 class="tci-message" id="tciSetTitle">수록 카드를 불러오는 중…</h3>`,'tciSetTitle');
    try{const data=await ensureManifest();if(!owns(token)||CI_TAB!==game)return;const gameData=data.games.find(item=>item.id===game),matches=(gameData?.sets||[]).filter(set=>String(set.id)===String(setId)||set.code===setId);if(matches.length!==1)throw Error('Set not found');const set=matches[0],body=await json(set.file);if(!owns(token)||CI_TAB!==game)return;const prepared=prepareSet(body,game,set);active=prepared;gridPanel();if(cardId){while(!active.cards.some(card=>cardMatches(card,cardId))&&active.parts.length&&token===session){if(!await more(false))break;}if(owns(token))detail(cardId);}}
    catch{if(owns(token)&&CI_TAB===game)present(`${header()}<h3 class="tci-message" id="tciSetTitle">카드를 불러오지 못했습니다.</h3><button class="tci-more" type="button" data-tci-set="${esc(setId)}" data-tci-game="${esc(game)}">다시 시도</button>`,'tciSetTitle');}
  }
  async function openBox(game,boxId,cardId=''){
    if(!isOwn(game))return;invalidate();cancelOld();selectTab(game);const token=++session;opener=document.activeElement;cardPage=1;cardQuery='';rarity='';gridScroll=0;
    active={viewGame:game,set:{name:GAMES[game]},cards:[],parts:[],total:0,box:true};present(`${header()}<h3 class="tci-message" id="tciSetTitle">봉입 카드를 불러오는 중…</h3>`,'tciSetTitle');
    try{
      const data=await ensureManifest();if(!owns(token))return;const gameData=data.games.find(item=>item.id===game),box=gameData?.boxes?.find(item=>item.id===boxId);if(!box||!Array.isArray(box.setIds))throw Error('Box not found');
      const members=[...new Set([...box.setIds,...(box.marketSetIds||[]),...(box.relatedSetIds||[])])].map(id=>gameData.sets.find(set=>set.id===id));if(members.some(set=>!set||set.sourceGame!==box.sourceGame))throw Error('Box membership mismatch');
      const supplements=new Set(box.marketCardIds||[]),relatedSets=new Set(box.relatedSetIds||[]);
      let index=0;const rows=new Map(),relatedRows=new Map();
      async function worker(){while(index<members.length&&owns(token)){const set=members[index++],first=prepareSet(await json(set.file),game,set);if(!owns(token))return;const parts=[first,...await Promise.all(first.parts.map(async path=>prepareSet(await json(path),game,set)))];if(!owns(token))return;for(const part of parts)for(const card of part.cards){if(card.game!==box.sourceGame)throw Error('Box card game mismatch');if((box.officialCatalogueComplete||box.officialMembershipComplete)&&card.catalogSource==='SNKRDUNK'&&!supplements.has(String(card.id)))continue;(relatedSets.has(set.id)?relatedRows:rows).set(String(card.id),card);}}}
      await Promise.all(Array.from({length:Math.min(4,members.length)},worker));if(!owns(token))return;
      active={viewGame:game,set:box,cards:[...rows.values()].sort((a,b)=>Number(!a.fullCardNumber)-Number(!b.fullCardNumber)||a.fullCardNumber.localeCompare(b.fullCardNumber,undefined,{numeric:true})||a.name.localeCompare(b.name)),parts:[],total:rows.size,box:true,relatedCards:[...relatedRows.values()],showRelated:!!cardId&&[...relatedRows.values()].some(card=>cardMatches(card,cardId))};gridPanel();if(!rows.size){const grid=document.getElementById('tciCardGrid');if(grid)grid.innerHTML='<p class="tci-message">이 박스의 봉입 카드는 등록 준비 중입니다.</p>';}if(cardId)detail(cardId);
    }catch{if(owns(token))present(`${header()}<h3 class="tci-message" id="tciSetTitle">봉입 카드를 불러오지 못했습니다.</h3><button class="tci-more" type="button" data-tci-set="${esc(boxId)}" data-tci-game="${esc(game)}">다시 시도</button>`,'tciSetTitle');}
  }
  async function more(show=true){
    if(!owns()||!active.parts.length)return;const token=session,path=active.parts[0],prior=active;try{const data=await json(path);if(!owns(token)||active!==prior)return;const prepared=prepareSet(data,active.viewGame,active.set),cards=prepared.cards;const ids=new Set(active.cards.map(card=>String(card.id)));for(const card of cards)if(!ids.has(String(card.id))){ids.add(String(card.id));active.cards.push(card);}active.parts.shift();if(show)gridPanel();return true;}catch{if(owns(token))window.showToast?.('추가 카드를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');return false;}}
  function close(){session++;priceToken++;if(modal()?.querySelector('[data-tci-shell]'))closeAnyModal();}
  function href(game,setId,cardId=''){const params=new URLSearchParams({brand:game,set:setId});if(cardId)params.set('card',cardId);return '/?'+params+'#cardinfo';}
  async function share(){if(!active)return;const address=new URL(href(active.viewGame,active.set.id,selected?.id||''),location.origin).href;try{if(navigator.share)await navigator.share({title:selected?.name||active.set.name,url:address});else{await navigator.clipboard.writeText(address);window.showToast?.('링크를 복사했습니다');}}catch{}}
  const previousRender=renderCardInfo,previousOpen=window.openSetGrid;
  renderCardInfo=function(...args){if(ownTab())return render();listToken++;bars(false);if(active){close();active=null;}return previousRender.apply(this,args);};
  window.openSetGrid=function(code,...args){if(/^(?:EN-|CN-|RB-EN-|CIKW\/)/.test(String(code))){session++;priceToken++;return previousOpen.apply(this,[code,...args]);}const explicit=String(code).match(/^TCGI:([a-z_]+):(.+)$/);if(explicit&&isOwn(explicit[1]))return open(explicit[1],explicit[2],args[0]||'');if(ownTab())return open(CI_TAB,code);session++;priceToken++;return previousOpen.apply(this,[code,...args]);};
  document.addEventListener('click',event=>{
    const tab=event.target?.closest?.('#ciTabs [data-ci]');if(tab){if(isOwn(tab.dataset.ci)){event.preventDefault();event.stopImmediatePropagation();invalidate(true);cancelOld();selectTab(tab.dataset.ci);render();}else if(entered){invalidate(true);bars(false);}return;}
    const button=event.target?.closest?.('[data-tci-inclusion],[data-tci-set],[data-tci-card],[data-tci-page],[data-tci-set-page],[data-tci-back],[data-tci-close],[data-tci-expand],[data-tci-share],[data-tci-more],[data-tci-retry-list]');if(!button||button.disabled)return;event.preventDefault();event.stopImmediatePropagation();
    if(button.dataset.tciInclusion){active.showRelated=button.dataset.tciInclusion==='related';rarity='';cardQuery='';cardPage=1;gridScroll=0;gridPanel();}else if(button.dataset.tciSet)open(button.dataset.tciGame||CI_TAB,button.dataset.tciSet);else if(button.dataset.tciCard)detail(button.dataset.tciCard);else if(button.dataset.tciPage){cardPage=Math.max(1,Number(button.dataset.tciPage)||1);gridScroll=0;gridBody();const scroll=modal()?.querySelector('.tci-scroll');if(scroll)scroll.scrollTop=0;}else if(button.dataset.tciSetPage){pages.set(CI_TAB,Math.max(1,Number(button.dataset.tciSetPage)||1));render();}else if(button.hasAttribute('data-tci-back'))gridPanel();else if(button.hasAttribute('data-tci-close'))close();else if(button.hasAttribute('data-tci-expand'))modal()?.classList.toggle('ci-expanded');else if(button.hasAttribute('data-tci-share'))share();else if(button.hasAttribute('data-tci-more'))more();else render();
  },true);
  document.addEventListener('input',event=>{if(event.target?.id==='tciCardSearch'&&!event.isComposing){cardQuery=event.target.value;cardPage=1;gridBody();}});
  document.addEventListener('error',event=>{const img=event.target;if(!img?.dataset?.tciFallback)return;const fallback=url(img.dataset.tciFallback);delete img.dataset.tciFallback;if(fallback)img.src=fallback;},true);
  document.addEventListener('compositionend',event=>{if(event.target?.id==='tciCardSearch'){cardQuery=event.target.value;cardPage=1;gridBody();}});
  document.addEventListener('change',event=>{if(event.target?.id==='tciRarity'){rarity=event.target.value;cardPage=1;gridBody();}else if(event.target?.id==='tciSeries'&&ownTab()){seriesState.set(CI_TAB,event.target.value);pages.set(CI_TAB,1);render();}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&owns()){event.preventDefault();event.stopImmediatePropagation();close();}},true);
  window.addEventListener('hashchange',()=>{if(location.hash!=='#cardinfo'&&active)close();});
  function deepLink(){if(location.hash!=='#cardinfo')return;const params=new URLSearchParams(location.search),game=params.get('brand');if(!isOwn(game))return;selectTab(game);if(params.get('set'))open(game,params.get('set'),params.get('card')||'');render();}
  window.TCGCardInfo=Object.freeze({render,open,detail,more,close,href,ensureManifest,prepareManifest,prepareSet,dataPath,textMatch,target,priceHTML,cancelPending(){invalidate();},state:()=>({game:CI_TAB,set:active?.set?.id||null,selected:selected?.id||null,page:cardPage,query:cardQuery})});
  deepLink();
})();

