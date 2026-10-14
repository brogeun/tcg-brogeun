/* Contained-card identity only. Never infer an artwork from p1/p2 order or price. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ContainedCardMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const upper = value => String(value || '').toUpperCase();
  // Only aliases established by an actual productNumber; never collapse split sets.
  const aliases = {
    'ADV4':['ADVEX'], // Local Magma vs Aqua (080); SNKRDUNK ADV4 is a different 083-card set.
    'BW1-BB':['BW1-B','BW1'], 'BW1-BW':['BW1-W','BW1'],
    'BW3-BH':['BW3-W'], 'BW3-BP':['BW3-P'],
    'BW5-BRN':['BW5-O'], 'BW5-BRZ':['BW5-G'],
    'BW6-BC':['BW6-W'], 'BW6-BF':['BW6-B'],
    'BW8-BRF':['BW8-K'], 'BW8-BRN':['BW8-N'],
    'XY1-BX':['XY1-X'], 'XY1-BY':['XY1-Y'],
    'XY5-BG':['XY5-G'], 'XY5-BT':['XY5-T'],
    'XY8-BB':['XY8-B'], 'XY8-BR':['XY8-R'],
    'XY11-BB':['XY11-E','XY11-2'], 'XY11-BR':['XY11-R','XY11-1'],
    'L1-BHG':['L1-H'], 'L1-BSS':['L1-S'], 'L2':['L2-L'],
    'DP4-BD':['DP4-DR'], 'DP4-BM':['DP4-MP'],
    'DP5':['DP5-CS'], // Local Cry from the Mysterious, not Temple of Wrath (DP5-TW).
    'CL1':['PMCG1'], 'CL2':['PMCG2'], 'CL3':['PMCG3'], 'CL4':['PMCG4'],
    'GYM1':['PMCG-G1'], 'GYM2':['PMCG-G2'],
    'BSTXY':['XY-BEST','XY'], // The Best of XY prints XY; the 171-card fraction stays required.
    'DPT-MRP09':['M'], // Movie cards retain the 022-card printed fraction.
    'ADV4-SEAL':['ADV4'], // Undone Seal prints /083; Magma vs Aqua retains /080.
    'DP5-TW':['DP5-TW']
  };
  const legacy = card => card.brand === 'pokemon' && !/\d+\/\d+/.test(card.number || '') &&
    (/\bNo\.\s*\d+/i.test(card.name || '') || /^No\./i.test(card.number || ''));
  const paired = product => /\bLEGEND\b/i.test(product.name||'') && /\d{3}-\d{3}/.test((product.name||'')+' '+(product.productNumber||''));
  function numberOf(card) {
    return String(card.baseNumber || card.number || (String(card.name || '').match(/\bNo\.\s*(\d+)/i) || [])[1] || '')
      .replace(/^No\.\s*/i, '').split(/[\/_]/)[0].replace(/^0+(?=\d)/, '');
  }
  function foreign(product) {
    const language = String(product.language || '').toLowerCase();
    return (language && !['ja', 'jp', 'japanese', '日本語'].includes(language)) ||
      /(?:^|-)(?:tcg|pkmn)-(?:en|eng|cn|zh|kr|ko|fr|de|it|es|pt|th|id)(?:-|$)/i.test(product.productNumber || '') ||
      /(?:pkmn|pokemon)-tcg-(?:en|eng|cn|zh(?:-tw)?|tc|kr|ko|fr|de|it|es|pt|th|id)-/i.test([product.thumbnailUrl,product.image,product.imageUrl].filter(Boolean).join(' ')) ||
      /\((?:Sword & Shield|Sun & Moon|Scarlet & Violet|Black & White|XY)\s*["“]/i.test(product.name || '') ||
      /\[[^\]]*\b(?:EN|ENG|CHN|ZH|CN|KR|KOR|KO|FR|DE|IT|ES|PT|TH|ID)\b[^\]]*\]|\b(?:English|Chinese|Korean|French|German)\s+(?:Ver|Version|Edition)|(?:英語|韓国語|中国語|フランス語|ドイツ語|イタリア語|スペイン語|タイ語|ポルトガル語|インドネシア語)版/i.test(product.name || '');
  }
  function sameIdentity(card, product, candidateProofs = {}) {
    if (!product || product.brand !== card.brand || product.kind === 'box' || foreign(product)) return false;
    const code = upper(card.setCode || card.boxCode), num = numberOf(card);
    if (!num || !code) return false;
    const pn = upper(product.productNumber), name = String(product.name || '');
    // Some English catalogue entries reuse the Japanese productNumber. The
    // printed fraction in their title must not contradict the source card.
    const sourceFraction=String(card.number||'').match(/(\d+)\/(\d+)/);
    const listedFraction=name.match(/\[?(\d+)\/(\d+)\]?/);
    const codes = [code, ...(aliases[code] || [])].filter(c=>c!=='BW1'||code==='BW1'||(num==='56'&&Number(sourceFraction?.[2])===53));
    if(sourceFraction&&/\bLEGEND\b/i.test(card.name||'')&&paired(product)) {
      const pair=name.match(/\[([^\s\]]+)\s+(\d{3})-(\d{3})\/(\d+)\]/);
      if(pair)return codes.includes(upper(pair[1]))&&[Number(pair[2]),Number(pair[3])].includes(Number(sourceFraction[1]))&&Number(pair[4])===Number(sourceFraction[2]);
      return codes.some(c=>new RegExp('(?:^|-)'+escape(c)+'-(?:0*'+escape(num)+'-\\d+|\\d+-0*'+escape(num)+')$','i').test(pn));
    }
    if(sourceFraction&&listedFraction&&(Number(sourceFraction[1])!==Number(listedFraction[1])||Number(sourceFraction[2])!==Number(listedFraction[2])))return false;
    if (legacy(card)) {
      // TCG Collector's No. is an inventory position, NOT a printed card number.
      // Limit to the actual set namespace + exact character/title, then require
      // artwork confirmation (or explicit selection) in resolve below.
      const normalized = value => String(value).normalize('NFKC').replace(/[‘’]/g,"'")
        .replace(/^Basic (?=(?:Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Fairy) Energy\b)/i,'')
        .replace(/\s*♂/g,'(Male)').replace(/\s*♀/g,'(Female)').replace(/é/g,'e')
        .replace(/^Rocket's /i,"Team Rocket's ").replace(/^Technical Machine:\s*/i,'Technical Machine ')
        .replace(/Quiz #(\d+)/i,'Quiz Part $1')
        .replace(/^Unown \[([A-Z!?])\]/i,'Unown $1').replace(/\s+/g,' ').trim();
      const title = normalized(String(card.name || '').replace(/\s*\([^)]*No\.\s*\d+\).*$/i,''));
      if (!title || /Promotion|プロモ|Starter|Start Deck|Half Deck|Movie|Prize/i.test(name)) return false;
      const namespaces=aliases[code] || [code];
      const inSet=namespaces.some(c=>new RegExp('(?:^|-)' + escape(c) + '(?:-|$)','i').test(pn) ||
        new RegExp('\\[' + escape(c) + '(?:\\s|\\])','i').test(name));
      const proof=candidateProofs[[card.brand,upper(card.boxCode),card.name].join(':')];
      const checkedTranslation=proof?.products?.some(p=>String(p.id)===String(product.id)&&p.name===product.name&&p.productNumber===product.productNumber);
      return inSet && (checkedTranslation || new RegExp('^'+escape(title)+'(?=\\s*(?:\\[|\\(|\\*|:|LV\\.?|(?:C|U|R|RR|SR)\\b|$))','i').test(normalized(name)));
    }
    if (codes.some(c => new RegExp('(?:^|-)' + escape(c) + '-0*' + escape(num) + '$', 'i').test(pn))) return true;
    if (codes.some(c => new RegExp('\\[' + escape(c) + '(?:\\s+|-)0*' + escape(num) + '(?:/|\\]|\\s)', 'i').test(name))) return true;
    // Old Japanese sets use No. instead of collection numbers. Require exact title,
    // not just the Pokémon's name or a generic national Pokédex number.
    return /^No\./i.test(card.number || '') || /\bNo\.\s*\d+/i.test(card.name || '')
      ? upper(name).replace(/\s+/g, ' ').trim() === upper(card.name).replace(/\s+/g, ' ').trim()
      : false;
  }
  function special(product) {
    return /-(?:P|SP|SPC|RSP|TR|GSP|RP)(?=[\s[(])|Parallel|パラレル|Comic|コミパラ|Premium\s*Card|Promotion|プロモ|Anniversary|Champion|Flagship|Tournament|Prize|Winner|Reverse\s*Holo|Master\s*Ball|Monster\s*Ball|Mirror|ミラー|マスターボール/i.test(product.name || '');
  }
  function resolve(card, products, verified = {}, candidateProofs = {}) {
    const fullId = upper(card.fullId || ''), key = [card.brand, upper(card.boxCode), fullId].join(':');
    const proof = verified[key];
    if (proof && /^\d+$/.test(String(proof.id)) && proof.brand === card.brand && upper(proof.fullId) === fullId) {
      const product = products.find(p => String(p.id) === String(proof.id));
      // A verified link can exist before the price feed contains that product.
      if (product && !sameIdentity(card, product, candidateProofs)) return {status: 'conflict', id: null};
      return {status: product ? 'matched' : 'verified-link', id: String(proof.id), proof};
    }
    const candidates = [...new Map(products.filter(p => sameIdentity(card, p, candidateProofs)).map(p => [String(p.id), p])).values()];
    if(candidates.length&&candidates.every(paired))return {status:'paired-product',id:null};
    if (card.brand === 'pokemon' && card.id) {
      const direct = candidates.find(p => String(p.id) === String(card.id));
      if (direct) return {status: 'matched', id: String(direct.id)};
    }
    // Rebuilt source lists contain plain cards. An edition-only market listing
    // must not become the plain card's price merely because it is the only one.
    if (card.marketLinkPolicy === 'verified-only') {
      return {status: candidates.length ? 'artwork-pending' : 'unlinked', id: null};
    }
    if (legacy(card)) return {status:candidates.length ? 'artwork-pending' : 'unlinked', id:null};
    if (card.brand === 'pokemon' && special(card)) return {status: 'artwork-pending', id: null};
    if (card.brand === 'onepiece' && fullId) {
      const artwork = candidates.filter(p => {
        const url = p.thumbnailUrl || p.image || '';
        return new RegExp('/' + escape(fullId) + '\\.(?:png|jpe?g|webp)(?:[?#]|$)', 'i').test(url);
      });
      if (artwork.length === 1) return {status: 'matched', id: String(artwork[0].id)};
      if (fullId.includes('_')) return {status: 'artwork-pending', id: null};
    }
    const plain = candidates.filter(p => !special(p));
    return plain.length === 1 ? {status: 'matched', id: String(plain[0].id)} :
      {status: plain.length > 1 ? 'ambiguous' : 'unlinked', id: null};
  }
  function createResolver(products, verified = {}, candidateProofs = {}) {
    const pools = new Map();
    function poolFor(card) {
      const code = upper(card.setCode || card.boxCode), key = card.brand + ':' + code;
      if (!pools.has(key)) {
        const codes = [code, ...(aliases[code] || [])];
        pools.set(key, products.filter(p => p.brand === card.brand &&
          codes.some(c => upper(p.name).includes(c) || upper(p.productNumber).includes(c))));
      }
      return pools.get(key);
    }
    const find = card => {
      const proof = verified[[card.brand, upper(card.boxCode), upper(card.fullId)].join(':')];
      const pool = poolFor(card);
      // Include the verified product even if its metadata is inconsistent, so
      // resolve can report a conflict instead of silently trusting the ID.
      const product = proof && products.find(p => String(p.id) === String(proof.id));
      return resolve(card, product && !pool.includes(product) ? [...pool, product] : pool, verified, candidateProofs);
    };
    find.candidates = card => [...new Map(poolFor(card).filter(p=>sameIdentity(card,p,candidateProofs)).map(p=>[String(p.id),p])).values()];
    return find;
  }
  return {resolve, createResolver, sameIdentity, numberOf, foreign, aliases, legacy, paired};
});
