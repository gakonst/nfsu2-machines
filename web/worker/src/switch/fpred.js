// Free roam's car states by their fields: a port of web/server-rs/crates/lan/src/fpred.rs.  A page whose hello said
// "fpred":1 besides "delta":1 gets a friend's SNAP of one state (runtime/roam_core.c rc_encode, put_state, put_statex) as
// the fields that differ from what the page can work out itself, each as a small number:
// - the position goes in millimetres, the velocity in centimetres a second and the time in steps of 256 µs: the page
//   writes back the floats and microseconds those make, so the game gets the state rounded that far (at most 0.5 mm,
//   0.5 cm/s and 128 µs off), with a CRC that checks out;
// - the time is taken to go on as it went (the last interval again), the sequence number too, and the position by the
//   last one's velocity over the time between: what is left of them is mostly nothing or a few millimetres;
// - every other field is taken to be what it was, and goes as its difference when it is not.
//
// An entry: [0] F_FPRED, [1..2] the source's low 16 bits, [3] the length of what follows (at most 255: a longer one goes
// as the byte delta instead); then a bitmap of the fields that differ (LEB128, 7 a byte, field 0 in bit 0, the groups of
// zeros at the end left out), then each of those as a zigzag LEB128 varint of the difference.  The fields are in NF
// order, the often-changing first.  Both ends keep each source's last state (as the page restores it: the rounded one),
// and the one before for the time and the sequence; a source with none goes against zeros.  Past REFS_MAX sources, a new
// one clears them all first, on both ends.  Anything else of the datagram that a state of this layout cannot carry
// (more states than one, a field of a newer core) goes as before, and leaves this state alone.
//
// Numbers: Rust's fields are i64.  What fields() makes is within ±1e9 (a position in mm of an f32 within 1e6 m) or 32
// bits, so the encoder (the switch's hot path) works in plain Numbers (Float64Array, exact for these) and asserts its
// input is safe integers.  The decoder (the page's side; here for the tests and the DST) reads varints of up to 64 bits
// from the wire, so it works in BigInt with i64 wrapping (BigInt64Array), as the Rust release build does.

import { ByteBuf } from './bytebuf.js';
import { REFS_MAX } from './compact.js';

/** fpred.rs F_FPRED: the entry's flags byte: the kind 1 with F_ROAM and F_WHOLE, which together go with nothing else */
export const F_FPRED = 0x61;
/** fpred.rs NF: the fields: the time and sequence number first (a standing car's only changes, mostly), then what a
 *  moving one changes */
export const NF = 53;
const T = 0; // steps of 256 µs, 24 bits
const SEQ = 1;
const P = 2; // x, y, z: millimetres
const V = 5; // centimetres a second
const Q = 8; // 4, i16
const W = 12; // 3, i16
const SPEED = 15;
const RPM = 16;
const STEER = 17;
const WZ = 18; // 4, i16
const ENG = 22;
const EACC = 23;
const EDCL = 24;
const THR = 25;
const BRK = 26;
const GEAR = 27;
const BITS = 28;
const NOS = 29;
const HYD = 30;
const THUMPS = 31;
const EBASE = 32;
const SLIP = 33; // 12 bytes: each wheel's two slips and its surface
const XLEN = 45;
const CLOCK = 46;
const STATUS = 47;
const EPOCH = 48;
const CFG_REV = 49;
const N = 50;
const FLAGS = 51;
const SENDER = 52;
/** runtime/roam_core.h RC_HF_STATEX: the header's flag for a state's extension */
const HF_STATEX = 0x0040;

/** the field indices, for tests and tools (fpred.rs's consts) */
export const FIELD = Object.freeze({ T, SEQ, P, V, Q, W, SPEED, RPM, STEER, WZ, ENG, EACC, EDCL, THR, BRK, GEAR, BITS, NOS, HYD, THUMPS, EBASE, SLIP, XLEN, CLOCK, STATUS, EPOCH, CFG_REV, N, FLAGS, SENDER });

