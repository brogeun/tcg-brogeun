const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceRoot = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(sourceRoot, 'index.html'), 'utf8');
const start = html.indexOf('async function loadPriceGrid()');
const end = html.indexOf('\n// 시세 상품 ID', start);
const prefixStart = html.lastIndexOf('let PRICE_GRID_REQUEST = 0;', start);
const code = (prefixStart !== -1 ? html.slice(prefixStart, start) : '') + html.slice(start, end);
const nodes = new Map();
const node = id => nodes.get(id) || (nodes.set(id,{textContent:'',innerHTML:''}), nodes.get(id));
let resolveFirst;
const calls = [], renders = [];
const first = new Promise(resolve => {resolveFirst = resolve;});
const response = products => ({ok:true,json:async () => ({ok:true,products})});
const ctx = {
  PRICE_BRAND:'pokemon',PRICE_CAT:'box',PRICE_LOADING:false,HOME_TOP_CACHE:{},
  document:{getElementById:node},window:{},Math,Date,console,
  escapeHtml:s=>s,
  enrichPriceProductMetadata:async x=>x,
  isPriceBoxProduct:x=>x.kind==='box',
  applyGradePrices:async x=>x,
  renderPriceGrid:x=>renders.push({brand:ctx.PRICE_BRAND,cat:ctx.PRICE_CAT,ids:x.map(y=>y.id)}),
  fetch:async url=>{calls.push(url); if(calls.length===1)return first;
    return response(url.includes('price-onepiece-card')?[{id:'onepiece-card',kind:'card'}]:[]);},
};
vm.createContext(ctx);vm.runInContext(code,ctx);
(async()=>{
  const old = ctx.loadPriceGrid();
  ctx.PRICE_BRAND='onepiece';ctx.PRICE_CAT='card';
  await ctx.loadPriceGrid();
  resolveFirst(response([{id:'pokemon-box',kind:'box'}]));
  await old;
  assert.equal(renders.length,1);
  assert.equal(JSON.stringify(renders[0].ids),'["onepiece-card"]');
  assert(!ctx.HOME_TOP_CACHE.onepiece?.some(x=>x.id==='pokemon-box'));
  console.log(JSON.stringify({calls,renders,cache:ctx.HOME_TOP_CACHE}));
})().catch(e=>{console.error(e);process.exitCode=1;});
