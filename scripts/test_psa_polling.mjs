// Offline PSA registration/polling tests. No browser, provider API or real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('window.registerPsaCert = async function');
const end = html.indexOf('\nfunction showPsaCertPopup', start);
assert(start >= 0 && end > start, 'PSA registration/polling source must be found');
const source = html.slice(start, end);
const SAVED = '요청은 저장되어 있습니다. 잠시 후 다시 확인해주세요.';
const response = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(transport = async () => response({ status: 'pending', ok: false })) {
  let now = 0, nextId = 0;
  const timers = new Map();
  const calls = { requests: [], success: [], fail: [], cancel: 0, toast: [], alert: [], close: 0, show: 0, refresh: 0 };
  const input = { value: '23 483 296', disabled: false };
  const schedule = (fn, delay, interval = 0) => {
    const id = ++nextId; timers.set(id, { fn, at: now + delay, interval }); return id;
  };
  const context = {
    window: {}, encodeURIComponent,
    document: { getElementById: id => id === 'certInp_1' ? input : null },
    fetch: (url, options) => { calls.requests.push({ url, options }); return transport(url, options); },
    showToast: (...args) => calls.toast.push(args), alert: message => calls.alert.push(message),
    refreshPortfolio: () => { calls.refresh++; },
    closePsaCertPopup: () => { calls.close++; },
    showPsaCertPopup: () => { calls.show++; context.window.__psaPopupCancelled = false; },
    setInterval: (fn, delay) => schedule(fn, delay, delay), clearInterval: id => timers.delete(id),
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
  };
  vm.createContext(context); vm.runInContext(source, context);
  const advance = async milliseconds => {
    const endAt = now + milliseconds;
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= endAt)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at;
      if (timer.interval) timer.at += timer.interval; else timers.delete(id);
      timer.fn(); await flush();
    }
    now = endAt; await flush();
  };
  const poll = (requestId = 'fixture-request-id-01') => context.pollPsaCert('23483296', requestId,
    data => calls.success.push(data), (r, data) => calls.fail.push({ r, data }), () => { calls.cancel++; });
  return { context, calls, input, timers, advance, poll };
}

test('a user click posts retry once, then polls the saved request using GET with encoded id', async () => {
  let count = 0;
  const id = 'fixture-request-id-01';
  const f = fixture(async (url, options) => options.method === 'POST'
    ? response({ status: 'pending', request_id: id }, 202)
    : response(count++ ? { status: 'registered', ok: true, message: '인증 완료' } : { status: 'processing', ok: false }));
  await f.context.window.registerPsaCert(1, '91103', 'psa10');
  assert.equal(f.input.disabled, true);
  assert.equal(f.calls.requests.length, 1);
  const initial = f.calls.requests[0];
  assert.equal(initial.url, '/api/psa/cert');
  assert.equal(initial.options.method, 'POST');
  assert.deepEqual(JSON.parse(initial.options.body), { cert_number: '23483296', card_id: '91103', holding_id: 1, expected_grade: 'psa10', retry: true });
  await f.advance(10000);
  assert.equal(f.calls.requests.filter(call => call.options.method === 'POST').length, 1);
  for (const { url, options } of f.calls.requests.slice(1)) {
    assert.equal(url, `/api/certifications/status?id=${encodeURIComponent(id)}`);
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'include'); assert.equal(options.cache, 'no-store');
    assert.equal(options.body, undefined);
  }
  assert.equal(f.calls.refresh, 1); assert.equal(f.timers.size, 0);
  await f.advance(180000); assert.equal(f.calls.requests.length, 3);
});

test('request id is escaped and never interpolated as an extra query parameter', async () => {
  const f = fixture(); f.poll('fixture &id=other?/#'); await f.advance(5000);
  assert.equal(f.calls.requests[0].url, '/api/certifications/status?id=fixture%20%26id%3Dother%3F%2F%23');
  f.context.window.__psaCancelPolling();
});

test('pending, processing and retry_wait all wait for registered and ok true', async () => {
  const states = ['pending', 'processing', 'retry_wait', 'registered'];
  const f = fixture(async () => { const status = states.shift(); return response({ status, ok: status === 'registered' }); });
  f.poll(); await f.advance(15000);
  assert.equal(f.calls.success.length, 0); assert.equal(f.calls.fail.length, 0); assert.equal(f.calls.cancel, 0);
  await f.advance(5000);
  assert.equal(f.calls.success.length, 1); assert.equal(f.calls.requests.length, 4); assert.equal(f.timers.size, 0);
});

for (const status of ['needs_review', 'rejected', 'not_found']) {
  test(`${status} stops polling and preserves the exact server message`, async () => {
    const message = `${status} 서버 안내`;
    const f = fixture(async () => response({ status, ok: false, message }));
    f.poll(); await f.advance(5000); await f.advance(180000);
    assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.fail.length, 1);
    assert.equal(f.calls.fail[0].data.message, message);
    assert.equal(f.calls.success.length, 0); assert.equal(f.calls.cancel, 0); assert.equal(f.timers.size, 0);
  });
}

test('not_found without a server message uses an accurate Korean fallback', async () => {
  const f = fixture(async () => response({ status: 'not_found', ok: false })); f.poll(); await f.advance(5000);
  assert.match(f.calls.fail[0].data.message, /기록을 찾지 못했습니다.*가품 판정은 아닙니다/);
});

