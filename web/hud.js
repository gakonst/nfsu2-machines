// The HUD: drawn in JS on a high-resolution canvas over the 320x180 frame, from the state words only. Layout is in
// 320x180 units (u = one unit in canvas pixels). draw() also returns the moments the audio wants (beeps, shifts).
import { C, FLAG, H, HEADER_WORDS, CAR_WORDS, COUNTDOWN_TICKS, RPM } from './net.js';

export const CAR_COLOURS = ['#ff2bd6', '#00e5ff', '#ffd400', '#39ff14', '#ff6a00', '#8a5cff', '#ffffff', '#ff3355'];
const MODES = ['CIRCUIT', 'SPRINT', 'DRAG'];
const SHIFTS = [null, ['PERFECT SHIFT', '#39ff14'], ['GOOD SHIFT', '#00e5ff'], ['EARLY SHIFT', '#ffd400'], ['LATE SHIFT', '#ff6a00']];
const FONT = '"Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", Arial, sans-serif';
const PINK = '#ff2bd6', CYAN = '#00e5ff', GOLD = '#ffd400', INK = '#f2efff', DIM = '#8d88b5';
const LEDS = [[6000, '#39ff14'], [6400, '#39ff14'], [6800, '#ffd400'], [7050, '#ffd400'], [7300, '#ff3355']];

const pad2 = (n) => String(n).padStart(2, '0');
export function fmtTime(ticks) {
  if (!(ticks > 0)) return '--:--.--';
  const cs = Math.floor((ticks * 100) / 60);
  return Math.floor(cs / 6000) + ':' + pad2(Math.floor(cs / 100) % 60) + '.' + pad2(cs % 100);
}
export const ordinal = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? 'ST' : n % 10 === 2 && n % 100 !== 12 ? 'ND' : n % 10 === 3 && n % 100 !== 13 ? 'RD' : 'TH');

