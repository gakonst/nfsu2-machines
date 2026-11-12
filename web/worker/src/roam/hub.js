// The hub's logic, without its timer (RoamHub gives it one): the players, the links, the cap.  A port of
// web/server-rs/crates/roam/src/hub.rs, function by function, in the same order of operations: the links (which pairs,
// in which order, the grid and heap of a large room), the lists, the maps and the lobbies come out byte for byte as the
// Rust hub's (test/roam/difftrace.test.mjs replays seeded traces into both and compares every datagram).
//
// The order of the players, and of each player's links, is the order they came in: it decides between pairs at one
// distance, and so the links.  The players live in slots (a link names the slot of the player it is to: a player
// that goes is taken out of every link before its slot is used again, at the next tick or once many have gone, and
// until then links to it count for nothing) and order lists the slots in the order the players came.
//
// What differs from the Rust, all of it outside what the hub sends: no threads (the Rust reads a large room's walks on
// several, with the same links), no clock of its own (now() is what the caller gives), tickMsMax stays 0, and the
// order of console lines that come from Rust HashMap iterations (kept watches, judged races) is insertion order here.

import { CAR_KMH, MODE_DRIFT } from '../anticheat/anticheat.js';
import { canonical, second } from '../claims/claims.js';
import { headingCos, headingSin, hypot } from '../util/crmath.js';
import { printable, numberToString } from '../util/js.js';
import { fixed } from '../util/rustfmt.js';
import { vipStr } from '../util/vip.js';
import { Cand, Found, Grid, Heap, Level, Near, WALK_AHEAD, WALK_SOON, WALK_VIEW, before, distance, samePlace, square, weigh } from './links.js';
import * as results from './results.js';
import { sortUnstable } from './rsort.js';
import * as watch from './watch.js';
import * as wire from './wire.js';

const { F_DATA, KIND_UDP } = wire;

/** 10.77.0.253, runtime/web/net_proto.h NET_ROAM_HUB */
export const ROAM_HUB_VIP = 0x0a4d00fd;

/** no slot, no place in a room */
const NONE = 0xffffffff;
/** The most slots, and so the most players */
const SLOTS_MAX = 25600;
/** The world map's keys (MAPD, and the minimap's NEARD) */
const MAP_KEYS = wire.MAPD_PARKED;
/** no world map key */
const NO_KEY = 0xffff;

const MAP_TOL_M = 8.0;
const MAP_TOL_H = 32;
const MAP_AHEAD_MS = 1000.0;
const MAP_KEEP_MS = 10000.0;
const MAP_LOBBIES_GAP_MS = 1000.0;
const STAY_M = 25.0;
const PARKED_MS = 60000.0;
/** MAPD's most players placed in one answer of parts full datagrams, with their heights (z) or not */
function mapdMax(parts, z) {
  return parts * Math.floor(wire.MAPD_BYTES / (z ? wire.MAPD_PLACE_Z : wire.MAPD_PLACE));
}
const NEAR_MAX = Math.floor(wire.MAPD_BYTES / wire.MAPD_PLACE);
const NEAR_M = 1000.0;
const NEAR_TOL_M = 2.0;
const NEAR_TOL_H = 8;
const NEAR_CELL_M = 128.0;
const NEAR_SLACK_M = 64.0;
const NEAR_KEEP_M = 120.0;
const NEAR_CANDS_MS = 1000.0;
const NEAR_MOVE_M = 40.0;
const NEAR_FIRST = 2;
const NEAR_BUSY_LOW = 0.6;
const NEAR_BUSY_HIGH = 0.75;
const LOBBY_STALE_MS = 3000.0;
const LOBBY_NEAR_M = 20.0;
const LOBBY_NEAR_MAX = 24;
const LOBBY_JOIN_MS = 6000.0;
const LOBBY_STAY_M = 50.0;
const REPORT_GAP_MS = 20000.0;
const LOBBY_LAND_M = 30.0;
const NEAR_FRESH_MS = 2000.0;
const NEAR_NAMED = 3;
const BESIDE_M = 30.0;
const WATCH_KEEP_MS = 60000.0;
const JOINED_KEEP_MS = 1800000.0;
const JOINED_PER_VIP = 4;
const JOINED_IDS = 12;
const CREW_LINKS = 16;
function crewCap(degree) {
  return Math.min(CREW_LINKS, Math.max(Math.floor(degree / 2), 1));
}
const CREW_GROUP_MAX = 64;
const FRIENDS_MAX = 264;
const FRIEND_NEAR_M = 30.0;
const CAR_KW = 600.0;
const CAR_RATING = 1000.0;
const PLAYER_TYPES = 31;
const TIMES_KEPT = 1024;
const TIMES_RACES = 2048;
const LIKE_RATING = 60.0;
const LIKE_MIN = 10;
const GAIN_SHARE = 0.95;
const SEEN_EVERY_MS = 600000.0;
const NAME_LINES = 4;
const GAME_NAME_MAX = 24;
const FLEW_SEEN_M = 200.0;
const DIR_RECV = 1;
const DIR_SEND = 2;
const DIR_BOTH = 3;
const AGE_MAX_S = 1.0;
const KEY_HELD = -3.0e6;
const KEY_NEAR = -2.0e6;
const KEY_FAR_HELD = -1.0e6;
const ONEWAY_MORE = 8;
const ONEWAY_FAR = 48;
const GONE_RX_FULL = 0;
const GONE_TX_FULL = 1;
const GONE_LIST_FULL = 2;
const GONE_AWAY = 3;
const GONE_LEFT = 4;
const GONE_OTHER = 5;
const GONE_N = 6;
const NEAR_GONE_M = 60.0;
const NEAR_SAY_MS = 300000.0;

const fr = Math.fround;
const f32view = new DataView(new ArrayBuffer(4));
/** an f32's bits as a u32 (a distance's square: its bits are in its order, it is not negative) */
function f32ToBits(x) {
  f32view.setFloat32(0, x);
  return f32view.getUint32(0);
}

function assert(c, what) {
  if (!c) throw new Error('roam hub: ' + what);
}

/** binary search of a sorted array of numbers */
function bsearch(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo < a.length && a[lo] === x;
}

/** the first index in [from, to) of a sorted array where pred is false (Rust's partition_point) */
function partitionPoint(a, pred, from = 0, to = a.length) {
  let lo = from, hi = to;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (pred(a[m])) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** a pair of places or slots (each under 2^24) as one number, in their order */
function pairKey(a, b) {
  return a * 16777216 + b;
}

/** a player's endpoint, its virtual address and port, in one number */
function key(vip, port) {
  return vip * 65536 + port;
}

/** a HELLO's crews as the hub keeps them: each one once, in its order, 0 after them */
function distinct(crews) {
  const out = [0, 0, 0, 0];
  let n = 0;
  for (const c of crews) {
    let seen = false;
    for (let k = 0; k < n; k++) if (out[k] === c) seen = true;
    if (c !== 0 && !seen) {
      out[n] = c;
      n++;
    }
  }
  return out;
}

/** a player's crews: the nonzero ones of its crews */
function crewsOf(p) {
  const out = [];
  for (const c of p.crews) {
    if (c === 0) break;
    out.push(c);
  }
  return out;
}

const te = new TextEncoder();

/** The id of the friendship of keyphrases a and b (hub.rs friend_id): FNV-1a of the two, never 0 */
function friendId(a, b) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  let h = 0x811c9dc5;
  for (const c of te.encode(lo)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  h = Math.imul(h ^ 0, 0x01000193) >>> 0;
  for (const c of te.encode(hi)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  return Math.max(h, 1);
}

/** a player's friendships (hub.rs friend_ids) */
function friendIds(owner, friends, seat2) {
  if (owner == null || friends == null || seat2) return [];
  const ids = [];
  for (const x of friends) if (x !== owner) ids.push(friendId(owner, x));
  ids.sort((a, b) => a - b);
  return ids.filter((x, i) => i === 0 || ids[i - 1] !== x);
}

function friendsBoth(p, q) {
  if (p.owner != null && q.owner != null && p.owner !== q.owner) {
    const id = friendId(p.owner, q.owner);
    return bsearch(p.friendIds, id) && bsearch(q.friendIds, id);
  }
  return false;
}

function mates(p, q) {
  if (friendsBoth(p, q)) return true;
  if (p.room !== q.room) return false;
  for (const c of q.crews) {
    if (c === 0) break;
    if (p.crews.includes(c)) return true;
  }
  return false;
}

/** the nearest integer, a half up (hub.rs js_round) */
function jsRound(x) {
  const c = Math.ceil(x);
  return c - 0.5 <= x ? c : c - 1.0;
}

/** Rust's {:?} of a String: its text quoted, with Rust's escapes */
function debugStr(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c === 0) out += '\\0';
    else if (c < 0x20 || c === 0x7f) out += '\\u{' + c.toString(16) + '}';
    else out += ch;
  }
  return out + '"';
}

