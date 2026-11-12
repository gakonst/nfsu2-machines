// The codecs' differential tests' inputs and the JS port's answers (codecs_diff.test.mjs): seeded queries, one JSON line
// each, that the Rust driver (web/server-rs/crates/lan-diff-codecs, src/difftrace.rs) answers from the Rust code and
// answer() here from the JS port, in the same shape.

import { Prng } from '../../src/util/prng.js';
import { ByteBuf } from '../../src/switch/bytebuf.js';
import { crc32 } from '../../src/switch/crc32.js';
import { KIND_COMPACT, ROAM_OK, TIMED_MAX, Refs, entry, entryFp, entryLen, mark, timed, waited } from '../../src/switch/compact.js';
import { FIELD, Fpred, NF, fields, layout, rounded, width, write } from '../../src/switch/fpred.js';
import { KINDS, MSGS, fmtFixed, kindsLine, line, msgLine, name, ofEntry, ofHost, ofPage } from '../../src/switch/mix.js';
import { unpackAll } from '../../src/switch/compact_test_util.js';

const BASE = ((10 << 24) | (77 << 16)) >>> 0;
const BROADCAST = 0xFFFFFFFF;
const ROAM_PORT = 47210;
const HUB = (BASE | 0xFD) >>> 0;
const addr = (x) => (BASE | x) >>> 0;

export function hex(b) {
  return Buffer.from(b.buffer, b.byteOffset, b.length).toString('hex');
}
export function unhex(s) {
  return new Uint8Array(Buffer.from(s, 'hex'));
}
const F64 = new DataView(new ArrayBuffer(8));
export function f64bits(x) {
  F64.setFloat64(0, x);
  return F64.getBigUint64(0).toString(16).padStart(16, '0');
}
export function bitsf64(s) {
  F64.setBigUint64(0, BigInt('0x' + s));
  return F64.getFloat64(0);
}

// ---- making frames ----

function cat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function frameOf(kind, b1, src, dst, sport, dport, data) {
  const f = new Uint8Array(16 + data.length);
  const dv = new DataView(f.buffer);
  f[0] = kind;
  f[1] = b1;
  dv.setUint32(4, src >>> 0);
  dv.setUint32(8, dst >>> 0);
  dv.setUint16(12, sport);
  dv.setUint16(14, dport);
  f.set(data, 16);
  return f;
}
/** a free-roam datagram: "N2FR", version, type, its length, a body (the sender's id on), the CRC */
function dgram(type, body, ver = 1) {
  const d = new Uint8Array(8 + body.length + 4);
  d.set([0x4E, 0x32, 0x46, 0x52, ver, type]);
  const n = d.length;
  d[6] = n & 255;
  d[7] = n >>> 8;
  d.set(body, 8);
  const c = crc32(d, 0, n - 4);
  new DataView(d.buffer).setUint32(n - 4, c, true);
  return d;
}

