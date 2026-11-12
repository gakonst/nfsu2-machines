// compact.rs's unit tests, ported (web/server-rs/crates/lan/src/compact.rs mod tests; the #[ignore]d cost benches are
// left out).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ByteBuf } from '../../src/switch/bytebuf.js';
import { crc32 } from '../../src/switch/crc32.js';
import {
  KIND_COMPACT, OTHER_MAX, REFS_MAX, ROAM_OK, TIMED_MAX, Refs, entry, entryFp, entryLen, mark, roamOk, timed, waited,
} from '../../src/switch/compact.js';
import { F_FPRED, Fpred, rounded } from '../../src/switch/fpred.js';
import { dgram, frame, roam, roamFrame, unpack, unpackAll, unpackFp, unpackWith } from '../../src/switch/compact_test_util.js';
import { body } from '../../src/switch/fpred_test_util.js';

const BASE = ((10 << 24) | (77 << 16)) >>> 0;
const BROADCAST = 0xFFFFFFFF;
const ROAM_PORT = 47210;
const RC_PING = 6;
const RC_PONG = 7;
const F_WHOLE = 0x40;
const F_DELTA = 0x80;
const F_ROAM = 0x20;
const addr = (x) => (BASE | x) >>> 0;
const bytes = (s) => new TextEncoder().encode(s);
const newBundle = () => {
  const b = new ByteBuf();
  b.pushBytes(Uint8Array.of(KIND_COMPACT, 0, 0, 0));
  return b;
};
/** the Rust tests' xorshift32 */
function xorshift32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s;
  };
}
const le32 = (x) => Uint8Array.of(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, x >>> 24);

// every kind of entry comes back as the frame it was, byte for byte, and the usual one is a quarter smaller
test('entries come back byte for byte', () => {
  const own = addr(0x0305);
  const a = addr(0x0102), b = addr(0x0F07);
  const snap = roam(3, new Uint8Array(70).fill(9));
  const broken = roam(3, new Uint8Array(70).fill(9));
  broken[broken.length - 1] ^= 1;
  const cases = [
    [frame(1, a, own, ROAM_PORT, ROAM_PORT, snap), a, own],
    [frame(1, b, BROADCAST, ROAM_PORT, ROAM_PORT, roam(1, bytes('hello'))), b, BROADCAST],
    [frame(1, a, own, 47211, 47300, snap), a, own],
    [frame(1, a, own, ROAM_PORT, ROAM_PORT, broken), a, own],
    [frame(1, a, own, ROAM_PORT, ROAM_PORT, bytes('just some bytes of a datagram')), a, own],
    [frame(1, a, own, ROAM_PORT, ROAM_PORT, new Uint8Array(0)), a, own],
    [frame(3, b, own, 6112, 6113, Uint8Array.of(1, 64, 0, 0, 0, 0, 0, 7, 42, 42)), b, own],
    [frame(5, b, BROADCAST, 0, 0, Uint8Array.of(8, 64, 0, 0, 0, 0, 0, 1)), b, BROADCAST],
    [frame(2, a, BROADCAST, 47300, 47300, snap), a, BROADCAST],
    [frame(1, 0x0B000001, own, ROAM_PORT, ROAM_PORT, snap), 0x0B000001, own],
    [frame(1, a, addr(9), ROAM_PORT, ROAM_PORT, snap), a, addr(9)],
  ];
  const buf = newBundle();
  const want = [];
  for (const [f, src, dst] of cases) {
    const m = mark(f);
    const before = buf.len;
    entry(buf, m, src, dst, own, null);
    assert.equal(buf.len - before, entryLen(m, src, dst, own));
    want.push(f);
  }
  assert.deepEqual(unpack(buf.bytes(), own), want);
  const m = mark(cases[0][0]);
  assert.equal(snap.length, 90);
  assert.equal(entryLen(m, a, own, own), 84);
  assert.equal(mark(cases[3][0])[1], 0, 'a broken CRC is not left out');
});

// a frame too short for its ports (12 to 15 bytes: the reader takes them) goes whole, broadcast or not
test('a frame without ports goes whole', () => {
  const own = addr(0x0305), a = addr(0x0102);
  const buf = newBundle();
  const want = [];
  for (const [kind, dst, len] of [[1, BROADCAST, 12], [1, own, 15], [3, BROADCAST, 13], [5, own, 14]]) {
    const f = new Uint8Array(len).fill(0xAB);
    f.set(frame(kind, a, dst, 0, 0, new Uint8Array(0)).subarray(0, 12));
    const m = mark(f);
    const before = buf.len;
    entry(buf, m, a, dst, own, null);
    assert.equal(buf.len - before, entryLen(m, a, dst, own));
    assert.equal(buf.bytes()[before], F_WHOLE);
    want.push(f);
  }
  assert.deepEqual(unpack(buf.bytes(), own), want);
});

