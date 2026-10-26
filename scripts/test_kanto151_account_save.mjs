import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {onRequestGet,onRequestPut} from '../functions/api/games/kanto151-save.js';
import {checkpointDigest,MAX_SAVE_BODY_BYTES,validateSaveBundle} from '../functions/_shared/kanto151-save.js';
import {signJwt} from '../functions/_shared/jwt.js';

// Real SQL and real session signatures, using only synthetic in-memory users.
const SECRET = 'isolated-kanto-account-save-test-secret';
const URL = 'https://account-save.example.test/api/games/kanto151-save';
const NOW = '2026-10-17T00:00:00.000Z';
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec("PRAGMA foreign_keys = ON; CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE); INSERT INTO users VALUES ('pc-user', 'pc-user@example.test'), ('phone-user', 'phone-user@example.test');");
  sqlite.exec(readFileSync(new globalThis.URL('../functions/_schema/kanto151_saves.sql',import.meta.url),'utf8'));
  const calls = [], faults = {sql:null};
  const execute = (sql,args,kind) => {
    calls.push({sql,args:[...args],kind});
    if (faults.sql && sql.includes(faults.sql)) throw Error('private fixture error that must not reach the client');
    const statement = sqlite.prepare(sql);
    if (kind === 'first') return statement.get(...args) ?? null;
    const result = statement.run(...args);
    return {success:true,meta:{changes:Number(result.changes)}};
  };
  const db = {
    prepare(sql) { return {bind(...args) { return {sql,args,first:async()=>execute(sql,args,'first'),run:async()=>execute(sql,args,'run')}; }}; },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(s=>execute(s.sql,s.args,'run')); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return {sqlite,calls,faults,db,env:{JWT_SECRET:SECRET,DB:db},close:()=>sqlite.close()};
}
function save(overrides={}) {
  return {version:3,starter:1,collection:[{uid:'original-pokemon',id:1,level:12,exp:17,hp:46,shiny:true,friendship:52,status:null}],party:['original-pokemon'],dex:{1:{caught:true,seen:true,shinyCaught:true,shinySeen:true}},inventory:{'poke-ball':12,potion:8},coins:1380,region:'verdant',position:[0,10],worldId:'kanto-five-v1',discovered:['verdant','waterside'],bosses:[],flags:{},quests:{},survival:{hunger:85,thirst:90,drops:[]},settings:{volume:0.4,quality:'auto',camera:1,motion:true,locale:'ko-KR'},playTime:1500,worldTime:9,weather:'clear',savedAt:NOW,...overrides};
}
function bundle(value=save(),withCheckpoint=true) {
  const text = JSON.stringify(value);
  return {schema:1,save:text,checkpoint:withCheckpoint?JSON.stringify({schema:1,owner:value.collection[0].uid,kind:'manual',region:value.region,place:'푸른잎 쉼터',savedAt:NOW,snapshot:text,checksum:checkpointDigest(text)}):null};
}
async function request(ctx,{method='GET',user='pc-user',expectedAccount=user,headers={},body,raw,env=ctx.env,exp=Math.floor(Date.now()/1000)+600}={}) {
  const allHeaders = {'Content-Type':'application/json',Origin:new globalThis.URL(URL).origin,...headers};
  if (user) allHeaders.Cookie = 'session='+await signJwt({sub:user,email:user+'@example.test',exp},SECRET);
  if (expectedAccount !== null) allHeaders['X-Kanto151-Account'] = expectedAccount;
  for (const [key,value] of Object.entries(allHeaders)) if (value === null) delete allHeaders[key];
  const req = new Request(URL,{method,headers:allHeaders,...(method==='PUT'?{body:raw??JSON.stringify(body??{expectedRevision:0,bundle:bundle()})}:{} )});
  const response = await (method === 'PUT' ? onRequestPut : onRequestGet)({request:req,env});
  return {response,status:response.status,data:await response.json()};
}
const put = (ctx,revision=0,value=bundle(),options={}) => request(ctx,{method:'PUT',body:{expectedRevision:revision,bundle:value},...options});
const accountRecordCalls = ctx => ctx.calls.filter(({sql}) => /\bkanto151_(?:saves|save_backups)\b/i.test(sql));

test('anonymous, forged and expired sessions never read or write account records',async()=>{
  const ctx=fixture();
  try {
    assert.equal((await request(ctx,{user:null})).status,401);
    assert.equal((await put(ctx,0,bundle(),{user:null})).status,401);
    assert.equal((await request(ctx,{headers:{Cookie:'session=forged.jwt.signature'},user:null})).status,401);
    assert.equal((await request(ctx,{exp:1})).status,401);
    assert.equal(ctx.calls.length,0);
  } finally { ctx.close(); }
});

