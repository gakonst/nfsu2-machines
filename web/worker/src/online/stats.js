// The online races' results per persona (crates/online/src/stats.rs): the one thing the online host keeps
// (<state>/online/stats.json, here the Store's "stats.json").  What is in it is public in the game anyway (the
// rankings and every player's online career): a persona name, its races, wins and losses per race type, ranked and
// unranked, rating points, best times per track, its records, the month it was last seen.  Nothing about who plays a
// persona.
//
// A race counts once (lobby.js decides which report).  Rating points per race: (players - place) * 100 /
// (players - 1), ranked races only.  Every count is kept twice: overall and for the current month, and the month
// before's counts stay as they were when it ended (Last Month's Leaderboard, from November 2026 on:
// FIRST_WHOLE_MONTH).  Personas not seen for pruneMonths months are forgotten; with max of them, the least recently
// seen goes for a new one, and a persona keeps its best times on MAX_BEST tracks.  The rankings are built at most
// every boardMs, and names are found by their beginning in a sorted list (EA Messenger's search).
//
// Written whole at most every saveMs and when the server stops, byte for byte as the Rust server (and the Node
// server before it) wrote it.  A file that does not parse is kept aside (stats.json.bad-<time>) and the server starts
// with no results.

import { assert, lower, monthOf, isMonth, validName, cmpStr, q } from './jsx.js';
import { blockedName } from '../names/index.js';

/** the race types by the game's own numbers (the type in its race report) */
export const RACE_TYPES = Object.freeze(['circuit', 'sprint', 'drag', 'drift', 'streetx', 'url']);
export const MAX_PERSONAS = 100000;
export const MAX_BEST = 300;
/** the largest figure a record takes: top speed in m/s, drift points, powerslide in m, jump in s */
export const RECORD_MAX = Object.freeze([150.0, 100000000.0, 10000.0, 60.0]);
/** the first month whose counts are kept whole until it ends (the first one Last Month's Leaderboard shows) */
export const FIRST_WHOLE_MONTH = '2026-11';
/** a racer's state when the race put it out on the road (ReportPlayer.state) */
export const OUT = 0x0b;

export const PERIODS = Object.freeze(['all', 'month', 'lastMonth']);

/** JS Math.round as jsx::round writes it (floor, then half up; -0 stays -0 only for -0 itself) */
function rnd(x) {
  if (!Number.isFinite(x)) return x;
  const r = Math.floor(x);
  return x - r >= 0.5 ? r + 1 : r;
}

