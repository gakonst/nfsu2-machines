// The cheat watch (port of web/server-rs/crates/roam/src/watch.rs, bit for bit in its arithmetic): how a player's car
// moves, by its SNAPs to the hub (two a second, each with where its car is and the time on the player's own clock), and
// what of it no car of the game does, as [cheat] lines.  See watch.rs for the rules and their reasons:
//
// - a teleport: the car went farther than DRIVE_MPS takes it, by JUMP_M or more (what went past it adds up, and leaks
//   away at LEAK_MPS); a jump that lands near an event's or a shop's trigger is the World Map's (jumps.js) and is left
//   be; a status other than free roam starts the watch afresh (reset)
// - too fast: DRIVE_MPS or more between SNAPs for FAST_MS on end
// - a fast clock: the player's clock CLOCK_RATE times as fast as the server's, over two counts of CLOCK_MS on end
//
// Times are the hub's clock (ms, passed in); a SNAP's own time is the player's clock (µs, a wrapping u32) and its epoch
// (a wrapping u8).  No hidden time or randomness.

import { vipStr } from '../util/vip.js';
import { fixed } from '../util/rustfmt.js';
import { fmax, fmin } from '../util/f64.js';
import { EVENTS, SHOPS } from './jumps.js';

/** what a car of the game drives at most, with room to spare (m/s: 450 km/h) */
export const DRIVE_MPS = 125.0;
/** a teleport goes this much farther than DRIVE_MPS takes a car (m); what went past leaks LEAK_MPS a second (m/s) */
export const JUMP_M = 300.0;
const LEAK_MPS = 50.0;
/** a teleport that lands this near an event's trigger, or a shop's, is the World Map's jump (m) */
const EVENT_JUMP_M = 25.0;
const SHOP_JUMP_M = 45.0;
/** a run over DRIVE_MPS this long (ms) is told */
const FAST_MS = 2000.0;
/** the player's clock this many times as fast as the server's, over CLOCK_MS at least (ms), is told */
const CLOCK_RATE = 1.3;
const CLOCK_MS = 30_000.0;
/** the other players this near where the car came to (m) are next to it */
export const NEAR_M = 40.0;
/** the lines a player gets at once, and how long one takes to come back (ms) */
const LINES = 5.0;
const LINE_BACK_MS = 120_000.0;
/** what no line told is summed up this often (ms) */
const SUM_MS = 600_000.0;

/**
 * What a SNAP showed:
 * - {kind: 'jump', from, to, d, ms, over}: a teleport, from where to where (m apart), in how long (ms), and how far past
 *   what a car drives in that time
 * - {kind: 'fast', from, to, mps, ms}: a run over DRIVE_MPS, its speed (m/s, on average), how long so far (ms)
 * - {kind: 'clock', rate, ms}: the player's clock ran rate times as fast as the server's over ms
 * @typedef {{kind: 'jump', from: number[], to: number[], d: number, ms: number, over: number}
 *   | {kind: 'fast', from: number[], to: number[], mps: number, ms: number}
 *   | {kind: 'clock', rate: number, ms: number}} Seen
 */

/**
 * what was near where a car came to: the other players ([how far, name, address]; the nearest few), how many in all,
 * and the host of a race lobby that starts there
 * @typedef {{players: [number, string, number][], all: number, lobby: string|null}} Near
 */

const copy3 = (p) => [p[0], p[1], p[2]];

/** One player's watch */
export class Watch {
  /** @param {number} now */
  constructor(now) {
    /** the last SNAP: {p, at, tUs, clock} or null */
    this.last = null;
    /** how far the car went past what DRIVE_MPS takes it (m), since where and for how long (ms) */
    this.over = 0.0;
    this.overFrom = [0.0, 0.0, 0.0];
    this.overMs = 0.0;
    /** the run over DRIVE_MPS going on: since where, how long (ms), how far (m), and whether it was told */
    this.runFrom = [0.0, 0.0, 0.0];
    this.runMs = 0.0;
    this.runM = 0.0;
    this.runTold = false;
    /** the clock's counts (watch.rs) */
    this.ownMs = 0.0;
    this.countAt = 0.0;
    this.countLow = 0.0;
    this.low = 0.0;
    /** the last count's [rate, ms, told] when it was fast, or null */
    this.clockPrev = null;
    /** since it came: teleports (and of them next to another player), runs told, their time (ms), top speed (m/s),
     * the time its clock ran fast (ms) and how fast at most */
    this.jumps = 0;
    this.near = 0;
    this.runs = 0;
    this.runAllMs = 0.0;
    this.top = 0.0;
    this.clockMs = 0.0;
    this.clockMax = 0.0;
    /** the lines it may still get, counted back from linesAt; what no line told since the last summary, when that was;
     * when it came */
    this.lines = LINES;
    this.linesAt = now;
    this.quiet = 0;
    this.summedAt = now;
    this.came = now;
  }

  /** out of free roam (a status other than 2 and 5): the next SNAP starts afresh */
  reset() {
    this.last = null;
    this.clockPrev = null;
    this.over = 0.0;
    this._endRun();
  }