// to a page that takes deltas: every datagram comes back byte for byte, and a snapshot that changed a little takes far
// fewer bytes
test('deltas come back byte for byte', () => {
  const own = addr(0x0305);
  const srcs = [addr(0x0102), addr(0x0F07), addr(0x1301)];
  const rnd = xorshift32(0x9E3779B9);
  const bodies = srcs.map(() => Array.from({ length: 75 }, () => rnd() & 0xFF));
  const frames = [];
  for (let step = 0; step < 400; step++) {
    const i = rnd() % srcs.length;
    const bd = bodies[i];
    const times = rnd() % 30;
    for (let j = 0; j < times; j++) {
      const k = rnd() % bd.length;
      bd[k] = rnd() & 0xFF;
    }
    if (step % 97 === 0) bd.push(rnd() & 0xFF);
    const u = Uint8Array.from(bd);
    frames.push([frame(1, srcs[i], own, ROAM_PORT, ROAM_PORT, roam(3, u)), srcs[i], own]);
    switch (step % 13) {
      case 0: frames.push([frame(1, srcs[i], own, ROAM_PORT, ROAM_PORT, roam(1, bytes('a hello'))), srcs[i], own]); break;
      case 5: frames.push([frame(1, srcs[i], BROADCAST, ROAM_PORT, ROAM_PORT, roam(3, u)), srcs[i], BROADCAST]); break;
      case 7: frames.push([frame(1, srcs[i], own, 47211, 47211, roam(3, u)), srcs[i], own]); break;
      case 9: frames.push([frame(3, srcs[i], own, 6112, 6113, Uint8Array.of(1, 64, 0, 0, 0, 0, 0, 7, 42)), srcs[i], own]); break;
    }
  }
  const refs = new Refs();
  const bundles = [];
  let b = newBundle();
  let plainBytes = 0, deltaBytes = 0;
  for (const [f, src, dst] of frames) {
    const m = mark(f);
    const at = b.len;
    entry(b, m, src, dst, own, refs);
    plainBytes += entryLen(m, src, dst, own);
    deltaBytes += b.len - at;
    if (b.len > 2000) {
      bundles.push(b.toBytes());
      b = newBundle();
    }
  }
  bundles.push(b.toBytes());
  const page = new Map();
  const got = bundles.flatMap((x) => unpackWith(x, own, page));
  assert.equal(got.length, frames.length);
  got.forEach((g, i) => assert.deepEqual(g, frames[i][0]));
  assert.ok(deltaBytes * 10 < plainBytes * 7, deltaBytes + ' bytes with deltas, ' + plainBytes + ' without');
});

// to a page that takes them, races' datagrams, the race horn's UDP, LAN broadcasts, free roam's among them and sources
// enough to clear the last ones now and then: what changed goes, and each comes back byte for byte
test('other datagrams as what changed come back byte for byte', () => {
  const own = addr(0x0305);
  const rnd = xorshift32(0x2545F491);
  const rivals = [0, 1, 2, 3, 4].map((i) => addr(0x0400 + i));
  const packets = rivals.map(() => Array.from({ length: 120 }, () => rnd() & 0xFF));
  const frames = [];
  for (let step = 0; step < 4000; step++) {
    const i = rnd() % rivals.length;
    const src = rivals[i], p = packets[i];
    const times = rnd() % 12;
    for (let j = 0; j < times; j++) {
      const k = rnd() % p.length;
      p[k] = rnd() & 0xFF;
    }
    if (step % 61 === 0) p.push(rnd() & 0xFF);
    else if (step % 61 === 30) p.pop();
    const d = Uint8Array.from([0, 64, 0, 0, 0, 0, 0, 0, ...p]);
    const ports = step % 89 === 0 ? [6112, 6114] : [6112, 6113];
    frames.push([frame(3, src, own, ports[0], ports[1], d), src, own]);
    switch (step % 17) {
      case 0: frames.push([frame(1, src, own, 3659, 3659, Uint8Array.of(1, 2, 3, step % 3)), src, own]); break;
      case 4: frames.push([frame(3, src, BROADCAST, 6112, 6112, Uint8Array.of(0, 1, 0, 0, 0, 0, 0, 0, 9, 9)), src, BROADCAST]); break;
      case 8: frames.push([frame(1, src, own, ROAM_PORT, ROAM_PORT, roam(3, Uint8Array.from(p.slice(0, 60)))), src, own]); break;
      case 3: frames.push([frame(3, src, own, 6112, 6113, new Uint8Array(1600).fill(step % 7)), src, own]); break;
      case 12:
      case 14: {
        const s = addr(0x1000 + step);
        frames.push([frame(3, s, own, 6112, 6113, d), s, own]);
        break;
      }
    }
  }
  const refs = new Refs();
  const bundles = [];
  let b = newBundle();
  let plainBytes = 0, deltaBytes = 0, asDeltas = 0;
  for (const [f, src, dst] of frames) {
    const m = mark(f);
    const at = b.len;
    entryFp(b, m, src, dst, own, refs, null, true);
    if (m[0] === 3 && dst === own && rivals.includes(src) && m.length - 12 <= OTHER_MAX) {
      plainBytes += entryLen(m, src, dst, own);
      deltaBytes += b.len - at;
      asDeltas += (b.bytes()[at] & (F_DELTA | F_ROAM)) === F_DELTA ? 1 : 0;
    }
    if (b.len > 2000) {
      bundles.push(b.toBytes());
      b = newBundle();
    }
  }
  bundles.push(b.toBytes());
  const page = new Map(), pageOthers = new Map();
  const got = bundles.flatMap((x) => unpackAll(x, own, page, null, pageOthers));
  assert.equal(got.length, frames.length);
  got.forEach((g, k) => assert.deepEqual(g, frames[k][0], 'frame ' + k));
  assert.ok(asDeltas > 3500, asDeltas + ' as deltas');
  assert.ok(deltaBytes * 10 < plainBytes * 4, deltaBytes + ' bytes with deltas, ' + plainBytes + ' without');
  // without "ldelta" the same go as before
  const b2 = newBundle();
  const refs2 = new Refs();
  for (const [f, src, dst] of frames.slice(0, 200)) entry(b2, mark(f), src, dst, own, refs2);
  const got2 = unpackWith(b2.bytes(), own, new Map());
  assert.ok(got2.every((g, i) => Buffer.from(g).equals(Buffer.from(frames[i][0]))));
});

