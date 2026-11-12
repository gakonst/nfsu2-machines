// A port of web/server-rs/crates/roam/tests/roam_meets.rs: a car meet's links (hub.rs one_way, Gather::key): a player
// slower than near_fast gets the cars within near_m first, by where they are now, and one that came near stays
// near_hold_ms while it is; and the hints of a core of version 16 (lists): which of the players who only get a
// player's car are far off, and why the cars near it went.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kit, HF_CREW, crewMarks, helloWith, peersOf, snapMoving } from './kit.mjs';

function W(i) {
  return (0x0a4d0002 + i) >>> 0;
}

const TX = 0x40;

/** the last frame the hub sent to player i, or undefined */
function last(k, i) {
  for (let n = k.sent.length - 1; n >= 0; n--) if (k.sent[n][0] === W(i)) return k.sent[n][1];
  return undefined;
}

/** player i's last list: the vips it gets cars from (entries not marked TX) */
function gets(k, i) {
  const f = last(k, i);
  if (f === undefined) return [];
  const e = peersOf(f);
  const m = crewMarks(f);
  const marks = m ? m[1] : e.map(() => 0);
  return e.filter((_, n) => (marks[n] & TX) === 0).map((p) => p.vip);
}

/**
 * the hints at the end of player i's last list (after its marks): the far ones [vip, its byte] and the cars gone
 * [id, why]; null without
 */
function hints(k, i) {
  const f = last(k, i);
  if (f === undefined) return null;
  const e = peersOf(f);
  const d = f.subarray(16);
  if (((d[14] | (d[15] << 8)) & HF_CREW) === 0) return null;
  const n = e.length;
  const o0 = 17 + 10 * n;
  let o = o0 + 1 + 4 * d[o0] + n;
  const end = d.length - 4;
  if (o >= end) return null;
  const nf = d[o];
  const far = [];
  for (let q = 0; q < nf; q++) far.push([e[d[o + 1 + q] & 0x7f].vip, d[o + 1 + q]]);
  o += 1 + nf;
  const ng = d[o];
  const gone = [];
  for (let q = 0; q < ng; q++) {
    const b = o + 1 + 5 * q;
    gone.push([(d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24)) >>> 0, d[b + 4]]);
  }
  return [far, gone];
}

function join(k, i, core, links, p, v) {
  k.from(W(i), helloWith(100 + i, { core, links }));
  k.from(W(i), snapMoving(100 + i, p, v, 0.0, 2));
}

/** the players say where they are again (as every half second), then a tick */
function tick(k, at, ms) {
  k.step(ms);
  at.forEach(([p, v], i) => k.from(W(i), snapMoving(100 + i, p, v, 0.0, 2)));
  k.clear();
  k.hub.tick();
}

const hexs = (a) => '[' + a.map((x) => x.toString(16)).join(', ') + ']';

// A player parked at a meet who shows 2 cars, two parked 30 and 40 m off: a third that parks 10 m from it shows only
// once the two have shown 30 s (near_hold_ms), then in place of the farther one; before (near_m none), after 5 s
// (hold_ms)
test('a car near a parked player stays 30 s', () => {
  for (const near of [true, false]) {
    const o = { viewM: 1e-9, nearM: near ? 60.0 : 1e-9 };
    const k = new Kit(o);
    const at = [[[0.0, 0.0, 0.0], [0, 0, 0]], [[30.0, 0.0, 0.0], [0, 0, 0]], [[0.0, 40.0, 0.0], [0, 0, 0]], [[400.0, 0.0, 0.0], [0, 0, 0]]];
    at.forEach(([p, v], i) => join(k, i, 16, i === 0 ? 2 : 8, p, v));
    k.hub.tick();
    assert.deepStrictEqual(gets(k, 0), [W(1), W(2)], 'near ' + near + ': the two near ones');
    // the third drives in and parks 10 m off
    at[3][0] = [-10.0, 0.0, 0.0];
    let swapped = null;
    for (let t = 1; t <= 80; t++) {
      tick(k, at, 500.0);
      const g = gets(k, 0);
      if (g.includes(W(3)) && swapped === null) {
        swapped = t / 2.0;
        assert.ok(g.includes(W(1)) && !g.includes(W(2)), 'near ' + near + ': the farther one gives way (' + hexs(g) + ')');
      }
    }
    assert.ok(swapped !== null, 'the nearest shows in the end');
    const s = swapped;
    if (near) assert.ok(s >= 29.0 && s <= 31.0, 'near first: the swap after 30 s, not ' + s + ' s');
    else assert.ok(s <= 6.0, 'before: the swap after hold_ms, not ' + s + ' s');
  }
});

