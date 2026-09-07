import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SLIDE_POSES, slideVisual } from '../games/volleyball/slide-poses.mjs';
for (const [id, pose] of Object.entries(SLIDE_POSES)) {
  const png = readFileSync(new URL(`../games/volleyball/sprites/${pose.file}`, import.meta.url));
  const sheetWidth = png.readUInt32BE(16), sheetHeight = png.readUInt32BE(20);
  const seen = new Set();
  for (const remaining of [.32, .23, .15, .07]) {
    const visual = slideVisual(id, remaining), [x, y, width, height] = visual.bounds;
    assert(x >= 0 && y >= 0 && x + width <= sheetWidth && y + height <= sheetHeight, `${id}: frame within source sheet`);
    assert.equal(visual.width / width, visual.height / height, `${id}: natural proportions, no squash`);
    assert(width > height, `${id}: actual horizontal pose`); seen.add(x);
  }
  assert.equal(seen.size, 4, `${id}: four distinct animation frames`);
}
console.log('PASS: all three slide sheets, four-frame animation, frame bounds and uniform aspect-preserving rendering');
