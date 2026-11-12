// What the race checks of the free-roam hub (roam/results.js, hub) and of the Online mode share (port of nfsu2-anticheat,
// web/server-rs/crates/anticheat/src/lib.rs): the limits no honest race passes, the rule for a car's jump, and a
// track's quickest racers (Quickest), which a win far quicker than theirs is measured against.

import { fmin, totalCmp } from '../util/f64.js';

/** no car of the game averages this over a race (m/s: 350 km/h) */
export const RACE_MPS = 350.0 / 3.6;

/** a top speed no car of the game makes, however tuned (km/h) */
export const CAR_KMH = 420.0;

/**
 * A winner in under THIRD_SHARE of the third quickest other racer's time of its track (Quickest.third), once the track
 * had QUICK_WINS clean races, is a [cheat] line.  TOP_KEPT: the quickest racers kept of each track.
 */
export const THIRD_SHARE = 0.7;
export const QUICK_WINS = 10;
export const TOP_KEPT = 4;

/** a car's jump at once (m) that no lag makes, and how many of the other racers' games must have had it so */
export const JUMP_M = 150.0;
export const JUMP_SEEN = 2;

/** a drift race's mode: won by points, so left out of the time rules */
export const MODE_DRIFT = 3;

/**
 * whether the other racers' games had a car jump: far of them had it JUMP_M or more, JUMP_SEEN at least, or the one
 * when it is the only other one (onlyOther)
 * @param {number} far
 * @param {boolean} onlyOther
 */
export function jumpSeen(far, onlyOther) {
  return far >= JUMP_SEEN || (onlyOther && far === 1);
}

/**
 * A track's clean races: how many (wins, which the check counts as it sees fit), and its quickest racers, each once by
 * name with its best time, quickest first, TOP_KEPT at most
 */
export class Quickest {
  constructor() {
    /** @type {number} */
    this.wins = 0;
    /** @type {[string, number][]} */
    this._top = [];
  }

  /**
   * a racer's time (its best is kept); wins is left as it is
   * @param {string} who
   * @param {number} time
   */
  add(who, time) {
    const x = this._top.find((e) => e[0] === who);
    if (x) x[1] = fmin(x[1], time);
    else this._top.push([who, time]);
    // (stable, as Rust's sort_by)
    this._top.sort((a, b) => totalCmp(a[1], b[1]));
    if (this._top.length > TOP_KEPT) this._top.length = TOP_KEPT;
  }

  /** the racers kept, quickest first (a copy) @returns {[string, number][]} */
  top() {
    return this._top.map((e) => [e[0], e[1]]);
  }

  /** the number of racers kept */
  get size() {
    return this._top.length;
  }

  /**
   * the third quickest racer's time but who's, once the track had QUICK_WINS clean races
   * @param {string} who
   * @returns {number|null}
   */
  third(who) {
    if (this.wins < QUICK_WINS) return null;
    const others = this._top.filter((e) => e[0] !== who);
    return others.length > 2 ? others[2][1] : null;
  }

  /** a copy (Rust's derive(Clone)) */
  clone() {
    const q = new Quickest();
    q.wins = this.wins;
    q._top = this.top();
    return q;
  }
}