// ...and the hub tells the player why the car went (its hints: RC_GONE_ROOM), and counts it
test('a near car that goes is said why', () => {
  const o = { viewM: 1e-9, nearHoldMs: 1000.0, holdMs: 1000.0 };
  let k = new Kit(o);
  const at = [[[0.0, 0.0, 0.0], [0, 0, 0]], [[30.0, 0.0, 0.0], [0, 0, 0]], [[0.0, 40.0, 0.0], [0, 0, 0]], [[400.0, 0.0, 0.0], [0, 0, 0]]];
  at.forEach(([p, v], i) => join(k, i, 16, i === 0 ? 2 : 8, p, v));
  k.hub.tick();
  at[3][0] = [-10.0, 0.0, 0.0];
  let said = null;
  for (let n = 0; n < 10; n++) {
    tick(k, at, 500.0);
    const h = hints(k, 0);
    if (h !== null && h[1].length !== 0) {
      said = h[1];
      break;
    }
  }
  assert.deepStrictEqual(said, [[102, 1]], 'player 2 (id 102) went: our links were full of nearer ones (RC_GONE_ROOM)');
  assert.strictEqual(k.hub.info().nearGone[0], 1, 'counted: ' + JSON.stringify(k.hub.info().nearGone));
  // the line every 5 minutes
  for (let n = 0; n < 610; n++) tick(k, at, 500.0);
  assert.ok(
    k.lines.some((l) => l === '[roam] cars within 60 m of a player that went in the last 5 min: 1 (0.2 a minute): the player\'s links full 1'),
    JSON.stringify(k.lines),
  );
  // a core of version 15 gets no hints
  k = new Kit({ viewM: 1e-9, nearHoldMs: 1000.0, holdMs: 1000.0 });
  at.forEach(([p, v], i) => join(k, i, 15, i === 0 ? 2 : 8, p, v));
  for (let n = 0; n < 6; n++) {
    tick(k, at, 500.0);
    assert.ok(hints(k, 0) === null, 'no hints to a core of 15');
  }
});

// A driver at speed (near_fast and more) gets its cars as before: the near ones count as any other
test('a driver at speed gets its cars as before', () => {
  const lists = (near) => {
    const k = new Kit({ viewM: 1e-9, nearM: near });
    // the driver at 25 m/s along x, cars round it 20 to 200 m off, some parked, some driving
    const at = [[[0.0, 0.0, 0.0], [25.0, 0.0, 0.0]]];
    for (let i = 1; i < 40; i++) {
      const a = i * 2.4;
      const r = 20.0 + 5.0 * i;
      at.push([[r * Math.cos(a), r * Math.sin(a), 0.0], i % 3 === 0 ? [0.0, 12.0, 0.0] : [0, 0, 0]]);
    }
    at.forEach(([p, v], i) => join(k, i, 16, i === 0 ? 8 : 32, p, v));
    const out = [];
    for (let n = 0; n < 40; n++) {
      for (const [p, v] of at) {
        p[0] += v[0] * 0.5;
        p[1] += v[1] * 0.5;
      }
      tick(k, at, 500.0);
      out.push(gets(k, 0).sort((a, b) => a - b));
    }
    return out;
  };
  assert.deepStrictEqual(lists(60.0), lists(1e-9), "the driver's cars, near first or not");
});

// A player who only gets our car, far off: our list says so (every 4th past 300 m, every 10th past 1 km), so our core
// sends it that few; a near one is not named; a core of version 15 gets none of it
test('the ones far off who only get our car are hinted', () => {
  for (const core of [16, 15]) {
    const k = new Kit({ viewM: 1e-9 });
    // player 0 shows 1 car (the nearest, 3 at 200 m); 1 (500 m) and 2 (1500 m) show 64 and get its car
    const at = [[[0.0, 0.0, 0.0], [0, 0, 0]], [[500.0, 0.0, 0.0], [0, 0, 0]], [[0.0, 1500.0, 0.0], [0, 0, 0]], [[200.0, 0.0, 0.0], [0, 0, 0]]];
    at.forEach(([p, v], i) => join(k, i, core, i === 0 ? 1 : 64, p, v));
    k.hub.tick();
    tick(k, at, 500.0);
    assert.deepStrictEqual(gets(k, 0), [W(3)], 'core ' + core + ": it gets the nearest one's car only");
    const h = hints(k, 0);
    if (core === 15) {
      assert.ok(h === null, 'no hints to a core of 15: ' + JSON.stringify(h));
      continue;
    }
    assert.ok(h !== null, 'hints');
    const [far0, gone] = h;
    const far = far0.map(([v, b]) => [v, (b & 0x80) !== 0]).sort((a, b) => a[0] - b[0] || Number(a[1]) - Number(b[1]));
    assert.deepStrictEqual(far, [[W(1), false], [W(2), true]], 'far (500 m) and very far (1500 m); the one at 200 m gets every one');
    assert.ok(gone.length === 0);
    assert.deepStrictEqual(k.hub.info().txOnly, [0, 1, 1], JSON.stringify(k.hub.info().txOnly));
    // two that drive at each other count as near before they are (4 s on at their speeds)
    const at2 = [[[0.0, 0.0, 0.0], [30.0, 0.0, 0.0]], [[500.0, 0.0, 0.0], [-30.0, 0.0, 0.0]], at[2], at[3]];
    tick(k, at2, 500.0);
    const h2 = hints(k, 0);
    assert.ok(h2 !== null, 'hints');
    assert.ok(h2[0].every((e) => e[0] !== W(1)), 'closing in: near (' + JSON.stringify(h2[0]) + ')');
  }
});
