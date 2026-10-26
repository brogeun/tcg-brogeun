import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {verifyAppleIdToken} from '../../functions/_shared/apple.js';

if (!globalThis.crypto) globalThis.crypto=webcrypto;
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'isolated-apple-token-tests',alg:'RS256'};
const originalFetch=globalThis.fetch;
globalThis.fetch=async input=>{
  assert.equal(String(input),'https://appleid.apple.com/auth/keys','only the isolated JWKS fixture is allowed');
  return Response.json({keys:[jwk]});
};
after(()=>{globalThis.fetch=originalFetch;});

async function token(changes={},omit=[]){
  const now=Math.floor(Date.now()/1000);
  const claims={iss:'https://appleid.apple.com',aud:'kr.tcghub.app',sub:'isolated-apple-sub',iat:now,exp:now+600,...changes};
  for(const name of omit)delete claims[name];
  const head=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');
  const body=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const message=head+'.'+body;
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(message));
  return message+'.'+Buffer.from(signature).toString('base64url');
}

test('Apple standard signed token is accepted without requiring an optional email claim',async()=>{
  const claims=await verifyAppleIdToken(await token(),['kr.tcghub.app']);
  assert.equal(claims.sub,'isolated-apple-sub');
});
test('Apple signed verified-email token remains supported',async()=>{
  const claims=await verifyAppleIdToken(await token({email:'owner@audit.invalid',email_verified:true}),['kr.tcghub.app']);
  assert.equal(claims.email,'owner@audit.invalid');
});
for(const [name,changes,omit]of [
  ['missing exp',{},['exp']],
  ['string exp',{exp:'9999999999'},[]],
  ['null exp',{exp:null},[]],
  ['non-finite exp',{exp:Infinity},[]],
  ['missing iat',{},['iat']],
  ['string iat',{iat:'1'},[]],
  ['null iat',{iat:null},[]],
  ['non-finite iat',{iat:Infinity},[]],
  ['numeric sub',{sub:7},[]],
  ['empty sub',{sub:''},[]],
  ['missing sub',{},['sub']],
  ['wrong issuer',{iss:'https://attacker.invalid'},[]],
  ['wrong audience',{aud:'unrelated.app'},[]],
]){
  test('Apple rejects '+name+' after real signature verification',async()=>{
    await assert.rejects(verifyAppleIdToken(await token(changes,omit),['kr.tcghub.app']));
  });
}
test('Apple expiry boundary is rejected without relying on wall-clock timing',async t=>{
  const now=1700000000;t.mock.method(Date,'now',()=>now*1000);
  await assert.rejects(verifyAppleIdToken(await token({exp:now}),['kr.tcghub.app']));
});
test('Apple rejects already expired tokens',async()=>{
  await assert.rejects(verifyAppleIdToken(await token({exp:Math.floor(Date.now()/1000)-60}),['kr.tcghub.app']));
});
test('Apple rejects issue times beyond the established 60-second tolerance',async()=>{
  await assert.rejects(verifyAppleIdToken(await token({iat:Math.floor(Date.now()/1000)+120}),['kr.tcghub.app']));
});
test('Apple rejects a modified RSA signature',async()=>{
  const parts=(await token()).split('.'),signature=Buffer.from(parts[2],'base64url');
  signature[0]^=1;parts[2]=signature.toString('base64url');
  await assert.rejects(verifyAppleIdToken(parts.join('.'),['kr.tcghub.app']));
});
