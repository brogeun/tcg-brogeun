const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const code = html.slice(html.indexOf('let JPY_KRW = 9.5;'), html.indexOf('/*', html.indexOf('const refreshFxIfDue')));
const snapshot = (cny = 200.77, date = '2026-10-08') => ({
  updated: '2026-10-11T23:00:00+09:00', asOf: date,
  basis: 'previous-business-day-close',
  rates: {JPY: 8.4871, USD: 1343.8, CNY: cny},
});

function setup(first = snapshot()) {
  const listeners = new Map(), intervals = [], requests = [], events = [];
  let next = first, now = Date.now();
  const document = {hidden: false, addEventListener(type, fn) {listeners.set(type, fn);}};
  const window = {
    addEventListener(type, fn) {listeners.set(type, fn);},
    dispatchEvent(event) {events.push(event.type); listeners.get(event.type)?.(event);},
  };
  const context = vm.createContext({
    window, document,
    Date: {now: () => now},
    CustomEvent: class {constructor(type) {this.type = type;}},
    console: {warn() {}},
    setInterval(fn, delay) {intervals.push({fn, delay});},
    fetch: async (url, options) => {
      requests.push({url, options});
      if (next instanceof Error) throw next;
      return {ok: true, json: async () => next};
    },
  });
  vm.runInContext(code, context);
  return {context, window, document, listeners, intervals, requests, events,
    setNext(value) {next = value;}, advance(ms) {now += ms;},
    get(expression) {return vm.runInContext(expression, context);}};
}

(async () => {
  const app = setup();
  await app.window.TCGFX.ready;
  assert.equal(app.window.TCGFX.convert(58.22, 'CNY'), 11688);
  assert.equal(app.window.TCGFX.convert(110, 'CNY'), 22084);
  assert.equal(app.window.TCGFX.convert(3, 'CNY'), 602);
  assert.equal(app.window.TCGFX.convert(100, 'JPY'), 848);
  assert.equal(app.window.TCGFX.convert(10, 'USD'), 13438);
  assert.equal(app.window.TCGFX.convert(12.9, 'KRW'), 12);
  assert.equal(app.get("fmtKrw(58.22, 'CNY')"), '₩11,688');
  assert.equal(app.get("fmtOrig(58.22, 'CNY')"), '¥58.22 CNY');
  assert.equal(app.window.TCGFX.getState().date, '2026-10-08');
  assert.equal(app.requests[0].options.cache, 'no-store');
  assert.deepEqual(app.events, ['tcg:fx-updated']);

  app.setNext(snapshot(201.25, '2026-10-12'));
  await app.window.TCGFX.refresh();
  assert.equal(app.window.TCGFX.convert(110, 'CNY'), 22137);
  assert.equal(app.window.TCGFX.getState().date, '2026-10-12');
  assert.equal(app.events.length, 2);

  for (const bad of [new Error('offline'), {...snapshot(), rates: {USD: 1, JPY: 1}}, snapshot(NaN), snapshot(0), snapshot(1, '')]) {
    app.setNext(bad);
    assert.equal(await app.window.TCGFX.refresh(), false);
    assert.equal(app.window.TCGFX.getState().rates.CNY, 201.25);
    assert.equal(app.window.TCGFX.getState().rates.USD, 1343.8);
    assert.equal(app.window.TCGFX.getState().date, '2026-10-12');
  }

  const unavailable = setup(new Error('offline'));
  await unavailable.window.TCGFX.ready;
  assert.equal(unavailable.window.TCGFX.convert(3, 'CNY'), null);
  assert.equal(unavailable.get("fmtKrw(3, 'CNY')"), '—');
  assert.equal(unavailable.get("fmtOrig(3, 'CNY')"), '¥3 CNY');
  assert.equal(unavailable.window.TCGFX.getState().cnyReady, false);
  unavailable.setNext(snapshot());
  unavailable.advance(3600000);
  unavailable.listeners.get('focus')();
  await unavailable.window.TCGFX.refresh();
  assert.equal(unavailable.window.TCGFX.convert(3, 'CNY'), 602);

  app.setNext(snapshot(202));
  app.advance(3600000);
  app.document.hidden = true;
  const oldRequests = app.requests.length;
  app.intervals[0].fn();
  assert.equal(app.requests.length, oldRequests);
  app.document.hidden = false;
  app.listeners.get('visibilitychange')();
  await app.window.TCGFX.refresh();
  assert.equal(app.window.TCGFX.convert(3, 'CNY'), 606);

  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(sw, /url\.pathname === '\/data\/fx-rates\.json'[\s\S]*?networkFirst\(req, DATA_CACHE\)/);
  console.log('PASS: common JPY/USD/CNY conversion, daily refresh, failure retention, no invented CNY rate, FX cache policy');
})().catch(error => {console.error(error); process.exitCode = 1;});
