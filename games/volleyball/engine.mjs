export const W = 960, H = 540, FLOOR = 456, NET = { x: 474, y: 286, w: 12 }, R = 34, BALL_R = 17;
export const CHARACTERS = {
  pikachu: { name: '피카츄', color: '#f5c534' },
  charmander: { name: '파이리', color: '#f78243' },
  squirtle: { name: '꼬부기', color: '#52b8dc' }
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const LEGACY_DIFFICULTIES = {
  easy: { name: '쉬움', speed: 225, offset: 30, jumpRange: 65, deadZone: 18 },
  normal: { name: '보통', speed: 290, offset: 8, jumpRange: 110, deadZone: 13 },
  hard: { name: '어려움', speed: 340, offset: 0, jumpRange: 135, deadZone: 6 }
};
const V5_DIFFICULTIES = {
  easy: { name: '쉬움', speed: 225, reaction: .18, commitment: .22, aimError: 85, jumpRange: 90, deadZone: 22, attackChance: .18 },
  normal: { name: '보통', speed: 260, reaction: .16, commitment: .20, aimError: 62, jumpRange: 105, deadZone: 16, attackChance: .35 },
  hard: { name: '어려움', speed: 315, reaction: .065, commitment: .09, aimError: 75, jumpRange: 125, deadZone: 8, attackChance: .82 }
};
export const DIFFICULTIES = {
  easy: { name: '쉬움', speed: 245, reaction: .18, commitment: .22, aimError: 80, jumpRange: 95, deadZone: 20, attackChance: .35 },
  normal: { name: '보통', speed: 275, reaction: .14, commitment: .16, aimError: 70, jumpRange: 115, deadZone: 12, attackChance: .55 },
  hard: { name: '어려움', speed: 290, reaction: .11, commitment: .13, aimError: 90, jumpRange: 130, deadZone: 7, attackChance: .80 }
};
function canRunToBall(player, ball, speed) {
  // Check grounded contact before the ball lands, using the replay's fixed tick.
  // A slow drop can be reached on foot even when it is already below net height.
  const dt = 1 / 120, contactRadius = R + BALL_R;
  let { x, y, vx, vy } = ball;
  for (let tick = 1; tick <= 60; tick++) {
    vy += 880 * dt; x += vx * dt; y += vy * dt;
    if (x > W - BALL_R) { x = W - BALL_R; vx = -Math.abs(vx); }
    if (x < NET.x + NET.w + BALL_R) { x = NET.x + NET.w + BALL_R; vx = Math.abs(vx) * .82; }
    if (y + BALL_R >= FLOOR) return false;
    const dy = y - (FLOOR - R);
    if (Math.abs(dy) >= contactRadius) continue;
    const reach = Math.sqrt(contactRadius * contactRadius - dy * dy), travel = speed * tick * dt;
    const left = Math.max(NET.x + NET.w + R, player.x - travel);
    const right = Math.min(W - R, player.x + travel);
    if (x > left - reach && x < right + reach) return true;
  }
  return false;
}
export class Match {
  constructor({ player = 'pikachu', opponent = 'squirtle', difficulty = 'normal', rulesVersion = 6 } = {}) {
    this.characters = [player, opponent]; this.difficulty = Object.hasOwn(DIFFICULTIES, difficulty) ? difficulty : 'normal';
    this.rulesVersion = [3, 4, 5].includes(rulesVersion) ? rulesVersion : 6;
    this.aiRandomState = 0x9e3779b9;
    this.scores = [0, 0]; this.phase = 'ready'; this.server = 0; this.events = [];
    this.resetRally();
  }
  resetRally() {
    this.players = [220, 740].map((x, i) => ({ x, y: FLOOR - R, vx: 0, vy: 0, spike: 0, cooldown: 0, jumpHeld: false,
      facing: i ? -1 : 1, slide: 0, slideCooldown: 0, slideHeld: false, slideDirection: i ? -1 : 1 }));
    this.ball = { x: this.server ? 735 : 225, y: 200, vx: 0, vy: 0, spin: 0 };
    this.timer = 1.15; this.hitLock = 0; this.lastHitSide = null;
    this.shotNumber = 0;
    this.ai = { time: 0, decideAt: 0, target: 737, shot: -1, error: 0, attack: false, controls: {},
      observations: [{ time: 0, shot: 0, ...this.ball }] };
  }
  start() { this.phase = 'serve'; }
  pause() { if (['playing', 'serve', 'point'].includes(this.phase)) { this.beforePause = this.phase; this.phase = 'paused'; } }
  resume() { if (this.phase === 'paused') this.phase = this.beforePause; }
  aiInput(dt = 1 / 120) {
    if (this.rulesVersion >= 5) return this.reactAiInput(dt);
    const p = this.players[1], b = this.ball, easy = this.difficulty === 'easy', hard = this.difficulty === 'hard';
    const settings = LEGACY_DIFFICULTIES[this.difficulty];
    let target = 737;
    if (b.x > 465 || b.vx > 0) {
      const t = clamp((-b.vy + Math.sqrt(Math.max(0, b.vy * b.vy + 1760 * (370 - b.y)))) / 880, 0, .9);
      target = b.x + b.vx * t;
      // Reflect predicted wall bounces in the same court as the physics.
      if (target > W - BALL_R) target = 2 * (W - BALL_R) - target;
      target = clamp(target + settings.offset, 530, 910);
    }
    let saving = hard && b.x > 510 && b.y > 365 && b.vy > 0 && Math.abs(b.x - p.x) > 55 && Math.abs(b.x - p.x) < 190;
    if (saving && this.rulesVersion >= 4) saving = p.y >= FLOOR - R - .1 && !canRunToBall(p, b, settings.speed);
    if (saving) target = b.x;
    return { left: p.x > target + settings.deadZone, right: p.x < target - settings.deadZone,
      jump: !saving && b.x > 490 && Math.abs(b.x - p.x) < settings.jumpRange && b.y > (hard ? 160 : 190) && b.y < 338 && b.vy > -100,
      spike: !easy && p.y < FLOOR - R - 40 && Math.abs(b.x - p.x) < (hard ? 115 : 90) && b.y < p.y,
      slide: saving && p.slideCooldown <= 0 };
  }
  reactAiInput(dt) {
    const p = this.players[1], ai = this.ai, settings = (this.rulesVersion === 5 ? V5_DIFFICULTIES : DIFFICULTIES)[this.difficulty];
    ai.time += dt;
    ai.observations.push({ time: ai.time, shot: this.shotNumber, ...this.ball });
    const observedAt = ai.time - settings.reaction;
    while (ai.observations.length > 1 && ai.observations[1].time <= observedAt) ai.observations.shift();
    if (ai.time >= ai.decideAt) {
      const observation = ai.observations[0], age = ai.time - observation.time;
      // Estimate the visible trajectory between observations; a new hit or net
      // bounce still has to reach the delayed observation before we can react.
      const b = { ...observation, x: observation.x + observation.vx * age,
        y: observation.y + observation.vy * age + 440 * age * age, vy: observation.vy + 880 * age };
      if (b.x > W - BALL_R) { b.x = 2 * (W - BALL_R) - b.x; b.vx = -Math.abs(b.vx); }
      if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy) * .75; }
      // Deterministic perception errors stay with a shot, so later samples do not
      // average them away. Neither decisions nor errors depend on the score.
      const random = () => {
        this.aiRandomState = (Math.imul(this.aiRandomState, 1664525) + 1013904223) >>> 0;
        return this.aiRandomState / 4294967296;
      };
      if (ai.shot !== b.shot) {
        ai.shot = b.shot; ai.error = (random() * 2 - 1) * settings.aimError;
        ai.attack = random() < settings.attackChance;
      }
      ai.decideAt = ai.time + settings.commitment;
      let target = 737;
      if (b.x > 465 || b.vx > 0) {
        const t = clamp((-b.vy + Math.sqrt(Math.max(0, b.vy * b.vy + 1760 * (370 - b.y)))) / 880, 0, .9);
        target = b.x + b.vx * t;
        if (target > W - BALL_R) target = 2 * (W - BALL_R) - target;
        const uncertainty = clamp((Math.abs(b.vx) - 180) / 320, .2, 1);
        target = clamp(target + ai.error * uncertainty, 530, 910);
      }
      const saving = this.difficulty === 'hard' && p.y >= FLOOR - R - .1 && p.slideCooldown <= 0 &&
        b.x > 510 && b.y > 365 && b.vy > 0 && Math.abs(b.x - p.x) > 55 && Math.abs(b.x - p.x) < 190 && !canRunToBall(p, b, settings.speed);
      if (saving) target = b.x;
      ai.target = target;
      const liftNearNet = b.x < 600 && p.x < 620;
      const jumpHeight = (this.difficulty === 'hard' ? 155 : 175) - Math.max(0, b.vy) * settings.commitment * .65;
      ai.controls = {
        jump: !saving && (ai.attack || liftNearNet) && b.x > 490 && Math.abs(b.x - p.x) < settings.jumpRange && b.y > jumpHeight && b.y < 320 && b.vy > -60,
        spike: this.difficulty !== 'easy' && ai.attack && p.y < FLOOR - R - 40 && Math.abs(b.x - p.x) < settings.jumpRange && b.y < p.y,
        slide: saving
      };
      if (this.rulesVersion >= 6 && this.difficulty !== 'easy' && ai.attack && !saving) {
        const grounded = p.y >= FLOOR - R - .1;
        ai.controls.jump = false; ai.controls.spike = false;
        if (b.x > 660) {
          // Take a low, late contact from the back court: its fast rising arc
          // crosses the net, unlike a downward strike from the baseline.
          const contactX = clamp(b.x + b.vx * .10 + ai.error * .35, 530, 926);
          if (b.y > 290 && b.y < 385 && b.vy > 0 && Math.abs(contactX - p.x) < settings.speed * .1 + 42) {
            ai.target = contactX;
            ai.controls.jump = grounded;
            ai.controls.spike = true;
          }
        } else {
          // Near the net, plan an aerial contact from the delayed trajectory.
          // The forecast uses the player's running speed and jump arc.
          let predicted = { ...b }, playerY = p.y, playerVy = grounded ? -735 : p.vy;
          for (let tick = 1; tick <= 60; tick++) {
            const t = tick / 120;
            predicted.vy += 880 / 120; predicted.x += predicted.vx / 120; predicted.y += predicted.vy / 120;
            playerVy += 1800 / 120; playerY += playerVy / 120;
            if (predicted.y < BALL_R) { predicted.y = BALL_R; predicted.vy = Math.abs(predicted.vy) * .75; }
            if (predicted.y > FLOOR - BALL_R || playerY > FLOOR - R) break;
            const targetX = clamp(predicted.x + ai.error * .35, 520, 926);
            const netTime = Math.max(0, predicted.x - (NET.x + NET.w + BALL_R)) / 590;
            if (predicted.x < 503 || predicted.x > 700 || predicted.y > 235 ||
                Math.abs(predicted.y - playerY) > 48 || Math.abs(targetX - p.x) > settings.speed * t + 24 ||
                predicted.y + 135 * netTime + 440 * netTime * netTime >= NET.y - BALL_R - 8) continue;
            ai.target = targetX;
            ai.controls.jump = grounded;
            ai.controls.spike = !grounded && t < .18;
            break;
          }
        }
      }
    }
    return { left: p.x > ai.target + settings.deadZone, right: p.x < ai.target - settings.deadZone, ...ai.controls };
  }
  step(dt, input = {}) {
    if (!['playing', 'serve', 'point'].includes(this.phase)) return;
    dt = Math.min(dt, 1 / 60);
    if (this.phase === 'point') {
      this.timer -= dt;
      if (this.timer <= 0) { this.resetRally(); this.phase = 'serve'; }
      return;
    }
    const controls = [input, this.aiInput(dt)];
    this.players.forEach((p, i) => {
      const c = controls[i], speed = i ? (this.rulesVersion >= 6 ? DIFFICULTIES : this.rulesVersion === 5 ? V5_DIFFICULTIES : LEGACY_DIFFICULTIES)[this.difficulty].speed : 340;
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
      if (this.timer <= 0) { this.phase = 'playing'; this.ball.vx = this.server ? -210 : 210; this.ball.vy = -330; this.shotNumber++; this.events.push({ type: 'serve' }); }
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
      if (dist >= radius + BALL_R || (this.hitLock > 0 && (this.rulesVersion === 3 || this.lastHitSide === i))) return;
      const nx = dist ? dx / dist : 0, ny = dist ? dy / dist : -1;
      b.x = bodyX + nx * (radius + BALL_R + 1); b.y = bodyY + ny * (radius + BALL_R + 1);
      if (sliding) b.y = Math.min(b.y, FLOOR - BALL_R - 1);
      const direction = i ? -1 : 1;
      const spike = p.spike > 0 && p.y < FLOOR - R - 15;
      b.vx = sliding ? direction * 390 : direction * (spike ? 720 : 360) + p.vx * .22 + dx * 1.3;
      b.vy = sliding ? -700 : spike && b.y < NET.y - 48 ? 135 : (spike ? -660 : -640);
      this.hitLock = .12; this.lastHitSide = i; this.shotNumber++; p.spike = 0;
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
