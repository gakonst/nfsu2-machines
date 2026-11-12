// Port of the #[cfg(test)] tests of web/server-rs/crates/roam/src/watch.rs, every assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Watch } from '../../src/roam/watch.js';

/** Rust's float as u32: truncated, saturating, NaN 0 */
function asU32(x) {
  if (!(x > 0)) return 0;
  return x >= 4294967295 ? 4294967295 : Math.trunc(x);
}

/** a player driving: a SNAP every 500 ms, its clock with the server's */
class Drive {
  constructor() {
    this.w = new Watch(0.0);
    this.now = 0.0;
    this.tUs = 7_000_000;
    this.clock = 0;
  }
  /** the next SNAP, ms later by the server's clock and own ms later by the player's */
  at(ms, own, p) {
    this.now += ms;
    this.tUs = (this.tUs + asU32(own * 1000.0)) >>> 0;
    return this.w.snap(this.now, p, this.tUs, this.clock, false);
  }
  snap(p) {
    return this.at(500.0, 500.0, p);
  }
  /** SNAPs from x0 to x1 at mps, one every 500 ms; what they showed */
  drive(x0, x1, mps) {
    const n = Math.round((x1 - x0) / (mps / 2.0));
    const out = [];
    for (let i = 1; i <= n; i++) out.push(...this.snap([x0 + ((x1 - x0) * i) / n, 0.0, 0.0]).filter((s) => s !== null));
    return out;
  }
}

const x = (m) => [m, 0.0, 0.0];
const flat = (a) => a.filter((s) => s !== null);

// (Rust's f64::round rounds half away from zero; Math.round rounds half up: the same for the test's positive counts)

test('a teleport is seen and driving is not', () => {
  const d = new Drive();
  d.snap(x(0.0));
  assert.deepEqual(d.drive(0.0, 31_500.0, 105.0), []);
  const [jump] = d.snap(x(33_500.0));
  assert.equal(jump?.kind, 'jump', JSON.stringify(jump));
  assert.deepEqual([jump.d, jump.ms, jump.over], [2000.0, 500.0, 1912.5]);
  assert.deepEqual(d.drive(33_500.0, 40_000.0, 100.0), []);
  assert.equal(d.w.jumps, 1);
});

test('a respawn is no teleport', () => {
  const d = new Drive();
  d.snap(x(0.0));
  assert.deepEqual(d.snap(x(250.0)), [null, null]);
  assert.deepEqual(d.drive(250.0, 750.0, 100.0), []);
  assert.deepEqual(d.snap(x(1000.0)), [null, null]);
  assert.deepEqual([d.w.jumps, d.w.runs], [0, 0]);
});

test('short jumps add up', () => {
  const d = new Drive();
  d.snap(x(0.0));
  let at = 0.0;
  const seen = [];
  for (let k = 0; k < 4; k++) {
    at += 290.0;
    seen.push(...flat(d.snap(x(at))));
    seen.push(...flat(d.snap(x(at))));
  }
  assert.equal(seen.length, 2, JSON.stringify(seen));
  assert.ok(seen[0].kind === 'jump' && seen[1].kind === 'jump', JSON.stringify(seen));
  assert.deepEqual([seen[0].d, seen[0].ms], [580.0, 1500.0], 'the second jump, 1.5 s after the first began');
  assert.deepEqual(seen[1].from, x(580.0), 'then the third and fourth');
});

test("the world map's jump is no teleport", () => {
  const jump = (from, to) => {
    const d = new Drive();
    d.snap(from);
    const [seen] = d.snap(to);
    return [seen !== null, d.w.jumps];
  };
  assert.deepEqual(jump([-1261.0, 782.0, 48.0], [226.0, -478.0, 18.0]), [false, 0], "onto an event's trigger");
  assert.deepEqual(jump([-408.0, 22.0, 14.0], [352.0, -749.0, 14.0]), [false, 0], "beside the Performance Shop's");
  assert.deepEqual(jump([-71.0, -1584.0, 14.0], [-316.0, -458.0, 20.0]), [false, 0], "39 m beside a shop's (2026-10-29)");
  assert.deepEqual(jump([-1261.0, 782.0, 48.0], [326.0, -478.0, 18.0]), [true, 1], "100 m off the event's");
});

