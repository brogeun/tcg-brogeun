export const W = 960, H = 540, FLOOR = 456, NET = { x: 474, y: 286, w: 12 }, R = 34, BALL_R = 17;
export const CHARACTERS = {
  pikachu: { name: '피카츄', color: '#f5c534' },
  charmander: { name: '파이리', color: '#f78243' },
  squirtle: { name: '꼬부기', color: '#52b8dc' }
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const DIFFICULTIES = {
  easy: { name: '쉬움', speed: 225, offset: 30, jumpRange: 65, deadZone: 18 },
  normal: { name: '보통', speed: 290, offset: 8, jumpRange: 110, deadZone: 13 },
  hard: { name: '어려움', speed: 340, offset: 0, jumpRange: 135, deadZone: 6 }
};
export class Match {
  constructor({ player = 'pikachu', opponent = 'squirtle', difficulty = 'normal' } = {}) {
    this.characters = [player, opponent]; this.difficulty = Object.hasOwn(DIFFICULTIES, difficulty) ? difficulty : 'normal';
    this.scores = [0, 0]; this.phase = 'ready'; this.server = 0; this.events = [];
    this.resetRally();
  }
  resetRally() {
    this.players = [220, 740].map((x, i) => ({ x, y: FLOOR - R, vx: 0, vy: 0, spike: 0, cooldown: 0, jumpHeld: false,
      facing: i ? -1 : 1, slide: 0, slideCooldown: 0, slideHeld: false, slideDirection: i ? -1 : 1 }));
    this.ball = { x: this.server ? 735 : 225, y: 200, vx: 0, vy: 0, spin: 0 };
    this.timer = 1.15; this.hitLock = 0;
  }
  start() { this.phase = 'serve'; }
  pause() { if (['playing', 'serve', 'point'].includes(this.phase)) { this.beforePause = this.phase; this.phase = 'paused'; } }
  resume() { if (this.phase === 'paused') this.phase = this.beforePause; }
  aiInput() {
    const p = this.players[1], b = this.ball, easy = this.difficulty === 'easy', hard = this.difficulty === 'hard';
    const settings = DIFFICULTIES[this.difficulty];
    let target = 737;
    if (b.x > 465 || b.vx > 0) {
      const t = clamp((-b.vy + Math.sqrt(Math.max(0, b.vy * b.vy + 1760 * (370 - b.y)))) / 880, 0, .9);
      target = b.x + b.vx * t;
      // Reflect predicted wall bounces in the same court as the physics.
      if (target > W - BALL_R) target = 2 * (W - BALL_R) - target;
      target = clamp(target + settings.offset, 530, 910);
    }
    const saving = hard && b.x > 510 && b.y > 365 && b.vy > 0 && Math.abs(b.x - p.x) > 55 && Math.abs(b.x - p.x) < 190;
    if (saving) target = b.x;
    return { left: p.x > target + settings.deadZone, right: p.x < target - settings.deadZone,
      jump: !saving && b.x > 490 && Math.abs(b.x - p.x) < settings.jumpRange && b.y > (hard ? 160 : 190) && b.y < 338 && b.vy > -100,
      spike: !easy && p.y < FLOOR - R - 40 && Math.abs(b.x - p.x) < (hard ? 115 : 90) && b.y < p.y,
      slide: saving && p.slideCooldown <= 0 };
  }
  step(dt, input = {}) {
    if (!['playing', 'serve', 'point'].includes(this.phase)) return;
    dt = Math.min(dt, 1 / 60);
    if (this.phase === 'point') {
      this.timer -= dt;
      if (this.timer <= 0) { this.resetRally(); this.phase = 'serve'; }
      return;
    }
    const controls = [input, this.aiInput()];
    this.players.forEach((p, i) => {
      const c = controls[i], speed = i ? DIFFICULTIES[this.difficulty].speed : 340;
      const movement = (c.right ? 1 : 0) - (c.left ? 1 : 0);
      p.slide = Math.max(0, p.slide - dt); p.slideCooldown = Math.max(0, p.slideCooldown - dt);
      if (movement && p.slide <= 0) p.facing = movement;
      if (c.slide && !p.slideHeld && p.slideCooldown <= 0 && p.y >= FLOOR - R - .1) {
        p.slide = .32; p.slideCooldown = .85; p.slideDirection = p.facing; p.spike = 0;
        this.events.push({ type: 'slide', x: p.x, y: FLOOR - 4, side: i });
      }
      p.slideHeld = !!c.slide;
      p.vx = p.slide > 0 ? p.slideDirection * (330 + 370 * p.slide / .32) : movement * speed;
      const reach = p.slide > 0 ? 47 : R;
      p.x = clamp(p.x + p.vx * dt, i ? NET.x + NET.w + reach : reach, i ? W - reach : NET.x - reach);
      if (c.jump && !p.jumpHeld && p.slide <= 0 && p.y >= FLOOR - R - .1) p.vy = -735;
      p.jumpHeld = !!c.jump;
      p.vy += 1800 * dt; p.y += p.vy * dt;
      if (p.y >= FLOOR - R) { p.y = FLOOR - R; p.vy = 0; }
      p.spike = Math.max(0, p.spike - dt); p.cooldown = Math.max(0, p.cooldown - dt);
      if (c.spike && p.cooldown <= 0 && p.y < FLOOR - R - 15) { p.spike = .23; p.cooldown = .5; }
    });
    if (this.phase === 'serve') {
      this.timer -= dt;
      if (this.timer <= 0) { this.phase = 'playing'; this.ball.vx = this.server ? -210 : 210; this.ball.vy = -330; this.events.push({ type: 'serve' }); }
      return;
    }
    const b = this.ball, previous = { x: b.x, y: b.y };
    b.vy += 880 * dt; b.x += b.vx * dt; b.y += b.vy * dt; b.spin += b.vx * dt / 42;
    this.hitLock = Math.max(0, this.hitLock - dt);
    if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
    if (b.x > W - BALL_R) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy) * .75; }
    if (b.x + BALL_R > NET.x && b.x - BALL_R < NET.x + NET.w && b.y + BALL_R > NET.y) {
      if (previous.y + BALL_R <= NET.y && b.vy > 0) { b.y = NET.y - BALL_R; b.vy = -Math.abs(b.vy) * .75; }
      else if (previous.x < W / 2) { b.x = NET.x - BALL_R; b.vx = -Math.abs(b.vx) * .82; }
      else { b.x = NET.x + NET.w + BALL_R; b.vx = Math.abs(b.vx) * .82; }
    }
    this.players.forEach((p, i) => {
      // A low horizontal capsule gives a sliding player a wider ground-level reach.
      const sliding = p.slide > 0, radius = sliding ? 22 : R;
      const bodyX = sliding ? clamp(b.x, p.x - 25, p.x + 25) : p.x;
      const bodyY = sliding ? FLOOR - 22 : p.y;
      const dx = b.x - bodyX, dy = b.y - bodyY, dist = Math.hypot(dx, dy);
      if (dist >= radius + BALL_R || this.hitLock > 0) return;
      const nx = dist ? dx / dist : 0, ny = dist ? dy / dist : -1;
      b.x = bodyX + nx * (radius + BALL_R + 1); b.y = bodyY + ny * (radius + BALL_R + 1);
      if (sliding) b.y = Math.min(b.y, FLOOR - BALL_R - 1);
      const direction = i ? -1 : 1;
      const spike = p.spike > 0 && p.y < FLOOR - R - 15;
      b.vx = sliding ? direction * 390 : direction * (spike ? 720 : 360) + p.vx * .22 + dx * 1.3;
      b.vy = sliding ? -700 : spike && b.y < NET.y - 48 ? 135 : (spike ? -660 : -640);
      this.hitLock = .12; p.spike = 0;
      this.events.push({ type: sliding ? 'dig' : spike ? 'spike' : 'hit', x: b.x, y: b.y, side: i });
    });
    if (b.y + BALL_R >= FLOOR) this.point(b.x < W / 2 ? 1 : 0);
  }
  point(side) {
    this.scores[side]++; this.server = side; this.timer = 1.35;
    this.phase = this.scores[side] >= 7 ? 'over' : 'point';
    this.events.push({ type: this.phase === 'over' ? 'over' : 'point', side });
  }
}
