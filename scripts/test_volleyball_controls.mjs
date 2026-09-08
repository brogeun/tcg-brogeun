import assert from 'node:assert/strict';
import test from 'node:test';
import { Match, FLOOR, R } from '../games/volleyball/engine.mjs';
import { encodeInput, decodeInput } from '../games/volleyball/replay.mjs';
import { VolleyballControls, GAME_KEYS, isGameInputTarget } from '../games/volleyball/controls.mjs';

const DT = 1 / 120;
const ground = FLOOR - R;
function game() {
  const match = new Match();
  match.start(); match.timer = 10;
  return match;
}
function tick(controls, match) {
  const input = controls.sample(match, DT);
  match.step(DT, input);
  return input;
}
function tap(controls, code) { controls.keyDown(code); controls.keyUp(code); }

class Surface {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type, options = {}) {
    const event = { pointerId: 1, button: 0, clientX: 10, clientY: 10, prevented: false,
      preventDefault() { this.prevented = true; }, ...options };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
}
class Button extends Surface {
  captures = new Set();
  classes = new Set();
  constructor(action, left) {
    super(); this.dataset = { control: action }; this.left = left;
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  }
  getBoundingClientRect() { return { left: this.left, right: this.left + 50, top: 0, bottom: 50 }; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); this.fire('lostpointercapture', { pointerId: id }); }
}
function touchSetup(isActive = () => true) {
  const controls = new VolleyballControls(), doc = new Surface();
  doc.defaultView = new Surface();
  const buttons = ['left', 'right', 'jump', 'slide', 'spike'].map((name, i) => new Button(name, i * 60));
  const unbind = controls.bindTouchControls(buttons, { document: doc, isActive });
  return { controls, doc, buttons, unbind };
}

test('captured movement finger slides left/right without lifting and can leave/re-enter', () => {
  const { controls, doc, buttons: [left, right] } = touchSetup(), match = game();
  left.fire('pointerdown');
  assert.equal(tick(controls, match).left, true);
  doc.fire('pointermove', { clientX: 75 });
  const moved = tick(controls, match);
  assert.equal(moved.left, false); assert.equal(moved.right, true);
  assert.equal(left.classes.has('pressed'), false); assert.equal(right.classes.has('pressed'), true);
  doc.fire('pointermove', { clientX: 55 });
  assert.equal(tick(controls, match).right, false, 'gap between arrows is neutral');
  doc.fire('pointermove', { clientX: 10 });
  assert.equal(tick(controls, match).left, true);
  doc.fire('pointerup');
  const released = tick(controls, match);
  assert.equal(released.left, false); assert.equal(released.right, false);
});

test('movement drag preserves a second finger and keyboard movement', () => {
  const { controls, doc, buttons: [left, right, jump] } = touchSetup(), match = game();
  left.fire('pointerdown', { pointerId: 1 });
  jump.fire('pointerdown', { pointerId: 2 });
  doc.fire('pointermove', { pointerId: 1, clientX: 75 });
  const input = tick(controls, match);
  assert.equal(input.right, true); assert.equal(input.jump, true);
  controls.keyDown('KeyA');
  doc.fire('pointerup', { pointerId: 2 });
  assert.equal(right.classes.has('pressed'), true);
  doc.fire('pointercancel', { pointerId: 1 });
  assert.equal(tick(controls, match).left, true, 'touch cancellation does not release a keyboard key');
  controls.keyUp('KeyA');
  assert.equal(tick(controls, match).left, false);
});

test('releasing one of two fingers on the same arrow retains the other', () => {
  const { controls, doc, buttons: [left] } = touchSetup(), match = game();
  left.fire('pointerdown', { pointerId: 1 }); left.fire('pointerdown', { pointerId: 2 });
  doc.fire('pointerup', { pointerId: 1 });
  assert.equal(tick(controls, match).left, true); assert.equal(left.classes.has('pressed'), true);
  left.fire('lostpointercapture', { pointerId: 2 });
  assert.equal(tick(controls, match).left, false); assert.equal(left.classes.has('pressed'), false);
});

