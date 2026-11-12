// Port of the tests of web/server-rs/crates/anticheat/src/lib.rs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quickest, QUICK_WINS, jumpSeen } from '../../src/anticheat/anticheat.js';

test('the quickest keep each racers best and the third leaves the winner out', () => {
  const q = new Quickest();
  for (const [who, t] of [['a', 60.0], ['b', 62.0], ['c', 65.0], ['a', 58.0], ['d', 70.0], ['e', 71.0]]) q.add(who, t);
  assert.deepEqual(q.top(), [['a', 58.0], ['b', 62.0], ['c', 65.0], ['d', 70.0]], 'each once, its best, TOP_KEPT');
  assert.equal(q.third('x'), null, 'not before QUICK_WINS');
  q.wins = QUICK_WINS;
  assert.equal(q.third('x'), 65.0);
  assert.equal(q.third('a'), 70.0, "the winner's own time is not one to beat");
  q.add('a', 80.0);
  assert.deepEqual(q.top()[0], ['a', 58.0], 'a slower time leaves the best');
});

test('a jump counts by two games or the only other one', () => {
  assert.ok(jumpSeen(2, false) && jumpSeen(3, true));
  assert.ok(!jumpSeen(1, false) && jumpSeen(1, true));
  assert.ok(!jumpSeen(0, true));
});

test('a NaN time is no best (f64::min)', () => {
  const q = new Quickest();
  q.add('a', 50.0);
  q.add('a', NaN);
  assert.deepEqual(q.top(), [['a', 50.0]]);
});
