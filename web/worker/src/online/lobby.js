// The lobby of the online host (crates/online/src/lobby.rs): what EA's servers did for NFS Underground 2's Online
// mode, for the players of this one server: the redirector (20920: @dir -> this lobby), the lobby (20922: login,
// personas, rooms, chat, games, race results, rankings).  See lobby.rs for the full text of every rule; this is a
// line-for-line port (method names camelCased), so the frames, the console lines and the results are the same.
//
// Sessions and games are kept by id.  A session that left (and a game that ended) stays readable until the event
// that ended it is over (the graveyard), so the code still handling that event goes on with it.

import { assert, toInt32, toUint32, round, slice16, validName, cleanText, lower, day, hex, utf8, q, vipStr, toFixed, fmt0, cmpStr } from './jsx.js';
import { FieldMap, FrameReader, MAX_FRAME, encodeFrame, fieldsLen, isSecret } from './aries.js';
import { Bucket } from './bucket.js';
import { LIMITS, slurSaid, fourPrintable } from './rules.js';
import { randInt, randHex, randBytes } from './rand.js';
import { md5 } from './md5.js';
import { sha256 } from '../util/sha256.js';
import { blockedName, chatSlur } from '../names/index.js';
import { CAR_KMH, JUMP_M, MODE_DRIFT, Quickest, RACE_MPS, THIRD_SHARE, jumpSeen } from '../anticheat/anticheat.js';
import { OUT, RACE_TYPES, decodeResult, racePoints } from './stats.js';

export { LIMITS, fourPrintable };

const PORT_LOBBY = 20922;
const PORT_BUDDY = 13505;

/** the rooms everyone shares: a lounge and one per race type */
export const ROOMS = ['Lounge', 'Circuit', 'Sprint', 'Drift', 'Drag', 'StreetX', 'URL'];
const ROOM_LIMIT = 50;
const TIER = '0,1999,4999,9999,19999,39999,59999,79999,99999,119999';
/** games in one game list search (every open game in one search) */
const GAMES_PER_UPDATE = 200;

/** the server config (the "news" reply, code new7) */
export function configFields() {
  return [
    ['TOSURL', 'http://10.77.0.1/tos'],
    ['NEWSURL', 'http://10.77.0.1/news'],
    ['BUDDY_SERVER', '10.77.0.1'],
    ['BUDDY_PORT', PORT_BUDDY],
    ['GAMES_PER_UPDATE', GAMES_PER_UPDATE],
    ['CIRCUIT_TIER_POINTS', TIER],
    ['SPRINT_TIER_POINTS', TIER],
    ['DRIFT_TIER_POINTS', TIER],
    ['DRAG_TIER_POINTS', TIER],
    ['STREET_CROSS_TIER_POINTS', TIER],
    ['URL_TIER_POINTS', TIER],
  ];
}

const READY = (1 << 27) >>> 0;
const PASSWORD = (1 << 16) >>> 0;
const ACTIVE = (1 << 19) >>> 0;
const RANKED = (1 << 18) >>> 0;
const COUNTDOWN = (1 << 12) >>> 0;
const PRIVATE = (1 << 8) >>> 0;
const FILTER_SET = 'filt';
const FILTER_DEFAULT = [0x40000f3, 0x40001f3, 0, 0xc0000];
const REPORT_TYPES = ['circuit', 'sprint', 'drag', 'drift', 'streetx', 'url', 'type 6'];
const MIN_RACE_S = [20, 20, 5, 20, 20, 20, 20];
const FAR_AHEAD = 0.4;
const TRACKS_KEPT = 4096;
const DROVE_SHARE = 0.5;
const ENDED_S = 40;
const AGREE_S = 1;
const CLOSE_SHARE = 0.95;
const SEEN_KEPT = 8;
const CAR_MPS = CAR_KMH / 3.6;
const SLOT_TYPES = [0, 1, 3, 2, 4, 5];
const RESULTS_WAIT_MS = 60000;

const CAR_TYPES = ['PEUGOT', 'FOCUS', 'COROLLA', '240SX', 'MIATA', 'CIVIC', 'PEUGOT106', 'CORSA', 'HUMMER', 'NAVIGATOR',
  'ESCALADE', 'TIBURON', 'SENTRA', 'CELICA', 'IS300', 'SUPRA', 'GOLF', 'A3', 'RSX', 'ECLIPSE', 'TT', 'RX8', '350Z', 'G35',
  '3000GT', 'GTO', 'MUSTANGGT', 'SKYLINE', 'LANCEREVO8', 'RX7', 'IMPREZAWRX'];

/** Rust's u8::from_str_radix(s, 16): an optional '+', hex digits, at most 255; else null */
function hexU8(s) {
  if (!/^\+?[0-9A-Fa-f]+$/.test(s)) return null;
  const v = parseInt(s, 16);
  return v <= 255 ? v : null;
}

/** a rank's code from a game that raced an edited car: "ed" and the car type in two hex digits */
function editedCode(code) {
  if (!code.startsWith('ed') || code.length !== 4) return null;
  return hexU8(code.slice(2));
}

/** a rank's code from a game that had another racer's car jump: "j", the slot, the jump in two hex digits (4 m a step) */
function jumpCode(code) {
  if (!code.startsWith('j') || code.length !== 4) return null;
  const rest = code.slice(1);
  if (!/^[0-9]$/.test(rest[0])) return null;
  const slot = Number(rest[0]);
  if (slot >= 8) return null;
  const v = hexU8(rest.slice(1));
  return v === null ? null : [slot, v * 4];
}

/** Rust's f64::round (half away from zero) */
function rustRound(x) {
  const a = Math.abs(x), f = Math.floor(a);
  const r = a - f >= 0.5 ? f + 1 : f;
  return x < 0 ? -r : r;
}

function lapsText(laps) {
  return laps > 0 ? ', ' + laps + ' lap' + (laps === 1 ? '' : 's') : '';
}

/** "SUPRA, type 15" for an edited car's type; "type unknown" when the game could not tell */
function editedCar(t) {
  return t < CAR_TYPES.length ? CAR_TYPES[t] + ', type ' + t : 'type unknown';
}

/** Iterator::max_by of [value, x] pairs: the last of the largest */
function maxByLast(pairs) {
  let best = null;
  for (const p of pairs) if (best === null || !(p[0] < best[0])) best = p;
  return best;
}

/** the [cheat] lines of the racers whose car jumped JUMP_M or more at once by JUMP_SEEN of the other games */
function jumpLines(game, r, players) {
  const ty = REPORT_TYPES[r.kind] ?? 'race';
  const laps = lapsText(r.laps);
  const two = players.length === 2;
  const lines = [];
  for (const p of players) {
    const far = p.jumped.map((x) => x[1]).filter((m) => m >= JUMP_M);
    if (p.jumpTold || !jumpSeen(far.length, two)) continue;
    far.sort((a, b) => b - a);
    p.jumpTold = true;
    let place = '';
    if (p.own && p.own.finished && p.own.place === 1 && r.kind !== MODE_DRIFT) place = '; it won';
    else if (p.own && p.own.finished && r.kind !== MODE_DRIFT) place = '; it came ' + p.own.place;
    lines.push('[cheat] ' + vipStr(p.vip) + ' "' + p.name + '": its car jumped ' + fmt0(far[0]) + ' m at once in the online race "' + game +
      '" (' + ty + ', track ' + r.track + laps + '), as ' + far.length + ' other players\' games had it (the largest each: ' +
      far.map(fmt0).join(', ') + ' m; honest races\' largest are under 50 m)' + place);
  }
  return lines;
}

/** the [cheat] lines of a race so far, at the report of game player me (lobby.rs race_cheats) */
function raceCheats(game, r, me, mine, edited, views, players) {
  const kind = r.kind;
  const drift = kind === MODE_DRIFT;
  if (mine && players[me].own === null) {
    const speed = (v) => (v < 1000 ? Math.max(v, 0) : 0);
    const time = mine.time < 100000 ? Math.max(mine.time, 0) : 0;
    const finished = !mine.dropped && mine.place >= 1 && time > 0;
    players[me].own = { finished, place: mine.place, time, score: Math.max(mine.score, 0), avg: speed(mine.avg), top: speed(mine.top), edited, told: false };
  }
  for (const [j, t] of views) if (j !== me && players[j].seen.length < SEEN_KEPT) players[j].seen.push(t);
  const ty = REPORT_TYPES[kind] ?? 'race';
  const laps = lapsText(r.laps);
  const lines = [];
  for (let i = 0; i < players.length; i++) {
    const o = players[i].own;
    if (!o || o.told) continue;
    const drove = o.avg * o.time;
    const why = [];
    if (!o.finished && o.top < CAR_MPS && o.edited === null) continue;
    const agreed = players[i].seen.some((t) => Math.abs(t - o.time) <= AGREE_S);
    const close = players.some((x, j) => {
      if (j === i) return false;
      const ts = [];
      if (x.own && x.own.finished) ts.push(x.own.time);
      ts.push(...x.seen);
      return ts.some((t) => t * CLOSE_SHARE <= o.time);
    });
    const taken = !drift && o.finished && agreed && !close;
    if (kind < MIN_RACE_S.length && taken && o.time < MIN_RACE_S[kind]) {
      why.push('under the ' + String(MIN_RACE_S[kind]) + ' s a ' + ty + ' race takes at least');
    }
    if (taken && o.avg >= RACE_MPS) why.push(fmt0(o.avg * 3.6) + ' km/h on average, which no car does');
    const most = maxByLast(players
      .map((x, j) => (x.own && j !== i && (x.own.finished || x.own.time <= o.time + ENDED_S) ? [x.own.avg * x.own.time, x.name] : null))
      .filter((x) => x !== null));
    let each = '';
    if (most && taken && drove < DROVE_SHARE * most[0]) {
      why.push('having driven ' + fmt0(drove) + ' m, under half the ' + fmt0(most[0]) + ' m "' + most[1] + '" drove');
      each = 'each ';
    }
    if (o.edited !== null) why.push('an edited car (' + editedCar(o.edited) + ': its game has the car\'s data edited, GlobalB)');
    if (o.top >= CAR_MPS) why.push('an edited car (no car of the game makes ' + fmt0(CAR_MPS * 3.6) + ' km/h)');
    if (why.length === 0) continue;
    const p = players[i];
    p.own = { ...o, told: true };
    const place = !o.finished ? 'raced in' : o.place === 1 ? 'won' : 'finished ' + o.place + ' in';
    const time = o.finished && !drift ? ' in ' + fmtTime(o.time) : o.finished && drift ? ' with ' + o.score + ' points' : '';
    lines.push('[cheat] ' + vipStr(p.vip) + ' "' + p.name + '": ' + place + ' the online race "' + game + '" (' + ty + ', track ' + r.track +
      laps + ')' + time + ', ' + why.join(', ') + ': ' + each + 'by its own game; its top speed ' + fmt0(o.top * 3.6) + ' km/h');
  }
  return lines;
}

