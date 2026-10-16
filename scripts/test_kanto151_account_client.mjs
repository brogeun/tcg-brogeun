import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountSaveController,createAccountSaveTransport,ACCOUNT_SAVE_META_KEY,ACCOUNT_SAVE_BACKUP_PREFIX,accountSaveFingerprint,validateAccountSaveBundle} from '../games/kanto151/src/account-save.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const bundle=(count=1,{owner='original-partner',checkpointId='original-checkpoint',coins=300,marker=''}={})=>({schema:1,save:JSON.stringify({version:3,starter:1,checkpointId,collection:Array.from({length:count},(_,i)=>({id:i+1,uid:i?`caught-${i}`:owner,level:10+i})),coins,marker}),checkpoint:JSON.stringify({version:1,save:{marker,coins}})});
function memoryStorage(){const values=new Map(),writes=[];return {values,writes,getItem:key=>values.has(key)?values.get(key):null,setItem(key,value){values.set(key,String(value));writes.push(key);},removeItem:key=>values.delete(key)};}
function memoryServer(){
 const records=new Map(),calls=[];let time=0;
 const server={records,calls,offline:false,beforePut:null,beforeUser:null,clients:0,
  client(session){return {
   async getUser(){calls.push(['me',session.id]);if(server.beforeUser)await server.beforeUser();if(server.offline)throw Error('offline');return session.id?{id:session.id,nickname:'테스터'}:null;},
   async getRecord({userId}){calls.push(['get',userId]);if(server.offline)throw Error('offline');if(session.id!==userId)throw Object.assign(Error('account changed'),{code:'account-changed'});return clone(records.get(userId)??null);},
   async putRecord({userId,expectedRevision,bundle:incoming}){calls.push(['put',userId,expectedRevision]);if(server.beforePut)await server.beforePut({userId,expectedRevision,bundle:incoming});if(server.offline)throw Error('offline');if(session.id!==userId)throw Object.assign(Error('account changed'),{code:'account-changed'});const previous=records.get(userId);if((previous?.revision??0)!==expectedRevision)throw Object.assign(Error('conflict'),{code:'conflict',record:clone(previous)});validateAccountSaveBundle(incoming);const record={revision:expectedRevision+1,updatedAt:new Date(++time).toISOString(),bundle:clone(incoming)};records.set(userId,record);return clone(record);},
  };},
 };return server;
}
const make=(server,storage=memoryStorage(),session={id:'kakao-a'},options={})=>new AccountSaveController({transport:server.client(session),storage,debounceMs:60000,...options});
const backups=storage=>[...storage.values].filter(([key])=>key.startsWith(ACCOUNT_SAVE_BACKUP_PREFIX)).map(([,value])=>JSON.parse(value));
const putCount=server=>server.calls.filter(call=>call[0]==='put').length;
async function registered(server,storage=memoryStorage(),session={id:'kakao-a'},initial=bundle()){
 const controller=make(server,storage,session);assert.equal((await controller.init(initial)).status,'link-required');assert.equal((await controller.useLocal()).status,'synced');return controller;
}

test('existing PC progress needs an explicit first account link and preserves all game keys',async()=>{
 const server=memoryServer(),storage=memoryStorage(),original=bundle(151),keys=['kanto151-save-v3','kanto151-save-v2','kanto151-save-v3:backup','kanto151-save-v3:checkpoint:original'];
 keys.forEach((key,i)=>storage.setItem(key,i===0?original.save:`original-${i}`));const before=keys.map(key=>storage.getItem(key));
 const controller=make(server,storage);assert.equal((await controller.init(original)).status,'link-required');assert.equal(putCount(server),0);
 controller.onStored(original);await controller.flush();assert.equal(putCount(server),0);
 assert.equal((await controller.useLocal()).status,'synced');assert.deepEqual(server.records.get('kakao-a').bundle,original);assert.deepEqual(keys.map(key=>storage.getItem(key)),before);
 assert.deepEqual(backups(storage)[0].bundle,original);assert.equal(JSON.parse(storage.getItem(ACCOUNT_SAVE_META_KEY)).ownerUserId,'kakao-a');controller.dispose();
});