const RUST_SPACE = /^[\t\n\u000B\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\t\n\u000B\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/gu;

/** Rust's str::trim: White_Space at both ends */
function rustTrim(s) {
  return s.replace(RUST_SPACE, '');
}

function asciiLower(s) {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** str::eq_ignore_ascii_case */
function eqIgnoreAsciiCase(a, b) {
  return te.encode(a).length === te.encode(b).length && asciiLower(a) === asciiLower(b);
}

/** whether a game shows the name page (a page's on the switch) as game (hub.rs same_name) */
function sameName(page, game) {
  let shown = '';
  let n = 0;
  for (const ch of page) {
    if (n >= GAME_NAME_MAX) break;
    const c = ch.codePointAt(0);
    shown += c >= 0x20 && c <= 0x7e ? ch : '?';
    n++;
  }
  return eqIgnoreAsciiCase(rustTrim(shown), rustTrim(game));
}

/** latin1 text of bytes (a name of printable ASCII, checked) */
function latin1(b) {
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

/** the bytes of a name as Rust's p.name.as_bytes() == name compares them */
function sameBytes(s, b) {
  if (s.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (s.charCodeAt(i) !== b[i]) return false;
  return true;
}

/** how a race report's player did: "2nd of 4", "did not finish", "quit" */
function placeWord(r) {
  if (r.place === 0) return r.quit ? 'quit' : 'did not finish';
  const n = r.place;
  return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th') + ' of ' + r.players;
}

/** what a race report says of its player's career stage and its lobby (hub.rs lobby_notes) */
function lobbyNotes(r) {
  let s = '';
  if (r.stage > 0) s += '; stage ' + r.stage;
  if (r.lobbyBits & wire.RL_STAGED) s += "; its lobby's stage limit";
  if (r.lobbyBits & wire.RL_MATE_PAST) s += "; past it as the host's friend or crew-mate";
  if (r.lobbyBits & wire.RL_HOST_PAST) s += "; its host past the race's stage";
  return s;
}

function hex8(n) {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/** A player's race report as a log line (hub.rs race_line) */
function raceLine(player, r) {
  const mode = results.modeName(r.mode);
  const how = placeWord(r);
  const time = r.time > 0.0 ? ' in ' + fixed(r.time, 2) + ' s' : '';
  const name = latin1(r.name);
  return (
    '[race] lobby ' + hex8(r.lobby) + ', race ' + hex8(r.race) + ' (' + mode + ', track ' + r.track + ', ' + r.laps + ' lap' +
    (r.laps === 1 ? '' : 's') + ', ' + r.players + ' cars): ' + player + (r.host ? ' (host)' : '') + ' ' + how + time + '; ' +
    name + ' (type ' + r.carType + '), class ' + r.class + ', rating ' + fixed(r.rating, 1) + " (the cars' average " +
    fixed(r.field, 1) + '), ' + fixed(r.kw, 0) + ' kW, ' + fixed(r.kg, 0) + ' kg, ' + fixed(r.kmh, 0) + ' km/h, power x' +
    fixed(r.factor, 3) + (r.credit === 1 ? '; won it in the career' : r.credit === 2 ? "; a friend's win in the career" : '') +
    lobbyNotes(r)
  );
}

function overTheGame(r) {
  return r.kw >= CAR_KW || r.kmh >= CAR_KMH || r.rating >= CAR_RATING;
}

/** whether a race report's car is one the server race-bans its player for (hub.rs server_bans) */
function serverBans(c, r) {
  return r.players >= 2 && r.carType < PLAYER_TYPES && ((c.kw != null && r.kw >= c.kw) || (c.rating != null && r.rating >= c.rating));
}

/** The honest finishers' times of the lobbies' races, per race (id, laps), the newest last (hub.rs Times) */
class Times {
  constructor() {
    /** @type {Map<number, Array<[number, number]>>} */
    this.m = new Map();
  }
  static key(r) {
    return r.race * 256 + r.laps;
  }
  add(r) {
    if (r.edited || overTheGame(r) || r.players < 2 || r.place === 0 || r.time <= 0.0 || r.mode === MODE_DRIFT) return;
    const k = Times.key(r);
    if (this.m.size >= TIMES_RACES && !this.m.has(k)) return;
    let v = this.m.get(k);
    if (!v) {
      v = [];
      this.m.set(k, v);
    }
    if (v.length >= TIMES_KEPT) v.shift();
    v.push([Math.fround(r.rating), Math.fround(r.time)]);
  }
  compare(r) {
    if (r.place === 0 || r.time <= 0.0 || r.mode === MODE_DRIFT) return null;
    const all = this.m.get(Times.key(r));
    if (!all) return null;
    const lo = r.rating - LIKE_RATING, hi = r.rating + LIKE_RATING;
    const near = all.filter((x) => x[0] >= lo && x[0] <= hi).map((x) => x[1]);
    let t, like;
    if (near.length >= LIKE_MIN) {
      t = near;
      like = [Math.max(lo, 0.0), hi];
    } else {
      t = all.map((x) => x[1]);
      like = null;
    }
    if (t.length < LIKE_MIN) return null;
    t.sort((a, b) => a - b);
    let beat = 0;
    for (const x of t) if (x > r.time) beat++;
    return { beat, of: t.length, median: t[Math.floor(t.length / 2)], like };
  }
}

function comparedText(r, c) {
  if (r.mode === MODE_DRIFT) return 'a drift race, won by points: no time to compare';
  if (r.place === 0 || r.time <= 0.0) return 'no time to compare';
  if (!c) return 'its ' + fixed(r.time, 2) + ' s: too few honest times of this race to compare it with';
  const share = c.beat === c.of ? 'all ' + c.of : Math.floor((c.beat * 100) / c.of) + ' % of the ' + c.of;
  const cars = c.like ? 'honest cars rated ' + fixed(c.like[0], 0) + '-' + fixed(c.like[1], 0) : 'honest cars of any rating (too few rated like it)';
  return 'its ' + fixed(r.time, 2) + ' s beat ' + share + ' ' + cars + ' in this race (their median ' + fixed(c.median, 2) + ' s)';
}

/** A player's race report's [cheat] line, or what its [race] line adds (hub.rs edited_car_line) */
function editedCarLine(who, r, c) {
  const over = overTheGame(r);
  if (r.players < 2 || !(over || r.edited)) return [null, ''];
  const gain = c != null && c.like != null && c.beat >= GAIN_SHARE * c.of;
  const cmp = comparedText(r, c);
  if (!over && !gain) return [null, '; its game has the car\'s data edited (GlobalB), no gain seen: ' + cmp];
  const why = [];
  if (r.edited) why.push("its game has the car's data edited (GlobalB)");
  if (over) why.push('no car of the game makes ' + fixed(CAR_KW, 0) + ' kW, ' + fixed(CAR_KMH, 0) + ' km/h or a rating of ' + fixed(CAR_RATING, 0));
  const name = latin1(r.name);
  const line =
    '[cheat] ' + who + ': raced in the race of lobby ' + hex8(r.lobby) + ' (race ' + hex8(r.race) + ': ' + results.modeName(r.mode) +
    ', ' + r.laps + ' lap' + (r.laps === 1 ? '' : 's') + ') in an edited car, ' + placeWord(r) + ': ' + name + ' (type ' + r.carType +
    '), ' + fixed(r.kw, 0) + ' kW, ' + fixed(r.kg, 0) + ' kg, ' + fixed(r.kmh, 0) + ' km/h, rated ' + fixed(r.rating, 0) + '; ' +
    why.join('; ') + '; ' + cmp;
  return [line, ''];
}

function carBan(vip, name, r) {
  return {
    vip, name, car: latin1(r.name), carType: r.carType, kw: r.kw, kg: r.kg, kmh: r.kmh, rating: r.rating,
    kind: results.modeName(r.mode), laps: r.laps, place: placeWord(r), lobby: r.lobby, race: r.race,
  };
}

/** One player of a lobby (hub.rs Joined): the race, the browser that hosts it, its racers, when last heard of */
class Joined {
  constructor(race, vip, racers, at) {
    this.race = race;
    this.vip = vip;
    /** @type {Array<{id: number, key: number, name: string}>} */
    this.racers = racers;
    this.at = at;
  }
  join(id, k, name) {
    const vipOf = (x) => Math.floor(x / 65536);
    if (this.racers.some((r) => r.id === id && vipOf(r.key) !== vipOf(k))) return;
    this.racers = this.racers.filter((r) => r.key !== k || r.id === id);
    const at = this.racers.findIndex((r) => r.id === id);
    if (at >= 0) {
      const r = this.racers[at];
      r.key = k;
      if (r.name !== name) r.name = name;
    } else if (this.racers.length < JOINED_IDS) {
      this.racers.push({ id, key: k, name });
    }
  }
  has(id, k) {
    return this.racers.some((r) => r.id === id && r.key === k);
  }
}

/** What a browser's page blocks (hub.rs Block) */
class Block {
  constructor(names) {
    const set = [];
    for (const n of names) {
      const c = canonical(n);
      if (c != null) set.push(c);
    }
    set.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.names = set.filter((x, i) => i === 0 || set[i - 1] !== x);
    this.owners = [];
    this.checked = -1;
  }
  ownersOf(claims, now) {
    if (!claims || claims.generation() === this.checked) return;
    this.checked = claims.generation();
    const out = [];
    for (const n of this.names) {
      const h = claims.holders(n, Math.trunc(now));
      if (h.length === 1) out.push(h[0]);
    }
    this.owners = out;
  }
  has(p) {
    return (p.canon !== '' && this.names.includes(p.canon)) || (p.owner != null && this.owners.includes(p.owner));
  }
}

/** The hub's options (lib.rs RoamOptions), their defaults */
export function defaultOptions() {
  return {
    degree: 64,
    tickMs: 500,
    staleMs: 60000.0,
    goneMs: 6000.0,
    keep: 0.5,
    holdMs: 5000.0,
    maxPerVip: 3,
    maxPlayers: 24576,
    exactRoom: 256,
    minDegree: 8,
    busyHigh: 0.85,
    busyLow: 0.65,
    capDownMs: 5000.0,
    capUpMs: 15000.0,
    askCap: 24,
    soonMs: 1000.0,
    lookMs: 4000.0,
    awayM: 100.0,
    viewM: 150.0,
    sends: 64,
    nearM: 60.0,
    nearHoldMs: 30000.0,
    nearFast: 15.0,
    levelSlackM: 5.0,
    levelGrade: 0.2,
    levelK: 25.0,
    mapMax: 4096,
    mapGapMs: 250.0,
    mapFreshMs: 5000.0,
    nearGapMs: 150.0,
    // (the Rust's threads for a large room's walks: none here, the links are the same)
    linkThreads: 1,
    deny: null,
    carBans: null,
  };
}

/** the options: a value that is not a positive number keeps its default (hub.rs sanitize) */
function sanitize(o) {
  const d = defaultOptions();
  o = { ...d, ...(o || {}) };
  const n = (v, dv) => (Number.isInteger(v) && v > 0 ? v : dv);
  const f = (v, dv) => (typeof v === 'number' && Number.isFinite(v) && v > 0.0 ? v : dv);
  return {
    degree: Math.min(n(o.degree, d.degree), wire.LINKS_MAX),
    tickMs: n(o.tickMs, d.tickMs),
    staleMs: f(o.staleMs, d.staleMs),
    goneMs: f(o.goneMs, d.goneMs),
    keep: f(o.keep, d.keep),
    holdMs: f(o.holdMs, d.holdMs),
    maxPerVip: n(o.maxPerVip, d.maxPerVip),
    maxPlayers: Math.min(n(o.maxPlayers, d.maxPlayers), SLOTS_MAX),
    exactRoom: n(o.exactRoom, d.exactRoom),
    minDegree: n(o.minDegree, d.minDegree),
    busyHigh: f(o.busyHigh, d.busyHigh),
    busyLow: f(o.busyLow, d.busyLow),
    capDownMs: f(o.capDownMs, d.capDownMs),
    capUpMs: f(o.capUpMs, d.capUpMs),
    askCap: n(o.askCap, d.askCap),
    soonMs: f(o.soonMs, d.soonMs),
    lookMs: f(o.lookMs, d.lookMs),
    awayM: f(o.awayM, d.awayM),
    viewM: f(o.viewM, d.viewM),
    sends: Math.min(n(o.sends, d.sends), wire.LIST_MAX),
    nearM: f(o.nearM, d.nearM),
    nearHoldMs: f(o.nearHoldMs, d.nearHoldMs),
    nearFast: f(o.nearFast, d.nearFast),
    levelSlackM: f(o.levelSlackM, d.levelSlackM),
    levelGrade: f(o.levelGrade, d.levelGrade),
    levelK: f(o.levelK, d.levelK),
    mapMax: Math.min(n(o.mapMax, d.mapMax), mapdMax(wire.MAPD_PARTS_WIDE, false)),
    mapGapMs: f(o.mapGapMs, d.mapGapMs),
    mapFreshMs: f(o.mapFreshMs, d.mapFreshMs),
    nearGapMs: f(o.nearGapMs, d.nearGapMs),
    linkThreads: Math.min(n(o.linkThreads, d.linkThreads), 64),
    deny: o.deny || null,
    carBans: o.carBans || null,
  };
}

function newStats() {
  return {
    frames: 0, bad: 0, refused: 0, lists: 0, ticks: 0, tickMsMax: 0, busy: 0, capCuts: 0, duelLinks: 0, lobbyLinks: 0,
    crewLinks: 0, crewSkips: 0, onewayLinks: 0, txOnly: [0, 0, 0], raceReports: 0, cheatLines: 0, carBans: 0, nears: 0,
  };
}

/** a minimap grid's read of a player (hub.rs Shown) */
function shownOf(o) {
  return {
    live: true, hasP: o.p !== null, impostor: o.impostor, status: o.status, heading: o.heading, mapKey: o.mapKey, id: o.id,
    room: o.room, p: o.p !== null ? o.p : [0, 0, 0], v: [o.v[0], o.v[1]], posAt: o.posAt,
  };
}
const SHOWN_NONE = Object.freeze({ live: false, hasP: false, impostor: false, status: 0, heading: 0, mapKey: 0, id: 0, room: 0, p: [0, 0, 0], v: [0, 0], posAt: 0 });

/** a FIFO of u16 keys (the world map keys free, hub.rs map_free) */
class KeyQueue {
  constructor(n) {
    this.buf = new Uint16Array(n + 1);
    this.head = 0;
    this.tail = 0;
    for (let k = 0; k < n; k++) this.push(k);
  }
  get length() {
    return (this.tail - this.head + this.buf.length) % this.buf.length;
  }
  push(k) {
    this.buf[this.tail] = k;
    this.tail = (this.tail + 1) % this.buf.length;
    assert(this.tail !== this.head, 'map keys overflow');
  }
  shift() {
    if (this.head === this.tail) return null;
    const k = this.buf[this.head];
    this.head = (this.head + 1) % this.buf.length;
    return k;
  }
}

/** The hub's logic, without its timer (RoamHub gives it one) (hub.rs Hub) */
export class Hub {
  /**
   * @param {object} o the options (defaultOptions(); a value that is not a positive number keeps its default)
   * @param {{now: () => number, busy?: () => number, log?: (line: string) => void, send?: (vip: number, frame: Uint8Array) => boolean, id: number, claims?: any}} io
   *   now: the clock in ms (the caller's, never a hidden one); busy: 0 to 1, how busy the server was; log: a console line;
   *   send(vip, frame): through the switch (true: it went); id: the hub's own sender id
   */
  constructor(o, io) {
    this.o = sanitize(o);
    this.now = io.now;
    this.busy = io.busy || (() => 0);
    this.log = io.log || (() => {});
    this.send = io.send || (() => false);
    this.id = io.id >>> 0;
    assert(this.id !== 0, 'the hub id is never 0');
    this.seq = 0;
    this.cap = this.o.degree;
    this.capAt = -Infinity;
    this.threadBusy = 0.0;
    this.st = newStats();
    /** @type {Array<object|null>} */
    this.slots = [];
    this.free = [];
    this.mapFree = new KeyQueue(MAP_KEYS);
    this.dead = [];
    this.deadAt = [];
    this.order = [];
    this.holes = 0;
    this.byKey = new Map();
    this.blocks_ = new Map();
    this.pages = new Map();
    this.friends_ = new Map();
    this.roomNames = new Map();
    this.ownersAt = new Map();
    /** the pairs kept apart at the last tick, as slots, the lower first, sorted (pairKey) */
    this.apart = [];
    this.perVip = new Map();
    this.crewed = 0;
    this.kept = new Map();
    this.results = new results.Results();
    this.times = new Times();
    this.joined = new Map();
    this.joinedByVip = new Map();
    this.joinedPruned = 0.0;
    this.nearSaid = [0, 0, 0, 0, 0, 0];
    this.nearSaidAt = 0.0;
    this.mapAt = new Map();
    this.maps = new Map();
    this.lobbiesAt = new Map();
    this.mapCands = new Map();
    this.nearAt = new Map();
    this.nears = new Map();
    this.nearGrid = null;
    this.nearGens = 0;
    this.nearMark = [];
    this.nearStamp = 0;
    this.s = newScratch();
    this.claims = io.claims || null;
  }

  /** the claimed names its players' names are checked against */
  setClaims(claims) {
    this.claims = claims || null;
  }

  /** a player's name against the claims and the names the operator took away (hub.rs check_claim) */
  checkClaim(slot, now) {
    if (this.claims == null && this.o.deny == null) return;
    const cg = this.claims ? this.claims.generation() : 0;
    const dg = this.o.deny ? this.o.deny.generation() : 0;
    // (both generations in one value, never 0: a string here, as only equality counts)
    const g = cg + ':' + dg;
    const p = this.slots[slot];
    if (!p) return;
    if (p.checked !== g) {
      p.checked = g;
      const was = p.impostor;
      const denied = this.o.deny != null && this.o.deny.has(p.name);
      p.impostor = denied || (this.claims != null && !this.claims.mayUse(p.name, p.owner, Math.trunc(now)));
      if (p.impostor && !was) {
        this.log(
          '[roam] ' + vipStr(p.vip) + ' plays as "' + printable(p.name, 32) + '", ' +
            (denied ? 'a name the operator took away' : 'a name another keyphrase claimed') + ': no links',
        );
      }
    }
    if (this.claims != null && p.owner != null && !p.impostor && now - p.seenClaim >= SEEN_EVERY_MS) {
      p.seenClaim = now;
      this.claims.seen(p.name, p.owner, Math.trunc(now));
    }
  }

  /** the switch's way to its browsers */
  attachSwitch(send) {
    this.send = send;
  }

  options() {
    return this.o;
  }

  player(slot) {
    const p = this.slots[slot];
    return p === undefined ? null : p;
  }

  /** the minimap grid's live read of the player in slot as it is now, if the grid has it (hub.rs shown_sync) */
  shownSync(slot) {
    const g = this.nearGrid;
    if (!g) return;
    const k = slot < g.pos.length ? g.pos[slot] : NONE;
    if (k === NONE) return;
    const p = this.player(slot);
    if (k < g.live.length) g.live[k] = p ? shownOf(p) : SHOWN_NONE;
  }

  /** the world map's key of the player in slot (hub.rs map_key_sync) */
  mapKeySync(slot) {
    const p = this.player(slot);
    if (!p) return;
    const want = p.status === 2 || p.status === 5;
    if (want && p.mapKey === NO_KEY) {
      const k = this.mapFree.shift();
      if (k !== null) p.mapKey = k;
    } else if (!want && p.mapKey !== NO_KEY) {
      this.mapFree.push(p.mapKey);
      p.mapKey = NO_KEY;
    }
  }

  /** the players in the order they came */
  *players() {
    for (const s of this.order) {
      const p = s === NONE ? null : this.slots[s];
      if (p) yield p;
    }
  }

  insert(p) {
    const k = key(p.vip, p.port);
    const w = this.kept.get(k);
    if (w) {
      this.kept.delete(k);
      if (this.now() - w.at < WATCH_KEEP_MS) {
        p.watch = w.watch;
        if (w.id !== p.id) p.watch.reset();
      }
    }
    if (this.free.length === 0 && this.slots.length >= SLOTS_MAX) this.purge();
    let slot;
    if (this.free.length > 0) slot = this.free.pop();
    else {
      this.slots.push(null);
      slot = this.slots.length - 1;
    }
    let mine = this.perVip.get(p.vip);
    if (!mine) {
      mine = [];
      this.perVip.set(p.vip, mine);
    }
    mine.push(slot);
    this.order.push(slot);
    p.at = this.order.length - 1;
    this.slots[slot] = p;
    this.byKey.set(k, slot);
    return slot;
  }

  /** out of the slots and the order (not out of the links: dropSlots does that); false if it was empty */
  remove(slot, keep) {
    const p = this.player(slot);
    if (!p) return false;
    this.slots[slot] = null;
    if (p.mapKey !== NO_KEY) this.mapFree.push(p.mapKey);
    this.shownSync(slot);
    const now = this.now();
    const k = key(p.vip, p.port);
    if (keep && this.kept.size < this.o.maxPlayers) {
      // (a key kept already is replaced: a HashMap insert)
      this.kept.delete(k);
      this.kept.set(k, { watch: p.watch, id: p.id, name: p.name, at: now });
      p.watch = new watch.Watch(now);
    } else {
      const line = p.watch.summary(p.vip, p.name, now, true);
      if (line != null) {
        this.st.cheatLines++;
        this.log(line);
      }
    }
    this.byKey.delete(k);
    this.crewed -= p.crews[0] !== 0 ? 1 : 0;
    const mine = this.perVip.get(p.vip);
    if (mine) {
      const left = mine.filter((s) => s !== slot);
      if (left.length === 0) this.perVip.delete(p.vip);
      else this.perVip.set(p.vip, left);
    }
    if (p.at < this.order.length) this.order[p.at] = NONE;
    this.holes++;
    if (this.holes > 64 && this.holes * 2 > this.order.length) {
      this.order = this.order.filter((s) => s !== NONE);
      this.holes = 0;
      for (let at = 0; at < this.order.length; at++) {
        const q = this.slots[this.order[at]];
        if (q) q.at = at;
      }
    }
    return true;
  }

  /** a player that said BYE: out of the players and out of every link */
  dropKey(k) {
    const slot = this.byKey.get(k);
    if (slot === undefined) return;
    this.dropSlots([slot], false);
  }

  /** Players gone at once (hub.rs drop_slots) */
  dropSlots(slots, keep) {
    while (this.deadAt.length < this.slots.length) this.deadAt.push(false);
    for (const s of slots) {
      if (this.remove(s, keep)) {
        this.deadAt[s] = true;
        this.dead.push(s);
      }
    }
    if (this.dead.length >= Math.max(64, Math.floor(this.byKey.size / 8))) this.purge();
  }

  /** the players gone out of the others' links, and their slots free again */
  purge() {
    if (this.dead.length === 0) return;
    const dead = this.deadAt;
    for (const q of this.slots) {
      if (q) q.links = q.links.filter((l) => !(l.slot < dead.length && dead[l.slot]));
    }
    for (const s of this.dead) {
      this.deadAt[s] = false;
      this.free.push(s);
    }
    this.dead.length = 0;
  }

  /** a link to a player that is still there (not one gone and not purged yet) */
  live(l) {
    return !(l.slot < this.deadAt.length && this.deadAt[l.slot]);
  }

  /** a frame from browser from to the hub's address */
  frame(from, data) {
    this.frameOf(from, data, null, null);
  }

  frameFrom(from, data, owner) {
    this.frameOf(from, data, owner, null);
  }

  /**
   * a frame from the browser at from, whose page plays with keyphrase owner (null: none), of the client client (an
   * opaque id; null: the browser is a client of its own) (hub.rs frame_of)
   * @param {number} from
   * @param {Uint8Array} data
   * @param {string|null} owner
   * @param {string|null} client
   */
  frameOf(from, data, owner, client) {
    owner = owner == null ? null : owner;
    this.st.frames++;
    if (data.length < F_DATA + wire.HDR + wire.CRC || data[0] !== KIND_UDP) {
      this.st.bad++;
      return;
    }
    const sport = (data[12] << 8) | data[13], dport = (data[14] << 8) | data[15];
    const dec = sport !== 0 ? wire.decode(data.subarray(F_DATA)) : null;
    if (!dec) {
      this.st.bad++;
      return;
    }
    const { sender, m } = dec;
    const k = key(from, sport);
    const found = this.byKey.get(k);
    if (m.type === 'bye') {
      if (found !== undefined) this.dropKey(k);
      return;
    }
    let renamed = found === undefined;
    let slot;
    if (found !== undefined) slot = found;
    else {
      if (m.type !== 'hello') return;
      const mineN = this.perVip.has(from) ? this.perVip.get(from).length : 0;
      if (mineN >= this.o.maxPerVip || this.byKey.size >= this.o.maxPlayers) {
        this.st.refused++;
        return;
      }
      const name = latin1(m.name);
      slot = this.insert({
        p: null,
        v: [0.0, 0.0, 0.0],
        posAt: 0.0,
        stay: [0.0, 0.0],
        stayAt: Infinity,
        id: sender,
        room: m.room,
        impostor: false,
        status: m.status,
        heading: 0,
        slope: 0,
        mapKey: NO_KEY,
        vip: from,
        port: sport,
        hubPort: dport,
        name,
        canon: canonical(name) ?? '',
        degree: 0,
        seen: 0.0,
        lobbies: false,
        marks: false,
        seat2: m.seat2,
        crews: [0, 0, 0, 0],
        lobby: null,
        join: null,
        duel: 0,
        reported: null,
        resulted: null,
        links: [],
        oneway: false,
        hints: false,
        watch: new watch.Watch(this.now()),
        at: 0,
        owner,
        friendIds: friendIds(owner, this.friends_.get(from), m.seat2),
        checked: 0,
        seenClaim: -Infinity,
      });
    }
    const now = this.now();
    const degree = this.o.degree;
    const beside = m.type === 'snap' && (m.status === 2 || m.status === 5) ? this.besideOwn(slot, m.p, now) : false;
    const p = this.player(slot);
    if (!p) return;
    p.seen = now;
    p.hubPort = dport;
    let ask = null, askNear = null, report = null, edited = null, banned = null, res = null, heard = null, crewed = null;
    let seen = [null, null];
    let check = false;
    switch (m.type) {
      case 'hello': {
        if (p.id !== sender) {
          p.links = [];
          p.watch.reset();
        }
        p.id = sender;
        p.room = m.room;
        p.status = m.status;
        if (!(m.status === 2 || m.status === 5)) p.watch.reset();
        if (!sameBytes(p.name, m.name)) {
          p.name = latin1(m.name);
          p.canon = canonical(p.name) ?? '';
          p.checked = 0;
          renamed = true;
        }
        if (p.owner !== owner || p.seat2 !== m.seat2) {
          if (p.seat2 !== m.seat2) renamed = true;
          p.owner = owner;
          p.seat2 = m.seat2;
          p.checked = 0;
          p.friendIds = friendIds(owner, this.friends_.get(from), m.seat2);
        }
        check = true;
        const most = m.core >= 14 ? degree : Math.min(degree, wire.LINKS_V13);
        p.degree = m.core >= 10 && m.links > 0 ? Math.min(m.links, most) : Math.min(degree, wire.LINKS_V9);
        p.lobbies = m.lobbies;
        p.marks = m.marks;
        p.oneway = m.core >= wire.CORE_ONEWAY;
        p.hints = m.core >= wire.CORE_HINTS;
        p.duel = m.duel;
        const was = p.crews[0] !== 0;
        p.crews = distinct(m.crews);
        crewed = [was, p.crews[0] !== 0];
        break;
      }
      case 'snap': {
        if (sender !== p.id) break;
        const pos = m.p;
        const dx = pos[0] - p.stay[0], dy = pos[1] - p.stay[1];
        if (p.p === null || dx * dx + dy * dy > STAY_M * STAY_M || !(m.status === 2 || m.status === 5)) {
          p.stay = [pos[0], pos[1]];
          p.stayAt = now;
        }
        p.p = pos;
        p.v = m.v;
        p.heading = m.heading;
        p.slope = m.slope;
        p.posAt = p.seen;
        p.status = m.status;
        if (m.status === 2 || m.status === 5) seen = p.watch.snap(now, pos, m.tUs, m.clock, beside);
        else p.watch.reset();
        break;
      }
      case 'mapreq':
        if (sender === p.id && !p.seat2) ask = [m.req, m.max, m.base, m.flags];
        break;
      case 'nearreq':
        if (sender === p.id && !p.seat2) askNear = [m.req, m.max, m.base, m.radius];
        break;
      case 'lobby': {
        if (!(m.to === 0 && sender === p.id)) break;
        if (m.op === wire.LOBBY_ADVERT) {
          p.lobby = [
            { id: m.lobby, race: m.race, x: m.x, y: m.y, n: m.n, max: m.max, state: m.state, ids: m.ids, private: m.private, staged: m.staged, hstage: m.hstage },
            now,
          ];
        } else if (m.op === wire.LOBBY_CLOSE && p.lobby !== null && p.lobby[0].id === m.lobby) {
          p.lobby = null;
        } else if (m.op === wire.LOBBY_JOIN) {
          p.join = [m.lobby, now];
        }
        if (m.op === wire.LOBBY_ADVERT || m.op === wire.LOBBY_JOIN) heard = [m.op, m.lobby, m.race];
        break;
      }
      case 'racerep': {
        const r = m.r;
        if (!(sender === p.id && !(p.reported !== null && (p.reported[0] === r.lobby || now - p.reported[1] < REPORT_GAP_MS)))) break;
        p.reported = [r.lobby, now];
        const [line, note] = editedCarLine(vipStr(p.vip) + ' "' + p.name + '"', r, this.times.compare(r));
        this.times.add(r);
        report = raceLine(p.name, r) + note;
        edited = line;
        if (this.o.carBans != null && serverBans(this.o.carBans, r)) banned = carBan(p.vip, p.name, r);
        break;
      }
      case 'raceres': {
        const r = m.r;
        const ok =
          p.resulted === null ||
          (p.resulted[0] === r.lobby ? (p.resulted[2] & (1 << r.heat)) === 0 : now - p.resulted[1] >= REPORT_GAP_MS);
        if (!(sender === p.id && ok)) break;
        const heats = p.resulted !== null && p.resulted[0] === r.lobby ? p.resulted[2] : 0;
        p.resulted = [r.lobby, now, heats | (1 << r.heat)];
        res = [p.id, r];
        break;
      }
      default:
        break;
    }
    if (heard) this.lobbyHeard(slot, heard[0], heard[1], heard[2], now);
    if (crewed) this.crewed = this.crewed + (crewed[1] ? 1 : 0) - (crewed[0] ? 1 : 0);
    if (check) this.checkClaim(slot, now);
    this.mapKeySync(slot);
    this.shownSync(slot);
    if (renamed) this.nameCheck(slot);
    if (report !== null) {
      this.st.raceReports++;
      this.log(report);
    }
    if (edited !== null) {
      this.st.cheatLines++;
      this.log(edited);
    }
    if (banned !== null && this.o.carBans != null) {
      this.st.carBans++;
      this.o.carBans.call(banned);
    }
    for (const sn of seen) if (sn) this.cheat(slot, sn, now);
    if (res) {
      const [by, r] = res;
      const j = this.joined.get(r.lobby);
      if (j && j.race === r.race && j.has(by, k)) {
        for (let x = 0; x < r.n; x++) {
          const row = r.rows[x];
          if (!j.racers.some((mm) => mm.id === row.id)) row.id = 0;
        }
        const names = j.racers.map((mm) => [mm.id, this.racerName(mm)]);
        const cl = client != null ? client : vipStr(from);
        this.results.add(now, by, cl, r, (id) => {
          const f = names.find((x) => x[0] === id);
          return f ? f[1] : null;
        });
      }
    }
    if (ask) this.mapd(slot, ask[0], ask[1], ask[2], ask[3], now);
    if (askNear) this.neard(slot, askNear[0], askNear[1], askNear[2], askNear[3], now);
  }

  /** A lobby's advert or a player's own ask to join it (hub.rs lobby_heard) */
  lobbyHeard(slot, op, lobby, race, now) {
    const p = this.player(slot);
    if (!p) return;
    const id = p.id, k = key(p.vip, p.port), vip = p.vip;
    const j = this.joined.get(lobby);
    if (j) {
      if (j.race === race && (op !== wire.LOBBY_ADVERT || j.vip === vip)) {
        j.join(id, k, p.name);
        j.at = now;
      }
      return;
    }
    if (op !== wire.LOBBY_ADVERT) return;
    let mine = this.joinedByVip.get(vip);
    if (!mine) {
      mine = [];
      this.joinedByVip.set(vip, mine);
    }
    if (mine.length >= JOINED_PER_VIP) {
      const old = mine.shift();
      this.joined.delete(old);
    }
    mine.push(lobby);
    this.joined.set(lobby, new Joined(race, vip, [{ id, key: k, name: p.name }], now));
  }

  /** What a player's SNAP showed of its car as a [cheat] line (hub.rs cheat) */
  cheat(slot, seen, now) {
    const p = this.player(slot);
    if (!p) return;
    const room = p.room, vip = p.vip;
    let near = [], all = 0, lobby = null;
    if (seen.kind === 'jump' || seen.kind === 'fast') {
      const to = seen.to;
      for (const q of this.order) {
        const o = q === NONE ? null : this.player(q);
        if (!o || o.vip === vip || o.room !== room) continue;
        if (o.p !== null && (o.status === 2 || o.status === 5) && now - o.posAt <= NEAR_FRESH_MS) {
          const at = o.p;
          const kk = (now - o.posAt) / 1000.0;
          const there = [at[0] + o.v[0] * kk, at[1] + o.v[1] * kk, at[2] + o.v[2] * kk];
          const d = watch.distance(there, to);
          if (d < watch.NEAR_M) {
            all++;
            near.push([d, o.name, o.vip]);
          }
        }
        if (lobby === null && o.lobby !== null) {
          const [l, t] = o.lobby;
          if (now - t < LOBBY_STALE_MS && hypot(l.x - to[0], l.y - to[1]) < LOBBY_LAND_M) lobby = o.name;
        }
      }
      near.sort((a, b) => a[0] - b[0]);
      near = near.slice(0, NEAR_NAMED);
    }
    if (seen.kind === 'jump' && all > 0) p.watch.landedNear();
    const last = p.watch.line(now);
    if (last === null) return;
    const line = watch.line(p.vip, p.name, seen, { players: near, all, lobby }, p.watch.jumps, last);
    this.st.cheatLines++;
    this.log(line);
  }

  /** Whether a SNAP of a browser's second player has its car beside its first player's (hub.rs beside_own) */
  besideOwn(slot, to, now) {
    const p = this.player(slot);
    if (!p || !p.seat2) return false;
    const mine = this.perVip.get(p.vip);
    if (!mine || mine.length <= 1) return false;
    for (const s of mine) {
      if (s === slot) continue;
      const o = this.player(s);
      if (!o) continue;
      if (o.seat2 || o.impostor || o.room !== p.room || !(o.status === 2 || o.status === 5) || now - o.posAt > NEAR_FRESH_MS) continue;
      if (o.p === null) continue;
      const at = o.p;
      const kk = Math.max(now - o.posAt, 0.0) / 1000.0;
      if (watch.distance([at[0] + o.v[0] * kk, at[1] + o.v[1] * kk, at[2] + o.v[2] * kk], to) <= BESIDE_M) return true;
    }
    return false;
  }

  /** a lobby's player as a line names it (hub.rs racer_name) */
  racerName(r) {
    const s = this.byKey.get(r.key);
    const p = s === undefined ? null : this.player(s);
    const nowP = p && p.id === r.id ? p : null;
    return vipStr(Math.floor(r.key / 65536)) + ' "' + (nowP ? nowP.name : r.name) + '"';
  }

  /** a frame of the hub's to the player at vip:port from the hub's port hubPort, its datagram of len bytes after it */
  newFrame(vip, port, hubPort, len) {
    const f = new Uint8Array(F_DATA + len);
    f[0] = KIND_UDP;
    f[4] = ROAM_HUB_VIP >>> 24; f[5] = (ROAM_HUB_VIP >>> 16) & 255; f[6] = (ROAM_HUB_VIP >>> 8) & 255; f[7] = ROAM_HUB_VIP & 255;
    f[8] = vip >>> 24; f[9] = (vip >>> 16) & 255; f[10] = (vip >>> 8) & 255; f[11] = vip & 255;
    f[12] = hubPort >> 8; f[13] = hubPort & 255;
    f[14] = port >> 8; f[15] = port & 255;
    return f;
  }

  /** The world map's answer to the player in slot (hub.rs mapd) */
  mapd(slot, req, most, base, flags, now) {
    const parked = (flags & wire.MAPREQ_PARKED) !== 0;
    const partsMax = (flags & wire.MAPREQ_WIDE) !== 0 ? wire.MAPD_PARTS_WIDE : wire.MAPD_PARTS;
    const max = Math.min(this.o.mapMax, mapdMax(partsMax, parked), most);
    let p = this.player(slot);
    if (!p) return;
    if (p.impostor || (this.mapAt.has(p.vip) && now < this.mapAt.get(p.vip))) return;
    const room = p.room, at = p.p !== null ? p.p : [0, 0, 0], vip = p.vip, port = p.port, hubPort = p.hubPort, lobbies = p.lobbies;
    let atT, cands;
    if (this.mapCands.has(room)) {
      [atT, cands] = this.mapCands.get(room);
      this.mapCands.delete(room);
    } else {
      atT = now;
      cands = this.mapRoom(room, now);
    }
    p = this.player(slot);
    if (!p) return;
    const links = p.links.filter((l) => (l.dir & DIR_RECV) !== 0).map((l) => l.slot);
    links.sort((a, b) => a - b);
    let pick = [];
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (c.slot === slot || bsearch(links, c.slot)) continue;
      const o = this.player(c.slot);
      if (o && (o.vip === vip || this.apartFrom(slot, c.slot, p, o))) continue;
      pick.push(i);
    }
    const total = Math.min(pick.length, 0xffff);
    if (pick.length > max) {
      const d2 = (q) => (q[0] - at[0]) * (q[0] - at[0]) + (q[1] - at[1]) * (q[1] - at[1]) + (q[2] - at[2]) * (q[2] - at[2]);
      const near = pick.map((i) => [d2(cands[i].p), i]);
      near.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      pick = near.slice(0, max).map((e) => e[1]);
      pick.sort((a, b) => a - b);
    }
    const list = pick.map((i) => cands[i]);
    this.mapCands.set(room, [atT, cands]);
    let mm = this.maps.get(vip);
    if (mm) this.maps.delete(vip);
    else mm = newMapHeld();
    if (base !== 0 && mm.sent !== null && mm.sent[0] === base) {
      mm.held = mm.sent;
      mm.sent = null;
    }
    const from = mm.held !== null && base !== 0 && mm.held[0] === base ? mm.held[1] : [];
    let b = from.length === 0 ? 0 : base;
    let [e, ends, next] = mapDiff(from, list, atT, MAP_TOL_M, MAP_TOL_H, parked);
    let parts = mapParts(ends);
    if (parts.length > partsMax) {
      b = 0;
      [e, ends, next] = mapDiff([], list, atT, MAP_TOL_M, MAP_TOL_H, parked);
      parts = mapParts(ends);
    }
    for (let k = 0; k < parts.length; k++) {
      const [a, z] = parts[k];
      const s0 = a === 0 ? 0 : ends[a - 1], s1 = z === 0 ? 0 : ends[z - 1];
      const f = this.newFrame(vip, port, hubPort, wire.mapdLen(s1 - s0));
      wire.writeMapd(f.subarray(F_DATA), wire.MSG_MAPD, this.id, this.seq, req, b, k, parts.length, total, z - a, parked ? wire.HF_MAPZ : 0, e.subarray(s0, s1));
      this.seq = (this.seq + 1) & 0xffff;
      this.send(vip, f);
    }
    mm.sent = [req, next];
    mm.at = now;
    this.maps.set(vip, mm);
    this.mapAt.set(vip, now + this.o.mapGapMs);
    if (lobbies && !(this.lobbiesAt.has(vip) && now < this.lobbiesAt.get(vip))) {
      this.lobbiesAt.set(vip, now + MAP_LOBBIES_GAP_MS);
      this.lobbies(slot, req, now);
    }
  }

  /** The minimap's answer to the player in slot (hub.rs neard) */
  neard(slot, req, most, base, radius, now) {
    const max = Math.min(NEAR_MAX, most);
    const r = Math.min(radius, NEAR_M);
    let p = this.player(slot);
    if (!p) return;
    if (p.impostor || (this.nearAt.has(p.vip) && now < this.nearAt.get(p.vip))) return;
    const room = p.room, vip = p.vip, port = p.port, hubPort = p.hubPort;
    const own = this.perVip.has(vip) && this.perVip.get(vip).length > 1;
    if (this.nearGrid === null || this.nearGrid.at > now) {
      this.nearGens++;
      this.nearGrid = this.nearGridOf(now, this.nearGens);
    }
    let m = this.nears.get(vip);
    if (m) this.nears.delete(vip);
    else m = newMapHeld();
    const found = [];
    let picks = [];
    const mark = this.nearMark;
    while (mark.length < this.slots.length) mark.push(0);
    this.nearStamp = (this.nearStamp + 1) >>> 0;
    if (this.nearStamp === 0) {
      mark.fill(0);
      this.nearStamp = 1;
    }
    const stamp = this.nearStamp;
    const grid = this.nearGrid;
    p = this.player(slot);
    if (!p) return;
    if (p.p !== null) {
      const me = ahead(p, now);
      const co = m.candsOf;
      const fresh =
        co !== null && co[1] === slot && co[2] === radius && co[3] === most && now - co[0] < NEAR_CANDS_MS && hypot(me[0] - co[4], me[1] - co[5]) < NEAR_MOVE_M;
      if (!fresh) {
        mark[slot] = stamp;
        for (const l of p.links) if ((l.dir & DIR_RECV) !== 0 && l.slot < mark.length) mark[l.slot] = stamp;
        const keep = r + NEAR_KEEP_M;
        const reach = keep + NEAR_SLACK_M;
        const x0 = nearCell(me[0] - reach), x1 = nearCell(me[0] + reach), y0 = nearCell(me[1] - reach), y1 = nearCell(me[1] + reach);
        const mx = fr(me[0]), my = fr(me[1]), k2 = fr(keep * keep), since = fr((now - grid.at) / 1000.0);
        const blocks = this.blocks_.size > 0;
        const row = (cy, cx0, cx1) => {
          if (cx0 > cx1) return;
          const ri = partitionPoint(grid.rows, (e) => e[0] < room || (e[0] === room && e[1] < cy));
          if (ri >= grid.rows.length) return;
          const [rr, rc, rs0] = grid.rows[ri];
          if (rr !== room || rc !== cy) return;
          const rs = rs0, re = ri + 1 < grid.rows.length ? grid.rows[ri + 1][2] : grid.keys.length;
          const a = partitionPoint(grid.keys, (kk) => kk[2] < cx0, rs, re);
          const z = partitionPoint(grid.keys, (kk) => kk[2] <= cx1, rs, re);
          for (let kx = a; kx < z; kx++) {
            const it = grid.items[kx];
            const dt = since < it.left ? since : it.left;
            const dx = fr(fr(it.x + fr(it.vx * dt)) - mx), dy = fr(fr(it.y + fr(it.vy * dt)) - my);
            const d2 = fr(fr(dx * dx) + fr(dy * dy));
            if (d2 > k2 || (it.slot < mark.length && mark[it.slot] === stamp)) continue;
            if (blocks || own) {
              const o = this.player(it.slot);
              if (o && (o.vip === vip || this.apartFrom(slot, it.slot, p, o))) continue;
            }
            found.push([d2, kx]);
          }
        };
        const cx = nearCell(me[0]), cy = nearCell(me[1]);
        const fx0 = Math.max(cx - NEAR_FIRST, x0), fx1 = Math.min(cx + NEAR_FIRST, x1), fy0 = Math.max(cy - NEAR_FIRST, y0), fy1 = Math.min(cy + NEAR_FIRST, y1);
        for (let y = fy0; y <= fy1; y++) row(y, fx0, fx1);
        const inner = Math.min(NEAR_FIRST * NEAR_CELL_M - NEAR_SLACK_M, keep);
        const inner2 = fr(inner * inner);
        let within = 0;
        for (const x of found) if (x[0] <= inner2) within++;
        if (within < 2 * max) {
          for (let y = y0; y <= y1; y++) {
            if (y >= fy0 && y <= fy1) {
              row(y, x0, fx0 - 1);
              row(y, fx1 + 1, x1);
            } else {
              row(y, x0, x1);
            }
          }
        }
        if (found.length > 2 * max) {
          found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
          found.length = 2 * max;
        }
        m.cands = found.map((x) => grid.items[x[1]].slot);
        m.candK = found.map((x) => x[1]);
        m.candK.sort((a, b) => a - b);
        m.candNth = grid.nth;
        m.candsOf = [now, slot, radius, most, me[0], me[1]];
        found.length = 0;
      }
      if (m.candNth !== grid.nth) {
        m.candK = [];
        for (const q of m.cands) {
          const kk = q < grid.pos.length ? grid.pos[q] : NONE;
          if (kk !== NONE) m.candK.push(kk);
        }
        m.candK.sort((a, b) => a - b);
        m.candNth = grid.nth;
      }
      const mx = fr(me[0]), my = fr(me[1]), r2 = fr(r * r), since = fr((now - grid.at) / 1000.0);
      for (const kx of m.candK) {
        const it = grid.items[kx];
        const dt = since < it.left ? since : it.left;
        const dx = fr(fr(it.x + fr(it.vx * dt)) - mx), dy = fr(fr(it.y + fr(it.vy * dt)) - my);
        const d2 = fr(fr(dx * dx) + fr(dy * dy));
        if (d2 <= r2) {
          if (own) {
            const o = this.player(it.slot);
            if (o && o.vip === vip) continue;
          }
          picks.push([d2, it.slot, kx]);
        }
      }
      if (picks.length > max) {
        picks.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
      }
    }
    const total = Math.min(picks.length, 0xffff);
    const picked = Math.min(picks.length, max);
    picks = picks.slice(0, picked);
    picks.sort((a, b) => a[2] - b[2]);
    const list = [];
    for (const [, q, kx] of picks) {
      const s = kx < grid.live.length ? grid.live[kx] : SHOWN_NONE;
      if (s.live && s.room === room && this.shownOnMap(s, now)) {
        list.push(mapCandOf(q, s.mapKey, s.id, s.p, s.heading, s.v, aheadOf(s.p, s.v, s.posAt, now), false));
      }
    }
    list.sort((a, b) => a.key - b.key);
    if (base !== 0 && m.sent !== null && m.sent[0] === base) {
      m.held = m.sent;
      m.sent = null;
    }
    const from = m.held !== null && base !== 0 && m.held[0] === base ? m.held[1] : [];
    let b = from.length === 0 ? 0 : base;
    let [e, ends, next] = mapDiff(from, list, now, NEAR_TOL_M, NEAR_TOL_H, false);
    if (e.length > wire.MAPD_BYTES || ends.length > 255) {
      b = 0;
      [e, ends, next] = mapDiff([], list, now, NEAR_TOL_M, NEAR_TOL_H, false);
    }
    const f = this.newFrame(vip, port, hubPort, wire.mapdLen(e.length));
    wire.writeMapd(f.subarray(F_DATA), wire.MSG_NEARD, this.id, this.seq, req, b, 0, 1, total, ends.length & 255, 0, e);
    this.seq = (this.seq + 1) & 0xffff;
    this.send(vip, f);
    this.st.nears++;
    m.sent = [req, next];
    m.at = now;
    this.nears.set(vip, m);
    const gap = this.threadBusy >= NEAR_BUSY_HIGH ? 1000.0 : this.threadBusy >= NEAR_BUSY_LOW ? 500.0 : this.o.nearGapMs;
    this.nearAt.set(vip, now + gap);
  }

  /** every room's players a map shows now, by room and cell (hub.rs near_grid_of) */
  nearGridOf(now, nth) {
    const v = [];
    for (const q of this.order) {
      const o = q === NONE ? null : this.player(q);
      if (!o || !this.mapShown(o, now)) continue;
      const at = ahead(o, now);
      const left = Math.max(MAP_AHEAD_MS - Math.max(now - o.posAt, 0.0), 0.0) / 1000.0;
      const it = { slot: q, x: fr(at[0]), y: fr(at[1]), vx: fr(o.v[0]), vy: fr(o.v[1]), left: fr(left) };
      v.push([[o.room, nearCell(at[1]), nearCell(at[0])], it]);
    }
    // (Rust's sort_unstable_by_key on ((u32, i32, i32), NearItem), 36 bytes: a cell's players in its order, rsort.js)
    sortUnstable(v, (a, b) => a[0][0] < b[0][0] || (a[0][0] === b[0][0] && (a[0][1] < b[0][1] || (a[0][1] === b[0][1] && a[0][2] < b[0][2]))), 36);
    let maxSlot = -1;
    for (const e of v) if (e[1].slot > maxSlot) maxSlot = e[1].slot;
    const pos = new Array(maxSlot + 1).fill(NONE);
    const rows = [];
    for (let k = 0; k < v.length; k++) {
      pos[v[k][1].slot] = k;
      const [room, cy] = v[k][0];
      const last = rows.length > 0 ? rows[rows.length - 1] : null;
      if (last === null || last[0] !== room || last[1] !== cy) rows.push([room, cy, k]);
    }
    const live = v.map((e) => {
      const pp = this.player(e[1].slot);
      return pp ? shownOf(pp) : SHOWN_NONE;
    });
    return { at: now, nth, keys: v.map((e) => e[0]), rows, live, items: v.map((e) => e[1]), pos };
  }

  /** a player the maps show (hub.rs map_shown) */
  mapShown(o, now) {
    return o.mapKey !== NO_KEY && !o.impostor && o.p !== null && now - o.posAt <= this.o.mapFreshMs && (o.status === 2 || o.status === 5);
  }

  shownOnMap(s, now) {
    return s.mapKey !== NO_KEY && !s.impostor && s.hasP && now - s.posAt <= this.o.mapFreshMs && (s.status === 2 || s.status === 5);
  }

  /** the players of room a world map shows, by key (hub.rs map_room) */
  mapRoom(room, now) {
    const list = [];
    for (const q of this.order) {
      const o = q === NONE ? null : this.player(q);
      if (!o) continue;
      if (o.room === room && this.mapShown(o, now)) list.push(mapCand(q, o, ahead(o, now), now));
    }
    list.sort((a, b) => a.key - b.key);
    return list;
  }

  /** With the world map's answer, to a player that takes race lobbies: its room's open lobbies (hub.rs lobbies) */
  lobbies(slot, req, now) {
    const p = this.player(slot);
    if (!p || !p.lobbies || p.impostor) return;
    const room = p.room, at = p.p !== null ? p.p : [0, 0, 0];
    const near = [];
    for (const q of this.order) {
      const o = q === NONE ? null : this.player(q);
      if (!o || o.lobby === null) continue;
      const [l, t] = o.lobby;
      if (o.impostor || o.room !== room || now - t > LOBBY_STALE_MS) continue;
      if (this.apartFrom(slot, q, p, o)) continue;
      const ours = q === slot || l.ids.slice(0, Math.min(l.n, wire.LOBBY_PLAYERS)).includes(p.id);
      if (l.private && !ours && !mates(p, o)) continue;
      if (!ours && (l.state !== 0 || l.n >= l.max)) continue;
      const state = l.staged
        ? l.state | wire.LOBBIES_STAGED | ((l.hstage & 7) << wire.LOBBIES_HSTAGE) | (mates(p, o) ? wire.LOBBIES_MATE : 0)
        : l.state;
      const d = distance(at, [l.x, l.y, at[2]]);
      near.push([d, [l.x, l.y, l.race, l.n, l.max, state]]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const list = near.slice(0, wire.LOBBIES_MAX).map((e) => e[1]);
    const f = this.newFrame(p.vip, p.port, p.hubPort, wire.lobbiesLen(list.length));
    wire.writeLobbies(f.subarray(F_DATA), this.id, this.seq, req, list);
    this.seq = (this.seq + 1) & 0xffff;
    this.send(p.vip, f);
  }

  /** browser vip left the switch */
  peerGone(vip) {
    this.blocks_.delete(vip);
    this.pages.delete(vip);
    this.friends_.delete(vip);
    this.roomNames.delete(vip);
    const mine = this.perVip.get(vip);
    if (!mine) return;
    this.dropSlots(mine.slice(), true);
  }

  /** browser vip's page blocks these players, by the name over their car (hub.rs blocks) */
  blocks(vip, names) {
    this.log('[roam] ' + vipStr(vip) + ' blocks ' + names.map(debugStr).join(', '));
    const b = new Block(names);
    b.ownersOf(this.claims, this.now());
    this.blocks_.set(vip, b);
  }

  /** browser vip's keyphrase me has these friends (their keyphrases) (hub.rs friends) */
  friends(vip, me, owners) {
    const theirs = [];
    for (const o of owners) {
      const s = this.ownersAt.get(o);
      if (s === undefined) continue;
      const p = this.player(s);
      if (p && p.vip !== vip) theirs.push(p.vip);
    }
    if (owners.length === 0) this.friends_.delete(vip);
    else this.friends_.set(vip, owners.slice());
    for (const v of theirs) {
      let l = this.friends_.get(v);
      if (!l) {
        l = [];
        this.friends_.set(v, l);
      }
      if (!l.includes(me) && l.length < FRIENDS_MAX) l.push(me);
    }
    for (const v of [vip, ...theirs]) {
      const f = this.friends_.get(v);
      for (const p of this.slots) if (p && p.vip === v) p.friendIds = friendIds(p.owner, f, p.seat2);
    }
  }

  /** browser vip's page plays in the room of this name */
  roomName(vip, name) {
    this.roomNames.set(vip, Array.from(name).slice(0, 64).join(''));
  }

  /** The player of browser vip is linked now with one under name, its car near (hub.rs linked_with): [vip, owner] or null */
  linkedWith(vip, name) {
    const canon = canonical(name);
    if (canon == null) return null;
    for (const p of this.slots) {
      if (!p || p.vip !== vip || p.impostor) continue;
      for (const l of p.links) {
        const q = this.player(l.slot);
        if (!q) continue;
        let near = false;
        if (p.p !== null && q.p !== null) {
          const a = p.p, b = q.p;
          const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
          near = dx * dx + dy * dy + dz * dz <= FRIEND_NEAR_M * FRIEND_NEAR_M;
        }
        if (q.canon === canon && !q.impostor && q.vip !== vip && near) return [q.vip, q.owner];
      }
    }
    return null;
  }

  /** The race lobby the player of browser vip hosts, open now (hub.rs hosted) */
  hosted(vip) {
    const now = this.now();
    const mine = this.perVip.get(vip);
    if (!mine) return null;
    for (const s of mine) {
      const p = this.player(s);
      if (!p || p.vip !== vip || p.seat2 || p.impostor || p.lobby === null) continue;
      const [l, t] = p.lobby;
      const open = now - t <= LOBBY_STALE_MS && l.state === 0 && l.n >= 1 && l.ids[0] === p.id;
      if (open) return { host: p.id, lobby: l.id, race: l.race, n: l.n, max: l.max, room: p.room };
    }
    return null;
  }

  /** Where each of these keyphrases plays in free roam (as of the last tick) */
  whereabouts(owners) {
    return owners.map((o) => {
      const s = this.ownersAt.get(o);
      if (s === undefined) return null;
      const p = this.player(s);
      if (!p) return null;
      return { room: p.room, roomName: this.roomNames.has(p.vip) ? this.roomNames.get(p.vip) : null };
    });
  }

  /** browser vip's page goes by name on the switch */
  pageName(vip, name) {
    this.pages.set(vip, { name, told: [], coop: [], flew: false });
    for (const s of (this.perVip.get(vip) || []).slice()) this.nameCheck(s);
  }

  /** Browser vip's game says its car was in the air in free roam for secs (hub.rs flew) */
  flew(vip, secs) {
    const page = this.pages.get(vip);
    if (page && page.flew) return;
    let pageName = null;
    if (page) {
      page.flew = true;
      pageName = page.name;
    }
    let me = null;
    for (const p of this.players()) {
      if (p.vip === vip && p.p !== null && (me === null || p.posAt >= me.posAt)) me = p;
    }
    let name, at;
    if (me) {
      name = me.name;
      at = [me.p, me.room];
    } else if (pageName !== null) {
      name = pageName;
      at = null;
    } else {
      name = '';
      at = null;
    }
    let place;
    if (at) {
      const [a, room] = at;
      let seen = 0;
      for (const o of this.players()) {
        if (o.vip !== vip && o.room === room && (o.status === 2 || o.status === 5) && o.p !== null && hypot(o.p[0] - a[0], o.p[1] - a[1]) < FLEW_SEEN_M) seen++;
      }
      place = ', last at ' + fixed(a[0], 0) + ' ' + fixed(a[1], 0) + ' ' + fixed(a[2], 0) + ', ' + seen + ' other player' + (seen === 1 ? '' : 's') + ' within ' + fixed(FLEW_SEEN_M, 0) + ' m';
    } else {
      place = ', not on the hub now';
    }
    this.st.cheatLines++;
    const s = Number.isFinite(secs) ? Math.min(Math.max(secs, 0.0), 86400.0) : 0.0;
    this.log('[cheat] ' + vipStr(vip) + ' "' + printable(name, 32) + '": its car was in the air in free roam for ' + fixed(s, 0) + ' s, by its own game' + place + ': its page left the switch');
  }

  /** The name over the car of the player in slot against its page's on the switch (hub.rs name_check) */
  nameCheck(slot) {
    const p = this.player(slot);
    if (!p) return;
    const page = this.pages.get(p.vip);
    if (!page) return;
    if (p.name === '' || sameName(page.name, p.name)) return;
    const isSecond = (n) => {
      const s = second(n);
      return s != null && eqIgnoreAsciiCase(s, p.canon);
    };
    const now = Math.trunc(this.now());
    const claimed = () => {
      if (p.owner == null || this.claims == null) return false;
      const mine = this.claims.mine(p.owner, now);
      return mine != null && isSecond(mine.name);
    };
    if (p.seat2 && (isSecond(page.name) || claimed())) {
      if (page.coop.length < NAME_LINES && !page.coop.includes(p.name)) {
        page.coop.push(p.name);
        this.log('[roam] ' + vipStr(p.vip) + ' "' + printable(page.name, 32) + '": its second player (co-op) shows "' + printable(p.name, 32) + '" over its car');
      }
      return;
    }
    if (page.told.length >= NAME_LINES || page.told.includes(p.name)) return;
    page.told.push(p.name);
    this.log('[roam] ' + vipStr(p.vip) + ' "' + printable(page.name, 32) + '": its game shows "' + printable(p.name, 32) + '" over its car');
  }

  /** the names over the cars of the players that are not their pages' on the switch, by browser */
  otherNames() {
    const by = new Map();
    for (const p of this.players()) {
      if (p.name === '') continue;
      const g = this.pages.get(p.vip);
      if (g && sameName(g.name, p.name)) continue;
      let names = by.get(p.vip);
      if (!names) {
        names = [];
        by.set(p.vip, names);
      }
      if (!names.includes(p.name)) names.push(p.name);
    }
    return by;
  }

  /** whether the players in slots a and b (p and q) are kept apart (hub.rs apart_from) */
  apartFrom(a, b, p, q) {
    return this.blocks_.size > 0 && (bsearch(this.apart, pairKey(Math.min(a, b), Math.max(a, b))) || blocked(this.blocks_, p, q));
  }

  /** every tickMs: who is linked to whom, and every player's list (hub.rs tick) */
  tick() {
    const now = this.now();
    this.adjust(now);
    const goneMs = this.o.goneMs;
    const gone = [];
    for (const s of this.order) {
      const p = s === NONE ? null : this.player(s);
      if (p && now - p.seen > goneMs) gone.push(s);
    }
    this.dropSlots(gone, true);
    this.purge();
    for (const [k, t] of [...this.mapAt]) if (!(now < t)) this.mapAt.delete(k);
    for (const [k, t] of [...this.lobbiesAt]) if (!(now < t)) this.lobbiesAt.delete(k);
    for (const [k, m] of [...this.maps]) if (!(now - m.at < MAP_KEEP_MS)) this.maps.delete(k);
    this.mapCands.clear();
    for (const [k, t] of [...this.nearAt]) if (!(now < t)) this.nearAt.delete(k);
    for (const [k, m] of [...this.nears]) if (!(now - m.at < MAP_KEEP_MS)) this.nears.delete(k);
    this.nearGrid = null;
    if (now - this.joinedPruned >= 60000.0) {
      this.joinedPruned = now;
      for (const [k, j] of [...this.joined]) if (!(now - j.at < JOINED_KEEP_MS)) this.joined.delete(k);
      for (const [v, ls] of [...this.joinedByVip]) {
        const left = ls.filter((l) => this.joined.has(l));
        if (left.length === 0) this.joinedByVip.delete(v);
        else this.joinedByVip.set(v, left);
      }
    }
    const goneForGood = [];
    for (const [k, w] of [...this.kept]) {
      if (now - w.at < WATCH_KEEP_MS) continue;
      const line = w.watch.summary(Math.floor(k / 65536), w.name, w.at, true);
      if (line != null) goneForGood.push(line);
      this.kept.delete(k);
    }
    for (const line of goneForGood) {
      this.st.cheatLines++;
      this.log(line);
    }
    for (const [o, v] of this.results.judged(now)) {
      const who = (id) => (o.names.has(id) ? o.names.get(id) : 'player ' + hex8(id));
      const result = results.resultLine(o, who);
      const cheats = [];
      if (v) cheats.push(results.line(v, who));
      for (const j of o.jumps) cheats.push(results.jumpLine(o, j, who));
      this.log(result);
      for (const line of cheats) {
        this.st.cheatLines++;
        this.log(line);
      }
    }
    for (const slot of this.order) {
      const p = slot === NONE ? null : this.player(slot);
      if (!p) continue;
      const line = p.watch.summary(p.vip, p.name, now, false);
      if (line != null) {
        this.st.cheatLines++;
        this.log(line);
      }
    }
    if (this.claims) for (const b of this.blocks_.values()) b.ownersOf(this.claims, now);
    this.apart = [];

    const s = this.s;
    s.roomOf.clear();
    this.ownersAt.clear();
    const rooms = [];
    let dueling = 0;
    for (const slot of this.order) {
      const p = slot === NONE ? null : this.player(slot);
      if (!p) continue;
      if (p.p === null || now - p.posAt > this.o.staleMs || p.impostor) continue;
      dueling += p.duel !== 0 ? 1 : 0;
      if (p.owner != null && !p.seat2) this.ownersAt.set(p.owner, slot);
      let r = s.roomOf.get(p.room);
      if (r === undefined) {
        r = rooms.length;
        rooms.push([]);
        s.roomOf.set(p.room, r);
      }
      rooms[r].push(slot);
    }
    s.ow.goneOut = [];
    s.fresh = new Array(this.slots.length);
    for (let i = 0; i < this.slots.length; i++) s.fresh[i] = [];
    s.local = new Uint32Array(this.slots.length).fill(NONE);
    const level = new Level(this.o.levelSlackM, this.o.levelGrade, this.o.levelK);
    const w = {
      now, holdMs: this.o.holdMs, keep: this.o.keep, nearM: this.o.nearM, nearHoldMs: this.o.nearHoldMs, nearFast: this.o.nearFast, level,
    };
    let duelLinks = 0, lobbyLinks = 0, crewLinks = 0, crewSkips = 0, onewayLinks = 0;
    for (const list of rooms) {
      prepare(this.slots, list, this.cap, this.o, now, s);
      if (dueling > 1) duelPairs(this.slots, list, s);
      else s.dpairs = [];
      lobbyPairs(this.slots, list, now, s);
      blockPairs(this.slots, list, this.blocks_, s);
      for (const [a, b] of s.bpairs) {
        const x = list[a], y = list[b];
        this.apart.push(pairKey(Math.min(x, y), Math.max(x, y)));
      }
      if (this.crewed > 0 || this.friends_.size > 0) crewSkips += crewPairs(this.slots, list, w, s);
      else s.cpairs = [];
      let allNew = list.length >= 2;
      if (allNew) for (const slot of list) if (!(this.slots[slot] && this.slots[slot].oneway)) allNew = false;
      let made;
      if (allNew) made = linkFirst(this.slots, list, w, s);
      else if (list.length > this.o.exactRoom) made = linkMany(this.slots, list, w, s);
      else made = linkEveryPair(this.slots, list, w, s);
      duelLinks += made[0];
      lobbyLinks += made[1];
      crewLinks += made[2];
      onewayLinks += oneWay(this.slots, list, this.cap >= this.o.degree, this.o, w, s);
      for (const slot of list) s.local[slot] = NONE;
    }
    this.apart.sort((a, b) => a - b);
    this.st.duelLinks = duelLinks;
    this.st.lobbyLinks = lobbyLinks;
    this.st.crewLinks = crewLinks;
    this.st.crewSkips = crewSkips;
    this.st.onewayLinks = onewayLinks;
    this.nearLine(now);
    this.lists();
    this.st.ticks++;
  }

  /** every NEAR_SAY_MS: how many of the cars players got from near went, and why (hub.rs near_line) */
  nearLine(now) {
    if (this.nearSaidAt === 0.0) this.nearSaidAt = now;
    if (now - this.nearSaidAt < NEAR_SAY_MS) return;
    const g = this.s.ow.gone;
    const d = g.map((a, i) => a - this.nearSaid[i]);
    let all = 0;
    for (const x of d) all += x;
    const mins = (now - this.nearSaidAt) / 60000.0;
    this.nearSaid = g.slice();
    this.nearSaidAt = now;
    const [a, b, c] = this.st.txOnly;
    if (a + b + c > 0) {
      this.log(
        '[roam] one-way links at the last tick: ' + (a + b + c) + " (a player gets the other's car, the other none of its): " + a +
          ' near, ' + b + ' past ' + numberToString(wire.FAR_M) + ' m, ' + c + ' past ' + numberToString(wire.VERYFAR_M) +
          ' m (a core of 16 and up sends those every 4th and 10th car state)',
      );
    }
    if (all === 0) return;
    const names = ["the player's links full", "its player's sends full", 'a list full', 'off free roam', 'left the room', 'other'];
    const why = [];
    for (let i = 0; i < d.length; i++) if (d[i] > 0) why.push(names[i] + ' ' + d[i]);
    this.log(
      '[roam] cars within ' + numberToString(NEAR_GONE_M) + ' m of a player that went in the last ' + numberToString(jsRound(mins)) +
        ' min: ' + all + ' (' + fixed(all / Math.max(mins, 1e-9), 1) + ' a minute): ' + why.join(', '),
    );
  }

  /** every player's new links in place, and its PEERS list sent (hub.rs lists) */
  lists() {
    const now = this.now();
    const lookS = this.o.lookMs / 1000.0;
    const s = this.s;
    const goneOut = s.ow.goneOut;
    goneOut.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    this.st.txOnly = [0, 0, 0];
    const slots = this.slots;
    for (const slot of this.order) {
      const p = slot === NONE ? null : slots[slot];
      if (!p) continue;
      const links = s.fresh[slot];
      const mine = this.crewed > 0 ? crewsOf(p) : [];
      const befriended = p.marks && p.friendIds.length > 0;
      const oneway = p.oneway && links.some((l) => l.dir !== DIR_BOTH);
      const hints = [];
      if (oneway) {
        let far = 0;
        for (let k = 0; k < links.length; k++) {
          const l = links[k];
          if (l.dir !== DIR_SEND) continue;
          const q = slots[l.slot];
          const code = q ? farCode(p, q, now, lookS) : 1;
          this.st.txOnly[code === 1 ? 0 : code === 4 ? 1 : 2]++;
          if (p.hints && code > 1 && k < wire.LIST_MAX) {
            if (far === 0) hints.push(0);
            far++;
            hints.push(k | (code > 4 ? wire.HINT_VERYFAR : 0));
          }
        }
        if (far > 0) hints[0] = far;
      }
      let gone = [];
      if (p.hints) {
        const a = partitionPoint(goneOut, (e) => e[0] < slot), z = partitionPoint(goneOut, (e) => e[0] <= slot);
        gone = goneOut.slice(a, z);
      }
      if (hints.length > 0 || gone.length > 0) {
        if (hints.length === 0) hints.push(0);
        const g = gone.slice(0, Math.min(gone.length, wire.GONE_MAX));
        hints.push(g.length);
        for (const [, id, why] of g) {
          hints.push(id & 255, (id >>> 8) & 255, (id >>> 16) & 255, id >>> 24);
          hints.push(why + 1);
        }
      }
      const withMarks = mine.length > 0 || befriended || oneway || hints.length > 0;
      const marks = [];
      if (withMarks) {
        for (const l of links) {
          const way = l.dir === DIR_RECV ? wire.MARK_RXONLY : l.dir === DIR_SEND ? wire.MARK_TXONLY : 0;
          const q = slots[l.slot];
          let mk = 0;
          if (q) {
            let crews = 0;
            for (let c = 0; c < mine.length; c++) if (q.crews.includes(mine[c])) crews |= 1 << c;
            const friend = befriended && friendsBoth(p, q);
            mk = crews | (friend ? wire.MARK_FRIEND : 0);
          }
          marks.push(way | mk);
        }
      }
      const n = withMarks ? wire.peersCrewLen(links.length, mine.length) + hints.length : wire.peersLen(links.length);
      const f = this.newFrame(p.vip, p.port, p.hubPort, n);
      const list = links.map((l) => {
        const q = slots[l.slot];
        return q ? { vip: q.vip, port: q.port, id: q.id } : { vip: 0, port: 0, id: 0 };
      });
      wire.writePeers(f.subarray(F_DATA), this.id, this.seq, list, mine, marks, hints);
      this.seq = (this.seq + 1) & 0xffff;
      if (this.send(p.vip, f)) this.st.lists++;
    }
    for (const slot of this.order) {
      const p = slot === NONE ? null : slots[slot];
      if (p) {
        p.links = s.fresh[slot];
        s.fresh[slot] = [];
      }
    }
  }

  /** the cap on the links: a quarter down while the server is busy, 2 up once it has room again (hub.rs adjust) */
  adjust(now) {
    const busy = this.busy();
    const old = this.cap;
    let top = -1;
    for (const p of this.players()) if (p.degree > top) top = p.degree;
    if (top < 0) top = this.o.degree;
    let was = old;
    this.st.busy = jsRound(busy * 100.0);
    const o = this.o;
    if (busy > o.busyHigh && now - this.capAt >= o.capDownMs) {
      was = Math.min(old, Math.max(top, o.minDegree));
      this.cap = Math.max(Math.min(o.minDegree, o.degree), Math.floor((was * 3) / 4));
    } else if (busy < o.busyLow && now - this.capAt >= o.capUpMs) {
      this.cap = Math.min(o.degree, this.cap + 2);
    }
    if (this.cap === old) return;
    this.capAt = now;
    if (this.cap < was) this.st.capCuts++;
    this.log('[roam] the server\'s thread was ' + numberToString(this.st.busy) + ' % busy: at most ' + this.cap + ' links a player (was ' + was + ')');
  }

  /** how busy the hub's own thread was over the last second, 0 to 1 (the minimap's answers come less often) */
  setThreadBusy(busy) {
    this.threadBusy = Number.isFinite(busy) ? Math.min(Math.max(busy, 0.0), 1.0) : 0.0;
  }

  /** free roam is busy: the cap is under askCap */
  crowded() {
    return this.cap < this.o.askCap;
  }

  /** the browsers in free roam now */
  vips() {
    const out = new Set();
    for (const p of this.players()) out.add(p.vip);
    return out;
  }

  /** how many browsers drive in free roam now, or paused there */
  inRoam() {
    const out = new Set();
    for (const p of this.players()) if (p.status === 2 || p.status === 5) out.add(p.vip);
    return out.size;
  }

  /** how many second players of co-op free roam drive there now, or paused there */
  coopSeats() {
    let n = 0;
    for (const p of this.players()) if (p.seat2 && (p.status === 2 || p.status === 5) && !p.impostor) n++;
    return n;
  }

  /** inRoam() by room: Map<room, count> */
  inRooms() {
    const seen = new Set();
    const n = new Map();
    for (const p of this.players()) {
      if (!((p.status === 2 || p.status === 5) && !p.impostor)) continue;
      const k = p.room + ":" + p.vip;
      if (!seen.has(k)) {
        seen.add(k);
        n.set(p.room, (n.get(p.room) || 0) + 1);
      }
    }
    return n;
  }

  /** inRoam() by crew, in any room: [[crew, browsers], ...] in the order of the crews' numbers (hub.rs crew_counts) */
  crewCounts() {
    if (this.crewed === 0) return [];
    const pairs = [];
    for (const p of this.players()) {
      if (!((p.status === 2 || p.status === 5) && !p.impostor)) continue;
      for (const c of crewsOf(p)) pairs.push([c, p.vip]);
    }
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out = [];
    for (let i = 0; i < pairs.length; i++) {
      if (i > 0 && pairs[i][0] === pairs[i - 1][0] && pairs[i][1] === pairs[i - 1][1]) continue;
      if (out.length > 0 && out[out.length - 1][0] === pairs[i][0]) out[out.length - 1][1]++;
      else out.push([pairs[i][0], 1]);
    }
    return out;
  }

  /** inRoam() in each of these crews (any room), in their order */
  inCrews(crews) {
    const counts = this.crewCounts();
    return crews.map((c) => crewCount(counts, c));
  }

  /** counts for the tests and the switch's info() (hub.rs info) */
  info() {
    let linked = 0, links = 0;
    for (const p of this.players()) {
      const n = this.dead.length === 0 ? p.links.length : p.links.filter((l) => this.live(l)).length;
      if (n > 0) linked++;
      links += n;
    }
    const st = this.st;
    return {
      players: this.byKey.size,
      linked,
      links: links / 2.0,
      cap: this.cap,
      frames: st.frames,
      bad: st.bad,
      refused: st.refused,
      lists: st.lists,
      ticks: st.ticks,
      tickMsMax: st.tickMsMax,
      busy: st.busy,
      capCuts: st.capCuts,
      duelLinks: st.duelLinks,
      lobbyLinks: st.lobbyLinks,
      crewLinks: st.crewLinks,
      crewSkips: st.crewSkips,
      onewayLinks: st.onewayLinks,
      txOnly: st.txOnly.slice(),
      nearGone: this.s.ow.gone.slice(),
      raceReports: st.raceReports,
      cheatLines: st.cheatLines,
      carBans: st.carBans,
      nears: st.nears,
      threadBusy: this.threadBusy,
      watchesKept: this.kept.size,
      mapKeys: MAP_KEYS - this.mapFree.length,
      blocking: this.blocks_.size,
      keptApart: this.apart.length,
      coopSeats: this.coopSeats(),
    };
  }

  /** each pair of browsers linked now, once (the lower address first), sorted (hub.rs link_pairs) */
  linkPairs() {
    const v = [];
    for (const p of this.players()) {
      for (const l of p.links) {
        if (!this.live(l)) continue;
        const o = this.player(l.slot);
        if (!o || o.vip === p.vip) continue;
        v.push([Math.min(p.vip, o.vip), Math.max(p.vip, o.vip)]);
      }
    }
    v.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return v.filter((x, i) => i === 0 || v[i - 1][0] !== x[0] || v[i - 1][1] !== x[1]);
  }

  /** each player's links now, by vip:port, for the tests */
  links() {
    const name = (p) => p.vip + ':' + p.port;
    const out = [];
    for (const p of this.players()) {
      const to = [];
      for (const l of p.links) {
        if (!this.live(l)) continue;
        const q = this.player(l.slot);
        if (q) to.push(name(q));
      }
      out.push([name(p), to]);
    }
    return out;
  }
}

/** a crew's count in crewCounts' table (0: none) */
export function crewCount(counts, crew) {
  let lo = 0, hi = counts.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (counts[m][0] < crew) lo = m + 1;
    else hi = m;
  }
  return lo < counts.length && counts[lo][0] === crew ? counts[lo][1] : 0;
}

function newMapHeld() {
  return { held: null, sent: null, at: 0, cands: [], candsOf: null, candK: [], candNth: 0 };
}

/** What one tick needs (hub.rs Scratch); walkUsed and ow.gone are kept from tick to tick */
function newScratch() {
  return {
    roomOf: new Map(),
    fresh: [],
    local: new Uint32Array(0),
    pos: [], now: [], speed: [], soon: [], ahead: [], view: [], deg: [], vips: [], newcore: [], ccap: [],
    dpairs: [], lpairs: [], lmembers: [],
    bpairs: [], bstart: [], bnext: [],
    cpairs: [],
    walkUsed: [],
    ow: { gone: [0, 0, 0, 0, 0, 0], goneOut: [] },
  };
}

function player(slots, slot) {
  const p = slots[slot];
  return p === undefined ? null : p;
}

/** the place in the room of the player in slot (null: not in this room) */
function local(at, slot) {
  if (slot >= at.length) return null;
  const j = at[slot];
  return j === NONE ? null : j;
}

/** a link made: both ends list each other */
function join(fresh, a, b, since) {
  fresh[a].push({ slot: b, since, dir: DIR_BOTH });
  fresh[b].push({ slot: a, since, dir: DIR_BOTH });
}

/** since when the players in slots a and b are linked: since the link of the last tick, or now */
function sinceOf(slots, a, b, now) {
  const p = player(slots, a);
  if (p) for (const l of p.links) if (l.slot === b) return l.since;
  return now;
}

function linkedIn(fresh, a, b) {
  for (const l of fresh[a]) if (l.slot === b) return true;
  return false;
}

/** how far apart places i and j of a room count (hub.rs apart) */
function apartOf(soon, ahead, view, i, j, l) {
  let d = weigh(soon[i], soon[j], l);
  const b = weigh(ahead[i], ahead[j], l);
  if (b < d) d = b;
  const c = weigh(view[i], soon[j], l);
  if (c < d) d = c;
  const e = weigh(view[j], soon[i], l);
  if (e < d) d = e;
  return d;
}

/** a link of the last tick: younger than holdMs before every new one, older at keep its distance (hub.rs old_key) */
function oldKey(soon, ahead, view, i, j, since, w) {
  return w.now - since < w.holdMs ? -1.0 : apartOf(soon, ahead, view, i, j, w.level) * w.keep;
}

/** A room's players by their place in its list: where the links weigh them (hub.rs prepare) */
function prepare(slots, list, cap, o, now, s) {
  const m = list.length;
  s.pos = new Array(m);
  s.now = new Array(m);
  s.speed = new Float64Array(m);
  s.soon = new Array(m);
  s.ahead = new Array(m);
  s.view = new Array(m);
  s.deg = new Int32Array(m);
  s.vips = new Float64Array(m);
  s.newcore = new Uint8Array(m);
  s.ccap = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    const slot = list[i];
    const p = player(slots, slot);
    let at = [0, 0, 0], v = [0, 0, 0], status = 0, heading = 0, slope = 0, age = 0.0;
    if (p) {
      at = p.p !== null ? p.p : [0, 0, 0];
      v = p.v;
      status = p.status;
      heading = p.heading;
      slope = p.slope;
      age = (now - p.posAt) / 1000.0;
    }
    let view = 0.0;
    if (status === 2) view = o.viewM;
    else v = [0.0, 0.0, 0.0];
    const up = status === 2 || status === 5 ? 0.0 : o.awayM;
    age = age < 0.0 ? 0.0 : age > AGE_MAX_S ? AGE_MAX_S : age;
    const fx = headingCos(heading), fy = headingSin(heading), s1 = slope / 100.0;
    const along = v[0] * fx + v[1] * fy;
    const tAhead = age + o.lookMs / 1000.0;
    const ts = age + o.soonMs / 1000.0;
    const soon = [at[0] + v[0] * ts, at[1] + v[1] * ts, at[2], up];
    s.pos[i] = at;
    s.now[i] = [at[0] + v[0] * age, at[1] + v[1] * age, at[2], up];
    s.speed[i] = hypot(v[0], v[1]);
    s.soon[i] = soon;
    s.ahead[i] = [at[0] + v[0] * tAhead, at[1] + v[1] * tAhead, at[2] + s1 * along * tAhead, up];
    s.view[i] = [soon[0] + fx * view, soon[1] + fy * view, at[2] + s1 * (along * ts + view), up];
    s.deg[i] = p ? Math.min(p.degree, cap) : 0;
    s.vips[i] = p ? p.vip : 0;
    s.newcore[i] = p && p.oneway ? 1 : 0;
    s.ccap[i] = p ? crewCap(p.degree) : 0;
    s.local[slot] = i;
  }
}

/** The links outruns between players need before any other (hub.rs duel_pairs) */
function duelPairs(slots, list, s) {
  const dpairs = [];
  s.dpairs = dpairs;
  const dids = [];
  for (let j = 0; j < list.length; j++) {
    const p = player(slots, list[j]);
    if (p && p.duel !== 0) dids.push([p.id, j]);
  }
  if (dids.length < 2) return;
  dids.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [id, i] of dids) {
    const pi = player(slots, list[i]);
    if (!pi) continue;
    const want = pi.duel;
    for (let k = partitionPoint(dids, (e) => e[0] < want); k < dids.length && dids[k][0] === want; k++) {
      const j = dids[k][1];
      const q = player(slots, list[j]);
      if (i < j && q && q.duel === id) dpairs.push([i, j]);
    }
  }
}

/** The links a race lobby needs before any other (hub.rs lobby_pairs) */
function lobbyPairs(slots, list, now, s) {
  const pos = s.pos, vips = s.vips;
  const lpairs = [], lmembers = [], ljoin = [];
  s.lpairs = lpairs;
  s.lmembers = lmembers;
  let lids = null;
  for (let j = 0; j < list.length; j++) {
    const o = player(slots, list[j]);
    if (o && o.join !== null && now - o.join[1] <= LOBBY_JOIN_MS) ljoin.push([o.join[0], j]);
  }
  for (let i = 0; i < list.length; i++) {
    const slot = list[i];
    const p = player(slots, slot);
    if (!p || p.lobby === null) continue;
    const [l, t] = p.lobby;
    const x = l.x, y = l.y;
    const there = (j) => (pos[j][0] - x) * (pos[j][0] - x) + (pos[j][1] - y) * (pos[j][1] - y) <= LOBBY_STAY_M * LOBBY_STAY_M;
    if (now - t > LOBBY_STALE_MS || l.state > 1 || !there(i)) continue;
    if (lids === null) {
      lids = new Map();
      for (let j = 0; j < list.length; j++) {
        const o = player(slots, list[j]);
        if (o) lids.set(o.id, j);
      }
    }
    const asked = (j) => {
      const o = player(slots, list[j]);
      return o !== null && o.join !== null && o.join[0] === l.id;
    };
    const upto = Math.min(Math.max(l.n, 1), wire.LOBBY_PLAYERS);
    for (let k = 1; k < upto; k++) {
      const j = lids.get(l.ids[k]);
      if (j !== undefined && j !== i && (there(j) || asked(j))) {
        lpairs.push([i, j]);
        lmembers.push([i, j]);
      }
    }
    for (const [id, j] of ljoin) if (id === l.id && j !== i) lpairs.push([i, j]);
    const lnear = [];
    for (let j = 0; j < list.length; j++) {
      const q = player(slots, list[j]);
      if (j === i || vips[i] === vips[j] || !(q && (q.status === 2 || q.status === 5))) continue;
      if (l.private && !(p && q && mates(p, q))) continue;
      const d = (pos[j][0] - x) * (pos[j][0] - x) + (pos[j][1] - y) * (pos[j][1] - y);
      if (d <= LOBBY_NEAR_M * LOBBY_NEAR_M) lnear.push([d, j]);
    }
    lnear.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let k = 0; k < lnear.length && k < LOBBY_NEAR_MAX; k++) lpairs.push([i, lnear[k][1]]);
  }
}

function strCmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The pairs of a room kept apart (hub.rs block_pairs) */
function blockPairs(slots, list, blocks, s) {
  s.bpairs = [];
  s.bstart = [];
  s.bnext = [];
  if (blocks.size === 0) return;
  const of = (i) => {
    const p = player(slots, list[i]);
    return p ? blocks.get(p.vip) || null : null;
  };
  const bfrom = [];
  for (let i = 0; i < list.length; i++) if (of(i)) bfrom.push(i);
  if (bfrom.length === 0) return;
  const names = new Set(), owners = new Set();
  for (const i of bfrom) {
    const b = of(i);
    for (const n of b.names) names.add(n);
    for (const o of b.owners) owners.add(o);
  }
  const byName = [], byOwner = [];
  for (let j = 0; j < list.length; j++) {
    const q = player(slots, list[j]);
    if (!q) continue;
    if (names.has(q.canon)) byName.push([q.canon, j]);
    if (q.owner != null && owners.has(q.owner)) byOwner.push([q.owner, j]);
  }
  byName.sort((a, b) => strCmp(a[0], b[0]) || a[1] - b[1]);
  byOwner.sort((a, b) => strCmp(a[0], b[0]) || a[1] - b[1]);
  const withKey = (v, k) => {
    const out = [];
    for (let x = partitionPoint(v, (e) => e[0] < k); x < v.length && v[x][0] === k; x++) out.push(v[x][1]);
    return out;
  };
  const bpairs = [];
  for (const i of bfrom) {
    const b = of(i);
    const found = [];
    for (const n of b.names) found.push(...withKey(byName, n));
    for (const o of b.owners) found.push(...withKey(byOwner, o));
    for (const j of found) if (j !== i) bpairs.push([Math.min(i, j), Math.max(i, j)]);
  }
  const direct = bpairs.length;
  for (const [h, m] of s.lmembers) {
    for (let k = 0; k < direct; k++) {
      const [a, b] = bpairs[k];
      let x;
      if (a === m) x = b;
      else if (b === m) x = a;
      else continue;
      if (x !== h && !s.lmembers.some((e) => e[0] === h && e[1] === x)) bpairs.push([Math.min(h, x), Math.max(h, x)]);
    }
  }
  if (bpairs.length === 0) return;
  bpairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const dd = bpairs.filter((e, i) => i === 0 || bpairs[i - 1][0] !== e[0] || bpairs[i - 1][1] !== e[1]);
  s.bpairs = dd;
  const m = list.length;
  const bstart = new Array(m + 1).fill(0);
  for (const [a, b] of dd) {
    bstart[a + 1]++;
    bstart[b + 1]++;
  }
  for (let i = 0; i < m; i++) bstart[i + 1] += bstart[i];
  const bnext = new Array(bstart[m]).fill(0);
  const at = bstart.slice(0, m);
  for (const [a, b] of dd) {
    bnext[at[a]++] = b;
    bnext[at[b]++] = a;
  }
  s.bstart = bstart;
  s.bnext = bnext;
}

/** whether places a and b of the room are kept apart (hub.rs kept_apart) */
function keptApart(bstart, bnext, a, b) {
  if (bstart.length === 0) return false;
  for (let k = bstart[a]; k < bstart[a + 1]; k++) if (bnext[k] === b) return true;
  return false;
}

/** The crews' pairs, linked after the race lobbies' and before any other (hub.rs crew_pairs): the large crews skipped */
function crewPairs(slots, list, w, s) {
  const soon = s.soon, at = s.local;
  const cmembers = [];
  for (let j = 0; j < list.length; j++) {
    const p = player(slots, list[j]);
    if (!p) continue;
    for (const c of crewsOf(p)) cmembers.push([c, j]);
    for (const f of p.friendIds) cmembers.push([f, j]);
  }
  cmembers.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const m = list.length;
  const cmark = new Int32Array(m);
  const csince = new Float64Array(m);
  const keep2 = w.keep * w.keep;
  let stamp = 0, skipped = 0, g = 0;
  const cpairs = [];
  while (g < cmembers.length) {
    const crew = cmembers[g][0];
    let e = g;
    while (e < cmembers.length && cmembers[e][0] === crew) e++;
    if (e - g > CREW_GROUP_MAX) {
      skipped++;
      g = e;
      continue;
    }
    for (let x = g; x < e - 1; x++) {
      const i = cmembers[x][1];
      stamp++;
      const pi = player(slots, list[i]);
      if (pi) {
        for (const l of pi.links) {
          const j = local(at, l.slot);
          if (j !== null) {
            cmark[j] = stamp;
            csince[j] = l.since;
          }
        }
      }
      for (let y = x + 1; y < e; y++) {
        const j = cmembers[y][1];
        const sq = square(soon[i], soon[j], w.level);
        const d = cmark[j] !== stamp ? sq : w.now - csince[j] < w.holdMs ? -1.0 : sq * keep2;
        cpairs.push([d + 0.0, i, j]);
      }
    }
    g = e;
  }
  cpairs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  s.cpairs = cpairs.filter((e, i) => i === 0 || cpairs[i - 1][0] !== e[0] || cpairs[i - 1][1] !== e[1] || cpairs[i - 1][2] !== e[2]);
  return skipped;
}

/** The links made first, in a room whose players all take one-way links (hub.rs link_first) */
function linkFirst(slots, list, w, s) {
  const { deg, ccap, fresh, dpairs, lpairs, cpairs, bstart, bnext } = s;
  let duel = 0, made = 0;
  const firsts = dpairs.concat(lpairs);
  for (let k = 0; k < firsts.length; k++) {
    const [a, b] = firsts[k];
    const sa = list[a], sb = list[b];
    if (fresh[sa].length < deg[a] && fresh[sb].length < deg[b] && !linkedIn(fresh, sa, sb) && !keptApart(bstart, bnext, a, b)) {
      join(fresh, sa, sb, sinceOf(slots, sa, sb, w.now));
      if (k < dpairs.length) duel++;
      else made++;
    }
  }
  let crew = 0;
  if (cpairs.length > 0) {
    const ccount = new Int32Array(list.length);
    for (const [, a, b] of cpairs) {
      const sa = list[a], sb = list[b];
      if (ccount[a] < ccap[a] && ccount[b] < ccap[b] && fresh[sa].length < deg[a] && fresh[sb].length < deg[b] && !linkedIn(fresh, sa, sb) && !keptApart(bstart, bnext, a, b)) {
        join(fresh, sa, sb, sinceOf(slots, sa, sb, w.now));
        ccount[a]++;
        ccount[b]++;
        crew++;
      }
    }
  }
  return [duel, made, crew];
}

/** The links of a room of at most exactRoom players: every pair of them, nearest first (hub.rs link_every_pair) */
function linkEveryPair(slots, list, w, s) {
  const m = list.length;
  const { soon, ahead, view, deg, ccap, local: at, fresh, dpairs, lpairs, cpairs, bstart, bnext, vips } = s;
  let duel = 0, made = 0;
  const firsts = dpairs.concat(lpairs);
  for (let k = 0; k < firsts.length; k++) {
    const [a, b] = firsts[k];
    const sa = list[a], sb = list[b];
    if (fresh[sa].length < deg[a] && fresh[sb].length < deg[b] && !linkedIn(fresh, sa, sb) && !keptApart(bstart, bnext, a, b) && vips[a] !== vips[b]) {
      join(fresh, sa, sb, sinceOf(slots, sa, sb, w.now));
      if (k < dpairs.length) duel++;
      else made++;
    }
  }
  let crew = 0;
  if (cpairs.length > 0) {
    const ccount = new Int32Array(m);
    for (const [, a, b] of cpairs) {
      const sa = list[a], sb = list[b];
      if (
        ccount[a] < ccap[a] && ccount[b] < ccap[b] && fresh[sa].length < deg[a] && fresh[sb].length < deg[b] &&
        !linkedIn(fresh, sa, sb) && !keptApart(bstart, bnext, a, b) && vips[a] !== vips[b]
      ) {
        join(fresh, sa, sb, sinceOf(slots, sa, sb, w.now));
        ccount[a]++;
        ccount[b]++;
        crew++;
      }
    }
  }
  const first = duel + made + crew > 0;
  let npre = null;
  if (first) npre = list.map((slot) => fresh[slot].length);
  const madeFirst = (a, sa, sb) => {
    const f = fresh[sa];
    for (let x = 0; x < npre[a]; x++) if (f[x].slot === sb) return true;
    return false;
  };
  const pd = [], pa = [], pb = [], ps = [];
  const mark = new Int32Array(m);
  const since = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const a = player(slots, list[i]);
    if (!a) continue;
    const stamp = i + 1;
    for (const l of a.links) {
      const j = local(at, l.slot);
      if (j !== null) {
        mark[j] = stamp;
        since[j] = l.since;
      }
    }
    for (let j = i + 1; j < m; j++) {
      if (vips[i] === vips[j]) continue;
      const linked = mark[j] === stamp;
      const d = linked ? oldKey(soon, ahead, view, i, j, since[j], w) : apartOf(soon, ahead, view, i, j, w.level);
      pd.push(d + 0.0);
      pa.push(i);
      pb.push(j);
      ps.push(linked ? since[j] : w.now);
    }
  }
  // a stable sort by d: at one d, the pairs in the order they were weighed (links.rs sort_stable)
  const n = pd.length;
  const order = new Array(n);
  for (let k = 0; k < n; k++) order[k] = k;
  order.sort((x, y) => pd[x] - pd[y] || x - y);
  let open = 0;
  for (let i = 0; i < m; i++) if (fresh[list[i]].length < deg[i]) open++;
  for (const k of order) {
    if (open < 2) break;
    const a = pa[k], b = pb[k];
    const sa = list[a], sb = list[b];
    if (fresh[sa].length < deg[a] && fresh[sb].length < deg[b] && (!first || !madeFirst(a, sa, sb)) && !keptApart(bstart, bnext, a, b)) {
      join(fresh, sa, sb, ps[k]);
      open -= (fresh[sa].length === deg[a] ? 1 : 0) + (fresh[sb].length === deg[b] ? 1 : 0);
    }
  }
  return [duel, made, crew];
}

/** a sorted array of [a, b] pairs: whether it has (a, b) */
function hasPair(v, a, b) {
  let lo = 0, hi = v.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const e = v[mid];
    if (e[0] < a || (e[0] === a && e[1] < b)) lo = mid + 1;
    else hi = mid;
  }
  return lo < v.length && v[lo][0] === a && v[lo][1] === b;
}