/** fpred.rs width: a field's width when its difference wraps (bits), 0 for a signed one that does not */
export function width(i) {
  switch (i) {
    case RPM: case ENG: case SEQ: case CFG_REV: case FLAGS: return 16;
    case T: return 24;
    case SENDER: return 32;
    case EACC: case EDCL: case THR: case BRK: case GEAR: case BITS: case NOS: case HYD: case THUMPS: case EBASE:
    case XLEN: case CLOCK: case STATUS: case EPOCH: case N: return 8;
    default: return i >= SLIP && i < SLIP + 12 ? 8 : 0;
  }
}
const WIDTH = Uint8Array.from({ length: NF }, (_, i) => width(i));

/** fpred.rs layout: what an extension of x bytes holds past the wheels' heights and the nitrous, as roam_core.c
 *  get_statex reads it: bit 1 the hydraulics, 2 the wheels' slips, 4 the engine; -1 when a newer core's fields follow
 *  those (or it is too short) */
export function layout(x) {
  if (!(x >= 0 && x <= Number.MAX_SAFE_INTEGER)) return -1; // Rust's usize of a negative or huge i64: no layout
  const hyd = x >= 11, slip = x >= 23;
  const base = 9 + (hyd ? 2 : 0) + (slip ? 12 : 0);
  const eng = x >= base + 5;
  if (!(x >= 9 && base + (eng ? 5 : 0) === x)) return -1;
  return (hyd ? 1 : 0) | (slip ? 2 : 0) | (eng ? 4 : 0);
}

const F32 = new Float32Array(1);
const F32B = new Uint8Array(F32.buffer);
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) throw new Error('fpred.js: a little-endian platform');

function rd16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function rds16(b, o) {
  return ((b[o] | (b[o + 1] << 8)) << 16) >> 16;
}
function rd32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
/** an f32, little-endian, as a double (exact) */
function rdf(b, o) {
  F32B[0] = b[o];
  F32B[1] = b[o + 1];
  F32B[2] = b[o + 2];
  F32B[3] = b[o + 3];
  return F32[0];
}

/** fpred.rs round: x to the nearest whole number, halves away from zero (f64::round), for the x fields rounds: an f32
 *  times 1000 or 100, within 1e9.  Such an x has at most 31 significant bits, so x ± 0.5 is exact and the truncation is
 *  the rounding. */
function round(x) {
  return Math.trunc(x + (x < 0 || Object.is(x, -0) ? -0.5 : 0.5)) + 0; // + 0: no -0 (Rust's i64 has none)
}

/** fpred.rs fields: the fields of a SNAP's body (the datagram from its sender's id on, without its CRC: what a compact
 *  entry carries), rounded as they go, as a Float64Array(NF) of integers; null when it is not a SNAP of one state of
 *  this layout, or a float is not a finite one this can carry. */