/** the [cheat] line of a race whose winner took under FAR_AHEAD of the next finisher's time */
function farAhead(game, kind, order, players) {
  if (kind === MODE_DRIFT) return null;
  const done = order.filter((p) => p.place !== 0 && p.time > 0);
  done.sort((a, b) => a.time - b.time);
  if (done.length < 2) return null;
  const [a, b] = done;
  if (a.time >= FAR_AHEAD * b.time) return null;
  const pl = players.find((p) => lower(p.name) === lower(a.name));
  const vip = pl ? pl.vip : 0;
  return '[cheat] ' + vipStr(vip) + ' "' + a.name + '": won the online race "' + game + '" (' + (REPORT_TYPES[kind] ?? 'race') + ') in ' +
    fmtTime(a.time) + ', under ' + fmt0(FAR_AHEAD * 100) + ' % of the next finisher\'s ' + fmtTime(b.time) + ' ("' + b.name + '")';
}

/** the [cheat] line of a standing race won far quicker than the track's third quickest other racer; else null, and a
 *  clean race counts in the track's (lobby.rs quick_win) */
function quickWin(wins, game, r, order, players, told) {
  if (r.kind === MODE_DRIFT) return null;
  const w = order.find((p) => p.place === 1 && p.time > 0);
  if (!w) return null;
  const key = r.kind + ',' + r.track + ',' + r.dir + ',' + r.laps;
  const who = lower(w.name);
  const close = order.some((p) => p.place > 1 && p.time > 0 && w.time >= THIRD_SHARE * p.time);
  if (!close) {
    const x = wins.get(key);
    const third = x ? x.third(who) : null;
    if (third !== null && third !== undefined && w.time < THIRD_SHARE * third) {
      const pl = players.find((p) => lower(p.name) === who);
      const vip = pl ? pl.vip : 0;
      const ty = REPORT_TYPES[r.kind] ?? 'race';
      return '[cheat] ' + vipStr(vip) + ' "' + w.name + '": won the online race "' + game + '" (' + ty + ', track ' + r.track + lapsText(r.laps) +
        ') in ' + fmtTime(w.time) + ', under ' + fmt0(THIRD_SHARE * 100) + ' % of the third quickest other racer\'s time of the track\'s ' +
        x.wins + ' clean races (' + fmtTime(third) + '): as the result stands';
    }
  }
  const finished = order.filter((p) => p.place !== 0 && p.time > 0).length;
  if (finished >= 2 && !told && (wins.size < TRACKS_KEPT || wins.has(key))) {
    let track = wins.get(key);
    if (!track) {
      track = new Quickest();
      wins.set(key, track);
    }
    track.wins += 1;
    const toldOf = (name) => players.some((p) => lower(p.name) === lower(name) && p.own && p.own.told);
    for (const p of order) if (p.place !== 0 && p.time > 0 && !toldOf(p.name)) track.add(lower(p.name), p.time);
  }
  return null;
}

/** what decides a race's result in a kept report: the racers who crossed the finish line at their places */
export function finishersOf(key) {
  const done = key.split('|')[0];
  return done.split(',').filter((e) => e !== '' && !e.endsWith(':0')).join(',');
}

/** the racers a kept report names who did not finish */
export function othersOf(key) {
  const i = key.indexOf('|');
  const done = i < 0 ? key : key.slice(0, i);
  const rest = i < 0 ? '' : key.slice(i + 1);
  const old = done.split(',').filter((e) => e.endsWith(':0')).map((e) => e.slice(0, -2));
  return old.concat(rest.split(',')).filter((e) => e !== '');
}

/** a race time in a console line: "3:06.82" */
export function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = toFixed(t % 60, 2);
  return String(m) + ':' + s.padStart(5, '0');
}

/** a ranking's number in lowercase hex, as a u32 */
const h = (v) => toUint32(v).toString(16);

/** a session's persona as the console lines write it */
const tpl = (p) => (p === null || p === undefined ? 'null' : p);

/** fields within max bytes of text: the optional ones (named in drop, first dropped first) go until it fits */
export function fit(fields, max, drop) {
  let f = fields;
  if (fieldsLen(f) <= max) return f;
  for (const k of drop) {
    f = f.filter(([n]) => n !== k);
    if (fieldsLen(f) <= max) return f;
  }
  return f;
}

/** HMAC-SHA256 (a game's password digest) */
function hmacSha256(key, msg) {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  const ipad = new Uint8Array(64 + msg.length), opad = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }
  ipad.set(msg, 64);
  opad.set(sha256(ipad), 64);
  return sha256(opad);
}

/** a game's password as the lobby keeps it: an HMAC under a random key of the game's own */
class RoomPassword {
  constructor(prng, pass) {
    this.key = randBytes(prng, 32);
    this.tag = hmacSha256(this.key, utf8(pass));
  }
  /** the same password (compared in constant time) */
  matches(pass) {
    const t = hmacSha256(this.key, utf8(pass));
    let d = 0;
    for (let i = 0; i < 32; i++) d |= t[i] ^ this.tag[i];
    return d === 0;
  }
}

const laterNew = () => ({ at: -Infinity, timer: null, pending: false });

export class Lobby {
  constructor(l) {
    this.l = l;
    /** the live sessions, in the order they came */
    this.sessions = new Set();
    /** every session object still held */
    this.sess = new Map();
    this.byVip = new Map();
    this.byGroup = new Map();
    this.bySite = new Map();
    this.graveyard = [];
    /** lower-case persona -> session */
    this.byPersona = new Map();
    this.rooms = ROOMS.map((n, i) => ({ id: i + 1, name: n, users: new Set() }));
    /** id -> game, in id order */
    this.games = new Map();
    this.dead = new Map();
    /** game id -> {later, gone, room} */
    this.agm = new Map();
    /** room id -> later */
    this.pop = new Map();
    this.goneVips = new Map();
    this.nextUser = 1;
    this.nextGame = 1;
    this.stats = { logins: 0, refused: 0, chats: 0, games: 0, races: 0, dropped: 0 };
    this.lastSst = null;
    /** lower-case persona -> its last lines [{t, text, to, hidden}], the oldest first */
    this.said = new Map();
    /** "kind,track,dir,laps" -> Quickest */
    this.wins = new Map();
  }
  room(id) {
    return this.rooms.find((r) => r.id === id) || null;
  }
  game(id) {
    return this.games.get(id) || this.dead.get(id) || null;
  }
  s(id) {
    const x = this.sess.get(id);
    assert(x, 'a held session');
    return x;
  }
  addLive(id) {
    const s = this.sess.get(id);
    if (!s || this.sessions.has(id)) return;
    this.sessions.add(id);
    if (!this.byVip.has(s.vip)) this.byVip.set(s.vip, []);
    this.byVip.get(s.vip).push(id);
    this.byGroup.set(s.group, (this.byGroup.get(s.group) || 0) + 1);
    if (s.site !== null) this.bySite.set(s.site, (this.bySite.get(s.site) || 0) + 1);
  }
  removeLive(id) {
    const s = this.sess.get(id);
    if (!s || !this.sessions.has(id)) return;
    this.sessions.delete(id);
    const v = this.byVip.get(s.vip);
    if (v) {
      const w = v.filter((x) => x !== id);
      if (w.length === 0) this.byVip.delete(s.vip);
      else this.byVip.set(s.vip, w);
    }
    const less = (m, k) => {
      const n = m.get(k);
      if (n !== undefined) {
        if (n - 1 === 0) m.delete(k);
        else m.set(k, n - 1);
      }
    };
    less(this.byGroup, s.group);
    if (s.site !== null) less(this.bySite, s.site);
  }
  /** the live sessions of one browser, in the order they came */
  ofVip(vip) {
    return this.byVip.get(vip) || [];
  }
  /** (tests) the counts by browser, client and site are the live ones counted again */
  checkCounts() {
    const v = new Map(), g = new Map(), st = new Map();
    for (const id of this.sessions) {
      const s = this.s(id);
      assert(!s.gone, 'a live session that left');
      if (!v.has(s.vip)) v.set(s.vip, []);
      v.get(s.vip).push(id);
      g.set(s.group, (g.get(s.group) || 0) + 1);
      if (s.site !== null) st.set(s.site, (st.get(s.site) || 0) + 1);
    }
    const same = (a, b) => a.size === b.size && [...a].every(([k, x]) => JSON.stringify(b.get(k)) === JSON.stringify(x));
    assert(same(v, this.byVip) && same(g, this.byGroup) && same(st, this.bySite), 'the lobby counts');
  }
  playerGone(p) {
    if (p.s === null) return true;
    const s = this.sess.get(p.s);
    return !s || s.gone;
  }
  /** the end of an event: what left or ended is let go */
  purge() {
    for (const id of this.graveyard) this.sess.delete(id);
    this.graveyard = [];
    for (const id of [...this.dead.keys()]) if (!this.agm.has(id)) this.dead.delete(id);
  }
  /** racing: players of a started race not back in the lobby and not online under their name again */
  racers(here) {
    const out = [];
    for (const g of this.games.values()) {
      if (g.started === 0) continue;
      for (const p of g.players) if (!p.back && !this.byPersona.has(lower(p.name)) && here.has(p.vip)) out.push(p);
    }
    return out;
  }
  info(here) {
    return [this.sessions.size, this.byPersona.size, this.racers(here).length, this.games.size];
  }
  vips(here) {
    const v = new Set();
    for (const s of this.byPersona.values()) {
      const x = this.sess.get(s);
      if (x) v.add(x.vip);
    }
    for (const p of this.racers(here)) v.add(p.vip);
    return v;
  }
  seen(vip) {
    if (this.goneVips.size > 0) this.goneVips.delete(vip);
  }
  peerGone(vip, now) {
    this.goneVips.set(vip, now);
  }
  laterMut(k) {
    const id = Number(k.slice(2));
    if (k[0] === 'a') {
      const a = this.agm.get(id);
      return a ? a.later : null;
    }
    return this.pop.get(id) || null;
  }
  sstCounts() {
    let open = 0, racing = 0;
    for (const g of this.games.values()) {
      if (g.started !== 0) racing++;
      else open++;
    }
    return [this.byPersona.size, racing, open];
  }
  gameByName(name) {
    for (const g of this.games.values()) if (g.name === name) return g.id;
    return null;
  }
  gamesOf(vip, group, started) {
    let v = 0, g = 0;
    for (const x of this.games.values()) {
      if ((x.started === 0) === started) continue;
      if (x.vip === vip) v++;
      if (x.group === group) g++;
    }
    return [v, g];
  }
  roomOf(name) {
    const n = lower(name ?? '');
    const r = this.rooms.find((x) => lower(x.name) === n);
    return r ? r.id : null;
  }
}


