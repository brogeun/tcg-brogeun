import { CHARACTERS, DIFFICULTIES } from './engine.mjs?v=6';
import { RULES_VERSION } from './replay.mjs?v=6';
const $ = id => document.getElementById(id);
let selected = 'normal', requestId = 0, loggedIn = false, available = false, locked = false, pending = null, saving = false;
async function api(body, difficulty = selected) {
  const response = await fetch(`/api/games/volleyball?difficulty=${encodeURIComponent(difficulty)}`, {
    credentials: 'same-origin', signal: AbortSignal.timeout(15000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  });
  let result;
  try { result = await response.json(); } catch { throw new Error('회원 리더보드에 연결할 수 없어요. 잠시 뒤 다시 시도해 주세요.'); }
  if (!response.ok || !result.ok) throw new Error(result.message || '기록을 불러올 수 없어요.');
  return result;
}
const timeLabel = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
function setControls() {
  $('ranked').disabled = locked || !loggedIn || !available;
  $('nickname').disabled = locked || !loggedIn || !available;
}
export function lockRanking(value) { locked = value; setControls(); }
export async function refreshLeaderboard(difficulty = selected) {
  selected = difficulty; const current = ++requestId;
  document.querySelectorAll('[data-ranking]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ranking === difficulty)));
  $('ranking-caption').textContent = `${DIFFICULTIES[difficulty].name} · 전체 회원 TOP 20`;
  $('ranking-status').textContent = '순위를 불러오는 중…'; $('ranking-body').replaceChildren(); $('my-ranking').textContent = '';
  try {
    const data = await api(null, difficulty); if (current !== requestId) return;
    loggedIn = data.loggedIn; available = true; setControls();
    $('ranking-auth').textContent = loggedIn ? '공개 닉네임으로 회원 순위에 기록돼요.' : '로그인하면 전체 회원과 순위를 겨룰 수 있어요. 지금은 연습 경기로 플레이해요.';
    $('ranking-login').hidden = loggedIn;
    $('ranking-status').textContent = data.rows.length ? '' : '아직 등록된 기록이 없어요. 첫 기록에 도전하세요!';
    for (const record of data.rows) {
      const row = document.createElement('tr'); if (record.is_me) row.className = 'my-record';
      for (const value of [record.rank, `${record.nickname}${record.is_me ? ' (나)' : ''}`, CHARACTERS[record.character]?.name || '—',
        `${record.score} : ${record.conceded}`, timeLabel(record.duration_ms)]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      $('ranking-body').append(row);
    }
    $('my-ranking').textContent = data.mine ? `내 최고 기록 · ${data.mine.rank}위 · ${data.mine.score} : ${data.mine.conceded} · ${timeLabel(data.mine.duration_ms)}` : loggedIn ? '이 난이도의 내 기록은 아직 없어요.' : '';
  } catch (error) {
    if (current !== requestId) return;
    available = false; setControls(); $('ranking-status').textContent = error.message;
    $('ranking-auth').textContent = '리더보드 연결 전에는 연습 경기로 플레이할 수 있어요.';
  }
}
export async function prepareRankedMatch(options) {
  if (pending) throw new Error('미등록 경기의 기록을 다시 등록하거나 포기한 뒤 시작해 주세요.');
  if (!$('ranked').checked || !loggedIn || !available) return null;
  const result = await api({ action: 'start', ...options, nickname: $('nickname').value, version: RULES_VERSION });
  $('submission-status').textContent = `${DIFFICULTIES[options.difficulty].name} 랭킹 경기 · 종료 후 자동 등록`;
  return { sessionId: result.sessionId, difficulty: options.difficulty };
}
async function sendPending() {
  if (!pending || saving) return;
  saving = true; $('retry-ranking').disabled = true; $('discard-ranking').disabled = true;
  $('submission-status').textContent = '경기를 검증하고 기록을 등록하는 중…';
  try {
    const submission = pending;
    await api(submission.body); pending = null;
    $('submission-status').textContent = '경기 등록 완료! 더 좋은 성적이면 내 최고 기록이 갱신돼요.';
    $('retry-ranking').hidden = true; $('discard-ranking').hidden = true;
    await refreshLeaderboard(submission.difficulty);
  } catch (error) {
    $('submission-status').textContent = `등록하지 못했어요. ${error.message}`;
    $('retry-ranking').hidden = false; $('discard-ranking').hidden = false;
  } finally { saving = false; $('retry-ranking').disabled = false; $('discard-ranking').disabled = false; }
}
export async function submitRankedMatch(session, replay) {
  if (!session) return;
  pending = { body: { action: 'finish', sessionId: session.sessionId, replay }, difficulty: session.difficulty };
  await sendPending();
}
export function initLeaderboard() {
  document.querySelectorAll('[data-ranking]').forEach(button => button.addEventListener('click', () => refreshLeaderboard(button.dataset.ranking)));
  $('refresh-ranking').addEventListener('click', () => refreshLeaderboard());
  $('retry-ranking').addEventListener('click', sendPending);
  $('discard-ranking').addEventListener('click', () => { pending = null; $('retry-ranking').hidden = true; $('discard-ranking').hidden = true; $('submission-status').textContent = '이번 경기의 기록 등록을 포기했어요.'; });
  refreshLeaderboard();
}