/** What a receiver's candidates are read from (hub.rs Gather) */
class Gather {
  constructor(c) {
    Object.assign(this, c);
  }

  /** read of receivers news[k] for each k of ks (hub.rs Gather::read_all: one thread here) */
  readAll(ks, more, got, m, out) {
    const n = this.news.length;
    const b = { stamp: new Uint32Array(n), ostamp: new Uint32Array(m), osince: new Float64Array(m), odir: new Uint8Array(m) };
    this.read(ks, more, got, b, out);
  }

  /** where receiver i's link with sender j goes in the order (hub.rs Gather::key; had: since when, or null) */
  key(i, j, d, had) {
    const w = this.w;
    const dn = weigh(this.now[i], this.now[j], w.level);
    const near = dn < w.nearM && this.speed[i] < w.nearFast;
    if (had !== null) {
      if (near && w.now - had < Math.max(w.nearHoldMs, w.holdMs)) return KEY_HELD + dn;
      if (near) return KEY_NEAR + dn * w.keep;
      if (w.now - had < w.holdMs) return KEY_FAR_HELD + d;
      return d * w.keep;
    }
    if (near) return KEY_NEAR + dn;
    return d;
  }

  both(i, j) {
    return !this.newcore[i] || !this.newcore[j] || hasPair(this.kept, Math.min(i, j), Math.max(i, j));
  }

