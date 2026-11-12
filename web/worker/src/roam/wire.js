// The free-roam wire format (runtime/roam_core.h), a port of web/server-rs/crates/roam/src/wire.rs: a 16-byte header
// ("N2FR", version 1, type, length, sender id, sequence, flags; little-endian), the payload, then the CRC-32 (zlib's)
// of everything before it.  And the switch's frame around a datagram (nfsu2-lan): [0] kind, [4..8] source vip,
// [8..12] destination vip, [12..16] ports.

import { crc32 } from './crc32.js';
import { atan2, hypot } from '../util/crmath.js';

/** the switch's frame kinds (nfsu2-lan): a UDP datagram */
export const KIND_UDP = 1;
/** the switch's header in front of a datagram */
export const F_DATA = 16;
export const MSG_HELLO = 1;
export const MSG_PEERS = 2;
export const MSG_SNAP = 3;
export const MSG_BYE = 8;
export const MSG_MAPREQ = 10;
export const MSG_MAPD = 17;
export const MSG_NEARREQ = 18;
export const MSG_NEARD = 19;
export const MSG_LOBBY = 12;
export const MSG_LOBBIES = 13;
export const MSG_RACEREP = 14;
const RACEREP_BYTES = 64;
const RACEREP_NAME = 16;
export const MSG_RACERES = 16;
const RACERES_HEAD = 12;
const RACERES_ROW = 20;
export const RS_FINISHED = 0x01;
export const RS_OURS = 0x02;
export const HF_LOBBY = 0x0080;
export const HF_CREW = 0x0200;
export const HF_HUBCREW = 0x0400;
export const HF_SEAT2 = 0x2000;
export const MARK_FRIEND = 0x80;
export const MARK_RXONLY = 0x20;
export const MARK_TXONLY = 0x40;
export const CORE_ONEWAY = 15;
export const CORE_HINTS = 16;
export const HINT_VERYFAR = 0x80;
export const GONE_MAX = 32;
export const FAR_M = 300.0;
export const VERYFAR_M = 1000.0;
export const LIST_MAX = 96;
export const CREWS = 4;
const SEEN_MAX = 64;
export const LINKS_MAX = 64;
export const LINKS_V13 = 48;
export const LINKS_V9 = 32;
export const LOBBY_ADVERT = 1;
export const LOBBY_JOIN = 2;
export const LOBBY_CLOSE = 5;
export const LOBBY_COUNTS_ON = 0x8000;
export const LOBBY_PRIVATE = 0x0040;
export const LOBBY_COUNTS_HOST = 0x0001;
export const LOBBY_STAGED = 0x0080;
export const LOBBY_HSTAGE = 9;
export const LOBBIES_ENTRY = 11;
export const LOBBIES_MAX = 96;
export const LOBBIES_STAGED = 0x80;
export const LOBBIES_HSTAGE = 2;
export const LOBBIES_MATE = 0x40;
export const LOBBY_PLAYERS = 6;
export const MAPD_GONE = 0x8000;
export const MAPD_PARKED = 0x4000;
export const MAPREQ_PARKED = 1;
export const MAPD_PLACE = 9;
export const MAPD_PLACE_Z = 11;
export const HF_MAPZ = 0x0800;
export const MAPD_BYTES = 1152;
export const MAPD_PARTS = 16;
export const MAPREQ_WIDE = 2;
export const MAPD_PARTS_WIDE = 48;
export const HDR = 16;
export const CRC = 4;
export const RACE_HEATS = 3;
export const RL_STAGED = 0x01;
export const RL_MATE_PAST = 0x02;
export const RL_HOST_PAST = 0x04;
export const SLOPE_MAX = 30.0;

const f32buf = new DataView(new ArrayBuffer(4));

export function u16le(d, o) {
  return d[o] | (d[o + 1] << 8);
}

export function u32le(d, o) {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
}

export function f32le(d, o) {
  f32buf.setUint8(0, d[o]);
  f32buf.setUint8(1, d[o + 1]);
  f32buf.setUint8(2, d[o + 2]);
  f32buf.setUint8(3, d[o + 3]);
  return f32buf.getFloat32(0, true);
}

