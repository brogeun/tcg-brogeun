import { W, H, FLOOR, NET, R, CHARACTERS } from './engine.mjs?v=8';
import { SLIDE_POSES, slideVisual } from './slide-poses.mjs?v=1';
import { canvasFont, refreshCanvasFont } from '../shared/fonts.mjs?v=1';

const TAU = Math.PI * 2;
const legacyBounds = { pikachu: [31, 24, 39, 46], charmander: [30, 29, 38, 42], squirtle: [29, 29, 38, 39] };

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => { img.onload = img.onerror = null; reject(new Error(`Image timeout: ${url}`)); }, 12000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error(`Image unavailable: ${url}`)); };
    img.src = url;
  });
}

export class CourtRenderer {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) throw new Error('Canvas rendering is unavailable');
    this.reducedMotion = reducedMotion;
    this.characters = {};
    this.rings = [];
    this.time = 0;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }

  resize() {
    refreshCanvasFont();
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const size = Math.min(rect.width / W, rect.height / H);
    const scale = Math.max(1, Math.min(2, size * (globalThis.devicePixelRatio || 1)));
    const width = Math.round(W * scale), height = Math.round(H * scale);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
    }
  }

  async load() {
    const fallback = Object.fromEntries(Object.keys(CHARACTERS).map(id => [id,
      loadImage(`./sprites/${id}.png`).then(image => ({ image, legacy: true, poses: { idle: legacyBounds[id] } })).catch(() => null)
    ]));
    let manifest;
    try {
      const response = await fetch('./art/manifest.json?v=1', { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Art manifest unavailable');
      manifest = await response.json();
    } catch { manifest = { characters: {} }; }
    await Promise.all(Object.keys(CHARACTERS).map(async id => {
      const spec = manifest.characters[id];
      // Load the small PMD fallback even when an advertised atlas has slide art:
      // that atlas may fail independently while the legacy images are available.
      const slideImage = loadImage(`./sprites/${SLIDE_POSES[id].file}`).catch(() => null);
      try {
        if (!spec) throw new Error('Missing character art');
        const image = await loadImage(`./art/${spec.file}`);
        this.characters[id] = { image, poses: spec.poses, anchors: spec.anchors };
      } catch {
        this.characters[id] = await fallback[id];
        if (!this.characters[id]) throw new Error(`Character unavailable: ${id}`);
      }
      if (slideImage) this.characters[id].slideImage = await slideImage;
    }));
    // The match can start even if the decorative backdrop is slow or unavailable.
    if (manifest.background) loadImage(`./art/${manifest.background.file}`).then(image => { this.background = image; }).catch(() => {});
    document.querySelectorAll('[data-portrait]').forEach(canvas => this.portrait(canvas));
  }

  portrait(canvas) {
    const art = this.characters[canvas.dataset.portrait];
    if (!art) return;
    const c = canvas.getContext('2d');
    const bounds = art.poses.idle;
    const scale = Math.min(148 / bounds[2], 144 / bounds[3]);
    c.clearRect(0, 0, 160, 160);
    c.imageSmoothingEnabled = !art.legacy;
    c.drawImage(art.image, ...bounds, (160 - bounds[2] * scale) / 2, 153 - bounds[3] * scale, bounds[2] * scale, bounds[3] * scale);
  }

  circle(x, y, radius, fill) {
    const c = this.ctx; c.beginPath(); c.arc(x, y, radius, 0, TAU); c.fillStyle = fill; c.fill();
  }
  line(x1, y1, x2, y2, color, width = 1) {
    const c = this.ctx; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.strokeStyle = color; c.lineWidth = width; c.stroke();
  }

  court() {
    const c = this.ctx;
    const sky = c.createLinearGradient(0, 0, 0, FLOOR);
    sky.addColorStop(0, '#47bbc9'); sky.addColorStop(.62, '#cef0e5'); sky.addColorStop(1, '#fff1c6');
    c.fillStyle = sky; c.fillRect(0, 0, W, H);
    if (this.background) c.drawImage(this.background, 0, 0, W, H);
    else {
      this.circle(788, 90, 43, '#fff8d4');
      c.fillStyle = '#64bcc7'; c.fillRect(0, 300, W, 84);
      for (let i = 0; i < 5; i++) this.line(0, 316 + i * 13, W, 316 + i * 13, '#e4ffff55', 2);
    }
    // Sand overlays fade into the art; the flat front boundary is the actual floor.
    const sand = c.createLinearGradient(0, 340, 0, H);
    sand.addColorStop(0, '#f5d7a300'); sand.addColorStop(.3, '#f5d7a3eb'); sand.addColorStop(1, '#e7bc7d');
    c.fillStyle = sand; c.fillRect(0, 340, W, H - 340);
    c.beginPath(); c.moveTo(54, 397); c.lineTo(906, 397); c.lineTo(940, FLOOR + 5); c.lineTo(20, FLOOR + 5); c.closePath();
    c.fillStyle = '#ffe8b87a'; c.fill(); c.strokeStyle = '#fff8e3'; c.lineWidth = 3; c.stroke();
    this.line(480, 398, 480, FLOOR + 5, '#fffbeb', 3);
    this.line(20, FLOOR + 8, 940, FLOOR + 8, '#ae865446', 2);
    c.fillStyle = '#aa794427';
    for (let i = 0; i < 90; i++) c.fillRect((i * 137 + 31) % W, 377 + (i * 43) % 158, i % 3 + 1, 1);
    c.font = canvasFont(11, 800); c.textAlign = 'center'; c.fillStyle = '#956f49a6';
    c.fillText('TCG HUB  /  BEACH CLUB', 480, 510);
    c.font = canvasFont(12, 800); c.fillStyle = '#627b72b3';
    c.fillText('YOU', 235, 488); c.fillText('CPU', 725, 488);

    c.save(); c.translate(NET.x, NET.y);
    const netHeight = FLOOR - NET.y;
    c.fillStyle = '#755c432a'; c.beginPath(); c.moveTo(4, netHeight); c.lineTo(30, netHeight + 13); c.lineTo(37, netHeight + 10); c.lineTo(12, netHeight); c.fill();
    c.fillStyle = '#f5fff3b8'; c.fillRect(0, 0, NET.w, netHeight);
    for (let y = 10; y < netHeight; y += 10) this.line(1, y, NET.w - 1, y, '#426568a6', 1);
    this.line(3, 2, 3, netHeight, '#3e666ba6'); this.line(9, 2, 9, netHeight, '#3e666ba6');
    const post = c.createLinearGradient(-3, 0, 3, 0); post.addColorStop(0, '#176a70'); post.addColorStop(.45, '#55a7a4'); post.addColorStop(1, '#20515d');
    c.fillStyle = post; c.fillRect(-3, 1, 6, netHeight + 2);
    c.fillStyle = '#fffaf0'; c.fillRect(-4, -3, NET.w + 7, 7);
    c.fillStyle = '#277780'; c.fillRect(-4, 4, NET.w + 7, 2);
    c.restore();
  }

  player(p, side, match) {
    const c = this.ctx, art = this.characters[match.characters[side]];
    if (!art) return;
    const jumping = p.y < FLOOR - R - 4, sliding = p.slide > 0;
    const won = ['point', 'over'].includes(match.phase) && match.server === side;
    const pose = sliding ? 'slide' : won ? 'victory' : jumping ? 'attack' : 'idle';
    const oldSlide = sliding && !art.poses.slide && art.slideImage;
    const bounds = oldSlide ? slideVisual(match.characters[side], p.slide).bounds : art.poses[pose] || art.poses.idle;
    const maxWidth = oldSlide ? 100 : sliding ? 126 : 111, maxHeight = sliding ? 58 : won ? 102 : jumping ? 100 : 94;
    const fit = Math.min(maxWidth / bounds[2], maxHeight / bounds[3]);
    const width = bounds[2] * fit, height = bounds[3] * fit;
    const anchor = !oldSlide && art.anchors?.[pose];
    const lift = Math.max(0, FLOOR - R - p.y);
    c.save(); c.globalAlpha = .2 - Math.min(.12, lift / 1700);
    c.fillStyle = '#5b614d'; c.beginPath(); c.ellipse(p.x, FLOOR + 2, sliding ? 47 : Math.max(15, 30 - lift / 15), 6, 0, 0, TAU); c.fill(); c.restore();
    const moving = !jumping && !sliding && Math.abs(p.vx) > 1;
    const bob = this.reducedMotion || sliding ? 0 : moving ? Math.sin(this.time * 24) * 2 : Math.sin(this.time * 3 + side) * .7;
    const facing = sliding ? p.slideDirection : jumping || won ? (side ? -1 : 1) : p.facing;
    c.save(); c.translate(p.x, (sliding ? FLOOR : p.y + R) + bob);
    c.scale(facing * (art.legacy && !oldSlide ? -1 : 1), 1);
    if (moving && !this.reducedMotion) c.rotate(Math.sin(this.time * 24) * .025);
    c.imageSmoothingEnabled = !art.legacy && !oldSlide; c.imageSmoothingQuality = 'high';
    c.drawImage(oldSlide ? art.slideImage : art.image, ...bounds,
      anchor ? -anchor[0] * fit : -width / 2, anchor ? -anchor[1] * fit : -height, width, height); c.restore();
    if (p.spike > 0) {
      c.save(); c.strokeStyle = '#fffdf0'; c.lineWidth = 4; c.globalAlpha = .75;
      c.beginPath(); c.arc(p.x, p.y - 7, 49, side ? Math.PI : -.8, side ? 3.9 : .8); c.stroke(); c.restore();
    }
    if (sliding && !this.reducedMotion) {
      for (let i = 0; i < 3; i++) this.line(p.x - p.slideDirection * (58 + i * 7), FLOOR - 9 - i * 8, p.x - p.slideDirection * (78 + i * 9), FLOOR - 9 - i * 8, '#fff5d6b3', 3);
    }
    if (!sliding) {
      const markerY = p.y + R - height - 10;
      c.beginPath(); c.moveTo(p.x - 4, markerY - 4); c.lineTo(p.x + 4, markerY - 4); c.lineTo(p.x, markerY + 2); c.closePath();
      c.fillStyle = side ? '#345963' : '#087f73'; c.fill();
    }
  }

  ball(ball, trail) {
    const c = this.ctx;
    if (!this.reducedMotion && trail.length > 1) {
      c.save(); c.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) {
        const t = i / trail.length;
        this.line(trail[i - 1].x, trail[i - 1].y, trail[i].x, trail[i].y, `rgba(255,250,223,${t * .58})`, 3 + t * 18);
      }
      c.restore();
    }
    const lift = Math.max(0, FLOOR - ball.y);
    c.save(); c.globalAlpha = .16; c.fillStyle = '#6e6650'; c.beginPath(); c.ellipse(ball.x, FLOOR + 1, Math.max(6, 15 - lift / 50), 3, 0, 0, TAU); c.fill(); c.restore();
    c.save(); c.translate(ball.x, ball.y); c.rotate(ball.spin);
    this.circle(0, 0, 17, '#fffbee');
    c.save(); c.beginPath(); c.arc(0, 0, 16, 0, TAU); c.clip();
    for (let i = 0; i < 3; i++) {
      c.save(); c.rotate(i * TAU / 3); c.beginPath(); c.moveTo(-2, -17); c.bezierCurveTo(15, -12, 11, 9, -8, 17); c.lineTo(7, 19); c.bezierCurveTo(21, 7, 21, -10, 11, -19); c.closePath();
      c.fillStyle = i === 1 ? '#f0b638' : '#258f9d'; c.fill(); c.strokeStyle = '#2a626870'; c.lineWidth = 1; c.stroke(); c.restore();
    }
    c.restore();
    c.beginPath(); c.arc(0, 0, 17, 0, TAU); c.strokeStyle = '#254b56'; c.lineWidth = 1.8; c.stroke();
    c.rotate(-ball.spin);
    const shade = c.createRadialGradient(-6, -7, 1, 2, 3, 20); shade.addColorStop(0, '#ffffff99'); shade.addColorStop(.45, '#ffffff00'); shade.addColorStop(1, '#163e5266');
    this.circle(0, 0, 16, shade); this.circle(-6, -7, 3, '#ffffffbd'); c.restore();
  }

  event(event) {
    if (this.reducedMotion) return;
    if (['hit', 'dig', 'spike'].includes(event.type)) this.rings.push({ x: event.x, y: event.y, age: 0, power: event.type === 'spike' ? 1.6 : 1 });
  }

  draw(match, { time, dt, trail, particles, feedback }) {
    const c = this.ctx; this.time = time;
    c.setTransform(this.canvas.width / W, 0, 0, this.canvas.height / H, 0, 0);
    c.globalAlpha = 1; this.court();
    match.players.forEach((p, side) => this.player(p, side, match));
    this.ball(match.ball, trail);
    for (const p of particles) { c.globalAlpha = Math.min(1, Math.max(0, p.life * 2)); this.circle(p.x, p.y, p.size, p.color); }
    c.globalAlpha = 1;
    for (const ring of this.rings) {
      if (match.phase !== 'paused') ring.age += dt;
      const t = ring.age / .32;
      if (t >= 1) continue;
      c.globalAlpha = (1 - t) * .9; c.strokeStyle = '#fffbea'; c.lineWidth = (1 - t) * 4 + 1;
      c.beginPath(); c.arc(ring.x, ring.y, (15 + t * 36) * ring.power, 0, TAU); c.stroke();
    }
    this.rings = this.rings.filter(ring => ring.age < .32); c.globalAlpha = 1;
    if (match.phase === 'serve') this.pill(`${match.server ? 'CPU 서브' : '내 서브'}  ·  ${Math.max(1, Math.ceil(match.timer / .4))}`, 480, 83);
    if (feedback.rally >= 3 && match.phase === 'playing') this.pill(`${feedback.rally}회 랠리`, 480, 33);
  }

  pill(text, x, y) {
    const c = this.ctx; c.font = canvasFont(15, 800); c.textAlign = 'center';
    const width = c.measureText(text).width + 30;
    c.fillStyle = '#123e46cc'; c.beginPath(); c.roundRect(x - width / 2, y - 19, width, 32, 16); c.fill();
    c.fillStyle = '#fffdf0'; c.fillText(text, x, y + 2);
  }
}
