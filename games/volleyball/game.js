import { Match, CHARACTERS, DIFFICULTIES, FLOOR, R } from './engine.mjs?v=7';
import { encodeInput, MAX_TICKS, MAX_CHANGES, RULES_VERSION } from './replay.mjs?v=7';
import { initLeaderboard, lockRanking, prepareRankedMatch, submitRankedMatch } from './leaderboard.js?v=7';
import { initScreenMode } from './screen-mode.mjs?v=3';
import { CourtRenderer } from './renderer.mjs?v=2';
import { VolleyballControls, GAME_KEYS, isGameInputTarget } from './controls.mjs?v=4';
import { MatchFeedback, ResumeCountdown } from './feedback.mjs?v=1';

const $ = id => document.getElementById(id);
const canvas = $('court'), controls = new VolleyballControls();
const countdown = new ResumeCountdown();
let feedback = new MatchFeedback();
const particles = [], trail = [];
let selection = 'pikachu', match = new Match(), loaded = false;
let soundEnabled = true, lastTime = 0, accumulator = 0, messageTime = 0, visualTime = 0;
const music = $('bgm');
let musicVolume = 35;
try {
  const saved = localStorage.getItem('tcghub-volleyball-volume');
  if (saved !== null && Number.isFinite(Number(saved))) musicVolume = Math.max(0, Math.min(100, Number(saved)));
} catch {}
function applyMusicVolume(value) {
  musicVolume = Number(value);
  music.volume = musicVolume / 100;
  $('music-volume').value = musicVolume;
  $('music-volume').setAttribute('aria-valuetext', `${musicVolume}%`);
  $('music-volume-value').textContent = `${musicVolume}%`;
}
applyMusicVolume(musicVolume);
$('music-volume').addEventListener('input', event => {
  applyMusicVolume(event.target.value);
  try { localStorage.setItem('tcghub-volleyball-volume', String(musicVolume)); } catch {}
});
let musicRequest = 0;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const renderer = new CourtRenderer(canvas, { reducedMotion });
let rankedSession = null, replay = null, lastBits = 0, starting = false;
const screenMode = initScreenMode({ arena: document.querySelector('.arena'), button: $('expand'), onPause: pause });