/** f64::partial_cmp(..).unwrap_or(Equal) */
function cmpNum(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** one race type's counts */
export function blank() {
  return { races: 0, rw: 0, rl: 0, uw: 0, ul: 0, points: 0, dc: 0 };
}

/** a counts table by race type: 6 slots, null for a type not raced */
export function emptyTable() {
  return [null, null, null, null, null, null];
}

/** a persona's records (0: none yet) */
export function noRecords() {
  return { top: 0, drift: 0, slide: 0, jump: 0, drag: 0 };
}

function sameRecords(a, b) {
  return a.top === b.top && a.drift === b.drift && a.slide === b.slide && a.jump === b.jump && a.drag === b.drag;
}

function isDefaultRecords(r) {
  return sameRecords(r, noRecords());
}

/** the record of a persona not seen before */
function newRecord(name, m) {
  return {
    name,
    seen: m,
    all: emptyTable(),
    monthKey: m,
    month: emptyTable(),
    lastKey: '',
    last: emptyTable(),
    best: new Map(),
    records: noRecords(),
  };
}

export class Stats {
  /**
   * @param o {store, clocks, log, saveMs, pruneMonths, max, boardMs} (Rust StatsOptions; store null: in memory only)
   */
  constructor({ store = null, clocks, log, saveMs = 30000, pruneMonths = 12, max = MAX_PERSONAS, boardMs = 5000 }) {
    assert(clocks && typeof clocks.now === 'function' && typeof clocks.timer === 'function', 'stats: clocks');
    this.store = store;
    this.clocks = clocks;
    this.log = log || (() => {});
    this.saveMs = saveMs;
    this.pruneMonths = pruneMonths;
    this.max = max;
    this.boardMs = boardMs;
    /** lower-case name -> record, the least recently seen first */
    this.p = new Map();
    /** "kind|period" -> the ranking as last built */
    this.boards = new Map();
    /** the names sorted by their lower case, and when: {t, stale, names: [[low, name]]} | null */
    this.sorted = null;
    this.dirty = false;
    /** when the debounced save is due (the timer clock), if one is armed */
    this.saveAt = null;
    /** how often a board was built */
    this.builds = 0;
    if (this.store) this.load();
  }

  now() {
    return this.clocks.now();
  }

  /** the file's name as the console lines quote it, or null (in memory) */
  file() {
    return this.store ? this.store.path('stats.json') : null;
  }

  load() {
    if (!this.store) return;
    const text = this.store.get('stats.json');
    if (text === null) return;
    const file = this.store.path('stats.json');
    let j;
    try {
      j = JSON.parse(text);
    } catch (e) {
      const t = this.now();
      const asideName = 'stats.json.bad-' + String(Math.trunc(t));
      // (a rename: the text kept aside, the file gone; one that could not be kept aside stays)
      if (this.store.put(asideName, text) === null) this.store.delete('stats.json');
      this.log(
        '[online] ' + file + ' could not be read (' + (e && e.message) + '): moved to ' + this.store.path(asideName) +
          ', starting with no results',
        null,
      );
      return;
    }
    const rows = [];
    const personas = get(j, 'personas');
    if (Array.isArray(personas)) {
      for (let i = 0; i < personas.length; i++) {
        const r = personas[i];
        const name = get(r, 'name');
        if (typeof name !== 'string') continue;
        // one kept before names were checked for slurs: the server takes no such name now
        if (validName(name) && !blockedName(name)) rows.push(clean(r, name));
      }
    }
    rows.sort((a, b) => cmpStr(a.seen, b.seen));
    const from = this.max === 0 ? 0 : Math.max(0, rows.length - this.max);
    for (let i = from; i < rows.length; i++) this.p.set(lower(rows[i].name), rows[i]);
    this.log('[online] results of ' + this.p.size + ' personas read from ' + file, null);
  }

  /** a persona's record (made when asked for by a race: the least recently seen goes when there are max), or null */
  rec(name, make) {
    const k = lower(name);
    if (!this.p.has(k) && make) {
      let guard = this.p.size + 1;
      while (this.p.size >= this.max && guard-- > 0) {
        const it = this.p.keys().next();
        if (it.done) break;
        this.p.delete(it.value);
      }
      this.p.set(k, newRecord(name, monthOf(this.now())));
      if (this.sorted) this.sorted.stale = true;
    }
    const m = monthOf(this.now());
    const r = this.p.get(k);
    if (r === undefined) return null;
    roll(r, m);
    return r;
  }

  /** the number of records */
  len() {
    return this.p.size;
  }

  /** One race's result: each player's counts and points, best time, month seen. */
  addRace(race) {
    const n = race.players.length;
    const t = race.kind;
    if (n < 2 || !(Number.isInteger(t) && t >= 0 && t < RACE_TYPES.length)) return;
    const m = monthOf(this.now());
    for (const pl of race.players) {
      const k = lower(pl.name);
      if (this.rec(pl.name, true) === null) continue;
      // raced now: the most recently seen
      const r = this.p.get(k);
      assert(r !== undefined, 'stats: just made');
      this.p.delete(k);
      this.p.set(k, r);
      r.seen = m;
      const won = pl.place === 1;
      const pts = racePoints(race.ranked, n, pl.place);
      for (const table of [r.all, r.month]) {
        if (table[t] === null) table[t] = blank();
        const c = table[t];
        c.races += 1;
        c.points += pts;
        if (race.ranked) {
          if (won) c.rw += 1;
          else c.rl += 1;
        } else if (won) c.uw += 1;
        else c.ul += 1;
        // left the race (a racer still on the way when it ended did not finish either, and stayed)
        if (pl.place === 0 && pl.left) c.dc += 1;
      }
      if (pl.place !== 0 && pl.time > 0) {
        const key = t + ':' + String(race.track);
        const old = r.best.has(key) ? r.best.get(key) : null;
        if (!(old !== null && old <= pl.time) && (old !== null || r.best.size < MAX_BEST)) {
          r.best.set(key, rnd(pl.time * 1000) / 1000);
        }
      }
    }
    this.touch();
  }

  /** A player's own entry in its race report: each figure that beats the persona's record becomes it. */
  addRecords(name, kind, p) {
    const fits = (x, max) => Number.isFinite(x) && x > 0 && x <= max;
    const x = [p.top, p.driftBest, p.slide, p.jump];
    const drag = RACE_TYPES[kind] === 'drag' && Number.isInteger(kind) && fits(p.time, Number.MAX_VALUE) ? p.time : null;
    // (nothing to keep: no record made for it)
    if (drag === null && !x.some((v, i) => fits(v, RECORD_MAX[i]))) return;
    const r = this.rec(name, true);
    if (r === null) return;
    const old = { ...r.records };
    const rec = r.records;
    const keys = ['top', 'drift', 'slide', 'jump'];
    for (let i = 0; i < 4; i++) {
      if (fits(x[i], RECORD_MAX[i]) && x[i] > rec[keys[i]]) rec[keys[i]] = rnd(x[i] * 1000) / 1000;
    }
    if (drag !== null && (rec.drag === 0 || drag < rec.drag)) rec.drag = rnd(drag * 1000) / 1000;
    if (!sameRecords(rec, old)) this.touch();
  }

  /** The 38 numbers of the game's STAT field (hex, each followed by a comma). */
  statField(name, monthly) {
    let table = emptyTable();
    let rec = noRecords();
    const r = typeof name === 'string' && name !== '' ? this.rec(name, false) : null;
    if (r !== null) {
      if (monthly) table = r.month;
      else {
        table = r.all;
        rec = r.records;
      }
    }
    let dc = 0;
    for (const c of table) if (c !== null) dc += c.dc;
    const milli = (v) => rnd(v * 1000);
    const v = [0, dc, 0, milli(rec.top), rec.drift, milli(rec.slide), milli(rec.jump), milli(rec.drag)];
    for (const c0 of table) {
      const c = c0 === null ? blank() : c0;
      v.push(c.points, c.rw, c.rl, c.uw, c.ul);
    }
    let s = '';
    for (const x of v) s += (x >>> 0).toString(16) + ',';
    return s;
  }

  /** a ranking: best first (points, then wins, then fewer losses, then name) */
  board(kind, period) {
    assert(PERIODS.includes(period), 'stats: period');
    this.builds += 1;
    const m = monthOf(this.now());
    const rows = [];
    for (const r of this.p.values()) {
      roll(r, m);
      let table;
      if (period === 'all') table = r.all;
      else if (period === 'month') table = r.month;
      else if (lastShown(r)) table = r.last;
      else continue;
      const c = Number.isInteger(kind) && kind >= 0 && kind < 6 ? table[kind] : null;
      if (c === null || c === undefined || c.races === 0) continue;
      rows.push({ name: r.name, points: c.points, wins: c.rw + c.uw, losses: c.rl + c.ul, races: c.races, rank: 0 });
    }
    rows.sort(
      (a, b) =>
        cmpNum(b.points, a.points) || cmpNum(b.wins, a.wins) || cmpNum(a.losses, b.losses) || cmpStr(a.name, b.name),
    );
    return rows;
  }

  /** a ranking as the game's Rankings ask for it: {t, month, rows (with ranks), index: lower name -> row}; built at
   *  most every boardMs */
  ranking(kind, period) {
    const now = this.now();
    const month = monthOf(now);
    const key = kind + '|' + period;
    const b = this.boards.get(key);
    const fresh = b !== undefined && now - b.t < this.boardMs && b.month === month;
    if (!fresh) {
      const rows = this.board(kind, period);
      const index = new Map();
      for (let i = 0; i < rows.length; i++) {
        rows[i].rank = i + 1;
        index.set(lower(rows[i].name), i);
      }
      this.boards.set(key, { t: now, month, rows, index });
    }
    return this.boards.get(key);
  }

  /** at most max names that begin with prefix (lower case), from a sorted list built at most every boardMs */
  startingWith(prefix, max) {
    const now = this.now();
    if (this.sorted === null || (this.sorted.stale && now - this.sorted.t >= this.boardMs)) {
      const names = [];
      for (const r of this.p.values()) names.push([lower(r.name), r.name]);
      names.sort((a, b) => cmpStr(a[0], b[0]));
      this.sorted = { t: now, stale: false, names };
    }
    const n = this.sorted.names;
    // partition_point(x.0 < prefix)
    let lo = 0, hi = n.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmpStr(n[mid][0], prefix) < 0) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < n.length; i++) {
      const [low, name] = n[i];
      if (out.length >= max || !low.startsWith(prefix)) break;
      if (this.p.has(low)) out.push(name);
    }
    return out;
  }

  touch() {
    this.dirty = true;
    if (this.store === null || this.saveAt !== null) return;
    this.saveAt = this.clocks.timer() + this.saveMs;
  }

  /** when the debounced save is due (the timer clock), or null */
  saveDue() {
    return this.saveAt;
  }

  /** the save timer fired */
  saveTimer() {
    this.saveAt = null;
    this.save();
  }

  prune() {
    const [y, mo] = monthParts(monthOf(this.now()));
    const cut = y * 12 + mo - this.pruneMonths;
    const old = [];
    for (const [k, r] of this.p) {
      const [ry, rm] = monthParts(r.seen);
      if (ry * 12 + rm < cut) old.push(k);
    }
    for (const k of old) this.p.delete(k);
  }

  /** the file's text: version 1, every record, field for field in the Node server's format */
  serialize() {
    const parts = ['{"v":1,"note":"NFSU2 online results per persona (public in the game)","personas":['];
    let i = 0;
    for (const r of this.p.values()) {
      let s = i > 0 ? ',' : '';
      i++;
      s += '{"name":' + q(r.name) + ',"seen":' + q(r.seen) + ',"all":' + writeTable(r.all);
      s += ',"month":{"key":' + q(r.monthKey) + ',"t":' + writeTable(r.month) + '}';
      // last month's counts (only once it has some)
      if (r.lastKey !== '' && r.last.some((c) => c !== null)) {
        s += ',"last":{"key":' + q(r.lastKey) + ',"t":' + writeTable(r.last) + '}';
      }
      s += ',"best":{';
      let j = 0;
      for (const [k, v] of r.best) {
        if (j > 0) s += ',';
        j++;
        s += q(k) + ':' + num(v);
      }
      s += '}';
      // (a persona with none: as the Node server wrote it)
      if (!isDefaultRecords(r.records)) {
        s += ',"rec":{';
        let first = true;
        for (const k of ['top', 'drift', 'slide', 'jump', 'drag']) {
          const v = r.records[k];
          if (v === 0) continue;
          if (!first) s += ',';
          first = false;
          s += '"' + k + '":' + num(v);
        }
        s += '}';
      }
      s += '}';
      parts.push(s);
    }
    parts.push(']}');
    return parts.join('');
  }

  save() {
    if (this.store === null) return;
    if (!this.dirty) return;
    this.prune();
    const body = this.serialize();
    const err = this.store.put('stats.json', body);
    if (err === null) this.dirty = false;
    else this.log('[online] the results could not be written: ' + err, null);
  }

  /** the server stops: the timer ends, the results are written */
  stop() {
    this.saveAt = null;
    this.save();
  }
}

