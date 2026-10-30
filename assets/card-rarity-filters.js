/* Source rarity only. Mount explicitly in a box's existing contained-card panel. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardRarityFilters = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const UNKNOWN = 'unknown', NOT_APPLICABLE = 'not-applicable';
  const metadataRequests = new Map();
  const metadataURLs = {
    pokemon:'/data/collections/sources/pokemon-jp-rarity-metadata.json?v=20261029-source-rarity-1',
    onepiece:'/data/collections/sources/onepiece-printing-metadata.json?v=20261029-source-rarity-1'
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const empty = /^(?:[-—?]|unknown|unconfirmed|미확인|확인\s*중)$/i;

  function metadata(card) {
    if (card?.rarityNotApplicable === true) return {key:NOT_APPLICABLE, label:'해당 없음', state:'not-applicable'};
    // Never read a title, price, card number, parallel suffix or grading grade.
    const original = typeof card?.rarity === 'string' ? card.rarity.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
    if (!original || empty.test(original)) return {key:UNKNOWN, label:'미확인', state:'unknown'};
    return {key:'known:' + original.toUpperCase(), label:original, state:'known'};
  }

  function options(cards) {
    const grouped = new Map();
    for (const card of Array.isArray(cards) ? cards : []) {
      const item = metadata(card), found = grouped.get(item.key);
      if (found) found.count++;
      else grouped.set(item.key, {...item, count:1});
    }
    return [...grouped.values()].sort((a,b) => {
      const order = item => item.state === 'known' ? 0 : item.state === 'unknown' ? 1 : 2;
      return order(a)-order(b) || a.label.localeCompare(b.label, 'en', {numeric:true});
    });
  }

  function selection(cards, selected) {
    const allowed = new Set(options(cards).map(item => item.key));
    return [...new Set(Array.isArray(selected) ? selected : [])].filter(key => allowed.has(key));
  }

  function filter(cards, selected) {
    const input = Array.isArray(cards) ? cards : [], keys = selection(input, selected);
    if (!keys.length) return input.slice();
    const allowed = new Set(keys);
    return input.filter(card => allowed.has(metadata(card).key));
  }

  function merge(cards, payload, {brand, setCode} = {}) {
    const input = Array.isArray(cards) ? cards : [];
    if (!payload || !payload.cards || typeof payload.cards !== 'object' || Array.isArray(payload.cards)) return input.slice();
    return input.map(card => {
      // Existing explicit source metadata always wins; this cannot rewrite it.
      if (metadata(card).state !== 'unknown') return card;
      if (brand === 'pokemon') {
        const source = String(card.url || card.sourceUrl || '');
        const entry = Object.prototype.hasOwnProperty.call(payload.cards,source) ? payload.cards[source] : null;
        if (payload.schemaVersion !== 1 || payload.brand !== 'pokemon' || payload.language !== 'ja' ||
            !entry || entry.rarityStatus !== 'source-explicit' || entry.sourceUrl !== source ||
            String(entry.setCode).toUpperCase() !== String(setCode).toUpperCase() ||
            entry.number !== card.number || entry.name !== card.name ||
            typeof entry.rarity !== 'string' || !entry.rarity.trim()) return card;
        return {...card, rarity:entry.rarity, rarityOriginal:entry.rarityOriginal, raritySourceUrl:entry.sourceUrl};
      }
      if (brand === 'onepiece') {
        // Exact fullId only. A base card never supplies a _p1/_p2 rarity.
        const id = String(card.fullId || '');
        const entry = id && Object.prototype.hasOwnProperty.call(payload.cards,id) ? payload.cards[id] : null;
        if (!entry || entry.rarityStatus !== 'official-unambiguous' ||
            typeof entry.rarity !== 'string' || !entry.rarity.trim()) return card;
        return {...card, rarity:entry.rarity};
      }
      return card;
    });
  }

  function ensureMetadata(brand, {fetchImpl, timeoutMs = 2500} = {}) {
    if (!Object.prototype.hasOwnProperty.call(metadataURLs,brand)) return Promise.resolve(null);
    if (metadataRequests.has(brand)) return metadataRequests.get(brand);
    const request = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!request) return Promise.resolve(null);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const deadline = new Promise((resolve,reject) => {
      timer = setTimeout(() => { controller?.abort(); reject(new Error('Rarity metadata timed out')); }, Math.max(1,Math.min(2500,Number(timeoutMs) || 2500)));
    });
    const work = Promise.resolve().then(() => request(metadataURLs[brand], {
      cache:'no-cache', credentials:'omit', ...(controller ? {signal:controller.signal} : {})
    })).then(response => response.ok ? response.json() : null).then(payload => {
      if (!payload || !payload.cards || typeof payload.cards !== 'object' || Array.isArray(payload.cards)) throw Error('Invalid rarity metadata');
      return payload;
    });
    const pending = Promise.race([work,deadline]).catch(() => { metadataRequests.delete(brand); return null; }).finally(() => clearTimeout(timer));
    metadataRequests.set(brand,pending);
    return pending;
  }

  async function enrich(cards, {brand, setCode, fetchImpl} = {}) {
    const payload = await ensureMetadata(brand,{fetchImpl});
    return merge(cards,payload,{brand,setCode});
  }

  function page(cards, {selected = [], predicate = () => true, page = 1, pageSize = 18} = {}) {
    const filtered = filter(cards, selected).filter(predicate);
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 18;
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    const current = Math.max(1, Math.min(pages, Math.floor(Number(page)) || 1));
    return {filtered, count:filtered.length, page:current, pages, items:filtered.slice((current-1)*size, current*size)};
  }

  function controlsHtml(cards, selected) {
    const entries = options(cards), keys = selection(cards, selected), all = !keys.length;
    if (!entries.length) return '';
    const button = (key, label, count, on) => '<button type="button" class="ci-rarity-chip" data-card-rarity="'+esc(key)+'" aria-pressed="'+String(on)+'">'+esc(label)+'<span>'+count+'</span></button>';
    return '<div class="ci-rarity-filters" role="group" aria-label="레어도 복수 선택">'+
      button('', '전체', cards.length, all)+entries.map(item => button(item.key, item.label, item.count, keys.includes(item.key))).join('')+'</div>';
  }

  function mount(container, {cards, selected = [], onChange} = {}) {
    if (!container) return;
    const input = Array.isArray(cards) ? cards : [];
    container.innerHTML = controlsHtml(input, selected);
    container.onclick = event => {
      const button = event.target?.closest?.('button[data-card-rarity]');
      if (!button || !container.contains(button) || button.disabled) return;
      const key = button.dataset.cardRarity;
      if (key && !options(input).some(item => item.key === key)) return;
      event.preventDefault(); event.stopPropagation();
      const current = selection(input, selected);
      const next = !key ? [] : current.includes(key) ? current.filter(item => item !== key) : [...current, key];
      if (typeof onChange === 'function') onChange(next);
      // Provider redraws keep the active filter focus, without scrolling the panel.
      const live = container.id ? container.ownerDocument?.getElementById(container.id) || container : container;
      [...live.querySelectorAll('button[data-card-rarity]')].find(item => item.dataset.cardRarity === key)?.focus({preventScroll:true});
    };
  }

  return Object.freeze({metadata, options, selection, filter, merge, ensureMetadata, enrich, page, controlsHtml, mount});
});
