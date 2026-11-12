// The races' results as the players' games showed them (port of web/server-rs/crates/roam/src/results.rs; see it for
// the rules and their reasons), for a race won by cheating: a teleport to the finish, a speed hack, a race the game ended
// at once.  The hub takes a report only from a player of the race's lobby; it keeps a race's reports until every
// racer's came, or RESULTS_WAIT_MS after the first, then judges it once: a [race] line of its result (resultLine), a
// [cheat] line of a winner who cheated (line) and of a car that jumped (jumpLine).
//
// A RaceRes is a plain object {lobby, race, mode, laps, heat, heats, n, rows}: rows exactly LOBBY_PLAYERS of
// {id, flags, time, done, dist, jump}, the first n used.  Times are passed in (ms); no hidden time or randomness.

import { JUMP_M, MODE_DRIFT, QUICK_WINS, Quickest, RACE_MPS, THIRD_SHARE, jumpSeen } from '../anticheat/anticheat.js';
import { display, fixed, fixedPad, hex8 } from '../util/rustfmt.js';
import { fmax, fmin, totalCmp } from '../util/f64.js';

/** a row's flags (roam_core.h RC_RS_FINISHED, RC_RS_OURS), and the most players a lobby takes (wire.rs) */
export const RS_FINISHED = 0x01;
export const RS_OURS = 0x02;
export const LOBBY_PLAYERS = 6;

/** a race's reports are judged once every racer's came, or this long after the first (ms) */
export const RESULTS_WAIT_MS = 90_000.0;
/** the races kept at once */
const RACES_KEPT = 4096;
/** a winner who came less than this share of the way by every report finished without driving it */
const DROVE_MIN = 0.5;
/** a winner in under this share of the race's quickest clean win; the clean wins kept; the clients a clean win needs */
const QUICK_SHARE = 0.5;
const BEST_KEPT = 4096;
const BEST_SEEN = 2;
/** a race ends 30 s after its first finished: the others' rows are that much later, this much at least (s) */
const GAME_END_S = 25.0;
/** a winner who drove less than this share of the way: the line says how much it drove */
const DROVE_SHORT = 0.9;

/**
 * @typedef {{id: number, flags: number, time: number, done: number, dist: number, jump: number}} ResRow
 * @typedef {{lobby: number, race: number, mode: number, laps: number, heat: number, heats: number, n: number,
 *   rows: ResRow[]}} RaceRes
 * @typedef {{kind: 'first'|'finished'|'out', t: number|null}} OwnGame  (t null for 'out')
 * @typedef {{lobby: number, race: number, mode: number, laps: number, heat: number, heats: number, winner: number,
 *   time: number, length: number|null, avg: number|null, next: [number, number]|null, drove: number|null,
 *   quickest: number|null, third: [number, number]|null, own: OwnGame|null, seen: number, reports: number,
 *   names: Map<number, string>}} Verdict
 * @typedef {{id: number, seen: number[], others: number, place: number|null}} Jump
 * @typedef {{lobby: number, race: number, mode: number, laps: number, heat: number, heats: number,
 *   order: [number, number|null][], silent: number[], reports: number, racers: number, names: Map<number, string>,
 *   jumps: Jump[]}} Outcome
 */

const used = (r) => r.rows.slice(0, r.n);

/** a copy of a report (RaceRes is Copy in Rust: the caller's object may change after) */
function copyRes(r) {
  if (!(Number.isInteger(r.n) && r.n >= 0 && r.n <= LOBBY_PLAYERS)) throw new RangeError('RaceRes n ' + r.n);
  return { lobby: r.lobby, race: r.race, mode: r.mode, laps: r.laps, heat: r.heat, heats: r.heats, n: r.n, rows: r.rows.map((x) => ({ ...x })) };
}

/** A race's clean wins: how many and the quickest winners (win), and the quickest of them */
class Best {
  constructor() {
    this.win = new Quickest();
    this.quickest = 0.0;
  }
  /** a clean win: it counts, its winner's time is one of the quickest */
  add(who, time) {
    this.quickest = this.win.wins === 0 ? time : fmin(this.quickest, time);
    this.win.wins = (this.win.wins + 1) >>> 0;
    this.win.add(who, time);
  }
  /** the quickest clean win, once there were QUICK_WINS of two winners at least */
  quick() {
    return this.win.wins >= QUICK_WINS && this.win.size >= 2 ? this.quickest : null;
  }
}