export function fields(body) {
  if (body.length < 66 || body[12] !== 1) return null;
  const v = new Float64Array(NF);
  v[SENDER] = rd32(body, 0);
  v[SEQ] = rd16(body, 4);
  v[FLAGS] = rd16(body, 6);
  v[STATUS] = body[8];
  v[EPOCH] = body[9];
  v[CFG_REV] = rd16(body, 10);
  v[N] = 1;
  v[CLOCK] = body[13];
  v[T] = Math.floor((rd32(body, 14) + 128) / 256) & 0xFFFFFF;
  for (let i = 0; i < 3; i++) {
    const p = rdf(body, 18 + 4 * i), s = rdf(body, 30 + 4 * i);
    if (!Number.isFinite(p) || Math.abs(p) > 1e6 || !Number.isFinite(s) || Math.abs(s) > 1e6) return null;
    v[P + i] = round(p * 1000.0);
    v[V + i] = round(s * 100.0);
  }
  for (let i = 0; i < 4; i++) v[Q + i] = rds16(body, 42 + 2 * i);
  for (let i = 0; i < 3; i++) v[W + i] = rds16(body, 50 + 2 * i);
  v[STEER] = rds16(body, 56);
  v[THR] = body[58];
  v[BRK] = body[59];
  v[RPM] = rd16(body, 60);
  v[SPEED] = rds16(body, 62);
  v[GEAR] = body[64];
  v[BITS] = body[65];
  let end = 66;
  if (v[FLAGS] & HF_STATEX) {
    if (body.length < 67) return null;
    const x = body[66];
    v[XLEN] = x;
    end = 67 + x;
    if (x > 0) {
      const g = layout(x);
      if (g < 0) return null;
      if (body.length < end) return null;
      for (let i = 0; i < 4; i++) v[WZ + i] = rds16(body, 67 + 2 * i);
      v[NOS] = body[75];
      let k = 76;
      if (g & 1) {
        v[HYD] = body[76];
        v[THUMPS] = body[77];
        k = 78;
      }
      if (g & 2) {
        for (let i = 0; i < 12; i++) v[SLIP + i] = body[78 + i];
        k = 90;
      }
      if (g & 4) {
        v[ENG] = rd16(body, k);
        v[EACC] = body[k + 2];
        v[EDCL] = body[k + 3];
        v[EBASE] = body[k + 4];
      }
    }
  }
  return body.length === end ? v : null;
}

/** field i's low 32 bits as a u32 (Rust's as u32; masked further, as u16 / as u8), of a Number or a BigInt */
function lo32(v, i) {
  const x = v[i];
  return typeof x === 'bigint' ? Number(BigInt.asUintN(32, x)) : x >>> 0;
}
/** field i as an f64 (Rust's as f64: to the nearest, ties to even) */
function f64(v, i) {
  const x = v[i];
  return typeof x === 'bigint' ? Number(x) : x;
}
/** field i against a small whole number, exactly: -1, 0 or 1 */
function cmp(v, i, n) {
  const x = v[i];
  if (typeof x === 'bigint') {
    const b = BigInt(n);
    return x < b ? -1 : x > b ? 1 : 0;
  }
  return x < n ? -1 : x > n ? 1 : 0;
}

/** fpred.rs write: the body a state's fields make (the page does the same): its floats and time as the page writes them
 *  back, appended to out (a ByteBuf).  v: an array of NF whole numbers (Numbers, or BigInts as the decoder's).  False
 *  when the fields make no state of this layout (nothing is written then). */
export function write(v, out) {
  if (v.length !== NF) throw new RangeError('write: NF fields');
  const flags = lo32(v, FLAGS);
  const xIn = cmp(v, XLEN, 0) >= 0 && cmp(v, XLEN, 256) < 0;
  const x = xIn ? Number(v[XLEN]) : -1;
  let g = -1;
  if (flags & HF_STATEX && cmp(v, XLEN, 0) !== 0) {
    // Rust: layout(v[XLEN] as usize), a negative one huge: no layout either way
    g = xIn ? layout(x) : -1;
    if (g < 0) return false;
  }
  if (cmp(v, N, 1) !== 0 || !xIn) return false;
  out.u32le(lo32(v, SENDER));
  out.u16le(lo32(v, SEQ));
  out.u16le(flags);
  out.push(lo32(v, STATUS));
  out.push(lo32(v, EPOCH));
  out.u16le(lo32(v, CFG_REV));
  out.push(1);
  out.push(lo32(v, CLOCK));
  out.u32le((lo32(v, T) << 8) >>> 0);
  for (let i = 0; i < 3; i++) putF32(out, f64(v, P + i) / 1000.0);
  for (let i = 0; i < 3; i++) putF32(out, f64(v, V + i) / 100.0);
  for (let i = Q; i < Q + 4; i++) out.u16le(lo32(v, i));
  for (let i = W; i < W + 3; i++) out.u16le(lo32(v, i));
  out.u16le(lo32(v, STEER));
  out.push(lo32(v, THR));
  out.push(lo32(v, BRK));
  out.u16le(lo32(v, RPM));
  out.u16le(lo32(v, SPEED));
  out.push(lo32(v, GEAR));
  out.push(lo32(v, BITS));
  if (flags & HF_STATEX) {
    out.push(x);
    if (g >= 0) {
      for (let i = WZ; i < WZ + 4; i++) out.u16le(lo32(v, i));
      out.push(lo32(v, NOS));
      if (g & 1) {
        out.push(lo32(v, HYD));
        out.push(lo32(v, THUMPS));
      }
      if (g & 2) for (let i = SLIP; i < SLIP + 12; i++) out.push(lo32(v, i));
      if (g & 4) {
        out.u16le(lo32(v, ENG));
        out.push(lo32(v, EACC));
        out.push(lo32(v, EDCL));
        out.push(lo32(v, EBASE));
      }
    }
  }
  return true;
}

