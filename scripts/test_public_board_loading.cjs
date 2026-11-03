const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const path = require('node:path');

(async () => {
  const {onRequestGet: board, onRequestPost: save} = await import(pathToFileURL(path.resolve('functions/api/admin.js')));
  const {onRequestGet: media} = await import(pathToFileURL(path.resolve('functions/api/admin-media.js')));
  const {signJwt} = await import(pathToFileURL(path.resolve('functions/_shared/jwt.js')));
  const imageBytes = Buffer.alloc(1024 * 1024, 7);
  const image = 'data:image/png;base64,' + imageBytes.toString('base64');
  const original = [{id: 'fixture', title: '제목', image, content: `<p>본문은 그대로</p><img src="${image}"><p>끝</p>`, link: 'https://example.test'}];
  const stored = structuredClone(original), writes = [];
  const env = {ADMIN_KV: {get: async () => structuredClone(stored), put: async (...args) => writes.push(args)}};
  const get = query => board({env, request: new Request('https://tcghub.kr/api/admin?type=news' + query)});
  const full = await (await get('')).json();
  assert.deepEqual(full.items, original, 'editor must receive original image and HTML bytes');
  const compact = await (await get('&view=display')).json();
  assert.equal(compact.meta.view, 'display');
  const item = compact.items[0];
  assert.equal(item._displayOnly, true);
  assert.equal(item.title, original[0].title);
  assert.equal(item.link, original[0].link);
  assert(item.content.startsWith('<p>본문은 그대로</p><img src="/api/admin-media?'));
  assert(item.content.endsWith('"><p>끝</p>'));
  assert.equal(JSON.stringify(compact).includes('data:image'), false);
  assert(JSON.stringify(compact).length < JSON.stringify(full).length / 1000, 'large images must leave JSON');
  assert.deepEqual(stored, original, 'display projection cannot mutate stored originals');
  const response = await media({env, request: new Request(new URL(item.image, 'https://tcghub.kr'))});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert(response.headers.get('cache-control').includes('immutable'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), imageBytes, 'original image resolution and bytes preserved');
  const contentUrl = item.content.match(/src="([^"]+)"/)[1];
  assert.equal((await media({env, request: new Request(new URL(contentUrl, 'https://tcghub.kr'))})).status, 200);
  stored[0].image = 'data:image/png;base64,AQID';
  assert.equal((await media({env, request: new Request(new URL(item.image, 'https://tcghub.kr'))})).status, 404, 'edited images cannot be served under an old SHA');
  assert.equal((await media({env, request: new Request('https://tcghub.kr/api/admin-media?type=unknown')})).status, 400);
  assert.equal((await media({env, request: new Request(new URL(item.image.replace(/v=[a-f0-9]+/, 'v=invalid'), 'https://tcghub.kr'))})).status, 400);
  const secret = 'isolated-test-only-secret';
  const user = {id: 'fixture-admin', email: 'yhk3213@gmail.com'};
  const authEnv = {...env, JWT_SECRET: secret, DB: {prepare: () => ({bind: () => ({first: async () => user})})}};
  const token = await signJwt({sub: user.id, email: user.email, exp: Math.floor(Date.now()/1000)+60}, secret);
  const rejected = await save({env: authEnv, request: new Request('https://tcghub.kr/api/admin', {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://tcghub.kr', Cookie: 'session=' + token},
    body: JSON.stringify({type: 'news', items: compact.items}),
  })});
  assert.equal(rejected.status, 400, 'server must reject display copies on writes');
  assert.equal(writes.length, 0);

  const html = fs.readFileSync('index.html', 'utf8');
  const helper = html.slice(html.indexOf('function loadPublicBoardData('), html.indexOf('async function saveAdminData('));
  const all = html.slice(html.indexOf('async function loadAllAdminData('), html.indexOf('function applyThumbFallback('));
  const pending = [], calls = [];
  const context = vm.createContext({console, Date, Map, Promise, encodeURIComponent,
    EVENTS: [], ETC_LIST: [], CARDSHOWS: [], GRADING_LIST: [], NEWS_LIST: [],
    localStorage: {setItem(){}}, renderHomeRecommendations(){},
    fetch(url) { calls.push(url); return new Promise(resolve => pending.push({url, resolve})); },
  });
  vm.runInContext(helper + '\n' + all, context);
  const load = type => vm.runInContext(`loadPublicBoardData('${type}')`, context);
  const one = load('news'), two = load('news'), three = load('news');
  assert.equal(calls.length, 1, 'home, hub, and initial all-board load share a request');
  assert(calls[0].endsWith('&view=display'));
  pending.shift().resolve({ok: true, json: async () => ({items: [{id: 'display', _displayOnly: true}]})});
  await Promise.all([one, two, three]);
  await load('news');
  assert.equal(calls.length, 1, 'completed public load reused within its bounded TTL');
  vm.runInContext("invalidatePublicBoard('news')", context);
  const stale = load('news');
  const staleRequest = pending.shift();
  vm.runInContext("invalidatePublicBoard('news')", context);
  const fresh = load('news');
  const freshRequest = pending.shift();
  freshRequest.resolve({ok: true, json: async () => ({items: [{id: 'fresh'}]})});
  await fresh;
  staleRequest.resolve({ok: true, json: async () => ({items: [{id: 'stale'}]})});
  assert.equal((await stale)[0].id, 'fresh', 'late pre-save public response cannot poison cache');
  const originalLoad = vm.runInContext('ensureAdminOriginals()', context);
  assert.equal(pending.length, 5);
  assert(pending.every(request => !request.url.includes('view=display')), 'editor uses a separate full-data path');
  pending.splice(0).forEach(({resolve}) => resolve({ok: true, json: async () => ({items: [{id: 'original', content: 'full'}]})}));
  await originalLoad;
  assert.equal(vm.runInContext('NEWS_LIST[0].id', context), 'original');
  const publicReload = vm.runInContext('loadAllAdminData()', context);
  pending.splice(0).forEach(({resolve}) => resolve({ok: true, json: async () => ({items: [{id: 'display-late', _displayOnly: true}]})}));
  await publicReload;
  assert.equal(vm.runInContext('NEWS_LIST[0].id', context), 'original', 'late public load preserves hydrated editor originals');
  vm.runInContext("ensureAdminOriginals.loaded = false; loadPublicBoardData.state.completed.clear(); NEWS_LIST = [{id:'retained'}]", context);
  const partial = vm.runInContext('loadAllAdminData()', context);
  pending.splice(0).forEach(({url, resolve}) => resolve(url.includes('type=news')
    ? {ok: false, status: 503}
    : {ok: true, json: async () => ({items: [{id: 'independent'}]})}));
  await partial;
  assert.equal(vm.runInContext('EVENTS[0].id', context), 'independent', 'one failed board cannot block successful boards');
  assert.equal(vm.runInContext('NEWS_LIST[0].id', context), 'retained', 'failed refresh cannot erase existing board data');
  const retry = load('news');
  assert.equal(pending.length, 1, 'failed public response stays retryable');
  pending.shift().resolve({ok: true, json: async () => ({items: [{id: 'recovered'}]})});
  assert.equal((await retry)[0].id, 'recovered');
  for (const name of ['adminMoveEntry', 'adminSaveEntry', 'adminEditEntry', 'adminDeleteEntry', 'adminExportJson']) {
    const body = html.slice(html.indexOf('function ' + name + '('));
    assert(body.slice(0, 180).includes('await ensureAdminOriginals()'), name + ' waits for originals');
  }
  console.log('PASS: compact public boards, unchanged original media/text, SHA mismatch protection, display-write rejection, shared public requests, save invalidation race, editor hydration isolation');
})().catch(error => { console.error(error); process.exitCode = 1; });
