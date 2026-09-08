import { FLOOR, R } from './engine.mjs?v=6';

export const ACTION_BUFFER_SECONDS = .12;
const KEY_ACTIONS = Object.freeze({
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'jump', KeyW: 'jump', Space: 'spike',
  ArrowDown: 'slide', KeyS: 'slide', ShiftLeft: 'slide', ShiftRight: 'slide'
});
export const GAME_KEYS = Object.freeze(Object.keys(KEY_ACTIONS));
const ACTIONS = ['jump', 'slide', 'spike'];
const BUTTON_ACTIONS = [...ACTIONS, 'attack'];
const DIRECTIONS = ['left', 'right'];
const emptyInput = () => ({ left: false, right: false, jump: false, spike: false, slide: false });

// Keep the game's global keydown handler (including P/Escape and phase checks)
// outside this module. Always deliver keyup, even when focus moved to a form.
export function isGameInputTarget(target) {
  return !target?.closest?.('select,input,textarea,button,a,summary,[role="textbox"],[contenteditable]:not([contenteditable="false"])');
}

/**
 * Browser events only update intent. For every fixed simulation tick, call
 * sample(match, dt), record those returned controls, then pass the same object
 * to match.step(dt, controls). Do not clear buffers after stepping.
 *
 * Call clear() when pausing, restarting, starting, or ending a match. Touch
 * binding also clears on window blur. This module never starts/resumes a match,
 * plays audio, handles global hotkeys, or changes the engine/replay rules.
 */
export class VolleyballControls {
  #keys = new Set();
  #touches = new Map();
  #pending = new Map();
  #buttons = [];
  #time = 0;
  #bufferSeconds;
  #unbind = null;
  #combo = null;

  constructor({ bufferSeconds = ACTION_BUFFER_SECONDS } = {}) {
    if (!Number.isFinite(bufferSeconds) || bufferSeconds <= 0) throw new RangeError('bufferSeconds must be positive');
    this.#bufferSeconds = bufferSeconds;
  }

  #held(action) {
    for (const code of this.#keys) if (KEY_ACTIONS[code] === action) return true;
    for (const touch of this.#touches.values()) if (touch.action === action) return true;
    return false;
  }

  #request(action, source, wasHeld) {
    if (!wasHeld && BUTTON_ACTIONS.includes(action)) {
      this.#pending.set(action, { until: this.#time + this.#bufferSeconds, source });
    }
  }

