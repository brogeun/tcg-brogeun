import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const source=readFileSync(new URL('../../functions/api/card-grades.js',import.meta.url),'utf8');
const api=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
async function call(handler){
 const queries=[],saved=[];
 globalThis.caches={default:{match:async()=>null,put:async(k,r)=>saved.push(await r.json())}};
 globalThis.fetch=async(url,options)=>{assert(options.signal,'Upstream request must have a deadline');if(String(url).includes('/apparels/'))throw Error('HTML unavailable');
  const condition=new URL(url).searchParams.get('conditionId');queries.push(condition);return handler(condition);};
 const response=await api.onRequestGet({request:new Request('https://tcghub.kr/api/card-grades?id=12345')});
 return {response,body:await response.json(),queries,saved};
}
const ok=items=>new Response(JSON.stringify({usedListings:items}));
test('raw, PSA10 and PSA9 have independent requests and currencies retain the actual amounts',async()=>{
 const result=await call(c=>ok([{id:c,condition:{18:'A',22:'PSA10',23:'PSA9'}[c],priceAmount:{18:510000,22:10000,23:4500000}[c],currency:{18:'JPY',22:'USD',23:'KRW'}[c],price:'$1'}]));
 assert.deepEqual(result.queries.sort(),['18','22','23']);assert.equal(result.body.grades.raw.lowest_ask,510000);assert.equal(result.body.grades.raw.currency,'JPY');
 assert.equal(result.body.grades.psa10.currency,'USD');assert.equal(result.body.grades.psa9.currency,'KRW');assert.equal(result.saved.length,1);
});
test('all upstream failures never become cached confirmed absences',async()=>{
 const r=await call(()=>new Response('',{status:503}));assert.equal(r.response.status,503);assert.equal(r.body.ok,false);assert.equal(r.saved.length,0);assert.equal(r.response.headers.get('Cache-Control'),'no-store');
});
test('complete empty raw result confirms raw absence independently of PSA failure',async()=>{
 const r=await call(c=>c==='18'?ok([]):new Response('',{status:503}));
 assert.deepEqual(r.body.noListingGrades,['raw']);assert.deepEqual(r.body.unavailableGrades,['psa10','psa9']);assert(r.body.partial);assert.equal(r.response.headers.get('Cache-Control'),'public, max-age=60');
});
test('unreadable active prices do not become absence evidence',async()=>{
 const r=await call(()=>ok([{id:'1',condition:'A',price:'unavailable'}]));assert.equal(r.response.status,503);assert.equal(r.saved.length,0);
});
test('unexpected upstream response shape is a source failure',async()=>{
 const r=await call(()=>new Response('{}'));assert.equal(r.response.status,503);assert.equal(r.saved.length,0);
});
test('confirmed empty API pages preserve per-grade absence evidence',async()=>{
 const r=await call(()=>ok([]));assert.equal(r.body.ok,true);assert.deepEqual(r.body.noListingGrades,['raw','psa10','psa9']);assert.equal(r.response.headers.get('Cache-Control'),'public, max-age=3600');
});
