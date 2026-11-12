// A port of the #[cfg(test)] tests of web/server-rs/crates/roam/src/links.rs: the distance as V8 computes it, the
// stable sort by distance, the heap, the grid's nearest-first walk and the weight of a gap in height.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hypot3, orderKey, Heap, Cand, Level, Grid, Near, Found, weigh, square, distance, WALK_SOON, WALK_AHEAD, WALK_VIEW } from '../../src/roam/links.js';
import { hypot } from '../../src/util/crmath.js';

const M64 = (1n << 64n) - 1n;
/** the tests' LCG (seed * 6364136223846793005 + 1442695040888963407, wrapping) */
function lcg(seed) {
  let s = BigInt(seed);
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & M64;
    return s;
  };
}
/** a uniform f64 in [0, 1) of the LCG: (seed >> 11) / 2^53 */
function unitRng(seed) {
  const next = lcg(seed);
  return () => Number(next() >> 11n) / 2 ** 53;
}

const bitsView = new DataView(new ArrayBuffer(8));
/** f64::to_bits */
function bits(x) {
  bitsView.setFloat64(0, x);
  return bitsView.getBigUint64(0);
}
const fr = Math.fround;

test('hypot as v8', () => {
  assert.equal(hypot3(3.0, 4.0, 0.0), 5.0);
  assert.equal(hypot3(0.0, -0.0, 0.0), 0.0);
  assert.ok(Number.isNaN(hypot3(NaN, 1.0, 0.0)));
  assert.equal(hypot3(NaN, -Infinity, 0.0), Infinity);
});

// links.rs sort_stable (a radix sort of (order_key(d), i)) is, in the JS hub, a stable sort by d with the index after
// it (hub.js: order.sort((x, y) => pd[x] - pd[y] || x - y)); orderKey is d's place in the order of numbers, -0 as 0
test('sorts as a stable sort by the number', () => {
  const next = lcg(1);
  const rnd = () => next() >> 33n;
  for (const n of [0, 1, 5, 63, 64, 65, 1000, 31125]) {
    const ds = [];
    for (let k = 0; k < n; k++) {
      const c = rnd() % 6n;
      ds.push(c === 0n ? -1.0 : c === 1n ? 0.0 : c === 2n ? -0.0 : c === 3n ? Number(rnd() % 50n) * 0.5 : c === 4n ? Number(rnd()) * 1e-3 : Number(rnd()) * 1e6);
    }
    const v = ds.map((d, i) => [orderKey(d), i]);
    v.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    const want = ds.map((_, i) => i);
    // a stable comparison sort by the number
    want.sort((x, y) => (ds[x] < ds[y] ? -1 : ds[x] > ds[y] ? 1 : 0));
    assert.deepEqual(v.map((e) => e[1]), want, String(n));
  }
});

/** Rust's Cand::pair: (min(i, j), max(i, j)) in their order */
const pair = (c) => [c.lo, c.hi];

test('heap gives the least first', () => {
  const h = new Heap();
  for (const [d, i, j, nearest] of [[3.0, 1, 2, false], [1.0, 6, 5, true], [1.0, 2, 9, false], [-1.0, 7, 8, true], [1.0, 3, 2, false]]) {
    h.push(new Cand(d, i, j, nearest));
  }
  const order = [];
  for (let e; (e = h.pop()) !== null; ) order.push([e.d, e.i(), e.j(), e.nearest]);
  assert.deepEqual(order, [[-1.0, 7, 8, true], [1.0, 3, 2, false], [1.0, 2, 9, false], [1.0, 6, 5, true], [3.0, 1, 2, false]]);
  const big = new Cand(0.5, 2 ** 30 - 1, 2 ** 30 - 2, true);
  assert.deepEqual([big.i(), big.j(), big.nearest, big.walk], [2 ** 30 - 1, 2 ** 30 - 2, true, WALK_SOON]);
  const a = Cand.by(0.5, 4, 9, WALK_AHEAD);
  assert.deepEqual([a.i(), a.j(), a.nearest, a.walk, pair(a)], [4, 9, true, WALK_AHEAD, pair(new Cand(0.5, 9, 4, false))]);
  const v = Cand.by(0.5, 2 ** 30 - 1, 3, WALK_VIEW);
  assert.deepEqual([v.i(), v.j(), v.nearest, v.walk], [2 ** 30 - 1, 3, true, WALK_VIEW]);
});