/** a parsed JSON value's own member (serde_json Value::get with a string key: objects only) */
function get(v, k) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** a new month: the monthly counts start again; those of the month that ended are last month's when it was the one
 *  before (a persona that did not race in it has none) */
export function roll(r, m) {
  if (r.monthKey !== m) {
    const before = monthBefore(m);
    if (r.monthKey === before) {
      r.lastKey = r.monthKey;
      r.last = r.month;
    } else if (r.lastKey !== before) {
      r.lastKey = '';
      r.last = emptyTable();
    }
    r.monthKey = m;
    r.month = emptyTable();
  }
}

/** a record's last month's counts show (Last Month's Leaderboard): those of FIRST_WHOLE_MONTH or later */
export function lastShown(r) {
  if (r.lastKey === '') return false;
  const [a, b] = monthParts(r.lastKey);
  const [c, d] = monthParts(FIRST_WHOLE_MONTH);
  return a > c || (a === c && b >= d);
}

/** the month before a month ("2026-01" -> "2025-12") */
export function monthBefore(m) {
  const [y, mo] = monthParts(m);
  const n = y * 12 + mo - 2;
  const yy = Math.floor(n / 12);
  const mm = n - yy * 12 + 1;
  return String(yy) + '-' + String(mm).padStart(2, '0');
}

