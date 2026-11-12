import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../games/kanto151/boot.js',import.meta.url),'utf8');
const keys=['tcghub:kanto151:v3','tcghub:kanto151:v3:backup','tcghub:kanto151:v2','tcghub:kanto151:v2:backup'];
const saved=(extra={})=>JSON.stringify({version:3,starter:1,collection:[{uid:'one',id:1}],party:['one'],dex:{1:{caught:true},16:{caught:true},19:{seen:true}},region:'highlands',settings:{locale:'ko-KR'},...extra});

// Execute the real classic boot script. The DOM provides only rendering/events;
// game modules, network, frame loops, GPU and persistent writes are forbidden.
function fixture({records=new Map(),qa=false,storageDenied=false}={}){
 const nodes=new Map(),listeners=new Map(),windowListeners=new Map(),timers=[],scripts=[],reads=[],writes=[],calls=[];
 let storageAccess=0,reloads=0,forbidden=0;
 const document={documentElement:{lang:'ko-KR'}};
 class Node{
  constructor(tag='div',id=''){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.dataset={};this.disabled=false;this.textContent='';this.attrs={};this.classes=new Set();this.classList={add:(...names)=>names.forEach(n=>this.classes.add(n)),remove:(...names)=>names.forEach(n=>this.classes.delete(n)),contains:n=>this.classes.has(n),toggle:(n,value)=>{const next=value===undefined?!this.classes.has(n):Boolean(value);next?this.classes.add(n):this.classes.delete(n);return next;}};this.id=id;}
  set id(value){this._id=value;if(value)nodes.set(value,this);}get id(){return this._id;}
  append(...items){for(const n of items){n.parentElement=this;this.children.push(n);if(n.tagName==='SCRIPT')scripts.push(n);}}
  after(node){const p=this.parentElement;if(!p)return;node.parentElement=p;p.children.splice(p.children.indexOf(this)+1,0,node);}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);nodes.delete(this.id);this.parentElement=null;}
  replaceChildren(...items){this.children=[];this.append(...items);}
  setAttribute(key,value){this.attrs[key]=String(value);}getAttribute(key){return this.attrs[key];}
  closest(){for(let n=this;n;n=n.parentElement){if(['new-game','continue','startup-account-open'].includes(n.id))return n;if(n.dataset.panel){for(let p=n.parentElement;p;p=p.parentElement)if(p.id==='title')return n;}}return null;}
  click(){if(!this.disabled)fireClick(this);}
 }
 document.createElement=tag=>new Node(tag);document.createTextNode=text=>{const node=new Node('#text');node.textContent=text;return node;};document.getElementById=id=>nodes.get(id)||null;
 document.body=new Node('body');const add=(id,tag='div',parent=document.body)=>{const node=new Node(tag,id);parent.append(node);return node;};
 const title=add('title','main'),loading=add('loading'),message=add('load-message','p',loading),entry=add('kanto-runtime','script');entry.type='module';entry.dataset.runtimeSrc='./src/runtime-example.mjs';scripts.length=0;
 for(const id of ['start-heading','start-description','start-save','start-lineup','start-region','title-count'])add(id,'div',title);
 const actions=add('title-actions','div',title);add('continue','button',actions);add('new-game','button',actions);add('hub-return','a',title);
 for(const panel of ['settings','credits']){const n=add('title-'+panel,'button',title);n.dataset.panel=panel;}
 const brand=add('brand','strong',title);brand.dataset.startText='start.brand';
 document.querySelectorAll=selector=>{
  if(selector==='[data-start-text]')return [...nodes.values()].filter(n=>n.dataset.startText);
  if(selector==='[data-start-label]')return [...nodes.values()].filter(n=>n.dataset.startLabel);
  if(selector==='#title button')return [...nodes.values()].filter(n=>{if(n.tagName!=='BUTTON')return false;for(let p=n.parentElement;p;p=p.parentElement)if(p===title)return true;return false;});
  throw Error('Unexpected DOM query '+selector);
 };
 document.addEventListener=(name,handler)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(handler);};
 document.removeEventListener=(name,handler)=>listeners.set(name,(listeners.get(name)||[]).filter(f=>f!==handler));
 const location={search:qa?'?qa=1':'',reload(){reloads++;}};
 const window={location,addEventListener(name,handler,options){if(!windowListeners.has(name))windowListeners.set(name,[]);windowListeners.get(name).push({handler,once:options?.once});}};
 function emit(name,event={}){for(const l of [...windowListeners.get(name)||[]]){l.handler(event);if(l.once)windowListeners.set(name,windowListeners.get(name).filter(x=>x!==l));}}
 function fireClick(target){const event={target,stopped:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;}};for(const f of [...listeners.get('click')||[]]){f(event);if(event.stopped)break;}if(!event.stopped)target.onclick?.(event);return event;}
 const storage={getItem(key){reads.push(key);return records.get(key)||null;},setItem(...args){writes.push(args);assert.fail('light title wrote a save');},removeItem(){assert.fail('light title deleted a save');}};
 const forbid=()=>{forbidden++;throw Error('An idle title started an expensive dependency');};
 const scope={window,document,location,URLSearchParams,console,fetch:forbid,requestAnimationFrame:forbid,WebGLRenderingContext:forbid,AudioContext:forbid,setTimeout(handler,delay){const t={handler,delay,active:true};timers.push(t);return t;},clearTimeout(timer){if(timer)timer.active=false;}};
 Object.defineProperty(scope,'localStorage',{get(){storageAccess++;if(storageDenied)throw Error('storage unavailable');return storage;}});
 vm.runInNewContext(source,scope,{filename:'boot.js'});
 const ready=()=>{
  document.querySelectorAll('#title button').forEach(b=>b.disabled=false);
  nodes.get('new-game').onclick=()=>calls.push('new');nodes.get('continue').onclick=()=>calls.push('continue');
  window.kanto151={game:{openPanel:panel=>calls.push(panel),accountSaveUI:{open:()=>calls.push('account')}}};emit('kanto151-ready');
 };
 return {nodes,window,document,timers,scripts,reads,writes,calls,emit,fireClick,ready,records,message,get storageAccess(){return storageAccess;},get reloads(){return reloads;},get forbidden(){return forbidden;}};
}