export class Hud {
  constructor(canvas) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.u = 1;
    this.touch = false; // phones: a smaller tach above the right-hand touch pads
    this.reset();
  }

  reset() {
    this.pop = null; // { text, colour, at }
    this.goAt = -1;
    this.crashAt = -1e9;
    this.prev = { gear: 0, shift: 0, flags: 0, count: -1, phase: -1, finished: 0 };
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.round(r.width * dpr)), h = Math.max(180, Math.round(r.height * dpr));
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    this.u = this.cv.height / 180;
  }

  clear() { this.resize(); this.g.clearRect(0, 0, this.cv.width, this.cv.height); }

  car(s, slot, w) { return s[HEADER_WORDS + slot * CAR_WORDS + w]; }

  text(str, x, y, size, colour, align = 'left', glow = 0, weight = 800) {
    const g = this.g, u = this.u;
    g.font = 'italic ' + weight + ' ' + (size * u).toFixed(1) + 'px ' + FONT;
    g.textAlign = align;
    g.textBaseline = 'alphabetic';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(1, size * u * 0.12);
    g.strokeStyle = 'rgba(4,3,10,0.75)';
    g.strokeText(str, x * u, y * u);
    g.shadowColor = colour;
    g.shadowBlur = glow * u;
    g.fillStyle = colour;
    g.fillText(str, x * u, y * u);
    g.shadowBlur = 0;
  }

  box(x, y, w, h, fill, stroke) {
    const g = this.g, u = this.u;
    g.beginPath();
    g.moveTo((x + 4) * u, y * u); g.lineTo((x + w) * u, y * u); g.lineTo((x + w - 4) * u, (y + h) * u); g.lineTo(x * u, (y + h) * u);
    g.closePath();
    g.fillStyle = fill; g.fill();
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 0.5 * u; g.stroke(); }
  }

  /**
   * v: { state, slot, names, trackName, now, results, desync, waiting, note }. Returns events for the audio:
   * 'count' (3-2-1), 'go', 'shift', 'crash'.
   */
  draw(v) {
    this.clear();
    const s = v.state, slot = v.slot, now = v.now;
    const events = [];
    if (!s) return events;
    const phase = s[H.phase], tick = s[H.tick], cars = s[H.cars], mode = s[H.mode];
    const p = this.prev;

    // transitions
    const count = phase === 0 ? Math.ceil(s[H.countdown] / 60) : 0;
    if (count !== p.count && count > 0) events.push('count');
    if (p.phase === 0 && phase === 1) { events.push('go'); this.goAt = now; }
    const gear = this.car(s, slot, C.gear), shift = this.car(s, slot, C.last_shift), flags = this.car(s, slot, C.flags);
    if (gear !== p.gear && p.gear !== 0) {
      events.push('shift');
      if (mode === 2 && shift > 0 && SHIFTS[shift]) this.pop = { text: SHIFTS[shift][0], colour: SHIFTS[shift][1], at: now };
    }
    if ((flags & FLAG.PERFECT) && !(p.flags & FLAG.PERFECT)) this.pop = { text: SHIFTS[1][0], colour: SHIFTS[1][1], at: now };
    if ((flags & FLAG.CRASHED) && !(p.flags & FLAG.CRASHED)) { events.push('crash'); this.crashAt = now; }
    Object.assign(p, { gear, shift, flags, count, phase });

    if (v.results) { this.results(v, s); return events; }
    this.progress(s, cars, slot);
    this.standings(s, cars, slot, v.names);
    this.topLeft(s, slot, phase, tick, mode);
    this.topRight(s, slot, phase, tick, mode, v.trackName);
    if (this.touch) {
      const k = 0.65, u = this.u; // move the tach cluster (centre 278,140) up the right edge, above the pads
      this.g.setTransform(k, 0, 0, k, (290 - k * 278) * u, (82 - k * 140) * u);
      this.tach(s, slot, now, mode);
      this.g.setTransform(1, 0, 0, 1, 0, 0);
    } else this.tach(s, slot, now, mode);

    // centre messages
    if (phase === 0 && count > 0) {
      const f = 1 - (s[H.countdown] % 60) / 60;
      this.text(String(count), 160, 98, 46 - f * 10, count === 1 ? GOLD : CYAN, 'center', 8, 900);
      if (mode === 2) this.text('LAUNCH IN THE GREEN: HOLD GAS, SHIFT AT THE LIGHT', 160, 116, 6, DIM, 'center');
    } else if (phase === 1 && this.goAt > 0 && now - this.goAt < 900) {
      this.text('GO!', 160, 100, 48 + (now - this.goAt) / 60, '#39ff14', 'center', 10, 900);
    }
    if (this.pop && now - this.pop.at < 1100) {
      const t = (now - this.pop.at) / 1100, k = t < 0.15 ? 0.6 + t * 2.7 : 1;
      this.g.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
      this.text(this.pop.text, 160, 62, 15 * k, this.pop.colour, 'center', 6, 900);
      this.g.globalAlpha = 1;
    }
    if (now - this.crashAt < 1200) this.text('CRASH!', 160, 80, 20, '#ff3355', 'center', 6, 900);
    if (flags & FLAG.FUEL_LIMITED) this.text('OUT OF FUEL \u00b7 20 KM/H', 160, 132, 9, PINK, 'center', 4);
    const fin = this.car(s, slot, C.finished);
    if (fin > 0 && phase !== 2) this.text('FINISHED ' + ordinal(this.car(s, slot, C.place)), 160, 84, 16, GOLD, 'center', 6, 900);
    if (v.waiting) this.text('WAITING FOR THE ROOM\u2026', 160, 150, 7, DIM, 'center');
    if (v.desync) {
      this.box(90, 22, 140, 12, 'rgba(120,0,30,0.85)', '#ff3355');
      this.text('DESYNC AT FRAME ' + v.desync.n + ': RESULTS ARE THE ROOM\u2019S', 160, 30.5, 6, INK, 'center');
    }
    if (v.note) this.text(v.note, 160, 176, 5.5, DIM, 'center');
    return events;
  }

  progress(s, cars, slot) {
    const total = Math.max(1, s[H.track_m] * 1000 * Math.max(1, s[H.laps]));
    const g = this.g, u = this.u, x0 = 110, x1 = 210, y = 6;
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(x0 * u, (y - 0.4) * u, (x1 - x0) * u, 0.8 * u);
    for (let c = cars - 1; c >= 0; c--) {
      const k = Math.min(1, Math.max(0, this.car(s, c, C.progress_mm) / total));
      const me = c === slot;
      g.fillStyle = CAR_COLOURS[this.car(s, c, C.colour) & 7];
      g.beginPath();
      g.arc((x0 + k * (x1 - x0)) * u, y * u, (me ? 2.2 : 1.4) * u, 0, Math.PI * 2);
      g.fill();
      if (me) { g.strokeStyle = INK; g.lineWidth = 0.5 * u; g.stroke(); }
    }
  }

  standings(s, cars, slot, names) {
    const order = [];
    for (let c = 0; c < cars; c++) order[this.car(s, c, C.place) - 1] = c;
    for (let i = 0; i < cars; i++) {
      const c = order[i];
      if (c === undefined) continue;
      const y = 44 + i * 7.5, me = c === slot;
      this.box(4, y - 5.5, 46, 7, me ? 'rgba(255,43,214,0.35)' : 'rgba(10,8,24,0.55)');
      this.g.fillStyle = CAR_COLOURS[this.car(s, c, C.colour) & 7];
      this.g.fillRect(7 * this.u, (y - 4.5) * this.u, 1.5 * this.u, 5 * this.u);
      this.text(String(i + 1), 11, y, 5.5, me ? GOLD : DIM, 'left');
      this.text((names?.[c] ?? 'Car ' + (c + 1)).slice(0, 10).toUpperCase(), 16, y, 5.5, me ? INK : '#c9c4ea', 'left', 0, 700);
    }
  }

  topLeft(s, slot, phase, tick, mode) {
    const place = this.car(s, slot, C.place), cars = s[H.cars];
    this.text('POS', 6, 12, 5.5, DIM);
    this.text(String(place), 6, 30, 22, INK, 'left', 4, 900);
    const w = this.g.measureText(String(place)).width / this.u;
    this.text('/' + cars, 7 + w, 30, 10, PINK, 'left', 3, 900);
    if (mode === 0) {
      const lap = Math.min(this.car(s, slot, C.lap), s[H.laps]);
      this.text('LAP', 34, 12, 5.5, DIM);
      this.text(lap + '/' + s[H.laps], 34, 22, 9, CYAN, 'left', 3, 900);
    }
  }

  topRight(s, slot, phase, tick, mode, trackName) {
    const fin = this.car(s, slot, C.finished);
    const t = fin > 0 ? fin - COUNTDOWN_TICKS : phase >= 1 ? tick - COUNTDOWN_TICKS : 0;
    this.text('TIME', 314, 12, 5.5, DIM, 'right');
    this.text(t > 0 ? fmtTime(t) : '0:00.00', 314, 23, 10, INK, 'right', 3, 900);
    if (mode === 0) {
      const best = this.car(s, slot, C.best_lap);
      this.text('BEST ' + (best > 0 ? fmtTime(best) : '--:--.--'), 314, 31, 5.5, GOLD, 'right');
    } else {
      const left = Math.max(0, s[H.track_m] - Math.floor(this.car(s, slot, C.progress_mm) / 1000));
      this.text(left + ' M TO GO', 314, 31, 5.5, GOLD, 'right');
    }
    this.text(MODES[mode] + (trackName ? ' \u00b7 ' + trackName.toUpperCase() : ''), 314, 38, 4.5, DIM, 'right', 0, 700);
  }

  tach(s, slot, now, mode) {
    const g = this.g, u = this.u, cx = 278, cy = 140, r = 33;
    const rpm = Math.max(0, Math.min(RPM.max, this.car(s, slot, C.rpm)));
    const speed = Math.max(0, Math.round(this.car(s, slot, C.speed_x10) / 10));
    const gear = this.car(s, slot, C.gear), flags = this.car(s, slot, C.flags), nitro = this.car(s, slot, C.nitro);
    const a = (v) => Math.PI * 0.75 + (v / RPM.max) * Math.PI * 1.5;
    // dial
    g.beginPath(); g.arc(cx * u, cy * u, (r + 3) * u, 0, Math.PI * 2);
    g.fillStyle = 'rgba(8,6,20,0.78)'; g.fill();
    g.shadowColor = PINK; g.shadowBlur = 4 * u; g.strokeStyle = 'rgba(255,43,214,0.8)'; g.lineWidth = 0.8 * u; g.stroke(); g.shadowBlur = 0;
    const arc = (from, to, rad, width, colour) => {
      g.beginPath(); g.arc(cx * u, cy * u, rad * u, a(from), a(to)); g.strokeStyle = colour; g.lineWidth = width * u; g.stroke();
    };
    arc(0, RPM.max, r - 1, 1, 'rgba(255,255,255,0.15)');
    arc(RPM.perfectLo, RPM.perfectHi, r - 5, 2.5, 'rgba(57,255,20,0.75)');
    arc(RPM.redline, RPM.max, r - 1, 3, '#ff3355');
    for (let v = 0; v <= RPM.max; v += 500) {
      const big = v % 1000 === 0, an = a(v), r0 = big ? r - 6 : r - 3.5;
      g.beginPath();
      g.moveTo((cx + Math.cos(an) * r0) * u, (cy + Math.sin(an) * r0) * u);
      g.lineTo((cx + Math.cos(an) * (r - 1)) * u, (cy + Math.sin(an) * (r - 1)) * u);
      g.strokeStyle = v >= RPM.redline ? '#ff3355' : INK; g.lineWidth = (big ? 0.8 : 0.4) * u; g.stroke();
      if (big) {
        g.font = 'italic 700 ' + (4.5 * u).toFixed(1) + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = v >= RPM.redline ? '#ff3355' : '#c9c4ea';
        g.fillText(String(v / 1000), (cx + Math.cos(an) * (r - 10)) * u, (cy + Math.sin(an) * (r - 10)) * u);
      }
    }
    g.textBaseline = 'alphabetic';
    // needle
    const an = a(rpm);
    g.beginPath(); g.moveTo(cx * u, cy * u); g.lineTo((cx + Math.cos(an) * (r - 3)) * u, (cy + Math.sin(an) * (r - 3)) * u);
    g.strokeStyle = rpm >= RPM.redline ? '#ff3355' : PINK; g.lineWidth = 1.2 * u; g.shadowColor = g.strokeStyle; g.shadowBlur = 4 * u; g.stroke(); g.shadowBlur = 0;
    g.beginPath(); g.arc(cx * u, cy * u, 7.5 * u, 0, Math.PI * 2); g.fillStyle = '#100c24'; g.fill();
    g.strokeStyle = CYAN; g.lineWidth = 0.5 * u; g.stroke();
    this.text(gear > 0 ? String(gear) : 'N', cx, cy + 4, 12, GOLD, 'center', 3, 900);
    this.text(String(speed), cx, cy + 22, 11, INK, 'center', 3, 900);
    this.text('KM/H', cx, cy + 28, 4, DIM, 'center');
    // shift light
    const flash = rpm >= RPM.redline && Math.floor(now / 80) % 2 === 0;
    for (let i = 0; i < LEDS.length; i++) {
      const [at, colour] = LEDS[i], on = rpm >= RPM.redline ? flash : rpm >= at;
      g.beginPath(); g.arc((cx - 12 + i * 6) * u, (cy - r - 7) * u, 2 * u, 0, Math.PI * 2);
      g.fillStyle = on ? (rpm >= RPM.redline ? '#ff3355' : colour) : 'rgba(255,255,255,0.12)';
      if (on) { g.shadowColor = g.fillStyle; g.shadowBlur = 5 * u; }
      g.fill(); g.shadowBlur = 0;
    }
    if (rpm >= RPM.perfectLo && rpm <= RPM.perfectHi && (mode === 2 || gear < 6)) this.text('SHIFT', cx, cy - r - 11, 5, '#39ff14', 'center', 4);
    // nitrous bar
    const bx = 236, by = 112, bh = 60, k = Math.max(0, Math.min(1000, nitro)) / 1000, on = flags & FLAG.NITRO;
    g.fillStyle = 'rgba(8,6,20,0.7)'; g.fillRect((bx - 1) * u, (by - 1) * u, 7 * u, (bh + 2) * u);
    const grad = g.createLinearGradient(0, (by + bh) * u, 0, by * u);
    grad.addColorStop(0, '#2a7bff'); grad.addColorStop(1, CYAN);
    g.fillStyle = grad;
    if (on) { g.shadowColor = CYAN; g.shadowBlur = 8 * u; }
    g.fillRect(bx * u, (by + bh * (1 - k)) * u, 5 * u, bh * k * u);
    g.shadowBlur = 0;
    g.strokeStyle = on ? INK : 'rgba(0,229,255,0.6)'; g.lineWidth = 0.4 * u; g.strokeRect((bx - 1) * u, (by - 1) * u, 7 * u, (bh + 2) * u);
    this.text('N2O', bx + 2.5, by - 3, 4.5, on ? INK : CYAN, 'center', on ? 4 : 0);
  }

  results(v, s) {
    const g = this.g, u = this.u;
    g.fillStyle = 'rgba(5,4,12,0.72)'; g.fillRect(0, 0, this.cv.width, this.cv.height);
    const rows = v.results, x = 60, w = 200, top = 22;
    this.text('RESULTS', 160, top + 6, 14, PINK, 'center', 6, 900);
    this.text((MODES[s[H.mode]] ?? '') + (v.trackName ? ' \u00b7 ' + v.trackName.toUpperCase() : ''), 160, top + 14, 5.5, DIM, 'center');
    const hy = top + 24;
    this.text('POS', x + 4, hy, 4.5, DIM); this.text('DRIVER', x + 24, hy, 4.5, DIM);
    const laps = s[H.mode] === 0;
    this.text('TIME', x + 150, hy, 4.5, DIM, 'right');
    if (laps) this.text('BEST LAP', x + w - 4, hy, 4.5, DIM, 'right');
    for (let i = 0; i < rows.length && i < 8; i++) {
      const r = rows[i], y = hy + 9 + i * 9, me = r.slot === v.slot;
      this.box(x, y - 6.5, w, 8, me ? 'rgba(255,43,214,0.32)' : 'rgba(14,10,32,0.85)', me ? PINK : null);
      const colour = r.slot >= 0 && r.slot < s[H.cars] ? CAR_COLOURS[this.car(s, r.slot, C.colour) & 7] : INK;
      g.fillStyle = colour; g.fillRect((x + 19) * u, (y - 5.5) * u, 1.5 * u, 6 * u);
      this.text(ordinal(r.place), x + 4, y, 6, i === 0 ? GOLD : INK, 'left', 0, 900);
      this.text(String(r.name).slice(0, 16).toUpperCase(), x + 24, y, 6, INK, 'left', 0, 700);
      this.text(r.ticks > 0 ? fmtTime(r.ticks) : 'DNF', x + 150, y, 6, r.ticks > 0 ? INK : DIM, 'right');
      const best = r.slot >= 0 && r.slot < s[H.cars] ? this.car(s, r.slot, C.best_lap) : 0;
      if (laps) this.text(best > 0 ? fmtTime(best) : '--', x + w - 4, y, 6, DIM, 'right');
    }
  }
}
