import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Match, FLOOR, R, BALL_R } from '../games/volleyball/engine.mjs';
import { RULES_VERSION, encodeInput, verifyReplay } from '../games/volleyball/replay.mjs';

const dt = 1 / 120;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export const STRATEGIES = ['follow', 'mobile', 'practiced'];
export function playerBot(strategy, seed) {
  // Test-only player variations: reaction intervals, imperfect positioning and
  // occasional jump attacks. These seeds never change the opponent's rules.
  let state = seed >>> 0, observeAt = 0, target = 220, jumpUntil = 0, attackUntil = 0, nextJump = 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  return (match, tick) => {
    if (strategy === 'idle') return {};
    const p = match.players[0], b = match.ball, skilled = strategy === 'practiced';
    if (tick >= observeAt) {
      observeAt = tick + (skilled ? 10 : strategy === 'mobile' ? 18 : 22) + Math.floor(random() * 7);
      target = 220;
      if (b.x < 480 || b.vx < 0) {
        const landing = clamp((-b.vy + Math.sqrt(Math.max(0, b.vy * b.vy + 1760 * (370 - b.y)))) / 880, 0, skilled ? .8 : .45);
        target = b.x + b.vx * (strategy === 'follow' ? .15 : landing);
        if (target < BALL_R) target = 2 * BALL_R - target;
        target += (random() - .5) * (skilled ? 16 : 32);
      }
      target = clamp(target, 55, 425);
      if (strategy !== 'follow' && tick >= nextJump && p.y >= FLOOR - R - .1 &&
        b.x < 460 && Math.abs(b.x - p.x) < (skilled ? 105 : 85) && b.y > 185 && b.y < 325 && b.vy > -80 && random() < (skilled ? .9 : .6)) {
        jumpUntil = tick + 8; attackUntil = tick + (skilled ? 42 : 36); nextJump = tick + (skilled ? 95 : 145);
      }
    }
    const deadZone = skilled ? 12 : 21;
    return { left: p.x > target + deadZone, right: p.x < target - deadZone, jump: tick < jumpUntil, spike: tick < attackUntil };
  };
}
export function runBalanceMatch(difficulty, strategy, seed, rulesVersion = RULES_VERSION, record = false) {
  const match = new Match({ difficulty, rulesVersion }); match.start();
  const control = playerBot(strategy, seed), replay = { version: rulesVersion, ticks: 0, changes: [] };
  let bits = 0, playerHits = 0, aiHits = 0;
  while (match.phase !== 'over' && replay.ticks < 120 * 600) {
    const input = control(match, replay.ticks), nextBits = encodeInput(input);
    if (record && nextBits !== bits) replay.changes.push([replay.ticks, nextBits]);
    bits = nextBits; match.step(dt, input); replay.ticks++;
    for (const event of match.events) if (['hit', 'spike', 'dig'].includes(event.type)) event.side === 0 ? playerHits++ : aiHits++;
    match.events.length = 0;
  }
  return { difficulty, strategy, seed, score: match.scores[0], conceded: match.scores[1], ticks: replay.ticks,
    finished: match.phase === 'over', playerHits, aiHits, ...(record ? { replay } : {}) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const rulesVersion = Number(process.argv.find(value => value.startsWith('--rules='))?.split('=')[1] || RULES_VERSION);
  const reportOnly = process.argv.includes('--report-only'), samples = [];
  for (const difficulty of ['easy', 'normal', 'hard']) {
    for (const strategy of STRATEGIES) {
      const runs = Array.from({ length: 8 }, (_, index) => runBalanceMatch(difficulty, strategy, index + 1, rulesVersion));
      samples.push(...runs);
      console.log(JSON.stringify({ rulesVersion, difficulty, strategy, scores: runs.map(run => `${run.score}-${run.conceded}${run.finished ? '' : '*'}`),
        wins: runs.filter(run => run.score === 7).length, meanPoints: Number((runs.reduce((sum, run) => sum + run.score, 0) / runs.length).toFixed(2)),
        meanSeconds: Math.round(runs.reduce((sum, run) => sum + run.ticks / 120, 0) / runs.length) }));
    }
    const idle = runBalanceMatch(difficulty, 'idle', 1, rulesVersion);
    console.log(JSON.stringify({ rulesVersion, difficulty, strategy: 'idle', score: `${idle.score}-${idle.conceded}`, seconds: Math.round(idle.ticks / 120) }));
    if (!reportOnly) assert(idle.finished && idle.score === 0 && idle.conceded === 7, `${difficulty}: doing nothing does not earn free points`);
  }
  if (!reportOnly) {
    assert(samples.every(run => run.finished), 'representative matches finish within ten minutes');
    assert(samples.filter(run => run.difficulty !== 'hard').every(run => run.ticks < 120 * 360), 'easy and normal avoid drawn-out stalemates');
    const mobileNormal = samples.filter(run => run.difficulty === 'normal' && run.strategy === 'mobile');
    assert(mobileNormal.every(run => run.score >= 1), 'basic movement and occasional jump attacks can score in normal');
    const followNormal = samples.filter(run => run.difficulty === 'normal' && run.strategy === 'follow');
    assert(followNormal.every(run => run.score >= 1), 'normal allows points with movement alone across all player seeds');
    const average = runs => runs.reduce((sum, run) => sum + run.score, 0) / runs.length;
    const followEasy = samples.filter(run => run.difficulty === 'easy' && run.strategy === 'follow');
    const mobileHard = samples.filter(run => run.difficulty === 'hard' && run.strategy === 'mobile');
    assert(followEasy.filter(run => run.score === 7).length >= 6, 'easy is learnable with basic movement');
    assert(average(followEasy) > average(followNormal), 'easy is more forgiving than normal');
    assert(average(mobileNormal) > average(mobileHard), 'hard remains more challenging than normal');
    assert(mobileHard.some(run => run.score >= 3), 'hard allows counterplay instead of requiring perfect attacks');
    const trace = runBalanceMatch('normal', 'mobile', 3, rulesVersion, true);
    assert.deepEqual(verifyReplay({ difficulty: 'normal' }, trace.replay),
      { score: trace.score, conceded: trace.conceded, durationMs: Math.round(trace.ticks * 1000 / 120) }, 'calibrated player trace replays exactly');
    console.log('PASS: 72 fixed player runs, difficulty ordering, normal scoring, idle sanity and replay parity');
  }
}
