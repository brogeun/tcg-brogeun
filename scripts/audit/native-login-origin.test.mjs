import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {onRequestPost as apple} from '../../functions/api/auth/apple/native.js';
import {onRequestPost as google} from '../../functions/api/auth/google/native.js';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'isolated-native-origin-tests',alg:'RS256'};
async function appleToken(){
  const now=Math.floor(Date.now()/1000);
  const head=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');
  const body=Buffer.from(JSON.stringify({iss:'https://appleid.apple.com',aud:'kr.tcghub.app',sub:'isolated-owner',email:'owner@audit.invalid',email_verified:true,iat:now,exp:now+600})).toString('base64url');
  const message=head+'.'+body;
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(message));
  return message+'.'+Buffer.from(signature).toString('base64url');
}
const providers=[['apple',apple],['google',google]];
const rejectionCases=[
  ['missing Content-Type',{},415],
  ['text/plain form',{'Content-Type':'text/plain'},415],
  ['URL-encoded form',{'Content-Type':'application/x-www-form-urlencoded'},415],
  ['JSONP media type',{'Content-Type':'application/jsonp'},415],
  ['ambiguous media type',{'Content-Type':'application/json, text/plain'},415],
  ['foreign Origin',{'Content-Type':'application/json',Origin:'https://attacker.invalid'},403],
  ['null Origin',{'Content-Type':'application/json',Origin:'null'},403],
  ['HTTP Origin',{'Content-Type':'application/json',Origin:'http://tcghub.kr'},403],
  ['cross-site fetch metadata',{'Content-Type':'application/json',Origin:'https://tcghub.kr','Sec-Fetch-Site':'cross-site'},403],
];
for(const [name,handler]of providers){
  for(const [scenario,headers,expected]of rejectionCases){
    test(name+' rejects '+scenario+' before token verification or account access',async t=>{
      let fetches=0,dbCalls=0;
      t.mock.method(globalThis,'fetch',async()=>{fetches++;throw Error('unexpected outbound request');});
      const env={DB:{prepare(){dbCalls++;throw Error('unexpected DB access');}}};
      const request=new Request('https://tcghub.kr/api/auth/'+name+'/native',{method:'POST',headers,body:new TextEncoder().encode('{"idToken":"unused","identityToken":"unused"}')});
      if(scenario==='missing Content-Type')assert.equal(request.headers.get('Content-Type'),null);
      const response=await handler({env,request});
      assert.equal(response.status,expected);
      assert.equal(fetches,0);assert.equal(dbCalls,0);
      assert.equal(response.headers.get('Set-Cookie'),null);
    });
  }
  for(const [scenario,headers]of [
    ['same-origin JSON',{'Content-Type':'application/json',Origin:'https://tcghub.kr','Sec-Fetch-Site':'same-origin'}],
    ['native JSON without Origin',{'Content-Type':'application/json'}],
    ['JSON with charset',{'Content-Type':'Application/JSON; charset=utf-8',Origin:'https://tcghub.kr'}],
  ]){
    test(name+' accepts '+scenario+' with the existing token and session contract',async t=>{
      const selected=[];
      t.mock.method(globalThis,'fetch',async input=>{
        const url=String(input);
        if(url==='https://appleid.apple.com/auth/keys')return Response.json({keys:[jwk]});
        assert.ok(url.startsWith('https://oauth2.googleapis.com/tokeninfo?id_token='),'unexpected outbound request');
        return Response.json({email:'owner@audit.invalid',email_verified:'true',aud:'isolated-google-client',sub:'isolated-google-sub'});
      });
      const DB={prepare(sql){return{bind(...args){return{first:async()=>{selected.push(args[0]);return{id:'owner-user',email:args[0],name:'Local fixture'};},run:async()=>({success:true})};}};}};
      const body=name==='apple'?{identityToken:await appleToken(),user:{email:'victim@audit.invalid'}}:{idToken:'isolated-google-token'};
      const response=await handler({env:{DB,JWT_SECRET:'isolated-native-origin-test-key',APPLE_BUNDLE_ID:'kr.tcghub.app',GOOGLE_CLIENT_ID:'isolated-google-client'},request:new Request('https://tcghub.kr/api/auth/'+name+'/native',{method:'POST',headers,body:JSON.stringify(body)})});
      assert.equal(response.status,200);
      const cookie=response.headers.get('Set-Cookie')||'';
      assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);
      const jwt=cookie.match(/session=([^;]+)/)?.[1];assert.ok(jwt);
      assert.equal(JSON.parse(Buffer.from(jwt.split('.')[1],'base64url').toString()).sub,'owner-user');
      assert.deepEqual(selected,['owner@audit.invalid']);
    });
  }
}