export const lobbyMethods = {
  now() {
    return this.clocks.now();
  },

  /** a session's words to the game */
  lsend(s, kind, fields, code = '') {
    const x = this.lobby.sess.get(s);
    if (!x || x.gone) return;
    this.connWrite(x.conn, encodeFrame(kind, code, fields));
  },

  /** a message encoded once, to one more session */
  lsendFrame(s, frame) {
    const x = this.lobby.sess.get(s);
    if (x && !x.gone) this.connWrite(x.conn, frame);
  },

  llog(line, s) {
    this.log(line, this.lobby.s(s).group);
  },

  // ---- the redirector (20920): @dir -> this lobby, and nothing else ----

  redirectorConnect(c) {
    const t = this.setTimeout(30000, { k: 'RedirectorIdle', c });
    this.vh.redirs.set(c, { reader: new FrameReader(), timer: t });
    this.setSvc(c, { k: 'redirector', id: 0 });
  },

  redirectorIdle(c) {
    if (this.vh.redirs.has(c)) this.connDestroy(c, 'redirector: no request');
  },

  redirectorData(c, buf) {
    const r = this.vh.redirs.get(c);
    if (!r) return;
    const msgs = r.reader.push(buf);
    const bad = r.reader.error !== null;
    for (const m of msgs) {
      if (m.kind !== '@dir') continue;
      const sess = randInt(this.prng, 1, 2 ** 31);
      const mask = randHex(this.prng, 16);
      this.connWrite(c, encodeFrame('@dir', '', [['ADDR', '10.77.0.1'], ['PORT', PORT_LOBBY], ['SESS', sess], ['MASK', mask]]));
      const r2 = this.vh.redirs.get(c);
      if (r2 && r2.timer !== null) {
        this.timers.clear(r2.timer);
        r2.timer = null;
      }
      this.connEnd(c);
    }
    if (bad) this.connDestroy(c, 'redirector: not the lobby protocol');
  },

  // ---- the lobby (20922) ----

  lobbyConnect(c) {
    const ids = this.connIds(c);
    if (!ids) return;
    const [vip, peer, group, site] = ids;
    const lb = this.lobby;
    const nv = lb.ofVip(vip).length;
    const ng = lb.byGroup.get(group) || 0;
    const ns = site !== null ? lb.bySite.get(site) || 0 : 0;
    const l = lb.l;
    const n = lb.sessions.size;
    const lastShare = n >= l.sessions * (1 - l.freeShare);
    if (n >= l.sessions || nv >= l.perVip || ng >= l.perGroup || ns >= l.perSite || (lastShare && (ng > 0 || ns > 0))) {
      lb.stats.refused += 1;
      this.log('[online] ' + peer + ': lobby full or too many sessions from that browser or client, refused', group);
      return this.connDestroy(c, 'lobby full');
    }
    const t = this.now();
    const id = lb.nextUser;
    lb.nextUser += 1;
    const owner = this.connOwner(c);
    lb.sess.set(id, {
      id, conn: c, vip, group, site, owner, addr: peer, reader: new FrameReader(MAX_FRAME),
      account: null, personas: [], persona: null, lkey: null, room: null, game: null, auxi: '', browsing: false,
      t0: t, lastIn: t, lastPing: t,
      msgs: Bucket.withBurstAt(l.msgRate, 2 * l.msgRate, t),
      chats: Bucket.withBurstAt(l.chatRate, 5, t),
      creates: Bucket.withBurstAt(l.createRate, 3, t),
      acts: Bucket.withBurstAt(l.actRate, 4, t),
      muteUntil: 0, slurs: [], gone: false,
    });
    lb.addLive(id);
    lb.goneVips.delete(vip);
    this.setSvc(c, { k: 'lobby', id });
  },

  lobbyData(s, buf) {
    const now0 = this.now();
    const x0 = this.lobby.s(s);
    x0.lastIn = now0;
    const msgs = x0.reader.push(buf);
    for (const m of msgs) {
      if (this.lobby.s(s).gone) return;
      const now = this.now();
      if (!this.lobby.s(s).msgs.takeAt(now, 1)) return this.ldrop(s, 'too many messages');
      if (!fourPrintable(m.kind)) return this.ldrop(s, 'not the lobby protocol (a message kind that is not 4 letters)');
      const f = m.kind === 'gcre' || m.kind === 'gjoi'
        ? FieldMap.parseWith(m.body, (k) => k !== 'PASS' && isSecret(k))
        : FieldMap.parse(m.body);
      this.message(s, m.kind, m.code, f);
    }
    const e = this.lobby.s(s).reader.error;
    if (e !== null) this.ldrop(s, 'not the lobby protocol (' + e + ')');
  },

  who(s) {
    const x = this.lobby.s(s);
    if (x.persona !== null) return x.addr + ' "' + x.persona + '"';
    if (x.account !== null) return x.addr + ' (' + x.account + ')';
    return x.addr;
  },

  /** a session dropped: counted, on the console, its link reset */
  ldrop(s, why) {
    this.lobby.stats.dropped += 1;
    this.llog('[online] ' + this.who(s) + ': dropped: ' + why, s);
    this.connDestroy(this.lobby.s(s).conn, why);
  },

  message(s, kind, code, f) {
    switch (kind) {
      case 'addr': return;
      case 'skey': return this.lsend(s, 'skey', [['SKEY', '$' + randHex(this.prng, 16)]]);
      case 'news':
        return f.get('NAME') === '7' ? this.lsend(s, 'news', configFields(), 'new7') : this.lsend(s, 'news', [], 'badc');
      case 'sele': {
        const stats = Math.min(5000, toInt32(f.num('STATS', 0)));
        return this.lsend(s, 'sele', [['GAMES', 1], ['MYGAME', 1], ['ROOMS', 1], ['USERS', 1], ['USERSETS', 0], ['MESGS', 1],
          ['ASYNC', 1], ['RANKS', 0], ['STATS', stats], ['MORE', 1], ['SLOTS', 36]]);
      }
      case '~png': case '@alv': case '@cnt': return;
      case 'auth': case 'acct': return this.auth(s, kind, f);
      case 'lost': return this.lsend(s, 'lost', [], 'imst');
      case 'cper': return this.createPersona(s, f);
      case 'dper': return this.deletePersona(s, f);
      case 'pers': return this.selectPersona(s, f);
    }
    if (this.lobby.s(s).persona === null) return this.lsend(s, kind, [], 'auth');
    switch (kind) {
      case 'move': return this.moveRoom(s, f);
      case 'mesg': return this.mesg(s, f);
      case 'auxi': return this.auxi(s, f);
      case 'user': return this.userInfo(s, f.get('PERS') ?? '');
      case 'onln': return this.online(s, f);
      case 'gsea':
        this.lobby.s(s).browsing = true;
        this.backFromRace(s);
        return this.gameSearch(s, f, code === FILTER_SET);
      case 'gcre': return this.gameCreate(s, f);
      case 'gjoi': return this.gameJoin(s, f);
      case 'gset': return this.gameSet(s, f);
      case 'gsta': return this.gameStart(s);
      case 'gdel': return this.gameDelete(s);
      case 'glea': return this.gameLeave(s, 'glea');
      case 'rank': return this.rank(s, f, code);
      case 'snap': return this.snap(s, f);
      case 'rept': return this.complaint(s, f);
      default: return this.lsend(s, kind, [], 'badc');
    }
  },

  // ---- login ----

  auth(s, kind, f) {
    const name = f.str('NAME');
    if (this.lobby.s(s).account !== null) return this.lsend(s, kind, [], 'logn');
    if (!validName(name) || blockedName(name) || this.denied(name)) return this.lsend(s, kind, [], kind === 'acct' ? 'inam' : 'imst');
    const x = this.lobby.s(s);
    x.account = name;
    x.personas = [name];
    const addr = x.addr;
    this.lobby.stats.logins += 1;
    this.llog('[online] ' + addr + ': logged in as "' + name + '" (' + this.lobby.sessions.size + ' connected)', s);
    const t = day(this.now());
    const personas = this.lobby.s(s).personas.join(',');
    const reply = fit([['NAME', name], ['PERSONAS', personas], ['TOS', 1], ['ADDR', addr], ['LAST', t], ['BORN', '19800101'],
      ['SPAM', 'NN'], ['MAIL', 'player@localhost']], 122, ['MAIL', 'SPAM', 'BORN', 'LAST']);
    this.lsend(s, kind, reply);
    for (let i = 0; i < this.lobby.rooms.length; i++) this.lsend(s, '+rom', this.roomFields(this.lobby.rooms[i].id));
  },

  createPersona(s, f) {
    if (this.lobby.s(s).account === null) return this.lsend(s, 'cper', [], 'auth');
    const p = f.str('PERS');
    if (!validName(p) || blockedName(p) || this.denied(p)) return this.lsend(s, 'cper', [], 'invp');
    const lp = lower(p);
    if (this.lobby.s(s).personas.some((x) => lower(x) === lp) || this.lobby.byPersona.has(lp)) return this.lsend(s, 'cper', [], 'dupl');
    if (this.lobby.s(s).personas.length >= this.lobby.l.personas) return this.lsend(s, 'cper', [], 'nspc');
    this.lobby.s(s).personas.push(p);
    this.lsend(s, 'cper', this.persFields(s, p));
  },

  deletePersona(s, f) {
    if (this.lobby.s(s).account === null) return this.lsend(s, 'dper', [], 'auth');
    const p = f.str('PERS');
    const lp = lower(p);
    const x = this.lobby.s(s);
    const i = x.personas.findIndex((y) => lower(y) === lp);
    const current = x.persona !== null && lower(x.persona) === lp;
    if (i < 0 || current) return this.lsend(s, 'dper', [['PERS', p], ['RESULT', 1]]);
    x.personas.splice(i, 1);
    this.lsend(s, 'dper', [['PERS', p], ['RESULT', 0]]);
  },

  /** the pers / cper reply (the game keeps it in 108 bytes) */
  persFields(s, p) {
    const t = day(this.now());
    const x = this.lobby.s(s);
    return fit([['PERS', p], ['LKEY', x.lkey ?? ''], ['NAME', x.account], ['LAST', t], ['PLAST', t]], 108, ['PLAST', 'LAST', 'NAME']);
  },

  selectPersona(s, f) {
    if (this.lobby.s(s).account === null) return this.lsend(s, 'pers', [], 'auth');
    const lp = lower(f.str('PERS'));
    let mine = this.lobby.s(s).personas.find((x) => lower(x) === lp);
    if (mine === undefined) return this.lsend(s, 'pers', [], 'invp');
    this.giveWay(mine, s);
    const asked = mine;
    const claimed = !this.mayClaim(mine, s);
    if (claimed || this.nameTaken(mine, s)) {
      const v = this.freeVariant(mine, s);
      if (v === null) return this.lsend(s, 'pers', [], 'pset');
      mine = v;
    }
    const owner = this.lobby.s(s).owner;
    if (this.claims && owner !== null) this.claims.seen(mine, owner, Math.trunc(this.now()));
    const old = this.lobby.s(s).persona;
    if (old !== null && old !== mine) this.lobby.byPersona.delete(lower(old));
    const x = this.lobby.s(s);
    x.persona = mine;
    x.lkey = randHex(this.prng, 15);
    const addr = x.addr;
    this.lobby.byPersona.set(lower(mine), s);
    this.buddyFetch(lower(mine));
    const taken = mine === asked ? '' : claimed ? ' ("' + asked + '" is claimed)' : ' ("' + asked + '" is taken)';
    this.llog('[online] ' + addr + ': plays as "' + mine + '"' + taken, s);
    this.lsend(s, 'pers', this.persFields(s, mine));
    this.lsend(s, '+who', this.userFields(s));
    this.lsend(s, '+sst', this.sstFields());
  },

  /** name's holder gives way to s: its own browser's older session, a stale one, or the name's owner */
  giveWay(name, s) {
    const hId = this.lobby.byPersona.get(lower(name));
    if (hId === undefined || hId === s) return;
    const hx = this.lobby.sess.get(hId);
    if (!hx) return;
    const owner = this.lobby.s(s).owner;
    const byOwner = owner !== null && hx.owner !== owner && this.mayClaim(name, s) && !this.mayClaimAs(name, hx.owner);
    if (hx.gone || hx.vip === this.lobby.s(s).vip || this.now() - hx.lastIn >= 30000) this.ldrop(hId, 'the persona logged in again');
    else if (byOwner) this.ldrop(hId, "the name's owner logged in");
  },

  denied(name) {
    return !!this.deny && this.deny.has(name);
  },

  racesOff(s) {
    const c = this.vh.conns.get(this.lobby.s(s).conn);
    return !!c && c.noRaces;
  },

  mayClaim(name, s) {
    return this.mayClaimAs(name, this.lobby.s(s).owner);
  },

  mayClaimAs(name, owner) {
    return !this.claims || this.claims.mayUse(name, owner, Math.trunc(this.now()));
  },

  /** name is another player's: a session that holds it, or a player racing under it from another browser on the switch */
  nameTaken(name, s) {
    if (!this.mayClaim(name, s)) return true;
    const k = lower(name);
    const hId = this.lobby.byPersona.get(k);
    if (hId !== undefined && hId !== s) {
      const hx = this.lobby.sess.get(hId);
      if (hx && !hx.gone) return true;
    }
    const vip = this.lobby.s(s).vip;
    for (const g of this.lobby.games.values()) {
      if (g.started === 0) continue;
      for (const p of g.players) if (!p.back && p.vip !== vip && lower(p.name) === k && !this.lobby.goneVips.has(p.vip)) return true;
    }
    return false;
  },

  /** a free name: name with four digits in place of its end (the same digits for one client while free) */
  freeVariant(name, s) {
    const d0 = sha256(utf8(this.lobby.s(s).group + '\n' + lower(name)));
    const own = (((d0[0] << 24) | (d0[1] << 16) | (d0[2] << 8) | d0[3]) >>> 0) % 9000 + 1000;
    for (let i = 0; i < 20; i++) {
      const d = i === 0 ? String(own) : String(randInt(this.prng, 1000, 10000));
      const cut = slice16(name, 15 - d.length) + d;
      const v = blockedName(cut) || this.denied(cut) ? 'Player' + d : cut;
      if (blockedName(v)) continue;
      this.giveWay(v, s);
      if (!this.nameTaken(v, s)) return v;
    }
    return null;
  },

  sstFields() {
    const [uil, gip, gcr] = this.lobby.sstCounts();
    return [['UIL', uil], ['UIR', 0], ['UIG', 0], ['GIP', gip], ['GCR', gcr], ['GCM', 0]];
  },

  // ---- users and rooms ----

  userFields(s) {
    const x = this.lobby.s(s);
    const g = x.game !== null ? this.lobby.games.get(x.game) || null : null;
    return [['I', x.id], ['N', x.persona], ['M', x.account], ['F', g ? 'G' : 'U'], ['A', x.addr], ['P', g ? 1 : 2], ['S', ''],
      ['X', x.auxi], ['G', g ? g.id : 0], ['AT', ''], ['CL', 511], ['LV', 0], ['MD', 0], ['LA', x.addr], ['HW', 0], ['RP', 0],
      ['MA', ''], ['US', ''], ['C', '']];
  },

  usrFields(s) {
    const x = this.lobby.s(s);
    return [['I', x.id], ['N', x.persona], ['M', x.account], ['F', 'H'], ['A', x.addr], ['P', 211], ['S', ''], ['X', x.auxi],
      ['G', x.game ?? 0], ['T', 2]];
  },

  roomFields(id) {
    const r = this.lobby.room(id);
    assert(r, 'a room');
    return [['I', r.id], ['N', r.name], ['H', 'NFSU2'], ['F', 'CK'], ['T', r.users.size], ['L', ROOM_LIMIT], ['P', 0]];
  },

  moveRoom(s, f) {
    const to = this.lobby.roomOf(f.get('NAME'));
    if (to !== null) {
      const r = this.lobby.room(to);
      if (r.users.size >= ROOM_LIMIT && !r.users.has(s)) return this.lsend(s, 'move', [], 'full');
    }
    if (!this.lobby.s(s).acts.takeAt(this.now(), 1)) return this.lsend(s, 'move', [], 'full');
    const old = this.lobby.s(s).room;
    this.leaveRoom(s);
    if (to === null) {
      return this.lsend(s, 'move', [['IDENT', 0], ['NAME', ''], ['COUNT', 0], ['LIDENT', old ?? 0], ['LCOUNT', 0]]);
    }
    const room = this.lobby.room(to);
    room.users.add(s);
    this.lobby.s(s).room = to;
    const name = room.name, count = room.users.size;
    this.lsend(s, 'move', [['IDENT', to], ['NAME', name], ['COUNT', count], ['FLAGS', 'C']]);
    const x = this.lobby.s(s);
    this.lsend(s, '+who', [['I', x.id], ['N', x.persona], ['M', x.account], ['F', ''], ['A', x.addr], ['S', ''], ['X', x.auxi],
      ['R', name], ['RI', to], ['RF', 'C'], ['RT', 1]]);
    for (const u of [...room.users]) {
      if (u === s || !room.users.has(u)) continue;
      this.lsend(s, '+usr', this.usrFields(u));
      this.lsend(u, '+usr', this.usrFields(s));
    }
    this.population(to);
  },

  leaveRoom(s) {
    const r = this.lobby.s(s).room;
    if (r === null || this.lobby.room(r) === null) return;
    const room = this.lobby.room(r);
    room.users.delete(s);
    this.lobby.s(s).room = null;
    const x = this.lobby.s(s);
    const usr = encodeFrame('+usr', '', [['I', x.id], ['T', 1]]);
    const msg = encodeFrame('+msg', '', [['F', 'C'], ['T', 'has left the room'], ['N', x.persona]]);
    for (const u of [...room.users]) {
      if (!room.users.has(u)) continue;
      this.lsendFrame(u, usr);
      this.lsendFrame(u, msg);
    }
    this.population(r);
  },

  /** a room's population to everyone, at most every announceMs (the latest) */
  population(r) {
    if (!this.lobby.pop.has(r)) this.lobby.pop.set(r, laterNew());
    this.later('p:' + r);
  },

  sendPopulation(r) {
    const room = this.lobby.room(r);
    const pop = encodeFrame('+pop', '', [['Z', r + '/' + (room ? room.users.size : 0)]]);
    for (const u of [...this.lobby.sessions]) {
      const x = this.lobby.sess.get(u);
      if (!x) continue;
      if (!this.lobby.sessions.has(u) || x.persona === null || x.gone) continue;
      this.lsendFrame(u, pop);
    }
  },

  /** a record out now, or (only the latest) once announceMs has passed since the last one */
  later(k) {
    const ms = this.lobby.l.announceMs, now = this.now();
    const a = this.lobby.laterMut(k);
    if (!a) return;
    a.pending = true;
    if (a.timer !== null) return;
    const wait = a.at + ms - now;
    if (wait <= 0) return this.fire(k);
    const t = this.setTimeout(wait, { k: 'Later', key: k });
    const a2 = this.lobby.laterMut(k);
    if (a2) a2.timer = t;
  },

  /** a later record goes now (when one waits), and its timer ends */
  fire(k) {
    const now = this.now();
    const a = this.lobby.laterMut(k);
    if (!a) return;
    const t = a.timer;
    a.timer = null;
    a.at = now;
    const pending = a.pending;
    a.pending = false;
    if (t !== null) this.timers.clear(t);
    if (pending) {
      const id = Number(k.slice(2));
      if (k[0] === 'p') this.sendPopulation(id);
      else this.sendAgm(id);
    }
  },

  laterTimer(k, id) {
    const a = this.lobby.laterMut(k);
    if (a && a.timer === id) this.fire(k);
  },

  auxi(s, f) {
    const text = slice16(f.str('TEXT'), this.lobby.l.auxiLen);
    this.lobby.s(s).auxi = text;
    this.lsend(s, 'auxi', [['TEXT', text]]);
    this.lsend(s, '+who', this.userFields(s));
    if (!this.lobby.s(s).acts.takeAt(this.now(), 1)) return;
    const r = this.lobby.s(s).room;
    if (r !== null && this.lobby.room(r) !== null) {
      const room = this.lobby.room(r);
      for (const u of [...room.users]) if (u !== s && room.users.has(u)) this.lsend(u, '+usr', this.usrFields(s));
    }
    const gid = this.lobby.s(s).game;
    const g = gid !== null ? this.lobby.games.get(gid) : undefined;
    if (g) {
      for (const p of g.players.map((p) => ({ ...p }))) {
        if (p.s !== s && !this.lobby.playerGone(p)) this.lsend(p.s, '+who', this.userFields(s));
      }
    }
  },

  /** a persona's online career */
  userInfo(s, pers) {
    const u = this.lobby.byPersona.get(lower(pers));
    const rec = this.stats.rec(pers, false);
    const r = rec ? rec.name : null;
    if (u === undefined && r === null) return this.lsend(s, 'user', [], 'badc');
    const name = u !== undefined ? this.lobby.s(u).persona ?? '' : r ?? '';
    const t = day(this.now());
    const stat = this.stats.statField(name, false);
    const lmstat = this.stats.statField(name, true);
    const addr = u !== undefined ? this.lobby.s(u).addr : '';
    this.lsend(s, 'user', [['PERS', name], ['LAST', t], ['EXPR', 1072566000], ['STAT', stat], ['CHEAT', 3], ['ACK_REP', 186],
      ['REP', 186], ['PLAST', t], ['PSINCE', t], ['DCNT', 0], ['ADDR', addr], ['SERV', 'NFSU2'], ['RANK', 99999], ['MESG', ''],
      ['LMSTAT', lmstat], ['LGAME', '']]);
    const auxi = u !== undefined ? this.lobby.s(u).auxi : '';
    this.lsend(s, 'auxi', [['TEXT', auxi]]);
  },


  // ---- results and rankings ----

  /** a player's report of a finished race (lobby.rs rank: see its text) */
  rank(s, f, code) {
    const reply = () => {
      const time = Math.floor(this.now() / 1000) % 100000;
      this.lsend(s, 'rank', [['RANK', 'Unranked'], ['TIME', time]]);
    };
    const auth = f.str('AUTH');
    const persona = lower(tpl(this.lobby.s(s).persona));
    let g = null;
    if (auth !== '') for (const x of this.lobby.games.values()) if (x.auth === auth) { g = x.id; break; }
    let me = -1;
    if (g !== null) {
      const gm = this.lobby.game(g);
      if (gm) me = gm.players.findIndex((p) => lower(p.name) === persona);
    }
    if (g === null || me < 0) {
      this.llog('[online] ' + this.who(s) + ": a race report for no race of this server's (ignored)", s);
      return reply();
    }
    let gm = this.lobby.game(g);
    gm.players[me].back = true;
    gm.players[me].results = s;
    if (gm.players[me].reported) {
      reply();
      return this.resultsTable(g, s);
    }
    const r = decodeResult(f.get('RESU') ?? 'undefined');
    const names = [];
    let i = 0;
    while (f.has('NAME' + i) && i < 8) {
      names.push(f.get('NAME' + i) ?? 'null');
      i++;
    }
    const jc = jumpCode(code);
    if (jc !== null && jc[0] < names.length) {
      const want = lower(names[jc[0]]);
      const players = this.lobby.game(g).players;
      const j = players.findIndex((x) => lower(x.name) === want);
      if (j >= 0 && j !== me && !players[j].jumped.some((x) => x[0] === me)) players[j].jumped.push([me, jc[1]]);
    }
    let why = this.checkReport(g, r, names);
    const spers = tpl(this.lobby.s(s).persona);
    const gname = this.lobby.game(g).name;
    if (r !== null && why === '') {
      const mine = r.players.find((p) => lower(names[p.index]) === persona) || null;
      const players = this.lobby.game(g).players;
      const views = [];
      for (const p of r.players) {
        if (!(!p.dropped && p.place >= 1 && p.time > 0 && p.time < 100000)) continue;
        const want = lower(names[p.index]);
        const j = players.findIndex((x) => lower(x.name) === want);
        if (j >= 0) views.push([j, p.time]);
      }
      const lines = raceCheats(gname, r, me, mine, editedCode(code), views, players);
      lines.push(...jumpLines(gname, r, players));
      for (const line of lines) this.llog(line, s);
      why = this.checkTimes(g, r);
    }
    if (why !== '') {
      this.llog('[online] "' + gname + '": ' + spers + "'s race report not taken: " + why, s);
      reply();
      this.resultsTable(g, s);
      return this.endIfBack(g);
    }
    assert(r !== null, 'checked');
    const drift = r.kind === MODE_DRIFT;
    if (drift) {
      const p = r.players.find((p) => lower(names[p.index]) === persona);
      if (p) {
        const how = p.dropped || p.place === 0 ? 'did not finish' : p.place + ' of ' + r.players.length;
        const name = this.lobby.game(g).players[me].name;
        this.llog('[online] "' + gname + '" (drift, track ' + r.track + lapsText(r.laps) + '): ' + name + "'s own game: " + how + ', ' +
          p.score + ' points, its biggest drift ' + p.driftBest + ', top speed ' + fmt0(p.top * 3.6) + ' km/h, ' + fmtTime(p.time), s);
      }
    }
    const own = r.players.find((p) => !p.dropped && lower(names[p.index]) === persona);
    const finished = r.players.some((p) => (!p.dropped || p.state === OUT) && lower(names[p.index]) === persona);
    if (own) this.stats.addRecords(this.lobby.game(g).players[me].name, r.kind, own);
    gm = this.lobby.game(g);
    gm.players[me].reported = true;
    let order = r.players.map((p) => {
      const want = lower(names[p.index]);
      const x = gm.players.find((x) => lower(x.name) === want);
      const fin = !p.dropped;
      return { name: x ? x.name : '', place: fin ? p.place : 0, time: p.time, left: !fin && p.state !== OUT };
    });
    order = order.map((p, i) => [p, i]).sort((a, b) => ((a[0].place === 0 ? 99 : a[0].place) - (b[0].place === 0 ? 99 : b[0].place)) || a[1] - b[1]).map((x) => x[0]);
    const others = order.filter((p) => p.place === 0).map((p) => p.name);
    const key = order.filter((p) => p.place !== 0).map((p) => p.name + ':' + p.place).join(',') + '|' + others.join(',');
    const decides = finishersOf(key);
    const points = (name) => {
      const p = r.players.find((p) => lower(names[p.index]) === lower(name));
      return p ? p.score : 0;
    };
    const lineOf = (order) => order.map((p) => {
      const place = p.place === 0 ? 'DNF' : String(p.place);
      let time;
      if (p.place === 0 && !p.left) time = ' (out of time)';
      else if (p.place === 0) time = '';
      else if (drift) time = ' ' + points(p.name) + ' points';
      else time = ' ' + fmtTime(p.time);
      return place + ' ' + p.name + time;
    }).join(', ');
    const line = lineOf(order);
    const svip = this.lobby.s(s).vip;
    gm = this.lobby.game(g);
    let to = null;
    let before = [];
    if (!finished || decides === '') {
      if (gm.result !== null) to = s;
      const w = finished ? "'s report has no racer who finished" : ' did not finish';
      this.llog('[online] "' + gname + '": ' + spers + w + ': the report decides nothing (' + line + ')', s);
    } else if (gm.result !== null) {
      to = s;
      if (finishersOf(gm.result) !== decides) this.llog('[online] "' + gname + '": ' + spers + "'s report differs (" + line + '); the result stands', s);
    } else {
      const m = gm.reports.find(([v, k]) => finishersOf(k) === decides && v !== svip);
      if (m) {
        for (const name of othersOf(m[1])) {
          if (!order.some((p) => lower(p.name) === lower(name))) order.push({ name, place: 0, time: 0, left: true });
        }
        const line2 = lineOf(order);
        const ranked = gm.ranked && order.length >= 3;
        const wasRanked = gm.ranked;
        const n = order.length;
        const table = gm.ranked ? this.tableFrame(g, r, names, n, ranked && r.kind < RACE_TYPES.length) : null;
        const far = farAhead(gname, r.kind, order, this.lobby.game(g).players);
        const players = this.lobby.game(g).players;
        const told = far !== null || (() => {
          const w = order.find((p) => p.place === 1);
          return !!w && players.some((p) => lower(p.name) === lower(w.name) && p.own && p.own.told);
        })();
        const quick = quickWin(this.lobby.wins, gname, r, order, players, told);
        gm = this.lobby.game(g);
        gm.result = key;
        gm.table = table;
        before = gm.players.filter((p) => p.results !== null && p.results !== s).map((p) => [p.results, p.name]);
        if (far !== null) this.llog(far, s);
        if (quick !== null) this.llog(quick, s);
        this.stats.addRace({ kind: r.kind, ranked, track: r.track, players: order });
        const tail = r.kind >= RACE_TYPES.length ? ' (no stats for this race type)'
          : wasRanked && !ranked ? ' (a ranked race needs 3 players: no points)' : '';
        const rt = REPORT_TYPES[r.kind];
        const at = drift ? ', track ' + r.track + ', ' + r.laps + ' lap' + (r.laps === 1 ? '' : 's') : '';
        this.llog('[online] "' + gname + '" (' + rt + ', ' + (ranked ? 'ranked' : 'unranked') + at + '): ' + line2 + tail, s);
      } else {
        if (gm.reports.length > 0 && !gm.reports.some(([, k]) => finishersOf(k) === decides)) {
          this.llog('[online] "' + gname + '": ' + spers + "'s report differs (" + line + ')', s);
        }
        this.lobby.game(g).reports.push([svip, key]);
      }
    }
    reply();
    this.userInfo(s, this.lobby.s(s).persona ?? '');
    for (const [x, name] of before) this.userInfo(x, name);
    this.resultsTable(g, to);
    this.endIfBack(g);
  },

  /** a ranked race's table on its players' results screens ($rfn once the result stands, $rup until then) */
  resultsTable(g, to) {
    const gm = this.lobby.game(g);
    if (!gm || !gm.ranked) return;
    let frame = gm.table;
    if (frame === null) {
      const f = [];
      gm.players.slice(0, 6).forEach((p, i) => f.push(['OPPO' + i, p.name], ['STAT' + i, p.reported ? 1 : 0]));
      f.push(['TIME', RESULTS_WAIT_MS]);
      frame = encodeFrame('$rup', '', f);
    }
    const sessions = to !== null ? [to] : gm.players.filter((p) => p.results !== null).map((p) => p.results);
    for (const x of sessions) this.lsendFrame(x, frame);
  },

  /** the ranked table ($rfn) from the report that decided the result */
  tableFrame(g, r, names, n, pts) {
    const hx = (x) => (x < 0 ? '-' + (-x).toString(16) : x.toString(16));
    const f = [];
    this.lobby.game(g).players.slice(0, 6).forEach((pl, i) => {
      const want = lower(pl.name);
      const p = r.players.find((p) => lower(names[p.index]) === want);
      if (!p) return;
      const place = p.dropped ? 0 : p.place;
      const first = REPORT_TYPES[r.kind] === 'drift' ? p.score : Math.trunc(Math.min(1e9, Math.max(0, rustRound(p.time * 1000))));
      const points = Math.trunc(racePoints(pts, n, place));
      f.push(['OPPO' + i, pl.name], ['DATA' + i, hx(first) + ',' + hx(place === 0 ? -2 : place) + ',0,0,' + hx(points)]);
    });
    return encodeFrame('$rfn', '', f);
  },

  /** why a decoded race report is not one of game g's ('' = it is) */
  checkReport(g, r, names) {
    if (r === null) return 'the report does not parse';
    const gm = this.lobby.game(g);
    if (r.players.length !== names.length || names.length > gm.players.length) return "not the game's number of players";
    const want = new Set(gm.players.map((p) => lower(p.name)));
    if (!names.every((n) => want.delete(lower(n)))) return "not the game's players";
    const idx = new Set(r.players.map((p) => p.index));
    const places = r.players.filter((p) => !p.dropped).map((p) => p.place);
    if (idx.size !== names.length || [...idx].some((i) => i >= names.length)) return 'players named twice';
    const distinct = new Set(places);
    if (distinct.size !== places.length || places.some((p) => p < 1 || p > names.length)) return 'places do not add up';
    if (r.kind >= REPORT_TYPES.length) return 'race type ' + r.kind;
    return '';
  },

  /** why a race report of the right shape cannot be game g's result by its times ('' = it can) */
  checkTimes(g, r) {
    const gm = this.lobby.game(g);
    const age = (this.now() - gm.started) / 1000;
    const min = MIN_RACE_S[r.kind];
    if (age < min) return 'a race of ' + toFixed(age, 1) + ' s (a ' + REPORT_TYPES[r.kind] + ' race takes ' + String(min) + ' s at least)';
    if (r.players.some((p) => !p.dropped && !(p.time >= min && p.time <= age + 5))) return 'a time the race has not had';
    return '';
  },

  /** back in the lobby after a race (its game list): the race is over for this player */
  backFromRace(s) {
    const x = this.lobby.s(s);
    const vip = x.vip, persona = lower(tpl(x.persona));
    for (const id of [...this.lobby.games.keys()]) {
      const g = this.lobby.games.get(id);
      if (!g || g.started === 0) continue;
      const me = g.players.find((p) => p.vip === vip && lower(p.name) === persona);
      if (!me) continue;
      if (me.s !== s) {
        me.back = true;
        this.endIfBack(id);
      }
    }
  },

  endIfBack(g) {
    const x = this.lobby.game(g);
    if (!x) return;
    if (x.started !== 0 && x.players.every((p) => p.back)) this.endGame(g, 'every player is back in the lobby');
  },

  /** a ranking (the game's Rankings screens): see lobby.rs snap */
  snap(s, f) {
    const chan = toInt32(f.num('CHAN', NaN));
    const index = f.get('INDEX') ?? 0;
    const start = Math.max(0, toInt32(f.num('START', 0)));
    const range = Math.min(100, Math.max(0, toInt32(f.num('RANGE', 0))));
    const at = chan - 6;
    const kind = at >= 0 && at < 24 ? SLOT_TYPES[at % 6] : null;
    const own = at >= 6 && at < 12;
    const period = at >= 12 && at < 18 ? 'month' : at >= 18 ? 'lastMonth' : 'all';
    const find = f.get('FIND');
    const persona = this.lobby.s(s).persona ?? '';
    const board = kind !== null ? this.stats.ranking(kind, period) : null;
    const all = board ? board.rows : [];
    let rows;
    if (own || find !== null) {
      const fv = find ?? '';
      const w = fv.startsWith('$') ? fv.slice(1) : fv;
      const who = w === '' ? persona : w;
      const i = board ? board.index.get(lower(who)) : undefined;
      rows = i !== undefined ? [all[i]] : [];
    } else {
      rows = all.slice(Math.min(start, all.length), Math.min(start + range, all.length));
    }
    const total = all.length;
    this.lsend(s, 'snap', [['INDEX', index], ['CHAN', chan], ['START', start], ['RANGE', rows.length], ['SEQN', 0],
      ['COUNT', rows.length], ['TOTAL', total], ['MORE', 0]]);
    for (const r of rows) {
      this.lsend(s, '+snp', [['N', r.name], ['R', r.rank], ['P', toUint32(r.points)], ['S', h(r.points) + ',' + h(r.wins) + ',' + h(r.losses)], ['O', 1]]);
    }
  },

  online(s, f) {
    const u = this.lobby.byPersona.get(lower(f.str('PERS')));
    if (u === undefined) return this.lsend(s, 'onln', [['I', 0], ['N', cleanText(f.str('PERS'), 16)]]);
    this.lsend(s, 'onln', this.userFields(u));
  },

  // ---- chat ----

  mesg(s, f) {
    const now = this.now();
    if (now < this.lobby.s(s).muteUntil) return this.lsend(s, 'mesg', [], 'mute');
    if (!this.lobby.s(s).chats.takeAt(now, 1)) {
      const mute = this.lobby.l.muteMs;
      this.lobby.s(s).muteUntil = now + mute;
      this.llog('[online] ' + this.who(s) + ': chat flood, muted for ' + String(mute / 1000) + ' s', s);
      return this.lsend(s, 'mesg', [], 'mute');
    }
    const text = cleanText(f.str('TEXT'), this.lobby.l.chatLen);
    const attr = slice16(f.str('ATTR'), 8);
    this.lsend(s, 'mesg', attr === '' ? [] : [['ATTR', attr]]);
    if (text === '' && attr === '') return;
    this.lobby.stats.chats += 1;
    const persona = this.lobby.s(s).persona;
    const me = persona !== null ? lower(persona) : '';
    const priv = f.get('PRIV');
    const to = priv !== null && priv !== '' ? lower(priv) : null;
    const slur = chatSlur(text);
    if (slur !== null) {
      const l = this.lobby.l;
      const x = this.lobby.s(s);
      const rec = { times: x.slurs, until: x.muteUntil };
      const muted = slurSaid(l, rec, now);
      x.slurs = rec.times;
      x.muteUntil = rec.until;
      const then = muted ? '; muted for ' + String(l.slurMuteMs / 1000) + ' s' : '';
      this.llog('[online] ' + this.who(s) + ': a line with ' + q(slur) + ' in it, shown to no one else' + then, s);
    }
    if (text !== '' && me !== '') {
      const l = this.lobby.l;
      if (!this.lobby.said.has(me)) this.lobby.said.set(me, []);
      const said = this.lobby.said.get(me);
      said.push({ t: now, text, to, hidden: slur !== null });
      while (said.length > l.saidLines) said.shift();
    }
    const withAttr = (v) => (attr !== '' ? v.concat([['A', attr]]) : v);
    const hidden = slur !== null, blocked = this.buddies.blocked(me);
    if (to !== null) {
      const u = this.lobby.byPersona.get(to);
      if (u !== undefined && !this.lobby.s(u).gone && this.hears(u, s, me, hidden, blocked)) {
        this.lsend(u, '+msg', withAttr([['F', 'P'], ['T', text], ['N', persona]]));
      }
      return;
    }
    const msg = encodeFrame('+msg', '', withAttr([['F', 'U'], ['T', text], ['N', persona]]));
    const room = this.lobby.s(s).room;
    const gid = this.lobby.s(s).game;
    const g = gid !== null ? this.lobby.games.get(gid) : undefined;
    if (g && (attr.includes('G') || room === null)) {
      for (const p of g.players.map((p) => p.s)) {
        if (p === null) continue;
        if (this.hears(p, s, me, hidden, blocked)) this.lsendFrame(p, msg);
      }
      return;
    }
    if (room !== null && this.lobby.room(room) !== null) {
      const rm = this.lobby.room(room);
      for (const u of [...rm.users]) if (rm.users.has(u) && this.hears(u, s, me, hidden, blocked)) this.lsendFrame(u, msg);
    }
  },

  /** session u hears a line of session s (persona from, lower case) */
  hears(u, s, from, hidden, blocked) {
    if (u === s) return true;
    if (hidden) return false;
    if (!blocked) return true;
    const p = this.lobby.s(u).persona;
    return !(p !== null && this.buddies.blocks(lower(p), from));
  },

  /** "Submit Complaint" about persona PERS */
  complaint(s, f) {
    const name = cleanText(f.str('PERS'), 16);
    const k = lower(name);
    const mp = this.lobby.s(s).persona;
    const me = mp !== null ? lower(mp) : null;
    const now = this.now(), ms = this.lobby.l.saidMs;
    const said = (this.lobby.said.get(k) || [])
      .filter((x) => now - x.t <= ms && (x.to === null || x.to === me))
      .map((x) => q(x.text) + (x.hidden ? ' (shown to no one)' : ''));
    const u = this.lobby.byPersona.get(k);
    const whom = u !== undefined && !this.lobby.s(u).gone ? this.who(u) : '"' + name + '"';
    const tail = said.length === 0 ? ' (no lines of its kept)' : ', who said: ' + said.join(' ');
    this.llog('[online] ' + this.who(s) + ': a complaint about ' + whom + tail, s);
    this.lsend(s, 'rept', [['TEXT', 'Report complete']]);
  },

  // ---- games ----

  gameFields(gid, extra = []) {
    const g = this.lobby.game(gid);
    assert(g, 'held');
    const f = [['IDENT', g.id], ['WHEN', g.when], ['NAME', g.name], ['HOST', g.hostName], ['ROOM', g.room], ['MAXSIZE', g.maxSize],
      ['MINSIZE', g.minSize], ['COUNT', g.players.length], ['CUSTFLAGS', g.custFlags], ['SYSFLAGS', g.sysFlags], ['EVID', 0],
      ['EVGID', 0], ['NUMPART', 1]];
    g.players.forEach((p, i) => {
      f.push(['OPID' + i, p.id], ['OPPO' + i, p.name], ['ADDR' + i, p.addr], ['LADDR' + i, p.addr], ['MADDR' + i, ''],
        ['OPPART' + i, 0], ['OPFLAG' + i, p.flags]);
    });
    f.push(['PARTSIZE0', g.maxSize], ['PARAMS', g.params], ['PARTPARAMS0', '']);
    for (let i = 0; i < g.players.length; i++) f.push(['OPPARAM' + i, '']);
    return f.concat(extra);
  },

  /** the game list (lobby.rs game_search) */
  gameSearch(s, f, filterSet) {
    const n = (k) => toUint32(f.num(k, 0));
    const cf = n('CUSTFLAGS'), cm = n('CUSTMASK'), sf = n('SYSFLAGS'), sm = n('SYSMASK');
    const asked4 = [(cf & cm) >>> 0, cm, (sf & sm) >>> 0, sm];
    const onlyAsked = filterSet && asked4.some((v, i) => v !== FILTER_DEFAULT[i]);
    const start = Math.max(0, toInt32(f.num('START', 0)));
    const count = Math.min(Math.max(0, toInt32(f.num('COUNT', 20))), GAMES_PER_UPDATE);
    const x = this.lobby.s(s);
    const room = x.room, mine = x.game;
    const asked = (g) => ((g.custFlags & cm) >>> 0) === ((cf & cm) >>> 0) && ((g.sysFlags & sm) >>> 0) === ((sf & sm) >>> 0);
    const open = [...this.lobby.games.values()].filter((g) => g.started === 0 && (g.custFlags & PRIVATE) === 0 &&
      (room === null || g.room === 0 || g.room === room));
    const list = open.filter((g) => asked(g)).concat(open.filter((g) => !onlyAsked && !asked(g))).slice(start, start + count).map((g) => g.id);
    this.lsend(s, 'gsea', [['COUNT', list.length]]);
    for (const g of list) this.lsend(s, mine === g ? '+mgm' : '+gam', this.gameFields(g));
  },

  gameCreate(s, f) {
    if (this.lobby.s(s).game !== null) this.gameLeave(s, null);
    if (this.racesOff(s)) {
      this.llog('[online] ' + this.who(s) + ': under a race ban: made no game', s);
      return this.lsend(s, 'gcre', [], 'full');
    }
    const now = this.now();
    if (this.lobby.games.size >= this.lobby.l.games || !this.lobby.s(s).creates.takeAt(now, 1)) return this.lsend(s, 'gcre', [], 'full');
    const { vip, group } = this.lobby.s(s);
    const [mv, mg] = this.lobby.gamesOf(vip, group, false);
    if (mv >= this.lobby.l.openPerVip || mg >= this.lobby.l.openPerGroup) return this.lsend(s, 'gcre', [], 'full');
    const name = cleanText(f.str('NAME'), this.lobby.l.gameNameLen);
    if (name === '' || blockedName(name)) return this.lsend(s, 'gcre', [], 'inam');
    const persona = this.lobby.s(s).persona ?? '';
    const old = this.lobby.gameByName(name);
    if (old !== null) {
      const o = this.lobby.games.get(old);
      if (o.hostName === persona && o.started !== 0) this.endGame(old, 'its creator made a new one');
      else return this.lsend(s, 'gcre', [], 'dupl');
    }
    const sysFlags = (toUint32(f.num('SYSFLAGS', 0)) & ~ACTIVE) >>> 0;
    const pass = f.str('PASS');
    const password = pass !== '' ? new RoomPassword(this.prng, pass) : null;
    const l = this.lobby.l;
    const size = (k, def) => Math.min(l.gameSize, Math.max(2, toInt32(f.num(k, def))));
    const id = this.lobby.nextGame;
    this.lobby.nextGame += 1;
    const x = this.lobby.s(s);
    const g = {
      id, when: day(now), name, hostName: persona, room: x.room ?? 0, vip: x.vip, group: x.group,
      maxSize: size('MAXSIZE', 4), minSize: size('MINSIZE', 2), custFlags: toUint32(f.num('CUSTFLAGS', 0)),
      sysFlags: ((sysFlags & ~PASSWORD) | (password ? PASSWORD : 0)) >>> 0, password,
      params: slice16(f.str('PARAMS'), 256), players: [this.member(s)], started: 0, auth: '', reports: [], result: null,
      table: null, ranked: (sysFlags & RANKED) !== 0,
    };
    this.lobby.games.set(id, g);
    x.game = id;
    x.browsing = false;
    this.lobby.stats.games += 1;
    this.llog('[online] ' + this.who(s) + ': created the game "' + name + '" (' + this.lobby.games.size + ' games)', s);
    this.lsend(s, 'gcre', this.gameFields(id));
    this.lsend(s, '+who', this.userFields(s));
    this.lsend(s, '+mgm', this.gameFields(id));
    this.announce(id, false);
  },

  member(s) {
    const x = this.lobby.s(s);
    return { s, id: x.id, name: x.persona ?? '', addr: x.addr, vip: x.vip, flags: 0, back: false, reported: false, results: null,
      own: null, seen: [], jumped: [], jumpTold: false };
  },

  /** a game's record to everyone looking at the game list in its room, at most every announceMs: the latest */
  announce(g, gone) {
    const x = this.lobby.game(g);
    if (!x) return;
    if ((x.custFlags & PRIVATE) !== 0) return;
    let a = this.lobby.agm.get(g);
    if (!a) {
      a = { later: laterNew(), gone: false, room: x.room };
      this.lobby.agm.set(g, a);
    }
    if (gone) a.gone = true;
    this.later('a:' + g);
  },

  sendAgm(g) {
    const a = this.lobby.agm.get(g);
    if (!a) return;
    const gone = a.gone, room = a.room;
    if (gone) this.lobby.agm.delete(g);
    const x = this.lobby.game(g);
    const rec = encodeFrame('+agm', '', x && !gone && x.started === 0 ? this.gameFields(g) : [['IDENT', g]]);
    const rm = this.lobby.room(room);
    const targets = rm !== null ? [...rm.users] : [...this.lobby.sessions];
    for (const u of targets) {
      const still = rm !== null ? rm.users.has(u) : this.lobby.sessions.has(u);
      const y = this.lobby.sess.get(u);
      if (!y) continue;
      if (!still || y.persona === null || y.gone || !y.browsing || y.game === g) continue;
      this.lsendFrame(u, rec);
    }
  },

  gameJoin(s, f) {
    if (!this.lobby.s(s).acts.takeAt(this.now(), 1)) return this.lsend(s, 'gjoi', [], 'full');
    if (this.racesOff(s)) {
      this.llog('[online] ' + this.who(s) + ': under a race ban: joined no game', s);
      return this.lsend(s, 'gjoi', [], 'full');
    }
    const ident = f.num('IDENT', NaN);
    const byId = Number.isFinite(ident) && ident >= 0 && Number.isInteger(ident) && this.lobby.games.has(ident) ? ident : null;
    const byName = this.lobby.gameByName(f.str('NAME'));
    const g = byName !== null ? byName : byId;
    if (g === null) return this.lsend(s, 'gjoi', [], 'ugam');
    const x = this.lobby.games.get(g);
    if (x.started !== 0) return this.lsend(s, 'gjoi', [], 'ugam');
    if (x.players.length >= x.maxSize) return this.lsend(s, 'gjoi', [], 'full');
    if (x.password && !x.password.matches(f.str('PASS'))) return this.lsend(s, 'gjoi', [], 'pass');
    const cur = this.lobby.s(s).game;
    if (cur !== null && cur === g) return this.lsend(s, 'gjoi', this.gameFields(g));
    if (cur !== null) this.gameLeave(s, null);
    const m = this.member(s);
    const x2 = this.lobby.games.get(g);
    assert(x2, 'live');
    x2.players.push(m);
    const gname = x2.name, n = x2.players.length, max = x2.maxSize;
    const xs = this.lobby.s(s);
    xs.game = g;
    xs.browsing = false;
    this.llog('[online] ' + this.who(s) + ': joined "' + gname + '" (' + n + '/' + String(max) + ')', s);
    this.lsend(s, 'gjoi', this.gameFields(g));
    this.lsend(s, '+who', this.userFields(s));
    const gg = this.lobby.game(g);
    const players = gg ? gg.players.map((p) => p.s) : [];
    for (const p of players) if (p !== null && p !== s) this.lsend(p, '+who', this.userFields(s));
    this.update(g);
  },

  /** a changed game to its players (+mgm) and the game list (+agm) */
  update(g) {
    const rec = encodeFrame('+mgm', '', this.gameFields(g));
    const gg = this.lobby.game(g);
    const players = gg ? gg.players.map((p) => p.s) : [];
    for (const p of players) if (p !== null) this.lsendFrame(p, rec);
    this.announce(g, false);
  },

  gameSet(s, f) {
    const g = this.lobby.s(s).game;
    if (g === null || !this.lobby.games.has(g)) return this.lsend(s, 'gset', [], 'ugam');
    let changed = false;
    if (f.has('USERFLAGS')) {
      const flags = (toUint32(f.num('USERFLAGS', NaN)) & READY) >>> 0;
      const x = this.lobby.games.get(g);
      const p = x.players.find((p) => p.s === s);
      if (p) {
        if (p.flags !== flags) {
          p.flags = flags;
          changed = true;
        }
      } else {
        this.consoleError('[online] ' + this.who(s) + ': "gset" failed: TypeError: Cannot read properties of undefined (reading \'flags\')');
        return this.ldrop(s, 'server error');
      }
    }
    const persona = this.lobby.s(s).persona ?? '';
    const l = this.lobby.l;
    const x = this.lobby.games.get(g);
    if (persona === x.hostName && x.started === 0) {
      if (f.has('PARAMS')) {
        const p = slice16(f.get('PARAMS') ?? 'null', 256);
        if (x.params !== p) {
          x.params = p;
          changed = true;
        }
      }
      if (f.has('MAXSIZE')) {
        const v = Math.min(l.gameSize, Math.max(Math.max(x.players.length, 2), toInt32(f.num('MAXSIZE', NaN))));
        if (x.maxSize !== v) {
          x.maxSize = v;
          changed = true;
        }
      }
      if (f.has('MINSIZE')) {
        const v = Math.min(x.maxSize, Math.max(2, toInt32(f.num('MINSIZE', NaN))));
        if (x.minSize !== v) {
          x.minSize = v;
          changed = true;
        }
      }
      if (f.has('SYSFLAGS')) {
        const v = ((x.sysFlags & ~COUNTDOWN) | (toUint32(f.num('SYSFLAGS', NaN)) & COUNTDOWN)) >>> 0;
        if (x.sysFlags !== v) {
          x.sysFlags = v;
          changed = true;
        }
      }
      const kicks = new Set(f.str('KICK').split(',').map((n) => lower(n.trim())).filter((n) => n !== ''));
      for (const kick of kicks) {
        const gx = this.lobby.game(g);
        if (!gx) break;
        const k = gx.players.find((p) => lower(p.name) === kick && p.s !== s);
        if (!k) continue;
        this.llog('[online] "' + gx.name + '": ' + k.name + ' kicked out by ' + persona, s);
        const ks = k.s;
        if (ks === null) continue;
        this.gameLeave(ks, null);
        this.lsend(ks, '+who', this.userFields(ks));
        this.lsend(ks, '+mgm', this.gameFields(g));
      }
    }
    this.lsend(s, 'gset', this.gameFields(g));
    if (changed) this.update(g);
  },

  gameStart(s) {
    const g = this.lobby.s(s).game;
    if (g === null || !this.lobby.games.has(g)) return this.lsend(s, 'gsta', [], 'ugam');
    const x = this.lobby.games.get(g);
    const persona = this.lobby.s(s).persona ?? '';
    if (x.hostName !== persona) return this.lsend(s, 'gsta', [], 'host');
    if (x.players.length < x.minSize) return this.lsend(s, 'gsta', [], 'nepl');
    if (new Set(x.players.map((p) => p.vip)).size !== x.players.length) return this.lsend(s, 'gsta', [], 'nepl');
    const { vip, group } = this.lobby.s(s);
    const [mv, mg] = this.lobby.gamesOf(vip, group, true);
    if (mv >= this.lobby.l.startedPerVip || mg >= this.lobby.l.startedPerGroup) return this.lsend(s, 'gsta', [], 'full');
    const now = this.now();
    x.started = now;
    x.sysFlags = (x.sysFlags | ACTIVE) >>> 0;
    x.auth = hex(md5(utf8(x.id + ':' + x.name + ':' + String(now) + ':' + randHex(this.prng, 8))));
    const gname = x.name, names = x.players.map((p) => p.name).join(', ');
    this.lobby.stats.races += 1;
    const seed = randInt(this.prng, 1, 2 ** 31);
    this.llog('[online] "' + gname + '": the race starts (' + names + ')', s);
    this.lsend(s, 'gsta', []);
    this.update(g);
    const gg = this.lobby.game(g);
    const players = gg ? gg.players.map((p) => [p.s, p.name]) : [];
    const auth = gg ? gg.auth : '';
    for (const [p, name] of players) {
      if (p === null) continue;
      this.lsend(p, '+ses', this.gameFields(g, [['AUTH', auth], ['SEED', seed], ['SELF', name]]));
    }
  },

  gameDelete(s) {
    const g = this.lobby.s(s).game;
    if (g === null || !this.lobby.games.has(g)) return this.lsend(s, 'gdel', [], 'ugam');
    if (this.lobby.games.get(g).hostName !== (this.lobby.s(s).persona ?? '')) return this.lsend(s, 'gdel', [], 'host');
    this.lsend(s, 'gdel', []);
    this.endGame(g, 'deleted by its creator');
  },

  /** s leaves its game: kind = the reply's kind ('glea'), or null (the session or the game went) */
  gameLeave(s, kind) {
    const x = this.lobby.s(s);
    const g = x.game !== null && this.lobby.games.has(x.game) ? x.game : null;
    x.game = null;
    if (kind !== null) x.browsing = true;
    if (g === null) {
      if (kind !== null) this.lsend(s, kind, []);
      return;
    }
    if (kind !== null) this.lsend(s, kind, []);
    const persona = this.lobby.s(s).persona;
    const gm = this.lobby.game(g);
    if (!gm) return;
    if (gm.started !== 0) {
      const p = gm.players.find((p) => p.s === s);
      if (p) p.s = null;
      return;
    }
    gm.players = gm.players.filter((p) => p.s !== s);
    if (gm.players.length === 0 || gm.hostName === persona) {
      return this.endGame(g, gm.players.length === 0 ? 'empty' : 'its creator left');
    }
    this.update(g);
  },

  endGame(g, why) {
    const x = this.lobby.games.get(g);
    if (!x) return;
    this.lobby.games.delete(g);
    const players = x.players.map((p) => p.s);
    const group = x.group, gname = x.name;
    this.lobby.dead.set(g, x);
    for (const p of players) {
      if (p === null) continue;
      const y = this.lobby.sess.get(p);
      if (!y || y.gone) continue;
      if (y.game === g) {
        y.game = null;
        y.browsing = true;
      }
      this.lsend(p, '+who', this.userFields(p));
      this.lsend(p, '+mgm', [['IDENT', g]]);
    }
    this.announce(g, true);
    this.log('[online] the game "' + gname + '" ended: ' + why + ' (' + this.lobby.games.size + ' games)', group);
  },

  // ---- leaving, keep-alive ----

  lobbyLeave(s, why) {
    const x = this.lobby.sess.get(s);
    if (!x || x.gone) return;
    if (x.game !== null) this.gameLeave(s, null);
    this.lobby.s(s).gone = true;
    this.lobby.removeLive(s);
    this.lobby.graveyard.push(s);
    this.leaveRoom(s);
    const y = this.lobby.s(s);
    if (y.persona !== null) {
      const k = lower(y.persona);
      if (this.lobby.byPersona.get(k) === s) this.lobby.byPersona.delete(k);
    }
    if (this.lobby.s(s).account !== null) {
      this.llog('[online] ' + this.who(s) + ': left (' + why + '; ' + this.lobby.sessions.size + ' connected)', s);
    }
  },

  /** the lobby's 5 s tick */
  lobbyTick() {
    this.forgetReadRaces();
    const now = this.now();
    const l = this.lobby.l;
    const keys = [...this.lobby.agm.keys()].map((g) => 'a:' + g).concat([...this.lobby.pop.keys()].map((r) => 'p:' + r));
    for (const k of keys) {
      const a = this.lobby.laterMut(k);
      if (a && a.timer !== null && now - a.at >= l.announceMs) this.fire(k);
    }
    const sst = this.lobby.sstCounts();
    const last = this.lobby.lastSst;
    if (last === null || last[0] !== sst[0] || last[1] !== sst[1] || last[2] !== sst[2]) {
      this.lobby.lastSst = sst;
      const f = encodeFrame('+sst', '', this.sstFields());
      for (const s of [...this.lobby.sessions]) {
        if (this.lobby.sessions.has(s) && this.lobby.s(s).persona !== null) this.lsendFrame(s, f);
      }
    }
    for (const s of [...this.lobby.sessions]) {
      const x = this.lobby.s(s);
      if (now - x.lastIn > l.idleMs) {
        const secs = round((now - x.lastIn) / 1000);
        this.ldrop(s, 'silent for ' + String(secs) + ' s');
        continue;
      }
      if (x.persona === null && now - x.t0 > l.preLoginMs) {
        this.ldrop(s, 'no persona chosen');
        continue;
      }
      if (now - x.lastPing >= l.pingMs) {
        x.lastPing = now;
        this.lsend(s, '~png', [['REF', day(now)]]);
      }
    }
    const away = (vip) => now - (this.lobby.goneVips.has(vip) ? this.lobby.goneVips.get(vip) : Infinity) > l.orphanMs;
    for (const g of [...this.lobby.games.keys()]) {
      const x = this.lobby.games.get(g);
      if (!x || x.started === 0) continue;
      if (now - x.started > l.raceMs) this.endGame(g, 'the race is long over');
      else if (x.players.every((p) => away(p.vip))) this.endGame(g, 'its players left the server');
    }
    for (const [v, t] of [...this.lobby.goneVips]) if (!(now - t <= l.raceMs)) this.lobby.goneVips.delete(v);
    for (const [k, v] of [...this.lobby.said]) {
      while (v.length > 0 && now - v[0].t > l.saidMs) v.shift();
      if (v.length === 0) this.lobby.said.delete(k);
    }
  },

  /** the server stops: the timers end, every session's link goes, the races going on and the results are written */
  lobbyStop() {
    const keys = [...this.lobby.agm.keys()].map((g) => 'a:' + g).concat([...this.lobby.pop.keys()].map((r) => 'p:' + r));
    for (const k of keys) {
      const a = this.lobby.laterMut(k);
      if (a && a.timer !== null) this.timers.clear(a.timer);
    }
    for (const s of [...this.lobby.sessions]) this.connDestroy(this.lobby.s(s).conn, 'server stopping');
    this.saveRaces();
    this.stats.stop();
  },
};

