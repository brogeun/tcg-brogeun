import { FLOOR, R } from './engine.mjs?v=6';

export const ACTION_BUFFER_SECONDS = .12;
const KEY_ACTIONS = Object.freeze({
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'jump', KeyW: 'jump', Space: 'spike',
  ArrowDown: 'slide', KeyS: 'slide', ShiftLeft: 'slide', ShiftRight: 'slide'
});
export const GAME_KEYS = Object.freeze(Object.keys(KEY_ACTIONS));
const ACTIONS = ['jump', 'slide', 'spike'];
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
    if (!wasHeld && ACTIONS.includes(action)) {
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
    this.#time = 0;
    this.#paint();
    for (const [pointerId, touch] of captured) {
      try {
        if (touch.owner.hasPointerCapture?.(pointerId)) touch.owner.releasePointerCapture(pointerId);
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
    if (['serve', 'playing', 'point'].includes(match.phase)) {
      controls.left = this.#held('left'); controls.right = this.#held('right');
      if (match.phase !== 'point') {
        const p = match.players[0];
        const grounded = p.y >= FLOOR - R - .1;
        const wants = action => this.#pending.has(action);
        // These read-only gates follow the shared engine's step order: cooldowns tick
        // first; slide takes priority over jump; spike checks the updated y.
        controls.slide = wants('slide') && !p.slideHeld && p.slideCooldown <= step && grounded;
        controls.jump = wants('jump') && !p.jumpHeld && !controls.slide && p.slide <= step && grounded;
        const nextY = Math.min(FLOOR - R, p.y + ((controls.jump ? -735 : p.vy) + 1800 * step) * step);
        controls.spike = (wants('spike') || this.#held('spike')) && p.cooldown <= step && nextY < FLOOR - R - 15;
        for (const action of ACTIONS) if (controls[action]) this.#pending.delete(action);
      }
    }
    // Simulation time, rather than event timestamps or wall time, keeps the
    // buffering independent of rendering cadence. Only accepted bits replay.
    this.#time += step;
    return controls;
  }

  /**
   * Bind data-control buttons. A pointer that starts on an arrow can move to
   * either arrow (or neutral space) while captured. Action fingers remain
   * independent. isActive should allow playing/serve/point only.
   * Returns a cleanup function; clear() retains the binding.
   */
  bindTouchControls(buttons, { document: doc = globalThis.document, isActive = () => true } = {}) {
    this.#unbind?.();
    this.#buttons = [...buttons];
    const removeListeners = [];
    const listen = (target, type, handler) => {
      target?.addEventListener(type, handler);
      removeListeners.push(() => target?.removeEventListener(type, handler));
    };
    const release = (event, cancelled = false) => {
      const touch = this.#touches.get(event.pointerId);
      if (!touch) return;
      this.#touches.delete(event.pointerId);
      if (cancelled && this.#pending.get(touch.action)?.source === `pointer:${event.pointerId}`) {
        this.#pending.delete(touch.action);
      }
      this.#paint();
    };
    const move = event => {
      const touch = this.#touches.get(event.pointerId);
      if (!touch?.directional) return;
      event.preventDefault();
      touch.action = this.#buttons.find(button => {
        if (!DIRECTIONS.includes(button.dataset.control)) return false;
        const box = button.getBoundingClientRect();
        return event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom;
      })?.dataset.control ?? null;
      this.#paint();
    };
    for (const button of this.#buttons) {
      listen(button, 'pointerdown', event => {
        if (!isActive() || (event.button !== undefined && event.button !== 0)) return;
        const action = button.dataset.control;
        if (![...DIRECTIONS, ...ACTIONS].includes(action)) return;
        event.preventDefault();
        const wasHeld = this.#held(action);
        this.#touches.set(event.pointerId, { action, owner: button, directional: DIRECTIONS.includes(action) });
        this.#request(action, `pointer:${event.pointerId}`, wasHeld);
        try { button.setPointerCapture(event.pointerId); } catch { /* Document listeners still release the pointer. */ }
        this.#paint();
      });
      listen(button, 'lostpointercapture', event => release(event, true));
      listen(button, 'contextmenu', event => event.preventDefault());
    }
    listen(doc, 'pointermove', move);
    listen(doc, 'pointerup', event => release(event));
    listen(doc, 'pointercancel', event => release(event, true));
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