test('a separate empty phone restores the same account including every Pokemon UID and checkpoint',async()=>{
 const server=memoryServer(),pcStorage=memoryStorage(),pc=bundle(151),pcController=await registered(server,pcStorage,{id:'kakao-a'},pc),phoneStorage=memoryStorage(),phone=make(server,phoneStorage);
 assert.equal((await phone.init(null)).status,'cloud-available');assert.equal(putCount(server),1);
 let applied;const result=await phone.useCloud({apply:async incoming=>{applied=incoming;phoneStorage.setItem('game-save',incoming.save);phoneStorage.setItem('game-checkpoint',incoming.checkpoint);}});
 assert.equal(result.status,'synced');assert.equal(result.pending,false);assert.deepEqual(applied,pc);assert.equal(JSON.parse(phoneStorage.getItem('game-save')).collection.length,151);assert.equal(phoneStorage.getItem('game-checkpoint'),pc.checkpoint);assert.equal(backups(phoneStorage)[0].bundle,null);assert.equal(putCount(server),1);pcController.dispose();phone.dispose();
});

test('a phone empty record cannot replace the account progress, including after it was linked',async()=>{
 const server=memoryServer(),controller=await registered(server),saved=clone(server.records.get('kakao-a'));
 const empty={schema:1,save:JSON.stringify({starter:null,collection:[]}),checkpoint:null};assert.equal(controller.onStored(empty),false);assert.equal(controller.snapshot.status,'error');await controller.flush();await controller.useLocal();assert.deepEqual(server.records.get('kakao-a'),saved);
 const second=make(server);assert.equal((await second.init(empty)).status,'error');assert.equal(putCount(server),1);controller.dispose();second.dispose();
});

test('cloud restore fetches the latest account record again before applying a cached choice',async()=>{
 const server=memoryServer(),pc=await registered(server),phone=make(server);await phone.init(null);pc.onStored(bundle(9));await pc.flush();let applied;await phone.useCloud({apply:incoming=>{applied=incoming;}});assert.deepEqual(applied,bundle(9));assert.equal(phone.snapshot.revision,2);pc.dispose();phone.dispose();
});

test('normal linked saves upload sequentially with revision checks and expose pending status',async()=>{
 const server=memoryServer(),storage=memoryStorage(),controller=await registered(server,storage),first=bundle(2),last=bundle(3),gate=deferred();let calls=0;
 server.beforePut=async()=>{if(++calls===1)await gate.promise;};
 controller.onStored(first);assert.equal(controller.snapshot.pending,true);assert.equal(controller.snapshot.status,'synced');const saving=controller.flush();await Promise.resolve();await Promise.resolve();controller.onStored(last);gate.resolve();
 assert.equal((await saving).status,'synced');assert.equal(controller.snapshot.pending,false);assert.deepEqual(server.records.get('kakao-a').bundle,last);assert.equal(server.records.get('kakao-a').revision,3);assert.deepEqual(server.calls.filter(call=>call[0]==='put').map(call=>call[2]),[0,1,2]);assert.equal(JSON.parse(storage.getItem(ACCOUNT_SAVE_META_KEY)).accounts['kakao-a'].revision,3);controller.dispose();
});

test('a newer phone record stops a stale PC autosave until an explicit conflict choice',async()=>{
 const server=memoryServer(),storage=memoryStorage(),pc=await registered(server,storage),phone=make(server);
 await phone.init(null);await phone.useCloud({apply:()=>{}});phone.onStored(bundle(2));await phone.flush();const newest=clone(server.records.get('kakao-a'));
 pc.onStored(bundle(1,{coins:777}));assert.equal((await pc.flush()).status,'conflict');assert.equal(pc.snapshot.reason,'remote-changed');assert.equal(pc.snapshot.record.revision,2);assert.equal(JSON.parse(storage.getItem(ACCOUNT_SAVE_META_KEY)).accounts['kakao-a'].revision,1);
 pc.onStored(bundle(1,{coins:888}));await pc.flush();assert.deepEqual(server.records.get('kakao-a'),newest);assert.equal(putCount(server),3);
 await pc.useLocal();assert.equal(server.records.get('kakao-a').revision,3);assert.equal(JSON.parse(server.records.get('kakao-a').bundle.save).coins,888);assert.equal(backups(storage).at(-1).cloudRecord.revision,2);pc.dispose();phone.dispose();
});