/** an f64 as Rust's as f32 (to the nearest, ties to even, as Math.fround), little-endian */
function putF32(out, x) {
  F32[0] = x;
  out.push(F32B[0]);
  out.push(F32B[1]);
  out.push(F32B[2]);
  out.push(F32B[3]);
}

/** fpred.rs rounded: a SNAP's body as the game gets it through this (rounded; null: it would go as before, as it is) */
export function rounded(body) {
  const v = fields(body);
  if (v === null) return null;
  const out = new ByteBuf(body.length);
  return write(v, out) ? out.toBytes() : null;
}

/** fpred.rs signed: a difference of bits bits, signed (0: as it is): its low bits, the top one the sign (Numbers: safe
 *  integers in; bits 0, 8, 16, 24 or 32) */
function signedN(d, bits) {
  switch (bits) {
    case 0: return d;
    case 8: return (d << 24) >> 24;
    case 16: return (d << 16) >> 16;
    case 24: return (d << 8) >> 8;
    case 32: return d | 0;
    default: throw new RangeError('signed: a width of 0, 8, 16, 24 or 32');
  }
}

/** i64::div_euclid by a positive divisor, exactly, for safe integers */
function divEuclidN(a, b) {
  let q = Math.floor(a / b);
  const r = a - q * b;
  if (r < 0) q -= 1;
  else if (r >= b) q += 1;
  return q;
}

/** fpred.rs put_varint_at: u (a safe non-negative integer) as a LEB128 varint into e at n: where it ends */
function putVarintAt(e, n, u) {
  while (u >= 0x80) {
    e[n++] = (u & 0x7F) | 0x80; // & takes the low 32 bits first: their low 7 are u's
    u = Math.floor(u / 128);
  }
  e[n] = u;
  return n + 1;
}

/** the BigInt path (the decoder's): i64 wrapping as Rust's release build */
const asI64 = (x) => BigInt.asIntN(64, x);
function signedB(d, bits) {
  return bits === 0 ? d : BigInt.asIntN(bits, d);
}
function divEuclidB(a, b) {
  const q = a / b;
  return a % b < 0n ? q - 1n : q;
}
/** fpred.rs apply */
function applyB(i, want, d) {
  const b = WIDTH[i];
  return b === 0 ? asI64(want + d) : (want + d) & ((1n << BigInt(b)) - 1n);
}

/** fpred.rs Last: what both ends keep of a source: its last state, and the one before's time and sequence number
 *  (two: there was one).  v is a Float64Array (the encoder's) or a BigInt64Array (the decoder's). */
class Last {
  constructor(v) {
    this.v = v;
    this.t2 = v instanceof BigInt64Array ? 0n : 0;
    this.seq2 = this.t2;
    this.two = false;
  }
}

/** a Last in BigInt (the decoder's) */
function bigLast(l) {
  if (l.v instanceof BigInt64Array) return l;
  const b = new Last(BigInt64Array.from(l.v, (x) => BigInt(x)));
  b.t2 = BigInt(l.t2);
  b.seq2 = BigInt(l.seq2);
  b.two = l.two;
  return b;
}

