import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Match, DIFFICULTIES } from '../games/volleyball/engine.mjs';
import { RULES_VERSION, MAX_TICKS, verifyReplay, encodeInput, decodeInput } from '../games/volleyball/replay.mjs';
import { onRequestGet, onRequestPost } from '../functions/api/games/volleyball.js';
import { signJwt } from '../functions/_shared/jwt.js';
import { LocalDB } from './volleyball-local-db.mjs';
const DB = new LocalDB();
DB.sqlite.exec('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)');
const migration = readFileSync(new URL('../functions/_schema/volleyball.sql', import.meta.url), 'utf8');
DB.sqlite.exec(migration); DB.sqlite.exec(migration);
for (const id of ['alice', 'bob', 'carol']) DB.prepare('INSERT INTO users VALUES (?, ?)').bind(id, `${id}@private.test`).run();
const env = { DB, JWT_SECRET: 'local-test-only-not-a-production-secret' };
const tokens = {};
for (const id of ['alice', 'bob', 'carol']) tokens[id] = await signJwt({ sub: id, email: `${id}@private.test`, exp: Math.floor(Date.now() / 1000) + 3600 }, env.JWT_SECRET);
const endpoint = 'https://tcghub.test/api/games/volleyball';
async function post(data, id = 'alice', overrides = {}) {
  const request = new Request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://tcghub.test', ...(id ? { Cookie: `session=${tokens[id]}` } : {}), ...overrides }, body: JSON.stringify(data) });
  const response = await onRequestPost({ request, env }); return { status: response.status, data: await response.json() };
}
async function get(difficulty = 'normal', id = 'alice') {
  const response = await onRequestGet({ request: new Request(endpoint + '?difficulty=' + difficulty, { headers: id ? { Cookie: `session=${tokens[id]}` } : {} }), env });
  return { status: response.status, data: await response.json() };
}
const start = difficulty => ({ action: 'start', version: RULES_VERSION, difficulty, player: 'pikachu', opponent: 'squirtle', nickname: '테스트 트레이너' });
assert.equal((await get()).data.rows.length, 0, 'empty ranking is real and has no seeded scores');
assert.equal((await get('invalid')).status, 400);
assert.equal((await post(start('easy'), null)).status, 401);
assert.equal((await post(start('easy'), 'alice', { Origin: 'https://other.test' })).status, 403);
assert.equal((await post({ ...start('easy'), nickname: '<script>' })).status, 400);
assert.equal((await post({ ...start('easy'), difficulty: '__proto__' })).status, 400);
assert.equal((await post({ ...start('easy'), version: 0 })).status, 400);
assert.equal((await post({ ...start('easy'), version: 3 })).status, 400, 'new sessions cannot opt into legacy mechanics');
assert.equal((await post({ ...start('easy'), version: 4 })).status, 400, 'new sessions cannot opt into the previous balance');
assert.equal(encodeInput(decodeInput(31)), 31);
// A changing-input trace (including slide and jump) must reproduce the client exactly.
for (const rulesVersion of [3, 4, 5, RULES_VERSION]) {
  const match = new Match({ difficulty: 'hard', rulesVersion }); match.start();
  const trace = { version: rulesVersion, ticks: 0, changes: [[0, 18], [25, 0], [70, 5], [95, 0], [150, 10], [180, 0]] };
  let cursor = 0, controls = decodeInput(0);
  while (match.phase !== 'over' && trace.ticks < MAX_TICKS) {
    if (trace.changes[cursor]?.[0] === trace.ticks) controls = decodeInput(trace.changes[cursor++][1]);
    match.step(1 / 120, controls); match.events.length = 0; trace.ticks++;
  }
  const result = verifyReplay({ difficulty: 'hard' }, trace);
  assert.deepEqual(result, { score: match.scores[0], conceded: match.scores[1], durationMs: Math.round(trace.ticks * 1000 / 120) }, `v${rulesVersion} input replay matches client simulation`);
}
// Captured before the v4 engine changes; these fixtures must retain exact v3 results.
const legacyChanges = [[0, 18], [25, 0], [70, 5], [95, 0], [150, 10], [180, 0]];
const legacyFixtures = [
  { difficulty: 'easy', ticks: 4135, durationMs: 34458 },
  { difficulty: 'normal', ticks: 7021, durationMs: 58508 },
  { difficulty: 'hard', ticks: 3877, durationMs: 32308 }
];
for (const fixture of legacyFixtures) {
  assert.deepEqual(verifyReplay({ difficulty: fixture.difficulty, rulesVersion: RULES_VERSION }, { version: 3, ticks: fixture.ticks, changes: legacyChanges }),
    { score: 0, conceded: 7, durationMs: fixture.durationMs }, `${fixture.difficulty} v3 fixture chooses legacy mechanics from the replay`);
}
const legacyV4Fixtures = JSON.parse(readFileSync(new URL('./fixtures/volleyball-v4.json', import.meta.url), 'utf8'));
for (const fixture of legacyV4Fixtures) {
  assert.deepEqual(verifyReplay({ difficulty: fixture.difficulty }, fixture.replay),
    { score: fixture.score, conceded: fixture.conceded, durationMs: Math.round(fixture.ticks * 1000 / 120) }, `${fixture.difficulty}: pre-rebalance v4 match keeps its exact result`);
}
const legacyV5Fixtures = JSON.parse(readFileSync(new URL('./fixtures/volleyball-v5.json', import.meta.url), 'utf8'));
for (const fixture of legacyV5Fixtures) {
  assert.deepEqual(verifyReplay({ difficulty: fixture.difficulty }, fixture.replay),
    { score: fixture.score, conceded: fixture.conceded, durationMs: Math.round(fixture.ticks * 1000 / 120) }, `${fixture.difficulty}: v5 keeps its exact result`);
}
assert.equal((await post({ ...start('easy'), version: 5 })).status, 400, 'new sessions cannot opt into v5');
{
  const hard = new Match({ difficulty: 'hard', rulesVersion: 4 }); hard.ball = { x: 640, y: 405, vx: -100, vy: 150 };
  assert.equal(hard.aiInput().slide, true, 'hard AI attempts low-ball slide saves');
  const normal = new Match({ difficulty: 'normal', rulesVersion: 4 }); normal.ball = { ...hard.ball };
  assert.equal(normal.aiInput().slide, false, 'normal AI keeps simpler defense');
  assert(DIFFICULTIES.hard.speed > DIFFICULTIES.normal.speed && DIFFICULTIES.normal.speed > DIFFICULTIES.easy.speed);
}
const replays = {};
for (const difficulty of Object.keys(DIFFICULTIES)) {
  const match = new Match({ difficulty }); match.start(); let ticks = 0;
  while (match.phase !== 'over' && ticks < MAX_TICKS) { match.step(1 / 120); match.events.length = 0; ticks++; }
  assert.equal(match.phase, 'over', `${difficulty} match completes`);
  const replay = { version: RULES_VERSION, ticks, changes: [] };
  const began = performance.now(); const result = verifyReplay({ difficulty }, replay);
  console.log(`${difficulty}: ${ticks} replay ticks verified in ${(performance.now() - began).toFixed(1)}ms`);
  assert.equal(result.score, match.scores[0]); assert.equal(result.conceded, match.scores[1]); replays[difficulty] = replay;
  DB.prepare('UPDATE volleyball_sessions SET started_at=0 WHERE user_id=?').bind('alice').run();
  const session = await post(start(difficulty)); assert.equal(session.status, 200);
  assert.equal(DB.prepare('SELECT rules_version FROM volleyball_sessions WHERE id=?').bind(session.data.sessionId).first().rules_version, RULES_VERSION, 'new sessions are bound to current rules');
  const finish = { action: 'finish', sessionId: session.data.sessionId, replay, score: 999, userId: 'bob', difficulty: 'hard' };
  assert.equal((await post({ ...finish, replay: { ...replay, version: 3 } })).status, 400, 'current session rejects legacy mechanics');
  assert.equal((await post({ ...finish, replay: { ...replay, version: 4 } })).status, 400, 'current session rejects the previous balance');
  assert.equal((await post({ ...finish, replay: { ...replay, version: 5 } })).status, 400, 'current session rejects v5');
  assert.equal(DB.prepare('SELECT completed_at FROM volleyball_sessions WHERE id=?').bind(session.data.sessionId).first().completed_at, null, 'version mismatch cannot complete a session');
  assert.equal((await post(finish, 'bob')).status, 409, 'session is owner-scoped');
  assert.equal((await post(start(difficulty))).status, 429, 'rapid starts are limited');
  assert.equal((await post(finish)).status, 400, 'cannot submit simulated time faster than wall clock');
  DB.prepare('UPDATE volleyball_sessions SET started_at=? WHERE user_id=?').bind(Date.now() - result.durationMs - 100, 'alice').run();
  const saved = await post(finish); assert.equal(saved.status, 200); assert.equal(saved.data.score, result.score, 'submitted score is ignored');
  assert.equal((await post(finish)).data.alreadySaved, true, 'retry is idempotent');
  const ranking = (await get(difficulty)).data;
  assert.equal(ranking.rows.length, 1); assert.equal(ranking.mine.rank, 1); assert.equal(ranking.rows[0].score, result.score);
}
assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM volleyball_records').first().n, 3, 'separate record per difficulty');
assert.throws(() => verifyReplay({}, { ...replays.easy, ticks: 1 }), /완료/);
assert.throws(() => verifyReplay({}, { ...replays.easy, changes: [[0, 0], [0, 1]] }), /조작/);
assert.throws(() => verifyReplay({}, { ...replays.easy, changes: [[0, 32]] }), /조작/);
assert.throws(() => verifyReplay({ difficulty: 'easy' }, { ...replays.easy, ticks: replays.easy.ticks + 1 }), /종료 이후/);
assert.throws(() => verifyReplay({}, { ...replays.easy, ticks: MAX_TICKS + 1 }), /형식/);
assert.throws(() => verifyReplay({}, { ...replays.easy, version: 2 }), /형식/);
assert.throws(() => verifyReplay({}, { ...replays.easy, version: RULES_VERSION + 1 }), /형식/);
// Already active v3/v4/v5 sessions can finish after deployment, with their original replay only.
for (const version of [3, 4, 5]) {
  const fixture = version === 3 ? legacyFixtures.find(item => item.difficulty === 'easy') : (version === 4 ? legacyV4Fixtures : legacyV5Fixtures).find(item => item.difficulty === 'easy');
  const replay = version === 3 ? { version: 3, ticks: fixture.ticks, changes: legacyChanges } : fixture.replay;
  const expected = { score: fixture.score ?? 0, conceded: fixture.conceded ?? 7, durationMs: Math.round(fixture.ticks * 1000 / 120) };
  const sessionId = `active-v${version}-session`;
  DB.prepare(`UPDATE volleyball_sessions SET id=?, rules_version=?, difficulty='easy', started_at=?, completed_at=NULL,
    score=NULL, conceded=NULL, duration_ms=NULL WHERE user_id='alice'`).bind(sessionId, version, Date.now() - expected.durationMs - 100).run();
  assert.equal((await post({ action: 'finish', sessionId, replay: replays.easy })).status, 400, 'legacy session rejects current-version replay');
  const saved = await post({ action: 'finish', sessionId, replay });
  assert.equal(saved.status, 200, 'active legacy session remains finishable');
  assert.deepEqual(saved.data, { ok: true, ...expected });
  assert.equal((await post({ action: 'finish', sessionId, replay })).data.alreadySaved, true, 'legacy finish stays idempotent');
  assert.equal(DB.prepare('SELECT COUNT(*) AS n FROM volleyball_records').first().n, 3, 'legacy completion preserves existing leaderboard records');
}
// Add explicit fixtures only in this isolated in-memory test database.
const insert = DB.prepare(`INSERT INTO volleyball_records VALUES (?, 'easy', ?, 'pikachu', 7, ?, ?, ?)`);
insert.bind('bob', '밥', 2, 50000, 10).run(); insert.bind('carol', '캐롤', 1, 60000, 20).run();
let ranking = (await get('easy', 'bob')).data;
assert.equal(ranking.rows[0].nickname, '캐롤', 'fewer concessions outrank a faster game');
assert.equal(ranking.mine.rank, 3, 'the preserved v5 best also outranks Bob'); assert.equal(ranking.rows[2].is_me, 1);
DB.prepare("UPDATE volleyball_records SET conceded=1, duration_ms=55000 WHERE user_id='bob' AND difficulty='easy'").run();
ranking = (await get('easy')).data; assert.equal(ranking.rows[0].nickname, '밥', 'time breaks equal-score ties');
assert(!JSON.stringify(ranking).includes('@private.test')); assert(!JSON.stringify(ranking).includes('user_id'));
const publicRanking = await get('easy', null); assert.equal(publicRanking.data.loggedIn, false); assert.equal(publicRanking.data.mine, null);
assert(publicRanking.data.rows.every(row => !row.is_me));
const session = await post(start('easy'), 'bob'); assert.equal(session.status, 200);
DB.prepare('UPDATE volleyball_sessions SET started_at=? WHERE user_id=?').bind(Date.now() - 1000000, 'bob').run();
await post({ action: 'finish', sessionId: session.data.sessionId, replay: replays.easy }, 'bob');
assert.equal(DB.prepare("SELECT score FROM volleyball_records WHERE user_id='bob' AND difficulty='easy'").first().score, 7, 'worse result does not replace personal best');
const plan = DB.prepare('EXPLAIN QUERY PLAN SELECT * FROM volleyball_records WHERE difficulty=? ORDER BY score DESC, conceded ASC, duration_ms ASC, achieved_at ASC, user_id ASC LIMIT 20').bind('easy').all();
assert(plan.results.some(row => row.detail.includes('idx_volleyball_records_ranking')), 'ranking uses its index');
DB.prepare("DELETE FROM users WHERE id='bob'").run(); assert.equal(DB.prepare("SELECT COUNT(*) AS n FROM volleyball_records WHERE user_id='bob'").first().n, 0, 'account deletion removes rankings');
DB.sqlite.close();
console.log('PASS: migration, three modes, current and legacy replays, session version binding, ownership, timing, idempotency, public privacy, personal bests, sorting, indexed queries, account deletion');
