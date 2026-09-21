import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { onRequestPost as requestLink } from '../functions/api/auth/request.js';
import { onRequestGet as verifyLink, onRequestPost as finishApp } from '../functions/api/auth/verify.js';
import { sha256Hex, verifyJwt } from '../functions/_shared/jwt.js';

// In-memory fixtures only: no email is sent and no production data is accessed.
const tokens = new Map(), users = new Map(), kv = new Map(), mails = [];
const env = {
  APP_URL: 'https://tcghub.test', RESEND_API_KEY: 'fixture', JWT_SECRET: 'fixture-secret',
  ADMIN_KV: { async put(k,v) { kv.set(k,v); }, async get(k) { return kv.get(k) ?? null; } },
  DB: { prepare(sql) { return { bind(...args) { return {
    async first() {
      if (sql.startsWith('SELECT COUNT')) return { n: 0 };
      if (sql.includes('FROM magic_tokens')) return tokens.has(args[0]) ? { ...tokens.get(args[0]) } : null;
      if (sql.includes('FROM users')) return users.get(args[0]) ?? null;
      throw new Error(sql);
    },
    async run() {
      if (sql.startsWith('INSERT INTO magic_tokens')) {
        assert(!tokens.has(args[0]));
        tokens.set(args[0], { email: args[1], expires_at: args[2], used: 0 });
      } else if (sql.startsWith('UPDATE magic_tokens')) {
        const row = tokens.get(args[0]);
        const changes = row && !row.used ? 1 : 0;
        if (changes) row.used = 1;
        return { meta: { changes } };
      } else if (sql.startsWith('INSERT INTO users')) {
        users.set(args[1], { id: args[0], email: args[1], name: null });
      } else if (!sql.startsWith('UPDATE users')) throw new Error(sql);
      return { meta: { changes: 1 } };
    }
  }; } }; } }
};
const post = (path, body) => new Request(env.APP_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const get = url => verifyLink({ env, request: new Request(url) });
const finish = verifier => finishApp({ env, request: post('/api/auth/verify', { verifier }) });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  assert.equal(url, 'https://api.resend.com/emails');
  mails.push(JSON.parse(opts.body));
  return Response.json({ id: 'fixture-mail' });
};
async function send(verifier, email = 'app@example.test') {
  const body = { email };
  if (verifier) Object.assign(body, { app: true, appChallenge: await sha256Hex(verifier) });
  assert.equal((await requestLink({ env, request: post('/api/auth/request', body) })).status, 200);
  const mail = mails.at(-1);
  if (verifier) {
    assert(!JSON.stringify(mail).includes(verifier));
    assert(!JSON.stringify(mail).includes(body.appChallenge));
  }
  return new URL(mail.text.match(/https:\/\/[^\s]+/)[0]);
}
try {
  const verifier = 'a'.repeat(64), wrong = 'b'.repeat(64);
  const link = await send(verifier);
  assert.equal(link.searchParams.get('app'), '1');
  assert.equal((await finish(verifier)).status, 400, 'unconfirmed email cannot log in');
  const handoff = await get(link);
  assert.equal(handoff.status, 200);
  assert.equal(handoff.headers.get('Set-Cookie'), null, 'browser must not receive app session');
  assert.equal(handoff.headers.get('Cache-Control'), 'no-store');
  const page = await handoff.text();
  assert(page.includes('href="kr.tcghub.app://email-callback"'));
  for (const secret of [verifier, await sha256Hex(verifier), link.searchParams.get('token')]) assert(!page.includes(secret), 'no authentication data in handoff');
  assert.equal((await get(link)).status, 200, 'reopen pending confirmation');
  assert.equal((await finish(wrong)).status, 400, 'other app cannot claim approval');
  const direct = new URL('/api/auth/verify', env.APP_URL);
  direct.searchParams.set('token', 'app:' + await sha256Hex(verifier));
  assert.equal((await get(direct)).status, 400, 'GET cannot bypass verifier proof');
  const successes = await Promise.all([finish(verifier), finish(verifier)]);
  assert.deepEqual(successes.map(r => r.status).sort(), [200,400], 'only one concurrent redemption succeeds');
  const success = successes.find(r => r.status === 200);
  const cookie = success.headers.get('Set-Cookie');
  assert(cookie.includes('HttpOnly; Secure; SameSite=Lax'));
  const claims = await verifyJwt(cookie.match(/^session=([^;]+)/)[1], env.JWT_SECRET);
  assert.equal(claims.email, 'app@example.test');
  assert.equal((await finish(verifier)).status, 400, 'replay rejected');

  const stripped = await send('c'.repeat(64));
  stripped.searchParams.delete('app');
  const strippedResult = await get(stripped);
  assert.equal(strippedResult.status, 200);
  assert.equal(strippedResult.headers.get('Set-Cookie'), null, 'stripping app flag cannot log browser in');
  const expiredVerifier = 'd'.repeat(64), expiredLink = await send(expiredVerifier);
  tokens.get(expiredLink.searchParams.get('token')).expires_at = 1;
  assert.equal((await get(expiredLink)).status, 400);
  const approvalVerifier = 'e'.repeat(64), approvalLink = await send(approvalVerifier);
  await get(approvalLink);
  tokens.get('app:' + await sha256Hex(approvalVerifier)).expires_at = 1;
  assert.equal((await finish(approvalVerifier)).status, 400, 'expired app approval rejected');

  const webLink = await send(null, 'web@example.test');
  assert.equal(webLink.searchParams.has('app'), false);
  const webResult = await get(webLink);
  assert.equal(webResult.status, 302);
  assert.equal(webResult.headers.get('Location'), '/?login=success');
  assert(webResult.headers.get('Set-Cookie'));
  assert.equal((await get(webLink)).status, 400);
  assert.equal((await get(env.APP_URL + '/api/auth/verify?token=invalid&app=1')).status, 400);
  assert.equal((await requestLink({env, request:post('/api/auth/request',{email:'a@example.test',app:true})})).status,400);
  assert.equal((await requestLink({env:{...env,ADMIN_KV:null},request:post('/api/auth/request',{email:'a@example.test',app:true,appChallenge:'f'.repeat(64)})})).status,500);
} finally { globalThis.fetch = originalFetch; }

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const listener = html.slice(html.indexOf('(function _setupAppDeepLinkListener()'), html.indexOf('// 클릭/Enter 위임', html.indexOf('(function _setupAppDeepLinkListener()')));
const submit = html.slice(html.indexOf('async function submitLogin()'), html.indexOf('// 약관 동의 검증 — 이메일/구글 공통'));
function storage() {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
}
async function client({ launch, native = true, fail = false, saved } = {}) {
  let handler;
  const calls = [], notices = [], localStorage = saved || storage();
  const window = { location: { href: '/' }, Capacitor: { isNativePlatform: () => native, Plugins: {
    App: { addListener(name, fn) { handler = fn; }, async getLaunchUrl() { return launch ? { url: launch } : undefined; } },
    Browser: { async close() {} }
  } } };
  const context = { window, URL, console, localStorage, crypto, TextEncoder, Uint8Array,
    showToast: (...args) => notices.push(args),
    fetch: async (url, opts) => { calls.push({url,...opts}); return Response.json(fail ? {ok:false,message:'expired'} : {ok:true}, {status:fail?400:200}); }
  };
  vm.runInNewContext(listener, context);
  await new Promise(resolve => setImmediate(resolve));
  return { handler, calls, notices, window, localStorage, context };
}
const appUrl = 'kr.tcghub.app://email-callback';
for (const cold of [false,true]) {
  const saved = storage(); saved.setItem('tcghub_email_verifier','a'.repeat(64));
  const c = await client({saved,launch:cold?appUrl:undefined});
  if (!cold) await Promise.all([c.handler({url:appUrl}),c.handler({url:appUrl})]);
  assert.equal(c.calls.length,1,'duplicate callbacks exchange only once');
  assert.equal(c.calls[0].url,'/api/auth/verify');
  assert.equal(c.calls[0].credentials,'include');
  assert.deepEqual(JSON.parse(c.calls[0].body),{verifier:'a'.repeat(64)});
  assert.equal(c.window.location.href,'/?login=success');
  assert.equal(saved.getItem('tcghub_email_verifier'),null);
  assert.equal((await client({saved,launch:appUrl})).calls.length,0,'reload does not repeat exchange');
}
const bad = await client({fail:true}); bad.localStorage.setItem('tcghub_email_verifier','b'.repeat(64));
await bad.handler({url:appUrl});
assert.equal(bad.window.location.href,'/'); assert.equal(bad.notices.length,1);
assert(bad.localStorage.getItem('tcghub_email_verifier'),'failure can be retried');
const social = await client(); await social.handler({url:'kr.tcghub.app://kakao-callback?code=fixture'});
assert.equal(social.calls[0].url,'/api/auth/exchange-code');
assert.equal((await client({native:false,launch:appUrl})).handler,undefined);

