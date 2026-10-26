// Offline regression tests. Provider HTTP and persistent stores are isolated mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {onRequestGet as googleCallback} from '../../functions/api/auth/google/callback.js';
import {onRequestGet as kakaoCallback} from '../../functions/api/auth/kakao/callback.js';
import {onRequestPost as appleNative} from '../../functions/api/auth/apple/native.js';
import {onRequestPost as googleNative} from '../../functions/api/auth/google/native.js';
import {onRequest as scrapeSet} from '../../functions/api/scrape-set.js';
import {getCurrentUser} from '../../functions/_shared/auth.js';
import {signJwt} from '../../functions/_shared/jwt.js';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const origin='https://tcghub.audit.invalid';
const secret='offline-auth-regression-secret';
const envBase={JWT_SECRET:secret,GOOGLE_CLIENT_ID:'audit-client',GOOGLE_CLIENT_SECRET:'audit-client-secret',KAKAO_CLIENT_ID:'audit-kakao-client',APPLE_BUNDLE_ID:'kr.tcghub.app'};
const members=[{id:'signed-user',email:'signed@audit.invalid',name:'Signed'},{id:'body-target',email:'body@audit.invalid',name:'Body'}];
function database(initial=members){
  const rows=new Map(initial.map(row=>[String(row.id),{...row}])),lookups=[],writes=[];
  return {rows,lookups,writes,prepare(sql){return {bind(...args){return {
    async first(){lookups.push({sql,args});if(!/FROM users/.test(sql))throw Error('Unexpected fixture query');return /WHERE email\s*=/.test(sql)?[...rows.values()].find(row=>row.email===args[0])||null:rows.get(String(args[0]))||null;},
    async run(){writes.push({sql,args});return {success:true,meta:{changes:1}};},
  };}};}};
}
function post(path,body,headers={}){return new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...headers},body:JSON.stringify(body)});}
function session(response){const value=response.headers.get('set-cookie')?.match(/(?:^|[;,]\s*)session=([^;]+)/)?.[1];return value?JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString()):null;}

for(const [provider,callback]of [['google',googleCallback],['kakao',kakaoCallback]]){
  test(`${provider} callback escapes untrusted error HTML before any provider or DB access`,async t=>{
    let fetched=0;const DB=database();
    t.mock.method(globalThis,'fetch',async()=>{fetched++;throw Error('Unexpected provider request');});
    const payload='<img src=x onerror="globalThis.untrusted=1">';
    const response=await callback({request:new Request(origin+`/api/auth/${provider}/callback?error=`+encodeURIComponent(payload)),env:{...envBase,DB}});
    const html=await response.text();
    assert.equal(response.status,400);assert.equal(html.includes(payload),false);assert.ok(html.includes('&lt;img'));
    assert.equal(fetched,0);assert.equal(DB.lookups.length,0);assert.equal(session(response),null);
  });
}

const rsa=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',rsa.publicKey),kid:'offline-auth-rsa',alg:'RS256'};
async function appleToken(extra){
  const now=Math.floor(Date.now()/1000),header=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');
  const body=Buffer.from(JSON.stringify({iss:'https://appleid.apple.com',aud:envBase.APPLE_BUNDLE_ID,sub:'signed-apple-sub',iat:now,exp:now+300,...extra})).toString('base64url');
  const message=header+'.'+body,signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',rsa.privateKey,new TextEncoder().encode(message));
  return message+'.'+Buffer.from(signature).toString('base64url');
}
for(const scenario of [
  {label:'missing signed email',claims:{},status:401},
  {label:'explicitly unverified signed email',claims:{email:'body@audit.invalid',email_verified:false},status:401},
  {label:'missing email verification claim',claims:{email:'body@audit.invalid'},status:401},
  {label:'verified signed email wins over body email',claims:{email:'signed@audit.invalid',email_verified:'true'},status:200},
]){
  test(`Apple account selection: ${scenario.label}`,async t=>{
    const DB=database();t.mock.method(globalThis,'fetch',async input=>{assert.equal(String(input),'https://appleid.apple.com/auth/keys');return Response.json({keys:[jwk]});});
    const response=await appleNative({env:{...envBase,DB},request:post('/api/auth/apple/native',{identityToken:await appleToken(scenario.claims),user:{email:'body@audit.invalid'}})});
    assert.equal(response.status,scenario.status);
    if(scenario.status===401){assert.equal(session(response),null);assert.equal(DB.lookups.length,0);assert.equal(DB.writes.length,0);}
    else {assert.equal(session(response).sub,'signed-user');assert.equal(DB.lookups[0].args[0],'signed@audit.invalid');}
  });
}