/** s.split('-').map(Number) of a month that passed its check, as i64 */
export function monthParts(s) {
  const it = s.split('-');
  const i64 = (x) => {
    const v = Number(x);
    return Number.isNaN(v) ? 0 : Math.trunc(v);
  };
  return [it.length > 0 ? i64(it[0]) : 0, it.length > 1 ? i64(it[1]) : 0];
}

/** a finite number as JSON.stringify writes it (-0 as 0), else null */
function num(x) {
  return Number.isFinite(x) ? String(x) : 'null';
}

function writeTable(t) {
  let s = '{';
  let first = true;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === null) continue;
    if (!first) s += ',';
    first = false;
    s +=
      '"' + i + '":{"races":' + num(c.races) + ',"rw":' + num(c.rw) + ',"rl":' + num(c.rl) + ',"uw":' + num(c.uw) +
      ',"ul":' + num(c.ul) + ',"points":' + num(c.points) + ',"dc":' + num(c.dc) + '}';
  }
  return s + '}';
}

/** a parsed JSON value that counts as there: not null, false, 0, NaN or "" (JS truthiness) */
function truthy(v) {
  return !!v;
}

/** a count from the file: a finite number of at least 0, at most 2^31; anything else is 0 */
function count(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.min(v, 2147483648);
  return 0;
}

