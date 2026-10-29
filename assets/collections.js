/* Private card collections, scoped to the existing Card info collection tab. */
(function (root) {
  'use strict';
  const VERSION = '20261030-collections1';
  const PAGE_SIZE = 18;
  const MAX_SNAPSHOT = 5000;
  const CATALOG_URL = '/data/collections/catalog.json?v=' + VERSION;
  const CARD_KEY = /^cp1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const norm = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s._-]/g, '');
  const uniq = values => [...new Set(values)];
  const gameName = game => ({pokemon:'포켓몬',onepiece:'원피스',riftbound:'리프트바운드',chiikawa:'치이카와'}[game] || game || '카드');
  const languageName = language => ({ja:'일판',en:'영판','zh-CN':'중판',ko:'한판',all:'모든 언어'}[language] || language);
  const strings = value => Array.isArray(value) ? value.filter(x => typeof x === 'string') : [];
  function safeImage(value) {
    const text = String(value || '');
    if (/^\/(?:images|data)\//.test(text)) return text;
    if (/^images\//.test(text)) return '/' + text;
    try { const url = new URL(text); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; }
  }
  function safeSource(value) {
    try { const url = new URL(String(value || '')); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; }
  }
  function publicPath(value) {
    const text = typeof value === 'string' ? value : value && value.url;
    if (typeof text !== 'string' || !/^\/data\/collections\/[A-Za-z0-9_./-]+\.json(?:\?[^#]*)?$/.test(text) || text.includes('..')) throw new Error('카드 데이터 경로를 확인하지 못했습니다.');
    return text;
  }
  function normalizeCard(raw) {
    if (!raw || !CARD_KEY.test(raw.id) || !raw.game || !raw.language) return null;
    return {...raw, id:String(raw.id), name:String(raw.name || raw.nameOriginal || raw.number || '카드'), nameOriginal:String(raw.nameOriginal || ''), number:String(raw.number || ''), setCode:String(raw.setCode || ''), image:safeImage(raw.image), artistIds:strings(raw.artistIds), characterIds:strings(raw.characterIds), rarity:String(raw.rarity || ''), form:raw.form === 'mega' ? 'mega' : 'base'};
  }
  function entityLabel(entity) { return String(entity.ko || entity.nameKo || entity.name || ''); }
  function entityMatches(entity, query) { return norm([entity.name, entity.ko, entity.nameKo, entity.knownFor, ...strings(entity.aliases)].join(' ')).includes(norm(query)); }
  function filterScope(cards, scope) {
    const ids = new Set(scope.entityIds || []);
    return cards.filter(card => (scope.type !== 'character' || card.sourceOnly !== true || card.characterDiscoveryVerified === true) && (!scope.game || card.game === scope.game) && (scope.language === 'all' || !scope.language || card.language === scope.language) && (scope.includeMega !== false || card.form !== 'mega') && (scope.type === 'artist' ? card.artistIds.some(id => ids.has(id)) : card.characterIds.some(id => ids.has(id))));
  }
  const state = {tab:'artists',query:'',game:'all',entity:null,language:'all',includeMega:true,includeEvolution:false,ownedFilter:'all',cardQuery:'',page:1,loading:false,error:'',privateLoading:false,privateError:'',selected:null,collections:[],detail:null,busy:false};
  let catalog = null;
  let catalogPromise = null;
  const allCards = new Map();
  const shardPromises = new Map();
  const loadedShards = new Set();
  const details = new Map();
  const ownership = new Map();
  const ownershipPending = new Set();
  let owner = null;
  let accountEpoch = 0;
  let listRun = 0;
  let detailRun = 0;
  let viewRun = 0;
  let ownershipGeneration = 0;
  let refreshAfterMutation = false;
  const privateControllers = new Set();
  let host = null;
  let modal = null;
  let modalOpener = null;
  let pendingDialog = null;
  let modalGeneration = 0;
  let picker = null;
  const pickerRequests = new Map();
  const hiddenElements = new Map();
  const api = {VERSION, norm, filterScope, normalizeCard, sessionChanged};
  root.TCGCollections = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = {...api,_test:{privateRequest,entityMatches,safeImage,safeSource,spriteInfo,cardPicture,uuid,getOwner:() => owner,getEpoch:() => accountEpoch}};
  if (typeof document === 'undefined') return;

  function active() { return typeof CI_TAB !== 'undefined' && CI_TAB === 'collections'; }
  function inform(message, type = 'info') { if (typeof showToast === 'function') showToast(message, type); }
  function userId(user) { return user && (typeof user.id === 'string' || typeof user.id === 'number') ? String(user.id) : null; }
  function currentOwner() { try { return typeof CURRENT_USER === 'undefined' ? null : userId(CURRENT_USER); } catch (_) { return null; } }
  function sessionChanged(user) {
    const next = userId(user);
    if (next === owner) return;
    owner = next; accountEpoch++; listRun++; detailRun++; ownershipGeneration++;
    privateControllers.forEach(controller => controller.abort()); privateControllers.clear();
    ownership.clear(); ownershipPending.clear(); details.clear(); pickerRequests.clear();
    state.collections = []; state.detail = null; state.selected = null; state.privateError = ''; state.privateLoading = false; state.busy = false; refreshAfterMutation = false;
    closeModal();
    if (active()) { render(); if (owner && state.tab === 'personal') loadCollections(); else if (owner && state.entity) ensureVisibleOwnership(); }
  }
  function requireOwner() {
    if (owner) return true;
    closeModal();
    if (typeof openLoginModal === 'function') openLoginModal('컬렉션 저장과 보유 표시는 로그인이 필요합니다');
    return false;
  }
  function stale() { const error = new Error('계정이 변경되었습니다.'); error.stale = true; return error; }
  async function privateRequest(path, options = {}) {
    if (!owner) { const error = new Error('로그인이 필요합니다.'); error.status = 401; throw error; }
    const capturedOwner = owner, epoch = accountEpoch;
    const controller = new AbortController(); privateControllers.add(controller);
    const method = options.method || 'GET';
    try {
      const response = await fetch('/api' + path, {method, credentials:'include', cache:'no-store', signal:controller.signal, headers:{'X-Collection-Account':capturedOwner, ...(method !== 'GET' ? {'Content-Type':'application/json'} : {})}, ...(options.body === undefined ? {} : {body:JSON.stringify(options.body)})});
      const payload = await response.json().catch(() => ({}));
      if (epoch !== accountEpoch || owner !== capturedOwner) throw stale();
      if (!response.ok || payload.ok === false) {
        const error = new Error(response.status === 409 ? '다른 기기나 창에서 목록이 변경됐습니다. 최신 목록을 다시 확인해 주세요.' : response.status === 401 ? '로그인 상태를 다시 확인해 주세요.' : response.status === 503 ? '컬렉션 저장을 잠시 이용할 수 없습니다. 잠시 후 다시 시도해 주세요.' : String(payload.message || '요청을 완료하지 못했습니다. 다시 시도해 주세요.'));
        error.status = response.status; error.code = payload.error; throw error;
      }
      if (String(payload.accountId || '') !== capturedOwner) throw stale();
      return payload;
    } catch (error) {
      if (epoch !== accountEpoch || owner !== capturedOwner || error.name === 'AbortError') throw stale();
      if (error.status === 401) sessionChanged(null);
      throw error;
    } finally { privateControllers.delete(controller); }
  }
  async function ensureCatalog(force = false) {
    if (force) { catalog = null; catalogPromise = null; }
    if (catalog) return catalog;
    if (!catalogPromise) catalogPromise = fetch(CATALOG_URL, {credentials:'omit',cache:'no-cache'}).then(response => { if (!response.ok) throw new Error('컬렉션 목록을 불러오지 못했습니다.'); return response.json(); }).then(raw => {
      if (!raw || raw.schemaVersion !== 1 || typeof raw.version !== 'string' || !Array.isArray(raw.artists) || !Array.isArray(raw.characters) || !raw.shards || typeof raw.shards !== 'object') throw new Error('컬렉션 데이터 형식을 확인하지 못했습니다.');
      const entities = list => list.filter(entry => entry && typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.game === 'string').map(entry => ({...entry,cardIds:strings(entry.cardIds),aliases:strings(entry.aliases)}));
      catalog = {...raw,artists:entities(raw.artists),characters:entities(raw.characters)};
      return catalog;
    }).catch(error => { catalogPromise = null; throw error; });
    return catalogPromise;
  }
  async function loadShard(key) {
    if (loadedShards.has(key)) return;
    if (!shardPromises.has(key)) shardPromises.set(key, (async () => {
      await ensureCatalog();
      if (!catalog.shards[key]) return;
      const path = publicPath(catalog.shards[key]);
      const response = await fetch(path, {credentials:'omit',cache:'no-cache'});
      if (!response.ok) throw new Error('카드 목록을 불러오지 못했습니다.');
      let payload = await response.json();
      if (payload.format === 'packed-v1') {
        if (!root.CollectionCatalogCodec || typeof root.CollectionCatalogCodec.decodeShard !== 'function') throw new Error('카드 데이터를 불러올 준비가 되지 않았습니다. 새로고침해 주세요.');
        payload = root.CollectionCatalogCodec.decodeShard(payload);
      }
      if (!payload || payload.schemaVersion !== 1 || payload.version !== catalog.version || !Array.isArray(payload.cards)) throw new Error('새 카드 데이터가 갱신 중입니다. 잠시 후 새로고침해 주세요.');
      payload.cards.forEach(raw => { const card = normalizeCard(raw); if (card) allCards.set(card.id, card); });
      loadedShards.add(key);
    })().catch(error => { shardPromises.delete(key); throw error; }));
    return shardPromises.get(key);
  }
  async function ensureGame(game,language = 'all',profile = null) {
    await ensureCatalog();
    const declared = profile && strings(profile.shardKeys);
    const available = declared && declared.length ? declared.filter(key => catalog.shards[key]) : Object.keys(catalog.shards);
    const keys = available.filter(key => key.startsWith(game + '-') && (language === 'all' || key === game + '-' + language));
    for (let i = 0; i < keys.length; i += 2) await Promise.all(keys.slice(i,i + 2).map(loadShard));
  }
  async function ensureCardKeys(ids,snapshot) {
    await ensureCatalog();
    if (ids.every(id => allCards.has(id))) return;
    if (snapshot && snapshot.game) await ensureGame(snapshot.game,snapshot.language || 'all');
    if (ids.every(id => allCards.has(id))) return;
    for (const key of Object.keys(catalog.shards)) {
      if (!loadedShards.has(key)) await loadShard(key);
      if (ids.every(id => allCards.has(id))) return;
    }
  }
  function entity() { return state.entity && catalog ? catalog[state.entity.type === 'artist' ? 'artists' : 'characters'].find(item => item.id === state.entity.id) : null; }
  function scope() {
    const item = entity();
    if (!item) return null;
    const family = state.includeEvolution && state.entity.type === 'character' ? strings(item.evolutionIds || item.familyIds) : [];
    return {type:state.entity.type,entityIds:uniq([item.id,...family]),game:item.game,language:state.language,includeMega:state.includeMega};
  }
  function scopedCards() {
    if (state.tab === 'personal') return state.detail ? state.detail.cardKeys.map(id => allCards.get(id)).filter(Boolean) : [];
    const selectedScope = scope();
    return selectedScope ? filterScope([...allCards.values()],selectedScope) : [];
  }
  function cardState(id) { return ownership.get(id); }
  function shownCards() {
    const q = norm(state.cardQuery);
    return scopedCards().filter(card => (!q || norm(card.name + ' ' + card.nameOriginal + ' ' + card.number).includes(q)) && (state.ownedFilter === 'all' || (cardState(card.id) && (state.ownedFilter === 'owned' ? cardState(card.id).owned : !cardState(card.id).owned))));
  }
  function mergeOwnership(map) {
    if (!map || typeof map !== 'object') return;
    Object.entries(map).forEach(([id,value]) => { if (CARD_KEY.test(id) && value && Number.isSafeInteger(value.revision) && value.revision >= 0) ownership.set(id,{manualOwned:value.manualOwned === true,holdingOwned:value.holdingOwned === true,owned:value.owned === true,revision:value.revision}); });
  }
  async function ensureOwnership(ids) {
    if (!owner) return;
    const epoch = accountEpoch, generation = ownershipGeneration;
    const needed = uniq(ids).filter(id => CARD_KEY.test(id) && !ownership.has(id) && !ownershipPending.has(id));
    needed.forEach(id => ownershipPending.add(id));
    try {
      for (let i = 0; i < needed.length; i += 100) {
        const batch = needed.slice(i,i + 100);
        const payload = await privateRequest('/collection-ownership?cardKeys=' + encodeURIComponent(batch.join(',')));
        if (epoch !== accountEpoch || generation !== ownershipGeneration) throw stale();
        mergeOwnership(payload.ownership);
      }
      if (active() && epoch === accountEpoch && generation === ownershipGeneration) renderResultArea();
    } catch (error) { if (!error.stale && active()) inform(error.message, 'error'); }
    finally { if (epoch === accountEpoch && generation === ownershipGeneration) needed.forEach(id => ownershipPending.delete(id)); }
  }
  function refreshPrivateViews() {
    if (!owner || !active()) return;
    if (state.busy) { refreshAfterMutation = true; return; }
    if (pickerCurrent(picker)) {
      const context = picker;
      reloadPickerCollection(context).then(ok => { if (ok && pickerCurrent(context)) { render(); renderPicker(context); } }).catch(error => { if (pickerCurrent(context) && !error.stale) { context.error=error.message; renderPicker(context); } });
      return;
    }
    ownershipGeneration++; ownership.clear(); ownershipPending.clear(); listRun++; detailRun++;
    state.collections = state.collections.map(item => ({...item,ownedCount:undefined}));
    state.privateLoading = false;
    if (state.tab === 'personal') { state.detail = null; loadCollections(state.selected); }
    else { render(); ensureVisibleOwnership(); }
  }
  function ensureVisibleOwnership() {
    if (!owner || !active() || !state.entity || state.loading) return;
    const cards = scopedCards();
    const ids = state.ownedFilter === 'all' ? shownCards().slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE).map(card => card.id) : cards.map(card => card.id);
    ensureOwnership(ids);
  }
  function normalizeCollection(raw) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string' || !Number.isSafeInteger(raw.revision)) throw new Error('저장된 컬렉션을 확인하지 못했습니다.');
    return {...raw,cardKeys:Array.isArray(raw.cardKeys) ? uniq(raw.cardKeys.filter(id => typeof id === 'string' && CARD_KEY.test(id))) : undefined};
  }
  async function loadCollections(preferred) {
    if (!owner) { render(); return; }
    const run = ++listRun, epoch = accountEpoch;
    state.privateLoading = true; state.privateError = ''; render();
    try {
      const payload = await privateRequest('/collections?limit=50');
      if (run !== listRun || epoch !== accountEpoch) return;
      state.collections = (Array.isArray(payload.collections) ? payload.collections : []).map(normalizeCollection);
      const next = preferred || state.selected;
      state.selected = state.collections.some(item => item.id === next) ? next : state.collections[0] && state.collections[0].id;
      state.privateLoading = false; render();
      if (state.selected) await loadDetail(state.selected);
      else { state.detail = null; render(); }
    } catch (error) { if (!error.stale && run === listRun && epoch === accountEpoch) { state.privateLoading = false; state.privateError = error.message; render(); } }
  }
  async function loadDetail(id) {
    if (!owner) return;
    const run = ++detailRun, epoch = accountEpoch;
    state.selected = id; state.detail = null; state.privateLoading = true; state.privateError = ''; render();
    try {
      const payload = await privateRequest('/collections/' + encodeURIComponent(id));
      if (run !== detailRun || epoch !== accountEpoch) return;
      const result = normalizeCollection(payload.collection);
      mergeOwnership(result.ownership || payload.ownership);
      await ensureCardKeys(result.cardKeys || [],result.snapshot);
      if (run !== detailRun || epoch !== accountEpoch) return;
      details.set(result.id,result); state.detail = result; state.privateLoading = false; state.page = 1; render();
    } catch (error) { if (!error.stale && run === detailRun && epoch === accountEpoch) { state.privateLoading = false; state.privateError = error.message; render(); } }
  }
  function badge(game) { return '<span class="tcc-badge ' + esc(game) + '">' + esc(gameName(game)) + '</span>'; }
  function cover(item) { return safeImage(item.coverImage || item.coverCard && item.coverCard.image || (allCards.get(item.coverCardId || item.representative) || {}).image); }
  function picture(url,alt,classes = '') { return url ? '<img class="' + esc(classes) + '" src="' + esc(url) + '" alt="' + esc(alt) + '" loading="lazy">' : '<span class="tcc-placeholder ' + esc(classes) + '">이미지 확인 중</span>'; }
  function spriteInfo(raw) {
    if (!raw || !['col','row','cols','rows'].every(key => Number.isInteger(raw[key]))) return null;
    return raw.cols > 0 && raw.cols <= 100 && raw.rows > 0 && raw.rows <= 100 && raw.col >= 0 && raw.col < raw.cols && raw.row >= 0 && raw.row < raw.rows ? raw : null;
  }
  function cardPicture(card,alt,classes = '') {
    const image = safeImage(card && card.image), sprite = spriteInfo(card && card.sprite);
    if (!image || !sprite) return picture(image,alt,classes);
    return '<span class="tcc-sprite ' + esc(classes) + '" style="--tcc-cols:' + sprite.cols + ';--tcc-rows:' + sprite.rows + ';--tcc-col:' + sprite.col + ';--tcc-row:' + sprite.row + '"><img src="' + esc(image) + '" alt="' + esc(alt) + '" loading="lazy"></span>';
  }
  function profilePicture(item,alt,classes = '') { const known = item.coverCard || allCards.get(item.coverCardId || item.representative); return cardPicture(known && known.image ? known : {image:cover(item),sprite:item.coverSprite},alt,classes); }
  function entityTile(item,type) {
    const name = entityLabel(item), original = name !== item.name ? item.name : '';
    return '<button type="button" class="tcc-entity" data-tcc-entity="' + esc(item.id) + '" data-tcc-type="' + type + '"><div class="tcc-cover"><span class="tcc-cover-label">' + (type === 'artist' ? '대표 일러스트' : '캐릭터 카드') + '</span>' + profilePicture(item,name) + '</div><div class="tcc-entity-copy"><strong>' + esc(name) + '</strong><span class="tcc-name-original">' + esc(original) + '</span>' + (item.knownFor ? '<p class="tcc-known">' + esc(item.knownFor) + '</p>' : '') + '<small>' + esc(gameName(item.game)) + ' · ' + (item.cardIds.length ? '카드 모아보기' : '카드 정보 확인 중') + '</small></div></button>';
  }
  function entityRow(item,type) { const name = entityLabel(item); return '<button type="button" class="tcc-entity-row" data-tcc-entity="' + esc(item.id) + '" data-tcc-type="' + type + '">' + (cover(item) ? profilePicture(item, '') : '<span class="tcc-entity-initial">' + esc(name.slice(0,1)) + '</span>') + '<span><strong>' + esc(name) + '</strong><small>' + esc(item.name !== name ? item.name : item.knownFor || '') + '</small></span>' + badge(item.game) + '</button>'; }
  function directoryResults() {
    if (!catalog) return '';
    const type = state.tab === 'characters' ? 'character' : 'artist';
    const entries = catalog[type === 'artist' ? 'artists' : 'characters'];
    if (state.query.trim()) {
      const matched = entries.filter(item => (state.game === 'all' || item.game === state.game) && entityMatches(item,state.query));
      const pages = Math.max(1,Math.ceil(matched.length / 60)); state.page = Math.min(state.page,pages);
      return '<div class="tcc-section-head"><h3>검색 결과</h3><small>' + matched.length.toLocaleString('ko-KR') + '개</small></div>' + (matched.length ? '<div class="tcc-search-results">' + matched.slice((state.page - 1) * 60,state.page * 60).map(item => entityRow(item,type)).join('') + '</div>' + pagesMarkup(pages,'directory') : message('찾는 ' + (type === 'artist' ? '작가' : '캐릭터') + '가 없어요','한글 또는 영문 이름, 다른 표기로 검색해 보세요.'));
    }
    const featured = strings(catalog[type === 'artist' ? 'featuredArtists' : 'featuredCharacters']).map(id => entries.find(item => item.id === id)).filter(Boolean).filter(item => state.game === 'all' || item.game === state.game);
    const games = uniq(featured.map(item => item.game));
    return games.map(game => '<section><div class="tcc-section-head"><h3>' + esc(gameName(game)) + ' 추천 ' + (type === 'artist' ? '작가' : '캐릭터') + '</h3><small>' + (type === 'artist' ? '그림을 따라 모아보세요' : '좋아하는 캐릭터를 모아보세요') + '</small></div><div class="tcc-entity-grid">' + featured.filter(item => item.game === game).map(item => entityTile(item,type)).join('') + '</div></section>').join('') + '<p class="tcc-note">찾는 ' + (type === 'artist' ? '작가' : '캐릭터') + '가 있다면 위 검색창에서 이름을 입력해 보세요. 카드가 연결되지 않은 검색 결과는 확인된 출처를 안내합니다.</p>';
  }
  function directory() {
    const type = state.tab === 'characters' ? '캐릭터' : '작가';
    const games = uniq(catalog[state.tab === 'characters' ? 'characters' : 'artists'].map(item => item.game));
    return '<div class="tcc-tools"><div class="tcc-chips" aria-label="게임 선택">' + ['all',...games].map(game => '<button type="button" class="tcc-chip" data-tcc-game="' + esc(game) + '" aria-pressed="' + (state.game === game) + '">' + esc(game === 'all' ? '전체' : gameName(game)) + '</button>').join('') + '</div><label class="tcc-search"><span aria-hidden="true">⌕</span><input id="tccEntityQuery" type="search" placeholder="' + type + ' 이름 검색 · 한글, 영문" aria-label="' + type + ' 이름 검색" value="' + esc(state.query) + '" autocomplete="off"><button type="button" data-tcc-action="clear-query" aria-label="검색어 지우기">×</button></label></div><div id="tccDirectoryResults">' + directoryResults() + '</div>';
  }
  function message(title,body,action = '') { return '<div class="tcc-message"><strong>' + esc(title) + '</strong><p>' + esc(body) + '</p>' + action + '</div>'; }
  function entityScopeControls(item) {
    const languages = Object.keys(catalog.shards).filter(key => key.startsWith(item.game + '-')).map(key => key.slice(item.game.length + 1));
    const canEvolve = strings(item.evolutionIds || item.familyIds).some(id => id !== item.id);
    return '<div class="tcc-scope"><label>언어 <select data-tcc-language aria-label="카드 언어">' + ['all',...languages].map(language => '<option value="' + esc(language) + '" ' + (state.language === language ? 'selected' : '') + '>' + esc(languageName(language)) + '</option>').join('') + '</select></label>' + (state.entity.type === 'character' && item.game === 'pokemon' ? '<label class="tcc-toggle"><input type="checkbox" data-tcc-mega ' + (state.includeMega ? 'checked' : '') + '>메가 포함</label><label class="tcc-toggle"><input type="checkbox" data-tcc-evolution ' + (state.includeEvolution ? 'checked' : '') + (canEvolve ? '' : ' disabled') + '>진화계열 포함</label>' + (!canEvolve && item.taxonomyStatus !== 'verified' ? '<span>진화계열 정보 확인 중</span>' : '') : '') + '</div>';
  }
  function entityDetail() {
    const item = entity(); if (!item) return message('정보를 찾지 못했어요','목록으로 돌아가 다시 선택해 주세요.','<button type="button" class="tcc-button" data-tcc-action="back">목록으로</button>');
    const cards = scopedCards();
    const source = safeSource(item.sourceUrl);
    return '<button type="button" class="tcc-button quiet tcc-back" data-tcc-action="back">← ' + (state.entity.type === 'artist' ? '작가별 모음' : '캐릭터별 모음') + '</button><div class="tcc-detail-head">' + (cover(item) ? profilePicture(item,entityLabel(item),'tcc-detail-cover') : '') + '<div class="tcc-detail-copy">' + badge(item.game) + '<h3>' + esc(entityLabel(item)) + '</h3><small>' + esc(entityLabel(item) !== item.name ? item.name : '') + '</small>' + (item.knownFor ? '<p>' + esc(item.knownFor) + '</p>' : '') + '</div><button type="button" class="tcc-button primary" data-tcc-action="save-scope" ' + (state.loading || !cards.length || state.busy ? 'disabled' : '') + '>+ 이 범위로 컬렉션 만들기</button></div>' + (state.loading ? message('카드를 불러오는 중이에요','선택한 게임의 카드 정보를 확인하고 있습니다.') : entityScopeControls(item) + (cards.length ? resultSection() : message('연결된 카드가 아직 없어요','확인된 카드가 연결되면 이곳에서 모아볼 수 있습니다.',source ? '<a class="tcc-button" href="' + esc(source) + '" target="_blank" rel="noopener noreferrer">출처에서 확인 ↗</a>' : '')));
  }
  function ownedTabs() { return owner ? '<div class="tcc-owned-tabs" aria-label="보유 여부">' + [['all','전체'],['owned','보유'],['missing','미보유']].map(([key,label]) => '<button type="button" data-tcc-owned-filter="' + key + '" aria-pressed="' + (state.ownedFilter === key) + '">' + label + '</button>').join('') + '</div>' : '<button type="button" class="tcc-button quiet small" data-tcc-action="login">로그인하고 보유 표시</button>'; }
  function ownControl(card) {
    const sourceNote = card.printingStatus === 'provider-locale-unverified' ? '<small class="tcc-source-only">중국어 원문 · 실물 언어와 판본 확인 중</small>' : card.sourceOnly && card.characterDiscoveryVerified !== true ? '<small class="tcc-source-only">판본·자산 연결 확인 중 · 직접 체크 가능</small>' : card.sourceOnly ? '<small class="tcc-source-only">자산 연결 확인 중 · 직접 체크 가능</small>' : '';
    if (!owner) return sourceNote + '<button type="button" class="tcc-button quiet small" data-tcc-action="login">로그인하고 보유 표시</button>';
    const value = cardState(card.id);
    if (!value) return sourceNote + '<label class="tcc-own"><input type="checkbox" disabled>보유 확인 중</label>';
    return sourceNote + '<div><label class="tcc-own"><input type="checkbox" data-tcc-own="' + esc(card.id) + '" ' + (value.owned ? 'checked' : '') + (state.busy ? ' disabled' : '') + '>' + (value.owned ? '보유 중' : '보유 표시') + '</label>' + (value.holdingOwned ? '<span class="tcc-holding-source">보유자산 연결</span>' : '') + '</div>';
  }
  function cardMarkup(card) {
    return '<article class="tcc-card"><button type="button" class="tcc-card-art" data-tcc-card="' + esc(card.id) + '" aria-label="' + esc(card.name + ' ' + card.number + ' 카드 상세') + '">' + cardPicture(card,card.name) + '</button><div class="tcc-card-body"><strong class="tcc-card-title">' + esc(card.name) + '</strong><p class="tcc-card-meta">' + esc(languageName(card.language)) + ' · ' + esc(card.setCode) + ' · ' + esc(card.number) + (card.rarity ? ' · ' + esc(card.rarity) : '') + '</p><div class="tcc-card-actions">' + ownControl(card) + '<button type="button" class="tcc-button small" data-tcc-add="' + esc(card.id) + '" ' + (state.busy ? 'disabled' : '') + '>+ 컬렉션</button></div>' + (state.tab === 'personal' ? '<button type="button" class="tcc-remove" data-tcc-remove="' + esc(card.id) + '" ' + (state.busy ? 'disabled' : '') + '>이 목록에서 빼기</button>' : '') + '</div></article>';
  }
  function pagesMarkup(pages,kind = 'cards') {
    if (pages <= 1) return '';
    const first = Math.max(1,Math.min(state.page - 2,pages - 4));
    return '<nav class="tcc-pages" aria-label="페이지 이동"><button type="button" data-tcc-page="' + (state.page - 1) + '" data-tcc-page-kind="' + kind + '" ' + (state.page <= 1 ? 'disabled' : '') + ' aria-label="이전 페이지">‹</button>' + Array.from({length:Math.min(5,pages)},(_,i) => i + first).map(page => '<button type="button" data-tcc-page="' + page + '" data-tcc-page-kind="' + kind + '" ' + (page === state.page ? 'aria-current="page"' : '') + '>' + page + '</button>').join('') + '<button type="button" data-tcc-page="' + (state.page + 1) + '" data-tcc-page-kind="' + kind + '" ' + (state.page >= pages ? 'disabled' : '') + ' aria-label="다음 페이지">›</button></nav>';
  }
  function resultSection() { return '<div id="tccResultArea"></div>'; }
  function renderResultArea() {
    if (!host || !active()) return;
    const area = host.querySelector('#tccResultArea'); if (!area) return;
    const all = scopedCards(), shown = shownCards(), pages = Math.max(1,Math.ceil(shown.length / PAGE_SIZE)); state.page = Math.min(state.page,pages);
    const known = all.filter(card => ownership.has(card.id)), owned = known.filter(card => cardState(card.id).owned).length;
    const ownerText = owner ? known.length === all.length ? ' · 보유 ' + owned + '종' : ' · 보유 상태 확인 중' : '';
    area.innerHTML = '<label class="tcc-search" style="max-width:none;margin:0 0 14px"><span aria-hidden="true">⌕</span><input id="tccCardQuery" type="search" aria-label="현재 카드 목록 검색" placeholder="카드 이름 또는 번호 검색" value="' + esc(state.cardQuery) + '"></label><div class="tcc-result-head"><p><strong>' + all.length.toLocaleString('ko-KR') + '종</strong>' + ownerText + (shown.length !== all.length ? ' · ' + shown.length + '종 표시' : '') + '</p>' + ownedTabs() + '</div>' + (shown.length ? '<div class="tcc-card-grid">' + shown.slice((state.page - 1) * PAGE_SIZE,state.page * PAGE_SIZE).map(cardMarkup).join('') + '</div>' + pagesMarkup(pages) : message('조건에 맞는 카드가 없어요','카드 검색 또는 보유 필터를 바꿔보세요.')) + '<p class="tcc-note">보유 표시는 같은 카드가 담긴 다른 컬렉션에도 함께 적용됩니다.</p>';
  }
  function collectionTile(item) {
    const detail = details.get(item.id), coverCards = detail ? detail.cardKeys.map(id => allCards.get(id)).filter(Boolean).slice(0,3) : [];
    const total = Number.isFinite(item.itemCount) ? item.itemCount : detail && detail.cardKeys.length;
    const owned = Number.isFinite(item.ownedCount) ? item.ownedCount : null;
    const progress = total && owned !== null ? Math.round(owned / total * 100) : 0;
    return '<button type="button" class="tcc-collection" data-tcc-collection="' + esc(item.id) + '" aria-pressed="' + (state.selected === item.id) + '"><div class="tcc-fan">' + (coverCards.length ? coverCards.map(card => cardPicture(card,'')).join('') : '<span>나만의 수집 목표</span>') + '</div><strong>' + esc(item.title) + '</strong><small>' + (total !== undefined && owned !== null ? '보유 ' + owned + ' / ' + total + '종 · ' + progress + '%' : '보유 상태 확인 중') + '</small><div class="tcc-progress" aria-hidden="true"><span style="width:' + progress + '%"></span></div></button>';
  }
  function personal() {
    if (!owner) return message('내 취향대로 컬렉션을 만들어 보세요','로그인하면 기기를 바꿔도 나의 수집 목표와 보유 표시를 이어서 볼 수 있습니다.','<button type="button" class="tcc-button primary" data-tcc-action="login">로그인하기</button>');
    const detail = state.detail;
    let html = '<div class="tcc-personal-head"><h3>나만의 컬렉션</h3><button type="button" class="tcc-button primary" data-tcc-action="new-empty" ' + (state.busy ? 'disabled' : '') + '>+ 새 컬렉션</button></div>';
    if (state.privateError) html += '<div class="tcc-status error" role="alert">' + esc(state.privateError) + '</div><button type="button" class="tcc-button" data-tcc-action="reload-private">다시 불러오기</button>';
    if (state.collections.length) html += '<div class="tcc-collections-grid">' + state.collections.map(collectionTile).join('') + '</div>';
    if (state.privateLoading) return html + message('컬렉션을 불러오는 중이에요','저장된 카드와 보유 상태를 확인하고 있습니다.');
    if (!state.collections.length && !state.privateError) return html + message('첫 컬렉션을 만들어 보세요','작가별·캐릭터별 모음에서 원하는 범위를 담거나 직접 카드를 골라 시작할 수 있어요.');
    if (!detail) return html;
    const total = detail.cardKeys.length, owned = detail.cardKeys.filter(id => cardState(id) && cardState(id).owned).length, percent = total ? Math.round(owned / total * 100) : 0;
    html += '<div class="tcc-personal-detail"><div><h3>' + esc(detail.title) + '</h3><p>비공개 · 보유 ' + owned + ' / ' + total + '종</p><div class="tcc-detail-tools"><button type="button" class="tcc-button primary small" data-tcc-action="find-cards" ' + (state.busy ? 'disabled' : '') + '>카드 찾아 추가</button><button type="button" class="tcc-button small" data-tcc-action="rename" ' + (state.busy ? 'disabled' : '') + '>이름 수정</button><button type="button" class="tcc-button small" data-tcc-action="delete" ' + (state.busy ? 'disabled' : '') + '>컬렉션 삭제</button></div></div><strong class="tcc-percent">' + percent + '%</strong></div>';
    if (detail.snapshot && detail.snapshot.kind !== 'manual') html += '<p class="tcc-note">생성할 때 선택한 카드 범위를 저장한 컬렉션입니다. 새 카드가 생겨도 목록이 자동으로 바뀌지 않습니다.</p>';
    if (total && scopedCards().length !== total) html += '<p class="tcc-note">현재 카드 정보에서 ' + (total - scopedCards().length) + '종을 확인하지 못했습니다. 저장된 목록은 유지됩니다.</p>';
    return html + (total ? resultSection() : message('카드를 담아 보세요','위의 카드 찾아 추가에서 원하는 카드를 검색해 직접 담아보세요.'));
  }
  function render() {
    if (!host || !active()) return;
    let body;
    if (!catalog) body = state.error ? message('컬렉션을 불러오지 못했어요',state.error,'<button type="button" class="tcc-button" data-tcc-action="retry">다시 시도</button>') : message('컬렉션을 준비하는 중이에요','카드와 작가 정보를 확인하고 있습니다.');
    else body = state.tab === 'personal' ? personal() : state.entity ? entityDetail() : directory();
    host.innerHTML = '<div class="tcc-intro"><h2>컬렉션</h2><p>좋아하는 그림과 캐릭터를 따라, 나만의 컬렉션을 만들어 보세요.</p></div><nav class="tcc-tabs" aria-label="컬렉션 메뉴">' + [['artists','작가별 모음'],['characters','캐릭터별 모음'],['personal','나만의 컬렉션']].map(([key,label]) => '<button type="button" data-tcc-tab="' + key + '" aria-pressed="' + (state.tab === key) + '">' + label + '</button>').join('') + '</nav>' + (state.error && catalog ? '<div class="tcc-status error" role="alert">' + esc(state.error) + '</div>' : '') + body;
    renderResultArea();
  }
  function hideForeignUI() {
    document.body.classList.add('tcc-collections-active');
    ['cardInfoList','cardInfoSearchWrap','cardInfoSrc','rfLanguages','encLanguages','ciLanguageTabs'].forEach(id => { const node = document.getElementById(id); if (node) { if (!hiddenElements.has(node)) hiddenElements.set(node,node.hidden); node.hidden = true; } });
    if (host) host.hidden = false;
  }
  function restoreForeignUI() { document.body.classList.remove('tcc-collections-active'); hiddenElements.forEach((value,node) => { node.hidden = value; }); hiddenElements.clear(); if (host) host.hidden = true; closeModal(); }
  async function show() {
    hideForeignUI(); render();
    try { await ensureCatalog(); if (!active()) return; state.error = ''; render(); if (owner) refreshPrivateViews(); }
    catch (error) { if (active()) { state.error = error.message; render(); } }
  }
  async function openEntity(type,id) {
    state.entity = {type,id};
    const selected = entity(), game = selected && selected.game;
    const available = game ? Object.keys(catalog.shards).filter(key => key.startsWith(game + '-')).map(key => key.slice(game.length + 1)) : [];
    const coverLanguage = selected && (selected.coverLanguage || selected.coverCard && selected.coverCard.language);
    state.language = available.includes(coverLanguage) ? coverLanguage : available.includes('ja') ? 'ja' : available[0] || 'all';
    state.includeMega = true; state.includeEvolution = false; state.ownedFilter = 'all'; state.cardQuery = ''; state.page = 1; state.loading = true; state.error = '';
    const run = ++viewRun; render();
    try { const item = entity(); if (!item) throw new Error('선택한 정보를 찾지 못했습니다.'); await ensureGame(item.game,state.language,item); if (run !== viewRun || !active()) return; state.loading = false; render(); ensureVisibleOwnership(); }
    catch (error) { if (run === viewRun && active()) { state.loading = false; state.error = error.message; render(); } }
  }
  function resetScope() { state.page = 1; state.ownedFilter = 'all'; render(); ensureVisibleOwnership(); }
  async function changeLanguage(language) {
    const item = entity(); if (!item) return;
    state.language = language; state.loading = true; state.page = 1; state.ownedFilter = 'all'; state.error = '';
    const run = ++viewRun; render();
    try { await ensureGame(item.game,language,item); if (run !== viewRun || !active()) return; state.loading = false; render(); ensureVisibleOwnership(); }
    catch (error) { if (run === viewRun && active()) { state.loading = false; state.error = error.message; render(); } }
  }
  function modalHead(title) { return '<div class="tcc-modal-head"><h3 id="tccModalTitle">' + esc(title) + '</h3><button type="button" class="tcc-modal-close" data-tcc-action="close-modal" aria-label="닫기">×</button></div>'; }
  function openModal(html) {
    if (!modal) { modal = document.createElement('div'); modal.className = 'tcc-modal-overlay'; modal.hidden = true; document.body.append(modal); modal.addEventListener('click',event => { if (event.target === modal) closeModal(); }); modal.addEventListener('click',handleClick); modal.addEventListener('submit',handleSubmit); modal.addEventListener('input',pickerInput); modal.addEventListener('change',pickerChange); }
    modalGeneration++; picker = null;
    modalOpener = document.activeElement;
    modal.innerHTML = '<section class="tcc-modal" role="dialog" aria-modal="true" aria-labelledby="tccModalTitle">' + html + '</section>'; modal.hidden = false;
    modal.querySelector('input,select,button')?.focus();
  }
  function closeModal() { modalGeneration++; picker = null; if (modal) { modal.hidden = true; modal.innerHTML = ''; } pendingDialog = null; modalOpener?.focus?.(); }
  function uuid() {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      root.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2,'0'));
      return hex.slice(0,4).join('') + '-' + hex.slice(4,6).join('') + '-' + hex.slice(6,8).join('') + '-' + hex.slice(8,10).join('') + '-' + hex.slice(10).join('');
    }
    throw new Error('안전한 연결에서 다시 시도해 주세요.');
  }
  // The manual picker uses baseline cards independently of entity metadata.
  function pickerShardEntries() {
    const known = uniq(['pokemon','onepiece','riftbound','chiikawa',...catalog.artists.map(item => item.game),...catalog.characters.map(item => item.game)]).sort((a,b) => b.length-a.length);
    return Object.keys(catalog.shards).map(key => {
      const game = known.find(value => key.startsWith(value + '-')) || key.split('-')[0];
      return {key,game,language:key.slice(game.length + 1)};
    });
  }
  function pickerLanguages(game) { return uniq(pickerShardEntries().filter(item => game === 'all' || item.game === game).map(item => item.language)); }
  function pickerCurrent(context) {
    return !!context && picker === context && pendingDialog === context && !!modal && !modal.hidden &&
      context.owner === owner && context.epoch === accountEpoch && context.modalGeneration === modalGeneration &&
      state.tab === 'personal' && state.selected === context.id && state.detail && state.detail.id === context.id;
  }
  function pickerCards(context) {
    const query = norm(context.query), names = root.JapaneseCardNames;
    return [...allCards.values()].filter(card => {
      if (card.retired === true || (card.sourceOnly === true && card.characterDiscoveryVerified !== true) ||
          (context.game !== 'all' && card.game !== context.game) ||
          (context.language !== 'all' && card.language !== context.language)) return false;
      if (!query) return true;
      let text = context.searchIndex.get(card.id);
      if (!text) {
        text = {base:norm([card.name,card.nameOriginal,card.number,card.setCode,card.nameKo,card.name_ko,card.koName,...strings(card.aliases)].filter(Boolean).join(' ')),known:''};
        if (card.game === 'pokemon' && names && typeof names.searchText === 'function' && typeof names.normalizeQuery === 'function') {
          try { text.known = names.searchText({...card,brand:'pokemon',id:card.sourceKey || card.id,productId:card.marketVerified === true ? card.marketId : undefined}); } catch (_) {}
        }
        context.searchIndex.set(card.id,text);
      }
      return text.base.includes(query) || !!(text.known && names && text.known.includes(names.normalizeQuery(context.query)));
    });
  }
  function pickerPages(context,pages) {
    if (pages <= 1) return '';
    const first = Math.max(1,Math.min(context.page-2,pages-4));
    return '<nav class="tcc-pages" aria-label="카드 검색 페이지"><button type="button" data-tcc-picker-page="' + (context.page-1) + '" ' + (context.page <= 1 ? 'disabled' : '') + '>‹</button>' +
      Array.from({length:Math.min(5,pages)},(_,i) => i+first).map(page => '<button type="button" data-tcc-picker-page="' + page + '" ' + (page === context.page ? 'aria-current="page"' : '') + '>' + page + '</button>').join('') +
      '<button type="button" data-tcc-picker-page="' + (context.page+1) + '" ' + (context.page >= pages ? 'disabled' : '') + '>›</button></nav>';
  }
  function renderPickerResults(context) {
    if (!pickerCurrent(context)) return;
    const area = modal.querySelector('#tccPickerResults'); if (!area) return;
    if (context.loading) { area.innerHTML = message('카드를 불러오는 중이에요','선택한 게임과 언어의 카드만 확인합니다.'); return; }
    const cards = pickerCards(context), pages = Math.max(1,Math.ceil(cards.length/PAGE_SIZE));
    context.page = Math.min(context.page,pages);
    area.innerHTML = '<p class="tcc-picker-count" role="status">' + cards.length.toLocaleString('ko-KR') + '종 · 이 컬렉션에 ' + context.selectedKeys.size.toLocaleString('ko-KR') + '종 담김</p>' +
      (cards.length ? '<div class="tcc-card-grid tcc-picker-grid">' + cards.slice((context.page-1)*PAGE_SIZE,context.page*PAGE_SIZE).map(card => {
        const selected = context.selectedKeys.has(card.id);
        return '<article class="tcc-card"><div class="tcc-card-art">' + cardPicture(card,card.name) + '</div><div class="tcc-card-body"><strong class="tcc-card-title">' + esc(card.name) + '</strong><p class="tcc-card-meta">' + esc(languageName(card.language)) + ' · ' + esc(card.setCode) + ' · ' + esc(card.number) + '</p><button type="button" class="tcc-button small" data-tcc-picker-add="' + esc(card.id) + '" ' + (selected || context.inflight || context.request || context.blocked ? 'disabled' : '') + '>' + (selected ? '이미 담긴 카드' : '+ 담기') + '</button></div></article>';
      }).join('') + '</div>' + pickerPages(context,pages) : message('조건에 맞는 카드가 없어요','카드 이름·번호·세트 코드 또는 게임과 언어를 바꿔보세요.'));
  }
  function renderPicker(context) {
    if (!pickerCurrent(context)) return;
    const games = uniq(pickerShardEntries().map(item => item.game)), disabled = context.inflight ? ' disabled' : '';
    const section = modal.querySelector('.tcc-modal'); if (!section) return;
    section.classList.add('tcc-picker-modal');
    section.innerHTML = modalHead('카드 찾아 추가') + '<div class="tcc-picker"><p>‘' + esc(context.title) + '’에 카드를 한 장씩 담습니다. 직접 담은 카드만 수집 목표에 반영됩니다.</p><div class="tcc-picker-tools"><label class="tcc-field">게임<select data-tcc-picker-game aria-label="추가할 카드 게임"' + disabled + '>' +
      [...games,'all'].map(game => '<option value="' + esc(game) + '" ' + (context.game === game ? 'selected' : '') + '>' + esc(game === 'all' ? '모든 게임' : gameName(game)) + '</option>').join('') + '</select></label><label class="tcc-field">언어<select data-tcc-picker-language aria-label="추가할 카드 언어"' + disabled + '>' +
      [...pickerLanguages(context.game),'all'].map(language => '<option value="' + esc(language) + '" ' + (context.language === language ? 'selected' : '') + '>' + esc(languageName(language)) + '</option>').join('') + '</select></label><label class="tcc-search"><span aria-hidden="true">⌕</span><input id="tccPickerQuery" type="search" maxlength="120" aria-label="추가할 카드 검색" placeholder="카드 이름·번호·세트 코드 검색" value="' + esc(context.query) + '"' + disabled + '></label></div><p class="tcc-inline-error" id="tccFormError" role="alert" ' + (context.error ? '' : 'hidden') + '>' + esc(context.error) + '</p>' +
      (context.request ? '<div class="tcc-picker-retry"><p>이전 추가 요청의 결과를 먼저 확인해 주세요.</p><button type="button" class="tcc-button" data-tcc-action="picker-retry" ' + (context.inflight ? 'disabled' : '') + '>같은 요청 다시 시도</button></div>' : '') + '<div id="tccPickerResults"></div></div>';
    renderPickerResults(context);
  }
  async function loadPickerScope(context) {
    if (!pickerCurrent(context)) return;
    const generation = ++context.searchGeneration;
    context.loading = true; context.error = ''; context.page = 1; renderPicker(context);
    const current = () => pickerCurrent(context) && generation === context.searchGeneration;
    try {
      const keys = pickerShardEntries().filter(item => (context.game === 'all' || item.game === context.game) && (context.language === 'all' || item.language === context.language)).map(item => item.key);
      for (let i=0;i<keys.length;i+=2) { await Promise.all(keys.slice(i,i+2).map(loadShard)); if (!current()) return; }
      const names = root.JapaneseCardNames;
      if ((context.game === 'pokemon' || context.game === 'all') && names && typeof names.ensureDisplayData === 'function') {
        await names.ensureDisplayData(); if (!current()) return;
      }
      context.searchIndex.clear(); context.loading = false; renderPicker(context);
    } catch (error) { if (current()) { context.loading = false; context.error = error.message; renderPicker(context); } }
  }
  function openPicker() {
    if (state.busy || !requireOwner() || !state.detail || state.selected !== state.detail.id) return;
    const current = state.detail, games = uniq(pickerShardEntries().map(item => item.game));
    if (!games.length) { inform('추가할 카드 정보를 확인하지 못했습니다.','error'); return; }
    const game = games.includes('pokemon') ? 'pokemon' : games[0], languages = pickerLanguages(game);
    openModal(modalHead('카드 찾아 추가'));
    const context = {type:'picker',id:current.id,title:current.title,revision:current.revision,selectedKeys:new Set(current.cardKeys),owner,epoch:accountEpoch,modalGeneration,game,language:languages.includes('ja') ? 'ja' : languages[0],query:'',page:1,loading:false,error:'',searchGeneration:0,searchIndex:new Map(),request:pickerRequests.get(current.id) || null,inflight:false,blocked:false};
    picker = context; pendingDialog = context;
    renderPicker(context); modal.querySelector('#tccPickerQuery')?.focus(); loadPickerScope(context);
  }
  function pickerInput(event) {
    const context = picker; if (!pickerCurrent(context) || event.target.id !== 'tccPickerQuery') return;
    context.query = String(event.target.value || '').slice(0,120); context.page = 1; renderPickerResults(context);
  }
  function pickerChange(event) {
    const context = picker; if (!pickerCurrent(context) || context.inflight) return;
    if (event.target.hasAttribute('data-tcc-picker-game')) {
      const game = event.target.value, games = uniq(pickerShardEntries().map(item => item.game));
      if (game !== 'all' && !games.includes(game)) return;
      context.game = game;
      const languages = pickerLanguages(game);
      if (context.language !== 'all' && !languages.includes(context.language)) context.language = languages.includes('ja') ? 'ja' : languages[0];
    } else if (event.target.hasAttribute('data-tcc-picker-language')) {
      const language = event.target.value;
      if (language !== 'all' && !pickerLanguages(context.game).includes(language)) return;
      context.language = language;
    } else return;
    loadPickerScope(context);
  }
  function applyPickerCollection(context,raw,marks) {
    const result = normalizeCollection(raw);
    if (result.id !== context.id || !Array.isArray(result.cardKeys)) throw new Error('최신 컬렉션을 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.');
    context.revision = result.revision; context.selectedKeys = new Set(result.cardKeys); context.title = result.title;
    details.set(result.id,result); state.detail = result;
    mergeOwnership(result.ownership || marks);
    state.collections = state.collections.map(item => item.id === result.id ? {...item,...result,itemCount:result.cardKeys.length} : item);
  }
  async function reloadPickerCollection(context) {
    const payload = await privateRequest('/collections/' + encodeURIComponent(context.id));
    if (!pickerCurrent(context)) return false;
    if (payload.collection && payload.collection.revision < context.revision) return true;
    applyPickerCollection(context,payload.collection,payload.ownership); return true;
  }
  async function addPickerCard(id) {
    const context = picker;
    if (!pickerCurrent(context) || context.inflight || state.busy || context.blocked) return;
    if (!context.request) {
      const card = allCards.get(id);
      if (!card || card.retired === true || !CARD_KEY.test(id) || context.selectedKeys.has(id) || (card.sourceOnly === true && card.characterDiscoveryVerified !== true) || (context.game !== 'all' && card.game !== context.game) || (context.language !== 'all' && card.language !== context.language)) return;
      if (context.selectedKeys.size >= MAX_SNAPSHOT) { context.error = '한 컬렉션에는 최대 5,000종까지 담을 수 있어요.'; renderPicker(context); return; }
      try {
        const body = Object.freeze({expectedRevision:context.revision,addCardKeys:Object.freeze([id]),removeCardKeys:Object.freeze([]),catalogVersion:catalog.version,mutationId:uuid()});
        context.request = {cardKey:id,body,attempts:0}; pickerRequests.set(context.id,context.request);
      } catch (error) { context.error = error.message; renderPicker(context); return; }
    } else if (id && id !== context.request.cardKey) return;
    const request = context.request, epoch = accountEpoch;
    request.attempts++; context.inflight = true; context.error = ''; state.busy = true; render(); renderPicker(context);
    try {
      const payload = await privateRequest('/collections/' + encodeURIComponent(context.id) + '/items',{method:'PUT',body:request.body});
      if (!pickerCurrent(context)) return;
      if (request.attempts > 1 || !payload.collection || payload.collection.revision < context.revision) {
        if (!await reloadPickerCollection(context) || !pickerCurrent(context)) return;
      } else applyPickerCollection(context,payload.collection,payload.ownership);
      if (pickerRequests.get(context.id) === request) pickerRequests.delete(context.id);
      context.request = null; context.error = ''; inform('컬렉션에 카드를 담았습니다.','success');
    } catch (error) {
      if (!pickerCurrent(context) || error.stale) return;
      context.error = error.message;
      if (error.status && error.status < 500) {
        if (pickerRequests.get(context.id) === request) pickerRequests.delete(context.id);
        context.request = null;
      }
      if (error.status === 409) {
        context.blocked = error.code === 'catalog_changed';
        const feedback = context.blocked ? '카드 정보가 갱신됐습니다. 새로고침 후 다시 추가해 주세요.' : '다른 창에서 목록이 바뀌어 최신 목록을 불러왔습니다. 카드를 확인한 뒤 다시 추가해 주세요.';
        try { if (!await reloadPickerCollection(context) || !pickerCurrent(context)) return; context.error = feedback; } catch (refreshError) { if (pickerCurrent(context)) context.error = refreshError.message; }
        if (pickerCurrent(context)) inform(context.error,'error');
      }
    } finally {
      if (epoch === accountEpoch) {
        context.inflight = false; state.busy = false; render(); if (pickerCurrent(context)) renderPicker(context);
        if (refreshAfterMutation) {
          refreshAfterMutation = false;
          if (pickerCurrent(context)) { try { await reloadPickerCollection(context); if (pickerCurrent(context)) { render(); renderPicker(context); } } catch (error) { if (pickerCurrent(context)) { context.error=error.message; renderPicker(context); } } }
          else refreshPrivateViews();
        }
      }
    }
  }

  function openCreate(keys = [],snapshot = {kind:'manual'},title = '') {
    if (!requireOwner()) return;
    const ids = uniq(keys).filter(id => CARD_KEY.test(id));
    if (ids.length > MAX_SNAPSHOT) { inform('한 컬렉션에는 최대 5,000종까지 담을 수 있어요. 언어나 진화계열 범위를 좁혀 주세요.','error'); return; }
    let createId; try { createId = uuid(); } catch (error) { inform(error.message,'error'); return; }
    openModal(modalHead('새 컬렉션 만들기') + '<form id="tccCreateForm"><label class="tcc-field">컬렉션 이름<input id="tccCollectionTitle" maxlength="60" required placeholder="예: 신지 칸다 모으기" value="' + esc(title) + '"></label><div class="tcc-snapshot-summary">선택한 ' + ids.length.toLocaleString('ko-KR') + '종을 목록으로 저장합니다.</div><p>나중에 추가되는 카드는 자동 반영되지 않습니다. 보유 여부는 별도로 표시하며 실제 보유자산은 변경되지 않아요.</p><p class="tcc-inline-error" id="tccFormError" role="alert" hidden></p><div class="tcc-form-actions"><button type="button" class="tcc-button" data-tcc-action="close-modal">취소</button><button type="submit" class="tcc-button primary">컬렉션 만들기</button></div></form>');
    // openModal clears no data; hold the trusted explicit selection, never form-supplied card metadata.
    pendingDialog = {type:'create',createId,keys:ids.slice(),snapshot:{...snapshot},request:null}; modal.querySelector('#tccCollectionTitle')?.focus();
  }
  function openRename() {
    if (!requireOwner() || !state.detail) return;
    const current = state.detail;
    openModal(modalHead('컬렉션 이름 수정') + '<form id="tccRenameForm"><label class="tcc-field">컬렉션 이름<input id="tccCollectionTitle" required maxlength="60" value="' + esc(current.title) + '"></label><p class="tcc-inline-error" id="tccFormError" role="alert" hidden></p><div class="tcc-form-actions"><button type="button" class="tcc-button" data-tcc-action="close-modal">취소</button><button type="submit" class="tcc-button primary">저장</button></div></form>');
    pendingDialog = {type:'rename',id:current.id,revision:current.revision};
  }
  function openDelete() {
    if (!requireOwner() || !state.detail) return;
    const current = state.detail;
    openModal(modalHead('컬렉션을 삭제할까요?') + '<p>‘' + esc(current.title) + '’ 목록을 삭제합니다. 카드의 보유 표시와 실제 보유자산은 그대로 유지됩니다.</p><p class="tcc-inline-error" id="tccFormError" role="alert" hidden></p><div class="tcc-form-actions"><button type="button" class="tcc-button" data-tcc-action="close-modal">취소</button><button type="button" class="tcc-button primary" data-tcc-action="confirm-delete">목록 삭제</button></div>');
    pendingDialog = {type:'delete',id:current.id,revision:current.revision};
  }
  async function openAdd(id) {
    if (!requireOwner()) return;
    const epoch = accountEpoch;
    if (!state.collections.length) { await loadCollections(); if (!owner || epoch !== accountEpoch) return; }
    if (!state.collections.length) { openCreate([id],{kind:'manual'},'좋아하는 카드'); return; }
    const card = allCards.get(id);
    openModal(modalHead('컬렉션에 추가') + '<form id="tccAddForm"><p>' + esc(card && card.name || '선택한 카드') + '</p><label class="tcc-field">추가할 컬렉션<select id="tccCollectionSelect">' + state.collections.map(item => '<option value="' + esc(item.id) + '" ' + (state.selected === item.id ? 'selected' : '') + '>' + esc(item.title) + '</option>').join('') + '</select></label><p class="tcc-inline-error" id="tccFormError" role="alert" hidden></p><div class="tcc-form-actions"><button type="button" class="tcc-button" data-tcc-action="new-from-card">새 컬렉션</button><button type="submit" class="tcc-button primary">추가하기</button></div></form>');
    pendingDialog = {type:'add',cardKey:id};
  }
  function openCard(id) {
    const card = allCards.get(id); if (!card) return;
    const source = safeSource(card.detailSourceUrl || card.sourceUrl);
    const artistNames = card.artistIds.map(key => catalog.artists.find(item => item.id === key)).filter(Boolean).map(entityLabel);
    openModal(modalHead('카드 상세') + '<div class="tcc-card-detail">' + cardPicture(card,card.name) + '<div><h4>' + esc(card.name) + '</h4><small>' + esc(gameName(card.game)) + ' · ' + esc(languageName(card.language)) + '</small><small>' + esc(card.setCode) + ' · ' + esc(card.number) + '</small>' + (artistNames.length ? '<p>일러스트 · ' + esc(artistNames.join(' / ')) + '</p>' : '') + (source ? '<a class="tcc-source" href="' + esc(source) + '" target="_blank" rel="noopener noreferrer">카드 정보 출처 ↗</a>' : '') + (card.marketVerified === true && /^\d+$/.test(String(card.marketId || '')) ? '<a class="tcc-source" href="/price/' + esc(card.marketId) + '">시세 보기 ↗</a>' : '<p>이 판본의 시세 연결은 확인 중입니다.</p>') + '<button type="button" class="tcc-button primary" data-tcc-add="' + esc(id) + '">+ 컬렉션에 추가</button></div></div>');
  }
  function formError(message) { const node = modal && modal.querySelector('#tccFormError'); if (node) { node.textContent = message; node.hidden = false; } else inform(message,'error'); }
  async function mutation(task,onSuccess) {
    if (state.busy || !requireOwner()) return;
    const epoch = accountEpoch; state.busy = true;
    modal?.querySelectorAll('button,input,select').forEach(node => { node.disabled = true; }); render();
    try { const payload = await task(); if (epoch !== accountEpoch) return; if (onSuccess) await onSuccess(payload); }
    catch (error) { if (!error.stale && epoch === accountEpoch) { if (error.status === 409) { closeModal(); if (error.code === 'catalog_changed') { state.error = '카드 정보가 갱신됐습니다. 페이지를 새로고침한 뒤 범위를 확인하고 다시 저장해 주세요.'; inform(state.error,'error'); } else { inform(error.message,'error'); await loadCollections(state.selected); } } else formError(error.message); } }
    finally { if (epoch === accountEpoch) { state.busy = false; modal?.querySelectorAll('button,input,select').forEach(node => { node.disabled = false; }); render(); if (refreshAfterMutation) { refreshAfterMutation = false; refreshPrivateViews(); } } }
  }
  async function removeItem(id) {
    const current = state.detail; if (!current || !owner) return;
    await mutation(() => privateRequest('/collections/' + encodeURIComponent(current.id) + '/items',{method:'PUT',body:{expectedRevision:current.revision,addCardKeys:[],removeCardKeys:[id],catalogVersion:catalog.version}}),async payload => {
      if (payload.collection) { const result = normalizeCollection(payload.collection); details.set(result.id,result); state.detail = result; mergeOwnership(result.ownership); }
      inform('이 컬렉션에서 카드를 뺐습니다. 보유 표시는 유지됩니다.','success'); await loadCollections(current.id);
    });
  }
  async function changeOwned(input) {
    if (!requireOwner()) return;
    const id = input.dataset.tccOwn, previous = ownership.get(id); if (!previous) return;
    if (!input.checked && previous.holdingOwned && !previous.manualOwned) { input.checked = true; inform('보유자산에 등록된 카드입니다. 실제 자산은 마이페이지에서 관리할 수 있어요.'); return; }
    const manualOwned = input.checked;
    await mutation(() => privateRequest('/collection-ownership',{method:'PUT',body:{cardKey:id,manualOwned,expectedRevision:previous.revision,catalogVersion:catalog.version}}),async payload => {
      mergeOwnership(payload.ownership);
      if (payload.ownership && payload.ownership[id] && payload.ownership[id].holdingOwned && !manualOwned) inform('직접 체크는 해제했습니다. 등록된 자산이 있어 보유 표시는 유지됩니다.');
      if (state.tab === 'personal') await loadCollections(state.selected);
    });
  }
  function handleSubmit(event) {
    const form = event.target; if (!form || !pendingDialog) return;
    if (!['tccCreateForm','tccRenameForm','tccAddForm'].includes(form.id)) return;
    event.preventDefault();
    const pending = pendingDialog;
    if (form.id === 'tccCreateForm') {
      const title = String(modal.querySelector('#tccCollectionTitle').value || '').trim().slice(0,60); if (!title) return;
      if (!pending.request) pending.request = {id:pending.createId,title,cardKeys:pending.keys.slice(),snapshot:{...pending.snapshot},catalogVersion:catalog.version};
      modal.querySelector('#tccCollectionTitle').readOnly = true;
      mutation(async () => {
        try { return await privateRequest('/collections',{method:'POST',body:pending.request}); }
        catch (error) { if (error.status && error.status < 500 && error.status !== 409 && pendingDialog === pending) { pending.request = null; const input = modal && modal.querySelector('#tccCollectionTitle'); if (input) input.readOnly = false; } throw error; }
      },async payload => {
        const created = normalizeCollection(payload.collection); details.set(created.id,created); mergeOwnership(created.ownership); closeModal(); state.tab = 'personal'; state.entity = null; state.selected = created.id; state.detail = created; state.query = ''; state.ownedFilter = 'all'; state.page = 1; inform('컬렉션을 만들었습니다.','success'); await loadCollections(created.id);
      });
    } else if (form.id === 'tccRenameForm') {
      const title = String(modal.querySelector('#tccCollectionTitle').value || '').trim().slice(0,60); if (!title) return;
      mutation(() => privateRequest('/collections/' + encodeURIComponent(pending.id),{method:'PATCH',body:{expectedRevision:pending.revision,title}}),async () => { closeModal(); await loadCollections(pending.id); inform('이름을 수정했습니다.','success'); });
    } else if (form.id === 'tccAddForm') {
      const id = modal.querySelector('#tccCollectionSelect').value, current = state.collections.find(item => item.id === id); if (!current) return;
      mutation(() => privateRequest('/collections/' + encodeURIComponent(id) + '/items',{method:'PUT',body:{expectedRevision:current.revision,addCardKeys:[pending.cardKey],removeCardKeys:[],catalogVersion:catalog.version}}),async payload => { if (payload.collection) details.set(id,normalizeCollection(payload.collection)); closeModal(); await loadCollections(state.selected); inform('컬렉션에 카드를 담았습니다.','success'); });
    }
  }
  function handleClick(event) {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || button.disabled) return;
    if (button.dataset.tccPickerAdd) { addPickerCard(button.dataset.tccPickerAdd); return; }
    if (button.dataset.tccPickerPage && pickerCurrent(picker)) { picker.page = Math.max(1,Number(button.dataset.tccPickerPage)); renderPickerResults(picker); return; }
    if (button.dataset.tccTab) { state.tab = button.dataset.tccTab; state.entity = null; state.query = ''; state.game = 'all'; state.page = 1; state.ownedFilter = 'all'; state.cardQuery = ''; viewRun++; closeModal(); render(); if (state.tab === 'personal' && owner) loadCollections(); return; }
    if (button.dataset.tccGame) { state.game = button.dataset.tccGame; state.page = 1; render(); return; }
    if (button.dataset.tccEntity) { openEntity(button.dataset.tccType,button.dataset.tccEntity); return; }
    if (button.dataset.tccCollection) { state.ownedFilter = 'all'; state.cardQuery = ''; loadDetail(button.dataset.tccCollection); return; }
    if (button.dataset.tccCard) { openCard(button.dataset.tccCard); return; }
    if (button.dataset.tccAdd) { openAdd(button.dataset.tccAdd); return; }
    if (button.dataset.tccRemove) { removeItem(button.dataset.tccRemove); return; }
    if (button.dataset.tccOwnedFilter) { state.ownedFilter = button.dataset.tccOwnedFilter; state.page = 1; renderResultArea(); ensureVisibleOwnership(); return; }
    if (button.dataset.tccPage) { state.page = Math.max(1,Number(button.dataset.tccPage)); if (button.dataset.tccPageKind === 'directory') { const results = host.querySelector('#tccDirectoryResults'); if (results) results.innerHTML = directoryResults(); } else { renderResultArea(); ensureVisibleOwnership(); } return; }
    const action = button.dataset.tccAction;
    if (action === 'close-modal') closeModal();
    else if (action === 'login') requireOwner();
    else if (action === 'back') { state.entity = null; state.loading = false; state.error = ''; state.page = 1; viewRun++; render(); }
    else if (action === 'clear-query') { state.query = ''; state.page = 1; render(); host.querySelector('#tccEntityQuery')?.focus(); }
    else if (action === 'retry') { state.error = ''; ensureCatalog(true).then(show).catch(error => { state.error = error.message; render(); }); render(); }
    else if (action === 'new-empty') openCreate();
    else if (action === 'find-cards') openPicker();
    else if (action === 'picker-retry' && pickerCurrent(picker) && picker.request) addPickerCard(picker.request.cardKey);
    else if (action === 'reload-private') loadCollections(state.selected);
    else if (action === 'rename') openRename();
    else if (action === 'delete') openDelete();
    else if (action === 'new-from-card' && pendingDialog && pendingDialog.cardKey) openCreate([pendingDialog.cardKey],{kind:'manual'},'좋아하는 카드');
    else if (action === 'save-scope') {
      const item = entity(); if (!item) return;
      const snapshot = {kind:state.entity.type,[state.entity.type === 'artist' ? 'artistId' : 'characterId']:item.id,game:item.game,...(state.language !== 'all' ? {language:state.language} : {}),...(state.entity.type === 'character' ? {includeMega:state.includeMega,includeEvolution:state.includeEvolution} : {})};
      openCreate(scopedCards().map(card => card.id),snapshot,entityLabel(item) + (state.includeEvolution ? ' 진화계열' : '') + ' 모으기');
    } else if (action === 'confirm-delete' && pendingDialog && pendingDialog.type === 'delete') {
      const pending = {...pendingDialog}; mutation(() => privateRequest('/collections/' + encodeURIComponent(pending.id),{method:'DELETE',body:{expectedRevision:pending.revision}}),async () => { details.delete(pending.id); state.detail = null; closeModal(); await loadCollections(); inform('컬렉션을 삭제했습니다. 보유 표시는 유지됩니다.','success'); });
    }
  }
  function handleImageError(event) {
    const node = event.target;
    if (!node || String(node.tagName).toUpperCase() !== 'IMG' || !((host && host.contains(node)) || (modal && modal.contains(node)))) return;
    const placeholder = document.createElement('span'); placeholder.className = 'tcc-placeholder'; placeholder.textContent = '이미지를 불러오지 못했어요';
    (node.closest('.tcc-sprite') || node).replaceWith(placeholder);
  }
  function install() {
    const tabs = document.getElementById('ciTabs'), list = document.getElementById('cardInfoList');
    if (!tabs || !list || typeof renderCardInfo !== 'function' || typeof CI_TAB === 'undefined') return;
    if (!tabs.querySelector('[data-ci="collections"]')) { const button = document.createElement('button'); button.type = 'button'; button.className = 'tab'; button.dataset.ci = 'collections'; button.textContent = '컬렉션'; button.setAttribute('aria-pressed','false'); tabs.append(button); }
    const collectionTab = tabs.querySelector('[data-ci="collections"]');
    function positionCollectionTab() {
      const chiikawa = tabs.querySelector('[data-ci="chiikawa"]');
      if (chiikawa) { if (chiikawa.nextElementSibling !== collectionTab) chiikawa.after(collectionTab); }
      else if (tabs.lastElementChild !== collectionTab) tabs.append(collectionTab);
    }
    positionCollectionTab();
    if (typeof MutationObserver !== 'undefined') new MutationObserver(positionCollectionTab).observe(tabs,{childList:true});
    host = document.createElement('div'); host.id = 'tcgCollections'; host.hidden = true; list.after(host);
    host.addEventListener('click',handleClick);
    document.addEventListener('error',handleImageError,true);
    host.addEventListener('input',event => {
      if (event.target.id === 'tccEntityQuery') { state.query = event.target.value.slice(0,120); state.page = 1; const results = host.querySelector('#tccDirectoryResults'); if (results) results.innerHTML = directoryResults(); }
      if (event.target.id === 'tccCardQuery') { state.cardQuery = event.target.value.slice(0,120); state.page = 1; const input = event.target, start = input.selectionStart; renderResultArea(); const replacement = host.querySelector('#tccCardQuery'); replacement?.focus(); replacement?.setSelectionRange?.(start,start); ensureVisibleOwnership(); }
    });
    host.addEventListener('change',event => {
      if (event.target.hasAttribute('data-tcc-language')) changeLanguage(event.target.value);
      else if (event.target.hasAttribute('data-tcc-mega')) { state.includeMega = event.target.checked; resetScope(); }
      else if (event.target.hasAttribute('data-tcc-evolution')) { state.includeEvolution = event.target.checked; resetScope(); }
      else if (event.target.hasAttribute('data-tcc-own')) changeOwned(event.target);
    });
    const previousRender = renderCardInfo;
    renderCardInfo = function (...args) { if (active()) { show(); return; } restoreForeignUI(); return previousRender.apply(this,args); };
    document.addEventListener('keydown',event => {
      if (!modal || modal.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); if (!state.busy) closeModal(); return; }
      if (event.key !== 'Tab') return;
      const nodes = [...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')];
      const first = nodes[0], last = nodes[nodes.length - 1]; if (!first) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    function pageChanged() {
      if (document.body.dataset.page !== 'cardinfo') { closeModal(); ownershipGeneration++; ownership.clear(); ownershipPending.clear(); listRun++; detailRun++; return; }
      if (active()) { hideForeignUI(); render(); refreshPrivateViews(); }
    }
    window.addEventListener('hashchange',pageChanged);
    window.addEventListener('focus',() => { if (document.body.dataset.page === 'cardinfo' && active()) refreshPrivateViews(); });
    if (typeof MutationObserver !== 'undefined') new MutationObserver(pageChanged).observe(document.body,{attributes:true,attributeFilter:['data-page']});
    if (typeof location !== 'undefined' && location.hash === '#cardinfo') {
      const selectedTab = new URLSearchParams(location.search).get('collection');
      if (['artists','characters','personal'].includes(selectedTab)) {
        CI_TAB = 'collections'; state.tab = selectedTab;
        tabs.querySelectorAll('.tab').forEach(button => { const selected = button.dataset.ci === 'collections'; button.classList.toggle('active',selected); button.setAttribute('aria-pressed',String(selected)); });
      }
    }
    owner = currentOwner(); if (active()) show();
  }
  install();
})(typeof window === 'undefined' ? globalThis : window);