function i16le(d, o) {
  const v = d[o] | (d[o + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

const fr = Math.fround;

/** Rust's f64::round: half away from zero */
export function rustRound(x) {
  if (!Number.isFinite(x)) return x;
  const t = Math.trunc(x);
  const f = x - t;
  if (f >= 0.5) return t + 1;
  if (f <= -0.5) return t - 1;
  return t;
}

/** a state's velocity as roam_core.c's get_state takes it (in float: finite, |v|^2 at most 200^2), else 0 */
function velocity(d, o) {
  const v0 = f32le(d, o), v1 = f32le(d, o + 4), v2 = f32le(d, o + 8);
  if (Number.isFinite(v0) && Number.isFinite(v1) && Number.isFinite(v2) && fr(fr(fr(v0 * v0) + fr(v1 * v1)) + fr(v2 * v2)) <= 40000) {
    return [v0, v1, v2];
  }
  return [0, 0, 0];
}

function quat(d, o) {
  return [i16le(d, o) / 32767.0, i16le(d, o + 2) / 32767.0, i16le(d, o + 4) / 32767.0, i16le(d, o + 6) / 32767.0];
}

function norm2(q) {
  return q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
}

/** where a state's car points, 256 a turn (wire.rs heading) */
export function heading(d, o) {
  const q = quat(d, o);
  const f0 = 1.0 - 2.0 * (q[1] * q[1] + q[2] * q[2]), f1 = 2.0 * (q[0] * q[1] + q[2] * q[3]);
  if (norm2(q) < 0.25) return 0;
  return Math.floor((atan2(f1, f0) * 128.0) / Math.PI + 0.5) & 255;
}

/** how steeply a state's car points up (+) or down, % (wire.rs slope) */
export function slope(d, o) {
  const q = quat(d, o);
  if (norm2(q) < 0.25) return 0;
  const f0 = 1.0 - 2.0 * (q[1] * q[1] + q[2] * q[2]), f1 = 2.0 * (q[0] * q[1] + q[2] * q[3]), f2 = 2.0 * (q[0] * q[2] - q[1] * q[3]);
  const across = hypot(f0, f1);
  if (across < 0.1) return 0;
  return rustRound(Math.min(SLOPE_MAX, Math.max(-SLOPE_MAX, (100.0 * f2) / across)));
}

/** a RACEREP's payload (at o), or null where roam_core.c's decoder would not take it */
function racerep(d, o) {
  const lobby = u32le(d, o), race = u32le(d, o + 4), players = d[o + 13], place = d[o + 12], flags = d[o + 14];
  const class_ = d[o + 16] >= 128 ? d[o + 16] - 256 : d[o + 16];
  const nums = [20, 24, 28, 32, 36, 40, 44].map((k) => f32le(d, o + k));
  const lim = [[0.0, 5000.0], [0.0, 5000.0], [0.01, 100.0], [0.0, 10000.0], [0.0, 50000.0], [0.0, 2000.0], [0.0, 100000.0]];
  if (lobby === 0 || race === 0 || !(players >= 1 && players <= LOBBY_PLAYERS) || place > players || !(class_ >= -1 && class_ <= 3) || (flags & ~7) !== 0) {
    return null;
  }
  for (let k = 0; k < 7; k++) {
    const x = nums[k];
    if (!(Number.isFinite(x) && x >= fr(lim[k][0]) && x <= fr(lim[k][1]))) return null;
  }
  let nl = 0;
  while (nl < RACEREP_NAME && d[o + 48 + nl] !== 0) nl++;
  const name = d.subarray(o + 48, o + 48 + nl);
  for (const c of name) if (c < 0x20 || c > 0x7e) return null;
  return {
    lobby,
    race,
    mode: d[o + 8],
    laps: d[o + 9],
    track: u16le(d, o + 10),
    place,
    players,
    host: (flags & 1) !== 0,
    quit: (flags & 2) !== 0,
    edited: (flags & 4) !== 0,
    credit: d[o + 17] <= 2 ? d[o + 17] : 0,
    stage: d[o + 18] <= 9 ? d[o + 18] : 0,
    lobbyBits: d[o + 19] & (RL_STAGED | RL_MATE_PAST | RL_HOST_PAST),
    carType: d[o + 15],
    class: class_,
    rating: nums[0],
    field: nums[1],
    factor: nums[2],
    kw: nums[3],
    kg: nums[4],
    kmh: nums[5],
    time: nums[6],
    name,
  };
}

/** a RACERES's payload (at o, len bytes), or null where roam_core.c's decoder would not take it */
function raceres(d, o, len) {
  if (len < RACERES_HEAD) return null;
  const n = d[o + 10];
  if (!(n >= 1 && n <= LOBBY_PLAYERS) || len !== RACERES_HEAD + RACERES_ROW * n) return null;
  const lobby = u32le(d, o), race = u32le(d, o + 4);
  if (lobby === 0 || race === 0) return null;
  const heat = d[o + 11] & 15, heats = d[o + 11] >> 4;
  const heatOk = heats === 0 ? heat === 0 : heats >= 2 && heats <= RACE_HEATS && heat >= 1 && heat <= heats;
  if (!heatOk) return null;
  const rows = [];
  for (let k = 0; k < LOBBY_PLAYERS; k++) rows.push({ id: 0, flags: 0, time: 0, done: 0, dist: 0, jump: 0 });
  const fits = (x, max) => Number.isFinite(x) && x >= 0.0 && x <= max;
  let ours = 0;
  for (let k = 0; k < n; k++) {
    const at = o + RACERES_HEAD + RACERES_ROW * k;
    const time = f32le(d, at + 8), done = f32le(d, at + 12), dist = f32le(d, at + 16);
    const flags = d[at + 4];
    if ((flags & ~(RS_FINISHED | RS_OURS)) !== 0 || !fits(time, 100000.0) || !fits(done, 1000.0) || !fits(dist, 1e6)) return null;
    rows[k] = { id: u32le(d, at), flags, time, done, dist, jump: u16le(d, at + 5) };
    if (flags & RS_OURS) ours++;
  }
  if (ours > 1) return null;
  return { lobby, race, mode: d[o + 8], laps: d[o + 9], heat, heats, n, rows };
}

/**
 * One free-roam datagram, or null: the fields the hub needs, checked as roam_core.c's decoder does (wire.rs decode).
 * @param {Uint8Array} d
 * @returns {null | {kind: number, sender: number, m: any}}
 */
export function decode(d) {
  if (d.length < HDR + CRC || d.length > 1200 || d[0] !== 0x4e || d[1] !== 0x32 || d[2] !== 0x46 || d[3] !== 0x52 || d[4] !== 1) {
    return null;
  }
  const end = d.length - CRC;
  if (u16le(d, 6) !== d.length || crc32(d.subarray(0, end)) !== u32le(d, end)) return null;
  const kind = d[5], sender = u32le(d, 8);
  if (sender === 0) return null;
  let m;
  switch (kind) {
    case MSG_HELLO: {
      if (end < 29) return null;
      const core = u16le(d, 16), status = d[19], room = u32le(d, 24), nl = d[28];
      if (nl > 24 || end < 29 + nl + 1 || status > 5) return null;
      const name = d.subarray(29, 29 + nl);
      for (const c of name) if (c < 0x20 || c > 0x7e) return null;
      const flags = u16le(d, 14);
      const crews = [0, 0, 0, 0];
      let links = 0, duel = 0;
      if (flags & HF_CREW) {
        const seen = d[29 + nl];
        const at = 29 + nl + 1 + 4 * seen;
        if (seen > SEEN_MAX || at > end) return null;
        if (at < end) {
          const n = d[at];
          if (n > CREWS || at + 1 + 4 * n > end) return null;
          for (let k = 0; k < n; k++) crews[k] = u32le(d, at + 1 + 4 * k);
          for (let k = 0; k < n; k++) if (crews[k] === 0) return null;
          const o = at + 1 + 4 * n;
          if (o < end) links = d[o];
          if (o + 5 <= end) duel = u32le(d, o + 1);
        }
      }
      m = {
        type: 'hello', sender, core, status, room, name,
        lobbies: (flags & HF_LOBBY) !== 0, marks: (flags & HF_HUBCREW) !== 0, crews, links, duel, seat2: (flags & HF_SEAT2) !== 0,
      };
      break;
    }
    case MSG_SNAP: {
      if (end < 22 + 52) return null;
      const status = d[16], n = d[20];
      if (!(n >= 1 && n <= 3) || status > 5 || end !== 22 + 52 * n) return null;
      const p = [f32le(d, 26), f32le(d, 30), f32le(d, 34)];
      if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])) || Math.abs(p[0]) > 20000.0 || Math.abs(p[1]) > 20000.0 || Math.abs(p[2]) > 2000.0) {
        return null;
      }
      m = { type: 'snap', sender, status, p, v: velocity(d, 38), heading: heading(d, 50), slope: slope(d, 50), tUs: u32le(d, 22), clock: d[21] };
      break;
    }
    case MSG_MAPREQ:
      if (end === HDR + 6 || end === HDR + 8) {
        m = { type: 'mapreq', req: u16le(d, 16), max: u16le(d, 18), base: u16le(d, 20), flags: end === HDR + 8 ? u16le(d, 22) : 0 };
      } else m = { type: 'other' };
      break;
    case MSG_NEARREQ:
      if (end === HDR + 8) m = { type: 'nearreq', req: u16le(d, 16), max: u16le(d, 18), base: u16le(d, 20), radius: u16le(d, 22) };
      else m = { type: 'other' };
      break;
    case MSG_LOBBY: {
      if (end < HDR + 24) return null;
      const op = d[16], arg = d[17], state = d[18], max = d[19], n = d[38];
      if (!(op >= 1 && op < 6) || arg >= 5 || state >= 3 || !(max >= 2 && max <= 6) || n > max || end !== HDR + 24 + 4 * n) return null;
      const ids = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) ids[i] = u32le(d, HDR + 24 + 4 * i);
      const lobby = u32le(d, 24), race = u32le(d, 28);
      if (lobby === 0 || race === 0) return null;
      for (let i = 0; i < n; i++) {
        if (ids[i] === 0) return null;
        for (let j = 0; j < i; j++) if (ids[j] === ids[i]) return null;
      }
      const t = u16le(d, 36);
      const on = op === LOBBY_ADVERT && (t & LOBBY_COUNTS_ON) !== 0;
      m = {
        type: 'lobby', op, to: u32le(d, 20), lobby, race, x: i16le(d, 32), y: i16le(d, 34), n, max, state, ids,
        private: on && (t & LOBBY_PRIVATE) !== 0,
        staged: on && (t & (LOBBY_COUNTS_HOST | LOBBY_STAGED)) !== 0,
        hstage: on ? (t >> LOBBY_HSTAGE) & 7 : 0,
      };
      break;
    }
    case MSG_RACEREP:
      if (end === HDR + RACEREP_BYTES) {
        const r = racerep(d, HDR);
        if (!r) return null;
        m = { type: 'racerep', r };
      } else m = { type: 'other' };
      break;
    case MSG_RACERES: {
      const r = raceres(d, HDR, end - HDR);
      if (!r) return null;
      m = { type: 'raceres', r };
      break;
    }
    case MSG_BYE:
      m = { type: 'bye' };
      break;
    default:
      m = { type: 'other' };
  }
  return { kind, sender, m };
}

