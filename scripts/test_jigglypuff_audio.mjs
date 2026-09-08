import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../games/jigglypuff/audio.js', import.meta.url), 'utf8');
const { createGameAudio } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const descriptors = new Map(['AudioContext', 'webkitAudioContext', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const contexts = [];
const saved = new Map();
let initialState = 'running';

class Param {
  value = 0;
  events = [];
  setValueAtTime(value, time) { this.events.push(['set', value, time]); this.value = value; }
  linearRampToValueAtTime(value, time) { this.events.push(['linear', value, time]); this.value = value; }
  exponentialRampToValueAtTime(value, time) {
    assert(value > 0, 'exponential ramps never target zero');
    this.events.push(['exponential', value, time]);
    this.value = value;
  }
  cancelScheduledValues(time) { this.events.push(['cancel', null, time]); }
}

class Node {
  connect(target) { this.connected = target; }
  disconnect() { this.connected = null; this.disconnected = true; }
}

class FakeAudioContext {
  currentTime = 0;
  state = initialState;
  destination = {};
  gains = [];
  oscillators = [];
  resumes = 0;
  suspends = 0;
  closes = 0;
  constructor() { contexts.push(this); }
  createGain() {
    const gain = Object.assign(new Node(), { gain: new Param() });
    this.gains.push(gain);
    return gain;
  }
  createOscillator() {
    const oscillator = Object.assign(new Node(), {
      frequency: new Param(),
      start(time) { this.startedAt = time; },
      stop(time) {
        if (time === undefined) this.stoppedImmediately = true;
        else this.endsAt = time;
      },
    });
    this.oscillators.push(oscillator);
    return oscillator;
  }
  resume() { ++this.resumes; this.state = 'running'; return Promise.resolve(); }
  suspend() { ++this.suspends; this.state = 'suspended'; return Promise.resolve(); }
  close() { ++this.closes; this.state = 'closed'; return Promise.resolve(); }
  advance(time) {
    this.currentTime = time;
    for (const oscillator of this.oscillators) {
      if (!oscillator.finished && oscillator.endsAt <= time) {
        oscillator.finished = true;
        oscillator.onended?.();
      }
    }
  }
  get active() { return this.oscillators.filter(oscillator => !oscillator.finished && !oscillator.stoppedImmediately); }
}

try {
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'webkitAudioContext', { configurable: true, writable: true, value: undefined });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
  });

  const audio = createGameAudio();
  assert.equal(audio.enabled, false, 'effects default off');
  audio.play('drop');
  assert.equal(await audio.unlock(), false);
  assert.equal(contexts.length, 0, 'loading and disabled gestures allocate no AudioContext');

  assert.equal(await audio.setEnabled(true), true);
  assert.equal(saved.get('jigglypuff-audio'), 'true');
  const context = contexts[0];
  assert.equal(contexts.length, 1);
  audio.play('drop');
  assert.equal(context.oscillators.length, 1);
  assert.equal(context.oscillators[0].type, 'triangle');
  audio.play('drop');
  audio.play('unknown');
  assert.equal(context.oscillators.length, 1, 'rapid duplicate and unknown cues are silent');
  context.advance(0.1);
  audio.play('drop');
  assert.equal(context.oscillators.length, 2, 'cooldown expires');

  context.advance(1);
  audio.play('merge', 0);
  const lowPitch = context.oscillators.at(-2).frequency.events[0][1];
  context.advance(2);
  audio.play('merge', 7);
  assert(context.oscillators.at(-2).frequency.events[0][1] > lowPitch, 'larger species have a higher merge pitch');
  context.advance(3);
  for (let i = 0; i < 6; i++) {
    context.currentTime = 3 + i * 0.05;
    audio.play('merge', i);
  }
  assert.equal(context.active.length, 8, 'chain reactions have at most eight scheduled voices');

  const chain = [...context.active];
  audio.play('clear');
  assert(chain.every(oscillator => oscillator.stoppedImmediately && oscillator.disconnected));
  assert.equal(context.active.length, 4, 'clear replaces the busy chain with a four-note cue');
  const afterClear = context.oscillators.length;
  audio.play('clear');
  assert.equal(context.oscillators.length, afterClear, 'clear is rate limited');
  context.advance(4);
  audio.play('win');
  assert.equal(context.active.length, 4);
  context.advance(5);
  audio.play('lose');
  assert.equal(context.active.length, 3);
  assert(context.gains.slice(1).every(node => node.gain.events.some(event => event[0] === 'linear' && event[1] > 0 && event[1] <= 0.09)), 'every note has a soft bounded attack');
  assert(context.gains.slice(1).every(node => node.gain.events.some(event => event[0] === 'linear' && event[1] === 0)), 'every note fades fully to zero before ending');

  const activeBeforeMute = [...context.active];
  const muted = audio.setEnabled(false);
  assert.equal(context.active.length, 0, 'mute stops scheduled and playing notes synchronously');
  assert(activeBeforeMute.every(oscillator => oscillator.disconnected));
  assert.equal(context.gains[0].gain.value, 0);
  assert.equal(saved.get('jigglypuff-audio'), 'false');
  await muted;
  const beforeMutedPlay = context.oscillators.length;
  audio.play('drop');
  assert.equal(context.oscillators.length, beforeMutedPlay);

  await audio.setEnabled(true);
  audio.play('merge');
  audio.suspend();
  assert.equal(audio.enabled, true, 'pause preserves the preference');
  assert.equal(context.active.length, 0);
  const resumesBeforePlay = context.resumes;
  context.state = 'running'; // Some browsers may change their context state externally.
  audio.play('drop');
  assert.equal(context.active.length, 0, 'pause requires a fresh gesture even when context runs');
  assert.equal(context.resumes, resumesBeforePlay, 'play never resumes audio');
  await audio.unlock();
  audio.play('drop');
  assert.equal(context.active.length, 1);

  audio.suspend();
  let resolveResume;
  context.resume = () => new Promise(resolve => { ++context.resumes; resolveResume = resolve; });
  const pendingUnlock = audio.unlock();
  await audio.setEnabled(false);
  context.state = 'running';
  resolveResume();
  assert.equal(await pendingUnlock, false, 'a late resume cannot reverse a newer mute');
  audio.play('drop');
  assert.equal(context.active.length, 0);
  audio.dispose();
  audio.dispose();
  assert.equal(context.closes, 1, 'dispose is idempotent');
  assert.equal(await audio.setEnabled(true), false, 'disposed audio cannot restart');

  saved.set('jigglypuff-audio', 'true');
  const remembered = createGameAudio();
  assert.equal(remembered.enabled, true);
  remembered.play('drop');
  assert.equal(contexts.length, 1, 'remembered preference still waits for a gesture');
  remembered.dispose();

  globalThis.AudioContext = undefined;
  const unsupported = createGameAudio();
  assert.equal(await unsupported.unlock(), false, 'missing Web Audio support stays silent');
  unsupported.play('merge');
  unsupported.suspend();
  unsupported.dispose();

  globalThis.webkitAudioContext = FakeAudioContext;
  const legacy = createGameAudio();
  assert.equal(await legacy.unlock(), true, 'prefixed AudioContext is supported');
  legacy.dispose();

  globalThis.AudioContext = FakeAudioContext;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('Storage denied'); } });
  const privateAudio = createGameAudio();
  assert.equal(privateAudio.enabled, false);
  assert.equal(await privateAudio.setEnabled(true), true, 'private storage does not prevent optional audio');
  privateAudio.dispose();

  initialState = 'suspended';
  const denied = createGameAudio();
  FakeAudioContext.prototype.resume = () => Promise.reject(Error('Autoplay denied'));
  assert.equal(await denied.setEnabled(true), false, 'resume rejection never escapes to gameplay');
  denied.play('drop');
  assert.equal(contexts.at(-1).oscillators.length, 0);
  denied.dispose();
  console.log('PASS: optional synthesized effects, pitch, envelopes, cooldowns, polyphony, mute, pause, resume race, cleanup, storage and browser fallbacks');
} finally {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