/** a car's state, as roam_core.c put_state writes it: what a SNAP of one carries (and its random variants) */
class Car {
  constructor(r, sender) {
    this.r = r;
    this.sender = sender;
    this.seq = r.below(65536);
    this.t = r.next32();
    this.p = [r.unit() * 4000 - 2000, r.unit() * 4000 - 2000, r.unit() * 100];
    this.v = [r.unit() * 80 - 40, r.unit() * 80 - 40, r.unit() * 2 - 1];
    this.x = [null, 0, 9, 11, 16, 23, 28][r.below(7)];
    this.k = r.below(1000);
  }
  /** the next state's body (from the sender's id on, without the CRC) */
  next() {
    const r = this.r;
    const dtUs = r.below(10) === 0 ? r.below(3_000_000) : 50_000 + (r.below(4) === 0 ? r.below(20_000) : 0);
    this.t = (this.t + dtUs) >>> 0;
    this.seq = (this.seq + 1 + (r.below(10) === 0 ? r.below(5) : 0)) & 0xFFFF;
    const standing = r.below(5) === 0;
    for (let i = 0; i < 3; i++) {
      if (!standing) {
        this.v[i] += r.unit() * 2 - 1;
        this.p[i] += (this.v[i] * dtUs) / 1e6;
      }
    }
    if (r.below(30) === 0) this.x = [null, 0, 9, 11, 16, 23, 28][r.below(7)];
    this.k += r.below(3);
    const p = this.p.map((x) => x), v = this.v.map((x) => (standing ? 0 : x));
    // edges now and then: halves at the rounding (an f32 x 1000 or x 100 at n + 0.5), big, not finite, -0, tiny
    if (r.below(8) === 0) {
      const i = r.below(3);
      const e = r.below(12);
      const vals = [
        (2 * r.below(1000) + 1) / 16 * (r.below(2) ? -1 : 1), 1e6, -1e6, 1e6 + 64, NaN, Infinity, -Infinity, -0, 1e-40, 2e6,
        (2 * r.below(100000) + 1) / 16, 999999.9375,
      ];
      p[i] = vals[e];
      if (r.below(2)) v[i] = r.below(2) ? (2 * r.below(1000) + 1) / 8 * (r.below(2) ? -1 : 1) : vals[e];
    }
    return carBody(this.sender, this.seq, this.t, p, v, this.k, this.x, r);
  }
}

/** a SNAP body: put_state's 66 bytes and put_statex's extension of x bytes (x null: none); r fills the other fields */
function carBody(sender, seq, t, p, v, k, x, r) {
  const b = new ByteBuf(100);
  b.u32le(sender >>> 0);
  b.u16le(seq);
  let flags = (x != null ? 0x0040 : 0) | 0x0020;
  if (r.below(10) === 0) flags |= r.below(65536) & ~0x0040;
  b.u16le(flags);
  b.push(r.below(4));
  b.push(r.below(10) === 0 ? r.below(256) : 7);
  b.u16le(r.below(10) === 0 ? r.below(65536) : 0x0102);
  b.push(1);
  b.push(r.below(10) === 0 ? r.below(256) : 3);
  b.u32le(t >>> 0);
  const f32 = new DataView(new ArrayBuffer(4));
  for (const q of [...p, ...v]) {
    f32.setFloat32(0, q, true);
    b.pushBytes(new Uint8Array(f32.buffer));
  }
  for (let i = 0; i < 8; i++) b.u16le(r.below(4) === 0 ? r.below(65536) : (k * (i + 1)) & 0xFFFF);
  b.push(r.below(256));
  b.push(r.below(256));
  b.u16le((3000 + 7 * k) & 0xFFFF);
  b.u16le((1500 + k) & 0xFFFF);
  b.push(r.below(7));
  b.push(r.below(256));
  if (x != null) {
    b.push(x);
    if (x > 0) {
      for (let i = 0; i < 4; i++) b.u16le((-300 + k + i) & 0xFFFF);
      b.push(r.below(256));
      const g = layout(x);
      if (g & 1) {
        b.push(r.below(3));
        b.push(r.below(256));
      }
      if (g & 2) for (let i = 0; i < 12; i++) b.push((i * 9 + k + r.below(3)) & 255);
      if (g & 4) {
        b.u16le((4000 + k) & 0xFFFF);
        b.push(r.below(256));
        b.push(r.below(256));
        b.push(r.below(256));
      }
    }
  }
  return b.toBytes();
}

/** a body that is not quite a SNAP of this layout: three states, an extension of a newer core, cut or longer */
function oddBody(r, car) {
  const b = car.next();
  switch (r.below(6)) {
    case 0: {
      const c = b.slice();
      c[12] = r.below(4) === 0 ? 0 : 3;
      return c;
    }
    case 1: return b.subarray(0, r.below(b.length));
    case 2: return cat(b, r.bytes(1 + r.below(8)));
    case 3: {
      const c = b.slice();
      if (c.length > 66) c[66] = r.below(256);
      return c;
    }
    case 4: {
      const c = b.slice();
      c[r.below(c.length)] ^= 1 << r.below(8);
      return c;
    }
    default: return r.bytes(r.below(120));
  }
}