/** One free-roam datagram, or null: what decode reads of it, the name its own (wire.rs decode_roam) */
export function decodeRoam(d) {
  const x = decode(d);
  if (!x) return null;
  const { kind, sender, m } = x;
  switch (m.type) {
    case 'hello': {
      const crews = [];
      for (const c of m.crews) {
        if (c === 0) break;
        crews.push(c);
      }
      return { type: 'hello', sender, core: m.core, status: m.status, room: m.room, name: String.fromCharCode(...m.name), crews };
    }
    case 'snap':
      return { type: 'snap', sender, status: m.status, p: m.p };
    case 'bye':
      return { type: 'bye', sender };
    default:
      return { type: 'other', kind, sender };
  }
}

export function peersLen(n) {
  return HDR + 1 + 10 * n + CRC;
}

export function peersCrewLen(n, k) {
  return peersLen(n) + 1 + 4 * k + n;
}

function header(b, kind, sender, seq, flags) {
  const len = b.length;
  b[0] = 0x4e; b[1] = 0x32; b[2] = 0x46; b[3] = 0x52;
  b[4] = 1;
  b[5] = kind;
  b[6] = len & 255; b[7] = len >> 8;
  b[8] = sender & 255; b[9] = (sender >>> 8) & 255; b[10] = (sender >>> 16) & 255; b[11] = sender >>> 24;
  b[12] = seq & 255; b[13] = (seq >> 8) & 255;
  b[14] = flags & 255; b[15] = (flags >> 8) & 255;
}