function stopMusic() { musicRequest++; music.pause(); }
async function playMusic() {
  if (!soundEnabled || document.hidden) return;
  const request = ++musicRequest;
  try {
    await music.play();
    if (request !== musicRequest) return;
    $('sound').title = '우리는 모두 친구 · 반복 재생';
  } catch {
    if (request !== musicRequest) return;
    soundEnabled = false;
    $('sound').textContent = 'BGM 재시도';
    $('sound').setAttribute('aria-pressed', 'false');
    $('sound').title = '배경음악을 재생하지 못했어요. 눌러서 다시 시도하세요.';
  }
}
function clearInput() { controls.clear(); }
function overlay(label, title, copy, button) {
  $('overlay-label').textContent = label; $('overlay-title').textContent = title;
  $('overlay-copy').textContent = copy; $('start').textContent = button; $('overlay').hidden = false;
  $('start').hidden = false; $('start').disabled = !loaded || starting;
  $('overlay').classList.remove('is-countdown');
  $('overlay').classList.toggle('is-result', match.phase === 'over');
  $('match-summary').hidden = match.phase !== 'over';
  $('result-ranking').hidden = match.phase !== 'over';
}
function updateUI() {
  $('player-name').textContent = CHARACTERS[match.characters[0]].name;
  $('ai-name').textContent = CHARACTERS[match.characters[1]].name;
  $('player-score').textContent = match.scores[0]; $('ai-score').textContent = match.scores[1];
  const active = !['ready', 'over'].includes(match.phase);
  $('characters').disabled = active || starting; $('opponent').disabled = active || starting; $('difficulty').disabled = active || starting;
  lockRanking(active || starting);
  $('pause').disabled = !active || starting; $('restart').disabled = !active || starting;
  $('pause').textContent = match.phase === 'paused' && !countdown.active ? '계속하기' : '일시정지';
  document.querySelector('.arena').classList.toggle('match-active', ['playing', 'serve', 'point'].includes(match.phase));
  const names = { ready: '경기 준비', serve: '서브 준비', playing: '7점 선승 · 경기 중', paused: '일시정지', point: '다음 랠리 준비', over: '경기 종료' };
  $('match-state').textContent = `${DIFFICULTIES[match.difficulty].name} · ${names[match.phase]}`;
}
async function newMatch() {
  if (starting) return;
  starting = true; $('start').disabled = true; updateUI();
  const options = { player: selection, opponent: $('opponent').value, difficulty: $('difficulty').value };
  try { rankedSession = await prepareRankedMatch(options); }
  catch (error) { stopMusic(); $('overlay-copy').textContent = error.message; starting = false; $('start').disabled = false; updateUI(); return; }
  starting = false; $('start').disabled = false;
  replay = rankedSession ? { version: RULES_VERSION, ticks: 0, changes: [] } : null; lastBits = 0;
  if (!rankedSession) $('submission-status').textContent = '연습 경기 · 회원 순위에 등록되지 않아요.';
  clearInput(); countdown.cancel(); feedback = new MatchFeedback(); particles.length = 0; trail.length = 0; messageTime = 0; $('rally-message').textContent = '';
  match = new Match(options);
  match.start(); $('overlay').hidden = true; accumulator = 0; updateUI(); canvas.focus({ preventScroll: true });
  if (!screenMode.canPlay() || document.hidden) pause();
}
function pause() {
  stopMusic(); countdown.cancel();
  if (!['playing', 'serve', 'point', 'paused'].includes(match.phase)) return;
  match.pause(); clearInput(); overlay('TIME OUT', '잠깐, 쉬어가기', '준비가 되면 경기를 이어가세요.', '계속하기'); updateUI();
}
function resume() {
  if (match.phase !== 'paused' || countdown.active || !screenMode.canPlay() || document.hidden) return;
  clearInput(); accumulator = 0; countdown.start();
  overlay('GET READY', countdown.label, '곧 경기가 이어집니다', '계속하기');
  $('overlay').classList.add('is-countdown'); $('start').hidden = true; updateUI();
}
function finishResume() {
  if (!screenMode.canPlay() || document.hidden || match.phase !== 'paused') { pause(); return; }
  match.resume(); playMusic(); clearInput(); accumulator = 0; $('overlay').hidden = true;
  updateUI(); canvas.focus({ preventScroll: true });
}
$('start').addEventListener('click', () => {
  if (!loaded || starting || !screenMode.canPlay()) return;
  if (match.phase === 'paused') resume();
  else { playMusic(); newMatch(); }
});
$('pause').addEventListener('click', () => match.phase === 'paused' && !countdown.active ? resume() : pause());
$('restart').addEventListener('click', () => {
  stopMusic(); countdown.cancel(); feedback = new MatchFeedback();
  rankedSession = null; replay = null;
  clearInput(); particles.length = 0; trail.length = 0;
  match = new Match({ player: selection, opponent: $('opponent').value, difficulty: $('difficulty').value });
  $('rally-message').textContent = ''; messageTime = 0;
  overlay('READY TO PLAY', '다시 한 판?', '캐릭터와 난이도를 바꿀 수 있어요.', '경기 시작'); updateUI();
});
$('sound').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  $('sound').textContent = soundEnabled ? 'BGM 켜짐' : 'BGM 꺼짐';
  $('sound').setAttribute('aria-pressed', String(soundEnabled));
  $('sound').title = soundEnabled ? '우리는 모두 친구 · 경기 중 반복 재생' : '배경음악 켜기';
  if (soundEnabled && match.phase !== 'paused') playMusic();
  else stopMusic();
  if (['playing', 'serve', 'point'].includes(match.phase)) canvas.focus({ preventScroll: true });
});
document.querySelectorAll('[data-character]').forEach(button => button.addEventListener('click', () => {
  selection = button.dataset.character;
  document.querySelectorAll('[data-character]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  match.characters[0] = selection; updateUI();
}));
$('opponent').addEventListener('change', () => { match.characters[1] = $('opponent').value; updateUI(); });
$('difficulty').addEventListener('change', () => { match.difficulty = $('difficulty').value; updateUI(); });
window.addEventListener('keydown', event => {
  if (!isGameInputTarget(event.target)) return;
  if (event.code === 'KeyP' || event.code === 'Escape') {
    if (!event.repeat) match.phase === 'paused' && !countdown.active ? resume() : pause();
    return;
  }
  if (GAME_KEYS.includes(event.code) && ['playing', 'serve', 'point'].includes(match.phase)) {
    event.preventDefault(); controls.keyDown(event.code, { repeat: event.repeat });
  }
});
window.addEventListener('keyup', event => controls.keyUp(event.code));
window.addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
controls.bindTouchControls(document.querySelectorAll('[data-control]'), { document,
  isActive: () => ['playing', 'serve', 'point'].includes(match.phase) && !starting });

const skillButtons = ['slide', 'attack'].map(name => document.querySelector(`[data-control="${name}"]`));
function updateSkillFeedback() {
  const p = match.players[0];
  for (const button of skillButtons) {
    const slide = button.dataset.control === 'slide', cooldown = slide ? p.slideCooldown : p.cooldown;
    const label = cooldown > .01 ? `${cooldown.toFixed(1)}초` : slide ? '준비' : p.y < FLOOR - R - 15 ? '스파이크' : '점프 + 스파이크';
    const detail = button.querySelector('small');
    if (detail.textContent !== label) detail.textContent = label;
    button.style.setProperty('--cooldown', `${Math.min(100, cooldown / (slide ? .85 : .5) * 100)}%`);
    button.classList.toggle('cooling', cooldown > .01);
  }
}

// Keep registration feedback and retries reachable while the arena is fullscreen.
function syncResultRanking() {
  $('result-status').textContent = $('submission-status').textContent;
  for (const action of ['retry', 'discard']) {
    const source = $(`${action}-ranking`), target = $(`result-${action}`);
    target.hidden = source.hidden; target.disabled = source.disabled;
  }
}
new MutationObserver(syncResultRanking).observe(document.querySelector('.leaderboard'), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
$('result-retry').addEventListener('click', () => $('retry-ranking').click());
$('result-discard').addEventListener('click', () => $('discard-ranking').click());

function events() {
  for (const e of match.events.splice(0)) {
    feedback.event(e); renderer.event(e);
    if (e.type === 'slide') {
      if (!reducedMotion) for (let i = 0; i < 8; i++) particles.push({ x: e.x, y: e.y, vx: (Math.random() - .5) * 160, vy: -Math.random() * 80, life: .3, size: 3, color: '#bca16b' });
    } else if (e.type === 'hit' || e.type === 'spike' || e.type === 'dig') {
      if (!reducedMotion) for (let i = 0; i < (e.type === 'spike' ? 18 : 8); i++) particles.push({ x: e.x, y: e.y, vx: (Math.random() - .5) * 280, vy: (Math.random() - .6) * 260, life: .45, size: e.type === 'spike' ? 4 : 3, color: CHARACTERS[match.characters[e.side]].color });
      if (e.type === 'spike') { $('rally-message').textContent = '스파이크!'; messageTime = .5; }
      if (e.type === 'dig') { $('rally-message').textContent = '슬라이딩 세이브!'; messageTime = .7; }
    } else if (e.type === 'point' || e.type === 'over') {
      $('rally-message').textContent = e.side === 0 ? '나이스! +1' : '상대 득점'; messageTime = 1.2; trail.length = 0;
      if (e.type === 'over') {
        clearInput(); overlay(e.side === 0 ? 'YOU WIN' : 'GOOD GAME', e.side === 0 ? '멋진 승리!' : '한 판 더 도전?', `${match.scores[0]} : ${match.scores[1]} · ${DIFFICULTIES[match.difficulty].name} · ${feedback.time}`, '다시 한 판');
        $('stat-spikes').textContent = feedback.spikes; $('stat-saves').textContent = feedback.saves; $('stat-rally').textContent = feedback.longest;
        syncResultRanking(); $('start').focus({ preventScroll: true });
        if (rankedSession && replay) submitRankedMatch(rankedSession, replay);
        rankedSession = null; replay = null;
      }
      updateUI();
    } else if (e.type === 'serve') updateUI();
  }
}
function frame(time) {
  const dt = Math.min((time - (lastTime || time)) / 1000, .05); lastTime = time;
  const resuming = countdown.active;
  if (resuming) {
    if (!screenMode.canPlay() || document.hidden) pause();
    else if (countdown.step(dt)) finishResume();
    else $('overlay-title').textContent = countdown.label;
  }
  if (match.phase !== 'paused' && !resuming) {
    visualTime += dt; accumulator += dt;
    const previousPhase = match.phase;
    while (accumulator >= 1 / 120) {
      const tickInput = controls.sample(match, 1 / 120);
      const activeTick = ['serve', 'playing', 'point'].includes(match.phase);
      if (replay && ['serve', 'playing', 'point'].includes(match.phase)) {
        const bits = encodeInput(tickInput);
        if (bits !== lastBits) { replay.changes.push([replay.ticks, bits]); lastBits = bits; }
        replay.ticks++;
        if (replay.ticks > MAX_TICKS || replay.changes.length > MAX_CHANGES) {
          replay = null; rankedSession = null;
          $('submission-status').textContent = '랭킹 기록 한도(20분 또는 조작 변경 24,000회)를 넘어 연습 경기로 전환됐어요.';
        }
      }
      if (activeTick) feedback.step();
      match.step(1 / 120, tickInput); accumulator -= 1 / 120;
    }
    if (previousPhase !== match.phase) updateUI();
    events(); messageTime -= dt; if (messageTime <= 0) $('rally-message').textContent = '';
    for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i]; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; if (p.life <= 0) particles.splice(i, 1); }
    if (match.phase === 'playing') { trail.push({ x: match.ball.x, y: match.ball.y }); if (trail.length > 10) trail.shift(); }
  }
  updateSkillFeedback(); renderer.draw(match, { time: visualTime, dt, trail, particles, feedback }); requestAnimationFrame(frame);
}
async function loadSprites() {
  $('start').disabled = true; $('start').textContent = '코트 준비 중…';
  try {
    await renderer.load();
    loaded = true; $('start').onclick = null;
    overlay('READY TO PLAY', '오늘의 선수는?', '캐릭터를 고른 뒤 코트에 입장하세요.', '경기 시작'); $('start').disabled = false;
  } catch {
    overlay('LOADING ERROR', '캐릭터를 불러오지 못했어요', '연결을 확인하고 다시 시도해 주세요.', '다시 불러오기');
    $('start').disabled = false; $('start').onclick = () => { $('start').onclick = null; loadSprites(); };
  }
}
initLeaderboard(); updateUI(); loadSprites(); requestAnimationFrame(frame);
