const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = html.indexOf('// Printed Japanese cards keep one current price source');
const handler = html.slice(start, html.indexOf('// 박스로 돌아가기', start));
const defer = () => { let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve}; };
function harness(prepare, lookup = async () => ({source:'yuyutei',status:'priced',amount:100})) {
  const calls={slide:[],html:[],lookup:0,closed:0};
  const origin={}, state={open:true}; let click;
  const ctx={CI_PANEL_REQUEST:1,_LAST_OPENED_SET:{setName:'Test'},escapeHtml:s=>String(s||''),
    document:{addEventListener:(_,fn)=>click=fn,getElementById:id=>id==='setGridContent'?origin:{classList:{contains:()=>state.open}}},
    window:{ContainedCardPrices:{prepareTarget:prepare},CardPriceFallback:{
      resolve:t=>t.direct||{status:'none'}, lookup:async(...args)=>{calls.lookup++;return lookup(...args);},
      render:r=>r?.source||'none',
    }},
    closeAnyModal:()=>{calls.closed++;state.open=false;},
    openAnyModal:s=>{calls.html.push(s);state.open=true;},
    openSlidePanel:id=>calls.slide.push(id),
  };
  vm.runInNewContext(handler,ctx);
  const item = (id='1') => ({dataset:{cardName:'Card '+id,cardIdentity:JSON.stringify({brand:'pokemon',language:'ja',id,number:'001/100'})},isConnected:true,querySelector:()=>null});
  return {calls,state,item,click:i=>click({target:{closest:s=>s==='.card-price-fallback a'?null:i}})};
}
test('new categories live in Card Info and source page shortcuts are removed',()=>{
  const price=html.slice(html.indexOf('data-page="price"'),html.indexOf('data-page="hub"'));
  assert(!price.includes('mr-game-shortcuts'));
  assert(!price.includes('/market-references'));
  const tabs=html.match(/id="ciTabs"[\s\S]*?<\/div>/)[0];
  for(const game of ['pokemon','onepiece','nikke','dragon_ball_fusion_world','yugioh','digimon','weiss_schwarz','union_arena','riftbound']) assert(tabs.includes('data-ci="'+game+'"'),game);
  assert(html.indexOf('/assets/tcg-card-info.js')>html.indexOf('/assets/chiikawa-catalog.js'));
  assert(html.indexOf('/assets/card-price-fallback.js')<html.indexOf('/assets/tcg-card-info.js'));
  assert.doesNotMatch(html,/data-contained-price|ContainedCardPrices\?\.hydrate\(/);
  assert.match(html,/location\.pathname \+ location\.search \+ '#cardinfo'/);
});
test('a current SNKR price keeps the existing detail without querying fallback',async()=>{
  const h=harness(async()=>({snkrdunkId:'42',direct:{status:'priced',source:'snkrdunk'}}));
  await h.click(h.item()); assert.deepEqual(h.calls.slide,['42']); assert.equal(h.calls.lookup,0); assert.equal(h.calls.html.length,0);
});
test('missing SNKR price shows fallback inside Card Info instead of empty market detail',async()=>{
  const h=harness(async()=>({snkrdunkId:'42',fullNumber:'001/100'}));
  await h.click(h.item()); assert.equal(h.calls.lookup,1); assert.equal(h.calls.slide.length,0); assert(h.calls.html[0].includes('yuyutei'));
});
test('a source failure is not treated as missing SNKR price',async()=>{
  const h=harness(async()=>({sourceUnavailable:true})); await h.click(h.item());
  assert.equal(h.calls.lookup,0); assert.equal(h.calls.slide.length,0); assert(h.calls.html[0].includes('가격 확인 지연'));
});
test('a closed set cannot be reopened by delayed price preparation',async()=>{
  const pending=defer(),h=harness(()=>pending.promise);const run=h.click(h.item());h.state.open=false;
  pending.resolve({fullNumber:'001/100'});await run;assert.equal(h.calls.lookup,0);assert.equal(h.calls.closed,0);assert.equal(h.calls.html.length,0);
});
test('a newer card wins while an older card is still preparing',async()=>{
  const pending=defer(),h=harness(t=>t.id==='1'?pending.promise:Promise.resolve({snkrdunkId:'2',direct:{status:'priced',source:'snkrdunk'}}));
  const older=h.click(h.item('1'));await h.click(h.item('2'));pending.resolve({snkrdunkId:'1',direct:{status:'priced',source:'snkrdunk'}});await older;
  assert.deepEqual(h.calls.slide,['2']);assert.equal(h.calls.html.length,0);
});