/** a record's counts from the file: each race type's entry (an object's "0".."5"; an array's elements and a string's
 *  characters too, as the Node server read them), one that is not there skipped, the numbers checked */
function counts(t) {
  const o = emptyTable();
  if (t === undefined) return o;
  for (let i = 0; i < 6; i++) {
    let c;
    if (isObject(t)) c = get(t, String(i));
    else if (Array.isArray(t)) c = i < t.length ? t[i] : undefined;
    else if (typeof t === 'string') c = t.length > i ? true : undefined;
    else c = undefined;
    if (c === undefined || !truthy(c)) continue;
    const f = (k) => count(isObject(c) ? get(c, k) : undefined);
    o[i] = { races: f('races'), rw: f('rw'), rl: f('rl'), uw: f('uw'), ul: f('ul'), points: f('points'), dc: f('dc') };
  }
  return o;
}

/** a best time's key: one digit (the race type), ':', 1 to 6 digits (the track) */
function bestKey(k) {
  return /^[0-9]:[0-9]{1,6}$/.test(k);
}

/** a stored record, with only the fields this file writes (numbers checked) */
function clean(r, name) {
  const best = new Map();
  const b = get(r, 'best');
  if (isObject(b)) {
    for (const k of Object.keys(b)) {
      const x = b[k];
      if (typeof x === 'number' && bestKey(k) && Number.isFinite(x) && x > 0) best.set(k, x);
    }
  }
  const monthStr = (v) => (typeof v === 'string' && isMonth(v) ? v : null);
  const seen = monthStr(get(r, 'seen')) ?? '1970-01';
  const month = get(r, 'month');
  const key = monthStr(isObject(month) ? get(month, 'key') : undefined) ?? seen;
  const mt = isObject(month) ? get(month, 't') : undefined;
  const last0 = get(r, 'last');
  const last = isObject(last0) ? last0 : undefined;
  const lastKey = monthStr(last !== undefined ? get(last, 'key') : undefined) ?? '';
  const lastT = lastKey === '' ? emptyTable() : counts(last !== undefined ? get(last, 't') : undefined);
  const all = counts(get(r, 'all'));
  let rec = noRecords();
  const o = get(r, 'rec');
  if (isObject(o)) {
    const take = (k, max) => {
      const x = get(o, k);
      return typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= max ? x : 0;
    };
    rec = {
      top: take('top', RECORD_MAX[0]),
      drift: take('drift', RECORD_MAX[1]),
      slide: take('slide', RECORD_MAX[2]),
      jump: take('jump', RECORD_MAX[3]),
      drag: take('drag', 1e9),
    };
  }
  return { name, seen, all, monthKey: key, month: counts(mt), lastKey, last: lastT, best, records: rec };
}

