// Rust's f64::max/min/total_cmp as src/util/f64.js has them (the zeros' choice as the server's x86-64 build makes it:
// /tmp/zeromax in difftrace_watch.mjs's notes; max(+0,-0) = -0, max(-0,+0) = +0, the same for min).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmax, fmin, totalCmp } from '../../src/util/f64.js';

test('max and min ignore a NaN and take the second of two zeros', () => {
  assert.equal(fmax(NaN, 0), 0);
  assert.equal(fmax(1, NaN), 1);
  assert.equal(fmin(NaN, 2), 2);
  assert.ok(Object.is(fmax(0, -0), -0) && Object.is(fmax(-0, 0), 0));
  assert.ok(Object.is(fmin(0, -0), -0) && Object.is(fmin(-0, 0), 0));
  assert.equal(fmax(3, 4), 4);
  assert.equal(fmin(3, 4), 3);
});

test('total_cmp orders -0 before +0 and a positive NaN last', () => {
  const v = [NaN, 1, -0, 0, -Infinity, Infinity, -1];
  v.sort(totalCmp);
  assert.ok(Object.is(v[2], -0) && Object.is(v[3], 0));
  assert.deepEqual(v.map(String), ['-Infinity', '-1', '0', '0', '1', 'Infinity', 'NaN']);
});