  /** the candidates of receivers news[k] for k in ks: [key, receiver, sender, since (0: new)] into out (hub.rs Gather::read) */
  read(ks, more, got, b, out) {
    const w = this.w;
    const { soon, ahead, view } = this;
    for (const k of ks) {
      const i = this.news[k];
      const want = this.deg[i] === 0 ? 0 : this.deg[i] + more;
      if (want === 0) continue;
      const cand = [];
      for (let walk = 0; walk < 3; walk++) {
        if (walk === 2 && samePlace(view[i], soon[i])) continue;
        const [g, pos] = walk === 1 ? [this.gridA, this.pahead] : [this.grid, this.psoon];
        const near = walk === 2 ? new Near(g, view[i], k, new Found()) : Near.of(g, pos, k, new Found());
        let gotN = 0;
        while (gotN < want) {
          const e = near.next(g, pos);
          if (e === null) break;
          cand.push(e);
          gotN++;
        }
      }
      cand.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      const stamp = k + 1;
      const pl = player(this.slots, this.list[i]);
      const old = pl ? pl.links : [];
      for (const l of old) {
        const j = local(this.at, l.slot);
        if (j !== null) {
          b.ostamp[j] = stamp;
          b.osince[j] = l.since;
          b.odir[j] = l.dir;
        }
      }
      let taken = 0;
      for (let idx = 0; idx < cand.length; idx++) {
        if (taken === want) break;
        const [d, jj] = cand[idx];
        if (b.stamp[jj] === stamp) continue;
        b.stamp[jj] = stamp;
        taken++;
        const j = this.news[jj];
        if (this.both(i, j) || keptApart(this.bstart, this.bnext, i, j) || (got.length > 0 && hasPair(got, i, j))) continue;
        const was = b.ostamp[j] === stamp;
        const had = was && (b.odir[j] & DIR_RECV) !== 0 ? b.osince[j] : null;
        const key = this.key(i, j, d, had);
        out.push([key + 0.0, i, j, was ? b.osince[j] : 0]);
      }
      if (got.length === 0) {
        for (const l of old) {
          if ((l.dir & DIR_RECV) === 0) continue;
          const j = local(this.at, l.slot);
          if (j === null) continue;
          if (j === i || !this.newcore[j] || this.both(i, j) || keptApart(this.bstart, this.bnext, i, j)) continue;
          const jj = partitionPoint(this.news, (x) => x < j);
          if (b.stamp[jj] === stamp) continue;
          let d = weigh(soon[i], soon[j], w.level);
          const d2 = weigh(ahead[i], ahead[j], w.level);
          if (d2 < d) d = d2;
          const d3 = weigh(view[i], soon[j], w.level);
          if (d3 < d) d = d3;
          const key = this.key(i, j, d, l.since);
          out.push([key + 0.0, i, j, l.since]);
        }
      }
    }
  }
}