function trailer(b) {
  const len = b.length;
  const c = crc32(b.subarray(0, len - CRC));
  b[len - 4] = c & 255; b[len - 3] = (c >>> 8) & 255; b[len - 2] = (c >>> 16) & 255; b[len - 1] = c >>> 24;
}

function put32le(b, o, v) {
  b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = v >>> 24;
}

/**
 * Writes a PEERS datagram into b (exactly peersLen(n) long, or peersCrewLen(n, mine.length) + hints with marks)
 * (wire.rs write_peers).  list: [{vip, port, id}]
 */
export function writePeers(b, sender, seq, list, mine, marks, hints) {
  const len = b.length, n = list.length;
  const withMarks = len > peersLen(n);
  header(b, MSG_PEERS, sender, seq, withMarks ? HF_CREW : 0);
  b[16] = n & 255;
  for (let i = 0; i < n; i++) {
    const e = list[i], o = 17 + 10 * i;
    b[o] = e.vip >>> 24; b[o + 1] = (e.vip >>> 16) & 255; b[o + 2] = (e.vip >>> 8) & 255; b[o + 3] = e.vip & 255;
    b[o + 4] = e.port & 255; b[o + 5] = e.port >> 8;
    put32le(b, o + 6, e.id);
  }
  if (withMarks) {
    let o = 17 + 10 * n;
    b[o++] = mine.length;
    for (const c of mine) {
      put32le(b, o, c);
      o += 4;
    }
    for (let i = 0; i < n; i++) b[o + i] = marks[i];
    for (let i = 0; i < hints.length; i++) b[o + n + i] = hints[i];
  }
  trailer(b);
}

