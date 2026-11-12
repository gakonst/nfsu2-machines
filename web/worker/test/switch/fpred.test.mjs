// fpred.rs's unit tests, ported (web/server-rs/crates/lan/src/fpred.rs mod tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ByteBuf } from '../../src/switch/bytebuf.js';
import { REFS_MAX } from '../../src/switch/compact.js';
import { FIELD, F_FPRED, Fpred, NF, fields, rounded, width } from '../../src/switch/fpred.js';
import { body } from '../../src/switch/fpred_test_util.js';

const { T, SEQ, P, V, N } = FIELD;
const rdf = (b, o) => new DataView(b.buffer, b.byteOffset).getFloat32(o, true);
const rd32 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const f = Math.fround;

/** through an encoder and a decoder (the switch's writer and the page): what the page writes is the rounded body */
function through(enc, dec, src, b) {
  const v = fields(b);
  assert.ok(v, 'a state this carries');
  const buf = new ByteBuf();
  assert.ok(enc.encode(buf, src, v));
  const e = buf.bytes();
  assert.equal(e[0], F_FPRED);
  assert.equal((e[1] << 8) | e[2], src);
  assert.equal(e[3], e.length - 4);
  const got = dec.decode(src, e.subarray(4));
  assert.ok(got, 'it decodes');
  assert.deepEqual(got, rounded(b), 'the rounded body');
  return e.length;
}

test('every extension comes back rounded', () => {
  for (const x of [null, 0, 9, 11, 16, 23, 28]) {
    const enc = new Fpred(), dec = new Fpred();
    for (let k = 0; k < 5; k++) {
      const b = body(0xABCD0001, 10 + k, 1_000_000 + 50_000 * k, [f(1695.123), f(-884.5), f(24.25)], [f(12.5), f(-3.25), f(0.01)], k, x);
      through(enc, dec, 0x0102, b);
    }
  }
});

test('the rounding is that far and no farther', () => {
  const b = body(1, 1, 123_456_789, [f(1695.1234), f(-884.5006), f(24.2496)], [f(12.345), f(-3.2549), f(0.004)], 0, 16);
  const r = rounded(b);
  for (let i = 0; i < 3; i++) {
    let a = rdf(b, 18 + 4 * i), c = rdf(r, 18 + 4 * i);
    assert.ok(Math.abs(a - c) <= 0.0005 + 1e-4, 'position ' + i + ': ' + a + ' ' + c);
    a = rdf(b, 30 + 4 * i);
    c = rdf(r, 30 + 4 * i);
    assert.ok(Math.abs(a - c) <= 0.005 + 1e-6, 'velocity ' + i + ': ' + a + ' ' + c);
  }
  assert.ok(Math.abs(rd32(b, 14) - rd32(r, 14)) <= 128);
  assert.deepEqual(b.subarray(42), r.subarray(42), 'the rest as it was');
  assert.deepEqual(b.subarray(0, 14), r.subarray(0, 14));
});

// a car driving a circle at 20 a second, its frames a little late now and then: each comes back rounded, a moving one in
// a few bytes, a standing one in fewer
test('a drive is a few bytes a state', () => {
  const enc = new Fpred(), dec = new Fpred();
  let moving = 0, standing = 0;
  let t = 4_000_000_000; // wraps on the way
  for (let k = 0; k < 400; k++) {
    t = (t + 50_000 + (k % 7 === 0 ? 16_667 : 0)) >>> 0;
    const a = k * 0.05;
    const [p, v] = k < 300
      ? [[f(1000 + 40 * Math.cos(a)), f(-500 + 40 * Math.sin(a)), 24], [f(-40 * Math.sin(a)), f(40 * Math.cos(a)), 0]]
      : [[1040, -500, 24], [0, 0, 0]];
    const b = body(7, k, t, p, v, k < 300 ? k : 300, 16);
    const n = through(enc, dec, 0x0305, b);
    if (k > 2 && k < 300) moving += n;
    else if (k > 302) standing += n;
  }
  const m = moving / 297, s = standing / 97;
  assert.ok(m < 30 && s < 8, m.toFixed(1) + ' bytes a moving state, ' + s.toFixed(1) + ' a standing one');
});

