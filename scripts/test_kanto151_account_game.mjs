import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {newSave,makePokemon,maxHP,SAVE_KEY,LEGACY_SAVE_KEY} from '../games/kanto151/src/core.mjs';
import {migrateFiveSave} from '../games/kanto151/src/save-migration.mjs';
import {makeInitialCheckpoint,checkpointKey} from '../games/kanto151/src/checkpoints.mjs';
import {validateAccountGameBundle,readAccountGameBundle,applyAccountGameBundle,archiveAccountGameOriginal} from '../games/kanto151/src/account-save-game.mjs';

const read=name=>JSON.parse(readFileSync(new URL('../games/kanto151/data/'+name+'.json',import.meta.url)));
const compositions=read('region-compositions'),byId=new Map(read('species').map(s=>[s.id,s])),biomeById=new Map(read('biomes').map(b=>[b.id,b]));
function memory(){const map=new Map();return {get length(){return map.size;},key:i=>[...map.keys()][i]??null,getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key)};}
function fixture(){
 const original=newSave();original.starter=25;original.playTime=4800;original.coins=721;
 for(const [i,id] of [25,6,150].entries()){const p=makePokemon(byId.get(id),87+i,id===150);p.uid='original-'+id;p.exp=352+i;p.moveIds=[33];p.knownMoveIds=[33,98];p.pendingMoveIds=[98];p.cooldowns={'33':1.5};original.collection.push(p);original.party.push(p.uid);original.dex[id]={seen:true,caught:true,shinySeen:p.shiny,shinyCaught:p.shiny};}
 original.bosses=[144,145,146,150];original.inventory['rare-candy']=11;
 const save=migrateFiveSave(original,compositions),g={save,compositions,byId,biomeById,storage:memory(),phase:'title'};
 g.checkpoint=makeInitialCheckpoint(g);const {save:s,...record}=g.checkpoint;
 g.storage.setItem(SAVE_KEY,JSON.stringify(save));g.storage.setItem(checkpointKey(save),JSON.stringify(record));return g;
}
test('account restore retains every original Pokémon field, party order, inventory, research and checkpoint',()=>{
 const pc=fixture(),bundle=readAccountGameBundle(pc),phone=fixture();phone.save=newSave();phone.storage=memory();delete phone.checkpoint;
 const before=structuredClone(pc.save),cp=JSON.parse(bundle.checkpoint);
 const restored=applyAccountGameBundle(phone,bundle);
 assert.deepEqual(phone.save,before);assert.deepEqual(JSON.parse(restored.save),before);
 assert.deepEqual(JSON.parse(restored.checkpoint),cp);assert.deepEqual(JSON.parse(phone.storage.getItem(SAVE_KEY)),before);
 assert.equal(pc.storage.getItem(SAVE_KEY),bundle.save);
});
test('original current, backup, legacy and recovery bytes are archived before a cloud replacement',()=>{
 const game=fixture(),other=fixture();other.save.collection[0].uid='cloud-partner';other.save.party[0]='cloud-partner';other.checkpoint=makeInitialCheckpoint(other);
 const {save:s,...record}=other.checkpoint;other.storage.setItem(checkpointKey(other.save),JSON.stringify(record));
 game.storage.setItem(LEGACY_SAVE_KEY,'untouched-old-format');game.storage.setItem(LEGACY_SAVE_KEY+':backup','untouched-legacy-backup');game.storage.setItem(SAVE_KEY+':backup','previous-primary-backup');
 const old=game.storage.getItem(SAVE_KEY),oldCheckpoint=game.storage.getItem(checkpointKey(game.save));
 applyAccountGameBundle(game,readAccountGameBundle(other));
 const key=Array.from({length:game.storage.length},(_,i)=>game.storage.key(i)).find(k=>k.startsWith('tcghub:kanto151:account-original:'));
 const archived=JSON.parse(game.storage.getItem(key));assert.equal(archived.keys[SAVE_KEY],old);assert.equal(archived.keys[checkpointKey(JSON.parse(old))],oldCheckpoint);
 assert.equal(archived.keys[LEGACY_SAVE_KEY],'untouched-old-format');assert.equal(game.storage.getItem(LEGACY_SAVE_KEY),'untouched-old-format');
 assert.equal(game.storage.getItem(LEGACY_SAVE_KEY+':backup'),'untouched-legacy-backup');assert.equal(game.storage.getItem(SAVE_KEY+':backup'),'previous-primary-backup');
});
test('an empty or corrupt account record cannot write storage or replace the live save',()=>{
 const game=fixture(),before=game.save,raw=game.storage.getItem(SAVE_KEY),count=game.storage.length;
 for(const bundle of [{schema:1,save:JSON.stringify(newSave()),checkpoint:null},{...readAccountGameBundle(game),checkpoint:'{}'},{schema:2,save:'{}',checkpoint:null}])assert.throws(()=>applyAccountGameBundle(game,bundle));
 assert.equal(game.save,before);assert.equal(game.storage.getItem(SAVE_KEY),raw);assert.equal(game.storage.length,count);
});
test('cloud application is refused during a live expedition without changing any saved key',()=>{
 const game=fixture(),bundle=readAccountGameBundle(game),count=game.storage.length;game.phase='playing';
 assert.throws(()=>applyAccountGameBundle(game,bundle),/첫 화면/);assert.equal(game.storage.length,count);
});
test('a backup quota failure leaves the original save and checkpoint untouched',()=>{
 const game=fixture(),bundle=readAccountGameBundle(game),before=game.save,raw=game.storage.getItem(SAVE_KEY),cp=game.storage.getItem(checkpointKey(game.save)),set=game.storage.setItem;
 game.storage.setItem=(k,v)=>{if(k.startsWith('tcghub:kanto151:account-original:'))throw Error('quota');set(k,v);};
 assert.throws(()=>applyAccountGameBundle(game,bundle),/quota/);assert.equal(game.save,before);assert.equal(game.storage.getItem(SAVE_KEY),raw);assert.equal(game.storage.getItem(checkpointKey(game.save)),cp);
});
test('a failed final primary write rolls back the recovery key and memory',()=>{
 const game=fixture(),other=fixture(),before=game.save,raw=game.storage.getItem(SAVE_KEY),cp=game.storage.getItem(checkpointKey(game.save)),set=game.storage.setItem;
 other.save.coins+=10;other.checkpoint=makeInitialCheckpoint(other);const {save:s,...record}=other.checkpoint;other.storage.setItem(checkpointKey(other.save),JSON.stringify(record));
 let fail=true;game.storage.setItem=(k,v)=>{if(k===SAVE_KEY&&fail){fail=false;throw Error('primary-full');}set(k,v);};
 assert.throws(()=>applyAccountGameBundle(game,readAccountGameBundle(other)),/primary-full/);assert.equal(game.save,before);assert.equal(game.storage.getItem(SAVE_KEY),raw);assert.equal(game.storage.getItem(checkpointKey(game.save)),cp);assert.equal(game.accountSaveApplying,false);
});
test('missing recovery is prepared from a copy without healing or altering the main account Pokémon',()=>{
 const pc=fixture(),bundle=readAccountGameBundle(pc);bundle.checkpoint=null;const incoming=JSON.parse(bundle.save);incoming.collection[0].hp=1;bundle.save=JSON.stringify(incoming);
 const phone=fixture();applyAccountGameBundle(phone,bundle);assert.equal(phone.save.collection[0].hp,1);assert.ok(phone.checkpoint.save.collection[0].hp>=maxHP(byId.get(25),87)*.5);assert.equal(phone.save.inventory['rare-candy'],11);
});
test('legacy account save migrates on a copy while keeping all existing local legacy bytes',()=>{
 const game=fixture(),old=newSave();old.version=2;old.starter=25;old.collection=[makePokemon(byId.get(25),92,true)];old.collection[0].uid='legacy-pikachu';old.party=[old.collection[0].uid];old.dex={25:{seen:true,caught:true,shinyCaught:true}};old.region='camp';
 const raw=JSON.stringify(old);game.storage.setItem(LEGACY_SAVE_KEY,raw);applyAccountGameBundle(game,{schema:1,save:raw,checkpoint:null});
 assert.equal(game.save.version,3);assert.equal(game.save.collection[0].uid,'legacy-pikachu');assert.equal(game.save.collection[0].level,92);assert.equal(game.save.collection[0].shiny,true);assert.equal(game.storage.getItem(LEGACY_SAVE_KEY),raw);assert.equal(JSON.stringify(old),raw);
});
test('original backup never reads unrelated login keys',()=>{
 const game=fixture(),get=game.storage.getItem;game.storage.setItem('hub-token','do-not-inspect');
 game.storage.getItem=k=>{assert.notEqual(k,'hub-token');return get(k);};assert.ok(archiveAccountGameOriginal(game));
});
