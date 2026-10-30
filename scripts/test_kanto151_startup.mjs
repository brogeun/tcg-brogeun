import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startRuntime,preloadScenery} from '../games/kanto151/src/startup.mjs';

const pending=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
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
