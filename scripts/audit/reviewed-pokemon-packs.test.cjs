'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const source=fs.readFileSync(path.join(root,'functions/_middleware.js'),'utf8');
const png=Buffer.from('exact original PNG bytes'),jpg=Buffer.from('exact original JPEG bytes');
const image=(bytes,type)=>({bytes:bytes.length,sha256:'a'.repeat(64),contentType:type,data:bytes.toString('base64')});
const makePack=()=>({schemaVersion:2,bucketSize:64,setCode:'reviewed-contents',bucket:'originals',
  files:{'dp-grass.png':image(png,'image/png'),'legend-water.jpg':image(jpg,'image/jpeg')}});
let moduleId=0;
async function runtime(){return import('data:text/javascript;base64,'+Buffer.from(source+'\n// test '+(++moduleId)).toString('base64'));}
function context(url,{method='GET',headers={},pack=makePack(),status=200}={}){
  let reads=0,fallback=0;
  return {request:new Request('https://example.test'+url,{method,headers}),
    env:{ASSETS:{fetch:async request=>{
      reads++;assert.equal(new URL(request.url).pathname,'/data/pokemon-vintage-packs-v2/reviewed-contents/originals.json');
      return new Response(JSON.stringify(pack),{status,headers:{'Content-Type':'application/json'}});
    }}},next:()=>{fallback++;return new Response('existing raw image');},
    reads:()=>reads,fallback:()=>fallback};
}
test('reviewed images retain exact original bytes, types and URLs while sharing one bounded pack',async()=>{
  const {onRequest}=await runtime(),ctx=context('/images/pokemon-contained/dp-grass.png');
  const response=await onRequest(ctx);assert.equal(response.status,200);
  assert.equal(response.headers.get('Content-Type'),'image/png');
  assert.equal(response.headers.get('Content-Length'),String(png.length));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  const second={...ctx,request:new Request('https://example.test/images/pokemon-contained/legend-water.jpg')};
  const other=await onRequest(second);assert.equal(other.headers.get('Content-Type'),'image/jpeg');
  assert.deepEqual(Buffer.from(await other.arrayBuffer()),jpg);assert.equal(ctx.reads(),1);
  const routes=JSON.parse(fs.readFileSync(path.join(root,'_routes.json'),'utf8'));
  assert(routes.include.includes('/images/pokemon-contained/*'));assert(routes.include.includes('/images/pokemon-vintage/*'));
});
test('reviewed image HEAD, conditional caching and invalid requests preserve response boundaries',async()=>{
  const {onRequest}=await runtime(),ctx=context('/images/pokemon-contained/dp-grass.png',{method:'HEAD'});
  const head=await onRequest(ctx);assert.equal(head.status,200);assert.equal(await head.text(),'');
  const cached=await onRequest({...ctx,request:new Request('https://example.test/images/pokemon-contained/dp-grass.png',
    {headers:{'If-None-Match':head.headers.get('ETag')}})});
  assert.equal(cached.status,304);
  assert.equal((await onRequest(context('/images/pokemon-contained/unknown.png'))).status,404);
  assert.equal((await onRequest(context('/images/pokemon-contained/unsafe/extra.png'))).status,404);
  const post=context('/images/pokemon-contained/dp-grass.png',{method:'POST'});
  assert.equal((await onRequest(post)).status,405);assert.equal(post.reads(),0);
});
test('missing packs preserve raw-image compatibility while corrupt packs fail and allow a bounded retry',async()=>{
  const {onRequest}=await runtime(),missing=context('/images/pokemon-contained/dp-grass.png',{status:404});
  assert.equal(await (await onRequest(missing)).text(),'existing raw image');assert.equal(missing.fallback(),1);
  const {onRequest:retry}=await runtime(),bad=context('/images/pokemon-contained/dp-grass.png',{pack:{...makePack(),setCode:'wrong-product'}});
  assert.equal((await retry(bad)).status,503);
  const good=context('/images/pokemon-contained/dp-grass.png');
  assert.equal((await retry(good)).status,200);assert.equal(good.reads(),1);
});

test('existing numbered and Pooka vintage image routes retain their original bytes',async()=>{
  for(const example of [
    {url:'/images/pokemon-vintage/Neo1/tcg-129.webp',set:'Neo1',bucket:'2',file:'tcg-129.webp'},
    {url:'/images/pokemon-vintage/DP1/pooka-ja-dp1-108.webp',set:'DP1',bucket:'pooka',file:'pooka-ja-dp1-108.webp'}
  ]){
    const {onRequest}=await runtime();
    const ctx={request:new Request('https://example.test'+example.url),
      env:{ASSETS:{fetch:async request=>{
        assert.equal(new URL(request.url).pathname,'/data/pokemon-vintage-packs-v2/'+example.set+'/'+example.bucket+'.json');
        return new Response(JSON.stringify({schemaVersion:2,bucketSize:64,setCode:example.set,bucket:example.bucket,
          files:{[example.file]:image(png,'image/webp')}}),{headers:{'Content-Type':'application/json'}});
      }}},next:()=>{throw Error('Unexpected fallback');}};
    const response=await onRequest(ctx);assert.equal(response.status,200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
  }
});
