// A port of web/server-rs/crates/roam/tests/roam_levels.rs: roads above roads: a gap in height that no road explains
// (a highway over a street) weighs more than it is (RoamOptions level_*), so a player's links go to the cars on its
// own road first.  What weighs as before: two cars on one road up a hill, a car over a bump, a player in a shop, and
// anyone at all while there is room.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kit, helloWith, snapMoving, snapN, snap, snapPose } from './kit.mjs';

const PI = Math.PI;

/** browser i's address */
function W(i) {
  return (0x0a4d0002 + i) >>> 0;
}

/** a player of core version 10 asking for links links, in room 0 */
function join(k, i, links) {
  k.from(W(i), helloWith(100 + i, { core: 10, links }));
}

/** the links of a room: every pair weighed, or the grid's nearest; with view points (kit's ways has none), as the server has them */
function both() {
  const o = {};
  return [['every pair', { ...o }], ['the grid', { ...o, exactRoom: 1 }]];
}

/** the rule turned off (an option that is not a positive number keeps its default: 1e-9 m a metre is none) */
function flat(o) {
  return { ...o, levelK: 1e-9 };
}

/** player i's links, sorted */
function linksOf(k, i) {
  const l = k.lists().get(W(i) + ':47210');
  assert.ok(l !== undefined, 'player ' + i + ' has a list');
  return l.map((e) => e.vip - W(0)).sort((a, b) => a - b);
}

/**
 * one tick of a hub that has the players' HELLOs and SNAPs in free roam (place, velocity, heading); player 0's links
 * (it asks for links, the others for 48: their room is not what decides)
 */
function tickWith(o, links, snaps) {
  const k = new Kit(o);
  snaps.forEach(([p, v, h], i) => {
    join(k, i, i === 0 ? links : 48);
    k.from(W(i), snapMoving(100 + i, p, v, h, 2));
  });
  k.clear();
  k.hub.tick();
  return linksOf(k, 0);
}

const Z = () => [0.0, 0.0, 0.0];
const s = (x) => JSON.stringify(x);

// Player 0 drives along a highway 10 m over a street, at 30 m/s; four cars drive the street under it with it, four
// drive the highway 60 to 200 m off.  With 4 links it gets the four on the highway (as it always did the four under
// it), with 8 all eight: the ones under it wait for room, they are not left out.
test('on a highway the cars on it come before the street under it', () => {
  const [up, run, back] = [10.0, [30.0, 0.0, 0.0], [-30.0, 0.0, 0.0]];
  const snaps = [
    [[0.0, 0.0, up], run, 0.0],
    [[5.0, 3.0, 0.0], run, 0.0],
    [[-8.0, -4.0, 0.0], run, 0.0],
    [[12.0, 2.0, 0.0], run, 0.0],
    [[-3.0, -2.0, 0.0], run, 0.0],
    [[60.0, 3.0, up], run, 0.0],
    [[85.0, -3.0, up], run, 0.0],
    [[110.0, 3.0, up], back, PI],
    [[200.0, -3.0, up], run, 0.0],
  ];
  for (const [how, o] of both()) {
    assert.deepStrictEqual(tickWith({ ...o }, 4, snaps), [5, 6, 7, 8], how + ": the highway's");
    assert.deepStrictEqual(tickWith(flat(o), 4, snaps), [1, 2, 3, 4], how + ", as before: the street's");
    assert.deepStrictEqual(tickWith({ ...o }, 8, snaps), [1, 2, 3, 4, 5, 6, 7, 8], how + ': room for all');
  }
});

// Under a highway meet, the street's own: a street car's links go to the cars on the street 40 to 100 m off before the
// two parked straight over it; a highway car 50 m to the side (in sight) weighs as it is.
test('under a highway the street comes first', () => {
  const snaps = [
    [[0.0, 0.0, 0.0], Z(), 0.0],
    [[3.0, 2.0, 12.0], Z(), 0.0],
    [[-6.0, -2.0, 12.0], Z(), PI],
    [[40.0, 0.0, 0.0], Z(), 0.0],
    [[0.0, -70.0, 0.0], Z(), 0.0],
    [[100.0, 10.0, 0.0], Z(), 0.0],
  ];
  for (const [how, o] of both()) {
    assert.deepStrictEqual(tickWith({ ...o }, 3, snaps), [3, 4, 5], how + ": the street's");
    assert.deepStrictEqual(tickWith(flat(o), 3, snaps), [1, 2, 3], how + ', as before');
  }
  const side = [[[0.0, 0.0, 0.0], Z(), 0.0], [[0.0, 50.0, 12.0], Z(), 0.0], [[60.0, 0.0, 0.0], Z(), 0.0]];
  for (const [how, o] of both()) assert.deepStrictEqual(tickWith(o, 1, side), [1], how + ': in sight');
});

