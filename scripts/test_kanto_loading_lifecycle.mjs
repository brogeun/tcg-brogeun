import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Run the real UI methods, including their delayed callbacks. An old callback
// is also invoked after cancellation to exercise the generation guard directly.
const source=readFileSync(new URL('../games/kanto151/src/ui.mjs',import.meta.url),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
function fixture(){
 const nodes=new Map(),timers=[];
 function node(){const classes=new Set();return {style:{},textContent:'',children:[],disabled:false,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},append(...items){this.children.push(...items);},remove(){this.removed=true;}};}
 const get=selector=>{if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);};
 const document={querySelector:get,createElement:node};
 const schedule=(callback,delay)=>{const timer={callback,delay,active:true};timers.push(timer);return timer;},cancel=timer=>{if(timer)timer.active=false;};
 const UI=new Function('document','setTimeout','clearTimeout','t','tx',source+'\nreturn UI;')(document,schedule,cancel,key=>key,key=>key);
 const ui=Object.assign(Object.create(UI.prototype),{game:{save:{starter:1},phase:'loading'},startScreen:{ready(){},suspend(){},translate(){}}});
 return {ui,get,timers};
}

test('immediate continue loading survives both old intro and title-completion callbacks',()=>{
 const f=fixture();f.ui.progress(1,'intro ready');f.ui.ready();const old=[...f.timers];f.ui.loading('map preparing');
 assert.equal(f.get('#loading').classList.contains('hidden'),false);assert(old.every(timer=>!timer.active));
 for(const timer of old)timer.callback();
 assert.equal(f.get('#loading').classList.contains('hidden'),false);assert.equal(f.get('#load-message').textContent,'map preparing');assert.equal(f.ui.loadingHideTimer,null);
});

test('only the most recent loading completion can hide its own overlay',()=>{
 const f=fixture();f.ui.loading('first region');f.ui.progress(1,'first complete');const first=f.timers[0];
 f.ui.loading('next region');f.ui.progress(.5,'next halfway');first.callback();assert.equal(f.get('#loading').classList.contains('hidden'),false);
 f.ui.progress(1,'next complete');const last=f.timers.at(-1);assert.equal(last.delay,250);last.callback();assert.equal(f.get('#loading').classList.contains('hidden'),true);assert.equal(f.ui.loadingHideTimer,null);
});

test('a loading error cancels completion hiding and retains retry and backup actions',()=>{
 const f=fixture();f.ui.progress(1,'complete');const old=f.timers[0];f.ui.loadError(Error('map unavailable'),async()=>{});
 assert.equal(old.active,false);old.callback();assert.equal(f.get('#loading').classList.contains('hidden'),false);assert.equal(f.get('#load-message').textContent,'loading.stopped');assert.equal(f.get('#loading .start-device').children.length,1);assert.equal(f.get('#loading .start-device').children[0].children.length,3);assert.equal(f.ui.loadingHideTimer,null);
});

test('a recovered retry can start a fresh progress cycle and finish normally',()=>{
 const f=fixture();f.ui.progress(1,'old complete');const old=f.timers[0];f.ui.loadError(Error('offline'));f.ui.loading('retry preparing');f.ui.progress(1,'retry complete');old.callback();assert.equal(f.get('#loading').classList.contains('hidden'),false);f.timers.at(-1).callback();assert.equal(f.get('#loading').classList.contains('hidden'),true);
});