test('idle title starts no module, data request, account lookup, frame loop, GPU or watchdog',()=>{
 const f=fixture();assert.equal(f.scripts.length,0);assert.equal(f.forbidden,0);assert.equal(f.timers.length,0);assert.equal(f.window.__kantoStartupState,'idle');assert.equal(f.nodes.get('new-game').textContent,'파트너 고르기');assert.equal(f.nodes.get('continue').disabled,true);assert(f.nodes.has('startup-account-open'));
});

test('saved title displays the original locale, region and bounded Pokédex count without writes',()=>{
 const raw=saved({settings:{locale:'en-US'},dex:{1:{caught:true},16:{caught:true},999:{caught:true}}}),records=new Map([[keys[0],raw]]),f=fixture({records});
 assert.equal(f.nodes.get('start-heading').textContent,'Continue your expedition');assert.equal(f.nodes.get('start-region').textContent,'Moonrise Highlands');assert.equal(f.nodes.get('title-count').children[0].textContent,'002 ');assert.equal(f.document.documentElement.lang,'en-US');assert.equal(f.nodes.get('continue').disabled,false);assert.deepEqual(f.reads,[keys[0]]);assert.equal(records.get(keys[0]),raw);assert.deepEqual(f.writes,[]);
});

for(let index=1;index<keys.length;index++)test('read-only fallback reaches '+keys[index]+' and maps its legacy region',()=>{
 const records=new Map(keys.slice(0,index).map(key=>[key,'{broken']));records.set(keys[index],saved({version:2,region:'mountain'}));const f=fixture({records});
 assert.deepEqual(f.reads,keys.slice(0,index+1));assert.equal(f.nodes.get('start-region').textContent,'달오름 산맥');assert.equal(f.nodes.get('continue').disabled,false);assert.deepEqual(f.writes,[]);
});

test('QA does not even access the real localStorage getter or show account access',()=>{
 const f=fixture({qa:true,records:new Map([[keys[0],saved()]]),storageDenied:true});assert.equal(f.storageAccess,0);assert.deepEqual(f.reads,[]);assert.equal(f.nodes.get('continue').disabled,true);assert(!f.nodes.has('startup-account-open'));assert.equal(f.scripts.length,0);
});