test('out of free roam starts afresh', () => {
  const d = new Drive();
  d.snap(x(0.0));
  d.w.reset();
  assert.deepEqual(d.snap(x(5000.0)), [null, null]);
  assert.equal(d.w.jumps, 0);
});

test('a new clock or silence excuses no jump', () => {
  const d = new Drive();
  d.snap(x(0.0));
  d.clock = 1;
  const a = d.snap(x(3000.0));
  assert.ok(a[0]?.kind === 'jump' && a[1] === null, 'a new clock epoch');
  assert.deepEqual(d.at(20_000.0, 20_000.0, x(5000.0)), [null, null], '20 s later, 2 km on');
  const b = d.at(20_000.0, 20_000.0, x(9000.0));
  assert.ok(b[0]?.kind === 'jump' && b[1] === null, '20 s later, 4 km on');
});

test('snaps that come at once count by their own times', () => {
  const d = new Drive();
  d.snap(x(0.0));
  assert.deepEqual(d.at(1500.0, 500.0, x(50.0)), [null, null], 'late');
  assert.deepEqual(d.at(1.0, 500.0, x(100.0)), [null, null], '1 ms after it');
  assert.deepEqual([d.w.jumps, d.w.runMs], [0, 0.0]);
});

test('older snaps are left out', () => {
  const d = new Drive();
  d.snap(x(0.0));
  const tOld = d.tUs;
  // 6 s on at 100 m/s, by the new connection, then the old one's backlog of the 6 s
  assert.deepEqual(d.at(6500.0, 6000.0, x(600.0)), [null, null]);
  for (let i = 1; i < 12; i++) {
    const t = (tOld + i * 500_000) >>> 0;
    assert.deepEqual(d.w.snap(d.now + i, x(i * 50.0), t, 0, false), [null, null], 'old SNAP ' + i);
  }
  assert.deepEqual(d.at(500.0, 500.0, x(650.0)), [null, null]);
  // an older clock epoch too
  d.clock = 5;
  d.snap(x(700.0));
  assert.deepEqual(d.w.snap(d.now + 1.0, x(9000.0), d.tUs, 4, false), [null, null]);
  assert.equal(d.w.jumps, 0);
});

test('a fast run is told once', () => {
  const d = new Drive();
  d.snap(x(0.0));
  const told = [];
  for (let i = 1; i <= 10; i++) {
    const [s] = d.snap(x(i * 83.3));
    if (s !== null) told.push([i, s]);
  }
  assert.equal(told.length, 1, JSON.stringify(told));
  const [i, s] = told[0];
  assert.equal(s.kind, 'fast');
  assert.deepEqual([i, s.ms], [4, 2000.0]);
  assert.ok(Math.abs(s.mps * 3.6 - 600.0) < 1.0, String(s.mps));
  d.snap(x(833.0));
  const sum = d.w.summary(0x0a4d0329, 'Bob', d.now, true);
  assert.equal(sum, '[cheat] 10.77.3.41 "Bob", 6 s in free roam (left): 1 run over 450 km/h for 5 s (at most 600 km/h)');
});

test('a fast clock is told', () => {
  const d = new Drive();
  d.snap(x(0.0));
  const clocks = [];
  for (let i = 1; i <= 290; i++) {
    const c = d.at(500.0, 1500.0, x(i * 50.0))[1];
    if (c !== null) clocks.push([i, c]);
  }
  assert.deepEqual(clocks.map((c) => c[0]), [120, 180, 240], JSON.stringify(clocks));
  assert.ok(clocks.every(([, c]) => c.kind === 'clock' && Math.abs(c.rate - 3.0) < 0.2), JSON.stringify(clocks));
  assert.ok(clocks[0][1].kind === 'clock' && clocks[0][1].ms === 60_000.0, 'the two counts of 30 s: ' + JSON.stringify(clocks[0]));
});