test('a released jump tap waits for landing within the 120 ms buffer', () => {
  const controls = new VolleyballControls(), match = game();
  match.players[0].y = ground - 4; match.players[0].vy = 100;
  tap(controls, 'KeyW');
  assert.equal(tick(controls, match).jump, false);
  let accepted = false;
  for (let i = 0; i < 10; i++) accepted = tick(controls, match).jump || accepted;
  assert.equal(accepted, true); assert.ok(match.players[0].vy < 0);
});

test('released slide and spike taps survive cooldown until the engine accepts them', () => {
  const slideControls = new VolleyballControls(), sliding = game();
  sliding.players[0].slideCooldown = .04;
  tap(slideControls, 'ShiftLeft');
  assert.equal(tick(slideControls, sliding).slide, false);
  const slideBits = Array.from({ length: 8 }, () => tick(slideControls, sliding).slide);
  assert.equal(slideBits.filter(Boolean).length, 1);
  assert.equal(sliding.events.filter(e => e.type === 'slide' && e.side === 0).length, 1);

  const spikeControls = new VolleyballControls(), spiking = game();
  spiking.players[0].y = ground - 100; spiking.players[0].cooldown = .04;
  tap(spikeControls, 'Space');
  assert.equal(tick(spikeControls, spiking).spike, false);
  const spikeBits = Array.from({ length: 8 }, () => tick(spikeControls, spiking).spike);
  assert.equal(spikeBits.filter(Boolean).length, 1); assert.ok(spiking.players[0].spike > 0);
});

test('jump and spike tapped together keep spike buffered until sufficient height', () => {
  const controls = new VolleyballControls(), match = game();
  tap(controls, 'KeyW'); tap(controls, 'Space');
  const first = tick(controls, match);
  assert.equal(first.jump, true); assert.equal(first.spike, false);
  assert.equal(tick(controls, match).spike, false);
  assert.equal(tick(controls, match).spike, true);
  assert.ok(match.players[0].spike > 0);
});

test('spike eligibility accounts for this tick crossing the downward height threshold', () => {
  const controls = new VolleyballControls(), match = game();
  match.players[0].y = ground - 16; match.players[0].vy = 240;
  tap(controls, 'Space');
  assert.equal(tick(controls, match).spike, false, 'the engine would reject spike after descending');
  match.players[0].y = ground - 60; match.players[0].vy = 0;
  assert.equal(tick(controls, match).spike, true, 'an ineligible tick did not consume the tap');
});

test('jump remains buffered when a simultaneous slide takes priority', () => {
  const controls = new VolleyballControls(), match = game();
  tap(controls, 'ShiftLeft'); tap(controls, 'KeyW');
  const first = tick(controls, match);
  assert.equal(first.slide, true); assert.equal(first.jump, false);
  match.players[0].slide = .02;
  assert.equal(tick(controls, match).jump, false);
  assert.equal(tick(controls, match).jump, false);
  assert.equal(tick(controls, match).jump, true);
});

test('expired quick taps do not trigger later and point ticks do not consume eligible requests', () => {
  const controls = new VolleyballControls(), match = game();
  match.players[0].y = ground - 100; match.players[0].vy = -200;
  tap(controls, 'KeyW');
  for (let i = 0; i < 16; i++) assert.equal(tick(controls, match).jump, false);
  match.players[0].y = ground; match.players[0].vy = 0;
  assert.equal(tick(controls, match).jump, false);
  match.phase = 'point'; match.timer = DT;
  tap(controls, 'KeyW');
  assert.equal(tick(controls, match).jump, false);
  assert.equal(match.phase, 'serve');
  assert.equal(tick(controls, match).jump, true);
});

test('holding jump or slide never repeats after landing/cooldown/rally reset', () => {
  for (const [code, action] of [['KeyW', 'jump'], ['ShiftLeft', 'slide']]) {
    const controls = new VolleyballControls(), match = game();
    controls.keyDown(code);
    assert.equal(tick(controls, match)[action], true);
    for (let i = 0; i < 160; i++) {
      controls.keyDown(code, { repeat: true });
      assert.equal(tick(controls, match)[action], false);
    }
    match.resetRally(); match.timer = 10;
    assert.equal(tick(controls, match)[action], false);
    controls.keyUp(code); controls.keyDown(code);
    assert.equal(tick(controls, match)[action], true);
  }
});

