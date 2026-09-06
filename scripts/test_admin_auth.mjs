import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onRequestPost, onRequestGet } from '../functions/api/admin.js';
import { onRequestGet as me } from '../functions/api/auth/me.js';
import { signJwt } from '../functions/_shared/jwt.js';

// All identities, signing keys, DB rows and writes below are isolated test fixtures.
const master = {id:'test-admin',email:'yhk3213@gmail.com'};
const member = {id:'test-member',email:'member@example.test'};
const secret = 'local-test-only-secret-not-a-production-credential';
const rows = new Map([master,member].map(u=>[u.id,u]));
const writes=[];
const env={JWT_SECRET:secret,DB:{prepare(){return {bind(id){return {first:async()=>rows.get(id)||null};}};}},ADMIN_KV:{get:async()=>[],put:async(...args)=>writes.push(args)}};
const token=async(user,exp=Math.floor(Date.now()/1000)+600)=>signJwt({sub:user.id,email:user.email,exp},secret);
async function request(user,options={}) {
 const headers={'Content-Type':'application/json',Origin:'https://tcghub.kr',...options.headers};
 if(user)headers.Cookie='session='+await token(user,options.exp);
 const r=await onRequestPost({env:options.env||env,request:new Request('https://tcghub.kr/api/admin',{method:'POST',headers,body:options.body||JSON.stringify({type:'events',items:[{id:'fixture',title:'test'}]})})});
 return r;
}
assert.equal((await request(null)).status,401);
assert.equal((await request(null,{headers:{'X-Admin-Password':'legacy'}})).status,401);
assert.equal((await request(member)).status,403);
assert.equal((await request({...master,id:member.id})).status,403,'DB identity must agree');
assert.equal((await request(master,{exp:1})).status,401);
assert.equal((await request(null,{headers:{Cookie:'session=forged.jwt.signature'}})).status,401);
assert.equal((await request(master,{headers:{Origin:'https://attacker.example'}})).status,403);
assert.equal((await request(master,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
assert.equal((await request(master,{headers:{'Content-Type':'text/plain'}})).status,415);
assert.equal((await request(master,{env:{...env,JWT_SECRET:''}})).status,503);
assert.equal((await request(master,{env:{...env,DB:null}})).status,403);
assert.equal((await request(master,{body:'{invalid'})).status,400);
assert.equal((await request(master,{body:JSON.stringify({type:'unknown',items:[]})})).status,400);
assert.equal((await request(master,{body:JSON.stringify({type:'events',items:Array(501).fill({})})})).status,413);
assert.equal(writes.length,0,'rejected requests cannot write');
for(const type of ['events','etc','cardshow','grading','news']){
 const r=await request(master,{body:JSON.stringify({type,items:[{id:'fixture',title:'test'}]})});assert.equal(r.status,200);
 assert.equal(writes.at(-1)[0],'admin_'+type);
}
for(const user of [null,member,master]){
 const headers=user?{Cookie:'session='+await token(user)}:{};
 const result=await me({env,request:new Request('https://tcghub.kr/api/auth/me',{headers})}).then(r=>r.json());
 assert.equal(result.user?.isAdmin===true,user===master);
}
rows.delete(master.id);
assert.equal((await request(master)).status,403,'deleted admin rejected');
assert.equal((await onRequestGet({env,request:new Request('https://tcghub.kr/api/admin?type=events')})).status,200,'public news readable');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
assert(!html.includes("localStorage.setItem('admin_enabled'"));
assert(html.includes('CURRENT_USER?.isAdmin === true'));
const save=html.slice(html.indexOf('async function saveAdminData'),html.indexOf('let NEWS_LIST'));
assert(!save.includes('X-Admin-Password')&&!save.includes('prompt('));
assert(save.includes("credentials: 'include'"));
const workflow=readFileSync(new URL('../.github/workflows/scrape.yml',import.meta.url),'utf8');
assert(workflow.includes('auth.js apple.js admin.js; do'),'deploy includes new auth helper');
console.log('PASS: admin session authorization, identity, expiry, CSRF, public reads, five board writes, role response, deployment helper');