  _endRun() {
    this.runMs = 0.0;
    this.runM = 0.0;
    this.runTold = false;
  }

  /**
   * A SNAP in free roam (status 2 or 5): what it shows of the car's way since the last one (a teleport or a fast run),
   * and of the player's clock; nothing of one older than the last.  beside: its car is beside its browser's first
   * player's, where the game puts it (no teleport, no run; the clock counts as ever)
   * @param {number} now
   * @param {number[]} p [x, y, z]
   * @param {number} tUs u32
   * @param {number} clock u8
   * @param {boolean} beside
   * @returns {[Seen|null, Seen|null]}
   */
  snap(now, p, tUs, clock, beside) {
    tUs >>>= 0;
    clock &= 0xff;
    const fix = { p: copy3(p), at: now, tUs, clock };
    const last = this.last;
    if (last === null) {
      this.last = fix;
      this._countFrom(now);
      return [null, null];
    }
    // (epochs count on, mod 256, and a time on within one: both a 32-bit difference's sign)
    const same = clock === last.clock;
    // (u32 wrapping_sub as i32, then as f64; u8 wrapping_sub as i8)
    const own = ((tUs - last.tUs) | 0) / 1000.0;
    if ((((clock - last.clock) << 24) >> 24) < 0 || (same && own < 0.0)) return [null, null];
    this.last = fix;
    const recv = now - last.at;
    if (same) this.ownMs += own;
    else this._countFrom(now);
    // (1 ms at least)
    const ms = fmax(fmax(recv, same ? own : 0.0), 1.0);
    const d = distance(last.p, fix.p);
    const past = d - (DRIVE_MPS * ms) / 1000.0;
    if (beside && past > 0.0) {
      this.over = fmax(this.over - (LEAK_MPS * ms) / 1000.0, 0.0);
      this.overMs += ms;
      this._endRun();
      return [null, same ? this._clock(now) : null];
    }
    const gain = past - (LEAK_MPS * ms) / 1000.0;
    if (this.over === 0.0 && gain > 0.0) {
      this.overFrom = copy3(last.p);
      this.overMs = 0.0;
    }
    this.over = fmax(this.over + gain, 0.0);
    this.overMs += ms;
    /** @type {Seen|null} */
    let way = null;
    if (this.over >= JUMP_M) {
      const over = this.over;
      this.over = 0.0;
      this._endRun();
      // (the World Map's jump: neither a line nor a count)
      if (!mapJump(fix.p)) {
        this.jumps = (this.jumps + 1) >>> 0;
        way = { kind: 'jump', from: copy3(this.overFrom), to: copy3(fix.p), d: distance(this.overFrom, fix.p), ms: this.overMs, over };
      }
    } else if (past >= 0.0) {
      if (this.runMs === 0.0) this.runFrom = copy3(last.p);
      this.runMs += ms;
      this.runM += d;
      const mps = (this.runM * 1000.0) / this.runMs;
      if (this.runMs >= FAST_MS) {
        // (the whole run once it is one, then each SNAP of it)
        this.runAllMs += this.runTold ? ms : this.runMs;
        this.top = fmax(this.top, mps);
        const told = this.runTold;
        this.runTold = true;
        if (!told) {
          this.runs = (this.runs + 1) >>> 0;
          way = { kind: 'fast', from: copy3(this.runFrom), to: copy3(fix.p), mps, ms: this.runMs };
        }
      }
    } else {
      this._endRun();
    }
    return [way, same ? this._clock(now) : null];
  }

  /** the clock's counts start again, from the first SNAP of a clock epoch (at now) */
  _countFrom(now) {
    this.ownMs = 0.0;
    this.countAt = now;
    this.countLow = now;
    this.low = now;
    this.clockPrev = null;
  }

  /**
   * The clock's count, at a SNAP (at now) of the same epoch as the last (watch.rs Watch::clock)
   * @returns {Seen|null}
   */
  _clock(now) {
    const late = now - this.ownMs;
    this.countLow = fmin(this.countLow, late);
    const over = now - this.countAt;
    if (over < CLOCK_MS) return null;
    const rate = 1.0 + fmax(this.low - this.countLow, 0.0) / over;
    this.low = fmin(this.low, this.countLow);
    this.countAt = now;
    this.countLow = late;
    const prev = this.clockPrev;
    this.clockPrev = rate >= CLOCK_RATE ? [rate, over, false] : null;
    if (prev === null || !(rate >= CLOCK_RATE)) return null;
    const [was, wasMs, told] = prev;
    // (the first count of the run too, the first time)
    const r = fmin(rate, was);
    const ms = told ? over : wasMs + over;
    this.clockPrev = [r, over, true];
    this.clockMs += ms;
    this.clockMax = fmax(this.clockMax, r);
    return { kind: 'clock', rate: r, ms };
  }

  /** a teleport of its landed next to another player */
  landedNear() {
    this.near = (this.near + 1) >>> 0;
  }

