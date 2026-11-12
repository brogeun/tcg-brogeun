import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from './fixtures/linkedom.worker.mjs';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const lucideScript=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(source=>source.includes('function _renderLucidePlaceholder'));
const favoriteSource=readFileSync(new URL('../assets/card-favorites.js',import.meta.url),'utf8');
const pinnedSource=readFileSync(new URL('./fixtures/lucide-0.469.0-runtime.cjs',import.meta.url),'utf8');
const tick=async()=>{for(let i=0;i<18;i++)await Promise.resolve();};
const reply=watchlists=>({ok:true,json:async()=>({ok:true,watchlists})});

function pinnedLucide(document){
  const context=vm.createContext({document,module:{exports:{}},console:{warn(){}}});
  vm.runInContext(pinnedSource,context);
  return context.module.exports;
}
function domFixture(markup){
  const {window}=parseHTML('<html><body>'+markup+'</body></html>'),document=window.document;
  const observers=[],ready=[],timers=[];
  let scans=0;
  const queryAll=document.querySelectorAll.bind(document);
  document.querySelectorAll=(selector)=>{scans++;return queryAll(selector);};
  document.addEventListener=(event,listener)=>{if(event==='DOMContentLoaded')ready.push(listener);};
  const context=vm.createContext({window,document,console,Promise,Set,AbortSignal,
    MutationObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(target,options){this.target=target;this.options=options;}},
    setTimeout:callback=>{timers.push(callback);return timers.length;},clearTimeout(){}});
  return {window,document,context,observers,ready,timers,get scans(){return scans;},clearScans(){scans=0;},boot(){ready.forEach(fn=>fn());},mutate(records){observers[0].callback(records);},flush(){while(timers.length)timers.shift()();}};
}
function lucideFixture(markup){
  const h=domFixture(markup),api=pinnedLucide(h.document),created=[];
  h.window.lucide={...api,createElement(icon){created.push(icon);return api.createElement(icon);}};
  vm.runInContext(lucideScript,h.context);h.boot();
  return Object.assign(h,{created});
}
function tree(element){
  return {tag:element.localName,attrs:Object.fromEntries([...element.attributes].map(a=>[a.name,a.value]).sort(([a],[b])=>a.localeCompare(b))),children:[...element.children].map(tree)};
}
function favoriteFixture({markup='<button data-watch-id="868770"></button><button data-watch-id="123"></button>',fetch:fetcher,user='A'}={}){
  const h=domFixture(markup),calls=[],toasts=[];
  h.context.CURRENT_USER=user?{id:user}:null;h.context.WATCHLIST=[];
  h.context.showToast=(...args)=>toasts.push(args);h.context.openLoginModal=()=>{};
  h.context.fetch=async(url,options)=>{const call={url,options,who:h.context.CURRENT_USER?.id};calls.push(call);return fetcher?fetcher(call,h):reply(call.who==='B'?[{id:2,card_id:'123'}]:[{id:1,card_id:'868770'}]);};
  vm.runInContext(favoriteSource,h.context);h.boot();
  return Object.assign(h,{calls,toasts,api:h.window.CardFavorites,switchOwner(id){h.context.CURRENT_USER=id?{id}:null;h.window.CardFavorites.sessionChanged();}});
}
function editsOf(button){
  let edits=0;const set=button.setAttribute.bind(button);button.setAttribute=(key,value)=>{edits++;return set(key,value);};
  return {get count(){return edits;}};
}

test('scoped renderer preserves pinned 0.469.0 SVG paths, attributes, classes and accessibility',()=>{
  const markup='<i data-lucide="house" id="house" class="home-icon custom custom" style="width:32px;height:32px" width="32" aria-label="홈" role="img"></i><i data-lucide="user-round" aria-hidden="true" stroke-width="1.5"></i><i data-lucide="trending-up" data-test="gain"></i><i data-lucide="alert-circle" class="notice"></i>';
  const old=domFixture(markup);pinnedLucide(old.document).createIcons();
  const current=lucideFixture(markup);
  assert.deepEqual([...current.document.body.children].map(tree),[...old.document.body.children].map(tree));
  assert.equal(current.created.length,4);
  assert.match(html,/lucide@0\.469\.0\/dist\/umd\/lucide\.min\.js/);
});