for (const kind of ['network', 'server']) {
  test(`${kind} failures stop after three minutes and explain that the request is saved`, async () => {
    const f = fixture(async () => { if (kind === 'network') throw new Error('fixture network failure'); return response({ message: 'fixture unavailable' }, 503); });
    f.poll(); await f.advance(179999);
    assert.equal(f.calls.cancel, 0); assert.equal(f.calls.fail.length, 0);
    await f.advance(1); assert.equal(f.calls.cancel, 1); assert.equal(f.timers.size, 0);
    assert.deepEqual(f.calls.toast, [[SAVED, 'info']]); assert.equal(f.calls.success.length, 0);
    const count = f.calls.requests.length; await f.advance(180000); assert.equal(f.calls.requests.length, count);
  });
}

test('a hung fetch has no overlapping polls and the independent deadline still ends the UI wait', async () => {
  const pending = deferred(); const f = fixture(() => pending.promise); f.poll(); await f.advance(180000);
  assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.cancel, 1);
  assert.deepEqual(f.calls.toast, [[SAVED, 'info']]); assert.equal(f.timers.size, 0);
  pending.resolve(response({ status: 'registered', ok: true })); await flush();
  assert.equal(f.calls.success.length, 0); assert.equal(f.calls.fail.length, 0);
});

test('a hung response body is also bounded and cannot succeed after timeout', async () => {
  const pending = deferred(); const f = fixture(async () => ({ status: 200, ok: true, json: () => pending.promise }));
  f.poll(); await f.advance(180000); assert.equal(f.calls.requests.length, 1); assert.equal(f.calls.cancel, 1);
  pending.resolve({ status: 'registered', ok: true }); await flush(); assert.equal(f.calls.success.length, 0);
});

test('cancel closes the popup immediately and ignores a late successful response', async () => {
  const pending = deferred(); const f = fixture(() => pending.promise); f.poll(); await f.advance(5000);
  f.context.window.__psaPopupCancelled = true; f.context.window.__psaCancelPolling();
  assert.equal(f.calls.cancel, 1); assert.equal(f.calls.close, 1); assert.equal(f.timers.size, 0);
  pending.resolve(response({ status: 'registered', ok: true })); await flush(); await f.advance(180000);
  assert.equal(f.calls.success.length, 0); assert.equal(f.calls.fail.length, 0); assert.equal(f.calls.requests.length, 1);
});

test('the cancellation flag also blocks a response before the next polling tick', async () => {
  const pending = deferred(); const f = fixture(() => pending.promise); f.poll(); await f.advance(5000);
  f.context.window.__psaPopupCancelled = true;
  pending.resolve(response({ status: 'registered', ok: true })); await flush();
  assert.equal(f.calls.cancel, 1); assert.equal(f.calls.success.length, 0); assert.equal(f.timers.size, 0);
});

test('starting another poll cancels the previous one and its late response cannot close the new popup', async () => {
  const previous = deferred(); let count = 0;
  const f = fixture(() => count++ === 0 ? previous.promise : Promise.resolve(response({ status: 'pending' })));
  f.poll('fixture-request-id-01'); await f.advance(5000); f.poll('fixture-request-id-02');
  assert.equal(f.calls.cancel, 1); assert.equal(f.calls.close, 1);
  previous.resolve(response({ status: 'registered', ok: true })); await flush();
  assert.equal(f.calls.success.length, 0); assert.equal(f.calls.close, 1);
  await f.advance(5000); assert.match(f.calls.requests.at(-1).url, /id=fixture-request-id-02$/);
  f.context.window.__psaCancelPolling(); assert.equal(f.timers.size, 0);
});

test('missing request id reports that the saved request needs a later check without reposting', async () => {
  const f = fixture(async () => response({ status: 'pending' }, 202));
  await f.context.window.registerPsaCert(1, '91103', 'psa10'); await f.advance(180000);
  assert.equal(f.calls.requests.length, 1); assert.equal(f.input.disabled, false); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.calls.toast, [[SAVED, 'error']]);
});

test('terminal polling failure restores the registration input', async () => {
  const f = fixture(async (url, options) => options.method === 'POST'
    ? response({ status: 'pending', request_id: 'fixture-request-id-01' }, 202)
    : response({ status: 'rejected', error: 'card_mismatch', message: '선택한 카드와 다릅니다.' }));
  await f.context.window.registerPsaCert(1, '91103', 'psa10'); await f.advance(5000);
  assert.equal(f.input.disabled, false); assert.deepEqual(f.calls.alert, ['선택한 카드와 다릅니다.']);
  assert.equal(f.calls.requests.filter(call => call.options.method === 'POST').length, 1);
});

test('timeout restores the registration input and pending with ok true never claims success', async () => {
  const f = fixture(async (url, options) => options.method === 'POST'
    ? response({ status: 'pending', request_id: 'fixture-request-id-01' }, 202)
    : response({ status: 'pending', ok: true }));
  await f.context.window.registerPsaCert(1, '91103', 'psa10'); await f.advance(180000);
  assert.equal(f.input.disabled, false); assert.equal(f.calls.refresh, 0); assert.deepEqual(f.calls.toast, [[SAVED, 'info']]);
});