/** Rust's str::split_once(" \""): the part after the first, or null */
function afterQuote(w) {
  const k = w.indexOf(' "');
  return k < 0 ? null : w.slice(k + 2);
}

/** trim_end_matches('"') */
const trimQuotes = (s) => s.replace(/"+$/, '');

/** a racer as the clean wins know it: its name (lower case) from names (10.77.3.41 "Bob"), else its id */
function racer(names, id) {
  const w = names.get(id);
  const n = w === undefined ? null : afterQuote(w);
  return n === null ? hex8(id) : trimQuotes(n).toLowerCase();
}

/** a race's mode as a word (roam_core.h rc_racerep) */
export function modeName(mode) {
  const MODES = ['circuit', 'sprint', 'drag', 'drift', 'URL'];
  return mode >= 0 && mode < MODES.length ? MODES[mode] : mode === 10 ? 'Street X' : 'race';
}

/** a time as m:ss.s */
function clock(s) {
  return display(Math.floor(s / 60.0)) + ':' + fixedPad(s % 60.0, 4, 1);
}

/** a race's kind as its lines say it: "sprint, 2 laps", "URL, 3 laps, heat 2 of 3" */
function kind(mode, laps, heat, heats) {
  let s = modeName(mode) + ', ' + laps + ' lap' + (laps === 1 ? '' : 's');
  if (heats > 0) s += ', heat ' + heat + ' of ' + heats;
  return s;
}

/**
 * A race's result line (Outcome); who as for line.  A drift race is won by points: its finishers in no order.
 * @param {Outcome} o
 * @param {(id: number) => string} who
 */
export function resultLine(o, who) {
  const name = (id) => {
    const w = who(id);
    const n = afterQuote(w);
    return n === null ? w : trimQuotes(n);
  };
  const drift = o.mode === MODE_DRIFT;
  let place = 0;
  const rows = o.order.map(([id, t]) => {
    if (t !== null && !drift) {
      place += 1;
      return place + ' ' + name(id) + ' ' + clock(t);
    }
    if (t !== null) return 'finished ' + name(id);
    return 'DNF ' + name(id);
  });
  let s = '[race] lobby ' + hex8(o.lobby) + ', race ' + hex8(o.race) + ' (' + kind(o.mode, o.laps, o.heat, o.heats) + '): the result by ' + o.reports + ' of ' + o.racers + " racers' games" + (drift ? ' (won by points: no order)' : '') + ': ' + rows.join(', ');
  if (o.silent.length > 0) s += '; no report from its own game: ' + o.silent.map((id) => who(id)).join(', ');
  return s;
}

/** One race's result by its reports (Outcome, its names left to the caller) */
function outcome(race) {
  if (race.reports.length === 0) return null;
  const first = race.reports[0][1];
  const ids = [];
  for (const [, r] of race.reports) for (const x of used(r)) if (x.id !== 0 && !ids.includes(x.id)) ids.push(x.id);
  const time = (id) => {
    const t = [];
    for (const [, r] of race.reports) for (const x of used(r)) if (x.id === id && (x.flags & RS_FINISHED) !== 0 && x.time > 0.0) t.push(x.time);
    t.sort(totalCmp);
    const k = Math.floor(Math.max(t.length - 1, 0) / 2);
    return k < t.length ? t[k] : null;
  };
  /** @type {[number, number|null][]} */
  const order = ids.map((id) => [id, time(id)]);
  // (a stable sort: the ones who did not finish stay in the reports' order, after the finishers)
  order.sort((a, b) => {
    if (a[1] !== null && b[1] !== null) return totalCmp(a[1], b[1]);
    if (a[1] !== null) return -1;
    if (b[1] !== null) return 1;
    return 0;
  });
  const silent = ids.filter((id) => !race.reports.some(([by]) => by === id));
  const jumps = jumped(race, order);
  return {
    lobby: first.lobby,
    race: first.race,
    mode: first.mode,
    laps: first.laps,
    heat: first.heat,
    heats: first.heats,
    order,
    silent,
    reports: race.reports.length,
    racers: race.reports.reduce((m, [, r]) => Math.max(m, r.n), 0),
    names: new Map(),
    jumps,
  };
}

/** The racers whose car jumped JUMP_M or more at once by JUMP_SEEN of the other reports, or by the only other one */
function jumped(race, order) {
  const out = [];
  order.forEach(([id, t], k) => {
    const others = race.reports.filter(([by]) => by !== id).map(([, r]) => r);
    const seen = [];
    for (const r of others) {
      const x = used(r).find((x) => x.id === id);
      if (x !== undefined && x.jump >= JUMP_M) seen.push(x.jump);
    }
    seen.sort((a, b) => totalCmp(b, a));
    if (jumpSeen(seen.length, others.length === 1)) out.push({ id, seen, others: others.length, place: t !== null ? k + 1 : null });
  });
  return out;
}

/**
 * A jump's [cheat] line (Jump); who as for line
 * @param {Outcome} o
 * @param {Jump} j
 * @param {(id: number) => string} who
 */
export function jumpLine(o, j, who) {
  const each = j.seen.map((m) => fixed(m, 0));
  let end;
  if (j.place === 1 && o.mode !== MODE_DRIFT) end = 'it won';
  else if (j.place !== null && o.mode !== MODE_DRIFT) end = 'it came ' + j.place;
  else if (j.place !== null) end = 'it finished';
  else end = 'it did not finish';
  return '[cheat] ' + who(j.id) + ': its car jumped ' + fixed(j.seen.length > 0 ? j.seen[0] : 0.0, 0) + ' m at once in the race of lobby ' + hex8(o.lobby) + ' (race ' + hex8(o.race) + ': ' + kind(o.mode, o.laps, o.heat, o.heats) + '), as ' + j.seen.length + ' of ' + j.others + " other players' games had it (the largest each: " + each.join(', ') + " m; honest races' largest are under 50 m); " + end;
}

/**
 * A verdict's [cheat] line; who: a player's address and name by its id (10.77.3.41 "Bob")
 * @param {Verdict} v
 * @param {(id: number) => string} who
 */
export function line(v, who) {
  let s = '[cheat] ' + who(v.winner) + ': won the race of lobby ' + hex8(v.lobby) + ' (race ' + hex8(v.race) + ': ' + kind(v.mode, v.laps, v.heat, v.heats) + ') in ' + clock(v.time);
  if (v.length !== null && v.avg !== null) {
    s += ', ' + fixed(v.avg * 3.6, 0) + " km/h on average over the race's " + fixed(v.length / 1000.0, 1) + ' km (as another finisher drove it)' + (v.avg >= RACE_MPS ? ', which no car does' : '');
  }
  if (v.quickest !== null) s += ', under ' + fixed(QUICK_SHARE * 100.0, 0) + " % of the race's quickest clean win (" + clock(v.quickest) + ')';
  if (v.third !== null) {
    const [t, wins] = v.third;
    s += ', under ' + fixed(THIRD_SHARE * 100.0, 0) + " % of the third quickest other winner's time of the race's " + wins + ' clean wins (' + clock(t) + ')';
  }
  if (v.drove !== null) s += ', having driven ' + fixed(v.drove * 100.0, 1) + ' % of the way';
  if (v.next !== null) s += "; the next finisher's " + clock(v.next[1]) + ', ' + who(v.next[0]);
  else s += '; nobody else finished (the race ends 30 s after the first)';
  s += ': as ' + v.seen + ' of ' + v.reports + " players' games saw it";
  if (v.own === null) s += '; its own game sent no report';
  else if (v.own.kind === 'first') {
    if (Math.abs(v.own.t - v.time) >= 0.5) s += '; its own game: first in ' + clock(v.own.t);
  } else if (v.own.kind === 'finished') s += '; its own game: not first, finished in ' + clock(v.own.t);
  else s += '; its own game: did not finish';
  return s;
}

/** a report's winner: its quickest finisher, or (none finished) the game's first row when every other one ended with
 * the race, GAME_END_S or more after it */
function winner(r) {
  const rows = used(r);
  let quickest = null;
  for (const w of rows) {
    // (min_by: the first of equal ones)
    if ((w.flags & RS_FINISHED) !== 0 && w.time > 0.0 && (quickest === null || totalCmp(w.time, quickest.time) < 0)) quickest = w;
  }
  if (quickest !== null) return quickest;
  if (rows.length === 0) return null;
  const [first, ...rest] = rows;
  return first.time > 0.0 && rest.length > 0 && rest.every((x) => x.time >= first.time + GAME_END_S) ? first : null;
}

/** a report's whole way (laps): as far as its finishers came (whole laps), or with none the race's laps */
function wholeWay(r) {
  let far = 0.0;
  for (const x of used(r)) if ((x.flags & RS_FINISHED) !== 0) far = fmax(far, Math.floor(x.done));
  return far >= 1.0 ? far : fmax(r.laps, 1.0);
}

/** The races' reports, until each is judged; the clean wins of each race (its name hash, laps and heat) so far */
export class Results {
  constructor() {
    /** keyed "lobby,heat"; Rust's HashMap, here in insertion order */
    this.races = new Map();
    /** keyed "race,laps,heat" @type {Map<string, Best>} */
    this.best = new Map();
  }

  /**
   * a player's report of a race (one a reporter: a second one counts for nothing), from its game's client (an opaque
   * id of its address), and who its racers by id as the hub knows them now; false when there is no room for a race more
   * @param {number} now
   * @param {number} reporter
   * @param {string} client
   * @param {RaceRes} r
   * @param {(id: number) => string|null} who
   * @returns {boolean}
   */
  add(now, reporter, client, r, who) {
    const key = r.lobby + ',' + r.heat;
    if (!this.races.has(key) && this.races.size >= RACES_KEPT) return false;
    let race = this.races.get(key);
    if (race === undefined) {
      race = { at: now, reports: [], clients: [], names: new Map() };
      this.races.set(key, race);
    }
    if (!race.reports.some(([id]) => id === reporter) && race.reports.length < LOBBY_PLAYERS) {
      const res = copyRes(r);
      race.reports.push([reporter, res]);
      race.clients.push(client);
      for (const x of used(res)) {
        if (x.id !== 0 && !race.names.has(x.id)) {
          const w = who(x.id);
          if (w !== null && w !== undefined) race.names.set(x.id, w);
        }
      }
    }
    return true;
  }

  /** the cheats' verdicts of judged (a test helper) @returns {Verdict[]} */
  due(now) {
    return this.judged(now).map(([, v]) => v).filter((v) => v !== null);
  }

  /**
   * the races due (every racer's report came, or RESULTS_WAIT_MS went by), judged and forgotten: each one's result, and
   * a cheat's verdict when its winner cheated.  A clean win by the reports of two clients or more, with another
   * finisher, may be its race's quickest.
   *
   * (Rust iterates its HashMap of races in no set order; here they go in the order they came.  Two races due at once
   * come out in another order, and when both are clean wins of one race (track) the second may be judged by the
   * first's.)
   * @param {number} now
   * @returns {[Outcome, Verdict|null][]}
   */
  judged(now) {
    const due = [];
    for (const [k, r] of this.races) {
      const racers = r.reports.reduce((m, [, x]) => Math.max(m, x.n), 0);
      if (now - r.at >= RESULTS_WAIT_MS || r.reports.length >= racers) due.push(k);
    }
    const out = [];
    for (const l of due) {
      const race = this.races.get(l);
      if (race === undefined) continue;
      this.races.delete(l);
      const o = outcome(race);
      if (o === null) continue;
      let cheat = null;
      const j = judge(race.reports, this.best, race.names);
      if (j !== null) {
        const [v, is] = j;
        const k = v.race + ',' + v.laps + ',' + v.heat;
        if (is) {
          cheat = { ...v, names: new Map(race.names) };
        } else if (v.next !== null && clientsFirst(race, v.winner) >= BEST_SEEN && (this.best.size < BEST_KEPT || this.best.has(k))) {
          let b = this.best.get(k);
          if (b === undefined) {
            b = new Best();
            this.best.set(k, b);
          }
          b.add(racer(race.names, v.winner), v.time);
        }
      }
      out.push([{ ...o, names: race.names }, cheat]);
    }
    return out;
  }
}

/** the clients whose reports of a race had w first (each once) */
function clientsFirst(race, w) {
  const seen = [];
  race.reports.forEach(([, r], k) => {
    const c = race.clients[k];
    const x = winner(r);
    if (x !== null && x.id === w && !seen.includes(c)) seen.push(c);
  });
  return seen.length;
}

/**
 * One race's reports judged (best: the races' clean wins; names: its racers): its winner's verdict, and whether it is
 * a cheat's
 * @returns {[Verdict, boolean]|null}
 */
function judge(reports, best, names) {
  if (reports.length === 0) return null;
  const first = reports[0][1];
  if (first.mode === MODE_DRIFT) return null;
  // the winner, in more than half of the reports
  const winners = [];
  for (const [, r] of reports) {
    const x = winner(r);
    if (x !== null) winners.push(x);
  }
  const wx = winners.find((x) => x.id !== 0 && winners.filter((y) => y.id === x.id).length * 2 > reports.length);
  if (wx === undefined) return null;
  const w = wx.id;
  const seen = winners.filter((x) => x.id === w).length;
  // its time: the slowest any report that had it first gave it; the most of the way any report says it drove
  let time = 0.0;
  for (const x of winners) if (x.id === w) time = fmax(time, x.time);
  let drove = 0.0;
  for (const [, r] of reports) for (const x of used(r)) if (x.id === w) drove = fmax(drove, fmin(x.done / wholeWay(r), 1.0));
  // the race's length: each other finisher's own way, the shortest
  let length = null;
  for (const [by, r] of reports) {
    if (by === w) continue;
    const own = used(r).find((x) => (x.flags & RS_OURS) !== 0 && x.id === by);
    if (own === undefined || !((own.flags & RS_FINISHED) !== 0 && own.dist > 0.0)) continue;
    length = length === null ? own.dist : fmin(length, own.dist);
  }
  const avg = length !== null ? length / time : null;
  // the next finisher: the quickest other one any report has (min_by: the first of equal ones)
  /** @type {[number, number]|null} */
  let next = null;
  for (const [, r] of reports) {
    for (const x of used(r)) {
      if (x.id !== w && (x.flags & RS_FINISHED) !== 0 && x.time > 0.0 && (next === null || totalCmp(x.time, next[1]) < 0)) next = [x.id, x.time];
    }
  }
  // the winner's own game: its report's winner, else its row there
  let own = null;
  const mine = reports.find(([by]) => by === w);
  if (mine !== undefined) {
    const r = mine[1];
    const x = winner(r);
    const row = used(r).find((y) => y.id === w);
    if (x !== null && x.id === w) own = { kind: 'first', t: x.time };
    else if (row !== undefined && (row.flags & RS_FINISHED) !== 0 && row.time > 0.0) own = { kind: 'finished', t: row.time };
    else own = { kind: 'out', t: null };
  }
  const b = best.get(first.race + ',' + first.laps + ',' + first.heat);
  // (the time rules: none for a winner with another car close behind, nor for one its game ended the race of)
  const close = next !== null && time >= THIRD_SHARE * next[1];
  const timed = !close && drove >= DROVE_MIN;
  let quickest = b === undefined ? null : b.quick();
  if (quickest !== null && !(timed && time < QUICK_SHARE * quickest)) quickest = null;
  /** @type {[number, number]|null} */
  let third = null;
  if (b !== undefined) {
    const t = b.win.third(racer(names, w));
    if (t !== null && timed && time < THIRD_SHARE * t) third = [t, b.win.wins];
  }
  const ended = drove < DROVE_MIN && seen >= 2;
  const cheat = (avg !== null && !close && avg >= RACE_MPS) || ended || quickest !== null || third !== null;
  /** @type {Verdict} */
  const v = {
    lobby: first.lobby,
    race: first.race,
    mode: first.mode,
    laps: first.laps,
    heat: first.heat,
    heats: first.heats,
    winner: w,
    time,
    length,
    avg,
    next,
    drove: drove < DROVE_SHORT ? drove : null,
    quickest,
    third,
    own,
    seen,
    reports: reports.length,
    names: new Map(),
  };
  return [v, cheat];
}
