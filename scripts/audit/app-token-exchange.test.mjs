// Offline SQLite/KV fixtures: credential exchanges never contact a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {onRequestPost as verify} from '../../functions/api/auth/verify.js';
import {onRequestPost as exchange} from '../../functions/api/auth/exchange-code.js';
import {sha256Hex} from '../../functions/_shared/jwt.js';

const origin='https://tcghub.audit.invalid',secret='offline-exchange-regression-secret',verifier='a'.repeat(64);
async function fixture(t){
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  sqlite.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,name TEXT,last_login INTEGER);INSERT INTO users VALUES('existing-account','owner@audit.invalid','Owner',0);CREATE TABLE magic_tokens(token TEXT PRIMARY KEY,email TEXT,expires_at INTEGER,used INTEGER);");
  sqlite.prepare('INSERT INTO magic_tokens VALUES(?,?,?,0)').run('app:'+await sha256Hex(verifier),'owner@audit.invalid',Math.floor(Date.now()/1000)+300);
  const kakaoToken='oauth-kakao:'+await sha256Hex('offline-code');
  sqlite.prepare('INSERT INTO magic_tokens VALUES(?,?,?,0)').run(kakaoToken,'owner@audit.invalid',Math.floor(Date.now()/1000)+300);
  const queries=[],kvCalls=[],store=new Map([['oauth_code:offline-code',{user_id:'existing-account',email:'owner@audit.invalid',name:'Owner',provider:'kakao'}]]);
  const env={JWT_SECRET:secret,DB:{prepare(sql){return {bind(...args){return {
    async first(){queries.push(sql);return sqlite.prepare(sql).get(...args)||null;},
    async run(){queries.push(sql);const r=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(r.changes)}};},
  };}};}},ADMIN_KV:{async get(key){kvCalls.push('get');return store.get(key)||null;},async delete(key){kvCalls.push('delete');store.delete(key);}}};
  return {sqlite,queries,kvCalls,store,env};
}
function request(path,body,headers){return new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...headers},body:JSON.stringify(body)});}
for(const [name,handler,path,body]of [['email verifier',verify,'/api/auth/verify',{verifier}],['Kakao code',exchange,'/api/auth/exchange-code',{code:'offline-code'}]]){
  for(const scenario of [
    {name:'cross-origin JSON',headers:{Origin:'https://foreign.audit.invalid'},status:403},
    {name:'cross-site fetch metadata',headers:{'Sec-Fetch-Site':'cross-site'},status:403},
    {name:'plain text form',headers:{'Content-Type':'text/plain'},status:415},
    {name:'URL encoded form',headers:{'Content-Type':'application/x-www-form-urlencoded'},status:415},
    {name:'JSON-like content type',headers:{'Content-Type':'application/jsonp'},status:415},
  ]){
    test(`${name} refuses ${scenario.name} before reading or consuming credentials`,async t=>{
      const f=await fixture(t),response=await handler({env:f.env,request:request(path,body,scenario.headers)});
      assert.equal(response.status,scenario.status);assert.equal(f.queries.length,0);assert.equal(f.kvCalls.length,0);assert.equal(response.headers.has('set-cookie'),false);
      assert.equal(f.sqlite.prepare('SELECT used FROM magic_tokens').get().used,0);assert.equal(f.store.has('oauth_code:offline-code'),true);
    });
  }
  for(const scenario of [
    {name:'same-origin JSON',headers:{}},
    {name:'native JSON without Origin',headers:{Origin:''}},
    {name:'JSON with charset',headers:{'Content-Type':'application/json; charset=UTF-8'}},
  ]){
    test(`${name} preserves ${scenario.name} and consumes the credential once`,async t=>{
      const f=await fixture(t),response=await handler({env:f.env,request:request(path,body,scenario.headers)});
      assert.equal(response.status,200);assert.equal((await response.json()).ok,true);assert.match(response.headers.get('set-cookie'),/session=/);
      if(name==='email verifier')assert.equal(f.sqlite.prepare('SELECT used FROM magic_tokens').get().used,1);
      else {assert.equal(f.sqlite.prepare('SELECT used FROM magic_tokens WHERE token=?').get('oauth-kakao:'+await sha256Hex('offline-code')).used,1);assert.equal(f.kvCalls.length,0);}
      const repeated=await handler({env:f.env,request:request(path,body,scenario.headers)});
      assert.notEqual(repeated.status,200);assert.equal(repeated.headers.has('set-cookie'),false);
    });
  }
}
