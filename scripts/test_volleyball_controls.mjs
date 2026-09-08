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
  listenerOptions = new Map();
  addEventListener(type, fn, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    this.listenerOptions.set(type, options);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  contains(target) {
    for (let node = target; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  fire(type, options = {}) {
    const event = { target: this, pointerId: 1, button: 0, clientX: 10, clientY: 10, prevented: false,
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
function touchSetup(isActive = () => true, binding = {}, names = ['left', 'right', 'jump', 'slide', 'spike']) {
  const controls = new VolleyballControls(), doc = new Surface();
  doc.defaultView = new Surface();
  const buttons = names.map((name, i) => new Button(name, i * 60));
  const groups = [new Surface(), new Surface()];
  buttons.forEach((button, i) => { button.parentElement = groups[i < 2 ? 0 : 1]; });
  const unbind = controls.bindTouchControls(buttons, { document: doc, isActive, ...binding });
  return { controls, doc, buttons, groups, unbind };
}
const nativeSetup = () => touchSetup(() => true, { touchEvents: true }, ['left', 'right', 'jump', 'slide', 'attack']);
const touchPoint = (identifier, target, overrides = {}) => ({ identifier, target, clientX: (target.left ?? 0) + 10, clientY: 10, ...overrides });
// Deliberately array-like rather than iterable, as TouchList is in older WebKit.
const touchList = points => Object.assign({ length: points.length, item: index => points[index] ?? null }, points);
const fireTouch = (target, type, changed, active = changed) => target.fire(type, {
  cancelable: true, changedTouches: touchList(changed), touches: touchList(active),
  targetTouches: touchList(active.filter(point => target.contains(point.target)))
});

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

test('native Touch Events process every changed identifier and independently release contacts', () => {
  const { controls, doc, buttons: [left, right, jump] } = nativeSetup(), match = game();
  const moving = touchPoint(41, left), jumping = touchPoint(7, jump);
  const start = fireTouch(left, 'touchstart', [moving, jumping]);
  assert.equal(start.prevented, true);
  const first = tick(controls, match);
  assert.equal(first.left, true); assert.equal(first.jump, true);
  fireTouch(doc, 'touchmove', [{ ...moving, clientX: 75 }], [moving, jumping]);
  assert.equal(tick(controls, match).right, true);
  fireTouch(doc, 'touchend', [jumping], [moving]);
  assert.equal(tick(controls, match).right, true);
  assert.equal(right.classes.has('pressed'), true); assert.equal(jump.classes.has('pressed'), false);
  fireTouch(doc, 'touchend', [moving], []);
  assert.equal(encodeInput(tick(controls, match)), 0);
});

test('native touches starting on nested button labels resolve to their own controls', () => {
  const { controls, buttons: [left, , jump] } = nativeSetup(), match = game();
  const label = { parentElement: jump };
  fireTouch(left, 'touchstart', [touchPoint(1, left), touchPoint(2, label, { clientX: 130 })]);
  const input = tick(controls, match);
  assert.equal(input.left, true); assert.equal(input.jump, true);
});

test('native touchcancel removes only changed contacts and their pending action', () => {
  const { controls, doc, buttons: [left, , jump] } = nativeSetup(), match = game();
  const moving = touchPoint(1, left), jumping = touchPoint(2, jump);
  fireTouch(left, 'touchstart', [moving, jumping]);
  fireTouch(doc, 'touchcancel', [jumping], [moving]);
  const input = tick(controls, match);
  assert.equal(input.left, true); assert.equal(input.jump, false);
  fireTouch(doc, 'touchcancel', [moving], []);
  assert.equal(encodeInput(tick(controls, match)), 0);
});

test('native event handlers are non-passive and ignore unrelated page touches', () => {
  const { controls, doc, groups, buttons: [left] } = nativeSetup(), match = game();
  assert.equal(left.listenerOptions.get('touchstart').passive, false);
  assert.equal(groups[0].listenerOptions.get('touchstart').passive, false);
  for (const type of ['touchmove', 'touchend', 'touchcancel']) assert.equal(doc.listenerOptions.get(type).passive, false);
  const other = touchPoint(80, new Surface());
  assert.equal(fireTouch(left, 'touchstart', [other]).prevented, false);
  assert.equal(fireTouch(doc, 'touchmove', [other]).prevented, false);
  assert.equal(fireTouch(doc, 'touchend', [other], []).prevented, false);
  assert.equal(encodeInput(tick(controls, match)), 0);
});

test('a native touch starting in a control-group gap can enter an arrow', () => {
  const { controls, doc, groups, buttons: [left] } = nativeSetup(), match = game();
  const gap = touchPoint(5, groups[0], { clientX: 55 });
  assert.equal(fireTouch(groups[0], 'touchstart', [gap]).prevented, true);
  assert.equal(encodeInput(tick(controls, match)), 0);
  fireTouch(doc, 'touchmove', [{ ...gap, clientX: 10 }]);
  assert.equal(tick(controls, match).left, true); assert.equal(left.classes.has('pressed'), true);
  fireTouch(doc, 'touchend', [gap], []);
  assert.equal(tick(controls, match).left, false);
});

test('touch-capable browsers suppress duplicate touch pointers while mouse and pen remain independent', () => {
  const { controls, doc, buttons: [left, right, jump] } = nativeSetup(), match = game();
  const moving = touchPoint(4, left);
  left.fire('pointerdown', { pointerId: 4, pointerType: 'touch' });
  fireTouch(left, 'touchstart', [moving]);
  fireTouch(doc, 'touchend', [moving], []);
  assert.equal(tick(controls, match).left, false, 'a duplicate pointer did not retain a released native touch');
  jump.fire('pointerdown', { pointerId: 9, pointerType: 'touch' });
  assert.equal(tick(controls, match).jump, false, 'only Touch Events own physical touch on this path');
  left.fire('pointerdown', { pointerId: 4, pointerType: 'mouse' });
  right.fire('pointerdown', { pointerId: 10, pointerType: 'pen', isPrimary: false });
  const input = tick(controls, match);
  assert.equal(input.left, true); assert.equal(input.right, true);
  doc.fire('pointerup', { pointerId: 4, pointerType: 'touch' });
  assert.equal(tick(controls, match).left, true, 'ignored touch pointers do not release a mouse with the same ID');
  doc.fire('pointerup', { pointerId: 4, pointerType: 'mouse' });
  assert.equal(tick(controls, match).left, false); assert.equal(tick(controls, match).right, true);
});

test('pointer fallback accepts secondary touch pointers and independent release', () => {
  const { controls, doc, buttons: [left, , jump] } = touchSetup(() => true, { touchEvents: false }), match = game();
  left.fire('pointerdown', { pointerId: 10, pointerType: 'touch', isPrimary: true });
  jump.fire('pointerdown', { pointerId: 20, pointerType: 'touch', isPrimary: false });
  const input = tick(controls, match);
  assert.equal(input.left, true); assert.equal(input.jump, true);
  doc.fire('pointerup', { pointerId: 20, pointerType: 'touch', isPrimary: false });
  assert.equal(tick(controls, match).left, true);
  doc.fire('pointercancel', { pointerId: 10, pointerType: 'touch', isPrimary: true });
  assert.equal(tick(controls, match).left, false);
});

test('touch feature detection selects the native path when the window advertises it', () => {
  const controls = new VolleyballControls(), doc = new Surface(), left = new Button('left', 0), match = game();
  doc.defaultView = new Surface(); doc.defaultView.ontouchstart = null;
  controls.bindTouchControls([left], { document: doc });
  assert.ok(left.listeners.get('touchstart')?.size);
  left.fire('pointerdown', { pointerType: 'touch' });
  assert.equal(tick(controls, match).left, false);
  fireTouch(left, 'touchstart', [touchPoint(77, left)]);
  assert.equal(tick(controls, match).left, true);
});

test('a movement thumb plus a quick attack tap makes one jump and one high strike', () => {
  const { controls, doc, buttons: [left, , , , attack] } = nativeSetup(), match = game();
  const moving = touchPoint(1, left), attacking = touchPoint(2, attack);
  fireTouch(left, 'touchstart', [moving, attacking]);
  fireTouch(doc, 'touchend', [attacking], [moving]);
  let jumps = 0, spikes = 0, strikeTick = 0;
  for (let i = 0; i < 150; i++) {
    const input = tick(controls, match);
    assert.equal(input.left, true);
    jumps += Number(input.jump); spikes += Number(input.spike);
    if (input.spike) { strikeTick = i; assert.ok(ground - match.players[0].y >= 110); }
  }
  assert.equal(jumps, 1); assert.equal(spikes, 1);
  assert.ok(strikeTick > 16 && strikeTick < 40, `strike tick ${strikeTick} is during the first jump's high ascent`);
});

test('holding attack never repeats a jump or strike, including after a rally reset', () => {
  const { controls, buttons: [, , , , attack] } = nativeSetup(), match = game();
  fireTouch(attack, 'touchstart', [touchPoint(1, attack)]);
  let jumps = 0, spikes = 0;
  for (let i = 0; i < 250; i++) {
    if (i === 150) { match.resetRally(); match.timer = 10; }
    const input = tick(controls, match);
    jumps += Number(input.jump); spikes += Number(input.spike);
  }
  assert.equal(jumps, 1); assert.equal(spikes, 1);
});

test('a new airborne attack strikes immediately without queuing a landing jump', () => {
  const { controls, doc, buttons: [, , , , attack] } = nativeSetup(), match = game();
  match.players[0].y = ground - 60;
  const attacking = touchPoint(1, attack);
  fireTouch(attack, 'touchstart', [attacking]); fireTouch(doc, 'touchend', [attacking], []);
  const first = tick(controls, match);
  assert.equal(first.jump, false); assert.equal(first.spike, true);
  for (let i = 0; i < 120; i++) assert.equal(tick(controls, match).jump, false);
});

test('dragging an action finger from jump to attack changes intent while movement continues', () => {
  const { controls, doc, buttons: [left, , jump, , attack] } = nativeSetup(), match = game();
  const moving = touchPoint(1, left), acting = touchPoint(2, jump);
  fireTouch(left, 'touchstart', [moving, acting]);
  assert.equal(tick(controls, match).jump, true);
  for (let i = 0; i < 8; i++) tick(controls, match);
  fireTouch(doc, 'touchmove', [{ ...acting, clientX: attack.left + 10 }], [moving, acting]);
  const input = tick(controls, match);
  assert.equal(input.left, true); assert.equal(input.spike, true); assert.equal(input.jump, false);
  assert.equal(jump.classes.has('pressed'), false); assert.equal(attack.classes.has('pressed'), true);
});

test('attack drift through neutral space preserves one strike and re-entry never retriggers', () => {
  const { controls, doc, buttons: [, , , , attack] } = nativeSetup(), match = game();
  const attacking = touchPoint(2, attack);
  fireTouch(attack, 'touchstart', [attacking]);
  let jumps = 0, spikes = 0;
  for (let i = 0; i < 180; i++) {
    if (i === 2 || i === 120) fireTouch(doc, 'touchmove', [{ ...attacking, clientX: -20 }]);
    if (i === 4 || i === 122) fireTouch(doc, 'touchmove', [attacking]);
    const input = tick(controls, match);
    jumps += Number(input.jump); spikes += Number(input.spike);
  }
  assert.equal(jumps, 1); assert.equal(spikes, 1);
});

test('neutral drift before a tick retains a pending attack but a different action replaces it', () => {
  for (const differentAction of [false, true]) {
    const { controls, doc, buttons: [, , , slide, attack] } = nativeSetup(), match = game();
    const attacking = touchPoint(2, attack);
    fireTouch(attack, 'touchstart', [attacking]);
    fireTouch(doc, 'touchmove', [{ ...attacking, clientX: -20 }]);
    if (differentAction) fireTouch(doc, 'touchmove', [{ ...attacking, clientX: slide.left + 10 }]);
    const first = tick(controls, match);
    assert.equal(first.jump, !differentAction); assert.equal(first.slide, differentAction);
    let strikes = 0;
    for (let i = 0; i < 140; i++) strikes += Number(tick(controls, match).spike);
    assert.equal(strikes, differentAction ? 0 : 1);
  }
});

test('quick attack release followed by lost pointer capture keeps its one-shot strike armed', () => {
  for (const native of [false, true]) {
    const { controls, doc, buttons: [, , , , attack] } = touchSetup(() => true,
      { touchEvents: native }, ['left', 'right', 'jump', 'slide', 'attack']);
    const match = game(), attacking = touchPoint(2, attack);
    if (native) {
      fireTouch(attack, 'touchstart', [attacking]); fireTouch(doc, 'touchend', [attacking], []);
    } else {
      attack.fire('pointerdown', { pointerId: 2, pointerType: 'touch' });
      doc.fire('pointerup', { pointerId: 2, pointerType: 'touch' });
    }
    attack.fire('lostpointercapture', { pointerId: 2, pointerType: 'touch' });
    let jumps = 0, spikes = 0;
    for (let i = 0; i < 130; i++) {
      const input = tick(controls, match);
      jumps += Number(input.jump); spikes += Number(input.spike);
    }
    assert.equal(jumps, 1); assert.equal(spikes, 1);
  }
});

test('native cancel/clear/blur and rally transitions cancel a pending jump-attack sequence', () => {
  for (const ending of ['touchcancel', 'clear', 'blur', 'point', 'reset', 'over']) {
    const { controls, doc, buttons: [left, , , , attack] } = nativeSetup(), match = game();
    const moving = touchPoint(1, left), attacking = touchPoint(2, attack);
    fireTouch(left, 'touchstart', [moving, attacking]);
    assert.equal(tick(controls, match).jump, true);
    if (ending === 'touchcancel') fireTouch(doc, 'touchcancel', [attacking], [moving]);
    else if (ending === 'clear') controls.clear();
    else if (ending === 'blur') doc.defaultView.fire('blur');
    else if (ending === 'reset') { match.resetRally(); match.timer = 10; }
    else { match.phase = ending; match.timer = DT; }
    for (let i = 0; i < 150; i++) {
      const input = tick(controls, match);
      assert.equal(input.spike, false, ending); assert.equal(input.jump, false, ending);
      if (ending === 'touchcancel') assert.equal(input.left, true, 'other thumb survives native cancellation');
    }
  }
});

test('attack pressed during point intermission never revives in the next serve', () => {
  const { controls, buttons: [, , , , attack] } = nativeSetup(), match = game();
  match.phase = 'point'; match.timer = DT;
  fireTouch(attack, 'touchstart', [touchPoint(1, attack)]);
  assert.equal(encodeInput(tick(controls, match)), 0);
  for (let i = 0; i < 140; i++) assert.equal(encodeInput(tick(controls, match)), 0);
});

test('native movement and jump-attack bits replay exactly without controller assistance', () => {
  const { controls, doc, buttons: [left, right, , , attack] } = nativeSetup(), live = game(), replayed = game();
  const moving = touchPoint(5, right), attacking = touchPoint(8, attack);
  const sampledChanges = [];
  for (let i = 0; i < 260; i++) {
    if (i === 0) fireTouch(right, 'touchstart', [moving, attacking]);
    if (i === 1) fireTouch(doc, 'touchend', [attacking], [moving]);
    if (i === 24) fireTouch(doc, 'touchmove', [{ ...moving, clientX: left.left + 10 }], [moving]);
    if (i === 60) fireTouch(doc, 'touchend', [moving], []);
    const before = JSON.stringify(live), input = controls.sample(live, DT), bits = encodeInput(input);
    assert.equal(JSON.stringify(live), before);
    sampledChanges.push(bits);
    live.step(DT, input); replayed.step(DT, decodeInput(bits));
  }
  assert.equal(sampledChanges.filter(bits => bits & 4).length, 1);
  assert.equal(sampledChanges.filter(bits => bits & 8).length, 1);
  assert.deepEqual(live, replayed);
});