  keyDown(code, { repeat = false } = {}) {
    const action = KEY_ACTIONS[code];
    if (!action || repeat || this.#keys.has(code)) return false;
    const wasHeld = this.#held(action);
    this.#keys.add(code);
    this.#request(action, `key:${code}`, wasHeld);
    this.#paint();
    return true;
  }

  keyUp(code) {
    this.#keys.delete(code);
    this.#paint();
  }

  #paint() {
    for (const button of this.#buttons) button.classList.toggle('pressed', this.#held(button.dataset.control));
  }

  clear() {
    const captured = [...this.#touches.entries()];
    this.#keys.clear(); this.#touches.clear(); this.#pending.clear();
    this.#time = 0; this.#combo = null;
    this.#paint();
    for (const [, touch] of captured) {
      try {
        if (touch.pointerId !== undefined && touch.owner.hasPointerCapture?.(touch.pointerId)) touch.owner.releasePointerCapture(touch.pointerId);
      } catch { /* The browser may already have released a cancelled pointer. */ }
    }
  }

  sample(match, dt = 1 / 120) {
    if (!Number.isFinite(dt) || dt <= 0) throw new RangeError('dt must be positive');
    const step = Math.min(dt, 1 / 60);
    const controls = emptyInput();
    for (const [action, request] of this.#pending) {
      if (request.until <= this.#time + 1e-9) this.#pending.delete(action);
    }
    const p = match.players[0];
    if (!['serve', 'playing'].includes(match.phase)) {
      this.#pending.delete('attack'); this.#combo = null;
    }
    if (this.#combo && (this.#combo.player !== p || this.#combo.until <= this.#time + 1e-9)) this.#combo = null;
    if (['serve', 'playing', 'point'].includes(match.phase)) {
      controls.left = this.#held('left'); controls.right = this.#held('right');
      if (match.phase !== 'point') {
        const grounded = p.y >= FLOOR - R - .1;
        const attack = this.#pending.get('attack');
        if (attack) {
          // One explicit attack press becomes one jump/strike sequence. An
          // airborne press is a manual strike and never queues another jump.
          this.#combo = { ...attack, player: p, stage: grounded ? 'jump' : 'spike' };
          this.#pending.delete('attack');
        }
        if (this.#combo?.stage === 'rise' && grounded) this.#combo = null;
        const wants = action => this.#pending.has(action);
        // These read-only gates follow the shared engine's step order: cooldowns tick
        // first; slide takes priority over jump; spike checks the updated y.
        controls.slide = wants('slide') && !p.slideHeld && p.slideCooldown <= step && grounded;
        controls.jump = (wants('jump') || this.#combo?.stage === 'jump') && !p.jumpHeld && !controls.slide && p.slide <= step && grounded;
        if (controls.jump && this.#combo?.stage === 'jump') {
          this.#combo.stage = 'rise'; this.#combo.until = this.#time + 1.1;
        }
        const nextY = Math.min(FLOOR - R, p.y + ((controls.jump ? -735 : p.vy) + 1800 * step) * step);
        // Trigger by player height only, without aiming at or following the
        // ball. A normal release keeps this one strike armed until accepted.
        const comboStrike = this.#combo?.stage === 'spike' || (this.#combo?.stage === 'rise' &&
          (nextY <= FLOOR - R - 110 || (!controls.jump && p.vy >= 0 && nextY < FLOOR - R - 15)));
        controls.spike = (wants('spike') || this.#held('spike') || comboStrike) && p.cooldown <= step && nextY < FLOOR - R - 15;
        if (controls.spike) this.#combo = null;
        for (const action of ACTIONS) if (controls[action]) this.#pending.delete(action);
      }
    }
    // Simulation time, rather than event timestamps or wall time, keeps the
    // buffering independent of rendering cadence. Only accepted bits replay.
    this.#time += step;
    return controls;
  }

  /**
   * Bind data-control buttons, including attack (one jump + high strike).
   * Arrows share one drag region; action buttons share another. Contacts may
   * start in either group's gaps and move into a button. All contacts remain
   * independent. isActive should allow playing/serve/point only.
   *
   * Touch-capable browsers use non-passive Touch Events and changedTouches
   * identifiers. Mouse/pen use Pointer Events; browsers without Touch Events
   * also use the pointer path for touch. touchEvents optionally overrides this
   * feature detection for testing. CSS must set touch-action:none on the pad.
   * Returns a cleanup function; clear() retains the binding.
   */
  bindTouchControls(buttons, { document: doc = globalThis.document, isActive = () => true,
    touchEvents = 'ontouchstart' in (doc?.defaultView ?? {}) } = {}) {
    this.#unbind?.();
    this.#buttons = [...buttons];
    const removeListeners = [];
    const groups = [...new Set(this.#buttons.map(button => button.parentElement).filter(Boolean))];
    const listen = (target, type, handler, options) => {
      target?.addEventListener(type, handler, options);
      removeListeners.push(() => target?.removeEventListener(type, handler, options));
    };
    const cancelSource = source => {
      for (const [action, request] of this.#pending) if (request.source === source) this.#pending.delete(action);
      if (this.#combo?.source === source) this.#combo = null;
    };
    const release = (source, cancelled = false) => {
      const touch = this.#touches.get(source);
      if (!touch) return;
      this.#touches.delete(source);
      if (cancelled) cancelSource(source);
      this.#paint();
    };
    const hitButton = (point, candidates) => candidates.find(button => {
        const box = button.getBoundingClientRect();
        return point.clientX >= box.left && point.clientX < box.right && point.clientY >= box.top && point.clientY < box.bottom;
    });
    const origin = (target, point) => {
      const button = this.#buttons.find(button => button === target || button.contains?.(target));
      if (button) return { action: button.dataset.control, owner: button, directional: DIRECTIONS.includes(button.dataset.control) };
      const group = groups.find(group => group === target || group.contains?.(target));
      if (!group) return null;
      const members = this.#buttons.filter(button => button.parentElement === group);
      return { action: hitButton(point, members)?.dataset.control ?? null, owner: group,
        directional: members.every(button => DIRECTIONS.includes(button.dataset.control)) };
    };
    const begin = (source, target, point, pointerId) => {
      if (!isActive() || this.#touches.has(source)) return false;
      const touch = origin(target, point);
      if (!touch || (touch.action && ![...DIRECTIONS, ...BUTTON_ACTIONS].includes(touch.action))) return false;
      const wasHeld = this.#held(touch.action);
      this.#touches.set(source, { ...touch, lastAction: touch.action, pointerId });
      this.#request(touch.action, source, wasHeld);
      if (pointerId !== undefined) {
        try { touch.owner.setPointerCapture(pointerId); } catch { /* Document listeners still release the pointer. */ }
      }
      this.#paint();
      return true;
    };
    const move = (source, point) => {
      const touch = this.#touches.get(source);
      if (!touch) return false;
      const action = hitButton(point, this.#buttons.filter(button =>
        DIRECTIONS.includes(button.dataset.control) === touch.directional))?.dataset.control ?? null;
      if (action !== touch.action) {
        // Thumb drift through a gap is like releasing a quick tap: retain its
        // one-shot intent, and don't create another press on re-entry. Only
        // entering a different action explicitly replaces the old request.
        const changedIntent = action && action !== touch.lastAction;
        if (changedIntent) cancelSource(source);
        const wasHeld = this.#held(action);
        touch.action = action;
        if (action) touch.lastAction = action;
        if (changedIntent) this.#request(action, source, wasHeld);
        this.#paint();
      }
      return true;
    };
    const ignoresPointer = event => touchEvents && event.pointerType === 'touch';
    for (const target of [...this.#buttons, ...groups]) {
      listen(target, 'pointerdown', event => {
        if (ignoresPointer(event)) return;
        if (!isActive() || (event.button !== undefined && event.button !== 0)) return;
        if (begin(`pointer:${event.pointerId}`, event.target ?? target, event, event.pointerId)) event.preventDefault();
      });
      listen(target, 'lostpointercapture', event => { if (!ignoresPointer(event)) release(`pointer:${event.pointerId}`, true); });
      listen(target, 'contextmenu', event => event.preventDefault());
      if (touchEvents) listen(target, 'touchstart', event => {
        let owned = false;
        for (const touch of Array.from(event.changedTouches ?? [])) {
          owned = begin(`touch:${touch.identifier}`, touch.target ?? event.target ?? target, touch) || owned;
        }
        if (owned && event.cancelable !== false) event.preventDefault();
      }, { passive: false });
    }
    listen(doc, 'pointermove', event => {
      if (!ignoresPointer(event) && move(`pointer:${event.pointerId}`, event)) event.preventDefault();
    });
    listen(doc, 'pointerup', event => { if (!ignoresPointer(event)) release(`pointer:${event.pointerId}`); });
    listen(doc, 'pointercancel', event => { if (!ignoresPointer(event)) release(`pointer:${event.pointerId}`, true); });
    if (touchEvents) {
      listen(doc, 'touchmove', event => {
        let owned = false;
        for (const touch of Array.from(event.changedTouches ?? [])) owned = move(`touch:${touch.identifier}`, touch) || owned;
        if (owned && event.cancelable !== false) event.preventDefault();
      }, { passive: false });
      for (const ending of ['touchend', 'touchcancel']) listen(doc, ending, event => {
        let owned = false;
        for (const touch of Array.from(event.changedTouches ?? [])) {
          const source = `touch:${touch.identifier}`;
          owned = this.#touches.has(source) || owned;
          release(source, ending === 'touchcancel');
        }
        if (owned && event.cancelable !== false) event.preventDefault();
      }, { passive: false });
    }
    listen(doc?.defaultView, 'blur', () => this.clear());
    this.#paint();
    const unbind = () => {
      if (this.#unbind !== unbind) return;
      removeListeners.forEach(remove => remove());
      this.clear(); this.#buttons = []; this.#unbind = null;
    };
    this.#unbind = unbind;
    return unbind;
  }
}
