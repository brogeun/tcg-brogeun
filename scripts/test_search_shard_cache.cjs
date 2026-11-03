'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('hashed search shards reuse exact bytes while manifest and unversioned files refresh', async () => {
  const handlers = new Map(), stores = new Map(), requests = [];
  const context = {
    URL, Response, location:{origin:'https://tcghub.kr'},
    self:{addEventListener:(name,fn)=>handlers.set(name,fn)},
    caches:{open:async name=>{
      if(!stores.has(name))stores.set(name,new Map());
      const store=stores.get(name);
      return {match:async req=>store.get(req.url)?.clone(),put:async(req,res)=>store.set(req.url,res)};
    }},
    fetch:async req=>{requests.push(req.url);return new Response('body-'+requests.length);},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8'),context);
  async function get(pathname) {
    let reply;
    handlers.get('fetch')({request:{method:'GET',url:'https://tcghub.kr'+pathname},respondWith:value=>{reply=value;}});
    return (await reply).text();
  }
  const shard='/data/search-index-ja/part-0000-0123456789abcdefabcd.json';
  assert.equal(await get(shard),await get(shard));
  assert.equal(requests.length,1,'Reload must not download the same shard again');
  await get('/data/search-index-ja/part-0000-abcdef0123456789abcd.json');
  assert.equal(requests.length,2,'A new digest must fetch new bytes');
  for(const file of ['/data/search-index-ja.json?v=release','/data/search-index-ja/part-0000.json']) {
    assert.notEqual(await get(file),await get(file),'Mutable manifests and unversioned paths must refresh');
  }
  let intercepted=false;
  handlers.get('fetch')({request:{method:'GET',url:'https://tcghub.kr/api/admin-media?item=1'},respondWith:()=>{intercepted=true;}});
  assert.equal(intercepted,false,'Public media must respect its API HTTP cache rather than generic image cache');
});