test('initialization and repeated explicit init leave existing SVG instances intact',()=>{
  const h=lucideFixture('<svg data-lucide="house" class="lucide lucide-house" id="existing"><path d="M0 0"></path></svg><i data-lucide="user-round"></i>');
  const existing=h.document.getElementById('existing'),generated=h.document.querySelector('svg[data-lucide="user-round"]');
  vm.runInContext('_initLucide(document)',h.context);
  assert.equal(h.document.getElementById('existing'),existing);
  assert.equal(h.document.querySelector('svg[data-lucide="user-round"]'),generated);
  assert.equal(h.created.length,1);
});

test('unrelated mutations schedule no icon render and do not query the document',()=>{
  const h=lucideFixture('<i data-lucide="house"></i>');h.clearScans();
  const unrelated=h.document.createElement('span');unrelated.textContent='가격 업데이트';h.document.body.append(unrelated);
  h.mutate([{type:'childList',addedNodes:[unrelated]}]);h.flush();
  assert.equal(h.scans,0);assert.equal(h.created.length,1);assert.equal(h.timers.length,0);
});

test('nested additions and placeholder attribute changes render only connected new icons once',()=>{
  const h=lucideFixture('<i data-lucide="house"></i>');h.clearScans();
  const added=h.document.createElement('div');added.innerHTML='<span><i data-lucide="house" class="dynamic"></i></span>';
  h.document.body.append(added);const icon=added.querySelector('i');icon.setAttribute('data-lucide','trending-up');
  h.mutate([{type:'childList',addedNodes:[added,icon]},{type:'attributes',target:icon,attributeName:'data-lucide'}]);h.flush();
  assert.equal(h.scans,0);assert.equal(h.created.length,2);assert.ok(added.querySelector('svg.lucide-trending-up.dynamic'));
  const svg=added.querySelector('svg');h.mutate([{type:'childList',addedNodes:[svg]}]);h.flush();assert.equal(h.created.length,2);
  const detached=h.document.createElement('i');detached.setAttribute('data-lucide','house');h.document.body.append(detached);h.mutate([{type:'childList',addedNodes:[detached]}]);detached.remove();h.flush();assert.equal(h.created.length,2);
});

test('favorite observer ignores unrelated changes and its own star insertion',async()=>{
  const h=favoriteFixture();await tick();h.clearScans();
  const original=h.document.querySelector('button'),writes=editsOf(original),callCount=h.calls.length;
  const unrelated=h.document.createElement('div');unrelated.innerHTML='<span>시세 100원</span>';h.document.body.append(unrelated);
  h.mutate([{type:'childList',addedNodes:[unrelated]}]);await tick();
  h.mutate([{type:'childList',addedNodes:[original.querySelector('svg')]}]);await tick();
  assert.equal(h.scans,0);assert.equal(writes.count,0);assert.equal(h.calls.length,callCount);
});

