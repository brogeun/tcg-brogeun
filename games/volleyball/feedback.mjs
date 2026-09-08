export class MatchFeedback {
  constructor() { this.ticks = 0; this.spikes = 0; this.saves = 0; this.rally = 0; this.longest = 0; }
  step() { this.ticks++; }
  event(event) {
    if (['hit', 'spike', 'dig'].includes(event.type)) {
      this.longest = Math.max(this.longest, ++this.rally);
      if (event.side === 0 && event.type === 'spike') this.spikes++;
      if (event.side === 0 && event.type === 'dig') this.saves++;
    }
    if (['point', 'over'].includes(event.type)) this.rally = 0;
  }
  get time() {
    const seconds = Math.floor(this.ticks / 120);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
}

// Presentation time only: no simulation or ranked replay ticks advance here.
export class ResumeCountdown {
  constructor() { this.remaining = 0; }
  start() { this.remaining = 3; }
  cancel() { this.remaining = 0; }
  get active() { return this.remaining > 0; }
  get label() { return String(Math.ceil(this.remaining)); }
  step(dt) {
    if (!this.active) return false;
    this.remaining = Math.max(0, this.remaining - dt);
    return !this.active;
  }
}
