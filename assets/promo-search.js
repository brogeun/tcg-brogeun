/* Supplement Japanese promo search without replacing existing products or quotes. */
(() => {
  'use strict';
  const version = '20261013-promo1';
  const series = '(?:PCG|ADV|DPt|SM|SV|XY|BW|neo|DP|M|S|L|e)-P';
  let catalogPromise, quotePromise, retry = true;

  function codeKeys(card) {
    if (card.brand !== 'pokemon') return [];
    const keys = new Set();
    for (const bracket of String(card.name || '').matchAll(/\[([^\]]+)\]/g)) {
      const text = bracket[1].trim();
      const forward = text.match(new RegExp('^(' + series + ')\\s*(?:-\\s*)?(\\d{1,4})(?=\\s|/|$)', 'i'));
      const reverse = text.match(new RegExp('^(\\d{1,4})\\s*/\\s*(' + series + ')(?=\\s|$)', 'i'));
      const family = forward?.[1] || reverse?.[2];
      const number = forward?.[2] || reverse?.[1];
      if (family && number) keys.add(family.toLowerCase() + ':' + String(Number(number)).padStart(3, '0'));
    }
    return [...keys];
  }

  function decorate(card) {
    const aliases = codeKeys(card).flatMap(key => {
      const [family, number] = key.split(':');
      return [number + '/' + family, family + number, family + ' ' + number, family + '-' + number];
    });
    return aliases.length ? {...card, nameLower: [card.nameLower || String(card.name || '').toLowerCase(), ...aliases].join(' ')} : card;
  }

  function queryKey(query) {
    const pattern = new RegExp('(?:^|\\s)(?:(\\d{1,4})\\s*[/／]\\s*(' + series + ')|(' + series + ')\\s*(?:-\\s*)?(\\d{1,4}))(?=\\s|$)', 'i');
    const match = String(query || '').trim().match(pattern);
    if (!match) return null;
    const family = match[2] || match[3], number = match[1] || match[4];
    return family.toLowerCase() + ':' + String(Number(number)).padStart(3, '0');
  }

  function filterCodeQuery(matches, query) {
    const key = queryKey(query);
    return key ? matches.filter(card => codeKeys(card).includes(key)) : matches;
  }

  async function json(url) {
    const response = await fetch(url, {signal: AbortSignal.timeout(12000)});
    if (!response.ok) throw new Error('Promo search HTTP ' + response.status);
    return response.json();
  }

  function catalog() {
    if (!catalogPromise) catalogPromise = json('/data/promo-search.json?v=' + version).then(data => {
      if (data.schemaVersion !== 1 || !Array.isArray(data.cards)) throw new Error('Invalid promo search catalogue');
      return data.cards.filter(card => /^\d+$/.test(String(card.id)) && card.kind === 'card' && card.language === 'ja' && ['pokemon', 'onepiece'].includes(card.brand) && typeof card.name === 'string' && card.name.length);
    }).catch(error => { catalogPromise = null; throw error; });
    return catalogPromise;
  }

  function quotes() {
    if (!quotePromise) quotePromise = Promise.all(['pokemon', 'onepiece'].map(async brand => {
      try { return (await json('/data/price-' + brand + '-card.json?t=' + Math.floor(Date.now() / 3600000))).products || []; }
      catch { return []; }
    })).then(lists => new Map(lists.flat().filter(product => Number(product.lastPrice) > 0 && ['USD', 'JPY', 'KRW'].includes(product.currency)).map(product => [String(product.id), product])));
    return quotePromise;
  }

  async function merge(existing) {
    const original = Array.isArray(existing) ? existing : [];
    try {
      const [cards, prices] = await Promise.all([catalog(), quotes()]);
      const merged = new Map(original.map(card => [String(card.id), decorate(card)]));
      for (const raw of cards) {
        const id = String(raw.id);
        if (merged.has(id)) continue;
        const price = prices.get(id);
        merged.set(id, decorate({...raw, id, nameLower: raw.name.toLowerCase(), productNumber: String(raw.productNumber || '').toLowerCase(), minPrice: price?.lastPrice ?? null, currency: price?.currency || 'USD', listingCount: 0}));
      }
      retry = false;
      return [...merged.values()];
    } catch (error) {
      retry = true;
      console.warn('[search] 프로모 보충 목록을 불러오지 못해 기존 검색을 유지합니다.', error.message);
      return original.map(decorate);
    }
  }

  window.PromoSearch = {merge, codeKeys, queryKey, filterCodeQuery, needsRetry: () => retry};
})();