/** a ping (t0) or pong (t0, t1, t2) of n body bytes past its 16-byte head, sometimes too short for its time */
function timedDgram(r, sender) {
  const ping = r.below(2) === 0;
  const full = ping ? 4 : 12;
  const n = r.below(4) === 0 ? r.below(full + 6) : full;
  const body = new Uint8Array(8 + n);
  new DataView(body.buffer).setUint32(0, sender >>> 0, true);
  body.set(r.bytes(4), 4);
  body.set(r.bytes(n), 8);
  return dgram(ping ? 6 : 7, body);
}

/** a free-roam datagram of any type, sometimes broken (CRC, length, magic, version) */
function roamDgram(r, car) {
  const c = r.below(10);
  let d;
  if (c < 4) d = dgram(3, car.next());
  else if (c < 5) d = dgram(3, oddBody(r, car));
  else if (c < 7) d = timedDgram(r, car.sender);
  else d = dgram(r.below(25), r.bytes(4 + r.below(r.below(8) === 0 ? 600 : 80)), r.below(30) === 0 ? 2 : 1);
  if (r.below(15) === 0) {
    d = d.slice();
    const k = r.below(4);
    if (k === 0) d[d.length - 1] ^= 1 << r.below(8);
    else if (k === 1) d[6] ^= 1;
    else if (k === 2) d[0] = 0x4D;
    else d = d.subarray(0, Math.max(0, d.length - 1 - r.below(6)));
  }
  return d;
}

/** a LAN play datagram (kinds 3-5): its 8-byte header and data */
function lanData(r, packet) {
  return cat(Uint8Array.of(r.below(3), 64, 0, 0, 0, 0, 0, r.below(8)), packet);
}

function pick(r, xs) {
  return xs[r.below(xs.length)];
}

/** one frame of anything the switch may hand a writer, from src to dst (dst sometimes not own or broadcast) */
function anyFrame(r, own, car) {
  const src = pick(r, [car.addr, car.addr, car.addr, HUB, 0x0B000001, (0x0A4E0000 | r.below(65536)) >>> 0, addr(r.below(65536))]);
  const dst = pick(r, [own, own, own, BROADCAST, addr(r.below(65536)), r.next32()]);
  const b1 = r.below(6) === 0 ? pick(r, [ROAM_OK, r.below(256)]) : 0;
  const c = r.below(12);
  if (c < 6) {
    const ports = r.below(6) === 0 ? [r.below(65536), pick(r, [ROAM_PORT, r.below(65536)])] : [ROAM_PORT, ROAM_PORT];
    return [frameOf(1, b1, src, dst, ports[0], ports[1], roamDgram(r, car)), src, dst];
  }
  if (c < 9) {
    const kind = 3 + r.below(3);
    return [frameOf(kind, b1, src, dst, pick(r, [6112, 6113, ROAM_PORT, r.below(65536)]), pick(r, [6112, 6113, r.below(65536)]), lanData(r, r.bytes(r.below(r.below(10) === 0 ? 1700 : 200)))), src, dst];
  }
  if (c < 10) return [frameOf(pick(r, [0, 2, 6, 7, 8, 33, 255]), b1, src, dst, r.below(65536), r.below(65536), r.bytes(r.below(100))), src, dst];
  // short and odd: 12 to 15 bytes, or garbage of any length 12 and up
  const f = r.bytes(12 + r.below(r.below(2) ? 4 : 80));
  f[0] = r.below(4) ? 1 + r.below(7) : f[0];
  return [f, src, dst];
}

function newCar(r, i) {
  const c = new Car(r, r.next32());
  c.addr = addr(r.below(4) === 0 ? r.below(65536) : 0x0100 + i);
  return c;
}

// ---- the queries ----

