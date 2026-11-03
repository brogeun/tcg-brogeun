'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../assets/market-price-index.js'),'utf8');

function fixture({page='home',hidden=false,offscreen=false,idle=true,observers=true,failure=false}={}){
  const listeners=new Map(),frames=new Map(),timers=new Map(),idles=new Map(),requests=[];
  const changes=[],intersections=[];let sequence=0;
  const on=(type,fn)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);};
  const off=(type,fn)=>listeners.get(type)?.delete(fn);
  const emit=type=>{for(const fn of [...(listeners.get(type)||[])])fn({type});};
  const root={innerHTML:'',classList:{add(){},remove(){}},contains:()=>false,querySelector:()=>null,
    addEventListener(){},getBoundingClientRect:()=>({top:offscreen?3000:120,bottom:offscreen?3200:400})};
  const document={hidden,readyState:'loading',body:{dataset:{page}},documentElement:{clientHeight:800},
    addEventListener:on,removeEventListener:off,getElementById:id=>id==='marketFlowRoot'?root:null};
  const context={document,URL,location:{href:'https://tcghub.kr/#'+page},innerHeight:800,
    addEventListener:on,removeEventListener:off,
    requestAnimationFrame:fn=>{const id=++sequence;frames.set(id,fn);return id;},
    cancelAnimationFrame:id=>frames.delete(id),
    setTimeout:fn=>{const id=++sequence;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    AbortController,TextDecoder,
    fetch:resource=>{requests.push(resource);return failure?Promise.reject(new Error('Fixture unavailable')):new Promise(()=>{});}};
  if(idle){context.requestIdleCallback=fn=>{const id=++sequence;idles.set(id,fn);return id;};context.cancelIdleCallback=id=>idles.delete(id);}
  if(observers){
    context.MutationObserver=class{constructor(fn){this.fn=fn;this.stopped=false;changes.push(this);}observe(){}disconnect(){this.stopped=true;}};
    context.IntersectionObserver=class{constructor(fn){this.fn=fn;this.stopped=false;intersections.push(this);}observe(){}disconnect(){this.stopped=true;}};
  }
  context.window=context;vm.createContext(context);vm.runInContext(source,context);
  emit('DOMContentLoaded');
  const drain=map=>{const entries=[...map.values()];map.clear();for(const fn of entries)fn();};
  function enter(next){document.body.dataset.page=next;for(const observer of changes)if(!observer.stopped)observer.fn([]);emit('hashchange');}
  function visible(value){document.hidden=!value;emit('visibilitychange');}
  function proximity(value){offscreen=!value;for(const observer of intersections)if(!observer.stopped)observer.fn([{target:root,isIntersecting:value}]);emit('scroll');}
  function start(){drain(frames);drain(frames);if(idle)drain(idles);else drain(timers);}
  return {context,document,requests,frames,idles,timers,changes,intersections,emit,enter,visible,proximity,start,frame:()=>drain(frames)};
}

test('cold startup keeps all history and proof downloads off nonhome routes',()=>{
  for(const page of ['cardinfo','price','portfolio']){
    const f=fixture({page});f.start();assert.equal(f.requests.length,0,page);
    f.enter('home');f.start();assert.equal(f.requests.length,3,'Returning home starts the original history and both proofs');
  }
});

test('home gets two paint opportunities and idle time before the chart downloads',()=>{
  const f=fixture();assert.equal(f.requests.length,0);
  f.frame();assert.equal(f.requests.length,0,'First frame must not start large chart data');
  f.frame();assert.equal(f.requests.length,0,'Second frame schedules idle work only');
  f.start();assert.equal(f.requests.length,3);
  assert.deepEqual(f.requests,['/data/market-price-index.json','/data/market-price-index-validation.json','/data/market-price-index-independent-verification.json']);
  assert(f.changes.every(observer=>observer.stopped));assert(f.intersections.every(observer=>observer.stopped));
});

test('offscreen and hidden charts wait until visible home is near the viewport',()=>{
  const f=fixture({offscreen:true});f.start();assert.equal(f.requests.length,0);
  f.proximity(true);f.visible(false);f.start();assert.equal(f.requests.length,0);
  f.visible(true);f.start();assert.equal(f.requests.length,3);
});

test('navigation away and pagehide cancel queued chart startup and pageshow can resume it',()=>{
  const f=fixture();f.frame();f.enter('cardinfo');f.start();assert.equal(f.requests.length,0);
  f.enter('home');f.frame();f.emit('pagehide');f.start();assert.equal(f.requests.length,0);
  assert.equal(f.frames.size,0);assert.equal(f.idles.size,0);assert.equal(f.timers.size,0);
  assert(f.changes.every(observer=>observer.stopped));assert(f.intersections.every(observer=>observer.stopped));
  f.emit('pageshow');f.start();assert.equal(f.requests.length,3);
});

test('browsers without idle or intersection observers retain deferred chart startup',()=>{
  const f=fixture({idle:false,observers:false});assert.equal(f.requests.length,0);
  f.frame();assert.equal(f.requests.length,0);f.frame();assert.equal(f.requests.length,0);
  f.start();assert.equal(f.requests.length,3);
});

test('public ready promise stays pending until the existing verified loader succeeds',async()=>{
  const f=fixture({page:'price'});let resolved=false;
  f.context.TCGMarketPriceIndex.ready.then(()=>{resolved=true;});
  await Promise.resolve();assert.equal(resolved,false);
  f.enter('home');f.start();await Promise.resolve();assert.equal(resolved,false,'Network requests alone must never resolve verified ready');
});

test('a started chart still settles its ready promise through the original failure path',async()=>{
  const f=fixture({page:'price',failure:true});let resolved=false;
  f.context.TCGMarketPriceIndex.ready.then(()=>{resolved=true;});await Promise.resolve();assert.equal(resolved,false);
  f.enter('home');f.start();const result=await f.context.TCGMarketPriceIndex.ready;
  assert.equal(result.ok,false);assert.equal(result.phase,'unavailable');assert.equal(f.requests.length,3);
});
