/* Offline Chinese catalog and language-isolation regression checks. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const chineseSource = fs.readFileSync(path.join(root, 'assets/chinese-catalog.js'), 'utf8');
const englishSource = fs.readFileSync(path.join(root, 'assets/english-catalog.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererStart = html.indexOf('function renderCardInfo()');
const rendererEnd = html.indexOf('/* ─────────── 세트 카드 그리드 모달', rendererStart);
assert(rendererStart >= 0 && rendererEnd > rendererStart, 'Locate the actual card-info renderer');
const originalRenderer = html.slice(rendererStart, rendererEnd);
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const fixture = {
  schemaVersion: 1, language: 'zh-CN', sets: [
    {code: 'CN-TEST', name: '브레이브 <박스>', originalName: '勇敢的宝可梦',
      sourceUrl: 'https://www.pokemon.cn/tcg/product/test.html', image: 'https://www.pokemon.cn/images/test.png',
      release: '2025.01.01', series: '테스트', aliases: ['brave pokemon', '전용 일러스트'],
      description: '중판 <한정 일러스트>', variants: [{name: '24팩 박스', cardsPerPack: 5, packsPerBox: 24, msrpCny: 10, msrpUnit: '팩'}]},
    {code: 'CN-SECOND', name: '두 번째 세트', originalName: '第二盒',
      sourceUrl: 'https://pokemon.cn/tcg/product/second.html', aliases: ['second set'], variants: []}
  ]
};
const cardRows = Array.from({length: 22}, (_, i) => ({
  id: 'CARD-' + String(i + 1).padStart(2, '0'), number: String(i < 2 ? 1 : i).padStart(3, '0') + '/020',
  name: i < 2 ? '皮卡丘' : '卡牌' + (i + 1), nameKo: i < 2 ? '피카츄' : '테스트 카드 ' + (i + 1),
  rarity: i === 1 ? 'SAR' : 'AR', variant: i === 1 ? '한정 일러스트' : '일반', image: 'https://cdn.pokemon-tcg.cn/cards/' + (i + 1).toString(16).padStart(8,'0') + '.png',
  sourceId: String(i + 1).padStart(8, '0') + '-1111-4111-8111-111111111111', sourceSetCode: 'testc',
  sourceUrl: 'https://www.pokemon.cn/tcg/card/test-' + (i + 1) + '.html'
}));
const cardData = {schemaVersion: 1, language: 'zh-CN', code: 'CN-TEST', cardCount: 22, expectedCardCount: 22, printedCardCount: 21, complete: true, cards: cardRows};
const cardSets = {'CN-TEST': cardData, 'CN-SECOND': {...clone(cardData), code: 'CN-SECOND'}};
fixture.sets.forEach(set => Object.assign(set, {cardCount: 22, expectedCardCount: 22, printedCardCount: 21, complete: true, kind: 'booster'}));
const enSet = {code: 'EN-TEST', name: 'English Test', displayCode: 'ENT', language: 'en', cardCount: 0};
// Synthetic Chinese auction data belongs only to the local test harness.
function marketQuote(priceMinor, listingId) {
  const sourceUrl = 'https://www.cardhobby.com.cn/market/item/' + listingId;
  return {priceMinor, date:'2026-10-09', auctionCount:2, totalAuctionCount:3, sourceUrl,
    history:[{date:'2026-10-08',priceMinor:priceMinor-100,auctionCount:1,sourceUrl},
      {date:'2026-10-09',priceMinor,auctionCount:2,sourceUrl}]};
}
function marketFixture() {
  const row = card => Object.fromEntries(['sourceId','sourceSetCode','number','name','variant'].map(key => [key,card[key]]));
  return {schemaVersion:1,language:'zh-CN',market:'CN',currency:'CNY',source:'cardhobby',
    priceKind:'auction_end_price',observedAt:'2026-10-10T00:00:00Z',coverage:{},
    cards:{[cardRows[0].sourceId]:{...row(cardRows[0]),grades:{psa10:marketQuote(98765,1001),raw:marketQuote(1234,1002)}},
      [cardRows[1].sourceId]:{...row(cardRows[1]),grades:{raw:marketQuote(2345,1003)}}},
    boxes:{'CN-TEST':[
      {...marketQuote(567890,2001),targetId:'BOX:CN-TEST:5',cardsPerPack:5,packsPerBox:24,
        configurationVerified:true,configurationSourceUrl:fixture.sets[0].sourceUrl},
      {...marketQuote(123450,2002),targetId:'BOX:CN-TEST:20',cardsPerPack:20,packsPerBox:null,
        configurationVerified:false,configurationSourceUrl:null}]}};
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {resolve = ok; reject = fail;});
  return {promise, resolve, reject};
}
function harness({data = fixture, cards = cardSets, cardGates = {}, cnGate, enGate, market = null, marketGate, marketError = false, fx = null, fxReady, english = false, actualRenderer = false, search = ''} = {}) {
  const nodes = new Map(), handlers = [], inputHandlers = [], windowHandlers = new Map(), fetched = [], opened = [], shared = [];
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      const n = {id, innerHTML: '', hidden: false, dataset: {}, attrs: {}, style: {}, scrollTop: 0,
        classList: {add(...values){values.forEach(v => classes.add(v));}, remove(...values){values.forEach(v => classes.delete(v));},
          contains: value => classes.has(value), toggle(value, force = !classes.has(value)){if(force)classes.add(value);else classes.delete(value);return force;}},
        setAttribute(k,v){this.attrs[k] = v;}, getAttribute(k){return this.attrs[k];},
        focus(){}, scrollIntoView(){}, remove(){nodes.delete(this.id);},
        before(other){nodes.set(other.id, other);}, querySelector(){return node('child-' + this.id);}, querySelectorAll(){return []}}
      nodes.set(id, n);
    }
    return nodes.get(id);
  }
  const list = node('cardInfoList'), modal = node('anyModal');
  list.parentNode = {insertBefore(child){nodes.set(child.id, child);}};
  node('ciLanguageTabs');
  modal.querySelector = selector => {
    if(selector === '.modal-box') return node('modalBox');
    return node('modalButton');
  };
  // Price-only DOM updates must leave the existing dialog, scroll and controls in place.
  const pricePattern=/<span class="cn-price" data-cn-cny="([^"]+)"(?: data-cn-price-unit="([^"]+)")? data-test-cn-price="(\d+)"><span class="cn-price-primary" data-cn-price-primary>([^<]*)<\/span><span class="cn-price-original" data-cn-price-original>([^<]*)<\/span><\/span>/g;
  modal.querySelectorAll=selector=>{
    if(selector==='[data-cn-cny]')return [...modal.innerHTML.matchAll(pricePattern)].map(match=>({
      dataset:{cnCny:match[1],cnPriceUnit:match[2]||''},
      querySelector(part){return {set textContent(value){
        const attribute=part==='[data-cn-price-primary]'?'data-cn-price-primary':'data-cn-price-original';
        modal.innerHTML=modal.innerHTML.replace(pricePattern,(whole,amount,unit,id)=>id===match[3]
          ?whole.replace(new RegExp('('+attribute+'>)[^<]*(</span>)'),(_,head,tail)=>head+String(value)+tail):whole);
      }}}}));
    if(selector==='[data-cn-fx-note]')return [...modal.innerHTML.matchAll(/<p class="cn-fx-note" data-cn-fx-note>[^<]*<\/p>/g)].map(()=>({set textContent(value){
      modal.innerHTML=modal.innerHTML.replace(/(<p class="cn-fx-note" data-cn-fx-note>)[^<]*(<\/p>)/g,(_,head,tail)=>head+String(value)+tail);
    }}));
    return [];
  };
  const ctx = {console, URL, URLSearchParams, Date, JSON, Math, Number, String, Map, Set,
    CI_TAB: 'pokemon', CI_QUERY: '', CI_ONEPIECE_CATEGORY: '', CI_LANGUAGE: 'ja', navigator: {clipboard:{async writeText(url){shared.push(url);}}},
    CARDINFO: {pokemon: [{code: 'JP-TEST', name: 'Japanese Test'}], pokemon_en: [enSet], onepiece: [{code: 'OP-TEST', name: 'One Piece Test'}]},
    escapeHtml: value => String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
    location: {search, hash: '#cardinfo', href: 'https://local.test/' + search + '#cardinfo'},
    document: {activeElement: node('opener'),
      getElementById(id){
        if(id.startsWith('cnCard') || ['cnPanelTitle','encPanelTitle','encCardTitle'].includes(id)) return modal.innerHTML.includes('id="' + id + '"') ? node(id) : null;
        return nodes.get(id) || null;
      },
      querySelector(selector){
        const title = selector.includes('#cnCardTitle') ? 'cnCardTitle' : selector.includes('#cnPanelTitle') ? 'cnPanelTitle' : null;
        if(title) return modal.classList.contains('open') && modal.innerHTML.includes('id="' + title + '"') ? node(title) : null;
        if(selector.includes('.cn-scroll'))return node('cn-scroll');
        if(selector.startsWith('#cnCard'))return this.getElementById(selector.slice(1));
        return null;
      }, querySelectorAll(selector){if(selector==='[data-cn-card]')return [...node('cnCardGrid').innerHTML.matchAll(/data-cn-card=\"([^\"]+)\"/g)].map(match=>{const button=node('card-button-'+match[1]);button.dataset.cnCard=match[1];return button;});return [];}, createElement(){return node('created-' + nodes.size);},
      addEventListener(type, handler){if(type === 'click')handlers.push(handler);if(type === 'input')inputHandlers.push(handler);}},
    async fetch(url){
      fetched.push(url);
      if(url.startsWith('/data/chinese-market.json')) {
        if(marketGate) await marketGate.promise;
        if(typeof marketError === 'function' ? marketError() : marketError) throw Error('Synthetic market request failed');
        return market === null ? {ok:false,status:404} : {ok:true,json:async()=>clone(market)};
      }
      if(url.startsWith('/data/chinese-catalog.json')) {
        if(cnGate) await cnGate.promise;
        return {ok: true, json: async () => clone(data)};
      }
      if(url.startsWith('/data/chinese-sets/')) {
        const code = decodeURIComponent(url.split('/').at(-1).split('?')[0].replace(/\.json$/, ''));
        if(cardGates[code])await cardGates[code].promise;
        if(!cards[code])return {ok:false};
        return {ok:true,json:async()=>clone(cards[code])};
      }
      if(url.startsWith('/data/chinese-search.json')) {
        return {ok:true,json:async()=>({schemaVersion:1,language:'zh-CN',cards:Object.entries(cards).flatMap(([code,set])=>set.cards.map(card=>({...card,setCode:code,kind:'card',language:'zh-CN'}))),sets:data.sets.map(set=>({...clone(set),cards:clone(cards[set.code]?.cards||[])}))})};
      }
      if(url.startsWith('/data/english-catalog.json')) {
        if(enGate) await enGate.promise;
        return {ok: true, json: async () => ({schemaVersion: 1, sets: [clone(enSet)]})};
      }
      if(url.startsWith('/data/english-card-names-ko.json'))return {ok: true, json: async () => ({schemaVersion: 1, names: {}})};
      if(url.startsWith('/data/english-sets/EN-TEST.json'))return {ok: true, json: async () => ({...clone(enSet),cards: []})};
      throw Error('Unexpected source: ' + url);
    },
    openAnyModal(markup){let priceIndex=0;modal.innerHTML=markup.replace(/<span class="cn-price"[^>]*>/g,tag=>tag.slice(0,-1)+' data-test-cn-price="'+priceIndex+++'">');modal.classList.add('open');for(const match of markup.matchAll(/id=\"([^\"]+)\"/g))node(match[1]);},
    closeAnyModal(){modal.classList.remove('open');}, showToast(){},
    renderCardInfo(){list.innerHTML = 'original-' + this.CI_TAB;},
    openSetGrid(code){opened.push(code);return code;},
    addEventListener(type,handler){if(!windowHandlers.has(type))windowHandlers.set(type,[]);windowHandlers.get(type).push(handler);},
    dispatchEvent(event){for(const handler of windowHandlers.get(event.type)||[])handler(event);return true;}}
  if(fx)ctx.TCGFX={getState:()=>fx,ready:fxReady?.promise,
    convert(amount,currency){const rate=fx.rates?.[currency];return fx.cnyReady&&typeof rate==='number'&&Number.isFinite(rate)&&rate>0?Math.floor(amount*rate):null;}};
  // The original renderer is called as a bare function by the wrapper.
  ctx.renderCardInfo = () => {list.innerHTML = 'original-' + ctx.CI_TAB;};
  ctx.window = ctx;
  vm.createContext(ctx);
  if(actualRenderer)vm.runInContext(originalRenderer, ctx, {filename: 'index-card-info-renderer.js'});
  vm.runInContext(chineseSource, ctx, {filename: 'chinese-catalog.js'});
  if(english)vm.runInContext(englishSource, ctx, {filename: 'english-catalog.js'});
  const click = async attrs => {
    const b = {disabled: false, dataset: {}, ...attrs, setAttribute(){}, hasAttribute(name){return !!attrs.attributes?.includes(name)}};
    const event = {target: {closest(selector){
      const isChinese = selector.includes('[data-cn-set]'), isEnglish = selector.includes('[data-enc-language]');
      if(isChinese && (b.dataset.cnSet || b.dataset.cnPage || b.dataset.cnCard || b.dataset.cnCardPage || attrs.attributes?.some(v=>v.startsWith('data-cn-'))))return b;
      if(isEnglish && b.dataset.encLanguage)return b;
      return null;
    }}, preventDefault(){}, stopPropagation(){}};
    for(const handler of handlers)handler(event);
    await tick();
  };
  const input = async (id,value) => {const target=node(id);target.value=value;for(const handler of inputHandlers)handler({target});await tick();};
  return {ctx, api: ctx.ChineseCatalog, list, modal, fetched, opened, shared, click, input, node};
}
function searchHarness() {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const boxes = [{id:'CN-TEST',setCode:'CN-TEST',kind:'box',language:'zh-CN',name:'测试盒',displayName:'테스트 박스',originalName:'测试盒',setName:'测试盒',thumbnailUrl:'images/pokemon-cn/CN-TEST.webp'}];
  const cards = ['CN-TEST','CN-SECOND'].map(setCode => ({id:'CARD-01',setCode,kind:'card',language:'zh-CN',name:'皮卡丘',nameKo:'피카츄 <한정>',displayName:'피카츄 <한정>',setName:setCode,number:'001/020',rarity:'SAR',variant:'masterball',variantLabel:'마스터볼 무늬',thumbnailUrl:'images/pokemon-cn/CN-TEST.webp'}));
  const japanese = {id:'JP-1',name:'Japanese Box',kind:'box',brand:'pokemon',setCode:'SV1',minPrice:100,currency:'JPY'};
  const mixed = [japanese,{...japanese,id:'CN-LABEL',language:'zh-CN'}, {...japanese,id:'3',language:'ZH-cn'},
    {...japanese,id:'4',setCode:'CN-SET'}, {...japanese,id:'CN-ID',setCode:'SV1'}, {...japanese,id:'5',language:'en'}, {...japanese,id:'6',setCode:'EN-SET'}];
  const english = [{id:'EN-SAMPLE',setCode:'EN-SAMPLE',language:'en',kind:'box',name:'English Box',displayName:'English Box',setName:'English Set'},
    {id:'EN-CARD',setCode:'EN-SAMPLE',language:'en',kind:'card',name:'English Card',displayName:'English Card',setName:'English Set',number:'001/001'}];
  let jaLoads = 0, enLoads = 0;
  const ctx = {window:{addEventListener(){}},document:{getElementById(){return null}},_ALL_CARDS_INDEX:mixed,CARDINFO:{pokemon:[],onepiece:[]},
    loadCardSearchData:async()=>{jaLoads++;},fetch:async()=>({ok:true,json:async()=>[]}),enrichPriceProductMetadata:async()=>{},
    isPriceBoxProduct:()=>true,getBoxKoreanName:row=>row.name,searchCards:()=>mixed,escapeHtml,fmtKrw:value=>'KRW '+value,fmtOrig:value=>'JPY '+value,
    ChineseCatalog:{async search(query,kind){return [...boxes,...cards].filter(row=>kind==='all'||kind===row.kind);},
      href(row){return '/?'+new URLSearchParams({set:row.setCode,...(row.kind==='card'?{card:row.id}:{})})+'#cardinfo';},isImage:url=>url==='images/pokemon-cn/CN-TEST.webp'},
    EnglishSearch:{async ensureData(){enLoads++;return english;},search:(rows,query,kind)=>rows.filter(row=>kind==='all'||kind===row.kind),href:row=>'/?set='+row.setCode+'#cardinfo'},
    EnglishCatalog:{art:()=>'<span>English card art</span>'}};
  const source = fs.readFileSync(path.join(root,'assets/search-modal.js'),'utf8');
  const marker = '  window.openGlobalSearch=open;';assert(source.includes(marker));
  const instrumented = source.replace(marker, `  window.__test={render,normalized,placeholder,
    setup(lang,kind,query){language=lang;category=kind;input={value:query};list={innerHTML:'',replaceChildren(){this.innerHTML='';},scrollTop:0};count={textContent:''};modal={hidden:false};},
    html:()=>list.innerHTML,count:()=>count.textContent};\n` + marker);
  vm.createContext(ctx);vm.runInContext(instrumented,ctx,{filename:'search-modal.js'});
  return {ctx,api:ctx.window.__test,jaLoads:()=>jaLoads,enLoads:()=>enLoads};
}
let failures = 0;
async function test(name, run) {
  try {await run(); console.log('PASS: ' + name);}
  catch(error){failures++;console.error('FAIL: ' + name + '\n' + error.stack);}
}
(async () => {
  await test('catalog schema, duplicate codes, language and official-source validation', () => {
    const api = harness().api;
    assert.equal(api.prepare(clone(fixture)).sets.length, 2);
    for(const change of [
      d => d.schemaVersion = 2,
      d => d.language = 'en',
      d => d.sets.push(clone(d.sets[0])),
      d => d.sets[0].code = 'EN-TEST',
      d => d.sets[0].sourceUrl = 'https://pokemon.cn.evil.test/product',
      d => d.sets[0].sourceUrl = 'https://evil.test/pokemon.cn/product',
      d => d.sets[0].sourceUrl = 'http://pokemon.cn/product',
      d => d.sets[0].originalName = '',
      d => d.sets[0].variants = {}
    ]) {const d = clone(fixture);change(d);assert.throws(() => api.prepare(d));}
    assert.equal(api.isImage('https://www.pokemon.cn/images/box.png'), true);
    for(const url of ['javascript:alert(1)','https://pokemon.cn.evil.test/image.png','https://evil.test/image.png']) assert.equal(api.isImage(url), false);
  });
  await test('local Chinese product images are allowed while unsafe paths and URLs are rejected', () => {
    const api = harness().api;
    for(const image of ['/images/pokemon-cn/CN-TEST.webp', 'images/pokemon-cn/CN-TEST.png', '/images/pokemon-cn/CN-TEST.jpg', 'images/pokemon-cn/CN-TEST.jpeg']) {
      assert.equal(api.isImage(image), true, image);
    }
    for(const image of ['', '/images/pokemon-cn/../private.webp', '/images/pokemon-cn/CN-TEST/../../private.webp',
      '/images/pokemon-cn/%2e%2e/private.webp', '/images/pokemon-cn/CN-TEST.svg', '/images/pokemon-cn/CN-TEST.html',
      '/images/pokemon-cn/CN-TEST.webp" onerror="alert(1)', '//evil.test/images/pokemon-cn/CN-TEST.webp',
      'data:image/svg+xml,<svg onload=alert(1)>', 'javascript:alert(1)', 'https://pokemon.cn.evil.test/image.png',
      'https://evil.test/image.png', 'C:/images/pokemon-cn/CN-TEST.webp']) {
      assert.equal(api.isImage(image), false, image);
    }
  });
  await test('local product images render from the root in both product lists and details', async () => {
    const data = clone(fixture);data.sets[0].image = 'images/pokemon-cn/CN-TEST.webp';
    const h = harness({data});h.list.dataset.catalogLanguage = 'zh-CN';await h.api.render();
    assert.match(h.list.innerHTML, /src="\/images\/pokemon-cn\/CN-TEST\.webp"/);
    await h.api.open('CN-TEST');
    assert.match(h.modal.innerHTML, /src="\/images\/pokemon-cn\/CN-TEST\.webp"/);
  });
  await test('Korean, Chinese and alias box searches and detail routes', async () => {
    const h = harness();
    for(const query of ['브레이브', '勇敢的宝可梦', 'brave pokemon', '전용 일러스트', 'CN-TEST']) {
      const rows = await h.api.search(query, 'box');assert.equal(rows.length, 1, query);
      assert.equal(rows[0].language, 'zh-CN');assert.equal(rows[0].kind, 'box');
      assert.equal(h.api.href(rows[0]), '/?set=CN-TEST#cardinfo');
    }
    assert.equal(h.api.href('CN-TEST'), '/?set=CN-TEST#cardinfo');
    assert.equal((await h.api.search('', 'all')).length, 0);
    assert.equal((await h.api.search('존재하지않는상품', 'box')).length, 0);
    assert.equal(h.fetched.filter(url => url.startsWith('/data/chinese-catalog.json')).length, 1);
  });
  await test('Chinese search uses exact grade and box price availability and separates lookup failure', async () => {
    const h=harness({market:marketFixture()});
    const rows=await h.api.search('피카츄','card');
    assert.equal(rows.find(row=>row.id==='CARD-01').priceLabel,'PSA 10 가격 기록');
    assert.equal(rows.find(row=>row.id==='CARD-02').priceLabel,'A급 가격 기록');
    assert.equal((await h.api.search('브레이브','box'))[0].priceLabel,'박스 가격 기록');
    assert.equal((await h.api.search('두 번째','box'))[0].priceLabel,'가격 미확보');
    const changed=marketFixture();changed.cards[cardRows[0].sourceId].number='999';
    const mismatched=await harness({market:changed}).api.search('피카츄','card');
    assert.equal(mismatched.find(row=>row.id==='CARD-01').priceLabel,'가격 미확보');
    let fail=true;const failed=harness({market:marketFixture(),marketError:()=>fail});
    assert.equal((await failed.api.search('브레이브','box'))[0].priceLabel,'가격 조회 실패');
    fail=false;assert.equal((await failed.api.search('브레이브','box'))[0].priceLabel,'박스 가격 기록');
  });
  await test('product details preserve CNY MSRP and never fabricate Japanese prices or sales', async () => {
    const h = harness();await h.api.open('CN-TEST');
    assert.match(h.modal.innerHTML, /포켓몬 · 중판/);
    assert.match(h.modal.innerHTML, /브레이브 &lt;박스&gt;/);
    assert.match(h.modal.innerHTML, /공식 권장가/);
    assert.match(h.modal.innerHTML, /¥10 CNY \/ 팩/);
    assert.match(h.modal.innerHTML, /가격 미확보/);
    assert(!h.modal.innerHTML.includes('수록 카드 목록은 준비 중'));
    assert.match(h.node('cnCardCount').innerHTML,/22/);
    assert(!/JPY|PSA|SNKRDUNK|PriceCharting|eBay|판매 기록|₩0|\$0/.test(h.modal.innerHTML));
    assert.equal(h.node('modalBox').attrs['aria-labelledby'], 'cnPanelTitle');
    assert.equal(h.fetched.some(url => /price|contained|english/.test(url)), false);
  });
  await test('complete card-set validation protects identity, counts, language and images', () => {
    const api=harness().api, prepared=api.prepareCards(clone(cardData),'CN-TEST');
    assert.equal(prepared.cards.length,22);assert.equal(prepared.cards[0].number,prepared.cards[1].number);
    assert.notEqual(prepared.cards[0].id,prepared.cards[1].id);assert.notEqual(prepared.cards[0].image,prepared.cards[1].image);
    for(const change of [data=>data.complete=false,data=>data.language='ja',data=>data.code='CN-OTHER',
      data=>data.cardCount=21,data=>data.expectedCardCount=20,data=>data.cards[1].id=data.cards[0].id,
      data=>data.cards[0].language='en',data=>data.cards[0].setCode='CN-OTHER',data=>data.cards[0].number='',
      data=>data.cards[0].image='javascript:alert(1)']) {
      const data=clone(cardData);change(data);assert.throws(()=>api.prepareCards(data,'CN-TEST'));
    }
    const oldId=clone(cardData);oldId.cards[0].sourceId='LEGACY-CARD';delete oldId.cards[0].id;
    assert.equal(api.prepareCards(oldId,'CN-TEST').cards[0].id,'LEGACY-CARD');
    assert.equal(api.isImage('/images/pokemon-cn-cards/CN-TEST/CARD-01.png'),true);
    assert.equal(api.isImage('https://cdn.pokemon-tcg.cn/cards/abcdef123456.png'),true);
    assert.equal(api.isImage('https://images.pikaqian.com/originals/TEST/abc-123.png'),true);
    for(const url of ['/images/pokemon-cn-cards/../../private.png','https://cdn.pokemon-tcg.cn.evil.test/cards/abcdef.png',
      'https://images.pikaqian.com.evil.test/originals/TEST/abc-123.png','https://images.pikaqian.com/originals/TEST/abc-123.svg'])assert.equal(api.isImage(url),false,url);
  });
  await test('all cards remain reachable across pages, searchable and distinct across illustration variants', async () => {
    const h=harness();await h.api.open('CN-TEST');
    const ids=()=>[...h.node('cnCardGrid').innerHTML.matchAll(/data-cn-card="([^"]+)"/g)].map(match=>match[1]);
    const first=ids();assert.equal(first.length,18);assert.match(h.node('cnCardCount').innerHTML,/21개 번호 · 버전 22종/);assert.match(h.node('cnCardCount').innerHTML,/1 \/ 2/);
    await h.click({dataset:{cnCardPage:'2'}});const last=ids();assert.equal(last.length,4);
    assert.equal(new Set([...first,...last]).size,22);assert.match(h.node('cnCardCount').innerHTML,/2 \/ 2/);
    h.node('cn-scroll').scrollTop=240;await h.click({attributes:['data-cn-expand']});
    await h.click({dataset:{cnCard:'CARD-22'}});assert.match(h.modal.innerHTML,/테스트 카드 22/);
    assert.match(h.modal.innerHTML,/cnCardTitle/);assert.equal(h.modal.classList.contains('ci-expanded'),true);
    await h.click({attributes:['data-cn-back']});assert.deepEqual(ids(),last);assert.equal(h.node('cn-scroll').scrollTop,240);
    assert.equal(h.modal.classList.contains('ci-expanded'),true);
    for(const query of ['피카츄','皮卡丘','００１/０２０']) {
      await h.input('cnCardSearch',query);assert.equal(ids().length,2,query);assert.match(h.node('cnCardCount').innerHTML,/검색 2장/);
      assert.match(h.node('cnCardCount').innerHTML,/1 \/ 1/);
    }
    await h.click({dataset:{cnCard:'CARD-01'}});assert.match(h.modal.innerHTML,/일반/);
    await h.click({attributes:['data-cn-back']});assert.equal(ids().length,2);
    await h.click({dataset:{cnCard:'CARD-02'}});assert.match(h.modal.innerHTML,/한정 일러스트/);
    await h.click({attributes:['data-cn-back']});await h.input('cnCardSearch','존재하지않는카드');assert.match(h.node('cnCardGrid').innerHTML,/검색 결과가 없습니다/);
  });
  await test('booster list first and last arrows jump across pages and disable at the boundary', async () => {
    const data=clone(fixture);data.sets=Array.from({length:140},(_,i)=>({...clone(fixture.sets[0]),code:'CN-BOX-'+(i+1),name:'박스 '+(i+1)}));
    const h=harness({data});h.list.dataset.catalogLanguage='zh-CN';await h.api.render();
    const button=label=>h.list.innerHTML.match(new RegExp('<button[^>]+aria-label="'+label+'"[^>]*>'))?.[0];
    assert.match(button('처음 페이지'),/data-cn-page="1"[^>]*disabled/);
    assert.match(button('마지막 페이지'),/data-cn-page="6"/);assert(!button('마지막 페이지').includes('disabled'));
    await h.click({dataset:{cnPage:'6'}});assert.match(h.list.innerHTML,/data-cn-set="CN-BOX-140"/);
    assert.match(button('마지막 페이지'),/disabled/);assert.match(button('다음 페이지'),/disabled/);
    await h.click({dataset:{cnPage:'5'}});assert.match(h.list.innerHTML,/aria-label="5페이지" aria-current="page"/);
    await h.click({dataset:{cnPage:'6'}});assert.match(h.list.innerHTML,/aria-label="6페이지" aria-current="page"/);
    await h.click({dataset:{cnPage:'1'}});assert.match(h.list.innerHTML,/data-cn-set="CN-BOX-1"/);
    assert(!h.list.innerHTML.includes('data-cn-set="CN-BOX-140"'));
    assert.match(button('처음 페이지'),/disabled/);assert.match(button('이전 페이지'),/disabled/);
    h.ctx.CI_QUERY='박스 140';await h.api.render();assert(!h.list.innerHTML.includes('aria-label="마지막 페이지"'));
    assert.match(h.list.innerHTML,/data-cn-set="CN-BOX-140"/);
  });
  await test('card list first and last arrows jump over twenty pages and reset after search', async () => {
    const data=clone(cardData);data.cards=Array.from({length:500},(_,i)=>i<cardRows.length?clone(cardRows[i]):{
      ...clone(cardRows[2]),id:'CARD-'+(i+1),sourceId:'SOURCE-'+(i+1),number:String(i+1),name:'卡牌'+(i+1),nameKo:'테스트 카드 '+(i+1)});
    data.cardCount=data.expectedCardCount=500;data.printedCardCount=499;
    const h=harness({cards:{...cardSets,'CN-TEST':data}});await h.api.open('CN-TEST');
    const button=label=>h.node('cnCardPages').innerHTML.match(new RegExp('<button[^>]+aria-label="'+label+'"[^>]*>'))?.[0];
    assert.match(button('처음 페이지'),/data-cn-card-page="1"[^>]*disabled/);
    assert.match(button('마지막 페이지'),/data-cn-card-page="28"/);
    await h.click({dataset:{cnCardPage:'28'}});assert.match(h.node('cnCardCount').innerHTML,/28 \/ 28/);
    assert.match(h.node('cnCardGrid').innerHTML,/data-cn-card="CARD-500"/);
    assert.match(button('마지막 페이지'),/disabled/);assert.match(button('다음 페이지'),/disabled/);
    await h.click({dataset:{cnCardPage:'27'}});assert.match(h.node('cnCardCount').innerHTML,/27 \/ 28/);
    await h.click({dataset:{cnCardPage:'28'}});assert.match(h.node('cnCardCount').innerHTML,/28 \/ 28/);
    await h.click({dataset:{cnCardPage:'1'}});assert.match(h.node('cnCardCount').innerHTML,/1 \/ 28/);
    assert.match(h.node('cnCardGrid').innerHTML,/data-cn-card="CARD-01"/);
    assert.match(button('처음 페이지'),/disabled/);assert.match(button('이전 페이지'),/disabled/);
    await h.click({dataset:{cnCardPage:'28'}});await h.input('cnCardSearch','피카츄');
    assert.match(h.node('cnCardCount').innerHTML,/1 \/ 1/);assert.match(button('처음 페이지'),/disabled/);
    assert.match(button('마지막 페이지'),/data-cn-card-page="1"[^>]*disabled/);
    const before=h.node('cnCardGrid').innerHTML;
    await h.click({dataset:{cnCardPage:'1'},disabled:true});assert.equal(h.node('cnCardGrid').innerHTML,before);
  });
  await test('card details show identities and blank prices without borrowing another language market', async () => {
    const data=clone(cardData);data.cards[0].psa10={language:'ja',currency:'JPY',grade:'PSA 10',sourcePriceCents:199900};
    const h=harness({cards:{...cardSets,'CN-TEST':data}});await h.api.open('CN-TEST','CARD-01');
    assert.match(h.modal.innerHTML,/피카츄/);assert.match(h.modal.innerHTML,/皮卡丘/);assert.match(h.modal.innerHTML,/001\/020/);
    assert.match(h.modal.innerHTML,/중국 본토 간체판/);assert.match(h.modal.innerHTML,/가격 미확보/);assert.match(h.modal.innerHTML,/class="px-current">—/);
    assert.equal((h.modal.innerHTML.match(/class="px-grade-price">—/g)||[]).length,2);
    assert.match(h.modal.innerHTML,/PSA 10/);assert.match(h.modal.innerHTML,/A급\(미감정\)/);
    assert(!/PSA 9|BGS/.test(h.modal.innerHTML));
    assert(!/1999|JPY|SNKRDUNK|PriceCharting|eBay|판매 기록|₩0|\$0/.test(h.modal.innerHTML));
    assert.equal(h.node('modalBox').attrs['aria-labelledby'],'cnCardTitle');
    assert.equal(h.fetched.some(url=>/price|contained|english/.test(url)),false);
  });
  await test('Chinese auction schema rejects foreign markets, unsafe links, missing amounts and unsupported grades', () => {
    const api=harness().api, id=cardRows[0].sourceId;
    assert.equal(api.prepareMarket(marketFixture()).cards[id].grades.raw.priceMinor,1234);
    for(const change of [d=>d.language='en',d=>d.market='US',d=>d.currency='USD',
      d=>d.source='jihuanshe',d=>d.priceKind='asking_price',d=>d.schemaVersion=2,
      d=>d.cards=[],d=>d.boxes=[],d=>d.cards[id].sourceId='other-card',
      d=>d.cards[id].grades.psa9=marketQuote(1234,10),d=>d.cards[id].grades.raw.priceMinor=0,
      d=>d.cards[id].grades.raw.priceMinor=12.34,d=>d.cards[id].grades.raw.priceMinor=Number.MAX_SAFE_INTEGER+1,
      d=>d.cards[id].grades.raw.auctionCount=0,d=>d.cards[id].grades.raw.totalAuctionCount=1,
      d=>d.cards[id].grades.raw.sourceUrl='https://www.cardhobby.com.cn.evil.test/market/item/1',
      d=>d.cards[id].grades.raw.history[0].sourceUrl='javascript:alert(1)',
      d=>d.cards[id].grades.raw.history=[],d=>d.boxes['CN-TEST'][0].packsPerBox=null,
      d=>d.boxes['CN-TEST'][0].targetId='BOX:CN-SECOND:5']) {
      const data=marketFixture();change(data);assert.throws(()=>api.prepareMarket(data));
    }
  });
  await test('actual auction amounts, CNY dates, grade columns and daily median history appear together', async () => {
    const h=harness({market:marketFixture()});await h.api.open('CN-TEST','CARD-01');
    const body=h.modal.innerHTML;
    assert.match(body,/최근 경매 종료가 · PSA 10/);assert.match(body,/¥987\.65 CNY/);assert.match(body,/¥12\.34 CNY/);
    assert.match(body,/2026\.10\.09/);assert.match(body,/배송비 제외/);assert.match(body,/판매자 표기 기준/);
    assert.match(body,/같은 날 경매 종료가격의 중간값/);assert.match(body,/같은 날짜의 경매 종료가격 중간값/);
    assert.equal((body.match(/<details class="cn-auction-history">/g)||[]).length,2);
    assert.match(body,/PSA 10 가격 기록 · 3건/);assert.match(body,/A급\(미감정\) 가격 기록 · 3건/);
    assert.match(body,/2026\.10\.08/);assert.match(body,/¥986\.65 CNY/);assert.match(body,/¥11\.34 CNY/);
    assert.match(body,/2건/);assert.match(body,/https:\/\/www\.cardhobby\.com\.cn\/market\/item\/1002" target="_blank" rel="noopener noreferrer"/);
    assert.equal((body.match(/class="px-grade-price">/g)||[]).length,2);
    assert(!/PSA 9|BGS|USD|JPY|SNKRDUNK|PriceCharting|eBay|₩0|\$0/.test(body));
    await h.api.ensureMarket();await h.api.open('CN-SECOND','CARD-01');
    assert.match(h.modal.innerHTML,/¥12\.34 CNY/);
    assert.equal(h.fetched.filter(url=>url.startsWith('/data/chinese-market.json')).length,1,'Successful market data is cached');
  });
  await test('shared CNY daily FX converts all grades, box formats, MSRP and history without changing source prices', async () => {
    const source=marketFixture(),before=JSON.stringify(source),fx={rates:{JPY:9.5,USD:1370,CNY:203.6789},date:'2026-10-11',cnyReady:true};
    const h=harness({market:source,fx});await h.api.open('CN-TEST','CARD-01');
    const converted=n=>'₩'+Math.floor(n/100*fx.rates.CNY).toLocaleString('ko-KR');
    for(const n of [98765,1234,98665,1134])assert(h.modal.innerHTML.includes(converted(n)),n);
    for(const n of ['¥987.65 CNY','¥12.34 CNY','¥986.65 CNY','¥11.34 CNY'])assert(h.modal.innerHTML.includes(n),n);
    assert.match(h.modal.innerHTML,/2026\.10\.11 환율/);assert.match(h.modal.innerHTML,/1 CNY = ₩203\.6789/);
    assert.match(h.modal.innerHTML,/원화는 현재 적용 환율로 환산합니다/);
    assert.equal((h.modal.innerHTML.match(/class="px-grade-price">/g)||[]).length,2);
    await h.click({attributes:['data-cn-back']});
    for(const n of [567890,567790,123450,123350])assert(h.modal.innerHTML.includes(converted(n)),n);
    assert.match(h.modal.innerHTML,/₩2,036 \/ 팩/);assert.match(h.modal.innerHTML,/¥10 CNY \/ 팩/);
    assert(!h.modal.innerHTML.includes('₩48,864'),'Per-pack MSRP is not fabricated as a box quote');
    assert.equal(JSON.stringify(source),before,'Raw CNY minor amounts, history and market fixture remain unchanged');
    assert.equal(h.fetched.filter(url=>url.startsWith('/data/chinese-market.json')).length,1);
  });
  await test('late initial FX and later daily FX update only visible Chinese monetary fields', async () => {
    const gate=deferred(),fx={rates:{JPY:9.5,USD:1370,CNY:null},date:null,cnyReady:false};
    const h=harness({market:marketFixture(),fx,fxReady:gate});await h.api.open('CN-TEST','CARD-01');
    assert.match(h.modal.innerHTML,/data-cn-price-primary>¥987\.65 CNY/);assert.match(h.modal.innerHTML,/원화 환산 불가/);
    h.modal.scrollTop=177;h.node('modalBox').focusSentinel='same-focused-control';h.modal.classList.add('ci-expanded');
    const originalDialog=h.modal;
    Object.assign(fx,{rates:{JPY:9.5,USD:1370,CNY:200.1234},date:'2026-10-11',cnyReady:true});gate.resolve();await tick();
    assert(h.modal.innerHTML.includes('₩'+Math.floor(987.65*200.1234).toLocaleString('ko-KR')));
    assert.match(h.modal.innerHTML,/2026\.10\.11 환율/);assert(!h.modal.innerHTML.includes('원화 환산 불가'));
    Object.assign(fx,{rates:{JPY:9.5,USD:1370,CNY:201.6789},date:'2026-10-12'});h.ctx.dispatchEvent({type:'tcg:fx-updated'});
    for(const amount of [987.65,12.34,986.65,11.34])assert(h.modal.innerHTML.includes('₩'+Math.floor(amount*201.6789).toLocaleString('ko-KR')));
    assert.match(h.modal.innerHTML,/2026\.10\.12 환율/);assert.match(h.modal.innerHTML,/¥987\.65 CNY/);
    assert.equal(h.modal,originalDialog);assert.equal(h.modal.scrollTop,177);
    assert.equal(h.node('modalBox').focusSentinel,'same-focused-control');assert(h.modal.classList.contains('ci-expanded'));
    await h.click({attributes:['data-cn-back']});await h.input('cnCardSearch','피카츄');
    const grid=h.node('cnCardGrid').innerHTML,pages=h.node('cnCardPages').innerHTML;h.node('cn-scroll').scrollTop=91;
    fx.rates.CNY=205;fx.date='2026-10-13';h.ctx.dispatchEvent({type:'tcg:fx-updated'});
    assert.match(h.modal.innerHTML,/₩1,164,174/);assert.match(h.modal.innerHTML,/₩2,050 \/ 팩/);
    assert.equal(h.node('cnCardGrid').innerHTML,grid);assert.equal(h.node('cnCardPages').innerHTML,pages);
    assert.equal(h.node('cn-scroll').scrollTop,91);assert.match(h.modal.innerHTML,/2026\.10\.13 환율/);
    assert.equal(h.fetched.filter(url=>url.startsWith('/data/chinese-market.json')).length,1,'FX update does not reload auction data');
  });
  await test('missing or failed CNY FX never falls back to JPY or USD and preserves original prices', async () => {
    for(const rate of [null,undefined,0,-1,NaN,Infinity]){
      const fx={rates:{JPY:9.5,USD:1370,CNY:rate},date:'2026-10-11',cnyReady:false},h=harness({market:marketFixture(),fx});
      await h.api.open('CN-TEST','CARD-01');
      assert.match(h.modal.innerHTML,/data-cn-price-primary>¥987\.65 CNY/);assert.match(h.modal.innerHTML,/data-cn-price-original>원화 환산 불가/);
      assert.match(h.modal.innerHTML,/환율을 불러오지 못해 원화로 환산할 수 없어요/);assert(!h.modal.innerHTML.includes('₩'));
      fx.rates.CNY=202;fx.cnyReady=true;h.ctx.dispatchEvent({type:'tcg:fx-updated'});assert.match(h.modal.innerHTML,/₩199,505/);
      fx.rates.CNY=null;fx.cnyReady=false;h.ctx.dispatchEvent({type:'tcg:fx-updated'});
      assert.match(h.modal.innerHTML,/data-cn-price-primary>¥987\.65 CNY/);assert(!h.modal.innerHTML.includes('₩'));
    }
  });
  await test('FX notifications do not modify closed or foreign-language dialogs', async () => {
    const fx={rates:{JPY:9.5,USD:1370,CNY:200},date:'2026-10-11',cnyReady:true},h=harness({market:marketFixture(),fx,english:true});
    await h.api.open('CN-TEST','CARD-01');await h.click({attributes:['data-cn-close']});const closed=h.modal.innerHTML;
    fx.rates.CNY=201;h.ctx.dispatchEvent({type:'tcg:fx-updated'});assert.equal(h.modal.innerHTML,closed);assert(!h.modal.classList.contains('open'));
    await h.api.open('CN-TEST','CARD-01');await h.ctx.openSetGrid('EN-TEST');const english=h.modal.innerHTML;
    fx.rates.CNY=202;h.ctx.dispatchEvent({type:'tcg:fx-updated'});assert.equal(h.modal.innerHTML,english);assert.match(english,/포켓몬 · 영판/);
  });
  await test('raw-only and missing variants keep only their exact grade quotes and blank cells', async () => {
    const h=harness({market:marketFixture()});await h.api.open('CN-TEST','CARD-02');
    assert.match(h.modal.innerHTML,/최근 경매 종료가 · A급\(미감정\)/);assert.match(h.modal.innerHTML,/¥23\.45 CNY/);
    assert.equal((h.modal.innerHTML.match(/class="px-grade-price">—/g)||[]).length,1);
    assert(!/987\.65|12\.34/.test(h.modal.innerHTML),'Same printed number does not borrow another variant or grade');
    await h.click({attributes:['data-cn-back']});await h.click({dataset:{cnCard:'CARD-03'}});
    assert.equal((h.modal.innerHTML.match(/class="px-grade-price">—/g)||[]).length,2);
    assert.match(h.modal.innerHTML,/가격 미확보/);assert.match(h.modal.innerHTML,/이번 수집에서 일치하는 가격 기록을 찾지 못했어요/);
    assert(!h.modal.innerHTML.includes('cn-auction-history'));assert(!/¥0(?:[. ]| CNY)/.test(h.modal.innerHTML));
  });
  await test('card prices require the source UUID plus all five exact catalog identity fields', async () => {
    const id=cardRows[0].sourceId;
    for(const field of ['sourceId','sourceSetCode','number','name','variant']) {
      const market=marketFixture();market.cards[id][field]+='-mismatch';
      const h=harness({market});await h.api.open('CN-TEST','CARD-01');
      assert.equal((h.modal.innerHTML.match(/class="px-grade-price">—/g)||[]).length,2,field);
      assert(!/987\.65|12\.34/.test(h.modal.innerHTML),field);
      assert.match(h.modal.innerHTML,/피카츄/,'Price rejection preserves card access');
    }
    const market=marketFixture(), other='99999999-1111-4111-8111-111111111111';
    market.cards[other]={...market.cards[id],sourceId:other};delete market.cards[id];
    const h=harness({market});await h.api.open('CN-TEST','CARD-01');
    assert.equal((h.modal.innerHTML.match(/class="px-grade-price">—/g)||[]).length,2);
  });
  await test('sealed box prices distinguish pack formats and unknown quantities while preserving per-pack MSRP', async () => {
    const h=harness({market:marketFixture()});h.list.dataset.catalogLanguage='zh-CN';await h.api.render();
    assert.match(h.list.innerHTML,/박스 경매 가격 기록 있음/);assert.match(h.list.innerHTML,/박스 가격 미확보/);
    await h.api.open('CN-TEST');const body=h.modal.innerHTML;
    assert.match(body,/5장 팩 형식 · 24팩 \/ 박스/);assert.match(body,/¥5,678\.9 CNY/);
    assert.match(body,/20장 팩 형식/);assert.match(body,/¥1,234\.5 CNY/);
    assert.match(body,/구성 확인 필요 · 박스당 팩 수 미확인/);assert.match(body,/경매 참고 기록입니다/);
    assert.match(body,/박스 구성 확인됨/);assert.match(body,/공식 구성 ↗/);
    assert.match(body,/¥10 CNY \/ 팩/);assert(!body.includes('¥240 CNY'),'Pack MSRP is never converted into an auction quote');
    assert.equal((body.match(/<details class="cn-auction-history">/g)||[]).length,2);
    await h.api.open('CN-SECOND');assert.match(h.modal.innerHTML,/가격 미확보/);
    assert(!/5,678|1,234/.test(h.modal.innerHTML));
  });
  await test('missing, failed and foreign price responses preserve complete card access without fake prices', async () => {
    const foreign=marketFixture();foreign.currency='JPY';
    for(const options of [{market:null},{market:marketFixture(),marketError:true},{market:foreign}]) {
      const h=harness(options);await h.api.open('CN-TEST');
      assert.match(h.node('cnCardGrid').innerHTML,/CARD-01/);assert.match(h.modal.innerHTML,/가격 자료를 불러오지 못했어요/);
      await h.click({dataset:{cnCard:'CARD-01'}});
      assert.equal((h.modal.innerHTML.match(/class="px-grade-price">—/g)||[]).length,2);
      assert.match(h.modal.innerHTML,/data-cn-price-retry/);assert(!/987\.65|12\.34|JPY/.test(h.modal.innerHTML));
    }
    let failures=1;const h=harness({market:marketFixture(),marketError:()=>failures-->0});
    await h.api.open('CN-TEST','CARD-01');assert.match(h.modal.innerHTML,/data-cn-price-retry/);
    await h.click({attributes:['data-cn-price-retry']});await tick();
    assert.match(h.modal.innerHTML,/¥987\.65 CNY/);assert(!h.modal.innerHTML.includes('data-cn-price-retry'));
  });
  await test('delayed price responses cannot replace a closed dialog, newer product or foreign-language dialog', async () => {
    for(const action of ['close','newer','english']) {
      const gate=deferred(),h=harness({market:marketFixture(),marketGate:gate,english:true});await tick();
      const pending=h.api.open('CN-TEST','CARD-01');await tick();let newer;
      if(action==='close')await h.click({attributes:['data-cn-close']});
      else if(action==='newer')newer=h.api.open('CN-SECOND');
      else await h.ctx.openSetGrid('EN-TEST');
      gate.resolve();await pending;if(newer)await newer;await tick();
      if(action==='close')assert.equal(h.modal.classList.contains('open'),false);
      else if(action==='newer'){assert.match(h.modal.innerHTML,/두 번째 세트/);assert(!h.modal.innerHTML.includes('브레이브'));}
      else {assert.match(h.modal.innerHTML,/포켓몬 · 영판/);assert(!/987\.65|12\.34/.test(h.modal.innerHTML));}
    }
    const gate=deferred(),h=harness({market:marketFixture(),marketGate:gate});
    h.list.dataset.catalogLanguage='zh-CN';const pending=h.api.render();
    h.list.dataset.catalogLanguage='ja';h.list.innerHTML='Japanese content';gate.resolve();await pending;
    assert.equal(h.list.innerHTML,'Japanese content');
  });
  await test('Chinese price requests stay isolated from Japanese, English and One Piece browsing', async () => {
    const h=harness({market:marketFixture(),english:true,actualRenderer:true});await tick();
    assert.equal(h.fetched.filter(url=>url.startsWith('/data/chinese-market.json')).length,0);
    await h.click({dataset:{encLanguage:'en'}});await h.ctx.openSetGrid('EN-TEST');
    await h.click({dataset:{encLanguage:'ja'}});h.ctx.openSetGrid('JP-TEST');
    h.ctx.CI_TAB='onepiece';h.ctx.renderCardInfo();
    assert.equal(h.fetched.filter(url=>url.startsWith('/data/chinese-market.json')).length,0);
    h.ctx.CI_TAB='pokemon';await h.click({dataset:{encLanguage:'zh-CN'}});
    assert.equal(h.fetched.filter(url=>url.startsWith('/data/chinese-market.json')).length,1);
  });
  await test('card searches and shared links preserve set-scoped variant IDs and direct detail entry', async () => {
    const h=harness();
    for(const query of ['피카츄','皮卡丘','001/020']) {
      const rows=await h.api.search(query,'card');assert.equal(rows.length,4,query);
      assert.equal(new Set(rows.map(row=>row.setCode+':'+row.id)).size,4);
      assert(rows.every(row=>row.kind==='card'&&row.language==='zh-CN'));
      assert.equal(h.api.href(rows[0]),'/?set=CN-TEST&card=CARD-01#cardinfo');
    }
    await h.api.open('CN-TEST','CARD-02');assert.match(h.modal.innerHTML,/한정 일러스트/);
    await h.click({attributes:['data-cn-share']});assert.equal(h.shared.at(-1),'https://local.test/?set=CN-TEST&card=CARD-02#cardinfo');
    const shared=harness({english:true,search:'?set=CN-TEST&card=CARD-02'});await tick();
    assert.match(shared.modal.innerHTML,/cnCardTitle/);assert.match(shared.modal.innerHTML,/한정 일러스트/);
    await shared.api.open('CN-TEST','NOT-IN-THIS-SET');assert.match(shared.modal.innerHTML,/공유된 카드를 찾지 못했습니다/);
    assert.match(shared.node('cnCardGrid').innerHTML,/data-cn-card="CARD-01"/);
  });
  await test('late card-set responses cannot replace a newer set, language or a closed dialog', async () => {
    const gate=deferred(),h=harness({cardGates:{'CN-TEST':gate}}),old=h.api.open('CN-TEST');await tick();
    await h.api.open('CN-SECOND');assert.match(h.modal.innerHTML,/두 번째 세트/);gate.resolve();await old;
    assert.match(h.modal.innerHTML,/두 번째 세트/);assert(!h.modal.innerHTML.includes('브레이브'));
    for(const action of ['close','english']) {
      const slow=deferred(),other=harness({english:true,cardGates:{'CN-TEST':slow}});await tick();
      const pending=other.api.open('CN-TEST');await tick();
      if(action==='close')await other.click({attributes:['data-cn-close']});
      else await other.ctx.openSetGrid('EN-TEST');
      slow.resolve();await pending;
      if(action==='close')assert.equal(other.modal.classList.contains('open'),false);
      else {assert.match(other.modal.innerHTML,/포켓몬 · 영판/);assert(!other.modal.innerHTML.includes('브레이브'));}
    }
  });
  await test('late list responses respect Japanese and One Piece language changes', async () => {
    const gate = deferred(), h = harness({cnGate: gate});
    h.list.dataset.catalogLanguage = 'zh-CN';const first = h.api.render();
    h.list.dataset.catalogLanguage = 'ja';h.list.innerHTML = 'Japanese content';
    gate.resolve();await first;assert.equal(h.list.innerHTML, 'Japanese content');
    h.list.dataset.catalogLanguage = 'zh-CN';h.ctx.CI_TAB = 'onepiece';h.list.innerHTML = 'One Piece content';
    await h.api.render();assert.equal(h.list.innerHTML, 'One Piece content');
  });
  await test('closed or replaced dialogs ignore pending Chinese product responses', async () => {
    for(const replace of [false, true]) {
      const gate = deferred(), h = harness({cnGate: gate});const pending = h.api.open('CN-TEST');
      assert.match(h.modal.innerHTML, /불러오는 중/);
      if(replace)h.ctx.openAnyModal('<h3 id="encPanelTitle">English content</h3>');
      else await h.click({attributes: ['data-cn-close']});
      gate.resolve();await pending;
      if(replace)assert.match(h.modal.innerHTML, /English content/);
      else assert.equal(h.modal.classList.contains('open'), false);
      assert(!h.modal.innerHTML.includes('브레이브'));
    }
  });
  await test('English wrapper switches between Chinese, Japanese, English and One Piece', async () => {
    const h = harness({english: true});await tick();
    assert.match(h.node('encLanguages').innerHTML, /data-enc-language="zh-CN"/);
    await h.click({dataset: {encLanguage: 'zh-CN'}});
    assert.equal(h.list.dataset.catalogLanguage, 'zh-CN');assert.match(h.list.innerHTML, /data-cn-set="CN-TEST"/);
    await h.click({dataset: {encLanguage: 'ja'}});assert.equal(h.list.innerHTML, 'original-pokemon');
    await h.click({dataset: {encLanguage: 'en'}});assert.match(h.list.innerHTML, /data-enc-set="EN-TEST"/);
    h.ctx.CI_TAB = 'onepiece';h.ctx.renderCardInfo();assert.equal(h.list.innerHTML, 'original-onepiece');
    assert.equal(h.node('encLanguages').hidden, true);assert.equal(h.list.dataset.catalogLanguage, '');
    h.ctx.CI_TAB = 'pokemon';h.ctx.renderCardInfo();assert.match(h.list.innerHTML, /data-enc-set="EN-TEST"/);
    await h.ctx.openSetGrid('CN-TEST');assert.match(h.modal.innerHTML, /포켓몬 · 중판/);
    h.ctx.openSetGrid('JP-ORIGINAL');assert.deepEqual(h.opened, ['JP-ORIGINAL']);
  });
  await test('actual page renderer survives Chinese, Japanese, English and One Piece transitions', async () => {
    const h = harness({english: true, actualRenderer: true});await tick();
    await h.click({dataset: {encLanguage: 'zh-CN'}});assert.match(h.list.innerHTML, /data-cn-set="CN-TEST"/);
    await h.click({dataset: {encLanguage: 'ja'}});assert.match(h.list.innerHTML, /data-set-code="JP-TEST"/);
    await h.click({dataset: {encLanguage: 'en'}});assert.match(h.list.innerHTML, /data-enc-set="EN-TEST"/);
    h.ctx.CI_TAB = 'onepiece';h.ctx.renderCardInfo();assert.match(h.list.innerHTML, /data-set-code="OP-TEST"/);
    assert.equal(h.node('encLanguages').hidden, true);
  });
  await test('late English catalog loading cannot replace a newer Chinese product dialog', async () => {
    const gate = deferred(), h = harness({english: true, enGate: gate});
    const oldEnglish = h.ctx.openSetGrid('EN-TEST');
    await h.ctx.openSetGrid('CN-TEST');assert.match(h.modal.innerHTML, /포켓몬 · 중판/);
    gate.resolve();await oldEnglish;await tick();
    assert.match(h.modal.innerHTML, /포켓몬 · 중판/);
    assert(!h.modal.innerHTML.includes('포켓몬 · 영판'));
  });
  await test('shared Chinese links select the Chinese language and product', async () => {
    const h = harness({english: true, search: '?set=CN-TEST'});await tick();
    assert.equal(h.api.initialLanguage, 'zh-CN');assert.equal(h.list.dataset.catalogLanguage, 'zh-CN');
    assert.match(h.list.innerHTML, /data-cn-set="CN-TEST"/);assert.match(h.modal.innerHTML, /포켓몬 · 중판/);
  });
  await test('global Chinese search keeps card and box kinds, set-scoped identities and detail routes', async () => {
    const h=searchHarness(), api=h.api;api.setup('zh-CN','card','피카츄');await api.render();
    assert.equal((api.html().match(/data-kind="card"/g)||[]).length,2,'Same local card ID in two sets remains two results');
    assert.match(api.html(),/피카츄 &lt;한정&gt;/);assert.match(api.html(),/중판 · 카드 · 001\/020/);assert.match(api.html(),/001\/020 · 마스터볼 무늬/);
    assert.match(api.html(),/\/?set=CN-TEST&amp;card=CARD-01#cardinfo/);assert.match(api.html(),/\/?set=CN-SECOND&amp;card=CARD-01#cardinfo/);
    assert.match(api.html(),/src="\/images\/pokemon-cn\/CN-TEST\.webp"/);assert.match(api.html(),/가격 미확보/);assert(!api.html().includes("시세 미수집"));
    assert(!api.html().includes('data-kind="box"'));assert.equal(api.placeholder(),'중판 카드 및 박스 이름 검색');
    api.setup('zh-CN','box','테스트');await api.render();assert.equal((api.html().match(/data-kind="box"/g)||[]).length,1);
    assert(!api.html().includes('data-kind="card"'));api.setup('zh-CN','all','테스트');await api.render();
    assert.equal((api.html().match(/class="gs-row"/g)||[]).length,3);assert.equal(h.jaLoads(),0);assert.equal(h.enLoads(),0);
    api.setup('en','all','box');await api.render();assert.match(api.html(),/English card art/);assert.match(api.html(),/영판 · 박스 · 수록 목록/);
    assert.equal(h.enLoads(),1);assert.equal(h.jaLoads(),0);
    api.setup('ja','all','Box');await api.render();assert.equal(api.normalized.size,1);assert.equal(api.normalized.has('JP-1'),true);
    assert.match(api.html(),/Japanese Box/);assert.equal(h.jaLoads(),1);
  });
  const actualPath = path.join(root, 'data/chinese-catalog.json');
  if(fs.existsSync(actualPath))await test('actual Chinese catalog passes product validation', () => {
    const actual = harness().api.prepare(JSON.parse(fs.readFileSync(actualPath, 'utf8')));
    assert.equal(actual.sets.length,48);
    const excluded=['CN-30TH-FUTURE-BOX','CN-30TH-PARTNER-1','CN-30TH-PARTNER-2','CN-30TH-PARTNER-3','CN-151-FIGURE','CN-151-STARTER-SQUIRTLE','CN-151-STARTER-CHARMANDER','CN-151-STARTER-BULBASAUR'];
    assert(!actual.sets.some(set=>excluded.includes(set.code)),'Gift/figure products are excluded from booster catalog');
    console.log('  Validated ' + actual.sets.length + ' actual Chinese products');
  });
  if(fs.existsSync(actualPath))await test('every actual Chinese product has an existing safe local image file', () => {
    const actual = JSON.parse(fs.readFileSync(actualPath, 'utf8')), api = harness().api;
    const imageRoot = path.join(root, 'images', 'pokemon-cn');
    const missing = actual.sets.filter(set => typeof set.image !== 'string' || !set.image.trim()).map(set => set.code);
    assert.equal(missing.length, 0, 'Missing product images: ' + missing.join(', '));
    for(const set of actual.sets) {
      assert.match(set.image, /^\/?images\/pokemon-cn\/CN-[A-Z0-9-]+\.(?:png|jpe?g|webp)$/, set.code + ' local image path');
      assert.equal(api.isImage(set.image), true, set.code + ' image must be allowed');
      const absolute = path.resolve(root, set.image.replace(/^\//, ''));
      const within = path.relative(imageRoot, absolute);
      assert(!within.startsWith('..') && !path.isAbsolute(within), set.code + ' image stays in the local image folder');
      assert(fs.existsSync(absolute), set.code + ' image file exists: ' + set.image);
      assert(fs.statSync(absolute).isFile(), set.code + ' image path names a file');
      const bytes = fs.readFileSync(absolute);
      assert(bytes.length > 12, set.code + ' image is not empty');
      const extension = path.extname(absolute).toLowerCase();
      const valid = extension === '.webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        : extension === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      assert(valid, set.code + ' file contains the expected image format, rather than an error page');
    }
    console.log('  Verified ' + actual.sets.length + '/' + actual.sets.length + ' local product images and file signatures');
  });
  else console.log('SKIP: actual Chinese catalog is still being prepared; fixture checks ran');
  if(fs.existsSync(actualPath))await test('all 48 booster files contain complete card lists with safe images and unique variant IDs', () => {
    const actual=JSON.parse(fs.readFileSync(actualPath,'utf8')),api=harness().api,expectedCards=new Map();let count=0;
    for(const set of actual.sets) {
      const file=path.join(root,'data','chinese-sets',set.code+'.json');assert(fs.existsSync(file),set.code+' has its full card file');
      const data=api.prepareCards(JSON.parse(fs.readFileSync(file,'utf8')),set.code);
      assert.equal(data.cardCount,data.expectedCardCount,set.code);assert.equal(data.cards.length,data.cardCount,set.code);
      if(set.cardCount!==undefined)assert.equal(set.cardCount,data.cardCount,set.code+' catalog card count');
      const printedCount=new Set(data.cards.map(card=>card.number)).size;
      if(set.printedCardCount!==undefined)assert.equal(set.printedCardCount,printedCount,set.code+' catalog printed-number count');
      if(data.printedCardCount!==undefined)assert.equal(data.printedCardCount,printedCount,set.code+' card-file printed-number count');
      assert.equal(new Set(data.cards.map(card=>card.id)).size,data.cardCount,set.code+' keeps unique variant IDs');
      for(const card of data.cards) {
        expectedCards.set(set.code+':'+card.id,card);
        assert(api.isImage(card.image),set.code+':'+card.id+' safe image');
        if(card.image.startsWith('/images/')||card.image.startsWith('images/')) {
          const local=path.resolve(root,card.image.replace(/^\//,''));assert(fs.existsSync(local),set.code+':'+card.id+' local image exists');
          assert(fs.statSync(local).size>12,set.code+':'+card.id+' image file is not empty');
        }
      }
      count+=data.cardCount;
    }
    const searchFile=path.join(root,'data','chinese-search.json');assert(fs.existsSync(searchFile),'Chinese card search index exists');
    const index=JSON.parse(fs.readFileSync(searchFile,'utf8'));assert.equal(index.schemaVersion,1);assert.equal(index.language,'zh-CN');
    assert.equal(index.cards.length,count,'Search index covers every booster card variant');
    assert.equal(new Set(index.cards.map(card=>card.setCode+':'+String(card.id||card.sourceId))).size,count,'Search IDs are unique within each set');
    for(const row of index.cards) {
      const key=row.setCode+':'+String(row.id||row.sourceId),card=expectedCards.get(key);assert(card,key+' search target belongs to the booster file');
      for(const field of ['number','name','image'])assert.equal(row[field],card[field],key+' search '+field+' matches the exact card');
    }
    console.log('  Verified '+actual.sets.length+' complete booster files and '+count+' searchable card variants');
  });
  const marketPath=path.join(root,'data/chinese-market.json');
  if(fs.existsSync(actualPath)&&fs.existsSync(marketPath))await test('actual auction export validates and matches exact Chinese card and booster targets', () => {
    const api=harness().api,market=api.prepareMarket(JSON.parse(fs.readFileSync(marketPath,'utf8')));
    const sets=JSON.parse(fs.readFileSync(actualPath,'utf8')).sets,byCode=new Map(sets.map(set=>[set.code,set])),bySource=new Map();
    for(const set of sets)for(const card of JSON.parse(fs.readFileSync(path.join(root,'data','chinese-sets',set.code+'.json'),'utf8')).cards) {
      const cards=bySource.get(card.sourceId)||[];cards.push(card);bySource.set(card.sourceId,cards);
    }
    let grades=0,boxes=0;
    for(const entry of Object.values(market.cards)) {
      assert((bySource.get(entry.sourceId)||[]).some(card=>['sourceId','sourceSetCode','number','name','variant'].every(key=>card[key]===entry[key])),entry.sourceId+' exact catalog identity');
      grades+=Object.keys(entry.grades).length;
    }
    for(const [code,quotes] of Object.entries(market.boxes)) {
      assert(byCode.has(code),code+' belongs to Chinese boosters');
      for(const quote of quotes) {
        if(quote.configurationVerified)assert.match(quote.configurationSourceUrl,/^https:\/\/(?:[a-z0-9-]+\.)?pokemon\.cn\//,code+' official configuration');
        boxes++;
      }
    }
    console.log('  Verified '+Object.keys(market.cards).length+' exact card targets, '+grades+' grade quotes and '+boxes+' box formats');
  });
  if(failures)process.exitCode = 1;
})().catch(error => {console.error(error);process.exitCode = 1;});