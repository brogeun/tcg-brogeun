import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CourtRenderer } from '../games/volleyball/renderer.mjs';
import { Match, W, H } from '../games/volleyball/engine.mjs';
import { SLIDE_POSES } from '../games/volleyball/slide-poses.mjs';

const manifest = JSON.parse(await fs.readFile(new URL('../games/volleyball/art/manifest.json', import.meta.url), 'utf8'));
const failures = new Set(), held = new Set(), pending = [], requests = [];
const atlasUrl = `./art/${manifest.characters.charmander.file}`;
const backdropUrl = `./art/${manifest.background.file}`;
const originalGlobals = new Map(['Image', 'fetch', 'document', 'ResizeObserver', 'devicePixelRatio']
  .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

function complete(image) {
  queueMicrotask(() => failures.has(image.src) ? image.onerror?.() : image.onload?.());
}
function releaseHeld() {
  held.clear();
  for (const image of pending.splice(0)) complete(image);
}
function makeCanvas(rect = { width: W, height: H }) {
  const calls = { images: [], scales: [], transforms: [] };
  const context = Object.fromEntries(['save', 'restore', 'beginPath', 'ellipse', 'fill', 'translate', 'rotate', 'arc', 'stroke', 'moveTo', 'lineTo']
    .map(name => [name, () => {}]));
  context.drawImage = (...args) => calls.images.push(args);
  context.scale = (...args) => calls.scales.push(args);
  context.setTransform = (...args) => calls.transforms.push(args);
  return { width: W, height: H, rect, calls,
    getContext: () => context, getBoundingClientRect() { return this.rect; } };
}

try {
  globalThis.Image = class {
    set src(value) {
      this.url = value; requests.push(value);
      if (held.has(value)) pending.push(this);
      else complete(this);
    }
    get src() { return this.url; }
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => structuredClone(manifest) });
  globalThis.document = { querySelectorAll: () => [] };
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; } observe() {} };
  globalThis.devicePixelRatio = 1;

  // Advertising an atlas slide must not suppress a real slide when that atlas fails.
  failures.add(atlasUrl);
  held.add(backdropUrl);
  const canvas = makeCanvas(), renderer = new CourtRenderer(canvas, { reducedMotion: true });
  await renderer.load();
  assert.equal(renderer.characters.charmander.legacy, true, 'a failed atlas must recover the legacy ready image');
  assert.equal(renderer.characters.charmander.image.src, './sprites/charmander.png');
  assert.equal(renderer.characters.charmander.slideImage?.src, `./sprites/${SLIDE_POSES.charmander.file}`,
    'atlas failure must retain the independent PMD slide');
  for (const character of ['pikachu', 'squirtle']) {
    assert.equal(renderer.characters[character].image.src, `./art/${manifest.characters[character].file}`);
    assert.equal(renderer.characters[character].slideImage?.src, `./sprites/${SLIDE_POSES[character].file}`);
  }
  assert.equal(renderer.background, undefined, 'slow decorative scenery must not block completion of the playable art load');
  assert.ok(pending.some(image => image.src === backdropUrl), 'the test must leave the backdrop request unresolved');

  const match = new Match({ player: 'charmander' });
  match.players[0].slide = .20;
  match.players[0].slideDirection = -1;
  renderer.player(match.players[0], 0, match);
  const slideDraw = canvas.calls.images.at(-1);
  assert.equal(slideDraw[0].src, `./sprites/${SLIDE_POSES.charmander.file}`,
    'the visible sliding player must draw the PMD sheet, not a resized standing sprite');
  assert.deepEqual(slideDraw.slice(1, 5), SLIDE_POSES.charmander.frames[1], 'the real PMD animation frame must be cropped');
  assert.ok(Math.abs(slideDraw[7] / slideDraw[3] - slideDraw[8] / slideDraw[4]) < 1e-10,
    'the PMD frame must keep its proportions');
  assert.deepEqual(canvas.calls.scales.at(-1), [-1, 1], 'a leftward slide must mirror the right-facing PMD source once');
  releaseHeld();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renderer.background.src, backdropUrl, 'the backdrop may finish independently after playable art');

  // A failed complete load must reject, then recover on the same renderer when Retry runs.
  failures.add('./sprites/charmander.png');
  await assert.rejects(renderer.load(), /Character unavailable: charmander/);
  failures.clear();
  await renderer.load();
  assert.equal(renderer.characters.charmander.image.src, atlasUrl, 'retry must replace the fallback with restored atlas art');
  assert.equal(!!renderer.characters.charmander.legacy, false);
  assert.deepEqual(renderer.characters.charmander.poses.slide, manifest.characters.charmander.poses.slide);
  assert.deepEqual(renderer.characters.charmander.anchors, manifest.characters.charmander.anchors);
  canvas.calls.images.length = 0;
  renderer.player(match.players[0], 0, match);
  assert.equal(canvas.calls.images.at(-1)[0].src, atlasUrl, 'successful retry must visibly use the restored atlas slide');

  // Responsive resolution may grow with DPR, but logical court coordinates stay fixed.
  globalThis.devicePixelRatio = 3;
  canvas.rect = { width: 390, height: 219.375 };
  renderer.resize();
  assert.ok(canvas.width > W, 'a high-DPR phone needs more pixels than the logical court');
  assert.ok(canvas.width <= W * 2 && canvas.height <= H * 2, 'backing resolution must respect the 2x cap');
  assert.ok(Math.abs(canvas.width * 9 - canvas.height * 16) <= 13, 'integer pixel rounding must preserve the 16:9 court');
  canvas.rect = { width: 2400, height: 1350 };
  renderer.resize();
  assert.deepEqual([canvas.width, canvas.height], [W * 2, H * 2], 'large fullscreen displays must respect the resolution cap');
  renderer.court = renderer.player = renderer.ball = () => {};
  renderer.draw(new Match(), { time: 0, dt: 0, trail: [], particles: [], feedback: { rally: 0 } });
  const [sx, skewY, skewX, sy, offsetX, offsetY] = canvas.calls.transforms.at(-1);
  assert.deepEqual([skewY, skewX, offsetX, offsetY], [0, 0, 0, 0]);
  assert.deepEqual([W * sx, H * sy], [canvas.width, canvas.height], 'logical court corners must map to the current backing pixels');
  canvas.rect = { width: 0, height: 0 };
  renderer.resize();
  assert.deepEqual([canvas.width, canvas.height], [W * 2, H * 2], 'a temporarily hidden canvas must retain its usable buffer');

  console.log('PASS: atlas failure keeps PMD slide, slow backdrop stays non-blocking, retry restores art, logical court/DPR resizing');
} finally {
  releaseHeld();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