function edgeCmp(x, y) {
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3];
}

/** One-way links (a core of version 15 and up), after the links of either function above (hub.rs one_way) */
function oneWay(slots, list, full, o, w, s) {
  const m = list.length;
  const { pos, now, speed, soon, ahead, view, deg, newcore, vips, local: at, fresh, dpairs, lpairs, cpairs, bstart, bnext, ow } = s;
  const news = [];
  for (let i = 0; i < m; i++) if (newcore[i]) news.push(i);
  ow.news = news;
  ow.skips = [];
  if (news.length < 2) return 0;
  const sends = (i) => (full ? Math.max(deg[i], o.sends) : deg[i]);
  let kept = [];
  for (const [a, b] of dpairs.concat(lpairs)) kept.push([Math.min(a, b), Math.max(a, b)]);
  for (const [, a, b] of cpairs) kept.push([Math.min(a, b), Math.max(a, b)]);
  kept.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  kept = kept.filter((e, i) => i === 0 || kept[i - 1][0] !== e[0] || kept[i - 1][1] !== e[1]);
  kept = kept.filter(([a, b]) => linkedIn(fresh, list[a], list[b]));
  const both = (i, j) => !newcore[i] || !newcore[j] || hasPair(kept, Math.min(i, j), Math.max(i, j));
  for (const i of news) {
    const sl = list[i];
    fresh[sl] = fresh[sl].filter((l) => {
      const j = local(at, l.slot);
      return j === null || both(i, j);
    });
  }
  const inn = new Int32Array(m), out = new Int32Array(m), listed = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    const n = fresh[list[i]].length;
    inn[i] = n;
    out[i] = n;
    listed[i] = n;
  }
  const psoon = news.map((i) => soon[i]);
  const pahead = news.map((i) => ahead[i]);
  const grid = new Grid(), gridA = new Grid();
  grid.build(psoon, w.level);
  gridA.build(pahead, w.level);
  const ctx = new Gather({
    news, psoon, pahead, grid, gridA, now, speed, soon, ahead, view, deg, newcore, at, list, slots, w, kept, bstart, bnext,
  });
  let edges = [];
  const ks0 = news.map((_, k) => k);
  ctx.readAll(ks0, ONEWAY_MORE, [], m, edges);
  edges.sort(edgeCmp);
  const pairs = new Set();
  const base = list.map((slot) => fresh[slot].length);
  const got = [];
  const skips = ow.skips;
  for (let round = 0; round < 2; round++) {
    if (round === 1) {
      const ks = [];
      for (let k = 0; k < news.length; k++) if (inn[news[k]] < deg[news[k]]) ks.push(k);
      if (ks.length === 0) break;
      got.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      edges = [];
      ctx.readAll(ks, ONEWAY_FAR, got, m, edges);
      edges.sort(edgeCmp);
    }
    for (const [, i, j, since0] of edges) {
      if (vips[i] === vips[j]) continue;
      if (inn[i] >= deg[i] || out[j] >= sends(j)) {
        if (since0 !== 0) skips.push([i, j, inn[i] >= deg[i] ? GONE_RX_FULL : GONE_TX_FULL]);
        continue;
      }
      const pk = pairKey(Math.min(i, j), Math.max(i, j));
      if (!pairs.has(pk)) {
        if (listed[i] >= wire.LIST_MAX || listed[j] >= wire.LIST_MAX) {
          if (since0 !== 0) skips.push([i, j, GONE_LIST_FULL]);
          continue;
        }
        pairs.add(pk);
        listed[i]++;
        listed[j]++;
      }
      const since = since0 === 0 ? w.now : since0;
      fresh[list[i]].push({ slot: list[j], since, dir: DIR_RECV });
      fresh[list[j]].push({ slot: list[i], since, dir: DIR_SEND });
      inn[i]++;
      out[j]++;
      if (round === 0) got.push([i, j]);
    }
  }
  nearGone(slots, list, pos, at, fresh, ow);
  let oneway = 0;
  for (const i of news) {
    const l = fresh[list[i]];
    const from = base[i];
    if (l.length - from < 2) {
      for (let x = from; x < l.length; x++) if (l[x].dir === DIR_RECV) oneway++;
      continue;
    }
    // (Rust's sort_unstable_by_key on Link, 16 bytes: equal slots, a link each way, in its order: rsort.js)
    const tail = l.slice(from);
    sortUnstable(tail, (x, y) => x.slot < y.slot, 16);
    let k = 0;
    for (let x = 1; x < tail.length; x++) {
      if (tail[x].slot === tail[k].slot) tail[k] = { slot: tail[k].slot, since: tail[k].since, dir: tail[k].dir | tail[x].dir };
      else {
        k++;
        tail[k] = tail[x];
      }
    }
    tail.length = k + 1;
    l.length = from;
    for (const x of tail) l.push(x);
    for (let x = from; x < l.length; x++) if (l[x].dir === DIR_RECV) oneway++;
  }
  return oneway;
}

