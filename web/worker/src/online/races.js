// The races going on, kept over a restart (crates/online/src/races.rs): written when the server stops
// (online/races.json, serde_json's text: struct field order, f64 as serde writes it), read back at the next start,
// once; the file goes at the lobby's first tick.

import { assert } from './jsx.js';

const VERSION = 1;

/** serde_json's (ryu's) text of an f64: "4.0", "1792500000000.0", "1e16", "1.5e-7" */
export function serdeF64(x) {
  if (!Number.isFinite(x)) return 'null';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const neg = x < 0;
  const e = Math.abs(x).toExponential();
  const [m, ex] = e.split('e');
  const digits = m.replace('.', '');
  const len = digits.length;
  const kk = Number(ex) + 1;
  const k = kk - len;
  let s;
  if (k >= 0 && kk <= 16) s = digits + '0'.repeat(k) + '.0';
  else if (kk > 0 && kk <= 16) s = digits.slice(0, kk) + '.' + digits.slice(kk);
  else if (kk > -5 && kk <= 0) s = '0.' + '0'.repeat(-kk) + digits;
  else if (len === 1) s = digits + 'e' + (kk - 1);
  else s = digits[0] + '.' + digits.slice(1) + 'e' + (kk - 1);
  return (neg ? '-' : '') + s;
}

const str = (s) => JSON.stringify(s);

function b64encode(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

/** STANDARD base64, strict (padding, canonical), or null */
function b64decode(t) {
  if (typeof t !== 'string' || t.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(t)) return null;
  let bin;
  try {
    bin = atob(t);
  } catch {
    return null;
  }
  const b = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return b64encode(b) === t ? b : null;
}

function keptJson(races) {
  const out = [];
  for (const r of races) {
    const players = r.players.map((p) => '{"name":' + str(p.name) + ',"id":' + p.id + ',"addr":' + str(p.addr) + ',"vip":' + p.vip +
      ',"flags":' + p.flags + ',"back":' + p.back + ',"reported":' + p.reported + ',"left":' + (p.left === null ? 'null' : serdeF64(p.left)) + '}');
    const reports = r.reports.map(([v, k]) => '[' + v + ',' + str(k) + ']');
    out.push('{"id":' + r.id + ',"name":' + str(r.name) + ',"host":' + str(r.host) + ',"when":' + str(r.when) + ',"room":' + r.room +
      ',"vip":' + r.vip + ',"max":' + serdeF64(r.max) + ',"min":' + serdeF64(r.min) + ',"cust":' + r.cust + ',"sys":' + r.sys +
      ',"params":' + str(r.params) + ',"started":' + serdeF64(r.started) + ',"auth":' + str(r.auth) + ',"ranked":' + r.ranked +
      ',"players":[' + players.join(',') + '],"reports":[' + reports.join(',') + '],"result":' + (r.result === null ? 'null' : str(r.result)) +
      ',"table":' + (r.table === null ? 'null' : str(r.table)) + '}');
  }
  return '{"v":' + VERSION + ',"races":[' + out.join(',') + ']}';
}

const isU = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
const U32 = 4294967295, U64 = Number.MAX_SAFE_INTEGER;
const field = (k) => '`' + k + '`';

/** the Kept value of a parsed file, as serde would take it (throws the reason when it would not) */
function readKept(j) {
  const bad = (what) => {
    throw new Error(what);
  };
  const missing = (k) => bad('missing field ' + field(k));
  const badType = (k) => bad('invalid type for ' + field(k));
  if (j === null || typeof j !== 'object' || Array.isArray(j)) bad('invalid type: expected struct Kept');
  if (!('v' in j)) missing('v');
  if (!isU(j.v, U32)) badType('v');
  if (!('races' in j)) missing('races');
  if (!Array.isArray(j.races)) badType('races');
  const num = (o, k) => {
    if (!(k in o)) missing(k);
    if (typeof o[k] !== 'number') badType(k);
    return o[k];
  };
  const u = (o, k, max) => {
    const v = num(o, k);
    if (!isU(v, max)) bad('invalid value for ' + field(k));
    return v;
  };
  const s = (o, k) => {
    if (!(k in o)) missing(k);
    if (typeof o[k] !== 'string') badType(k);
    return o[k];
  };
  const b = (o, k) => {
    if (!(k in o)) missing(k);
    if (typeof o[k] !== 'boolean') badType(k);
    return o[k];
  };
  const opt = (o, k, f) => (o[k] === undefined || o[k] === null ? null : f(o, k));
  const races = j.races.map((r) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) bad('invalid type: expected struct KeptRace');
    if (!('players' in r)) missing('players');
    if (!Array.isArray(r.players)) badType('players');
    const players = r.players.map((p) => {
      if (p === null || typeof p !== 'object' || Array.isArray(p)) bad('invalid type: expected struct KeptPlayer');
      return { name: s(p, 'name'), id: u(p, 'id', U64), addr: s(p, 'addr'), vip: u(p, 'vip', U32), flags: u(p, 'flags', U32),
        back: b(p, 'back'), reported: b(p, 'reported'), left: opt(p, 'left', num) };
    });
    if (!('reports' in r)) missing('reports');
    if (!Array.isArray(r.reports)) badType('reports');
    const reports = r.reports.map((x) => {
      if (!Array.isArray(x) || x.length !== 2 || !isU(x[0], U32) || typeof x[1] !== 'string') bad('invalid report');
      return [x[0], x[1]];
    });
    return { id: u(r, 'id', U64), name: s(r, 'name'), host: s(r, 'host'), when: s(r, 'when'), room: u(r, 'room', U32), vip: u(r, 'vip', U32),
      max: num(r, 'max'), min: num(r, 'min'), cust: u(r, 'cust', U32), sys: u(r, 'sys', U32), params: s(r, 'params'), started: num(r, 'started'),
      auth: s(r, 'auth'), ranked: b(r, 'ranked'), players, reports, result: opt(r, 'result', s), table: opt(r, 'table', s) };
  });
  return { v: j.v, races };
}