/** stateless frame queries: mark, timed, waited, entry_len, a plain entry, mix's kinds */
export function frameQueries(seed, count) {
  const r = new Prng(seed);
  const own = addr(r.below(65536));
  const cars = Array.from({ length: 6 }, (_, i) => newCar(r, i));
  const qs = [];
  for (let i = 0; i < count; i++) {
    let [f, src, dst] = anyFrame(r, own, pick(r, cars));
    if (r.below(40) === 0) f = r.bytes(r.below(12)); // shorter than any frame the reader takes: mark, kinds only
    const us = pick(r, [0, 0, 1 + r.below(1000), r.below(1_000_000), 999_999, 1_000_000, r.next32()]);
    const q = { op: 'frame', f: hex(f), src, dst, own, us };
    if (r.below(3)) q.roam = pick(r, [HUB, src]);
    if (r.below(3)) q.online = pick(r, [addr(1), src]);
    qs.push(q);
  }
  return qs;
}

/** a stream of frames to one page through one writer: Refs and Fpred carried across them, bundles cut as they fill */
export function streamQuery(seed, count, mode, long = true) {
  const r = new Prng(seed);
  const own = addr(r.below(65536));
  const many = r.below(6) === 0;
  const cars = Array.from({ length: many ? 300 : 2 + r.below(20) }, (_, i) => newCar(r, i));
  const rivals = cars.slice(0, 8).map(() => r.bytes(40 + r.below(120)));
  const lastRest = new Map();
  if (many && long) count *= 5;
  const frames = [];
  for (let i = 0; i < count; i++) {
    // (many: in turn half the time, so that more than REFS_MAX sources come and the last ones all go, on both ends)
    const ci = many && r.below(2) ? i % cars.length : r.below(cars.length);
    const car = cars[ci];
    const c = r.below(20);
    let f, src = car.addr, dst = own;
    if (c < 9) {
      // a friend's car state: by its fields, as a delta, or whole
      f = frameOf(1, 0, src, dst, ROAM_PORT, ROAM_PORT, dgram(3, r.below(12) ? car.next() : oddBody(r, car)));
    } else if (c < 11) {
      f = frameOf(1, 0, src, dst, ROAM_PORT, ROAM_PORT, timedDgram(r, car.sender));
    } else if (c < 15) {
      // a rival's race datagram: a few bytes new each time, now and then of another length or on other ports
      const k = ci % rivals.length;
      const kind = 3 + (r.below(15) === 0 ? 1 + r.below(2) : 0);
      // (on free roam's ports now and then: an other datagram's entry without its ports)
      const ports = r.below(4) === 0 ? [ROAM_PORT, ROAM_PORT] : [6112, r.below(20) === 0 ? 6114 : 6113];
      const last = lastRest.get(((src & 0xFFFF) << 8) | kind);
      if (last && last.length >= 12 && r.below(3) === 0) {
        // at the break-even: as many bytes new as make the delta about as long as the plain entry
        const len = last.length;
        const noPorts = last[0] === (ROAM_PORT >>> 8) && last[1] === (ROAM_PORT & 255) && last[2] === (ROAM_PORT >>> 8) && last[3] === (ROAM_PORT & 255);
        const even = len - Math.ceil(len / 8) - (noPorts ? 4 : 0);
        const want = Math.max(0, Math.min(len - 12, even + r.below(5) - 2));
        const rest = last.slice();
        const pos = Array.from({ length: len - 12 }, (_, j) => 12 + j);
        for (let j = 0; j < want; j++) {
          const q = j + r.below(pos.length - j);
          [pos[j], pos[q]] = [pos[q], pos[j]];
          rest[pos[j]] ^= 1 + r.below(255);
        }
        f = frameOf(kind, 0, src, dst, (rest[0] << 8) | rest[1], (rest[2] << 8) | rest[3], rest.subarray(4));
        rivals[k] = rest.slice(12);
      } else {
        let p = rivals[k];
        p = p.slice();
        // mostly a few bytes new; now and then most of them
        const n = r.below(4) === 0 ? r.below(p.length + 1) : r.below(12);
        for (let j = 0; j < n; j++) p[r.below(p.length)] = r.below(256);
        if (r.below(30) === 0) p = cat(p, r.bytes(1 + r.below(4)));
        else if (r.below(30) === 0 && p.length > 10) p = p.subarray(0, p.length - 1 - r.below(5));
        rivals[k] = p;
        f = frameOf(kind, 0, src, dst, ports[0], ports[1], lanData(r, p));
      }
    } else if (c < 17) {
      // a free-roam datagram of one length per source, any share of its bytes new (the delta's break-even)
      const blob = car.blob ?? (car.blob = r.bytes(8 + r.below(60)));
      const n = r.below(blob.length + 1);
      for (let j = 0; j < n; j++) blob[r.below(blob.length)] = r.below(256);
      const d = dgram(pick(r, [1, 2, 4, 12]), blob);
      if (r.below(3) === 0) d[d.length - 1] ^= 0x5A; // a CRC that does not check out: an other datagram on free roam's ports
      f = frameOf(1, 0, src, dst, ROAM_PORT, ROAM_PORT, d);
    } else {
      [f, src, dst] = anyFrame(r, own, car);
    }
    const m = mark(f);
    // (what the writer keeps as an other datagram's last, near enough: for the break-even above)
    if (f[0] >= 1 && f[0] <= 7 && f.length >= 16 && dst === own && src >>> 16 === BASE >>> 16 && m[1] !== ROAM_OK && f.length - 12 <= 1500) {
      lastRest.set(((src & 0xFFFF) << 8) | f[0], f.slice(12));
    }
    const us = timed(m) && r.below(4) ? r.below(60_000) : pick(r, [0, 0, 0, r.next32()]);
    frames.push([hex(f), src, dst, us]);
  }
  return { op: 'stream', own, refs: !!(mode & 1), fp: !!(mode & 2), others: !!(mode & 4), cut: pick(r, [2000, 2000, 100 + r.below(8000), 0]), frames };
}

