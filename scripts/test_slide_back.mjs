import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
assert.ok(html.indexOf('id="slideWatchBtn"')<html.indexOf('id="slideBackBtn"'));
assert.ok(html.indexOf('id="slideBackBtn"')<html.indexOf('id="slideShareBtn"'));
assert.match(html,/id="slideBackBtn"[^>]*aria-label="이전 목록으로 돌아가기"/);
const nodes=new Map();
function node(id){
  if(!nodes.has(id))nodes.set(id,{dataset:{},innerHTML:'',textContent:'',classList:{add(){},remove(){}},setAttribute(){}});
  return nodes.get(id);
}
const reopened=[];
const ctx={document:{getElementById:node,body:{style:{}}},location:{hash:'#cardinfo'},
  CardFavorites:{sync(){}},renderSlidePanel:async()=>{},console,
  _LAST_OPENED_SET:{setCode:'OP17',setName:'World Strongest',externalUrl:'https://example.com/set',page:10,scrollTop:246,expanded:true},
  closeAnyModal(){},openSetGrid:(...args)=>reopened.push(args)};
ctx.window=ctx;
vm.createContext(ctx);
vm.runInContext(html.slice(html.indexOf('let CURRENT_SLIDE_ID = null;'),html.indexOf('async function renderSlidePanel(productId)')),ctx);
const restore=html.slice(html.indexOf('window.reopenLastSet = function('));
vm.runInContext(restore.slice(0,restore.indexOf('\n};')+3),ctx);
await ctx.openSlidePanel('871034');
ctx._LAST_OPENED_SET={setCode:'M6a',page:1};
ctx.backFromSlidePanel();
assert.equal(reopened.length,1);
assert.equal(reopened[0][0],'OP17','Return to the entry set, never a later unrelated set');
assert.equal(reopened[0][3].page,10);
assert.equal(reopened[0][3].scrollTop,246);
assert.equal(reopened[0][3].expanded,true);
assert.equal(ctx.document.body.style.overflow,'');
ctx.backFromSlidePanel();assert.equal(reopened.length,1,'No stale repeat navigation');
for(const hash of ['#home','#price']){
  ctx.location.hash=hash;await ctx.openSlidePanel('871034');ctx.backFromSlidePanel();
  assert.equal(reopened.length,1,'Home/price must not jump to an old box');
}
ctx.location.hash='#cardinfo';await ctx.openSlidePanel('871034');ctx.closeSlidePanel();ctx.backFromSlidePanel();
assert.equal(reopened.length,1,'Close clears the return context');
assert.match(html,/let page = Math.max\(1, Math.min\(pageCount, Number\(viewState.page\) \|\| 1\)\)/);
assert.match(html,/viewState.page = page/);
assert.match(html,/viewState.scrollTop = scrollArea.scrollTop/);
assert.match(html,/scrollArea.scrollTop = Math.max\(0, Number\(viewState.scrollTop\) \|\| 0\)/);
console.log('PASS: button order/label, original set/page/scroll/fullscreen restoration, home/price fallback, no stale navigation');
