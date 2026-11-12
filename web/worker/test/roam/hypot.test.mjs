// A port of web/server-rs/crates/roam/tests/hypot.rs.
//
// hypot (links.js hypot3, exported by hub.js as hypot) against node's own Math.hypot, bit for bit: differences small
// and large, a zero or two among them, and the odd ones (subnormals, the largest double, infinities, NaN).  The links
// are the nearest pairs, and where two pairs are as near the players' order decides: a distance a bit off would link
// other players than the Node server's hub did.  (The Rust spawns node to compare with; here node is what runs it.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hypot } from '../../src/roam/hub.js';

const M64 = (1n << 64n) - 1n;

/** splitmix64: the same cases on every run */
class Rng {
  constructor(seed) {
    this.s = BigInt(seed);
  }
  next() {
    this.s = (this.s + 0x9e3779b97f4a7c15n) & M64;
    let z = this.s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
    return z ^ (z >> 31n);
  }
  unit() {
    return Number(this.next() >> 11n) / 2 ** 53;
  }
  below(n) {
    return Math.min(Math.trunc(this.unit() * n), Math.max(n - 1, 0));
  }
}

const f32 = Math.fround;

/**
 * the cases: differences of positions as the game has them (float32), of nearby ones, tiny ones, whole numbers and
 * zeros, and every pair of the odd values
 */
function hypots() {
  const r = new Rng(99);
  const s = () => {
    switch (r.below(5)) {
      case 0:
        return r.unit() * 40000.0 - 20000.0;
      case 1:
        return r.unit() * 2.0 - 1.0;
      case 2:
        return (r.unit() - 0.5) * 1e-6;
      case 3: {
        const a = f32(r.unit() * 40000.0 - 20000.0);
        const b = f32(r.unit() * 40000.0 - 20000.0);
        return a - b;
      }
      default:
        return r.below(5) === 0 ? 0.0 : r.below(1000) - 500;
    }
  };
  const v = [];
  for (let i = 0; i < 20000; i++) {
    const x = s(), y = s(), z = s();
    v.push([x, y, z]);
  }
  const odd = [0.0, -0.0, 1e-310, 5e-324, 1e300, 1.7976931348623157e308, Infinity, -Infinity, NaN, 3.0, 4.0, 12.0];
  for (const x of odd) {
    for (const y of odd) {
      v.push([x, y, 4.0]);
      v.push([x, 3.0, y]);
    }
  }
  return v;
}

const dv = new DataView(new ArrayBuffer(8));
function bits(x) {
  dv.setFloat64(0, x);
  return dv.getBigUint64(0);
}

test('hypot is Math.hypot', () => {
  const hyp = hypots();
  const bad = [];
  for (const h of hyp) {
    const a = hypot(h[0], h[1], h[2]), b = Math.hypot(h[0], h[1], h[2]);
    if (bits(a) !== bits(b)) bad.push('hypot(' + h.join(', ') + '): port ' + a + ', node ' + b);
  }
  assert.equal(hyp.length, 20000 + 2 * 12 * 12, 'an answer for each case');
  assert.ok(bad.length === 0, bad.length + ' of ' + hyp.length + ' differ, e.g.\n' + bad.slice(0, 10).join('\n'));
});