for(const native of [true,false]) {
  const c = await client({native});
  const input={value:' APP@example.test ',removeAttribute(){}};
  const btn={style:{}},msg={style:{}},state={};
  const box={_loginState:state,_syncLogin(){},querySelector:s=>({'#loginEmailInput':input,'#loginSubmit':btn,'#loginMsg':msg}[s])};
  const modal={classList:{contains:()=>true},querySelector:()=>box};
  c.context.document={getElementById:()=>modal}; c.context._verifyAgreements=()=>true;
  await vm.runInNewContext(submit+'\nsubmitLogin();',c.context);
  const sent=JSON.parse(c.calls[0].body);
  assert.equal(sent.app,native); assert.equal(sent.email,'app@example.test');
  if(native) {
    const verifier=c.localStorage.getItem('tcghub_email_verifier');
    assert.match(verifier,/^[a-f0-9]{64}$/);
    assert.equal(sent.appChallenge,await sha256Hex(verifier));
    assert.equal(sent.verifier,undefined,'verifier stays inside requesting app');
  } else assert.equal(sent.appChallenge,undefined);
}
for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if(!/\bsrc=|type=["'](?:application\/ld\+json|module)/i.test(match[1]) && match[2].trim()) new vm.Script(match[2]);
}
console.log('PASS: app/web email flow, token-free app URL, proof binding, cold/warm start, duplicates, replay, expiry, cookies, Kakao regression, client requests, inline JavaScript syntax.');
