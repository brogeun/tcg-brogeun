/* Shared by the search worker and its compatibility fallback. No DOM or network work. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardSearchEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function() {
  'use strict';
  const fold = value => String(value ?? '').normalize('NFKC').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase()
    .replace(/([가-힣])의(?=[\s가-힣])/g, '$1').replace(/[\s\p{P}\p{S}]+/gu, '');
  const strings = (values, normalize = fold) => [...new Set(values.filter(value => value !== undefined && value !== null && value !== '').map(normalize).filter(Boolean))];
  const series = '(?:PCG|ADV|DPt|SM|SV|XY|BW|neo|DP|M|S|L|e)-P';
  const referencePattern = /(?<![\p{L}\p{N}])((?:OP|ST|EB|PRB)\s*-?\s*\d{1,2})[\s-]+(\d{1,3})(?!\d)/giu;
  function references(value) {
    return [...String(value || '').normalize('NFKC').matchAll(referencePattern)].map(match => fold(match[1])+String(Number(match[2])).padStart(3,'0'));
  }
  const promoPattern = new RegExp('(?:^|\\s)(?:(\\d{1,4})\\s*[/／]\\s*(' + series + ')|(' + series + ')\\s*(?:-\\s*)?(\\d{1,4}))(?=\\s|$)', 'i');
  function promoKey(query) {
    const match = String(query || '').normalize('NFKC').trim().match(promoPattern);
    return match ? (match[2] || match[3]).toLowerCase() + ':' + String(Number(match[1] || match[4])).padStart(3, '0') : null;
  }
  function planQuery(query, category) {
    let text = String(query || '').normalize('NFKC').trim(), type = null;
    text = text.replace(/(?<![\p{L}\p{N}_])(?:don\s*!+(?:\s*cards?)?|don\s*cards?|돈(?:\s*!+)?(?:\s*카드)?|ドン(?:\s*!+)?(?:\s*カード)?)(?![\p{L}\p{N}_])/giu, () => { type = 'don'; return ' '; });
    if (/^don$/i.test(text)) { type = 'don'; text = ''; }
    let kind = category === 'card' || category === 'box' ? category : 'all';
    // Korean users commonly omit the space in e.g. 고대박스. Do not strip
    // English suffixes from real names such as Gearbox.
    const box = text.match(/(?:박스|ボックス)\s*$|(?:^|\s)(?:box|boxes)\s*$/iu);
    if (box) { if (kind === 'all') kind = 'box'; text = text.slice(0, box.index).trim(); }
    return {text, compact:fold(text), words:text.split(/\s+/).map(fold).filter(Boolean), kind, type, promo:promoKey(query), reference:references(text)[0]||null};
  }
  function isDon(row) {
    if (row.brand !== 'onepiece' || row.kind !== 'card') return false;
    return row.cardType === 'DON' || /^(?:don\s*!+(?![\p{L}\p{N}_])|don\s+cards?\b|ドン(?:\s*!+|\s*カード)|돈\s*(?:!+\s*)?카드)/iu.test(String(row.name || '').normalize('NFKC').trim()) || /^OPCD-\d/i.test(String(row.productNumber || row.code || ''));
  }
  function unpack(snapshot, tuple) {
    if (!snapshot.fields) return {...tuple};
    return Object.fromEntries(snapshot.fields.map((field,index) => {
      const value=tuple[index],dictionary=snapshot.dictionaries?.[field];
      if (typeof value === 'number' && Array.isArray(dictionary)) {
        if(!Number.isInteger(value)||value<0||value>=dictionary.length)throw new Error('Invalid card search dictionary reference');
        return [field,dictionary[value]];
      }
      return [field,value];
    }));
  }
  function decode(snapshot) {
    if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.rows)) throw new Error('Invalid card search snapshot');
    const fields = snapshot.fields;
    if (fields && (!Array.isArray(fields) || !fields.includes('id') || new Set(fields).size !== fields.length)) throw new Error('Invalid card search fields');
    return snapshot.rows.map(tuple => {
      const row = unpack(snapshot,tuple);
      if (!row.id || !['card', 'box'].includes(row.kind)) throw new Error('Invalid card search identity');
      row.id = String(row.id);
      return row;
    });
  }
  function prepare(row, index) {
    // Names and identifiers occur in several ranking fields for the same row.
    // Reuse their exact normalization while preparing it, then release the cache.
    const normalized = new Map();
    const normalize = value => {
      if (!normalized.has(value)) normalized.set(value, fold(value));
      return normalized.get(value);
    };
    const rowStrings = values => strings(values, normalize);
    const ids = rowStrings([row.id, row.productId, ...(row.productIds || [])]);
    const identifiers = rowStrings([row.productNumber, row.number, row.fullId, row.setCode, row.boxCode, row.code]);
    // Exact collector-number searches also recognise the printed numerator.
    if (row.number && /^\d+[a-z]?\/\d+[a-z]?$/i.test(String(row.number).replace(/\s/g,''))) identifiers.push(fold(String(row.number).split('/')[0]));
    const titleNames = [row.displayName, row.name, row.nameKo];
    const directNames = rowStrings(titleNames);
    const names = rowStrings([...titleNames, ...titleNames.map(value => String(value || '').split(/\s*\[/)[0].replace(/\s+(?:SAR|SR|RRR?|AR|HR|UR|SSR|CHR|CSR|SA)\s*$/i,''))]);
    const promoNames = (row.promoKeys || []).flatMap(key => {const [family,number]=String(key).split(':');return [family+number,number+'/'+family];});
    const text = rowStrings([row.searchText, row._searchText, row._opSearch, row.nameLower, row.displayName, row.name, row.nameKo, row.setName, row.productNumber, row.number, row.fullId, row.setCode, row.boxCode, row.code, ...(row.aliases || []),...promoNames]).join('\0');
    const refs=new Set([row.name,row.fullId,row.productNumber,row.number,((row.setCode||row.boxCode||row.code||'')+' '+String(row.number||'').split('/')[0])].flatMap(references));
    return {row, index, ids, identifiers, names, directNames, text, refs, don:isDon(row), promo:new Set(row.promoKeys || [])};
  }
  function make(snapshot, prepared) {
    const aliases = Object.entries(snapshot.aliases || {}).map(([key, values]) => ({key:fold(key), values:strings(Array.isArray(values) ? values : [values])}));
    const cache = new Map();
    function expand(word) {
      const expanded = new Set([word]);
      for (const alias of aliases) if (alias.key === word || alias.key.includes(word)) for (const value of alias.values) expanded.add(value);
      return [...expanded];
    }
    function search(query, options = {}) {
      const plan = planQuery(query, options.category), brand = options.brand || 'all';
      const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
      const limit = options.limit === Infinity ? Infinity : Math.max(1, Math.min(300, Math.floor(Number(options.limit) || 30)));
      if (!plan.compact && !plan.type && plan.kind === 'all') return {results:[], total:0};
      if (!String(query || '').trim()) return {results:[], total:0};
      const key = [plan.text, plan.kind, plan.type, plan.promo, brand].join('\0');
      let hits = cache.get(key);
      if (!hits) {
        const groups = plan.words.map(expand), full = plan.compact ? expand(plan.compact) : [];
        hits = [];
        for (const item of prepared) {
          const row = item.row;
          if (plan.kind !== 'all' && row.kind !== plan.kind || brand !== 'all' && row.brand !== brand || plan.type === 'don' && !item.don || plan.promo && !item.promo.has(plan.promo) || plan.reference && !item.refs.has(plan.reference)) continue;
          const exactId = plan.compact && item.ids.includes(plan.compact);
          const exactNumber = plan.compact && item.identifiers.includes(plan.compact);
          const compactMatch = !plan.compact || full.some(term => item.text.includes(term));
          const wordsMatch = groups.length > 0 && groups.every(group => group.some(term => item.text.includes(term)));
          if (!exactId && !exactNumber && !compactMatch && !wordsMatch) continue;
          const exactTitle = full.some(term => item.directNames.includes(term));
          const exactName = full.some(term => item.names.includes(term));
          const prefixName = full.some(term => item.names.some(name => name.startsWith(term)));
          const exactPhrase = plan.compact && item.text.includes(plan.compact);
          const rank = exactId ? 0 : exactNumber ? 1 : exactTitle ? 2 : exactName ? 3 : prefixName ? 4 : exactPhrase ? 5 : 6;
          const popularity = Number.parseInt(String(row.listingCount || '0').replace(/\+/g,''), 10) || 0;
          hits.push({item, rank, popularity});
        }
        hits.sort((a,b) => a.rank-b.rank || b.popularity-a.popularity || a.item.index-b.item.index);
        // A marketplace ID is an exact lookup when it exists. Otherwise short
        // numbers such as 151 must still find card numbers and named boxes.
        if (/^\d+$/.test(plan.text) && hits[0]?.rank===0) hits=hits.filter(hit=>hit.rank===0);
        // Cache only row references. Popular broad queries must not retain a
        // second set of ranking objects for every matching catalogue card.
        hits=hits.map(hit=>hit.item.row);
        if (cache.size >= 8) cache.delete(cache.keys().next().value);
        cache.set(key, hits);
      }
      return {results:hits.slice(offset, limit === Infinity ? undefined : offset+limit), total:hits.length};
    }
    return {search, size:prepared.length};
  }
  function create(snapshot) { return make(snapshot, decode(snapshot).map(prepare)); }
  async function createAsync(snapshot, yieldTask = () => new Promise(resolve => setTimeout(resolve, 0))) {
    if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.rows)) throw new Error('Invalid card search snapshot');
    const fields = snapshot.fields;
    if (fields && (!Array.isArray(fields) || !fields.includes('id') || new Set(fields).size !== fields.length)) throw new Error('Invalid card search fields');
    const prepared = [];
    for (let index=0; index<snapshot.rows.length; index++) {
      const tuple = snapshot.rows[index], row = unpack(snapshot,tuple);
      if (!row.id || !['card','box'].includes(row.kind)) throw new Error('Invalid card search identity');
      row.id=String(row.id);prepared.push(prepare(row,index));
      if (index % 750 === 749) await yieldTask();
    }
    return make(snapshot, prepared);
  }
  return {create, createAsync, decode, normalize:fold, planQuery, promoKey};
});