// a ping's t0 and a pong's t2 come to the page moved on by their wait, with a CRC that checks out; the rest of them, a
// snapshot, and one that did not wait come as they were
test('a ping and a pong come with their wait counted out', () => {
  const own = addr(0x0305), src = addr(0x0102);
  const ping = mark(frame(1, src, own, ROAM_PORT, ROAM_PORT, roam(RC_PING, le32(1_000_000))));
  const pongBody = Uint8Array.from([...le32(500), ...le32(7000), ...le32(7000)]);
  const pong = mark(frame(1, src, own, ROAM_PORT, ROAM_PORT, roam(RC_PONG, pongBody)));
  const snap = mark(frame(1, src, own, ROAM_PORT, ROAM_PORT, roam(3, new Uint8Array(52).fill(9))));
  assert.ok(timed(ping) && timed(pong) && !timed(snap));
  const into = new Uint8Array(TIMED_MAX);
  const b = newBundle();
  const refs = new Refs();
  for (const [f, us] of [[ping, 2500], [pong, 31_000], [snap, 40_000], [ping, 0]]) {
    const d = waited(f, us, into).slice();
    entry(b, d, src, own, own, refs);
  }
  const got = unpackWith(b.bytes(), own, new Map());
  const t = (g, at) => new DataView(g.buffer, g.byteOffset).getUint32(16 + at, true);
  assert.equal(t(got[0], 16), 1_002_500, "the ping's t0");
  assert.deepEqual([t(got[1], 16), t(got[1], 20), t(got[1], 24)], [500, 7000, 38_000], "the pong's t0, t1, t2");
  for (const g of got) assert.ok(roamOk(g.subarray(16)), 'a CRC that checks out');
  const w = snap.slice();
  w[1] = 0;
  assert.deepEqual(got[2], w);
  assert.equal(t(got[3], 16), 1_000_000, 'no wait, no change');
});

// a ping or pong of every length the switch marks: one too short for its time comes as it was, never read or written
// past its end
test('a ping or pong too short for its time comes as it was', () => {
  const own = addr(0x0305), src = addr(0x0102);
  const into = new Uint8Array(TIMED_MAX);
  for (const [kind, times] of [[RC_PING, 4], [RC_PONG, 12]]) {
    for (let n = 0; n <= 12; n++) {
      const f = mark(frame(1, src, BROADCAST, ROAM_PORT, ROAM_PORT, roam(kind, new Uint8Array(n).fill(7))));
      assert.equal(f[1], ROAM_OK, 'marked: ' + n + ' bytes');
      assert.equal(timed(f), n >= times, 'type ' + kind + ', ' + n + ' bytes');
      const d = waited(f, 2500, into).slice();
      if (n < times) assert.deepEqual(d, f, 'as it was');
      const b = newBundle();
      entry(b, d, src, BROADCAST, own, new Refs());
      const got = unpackWith(b.bytes(), own, new Map());
      assert.equal(got.length, 1);
      assert.ok(roamOk(got[0].subarray(16)), 'a CRC that checks out');
    }
  }
});