test('a new tap while engine edge state is held waits for a release tick', () => {
  const controls = new VolleyballControls(), match = game();
  tap(controls, 'ShiftLeft'); assert.equal(tick(controls, match).slide, true);
  match.players[0].slide = 0; match.players[0].slideCooldown = 0;
  tap(controls, 'ShiftRight');
  assert.equal(tick(controls, match).slide, false);
  assert.equal(tick(controls, match).slide, true);
});

test('held spike retains the existing cooldown repeat while held jump stays single', () => {
  const controls = new VolleyballControls(), match = game();
  controls.keyDown('KeyW'); controls.keyDown('Space');
  let jumps = 0, spikes = 0;
  for (let i = 0; i < 115; i++) {
    const input = tick(controls, match);
    jumps += Number(input.jump); spikes += Number(input.spike);
  }
  assert.equal(jumps, 1); assert.equal(spikes, 2);
});

test('touch quick tap survives release, but cancel/lost capture discard its pending action', () => {
  for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    const { controls, doc, buttons: [, , jump] } = touchSetup(), match = game();
    jump.fire('pointerdown');
    (ending === 'lostpointercapture' ? jump : doc).fire(ending);
    if (ending === 'pointerup') jump.fire('lostpointercapture');
    assert.equal(tick(controls, match).jump, ending === 'pointerup', ending);
    assert.equal(jump.classes.has('pressed'), false);
  }
});

test('clear/blur/unbind release input, buffers, styling, and captured pointers', () => {
  for (const ending of ['clear', 'blur', 'unbind']) {
    const { controls, doc, buttons: [left, , jump], unbind } = touchSetup(), match = game();
    left.fire('pointerdown', { pointerId: 1 }); jump.fire('pointerdown', { pointerId: 2 });
    controls.keyDown('KeyD');
    if (ending === 'clear') controls.clear();
    else if (ending === 'blur') doc.defaultView.fire('blur');
    else unbind();
    assert.equal(encodeInput(tick(controls, match)), 0, ending);
    assert.equal(left.classes.has('pressed'), false); assert.equal(jump.classes.has('pressed'), false);
    assert.equal(left.captures.size, 0); assert.equal(jump.captures.size, 0);
    if (ending === 'unbind') {
      left.fire('pointerdown');
      assert.equal(encodeInput(tick(controls, match)), 0);
    }
  }
});

test('inactive touch controls, nonprimary buttons, and repeat-only key events are ignored', () => {
  const { controls, buttons: [left] } = touchSetup(() => false), match = game();
  left.fire('pointerdown'); controls.keyDown('KeyW', { repeat: true });
  assert.equal(encodeInput(tick(controls, match)), 0);
  const active = touchSetup();
  active.buttons[0].fire('pointerdown', { button: 2 });
  assert.equal(encodeInput(tick(active.controls, match)), 0);
  assert.ok(GAME_KEYS.includes('Space')); assert.equal(GAME_KEYS.includes('Escape'), false);
  assert.equal(isGameInputTarget({ closest: selector => selector.includes('contenteditable') ? {} : null }), false);
  assert.equal(isGameInputTarget({ closest: () => null }), true);
});

test('recorded sampled controls reproduce the same engine state without the controller', () => {
  const controls = new VolleyballControls(), live = game(), replayed = game();
  for (let frame = 0; frame < 300; frame++) {
    if (frame === 0) controls.keyDown('KeyD');
    if (frame === 12 || frame === 180) tap(controls, 'KeyW');
    if (frame === 13 || frame === 182) tap(controls, 'Space');
    if (frame === 34) controls.keyUp('KeyD');
    if (frame === 106) tap(controls, 'ShiftLeft');
    const before = JSON.stringify(live);
    const sampled = controls.sample(live, DT);
    assert.equal(JSON.stringify(live), before, 'sampling never mutates the engine');
    const recorded = encodeInput(sampled);
    live.step(DT, sampled); replayed.step(DT, decodeInput(recorded));
  }
  assert.deepEqual(live, replayed);
});