/** The links of the last tick to a car within NEAR_GONE_M that no round made again (hub.rs near_gone) */
function nearGone(slots, list, pos, at, fresh, ow) {
  const skips = ow.skips;
  skips.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  for (const i of ow.news) {
    const p = player(slots, list[i]);
    if (!p || !(p.status === 2 || p.status === 5)) continue;
    const a = pos[i];
    for (const l of p.links) {
      if ((l.dir & DIR_RECV) === 0) continue;
      const q = player(slots, l.slot);
      if (!q || q.p === null) continue;
      const b = q.p;
      if (hypot(a[0] - b[0], a[1] - b[1]) >= NEAR_GONE_M) continue;
      const j = local(at, l.slot);
      if (j === null) {
        ow.gone[GONE_LEFT]++;
        ow.goneOut.push([list[i], q.id, GONE_LEFT]);
        continue;
      }
      if (fresh[list[i]].some((x) => x.slot === l.slot && (x.dir & DIR_RECV) !== 0)) continue;
      let why;
      if (!(q.status === 2 || q.status === 5)) why = GONE_AWAY;
      else {
        const k = partitionPoint(skips, (e) => e[0] < i || (e[0] === i && e[1] <= j));
        if (k > 0 && skips[k - 1][0] === i && skips[k - 1][1] === j) why = skips[k - 1][2];
        else why = GONE_OTHER;
      }
      ow.gone[why]++;
      ow.goneOut.push([list[i], q.id, why]);
    }
  }
}

