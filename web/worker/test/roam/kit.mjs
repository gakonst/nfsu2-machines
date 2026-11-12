// What the hub's tests share (a port of web/server-rs/crates/roam/tests/kit/mod.rs): a player's datagrams as
// roam_core.c lays them out, the switch's frame around them, the lists out of the hub's frames, and a hub with a clock
// of its own.

import { Hub, ROAM_HUB_VIP, defaultOptions } from '../../src/roam/hub.js';
import { crc32 } from '../../src/roam/crc32.js';

/** "10.77.0.5" as a number */
export function ip(s) {
  return s.split('.').reduce((a, b) => ((a << 8) | (Number(b) || 0)) >>> 0, 0) >>> 0;
}

/** roam_core's room hash (FNV-1a of the room's name, 0 for none, never 0 for one) */
export function fnv1a(s) {
  if (s === '') return 0;
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ (ch.codePointAt(0) & 0xff), 0x01000193) >>> 0;
  return h === 0 ? 1 : h;
}

/** roam_core.c's rc_room_hash of an ASCII name (kit room_hash) */
export function roomHash(s) {
  let h = 0x811c9dc5, kept = 0;
  for (const b of new TextEncoder().encode(s)) {
    if (b === 0x20 || (b >= 9 && b <= 13)) continue;
    const c = b >= 65 && b <= 90 ? b + 32 : b;
    h = Math.imul(h ^ c, 0x01000193) >>> 0;
    kept++;
  }
  return kept === 0 ? 0 : Math.max(h, 1);
}

function le16(b, o, v) {
  b[o] = v & 255;
  b[o + 1] = (v >> 8) & 255;
}
function le32(b, o, v) {
  b[o] = v & 255;
  b[o + 1] = (v >>> 8) & 255;
  b[o + 2] = (v >>> 16) & 255;
  b[o + 3] = (v >>> 24) & 255;
}
const f32 = new DataView(new ArrayBuffer(4));
function lef32(b, o, v) {
  f32.setFloat32(0, v, true);
  for (let k = 0; k < 4; k++) b[o + k] = f32.getUint8(k);
}

/** the CRC of a datagram written again (after its bytes changed) */
export function recrc(d) {
  const len = d.length;
  le32(d, len - 4, crc32(d.subarray(0, len - 4)));
  return d;
}

/** a datagram with these header flags: the header, the payload, the CRC */
export function dgramFlags(kind, sender, flags, payload) {
  const len = 16 + payload.length + 4;
  const b = new Uint8Array(len);
  b.set([0x4e, 0x32, 0x46, 0x52], 0);
  b[4] = 1;
  b[5] = kind;
  le16(b, 6, len);
  le32(b, 8, sender);
  le16(b, 12, 7);
  le16(b, 14, flags);
  b.set(payload, 16);
  return recrc(b);
}

export function dgram(kind, sender, payload) {
  return dgramFlags(kind, sender, 0, payload);
}

export const HF_CREW = 0x0200;
export const HF_HUBCREW = 0x0400;
export const HF_LOBBY = 0x0080;
export const HF_SEAT2 = 0x2000;
export const MARK_FRIEND = 0x80;

/**
 * a HELLO (kit hello_with): opts {room, status, name (string or bytes), seen, cfgRev, core, crews (null: a HELLO of
 * before), flags, links, duel}
 */
export function helloWith(sender, opts = {}) {
  const o = { room: 0, status: 2, name: 'p', seen: [], cfgRev: 3, core: 9, crews: null, flags: 0, links: 0, duel: 0, ...opts };
  const name = typeof o.name === 'string' ? new TextEncoder().encode(o.name) : o.name;
  const nl = name.length;
  const p = [];
  const head = new Uint8Array(13 + nl + 1 + 4 * o.seen.length);
  le16(head, 0, o.core);
  head[2] = 1;
  head[3] = o.status;
  le16(head, 4, 47210);
  le16(head, 6, o.cfgRev);
  le32(head, 8, o.room);
  head[12] = nl;
  head.set(name, 13);
  head[13 + nl] = o.seen.length;
  o.seen.forEach((s, i) => le32(head, 14 + nl + 4 * i, s));
  p.push(...head);
  let crews = o.crews;
  if (crews === null) {
    if (o.links > 0 || o.duel !== 0) crews = [];
    else return dgramFlags(1, sender, o.flags, Uint8Array.from(p));
  }
  p.push(crews.length);
  for (const c of crews) p.push(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24);
  if (o.links > 0 || o.duel !== 0) p.push(o.links);
  if (o.duel !== 0) p.push(o.duel & 255, (o.duel >>> 8) & 255, (o.duel >>> 16) & 255, o.duel >>> 24);
  return dgramFlags(1, sender, HF_CREW | o.flags, Uint8Array.from(p));
}

