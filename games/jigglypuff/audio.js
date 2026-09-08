const PREFERENCE_KEY = 'jigglypuff-audio';
const MAX_VOICES = 8;
const MASTER_VOLUME = 0.42;
const COOLDOWN = { drop: 0.08, merge: 0.045, clear: 0.28, win: 1, lose: 1 };
const MERGE_STEPS = [0, 2, 4, 7, 9, 12, 14, 16];

// Each note is [frequency, delay, duration, gain, ending frequency, waveform].
// Soft sine tones and a rounded drop keep even busy chain reactions gentle.
function notesFor(type, level) {
  const species = Math.max(0, Math.min(7, Math.floor(Number(level) || 0)));
  const frequency = 330 * 2 ** (MERGE_STEPS[species] / 12);
  switch (type) {
    case 'drop': return [[190, 0, 0.13, 0.075, 105, 'triangle']];
    case 'merge': return [
      [frequency, 0, 0.17, 0.09, frequency * 1.025],
      [frequency * 1.5, 0.045, 0.18, 0.045],
    ];
    case 'clear': return [523, 659, 784, 1047].map((hz, i) => [hz, i * 0.055, 0.24, 0.065]);
    case 'win': return [523, 659, 784, 1047].map((hz, i) => [hz, i * 0.085, i === 3 ? 0.36 : 0.22, 0.07]);
    case 'lose': return [330, 277, 220].map((hz, i) => [hz, i * 0.11, 0.25, 0.055]);
    default: return [];
  }
}

/**
 * Optional, entirely synthesized effects; constructing this object is silent.
 * Call unlock() or setEnabled(true) from a user gesture. After suspend(), a new
 * gesture must unlock audio again; play() never creates or resumes a context.
 * enabled reports the saved preference, independently of browser audio support.
 */
export function createGameAudio() {
  let enabled = false;
  try { enabled = globalThis.localStorage?.getItem(PREFERENCE_KEY) === 'true'; } catch {}

  let context = null;
  let master = null;
  let unlocked = false;
  let disposed = false;
  let revision = 0;
  const voices = new Set();
  const lastPlayed = new Map();

  function cleanVoice(voice) {
    voices.delete(voice);
    try { voice.oscillator.disconnect(); } catch {}
    try { voice.gain.disconnect(); } catch {}
  }

  function stopVoices() {
    for (const voice of [...voices]) {
      try { voice.oscillator.stop(); } catch {}
      cleanVoice(voice);
    }
  }

  function mute() {
    if (!master || !context) return;
    try {
      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.setValueAtTime(0, context.currentTime);
    } catch {}
  }

  async function unlock() {
    if (!enabled || disposed) return false;
    const request = ++revision;
    try {
      if (!context) {
        const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (typeof AudioContext !== 'function') return false;
        context = new AudioContext();
        master = context.createGain();
        master.gain.value = 0;
        master.connect(context.destination);
      }
      if (context.state !== 'running') await context.resume();
      // A pending browser resume must not undo a later mute, pause or dispose.
      if (disposed || !enabled || request !== revision || context.state !== 'running') return false;
      unlocked = true;
      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.setValueAtTime(master.gain.value, context.currentTime);
      master.gain.linearRampToValueAtTime(MASTER_VOLUME, context.currentTime + 0.018);
      return true;
    } catch {
      if (request === revision) unlocked = false;
      return false;
    }
  }

  function suspend() {
    ++revision;
    unlocked = false;
    mute();
    stopVoices();
    lastPlayed.clear();
    try { Promise.resolve(context?.suspend()).catch(() => {}); } catch {}
  }

  function setEnabled(value) {
    if (disposed) return Promise.resolve(false);
    enabled = Boolean(value);
    try { globalThis.localStorage?.setItem(PREFERENCE_KEY, String(enabled)); } catch {}
    if (enabled) return unlock();
    suspend();
    return Promise.resolve(false);
  }

  function note([frequency, delay, duration, volume, ending = frequency, waveform = 'sine'], now) {
    const oscillator = context.createOscillator();
    let gain;
    try {
      gain = context.createGain();
      const start = now + delay;
      const end = start + duration;
      oscillator.type = waveform;
      oscillator.frequency.setValueAtTime(frequency, start);
      oscillator.frequency.exponentialRampToValueAtTime(ending, end);
      gain.gain.setValueAtTime(0, now);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + 0.009);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      gain.gain.linearRampToValueAtTime(0, end + 0.008);
      oscillator.connect(gain);
      gain.connect(master);
      const voice = { oscillator, gain };
      oscillator.onended = () => cleanVoice(voice);
      voices.add(voice);
      oscillator.start(start);
      oscillator.stop(end + 0.012);
    } catch (error) {
      try { oscillator.stop(); } catch {}
      for (const voice of voices) if (voice.oscillator === oscillator) voices.delete(voice);
      try { oscillator.disconnect(); } catch {}
      try { gain?.disconnect(); } catch {}
      throw error;
    }
  }

  function play(type, level = 0) {
    if (!enabled || !unlocked || disposed || context?.state !== 'running' || !Object.hasOwn(COOLDOWN, type)) return;
    const now = context.currentTime;
    if (now - (lastPlayed.get(type) ?? -Infinity) < COOLDOWN[type]) return;
    const notes = notesFor(type, level);
    // Clear/result cues replace the current effects so their short melody reads.
    if (type === 'clear' || type === 'win' || type === 'lose') stopVoices();
    if (voices.size + notes.length > MAX_VOICES) return;
    lastPlayed.set(type, now);
    try { for (const parameters of notes) note(parameters, now); } catch { stopVoices(); }
  }

  function dispose() {
    if (disposed) return;
    suspend();
    disposed = true;
    try { master?.disconnect(); } catch {}
    try { Promise.resolve(context?.close()).catch(() => {}); } catch {}
  }

  return { get enabled() { return enabled; }, setEnabled, unlock, play, suspend, dispose };
}
