// Real in-memory SQLite transaction checks; never uses an operator or live account.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {onRequestPost as deleteAccount} from '../../functions/api/auth/delete-account.js';
import {getCurrentUser} from '../../functions/_shared/auth.js';
import {signJwt} from '../../functions/_shared/jwt.js';

const secret='offline-delete-regression-secret';
const owned=['holdings','transactions','watchlists','psa_certs','bgs_certs','cert_registration_requests'];
function fixture(t,{features=true,failTable=null}={}){
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  sqlite.exec("CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT); INSERT INTO users VALUES('account-owner','owner@audit.invalid'),('unrelated-user','other@audit.invalid'); CREATE TABLE magic_tokens(token TEXT,email TEXT); INSERT INTO magic_tokens VALUES('owner-token','owner@audit.invalid'),('other-token','other@audit.invalid');");
  if(features)for(const table of owned)sqlite.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY,user_id TEXT); INSERT INTO ${table} VALUES(1,'account-owner'),(2,'unrelated-user');`);
  const db={prepare(sql){let args=[];return {bind(...values){args=values;return this;},
    async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},
    run(){if(failTable&&sql.startsWith('DELETE FROM '+failTable+' '))throw Error('Injected transaction failure');const result=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}};},
  };},async batch(statements){sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  return {sqlite,env:{JWT_SECRET:secret,DB:db},ownerCount:table=>Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table==='magic_tokens'?'email':'user_id'}=?`).get(table==='magic_tokens'?'owner@audit.invalid':'account-owner').n)};
}
async function request(){const token=await signJwt({sub:'account-owner',email:'owner@audit.invalid',exp:Math.floor(Date.now()/1000)+300},secret);return new Request('https://tcghub.audit.invalid/api/auth/delete-account',{method:'POST',headers:{Origin:'https://tcghub.audit.invalid','Content-Type':'application/json',Cookie:'session='+token},body:JSON.stringify({confirm:'DELETE'})});}

test('account deletion removes owned BGS/PSA/request/login data and invalidates the issued session',async t=>{
  const f=fixture(t),req=await request();assert.equal((await getCurrentUser(req,f.env))?.id,'account-owner');
  const response=await deleteAccount({request:req,env:f.env});assert.equal(response.status,200);assert.equal((await response.json()).ok,true);
  assert.match(response.headers.get('set-cookie'),/Max-Age=0/);
  for(const table of [...owned,'magic_tokens'])assert.equal(f.ownerCount(table),0,table);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE id=?').get('account-owner').n,0);
  for(const table of owned)assert.equal(f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get('unrelated-user').n,1,'must preserve another user: '+table);
  assert.equal(await getCurrentUser(await request(),f.env),null);
});
test('an intermediate delete failure rolls the complete batch back and does not claim success',async t=>{
  const f=fixture(t,{failTable:'holdings'}),response=await deleteAccount({request:await request(),env:f.env});assert.equal(response.status,500);assert.equal((await response.json()).ok,false);
  for(const table of [...owned,'magic_tokens'])assert.equal(f.ownerCount(table),1,table);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE id=?').get('account-owner').n,1);
  assert.equal((await getCurrentUser(await request(),f.env))?.id,'account-owner');
});
test('older installations without optional feature tables still delete their account atomically',async t=>{
  const f=fixture(t,{features:false}),response=await deleteAccount({request:await request(),env:f.env});assert.equal(response.status,200);assert.equal(f.ownerCount('magic_tokens'),0);assert.equal(await getCurrentUser(await request(),f.env),null);
});
test('a missing transaction implementation fails closed before changing records',async()=>{
  const response=await deleteAccount({request:await request(),env:{JWT_SECRET:secret,DB:{prepare(){throw Error('Must not be reached');}}}});assert.equal(response.status,503);
});