export function hello(sender) {
  return helloWith(sender, {});
}

/** a SNAP of n states (the newest one's position first) */
export function snapN(sender, pos, status, n) {
  const p = new Uint8Array(6 + 52 * n);
  p[0] = status;
  p[4] = n;
  lef32(p, 10, pos[0]);
  lef32(p, 14, pos[1]);
  lef32(p, 18, pos[2]);
  le16(p, 6 + 34, 32767);
  return dgram(3, sender, p);
}

export function snap(sender, pos) {
  return snapN(sender, pos, 2, 1);
}

/** Rust's f64::round */
function rround(x) {
  const t = Math.trunc(x);
  const f = x - t;
  return f >= 0.5 ? t + 1 : f <= -0.5 ? t - 1 : t;
}

/** a SNAP of one state with a velocity and a heading (radians, 0 = +x, a turn about z) */
export function snapMoving(sender, pos, v, heading, status) {
  const d = snapN(sender, pos, status, 1);
  const p = d.subarray(16);
  for (let k = 0; k < 3; k++) lef32(p, 22 + 4 * k, v[k]);
  const z = Math.sin(heading / 2.0), w = Math.cos(heading / 2.0);
  le16(p, 34, 0);
  le16(p, 38, rround(z * 32767.0) & 0xffff);
  le16(p, 40, rround(w * 32767.0) & 0xffff);
  return recrc(d);
}

/** a SNAP of one state with a velocity, a heading and its nose slope up (a tangent) */
export function snapPose(sender, pos, v, heading, slope, status) {
  const d = snapMoving(sender, pos, v, heading, status);
  const sz = Math.sin(heading / 2.0), cz = Math.cos(heading / 2.0);
  const sy = Math.sin(-Math.atan(slope) / 2.0), cy = Math.cos(-Math.atan(slope) / 2.0);
  const q = [-sz * sy, cz * sy, sz * cy, cz * cy];
  const p = d.subarray(16);
  q.forEach((x, k) => le16(p, 34 + 2 * k, rround(x * 32767.0) & 0xffff));
  return recrc(d);
}

/** the world map's question (MAPREQ) */
export function mapreqBase(sender, req, max, base) {
  const p = new Uint8Array(6);
  le16(p, 0, req);
  le16(p, 2, max);
  le16(p, 4, base);
  return dgram(10, sender, p);
}

export function mapreqFlags(sender, req, max, base, flags) {
  const p = new Uint8Array(8);
  le16(p, 0, req);
  le16(p, 2, max);
  le16(p, 4, base);
  le16(p, 6, flags);
  return dgram(10, sender, p);
}

/** the minimap's question (NEARREQ) */
export function nearreq(sender, req, max, base, radius) {
  const p = new Uint8Array(8);
  le16(p, 0, req);
  le16(p, 2, max);
  le16(p, 4, base);
  le16(p, 6, radius);
  return dgram(18, sender, p);
}

/** a race lobby message (roam_core.c rc_encode): {op, arg, state, max, to, lobby, race, x, y, t, away, ids} */
export function lobbyMsg(sender, o) {
  const ids = o.ids || [];
  const p = new Uint8Array(24 + 4 * ids.length);
  p[0] = o.op;
  p[1] = o.arg || 0;
  p[2] = o.state || 0;
  p[3] = o.max ?? 6;
  le32(p, 4, o.to || 0);
  le32(p, 8, o.lobby);
  le32(p, 12, o.race);
  le16(p, 16, (o.x || 0) & 0xffff);
  le16(p, 18, (o.y || 0) & 0xffff);
  le16(p, 20, o.t || 0);
  p[22] = ids.length;
  p[23] = o.away || 0;
  ids.forEach((id, i) => le32(p, 24 + 4 * i, id));
  return dgram(12, sender, p);
}

/** the minimap's answer (NEARD) in a frame of the hub's, read as a MAPD's */
export function neardOf(f) {
  if (f[16 + 5] !== 19) return null;
  const g = f.slice();
  g[16 + 5] = 17;
  return mapdOf(g);
}

