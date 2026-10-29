const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const script = fs.readFileSync(path.join(__dirname, '../functions/price/[id].js'), 'utf8')
  .replace('export async function onRequestGet', 'async function onRequestGet');

async function run({id = '472683', root = {}, bucket = {}, rootFailure = false, bucketStatus = 200} = {}) {
  const urls = [];
  const context = {
    URL, Request, Response,
    fetch: async url => {
      urls.push(String(url));
      if (String(url).endsWith('/data/cards-meta-index.json')) {
        if (rootFailure) throw new Error('fixture root outage');
        return new Response(JSON.stringify(root));
      }
      if (/\/data\/cards-meta-index\/\d{2}\.json$/.test(String(url))) {
        return new Response(JSON.stringify(bucket), {status: bucketStatus});
      }
      if (String(url).endsWith('/data/cards-detail.json')) return new Response('{"cards":{}}');
      throw new Error('Unexpected URL ' + url);
    },
  };
  vm.runInNewContext(script, context);
  const response = await context.onRequestGet({
    request: new Request('https://tcghub.kr/price/' + id), params: {id},
    env: {ASSETS: {fetch: async () => new Response('<html><head><title>TCG</title></head><body></body></html>')}},
  });
  return {response, urls};
}

test('new game ID resolves through its exact suffix bucket', async () => {
  const {response, urls} = await run({bucket: {'472683': {name: 'Modernia', code: 'NIK/S117', brand: 'weiss_schwarz'}}});
  assert.equal(response.status,200);
  assert.match(await response.text(), /Modernia/);
  assert(urls.includes('https://tcghub.kr/data/cards-meta-index/83.json'));
});

test('legacy root entry stays available without a bucket request', async () => {
  const {response,urls} = await run({id:'1',root:{'1':{name:'Legacy Pokemon',brand:'pokemon'}}});
  assert.equal(response.status,200);
  assert(!urls.some(url=>url.includes('/data/cards-meta-index/')));
});

test('bucket can serve a known card while root index is unavailable', async () => {
  const {response}=await run({rootFailure:true,bucket:{'472683':{name:'Modernia',brand:'weiss_schwarz'}}});
  assert.equal(response.status,200);
});

test('absent numeric ID is 404 only after available metadata lookup', async () => {
  assert.equal((await run({bucket:{}})).response.status,404);
  assert.equal((await run({bucketStatus:404})).response.status,404);
  assert.equal((await run({bucketStatus:503})).response.status,503);
  assert.equal((await run({rootFailure:true,bucket:{}})).response.status,503);
});

test('invalid ID cannot turn into an arbitrary shard request', async () => {
  const {response,urls}=await run({id:'../private'});
  assert.equal(response.status,404);
  assert.equal(urls.length,0);
});