/** the hub's rule (RoamOptions level_*) */
const STEEP = new Level(5.0, 0.2, 25.0);

/** every other of list[i] (but i) from from by (weigh, j), as a sort of them all gives them */
function sorted(pos, i, from, l) {
  const want = [];
  for (let j = 0; j < pos.length; j++) if (j !== i) want.push([weigh(from, pos[j], l), j]);
  // f64::total_cmp then j (the weights are never NaN; -0 before 0 as total_cmp has it)
  want.sort((x, y) => (bits(x[0]) === bits(y[0]) ? x[1] - y[1] : x[0] < y[0] || (x[0] === y[0] && Object.is(x[0], -0)) ? -1 : 1));
  return want;
}

function walkAll(n, g, pos) {
  const got = [];
  for (let e; (e = n.next(g, pos)) !== null; ) got.push(e);
  return got;
}

function sameBits(got, want) {
  return got.every((a, k) => bits(a[0]) === bits(want[k][0]) && a[1] === want[k][1]);
}

const show = (l) => 'Level { slack: ' + l.slack + ', grade: ' + l.grade + ', k: ' + l.k + ' }';

/** each one's walk gives the others as sorted does, bit for bit */
function walksAsSorted(pos, l) {
  const g = new Grid();
  g.build(pos, l);
  for (let i = 0; i < pos.length; i++) {
    const n = Near.of(g, pos, i, new Found());
    const got = walkAll(n, g, pos);
    const want = sorted(pos, i, pos[i], l);
    assert.equal(got.length, want.length, pos.length + ' players, player ' + i + ', ' + show(l));
    assert.ok(sameBits(got, want), pos.length + ' players, player ' + i + ', ' + show(l));
  }
}

/** a place in free roam (nothing "up") */
function at(x, y, z) {
  return [x, y, z, 0.0];
}

test('near walks nearest first', () => {
  const pos = [];
  for (let i = 0; i < 50; i++) pos.push(at(((i * 7) % 50) * 3.0, ((i * 11) % 50) * 2.0, 0.0));
  for (const l of [new Level(), STEEP]) walksAsSorted(pos, l);
});

// the walk on lattices whose points sit on the cells' edges (distances of exactly the reach, 5 m cells), on a few
// spots (players at one place), and on scattered float32 positions near and far: all others by (distance, j); and
// the same with roads over roads (a lattice at 0 m and one 6 to 30 m over it; a highway over streets with a hill
// and players in a shop), where gaps in height weigh more than they are
test('near walks nearest first at the edges', () => {
  const rnd = unitRng(7);
  const lattice = (n, step, z) => {
    const out = [];
    for (let k = 0; k < n * n; k++) out.push(at((k % n) * step, Math.floor(k / n) * step, z));
    return out;
  };
  const layouts = [lattice(10, 1.0, 0.0), lattice(12, 5.0, 0.0), lattice(9, 2.5, 0.0)];
  const spots = [at(0.0, 0.0, 0.0), at(5.0, 0.0, 0.0), at(0.0, 10.0, 1.0)];
  layouts.push(Array.from({ length: 120 }, (_, k) => spots[k % 3]));
  const scattered = [];
  for (let k = 0; k < 300; k++) {
    const r = k % 10 === 0 ? 15000.0 : 400.0;
    // (Rust evaluates an array's elements in order)
    const x = (rnd() * 2.0 - 1.0) * r;
    const y = (rnd() * 2.0 - 1.0) * r;
    const z = rnd() * 20.0;
    scattered.push([x, y, z, 0.0].map(fr));
  }
  layouts.push(scattered);
  for (const [n, step, up] of [[10, 5.0, 6.0], [12, 2.5, 10.0], [8, 5.0, 30.0]]) {
    layouts.push([...lattice(n, step, 0.0), ...lattice(n, step, up)]);
  }
  const roads = [];
  for (let k = 0; k < 400; k++) {
    const x = (rnd() * 2.0 - 1.0) * 300.0;
    const y = (rnd() * 2.0 - 1.0) * 300.0;
    const z = k % 4 === 0 ? 12.0 : k % 4 === 1 ? 0.2 * Math.abs(x) : rnd() * 2.0;
    roads.push([x, y, z, k % 9 === 0 ? 100.0 : 0.0].map(fr));
  }
  layouts.push(roads);
  for (const pos of layouts) for (const l of [new Level(), STEEP]) walksAsSorted(pos, l);
});