test('restarting with two different records requires a choice even for a previously linked account',async()=>{
 const server=memoryServer(),storage=memoryStorage(),first=await registered(server,storage),local=bundle(2);first.onStored(local);first.dispose();
 const again=make(server,storage);assert.equal((await again.init(local)).status,'conflict');assert.equal(again.snapshot.reason,'different-progress');await again.flush();assert.equal(putCount(server),1);assert.deepEqual(again.snapshot.localBundle,local);again.dispose();
});

test('a different account cannot silently adopt the previous account local save',async()=>{
 const server=memoryServer(),storage=memoryStorage(),session={id:'kakao-a'},controller=await registered(server,storage,session),original=clone(server.records.get('kakao-a'));
 session.id='kakao-b';server.records.set('kakao-b',{...clone(original),revision:7});
 assert.equal((await controller.refresh()).status,'conflict');assert.equal(controller.snapshot.reason,'different-account');controller.onStored(bundle(2));await controller.flush();assert.equal(server.records.get('kakao-b').revision,7);assert.deepEqual(server.records.get('kakao-a'),original);controller.dispose();
});

test('an existing guest adventure is opt-in when logging into a new empty account',async()=>{
 const server=memoryServer(),storage=memoryStorage(),session={id:null},controller=make(server,storage,session),guest=bundle(5);
 assert.equal((await controller.init(guest)).status,'local');session.id='new-account';assert.equal((await controller.refresh()).status,'link-required');controller.onStored(bundle(6));await controller.flush();assert.equal(putCount(server),0);controller.dispose();
});

test('an account change just before upload prevents writes to both accounts',async()=>{
 const server=memoryServer(),session={id:'kakao-a'},controller=await registered(server,memoryStorage(),session),original=clone(server.records.get('kakao-a'));
 controller.onStored(bundle(2));session.id='kakao-b';assert.equal((await controller.flush()).status,'error');assert.equal(controller.snapshot.reason,'account-changed');assert.deepEqual(server.records.get('kakao-a'),original);assert.equal(server.records.has('kakao-b'),false);assert.equal(putCount(server),1);controller.dispose();
});

test('an account change between auth check and PUT is rejected by the expected account header',async()=>{
 const server=memoryServer(),session={id:'kakao-a'},controller=await registered(server,memoryStorage(),session),original=clone(server.records.get('kakao-a'));
 server.beforePut=async()=>{session.id='kakao-b';};controller.onStored(bundle(2));await controller.flush();assert.equal(controller.snapshot.reason,'account-changed');assert.deepEqual(server.records.get('kakao-a'),original);assert.equal(server.records.has('kakao-b'),false);controller.dispose();
});

test('an old in-flight response cannot replace state after refreshing another account',async()=>{
 const server=memoryServer(),session={id:'kakao-a'},controller=await registered(server,memoryStorage(),session),gate=deferred(),started=deferred();server.beforePut=async()=>{started.resolve();await gate.promise;};
 controller.onStored(bundle(2));const old=controller.flush();await started.promise;session.id='kakao-b';await controller.refresh(bundle(4,{owner:'b-partner'}));assert.equal(controller.snapshot.user.id,'kakao-b');gate.resolve();await old;assert.equal(controller.snapshot.user.id,'kakao-b');assert.equal(controller.snapshot.status,'link-required');assert.equal(server.records.has('kakao-b'),false);controller.dispose();
});

test('network failures keep local data and refuse account writes until a fresh check',async()=>{
 const server=memoryServer(),storage=memoryStorage(),controller=await registered(server,storage),local=bundle(8);server.offline=true;controller.onStored(local);assert.equal((await controller.flush()).status,'offline');assert.deepEqual(controller.snapshot.localBundle,local);server.offline=false;controller.onStored(bundle(9));await controller.flush();assert.equal(server.records.get('kakao-a').revision,1);assert.equal((await controller.refresh()).status,'conflict');controller.dispose();
});

test('suspend cancels a queued upload and refuses retries until an explicit refresh',async()=>{
 const server=memoryServer(),controller=await registered(server),pending=bundle(2);controller.onStored(pending);assert.equal(controller.snapshot.pending,true);controller.suspend(Error('checkpoint read failed'));assert.equal(controller.snapshot.status,'error');assert.equal(controller.snapshot.reason,'invalid-local');assert.deepEqual(controller.snapshot.localBundle,pending);await controller.flush();controller.onStored(pending);await controller.flush();assert.equal(putCount(server),1);assert.equal((await controller.refresh()).status,'conflict');await controller.useLocal();assert.equal(putCount(server),2);controller.dispose();
});

