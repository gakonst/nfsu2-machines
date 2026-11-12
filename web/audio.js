// Sound, all synthesized with WebAudio (no files): an engine voice from oscillators and filtered noise driven by
// rpm and throttle, a nitrous whoosh, a shift blip, countdown beeps and a crash thud.

export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('mm.muted') === '1';
  }

  /** Call from a user gesture: browsers only start audio after one. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);
    this.noise = this.noiseBuffer(ctx);

    // engine: two detuned saws and a square an octave down -> drive -> lowpass -> gain
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 4;
    const drive = ctx.createWaveShaper();
    drive.curve = this.driveCurve(2.5);
    drive.connect(this.lp).connect(this.engineGain).connect(this.master);
    this.oscs = [['sawtooth', 1, 0.5], ['sawtooth', 1.007, 0.35], ['square', 0.5, 0.3]].map(([type, mul, level]) => {
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.type = type; gn.gain.value = level; o.connect(gn).connect(drive); o.start();
      return { o, mul };
    });
    // intake roar: noise through a bandpass that tracks rpm
    this.roar = this.loopNoise(ctx, 'bandpass', 800, 1.2);
    // nitrous hiss
    this.hiss = this.loopNoise(ctx, 'highpass', 3000, 0.7);
  }

  setMuted(m) {
    this.muted = m;
    localStorage.setItem('mm.muted', m ? '1' : '0');
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  noiseBuffer(ctx) {
    const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
    let x = 0x2545f491;
    for (let i = 0; i < d.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = ((x >>> 0) / 4294967295) * 2 - 1; }
    return b;
  }

  driveCurve(k) {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  }

  loopNoise(ctx, type, freq, q) {
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), gn = ctx.createGain();
    src.buffer = this.noise; src.loop = true;
    f.type = type; f.frequency.value = freq; f.Q.value = q; gn.gain.value = 0;
    src.connect(f).connect(gn).connect(this.master); src.start();
    return { f, g: gn };
  }

  /** Every animation frame while racing: rpm 0..8000, throttle and nitro on/off. */
  engine(rpm, throttle, nitro) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, r = Math.max(700, Math.min(8200, rpm));
    const f0 = r / 30; // a four-cylinder fires twice per turn
    for (const { o, mul } of this.oscs) o.frequency.setTargetAtTime(f0 * mul, t, 0.02);
    this.lp.frequency.setTargetAtTime(300 + r * (throttle ? 0.55 : 0.25), t, 0.04);
    this.engineGain.gain.setTargetAtTime(0.16 + (throttle ? 0.14 : 0) + r / 80000, t, 0.05);
    this.roar.f.frequency.setTargetAtTime(400 + r * 0.3, t, 0.05);
    this.roar.g.gain.setTargetAtTime(throttle ? 0.05 + r / 120000 : 0.015, t, 0.08);
    this.hiss.g.gain.setTargetAtTime(nitro ? 0.22 : 0, t, nitro ? 0.03 : 0.15);
  }

  silence() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(0, t, 0.1);
    this.roar.g.gain.setTargetAtTime(0, t, 0.1);
    this.hiss.g.gain.setTargetAtTime(0, t, 0.1);
  }

  beep(freq, dur = 0.15, type = 'square', level = 0.25) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), gn = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    gn.gain.setValueAtTime(level, t); gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(gn).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }

  /** A gear change: the engine dips and a short pop. */
  shift() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.cancelScheduledValues(t);
    this.engineGain.gain.setValueAtTime(0.05, t);
    this.engineGain.gain.setTargetAtTime(0.3, t + 0.06, 0.05);
    this.burst(0.08, 1800, 'bandpass', 0.3);
  }

  crash() { this.burst(0.5, 300, 'lowpass', 0.8); this.beep(55, 0.3, 'sine', 0.5); }

  burst(dur, freq, type, level) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, src = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), gn = this.ctx.createGain();
    src.buffer = this.noise; f.type = type; f.frequency.value = freq;
    gn.gain.setValueAtTime(level, t); gn.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(gn).connect(this.master); src.start(t); src.stop(t + dur + 0.02);
  }

  /** HUD events -> sounds. */
  events(list) {
    for (const e of list) {
      if (e === 'count') this.beep(440, 0.18);
      else if (e === 'go') this.beep(880, 0.5);
      else if (e === 'shift') this.shift();
      else if (e === 'crash') this.crash();
    }
  }
}