// to a page that takes car states by their fields: a friend's SNAP goes so and reaches the game rounded, everything else
// (a ping with its wait, a HELLO, a SNAP of three states, one to the broadcast address) as before, byte for byte
test('car states by their fields among the rest', () => {
  const own = addr(0x0305), a = addr(0x0102), b = addr(0x0207);
  const refs = new Refs(), fp = new Fpred();
  const pageRefs = new Map(), pageFp = new Fpred();
  const want = [];
  const bundle = newBundle();
  const into = new Uint8Array(TIMED_MAX);
  let byFields = 0;
  const put = (f, src, dst, us, isRounded) => {
    const m = mark(f);
    const d = waited(m, us, into).slice();
    const at = bundle.len;
    entryFp(bundle, d, src, dst, own, refs, fp, false);
    if (bundle.bytes()[at] === F_FPRED) byFields++;
    let w = d.slice();
    w[1] = 0;
    if (isRounded) {
      const bd = rounded(w.subarray(16 + 8, w.length - 4));
      assert.ok(bd);
      w = roamFrame(3, bd, src, own);
    } else if (us > 0) {
      const n = w.length;
      w.set(le32(crc32(w, 16, n - 4)), n - 4);
    }
    want.push(w);
  };
  for (let k = 0; k < 40; k++) {
    const t = 1_000_000 + 50_000 * k;
    for (const [src, x] of [[a, 16], [b, 28]]) {
      const s = body(src, k, t, [Math.fround(100 + Math.fround(k * 1.5)), 2, 3], [30, 0.5, 0], k, x);
      put(roamFrame(3, s, src, own), src, own, 0, true);
    }
    if (k % 5 === 0) {
      put(frame(1, a, own, ROAM_PORT, ROAM_PORT, roam(RC_PING, le32(k))), a, own, 3000, false);
      put(frame(1, b, own, ROAM_PORT, ROAM_PORT, roam(1, bytes('a hello'))), b, own, 0, false);
      const three = body(a, k, t, [1, 1, 1], [0, 0, 0], k, 16);
      three[12] = 3;
      put(roamFrame(3, three, a, own), a, own, 0, false);
      const s = body(b, k, t, [5, 5, 5], [0, 0, 0], k, 16);
      put(frame(1, b, BROADCAST, ROAM_PORT, ROAM_PORT, dgram(3, s)), b, BROADCAST, 0, false);
    }
  }
  assert.equal(byFields, 80);
  const got = unpackFp(bundle.bytes(), own, pageRefs, pageFp);
  assert.equal(got.length, want.length);
  got.forEach((g, i) => assert.deepEqual(g, want[i], 'frame ' + i));
});

// past REFS_MAX sources the writer's last bodies all go, and the page's with them: still byte for byte
test('many sources: the last bodies go together', () => {
  const own = addr(0x0305);
  const refs = new Refs();
  const page = new Map();
  for (let round = 0; round < 3; round++) {
    const b = newBundle();
    const want = [];
    for (let s = 0; s < REFS_MAX + 40; s++) {
      const src = addr((Math.floor(s / 250) << 8) | ((s % 250) + 2));
      const f = frame(1, src, own, ROAM_PORT, ROAM_PORT, roam(3, Uint8Array.of(round, s & 255, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7)));
      entry(b, mark(f), src, own, own, refs);
      want.push(f);
    }
    assert.deepEqual(unpackWith(b.bytes(), own, page), want, 'round ' + round);
    assert.ok(refs.last.size <= REFS_MAX && page.size === refs.last.size);
  }
});

// byte 1 of the switch's copy is its own: what a client wrote there never says "checked"
test("a client's byte 1 is not kept", () => {
  const f = frame(1, addr(2), addr(3), ROAM_PORT, ROAM_PORT, bytes('not free roam'));
  f[1] = ROAM_OK;
  assert.equal(mark(f)[1], 0);
  const g = frame(3, addr(2), addr(3), 1, 2, roam(3, new Uint8Array(8)));
  g[1] = ROAM_OK;
  assert.equal(mark(g)[1], 0, "only kind 1 is free roam's");
});

// (JS only) what Rust would panic on throws here; a frame that only the switch's mark could have marked
test('broken invariants throw', () => {
  assert.throws(() => mark(Uint8Array.of(1)));
  const b = newBundle();
  const f = frame(1, addr(2), addr(3), ROAM_PORT, ROAM_PORT, new Uint8Array(4));
  f[1] = ROAM_OK; // not mark's: 24 bytes
  assert.throws(() => entry(b, f, addr(2), addr(3), addr(3), null));
  assert.throws(() => entry(b, Uint8Array.of(9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), addr(2), addr(3), addr(3), null));
});