test('an account lookup error never falls back to uploading an anonymous local save',async()=>{
 const server=memoryServer();server.offline=true;const original=bundle(151),controller=make(server);assert.equal((await controller.init(original)).status,'offline');controller.onStored(original);await controller.useLocal();await controller.flush();assert.equal(putCount(server),0);assert.deepEqual(controller.snapshot.localBundle,original);controller.dispose();
});

test('a failed backup blocks first link and leaves the existing PC save untouched',async()=>{
 const server=memoryServer(),storage=memoryStorage(),original=bundle(151);storage.setItem('primary',original.save);const set=storage.setItem.bind(storage);storage.setItem=(key,value)=>{if(key.startsWith(ACCOUNT_SAVE_BACKUP_PREFIX))throw Error('full');set(key,value);};
 const controller=make(server,storage);await controller.init(original);assert.equal((await controller.useLocal()).status,'error');assert.equal(controller.snapshot.reason,'backup-failed');assert.equal(putCount(server),0);assert.equal(storage.getItem('primary'),original.save);controller.dispose();
});

test('a failed backup blocks cloud apply before the game is touched',async()=>{
 const server=memoryServer(),pc=await registered(server),storage=memoryStorage(),phone=make(server,storage);await phone.init(null);storage.setItem=()=>{throw Error('full');};let applied=false;await phone.useCloud({apply:()=>{applied=true;}});assert.equal(applied,false);assert.equal(phone.snapshot.status,'error');assert.equal(server.records.get('kakao-a').revision,1);pc.dispose();phone.dispose();
});

test('a failed cloud adapter preserves the original local bundle and a recovery backup',async()=>{
 const server=memoryServer(),pc=await registered(server),storage=memoryStorage(),local=bundle(3,{owner:'other-local'}),phone=make(server,storage);await phone.init(local);await phone.useCloud({apply:()=>{throw Error('models unavailable');}});assert.equal(phone.snapshot.status,'error');assert.deepEqual(phone.snapshot.localBundle,local);assert.deepEqual(backups(storage).at(-1).bundle,local);assert.equal(storage.getItem(ACCOUNT_SAVE_META_KEY),null);pc.dispose();phone.dispose();
});

test('metadata write failure disables further account writes without deleting the local save',async()=>{
 const server=memoryServer(),storage=memoryStorage(),controller=await registered(server,storage),set=storage.setItem.bind(storage),local=bundle(2);storage.setItem=(key,value)=>{if(key===ACCOUNT_SAVE_META_KEY)throw Error('full');set(key,value);};assert.equal(controller.onStored(local),false);assert.equal(controller.snapshot.reason,'metadata-unavailable');await controller.flush();assert.equal(putCount(server),1);assert.deepEqual(controller.snapshot.localBundle,local);controller.dispose();
});

test('new adventure or imported checkpoint identity pauses automatic replacement',async()=>{
 for(const changed of [bundle(1,{owner:'new-starter'}),bundle(1,{checkpointId:'import-identity'})]){
  const server=memoryServer(),controller=await registered(server);controller.onStored(changed);assert.equal(controller.snapshot.status,'conflict');assert.equal(controller.snapshot.reason,'different-expedition');await controller.flush();assert.equal(server.records.get('kakao-a').revision,1);await controller.useLocal();assert.equal(server.records.get('kakao-a').revision,2);controller.dispose();
 }
});

test('an adventure replacement while uploading cannot restart writes after the old response',async()=>{
 const server=memoryServer(),controller=await registered(server),gate=deferred(),started=deferred();server.beforePut=async()=>{started.resolve();await gate.promise;};controller.onStored(bundle(2));const pending=controller.flush();await started.promise;const newGame=bundle(1,{owner:'brand-new-partner'});controller.onStored(newGame);assert.equal(controller.snapshot.status,'conflict');gate.resolve();await pending;assert.equal(controller.snapshot.status,'conflict');assert.deepEqual(controller.snapshot.localBundle,newGame);assert.equal(server.records.get('kakao-a').revision,2);await controller.flush();assert.equal(server.records.get('kakao-a').revision,2);controller.dispose();
});

