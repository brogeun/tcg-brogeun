/* Shared Japanese-card labels. Original product names and identities stay intact. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JapaneseCardNames = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  'use strict';
  const decode = value => String(value || '').replace(/&(?:amp|quot|apos|#39|lt|gt);/g, entity => ({'&amp;':'&','&quot;':'"','&apos;':"'",'&#39;':"'",'&lt;':'<','&gt;':'>'})[entity]).replace(/[’‘]/g, "'").normalize('NFKC');
  const fold = value => decode(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').normalize('NFC').replace(/\s+/g,' ').trim();
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function language(card) {
    const c = typeof card === 'string' ? {name:card} : card || {};
    const text = [c.name,c.originalName,c.productNumber,c.setCode,c.code,c.id].map(decode).join(' ');
    // Explicit edition markers outrank an absent or incorrect catalogue language.
    const markers = [
      ['en', /\[(?:EN|English)(?:\s*ver\.?)?\]|【英語版】|\bEnglish\s+(?:ver\.?|version|edition)\b|(?:^|[\s_-])EN(?:[\s_-]|$)/i],
      ['zh-TW', /\[(?:TC|ZH-TW)\]|【繁体字版】|\bTraditional Chinese\b|\bTaiwanese\s+(?:ver\.?|version|edition)\b/i],
      ['zh-CN', /\[(?:SC|CN|ZH|ZH-CN)\]|【(?:中国語|簡体字)版】|\b(?:Simplified Chinese|Chinese)\s*(?:ver\.?|version|edition)?\b|(?:^|[\s_-])CN-/i],
      ['fr', /\[FR\]|【フランス語版】|\bFrench\s+(?:ver\.?|version|edition)\b/i],
      ['ko', /\[KR\]|【韓国語版】|\bKorean\s+(?:ver\.?|version|edition)\b/i],
      ['th', /\[TH\]|【タイ語版】|\bThai(?:land)?\s+(?:ver\.?|version|edition)\b/i],
      ['id', /\[ID\]|【インドネシア語版】|\bIndonesian\s+(?:ver\.?|version|edition)\b/i],
      ['de', /\[DE\]|【ドイツ語版】|\bGerman\s+(?:ver\.?|version|edition)\b/i],
      ['it', /\[IT\]|【イタリア語版】|\bItalian\s+(?:ver\.?|version|edition)\b/i],
      ['es', /\[ES\]|【スペイン語版】|\bSpanish\s+(?:ver\.?|version|edition)\b/i],
      ['other', /\[(?:Asia|Aisa)\s*ver\.?\]|【外国語版】/i],
    ];
    for (const [code, pattern] of markers) if (pattern.test(text)) return code;
    // The marketplace's image identifier carries an edition code even when
    // the product title omits [EN]. A visible [CN] marker above still wins
    // over an incorrectly filed image (such products exist in this inventory).
    const imageEdition = [c.thumbnailUrl,c.image,c.imageUrl].map(decode).join(' ').match(/(?:pkmn|pokemon)-tcg-(en|cn|zh-tw|tc|ko|kr|th|id|fr|de|it|es)-/i)?.[1]?.toLowerCase();
    if (imageEdition) return ({en:'en',cn:'zh-CN','zh-tw':'zh-TW',tc:'zh-TW',ko:'ko',kr:'ko',th:'th',id:'id',fr:'fr',de:'de',it:'it',es:'es'})[imageEdition];
    const explicit = String(c.language || '').toLowerCase();
    return ({ja:'ja',jp:'ja',japanese:'ja',en:'en',english:'en',zh:'zh-CN',cn:'zh-CN','zh-cn':'zh-CN','zh-tw':'zh-TW',chinese:'zh-CN',ko:'ko',kr:'ko',fr:'fr',th:'th',id:'id',de:'de',it:'it',es:'es'})[explicit] || (explicit ? 'other' : 'ja');
  }

  function normalizeQuery(value) {
    return fold(value).toLowerCase().replace(/([가-힣])의(?=[\s가-힣])/g, '$1').replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  function parts(card) {
    const name = decode(typeof card === 'string' ? card : card?.name);
    // [Ice] is part of Ancient Technical Machine's title; [A] is Unown's
    // alphabet form. Only collector identifiers delimit the name.
    let collector = [...name.matchAll(/\[([^\]]+)\]/g)].find(match=>{
      const value=match[1].trim();
      return /\bNo\.?\s*\d+/i.test(value)||/^(?:\d{1,4}(?:st|nd|rd|th)?|\d{1,4}-\d{1,4}|20\d{2}\s+VS)$/.test(value)||/(?:\d{1,4}[a-z]?(?:-\d{1,4})?|[A-Z]{3}|(?:SV|GG)\d{1,4})\s*\/\s*(?:\d{1,4}|[A-Za-z0-9-]+)$/i.test(value)||/^[A-Za-z0-9+_-]{1,15}\s+#?\d/i.test(value)||/^(?:[A-Za-z0-9+_-]{1,15}\s+)?DPBP#\d+/i.test(value)||/^[A-Za-z0-9+_-]{1,15}\s+(?:FIG|GIF|FIR|WAT|LIG|GRA|PSY|DAR|MET|FAI)$/i.test(value)||/^[A-Za-z]{1,4}\d[A-Za-z0-9+_-]*$/.test(value)||/^(?:\d{1,4}\s+)?(?:(?:PMCG|PCG|ADV|SV|SM|S|M|BW|XY|DP|DPt|L|e|neo)-[A-Za-z0-9-]+|PROMO|PW|GB|VS|DP|8NE-PCT-KFG)$/i.test(value)||/^PROMO\s+SV-P$/i.test(value);
    });
    if(!collector)collector=name.match(/\[([A-Za-z0-9+_-]{1,15}\s+\d[A-Za-z0-9/-]*)(?=\s*\(|$)/);
    const printed = collector?.[1] || name.match(/\([^)]*?(\d{1,4}\s*\/\s*[A-Za-z0-9-]+)\)/)?.[1] || name.match(/\([^)]*?((?:No\.?|#)\s*\d+)\)/i)?.[1] || (typeof card === 'object' ? card.number || card.fullId || '' : '');
    // Collector parentheses describe the set; parentheses before metadata can be a form.
    let head = (collector ? name.slice(0,collector.index) : name).replace(/\s*【[\s\S]*$/, '');
    head = head.replace(/\s*\([^)]*(?:\d{1,4}\s*\/|\bNo\.|Pack|Collection|Deck|Booster|Expansion|Promotional|\bSet\b|Battle Road|Champions League|Sword\s*&\s*Shield)[\s\S]*$/i, '').trim();
    const suffix = name.match(/\b(?:Reverse Holo|Master Ball Mirror|Monster Ball Mirror|Mirror Holo|Reverse|Holo|Mirror)\b(?=\s*$)/i)?.[0];
    if (suffix && !head.toLowerCase().endsWith(suffix.toLowerCase())) head += ' : ' + suffix;
    return {head,printed:decode(printed).trim()};
  }

  function displayedIdentifier(card, printed) {
    // An unnumbered card's catalogue position is not its printed card number.
    // Keep the source identifier for search and matching, but label its role.
    if (card?.unprintedNumber === true) {
      const position = decode(card.inventoryNumber || printed).replace(/^(?:No\.?|#)\s*/i,'').trim();
      return position ? '목록 '+position : '';
    }
    return printed;
  }

  function create(initial) {
    let data, exact = new Map(), owners = new Map(), species = new Map(), perCard = new Map(), terms = [], speciesPattern, namesPattern, personPattern, ready;
    const cache = new Map();
    function configure(next) {
      if (!next || next.schemaVersion !== 1) throw new Error('Invalid Japanese card-name dictionary');
      data = next;
      exact = new Map(Object.entries(next.names || {}).map(([key,value]) => [fold(key).toLowerCase(),decode(value)]));
      owners = new Map(Object.entries(next.owners || {}).map(([key,value]) => [fold(key).toLowerCase(),decode(value)]));
      species = new Map(Object.entries(next.species || {}).map(([key,value]) => [fold(key).toLowerCase(),decode(value)]));
      perCard = new Map(Object.entries(next.perCard || {}).map(([key,value])=>[decode(key).replace(/\s+/g,'').toUpperCase(),value]));
      terms = Object.entries(next.terms || {}).sort((a,b)=>b[0].length-a[0].length).map(([en,ko]) => [new RegExp('(?<![A-Za-z])'+escape(en)+'(?![A-Za-z])','gi'),ko]);
      const keys = [...species.keys()].sort((a,b)=>b.length-a.length).map(escape);
      speciesPattern = keys.length ? new RegExp('(?<![A-Za-z])(?:'+keys.join('|')+')(?![A-Za-z])','gi') : null;
      // A person's name is not a general English word replacement (Dawn Wings / Leaf Energy).
      const nameKeys = [...exact.keys()].filter(key=>!owners.has(key)).sort((a,b)=>b.length-a.length).map(escape);
      namesPattern = nameKeys.length ? new RegExp('^(?:'+nameKeys.join('|')+')(?![A-Za-z]|\'s)','i') : null;
      const personKeys = [...owners.keys()].sort((a,b)=>b.length-a.length).map(escape);
      personPattern = personKeys.length ? new RegExp('^(?:'+personKeys.join('|')+')(?=$|\\s*(?::|[◇☆★("&]|(?:Extra Battle Day|Battle Festa|Authorized Voluntary Events|PROMO|SAR|SR|RR|RRR|AR|R|U|C|P|HR|UR|SSR|S|CHR|CSR|MA|MUR)\\b))','i') : null;
      cache.clear();
      return api;
    }
    async function ensureData() {
      if (data) return api;
      if (!ready) ready = fetch('/data/japanese-card-names-ko.json?v=20261014-jp3',{signal:AbortSignal.timeout(12000)}).then(response=>{
        if (!response.ok) throw new Error('Japanese card names HTTP '+response.status);
        return response.json();
      }).then(configure).catch(error=>{ready=null;throw error});
      return ready;
    }
    function translate(head) {
      let value = fold(head).replace(/\b(Hisuian|Galarian|Alolan|Paldean)(?=[A-Z])/g,'$1 ').replace(/'s(?=[A-Z])/g,"'s ").replace(/\b(Ice Rider|Shadow Rider|Rapid Strike|Single Strike)(?=[A-Z])/g,'$1 ').replace(/(?<=[a-z])(?=Soul Link)/g,' ');
      value = value.replace(/\b(\d+)(?:st|nd|rd|th)(?=\s+(?:Anniversary|Holo|Celebration)\b|\))/gi,'$1주년').replace(/\b(\d+)(?:st|nd|rd|th)(?=\s+Illustration Grand Prix\b)/gi,'제$1회');
      value = value.replace(/(\d+)주년\s+Anniversary\b/gi,'$1주년');
      const direct = exact.get(value.toLowerCase());
      if (direct) value = direct;
      else {
        if (namesPattern) value = value.replace(namesPattern,match=>exact.get(match.toLowerCase()));
        if (personPattern) value = value.replace(personPattern,match=>owners.get(match.toLowerCase()));
        value = value.replace(/\(([^)]+)\)/g,(whole,inside)=>owners.has(inside.toLowerCase())?'('+owners.get(inside.toLowerCase())+')':whole);
        // Do not infer an unknown owner's Korean spelling from a Pokemon species.
        value = value.replace(/^(.+?)'s\s*/i, (whole, owner) => owners.has(owner.toLowerCase()) ? owners.get(owner.toLowerCase())+'의 ' : whole);
        if(personPattern)value=value.replace(/^(.+?의\s+)(.*)$/,(_,owner,tail)=>owner+tail.replace(personPattern,match=>owners.get(match.toLowerCase())));
        value = value.replace(/^(?:MEGA|M)\s+(?=\S)/i, '메가');
        for (const [pattern,ko] of terms) value = value.replace(pattern,ko);
        if (speciesPattern) value = value.replace(speciesPattern,match=>species.get(match.toLowerCase()));
      }
      value = value.replace(/^(?:MEGA|M)\s+(?=\S)/i, '메가');
      value = value.replace(/\b(FB|GL|G|C|F|E4)LV\.X\b/gi,'$1 LV.X');
      for (const [pattern,ko] of terms) value = value.replace(pattern,ko);
      value = value.replace(/^(보스의 지령)\s+([A-Za-z]+)\b/, (whole,prefix,owner)=>owners.has(owner.toLowerCase())?prefix+' ('+owners.get(owner.toLowerCase())+')':whole);
      value = value.replace(/^(피카츄|이브이)\s+판초를 입은(?:\s+\1)?/,'판초를 입은 $1').replace(/^([가-힣]+)\s+포케파크(?:에서|의)/,'포케파크의 $1');
      value = value.replace(/\bLV\.?\s*(?!X\b)(\d+)\b/gi,'레벨 $1').replace(/\b(?:SA)\b\s*:\s*SA\b/gi,'SA');
      return value.replace(/\s*:\s*/g,' · ').replace(/\s+/g,' ').replace(/(?:\s*·\s*)+/g,' · ').replace(/^[\s·]+|[\s·]+$/g,'').trim();
    }
    function title(card) {
      if (!card) return '';
      const c = typeof card === 'string' ? {name:card,brand:'pokemon'} : card;
      const {head,printed} = parts(c);
      const identifier = displayedIdentifier(c, printed);
      if (c.brand && c.brand !== 'pokemon') return head+(identifier?' ['+identifier+']':'');
      // A trusted per-card Korean name takes precedence, including when fetched later.
      const bracket = decode(c.name).match(/\[([^\s\]]+)\s+([^\]]+)\]/);
      const code = decode(c.setCode || c.boxCode || c.code || bracket?.[1]).toUpperCase();
      const number = decode(c.number || bracket?.[2]).replace(/\s+/g,'').toUpperCase();
      const official = perCard.get(code+':'+number);
      const productOverride = data?.byId?.[String(c.productId || c.id)];
      const supplied = c.nameKo || c.name_ko || c.koName || c._koName || (typeof official==='string'?official:official?.nameKo) || (typeof productOverride==='string'?productOverride:productOverride?.nameKo);
      const key = [c.id,c.productId,c.name,c.variant,c.unprintedNumber,c.inventoryNumber,supplied,printed].join('\0');
      if (cache.has(key)) return cache.get(key);
      let label = supplied ? translate(parts(supplied).head) : translate(head);
      if(productOverride?.kind==='catalogue-display-base'){
        const sourceLabel=translate(head);
        // A known card base with an unknown product suffix must keep that
        // suffix visible. A catalogue match does not translate vendor wording.
        if(sourceLabel.startsWith(label+' '))label=sourceLabel;
      }
      const rawEx=head.match(/\b(?:EX|ex)\b/g)||[];
      if(!supplied&&new Set(rawEx).size===1)label=label.replace(/\bex\b/gi,rawEx[0]);
      if(supplied){
        const chunks=head.split(/\s*:\s*/),titleChunks=/^(?:Technical Machine|Flyinium Z|Normalium Z)\s*:/i.test(head)?2:1;
        const main=chunks.slice(0,titleChunks).join(': '),rarity=main.match(/\s(V-UNION|LV\.X|EX|GX|VMAX|VSTAR|BREAK|LEGEND|SAR|SR|RRR|RR|AR|HR|UR|SSR|CHR|CSR|MA|MUR|SA|PR|R|U|C|P|S|M)\s*$/)?.[1];
        const level=main.match(/\bLV\.?\s*(\d+)\b/i),attributes=chunks.slice(titleChunks).join(' : ');
        for(const [extra,separator] of [[rarity,' '],[level?'레벨 '+level[1]:'',' '],...(attributes?translate(attributes).split(' · ').map(extra=>[extra,' · ']):[])])if(extra&&!normalizeQuery(label).includes(normalizeQuery(extra)))label+=separator+extra;
      }
      // Movie-pack M is printed after the species. It is a separate card
      // identity attribute, unlike the older Mega mechanic's leading M.
      if(c.variant==='M'&&!/(?:^|\s)M(?=\s|$)/.test(label))label+=' M';
      const result = label+(identifier&&!label.includes('['+identifier+']')?' ['+identifier+']':'');
      if (cache.size > 30000) cache.clear();
      cache.set(key,result);
      return result;
    }
    function searchText(card) {
      const c = typeof card === 'string' ? {name:card} : card || {};
      return normalizeQuery([title(c),c.name,c.nameKo,c.name_ko,c.koName,c.productNumber,c.number,c.fullId,...(c.aliases || [])].filter(Boolean).join(' '));
    }
    function unresolved(card) {
      // Printed model and rarity codes remain visible. Unown's alphabet form
      // must not consume the first letter of the VSTAR mechanic.
      const printed=displayedIdentifier(card,parts(card).printed);
      let visible=title(card);
      if(printed&&visible.endsWith(' ['+printed+']'))visible=visible.slice(0,-printed.length-3);
      const label = visible.replace(/안농\s*(?:\[[A-Z!?]\]|\([A-Z!?]\)|[A-Z!?](?![A-Za-z]))/g,'안농').replace(/(?<![A-Za-z])(?:V-UNION|LV\.X|ACE\s*SPEC|HANDY(?:505|910is)|GFPD|WLFM|TS-[12]|G-\d{3}|CS\d{4}|SC2|B\/RGB|G\/RGB|R\/RGB|MC|PRO|VIP|UB|MAX|FF|WP|AZ|PP|DX|GB2?|AD|SIR|SUR|BWR|TV|ex|EX|GX|V|VMAX|VSTAR|BREAK|LEGEND|SP|SAR|SR|RR|RRR|AR|R|U|C|P|HR|UR|SSR|S|CHR|CSR|MA|MUR|SA|K|A|B|D|F|G|H|M|W|GL|FB|E4|C4|X|Y|Z|N|HP|PR|L|TR|ACE|No\.?\s*\d+)(?![A-Za-z])/g,'');
      return /[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/.test(label) ? label.replace(/\s+/g,' ').trim() : '';
    }
    const api = {configure,ensureData,title,searchText,normalizeQuery,language,unresolved,parts};
    if (initial) configure(initial);
    return api;
  }
  return Object.assign(create(),{create});
});