test('deleted accounts cannot reuse a previously valid JWT to read or recreate saves',async()=>{
  const ctx=fixture();
  try {
    const token=await signJwt({sub:'pc-user',email:'pc-user@example.test',exp:Math.floor(Date.now()/1000)+600},SECRET);
    const options={user:null,expectedAccount:'pc-user',headers:{Cookie:'session='+token}};
    assert.equal((await put(ctx,0,bundle(),options)).status,200);
    assert.equal((await put(ctx,1,bundle(save({coins:2000})),options)).status,200);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM kanto151_save_backups').get().n,1);
    ctx.sqlite.prepare('DELETE FROM users WHERE id = ?').run('pc-user');
    ctx.calls.length=0;
    assert.equal((await request(ctx,options)).status,401);
    assert.equal((await put(ctx,0,bundle(),options)).status,401);
    assert.equal(accountRecordCalls(ctx).length,0);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM kanto151_saves').get().n,0);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM kanto151_save_backups').get().n,0);
  } finally { ctx.close(); }
});

test('expected-account header catches account changes and cannot select another account',async()=>{
  const ctx=fixture();
  try {
    assert.equal((await request(ctx,{expectedAccount:null})).data.error,'account-required');
    for (const method of ['GET','PUT']) {
      const result=await request(ctx,{method,user:'phone-user',expectedAccount:'pc-user'});
      assert.equal(result.status,409);assert.equal(result.data.error,'account-changed');
    }
    assert.equal(accountRecordCalls(ctx).length,0);
    await put(ctx,0,bundle(),{body:{expectedRevision:0,bundle:bundle(),userId:'phone-user'}});
    assert.equal((await request(ctx,{user:'phone-user'})).data.record,null);
  } finally { ctx.close(); }
});

test('GET is private, no-store and account-scoped; device-independent sessions preserve raw bytes',async()=>{
  const ctx=fixture();
  try {
    const initial=await request(ctx);assert.deepEqual(initial.data,{ok:true,record:null});
    const original=bundle();original.save='\n'+original.save+'\n';
    const written=await put(ctx,0,original);assert.equal(written.status,200);assert.equal(written.data.record.revision,1);
    const phone=await request(ctx,{headers:{'User-Agent':'synthetic-phone'}});
    assert.equal(phone.status,200);assert.deepEqual(phone.data.record.bundle,original);
    assert.equal(phone.response.headers.get('Cache-Control'),'no-store');
    assert(!phone.response.headers.has('Access-Control-Allow-Origin'));
    assert.equal((await request(ctx,{user:'phone-user'})).data.record,null);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM kanto151_saves').get().n,1);
  } finally { ctx.close(); }
});

test('writes reject missing/cross origins, cross-site requests and non-JSON content',async()=>{
  const ctx=fixture();
  try {
    for (const headers of [{Origin:null},{Origin:'https://other.example.test'},{'Sec-Fetch-Site':'cross-site'}]) assert.equal((await put(ctx,0,bundle(),{headers})).status,403);
    assert.equal((await put(ctx,0,bundle(),{headers:{'Content-Type':'text/plain'}})).status,415);
    assert.equal(accountRecordCalls(ctx).length,0);
  } finally { ctx.close(); }
});

test('empty phone games cannot create a record or replace existing Pokémon',async()=>{
  const ctx=fixture();
  try {
    const blank=bundle(save({starter:null,party:[],collection:[],dex:{}}),false);
    assert.equal((await put(ctx,0,blank)).status,400);
    const original=bundle();await put(ctx,0,original);
    for(const invalid of [blank,bundle(save({starter:1,party:[]}),false),bundle(save({starter:1,collection:[]}),false),bundle(save({starter:null}),false)]) assert.equal((await put(ctx,1,invalid)).status,400);
    const stored=(await request(ctx)).data.record;assert.equal(stored.revision,1);assert.deepEqual(stored.bundle,original);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM kanto151_save_backups').get().n,0);
  } finally { ctx.close(); }
});

test('versions 2/3 work without rewriting original snapshots; Johto and unsupported data do not',()=>{
  for(const version of [2,3]) {
    const value=bundle(save({version}),false);assert.deepEqual(validateSaveBundle(value),value);
  }
  for(const changes of [{version:1},{version:4},{worldId:'johto-season-2'},{region:'dawn'},{collection:[{...save().collection[0],id:152}]},{collection:[{...save().collection[0],level:101}]}]) assert.throws(()=>validateSaveBundle(bundle(save(changes),false)));
});

test('duplicate Pokémon, broken parties, invalid levels/HP/XP and nonfinite numbers are rejected',async()=>{
  const ctx=fixture();
  try {
    const pokemon=save().collection[0];
    const cases=[{collection:[pokemon,pokemon]},{party:['missing']},{party:[pokemon.uid,pokemon.uid]},{collection:[{...pokemon,hp:-1}]},{collection:[{...pokemon,hp:null}]},{collection:[{...pokemon,exp:-1}]},{collection:[{...pokemon,level:0}]},{collection:[{...pokemon,uid:'bad/uid'}]},{survival:{hunger:101,thirst:100,drops:[]}},{position:[null,0]},{coins:-1},{dex:{152:{caught:true}}}];
    for(const changes of cases) assert.equal((await put(ctx,0,bundle(save(changes),false))).status,400);
    const overflow=bundle();overflow.save=overflow.save.replace('"coins":1380','"coins":1e999');assert.equal((await put(ctx,0,overflow)).status,400);
    assert.equal(accountRecordCalls(ctx).length,0);
  } finally { ctx.close(); }
});

