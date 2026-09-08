import { Match } from './engine.mjs?v=8';
export const RULES_VERSION = 6;
export const SUPPORTED_RULES_VERSIONS = Object.freeze([3, 4, 5, 6]);
export const MAX_TICKS = 120 * 1200;
export const MAX_CHANGES = 24000;
export function encodeInput(input) {
  return (input.left ? 1 : 0) | (input.right ? 2 : 0) | (input.jump ? 4 : 0) | (input.spike ? 8 : 0) | (input.slide ? 16 : 0);
}
export function decodeInput(bits) {
  return { left: !!(bits & 1), right: !!(bits & 2), jump: !!(bits & 4), spike: !!(bits & 8), slide: !!(bits & 16) };
}
export function verifyReplay(options, replay) {
  if (!replay || !SUPPORTED_RULES_VERSIONS.includes(replay.version) || !Number.isInteger(replay.ticks) || replay.ticks < 1 || replay.ticks > MAX_TICKS ||
      !Array.isArray(replay.changes) || replay.changes.length > MAX_CHANGES) throw new Error('경기 기록 형식이 올바르지 않습니다.');
  let previous = -1;
  for (const change of replay.changes) {
    if (!Array.isArray(change) || change.length !== 2 || !Number.isInteger(change[0]) || change[0] <= previous || change[0] >= replay.ticks ||
        !Number.isInteger(change[1]) || change[1] < 0 || change[1] > 31) throw new Error('조작 기록이 올바르지 않습니다.');
    previous = change[0];
  }
  const match = new Match({ ...options, rulesVersion: replay.version }); match.start(); let cursor = 0, controls = decodeInput(0);
  for (let tick = 0; tick < replay.ticks; tick++) {
    if (match.phase === 'over') throw new Error('경기 종료 이후의 기록입니다.');
    if (replay.changes[cursor]?.[0] === tick) controls = decodeInput(replay.changes[cursor++][1]);
    match.step(1 / 120, controls); match.events.length = 0;
  }
  if (match.phase !== 'over') throw new Error('끝까지 완료된 경기만 등록할 수 있습니다.');
  return { score: match.scores[0], conceded: match.scores[1], durationMs: Math.round(replay.ticks * 1000 / 120) };
}