test('what this cannot carry goes as before', () => {
  const ok = body(1, 1, 1, [1, 1, 1], [0, 0, 0], 0, 16);
  assert.ok(fields(ok));
  const three = ok.slice();
  three[12] = 3;
  assert.equal(fields(three), null, 'more states than one');
  for (const x of [10, 12, 14, 24, 30]) {
    const b0 = body(1, 1, 1, [1, 1, 1], [0, 0, 0], 0, 0);
    const b = new Uint8Array(b0.length + x);
    b.set(b0);
    b[66] = x;
    assert.equal(fields(b), null, 'an extension of ' + x + ": a newer core's fields");
  }
  for (const bad of [NaN, Infinity, 2e6]) {
    assert.equal(fields(body(1, 1, 1, [bad, 0, 0], [0, 0, 0], 0, null)), null);
    assert.equal(fields(body(1, 1, 1, [0, 0, 0], [0, bad, 0], 0, null)), null);
  }
  const long = new Uint8Array(ok.length + 1);
  long.set(ok);
  assert.ok(fields(long) === null && fields(ok.subarray(0, ok.length - 1)) === null, "a length that is not the layout's");
  // fields that would take more than 255 bytes: Rust's test gives the encoder 2^60s, which no fields() makes; the JS
  // encoder takes safe integers only and throws on them, writing and keeping nothing
  const enc = new Fpred();
  const big = new Array(NF).fill(0).map((_, i) => (width(i) === 0 ? 2 ** 60 : 2 ** width(i) / 2 - 1));
  big[N] = 1;
  const buf = new ByteBuf();
  buf.push(9);
  assert.throws(() => enc.encode(buf, 5, big));
  assert.ok(buf.len === 1 && enc.last.size === 0);
  // the widest safe fields still fit in 255 bytes
  const wide = new Array(NF).fill(0).map((_, i) => (width(i) === 0 ? 2 ** 51 : 2 ** width(i) / 2 - 1));
  wide[N] = 1;
  assert.ok(enc.encode(buf, 5, wide) && buf.len > 200);
});

// the time and the sequence number wrap, a frame is late (no prediction past a second), the epoch and the clock change,
// a far friend gets every fourth: each still comes back rounded
test('the edges of the predictions', () => {
  const enc = new Fpred(), dec = new Fpred();
  let seq = 65_530;
  let t = 0xFFFFFFFF - 120_000;
  for (let k = 0; k < 30; k++) {
    seq = (seq + (k > 20 ? 4 : 1)) & 0xFFFF;
    t = (t + (k === 10 ? 3_000_000 : k === 11 ? 0 : 50_000)) >>> 0;
    const b = body(9, seq, t, [-12000.5, 300.25, -2], [-60, 1.5, -0.25], k, k % 2 === 0 ? 16 : 28);
    if (k === 15) {
      b[9] = 8; // a teleport
      b[13] = 4; // a re-anchored clock
    }
    if (k > 20) b[6] |= 4; // every fourth
    through(enc, dec, 0x0909, b);
  }
});

// past REFS_MAX sources both ends forget them all at once, and still agree
test('many sources: both ends forget together', () => {
  const enc = new Fpred(), dec = new Fpred();
  for (let round = 0; round < 3; round++) {
    for (let s = 0; s < REFS_MAX + 40; s++) {
      const b = body(s, round, 1_000_000 * round + s, [s, 2, 3], [1, 0, 0], s, 11);
      through(enc, dec, s, b);
    }
    assert.ok(enc.last.size <= REFS_MAX && enc.last.size === dec.last.size);
  }
});

test('a broken entry decodes to nothing', () => {
  const enc = new Fpred();
  const b = body(1, 1, 1, [1, 1, 1], [0, 0, 0], 0, 16);
  const buf = new ByteBuf();
  assert.ok(enc.encode(buf, 3, fields(b)));
  const e = buf.toBytes().subarray(4);
  assert.equal(new Fpred().decode(3, e.subarray(0, e.length - 1)), null, 'cut short');
  const more = new Uint8Array(e.length + 1);
  more.set(e);
  assert.equal(new Fpred().decode(3, more), null, 'one too many');
  assert.equal(new Fpred().decode(3, new Uint8Array(9).fill(0xFF)), null, 'a bitmap past the fields');
});