test('a connection that catches up is no fast clock', () => {
  const d = new Drive();
  d.now = 12_000.0;
  d.w.snap(d.now, x(0.0), d.tUs, 0, false);
  for (let i = 1; i <= 20; i++) d.at(500.0, 500.0, x(i * 50.0));
  // the backlog at once, then all in time
  for (let i = 21; i <= 44; i++) d.at(1.0, 500.0, x(i * 50.0));
  const clocks = [];
  let lookedFast = false;
  for (let i = 45; i < 400; i++) {
    const c = d.snap(x(i * 50.0))[1];
    if (c !== null) clocks.push(c);
    lookedFast ||= d.w.clockPrev !== null;
  }
  assert.ok(lookedFast, 'a count looked fast');
  assert.deepEqual(clocks, []);
  assert.equal(d.w.jumps, 0);
});

test('a stall is no teleport', () => {
  const d = new Drive();
  d.snap(x(0.0));
  d.at(6500.0, 500.0, x(52.5));
  assert.deepEqual(d.at(1.0, 6000.0, x(682.5)), [null, null]);
  assert.deepEqual(d.drive(682.5, 2000.0, 105.0), []);
  assert.equal(d.w.jumps, 0);
});

test('a late start is no fast clock', () => {
  const d = new Drive();
  d.now = 12_000.0;
  d.w.snap(d.now, x(0.0), d.tUs, 0, false);
  for (let i = 1; i <= 24; i++) d.at(1.0, 500.0, x(i * 50.0));
  d.at(476.0, 500.0, x(25.0 * 50.0));
  const clocks = [];
  for (let i = 26; i < 300; i++) {
    const c = d.snap(x(i * 50.0))[1];
    if (c !== null) clocks.push(c);
  }
  assert.deepEqual(clocks, []);
  assert.equal(d.w.jumps, 0);
});

test('a backlog that drains is no fast clock', () => {
  const d = new Drive();
  d.snap(x(0.0));
  let at = 0.0;
  const go = (n, ms, own) => {
    const seen = [];
    for (let k = 0; k < n; k++) {
      at += 50.0;
      seen.push(...flat(d.at(ms, own, x(at))));
    }
    return seen;
  };
  assert.deepEqual(go(600, 500.0, 500.0), []);
  assert.deepEqual(go(240, 750.0, 500.0), [], 'falling behind');
  assert.deepEqual(go(240, 250.0, 500.0), [], 'catching up');
  assert.deepEqual(go(600, 500.0, 500.0), []);
  const hack = go(240, 500.0, 700.0);
  assert.ok(hack.length > 0 && hack[0].kind === 'clock' && hack[0].ms === 60_000.0 && Math.abs(hack[0].rate - 1.4) < 0.01, JSON.stringify(hack));
});

test('lines are few', () => {
  const w = new Watch(0.0);
  const got = [];
  for (let k = 0; k < 7; k++) got.push(w.line(0.0));
  assert.deepEqual(got, [false, false, false, false, true, null, null]);
  assert.equal(w.line(120_000.0), true);
  w.jumps = 9;
  assert.equal(w.summary(1, 'Bob', 500_000.0, false), null, 'not 10 min yet');
  assert.ok(w.summary(1, 'Bob', 600_000.0, false).endsWith('(so far): 9 teleports'));
  assert.equal(w.summary(1, 'Bob', 1_300_000.0, false), null, 'all told since');
});

test('a second player put beside its first is no teleport', () => {
  const d = new Drive();
  d.snap(x(0.0));
  d.now += 500.0;
  d.tUs = (d.tUs + 500_000) >>> 0;
  assert.deepEqual(d.w.snap(d.now, x(2000.0), d.tUs, d.clock, true), [null, null]);
  assert.deepEqual([d.w.jumps, d.w.runs, d.w.over], [0, 0, 0.0]);
  assert.deepEqual(d.drive(2000.0, 4000.0, 100.0), []);
  const [jump] = d.snap(x(6000.0));
  assert.equal(jump?.kind, 'jump', 'not beside it: ' + JSON.stringify(jump));
  // put beside it, then on at 600 km/h: a run, told as ever
  const told = [];
  for (let i = 1; i <= 10; i++) {
    d.now += 500.0;
    d.tUs = (d.tUs + 500_000) >>> 0;
    told.push(...flat(d.w.snap(d.now, x(6000.0 + i * 83.3), d.tUs, d.clock, i === 1)));
  }
  assert.ok(told.length === 1 && told[0].kind === 'fast', JSON.stringify(told));
});