test('favorite additions and watch ID changes update only affected buttons',async()=>{
  const h=favoriteFixture();await tick();h.clearScans();
  const original=h.document.querySelector('button'),writes=editsOf(original);
  const added=h.document.createElement('section');added.innerHTML='<button data-watch-id="868770"></button><button data-watch-id="123"></button>';h.document.body.append(added);
  const fresh=added.querySelector('button');h.mutate([{type:'childList',addedNodes:[added,fresh]}]);await tick();
  assert.equal(fresh.getAttribute('aria-pressed'),'true');assert.equal(added.querySelectorAll('button')[1].getAttribute('aria-pressed'),'false');
  assert.equal(fresh.querySelectorAll('.favorite-icon').length,1);assert.equal(writes.count,0);assert.equal(h.scans,0);
  fresh.setAttribute('data-watch-id','123');h.mutate([{type:'attributes',target:fresh,attributeName:'data-watch-id'}]);await tick();
  assert.equal(fresh.getAttribute('aria-pressed'),'false');assert.equal(writes.count,0);assert.equal(h.calls.length,1);
  const removed=h.document.createElement('button');removed.setAttribute('data-watch-id','868770');h.document.body.append(removed);h.mutate([{type:'childList',addedNodes:[removed]}]);removed.remove();await tick();assert.equal(removed.querySelector('.favorite-icon'),null);
});

test('explicit auth changes still refresh every star without relying on mutations',async()=>{
  const h=favoriteFixture();await tick();
  assert.equal(h.document.querySelector('[data-watch-id="868770"]').getAttribute('aria-pressed'),'true');
  h.switchOwner(null);assert.equal(h.context.WATCHLIST.length,0);
  for(const button of h.document.querySelectorAll('button'))assert.equal(button.getAttribute('aria-pressed'),'false');
  h.switchOwner('B');await tick();
  assert.equal(h.document.querySelector('[data-watch-id="123"]').getAttribute('aria-pressed'),'true');
  assert.match(html,/window\.CardFavorites\?\.sessionChanged\(\)/);
});

test('late A load is discarded and B reload starts without another DOM mutation',async()=>{
  const pending=[];const h=favoriteFixture({fetch:call=>new Promise(resolve=>pending.push({call,resolve}))});
  assert.equal(pending.length,1);h.switchOwner('B');
  pending[0].resolve(reply([{id:1,card_id:'868770'}]));await tick();
  assert.equal(h.context.WATCHLIST.length,0);assert.equal(pending.length,2);assert.equal(pending[1].call.who,'B');
  pending[1].resolve(reply([{id:2,card_id:'123'}]));await tick();
  assert.equal(h.context.WATCHLIST[0].card_id,'123');
  assert.equal(h.document.querySelector('[data-watch-id="868770"]').getAttribute('aria-pressed'),'false');
  assert.equal(h.document.querySelector('[data-watch-id="123"]').getAttribute('aria-pressed'),'true');
});

test('A to B to A discards the old A epoch and reloads the current A session',async()=>{
  const pending=[];const h=favoriteFixture({fetch:call=>new Promise(resolve=>pending.push({call,resolve}))});
  h.switchOwner('B');h.switchOwner('A');pending[0].resolve(reply([{id:1,card_id:'868770'}]));await tick();
  assert.equal(h.context.WATCHLIST.length,0);assert.equal(pending.length,2);assert.equal(pending[1].call.who,'A');
  pending[1].resolve(reply([{id:3,card_id:'123'}]));await tick();assert.equal(h.context.WATCHLIST[0].id,3);
});

test('account switch while waiting to toggle never writes under the new owner',async()=>{
  const pending=[];const h=favoriteFixture({fetch:call=>new Promise(resolve=>pending.push({call,resolve}))});
  const action=h.api.toggle('868770',h.document.querySelector('button'));
  h.switchOwner('B');pending[0].resolve(reply([{id:1,card_id:'868770'}]));await action;await tick();
  assert.equal(h.calls.filter(c=>c.options.method).length,0);assert.equal(pending.length,2);assert.equal(pending[1].call.who,'B');
  pending[1].resolve(reply([{id:2,card_id:'123'}]));await tick();
  assert.equal(h.context.WATCHLIST[0].id,2);assert.equal(h.toasts.length,0);
});

test('same-account load failures are not retried automatically',async()=>{
  const h=favoriteFixture({fetch:async()=>({ok:false,json:async()=>({ok:false})})});
  await tick();await tick();assert.equal(h.calls.length,1);
});
