import assert from 'node:assert/strict';
import { Match, FLOOR, R, NET, BALL_R } from '../games/volleyball/engine.mjs';
const dt = 1 / 120;
const active = (options = {}) => { const m = new Match(options); m.start(); m.phase = 'playing'; return m; };
let m = active();
for (let i = 0; i < 240; i++) m.step(dt, { left: true });
assert(m.players[0].x >= R, 'player must stay within left wall');
m = active();
for (let i = 0; i < 100; i++) m.step(dt, { right: true });
assert(m.players[0].x <= NET.x - R, 'player cannot cross net');
m = active(); m.ball.y = 30; m.ball.vx = 0;
m.step(dt, { jump: true }); assert(m.players[0].vy < 0, 'jump rises');
let takeoffs = 1, previousVy = m.players[0].vy;
for (let i = 0; i < 115; i++) { m.step(dt, { jump: true }); if (previousVy >= 0 && m.players[0].vy < 0) takeoffs++; previousVy = m.players[0].vy; }
assert.equal(takeoffs, 1, 'holding jump does not bounce automatically');
m = active(); m.ball = { x: 80, y: FLOOR - BALL_R - 1, vx: 0, vy: 300, spin: 0 };
m.step(dt); assert.deepEqual(m.scores, [0, 1]); assert.equal(m.phase, 'point');
m = active(); m.ball = { x: 880, y: FLOOR - BALL_R - 1, vx: 0, vy: 300, spin: 0 };
m.step(dt); assert.deepEqual(m.scores, [1, 0]);
m = active(); m.ball = { x: 480, y: NET.y - BALL_R - 1, vx: 0, vy: 300, spin: 0 };
m.step(dt); assert(m.ball.vy < 0, 'ball bounces off net top');
m = active(); m.ball = { x: NET.x - BALL_R - 1, y: 350, vx: 500, vy: 0, spin: 0 };
m.step(dt); assert(m.ball.vx < 0, 'ball bounces off net side');
m = active(); m.ball = { x: 220, y: 377, vx: 0, vy: 100, spin: 0 };
m.step(dt); assert(m.ball.vy < 0 && m.ball.vx > 0, 'normal return travels up and toward opponent');
m = active(); m.players[0].y = 270; m.players[0].vy = 0;
m.ball = { x: 230, y: 225, vx: 0, vy: 100, spin: 0 };
m.step(dt, { spike: true }); assert(m.events.some(e => e.type === 'spike'), 'airborne spike connects'); assert(m.ball.vx > 600, 'spike accelerates');
m = active(); m.pause(); const frozen = JSON.stringify(m);
m.step(dt, { right: true, jump: true }); assert.equal(JSON.stringify(m), frozen, 'pause freezes physics'); m.resume(); assert.equal(m.phase, 'playing');
m = active(); m.scores = [6, 2]; m.point(0); assert.equal(m.phase, 'over');
m.step(dt); assert.deepEqual(m.scores, [7, 2], 'finished match cannot score again');
for (const difficulty of ['easy', 'normal', 'hard']) {
  m = new Match({ difficulty }); m.start(); let hits = 0;
  for (let i = 0; i < 120 * 150 && m.phase !== 'over'; i++) {
    m.step(dt); hits += m.events.filter(e => e.type === 'hit' || e.type === 'spike').length; m.events.length = 0;
    for (const item of [m.ball, ...m.players]) for (const key of ['x', 'y', 'vx', 'vy']) assert(Number.isFinite(item[key]), `finite physics ${key}`);
  }
  assert.equal(m.phase, 'over', `${difficulty}: idle match reaches completion`);
  assert(hits > 0, `${difficulty}: AI returns ball`);
}
// Hold the serve countdown so slide timing can be tested without rally resets.
const slidePractice = () => { const game = active(); game.phase = 'serve'; game.timer = 10; return game; };
m = slidePractice(); m.step(dt, { slide: true, right: true, jump: true });
assert(m.players[0].slide > 0 && m.players[0].vx > 600, 'slide starts faster than running');
assert.equal(m.players[0].y, FLOOR - R, 'slide stays grounded even with jump pressed');
m.step(dt, { left: true }); assert(m.players[0].vx > 0, 'slide direction is locked during the dive');
const pausedSlide = m.players[0].slide; m.pause(); m.step(dt); assert.equal(m.players[0].slide, pausedSlide, 'pause freezes slide timer'); m.resume();
for (let i = 0; i < 42; i++) m.step(dt);
assert.equal(m.players[0].slide, 0, 'slide ends');
m.step(dt, { slide: true }); assert.equal(m.players[0].slide, 0, 'cooldown blocks immediate reuse');
for (let i = 0; i < 110; i++) m.step(dt, { slide: true });
assert.equal(m.players[0].slide, 0, 'holding slide does not repeatedly trigger it');
m.step(dt); m.step(dt, { slide: true, left: true }); assert(m.players[0].vx < -600, 'released slide can trigger again toward the left');
for (const right of [false, true]) {
  m = slidePractice(); m.players[0].x = right ? NET.x - R : R;
  for (let i = 0; i < 30; i++) m.step(dt, { slide: true, right, left: !right });
  assert(m.players[0].x >= 47 && m.players[0].x <= NET.x - 47, 'sliding body stays inside court');
}
m = slidePractice(); m.step(dt, { jump: true }); m.step(dt, { slide: true });
assert.equal(m.players[0].slide, 0, 'cannot start a ground slide in midair');
m = active(); m.ball = { x: 280, y: 438, vx: 0, vy: 20, spin: 0 };
m.step(dt); assert(!m.events.some(e => e.type === 'hit'), 'standing player cannot reach the distant low ball');
m = active(); m.ball = { x: 280, y: 438, vx: 0, vy: 20, spin: 0 };
m.step(dt, { slide: true, right: true });
assert(m.events.some(e => e.type === 'dig'), 'slide reaches and saves the distant low ball');
assert(m.ball.vy < -600 && m.ball.y < FLOOR - BALL_R, 'slide lifts ball without conceding a point');
assert.deepEqual(m.scores, [0, 0]);
m.resetRally(); assert.equal(m.players[0].slide, 0); assert.equal(m.players[0].slideCooldown, 0);
assert.equal(m.rulesVersion, 5, 'new matches use the current rules');
// A slow nearby drop is an easy running return; the old early dive overshot it.
for (const rulesVersion of [3, 4]) {
  m = active({ difficulty: 'hard', rulesVersion });
  m.ball = { x: 800, y: 366, vx: 0, vy: 20, spin: 0 };
  for (let tick = 0; tick < 60 && m.phase === 'playing'; tick++) {
    m.step(dt);
    if (m.events.some(e => ['hit', 'dig', 'spike'].includes(e.type))) break;
  }
  if (rulesVersion === 3) {
    assert.deepEqual(m.scores, [1, 0], 'legacy early dive keeps its original result');
    assert(m.events.some(e => e.type === 'slide'), 'legacy replay still uses the original AI');
  } else {
    assert(m.events.some(e => e.type === 'hit' && e.side === 1), 'hard AI runs to the slow drop');
    assert(!m.events.some(e => e.type === 'slide'), 'reachable drop does not waste a dive');
    assert.deepEqual(m.scores, [0, 0]);
  }
}
m = active({ difficulty: 'hard', rulesVersion: 4 }); m.ball = { x: 640, y: 405, vx: -100, vy: 150, spin: 0 };
for (let tick = 0; tick < 30 && m.phase === 'playing'; tick++) {
  m.step(dt);
  if (m.events.some(e => e.type === 'dig')) break;
}
assert(m.events.some(e => e.type === 'dig' && e.side === 1), 'hard AI still dives when running cannot reach the falling ball');
assert.deepEqual(m.scores, [0, 0]);
// A close-net spike must remain blockable by the other player during hit cooldown.
for (const rulesVersion of [3, 4, 5]) {
  m = active({ difficulty: 'hard', rulesVersion }); m.aiInput = () => ({});
  Object.assign(m.players[0], { x: 440, y: 240 }); Object.assign(m.players[1], { x: 520, y: 240 });
  m.ball = { x: 470, y: 208, vx: 0, vy: 0, spin: 0 };
  m.step(dt, { spike: true });
  assert.equal(m.events[0]?.type, 'spike'); assert.equal(m.events[0]?.side, 0);
  for (let tick = 1; tick < 15; tick++) m.step(dt);
  assert.equal(m.events.some(e => e.side === 1), rulesVersion >= 4, 'opponent can block only under the new collision rules');
}
m = active(); m.ball = { x: 220, y: 377, vx: 0, vy: 100, spin: 0 };
m.step(dt); assert.equal(m.lastHitSide, 0);
m.ball = { x: 220, y: 377, vx: 0, vy: 100, spin: 0 }; m.step(dt);
assert.equal(m.events.filter(e => e.type === 'hit').length, 1, 'same player cannot repeatedly hit during cooldown');
m.resetRally(); assert.equal(m.lastHitSide, null, 'rally reset clears the last hitter');
// The new AI must learn about changed trajectories through its delayed observations.
m = active({ difficulty: 'normal' }); m.aiInput(dt); const committedTarget = m.ai.target;
m.ball = { x: 900, y: 150, vx: 0, vy: 100, spin: 0 }; m.shotNumber++;
for (let tick = 0; tick < 18; tick++) { m.aiInput(dt); assert.equal(m.ai.target, committedTarget, 'AI cannot instantly read a new shot'); }
for (let tick = 0; tick < 40; tick++) m.aiInput(dt);
assert(m.ai.target > 800, 'AI responds after observing the shot');
const shotError = m.ai.error;
for (let tick = 0; tick < 60; tick++) m.aiInput(dt);
assert.equal(m.ai.error, shotError, 'repeated observations retain the same shot error');
const leading = active({ difficulty: 'normal' }), trailing = active({ difficulty: 'normal' });
leading.scores = [6, 0]; trailing.scores = [0, 6];
for (let tick = 0; tick < 240; tick++) {
  const ball = { x: 670 + tick / 4, y: 180 + tick / 3, vx: 180, vy: 100, spin: 0 };
  leading.ball = { ...ball }; trailing.ball = { ...ball };
  assert.deepEqual(leading.aiInput(dt), trailing.aiInput(dt), 'AI decisions do not depend on who is winning');
}
assert.equal(leading.aiRandomState, trailing.aiRandomState, 'deterministic perception state ignores scores');
const versions = [3, 4, 5].map(rulesVersion => { const game = active({ rulesVersion }); game.phase = 'serve'; game.timer = 100; return game; });
for (let tick = 0; tick < 240; tick++) {
  const input = { right: tick < 45, left: tick > 120, jump: tick >= 60 && tick < 80, slide: tick >= 150 && tick < 175, spike: tick > 65 && tick < 90 };
  for (const game of versions) game.step(dt, input);
  assert.deepEqual(versions[0].players[0], versions[2].players[0], 'v5 retains original player movement, jump and slide mechanics');
  assert.deepEqual(versions[1].players[0], versions[2].players[0]);
}
console.log('PASS: gameplay, delayed AI, score-independent perception, unchanged controls, opposing blocks, contact cooldown and legacy rules');
