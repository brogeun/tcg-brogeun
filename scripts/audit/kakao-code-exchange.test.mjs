// Actual handlers and SQLite; provider and legacy KV are isolated fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {onRequestPost as exchange} from '../../functions/api/auth/exchange-code.js';
import {onRequestGet as callback} from '../../functions/api/auth/kakao/callback.js';
import {onRequestPost as deleteAccount} from '../../functions/api/auth/delete-account.js';
import {sha256Hex, signJwt, verifyJwt} from '../../functions/_shared/jwt.js';

const origin='https://tcghub.audit.invalid',secret='offline-kakao-exchange-secret',code='offline-code';
const now=()=>Math.floor(Date.now()/1000);
const req=(body={code},headers={})=>new Request(origin+'/api/auth/exchange-code',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...headers},body:JSON.stringify(body)});
const exchangeRequest=env=>exchange({env,request:req()});
async function fixture(t,{nameColumn=true,email='owner@audit.invalid',seed=true}={}) {
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  sqlite.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT${nameColumn?',name TEXT':''},last_login INTEGER);CREATE TABLE magic_tokens(token TEXT PRIMARY KEY,email TEXT,expires_at INTEGER,used INTEGER);`);
  sqlite.prepare(`INSERT INTO users(id,email${nameColumn?',name':''},last_login) VALUES(?,?${nameColumn?',?':''},0)`).run('account',email,...(nameColumn?['Current owner']:[]));
  const token='oauth-kakao:'+await sha256Hex(code),queries=[],kvCalls=[];
  const f={sqlite,token,queries,kvCalls,intercept:null,failDB:false,dbClock:now};
  sqlite.function('unixepoch',()=>f.dbClock());
  const invoke=(sql,args,mode)=>{
    queries.push(sql);if(f.failDB)throw Error('offline database failure');f.intercept?.(sql,args);
    const s=sqlite.prepare(sql);
    if(mode==='first')return s.get(...args)||null;
    if(mode==='all')return {results:s.all(...args)};
    const r=s.run(...args);return {success:true,meta:{changes:Number(r.changes)}};
  };
  const statement=(sql,args=[])=>({bind(...bound){return statement(sql,bound)},async first(){return invoke(sql,args,'first')},async all(){return invoke(sql,args,'all')},async run(){return invoke(sql,args,'run')},_run(){return invoke(sql,args,'run')}});
  f.legacyValue={user_id:'account',email:'old-untrusted@audit.invalid',name:'Old untrusted',provider:'wrong'};
  f.legacyExpiration=now()+120;
  f.env={JWT_SECRET:secret,KAKAO_CLIENT_ID:'offline-client',DB:{prepare:statement,async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>s._run());sqlite.exec('COMMIT');return results}catch(e){sqlite.exec('ROLLBACK');throw e}}},ADMIN_KV:{async get(key){kvCalls.push(['get',key]);return f.legacyValue},async list(options){kvCalls.push(['list',options]);return {keys:[{name:'oauth_code:'+code,expiration:f.legacyExpiration}],list_complete:true}},async delete(key){kvCalls.push(['delete',key]);/* Deliberately stale replica: reads continue returning the value. */}}};
  if(seed)sqlite.prepare('INSERT INTO magic_tokens VALUES(?,?,?,0)').run(token,email,now()+300);
  return f;
}
async function assertRejected(response,status=401){assert.equal(response.status,status);assert.equal((await response.json()).ok,false);assert.equal(response.headers.has('set-cookie'),false)}

test('one D1 code has exactly one winner under simultaneous exchanges, without KV',async t=>{
  const f=await fixture(t);delete f.env.ADMIN_KV;
  const responses=await Promise.all([exchangeRequest(f.env),exchangeRequest(f.env)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);assert.equal(responses.filter(r=>r.headers.has('set-cookie')).length,1);
  assert.equal(f.sqlite.prepare('SELECT used FROM magic_tokens WHERE token=?').get(f.token).used,1);assert.equal(f.kvCalls.length,0);
});
test('used D1 rows cannot be regenerated from a stale legacy KV value',async t=>{
  const f=await fixture(t);f.sqlite.prepare('UPDATE magic_tokens SET used=1').run();await assertRejected(await exchangeRequest(f.env));assert.equal(f.kvCalls.length,0);
});
test('actual account deletion invalidates remaining D1 and stale KV login codes',async t=>{
  const f=await fixture(t),jwt=await signJwt({sub:'account',email:'owner@audit.invalid',exp:now()+60},secret);
  const response=await deleteAccount({env:f.env,request:new Request(origin+'/api/auth/delete-account',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'session='+jwt},body:'{"confirm":"DELETE"}'})});
  assert.equal(response.status,200);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM users').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM magic_tokens').get().n,0);
  await assertRejected(await exchangeRequest(f.env));assert.equal(f.sqlite.prepare('SELECT count(*) n FROM magic_tokens').get().n,0);
});
test('canonical database identity replaces stale KV email, name and provider',async t=>{
  const f=await fixture(t,{seed:false});const response=await exchangeRequest(f.env),body=await response.json();
  assert.equal(response.status,200);assert.deepEqual(body.user,{id:'account',email:'owner@audit.invalid',name:'Current owner',provider:'kakao'});
  const jwt=response.headers.get('set-cookie').match(/^session=([^;]+)/)[1];assert.equal((await verifyJwt(jwt,secret)).email,'owner@audit.invalid');
});
test('legacy users without an optional name column remain supported',async t=>{
  const f=await fixture(t,{nameColumn:false,seed:false});const response=await exchangeRequest(f.env);assert.equal(response.status,200);assert.equal((await response.json()).user.name,null);
});
for(const expiry of ['past','boundary'])test(`D1 ${expiry} expiration is rejected`,async t=>{
  const f=await fixture(t);f.sqlite.prepare('UPDATE magic_tokens SET expires_at=?').run(now()-(expiry==='past'?1:0));await assertRejected(await exchangeRequest(f.env));assert.equal(f.kvCalls.length,0);
});
test('expiration reached while storage calls are pending cannot be claimed using request-start time',async t=>{
  const f=await fixture(t),expiration=now()+100;f.sqlite.prepare('UPDATE magic_tokens SET expires_at=?').run(expiration);
  f.intercept=sql=>{if(sql.startsWith('UPDATE magic_tokens SET used'))f.dbClock=()=>expiration};
  await assertRejected(await exchangeRequest(f.env));assert.equal(f.sqlite.prepare('SELECT used FROM magic_tokens').get().used,0);
});
test('legacy grace preserves original expiration and atomically consumes one D1 record',async t=>{
  const f=await fixture(t,{seed:false});const original=f.legacyExpiration;
  const responses=await Promise.all([exchangeRequest(f.env),exchangeRequest(f.env)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);
  assert.deepEqual({...f.sqlite.prepare('SELECT email,expires_at,used FROM magic_tokens WHERE token=?').get(f.token)},{email:'owner@audit.invalid',expires_at:original,used:1});
  await assertRejected(await exchangeRequest(f.env));
});
for(const kind of ['missing-expiration','expired','future-extension','neighbor-key'])test(`legacy grace refuses ${kind}`,async t=>{
  const f=await fixture(t,{seed:false});
  f.env.ADMIN_KV.list=async()=>({keys:[{name:'oauth_code:'+code+(kind==='neighbor-key'?'-other':''),expiration:kind==='missing-expiration'?undefined:kind==='expired'?now()-1:kind==='future-extension'?now()+301:f.legacyExpiration}]});
  await assertRejected(await exchangeRequest(f.env));assert.equal(f.sqlite.prepare('SELECT count(*) n FROM magic_tokens').get().n,0);
});
test('legacy KV metadata failure fails closed without issuing a session',async t=>{
  const f=await fixture(t,{seed:false});f.env.ADMIN_KV.list=async()=>{throw Error('offline list failure')};await assertRejected(await exchangeRequest(f.env),503);
});
test('D1 read failure cannot fall back to non-atomic legacy KV',async t=>{
  const f=await fixture(t);f.failDB=true;await assertRejected(await exchangeRequest(f.env),503);assert.equal(f.kvCalls.length,0);
});
test('account disappearing at the atomic claim cannot receive a session',async t=>{
  const f=await fixture(t);f.intercept=sql=>{if(sql.startsWith('UPDATE magic_tokens SET used'))f.sqlite.prepare('DELETE FROM users WHERE id=?').run('account')};
  await assertRejected(await exchangeRequest(f.env));assert.equal(f.sqlite.prepare('SELECT used FROM magic_tokens').get().used,0);
});
for(const kind of ['missing-db','missing-secret','oversized-code'])test(`${kind} is rejected before storage`,async t=>{
  const f=await fixture(t);if(kind==='missing-db')delete f.env.DB;if(kind==='missing-secret')delete f.env.JWT_SECRET;
  const response=await exchange({env:f.env,request:req({code:kind==='oversized-code'?'x'.repeat(257):code})});await assertRejected(response,kind==='oversized-code'?400:503);assert.equal(f.queries.length,0);assert.equal(f.kvCalls.length,0);
});
function mockProvider(t){
  const previous=globalThis.fetch,calls=[];t.after(()=>globalThis.fetch=previous);
  globalThis.fetch=async url=>{calls.push(String(url));if(String(url)==='https://kauth.kakao.com/oauth/token')return Response.json({access_token:'offline-provider-token'});assert.equal(String(url),'https://kapi.kakao.com/v2/user/me');return Response.json({id:42,kakao_account:{profile:{nickname:'Provider nickname'}}})};return calls;
}
const callbackRequest=isApp=>new Request(origin+'/api/auth/kakao/callback?code=offline-provider-code&state=offline-state',{headers:{Cookie:'k_oauth_state=offline-state'+(isApp?'; k_oauth_app=1':'')}});
test('actual app callback writes hashed D1 code, supports missing KV and exchanges once',async t=>{
  const f=await fixture(t,{email:'kakao_42@tcghub.kr',seed:false});delete f.env.ADMIN_KV;const calls=mockProvider(t);
  const response=await callback({env:f.env,request:callbackRequest(true)}),html=await response.text();assert.equal(response.status,200);
  const raw=html.match(/kr\.tcghub\.app:\/\/kakao-callback\?code=([a-f0-9-]+)/)?.[1];assert(raw);
  const expected='oauth-kakao:'+await sha256Hex(raw),row=f.sqlite.prepare('SELECT token,email,expires_at,used FROM magic_tokens').get();assert.equal(row.token,expected);assert.equal(row.email,'kakao_42@tcghub.kr');assert.equal(row.used,0);assert(row.expires_at>now()&&row.expires_at<=now()+300);
  const first=await exchange({env:f.env,request:req({code:raw})});assert.equal(first.status,200);assert.equal((await first.json()).user.email,'kakao_42@tcghub.kr');await assertRejected(await exchange({env:f.env,request:req({code:raw})}));assert.equal(calls.length,2);
});
test('app callback accepts legacy users tables without an optional name column',async t=>{
  const f=await fixture(t,{email:'kakao_42@tcghub.kr',nameColumn:false,seed:false});mockProvider(t);
  const response=await callback({env:f.env,request:callbackRequest(true)});assert.equal(response.status,200);assert.match(await response.text(),/kakao-callback\?code=/);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM magic_tokens').get().n,1);
});
test('account deleted before callback code insertion cannot receive an app code',async t=>{
  const f=await fixture(t,{email:'kakao_42@tcghub.kr',seed:false});mockProvider(t);f.intercept=sql=>{if(sql.startsWith('INSERT INTO magic_tokens'))f.sqlite.prepare('DELETE FROM users WHERE id=?').run('account')};
  const response=await callback({env:f.env,request:callbackRequest(true)});assert.equal(response.status,400);assert.equal((await response.text()).includes('kakao-callback?code='),false);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM magic_tokens').get().n,0);
});
test('browser Kakao callback retains cookie redirect without an app code',async t=>{
  const f=await fixture(t,{email:'kakao_42@tcghub.kr',seed:false});mockProvider(t);const response=await callback({env:f.env,request:callbackRequest(false)});
  assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/?login=success');assert.match(response.headers.get('set-cookie'),/session=/);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM magic_tokens').get().n,0);assert.equal(f.kvCalls.length,0);
});
