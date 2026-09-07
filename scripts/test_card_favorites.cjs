const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict'), path = require('node:path');
const root = path.resolve(__dirname, '..');
function button(id) {
  return {dataset:{watchId:id}, attrs:{}, innerHTML:'', disabled:false, classList:{add(){}},
    querySelector(){return this.innerHTML.includes('favorite-icon') ? {} : null;},
    setAttribute(k,v){this.attrs[k]=v;}};
}
function harness(initial=[]) {
  let saved=structuredClone(initial), failDelete=false, login=0, calls=[], next=100;
  const buttons=[button('868770'),button('868770'),button('123')], handlers={};
  const ctx={CURRENT_USER:{id:1},WATCHLIST:[],AbortSignal,window:{},
    document:{querySelectorAll:()=>buttons,querySelector:()=>buttons[0],getElementById:()=>null,addEventListener:(e,f)=>handlers[e]=f},
    openLoginModal:()=>login++,showToast(){},
    fetch:async(url,opt)=>{
      calls.push([url,opt.method||'GET']);
      if (url==='/api/portfolio') return {ok:true,json:async()=>({ok:true,watchlists:structuredClone(saved)})};
      if (opt.method==='DELETE') {
        if (failDelete) return {ok:false,json:async()=>({ok:false})};
        saved=saved.filter(r=>String(r.id)!==url.split('/').at(-1));
        return {ok:true,json:async()=>({ok:true})};
      }
      const row={id:next++,...JSON.parse(opt.body)}; saved.push(row);
      // Match the deployed API: there is NO data.watchlist field.
      return {ok:true,json:async()=>({ok:true,id:row.id})};
    }};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'assets/card-favorites.js'),'utf8'),ctx);
  return {ctx,buttons,calls,api:ctx.window.CardFavorites,saved:()=>saved,fail:()=>failDelete=true,login:()=>login};
}
(async()=>{
  const h=harness();
  await h.api.toggle('868770',h.buttons[0]);
  assert.equal(h.saved().length,1); assert.equal(h.ctx.WATCHLIST[0].card_id,'868770');
  assert.equal(h.buttons[0].attrs['aria-pressed'],'true'); assert.equal(h.buttons[1].attrs['aria-pressed'],'true');
  assert.equal(h.buttons[2].attrs['aria-pressed'],'false');
  await h.api.toggle('868770',h.buttons[1]);
  assert.equal(h.saved().length,0); assert.equal(h.buttons[0].attrs['aria-pressed'],'false');
  assert(h.calls.some(([url,method])=>url.endsWith('/100') && method==='DELETE'));
  const saved=harness([{id:7,card_id:'868770',grade:'psa10'},{id:8,card_id:'868770',grade:'raw'},{id:9,card_id:'123'}]);
  await saved.api.toggle('868770');assert.deepEqual(saved.saved().map(r=>r.id),[9]);
  const failure=harness([{id:7,card_id:'868770'}]);failure.fail();await failure.api.toggle('868770');
  assert.equal(failure.saved().length,1);assert.equal(failure.buttons[0].attrs['aria-pressed'],'true');assert.equal(failure.buttons[0].disabled,false);
  const concurrent=harness();await Promise.all([concurrent.api.toggle('868770'),concurrent.api.toggle('868770')]);
  assert.equal(concurrent.calls.filter(([,m])=>m==='POST').length,1);
  concurrent.ctx.CURRENT_USER=null;concurrent.api.sessionChanged();await concurrent.api.toggle('868770');
  assert.equal(concurrent.buttons[0].attrs['aria-pressed'],'false');assert.equal(concurrent.login(),1);
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if(match[0].includes('application/ld+json')) continue;
    new vm.Script(match[1]);
  }
  assert.match(html,/id="slideWatchBtn"/);assert.match(html,/slideWatchBtn'\)\.dataset.watchId = String\(productId\)/);
  console.log('PASS: API response contract, add/remove, shared card state, existing multi-grade rows, failed DELETE, rapid taps, logout, popup identity and inline script syntax');
})().catch(e=>{console.error(e);process.exitCode=1;});