/** car states' bodies from a few sources through fields, rounded and an encoder-decoder pair */
export function fpredQuery(seed, count) {
  const r = new Prng(seed);
  const many = r.below(4) === 0;
  const cars = Array.from({ length: many ? 300 : 1 + r.below(8) }, (_, i) => newCar(r, i));
  const bodies = [];
  if (many) count *= 3;
  for (let i = 0; i < count; i++) {
    const ci = many && r.below(2) ? i % cars.length : r.below(cars.length);
    bodies.push([ci & 0xFFFF, hex(r.below(10) ? cars[ci].next() : oddBody(r, cars[ci]))]);
  }
  return { op: 'fpred', bodies };
}

/** any fields the JS encoder takes (whole numbers within 2^52; velocities within 2^31 so the prediction stays exact)
 *  through an encoder, and write */
export function fpencQuery(seed, count) {
  const r = new Prng(seed);
  const state = new Map();
  const states = [];
  const within = (m) => Math.floor(r.unit() * (2 * m + 1)) - m;
  for (let k = 0; k < count; k++) {
    const src = r.below(10) < 8 ? r.below(12) : r.below(600);
    if (!state.has(src)) {
      const z = new Array(NF).fill(0);
      z[FIELD.N] = 1;
      state.set(src, z);
    }
    const v = state.get(src).slice();
    const s = r.below(20);
    v[FIELD.T] = (v[FIELD.T] + (s === 0 ? r.below(1 << 24) : s === 1 ? -r.below(300) : s === 2 ? 4096 + r.below(3) : 190 + r.below(30))) & 0xFFFFFF;
    v[FIELD.SEQ] = (v[FIELD.SEQ] + 1 + (r.below(8) === 0 ? r.below(5) : 0)) & 0xFFFF;
    for (let i = 0; i < 3; i++) {
      v[FIELD.V + i] = Math.max(-1e8, Math.min(1e8, v[FIELD.V + i] + r.below(201) - 100));
      v[FIELD.P + i] = Math.max(-1e9, Math.min(1e9, v[FIELD.P + i] + Math.trunc(v[FIELD.V + i] / 20) + r.below(9) - 4));
    }
    const n = r.below(6);
    for (let j = 0; j < n; j++) {
      const i = r.below(NF);
      const w = width(i);
      if (w === 0) v[i] = i >= FIELD.V && i < FIELD.V + 3 ? within(pick(r, [1e8, 2 ** 31])) : within(pick(r, [32768, 1e9, 2 ** 49]));
      else v[i] = r.below(5) === 0 ? within(2 ** 40) : r.below(2 ** w);
    }
    if (r.below(50) === 0) v[FIELD.N] = r.below(3);
    state.set(src, v);
    states.push([src, v]);
  }
  return { op: 'fpenc', states };
}

