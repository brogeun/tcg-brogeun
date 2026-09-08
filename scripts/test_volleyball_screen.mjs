import assert from 'node:assert/strict';
import { initScreenMode } from '../games/volleyball/screen-mode.mjs';

function surface(extra = {}) {
  const listeners = new Map();
  const classes = new Set();
  return {
    ...extra,
    classList: { toggle(name, value) { value ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } },
    addEventListener(name, callback) { const list = listeners.get(name) || []; list.push(callback); listeners.set(name, list); },
    async emit(name, event = {}) { await Promise.all((listeners.get(name) || []).map(callback => callback(event))); },
  };
}
function setup({ native = false, rejected = false } = {}) {
  let pauses = 0, unlocks = 0;
  const portrait = surface({ matches: false });
  const label = { textContent: '' }, attributes = new Map();
  const arena = surface();
  const button = surface({ setAttribute(name, value) { attributes.set(name, value); }, querySelector() { return label; }, focus() {} });
  const document = surface({ body: surface(), hidden: false, fullscreenEnabled: native, fullscreenElement: null });
  const window = surface({ innerWidth: 844, innerHeight: 390 });
  const screen = { orientation: { async lock() {}, unlock() { unlocks++; } } };
  if (native) {
    arena.requestFullscreen = async () => {
      if (rejected) throw new Error('Fullscreen unavailable');
      document.fullscreenElement = arena;
      await document.emit('fullscreenchange');
    };
    document.exitFullscreen = async () => { document.fullscreenElement = null; await document.emit('fullscreenchange'); };
  }
  Object.assign(globalThis, { document, window, screen, matchMedia: () => portrait });
  const mode = initScreenMode({ arena, button, onPause() { pauses++; } });
  return { arena, button, document, window, screen, portrait, mode, attributes, pauses: () => pauses, unlocks: () => unlocks };
}

for (const options of [{}, { native: true }, { native: true, rejected: true }]) {
  const test = setup(options);
  assert.equal(test.pauses(), 0, 'initialization must not pause');
  await test.button.emit('click');
  assert.equal(test.arena.classList.contains('expanded'), true, 'native and CSS fallback both expand');
  assert.equal(test.mode.canPlay(), true, 'landscape is playable once expansion completes');
  test.document.hidden = true;
  assert.equal(test.mode.canPlay(), false, 'a hidden page never permits resume');
  test.document.hidden = false;
  for (const portrait of [true, false]) {
    const before = test.pauses();
    test.portrait.matches = portrait;
    await test.portrait.emit('change');
    assert.equal(test.pauses(), before + 1, 'both rotation directions pause');
    assert.equal(test.mode.canPlay(), !portrait, 'expanded portrait blocks play');
  }
  const before = test.pauses();
  await test.window.emit('resize');
  assert.equal(test.pauses(), before, 'duplicate resize notifications do not interrupt play');
  test.window.innerHeight -= 20;
  await test.window.emit('resize');
  assert.equal(test.pauses(), before + 1, 'changed viewport dimensions pause');
  await test.button.emit('click');
  assert.equal(test.arena.classList.contains('expanded'), false, 'exit restores the page');
  assert.equal(test.attributes.get('aria-pressed'), 'false');
}

{
  const test = setup({ native: true });
  let resolveEntry;
  test.arena.requestFullscreen = () => new Promise(resolve => { resolveEntry = async () => { test.document.fullscreenElement = test.arena; await test.document.emit('fullscreenchange'); resolve(); }; });
  const entering = test.button.emit('click');
  assert.equal(test.mode.canPlay(), false, 'pending fullscreen blocks starting or resuming');
  await test.document.emit('keydown', { code: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
  await Promise.resolve();
  assert.equal(test.arena.classList.contains('expanded'), false, 'Escape cancels pending expansion');
  await resolveEntry();
  await entering;
  assert.equal(test.document.fullscreenElement, null, 'late native success is closed after cancellation');
  assert.equal(test.arena.classList.contains('expanded'), false);
  assert.equal(test.mode.canPlay(), true);
}

{
  const test = setup({ native: true });
  await test.button.emit('click');
  test.document.exitFullscreen = async () => { throw new Error('Exit refused'); };
  await test.button.emit('click');
  assert.equal(test.arena.classList.contains('expanded'), true, 'refused exit preserves native view state');
  test.document.exitFullscreen = async () => { test.document.fullscreenElement = null; await test.document.emit('fullscreenchange'); };
  await test.button.emit('click');
  assert.equal(test.arena.classList.contains('expanded'), false, 'close remains usable after a refused exit');
}

console.log('PASS: viewport and rotation pauses, hidden-page and transition guards, native/fallback entry, canceled requests, refused-exit recovery');