for(const verified of [undefined,false,true]){
  test(`Google web requires verified email: ${String(verified)}`,async t=>{
    const DB=database();
    t.mock.method(globalThis,'fetch',async input=>{
      const url=String(input);
      if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'offline-access-token'});
      assert.equal(url,'https://openidconnect.googleapis.com/v1/userinfo');
      return Response.json({email:'signed@audit.invalid',email_verified:verified,sub:'signed-google-sub'});
    });
    const response=await googleCallback({env:{...envBase,DB},request:new Request(origin+'/api/auth/google/callback?code=offline-code&state=offline-state',{headers:{Cookie:'g_oauth_state=offline-state'}})});
    assert.equal(response.status,verified===true?302:400);
    if(verified!==true){assert.equal(session(response),null);assert.equal(DB.lookups.length,0);assert.equal(DB.writes.length,0);}
    else assert.equal(session(response).sub,'signed-user');
  });
}
for(const verified of [undefined,false,'true',true]){
  test(`Google native requires verified email: ${String(verified)}`,async t=>{
    const DB=database();
    t.mock.method(globalThis,'fetch',async input=>{assert.ok(String(input).startsWith('https://oauth2.googleapis.com/tokeninfo?'));return Response.json({email:'signed@audit.invalid',email_verified:verified,aud:envBase.GOOGLE_CLIENT_ID,sub:'signed-google-sub'});});
    const response=await googleNative({env:{...envBase,DB},request:post('/api/auth/google/native',{idToken:'offline-google-token'})});
    const allowed=verified===true||verified==='true';assert.equal(response.status,allowed?200:401);
    if(!allowed){assert.equal(session(response),null);assert.equal(DB.lookups.length,0);assert.equal(DB.writes.length,0);}
    else assert.equal(session(response).sub,'signed-user');
  });
}

for(const id of ['legacy-string',123]){
  test(`session checks the current DB user and revokes a deleted ${typeof id} account`,async()=>{
    const DB=database([{id,email:'active@audit.invalid'}]),token=await signJwt({sub:id,email:'stale@audit.invalid',exp:Math.floor(Date.now()/1000)+300},secret);
    const request=new Request(origin+'/api/auth/me',{headers:{Cookie:'session='+token}});
    assert.deepEqual(await getCurrentUser(request,{JWT_SECRET:secret,DB}),{id,email:'active@audit.invalid'});
    DB.rows.delete(String(id));assert.equal(await getCurrentUser(request,{JWT_SECRET:secret,DB}),null);
  });
}
test('forged and expired sessions never reach the user lookup',async()=>{
  const DB=database(),env={JWT_SECRET:secret,DB};
  const expired=await signJwt({sub:'signed-user',exp:1},secret);
  for(const token of ['forged.jwt.value',expired])assert.equal(await getCurrentUser(new Request(origin+'/api/auth/me',{headers:{Cookie:'session='+token}}),env),null);
  assert.equal(DB.lookups.length,0);
});

