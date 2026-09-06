/* Exact catalog links shared by slide and expanded price details. No fuzzy names. */
(function(root) {
  'use strict';
  const clean = value => String(value || '').normalize('NFKC').replace(/&quot;|&#34;/g,'"').replace(/&amp;/g,'&').trim();
  const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const aliasCache=new WeakMap();
  const norm=value=>clean(value).toLowerCase().replace(/[’‘]/g,"'").replace(/\s+/g,' ');
  const quoted=value=>[...clean(value).matchAll(/["「“]([^"」”]+)["」”]/g)].map(m=>m[1]);
  function aliasesFor(data,sets,brand) {
    let cache=aliasCache.get(data);if(!cache){cache=new Map();aliasCache.set(data,cache);}
    if(cache.get(brand)?.sets===sets)return cache.get(brand).aliases;
    const codes=new Map(sets.map(s=>[s.code.toLowerCase(),s]));
    const aliases=new Map();
    function add(name,set){if(!name)return;const key=norm(name);if(!aliases.has(key))aliases.set(key,new Set());aliases.get(key).add(set);}
    for(const set of sets){add(set.name,set);add(set.name.replace(/\s*\([^()]+\)\s*$/,''),set);add(set.name.match(/\(([^()]+)\)\s*$/)?.[1],set);}
    for(const row of data.manual?.[brand] || []){const set=codes.get(clean(row.code).toLowerCase());if(set){add(row.jp_name,set);quoted(row.name).forEach(name=>add(name,set));}}
    cache.set(brand,{sets,aliases});return aliases;
  }
  function resolve(product, brand, box, catalog, data = {}) {
    if (!product) return {sets:[],via:'none'};
    const sets=catalog[brand] || [];
    const id=String(product.id || '');
    const unique=values=>[...new Map(values.filter(Boolean).map(s=>[s.code,s])).values()];
    const byCode=code=>sets.find(s=>s.code.toLowerCase()===clean(code).toLowerCase());
    const direct=sets.find(s=>s.boxId && String(s.boxId)===String(box ? product.boxId || id : product.boxId || ''));
    if (direct) return {sets:[direct],via:'box-id'};
    // A product may be included in multiple boxes (reprints); keep all recorded links.
    const mapped=!box ? unique((data.cardToBox?.[id] || []).map(link=>byCode(link.setCode))) : [];
    if (mapped.length) return {sets:mapped,via:'card-id'};
    const indexed=data.meta?.[id] || {};
    const manual=(data.manual?.[brand] || []).find(row=>String(row.id)===id) || {};
    const override=data.overrides?.[id] || {};
    const cardOverride=data.cardOverrides?.[id] || {};
    const known=[product, indexed, manual, override, cardOverride];
    const codeFields=known.flatMap(row=>[row.setCode,row.set_code,row.code,row.productNumber]);
    const codeMatches=field=>{
      const text=clean(field).replace(/^(?:pkmn|opc)-tcg-/i,'');
      // OP-16 and OP16 are the same explicit set code, not a name similarity match.
      const normalized=text.replace(/^(OP|ST|EB|PRB)-(\d+)/i,'$1$2');
      return sets.slice().sort((a,b)=>b.code.length-a.code.length).find(s=>new RegExp('^'+escapeRE(s.code)+'(?:$|[\\s/\\-])','i').test(normalized));
    };
    const fields=unique(codeFields.map(codeMatches));
    if (box && fields.length===1) return {sets:fields,via:'product-code'};
    const names=known.flatMap(row=>[clean(row.name),clean(row.koName)]).filter(Boolean);
    // Promotional/reprint versions must not inherit the original card's box release date.
    const special=!box && names.some(n=>/Promo(?:tional)?\b|Promotion Pack|プロモーション|プロモ|프로모|재록/i.test(n));
    if (special) return {sets:[],via:'unregistered-promotion'};
    // Exact registered pack names may identify reprint sets; never compare similarity.
    // For boxes, use only their ID-indexed metadata/override, after direct IDs and codes.
    const candidates=(box?[indexed,manual,override]:known).flatMap(row=>{
      const name=clean(row.name);const parens=[...name.matchAll(/\(([^()]+)\)/g)].map(m=>m[1].replace(/^(?:High Class|Booster|Expansion|Extra Booster)\s+Pack\s+/i,''));
      return [...quoted(name),...parens];
    }).map(norm);
    const aliases=aliasesFor(data,sets,brand);
    const exactNames=unique(candidates.flatMap(name=>[...(aliases.get(name) || [])]));
    if(exactNames.length===1)return {sets:exactNames,via:'exact-registered-name'};
    if (fields.length===1) return {sets:fields,via:'product-code'};
    const brackets=unique(names.flatMap(name=>[...name.matchAll(/\[([^\]]+)\]/g)].map(m=>codeMatches(m[1]))));
    if (brackets.length===1) return {sets:brackets,via:'name-code'};
    return {sets:[],via:fields.length>1 || brackets.length>1?'ambiguous':'none'};
  }
  let pending=null;
  async function load() {
    if (!pending) pending=(async()=>{
      const fetchJSON=async path=>{try{const r=await fetch(path,{signal:AbortSignal.timeout(10000)});return r.ok?await r.json():{};}catch{return {};}};
      const [meta,links,pk,op,overrides,cardOverrides]=await Promise.all([
        typeof _PRICE_CARD_META_INDEX!=='undefined' && _PRICE_CARD_META_INDEX || fetchJSON('/data/cards-meta-index.json'),
        root._CARD_TO_BOX ? {cards:root._CARD_TO_BOX} : fetchJSON('/data/card-to-box.json'),
        fetchJSON('/data/manual-boxes-pokemon.json'),fetchJSON('/data/manual-boxes-onepiece.json'),
        typeof _PRICE_BOX_NAME_OVERRIDES!=='undefined' && _PRICE_BOX_NAME_OVERRIDES || fetchJSON('/data/price-box-name-overrides.json'),
        fetchJSON('/data/price-card-name-overrides.json')
      ]);
      return {meta,cardToBox:links.cards || {},manual:{pokemon:pk.products || [],onepiece:op.products || []},overrides,cardOverrides};
    })();
    return pending;
  }
  async function get(product,brand,box) { return resolve(product,brand,box,CARDINFO,await load()); }
  const label = set => `${set.code} · ${set.name}`;
  const api={resolve,get,label};
  root.PriceProductInfo=api;
  if(typeof module!=='undefined' && module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
