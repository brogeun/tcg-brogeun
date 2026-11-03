import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {startRuntime,preloadScenery,readStartupData} from '../games/kanto151/src/startup.mjs';

const pending=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
test('startup data retains every required dataset and its input ordering',async()=>{
 const names=['species','moves','biomes','type-chart','pokemon-manifest','game-design','locale-entities','locale-messages','locale-literals','species-localized','regions-localized','region-compositions','moves-localized'];
 const calls=[],signals=[];
 const rows=await readStartupData('https://tcghub.kr/games/kanto151/src/main.mjs',names,{fetcher:async(url,{signal})=>{
  calls.push(url.pathname);signals.push(signal);return {ok:true,json:async()=>({name:url.pathname.split('/').pop().replace('.json','')})};
 }});
 assert.deepEqual(rows.map(row=>row.name),names);
 assert.equal(calls.length,13);assert(signals.every(signal=>signal===signals[0]));
});
test('a stalled startup fetch times out and aborts sibling requests',async()=>{
 let signal;
 await assert.rejects(readStartupData('https://example.test/src/main.mjs',['species','moves'],{
  timeoutMs:15,fetcher:async(_,{signal:current})=>{signal=current;return new Promise(()=>{});}
 }),/응답 시간이 초과/);
 assert.equal(signal.aborted,true);
});
test('a stalled JSON response body has the same finite deadline',async()=>{
 await assert.rejects(readStartupData('https://example.test/src/main.mjs',['species'],{
  timeoutMs:15,fetcher:async()=>({ok:true,json:()=>new Promise(()=>{})})
 }),/응답 시간이 초과/);
});
test('missing startup files fail explicitly without returning a partial dataset',async()=>{
 await assert.rejects(readStartupData('https://example.test/src/main.mjs',['species'],{
  fetcher:async()=>({ok:false,status:404})
 }),/species: HTTP 404/);
});
const bootSource=await readFile(new URL('../games/kanto151/boot.js',import.meta.url),'utf8');
function bootFixture(){
 const events={},timers=[],nodes=new Map();let reloads=0;
 const parent={append(node){nodes.set(node.id,node);}};
 const message={textContent:'준비 중',parentElement:parent};nodes.set('load-message',message);
 const context=vm.createContext({window:{addEventListener(name,handler){events[name]=handler;}},
  document:{getElementById:id=>nodes.get(id),createElement:tag=>({tagName:tag.toUpperCase(),children:[],append(...children){this.children.push(...children);},remove(){nodes.delete(this.id);}})},
  location:{reload(){reloads++;}},setTimeout(handler){const timer={handler,active:true};timers.push(timer);return timer;},clearTimeout(timer){if(timer)timer.active=false;}
 });
 vm.runInContext(bootSource,context);
 return {events,timers,nodes,context,reloads:()=>reloads};
}
test('a stalled module graph offers reload and home without touching a save',()=>{
 const fixture=bootFixture();fixture.timers[0].handler();
 const actions=fixture.nodes.get('startup-recovery');assert(actions);
 assert.equal(actions.children[1].href,'/');actions.children[0].onclick();assert.equal(fixture.reloads(),1);
});
test('a late successful startup clears fallback and never shows timeout after ready',()=>{
 const fixture=bootFixture();fixture.timers[0].handler();assert(fixture.nodes.has('startup-recovery'));
 fixture.context.window.__kantoStartupState='ready';fixture.events['kanto151-ready']();
 assert.equal(fixture.timers[0].active,false);assert.equal(fixture.nodes.has('startup-recovery'),false);
 fixture.timers[0].handler();assert.equal(fixture.nodes.has('startup-recovery'),false);
});
test('module load failure exposes an immediate retry instead of an endless loading screen',()=>{
 const fixture=bootFixture();fixture.events.error({target:{tagName:'SCRIPT',type:'module'}});
 assert(fixture.nodes.has('startup-recovery'));
});
test('HTML preloads JSON without speculatively linking import-map modules',async()=>{
 const html=await readFile(new URL('../games/kanto151/index.html',import.meta.url),'utf8');
 assert.doesNotMatch(html,/<link\b[^>]*rel=["']modulepreload["']/i);
 assert.equal((html.match(/<link\b[^>]*as="fetch"/g)||[]).length,13);
 assert.ok(html.indexOf('type="importmap"')<html.indexOf('type="module"'));
});
const source=await readFile(new URL('../games/kanto151/src/game.mjs',import.meta.url),'utf8');
// Evaluate the real class without browser-only imports. Only the methods under
// test run; their dependencies are supplied by the fixture.
const Game=new Function('requestAnimationFrame','t',source.replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'')+'\nreturn Game;')(()=>{},key=>key);

test('title becomes ready even while account lookup never resolves',async()=>{
 const lookup=pending(),events=[];
 await startRuntime({async intro(){events.push('intro');}},{ready(){events.push('ready');}},{init(){events.push('account');return lookup.promise;}});
 assert.deepEqual(events,['account','intro','ready']);
 lookup.resolve();
});

test('intro requests no region or starter assets and preserves the save',async()=>{
 const save={starter:8,position:[12,9],region:'highlands'},before=JSON.stringify(save);
 const game={save,world:{orbit:{},build(){assert.fail('title must not build a map');}},resources:{create(){assert.fail('title must not load a model');}},emit(){},tick(){},loadShowcase(){assert.fail('title must not load the starter lineup');}};
 await Game.prototype.intro.call(game);
 assert.equal(JSON.stringify(save),before);
});

test('scenery downloads overlap, deduplicate paths and stay within six requests',async()=>{
 const waiters=[],calls=[];let active=0,peak=0;
 const world={async template(path){calls.push(path);peak=Math.max(peak,++active);const gate=pending();waiters.push(gate);await gate.promise;active--;}};
 const task=preloadScenery(world,Array.from({length:14},(_,i)=>({path:'asset-'+(i%13)})));
 assert.equal(calls.length,6);
 waiters.splice(0).forEach(gate=>gate.resolve());
 await new Promise(setImmediate);
 assert.equal(calls.length,12);
 waiters.splice(0).forEach(gate=>gate.resolve());
 await new Promise(setImmediate);
 assert.equal(calls.length,13);
 waiters.splice(0).forEach(gate=>gate.resolve());
 await task;assert.equal(peak,6);assert.equal(new Set(calls).size,13);
});

test('a starter model finishing after entering a field is released, never inserted',async()=>{
 const loading=pending();let released=0,inserted=0;
 const game={regionEpoch:0,phase:'starter',showcase:[],byId:new Map([[1,{name:'Bulbasaur'}]]),clearActors(){},resources:{create:()=>loading.promise},world:{actors:{add(){inserted++;}},height(){return 0;}},emit(){}};
 const task=Game.prototype.loadShowcase.call(game);
 game.regionEpoch++;game.phase='loading';
 loading.resolve({userData:{release(){released++;}}});
 await task;assert.equal(released,1);assert.equal(inserted,0);assert.equal(game.showcase.length,0);
});

const accountSource=await readFile(new URL('../games/kanto151/src/account-save-ui.mjs',import.meta.url),'utf8');
const AccountSaveUI=new Function('readAccountGameBundle',accountSource.replace(/^import .*;\r?$/gm,'').replace(/^export /gm,'')+'\nreturn AccountSaveUI;')(()=>null);
for(const phase of ['starter','loading','playing'])test('late cloud lookup cannot replace a '+phase+' session',async()=>{
 const lookup=pending();let restores=0;
 const account={game:{save:{},phase:'title'},ui:{startScreen:{busy:false}},controller:{init:()=>lookup.promise},changed(){},async restoreCloud(){restores++;}};
 const task=AccountSaveUI.prototype.init.call(account);
 account.game.phase=phase;lookup.resolve({status:'cloud-available'});
 await task;assert.equal(restores,0);
});

test('cloud-only progress still restores automatically on the untouched title',async()=>{
 let restores=0;
 const account={game:{save:{},phase:'title'},ui:{startScreen:{busy:false}},controller:{async init(){return {status:'cloud-available'};}},changed(){},async restoreCloud(){restores++;}};
 await AccountSaveUI.prototype.init.call(account);assert.equal(restores,1);
});

test('a replacement local save blocks automatic late cloud restore',async()=>{
 const lookup=pending();let restores=0;
 const account={game:{save:{},phase:'title'},ui:{startScreen:{busy:false}},controller:{init:()=>lookup.promise},changed(){},async restoreCloud(){restores++;}};
 const task=AccountSaveUI.prototype.init.call(account);account.game.save={starter:25};lookup.resolve({status:'cloud-available'});
 await task;assert.equal(restores,0);
});