// from a point of its own (inside the players' span, on a cell's edge, far outside it, above them, in a shop): all
// others but i by (weigh(from, pos[j]), j)
test('near walks nearest first from a point', () => {
  const pos = [];
  for (let i = 0; i < 80; i++) pos.push(at(((i * 7) % 40) * 5.0, ((i * 13) % 40) * 2.5, (i % 3) * 7.0));
  const froms = [
    [0, at(37.5, 20.0, 1.0)],
    [5, at(15.0, 10.0, 0.0)],
    [79, at(-400.0, 900.0, 100.0)],
    [12, at(190.0, -3.0, 0.0)],
    [3, [60.0, 40.0, 14.0, 100.0]],
  ];
  for (const l of [new Level(), STEEP]) {
    const g = new Grid();
    g.build(pos, l);
    for (const [i, from] of froms) {
      const n = new Near(g, from, i, new Found());
      const got = walkAll(n, g, pos);
      const want = sorted(pos, i, from, l);
      assert.equal(got.length, want.length, 'from ' + from);
      assert.ok(sameBits(got, want), 'from ' + from);
    }
  }
});

// two places with no gap past what a road explains, and the same "up", weigh what their distance always was, bit
// for bit; any two weigh the same both ways, never less than their distance in x and y, and their square is the
// weight's
test('weighs as the distance on one road', () => {
  const rnd = unitRng(3);
  for (let n = 0; n < 20000; n++) {
    const up = (r) => (r < 0.2 ? 100.0 : 0.0);
    const a0 = (rnd() - 0.5) * 6000.0, a1 = (rnd() - 0.5) * 6000.0, a2 = rnd() * 60.0, a3 = up(rnd());
    const a = [a0, a1, a2, a3].map(fr);
    const b0 = a[0] + (rnd() - 0.5) * 400.0, b1 = a[1] + (rnd() - 0.5) * 400.0, b2 = a[2] + (rnd() - 0.5) * 40.0, b3 = up(rnd());
    const b = [b0, b1, b2, b3].map(fr);
    for (const l of [new Level(), STEEP]) {
      const d = weigh(a, b, l);
      const across = hypot(a[0] - b[0], a[1] - b[1]);
      const m = a + ' ' + b;
      assert.equal(bits(d), bits(weigh(b, a, l)), m);
      assert.equal(bits(square(a, b, l)), bits(square(b, a, l)), m);
      assert.ok(d >= across * (1.0 - 1e-15), m);
      assert.ok(Math.abs(square(a, b, l) - d * d) <= d * d * 1e-14, m);
      if (Math.abs(a[2] - b[2]) <= l.slack + l.grade * across && a[3] === b[3]) {
        const [x, y] = [[a[0], a[1], a[2]], [b[0], b[1], b[2]]];
        assert.equal(bits(d), bits(distance(x, y)), m);
        const [dx, dy, dz] = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        assert.equal(bits(square(a, b, l)), bits(dx * dx + dy * dy + dz * dz), m);
      }
    }
  }
});

/** Rust's f64::round */
function rround(x) {
  const t = Math.trunc(x);
  const f = x - t;
  return f >= 0.5 ? t + 1 : f <= -0.5 ? t - 1 : t;
}

// what gaps weigh: a road up a hill as it is; the street under a highway (10 m below) as a car 135 m off, less
// to the side, as it is once in sight; a car 4 m up over a bump beside ours as it is; a player in a shop 100 m up
test('weighs a road above as one far off', () => {
  const w = (a, b) => rround(weigh(a, b, STEEP) * 10.0) / 10.0;
  assert.equal(w(at(0.0, 0.0, 0.0), at(100.0, 0.0, 20.0)), 102.0);
  assert.equal(w(at(0.0, 0.0, 10.0), at(0.0, 0.0, 0.0)), 135.0);
  assert.equal(w(at(0.0, 0.0, 10.0), at(8.0, 0.0, 0.0)), 95.3);
  assert.equal(w(at(0.0, 0.0, 10.0), at(40.0, 0.0, 0.0)), 41.2);
  assert.equal(w(at(0.0, 0.0, 4.0), at(3.0, 0.0, 0.0)), 5.0);
  assert.equal(w([0.0, 0.0, 0.0, 100.0], at(0.0, 0.0, 0.0)), 100.0);
  assert.equal(w([30.0, 0.0, 2.0, 100.0], [0.0, 0.0, 0.0, 100.0]), 30.1);
});