test('restored legacy bytes may migrate locally without uploading during startup',async()=>{
 const server=memoryServer(),pc=await registered(server),storage=memoryStorage(),phone=make(server,storage);await phone.init(null);const migrated=bundle(1,{checkpointId:'migrated-checkpoint'});await phone.useCloud({apply:()=>migrated});assert.equal(phone.snapshot.status,'synced');assert.equal(phone.snapshot.pending,false);assert.equal(putCount(server),1);const meta=JSON.parse(storage.getItem(ACCOUNT_SAVE_META_KEY)).accounts['kakao-a'];assert.equal(meta.fingerprint,accountSaveFingerprint(server.records.get('kakao-a').bundle));assert.equal(meta.localFingerprint,accountSaveFingerprint(migrated));phone.onStored(bundle(2,{checkpointId:'migrated-checkpoint'}));await phone.flush();assert.equal(server.records.get('kakao-a').revision,2);pc.dispose();phone.dispose();
});

test('snapshot objects cannot mutate the controller or remote record',async()=>{
 const server=memoryServer(),controller=await registered(server),snapshot=controller.snapshot;snapshot.record.bundle.save='changed';snapshot.localBundle.save='changed';snapshot.user.id='changed';assert.equal(controller.snapshot.user.id,'kakao-a');assert.notEqual(controller.snapshot.localBundle.save,'changed');assert.notEqual(controller.snapshot.record.bundle.save,'changed');controller.dispose();
});

test('strict bundle and injected game validation reject malformed or poisoned records',async()=>{
 for(const bad of [{schema:2,save:'{}',checkpoint:null},{schema:1,save:bundle().save,checkpoint:'not-json'},{schema:1,save:bundle().save,checkpoint:null,extra:1}]){
  if(bad.extra){assert.equal(validateAccountSaveBundle(bad),true);continue;}assert.throws(()=>validateAccountSaveBundle(bad));
 }
 const server=memoryServer(),controller=make(server,memoryStorage(),{id:'kakao-a'},{validateBundle:()=>false});assert.equal((await controller.init(bundle())).status,'error');assert.equal(putCount(server),0);controller.dispose();
});

test('real fetch adapter sends session credentials, account guard, and exact save bytes',async()=>{
 const calls=[],incoming=bundle(151),record={revision:1,updatedAt:'2026-10-17T00:00:00.000Z',bundle:incoming};
 const transport=createAccountSaveTransport({fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>url.endsWith('/me')?{ok:true,user:{id:'a'}}:{ok:true,record}};}});
 assert.equal((await transport.getUser()).id,'a');assert.deepEqual(await transport.getRecord({userId:'a'}),record);assert.deepEqual(await transport.putRecord({userId:'a',expectedRevision:0,bundle:incoming}),record);assert.equal(calls[1].options.headers['X-Kanto151-Account'],'a');assert.equal(calls[2].options.credentials,'same-origin');assert.equal(calls[2].options.method,'PUT');assert.deepEqual(JSON.parse(calls[2].options.body),{expectedRevision:0,bundle:incoming});
});

test('fetch adapter exposes 409 current records and rejects an account mismatch separately',async()=>{
 const record={revision:7,updatedAt:'now',bundle:bundle()},conflict=createAccountSaveTransport({fetchImpl:async()=>({ok:false,status:409,json:async()=>({ok:false,error:'conflict',record})})});await assert.rejects(()=>conflict.putRecord({userId:'a',expectedRevision:1,bundle:bundle()}),error=>error.code==='conflict'&&error.record.revision===7);
 const mismatch=createAccountSaveTransport({fetchImpl:async()=>({ok:false,status:409,json:async()=>({ok:false,error:'account-changed'})})});await assert.rejects(()=>mismatch.getRecord({userId:'a'}),error=>error.code==='account-changed');
});

test('fetch timeout is bounded and caller cancellation propagates without retrying',async()=>{
 const hanging=(_url,{signal})=>new Promise((_resolve,reject)=>{if(signal.aborted)reject(Error('aborted'));else signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
 const transport=createAccountSaveTransport({timeoutMs:10,fetchImpl:hanging});await assert.rejects(()=>transport.getUser(),error=>error.code==='timeout');const abort=new AbortController();abort.abort();await assert.rejects(()=>transport.getUser({signal:abort.signal}),/aborted/);
});