function hasPlace(places, from, to, j) {
  for (let x = from; x < to; x++) if (places[x] === j) return true;
  return false;
}

/** The links of a room larger than exactRoom, as linkEveryPair makes them, without sorting every pair (hub.rs link_many) */
function linkMany(slots, list, w, s) {
  const m = list.length;
  const { soon, ahead, view, deg, ccap, local: at, fresh, dpairs, lpairs, cpairs, bstart, bnext, vips } = s;
  const grid = new Grid(), gridA = new Grid();
  grid.build(soon, w.level);
  gridA.build(ahead, w.level);
  const heap = new Heap();
  // every player's walks read ahead: as far as each one went at the last tick and a quarter more, its links at most
  const want = new Uint16Array(m * 3);
  let aheadN = 1;
  for (let i = 0; i < m; i++) {
    const most = Math.max(deg[i], 1);
    const used = s.walkUsed[list[i]] || [0, 0, 0];
    for (let wk = 0; wk < 3; wk++) {
      const went = used[wk];
      const v = went === 0 ? most : went - 1 + 2 + Math.floor((went - 1) / 4);
      const c = Math.min(Math.max(v, 1), most);
      want[3 * i + wk] = c;
      if (c > aheadN) aheadN = c;
    }
  }
  // (Walks::read on one thread: every place's three walks, what each gave so far in pre)
  const preD = new Float64Array(m * 3 * aheadN), preJ = new Uint32Array(m * 3 * aheadN), preN = new Uint16Array(m * 3);
  const near = new Array(m), nearA = new Array(m), nearV = new Array(m);
  for (let i = 0; i < m; i++) {
    const walks = [Near.of(grid, soon, i, new Found()), Near.of(gridA, ahead, i, new Found()), new Near(grid, view[i], i, new Found())];
    for (let wk = 0; wk < 3; wk++) {
      if (wk === WALK_VIEW && samePlace(view[i], soon[i])) continue;
      const [g, pos] = wk === WALK_AHEAD ? [gridA, ahead] : [grid, soon];
      const atk = (3 * i + wk) * aheadN;
      const wn = want[3 * i + wk];
      let got = 0;
      while (got < wn) {
        const e = walks[wk].next(g, pos);
        if (e === null) break;
        preD[atk + got] = e[0];
        preJ[atk + got] = e[1];
        got++;
      }
      preN[3 * i + wk] = got;
    }
    near[i] = walks[0];
    nearA[i] = walks[1];
    nearV[i] = walks[2];
  }
  const preAt = new Uint16Array(m * 3);
  const olds = [];
  const olinks = [], osince = [], ostart = [];
  for (let i = 0; i < m; i++) {
    ostart.push(olinks.length);
    const a = player(slots, list[i]);
    if (!a) continue;
    for (const l of a.links) {
      const j = local(at, l.slot);
      if (j === null) continue;
      olinks.push(j);
      osince.push(l.since);
      if ((i < j || !hasPlace(olinks, ostart[j], ostart[j + 1], i)) && vips[i] !== vips[j]) {
        const d = oldKey(soon, ahead, view, i, j, l.since, w);
        olds.push(new Cand(d + 0.0, i, j, false));
      }
    }
  }
  ostart.push(olinks.length);
  olds.sort((x, y) => x.d - y.d || x.lo - y.lo || x.hi - y.hi);
  const old = (i, j) => hasPlace(olinks, ostart[i], ostart[i + 1], j) || hasPlace(olinks, ostart[j], ostart[j + 1], i);
  let stride = 0;
  for (let i = 0; i < m; i++) if (deg[i] > stride) stride = deg[i];
  const fcount = new Int32Array(m);
  const flinks = new Uint32Array(m * stride);
  const room = (i) => fcount[i] < deg[i];
  const linkedF = (i, j) => hasPlace(flinks, i * stride, i * stride + fcount[i], j);
  const addF = (a, b) => {
    flinks[a * stride + fcount[a]] = b;
    fcount[a]++;
  };
  let duel = 0, made = 0;
  const firsts = dpairs.concat(lpairs);
  for (let k = 0; k < firsts.length; k++) {
    const [i, j] = firsts[k];
    if (room(i) && room(j) && !linkedF(i, j) && !keptApart(bstart, bnext, i, j) && vips[i] !== vips[j]) {
      join(fresh, list[i], list[j], sinceOf(slots, list[i], list[j], w.now));
      addF(i, j);
      addF(j, i);
      if (k < dpairs.length) duel++;
      else made++;
    }
  }
  let crew = 0;
  if (cpairs.length > 0) {
    const ccount = new Int32Array(m);
    for (const [, i, j] of cpairs) {
      if (ccount[i] < ccap[i] && ccount[j] < ccap[j] && room(i) && room(j) && !linkedF(i, j) && !keptApart(bstart, bnext, i, j) && vips[i] !== vips[j]) {
        join(fresh, list[i], list[j], sinceOf(slots, list[i], list[j], w.now));
        addF(i, j);
        ccount[i]++;
        addF(j, i);
        ccount[j]++;
        crew++;
      }
    }
  }
  // walk wk of place i on to its next one that can still link (hub.rs advance!)
  const advance = (i, walk) => {
    const k = i * 3 + walk;
    for (;;) {
      const gotK = preAt[k], read = preN[k];
      preAt[k] = Math.min(preAt[k] + 1, 65535);
      let e;
      if (gotK < read) e = [preD[k * aheadN + gotK], preJ[k * aheadN + gotK]];
      else if (read === want[k]) {
        if (walk === WALK_AHEAD) e = nearA[i].next(gridA, ahead);
        else if (walk === WALK_VIEW) e = nearV[i].next(grid, soon);
        else e = near[i].next(grid, soon);
      } else e = null;
      if (e === null) return null;
      const jl = e[1];
      if (!room(jl) || old(i, jl) || linkedF(i, jl) || keptApart(bstart, bnext, i, jl) || vips[i] === vips[jl]) continue;
      return e;
    }
  };
  for (let i = 0; i < m; i++) {
    if (!room(i)) {
      grid.remove(i);
      gridA.remove(i);
    }
  }
  for (let i = 0; i < m; i++) {
    if (!room(i)) continue;
    for (const walk of [WALK_SOON, WALK_AHEAD, WALK_VIEW]) {
      const e = advance(i, walk);
      if (e !== null) heap.push(Cand.by(e[0], i, e[1], walk));
    }
  }
  let o = 0;
  for (let guard = 0; ; guard++) {
    assert(guard < 1e9, 'link_many runs away');
    const x = o < olds.length ? olds[o] : null, y = heap.peek();
    if (x === null && y === null) break;
    let takeOld;
    if (x !== null && y !== null) takeOld = !before(y, x);
    else takeOld = x !== null;
    let c;
    if (takeOld) {
      c = olds[o];
      o++;
    } else {
      c = heap.pop();
      if (c === null) break;
    }
    const i = c.i(), j = c.j();
    if (c.nearest && room(i)) {
      const e = advance(i, c.walk);
      if (e !== null) heap.push(Cand.by(e[0], i, e[1], c.walk));
    }
    if (room(i) && room(j) && !linkedF(i, j) && !keptApart(bstart, bnext, i, j)) {
      let since = w.now;
      if (!c.nearest) {
        for (let x2 = ostart[i]; x2 < ostart[i + 1]; x2++) {
          if (olinks[x2] === j) {
            since = osince[x2];
            break;
          }
        }
      }
      join(fresh, list[i], list[j], since);
      for (const [a, b] of [[i, j], [j, i]]) {
        addF(a, b);
        if (!room(a)) {
          grid.remove(a);
          gridA.remove(a);
        }
      }
    }
  }
  while (s.walkUsed.length < slots.length) s.walkUsed.push(null);
  for (let i = 0; i < m; i++) {
    s.walkUsed[list[i]] = [Math.min(preAt[3 * i] + 1, 65535), Math.min(preAt[3 * i + 1] + 1, 65535), Math.min(preAt[3 * i + 2] + 1, 65535)];
  }
  return [duel, made, crew];
}