// Two cars on one road up a hill weigh as before (a road at 25 % for 60 m, at 20 % for 100 and 200 m), and so does a
// car 5 m up over a bump beside player 0, or 7 m up 10 m off: each comes before a car on flat ground a little farther
// off.  (Player 0 points along x: its view point is far from all of them.)
test('up a hill and over a bump as before', () => {
  for (const [near, far] of [
    [[0.0, 60.0, 15.0], [0.0, -64.0, 0.0]],
    [[0.0, 100.0, 20.0], [0.0, -105.0, 0.0]],
    [[0.0, 200.0, 40.0], [0.0, -206.0, 0.0]],
    [[0.0, 3.0, 5.0], [0.0, -7.0, 0.0]],
    [[0.0, 10.0, 7.0], [0.0, -13.0, 0.0]],
  ]) {
    const snaps = [[[0.0, 0.0, 0.0], Z(), 0.0], [near, Z(), 0.0], [far, Z(), 0.0]];
    for (const [how, o] of both()) {
      assert.deepStrictEqual(tickWith({ ...o }, 1, snaps), [1], how + ': ' + s(near) + ' before ' + s(far));
      assert.deepStrictEqual(tickWith(flat(o), 1, snaps), [1], how + ', as before: ' + s(near) + ' before ' + s(far));
    }
  }
});

/**
 * one tick of a hub that has the players' HELLOs and SNAPs in free roam (place, velocity, heading, the nose's slope);
 * player 0's links (it asks for links, the others for 48)
 */
function tickPosed(o, links, snaps) {
  const k = new Kit(o);
  snaps.forEach(([p, v, h, slope], i) => {
    join(k, i, i === 0 ? links : 48);
    k.from(W(i), snapPose(100 + i, p, v, h, slope, 2));
  });
  k.clear();
  k.hub.tick();
  return linksOf(k, 0);
}

// Up a hill, a car in front counts from the view point as it always did: the view point is up the slope the car's
// nose is on.  Player 0 parked facing up a road at 15 %, car 1 parked 150 m on up it (22.5 m higher), car 2 100 m
// beside it on flat ground: car 1 first.  (Were the view point at player 0's own height, 22.5 m under car 1, car 1
// would weigh as on a road above, and car 2 would come first.)
test('up a hill the view point is up the slope', () => {
  for (const [slope, want] of [[0.15, 1], [0.0, 2]]) {
    const snaps = [
      [[0.0, 0.0, 0.0], Z(), 0.0, slope],
      [[150.0, 0.0, 22.5], Z(), 0.0, slope],
      [[0.0, -100.0, 0.0], Z(), -PI / 2.0, 0.0],
    ];
    for (const [how, o] of both()) {
      assert.deepStrictEqual(tickPosed({ ...o }, 1, snaps), [want], how + ': the nose ' + slope + ' up');
      assert.deepStrictEqual(tickPosed(flat(o), 1, snaps), [1], how + ', as before: the nose ' + slope + ' up');
    }
  }
});

// ...and so is the place 4 s ahead: player 0 drives up a road at 15 % at 25 m/s, car 1 parked 100 m on up it (15 m
// higher, facing down), car 2 parked 60 m beside: car 1 first, where player 0 will be in 4 s.
test('up a hill the place ahead is up the slope', () => {
  for (const [slope, want] of [[0.15, 1], [0.0, 2]]) {
    const snaps = [
      [[0.0, 0.0, 0.0], [25.0, 0.0, 3.75], 0.0, slope],
      [[100.0, 0.0, 15.0], Z(), PI, -slope],
      [[0.0, 60.0, 0.0], Z(), PI / 2.0, 0.0],
    ];
    for (const [how, o] of both()) {
      assert.deepStrictEqual(tickPosed({ ...o }, 1, snaps), [want], how + ': the nose ' + slope + ' up');
      assert.deepStrictEqual(tickPosed(flat(o), 1, snaps), [1], how + ', as before: the nose ' + slope + ' up');
    }
  }
});

// A car going up fast (a hop, a ramp) is where its SNAP had it, not moved on at its speed up (a second at 8 m/s would
// put it 11 m up, over a road above): 3 m up 5 m off, it comes before a car 20 m off.
test('a car going up is where it is', () => {
  const snaps = [[[0.0, 0.0, 0.0], Z(), 0.0], [[0.0, 5.0, 3.0], [0.0, 2.0, 8.0], 0.0], [[0.0, -20.0, 0.0], Z(), 0.0]];
  for (const [how, o] of both()) assert.deepStrictEqual(tickWith(o, 1, snaps), [1], how);
});