test('recovery checksum, owner and import identity are validated with no repair',async()=>{
  const ctx=fixture();
  try {
    for(const change of [r=>r.checksum='wrong',r=>r.owner='other-owner',r=>r.region='waterside',r=>r.savedAt='invalid',r=>{const s=JSON.parse(r.snapshot);s.checkpointId='other-import';r.snapshot=JSON.stringify(s);r.checksum=checkpointDigest(r.snapshot);},r=>{const s=JSON.parse(r.snapshot);s.collection[0].uid='different';s.party=['different'];r.snapshot=JSON.stringify(s);r.checksum=checkpointDigest(r.snapshot);},r=>{r.snapshot=r.snapshot.replace('"hp":46','"hp":-1');r.checksum=checkpointDigest(r.snapshot);}]) {
      const value=bundle(),checkpoint=JSON.parse(value.checkpoint);change(checkpoint);value.checkpoint=JSON.stringify(checkpoint);
      assert.equal((await put(ctx,0,value)).status,400);
    }
    assert.equal(accountRecordCalls(ctx).length,0);
  } finally { ctx.close(); }
});

test('malformed JSON, invalid revisions and byte limits reject before any database write',async()=>{
  const ctx=fixture();
  try {
    assert.equal((await put(ctx,0,bundle(),{raw:'{broken'})).status,400);
    for(const revision of [-1,0.5,null,'1',Number.MAX_SAFE_INTEGER]) assert.equal((await put(ctx,revision)).status,400);
    const huge=' '.repeat(MAX_SAVE_BODY_BYTES+1);
    assert.equal((await put(ctx,0,bundle(),{raw:huge})).status,413);
    assert.equal((await put(ctx,0,bundle(),{headers:{'Content-Length':String(MAX_SAVE_BODY_BYTES+1)}})).status,413);
    assert.equal(accountRecordCalls(ctx).length,0);
  } finally { ctx.close(); }
});

test('initial creation cannot overwrite an existing server record',async()=>{
  const ctx=fixture();
  try {
    const original=bundle();await put(ctx,0,original);
    const result=await put(ctx,0,bundle(save({coins:9999})));
    assert.equal(result.status,409);assert.equal(result.data.error,'conflict');assert.deepEqual(result.data.record.bundle,original);assert.equal(result.data.record.revision,1);
  } finally { ctx.close(); }
});

test('simultaneous initial uploads and updates have one winner, with exact previous backups',async()=>{
  const ctx=fixture();
  try {
    const initial=await Promise.all([put(ctx,0,bundle(save({coins:100}))),put(ctx,0,bundle(save({coins:200})))]);
    assert.deepEqual(initial.map(r=>r.status).sort(),[200,409]);
    const prior=(await request(ctx)).data.record;
    const concurrent=await Promise.all([put(ctx,1,bundle(save({coins:300}))),put(ctx,1,bundle(save({coins:400})))]);
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
    const stored=(await request(ctx)).data.record;assert.equal(stored.revision,2);
    const backups=ctx.sqlite.prepare('SELECT * FROM kanto151_save_backups').all();assert.equal(backups.length,1);assert.equal(backups[0].revision,1);assert.deepEqual(JSON.parse(backups[0].bundle_json),prior.bundle);
    assert.deepEqual(concurrent.find(r=>r.status===409).data.record,stored);
  } finally { ctx.close(); }
});

test('all previous revisions remain available, and a failed transaction rolls its backup back',async()=>{
  const ctx=fixture();
  try {
    for(let revision=0;revision<13;revision++) assert.equal((await put(ctx,revision,bundle(save({coins:100+revision})))).status,200);
    assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM kanto151_save_backups').get().n,12);
    const prior=(await request(ctx)).data.record;ctx.faults.sql='UPDATE kanto151_saves';
    const failed=await put(ctx,13,bundle(save({coins:9999})));assert.equal(failed.status,503);assert(!JSON.stringify(failed.data).includes('private fixture'));
    ctx.faults.sql=null;
    assert.deepEqual((await request(ctx)).data.record,prior);assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) AS n FROM kanto151_save_backups').get().n,12);
  } finally { ctx.close(); }
});

test('unconfigured/missing schema/unreadable records fail closed without exposing internals',async()=>{
  const ctx=fixture();
  try {
    assert.equal((await request(ctx,{env:{...ctx.env,JWT_SECRET:''}})).status,503);
    assert.equal((await request(ctx,{env:{...ctx.env,DB:null}})).status,503);
    assert.equal((await request(ctx,{env:{...ctx.env,DB:{}}})).status,503);
    assert.equal((await put(ctx,0,bundle(),{env:{...ctx.env,DB:null}})).status,503);
    await put(ctx);ctx.sqlite.prepare('UPDATE kanto151_saves SET bundle_json = ?').run('{broken');
    assert.equal((await request(ctx)).status,503);
    ctx.sqlite.exec('DROP TABLE kanto151_saves');const missing=await request(ctx);assert.equal(missing.status,503);assert(!JSON.stringify(missing.data).includes('kanto151_saves'));
  } finally { ctx.close(); }
});