/** the MAPD datagram in a frame of the hub's: [req, base, part, nparts, total, entries]; entry [key, [x, y, heading, vx, vy] | null] */
export function mapdOf(f) {
  const d = f.subarray(16);
  if (d[5] !== 17) return null;
  let o = 25;
  const e = [];
  const i16 = (k) => {
    const v = d[k] | (d[k + 1] << 8);
    return v >= 0x8000 ? v - 0x10000 : v;
  };
  const i8 = (v) => (v >= 128 ? v - 256 : v);
  const place = ((d[14] | (d[15] << 8)) & 0x0800) !== 0 ? 11 : 9;
  for (let n = 0; n < d[24]; n++) {
    const key = d[o] | (d[o + 1] << 8);
    if (key & 0x8000) {
      e.push([key & 0x7fff, null]);
      o += 2;
    } else {
      e.push([key, [i16(o + 2), i16(o + 4), d[o + 6], i8(d[o + 7]), i8(d[o + 8])]]);
      o += place;
    }
  }
  if (o + 4 !== d.length) throw new Error('MAPD entries fill the datagram');
  const u = (k) => d[k] | (d[k + 1] << 8);
  return [u(16), u(18), d[20], d[21], u(22), e];
}

export function bye(sender) {
  return dgram(8, sender, Uint8Array.of(0));
}

/** the switch's frame around a datagram (kind 1: [12..14] source port, [14..16] destination port) */
export function framePorts(from, d, sport, dport) {
  const f = new Uint8Array(16 + d.length);
  f[0] = 1;
  f[4] = from >>> 24; f[5] = (from >>> 16) & 255; f[6] = (from >>> 8) & 255; f[7] = from & 255;
  f[8] = ROAM_HUB_VIP >>> 24; f[9] = (ROAM_HUB_VIP >>> 16) & 255; f[10] = (ROAM_HUB_VIP >>> 8) & 255; f[11] = ROAM_HUB_VIP & 255;
  f[12] = sport >> 8; f[13] = sport & 255;
  f[14] = dport >> 8; f[15] = dport & 255;
  f.set(d, 16);
  return f;
}

export function frame(from, d) {
  return framePorts(from, d, 47210, 47210);
}

/** the PEERS list in a frame of the hub's: [{vip, port, id}] */
export function peersOf(f) {
  const d = f.subarray(16);
  const out = [];
  for (let i = 0; i < d[16]; i++) {
    const o = 17 + 10 * i;
    out.push({
      vip: ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0,
      port: d[o + 4] | (d[o + 5] << 8),
      id: (d[o + 6] | (d[o + 7] << 8) | (d[o + 8] << 16) | (d[o + 9] << 24)) >>> 0,
    });
  }
  return out;
}

/** the crew marks a PEERS list in a frame of the hub's ends in: [mine, marks], or null */
export function crewMarks(f) {
  const d = f.subarray(16);
  if (((d[14] | (d[15] << 8)) & HF_CREW) === 0) return null;
  const n = d[16];
  const o = 17 + 10 * n;
  const k = d[o];
  const mine = [];
  for (let c = 0; c < k; c++) mine.push((d[o + 1 + 4 * c] | (d[o + 2 + 4 * c] << 8) | (d[o + 3 + 4 * c] << 16) | (d[o + 4 + 4 * c] << 24)) >>> 0);
  return [mine, Array.from(d.subarray(o + 1 + 4 * k, o + 1 + 4 * k + n))];
}

/** the PEERS lists out of the hub's frames, by vip:port, without the players who only get the receiver's car */
export function listsIn(sent) {
  const out = new Map();
  for (const [vip, f] of sent) {
    const marks = crewMarks(f);
    const list = peersOf(f).filter((_, i) => !marks || (marks[1][i] & 0x40) === 0);
    out.set(vip + ':' + ((f[14] << 8) | f[15]), list);
  }
  return out;
}

/** the PEERS lists out of the hub's frames, by vip:port */
export function lists(sent) {
  const out = new Map();
  for (const [vip, f] of sent) out.set(vip + ':' + ((f[14] << 8) | f[15]), peersOf(f));
  return out;
}