// a player in a shop still counts 100 m up, at least, under the highway or on it: a car in free roam 80 m off comes
// before it at 10 m
test('a player in a shop counts 100 m up', () => {
  for (const z of [0.0, 12.0]) {
    for (const [how, o] of both()) {
      const k = new Kit({ ...o, degree: 1 });
      for (let i = 0; i < 3; i++) join(k, i, 1);
      k.from(W(0), snap(100, [0.0, 0.0, 0.0]));
      k.from(W(1), snapN(101, [10.0, 0.0, z], 4, 1));
      k.from(W(2), snap(102, [80.0, 0.0, 0.0]));
      k.hub.tick();
      assert.deepStrictEqual(linksOf(k, 0), [2], how + ": the shop's player at " + z + ' m');
    }
  }
});

const M64 = (1n << 64n) - 1n;
/** a number of [0, 1) from i and t (the same every run) */
function hash(i, t) {
  const x = (((BigInt(i) << 32n) | BigInt(t)) * 0x9e3779b97f4a7c15n) & M64;
  const y = (((x ^ (x >> 29n)) * 0xbf58476d1ce4e5b9n) & M64) >> 11n;
  return Number(y) / 2 ** 53;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// The grid's three walks give the links every pair sorted gives, tick after tick, on roads above roads: a highway 12 m
// over a street, a crowd on each (one over the other), a hill at 20 %, cars hopping over bumps, players in a shop or
// paused, 16, 32 or 48 links each; and read on four threads, the same lists, byte for byte.  (The JS hub has no threads:
// linkThreads is taken and does nothing, so its lists on "four threads" are the one thread's; the assertion is kept.)
test('the grid links as every pair on roads above roads', () => {
  const n = 500;
  const ground = (x) => (x > 300.0 ? (x - 300.0) * 0.2 : 0.0);
  const start = [];
  for (let i = 0; i < n; i++) {
    const [x, y, a, b] = [(hash(i, 0) - 0.5) * 1600.0, (hash(i, 1) - 0.5) * 1600.0, hash(i, 2) - 0.5, hash(i, 3) - 0.5];
    switch (i % 5) {
      // the two crowds, one over the other
      case 0:
        start.push([[a * 60.0, b * 16.0, i % 2 === 0 ? 12.0 : 0.0], [0, 0, 0]]);
        break;
      // on the highway (y near 0), along x
      case 1:
        start.push([[x, b * 16.0, 12.0], [a < 0.0 ? 40.0 : -40.0, 0.0, 0.0]]);
        break;
      // on the streets, the hill's too
      default:
        start.push([[x, y, ground(x)], [a * 50.0, b * 50.0, 0.0]]);
    }
  }
  const run = (o) => {
    const k = new Kit(o);
    for (let i = 0; i < n; i++) join(k, i, [16, 32, 48][i % 3]);
    const cars = start.map(([p, v]) => [p.slice(), v.slice()]);
    const sent = [];
    for (let t = 0; t < 10; t++) {
      cars.forEach(([p, v], i) => {
        if (i % 5 >= 1) {
          p[0] = clamp(p[0] + v[0] * 0.5, -800.0, 800.0);
          p[1] = clamp(p[1] + v[1] * 0.5, -800.0, 800.0);
        }
        if (i % 5 >= 2) {
          // a hop over a bump now and then, up to 9 m
          p[2] = ground(p[0]) + (hash(i, 10 + t) < 0.1 ? hash(i, 100 + t) * 9.0 : 0.0);
        }
        const status = i % 13 === 0 ? 4 : i % 17 === 0 ? 5 : 2;
        k.from(W(i), snapMoving(100 + i, p, v, Math.atan2(v[1], v[0]), status));
      });
      k.clear();
      k.hub.tick();
      sent.push([k.lists(), k.sent.slice()]);
      k.step(500.0);
    }
    return sent;
  };
  const every = run({ exactRoom: 1000 });
  const grid = run({ exactRoom: 1, linkThreads: 1 });
  const grid4 = run({ exactRoom: 1, linkThreads: 4 });
  every.forEach(([a], t) => {
    const [b, sb] = grid[t];
    assert.strictEqual(a.size, n);
    for (const [key, l] of a) {
      const x = l.map((e) => e.vip).sort((p, q) => p - q);
      const bl = b.get(key);
      assert.ok(bl !== undefined, 'tick ' + t + ', player ' + key);
      const y = bl.map((e) => e.vip).sort((p, q) => p - q);
      assert.deepStrictEqual(x, y, 'tick ' + t + ', player ' + key);
    }
    assert.ok(
      sb.length === grid4[t][1].length && sb.every(([v, f], j) => v === grid4[t][1][j][0] && Buffer.compare(f, grid4[t][1][j][1]) === 0),
      'tick ' + t + ': on four threads, the same lists',
    );
  });
});
