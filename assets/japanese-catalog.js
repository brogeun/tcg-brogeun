/* Japanese printed cards and market products have separate identities. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JapaneseCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  let ready, catalog, rows = [], products = [];
  const names = () => root.JapaneseCardNames;
  const normalize = value => names()?.normalizeQuery(value) || String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  // DON!! is a resource-card name. Its punctuation must not turn it into
  // the substring in Koraidon, Groudon or McDonald's during text folding.
  function prepareQuery(query) {
    const value = String(query || '').normalize('NFKC').trim();
    const term = /(?<![\p{L}\p{N}_])(?:don\s*!+(?:\s*cards?)?|don\s*cards?|돈(?:\s*!+)?(?:\s*카드)?|ドン(?:\s*!+)?(?:\s*カード)?)(?![\p{L}\p{N}_])/giu;
    let type = null;
    const text = value.replace(term, () => { type = 'don'; return ' '; }).trim();
    return /^don$/i.test(value) ? {type:'don', text:''} : {type, text};
  }
  function acceptsQuery(card, query) {
    const plan = typeof query === 'string' ? prepareQuery(query) : query;
    if (plan?.type !== 'don') return true;
    if (card.brand !== 'onepiece' || card.kind !== 'card') return false;
    const title = String(card.name || card.originalName || '').normalize('NFKC').trim();
    return /^(?:don\s*!+(?![\p{L}\p{N}_])|don\s+cards?\b|ドン(?:\s*!+|\s*カード)|돈\s*(?:!+\s*)?카드)/iu.test(title)
      || /^OPCD-\d/i.test(String(card.productNumber || card.code || ''));
  }
  function decode(data) {
    if (data?.schemaVersion !== 1 || !Array.isArray(data.sets) || !Array.isArray(data.cards)) throw new Error('Invalid Japanese catalogue');
    const ids = new Set();
    for (const card of data.cards) {
      if (!/^JP:/.test(card.id || '') || ids.has(card.id) || card.language !== 'ja' || !card.boxCode && !card.setCode) throw new Error('Invalid Japanese card identity');
      ids.add(card.id);
    }
    return data;
  }
  function configure(data) { catalog = decode(data); return setProducts(products); }
  function ensureData() {
    if (!ready) ready = Promise.all([
      fetch('/data/japanese-catalog.json?v=20261014-3').then(response => {
        if (!response.ok) throw new Error('Japanese catalogue unavailable');
        return response.json();
      }),
      names()?.ensureData(),
      root.CardCatalogRepairs?.ensureData()
    ]).then(([data]) => { configure(data); return catalog; }).catch(error => { ready = null; throw error; });
    return ready;
  }
  function title(card) { return names()?.title(card) || card.nameKo || card.name || ''; }
  function japanese(product) {
    if (names()) return names().language(product) === 'ja';
    return root.ContainedCardMatch ? !root.ContainedCardMatch.foreign(product) : !product.language || product.language === 'ja';
  }
  function setProducts(source) {
    products = source || [];
    if (!catalog) return rows = products;
    const byId = new Map(products.map(product => [String(product.id), product]));
    const covered = new Set();
    const canonical = new Map(catalog.cards.map(card => [card.id, card]));
    for (const product of products) {
      if (product.brand !== 'pokemon' || product.kind !== 'card' || !japanese(product)) continue;
      const candidate = canonical.get(names()?.candidateCatalogueId?.(product));
      if (candidate && candidate.brand === 'pokemon' && candidate.kind === 'card' &&
          candidate.language === 'ja' && japanese(candidate)) {
        // A reviewed duplicate is hidden only in search. It never supplies the
        // printed card's productId, price, artwork, or destination.
        covered.add(String(product.id));
      }
    }
    const sets = new Map(catalog.sets.map(set => [set.code, set]));
    const printed = catalog.cards.map(original => {
      const card=root.CardCatalogRepairs?.printed(original) || original;
      // Candidate IDs suppress duplicate market listings, never supply a price.
      for (const id of [...(card.productIds || []), ...(card.candidateProductIds || []), card.productId].filter(Boolean)) covered.add(String(id));
      const product = card.productId ? byId.get(String(card.productId)) : null;
      const set = sets.get(card.boxCode || card.setCode);
      const row = {...card, catalogueId:card.id, _catalogue:true, kind:'card', brand:'pokemon', language:'ja',
        setName:set?.name || card.setName || card.boxCode || card.setCode,
        thumbnailUrl:card.thumbnailUrl || card.image || '',
        minPrice:product?.minPrice, currency:product?.currency || 'JPY', listingCount:product?.listingCount || 0};
      row.displayName = title(row);
      row.nameLower = [row.name, row.displayName, row.number, row.boxCode, row.setCode, row.setName, set?.nameEn, row.boxCode+' '+row.number, row.setCode+' '+row.number, names()?.searchText(row)].filter(Boolean).join(' ').toLowerCase();
      row.productNumber = product?.productNumber || '';
      row._searchText=normalize([row.nameLower,row.productNumber].join(' '));
      return row;
    });
    const marketOnly = products.filter(product => {
      if (!japanese(product)) return false;
      return product.brand !== 'pokemon' || product.kind === 'box' || !covered.has(String(product.id));
    }).map(product => {
      const row={...product, displayName:product.kind === 'box' ? product.displayName || product.name : product.cardType==='DON' ? product.nameKo : title(product)};
      row._searchText=normalize((product.cardType==='DON' ? [row.displayName,row.nameLower,row.productNumber] : [row.displayName,row.name,row.nameLower,row.productNumber,names()?.searchText(row)]).filter(Boolean).join(' '));
      return row;
    });
    const knownBoxes = new Set(marketOnly.filter(product => product.kind === 'box').map(product => String(product.code || '').toUpperCase()));
    const catalogBoxes = catalog.sets.filter(set => !knownBoxes.has(set.code.toUpperCase())).map(set => ({
      ...set, id:'JPSET:'+set.code, setCode:set.code, boxCode:set.code, setName:set.name,
      name:set.name, displayName:set.name, nameLower:[set.name,set.code].join(' ').toLowerCase(),
      kind:'box', brand:'pokemon', language:'ja', _catalogue:true,
      thumbnailUrl:set.image || '/images/sets/'+encodeURIComponent(set.code)+'.jpg', productNumber:set.code, listingCount:0
    }));
    rows = [...printed, ...marketOnly, ...catalogBoxes];
    return rows;
  }
  function getSearchRows() { return rows.length ? rows : products; }
  function matches(card, query) {
    const plan = prepareQuery(query);
    if (!acceptsQuery(card, plan)) return false;
    const compact = normalize(plan.text);
    if (!compact) return Boolean(plan.type);
    const text = card._searchText || normalize([card.displayName, card.name, card.nameLower, card.productNumber, card.number, card.boxCode, card.setCode, card.setName, names()?.searchText(card)].filter(Boolean).join(' '));
    if (compact && text.includes(compact)) return true;
    const words = plan.text.split(/\s+/).map(normalize).filter(Boolean);
    return words.length > 0 && words.every(word => text.includes(word));
  }
  function href(card) {
    if (card.productId) return '#price/'+encodeURIComponent(card.productId);
    if (!card._catalogue) return '#price/'+encodeURIComponent(card.id);
    const query = new URLSearchParams({set:card.boxCode || card.setCode});
    if (card.kind === 'card') query.set('card', card.number || card.sourceId || card.id);
    return '/?'+query+'#cardinfo';
  }
  function find(id) { return rows.find(card => card.id === id); }
  function getProduct(id) {
    const saved=products.find(product=>String(product.id)===String(id));
    if(saved)return saved;
    const card=rows.find(card=>String(card.productId||'')===String(id));
    return card ? {id:String(id),name:card.name,nameKo:card.nameKo,image:card.thumbnailUrl,thumbnailUrl:card.thumbnailUrl,
      brand:'pokemon',_brand:'pokemon',kind:'card',_productKind:'card',language:'ja',setCode:card.setCode,
      number:card.number,productNumber:'pkmn-tcg-'+card.setCode+'-'+String(card.number).split('/')[0]} : null;
  }
  return {ensureData, configure, decode, setProducts, getSearchRows, prepareQuery, acceptsQuery, matches, href, find, title, getProduct};
});
