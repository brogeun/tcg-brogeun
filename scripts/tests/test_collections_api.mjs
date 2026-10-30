// Offline integration proof: real endpoint JS, real HS256 tokens, real SQLite.
// This is not a D1 staging/production or real-account test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
import {webcrypto} from 'node:crypto';

globalThis.crypto??=webcrypto;
const root=join(dirname(fileURLToPath(import.meta.url)),'../..');
const modules=new Map();
async function loadModule(path){
  if(modules.has(path))return modules.get(path);
  let source=await readFile(path,'utf8');
  if(process.env.COLLECTIONS_TEST_TRACE==='1'&&path.endsWith('collections.js'))source=source.replace('}catch(error){if(error instanceof CollectionError)', '}catch(error){if(!(error instanceof CollectionError)) console.error("fixture endpoint error:",error.message);if(error instanceof CollectionError)');
  for(const match of [...source.matchAll(/from\s+(['"])(\.\.?\/[^'"]+)\1/g)]){
    const dependency=await loadModule(join(dirname(path),match[2]));
    source=source.replace(match[0],`from '${dependency.url}'`);
  }
  const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');
  const result={url,module:await import(url)};modules.set(path,result);return result;
}
class Database{
  constructor(){
    this.child=spawn(process.env.COLLECTIONS_TEST_PYTHON||'python',['-u',join(root,'scripts/tests/collections_sqlite_bridge.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.pending=new Map();this.id=0;this.stderr='';
    this.child.stderr.on('data',chunk=>this.stderr+=chunk);
    createInterface({input:this.child.stdout}).on('line',line=>{const reply=JSON.parse(line),entry=this.pending.get(reply.id);if(!entry)return;this.pending.delete(reply.id);clearTimeout(entry.timer);reply.error?entry.reject(new Error(reply.error)):entry.resolve(reply.result);});
    this.child.on('error',error=>{for(const p of this.pending.values())p.reject(error);});
  }
  request(input){return new Promise((resolve,reject)=>{const id=++this.id,timer=setTimeout(()=>reject(new Error('SQLite bridge timed out: '+this.stderr)),10000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({...input,id})+'\n');});}
  prepare(sql){const db=this;return {sql,params:[],bind(...params){return {...this,params};},async all(){return db.request({op:'statement',sql:this.sql,params:this.params});},async first(){return (await this.all()).results[0]??null;},async run(){return db.request({op:'statement',sql:this.sql,params:this.params});}};}
  batch(statements){return this.request({op:'batch',statements:statements.map(({sql,params})=>({sql,params}))});}
  script(sql){return this.request({op:'script',sql});}
  close(){this.child.stdin.end();}
}
const key=n=>`cp1_${n.toString(16).padStart(8,'0')}-0000-5000-8000-000000000000`;
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ACCOUNT_A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ACCOUNT_B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSION='fixture-v1';
const fixtures={
  [key(1)]:{game:'pokemon',language:'ja',sourceKey:'JP:fixture:001',marketId:'1001',marketVerified:true},
  [key(2)]:{game:'pokemon',language:'ja',sourceKey:'JP:fixture:002',marketId:'1002',marketVerified:true},
  [key(3)]:{game:'pokemon',language:'ja',sourceKey:'JP:fixture:003',marketId:'1003',marketVerified:false},
  [key(4)]:{game:'onepiece',language:'ja',sourceKey:'OP01-001_p1',marketId:'1004',marketVerified:false},
  [key(5)]:{game:'pokemon',language:'en',sourceKey:'EN:set:5',marketVerified:false},
  [key(6)]:{game:'pokemon',language:'ja',sourceKey:'extra:source:6',marketId:'1001',marketVerified:true,sourceOnly:true},
  [key(7)]:{game:'pokemon',language:'ja',sourceKey:'official:printing:7',marketId:'1001',marketVerified:true,sourceOnly:true,characterDiscoveryVerified:true},
  [key(8)]:{game:'pokemon',language:'ja',sourceKey:'extra:source:8',marketId:'1001',marketVerified:true,sourceOnly:true,characterDiscoveryVerified:'true'},
};
const catalog={schemaVersion:1,version:VERSION,artists:[{id:'pokemon:fixture',game:'pokemon',cardIds:[key(1),key(2),key(6)]}],characters:[{id:'pokemon:base',game:'pokemon',cardIds:[key(1),key(2),key(6),key(7),key(8)],megaCardIds:[key(2)],evolutionIds:['pokemon:base','pokemon:evo']},{id:'pokemon:evo',game:'pokemon',cardIds:[key(3)],megaCardIds:[],evolutionIds:['pokemon:base','pokemon:evo']}]};

test('collections private APIs: signed-session + actual SQLite boundary and concurrency checks',async t=>{
  const db=new Database();t.after(()=>db.close());
  const shared=(await loadModule(join(root,'functions/_shared/collections.js'))).module;
  const jwt=(await loadModule(join(root,'functions/_shared/jwt.js'))).module;
  const index=(await loadModule(join(root,'functions/api/collections/index.js'))).module;
  const single=(await loadModule(join(root,'functions/api/collections/[id].js'))).module;
  const items=(await loadModule(join(root,'functions/api/collections/[id]/items.js'))).module;
  const own=(await loadModule(join(root,'functions/api/collection-ownership.js'))).module;
  const removeAccount=(await loadModule(join(root,'functions/api/auth/delete-account.js'))).module;
  const migration=await readFile(join(root,'functions/_schema/collections.sql'),'utf8');
  assert.equal(migration.slice(migration.indexOf('\nCREATE TABLE')).replace(/\r\n/g,'\n').trim(),shared.COLLECTION_SCHEMA.trim());
  await db.script(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT);CREATE TABLE holdings(id INTEGER PRIMARY KEY,user_id TEXT REFERENCES users(id),card_id TEXT,grade TEXT,qty INTEGER,buy_price INTEGER);CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id TEXT REFERENCES users(id),price INTEGER);INSERT INTO users VALUES('${ACCOUNT_A}','a@fixture.invalid'),('${ACCOUNT_B}','b@fixture.invalid');INSERT INTO holdings VALUES(1,'${ACCOUNT_A}','1001','raw',2,100),(2,'${ACCOUNT_A}','1001','psa10',1,200),(3,'${ACCOUNT_A}','1002','box',1,300),(4,'${ACCOUNT_A}','1003','raw',1,400),(5,'${ACCOUNT_B}','1002','raw',1,500);INSERT INTO transactions VALUES(1,'${ACCOUNT_A}',123),(2,'${ACCOUNT_B}',456);`);
  await db.script(migration);await db.script(migration);
  const secret='offline-collections-test-secret',tokens={};
  for(const account of [ACCOUNT_A,ACCOUNT_B])tokens[account]=await jwt.signJwt({sub:account,exp:Math.floor(Date.now()/1000)+3600},secret);
  const assetRequests=[];
  const assetBinding={async fetch(request){assetRequests.push({url:request.url,headers:Object.fromEntries(request.headers)});const path=new URL(request.url).pathname;if(path==='/data/collections/manifest.json')return Response.json({schemaVersion:1,version:VERSION});if(path==='/data/collections/catalog.json')return Response.json(catalog);if(/^\/data\/collections\/keys\/[0-9a-f]\.json$/.test(path))return Response.json({version:VERSION,cards:fixtures});return new Response('missing',{status:404});}};
  const env={DB:db,JWT_SECRET:secret,ASSETS:assetBinding};
  const routes={GET:index.onRequestGet,POST:index.onRequestPost};
  async function call(method,path,body,{account=ACCOUNT_A,headers={},customEnv=env,raw}={}){
    const h={'X-Collection-Account':account,'Cookie':`session=${tokens[account]}`,...(method!=='GET'?{'Origin':'https://tcghub.example','Content-Type':'application/json'}:{}),...headers};
    for(const k of Object.keys(h))if(h[k]===null)delete h[k];
    const request=new Request('https://tcghub.example'+path,{method,headers:h,...(method!=='GET'?{body:raw??JSON.stringify(body)}:{})});
    let handler,params={};
    if(path.split('?')[0]==='/api/collections')handler=routes[method];
    else if(path.startsWith('/api/collection-ownership'))handler=own['onRequest'+method[0]+method.slice(1).toLowerCase()];
    else {const match=path.match(/^\/api\/collections\/([^/?]+)(\/items)?/);params={id:match?.[1]};handler=(match?.[2]?items:single)['onRequest'+method[0]+method.slice(1).toLowerCase()];}
    const response=await handler({request,env:customEnv,params});
    assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
    const data=await response.json();if(response.ok){assert.equal(data.accountId,account);assert.equal(data.catalogVersion,VERSION);}return {status:response.status,data};
  }
  const create=(n,extra={})=>call('POST','/api/collections',{id:id(n),title:'내 컬렉션',cardKeys:[key(1),key(2),key(3)],catalogVersion:VERSION,...extra});
  const assetSnapshot=(await db.prepare('SELECT * FROM holdings ORDER BY id').all()).results;
  const txSnapshot=(await db.prepare('SELECT * FROM transactions ORDER BY id').all()).results;
  await t.test('schema is additive/idempotent; collection create counts exact verified any-grade card once',async()=>{
    const result=await create(1);assert.equal(result.status,201);assert.equal(result.data.collection.itemCount,3);assert.equal(result.data.collection.ownedCount,1);
    assert.equal(result.data.collection.ownership[key(1)].holdingOwned,true);
    assert.equal(result.data.collection.ownership[key(2)].holdingOwned,false,'box grade cannot satisfy card collection');
    assert.equal(result.data.collection.ownership[key(3)].holdingOwned,false,'unverified market mapping excluded');
  });
  await t.test('existing numeric JWT subjects normalize to the same account ID as legacy authentication',async()=>{
    await db.prepare('INSERT INTO users(id,email) VALUES(?,?)').bind('42','legacy@fixture.invalid').run();
    try{for(const subject of [42,'42']){tokens['42']=await jwt.signJwt({sub:subject,exp:Math.floor(Date.now()/1000)+3600},secret);const result=await call('GET','/api/collections',undefined,{account:'42'});assert.equal(result.status,200);assert.equal(result.data.accountId,'42');assert.deepEqual(result.data.collections,[]);assert.equal((await call('GET','/api/collections',undefined,{account:'42',headers:{'X-Collection-Account':'43'}})).status,409);}
      for(const subject of [0,42.5,true,null]){tokens['42']=await jwt.signJwt({sub:subject,exp:Math.floor(Date.now()/1000)+3600},secret);assert.equal((await call('GET','/api/collections',undefined,{account:'42'})).status,401);}
    }finally{delete tokens['42'];await db.prepare('DELETE FROM users WHERE id=?').bind('42').run();}
  });
  await t.test('replayed create is stable; ID reuse with different original payload conflicts',async()=>{
    const retry=await create(1);assert.equal(retry.status,200);assert.equal(retry.data.replayed,true);assert.equal(retry.data.collection.revision,1);
    assert.equal((await create(1,{title:'다른 제목'})).status,409);
  });
  await t.test('other account cannot read/rename/delete/modify existing collection; same ID may be privately owned independently',async()=>{
    const other={account:ACCOUNT_B};
    for(const [method,path,body] of [['GET',`/api/collections/${id(1)}`],['PATCH',`/api/collections/${id(1)}`,{expectedRevision:1,title:'몰래 수정'}],['DELETE',`/api/collections/${id(1)}`,{expectedRevision:1}],['PUT',`/api/collections/${id(1)}/items`,{expectedRevision:1,addCardKeys:[key(4)],catalogVersion:VERSION}]])assert.equal((await call(method,path,body,other)).status,404);
    const b=await call('POST','/api/collections',{id:id(1),title:'계정 B',cardKeys:[key(2)],catalogVersion:VERSION},other);assert.equal(b.status,201);assert.equal(b.data.collection.ownedCount,1);
  });
  await t.test('manual ownership is global, persists separately, and cannot suppress exact holdings',async()=>{
    const result=await call('PUT','/api/collection-ownership',{cardKey:key(2),manualOwned:true,expectedRevision:0,catalogVersion:VERSION});assert.equal(result.status,200);assert.equal(result.data.ownership[key(2)].owned,true);assert.equal(result.data.ownership[key(2)].revision,1);
    const other=await create(2,{cardKeys:[key(2)]});assert.equal(other.data.collection.ownedCount,1);
    const uncheck=await call('PUT','/api/collection-ownership',{cardKey:key(1),manualOwned:false,expectedRevision:0,catalogVersion:VERSION});assert.equal(uncheck.data.ownership[key(1)].owned,true);assert.equal(uncheck.data.ownership[key(1)].manualOwned,false);
    const repeat=await call('PUT','/api/collection-ownership',{cardKey:key(2),manualOwned:true,expectedRevision:0,catalogVersion:VERSION});assert.equal(repeat.data.replayed,true);assert.equal(repeat.data.ownership[key(2)].revision,1);
  });
  await t.test('ownership revisions prevent stale overwrites, and old accepted requests replay after intervening edit',async()=>{
    const off={cardKey:key(2),manualOwned:false,expectedRevision:1,catalogVersion:VERSION,mutationId:id(90)};
    const first=await call('PUT','/api/collection-ownership',off);assert.equal(first.data.ownership[key(2)].revision,2);
    assert.equal((await call('PUT','/api/collection-ownership',{...off,manualOwned:true,mutationId:id(91)})).status,409);
    await call('PUT','/api/collection-ownership',{cardKey:key(2),manualOwned:true,expectedRevision:2,catalogVersion:VERSION});
    const replayed=await call('PUT','/api/collection-ownership',off);assert.equal(replayed.data.replayed,true);assert.equal(replayed.data.ownership[key(2)].revision,3);assert.equal(replayed.data.ownership[key(2)].manualOwned,true);
    assert.equal((await call('PUT','/api/collection-ownership',{...off,manualOwned:true})).status,409,'mutationId reuse with another payload rejected');
  });
  await t.test('same printing across collections creates no asset/transaction rows or balance changes',async()=>{
    assert.deepEqual((await db.prepare('SELECT * FROM holdings ORDER BY id').all()).results,assetSnapshot);
    assert.deepEqual((await db.prepare('SELECT * FROM transactions ORDER BY id').all()).results,txSnapshot);
    const list=await call('GET','/api/collections');assert.equal(list.status,200);assert.equal(list.data.collections.length,2);assert(!Object.hasOwn(list.data.collections[0],'cardKeys'));
  });
  await t.test('real concurrent same-revision membership updates accept exactly one; duplicate add stays unique',async()=>{
    const path=`/api/collections/${id(1)}/items`;
    const [a,b]=await Promise.all([call('PUT',path,{expectedRevision:1,addCardKeys:[key(4)],catalogVersion:VERSION,mutationId:id(92)}),call('PUT',path,{expectedRevision:1,addCardKeys:[key(5)],catalogVersion:VERSION,mutationId:id(93)})]);
    assert.deepEqual([a.status,b.status].sort(),[200,409]);
    const winner=a.status===200?a:b,body=a.status===200?{expectedRevision:1,addCardKeys:[key(4)],catalogVersion:VERSION,mutationId:id(92)}:{expectedRevision:1,addCardKeys:[key(5)],catalogVersion:VERSION,mutationId:id(93)};
    assert.equal(winner.data.collection.revision,2);assert.equal(winner.data.collection.itemCount,4);
    const duplicate=await call('PUT',path,{expectedRevision:2,addCardKeys:[key(1)],catalogVersion:VERSION});assert.equal(duplicate.data.collection.itemCount,4);
    const replayed=await call('PUT',path,body);assert.equal(replayed.data.replayed,true);assert.equal(replayed.data.collection.revision,3);
  });
  await t.test('all keys validated before any item writes; invalid/overlapping/oversized batches leave revision unchanged',async()=>{
    const path=`/api/collections/${id(1)}/items`,before=(await call('GET',`/api/collections/${id(1)}`)).data.collection;
    assert.equal((await call('PUT',path,{expectedRevision:before.revision,addCardKeys:[key(2),key(999)],catalogVersion:VERSION})).status,400);
    assert.equal((await call('PUT',path,{expectedRevision:before.revision,addCardKeys:[key(1)],removeCardKeys:[key(1)],catalogVersion:VERSION})).status,400);
    assert.equal((await call('PUT',path,{expectedRevision:before.revision,addCardKeys:Array.from({length:101},(_,i)=>key(i+10)),catalogVersion:VERSION})).status,413);
    assert.equal((await call('GET',`/api/collections/${id(1)}`)).data.collection.revision,before.revision);
  });
  await t.test('SQLite failure inside atomic receipt+CAS batch rolls back receipt and record together',async()=>{
    await db.script("CREATE TRIGGER fixture_fail BEFORE UPDATE ON collections WHEN NEW.title='forcefail' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
    const before=(await call('GET',`/api/collections/${id(1)}`)).data.collection;
    const response=await call('PATCH',`/api/collections/${id(1)}`,{expectedRevision:before.revision,title:'forcefail',mutationId:id(94)});assert.equal(response.status,503);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM collection_mutations WHERE request_id=?').bind(id(94)).first()).n,0);
    assert.equal((await call('GET',`/api/collections/${id(1)}`)).data.collection.revision,before.revision);
  });
  await t.test('artist and character snapshots verify trusted exact scope, evolution and mega flags',async()=>{
    assert.equal((await create(3,{cardKeys:[key(1)],snapshot:{kind:'artist',artistId:'pokemon:fixture',game:'pokemon',language:'ja'}})).status,201);
    assert.equal((await create(4,{cardKeys:[key(3)],snapshot:{kind:'artist',artistId:'pokemon:fixture'}})).status,400);
    assert.equal((await create(5,{cardKeys:[key(1)],snapshot:{kind:'character',characterId:'pokemon:base',includeMega:false}})).status,201);
    assert.equal((await create(6,{cardKeys:[key(2)],snapshot:{kind:'character',characterId:'pokemon:base',includeMega:false}})).status,400);
    assert.equal((await create(7,{cardKeys:[key(1),key(2),key(3)],snapshot:{kind:'character',characterId:'pokemon:base',includeMega:true,includeEvolution:true}})).status,201);
    assert.equal((await create(8,{cardKeys:[key(3)],snapshot:{kind:'character',characterId:'pokemon:base',includeEvolution:false}})).status,400);
    assert.equal((await create(9,{cardKeys:[key(1)],snapshot:{kind:'character',characterId:'pokemon:base',includeEvolution:'true'}})).status,400);
    assert.equal((await create(14,{cardKeys:[key(6)],snapshot:{kind:'character',characterId:'pokemon:base',includeMega:true,includeEvolution:true}})).status,400,'sourceOnly rejected even if group lists that key');
    const sourceArtist=await create(15,{cardKeys:[key(6)],snapshot:{kind:'artist',artistId:'pokemon:fixture'}});assert.equal(sourceArtist.status,201);assert.equal(sourceArtist.data.collection.ownership[key(6)].holdingOwned,false,'source-only artist credit never auto-matches the asset ledger');
  });
  await t.test('body, identity, catalog version and JSON boundaries fail explicitly without partial creation',async()=>{
    assert.equal((await create(10,{catalogVersion:'old-version'})).status,409);
    assert.equal((await create(11,{cardKeys:[key(1),key(1)]})).status,400);
    assert.equal((await create(12,{cardKeys:Array.from({length:5001},(_,i)=>key(i+1))})).status,413);
    assert.equal((await call('POST','/api/collections',null,{raw:' '.repeat(shared.LIMITS.bodyBytes+1)})).status,413);
    assert.equal((await call('POST','/api/collections',null,{raw:'{'})).status,400);
    assert.equal((await call('POST','/api/collections',null,{raw:'[]'})).status,400);
    assert.equal((await call('POST','/api/collections',{}, {headers:{'Content-Type':'text/plain'}})).status,415);
    assert.equal((await call('POST','/api/collections',{}, {headers:{'Content-Length':'-1'}})).status,413);
    assert.equal((await create(13,{title:'😀'.repeat(61)})).status,400);
    assert.equal((await call('GET','/api/collection-ownership?cardKeys='+encodeURIComponent('../../secret'))).status,400);
  });
  await t.test('only exact trusted characterDiscoveryVerified boolean permits source-only snapshot; asset projection still excluded',async()=>{
    const approved=await create(16,{cardKeys:[key(7)],snapshot:{kind:'character',characterId:'pokemon:base'}});
    assert.equal(approved.status,201);assert.equal(approved.data.collection.ownership[key(7)].holdingOwned,false);assert.equal(approved.data.collection.ownedCount,0);
    const textFlag=await create(17,{cardKeys:[key(8)],snapshot:{kind:'character',characterId:'pokemon:base'}});assert.equal(textFlag.status,400,'string true is not an official discovery approval');
    const unchecked=await create(18,{cardKeys:[key(6)],snapshot:{kind:'character',characterId:'pokemon:base'}});assert.equal(unchecked.status,400,'unverified source-only keys remain excluded');
    const manual=await call('PUT','/api/collection-ownership',{cardKey:key(7),manualOwned:true,expectedRevision:0,catalogVersion:VERSION});assert.equal(manual.status,200);assert.equal(manual.data.ownership[key(7)].holdingOwned,false);assert.equal(manual.data.ownership[key(7)].manualOwned,true);assert.equal(manual.data.ownership[key(7)].owned,true);
  });
  await t.test('cross-origin writes, account mismatches, anonymous and deleted users never access private state',async()=>{
    assert.equal((await call('POST','/api/collections',{}, {headers:{Origin:'https://evil.example'}})).status,403);
    assert.equal((await call('POST','/api/collections',{}, {headers:{Origin:null}})).status,403);
    assert.equal((await call('POST','/api/collections',{}, {headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await call('GET','/api/collections',undefined,{headers:{'X-Collection-Account':ACCOUNT_B}})).status,409);
    assert.equal((await call('GET','/api/collections',undefined,{headers:{'X-Collection-Account':null}})).status,400);
    assert.equal((await call('GET','/api/collections',undefined,{headers:{Cookie:null}})).status,401);
    const expired=await jwt.signJwt({sub:ACCOUNT_A,exp:1},secret);assert.equal((await call('GET','/api/collections',undefined,{headers:{Cookie:`session=${expired}`}})).status,401);
    const deleted=await jwt.signJwt({sub:id(999),exp:Math.floor(Date.now()/1000)+100},secret);assert.equal((await call('GET','/api/collections',undefined,{headers:{Cookie:`session=${deleted}`}})).status,401);
  });
  await t.test('no incoming cookie/authorization is ever forwarded to exact same-origin registry asset reads',async()=>{
    assert(assetRequests.length>0);for(const request of assetRequests){assert.equal(new URL(request.url).origin,'https://tcghub.example');assert.equal(request.headers.cookie,undefined);assert.equal(request.headers.authorization,undefined);assert.equal(request.headers['x-collection-account'],undefined);}
  });
  await t.test('ordinary private reads and manual mutations load only thin manifest; artist snapshot loads full graph',async()=>{
    const before=assetRequests.length;
    assert.equal((await call('GET','/api/collections')).status,200);
    assert.equal((await call('GET',`/api/collections/${id(1)}`)).status,200);
    assert.equal((await call('GET','/api/collection-ownership?cardKeys='+key(1))).status,200);
    assert.equal((await create(30,{cardKeys:[key(1)]})).status,201);
    assert.equal((await call('PUT','/api/collection-ownership',{cardKey:key(5),manualOwned:true,expectedRevision:0,catalogVersion:VERSION})).status,200);
    const hotRequests=assetRequests.slice(before).map(row=>new URL(row.url).pathname);
    assert.equal(hotRequests.filter(path=>path.endsWith('/manifest.json')).length,5);
    assert.equal(hotRequests.filter(path=>path.endsWith('/catalog.json')).length,0,'ordinary requests never fetch/parse discovery graph');
    const beforeSnapshot=assetRequests.length;
    assert.equal((await create(31,{cardKeys:[key(1)],snapshot:{kind:'artist',artistId:'pokemon:fixture'}})).status,201);
    assert.equal(assetRequests.slice(beforeSnapshot).filter(row=>new URL(row.url).pathname.endsWith('/catalog.json')).length,1);
  });
  await t.test('missing manifest has no full-catalog fallback; snapshot graph version/readOnly must match manifest',async()=>{
    const reads=[];
    const noManifest={...env,ASSETS:{async fetch(request){const path=new URL(request.url).pathname;reads.push(path);return path.endsWith('/manifest.json')?new Response('missing',{status:404}):Response.json(catalog);}}};
    assert.equal((await call('GET','/api/collections',undefined,{customEnv:noManifest})).status,503);assert.deepEqual(reads,['/data/collections/manifest.json']);
    for(const mismatch of [{...catalog,version:'other-version'},{...catalog,readOnly:true}]){
      const mismatchEnv={...env,ASSETS:{async fetch(request){const path=new URL(request.url).pathname;return Response.json(path.endsWith('/manifest.json')?{schemaVersion:1,version:VERSION}:path.endsWith('/catalog.json')?mismatch:{version:VERSION,cards:fixtures});}}};
      const result=await call('POST','/api/collections',{id:id(32),title:'불일치',cardKeys:[key(1)],catalogVersion:VERSION,snapshot:{kind:'artist',artistId:'pokemon:fixture'}},{customEnv:mismatchEnv});assert.equal(result.status,503);
    }
    assert.equal(await db.prepare('SELECT id FROM collections WHERE user_id=? AND id=?').bind(ACCOUNT_A,id(32)).first(),null);
  });
  await t.test('same-binding new version evicts old shard cache and cannot retain two complete generations',async()=>{
    let version='cache-v1',reads=0;
    const switchingEnv={...env,ASSETS:{async fetch(request){const path=new URL(request.url).pathname;if(path.endsWith('/manifest.json'))return Response.json({schemaVersion:1,version});reads++;return Response.json({version,cards:fixtures});}}};
    async function read(){const response=await own.onRequestGet({request:new Request('https://cache-fixture.example/api/collection-ownership?cardKeys='+key(1),{headers:{Cookie:`session=${tokens[ACCOUNT_A]}`,'X-Collection-Account':ACCOUNT_A}}),env:switchingEnv});assert.equal(response.status,200);}
    await read();await read();assert.equal(reads,1,'warm current-version shard reused');
    version='cache-v2';await read();assert.equal(reads,2);
    version='cache-v1';await read();assert.equal(reads,3,'old generation was evicted rather than retained');
  });
  await t.test('default lazy bootstrap is authenticated, additive, concurrent-safe, and preserves existing portfolio rows',async()=>{
    const freshDB=new Database();
    try{
      await freshDB.script(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT);CREATE TABLE holdings(id INTEGER PRIMARY KEY,user_id TEXT,card_id TEXT,grade TEXT,qty INTEGER,buy_price INTEGER);CREATE TABLE transactions(id INTEGER PRIMARY KEY,user_id TEXT,price INTEGER);INSERT INTO users VALUES('${ACCOUNT_A}','a@fixture.invalid');INSERT INTO holdings VALUES(99,'${ACCOUNT_A}','1001','raw',1,900);INSERT INTO transactions VALUES(99,'${ACCOUNT_A}',900);`);
      const freshEnv={...env,DB:freshDB};let bootstraps=0;
      const originalBatch=freshDB.batch.bind(freshDB);freshDB.batch=statements=>{if(statements.some(item=>item.sql.startsWith('CREATE TABLE')))bootstraps++;return originalBatch(statements);};
      assert.equal((await call('POST','/api/collections',{}, {customEnv:freshEnv,headers:{Origin:'https://evil.example'}})).status,403);
      assert.equal((await call('GET','/api/collections',undefined,{customEnv:freshEnv,headers:{Cookie:null}})).status,401);
      assert.equal(bootstraps,0,'cross-origin or anonymous request must not create tables');
      const calls=await Promise.all(Array.from({length:5},()=>call('GET','/api/collections',undefined,{customEnv:freshEnv})));
      assert(calls.every(result=>result.status===200));assert.equal(bootstraps,1,'concurrent authenticated requests share one schema bootstrap');
      assert.equal((await freshDB.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type=\'table\' AND name IN (\'collections\',\'collection_mutations\',\'user_card_states\')').first()).n,3);
      assert.deepEqual((await freshDB.prepare('SELECT * FROM holdings').all()).results,[{id:99,user_id:ACCOUNT_A,card_id:'1001',grade:'raw',qty:1,buy_price:900}]);
      assert.equal((await freshDB.prepare('SELECT price FROM transactions').first()).price,900);
      for(let n=0;n<49;n++)await freshDB.prepare('INSERT INTO collections(user_id,id,title,items_json,snapshot_json,catalog_version,create_hash,created_at,updated_at) VALUES(?,?,?,\'[]\',\'{"kind":"manual"}\',?,?,?,?)').bind(ACCOUNT_A,id(1000+n),'fixture',VERSION,'fixture','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z').run();
      const responses=await Promise.all([2001,2002].map(n=>call('POST','/api/collections',{id:id(n),title:'한도 검사',cardKeys:[],catalogVersion:VERSION},{customEnv:freshEnv})));
      assert.deepEqual(responses.map(r=>r.status).sort(),[201,413]);
      assert.equal((await freshDB.prepare('SELECT COUNT(*) AS n FROM collections WHERE user_id=? AND deleted_at IS NULL').bind(ACCOUNT_A).first()).n,50);
    }finally{freshDB.close();}
  });
  await t.test('maximum 5000-card snapshot is accepted atomically; one more addition cannot exceed the cap',async()=>{
    const largeCards=Object.fromEntries(Array.from({length:5001},(_,i)=>[key(10000+i),{game:'pokemon',language:'ja',sourceKey:'fixture:'+i,marketVerified:false}]));
    const largeEnv={...env,ASSETS:{async fetch(request){const path=new URL(request.url).pathname;return Response.json(path.endsWith('/manifest.json')?{schemaVersion:1,version:VERSION}:path.endsWith('/catalog.json')?catalog:{version:VERSION,cards:largeCards});}}};
    const keys=Object.keys(largeCards),result=await call('POST','/api/collections',{id:id(20),title:'5000종 스냅샷',cardKeys:keys.slice(0,5000),catalogVersion:VERSION},{customEnv:largeEnv});
    assert.equal(result.status,201);assert.equal(result.data.collection.cardKeys.length,5000);assert.equal(result.data.collection.revision,1);
    const excess=await call('PUT',`/api/collections/${id(20)}/items`,{expectedRevision:1,addCardKeys:[keys[5000]],catalogVersion:VERSION},{customEnv:largeEnv});assert.equal(excess.status,413);
    const saved=await db.prepare('SELECT revision,json_array_length(items_json) AS n FROM collections WHERE user_id=? AND id=?').bind(ACCOUNT_A,id(20)).first();assert.deepEqual(saved,{revision:1,n:5000});
  });
  await t.test('disabled/read-only/missing binding/schema/failed registry all return503 independently',async()=>{
    assert.equal((await call('GET','/api/collections',undefined,{customEnv:{...env,COLLECTIONS_ENABLED:'0'}})).status,503);
    assert.equal((await call('PATCH',`/api/collections/${id(1)}`,{expectedRevision:3,title:'blocked'},{customEnv:{...env,COLLECTIONS_READ_ONLY:'1'}})).status,503);
    assert.equal((await call('GET','/api/collections',undefined,{customEnv:{...env,DB:null}})).status,503);
    const badAssets={fetch:async()=>new Response('<html>SPA fallback</html>',{headers:{'Content-Type':'text/html'}})};
    assert.equal((await call('GET','/api/collections',undefined,{customEnv:{...env,ASSETS:badAssets}})).status,503);
    const freshDB=new Database();try{await freshDB.script(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT);INSERT INTO users VALUES('${ACCOUNT_A}','a@fixture.invalid');`);assert.equal((await call('GET','/api/collections',undefined,{customEnv:{...env,DB:freshDB,COLLECTIONS_LAZY_SCHEMA:'0'}})).status,503);}finally{freshDB.close();}
  });
  await t.test('collection delete is idempotent, invisible to lists, and preserves manual flags/assets',async()=>{
    const current=(await call('GET',`/api/collections/${id(2)}`)).data.collection;
    const body={expectedRevision:current.revision,mutationId:id(95)};
    const removed=await call('DELETE',`/api/collections/${id(2)}`,body);assert.equal(removed.status,200);
    const retry=await call('DELETE',`/api/collections/${id(2)}`,body);assert.equal(retry.status,200);assert.equal(retry.data.replayed,true);
    assert.equal((await call('GET',`/api/collections/${id(2)}`)).status,404);
    assert((await db.prepare('SELECT manual_owned FROM user_card_states WHERE user_id=? AND card_key=?').bind(ACCOUNT_A,key(2)).first()).manual_owned===1);
    assert.deepEqual((await db.prepare('SELECT * FROM holdings ORDER BY id').all()).results,assetSnapshot);
    assert.deepEqual((await db.prepare('SELECT * FROM transactions ORDER BY id').all()).results,txSnapshot);
  });
  await t.test('account deletion removes all three optional collection tables atomically; preserves other user',async()=>{
    const response=await removeAccount.onRequestPost({request:new Request('https://tcghub.example/api/auth/delete-account',{method:'POST',headers:{Cookie:`session=${tokens[ACCOUNT_A]}`,'Content-Type':'application/json'},body:JSON.stringify({confirm:'DELETE'})}),env});assert.equal(response.status,200);
    for(const table of ['collections','collection_mutations','user_card_states'])assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).bind(ACCOUNT_A).first()).n,0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM collections WHERE user_id=?').bind(ACCOUNT_B).first()).n,1);
    assert.equal((await call('GET','/api/collections')).status,401);
    assert.equal((await call('GET','/api/collections',undefined,{account:ACCOUNT_B})).status,200);
    assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  });
});
