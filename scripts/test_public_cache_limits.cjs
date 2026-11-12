'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../sw.js'),'utf8');

function fixture(){
  const handlers={},stores=new Map(),requests=[],deleted=[];
  let network=0,offline=false,quota=false;
  class Cache {
    constructor(){this.rows=new Map();}
    async match(req){return this.rows.get(typeof req==='string'?req:req.url)?.clone();}
    async put(req,res){if(quota)throw Error('quota');const key=typeof req==='string'?req:req.url;this.rows.delete(key);this.rows.set(key,res.clone());}
    async keys(){return [...this.rows.keys()].map(url=>new Request(url));}
    async delete(req){return this.rows.delete(typeof req==='string'?req:req.url);}
  }
  const caches={async open(name){if(!stores.has(name))stores.set(name,new Cache());return stores.get(name);},async keys(){return [...stores.keys()];},async delete(name){deleted.push(name);return stores.delete(name);}};
  const self={addEventListener:(name,handler)=>handlers[name]=handler,clients:{claim:async()=>{}},skipWaiting:async()=>{}};
  const ctx={self,caches,URL,Request,Response,location:{origin:'https://tcghub.kr'},fetch:async req=>{requests.push(req.url);if(offline)throw Error('offline');return new Response(String(++network));}};
  vm.createContext(ctx);vm.runInContext(source+'\nglobalThis.audit={STATIC_CACHE,DATA_CACHE,IMAGE_CACHE,CACHE_LIMITS};',ctx);
  async function event(name,request){
    const work=[],e={request,waitUntil:p=>work.push(p),respondWith:p=>e.response=p};handlers[name](e);
    const response=await e.response;
    while(work.length)await Promise.all(work.splice(0));
    return response;
  }
  return {ctx,stores,requests,deleted,caches,event,get network(){return network;},offline(){offline=true;},quota(){quota=true;},get:async path=>event('fetch',new Request(new URL(path,'https://tcghub.kr')))};
}

test('hourly public JSON URLs share one cached body while the original network URL still refreshes',async()=>{
  const h=fixture(),name=h.ctx.audit.DATA_CACHE;
  assert.equal(await (await h.get('/data/top10-pokemon.json?t=1&v=release1')).text(),'1');
  assert.equal(await (await h.get('/data/top10-pokemon.json?t=2&v=release1')).text(),'1','stale-while-revalidate preserves its existing fast response');
  const cache=await h.caches.open(name);assert.equal((await cache.keys()).length,1);
  assert.equal(await (await cache.match('https://tcghub.kr/data/top10-pokemon.json?v=release1')).text(),'2');
  assert.deepEqual(h.requests,['https://tcghub.kr/data/top10-pokemon.json?t=1&v=release1','https://tcghub.kr/data/top10-pokemon.json?t=2&v=release1']);
  await h.get('/data/top10-pokemon.json?t=3&v=release2');assert.equal((await cache.keys()).length,2,'release identity is retained');
  await h.get('/data/top10-pokemon.json?t=3&v=release2&kind=box');assert.equal((await cache.keys()).length,3,'semantic parameters are retained');
});

test('API, authentication and account save requests never enter a public cache',async()=>{
  const h=fixture();
  for(const path of ['/api/auth/me','/api/portfolio','/api/games/kanto151-save','/api/collections'])assert.equal(await h.get(path),undefined);
  const response=await h.event('fetch',new Request('https://tcghub.kr/api/portfolio/holding',{method:'POST',body:'private'}));
  assert.equal(response,undefined);assert.equal(h.stores.size,0);assert.equal(h.requests.length,0);
});

test('a direct public JSON navigation can use the same timestamp-free cache key',async()=>{
  const h=fixture();
  const request={url:'https://tcghub.kr/data/news.json?t=123',method:'GET',mode:'navigate',headers:new Headers({'Accept':'application/json'})};
  assert.equal((await h.event('fetch',request)).status,200);
  const cache=await h.caches.open(h.ctx.audit.DATA_CACHE);
  assert(await cache.match('https://tcghub.kr/data/news.json'));
});

test('content-hashed search bodies retain cache-first reuse and separate releases',async()=>{
  const h=fixture();
  const a='/data/search-index-ja/part-0000-aaaaaaaaaaaaaaaaaaaa.json',b='/data/search-index-ja/part-0000-bbbbbbbbbbbbbbbbbbbb.json';
  const first=await (await h.get(a)).text();assert.equal(await (await h.get(a)).text(),first);assert.equal(h.network,1);
  await h.get(b);assert.equal(h.network,2);
});

test('image cache evicts oldest public entries and has only a bounded batch overshoot',async()=>{
  const h=fixture(),maximum=h.ctx.audit.CACHE_LIMITS[h.ctx.audit.IMAGE_CACHE],cache=await h.caches.open(h.ctx.audit.IMAGE_CACHE);
  for(let i=0;i<maximum+40;i++)await cache.put('https://tcghub.kr/images/old-'+i+'.webp',new Response('old'));
  await h.get('/images/current.webp');assert.equal((await cache.keys()).length,maximum);
  assert.equal(await cache.match('https://tcghub.kr/images/old-0.webp'),undefined);
  for(let i=0;i<35;i++){
    await h.get('/images/new-'+i+'.webp');assert((await cache.keys()).length<=maximum+15);
  }
  assert(await cache.match('https://tcghub.kr/images/new-34.webp'));
});

test('cache quota failures preserve successful responses and known offline data remains available',async()=>{
  const h=fixture();await h.get('/data/top10-pokemon.json?t=1');h.quota();
  assert.equal((await h.get('/images/new.webp')).status,200);
  h.offline();assert.equal(await (await h.get('/data/top10-pokemon.json?t=2')).text(),'1');
});

test('activation only retires old TCG HUB caches and bounds the current public caches',async()=>{
  const h=fixture(),name=h.ctx.audit.STATIC_CACHE,maximum=h.ctx.audit.CACHE_LIMITS[name];
  await h.caches.open('other-feature-private-cache');await h.caches.open('tcghub-old-static');
  const cache=await h.caches.open(name);for(let i=0;i<maximum+2;i++)await cache.put('https://tcghub.kr/assets/test-'+i+'.js',new Response('source'));
  await h.event('activate');assert.deepEqual(h.deleted,['tcghub-old-static']);
  assert(h.stores.has('other-feature-private-cache'));assert.equal((await cache.keys()).length,maximum);
});
