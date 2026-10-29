/* Chiikawa Weiss Schwarz Blau catalogue extension for TCG Hub.
 * Load after the existing language/Riftbound catalogue scripts.
 * Public static data only: no authentication, prices, portfolio or writes.
 */
(() => {
  'use strict';
  if (window.ChiikawaCatalog) return;

  const VERSION = '20261022-pr009';
  const DATA_URL = '/data/chiikawa-catalog.json';
  const PAGE_SIZE = 18;
  const BRAND = 'chiikawa';
  const SET_ID = /^CIKW\/[A-Z0-9]{1,8}$/;
  const CARD_NUMBER = /^CIKW\/[A-Z0-9]{1,8}-[A-Z0-9]{2,16}$/;
  const SOURCE_HOSTS = new Set([
    'arkblackcat.com', 'www.arkblackcat.com',
    'ws-blau.com', 'www.ws-blau.com',
    'c-labo-online.jp', 'www.c-labo-online.jp',
    'torecatchi-blau.com', 'www.torecatchi-blau.com',
    'square-bushiroad.com', 'www.square-bushiroad.com',
    'northerncross-cs.com', 'www.northerncross-cs.com',
  ]);
  const PRODUCT_TYPES = {
    booster: '부스터', starter_deck: '스타트덱', promo_collection: '프로모 모음',
  };
  const INCLUSION = {
    pack: '팩 수록', booster: '팩 수록', booster_pool: '팩 수록', regular: '수록 카드',
    deck: '덱 수록', starter_deck: '덱 수록', starter_deck_product: '덱 수록',
    box_bonus: '박스 특전', box_topper: '박스 특전',
    promo: '프로모', promotion: '프로모', promo_collection: '프로모',
    collection_bonus: '컬렉션 특전',
  };
  // Search conveniences; these are not asserted to be official translations.
  const ALIASES = [
    ['치이카와', 'chiikawa', 'ちいかわ'],
    ['하치와레', '가르마', 'hachiware', 'ハチワレ'],
    ['우사기', '토끼', 'usagi', 'うさぎ'],
    ['모몽가', '하늘다람쥐', 'momonga', 'モモンガ'],
    ['밤만쥬', '밤만주', '쿠리만쥬', '쿠리만주', 'kurimanju', 'くりまんじゅう'],
    ['랏코', '해달', 'rakko', 'ラッコ'],
    ['시사', '시이사', 'shisa', 'シーサー'],
    ['헌책방', '카니', '후루혼야', 'furuhonya', '古本屋'],
    ['데카츠요', '크고강한녀석', 'dekatsuyo', 'でかつよ'],
    ['아노코', '그아이', '그녀석', 'anoko', 'あのこ'],
    ['포셰트갑옷씨', '포쉐트갑옷씨', '미니백갑옷씨', 'ポシェットの鎧さん'],
    ['노동갑옷씨', '노동의갑옷씨', '労働の鎧さん'],
    ['라멘갑옷씨', '라면갑옷씨', 'ラーメンの鎧さん'],
    ['오데', 'ode', 'オデ'],
  ];
  const RARITIES = new Set(['N', 'R', 'RR', 'BR', 'SP', 'SSP', 'SEC', 'SD', 'PR']);
  const ICONS = {
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    back: '<path d="m12 5-7 7 7 7M5 12h14"/>',
    expand: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>',
  };

  let catalogue = null;
  let loadPromise = null;
  let listRequest = 0;
  let modalRequest = 0;
  let pendingOpen = null;
  let activeSet = null;
  let selectedCard = null;
  let cardQuery = '';
  let cardRarities = [];
  let page = 1;
  let gridScroll = 0;
  let focusCardId = '';
  let opener = null;
  let ownTabActive = false;
  let observedModal = null;
  let modalObserver = null;
  let ownsOpenModal = false;
  let composing = false;
  const languageVisibility = new Map();

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
  const compact = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\-_.\/:]+/g, '');
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  const text = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
  const inOwnTab = () => typeof CI_TAB !== 'undefined' && CI_TAB === BRAND;
  const modal = () => document.getElementById('anyModal');
  const shell = () => modal()?.querySelector('[data-ck-shell]');
  const rarityLabel = card => card.rarityNotApplicable ? '해당 없음' : card.rarity || '확인 중';
  const inclusionLabel = card => card.kind === 'collection_bonus' ? '컬렉션 특전' : INCLUSION[card.inclusionType] || '';

  function localImage(value) {
    // No external image requests, URL schemes, encoded paths or traversals.
    return typeof value === 'string' && /^\/images\/chiikawa\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i.test(value) ? value : '';
  }

  function sourceURL(value) {
    if (typeof value !== 'string' || !/^https:\/\//i.test(value)) return '';
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !SOURCE_HOSTS.has(url.hostname.toLowerCase())) return '';
      url.hash = '';
      return url.href;
    } catch { return ''; }
  }

  function fullNumber(card) {
    const fromId = text(card?.id).replace(/^wsb:ja:/, '');
    return CARD_NUMBER.test(card?.number || '') ? card.number : CARD_NUMBER.test(fromId) ? fromId : '';
  }

  function searchText(card) {
    const names = compact([card.name, card.nameJa].join(' '));
    const aliases = ALIASES.filter(group => group.some(alias => names.includes(compact(alias)))).flat();
    return compact([card.name, card.nameJa, card.number, card.id, card.rarity, inclusionLabel(card), ...aliases].join(' '));
  }

  function matches(card, query) {
    const words = String(query || '').trim().split(/\s+/).filter(Boolean);
    return words.every(word => {
      const rarity = word.normalize('NFKC').toUpperCase();
      return RARITIES.has(rarity) ? String(card.rarity || '').toUpperCase() === rarity : card.searchText.includes(compact(word));
    });
  }

  function prepare(payload) {
    if (!payload || payload.schemaVersion !== 1 || payload.brand !== BRAND || payload.game !== 'weiss_schwarz_blau' || payload.language !== 'ja' || !Array.isArray(payload.sets) || payload.sets.length > 200) throw new Error('Invalid Chiikawa catalogue header');
    const ids = new Set();
    const codes = new Set();
    const sets = payload.sets.map(rawSet => {
      if (!rawSet || !SET_ID.test(rawSet.code || '') || codes.has(rawSet.code) || !PRODUCT_TYPES[rawSet.productType] || !Array.isArray(rawSet.cards)) throw new Error('Invalid Chiikawa set');
      codes.add(rawSet.code);
      const cards = rawSet.cards.map(rawCard => {
        const number = fullNumber(rawCard);
        if (!rawCard || !number || rawCard.id !== 'wsb:ja:' + number || ids.has(rawCard.id) || !['game_card', 'collection_bonus'].includes(rawCard.kind)) throw new Error('Invalid or duplicate Chiikawa card identity');
        if (CARD_NUMBER.test(rawCard.number || '') && rawCard.number !== text(rawCard.id).replace(/^wsb:ja:/, '')) throw new Error('Conflicting Chiikawa card number');
        if (rawCard.setCode && (!SET_ID.test(rawCard.setCode) || rawCard.setCode !== rawSet.code)) throw new Error('Invalid Chiikawa card set membership');
        ids.add(rawCard.id);
        const card = {
          id: rawCard.id, number,
          name: text(rawCard.name) || text(rawCard.nameJa) || number,
          nameJa: text(rawCard.nameJa),
          rarity: text(rawCard.rarity, 40),
          rarityNotApplicable: rawCard.rarityNotApplicable === true,
          kind: rawCard.kind, setCode: rawCard.setCode || rawSet.code,
          inclusionType: text(rawCard.inclusionType, 80),
          image: localImage(rawCard.image),
          imageOriginal: sourceURL(rawCard.imageOriginal),
          sourceUrls: [...new Set((Array.isArray(rawCard.sourceUrls) ? rawCard.sourceUrls : []).map(sourceURL).filter(Boolean))].slice(0, 8),
          promoInfo: text(rawCard.promoInfo, 300),
          needsReview: [...new Set((Array.isArray(rawCard.needsReview) ? rawCard.needsReview : []).filter(reason => typeof reason === 'string').map(reason => reason.slice(0, 120)))],
        };
        card.searchText = searchText(card);
        return card;
      });
      return {
        code: rawSet.code, name: text(rawSet.name) || rawSet.code,
        nameJa: text(rawSet.nameJa), release: text(rawSet.release, 40),
        productType: rawSet.productType, boxImage: localImage(rawSet.boxImage),
        productFacts: (Array.isArray(rawSet.productFacts) ? rawSet.productFacts : []).filter(v => typeof v === 'string').slice(0, 8).map(v => text(v, 180)),
        productNote: text(rawSet.productNote, 360), cards,
      };
    });
    if (!Number.isInteger(payload.cardCount) || payload.cardCount !== ids.size || ids.size > 30000) throw new Error('Chiikawa card count does not match unique identities');
    return {
      schemaVersion: 1, brand: BRAND, language: 'ja', game: 'weiss_schwarz_blau',
      cardCount: ids.size, sets, generatedAt: text(payload.generatedAt, 100),
      quality: { status: text(payload.quality?.status, 40) || 'partial' },
    };
  }

  function load(force = false) {
    if (catalogue && !force) return Promise.resolve(catalogue);
    if (loadPromise && !force) return loadPromise;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;
    const promise = fetch(DATA_URL + '?v=' + VERSION, {
      cache: 'no-cache', credentials: 'omit', headers: { Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    }).then(response => {
      if (!response.ok) throw new Error('Chiikawa catalogue HTTP ' + response.status);
      return response.json();
    }).then(prepare).then(value => {
      if (loadPromise === promise) catalogue = value;
      return value;
    }).catch(error => {
      if (loadPromise === promise) loadPromise = null;
      throw error;
    }).finally(() => { if (timer) clearTimeout(timer); });
    loadPromise = promise;
    return promise;
  }

  function languageBars(enter) {
    const list = document.getElementById('cardInfoList');
    if (enter) {
      ownTabActive = true;
      for (const id of ['rfLanguages', 'encLanguages', 'ciLanguageTabs']) {
        const element = document.getElementById(id);
        if (element) {
          if (!languageVisibility.has(element)) languageVisibility.set(element, element.hidden);
          element.hidden = true;
        }
      }
      list?.classList.remove('enc-set-list');
      list?.classList.add('ck-set-list');
      if (list) list.dataset.catalogLanguage = 'chiikawa-ja';
    } else if (ownTabActive) {
      ownTabActive = false;
      listRequest++;
      for (const [element, hidden] of languageVisibility) if (element.isConnected) element.hidden = hidden;
      languageVisibility.clear();
      list?.classList.remove('ck-set-list');
      if (list?.dataset.catalogLanguage === 'chiikawa-ja') delete list.dataset.catalogLanguage;
    }
  }


  /* Chiikawa product/promo descriptions - v1 */
  function setFactsHTML(set, small = false) {
    if (!set || !Array.isArray(set.productFacts) || !set.productFacts.length) return '';
    if (small) return `<span class="ck-facts-teaser">${set.productFacts.slice(0, 2).map(item => `<span>• ${esc(item)}</span>`).join('')}</span>`;
    return `<section class="ck-product-info" aria-label="${esc(set.name)} 상품 정보"><strong>${set.productType === 'promo_collection' ? '프로모 카드 입수 안내' : '박스 구성·특별 레어 안내'}</strong><ul>${set.productFacts.map(item => `<li>${esc(item)}</li>`).join('')}</ul>${set.productNote ? `<p>${esc(set.productNote)}</p>` : ''}<p class="ck-facts-caution">※ 제공된 정리 자료 기준의 참고 정보입니다. 행사·재판·특전 조건은 실제 판매·배포 공지를 확인해 주세요.</p></section>`;
  }

  function noteHTML(data) {
    const partial = data.quality.status !== 'complete';
    return `<div class="ck-catalog-note"><div><strong>치이카와 · 일본판</strong><span>바이스슈발츠 브라우 · ${data.cardCount}개 카드</span></div>${partial ? '<p>수록 목록 확인 중 · 등록된 카드 기준으로 표시합니다.</p>' : ''}</div>`;
  }

  function releaseHTML(set, tag = 'span') {
    if (set.productType === 'promo_collection') return '';
    return `<${tag}>${set.release ? '발매일: ' + esc(set.release) : '발매일 확인 중'}</${tag}>`;
  }

  async function render(force = false) {
    const list = document.getElementById('cardInfoList');
    if (!list || !inOwnTab()) return;
    languageBars(true);
    const request = ++listRequest;
    if (!catalogue || force) list.innerHTML = '<div class="ck-message" role="status">치이카와 카드 목록을 불러오는 중…</div>';
    try {
      const data = await load(force);
      if (request !== listRequest || !inOwnTab()) return;
      const query = compact(typeof CI_QUERY === 'string' ? CI_QUERY : '');
      const sets = data.sets.filter(set => compact([set.code, set.name, set.nameJa, set.release, PRODUCT_TYPES[set.productType]].join(' ')).includes(query));
      list.innerHTML = noteHTML(data) + sets.map(set => {
        const bonus = set.cards.filter(card => card.kind === 'collection_bonus').length;
        return `<button type="button" class="ck-set-tile" data-ck-set="${esc(set.code)}" aria-label="${esc(set.name)} 수록 카드 보기">
          <span class="ck-cover ck-cover-${esc(set.productType)}${set.boxImage ? ' ck-cover-photo' : ''}">${set.boxImage ? `<img data-ck-box-image src="${esc(set.boxImage)}" alt="${esc(set.name)} 상품 박스 이미지" loading="lazy" decoding="async"><span class="ck-box-fallback" hidden>${esc(set.name)}</span>` : `<span class="ck-cover-label">WEISS SCHWARZ BLAU</span><strong>치이카와</strong><span>${esc(PRODUCT_TYPES[set.productType])}</span><span class="ck-cover-code">${esc(set.code)}</span>`}</span>
          <span class="ck-set-body"><span class="ck-set-code">${esc(set.code)}</span><strong>${esc(set.name)}</strong><span>${set.cards.length}개 카드${bonus ? ' · 컬렉션 특전 ' + bonus + '개 포함' : ''}</span>${releaseHTML(set)}${setFactsHTML(set, true)}</span>
        </button>`;
      }).join('') + (sets.length ? '' : '<div class="ck-message">검색 결과가 없습니다. 박스 이름 또는 세트 코드를 확인해 주세요.</div>');
    } catch (error) {
      if (request !== listRequest || !inOwnTab()) return;
      list.innerHTML = '<div class="ck-message" role="alert"><strong>치이카와 목록을 불러오지 못했습니다.</strong><p>잠시 후 다시 시도해 주세요.</p><button type="button" class="ck-button" data-ck-retry-list>다시 시도</button></div>';
      console.warn('[ChiikawaCatalog]', error.message);
    }
  }

  function owns(request = modalRequest) {
    const element = modal();
    return !!(element?.classList.contains('open') && !element.hidden && element.style.display !== 'none' && element.getAttribute('aria-hidden') !== 'true' && shell()?.dataset.ckSession === String(request));
  }

  function observeModal(element) {
    if (observedModal === element) return;
    modalObserver?.disconnect();
    observedModal = element;
    if (typeof MutationObserver === 'undefined') return;
    modalObserver = new MutationObserver(() => {
      if (ownsOpenModal && !owns()) {
        ownsOpenModal = false;
        modalRequest++;
        pendingOpen = null;
      }
    });
    modalObserver.observe(element, { attributes: true, attributeFilter: ['class', 'hidden', 'style', 'aria-hidden'], childList: true });
  }

  function toolbar(back = false) {
    return `<header class="ck-toolbar">${back ? `<button type="button" data-ck-back aria-label="수록 카드로 돌아가기">${icon('back')}</button>` : ''}<span>치이카와 <span>· 일본판</span></span><button type="button" data-ck-expand aria-label="패널 전체화면 전환" aria-pressed="false">${icon('expand')}</button><button type="button" data-ck-share aria-label="치이카와 정보 공유">${icon('share')}</button><button type="button" data-ck-close aria-label="치이카와 정보 닫기">${icon('close')}</button></header>`;
  }

  function present(content, titleId, request = modalRequest, focus = '[data-ck-close]') {
    const expanded = !!modal()?.classList.contains('ci-expanded');
    if (typeof CI_PANEL_REQUEST === 'number') CI_PANEL_REQUEST++;
    window.EnglishCatalog?.cancelPending?.();
    window.ChineseCatalog?.cancelPending?.();
    openAnyModal(`<div class="ck-shell" data-ck-shell data-ck-session="${request}">${content}<div class="ck-share-status" data-ck-share-status role="status" aria-live="polite"></div></div>`, 'wide');
    const element = modal();
    element.classList.add('ci-panel');
    element.classList.toggle('ci-expanded', expanded);
    element.removeAttribute('aria-hidden');
    element._ciOpener = opener?.isConnected ? opener : document.querySelector('#ciTabs [data-ci="chiikawa"]');
    const box = element.querySelector('.modal-box');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', titleId);
    shell()?.querySelector('[data-ck-expand]')?.setAttribute('aria-pressed', String(expanded));
    ownsOpenModal = true;
    observeModal(element);
    shell()?.querySelector(focus)?.focus({ preventScroll: true });
  }

  function imageHTML(card, detail = false) {
    return `<span class="ck-art${detail ? ' ck-art-detail' : ''}">${card.image ? `<img data-ck-image src="${esc(card.image)}" alt="${esc(card.name)}" loading="lazy" decoding="async">` : ''}<span class="ck-image-placeholder"${card.image ? ' hidden' : ''}>画像<span>이미지 없음</span></span></span>`;
  }

  function badges(card) {
    return `<span class="ck-badge">${esc(rarityLabel(card))}</span>${inclusionLabel(card) ? `<span class="ck-badge ck-badge-kind">${esc(inclusionLabel(card))}</span>` : ''}`;
  }

  function pager(current, total) {
    const start = Math.max(1, Math.min(current - 2, total - 4));
    const button = (number, label, content, disabled = false) => `<button type="button" data-ck-page="${number}" aria-label="${label}"${disabled ? ' disabled' : ''}>${content}</button>`;
    return button(1, '첫 페이지', '«', current === 1) + button(current - 1, '이전 페이지', '‹', current === 1) + Array.from({ length: Math.min(5, total) }, (_, index) => start + index).map(number => `<button type="button" data-ck-page="${number}" aria-label="${number}페이지"${number === current ? ' aria-current="page"' : ''}>${number}</button>`).join('') + button(current + 1, '다음 페이지', '›', current === total) + button(total, '마지막 페이지', '»', current === total);
  }

  function gridBody(focusFirst = false) {
    if (!activeSet || !owns()) return;
    const grid = document.getElementById('ckCardGrid');
    if (!grid) return;
    const rarityCards = window.CardRarityFilters?.filter(activeSet.cards, cardRarities) || activeSet.cards;
    const cards = rarityCards.filter(card => matches(card, cardQuery));
    const total = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
    page = Math.max(1, Math.min(page, total));
    grid.innerHTML = cards.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(card => `<button type="button" class="ck-card" data-ck-card="${esc(card.id)}" aria-label="${esc(card.name + ', ' + card.number)} 카드 정보">${imageHTML(card)}<span class="ck-card-copy"><strong>${esc(card.name)}</strong><span class="ck-card-number">${esc(card.number)}</span><span class="ck-badges">${badges(card)}</span></span></button>`).join('') || '<div class="ck-message">검색 결과가 없습니다. 카드 이름·번호·레어도를 확인해 주세요.</div>';
    const count = document.getElementById('ckCardCount');
    count.textContent = `${activeSet.cards.length}개 카드${cardQuery || cardRarities.length ? ' · 결과 ' + cards.length + '개' : ''} · ${page} / ${total} 페이지`;
    window.CardRarityFilters?.mount(document.getElementById('ckRarityFilters'), {cards:activeSet.cards, selected:cardRarities, onChange(next) {
      cardRarities = next; page = 1; gridScroll = 0; gridBody();
      const scroll = document.getElementById('ckPanelScroll'); if (scroll) scroll.scrollTop = 0;
    }});
    const pages = document.getElementById('ckCardPages');
    pages.innerHTML = pager(page, total);
    pages.hidden = total <= 1;
    if (focusFirst) grid.querySelector('[data-ck-card]')?.focus({ preventScroll: true });
  }

  function gridPanel(restore = false) {
    if (!activeSet) return;
    selectedCard = null;
    present(`${toolbar()}<div class="ck-set-heading"><span>${esc(PRODUCT_TYPES[activeSet.productType])} · ${esc(activeSet.code)}</span><h2 id="ckPanelTitle">${esc(activeSet.name)}</h2>${activeSet.nameJa && activeSet.nameJa !== activeSet.name ? `<p lang="ja">${esc(activeSet.nameJa)}</p>` : ''}${releaseHTML(activeSet, 'p')}</div><label class="ck-search">카드 검색<input id="ckCardSearch" type="search" autocomplete="off" placeholder="이름·번호·레어도 (예: 하치와레, SSP)" value="${esc(cardQuery)}"></label><div class="ck-scroll" id="ckPanelScroll">${setFactsHTML(activeSet)}<div class="ci-rarity-summary"><p class="ck-count" id="ckCardCount" role="status" aria-live="polite"></p><div id="ckRarityFilters"></div></div><div class="ck-card-grid" id="ckCardGrid"></div></div><nav class="ck-pages" id="ckCardPages" aria-label="수록 카드 페이지 이동"></nav>`, 'ckPanelTitle');
    gridBody();
    if (restore) {
      const scroll = document.getElementById('ckPanelScroll');
      if (scroll) scroll.scrollTop = gridScroll;
      const target = [...shell().querySelectorAll('[data-ck-card]')].find(button => button.dataset.ckCard === focusCardId);
      target?.focus({ preventScroll: true });
    }
  }

  function sourceName(url) {
    const host = new URL(url).hostname;
    if (host.includes('ws-blau')) return '공식 카드 정보';
    if (host.includes('c-labo')) return '카드라보';
    if (host.includes('torecatchi')) return '토레캇치';
    if (host.includes('square-bushiroad')) return '마스터즈스퀘어';
    if (host.includes('northerncross')) return '노던크로스';
    return '출처';
  }

  function detail(id) {
    if (!activeSet || !owns()) return;
    const card = activeSet.cards.find(item => item.id === id || item.number === id);
    if (!card) return;
    const scroll = document.getElementById('ckPanelScroll');
    if (scroll && document.getElementById('ckCardGrid')) gridScroll = scroll.scrollTop;
    focusCardId = card.id;
    selectedCard = card;
    const rows = [
      ['카드 번호', card.number], ['레어도', rarityLabel(card)], ['언어', '일본판'],
      ['수록 구분', inclusionLabel(card) || '수록 카드'], ['수록 상품', activeSet.name],
    ];
    if (card.promoInfo) rows.push(['특전·입수 경로', card.promoInfo]);
    const links = card.sourceUrls.map(url => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(sourceName(url))} ↗</a>`).join('');
    const original = card.imageOriginal && /\.(png|jpe?g|webp|gif)(?:$|[?#])/i.test(card.imageOriginal) ? `<a href="${esc(card.imageOriginal)}" target="_blank" rel="noopener noreferrer nofollow">원본 이미지 ↗</a>` : '';
    present(`${toolbar(true)}<div class="ck-scroll ck-detail-scroll"><article class="ck-detail">${imageHTML(card, true)}<div class="ck-detail-copy"><span class="ck-eyebrow">바이스슈발츠 브라우 · 치이카와</span><h2 id="ckCardTitle">${esc(card.name)}</h2>${card.nameJa && card.nameJa !== card.name ? `<p class="ck-japanese-name" lang="ja">${esc(card.nameJa)}</p>` : ''}<p class="ck-detail-number">${esc(card.number)}</p><div class="ck-badges">${badges(card)}</div><p class="ck-price-note">시세 정보는 제공하지 않습니다.</p><dl class="ck-facts">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${links || original ? `<section class="ck-sources" aria-label="카드 정보 출처"><h3>출처</h3><div>${links}${original}</div></section>` : ''}<button type="button" class="ck-button ck-back-button" data-ck-back>수록 카드로 돌아가기</button></div></article></div>`, 'ckCardTitle', modalRequest, '[data-ck-back]');
  }

  async function open(code, cardId = '', force = false) {
    if (!SET_ID.test(code || '')) return;
    const focus = document.activeElement;
    if (!shell()?.contains(focus)) opener = focus;
    const request = ++modalRequest;
    pendingOpen = { code, cardId };
    activeSet = null;
    selectedCard = null;
    cardQuery = '';
    cardRarities = [];
    page = 1;
    gridScroll = 0;
    focusCardId = '';
    present(`${toolbar()}<div class="ck-scroll"><h2 id="ckPanelTitle" class="ck-loading-title">치이카와 · 일본판</h2><p class="ck-message" role="status">수록 카드를 불러오는 중…</p></div>`, 'ckPanelTitle', request);
    try {
      const data = await load(force);
      if (request !== modalRequest || !owns(request)) return;
      activeSet = data.sets.find(set => set.code === code);
      if (!activeSet) throw new Error('Unknown Chiikawa set');
      gridPanel();
      if (cardId) {
        const card = activeSet.cards.find(item => item.id === cardId || item.number === cardId);
        if (card) {
          page = Math.floor(activeSet.cards.indexOf(card) / PAGE_SIZE) + 1;
          detail(card.id);
        } else {
          const status = shell()?.querySelector('[data-ck-share-status]');
          if (status) status.textContent = '공유된 카드 번호가 이 수록 목록에 없습니다.';
        }
      }
    } catch (error) {
      if (request !== modalRequest || !owns(request)) return;
      present(`${toolbar()}<div class="ck-scroll"><h2 id="ckPanelTitle" class="ck-loading-title">카드를 불러오지 못했습니다.</h2><div class="ck-message" role="alert"><p>공유 주소 또는 카드 데이터가 변경되었을 수 있습니다.</p><button type="button" class="ck-button" data-ck-retry-modal>다시 시도</button></div></div>`, 'ckPanelTitle', request);
      console.warn('[ChiikawaCatalog]', error.message);
    }
  }

  function close() {
    modalRequest++;
    pendingOpen = null;
    ownsOpenModal = false;
    if (modal()?.querySelector('[data-ck-shell]')) closeAnyModal();
  }

  function href(setCode = '', cardNumber = '') {
    const params = new URLSearchParams();
    if (SET_ID.test(setCode)) params.set('set', setCode);
    else params.set('brand', BRAND);
    const number = String(cardNumber || '').replace(/^wsb:ja:/, '');
    if (SET_ID.test(setCode) && CARD_NUMBER.test(number)) params.set('card', number);
    return '/?' + params.toString() + '#cardinfo';
  }

  async function share() {
    if (!owns()) return;
    const request = modalRequest;
    const url = new URL(href(activeSet?.code, selectedCard?.number), location.origin).href;
    try {
      if (navigator.share) {
        await navigator.share({ title: selectedCard?.name || activeSet?.name || '치이카와 카드 정보', url });
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        if (owns(request)) shell().querySelector('[data-ck-share-status]').textContent = '공유 링크를 복사했습니다.';
        return;
      }
    } catch (error) { if (error.name === 'AbortError' || !owns(request)) return; }
    if (!owns(request)) return;
    const status = shell().querySelector('[data-ck-share-status]');
    const label = document.createElement('label');
    label.textContent = '공유 링크를 복사해 주세요.';
    const input = document.createElement('input');
    input.type = 'url'; input.readOnly = true; input.value = url;
    label.append(input); status.replaceChildren(label); input.focus(); input.select();
  }

  function activate() {
    CI_TAB = BRAND;
    for (const button of document.querySelectorAll('#ciTabs .tab')) {
      const on = button.dataset.ci === BRAND;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
    renderCardInfo();
  }

  function deepLink() {
    if (location.hash !== '#cardinfo') return;
    const params = new URLSearchParams(location.search);
    const code = params.get('set') || '';
    if (!SET_ID.test(code) && params.get('brand') !== BRAND) return;
    activate();
    if (SET_ID.test(code)) open(code, params.get('card') || '');
  }

  const tabs = document.getElementById('ciTabs');
  if (!tabs || typeof CI_TAB === 'undefined' || typeof renderCardInfo !== 'function' || typeof openAnyModal !== 'function' || typeof closeAnyModal !== 'function') {
    console.warn('[ChiikawaCatalog] Expected TCG Hub catalogue hooks are unavailable.');
    return;
  }
  const previousRender = renderCardInfo;
  renderCardInfo = function (...args) {
    if (inOwnTab()) return render();
    languageBars(false);
    return previousRender.apply(this, args);
  };
  if (!tabs.querySelector('[data-ci="chiikawa"]')) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'tab'; button.dataset.ci = BRAND;
    button.textContent = '치이카와'; button.setAttribute('aria-pressed', 'false');
    tabs.append(button);
  }
  const subtitle = document.querySelector('.page[data-page="cardinfo"] .page-sub');
  if (subtitle && !subtitle.childElementCount && !subtitle.textContent.includes('치이카와')) {
    subtitle.textContent = subtitle.textContent.replace(/(\s+확장팩\s+목록)/, ' · 치이카와$1');
  }

  document.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('[data-ck-set],[data-ck-card],[data-ck-page],[data-ck-back],[data-ck-close],[data-ck-expand],[data-ck-share],[data-ck-retry-list],[data-ck-retry-modal]') : null;
    if (!button || button.disabled) return;
    event.preventDefault(); event.stopPropagation();
    if (button.dataset.ckSet) open(button.dataset.ckSet);
    else if (button.dataset.ckCard) detail(button.dataset.ckCard);
    else if (button.dataset.ckPage) {
      page = Number(button.dataset.ckPage); gridBody(true);
      const scroll = document.getElementById('ckPanelScroll'); if (scroll) scroll.scrollTop = 0;
    } else if (button.hasAttribute('data-ck-back')) gridPanel(true);
    else if (button.hasAttribute('data-ck-close')) close();
    else if (button.hasAttribute('data-ck-expand')) {
      const on = modal().classList.toggle('ci-expanded'); button.setAttribute('aria-pressed', String(on));
    } else if (button.hasAttribute('data-ck-share')) share();
    else if (button.hasAttribute('data-ck-retry-list')) render(true);
    else if (button.hasAttribute('data-ck-retry-modal') && pendingOpen) open(pendingOpen.code, pendingOpen.cardId, true);
  }, true);

  function filterInput(event) {
    if (event.target.id !== 'ckCardSearch' || composing || event.isComposing) return;
    cardQuery = event.target.value; page = 1; gridBody();
    const scroll = document.getElementById('ckPanelScroll'); if (scroll) scroll.scrollTop = 0;
  }
  document.addEventListener('input', filterInput);
  document.addEventListener('compositionstart', event => { if (event.target.id === 'ckCardSearch') composing = true; });
  document.addEventListener('compositionend', event => { if (event.target.id === 'ckCardSearch') { composing = false; filterInput(event); } });
  document.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    if (image.hasAttribute('data-ck-box-image')) {
      image.hidden = true;
      const fallback = image.parentElement.querySelector('.ck-box-fallback');
      if (fallback) fallback.hidden = false;
      return;
    }
    if (!image.hasAttribute('data-ck-image')) return;
    image.hidden = true;
    const fallback = image.parentElement.querySelector('.ck-image-placeholder');
    if (fallback) fallback.hidden = false;
  }, true);
  document.addEventListener('keydown', event => {
    if (!owns()) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); close(); return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...shell().querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),[tabindex="0"]')].filter(element => !element.hidden && element.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !shell().contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !shell().contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  }, true);
  window.addEventListener('hashchange', deepLink);
  window.ChiikawaCatalog = Object.freeze({ version: VERSION, prepare, matches, localImage, sourceURL, href, open, close, activate, ensureData: load });
  deepLink();
})();