/** entries, broken and whole, through one decoder (state carried: garbage leaves i64s that wrap) */
export function fpdecQuery(seed, count) {
  const r = new Prng(seed);
  const enc = new Fpred();
  const car = newCar(r, 0);
  const entries = [];
  const varint = (out, u) => {
    // u: a BigInt below 2^64
    for (let k = 0; k < 10; k++) {
      const b = Number(u & 0x7Fn);
      u >>= 7n;
      if (u === 0n) {
        out.push(b);
        return;
      }
      out.push(b | 0x80);
    }
  };
  for (let i = 0; i < count; i++) {
    const src = r.below(4);
    const c = r.below(6);
    if (c < 2) {
      const v = fields(car.next());
      if (v) {
        const b = new ByteBuf();
        enc.encode(b, src, v);
        const e = b.toBytes().subarray(4);
        if (c === 1 && e.length) e[r.below(e.length)] ^= 1 << r.below(8);
        entries.push([src, hex(e)]);
        continue;
      }
    }
    if (c < 4) {
      // a bitmap and varints of any size: huge differences
      const out = [];
      const mask = r.next64() & ((1n << 53n) - 1n) & (r.below(2) ? r.next64() : (1n << 53n) - 1n);
      varint(out, r.below(20) === 0 ? r.next64() : mask);
      let m = mask;
      for (let k = 0; k < 53; k++, m >>= 1n) if (m & 1n) varint(out, pick(r, [BigInt(r.below(300)), r.next64(), r.next64() >> BigInt(r.below(64)), 0xFFFFFFFFFFFFFFFFn]));
      if (r.below(10) === 0) out.push(r.below(256));
      entries.push([src, hex(Uint8Array.from(out))]);
      continue;
    }
    entries.push([src, hex(r.bytes(r.below(30)))]);
  }
  return { op: 'fpdec', entries };
}

function counts(r, n, scale) {
  return Array.from({ length: n }, () => (r.below(3) === 0 ? 0 : Math.floor(r.unit() * pick(r, [scale, 1000, 1e6, 1e12]))));
}

function secsOf(r) {
  return f64bits(pick(r, [300, 300, 0, 0.5, 1, 1.5, 60, -5, NaN, 5e-324, 1e-300, r.unit() * 1000, Infinity, 7.25]));
}