  /**
   * May a line tell what it did now?  If not, it is counted for the next summary.  true: yes, and it is the last line
   * for a while; false: yes; null: no
   * @param {number} now
   * @returns {boolean|null}
   */
  line(now) {
    this.lines = fmin(this.lines + (now - this.linesAt) / LINE_BACK_MS, LINES);
    this.linesAt = now;
    if (this.lines >= 1.0) {
      this.lines -= 1.0;
      return this.lines < 1.0;
    }
    this.quiet = (this.quiet + 1) >>> 0;
    return null;
  }

  /**
   * what it did since it came, as a line: every SUM_MS while something was not told, and (left) when it leaves after
   * anything at all
   * @param {number} vip
   * @param {string} name
   * @param {number} now
   * @param {boolean} left
   * @returns {string|null}
   */
  summary(vip, name, now, left) {
    const due = left ? this.jumps + this.runs > 0 || this.clockMs > 0.0 : this.quiet > 0 && now - this.summedAt >= SUM_MS;
    if (!due) return null;
    this.quiet = 0;
    this.summedAt = now;
    const parts = [];
    if (this.jumps > 0) {
      const near = this.near > 0 ? ' (' + this.near + ' next to other players)' : '';
      parts.push(this.jumps + ' teleport' + plural(this.jumps) + near);
    }
    if (this.runs > 0) {
      parts.push(this.runs + ' run' + plural(this.runs) + ' over ' + kmh(DRIVE_MPS) + ' for ' + span(this.runAllMs) + ' (at most ' + kmh(this.top) + ')');
    }
    if (this.clockMs > 0.0) {
      parts.push('its clock fast for ' + span(this.clockMs) + ' (up to ' + fixed(this.clockMax, 1) + " times the server's)");
    }
    return '[cheat] ' + vipStr(vip) + ' "' + name + '", ' + span(now - this.came) + ' in free roam (' + (left ? 'left' : 'so far') + '): ' + parts.join(', ');
  }
}

/**
 * a line of what a player's SNAP showed (jumps: its teleports so far); last: no more lines for a while
 * @param {number} vip
 * @param {string} name
 * @param {Seen} seen
 * @param {Near} near
 * @param {number} jumps
 * @param {boolean} last
 * @returns {string}
 */
export function line(vip, name, seen, near, jumps, last) {
  let what;
  switch (seen.kind) {
    case 'jump':
      what = 'teleport ' + jumps + ': ' + metres(seen.d) + ' in ' + fixed(seen.ms / 1000.0, 1) + ' s, ' + metres(seen.over) + ' more than a car drives, ' + place(seen.from) + ' to ' + place(seen.to);
      break;
    case 'fast':
      what = kmh(seen.mps) + ' for ' + fixed(seen.ms / 1000.0, 1) + ' s, ' + place(seen.from) + ' to ' + place(seen.to);
      break;
    case 'clock':
      what = "its game's clock ran " + fixed(seen.rate, 1) + " times as fast as the server's for " + span(seen.ms) + ' (a speed hack)';
      break;
    default:
      throw new TypeError('a Seen of kind ' + /** @type {any} */ (seen).kind);
  }
  let s = '[cheat] ' + vipStr(vip) + ' "' + name + '": ' + what;
  if (near.players.length > 0) {
    const names = near.players.map(([d, n, v]) => '"' + n + '" ' + vipStr(v) + ' (' + metres(d) + ')');
    const more = near.all - near.players.length;
    s += '; next to ' + names.join(', ') + (more > 0 ? ' and ' + more + ' more' : '');
  }
  if (near.lobby !== null && near.lobby !== undefined) s += '; at the start of "' + near.lobby + "\"'s race lobby";
  if (last) s += '; more are counted (summed up every 10 min and when it leaves)';
  return s;
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
export function distance(a, b) {
  const x = a[0] - b[0];
  const y = a[1] - b[1];
  const z = a[2] - b[2];
  return Math.sqrt(x * x + y * y + z * z);
}

/** a car there came by the World Map's jump: near an event's or a shop's trigger (jumps.js) */
function mapJump(p) {
  const near = (t, m) => (p[0] - t[0]) * (p[0] - t[0]) + (p[1] - t[1]) * (p[1] - t[1]) < m * m;
  return EVENTS.some((t) => near(t, EVENT_JUMP_M)) || SHOPS.some((t) => near(t, SHOP_JUMP_M));
}

function plural(n) {
  return n === 1 ? '' : 's';
}

function kmh(mps) {
  return fixed(mps * 3.6, 0) + ' km/h';
}

function metres(m) {
  return m < 1000.0 ? fixed(m, 0) + ' m' : fixed(m / 1000.0, 1) + ' km';
}

/** a place in whole metres, (x, y, height) */
function place(p) {
  return '(' + fixed(p[0], 0) + ', ' + fixed(p[1], 0) + ', ' + fixed(p[2], 0) + ')';
}

function span(ms) {
  const s = ms / 1000.0;
  if (s < 90.0) return fixed(s, 0) + ' s';
  if (s < 5400.0) return fixed(s / 60.0, 0) + ' min';
  return fixed(s / 3600.0, 1) + ' h';
}