const admin={id:'admin-fixture',email:'yhk3213@gmail.com'},member={id:'member-fixture',email:'member@audit.invalid'};
const good={code:'M2a',brand:'pokemon',url:'https://www.tcgcollector.com/sets/11678/mega-dream-ex?setCardCountMode=anyCardVariant'};
const image='https://static.tcgcollector.com/content/images/aa/bb/card_500.jpg';
async function scrapeFixture(t,{user=admin,method='POST',headers={},body=good,rawBody,mode='normal'}={}){
  const DB=database([admin,member]),writes=[],fetches=[];
  const env={...envBase,DB,IMAGES:{put:async(key,value)=>{writes.push({key,bytes:typeof value==='string'?value.length:value.byteLength});}}};
  t.mock.method(globalThis,'fetch',async(input,options={})=>{
    const url=String(input);fetches.push({url,redirect:options.redirect});
    if(url.startsWith('https://www.tcgcollector.com/sets/')){
      if(mode==='source-redirect')return new Response(null,{status:302,headers:{Location:'https://foreign.audit.invalid/'}});
      const source=mode==='foreign-image'?'http://127.0.0.1/private.jpg':image;
      return new Response(`<li class="card-image-grid-item"><img src="${source}" alt="Fixture">001/100</li>`,{headers:{'Content-Type':'text/html'}});
    }
    assert.equal(url,image);
    if(mode==='image-redirect')return new Response(null,{status:302,headers:{Location:'https://foreign.audit.invalid/private.jpg'}});
    return new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'image/jpeg'}});
  });
  const token=user?await signJwt({sub:user.id,email:user.email,exp:Math.floor(Date.now()/1000)+300},secret):null;
  const request=new Request(origin+'/api/scrape-set',{method,headers:{Origin:origin,'Content-Type':'application/json',...(token?{Cookie:'session='+token}:{}),...headers},...(method==='GET'?{}:{body:rawBody??JSON.stringify(body)})});
  return {response:await scrapeSet({request,env}),writes,fetches};
}
for(const scenario of [
  {label:'anonymous GET',options:{method:'GET',user:null},status:405},
  {label:'anonymous POST',options:{user:null},status:401},
  {label:'member POST',options:{user:member},status:403},
  {label:'forged admin claim on a member ID',options:{user:{...admin,id:member.id}},status:403},
  {label:'cross-origin',options:{headers:{Origin:'https://foreign.audit.invalid'}},status:403},
  {label:'missing origin',options:{headers:{Origin:''}},status:403},
  {label:'cross-site metadata',options:{headers:{'Sec-Fetch-Site':'cross-site'}},status:403},
  {label:'plain form',options:{headers:{'Content-Type':'text/plain'}},status:415},
  {label:'invalid JSON',options:{rawBody:'{'},status:400},
  {label:'oversized body',options:{body:{...good,padding:'x'.repeat(5000)}},status:413},
  {label:'storage prefix traversal',options:{body:{...good,code:'../M2a'}},status:400},
  {label:'unsupported brand',options:{body:{...good,brand:'private'}},status:400},
]){
  test(`scrape mutation guard rejects ${scenario.label} before network and storage`,async t=>{
    const f=await scrapeFixture(t,scenario.options);assert.equal(f.response.status,scenario.status);assert.equal(f.fetches.length,0);assert.equal(f.writes.length,0);
  });
}
for(const url of ['http://www.tcgcollector.com/sets/11678/mega-dream-ex','https://www.tcgcollector.com.foreign.invalid/sets/11678/mega-dream-ex','https://www.tcgcollector.com@foreign.invalid/sets/11678/mega-dream-ex','https://name@www.tcgcollector.com/sets/11678/mega-dream-ex','https://www.tcgcollector.com:8443/sets/11678/mega-dream-ex','https://www.tcgcollector.com/account']){
  test(`scrape rejects an untrusted source before storage: ${url}`,async t=>{
    const f=await scrapeFixture(t,{body:{...good,url}});assert.equal(f.response.status,400);assert.equal(f.fetches.length,0);assert.equal(f.writes.length,0);
  });
}
for(const [mode,status,fetches]of [['source-redirect',500,1],['foreign-image',400,1],['image-redirect',502,2]]){
  test(`scrape ${mode} never follows a foreign target or replaces the index`,async t=>{
    const f=await scrapeFixture(t,{mode});assert.equal(f.response.status,status);assert.equal(f.fetches.length,fetches);assert.equal(f.writes.length,0);
  });
}
test('an authorized administrator still writes the validated raster and set index',async t=>{
  const f=await scrapeFixture(t);assert.equal(f.response.status,200);assert.equal(f.writes.length,2);assert.deepEqual(f.writes.map(x=>x.key),['pokemon/M2a/cards/001.jpg','pokemon/M2a/index.json']);assert.ok(f.fetches.every(x=>x.redirect==='manual'));
});