/** a player's rating points for one race of n players (place 1..n, 0 = did not finish), ranked races only */
export function racePoints(ranked, n, place) {
  return ranked && n >= 2 && place !== 0 ? rnd(((n - place) * 100) / (n - 1)) : 0;
}

/** a player of a race report (decodeResult) */
export class ReportPlayer {
  constructor(f) {
    this.index = f.index ?? 0;
    this.place = f.place ?? 0;
    this.state = f.state ?? 0;
    this.car = f.car ?? 0;
    this.time = f.time ?? 0;
    this.score = f.score ?? 0;
    this.dropped = !!f.dropped;
    this.top = f.top ?? 0;
    this.avg = f.avg ?? 0;
    this.jump = f.jump ?? 0;
    this.slide = f.slide ?? 0;
    this.driftBest = f.driftBest ?? 0;
  }
  /** a racer who crossed the finish line, in the reporter's game */
  finished() {
    return finished(this);
  }
  /** the reporter's own entry: it raced to the end, finished or put out on the road when the race ended (OUT) */
  racedToTheEnd() {
    return racedToTheEnd(this);
  }
}

/** ReportPlayer::finished of any object with its fields */
export function finished(p) {
  return !p.dropped;
}

/** ReportPlayer::raced_to_the_end of any object with its fields */
export function racedToTheEnd(p) {
  return !p.dropped || p.state === OUT;
}

function popcount16(v) {
  let n = 0;
  for (let i = 0; i < 16; i++) n += (v >>> i) & 1;
  return n;
}

/** a race report from its base64 (rank RESU): null for anything that does not parse */
export function decodeResult(b64) {
  const b = nodeBase64(b64);
  if (b.length < 8 || b[0] !== 3) return null;
  const n = b[1];
  if (!(n >= 1 && n <= 8)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const f32At = (o) => dv.getFloat32(o, false);
  const i32At = (o) => dv.getInt32(o, false);
  const fin = (x) => (Number.isFinite(x) ? x : 0);
  const players = [];
  let o = 8;
  for (let k = 0; k < n; k++) {
    if (o + 55 > b.length) return null;
    const extra = 2 * popcount16(dv.getUint16(o + 53, false));
    // dropped out: the flag byte 0x0c instead of 0x01 and -1.0 at 32, or -1.0 at 44
    const time = f32At(o + 8);
    const dropped = (b[o + 2] & 0x08) !== 0 || f32At(o + 32) === -1 || f32At(o + 44) === -1;
    players.push(
      new ReportPlayer({
        index: b[o],
        place: b[o + 1],
        state: b[o + 2],
        car: b[o + 3],
        time: fin(time),
        score: i32At(o + 44),
        dropped,
        top: fin(f32At(o + 20)),
        avg: fin(f32At(o + 16)),
        jump: fin(f32At(o + 36)),
        slide: fin(f32At(o + 40)),
        driftBest: i32At(o + 48),
      }),
    );
    o += 55 + extra;
  }
  return { kind: b[2], reporter: b[3], track: (b[4] << 8) | b[5], dir: b[6], laps: b[7], players };
}

/** base64 as Node's Buffer.from(s, 'base64') reads it: both alphabets, other characters skipped, the first "=" ends
 *  it, the bits of an unfinished last byte dropped */
export function nodeBase64(s) {
  const o = [];
  let acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let v;
    if (c >= 65 && c <= 90) v = c - 65;
    else if (c >= 97 && c <= 122) v = c - 97 + 26;
    else if (c >= 48 && c <= 57) v = c - 48 + 52;
    else if (c === 43 || c === 45) v = 62;
    else if (c === 47 || c === 95) v = 63;
    else if (c === 61) break;
    else continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      o.push((acc >>> bits) & 255);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(o);
}