/** A PEERS datagram (wire.rs encode_peers) */
export function encodePeers(sender, seq, list) {
  return encodePeersCrews(sender, seq, list, [], []);
}

/** A PEERS datagram with crew marks (none with mine and marks empty) */
export function encodePeersCrews(sender, seq, list, mine, marks) {
  const withMarks = mine.length > 0 || marks.length > 0;
  const b = new Uint8Array(withMarks ? peersCrewLen(list.length, mine.length) : peersLen(list.length));
  writePeers(b, sender, seq, list, mine, marks, []);
  return b;
}

export function lobbiesLen(n) {
  return HDR + 3 + LOBBIES_ENTRY * n + CRC;
}

/** One LOBBIES datagram into b (exactly lobbiesLen(n) long): list of [x, y, race, n, max, state] */
export function writeLobbies(b, sender, seq, req, list) {
  header(b, MSG_LOBBIES, sender, seq, 0);
  b[16] = req & 255; b[17] = req >> 8;
  b[18] = list.length & 255;
  for (let i = 0; i < list.length; i++) {
    const [x, y, race, n, max, state] = list[i];
    const o = 19 + LOBBIES_ENTRY * i;
    b[o] = x & 255; b[o + 1] = (x >> 8) & 255;
    b[o + 2] = y & 255; b[o + 3] = (y >> 8) & 255;
    put32le(b, o + 4, race);
    b[o + 8] = n; b[o + 9] = max; b[o + 10] = state;
  }
  trailer(b);
}

export function mapdLen(bytes) {
  return HDR + 9 + bytes + CRC;
}

/** One MAPD (or NEARD) datagram into b (exactly mapdLen(e.length) long) (wire.rs write_mapd) */
export function writeMapd(b, kind, sender, seq, req, base, part, nparts, total, n, flags, e) {
  header(b, kind, sender, seq, flags);
  b[16] = req & 255; b[17] = req >> 8;
  b[18] = base & 255; b[19] = base >> 8;
  b[20] = part;
  b[21] = nparts;
  b[22] = total & 255; b[23] = total >> 8;
  b[24] = n;
  b.set(e, 25);
  trailer(b);
}