/** a hub with a clock of its own (1,000,000 ms at the start), an idle server unless a test says otherwise */
export class Kit {
  constructor(o = {}, extra = {}) {
    this.sent = [];
    this.t = 1000000.0;
    this.busy = 0.0;
    this.lines = [];
    this.hub = new Hub(o, {
      now: () => this.t,
      busy: () => this.busy,
      log: (line) => this.lines.push(line),
      send: (vip, f) => {
        this.sent.push([vip, f]);
        return true;
      },
      id: 0xb0b,
      ...extra,
    });
  }
  step(ms) {
    this.t += ms;
  }
  lists() {
    return lists(this.sent);
  }
  listsIn() {
    return listsIn(this.sent);
  }
  clear() {
    this.sent = [];
  }
  /** a datagram from browser vip (port 47210) */
  from(vip, d) {
    this.hub.frame(vip, frame(vip, d));
  }
  info(k) {
    const v = this.hub.info()[k];
    return typeof v === 'number' ? v : NaN;
  }
}

/** the links of a room: every pair weighed, or the grid's nearest; without view points */
export function ways() {
  const o = { ...defaultOptions(), viewM: 1e-9 };
  return [['every pair', o], ['the grid', { ...o, exactRoom: 1 }]];
}

/** browser i's address: 10.77.0.(10 + i) */
export function V(i) {
  return ip('10.77.0.' + (10 + i));
}

/** the room of the race track's spot of this key in the world of room base (lib.rs track_room) */
export function trackRoomOf(base, k) {
  const r = (base ^ Math.imul(k, 0x9e3779b1)) >>> 0;
  return r === 0 ? 1 : r;
}

/** a RACEREP (roam_core.h rc_racerep) of a random car in lobby l of n players (rng: a Prng) */
export function raceRep(sender, rng, l, n) {
  const p = new Uint8Array(64);
  le32(p, 0, l.id);
  le32(p, 4, l.race);
  p[8] = [0, 1, 2, 3, 4, 10][rng.below(6)];
  p[9] = 1 + rng.below(3);
  le16(p, 10, rng.below(200));
  p[13] = Math.max(1, Math.min(6, n));
  p[12] = rng.below(p[13] + 1);
  p[14] = rng.below(8);
  p[15] = rng.below(40);
  p[16] = rng.below(5) === 0 ? 255 : rng.below(4);
  p[17] = rng.below(3);
  p[18] = rng.below(10);
  p[19] = rng.below(8);
  const strong = rng.below(10) === 0;
  const nums = [strong ? 1200 : 200 + rng.below(600), 300 + rng.below(300), 0.5 + rng.unit(), strong ? 900 : 80 + rng.below(400), 900 + rng.below(800), 200 + rng.below(200), rng.below(4) === 0 ? 0 : 40 + rng.unit() * 100];
  nums.forEach((x, k) => lef32(p, 20 + 4 * k, x));
  const name = new TextEncoder().encode(['350Z', 'RX-8', 'Skyline GT-R', 'Civic', 'Mustang GT'][rng.below(5)]);
  p.set(name, 48);
  return dgram(14, sender, p);
}

/** a RACERES (roam_core.h rc_raceres) of lobby l's racers ids, from sender (its own row flagged) */
export function raceRes(sender, rng, l, ids) {
  const n = Math.max(1, Math.min(6, ids.length));
  const heats = rng.below(4) === 0 ? 2 + rng.below(2) : 0;
  const heat = heats ? 1 + rng.below(heats) : 0;
  const p = new Uint8Array(12 + 20 * n);
  le32(p, 0, l.id);
  le32(p, 4, l.race);
  p[8] = [0, 1, 2, 3, 4][rng.below(5)];
  p[9] = 1 + rng.below(3);
  p[10] = n;
  p[11] = heat | (heats << 4);
  for (let k = 0; k < n; k++) {
    const o = 12 + 20 * k;
    le32(p, o, rng.below(8) === 0 ? 0 : ids[k]);
    const fin = rng.below(4) !== 0;
    p[o + 4] = (fin ? 1 : 0) | (ids[k] === sender ? 2 : 0);
    le16(p, o + 5, rng.below(6) === 0 ? 150 + rng.below(300) : rng.below(50));
    lef32(p, o + 8, fin ? 20 + rng.unit() * 200 : 0);
    lef32(p, o + 12, fin ? p[9] : rng.unit() * p[9]);
    lef32(p, o + 16, 500 + rng.unit() * 20000);
  }
  return dgram(16, sender, p);
}