export const racesMethods = {
  /** the races of before the restart, read back (the server's start); the file goes at the first tick */
  loadRaces() {
    if (!this.store) return;
    const text = this.store.get('races.json');
    if (text === null) return;
    this.racesRead = true;
    const file = this.store.path('races.json');
    let kept;
    try {
      kept = readKept(JSON.parse(text));
      if (kept.v !== VERSION) throw new Error('version ' + kept.v);
    } catch (e) {
      return this.log('[online] ' + file + ' could not be read (' + e.message + '): the races of before are lost', null);
    }
    const now = this.clocks.now();
    let read = 0, over = 0;
    const lb = this.lobby;
    for (const r of kept.races) {
      if (!(r.started > 0 && now - r.started <= lb.l.raceMs)) {
        over++;
        continue;
      }
      if (r.auth === '' || r.players.length === 0 || lb.games.has(r.id) || [...lb.games.values()].some((g) => g.name === r.name)) continue;
      const players = r.players.map((p) => {
        lb.nextUser = Math.max(lb.nextUser, p.id + 1);
        if (p.left !== null) lb.goneVips.set(p.vip, p.left);
        return { s: null, id: p.id, name: p.name, addr: p.addr, vip: p.vip, flags: p.flags, back: p.back, reported: p.reported,
          results: null, own: null, seen: [], jumped: [], jumpTold: false };
      });
      lb.nextGame = Math.max(lb.nextGame, r.id + 1);
      lb.games.set(r.id, {
        id: r.id, when: r.when, name: r.name, hostName: r.host, room: r.room, vip: r.vip, group: 'race ' + r.id,
        maxSize: r.max, minSize: r.min, custFlags: r.cust, sysFlags: r.sys, password: null, params: r.params, players,
        started: r.started, auth: r.auth, reports: r.reports, result: r.result, table: r.table === null ? null : b64decode(r.table),
        ranked: r.ranked,
      });
      read++;
    }
    // (the games by id, as the Rust lobby's BTreeMap keeps them)
    lb.games = new Map([...lb.games.entries()].sort((a, b) => a[0] - b[0]));
    const tail = over > 0 ? ' (' + over + ' long over left out)' : '';
    this.log('[online] ' + read + ' races going on read back from ' + file + tail, null);
  },

  /** the lobby's first tick: the file read at the start goes */
  forgetReadRaces() {
    const was = this.racesRead;
    this.racesRead = false;
    if (was && this.store) this.store.delete('races.json');
  },

  /** the started races, for the next start */
  saveRaces() {
    this.racesRead = false;
    if (!this.store) return;
    const races = [...this.lobby.games.values()].filter((g) => g.started !== 0).map((g) => ({
      id: g.id, name: g.name, host: g.hostName, when: g.when, room: g.room, vip: g.vip, max: g.maxSize, min: g.minSize,
      cust: g.custFlags, sys: g.sysFlags, params: g.params, started: g.started, auth: g.auth, ranked: g.ranked,
      players: g.players.map((p) => ({ name: p.name, id: p.id, addr: p.addr, vip: p.vip, flags: p.flags, back: p.back,
        reported: p.reported, left: this.lobby.goneVips.has(p.vip) ? this.lobby.goneVips.get(p.vip) : null })),
      reports: g.reports, result: g.result, table: g.table === null ? null : b64encode(g.table),
    }));
    if (races.length === 0) {
      this.store.delete('races.json');
      return;
    }
    const n = races.length;
    const e = this.store.put('races.json', keptJson(races));
    const file = this.store.path('races.json');
    if (e === null) this.log('[online] ' + n + ' races going on written to ' + file + ' for the next start', null);
    else this.log('[online] the races going on could not be written: ' + e, null);
  },
};

assert(serdeF64(4) === '4.0' && serdeF64(1e16) === '1e16' && serdeF64(1.5e-7) === '1.5e-7' && serdeF64(0.001) === '0.001', 'serde f64');