/** mix's lines: random counts, some going backwards (saturating), seconds of every sort */
export function mixQueries(seed, count) {
  const r = new Prng(seed);
  const qs = [{ op: 'names' }];
  for (let i = 0; i < count; i++) {
    const c = r.below(3);
    if (c === 0) {
      const now = counts(r, 2 * KINDS, 1e9);
      // a few kinds big, many small: the 0.5 % cut and the ", n smaller kinds"
      for (let j = 0; j < 3; j++) now[r.below(KINDS)] = Math.floor(r.unit() * 1e12);
      const was = r.below(3) === 0 ? [] : counts(r, r.below(4) === 0 ? r.below(2 * KINDS) : 2 * KINDS, 1e9);
      qs.push({ op: 'line', now, was, secs: secsOf(r) });
      if (r.below(3) === 0) {
        // at the 0.5 % cut: one kind exactly 1/200 of all, one just under
        const x = 1 + r.below(100000);
        const now2 = new Array(2 * KINDS).fill(0);
        const a = r.below(KINDS), b = (a + 1 + r.below(KINDS - 1)) % KINDS;
        now2[a] = x;
        now2[b] = x - 1;
        let rest = 200 * x - x - (x - 1);
        for (let j = 0; rest > 0; j++) {
          const k = (b + 1 + (j % (KINDS - 2))) % KINDS;
          if (k === a || k === b) continue;
          const take = j > 400 ? rest : Math.min(rest, x * (2 + r.below(60)));
          now2[k] += take;
          rest -= take;
        }
        for (let j = KINDS; j < 2 * KINDS; j++) now2[j] = r.below(1000);
        qs[qs.length - 1] = { op: 'line', now: now2, was: [], secs: secsOf(r) };
      }
    } else if (c === 1) {
      const now = counts(r, MSGS, 1e6);
      const was = r.below(3) === 0 ? [] : counts(r, r.below(4) === 0 ? r.below(MSGS) : MSGS, 1e6);
      qs.push({ op: 'msgline', now, was, secs: secsOf(r) });
    } else {
      const kinds = Array.from({ length: r.below(6) }, () => [pick(r, ['racing or in a race lobby', 'in Online mode', 'driving in free roam', 'idle']), r.below(4) === 0 ? 0 : r.below(5000), Math.floor(r.unit() * 1e9), Math.floor(r.unit() * 1e9)]);
      qs.push({ op: 'kindsline', kinds, secs: secsOf(r) });
    }
  }
  return qs;
}

/** numbers as {:.0} and {:.1} write them: ties, every digit of large ones, not finite, negative */
export function fmtQuery(seed, count) {
  const r = new Prng(seed);
  const xs = [];
  for (let i = 0; i < count; i++) {
    const c = r.below(10);
    let x;
    if (c === 0) x = r.below(100000) + 0.5;
    else if (c === 1) x = (2 * r.below(100000) + 1) / 4;
    else if (c === 2) x = r.unit() * 10 ** r.below(25);
    else if (c === 3) x = pick(r, [NaN, Infinity, -Infinity, -0, 0, 5e-324, 1e21, 1e22, 2 ** 53, 2 ** 53 + 2, 9.95, 0.05, 0.15, 0.25, 0.35, 99.95, 1e300]);
    else if (c === 4) x = -r.unit() * 10 ** r.below(8);
    else if (c === 5) x = r.below(1000) / 10 + 0.05;
    else if (c === 6) x = (r.below(2 ** 30) * 2 + 1) / 2;
    else x = r.unit() * 1e6;
    xs.push(f64bits(x));
  }
  return { op: 'fmt', xs };
}

// ---- the JS port's answers ----

const into = new Uint8Array(TIMED_MAX);

