#!/usr/bin/env node
'use strict';

/* Compile the existing reviewed catalogues into one search-only snapshot.
 * Run after data collection and before deployment packaging. Browser search never
 * needs to download the full card metadata index just to label a result.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const FIELDS = [
  'id','name','displayName','kind','brand','language','thumbnailUrl','setName',
  'productNumber','number','setCode','boxCode','productId','productIds','fullId',
  '_catalogue','currency','minPrice','listingCount','searchText','promoKeys','cardType','href',
];
const VERSION = '20261104-search3';
const MODULES = ['japanese-card-names','card-catalog-repairs','japanese-catalog','onepiece-official-catalog','anniversary-market','promo-search'];
const DICTIONARY_FIELDS = ['kind','brand','language','setName','currency','setCode','boxCode','cardType','number','productNumber'];

function dictionaryEncode(rows) {
  const dictionaries = {};
  for (const field of DICTIONARY_FIELDS) {
    const position = FIELDS.indexOf(field), values = rows.map(row => row[position]);
    const dictionary = [], lookup = new Map();
    const encoded = values.map(value => {
      if (typeof value !== 'string') return value;
      if (!lookup.has(value)) { lookup.set(value,dictionary.length); dictionary.push(value); }
      return lookup.get(value);
    });
    const before = Buffer.byteLength(JSON.stringify(values));
    const after = Buffer.byteLength(JSON.stringify(encoded)) + Buffer.byteLength(JSON.stringify(dictionary)) + field.length + 4;
    if (before - after < 4096) continue;
    dictionaries[field] = dictionary;
    rows.forEach((row,index) => {row[position] = encoded[index];});
  }
  return dictionaries;
}

function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error('Search compiler source boundary missing: ' + start);
  return source.slice(a, b);
}

function createContext(root) {
  const missing = new Set(), requested = new Set(), warnings = [];
  const sandbox = {
    URL, URLSearchParams, AbortSignal, setTimeout, clearTimeout,
    console: {log() {}, warn(...args) { warnings.push(args.map(String).join(' ')); }},
    document: {addEventListener() {}},
    fetch: async resource => {
      const url = new URL(String(resource), 'https://tcghub.kr');
      if (url.origin !== 'https://tcghub.kr' || !url.pathname.startsWith('/data/')) {
        throw new Error('Search compiler cannot fetch external or live API resources: ' + url.pathname);
      }
      const relative = decodeURIComponent(url.pathname).slice(1);
      const filename = path.resolve(root, relative);
      if (!filename.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid source path');
      requested.add(relative);
      if (!fs.existsSync(filename)) {
        missing.add(relative);
        return {ok:false, status:404, json:async () => { throw new Error('Missing ' + relative); }};
      }
      return {ok:true, status:200, json:async () => JSON.parse(fs.readFileSync(filename, 'utf8'))};
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const run = (text, filename) => vm.runInContext(text, context, {filename, timeout:120000});
  for (const name of MODULES) {
    run(fs.readFileSync(path.join(root, 'assets', name + '.js'), 'utf8'), name + '.js');
  }
  run(
    'let _PRICE_BOX_NAME_OVERRIDES=null, _PRICE_CARD_NAME_OVERRIDES=null, _PRICE_CARD_META_INDEX=null;\n' +
    between(page, 'const CARDINFO = {', 'let CI_TAB = ') + '\n' +
    between(page, 'function getBoxKoreanName(', '// 카드 목록 가격을 PSA10') + '\n' +
    between(page, 'async function enrichPriceProductMetadata(', 'let PRICE_GRID_REQUEST = ') + '\n' +
    between(page, 'let _ALL_CARDS_INDEX = null;', 'function searchCards('),
    'existing-search-loaders.js'
  );
  return {context, run, missing, requested, warnings};
}

function rowTitle(row, names) {
  if (row.brand === 'pokemon') return names.title(row);
  if (row.brand === 'onepiece' && row.nameKo) return row.nameKo;
  return String(row.displayName || row.name || '').replace(/\s*\((?:Enhanced|High Class|Booster|Expansion|Promotional|Starter)\b.*$/i,'').trim();
}

async function compileSnapshot(root) {
  const state = createContext(root);
  await state.run('buildCardSearchData()', 'load-search-data.js');
  await state.run('JapaneseCardNames.ensureData()', 'load-search-names.js');
  // Initial CARDINFO only lists the main boosters. Starter, premium, promo and
  // limited-product labels must use the same reviewed manifest as the dialog.
  await state.run('OnePieceCatalog.ensureManifest()', 'load-onepiece-manifest.js');
  const onepieceSets = state.run('OnePieceCatalog.registerSets(CARDINFO.onepiece || [])', 'official-box-labels.js');
  const rawRows = state.run('OnePieceCatalog.mergeSearch(JapaneseCatalog.getSearchRows() || _ALL_CARDS_INDEX)', 'search-rows.js');
  const boxes = rawRows.filter(row => row.kind === 'box' && !row._catalogue).map(row => ({...row}));
  state.context.searchCompilerBoxes = boxes;
  await state.run('enrichPriceProductMetadata(searchCompilerBoxes, "box")', 'enrich-boxes.js');
  if (state.missing.size) throw new Error('Incomplete search sources: ' + [...state.missing].sort().join(', '));
  if (state.run('PromoSearch.needsRetry()', 'promo-status.js')) throw new Error('Promo search supplement was incomplete');
  if (!rawRows.length) throw new Error('Search catalogue is empty');

  const boxMap = new Map();
  for (const box of boxes) if (!boxMap.has(box.id)) boxMap.set(box.id, box);
  const names = state.context.JapaneseCardNames;
  const promo = state.context.PromoSearch;
  const cardinfo = state.run('CARDINFO', 'box-labels.js');
  const getBoxName = row => {
    state.context.searchCompilerRow = row;
    return state.run('getBoxKoreanName(searchCompilerRow, searchCompilerRow.brand)', 'box-label.js');
  };
  const isBox = row => {
    state.context.searchCompilerRow = row;
    return state.run('isPriceBoxProduct(searchCompilerRow)', 'box-type.js');
  };
  const projected = new Map();
  for (const original of rawRows) {
    const row = boxMap.get(original.id) || original;
    if (names.language(row) !== 'ja' || !['pokemon','onepiece'].includes(row.brand)) continue;
    const kind = row.kind === 'box' && (row._catalogue || isBox(row)) ? 'box' : 'card';
    // A reprint's printed setCode can differ from its containing boxCode.
    const code = String(row.boxCode || row.setCode || row.code || row.productNumber || '').toUpperCase();
    const sets = row.brand === 'onepiece' ? onepieceSets : cardinfo[row.brand] || [];
    const set = sets.find(set =>
      kind === 'box' && String(set.boxId) === String(row.id) || code &&
      (code === set.code.toUpperCase() || code.startsWith(set.code.toUpperCase() + '-') || code.startsWith('PKMN-TCG-' + set.code.toUpperCase() + '-')));
    const koreanSetName = set?.name?.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const displayName = kind === 'box' ? getBoxName(row) || koreanSetName || row._koName || row.displayName || row.name : rowTitle(row, names);
    const setName = (row.brand === 'onepiece' ? set?.name || row.setName : row.setName || set?.name) || row.productNumber?.toUpperCase() || (row.brand === 'onepiece' ? '원피스' : '포켓몬');
    const sourceText = row._searchText || row._opSearch || row.nameLower || '';
    // JapaneseCatalog already includes translated names and aliases in _searchText;
    // adding names.searchText again duplicates several megabytes across the pool.
    const searchText = [...new Set([sourceText || names.searchText(row), set?.name].filter(Boolean))].join(' ');
    // Preserve the existing exact-market destination. Unbound official artworks
    // link to the set/card information; no candidate ID supplies its price.
    const normalized = {...row, kind, displayName, setName};
    let href = state.context.JapaneseCatalog.href(normalized);
    if (row.brand === 'onepiece' && /^JP:ONEPIECE:/.test(row.id) && !row.productId) href = state.context.OnePieceCatalog.href(normalized);
    const out = {
      id:String(row.id), name:String(row.name || ''), displayName:String(displayName || row.name || ''), kind, brand:row.brand, language:'ja',
      thumbnailUrl:String(row.thumbnailUrl || row.image || ''), setName:String(setName),
      productNumber:String(row.productNumber || row.code || ''), number:String(row.number || ''), setCode:String(row.setCode || row.code || ''),
      boxCode:String(row.boxCode || ''), productId:row.productId ? String(row.productId) : null,
      productIds:(row.productIds || []).map(String), fullId:String(row.fullId || ''), _catalogue:Boolean(row._catalogue),
      currency:String(row.currency || 'JPY'), minPrice:Number(row.minPrice) > 0 ? Number(row.minPrice) : null,
      listingCount:parseInt(String(row.listingCount || 0).replace(/\+/g,''),10) || 0,
      searchText, promoKeys:promo.codeKeys(row), cardType:String(row.cardType || ''), href,
    };
    if (!out.id || !out.name || !out.displayName) throw new Error('Incomplete search identity: ' + out.id);
    projected.set(out.id, out);
  }
  const aliases = JSON.parse(JSON.stringify(state.run('_SEARCH_ALIASES || {}', 'search-aliases.js')));
  const rows = [...projected.values()].map(row => FIELDS.map(field => row[field] ?? null));
  const identity = rows.map(row => row[0]).join('\n');
  const dictionaries = dictionaryEncode(rows);
  const inputFiles = [...state.requested].sort();
  const sourceHash = crypto.createHash('sha256');
  sourceHash.update(fs.readFileSync(path.join(root,'index.html')));
  sourceHash.update(fs.readFileSync(__filename));
  for (const name of MODULES) sourceHash.update(name).update(fs.readFileSync(path.join(root,'assets',name+'.js')));
  for (const name of inputFiles) sourceHash.update(name).update(fs.readFileSync(path.join(root,name)));
  return {
    schemaVersion:1, version:VERSION, generatedAt:new Date().toISOString(),
    sourceHash:sourceHash.digest('hex'), fields:FIELDS, dictionaries, rows, aliases, rowCount:rows.length,
    counts:{total:rows.length,card:[...projected.values()].filter(row=>row.kind==='card').length,box:[...projected.values()].filter(row=>row.kind==='box').length,
      pokemon:[...projected.values()].filter(row=>row.brand==='pokemon').length,onepiece:[...projected.values()].filter(row=>row.brand==='onepiece').length},
    identityHash:crypto.createHash('sha256').update(identity).digest('hex'),
  };
}

async function main() {
  const rootArg = process.argv.indexOf('--root');
  const outArg = process.argv.indexOf('--out');
  const root = path.resolve(rootArg >= 0 ? process.argv[rootArg+1] : path.join(__dirname,'..'));
  const output = path.resolve(outArg >= 0 ? process.argv[outArg+1] : path.join(root,'data/search-index-ja.json'));
  const snapshot = await compileSnapshot(root);
  const result = writeSnapshot(snapshot,output);
  console.log(JSON.stringify({output,...result,...snapshot.counts,sourceHash:snapshot.sourceHash}));
}
function writeSnapshot(snapshot,output,{maxShardBytes=8*1024*1024,publicPrefix='/data/search-index-ja/'}={}) {
  const serialize = value => JSON.stringify(value)+'\n';
  const text = serialize(snapshot);
  fs.mkdirSync(path.dirname(output), {recursive:true});
  if (Buffer.byteLength(text) <= maxShardBytes) {
    fs.writeFileSync(output,text);
    return {bytes:Buffer.byteLength(text),shards:0};
  }
  // Content-addressed shard URLs prevent a cached manifest from silently using
  // another release's rows. Keep the manifest small; all rows stay searchable.
  const shardDirectory=path.join(path.dirname(output),'search-index-ja');
  fs.mkdirSync(shardDirectory,{recursive:true});
  const shards=[];
  let group=[],groupBytes=128,totalBytes=0;
  const flush=()=>{
    if(!group.length)return;
    const body=serialize({schemaVersion:1,sourceHash:snapshot.sourceHash,rows:group});
    const bytes=Buffer.byteLength(body);
    if(bytes>maxShardBytes)throw new Error('Search shard exceeds its asset budget');
    const digest=crypto.createHash('sha256').update(body).digest('hex').slice(0,20);
    const filename='part-'+String(shards.length).padStart(4,'0')+'-'+digest+'.json';
    fs.writeFileSync(path.join(shardDirectory,filename),body);
    shards.push(publicPrefix+filename);totalBytes+=bytes;
    group=[];groupBytes=128;
  };
  for(const row of snapshot.rows){
    const bytes=Buffer.byteLength(JSON.stringify(row))+1;
    if(group.length&&groupBytes+bytes>maxShardBytes)flush();
    group.push(row);groupBytes+=bytes;
  }
  flush();
  const manifest=serialize({...snapshot,rows:[],shards});
  fs.writeFileSync(output,manifest);
  return {bytes:Buffer.byteLength(manifest),totalBytes:totalBytes+Buffer.byteLength(manifest),shards:shards.length};
}
if (require.main === module) main().catch(error => { console.error(error.stack || String(error)); process.exitCode=1; });
module.exports={FIELDS,compileSnapshot,createContext,between,writeSnapshot};