/** whether one of the two players' browsers blocks the other */
function blocked(blocks, a, b) {
  const x = blocks.get(a.vip);
  if (x && x.has(b)) return true;
  const y = blocks.get(b.vip);
  return !!(y && y.has(a));
}

/** where a player is at now (x, y): its last SNAP's position moved on at its velocity, MAP_AHEAD_MS at most */
function ahead(o, now) {
  return aheadOf(o.p !== null ? o.p : [0, 0, 0], [o.v[0], o.v[1]], o.posAt, now);
}

/** how far player q is from p, who sends it its car (hub.rs far_code): 1, 4 or 10 */
function farCode(p, q, now, lookS) {
  if (p.p === null || q.p === null) return 1;
  const a = p.p, b = q.p;
  const at = (o, x, t) => {
    let age = (now - o.posAt) / 1000.0;
    age = age < 0.0 ? 0.0 : age > AGE_MAX_S ? AGE_MAX_S : age;
    const v = o.status === 2 ? o.v : [0.0, 0.0, 0.0];
    return [x[0] + v[0] * (age + t), x[1] + v[1] * (age + t)];
  };
  const apart = (t) => {
    const u = at(p, a, t), ww = at(q, b, t);
    return hypot(u[0] - ww[0], u[1] - ww[1]);
  };
  const x = apart(0.0), y = apart(lookS);
  const d = y < x ? y : x;
  if (d > wire.VERYFAR_M) return 10;
  if (d > wire.FAR_M) return 4;
  return 1;
}

function aheadOf(pos, v, posAt, now) {
  let dt = now - posAt;
  dt = (dt < 0.0 ? 0.0 : dt > MAP_AHEAD_MS ? MAP_AHEAD_MS : dt) / 1000.0;
  return [pos[0] + v[0] * dt, pos[1] + v[1] * dt];
}

function mapCand(slot, o, at, now) {
  return mapCandOf(slot, o.mapKey, o.id, o.p !== null ? o.p : [0, 0, 0], o.heading, [o.v[0], o.v[1]], at, now - o.stayAt >= PARKED_MS);
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function mapCandOf(slot, k, id, p, heading, v, at, parked) {
  const c = (x) => clamp(Math.floor(x + 0.5), -32767, 32767);
  const vw = (x) => clamp(wire.rustRound(x), -127, 127);
  return { slot, key: k, id, p, x: c(at[0]), y: c(at[1]), heading, vx: vw(v[0]), vy: vw(v[1]), parked };
}

/** the NEARD grid's cell of a coordinate (m) */
function nearCell(x) {
  return clamp(Math.floor(x / NEAR_CELL_M), -1e6, 1e6);
}

/** MAPD (and NEARD): the entries that take a map from from to list (hub.rs map_diff): [bytes, ends, next] */
function mapDiff(from, list, now, tolM, tolH, parked) {
  const e = [];
  const ends = [];
  const next = [];
  const pk = (c) => parked && c.parked && c.key < wire.MAPD_PARKED;
  const put16 = (v) => {
    e.push(v & 255, (v >> 8) & 255);
  };
  const place = (c) => {
    put16(c.key | (pk(c) ? wire.MAPD_PARKED : 0));
    put16(c.x);
    put16(c.y);
    e.push(c.heading, c.vx & 255, c.vy & 255);
    if (parked) put16(clamp(Math.floor(c.p[2] + 0.5), -32767, 32767));
    return { key: c.key, id: c.id, x: c.x, y: c.y, heading: c.heading, vx: c.vx, vy: c.vy, parked: pk(c), t: now };
  };
  let i = 0, j = 0;
  for (let guard = 0; i < from.length || j < list.length; guard++) {
    assert(guard <= from.length + list.length, 'map_diff runs away');
    const a = i < from.length ? from[i] : null, c = j < list.length ? list[j] : null;
    const was = e.length;
    if (a !== null && c !== null && a.key === c.key) {
      const dt = (now - a.t) / 1000.0;
      const dx = c.x - (a.x + a.vx * dt), dy = c.y - (a.y + a.vy * dt);
      const h1 = (c.heading - a.heading) & 255, h2 = (a.heading - c.heading) & 255;
      const dh = h1 < h2 ? h1 : h2;
      next.push(a.id !== c.id || dx * dx + dy * dy > tolM * tolM || dh > tolH || a.parked !== pk(c) ? place(c) : a);
      i++;
      j++;
    } else if (a !== null && (c === null || a.key < c.key)) {
      put16(a.key | wire.MAPD_GONE);
      i++;
    } else if (c !== null) {
      next.push(place(c));
      j++;
    } else break;
    if (e.length > was) ends.push(e.length);
  }
  return [Uint8Array.from(e), ends, next];
}

/** MAPD's datagrams for entries ending at ends: each its first entry and the one past its last (hub.rs map_parts) */
function mapParts(ends) {
  const parts = [[0, 0]];
  for (let k = 0; k < ends.length; k++) {
    const end = ends[k];
    const [a, z] = parts[parts.length - 1];
    const start = a === 0 ? 0 : ends[a - 1];
    if (z > a && (end - start > wire.MAPD_BYTES || z - a === 255)) parts.push([k, k + 1]);
    else parts[parts.length - 1][1] = k + 1;
  }
  return parts;
}

/**
 * The free-roam hub as a host on the switch (lib.rs RoamHub): vip 10.77.0.253.  The switch calls frame() for every
 * frame a browser sends to the hub's address, peerGone() for every browser that leaves, and tick() at nextTickMs();
 * the hub sends its lists, maps and lobbies through sw.send(vip, frame, null) (its frames are charged to nobody).
 * Sans-IO: time is what the caller gives (nowMs), the hub's sender id comes from the injected prng.  The hub keeps
 * nothing on disk (the Rust hub keeps memory only): storage is not used.
 */
export class RoamHub {
  /**
   * @param {{sw: {send: (vip: number, frame: Uint8Array, cause: any) => string}, prng: {below: (n: number) => number}, storage?: any, nowMs: number, options?: object}} a
   *   options: the hub's options (defaultOptions()), and: id (the hub's sender id, else random from prng), log (a
   *   console line: console.log by default), claims (the claimed names, web/worker/src/claims), busy (a function, 0
   *   to 1: how busy the server is; the Rust measured its workers' CPU, which a Worker cannot: 0 by default)
   */
  constructor({ sw, prng, storage = null, nowMs, options = {} }) {
    assert(Number.isFinite(nowMs), 'nowMs');
    this.vip = ROAM_HUB_VIP;
    this.name = 'free-roam hub';
    this.sw = sw;
    this.storage = storage;
    this.t = nowMs;
    this.busyFn = typeof options.busy === 'function' ? options.busy : null;
    this.busyNow = 0;
    // random and never 0 (roam_core.c's decoder drops a datagram from sender 0)
    const id = options.id != null ? options.id >>> 0 : 1 + prng.below(0xffffffff);
    const log = typeof options.log === 'function' ? options.log : (line) => console.log(line);
    this.core = new Hub(options, {
      now: () => this.t,
      busy: () => (this.busyFn ? this.busyFn() : this.busyNow),
      log,
      send: (vip, f) => (this.sw ? this.sw.send(vip, f, null) === 'sent' : false),
      id,
      claims: options.claims || null,
    });
    this.next = nowMs + this.core.o.tickMs;
    this.stopped = false;
    // what /players reads, as of the last tick (lib.rs RoamHub's atomics)
    this.lastCrowded = this.core.crowded();
    this.lastInRoam = 0;
    this.lastInRooms = new Map();
    this.lastCrews = [];
    this.lastCoopSeats = 0;
  }

  listed() {
    return false;
  }

  /** a frame from a browser to the hub's address (the switch wrote its true source vip into [4..8]) */
  frame(frame, ctx, nowMs) {
    this.t = nowMs;
    if (frame.length < 8) return;
    const from = ((frame[4] << 24) | (frame[5] << 16) | (frame[6] << 8) | frame[7]) >>> 0;
    const owner = ctx && ctx.owner != null ? ctx.owner : null;
    const client = ctx ? (ctx.site != null ? ctx.site : ctx.group != null ? ctx.group : null) : null;
    this.core.frameOf(from, frame, owner, client);
  }

  /** browser vip left the switch */
  peerGone(vip, nowMs) {
    if (nowMs != null) this.t = nowMs;
    this.core.peerGone(vip >>> 0);
  }

  /** every tickMs: the links and every player's list (the next one tickMs after this one began) */
  tick(nowMs) {
    this.t = nowMs;
    if (this.stopped) return;
    this.core.tick();
    this.next = nowMs + this.core.o.tickMs;
    this.lastCrowded = this.core.crowded();
    this.lastInRoam = this.core.inRoam();
    this.lastCoopSeats = this.core.coopSeats();
    this.lastInRooms = this.core.inRooms();
    this.lastCrews = this.core.crewCounts();
  }

  nextTickMs() {
    return this.stopped ? Infinity : this.next;
  }

  /** the server's busy measure (0 to 1), read at the next tick's cap (the Rust's WorkersBusy/QuotaBusy) */
  setBusy(fraction) {
    this.busyNow = Number.isFinite(fraction) ? fraction : 0;
  }

  /** how busy the hub's own work was (0 to 1): the minimap answers less often when busy */
  setThreadBusy(fraction) {
    this.core.setThreadBusy(fraction);
  }

  stop() {
    this.stopped = true;
    this.sw = null;
  }

  info() {
    return this.core.info();
  }
  vips() {
    return this.core.vips();
  }
  blocks(vip, names, nowMs) {
    if (nowMs != null) this.t = nowMs;
    this.core.blocks(vip >>> 0, names);
  }
  pageName(vip, name, nowMs) {
    if (nowMs != null) this.t = nowMs;
    this.core.pageName(vip >>> 0, name);
  }
  otherNames() {
    return this.core.otherNames();
  }
  linkPairs() {
    return this.core.linkPairs();
  }
  crowded() {
    return this.lastCrowded;
  }
  inRoam() {
    return this.lastInRoam;
  }
  inRoom(room) {
    return this.lastInRooms.get(room >>> 0) || 0;
  }
  inWorld(room) {
    return worldCount(this.lastInRooms, room >>> 0);
  }
  inCrews(crews) {
    return crews.map((c) => crewCount(this.lastCrews, c));
  }
  coopSeats() {
    return this.lastCoopSeats;
  }
  friends(vip, me, owners) {
    this.core.friends(vip >>> 0, me, owners);
  }
  roomName(vip, name) {
    this.core.roomName(vip >>> 0, name);
  }
  flew(vip, secs, nowMs) {
    if (nowMs != null) this.t = nowMs;
    this.core.flew(vip >>> 0, secs);
  }
  linkedWith(vip, name) {
    return this.core.linkedWith(vip >>> 0, name);
  }
  whereabouts(owners) {
    return this.core.whereabouts(owners);
  }
  hosted(vip, nowMs) {
    if (nowMs != null) this.t = nowMs;
    return this.core.hosted(vip >>> 0);
  }
}

/** The race tracks' spots a game's free roam can go to, each by its room's key (lib.rs TRACK_KEYS) */
export const TRACK_KEYS = [4711, 4701, 4311, 4301, 4201, 4211, 4221, 4601, 4605];

/** the room of the race track's spot of this key in the world of room base (lib.rs track_room): never 0 */
export function trackRoom(base, k) {
  const r = (base ^ Math.imul(k, 0x9e3779b1)) >>> 0;
  return r === 0 ? 1 : r;
}

/** whether room is in the main world (lib.rs main_world) */
export function mainWorld(room) {
  return room === 0 || TRACK_KEYS.some((k) => trackRoom(0, k) === room);
}

/** how many of free roam play in the world of room room, its race tracks' spots too (lib.rs world_count) */
export function worldCount(counts, room) {
  const n = (r) => counts.get(r) || 0;
  let s = n(room);
  for (const k of TRACK_KEYS) s += n(trackRoom(room, k));
  return s;
}

/** Math.hypot(x, y, z) as V8 computes it: the hub's distances (lib.rs hypot) */
export { hypot3 as hypot } from './links.js';
export { decodeRoam, encodePeers, encodePeersCrews } from './wire.js';
export const CREWS = wire.CREWS;

/**
 * What must hold of a hub after every frame and tick (the DST checks it after every step): the slots, the order, the
 * endpoints by key and by browser, the world map keys, the crews' count; and of its links (afterTick: right after a
 * tick, when every link is as the tick made it): no link to itself or to its own browser, none twice, both ends list
 * each other (the way mirrored), at most its degree (of cars it gets, for a core of one-way links; LIST_MAX in its list).
 * Returns the first violation, or null.
 * @param {Hub} hub
 * @param {boolean} [afterTick]
 * @returns {string|null}
 */
export function hubInvariants(hub, afterTick = false) {
  let players = 0, crewed = 0, keys = 0;
  const seenKeys = new Set();
  const perVip = new Map();
  for (let slot = 0; slot < hub.slots.length; slot++) {
    const p = hub.slots[slot];
    if (!p) continue;
    players++;
    if (hub.byKey.get(key(p.vip, p.port)) !== slot) return 'byKey does not lead to slot ' + slot;
    if (hub.order[p.at] !== slot) return 'order[' + p.at + '] is not slot ' + slot;
    if (p.crews[0] !== 0) crewed++;
    if (p.mapKey !== NO_KEY) {
      if (p.mapKey >= MAP_KEYS || seenKeys.has(p.mapKey)) return 'map key ' + p.mapKey + ' twice or out of range';
      seenKeys.add(p.mapKey);
      keys++;
      if (!(p.status === 2 || p.status === 5)) return 'a map key off free roam';
    } else if ((p.status === 2 || p.status === 5) && hub.mapFree.length > 0) return 'in free roam without a map key while keys are free';
    if (!perVip.has(p.vip)) perVip.set(p.vip, []);
    perVip.get(p.vip).push(slot);
    if (hub.deadAt[slot]) return 'a live player in a dead slot';
  }
  if (players !== hub.byKey.size) return 'byKey ' + hub.byKey.size + ' != players ' + players;
  if (players > hub.o.maxPlayers) return 'more players than maxPlayers';
  if (crewed !== hub.crewed) return 'crewed ' + hub.crewed + ' != ' + crewed;
  if (keys + hub.mapFree.length !== MAP_KEYS) return 'map keys lost: ' + keys + ' + ' + hub.mapFree.length;
  if (perVip.size !== hub.perVip.size) return 'perVip has ' + hub.perVip.size + ' browsers, not ' + perVip.size;
  for (const [vip, mine] of hub.perVip) {
    const want = perVip.get(vip);
    if (!want || want.length !== mine.length || want.some((s) => !mine.includes(s))) return 'perVip of ' + vipStr(vip) + ' out of step';
    if (mine.length > hub.o.maxPerVip) return 'more endpoints than maxPerVip for ' + vipStr(vip);
  }
  let holes = 0;
  for (const s of hub.order) if (s === NONE) holes++;
  if (holes !== hub.holes) return 'holes ' + hub.holes + ' != ' + holes;
  if (hub.order.length - holes !== players) return 'order holds ' + (hub.order.length - holes) + ' players, not ' + players;
  if (!afterTick) return null;
  const mirror = (d) => (d === DIR_RECV ? DIR_SEND : d === DIR_SEND ? DIR_RECV : d);
  for (let slot = 0; slot < hub.slots.length; slot++) {
    const p = hub.slots[slot];
    if (!p) continue;
    const seen = new Set();
    let recv = 0;
    for (const l of p.links) {
      if (l.slot === slot) return 'a link to itself';
      if (seen.has(l.slot)) return 'a link twice';
      seen.add(l.slot);
      if ((l.dir & DIR_RECV) !== 0) recv++;
      const q = hub.slots[l.slot];
      if (!q) continue;
      if (q.vip === p.vip) return 'a link between two endpoints of ' + vipStr(p.vip);
      const back = q.links.find((x) => x.slot === slot);
      if (!back) return 'a link one end does not list';
      if (back.dir !== mirror(l.dir)) return 'a link whose ends disagree on its way';
      if (back.since !== l.since) return 'a link whose ends disagree on its age';
    }
    if (p.oneway) {
      if (p.links.length > wire.LIST_MAX) return 'a list past LIST_MAX';
    } else if (p.links.length > Math.max(p.degree, 0) && p.links.some((l) => l.dir !== DIR_BOTH) === false) {
      return 'more links than its degree';
    }
    if (recv > Math.max(p.degree, hub.o.degree)) return 'more cars than its degree';
  }
  return null;
}