/** what the Rust driver answers to q, from the JS port */
export function answer(q) {
  switch (q.op) {
    case 'frame': {
      const f = unhex(q.f);
      const a = { kr: ofEntry(f, q.src, q.dst), kp: ofPage(f, q.dst), kh: ofHost(f, q.roam ?? null, q.online ?? null) };
      if (f.length < 2) return a;
      const m = mark(f);
      const w = waited(m, q.us, into);
      let e = null;
      if (f.length >= 12) {
        const b = new ByteBuf();
        entry(b, m, q.src, q.dst, q.own, null);
        e = hex(b.bytes());
      }
      return { ...a, m: hex(m), timed: timed(m), w: hex(w), len: entryLen(m, q.src, q.dst, q.own), e, k: ofEntry(m, q.src, q.dst) };
    }
    case 'stream': {
      const refs = new Refs(), fp = new Fpred();
      const entries = [], kinds = [], bundles = [];
      let b = new ByteBuf();
      b.pushBytes(Uint8Array.of(KIND_COMPACT, 0, 0, 0));
      for (const [fh, src, dst, us] of q.frames) {
        const m = mark(unhex(fh));
        const d = waited(m, us, into).slice();
        const at = b.len;
        entryFp(b, d, src, dst, q.own, q.refs ? refs : null, q.fp ? fp : null, q.others);
        entries.push(hex(b.view(at)));
        kinds.push(ofEntry(d, src, dst));
        if (b.len > q.cut) {
          bundles.push(b.toBytes());
          b = new ByteBuf();
          b.pushBytes(Uint8Array.of(KIND_COMPACT, 0, 0, 0));
        }
      }
      bundles.push(b.toBytes());
      const page = new Map(), pageFp = new Fpred(), pageOthers = new Map();
      const unpacked = [];
      for (const x of bundles) for (const f of unpackAll(x, q.own, q.refs ? page : null, q.fp ? pageFp : null, q.others ? pageOthers : null)) unpacked.push(hex(f));
      return { entries, kinds, unpacked };
    }
    case 'fpred': {
      const enc = new Fpred(), dec = new Fpred();
      return q.bodies.map(([src, bh]) => {
        const b = unhex(bh);
        const v = fields(b);
        const rd = rounded(b);
        if (v === null) return { fields: null, rounded: rd && hex(rd) };
        const buf = new ByteBuf();
        const ok = enc.encode(buf, src, v);
        const d = ok ? dec.decode(src, buf.view(4)) : null;
        return { fields: Array.from(v), rounded: rd && hex(rd), enc: ok ? hex(buf.bytes()) : null, dec: d && hex(d) };
      });
    }
    case 'fpenc': {
      const enc = new Fpred();
      return q.states.map(([src, v]) => {
        const buf = new ByteBuf();
        const ok = enc.encode(buf, src, v);
        const w = new ByteBuf();
        const wrote = write(v, w);
        return { enc: ok ? hex(buf.bytes()) : null, write: wrote ? hex(w.bytes()) : null };
      });
    }
    case 'fpdec': {
      const dec = new Fpred();
      return q.entries.map(([src, eh]) => {
        const d = dec.decode(src, unhex(eh));
        return d && hex(d);
      });
    }
    case 'names': return Array.from({ length: KINDS }, (_, i) => name(i));
    case 'line': return line(q.now, q.was, bitsf64(q.secs));
    case 'msgline': return msgLine(q.now, q.was, bitsf64(q.secs));
    case 'kindsline': return kindsLine(q.kinds.map(([kind, players, msgsIn, msgsOut]) => ({ kind, players, msgsIn, msgsOut })), bitsf64(q.secs));
    case 'fmt': return q.xs.map((s) => [fmtFixed(bitsf64(s), 0), fmtFixed(bitsf64(s), 1)]);
    default: throw new Error('unknown op ' + q.op);
  }
}

/** the whole run's queries (full: the one with cargo; else the fixture's smaller one) */
export function allQueries(full) {
  const qs = [];
  const S = full ? { frameSeeds: 40, frames: 300, streams: 96, streamLen: 400, fpred: 40, fpredLen: 300, fpenc: 20, fpencLen: 500, fpdec: 20, fpdecLen: 400, mix: 600, fmt: 20 }
    : { frameSeeds: 2, frames: 40, streams: 8, streamLen: 24, fpred: 1, fpredLen: 60, fpenc: 1, fpencLen: 60, fpdec: 1, fpdecLen: 100, mix: 60, fmt: 1 };
  for (let s = 0; s < S.frameSeeds; s++) qs.push(...frameQueries(1000 + s, S.frames));
  for (let s = 0; s < S.streams; s++) qs.push(streamQuery(2000 + s, S.streamLen, s % 8, full));
  for (let s = 0; s < S.fpred; s++) qs.push(fpredQuery(3000 + s, S.fpredLen));
  for (let s = 0; s < S.fpenc; s++) qs.push(fpencQuery(4000 + s, S.fpencLen));
  for (let s = 0; s < S.fpdec; s++) qs.push(fpdecQuery(5000 + s, S.fpdecLen));
  qs.push(...mixQueries(6000, S.mix));
  for (let s = 0; s < S.fmt; s++) qs.push(fmtQuery(7000 + s, 200));
  return { qs, sizes: S };
}