// encode as it was until 2026-11-05: the whole prediction, then the differences, then keep (Numbers)
const signed = (d, bits) => (bits === 0 ? d : bits === 32 ? d | 0 : (d << (32 - bits)) >> (32 - bits));
function divEuclid(a, b) {
  let q = Math.floor(a / b);
  const r = a - q * b;
  if (r < 0) q--;
  else if (r >= b) q++;
  return q;
}
function predict(l, t) {
  if (!l) return new Array(NF).fill(0);
  const w = Array.from(l.v);
  if (l.two) {
    w[T] = (2 * l.v[T] - l.t2) & 0xFFFFFF;
    w[SEQ] = (2 * l.v[SEQ] - l.seq2) & 0xFFFF;
  }
  if (t !== null) {
    const dt = signed(t - l.v[T], 24);
    if (dt >= 0 && dt <= 4096) for (let i = 0; i < 3; i++) w[P + i] = l.v[P + i] + divEuclid(l.v[V + i] * dt * 16 + 3125, 6250);
  }
  return w;
}
function putVarint(out, u) {
  while (u >= 0x80) {
    out.push((u % 128) | 0x80);
    u = Math.floor(u / 128);
  }
  out.push(u);
}
function encodeByPredict(fp, buf, src, cur) {
  const want = predict(fp.last.get(src), cur[T]);
  const e = [F_FPRED, src >> 8, src & 255, 0];
  const d = cur.map((c, i) => signed(c - want[i], width(i)));
  let mask = 0;
  d.forEach((x, i) => {
    if (x !== 0) mask += 2 ** i;
  });
  putVarint(e, mask);
  for (const x of d) if (x !== 0) putVarint(e, x >= 0 ? 2 * x : -2 * x - 1);
  if (e.length - 4 > 255) return false;
  e[3] = e.length - 4;
  buf.pushBytes(Uint8Array.from(e));
  fp.keep(src, cur);
  return true;
}

/** the Rust test's xorshift64* */
class Rng {
  constructor(s) {
    this.s = s;
  }
  next() {
    const M = (1n << 64n) - 1n;
    let s = this.s;
    s ^= s >> 12n;
    s ^= (s << 25n) & M;
    s ^= s >> 27n;
    this.s = s;
    return (s * 0x2545F4914F6CDD1Dn) & M;
  }
  below(n) {
    return Number(this.next() % BigInt(n));
  }
}

// the encoder and predict's way give the same bytes, the same answer and keep the same: over states that drive, stand,
// jump in time, wrap their time and sequence, change any field and come from more sources than REFS_MAX (Rust runs
// 400,000 states; this 60,000, and the widest states, past 2^53, are refused by the JS encoder instead)
test("the encoder is predict's way byte for byte", () => {
  const rng = new Rng(0x9E3779B97F4A7C15n);
  const a = new Fpred(), b = new Fpred();
  const state = new Map();
  let said = 0, widest = 0;
  const clamp = (x, m) => Math.min(Math.max(x, -m), m);
  for (let k = 0; k < 60_000; k++) {
    const src = rng.below(10) < 8 ? rng.below(24) : rng.below(600);
    if (!state.has(src)) {
      const z = new Array(NF).fill(0);
      z[N] = 1;
      state.set(src, z);
    }
    const v = state.get(src).slice();
    const r = rng.below(20);
    const step = r === 0 ? rng.below(1 << 24) : r === 1 ? -rng.below(300) : r === 2 ? 4096 + rng.below(3) : 190 + rng.below(30);
    v[T] = (v[T] + step) & 0xFFFFFF;
    const jump = rng.below(8) === 0 ? 1 : 0;
    v[SEQ] = (v[SEQ] + 1 + jump * rng.below(5)) & 0xFFFF;
    if (rng.below(4) !== 0) {
      for (let i = 0; i < 3; i++) {
        v[V + i] = clamp(v[V + i] + rng.below(201) - 100, 100_000_000);
        v[P + i] = clamp(v[P + i] + Math.trunc(v[V + i] / 20) + rng.below(9) - 4, 1_000_000_000);
      }
    }
    const times = rng.below(6);
    for (let j = 0; j < times; j++) {
      const i = rng.below(NF);
      const within = (m) => rng.below(2 * m + 1) - m;
      const w = width(i);
      v[i] = w === 0 ? (i >= P && i < V ? within(1_000_000_000) : i >= V && i <= 7 ? within(100_000_000) : within(32768)) : rng.below(2 ** w);
    }
    if (rng.below(5000) === 0) {
      widest++;
      continue; // Rust: every field at its widest (2^62): not a state the JS encoder takes, and not kept
    }
    state.set(src, v);
    const x = new ByteBuf(), y = new ByteBuf();
    x.push(k & 255);
    y.push(k & 255);
    const okA = a.encode(x, src, v), okB = encodeByPredict(b, y, src, v);
    assert.equal(okA, okB, 'state ' + k + ' from ' + src);
    assert.deepEqual(x.bytes(), y.bytes(), 'state ' + k + ' from ' + src);
    said += okA ? 1 : 0;
    if (k % 997 === 0) {
      assert.equal(a.last.size, b.last.size);
      for (const [s, l] of a.last) {
        const m = b.last.get(s);
        assert.ok(Array.from(l.v).every((q, i) => q === m.v[i]) && l.t2 === m.t2 && l.seq2 === m.seq2 && l.two === m.two, 'source ' + s + ' kept the same');
      }
    }
  }
  assert.ok(said > 59_000, said + ' written (' + widest + ' widest skipped)');
});
