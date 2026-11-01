/* Source rarity only. Mount explicitly in a box's existing contained-card panel. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardRarityFilters = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const UNKNOWN = 'unknown', NOT_APPLICABLE = 'not-applicable', SOURCE_UNLISTED = 'source-unlisted';
  const metadataRequests = new Map();
  const metadataURLs = {
    pokemon:'/data/collections/sources/pokemon-jp-rarity-metadata.json?v=20261101-rarity-recheck1',
    'pokemon-en':'/data/collections/sources/pokemon-en-rarity-recheck.json?v=20261101-rarity-deep1',
    onepiece:'/data/collections/sources/onepiece-printing-metadata.json?v=20261029-source-rarity-1'
  };
  const referenceURLs = {
    pokemon:'/data/collections/sources/pokemon-jp-rarity-crossdb.json?v=20261101-crossdb1',
    'pokemon-en':'/data/collections/sources/pokemon-en-rarity-crossdb.json?v=20261101-crossdb1'
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
  const empty = /^(?:[-—?]|unknown|unconfirmed|미확인|확인\s*중)$/i;
  const referenceValue = ref => {
    const literal=ref.literal.normalize('NFKC').trim().replace(/\s+/g,' ');
    return ({'Rare Secret':'Secret Rare','Holo Rare':'Rare Holo'})[literal] || literal;
  };

  function metadata(card) {
    if (card?.rarityNotApplicable === true) return {key:NOT_APPLICABLE, label:'해당 없음', state:'not-applicable'};
    // Never read a title, price, card number, parallel suffix or grading grade.
    const original = typeof card?.rarity === 'string' ? card.rarity.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
    if (!original || empty.test(original)) {
      if (typeof card?.rarityReferenceValue==='string' && card.rarityReferenceValue.trim()) {
        const value=card.rarityReferenceValue.normalize('NFKC').trim();
        return {key:'reference:'+value.toUpperCase(),label:value+' · 참고',state:'reference-grade'};
      }
      if (card?.rarityReferenceConflict === true) return {key:'reference-conflict',label:'자료 간 등급 차이',state:'reference-conflict'};
      if (card?.rarityDisclosureStatus === 'verified-unprinted-rarity') return {key:'documented-unprinted',label:'희귀도 표기 없음',state:'documented-unprinted'};
      if (card?.rarityReferenceUnlisted === true) return {key:'reference-unlisted',label:'미표기 분류 · 외부 DB',state:'reference-unlisted'};
      return card?.raritySourceUnlisted === true ?
        {key:SOURCE_UNLISTED, label:'원문 등급 미표기', state:'source-unlisted'} :
        {key:UNKNOWN, label:'미확인', state:'unknown'};
    }
    // These are literal manufacturer catalogue categories, not invented grades.
    const label = (typeof card.rarityDisplayLabel === 'string' && card.rarityDisplayLabel.trim()) ||
      (original==='NATSU' ? '복각 카드 (NATSU)' : original==='ENE' ? '기본 에너지 (ENE)' : original);
    return {key:'known:' + original.toUpperCase(), label, state:'known'};
  }

  function options(cards) {
    const grouped = new Map();
    for (const card of Array.isArray(cards) ? cards : []) {
      const item = metadata(card), found = grouped.get(item.key);
      if (found) found.count++;
      else grouped.set(item.key, {...item, count:1});
    }
    return [...grouped.values()].sort((a,b) => {
      const order = item => ({known:0,'reference-grade':1,'documented-unprinted':2,'reference-unlisted':3,'reference-conflict':4,'source-unlisted':5,unknown:6,'not-applicable':7})[item.state];
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
      // A verified publisher classification may fill a reviewed blank, never an
      // existing grade. A missing printed symbol alone is not such evidence.
      const state = metadata(card).state;
      if (state !== 'unknown' && state !== SOURCE_UNLISTED) return card;
      if (brand === 'pokemon' || brand === 'pokemon-en') {
        const source = String(card.url || card.sourceUrl || '');
        const entry = Object.prototype.hasOwnProperty.call(payload.cards,source) ? payload.cards[source] : null;
        if (payload.schemaVersion !== 1 || payload.brand !== 'pokemon' || payload.language !== (brand==='pokemon-en'?'en':'ja') ||
            !entry || entry.sourceUrl !== source ||
            String(entry.setCode).toUpperCase() !== String(setCode).toUpperCase() ||
            entry.number !== card.number || entry.name !== card.name) return card;
        const proof = entry.rarityEvidence;
        const publisherVerified = entry.rarityStatus === 'manufacturer-verified' &&
          proof?.schemaVersion === 1 && proof.value === entry.rarity && proof.exactEdition === true &&
          ['manufacturer-exact-product-checklist','manufacturer-indexed-cache-literal'].includes(proof.kind) &&
          /^https:\/\/(?:assets\.pokemon\.com|www\.pokemon\.com)\//.test(proof.url || '');
        const references = Array.isArray(proof?.references) ? proof.references : [];
        const external = proof?.schemaVersion === 1 && ['external-explicit','external-candidate'].includes(proof.kind) && proof.exactCardIdentity === true &&
          references.length > 0 && references.every(ref=>typeof ref.provider==='string' && typeof ref.literal==='string' &&
            ref.literal.trim() && /^https:\/\//.test(ref.url || ''));
        if (external && proof.kind==='external-candidate' && entry.rarityStatus==='reference-candidate' && !entry.rarity) {
          return {...card,rarityEvidence:proof};
        }
        if (external && entry.rarityStatus === 'reference-unlisted' && !entry.rarity && proof.value === 'None' &&
            references.every(ref=>ref.literal==='None')) {
          return {...card,rarityOriginal:entry.rarityOriginal,raritySourceUnlisted:true,rarityReferenceUnlisted:true,
            rarityReferenceDisagreement:Array.isArray(proof.otherReferences)&&proof.otherReferences.length>0,rarityEvidence:proof};
        }
        if (external && entry.rarityStatus === 'reference-conflict' && !entry.rarity && new Set(references.map(referenceValue)).size > 1) {
          return {...card,rarityOriginal:entry.rarityOriginal,raritySourceUnlisted:true,rarityReferenceConflict:true,rarityEvidence:proof};
        }
        const referenceGrade = external && entry.rarityStatus === 'reference-explicit' && proof.value === entry.rarity &&
          proof.value !== 'None' && references.every(ref=>referenceValue(ref)===entry.rarity);
        if (referenceGrade) return {...card,rarityOriginal:entry.rarityOriginal,rarityReferenceValue:entry.rarity,
          rarityReferenceDisagreement:Array.isArray(proof.otherReferences)&&proof.otherReferences.length>0,rarityEvidence:proof};
        if (state === SOURCE_UNLISTED && !publisherVerified) return card;
        if (entry.rarityStatus === 'source-unlisted' && !entry.rarity && entry.rarityOriginal === '—') {
          return {...card, raritySourceUnlisted:true, raritySourceUrl:source};
        }
        if ((!publisherVerified && entry.rarityStatus !== 'source-explicit') || typeof entry.rarity !== 'string' || !entry.rarity.trim()) return card;
        return {...card, rarity:entry.rarity, rarityOriginal:entry.rarityOriginal, raritySourceUrl:publisherVerified ? proof.url : entry.sourceUrl,
          ...(publisherVerified ? {raritySourceUnlisted:false, rarityEvidence:{...proof}} : {}),
          ...(entry.rarityDisplayLabel ? {rarityDisplayLabel:entry.rarityDisplayLabel} : {})};
      }
      if (brand === 'onepiece') {
        if (state !== 'unknown') return card;
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

  function requestMetadata(url, key, {fetchImpl, timeoutMs = 2500} = {}) {
    if (metadataRequests.has(key)) return metadataRequests.get(key);
    const request = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!request) return Promise.resolve(null);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const deadline = new Promise((resolve,reject) => {
      timer = setTimeout(() => { controller?.abort(); reject(new Error('Rarity metadata timed out')); }, Math.max(1,Math.min(2500,Number(timeoutMs) || 2500)));
    });
    const work = Promise.resolve().then(() => request(url, {
      cache:'no-cache', credentials:'omit', ...(controller ? {signal:controller.signal} : {})
    })).then(response => response.ok ? response.json() : null).then(payload => {
      if (!payload || !payload.cards || typeof payload.cards !== 'object' || Array.isArray(payload.cards)) throw Error('Invalid rarity metadata');
      return payload;
    });
    const pending = Promise.race([work,deadline]).catch(() => { metadataRequests.delete(key); return null; }).finally(() => clearTimeout(timer));
    metadataRequests.set(key,pending);
    return pending;
  }

  function ensureMetadata(brand, options = {}) {
    if (!Object.prototype.hasOwnProperty.call(metadataURLs,brand)) return Promise.resolve(null);
    return requestMetadata(metadataURLs[brand],brand,options);
  }

  function ensureSetMetadata(payload, setCode, options = {}) {
    const code=String(setCode || '').toUpperCase();
    if (!payload?.setShards || !Object.prototype.hasOwnProperty.call(payload.setShards,code)) return Promise.resolve(null);
    const url=payload.setShards[code];
    const match=typeof url==='string' && /^\/data\/collections\/sources\/pokemon-rarity-recheck\/([A-Za-z0-9_+-]+)\.json\?v=[A-Za-z0-9_-]+$/.exec(url);
    if (!match || (match[1].toUpperCase()!==code && !/^part-[0-9]{4}$/.test(match[1]))) return Promise.resolve(null);
    return requestMetadata(url,url,options).then(data=>{
      if (!data || data.bundleVersion!==1) return match[1].toUpperCase()===code ? data : null;
      const entry=Object.prototype.hasOwnProperty.call(data.sets || {},code) ? data.sets[code] : null;
      if (entry?.schemaVersion!==1 || entry.brand!=='pokemon' || entry.language!==(payload.language || 'ja') ||
          String(entry.setCode || '').toUpperCase()!==code) return null;
      // The source URL key and set header are stored once in public bundles.
      if (entry.compactIdentity===true && entry.cards && !Array.isArray(entry.cards)) {
        return {...entry,cards:Object.fromEntries(Object.entries(entry.cards).map(([sourceUrl,card])=>
          [sourceUrl,{...card,sourceUrl,setCode:entry.setCode}]))};
      }
      return entry;
    });
  }

  async function enrich(cards, {brand, setCode, fetchImpl} = {}) {
    if (Array.isArray(cards) && !cards.some(card=>['unknown',SOURCE_UNLISTED].includes(metadata(card).state))) return cards.slice();
    const payload = await ensureMetadata(brand,{fetchImpl});
    const enriched=merge(cards,payload,{brand,setCode});
    if (brand!=='pokemon' && brand!=='pokemon-en') return enriched;
    const setPayload=await ensureSetMetadata(payload,setCode,{fetchImpl});
    const primary=merge(enriched,setPayload,{brand,setCode});
    if (!primary.some(card=>['unknown',SOURCE_UNLISTED].includes(metadata(card).state))) return primary;
    const referenceURL=referenceURLs[brand];
    const index=referenceURL && await requestMetadata(referenceURL,'crossdb:'+brand,{fetchImpl});
    const reviewed=await ensureSetMetadata(index,setCode,{fetchImpl});
    return merge(primary,reviewed,{brand,setCode});
  }

  function evidenceHtml(card) {
    const proof=card?.rarityEvidence,refs=proof?.kind?.startsWith('external-') ? proof.references : card?.rarityDisclosureEvidence?.references;
    if (!Array.isArray(refs) || !refs.length) return '';
    const links=[...refs,...(proof?.otherReferences||[])].filter(ref=>/^https:\/\//.test(ref.url || '')).map(ref=>'<a href="'+esc(ref.url)+'" target="_blank" rel="noopener noreferrer">'+esc(ref.provider)+': '+esc(ref.literal)+'</a>');
    if (!links.length) return '';
    return '<p class="ci-rarity-evidence">'+(card.rarityDisclosureStatus==='verified-unprinted-rarity' ? '해당 상품의 희귀도 미표기 근거' : proof?.kind==='external-candidate' ? '외부 DB의 단일 후보 · 등급 적용 보류' : '외부 DB 분류 · 제조사 확정과 구분')+'<br>'+links.join(' · ')+
      (proof?.kind==='external-explicit' ? proof.identityMethod==='named-world-championship-deck' ? '<br>같은 연도·선수·덱에서 이름이 유일하게 일치한 참고 분류입니다. 목록의 No. 번호는 인쇄 번호로 취급하지 않습니다. 실물 판본은 별도 확인이 필요합니다.' : '<br>동일 언어·세트·카드 번호 기준의 분류입니다. 세부 인쇄 판본 확인 여부는 별도입니다.' : '')+
      (card.rarityReferenceDisagreement ? '<br>자료별 값이 달라 동일 상품 TCGplayer 분류를 참고값으로 우선 표시합니다.' : '')+'</p>';
  }

  function referenceLinksHtml(cards, selected) {
    const links=[];
    for (const card of filter(cards,selected)) {
      const refs=card.rarityEvidence?.kind?.startsWith('external-') ? card.rarityEvidence.references : card.rarityDisclosureEvidence?.references;
      for (const ref of [...(Array.isArray(refs) ? refs : []),...(card.rarityEvidence?.otherReferences||[])]) if (/^https:\/\//.test(ref.url || '')) {
        links.push('<li><a href="'+esc(ref.url)+'" target="_blank" rel="noopener noreferrer" title="'+esc(card.name)+'">'+esc(card.number || card.fullCardNumber)+' · '+esc(ref.provider)+' · '+esc(ref.literal)+'</a></li>');
      }
    }
    return links.length ? '<details class="ci-rarity-sources"><summary>카드 번호별 대조 출처</summary><ul>'+links.join('')+'</ul></details>' : '';
  }

  function page(cards, {selected = [], predicate = () => true, page = 1, pageSize = 18} = {}) {
    const filtered = filter(cards, selected).filter(predicate);
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 18;
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    const current = Math.max(1, Math.min(pages, Math.floor(Number(page)) || 1));
    return {filtered, count:filtered.length, page:current, pages, items:filtered.slice((current-1)*size, current*size)};
  }

  function controlsHtml(cards, selected, {open = false} = {}) {
    const entries = options(cards), keys = selection(cards, selected), all = !keys.length;
    if (!entries.length) return '';
    const button = (key, label, count, on) => '<button type="button" class="ci-rarity-chip" data-card-rarity="'+esc(key)+'" aria-pressed="'+String(on)+'">'+esc(label)+'<span>'+count+'</span></button>';
    return '<details class="ci-rarity-picker"'+(open ? ' open' : '')+'><summary>희귀도 필터 <span>'+(all ? '전체' : keys.length+'개 선택')+'</span></summary>'+
      '<div class="ci-rarity-menu"><div class="ci-rarity-filters" role="group" aria-label="희귀도 복수 선택">'+
      button('', '전체', cards.length, all)+entries.map(item => button(item.key, item.label, item.count, keys.includes(item.key))).join('')+
      '</div>'+(entries.some(item=>item.state===SOURCE_UNLISTED) ? '<p class="ci-rarity-note">원문 등급 미표기는 무등급 확정이 아닙니다. 공식 등급이 확인되면 반영합니다.</p>' : '')+
      (cards.some(card=>card.rarityEvidence?.kind==='external-explicit') ? '<p class="ci-rarity-note">외부 DB 분류를 포함합니다. ‘미표기 분류’는 DB의 명시값 None이며 제조사 무등급 확정과 다릅니다.</p>' : '')+
      (cards.some(card=>card.rarityReferenceDisagreement) ? '<p class="ci-rarity-note">자료에 등급 차이가 있습니다. ‘참고’ 항목은 동일 상품 TCGplayer 분류를 우선 표시하며, 다른 자료의 값도 출처 목록에 보존합니다.</p>' : '')+
      referenceLinksHtml(cards,keys)+
      '<button type="button" class="ci-rarity-done" data-card-rarity-close>선택 완료</button></div></details>';
  }

  function mount(container, {cards, selected = [], onChange} = {}) {
    if (!container) return;
    const input = Array.isArray(cards) ? cards : [];
    container.innerHTML = controlsHtml(input, selected);
    container.onclick = event => {
      const close = event.target?.closest?.('button[data-card-rarity-close]');
      if (close?.dataset && Object.prototype.hasOwnProperty.call(close.dataset,'cardRarityClose') && container.contains(close)) {
        event.preventDefault(); event.stopPropagation();
        const picker = container.querySelector?.('details'); if (picker) picker.open = false;
        picker?.querySelector('summary')?.focus({preventScroll:true}); return;
      }
      const button = event.target?.closest?.('button[data-card-rarity]');
      if (!button || !container.contains(button) || button.disabled) return;
      const key = button.dataset.cardRarity;
      if (key && !options(input).some(item => item.key === key)) return;
      event.preventDefault(); event.stopPropagation();
      const current = selection(input, selected);
      const next = !key ? [] : current.includes(key) ? current.filter(item => item !== key) : [...current, key];
      const wasOpen = container.querySelector?.('details')?.open === true;
      if (typeof onChange === 'function') onChange(next);
      // Provider redraws keep the active filter focus, without scrolling the panel.
      const live = container.id ? container.ownerDocument?.getElementById(container.id) || container : container;
      const picker = live.querySelector?.('details'); if (picker) picker.open = wasOpen;
      [...live.querySelectorAll('button[data-card-rarity]')].find(item => item.dataset.cardRarity === key)?.focus({preventScroll:true});
    };
  }

  return Object.freeze({metadata, options, selection, filter, merge, ensureMetadata, ensureSetMetadata, enrich, evidenceHtml, page, controlsHtml, mount});
});
