import { getCurrentUser, jsonResponse } from '../../_shared/auth.js';
import { CHARACTERS, DIFFICULTIES } from '../../../games/volleyball/engine.mjs';
import { RULES_VERSION, verifyReplay } from '../../../games/volleyball/replay.mjs';

const unavailable = () => jsonResponse({ ok: false, message: '회원 리더보드를 준비 중입니다. 연습 경기는 이용할 수 있어요.' }, 503);
const fail = (message, status = 400) => jsonResponse({ ok: false, message }, status);
const validDifficulty = value => typeof value === 'string' && Object.hasOwn(DIFFICULTIES, value);
const validCharacter = value => typeof value === 'string' && Object.hasOwn(CHARACTERS, value);
const order = 'score DESC, conceded ASC, duration_ms ASC, achieved_at ASC, user_id ASC';
export async function onRequestGet({ request, env }) {
  const difficulty = new URL(request.url).searchParams.get('difficulty') || 'normal';
  if (!validDifficulty(difficulty)) return fail('난이도를 확인해 주세요.');
  if (!env.DB) return unavailable();
  try {
    const user = await getCurrentUser(request, env);
    const rows = await env.DB.prepare(`SELECT nickname, character, score, conceded, duration_ms, achieved_at,
      CASE WHEN user_id = ? THEN 1 ELSE 0 END AS is_me FROM volleyball_records
      WHERE difficulty = ? ORDER BY ${order} LIMIT 20`).bind(user?.id || '', difficulty).all();
    let mine = null;
    if (user) mine = await env.DB.prepare(`SELECT nickname, character, score, conceded, duration_ms, achieved_at, rank FROM (
      SELECT *, ROW_NUMBER() OVER (ORDER BY ${order}) AS rank FROM volleyball_records WHERE difficulty = ?
    ) WHERE user_id = ?`).bind(difficulty, user.id).first();
    return jsonResponse({ ok: true, difficulty, loggedIn: !!user,
      rows: (rows.results || []).map((row, i) => ({ ...row, rank: i + 1 })), mine });
  } catch { return unavailable(); }
}
export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return fail('같은 사이트에서 요청해 주세요.', 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return fail('JSON 요청이 필요합니다.', 415);
  const user = await getCurrentUser(request, env);
  if (!user) return fail('로그인한 회원만 기록을 등록할 수 있어요.', 401);
  if (!env.DB) return unavailable();
  let data;
  try {
    // Stream with a hard bound, including when Content-Length is absent.
    const reader = request.body?.getReader(); if (!reader) return fail('요청 본문이 없습니다.');
    const chunks = []; let bytes = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength;
      if (bytes > 400000) { await reader.cancel(); return fail('경기 기록이 너무 큽니다.', 413); } chunks.push(value); }
    const body = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    data = JSON.parse(new TextDecoder().decode(body));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('요청을 확인해 주세요.');
  } catch { return fail('요청을 읽을 수 없습니다.'); }
  const now = Date.now();
  try {
    if (data.action === 'start') {
      if (!validDifficulty(data.difficulty) || !validCharacter(data.player) || !validCharacter(data.opponent) || data.version !== RULES_VERSION) return fail('새로고침 후 캐릭터와 난이도를 선택해 주세요.');
      const nickname = typeof data.nickname === 'string' ? data.nickname.trim().normalize('NFC') : '';
      if ([...nickname].length < 2 || [...nickname].length > 16 || !/^[\p{L}\p{N}_ -]+$/u.test(nickname)) return fail('공개 닉네임은 글자·숫자·공백·밑줄·하이픈으로 2~16자 입력해 주세요.');
      const recent = await env.DB.prepare('SELECT started_at FROM volleyball_sessions WHERE user_id = ?').bind(user.id).first();
      if (recent && now - recent.started_at < 5000) return fail('5초 뒤에 다시 시작해 주세요.', 429);
      const id = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO volleyball_sessions (id, user_id, nickname, difficulty, player, opponent, rules_version, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET id=excluded.id, nickname=excluded.nickname,
        difficulty=excluded.difficulty, player=excluded.player, opponent=excluded.opponent, rules_version=excluded.rules_version,
        started_at=excluded.started_at, completed_at=NULL, score=NULL, conceded=NULL, duration_ms=NULL`)
        .bind(id, user.id, nickname, data.difficulty, data.player, data.opponent, RULES_VERSION, now).run();
      return jsonResponse({ ok: true, sessionId: id });
    }
    if (data.action !== 'finish' || typeof data.sessionId !== 'string') return fail('요청을 확인해 주세요.');
    const session = await env.DB.prepare('SELECT * FROM volleyball_sessions WHERE id = ? AND user_id = ?').bind(data.sessionId, user.id).first();
    if (!session) return fail('경기 세션이 만료됐어요. 새 경기를 시작해 주세요.', 409);
    if (session.completed_at) return jsonResponse({ ok: true, alreadySaved: true, score: session.score, conceded: session.conceded });
    if (session.rules_version !== RULES_VERSION || now - session.started_at > 60 * 60 * 1000) return fail('경기 기록의 유효시간이 지났어요.', 409);
    let result;
    try { result = verifyReplay({ player: session.player, opponent: session.opponent, difficulty: session.difficulty }, data.replay); }
    catch (error) { return fail(error.message); }
    if (result.durationMs > now - session.started_at + 2000) return fail('경기 시간과 기록이 일치하지 않습니다.');
    await env.DB.batch([
      env.DB.prepare(`UPDATE volleyball_sessions SET completed_at=?, score=?, conceded=?, duration_ms=?
        WHERE id=? AND user_id=? AND completed_at IS NULL`).bind(now, result.score, result.conceded, result.durationMs, session.id, user.id),
      env.DB.prepare(`INSERT INTO volleyball_records (user_id, difficulty, nickname, character, score, conceded, duration_ms, achieved_at)
        SELECT user_id, difficulty, nickname, player, score, conceded, duration_ms, completed_at FROM volleyball_sessions
        WHERE id=? AND user_id=? AND completed_at IS NOT NULL
        ON CONFLICT(user_id, difficulty) DO UPDATE SET nickname=excluded.nickname, character=excluded.character,
        score=excluded.score, conceded=excluded.conceded, duration_ms=excluded.duration_ms, achieved_at=excluded.achieved_at
        WHERE excluded.score > volleyball_records.score
          OR (excluded.score = volleyball_records.score AND excluded.conceded < volleyball_records.conceded)
          OR (excluded.score = volleyball_records.score AND excluded.conceded = volleyball_records.conceded AND excluded.duration_ms < volleyball_records.duration_ms)`)
        .bind(session.id, user.id)
    ]);
    return jsonResponse({ ok: true, ...result });
  } catch { return unavailable(); }
}