/** a Last in Numbers (the encoder's); asserts they are safe */
function numLast(l) {
  if (l.v instanceof Float64Array) return l;
  const n = new Last(Float64Array.from(l.v, (x) => toSafe(x)));
  n.t2 = toSafe(l.t2);
  n.seq2 = toSafe(l.seq2);
  n.two = l.two;
  return n;
}

function toSafe(x) {
  const n = Number(x);
  if (!Number.isSafeInteger(n)) throw new RangeError('Fpred: a field past 2^53 cannot go through the encoder');
  return n;
}

/** fpred.rs predict (the decoder's, in BigInt): the value each field is taken to have: its last, the time and sequence
 *  number as they went, the position carried on by the last velocity for the time since (t: this state's time, or
 *  null) */
function predictB(l, t) {
  if (!l) return new BigInt64Array(NF);
  const w = BigInt64Array.from(l.v);
  if (l.two) {
    w[T] = (2n * l.v[T] - l.t2) & 0xFFFFFFn;
    w[SEQ] = (2n * l.v[SEQ] - l.seq2) & 0xFFFFn;
  }
  if (t !== null) {
    const dt = signedB(t - l.v[T], 24);
    // at most about a second: anything longer is a new start, not a drive
    if (dt >= 0n && dt <= 4096n) {
      for (let i = 0; i < 3; i++) {
        // mm = cm/s x 10 x dt x 256 µs, rounded: the velocity times dt x 16 / 6250 (the store wraps to i64)
        w[P + i] = l.v[P + i] + divEuclidB(asI64(l.v[V + i] * dt * 16n + 3125n), 6250n);
      }
    }
  }
  return w;
}

/** get_varint's reader position (the decoder is synchronous: one at a time) */
let AT = 0;
/** fpred.rs get_varint: a LEB128 varint of at most 10 bytes as a u64 (BigInt), or null when cut short or longer */
function getVarint(b) {
  let u = 0n;
  for (let k = 0; k < 10; k++) {
    if (AT >= b.length) return null;
    const x = b[AT++];
    u |= BigInt(x & 0x7F) << BigInt(7 * k);
    if ((x & 0x80) === 0) return BigInt.asUintN(64, u);
  }
  return null;
}

/** the encoder's scratch: the differences, and the entry made on the stack (its head, the bitmap and up to NF varints of
 *  10 bytes at most) */
const D = new Float64Array(NF);
const E = new Uint8Array(4 + 10 * (NF + 1));
/** 2^i, exact up to 2^52 */
const POW2 = Float64Array.from({ length: NF }, (_, i) => 2 ** i);
/** the largest field the encoder takes (fields() makes them within 2^32) */
const LIMIT = 2 ** 52;

/** fpred.rs Fpred: one end's last states by source (the switch's writer for its page, or a decoder of the page's).
 *  Rust keeps them in a HashMap by KeyHash; nothing iterates it, so a Map is the same. */
export class Fpred {
  constructor() {
    /** @type {Map<number, Last>} by the source's low 16 bits */
    this.last = new Map();
  }

  /** fpred.rs Fpred::keep: v becomes src's last (a copy kept) */
  keep(src, v) {
    const l = this.last.get(src);
    const big = v instanceof BigInt64Array || typeof v[0] === 'bigint';
    if (l !== undefined) {
      const m = big ? bigLast(l) : numLast(l);
      m.t2 = m.v[T];
      m.seq2 = m.v[SEQ];
      m.two = true;
      m.v.set(v);
      this.last.set(src, m);
      return;
    }
    if (this.last.size >= REFS_MAX) this.last.clear();
    this.last.set(src, new Last(big ? BigInt64Array.from(v) : Float64Array.from(v)));
  }

