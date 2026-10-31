import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../../functions/_middleware.js',import.meta.url),'utf8');
const context=vm.createContext({URL,Request,Response,fetch(){throw Error('Unexpected external request');}});
vm.runInContext(source.replace(/^export /gm,''),context);
const file='0123456789abcdef.json';
const body='{\r\n  "cards": [{"id":"123", "name":"돈!!", "price":12345}]\r\n}\r\n';
async function request(path,{method='GET',asset,game='nikke'}={}) {
  const calls=[];let next=0;
  const result=await context.onRequest({request:new Request('https://tcghub.kr'+path,{method}),
    env:{ASSETS:{fetch:async req=>{calls.push(req.url);return asset || Response.json({schemaVersion:1,game,files:{[file]:body}});}}},
    next:async()=>{next++;return new Response('original static response',{status:404});}});
  return {result,calls,next};
}
test('original card URLs return the exact packed bytes and ignore cache-busting queries',async()=>{
  const {result,calls,next}=await request('/data/tcg-card-info/nikke/'+file+'?v=123');
  assert.equal(result.status,200);assert.equal(await result.text(),body);assert.match(result.headers.get('Content-Type'),/application\/json/);
  assert.deepEqual(calls,['https://tcghub.kr/data/tcg-card-info-packs/nikke/0.json']);assert.equal(next,0);
});
test('HEAD preserves JSON headers without returning a body',async()=>{
  const {result}=await request('/data/tcg-card-info/nikke/'+file,{method:'HEAD'});
  assert.equal(result.status,200);assert.equal(await result.text(),'');assert.match(result.headers.get('Content-Type'),/application\/json/);
});
test('a missing pack or HTML fallback retains unpacked publications',async()=>{
  for(const asset of [new Response('missing',{status:404}),new Response('<html>SPA</html>',{headers:{'Content-Type':'text/html'}})]) {
    const {result,next}=await request('/data/tcg-card-info/nikke/'+file,{asset});
    assert.equal(next,1);assert.equal(await result.text(),'original static response');
  }
});
test('wrong-game, invalid and failed packs cannot expose other card data',async()=>{
  for(const asset of [Response.json({schemaVersion:1,game:'yugioh',files:{[file]:body}}),Response.json({schemaVersion:2,game:'nikke'}),new Response('{broken',{headers:{'Content-Type':'application/json'}}),new Response('unavailable',{status:503})]) {
    const {result,next}=await request('/data/tcg-card-info/nikke/'+file,{asset});assert.equal(result.status,503);assert.equal(next,0);
  }
});
test('unlisted files use the normal missing-file path',async()=>{
  const {result,next}=await request('/data/tcg-card-info/nikke/0123456789abcde0.json');assert.equal(next,1);assert.equal(result.status,404);
});
test('native public bundles remain available through the static asset path',async()=>{
  const {calls,next}=await request('/data/tcg-card-info/nikke/public-0000.json');assert.equal(next,1);assert.equal(calls.length,0);
});
test('invalid set paths and write methods never fetch a pack',async()=>{
  for(const path of ['/data/tcg-card-info/nikke/not-a-set.json','/data/tcg-card-info/nikke/0123456789abcdef.json/extra']) {
    const {result,calls}=await request(path);assert.equal(result.status,404);assert.equal(calls.length,0);
  }
  const {result,calls}=await request('/data/tcg-card-info/nikke/'+file,{method:'POST'});assert.equal(result.status,405);assert.equal(calls.length,0);
});
test('robots and unrelated routes retain their original behavior',async()=>{
  const robots=await request('/robots.txt');assert.equal(robots.result.status,200);assert.match(await robots.result.text(),/Sitemap: https:\/\/tcghub.kr\/sitemap.xml/);assert.equal(robots.calls.length,0);
  const ordinary=await request('/api/auth/me');assert.equal(ordinary.next,1);assert.equal(ordinary.calls.length,0);
});
test('legacy Card Info destinations serve HTML without canonicalizing back to home',async()=>{
  for(const path of ['/cardinfo?verify=source','/cardinfo/']) {
    const {result,calls,next}=await request(path,{asset:new Response('<html>TCGHUB</html>',{headers:{'Content-Type':'text/html; charset=utf-8','X-Test-Asset':'preserved'}})});
    assert.equal(result.status,200);assert.equal(await result.text(),'<html>TCGHUB</html>');assert.equal(result.headers.get('Location'),null);
    assert.equal(result.headers.get('X-Test-Asset'),'preserved');assert.equal(next,0);assert.equal(calls[0],path.includes('?')?'https://tcghub.kr/?verify=source':'https://tcghub.kr/');
  }
  const bad=await request('/cardinfo',{asset:new Response('missing',{status:404})});assert.equal(bad.result.status,503);
  const head=await request('/cardinfo',{method:'HEAD',asset:new Response('<html>TCGHUB</html>',{headers:{'Content-Type':'text/html'}})});assert.equal(await head.result.text(),'');assert.equal(head.result.status,200);
});
