import assert from 'node:assert/strict';
import { MatchFeedback, ResumeCountdown } from '../games/volleyball/feedback.mjs';
import { Match } from '../games/volleyball/engine.mjs';

const feedback = new MatchFeedback();
for (const event of [{ type:'hit', side:0 }, { type:'spike', side:1 }, { type:'dig', side:0 }, { type:'spike', side:0 }]) feedback.event(event);
assert.equal(feedback.spikes, 1, 'only successful player spikes count');
assert.equal(feedback.saves, 1, 'only successful player saves count');
assert.equal(feedback.longest, 4, 'rally includes both players');
feedback.event({ type:'point' }); feedback.event({ type:'hit', side:0 });
assert.equal(feedback.rally, 1); assert.equal(feedback.longest, 4);
feedback.event({ type:'over' }); assert.equal(feedback.rally, 0);
for (let i = 0; i < 120 * 65; i++) feedback.step();
assert.equal(feedback.time, '1:05');

const countdown = new ResumeCountdown(), match = new Match();
match.start(); match.pause(); const frozen = JSON.stringify(match);
countdown.start(); assert.equal(countdown.label, '3');
assert.equal(countdown.step(1), false); assert.equal(countdown.label, '2');
assert.equal(countdown.step(1), false); assert.equal(countdown.label, '1');
assert.equal(JSON.stringify(match), frozen, 'countdown never advances physics or replay');
assert.equal(countdown.step(1), true); assert.equal(countdown.active, false);
assert.equal(countdown.step(1), false, 'completion is emitted once');
countdown.start(); countdown.step(.5); countdown.cancel();
assert.equal(countdown.active, false); assert.equal(countdown.step(10), false, 'rotation/blur cancellation cannot resume later');
countdown.start(); assert.equal(countdown.label, '3', 'manual retry gets a fresh countdown');
console.log('PASS: player-only stats, full rallies, match timer, frozen/cancelable resume countdown');