test('storage denial still permits a new expedition and account access',()=>{
 const f=fixture({storageDenied:true});assert.equal(f.nodes.get('new-game').disabled,false);assert(f.nodes.has('startup-account-open'));assert.equal(f.scripts.length,0);
});

test('one user intent loads exactly one runtime and replays the original new-game confirmation path',()=>{
 const f=fixture({records:new Map([[keys[0],saved()]])});f.fireClick(f.nodes.get('new-game'));f.fireClick(f.nodes.get('title-settings'));f.fireClick(f.nodes.get('new-game'));
 assert.equal(f.scripts.length,1);assert.equal(f.scripts[0].type,'module');assert.equal(f.scripts[0].src,'./src/runtime-example.mjs');assert.equal(f.timers.length,1);assert.equal(f.timers[0].delay,30000);assert.deepEqual(f.calls,[]);f.ready();assert.deepEqual(f.calls,['new']);assert.equal(f.timers[0].active,false);assert(!f.nodes.has('startup-account-shell'));assert.equal(f.window.__kantoStartupState,'ready');f.emit('kanto151-ready');assert.deepEqual(f.calls,['new']);
});

for(const [id,expected] of [['continue','continue'],['title-settings','settings'],['title-credits','credits'],['startup-account-open','account']])test('ready runtime preserves the '+expected+' intent',()=>{
 const f=fixture({records:new Map([[keys[0],saved()]])});f.fireClick(f.nodes.get(id));assert.equal(f.scripts.length,1);f.ready();assert.deepEqual(f.calls,[expected]);assert.deepEqual(f.writes,[]);
});

test('cloud-only player has an explicit account entry without starting lookup during idle',()=>{
 const f=fixture();assert.equal(f.nodes.get('continue').disabled,true);assert.equal(f.scripts.length,0);f.fireClick(f.nodes.get('startup-account-open'));f.ready();assert.deepEqual(f.calls,['account']);
});

test('runtime timeout offers reload and home, leaves storage intact, and can recover if loading finishes',()=>{
 const raw=saved(),f=fixture({records:new Map([[keys[0],raw]])});f.fireClick(f.nodes.get('continue'));f.timers[0].handler();
 const recovery=f.nodes.get('startup-recovery');assert(recovery);assert.equal(recovery.children[1].href,'/');assert.equal(f.window.__kantoStartupState,'failed');assert.equal(f.records.get(keys[0]),raw);assert.deepEqual(f.writes,[]);recovery.children[0].onclick();assert.equal(f.reloads,1);f.ready();assert(!f.nodes.has('startup-recovery'));assert.deepEqual(f.calls,['continue']);
});

test('module and data failures expose recovery without adding another runtime or overwriting saves',()=>{
 for(const mode of ['module','data']){
  const f=fixture({records:new Map([[keys[0],saved()]])});f.fireClick(f.nodes.get('new-game'));
  if(mode==='module')f.emit('error',{target:f.scripts[0]});else f.emit('kanto151-startup-error',{detail:'data unavailable'});
  assert(f.nodes.has('startup-recovery'));assert.equal(f.scripts.length,1);assert.equal(f.timers[0].active,false);assert.deepEqual(f.writes,[]);assert.equal(f.calls.length,0);
 }
});

test('unrelated extension errors do not interrupt a requested runtime load',()=>{
 const f=fixture();f.fireClick(f.nodes.get('new-game'));f.emit('error',{target:{tagName:'SCRIPT',type:'module'}});assert(!f.nodes.has('startup-recovery'));f.ready();assert.deepEqual(f.calls,['new']);
});

test('startup and HUD reference installed fonts while the existing font asset is retained',()=>{
 const css=readFileSync(new URL('../games/kanto151/style.css',import.meta.url),'utf8');assert.doesNotMatch(css,/@font-face|PretendardVariable\.woff2|font-family:[^;}]*Kanto Startup/);assert.match(css,/\.startup[^\n]*font-family:"Malgun Gothic"/);assert.match(css,/#hud[^\n]*font-family:"Apple SD Gothic Neo"/);assert(source.length<20000);
});
