import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Run the unchanged controller and its real engine against local DOM/RAF fakes.
// No browser session, network service, production data, or source-code rewriting.
let now=1000,nextFrame=0;
const frames=new Map(),requests=[];
Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>now}});
globalThis.requestAnimationFrame=callback=>{const id=++nextFrame;frames.set(id,callback);return id;};
globalThis.cancelAnimationFrame=id=>frames.delete(id);
function frame(milliseconds=0){
 now+=milliseconds;const callbacks=[...frames.values()];frames.clear();
 for(const callback of callbacks)callback(now);
}
function advance(count,milliseconds){for(let i=0;i<count;i++)frame(milliseconds);}

function classes(){
 const values=new Set();
 return{contains:value=>values.has(value),toggle(value,force){const add=force===undefined?!values.has(value):force;if(add)values.add(value);else values.delete(value);return add;}};
}
function target(){
 const listeners=new Map();
 return{addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(listener);},dispatch(type,detail={}){
  const event={preventDefault(){this.defaultPrevented=true;},...detail};
  for(const listener of listeners.get(type)||[])listener(event);
  return event;
 }};
}
function context(){
 const value={images:[],clearRect(){this.images=[];},drawImage(image,...args){this.images.push({image,args});}};
 return new Proxy(value,{get(object,key){return key in object?object[key]:()=>{};}});
}
function element(attributes=''){
 const drawing=context(),attrs=new Map();
 return{...target(),style:{},classList:classes(),parentElement:{classList:classes()},children:[],textContent:'',value:'',
  hidden:/(?:^|\s)hidden(?:\s|$)/.test(attributes),disabled:/(?:^|\s)disabled(?:\s|$)/.test(attributes),open:false,
  width:960,height:1100,clientWidth:480,drawing,
  append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},
  setAttribute(name,value){attrs.set(name,String(value));},getAttribute:name=>attrs.get(name),
  getContext:()=>drawing,getBoundingClientRect:()=>({left:0,top:0,width:480,height:550}),
  focus(){},setPointerCapture(){},showModal(){this.open=true;},close(){this.open=false;},
  click(){if(!this.disabled)this.dispatch('click',{detail:1});}
 };
}
const html=readFileSync(new URL('../games/jigglypuff/index.html',import.meta.url),'utf8');
const elements=new Map([...html.matchAll(/<[a-z][a-z0-9]*\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(([,attributes,id])=>[id,element(attributes)]));
const get=id=>{assert(elements.has(id),`controller uses a real page element: ${id}`);return elements.get(id);};
const rankPanel=element();
globalThis.document={...target(),body:element(),hidden:false,title:'',getElementById:get,createElement:()=>element(),querySelector:selector=>selector==='.rank-panel'?rankPanel:null};
globalThis.window={...target(),visualViewport:target()};
globalThis.matchMedia=()=>({matches:false});
globalThis.devicePixelRatio=2;
globalThis.ResizeObserver=class{observe(){}};
globalThis.Image=class{set src(value){this.source=value;queueMicrotask(()=>this.onload?.());}};
function storage(){const data=new Map();return{data,getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,String(value)),removeItem:key=>data.delete(key)};}
globalThis.localStorage=storage();globalThis.sessionStorage=storage();
globalThis.fetch=async(url,options)=>{
 requests.push({url,method:options.method||'GET'});
 assert.equal(options.method,undefined,'practice and examples never submit a ranking');
 return{ok:true,json:async()=>({ok:true,loggedIn:false,rows:[],mine:null})};
};
await import('../games/jigglypuff/game.js');
await new Promise(resolve=>setImmediate(resolve));
frame();

const board=get('board');
const pointer=(type,x,id=1)=>board.dispatch(type,{pointerType:'touch',pointerId:id,button:0,clientX:x,clientY:100});
const visibleFaces=()=>board.drawing.images.length;
const elapsed=()=>{
 const match=/^(\d+):(\d{2})(?:\.(\d{3}))?$/.exec(get('timer').textContent);
 assert(match,'timer has a usable time value');return Number(match[1])*60000+Number(match[2])*1000+Number(match[3]||0);
};
const near=(actual,expected,message)=>assert(Math.abs(actual-expected)<=9,`${message}: expected ${expected} ms ± one physics tick, got ${actual}`);

assert.equal(get('drop').disabled,false,'sprites loaded and controller is ready');
assert.equal(visibleFaces(),2,'empty board renders the current piece and landing preview');
assert.equal(frames.size,0,'the unstarted game does not consume continuous frames');

// Pointer-down and cancellation do not commit a piece or begin its clock.
pointer('pointerdown',80);frame(100);
assert.equal(visibleFaces(),2);assert.equal(elapsed(),0);
pointer('pointermove',160);pointer('pointercancel',160);pointer('pointerup',160);frame(100);
assert.equal(visibleFaces(),2);assert.equal(elapsed(),0);
pointer('pointerdown',80);pointer('pointerup',80);frame();
assert.equal(visibleFaces(),3,'pointer-up commits exactly one piece');

// Slow but responsive frames retain their full active duration, independent of
// the shorter animation-effect delta. Allow one 120 Hz quantization interval.
advance(2,100);frame(150);near(elapsed(),350,'100/100/150 ms frames retain active time');
assert.equal(visibleFaces(),3);

// A late cooldown input reserves one release and is replayed only when ready.
pointer('pointerdown',400,2);pointer('pointerup',400,2);
assert.equal(get('drop').textContent,'낙하 예약');assert.equal(visibleFaces(),3);
frame(100);assert.equal(visibleFaces(),3,'cooldown still prevents an early second piece');
frame(100);assert.equal(visibleFaces(),4,'the queued release produces one second piece');
near(elapsed(),550,'queued drops do not alter the clock');

// Pausing cancels a reserved release and freezes both the clock and simulation.
frame(150);frame(150);
pointer('pointerdown',240,3);pointer('pointerup',240,3);assert.equal(get('drop').textContent,'낙하 예약');
get('pause').click();const pausedAt=elapsed();
assert.equal(get('pause').textContent,'계속하기');assert.equal(get('drop').disabled,true);
advance(3,1000);assert.equal(elapsed(),pausedAt);assert.equal(frames.size,0);
get('pause').click();frame();frame(200);
near(elapsed(),pausedAt+200,'resume continues from the paused duration');
assert.equal(visibleFaces(),4,'resuming cannot resurrect the cancelled queued release');

// Cancelling navigation resumes a previously running game, while preserving an
// intentional pause if that was the state before the confirmation dialog.
get('restart').click();assert.equal(get('leave-dialog').open,true);
const dialogAt=elapsed();frame(1000);assert.equal(elapsed(),dialogAt);
get('leave-cancel').click();assert.equal(get('leave-dialog').open,false);
assert.equal(get('pause').textContent,'일시정지');frame();frame(100);
near(elapsed(),dialogAt+100,'cancel resumes the running match');
get('pause').click();get('restart').click();get('leave-dialog').dispatch('cancel');
assert.equal(get('leave-dialog').open,false);assert.equal(get('pause').textContent,'계속하기');
const intentionallyPausedAt=elapsed();frame(500);assert.equal(elapsed(),intentionallyPausedAt);
get('pause').click();frame();

// An extended foreground stall explicitly pauses instead of silently losing
// elapsed active time or attempting an unbounded physics catch-up.
const beforeStall=elapsed();frame(300);
assert.equal(get('pause').textContent,'계속하기');assert.equal(elapsed(),beforeStall);
assert.match(get('status').textContent,/자동으로 일시정지/);
get('pause').click();frame();frame(100);near(elapsed(),beforeStall+100,'stall recovery');

// The actual speed example reaches Jigglypuff, ends, and excludes local/ranked
// records. Its physics is the real imported engine, without state injection.
get('demo').click();assert.equal(get('leave-dialog').open,true);get('leave-confirm').click();
frame();advance(180,1000/60);
assert.equal(get('result-panel').hidden,false);assert.equal(get('result-title').textContent,'합성 미리보기');
assert.equal(get('score').textContent,'640');assert.equal(get('danger-text').textContent,'푸린 완성!');
assert.equal(get('drop').disabled,true);assert.match(get('result-detail').textContent,/저장되지/);
const wonAt=elapsed();advance(20,100);assert.equal(elapsed(),wonAt);
assert.equal(localStorage.data.size,0);assert.equal(sessionStorage.data.size,0);

// Endless clears the Jigglypuff pair for 1,280 points and permits further drops
// and more than four minutes of active play without a time-limit result.
get('mode-endless').click();get('demo').click();frame();advance(180,1000/60);
assert.equal(get('score').textContent,'1280');assert.equal(get('result-panel').hidden,true);
assert.equal(get('drop').disabled,false);assert.equal(visibleFaces(),2,'the two final pieces clear the bowl');
get('drop').click();frame(20);assert.equal(visibleFaces(),3,'play continues after the clear');
advance(1200,200);
assert(elapsed()>=240000);assert.equal(get('result-panel').hidden,true);assert.equal(get('drop').disabled,false);
assert.equal(localStorage.data.size,0);assert.equal(sessionStorage.data.size,0);
assert(requests.every(request=>request.method==='GET'));

window.dispatch('blur');const backgroundAt=elapsed();frame(1000);assert.equal(elapsed(),backgroundAt);
assert.equal(get('pause').textContent,'계속하기');
console.log('PASS: release/cancel touch input, queued cooldown, full slow-frame duration, pause/resume, confirmation cancellation, stall recovery, real speed/endless examples, record exclusion and unlimited endless time.');