  /** fpred.rs Fpred::encode: the entry of a state cur (NF safe integers, as fields() makes them) from src (u16) into buf
   *  (a ByteBuf); false when it would be longer than 255 (nothing written, nothing kept: it goes as before).  Each
   *  field against its last value, then the time, the sequence number and the position against their predictions. */
  encode(buf, src, cur) {
    if (cur.length !== NF) throw new RangeError('encode: NF fields');
    // whole Numbers within 2^52 (fields() makes them within 2^32): their differences are exact
    for (let i = 0; i < NF; i++) {
      const c = cur[i];
      if (!(Number.isInteger(c) && c <= LIMIT && c >= -LIMIT)) throw new RangeError('encode: fields must be whole Numbers within 2^52');
    }
    let l = this.last.get(src);
    if (l !== undefined && !(l.v instanceof Float64Array)) {
      l = numLast(l);
      this.last.set(src, l);
    }
    const d = D;
    if (l === undefined) {
      for (let i = 0; i < NF; i++) d[i] = signedN(cur[i], WIDTH[i]);
    } else {
      const lv = l.v;
      for (let i = 0; i < NF; i++) d[i] = signedN(cur[i] - lv[i], WIDTH[i]);
      if (l.two) {
        d[T] = signedN(cur[T] - ((2 * lv[T] - l.t2) & 0xFFFFFF), 24);
        d[SEQ] = signedN(cur[SEQ] - ((2 * lv[SEQ] - l.seq2) & 0xFFFF), 16);
      }
      const dt = signedN(cur[T] - lv[T], 24);
      if (dt >= 0 && dt <= 4096) {
        for (let i = P; i < P + 3; i++) {
          const x = lv[i + V - P] * dt * 16 + 3125;
          if (!Number.isSafeInteger(x)) throw new RangeError('encode: a velocity past 2^37'); // Rust's i64 would wrap
          d[i] = cur[i] - (lv[i] + divEuclidN(x, 6250));
        }
      }
    }
    let mask = 0;
    for (let i = 0; i < NF; i++) if (d[i] !== 0) mask += POW2[i];
    const e = E;
    e[0] = F_FPRED;
    e[1] = (src >>> 8) & 0xFF;
    e[2] = src & 0xFF;
    let n = putVarintAt(e, 4, mask);
    for (let i = 0; i < NF; i++) {
      const x = d[i];
      if (x === 0) continue;
      if (!Number.isSafeInteger(2 * x)) throw new RangeError('encode: a difference past 2^52');
      n = putVarintAt(e, n, x >= 0 ? 2 * x : -2 * x - 1);
    }
    if (n - 4 > 255) return false;
    e[3] = n - 4;
    buf.pushBytes(e.subarray(0, n));
    if (l !== undefined) {
      l.t2 = l.v[T];
      l.seq2 = l.v[SEQ];
      l.two = true;
      l.v.set(cur);
    } else {
      this.keep(src, cur);
    }
    return true;
  }

  /** fpred.rs Fpred::decode: an entry's state from src (e: what follows its 4-byte head) as its body (the datagram from
   *  its sender's id on, without the CRC, a Uint8Array); null when it is broken.  What the page does (proto.ts
   *  FpredState.take). */
  decode(src, e) {
    AT = 0;
    const mask = getVarint(e);
    if (mask === null || mask >> BigInt(NF) !== 0n) return null;
    const d = new BigInt64Array(NF);
    for (let i = 0; i < NF; i++) {
      if ((mask >> BigInt(i)) & 1n) {
        const u = getVarint(e);
        if (u === null) return null;
        d[i] = (u >> 1n) ^ -(u & 1n); // the store wraps to i64
      }
    }
    if (AT !== e.length) return null;
    let l = this.last.get(src);
    if (l !== undefined) l = bigLast(l);
    const t = applyB(T, predictB(l, null)[T], d[T]);
    const want = predictB(l, t);
    const cur = new BigInt64Array(NF);
    for (let i = 0; i < NF; i++) cur[i] = applyB(i, want[i], d[i]);
    const body = new ByteBuf(96);
    if (!write(cur, body)) return null;
    this.keep(src, cur);
    return body.toBytes();
  }
}
