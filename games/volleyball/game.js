import { Match, CHARACTERS, DIFFICULTIES, W, H, FLOOR, NET, R } from './engine.mjs?v=5';
import { encodeInput, MAX_TICKS, MAX_CHANGES, RULES_VERSION } from './replay.mjs?v=5';
import { initLeaderboard, lockRanking, prepareRankedMatch, submitRankedMatch } from './leaderboard.js?v=5';
import { initScreenMode } from './screen-mode.mjs?v=1';
import { SLIDE_POSES, slideVisual } from './slide-poses.mjs?v=1';

const $ = id => document.getElementById(id);
const canvas = $('court'), ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas rendering is unavailable');
const spriteBounds = { pikachu: [31, 24, 39, 46], charmander: [30, 29, 38, 42], squirtle: [29, 29, 38, 39] };
const sprites = {}, keys = new Set(), touches = new Map();
const pendingActions = new Set();
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
function clearInput() { keys.clear(); touches.clear(); pendingActions.clear(); document.querySelectorAll('[data-control]').forEach(b => b.classList.remove('pressed')); }
function input() {
  const held = name => pendingActions.has(name) || [...touches.values()].includes(name);
  return { left: keys.has('ArrowLeft') || keys.has('KeyA') || held('left'), right: keys.has('ArrowRight') || keys.has('KeyD') || held('right'),
    jump: keys.has('ArrowUp') || keys.has('KeyW') || held('jump'), spike: keys.has('Space') || held('spike'),
    slide: keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('ArrowDown') || keys.has('KeyS') || held('slide') };
}
function overlay(label, title, copy, button) {
  $('overlay-label').textContent = label; $('overlay-title').textContent = title;
  $('overlay-copy').textContent = copy; $('start').textContent = button; $('overlay').hidden = false;
}
function updateUI() {
  $('player-name').textContent = CHARACTERS[match.characters[0]].name;
  $('ai-name').textContent = CHARACTERS[match.characters[1]].name;
  $('player-score').textContent = match.scores[0]; $('ai-score').textContent = match.scores[1];
  const active = !['ready', 'over'].includes(match.phase);
  $('characters').disabled = active || starting; $('opponent').disabled = active || starting; $('difficulty').disabled = active || starting;
  lockRanking(active || starting);
  $('pause').disabled = !active; $('restart').disabled = !active;
  $('pause').textContent = match.phase === 'paused' ? '계속하기' : '일시정지';
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
  clearInput(); particles.length = 0; trail.length = 0; messageTime = 0; $('rally-message').textContent = '';
  match = new Match(options);
  match.start(); $('overlay').hidden = true; accumulator = 0; updateUI(); canvas.focus({ preventScroll: true });
  if (!screenMode.canPlay() || document.hidden) pause();
}
function pause() {
  stopMusic();
  if (!['playing', 'serve', 'point'].includes(match.phase)) return;
  match.pause(); clearInput(); overlay('TIME OUT', '잠깐, 쉬어가기', '준비가 되면 경기를 이어가세요.', '계속하기'); updateUI();
}
function resume() { if (!screenMode.canPlay()) return; match.resume(); playMusic(); clearInput(); accumulator = 0; $('overlay').hidden = true; updateUI(); canvas.focus({ preventScroll: true }); }
$('start').addEventListener('click', () => {
  if (!loaded || starting || !screenMode.canPlay()) return;
  if (match.phase === 'paused') resume();
  else { playMusic(); newMatch(); }
});
$('pause').addEventListener('click', () => match.phase === 'paused' ? resume() : pause());
$('restart').addEventListener('click', () => {
  stopMusic();
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
const gameKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'ShiftLeft', 'ShiftRight'];
window.addEventListener('keydown', event => {
  if (event.target.closest('select,input,textarea,button,a,summary')) return;
  if (event.code === 'KeyP' || event.code === 'Escape') {
    if (!event.repeat) match.phase === 'paused' ? resume() : pause();
    return;
  }
  if (gameKeys.includes(event.code) && ['playing', 'serve', 'point'].includes(match.phase)) {
    event.preventDefault(); keys.add(event.code);
    if (!event.repeat) {
      if (['ArrowDown', 'KeyS', 'ShiftLeft', 'ShiftRight'].includes(event.code)) pendingActions.add('slide');
      if (['ArrowUp', 'KeyW'].includes(event.code)) pendingActions.add('jump');
      if (event.code === 'Space') pendingActions.add('spike');
    }
  }
});
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
document.querySelectorAll('[data-control]').forEach(button => {
  button.addEventListener('pointerdown', event => {
    event.preventDefault(); if (!['playing', 'serve', 'point'].includes(match.phase)) return;
    button.setPointerCapture(event.pointerId); touches.set(event.pointerId, button.dataset.control); button.classList.add('pressed');
    if (['slide', 'jump', 'spike'].includes(button.dataset.control)) pendingActions.add(button.dataset.control);
  });
  const release = event => { touches.delete(event.pointerId); if (![...touches.values()].includes(button.dataset.control)) button.classList.remove('pressed'); };
  button.addEventListener('pointerup', release); button.addEventListener('pointercancel', release); button.addEventListener('lostpointercapture', release);
  button.addEventListener('contextmenu', event => event.preventDefault());
});

function circle(x, y, radius, color) { ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); }
function line(x1, y1, x2, y2, color, width = 1) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); }
function drawCourt() {
  const sky = ctx.createLinearGradient(0, 0, 0, FLOOR); sky.addColorStop(0, '#9dd9de'); sky.addColorStop(1, '#e2f2df');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  // Court seating, boundary markings and net use game geometry.
  ctx.fillStyle = '#689f9e'; ctx.fillRect(0, 229, W, 12);
  for (let row = 0; row < 3; row++) {
    ctx.fillStyle = ['#7eb8b5', '#8fc8c0', '#a7d6c9'][row]; ctx.fillRect(0, 242 + row * 25, W, 24);
    for (let x = 15; x < W; x += 48) { ctx.fillStyle = '#ffffff24'; ctx.fillRect(x, 249 + row * 25, 28, 7); }
  }
  ctx.fillStyle = '#2a6469'; ctx.fillRect(0, 317, W, 34);
  ctx.font = '700 12px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#a8d9d5';
  for (let x = 105; x < W; x += 250) ctx.fillText('TCG HUB  /  POCKET VOLLEY', x, 339);
  ctx.fillStyle = '#d9eacf'; ctx.fillRect(0, 351, W, 24);
  ctx.fillStyle = '#e3cb91'; ctx.fillRect(0, 375, W, H - 375);
  ctx.fillStyle = '#eedcb0'; ctx.fillRect(22, 389, W - 44, 104);
  ctx.strokeStyle = '#fff5d9'; ctx.lineWidth = 3; ctx.strokeRect(37, 398, W - 74, 84);
  line(480, 397, 480, 482, '#fff5d9', 3);
  line(22, FLOOR + 2, W - 22, FLOOR + 2, '#c5aa75', 2);
  ctx.font = '800 17px system-ui'; ctx.fillStyle = '#9b865b88'; ctx.fillText('YOU', 235, 513); ctx.fillText('CPU', 725, 513);
  ctx.fillStyle = '#164b5350'; ctx.fillRect(NET.x + 8, NET.y + 10, 9, FLOOR - NET.y);
  ctx.fillStyle = '#ecf9f1'; ctx.fillRect(NET.x, NET.y, NET.w, FLOOR - NET.y);
  for (let y = NET.y + 10; y < FLOOR; y += 12) line(NET.x, y, NET.x + NET.w, y, '#648f8f', 2);
  line(NET.x + 6, NET.y, NET.x + 6, FLOOR, '#648f8f', 1);
  ctx.fillStyle = '#235a62'; ctx.fillRect(NET.x - 3, NET.y - 4, NET.w + 6, 7);
}
function drawPlayer(p, index) {
  const id = match.characters[index], color = CHARACTERS[id].color;
  const jump = FLOOR - R - p.y;
  ctx.save(); ctx.globalAlpha = .18; ctx.fillStyle = '#173f45'; ctx.beginPath(); ctx.ellipse(p.x, FLOOR + 5, Math.max(17, 31 - jump / 12), 7, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  const sliding = p.slide > 0;
  const sprite = sprites[sliding ? `${id}-slide` : id];
  if (!sprite) return;
  const bob = !sliding && !reducedMotion && p.vx && p.y >= FLOOR - R ? Math.sin(visualTime * 21) * 3 : 0;
  const slide = sliding ? slideVisual(id, reducedMotion ? .16 : p.slide) : null;
  const bounds = slide ? slide.bounds : spriteBounds[id];
  const height = slide ? slide.height : id === 'pikachu' ? 87 : 76;
  const width = slide ? slide.width : height * bounds[2] / bounds[3];
  ctx.save(); ctx.translate(p.x, p.y + R + bob); ctx.scale(sliding ? p.slideDirection : index === 0 ? -1 : 1, 1);
  if (!reducedMotion && p.spike > 0) ctx.rotate(index ? -.14 : .14);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(sprite, ...bounds, -width / 2, -height, width, height); ctx.restore();
  if (p.spike > 0) { ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, 48, Math.PI, Math.PI * 2); ctx.stroke(); }
  if (sliding && !reducedMotion) {
    for (let n = 0; n < 3; n++) line(p.x - p.slideDirection * (48 + n * 9), FLOOR - 8 - n * 8, p.x - p.slideDirection * (65 + n * 9), FLOOR - 8 - n * 8, '#b49a66', 3);
  }
  circle(p.x, sliding ? FLOOR - height - 12 : p.y - 67, 4, index ? '#285b67' : '#0d9d85');
}
function draw() {
  ctx.clearRect(0, 0, W, H); drawCourt();
  if (!reducedMotion) trail.forEach((p, i) => { ctx.globalAlpha = i / trail.length * .22; circle(p.x, p.y, 11 * i / trail.length, '#fff'); });
  ctx.globalAlpha = 1;
  match.players.forEach(drawPlayer);
  const b = match.ball;
  ctx.save(); ctx.globalAlpha = .14; ctx.fillStyle = '#173f45'; ctx.beginPath(); ctx.ellipse(b.x, FLOOR + 5, 14, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.spin);
  circle(0, 0, 17, '#fffdf1'); ctx.save(); ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#f0b743'; ctx.fillRect(-17, -17, 34, 12); ctx.fillStyle = '#2d9494'; ctx.fillRect(-17, 5, 34, 12);
  line(-17, -5, 17, -5, '#254b58', 1.5); line(-17, 5, 17, 5, '#254b58', 1.5); ctx.restore();
  ctx.beginPath(); ctx.arc(0, 0, 17, 0, Math.PI * 2); ctx.strokeStyle = '#254b58'; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
  particles.forEach(p => { ctx.globalAlpha = Math.max(0, p.life * 2); circle(p.x, p.y, p.size, p.color); }); ctx.globalAlpha = 1;
  if (match.phase === 'serve') { ctx.textAlign = 'center'; ctx.fillStyle = '#255762'; ctx.font = '800 24px system-ui'; ctx.fillText(match.server ? 'CPU 서브' : '내 서브', 480, 112); }
}
function events() {
  for (const e of match.events.splice(0)) {
    if (e.type === 'slide') {
      if (!reducedMotion) for (let i = 0; i < 8; i++) particles.push({ x: e.x, y: e.y, vx: (Math.random() - .5) * 160, vy: -Math.random() * 80, life: .3, size: 3, color: '#bca16b' });
    } else if (e.type === 'hit' || e.type === 'spike' || e.type === 'dig') {
      if (!reducedMotion) for (let i = 0; i < (e.type === 'spike' ? 18 : 8); i++) particles.push({ x: e.x, y: e.y, vx: (Math.random() - .5) * 280, vy: (Math.random() - .6) * 260, life: .45, size: e.type === 'spike' ? 4 : 3, color: CHARACTERS[match.characters[e.side]].color });
      if (e.type === 'spike') { $('rally-message').textContent = '스파이크!'; messageTime = .5; }
      if (e.type === 'dig') { $('rally-message').textContent = '슬라이딩 세이브!'; messageTime = .7; }
    } else if (e.type === 'point' || e.type === 'over') {
      $('rally-message').textContent = e.side === 0 ? '나이스! +1' : '상대 득점'; messageTime = 1.2; trail.length = 0;
      if (e.type === 'over') {
        clearInput(); overlay(e.side === 0 ? 'YOU WIN' : 'GOOD GAME', e.side === 0 ? '멋진 승리!' : '한 판 더 도전?', `${match.scores[0]} : ${match.scores[1]} · ${CHARACTERS[match.characters[e.side]].name} 승리`, '다시 한 판'); $('start').focus({ preventScroll: true });
        if (rankedSession && replay) submitRankedMatch(rankedSession, replay);
        rankedSession = null; replay = null;
      }
      updateUI();
    } else if (e.type === 'serve') updateUI();
  }
}
function frame(time) {
  const dt = Math.min((time - (lastTime || time)) / 1000, .05); lastTime = time;
  if (match.phase !== 'paused') {
    visualTime += dt; accumulator += dt;
    const previousPhase = match.phase;
    while (accumulator >= 1 / 120) {
      const controls = input();
      if (replay && ['serve', 'playing', 'point'].includes(match.phase)) {
        const bits = encodeInput(controls);
        if (bits !== lastBits) { replay.changes.push([replay.ticks, bits]); lastBits = bits; }
        replay.ticks++;
        if (replay.ticks > MAX_TICKS || replay.changes.length > MAX_CHANGES) {
          replay = null; rankedSession = null;
          $('submission-status').textContent = '랭킹 기록 한도(20분 또는 조작 변경 24,000회)를 넘어 연습 경기로 전환됐어요.';
        }
      }
      match.step(1 / 120, controls); pendingActions.clear(); accumulator -= 1 / 120;
    }
    if (previousPhase !== match.phase) updateUI();
    events(); messageTime -= dt; if (messageTime <= 0) $('rally-message').textContent = '';
    for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i]; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; if (p.life <= 0) particles.splice(i, 1); }
    if (match.phase === 'playing') { trail.push({ x: match.ball.x, y: match.ball.y }); if (trail.length > 10) trail.shift(); }
  }
  draw(); requestAnimationFrame(frame);
}
async function loadSprites() {
  $('start').disabled = true; $('start').textContent = '캐릭터 불러오는 중…';
  try {
    const assets = Object.keys(CHARACTERS).flatMap(id => [[id, `${id}.png`], [`${id}-slide`, SLIDE_POSES[id].file]]);
    await Promise.all(assets.map(([id, file]) => new Promise((resolve, reject) => {
      const img = new Image();
      const timeout = setTimeout(() => { img.onload = null; img.onerror = null; reject(new Error(`Sprite timeout: ${id}`)); }, 10000);
      img.onload = () => { clearTimeout(timeout); sprites[id] = img; resolve(); };
      img.onerror = () => { clearTimeout(timeout); reject(new Error(`Sprite unavailable: ${id}`)); };
      img.src = `./sprites/${file}`;
    })));
    loaded = true; $('start').onclick = null;
    overlay('READY TO PLAY', '오늘의 선수는?', '캐릭터를 고른 뒤 코트에 입장하세요.', '경기 시작'); $('start').disabled = false;
  } catch {
    overlay('LOADING ERROR', '캐릭터를 불러오지 못했어요', '연결을 확인하고 다시 시도해 주세요.', '다시 불러오기');
    $('start').disabled = false; $('start').onclick = () => { $('start').onclick = null; loadSprites(); };
  }
}
initLeaderboard(); updateUI(); loadSprites(); requestAnimationFrame(frame);
