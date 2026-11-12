// A port of web/server-rs/crates/roam/tests/roam_ahead.rs: what the hub does that the Node server's hub never did:
// links that look ahead at the cars' speeds, and the world map's answer (MAPREQ / MAPD).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kit, ways, helloWith, hello, snap, snapN, snapMoving, mapreqBase, mapreqFlags, mapdOf, bye, framePorts, fnv1a } from './kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
/** the repository's root (the Rust's CARGO_MANIFEST_DIR/../../../..) */
const REPO = join(here, '../../../..');

/** browser i's address, for more players than V's: 10.77.0.2 and on */
function W(i) {
  return (0x0a4d0002 + i) >>> 0;
}

/** a player of core version 4 (32 links) in room 0 */
function join_(k, i) {
  k.from(W(i), helloWith(100 + i, { core: 4 }));
}

function vipsOf(l, i) {
  return l.get(W(i) + ':47210').map((e) => e.vip);
}

// a car heading for a player far ahead is linked to it before the parked ones beside it, and the one it drives away
// from gives way first; parked, the nearest ones
test('links look ahead at the cars speeds', () => {
  for (const [how, o] of ways()) {
    for (const moving of [false, true]) {
      const k = new Kit({ ...o, degree: 2 });
      for (let i = 0; i < 4; i++) join_(k, i);
      // 0 at 50 m/s along x, 1 parked 200 m ahead of it (where 0 is in 4 s), 2 parked 40 m behind it (90 m in a
      // second), 3 parked 45 m beside it (67 m in a second)
      const v = moving ? 50.0 : 0.0;
      k.from(W(0), snapMoving(100, [0.0, 0.0, 0.0], [v, 0.0, 0.0], 0.0, 2));
      k.from(W(1), snap(101, [200.0, 0.0, 0.0]));
      k.from(W(2), snap(102, [-40.0, 0.0, 0.0]));
      k.from(W(3), snap(103, [0.0, -45.0, 0.0]));
      k.clear();
      k.hub.tick();
      const l = k.lists();
      const has = (i, j) => l.get(W(i) + ':47210').some((e) => e.vip === W(j));
      assert.equal(has(0, 1), moving, how + ', moving ' + moving + ': 0 and the player it heads for');
      assert.equal(has(0, 2), !moving, how + ', moving ' + moving + ': 0 and the one behind it');
      assert.ok(has(0, 3), how + ', moving ' + moving + ': 0 and the one beside it');
    }
  }
});

// a car in front of where a player's car points is linked from farther away (from its view point): 250 m in front
// before 120 m behind; turned around, the one behind it; without view points, the nearer one
test('links see farther in front', () => {
  for (const [how, o] of ways()) {
    for (const [heading, view, want] of [[0.0, true, 1], [Math.PI, true, 2], [0.0, false, 2]]) {
      const k = new Kit({ ...o, degree: 1, viewM: view ? 150.0 : o.viewM });
      for (let i = 0; i < 3; i++) join_(k, i);
      // 1 points on along x, 2 away from 0 (their view points far from 0)
      k.from(W(0), snapMoving(100, [0.0, 0.0, 0.0], [0, 0, 0], heading, 2));
      k.from(W(1), snapMoving(101, [250.0, 0.0, 0.0], [0, 0, 0], 0.0, 2));
      k.from(W(2), snapMoving(102, [-120.0, 0.0, 0.0], [0, 0, 0], Math.PI, 2));
      k.hub.tick();
      assert.deepEqual(vipsOf(k.lists(), 0), [W(want)], how + ': heading ' + heading + ', view ' + view);
    }
  }
});

// a player not in free roam (a shop) counts 100 m up: a car in free roam 80 m away comes before it at 10 m; paused in
// free roam it counts where it is
test('links go to the cars shown first', () => {
  for (const [how, o] of ways()) {
    for (const [status, want] of [[4, 2], [2, 1], [5, 1], [3, 2]]) {
      const k = new Kit({ ...o, degree: 1 });
      for (let i = 0; i < 3; i++) join_(k, i);
      k.from(W(0), snap(100, [0.0, 0.0, 0.0]));
      k.from(W(1), snapN(101, [10.0, 0.0, 0.0], status, 1));
      k.from(W(2), snap(102, [80.0, 0.0, 0.0]));
      k.hub.tick();
      assert.deepEqual(vipsOf(k.lists(), 0), [W(want)], how + ': status ' + status);
    }
  }
});

// a car's place is moved on by its SNAP's age (up to a second): heading for 0 at 50 m/s from 400 m, it is 150 m from
// 0 in 4 s once its SNAP is a second old (before a parked one 175 m away), 200 m when it is new; a paused game's speed
// moves nothing
test('links move a car on by its snaps age', () => {
  for (const [how, o] of ways()) {
    for (const [age, status, want] of [[0.0, 2, 2], [1000.0, 2, 1], [3000.0, 2, 1], [1000.0, 5, 2]]) {
      const k = new Kit({ ...o, degree: 1 });
      for (let i = 0; i < 3; i++) join_(k, i);
      k.from(W(0), snap(100, [0.0, 0.0, 0.0]));
      k.from(W(1), snapMoving(101, [400.0, 0.0, 0.0], [-50.0, 0.0, 0.0], Math.PI, status));
      k.from(W(2), snap(102, [0.0, 175.0, 0.0]));
      k.step(age);
      // (0 and 2 just sent theirs)
      k.from(W(0), snap(100, [0.0, 0.0, 0.0]));
      k.from(W(2), snap(102, [0.0, 175.0, 0.0]));
      k.hub.tick();
      assert.deepEqual(vipsOf(k.lists(), 0), [W(want)], how + ': a SNAP ' + age + ' ms old, status ' + status);
    }
  }
});

/** a small random number generator (the tests' own, the same every run: the Rust's u64 LCG) */
class Rng {
  constructor(seed) {
    this.s = BigInt(seed);
  }
  unit() {
    this.s = (this.s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(this.s >> 11n) / 2 ** 53;
  }
}

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// the grid's three walks (soon, ahead, and from the view points) give the links every pair sorted gives, tick after
// tick, with players driving about, parking, a few on one spot, some in a shop or paused, and links held and kept
test('the grid links as every pair with the cars moving', () => {
  const n = 400;
  const r = new Rng(11);
  const every = new Kit({ exactRoom: 1000 });
  const grid = new Kit({ exactRoom: 1 });
  const cars = [];
  for (let i = 0; i < n; i++) {
    const p = i % 20 === 0 ? [100.0, 100.0, 0.0] : [(r.unit() - 0.5) * 3000.0, (r.unit() - 0.5) * 3000.0, r.unit() * 10.0];
    const v = i % 3 === 0 ? [0, 0, 0] : [(r.unit() - 0.5) * 120.0, (r.unit() - 0.5) * 120.0, 0.0];
    cars.push([p, v]);
  }
  for (const k of [every, grid]) for (let i = 0; i < n; i++) join_(k, i);
  for (let tick = 0; tick < 12; tick++) {
    cars.forEach((c, i) => {
      const p = c[0];
      for (let a = 0; a < 2; a++) p[a] = clamp(p[a] + c[1][a], -19000.0, 19000.0);
      if (r.unit() < 0.1) c[1] = [(r.unit() - 0.5) * 120.0, (r.unit() - 0.5) * 120.0, 0.0];
      // some in a shop, some paused (their speeds move nothing, their view points none)
      const status = i % 7 === 0 ? 4 : i % 11 === 0 ? 5 : 2;
      const d = snapMoving(100 + i, p, c[1], r.unit() * 6.0, status);
      every.from(W(i), d);
      grid.from(W(i), d);
    });
    for (const k of [every, grid]) {
      k.clear();
      k.hub.tick();
      k.step(1000.0);
    }
    const a = every.lists(), b = grid.lists();
    assert.equal(a.size, n);
    for (const [key, l] of a) {
      const x = l.map((e) => e.vip).sort((p, q) => p - q);
      const y = b.get(key).map((e) => e.vip).sort((p, q) => p - q);
      assert.deepEqual(x, y, 'tick ' + tick + ', player ' + key);
    }
  }
});

/** the MAPD datagrams the hub sent since the last clear: [vip, mapd] */
function mapds(k) {
  const out = [];
  for (const [vip, f] of k.sent) {
    const m = mapdOf(f);
    if (m) out.push([vip, m]);
  }
  return out;
}

/** the entries of one MAPD answer, its parts in order (each checked to be of it): [req, base, total, entries] */
function mapdAnswer(k) {
  const m = mapds(k);
  assert.ok(m.length > 0, 'an answer');
  const [req, base, , n, total] = m[0][1];
  assert.ok(m.every(([, x], j) => x[0] === req && x[1] === base && x[2] === j && x[3] === n && x[4] === total), "one answer's parts");
  return [req, base, total, m.flatMap(([, x]) => x[5])];
}

// the world map: the players of the room in free roam, past the one asking and its links; not those in a race, another
// room or gone quiet (5 s); a player alone in its room gets one empty datagram, a stranger (no HELLO) nothing
test('the world map shows the room in free roam lately', () => {
  const k = new Kit({ degree: 1 });
  for (let i = 0; i < 10; i++) join_(k, i);
  k.from(W(10), helloWith(110, { room: fnv1a('blue') }));
  // player i at x = 10 i (rounded), heading a quarter turn (64)
  for (let i = 0; i <= 10; i++) {
    const status = i === 7 ? 3 : 2;
    k.from(W(i), snapMoving(100 + i, [i * 10.0 + 0.25, 3.75, 0.0], [0, 0, 0], Math.PI / 2, status));
  }
  k.hub.tick();
  k.clear();
  k.from(W(0), mapreqBase(100, 1, 2048, 0));
  // its link is 1 (the nearest), 7 races, 10 is in another room
  const want = [];
  for (let i = 2; i < 10; i++) if (i !== 7) want.push([i, [i * 10, 4, 64, 0, 0]]);
  assert.deepEqual(mapdAnswer(k), [1, 0, 7, want]);
  // a player alone in its room: one empty datagram; a stranger (no HELLO): nothing
  k.clear();
  k.from(W(10), mapreqBase(110, 1, 2048, 0));
  assert.deepEqual(mapds(k).map(([vip, x]) => [vip, x[0], x[1], x[2], x[3], x[4], x[5].length]), [[W(10), 1, 0, 0, 1, 0, 0]]);
  k.clear();
  k.from(W(20), mapreqBase(120, 1, 2048, 0));
  assert.equal(mapds(k).length, 0);
  // positions older than 5 s are not shown
  k.step(5100.0);
  k.from(W(1), snap(101, [10.0, 0.0, 0.0]));
  k.hub.tick();
  k.clear();
  k.from(W(0), mapreqBase(100, 2, 2048, 0));
  assert.equal(mapdAnswer(k)[2], 0, 'only its link 1 is fresh');
});

// a world map names each player it shows by a key of its own, not by its place on the hub (keys run to 16384, places
// past it): one that goes to a race gives its key back, behind the free ones, and gets the next free one when it is in
// free roam again (4 here: 0-3 are taken), so keys and places no longer go together; an answer lists its players by
// key (the game merges them in that order), and one from the answer the map holds says the old key went
test('the world map names a player by a key of its own', () => {
  const k = new Kit({ degree: 1 });
  for (let i = 0; i < 4; i++) {
    join_(k, i);
    k.from(W(i), snap(100 + i, [i * 100.0, 0.0, 0.0]));
  }
  const ask = (k, req, base) => {
    k.step(300.0);
    k.hub.tick();
    k.clear();
    k.from(W(3), mapreqBase(103, req, 2048, base));
    return mapdAnswer(k)[3].map(([key, e]) => [key, e ? e[0] : null]);
  };
  // 3 asks; 2 is its link (the nearest): the map shows 0 and 1, under keys 0 and 1
  assert.deepEqual(ask(k, 1, 0), [[0, 0], [1, 100]]);
  // 0 races (status 3), then is in free roam again further on: key 4, its place on the hub still the first
  k.from(W(0), snapN(100, [0.0, 0.0, 0.0], 3, 1));
  k.from(W(0), snap(100, [50.0, 0.0, 0.0]));
  assert.deepEqual(ask(k, 2, 1), [[0, null], [4, 50]], 'key 0 gone, 0 placed again under key 4');
  assert.deepEqual(ask(k, 3, 0), [[1, 100], [4, 50]], 'from nothing: by key');
});

// a map that asks for them (MAPREQ flags 1) learns who has stood at one spot for a minute (0x4000 in the key: a car
// meet counts those) and where everyone is, height and all (the GPS to a meet needs it); one placed again when it
// drives off; a map that does not ask never sees the mark
test('the world map tells who has stood a minute when asked', () => {
  const k = new Kit({ degree: 1 });
  for (let i = 0; i < 4; i++) join_(k, i);
  // 0 asks (1 beside it is its link); 2 stays within 25 m of one spot, 3 goes 3 m on every second
  const snaps = (k, t) => {
    k.from(W(0), snap(100, [0.0, 0.0, 0.0]));
    k.from(W(1), snap(101, [5.0, 0.0, 0.0]));
    k.from(W(2), snap(102, [500.0 + ((t / 1000.0) % 20.0), 0.0, 17.4]));
    k.from(W(3), snap(103, [800.0 + 3.0 * Math.floor(t / 1000.0), 0.0, 0.0]));
  };
  const ask = (k, req, base, flags) => {
    k.hub.tick();
    k.clear();
    k.from(W(0), flags !== 0 ? mapreqFlags(100, req, 2048, base, flags) : mapreqBase(100, req, 2048, base));
    return mapdAnswer(k)[3].map(([key]) => key);
  };
  snaps(k, 0.0);
  assert.deepEqual(ask(k, 1, 0, 1), [2, 3], 'nobody has stood a minute yet');
  let t = 0.0;
  while (t < 61000.0) {
    k.step(1000.0);
    t += 1000.0;
    snaps(k, t);
  }
  k.step(300.0);
  assert.deepEqual(ask(k, 2, 0, 1), [2 | 0x4000, 3], '2 has stood a minute, 3 kept going');
  const f = k.sent.find(([, f]) => mapdOf(f) !== null)[1];
  const d = f.subarray(16);
  assert.equal((d[14] | (d[15] << 8)) & 0x0800, 0x0800, 'heights with the answer');
  const z = d[25 + 9] | (d[25 + 10] << 8);
  assert.equal(z >= 0x8000 ? z - 0x10000 : z, 17, "2's height, whole metres");
  // 2 drives off: placed again from the answer the map holds, no longer marked
  k.step(300.0);
  k.from(W(2), snap(102, [600.0, 0.0, 0.0]));
  assert.deepEqual(ask(k, 3, 2, 1), [2], '2 placed again, unmarked');
  k.step(300.0);
  assert.deepEqual(ask(k, 4, 0, 0), [2, 3], 'not asked: no marks');
});

// one answer a quarter second for a browser, whatever its endpoints: a BYE and a HELLO, or another port, make a new
// player, not a new answer (the second security audit: that way a few clients kept the hub's thread busy with maps)
test('the world map answers a browser once a quarter second whatever its endpoints', () => {
  const k = new Kit();
  for (let i = 0; i < 20; i++) {
    join_(k, i);
    k.from(W(i), snap(100 + i, [i * 10.0, 0.0, 0.0]));
  }
  k.hub.tick();
  k.clear();
  k.from(W(0), mapreqBase(100, 1, 2048, 0));
  assert.equal(mapds(k).length, 1);
  // again as a new player on the same endpoint, then on other ports: nothing within the quarter second
  k.clear();
  k.from(W(0), bye(100));
  join_(k, 0);
  k.from(W(0), mapreqBase(100, 2, 2048, 0));
  for (const port of [47211, 47212]) {
    k.hub.frame(W(0), framePorts(W(0), hello(100), port, 47210));
    k.hub.frame(W(0), framePorts(W(0), mapreqBase(100, 3, 2048, 0), port, 47210));
  }
  assert.equal(mapds(k).length, 0, 'one answer a quarter second for the browser');
  // another browser is not held back by it; and past the quarter second (and a tick, which forgets old answers) it
  // asks again
  k.from(W(1), mapreqBase(101, 1, 2048, 0));
  assert.equal(mapds(k).length, 1);
  k.clear();
  k.step(250.0);
  k.hub.tick();
  k.clear();
  k.from(W(0), mapreqBase(100, 4, 2048, 0));
  assert.equal(mapds(k).length, 1);
});

// a page since MAPD gets what changed since the answer it holds: everyone at first (by slot, with their velocities),
// then only the players come, gone, or off where the page moved them on at their velocities; from nothing again when
// the hub has no such answer; one answer a quarter second
test('the world map sends what changed', () => {
  const k = new Kit({ degree: 1 });
  for (let i = 0; i < 8; i++) join_(k, i);
  // 0 asks; 1 its link; 2, 3 stand; 4 drives east at 20 m/s, 5 north at 10; 6 drives east, then turns; 7 is to go
  const at = (i, t) => {
    if (i === 4) return [[400.0 + 20.0 * t, 0.0, 0.0], [20.0, 0.0, 0.0]];
    if (i === 5) return [[500.0, 10.0 * t, 0.0], [0.0, 10.0, 0.0]];
    if (i === 6 && t > 0.0) return [[600.0 + 20.0 * t, 15.0, 0.0], [20.0, 0.0, 0.0]];
    if (i === 6) return [[600.0, 0.0, 0.0], [20.0, 0.0, 0.0]];
    return [[i * 100.0, 0.0, 0.0], [0, 0, 0]];
  };
  const snaps = (k, t) => {
    for (let i = 0; i < 8; i++) {
      const [p, v] = at(i, t);
      k.from(W(i), snapMoving(100 + i, p, v, 0.0, 2));
    }
  };
  snaps(k, 0.0);
  k.hub.tick();
  k.clear();
  k.from(W(0), mapreqBase(100, 1, 2048, 0));
  const first = mapdAnswer(k);
  assert.deepEqual(
    first,
    [1, 0, 6, [[2, [200, 0, 0, 0, 0]], [3, [300, 0, 0, 0, 0]], [4, [400, 0, 0, 20, 0]], [5, [500, 0, 0, 0, 10]], [6, [600, 0, 0, 20, 0]], [7, [700, 0, 0, 0, 0]]]],
    'everyone past itself and its link, by slot',
  );
  // a quarter second on: 4 and 5 where the page has them, 6 turned off 15 m, 7 gone, 8 come
  k.step(250.0);
  k.from(W(7), bye(107));
  join_(k, 8);
  snaps(k, 0.25);
  k.from(W(8), snap(108, [-50.0, 0.0, 0.0]));
  k.hub.tick();
  k.clear();
  k.step(100.0);
  k.from(W(0), mapreqBase(100, 2, 2048, 1));
  // (6 where it is at the question, 100 ms after its SNAP)
  assert.deepEqual(mapdAnswer(k), [2, 1, 6, [[6, [607, 15, 0, 20, 0]], [7, null], [8, [-50, 0, 0, 0, 0]]]]);
  // within the quarter second: nothing
  k.clear();
  k.step(100.0);
  k.from(W(0), mapreqBase(100, 3, 2048, 2));
  assert.equal(mapds(k).length, 0, 'one answer a quarter second');
  // the page did not take answer 2: it asks from 1 again and gets the same
  k.clear();
  k.step(200.0);
  k.from(W(0), mapreqBase(100, 4, 2048, 1));
  const again = mapdAnswer(k);
  assert.deepEqual([again[1], again[3].map((e) => e[0])], [1, [6, 7, 8]]);
  // an answer the hub does not have: from nothing
  k.clear();
  k.step(300.0);
  k.from(W(0), mapreqBase(100, 5, 2048, 77));
  const full = mapdAnswer(k);
  assert.deepEqual([full[0], full[1], full[3].length], [5, 0, 6]);
  // from that one on: what changed since it
  k.clear();
  k.step(300.0);
  k.from(W(0), mapreqBase(100, 6, 2048, 5));
  assert.equal(mapdAnswer(k)[1], 5);
  // a page that asks for fewer gets the nearest, and the others go
  k.clear();
  k.step(300.0);
  k.from(W(0), mapreqBase(100, 7, 2, 6));
  const few = mapdAnswer(k);
  assert.deepEqual([few[1], few[2]], [6, 6]);
  assert.equal(few[3].filter((e) => e[1] !== null).length, 0, JSON.stringify(few));
  assert.deepEqual(few[3].filter((e) => e[1] === null).map((e) => e[0]), [3, 4, 5, 6], 'the nearest, 8 and 2, stay');
});

// a car going straight is placed once: its SNAPs come twice a second, the questions four times, each SNAP's
// position as old as it is when asked (moved on at its velocity, it is where the page has the marker); one turning
// is placed again
test('the world map places a car going straight once', () => {
  const k = new Kit({ degree: 1 });
  for (let i = 0; i < 4; i++) join_(k, i);
  k.from(W(0), snap(100, [0.0, 0.0, 0.0]));
  k.from(W(1), snap(101, [5.0, 0.0, 0.0]));
  const placed = [];
  let base = 0;
  for (let step = 0; step < 40; step++) {
    const t = step * 0.125;
    // 2 straight east at 40 m/s, 3 north at 30 m/s until 2 s, then east; a SNAP each half second, 3's a quarter after 2's
    if (step % 4 === 1) k.from(W(2), snapMoving(102, [100.0 + 40.0 * t, 0.0, 0.0], [40.0, 0.0, 0.0], 0.0, 2));
    if (step % 4 === 3) {
      const [p, v] = t < 2.0 ? [[0.0, 100.0 + 30.0 * t, 0.0], [0.0, 30.0, 0.0]] : [[30.0 * (t - 2.0), 160.0, 0.0], [30.0, 0.0, 0.0]];
      k.from(W(3), snapMoving(103, p, v, 0.0, 2));
    }
    if (step % 2 === 0) {
      k.hub.tick();
      k.clear();
      k.from(W(0), mapreqBase(100, step + 1, 2048, base));
      const a = mapdAnswer(k);
      base = a[0];
      for (const e of a[3]) if (e[0] >= 2) placed.push([step, e[0]]);
    }
    k.step(125.0);
  }
  assert.equal(placed.filter((p) => p[1] === 2).length, 1, JSON.stringify(placed));
  const turned = placed.filter((p) => p[1] === 3).map((p) => p[0]);
  assert.ok(turned.length === 2 && turned[0] <= 4 && turned[1] >= 16 && turned[1] <= 22, JSON.stringify(placed));
});

const increasing = (keys) => keys.every((x, i) => i === 0 || keys[i - 1] < x);

// MAPD from nothing for 2048 of 2200: 16 full datagrams
test('the world map sends 2048 in 16 mapd datagrams', () => {
  const k = new Kit({ degree: 1 });
  for (let i = 0; i < 2200; i++) {
    join_(k, i);
    k.from(W(i), snap(100 + i, [i * 5.0, 0.0, 0.0]));
  }
  k.hub.tick();
  k.clear();
  k.from(W(0), mapreqBase(100, 1, 2048, 0));
  const m = mapds(k);
  assert.equal(m.length, 16);
  assert.ok(m.every(([, x]) => x[5].length === 128));
  const [, , total, all] = mapdAnswer(k);
  assert.deepEqual([total, all.length], [2198, 2048]);
  const keys = all.map((e) => e[0]);
  assert.ok(increasing(keys) && keys[0] <= 2 && keys[2047] <= 2050, 'the nearest, by slot');
  // a quarter second on, nobody moved: one empty datagram
  k.clear();
  k.step(300.0);
  k.from(W(0), mapreqBase(100, 2, 2048, 1));
  assert.deepEqual(mapds(k).map(([, x]) => [x[0], x[1], x[2], x[3], x[5].length]), [[2, 1, 0, 1, 0]]);
});

// MAPD from nothing, with heights (flags 1), for 4096 of 4300: 40 datagrams to a page that takes more than 16 (flags
// 2); a page before it (no flag 2) gets 16 of 104, as before, however many it asks for
test('the world map sends 4096 in 40 mapd datagrams to a page that takes them', () => {
  const k = new Kit({ degree: 1 });
  for (let i = 0; i < 4300; i++) {
    join_(k, i);
    k.from(W(i), snap(100 + i, [i * 3.0, 0.0, 0.0]));
  }
  k.hub.tick();
  k.clear();
  k.from(W(0), mapreqFlags(100, 1, 4096, 0, 3));
  let m = mapds(k);
  assert.equal(m.length, 40);
  assert.ok(m.slice(0, 39).every(([, x]) => x[5].length === 104) && m[39][1][5].length === 40, 'full datagrams, the rest last');
  const [, , total, all] = mapdAnswer(k);
  assert.deepEqual([total, all.length], [4298, 4096]);
  const keys = all.map((e) => e[0]);
  assert.ok(increasing(keys) && keys[0] <= 2 && keys[4095] <= 4098, 'the nearest, by slot');
  // a quarter second on, nobody moved: one empty datagram
  k.clear();
  k.step(300.0);
  k.from(W(0), mapreqFlags(100, 2, 4096, 1, 3));
  assert.deepEqual(mapds(k).map(([, x]) => [x[0], x[1], x[2], x[3], x[5].length]), [[2, 1, 0, 1, 0]]);
  // a page before: 16 datagrams at most
  k.clear();
  k.step(300.0);
  k.from(W(1), mapreqFlags(101, 1, 4096, 0, 1));
  m = mapds(k);
  assert.ok(m.length === 16 && m.every(([, x]) => x[5].length === 104), String(m.length));
});

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from({ length: Math.floor(h.length / 2) }, (_, i) => parseInt(h.slice(2 * i, 2 * i + 2), 16));
const u16 = (a, o) => a[o] | (a[o + 1] << 8);

// roam_core asks as the hub reads it, and takes the hub's answer in parts, in any order (as the Rust: skipped without
// a wasi-sdk in deps/, which builds runtime/roam_core.c with web/test/roam_hubwire.c to wasm)
test('the world map on the wire roam core asks and takes the answer', (t) => {
  const deps = join(REPO, 'deps');
  let wasi = null;
  try {
    const v = readdirSync(deps).filter((n) => n.startsWith('wasi-sdk-')).sort();
    if (v.length > 0) wasi = join(deps, v[v.length - 1]);
  } catch {
    wasi = null;
  }
  if (wasi === null) {
    t.skip('no wasi-sdk in deps/: skipped');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'roam-hubwire-'));
  try {
    const w = join(dir, 'roam_hubwire_map.wasm');
    const out = spawnSync(
      join(wasi, 'bin/clang'),
      ['--target=wasm32-wasip1-threads', '-pthread', '-O2', '-ffp-contract=off', '-Iruntime', '-o', w, 'web/test/roam_hubwire.c', 'runtime/roam_core.c',
        '-Wl,--import-memory,--export-memory,--shared-memory,--initial-memory=67108864,--max-memory=268435456'],
      { cwd: REPO, encoding: 'utf8' },
    );
    assert.equal(out.status, 0, 'clang: ' + out.stderr);
    const run = (args) => {
      const o = spawnSync(process.execPath, [join(REPO, 'web/test/wasi-run.mjs'), w, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
      return (o.stdout || '').trim();
    };
    // the hub's answer to 300 players (three parts), the last first: the session asks with req 1, from nothing
    let k = new Kit({ degree: 1 });
    for (let i = 0; i < 301; i++) {
      join_(k, i);
      k.from(W(i), snapMoving(100 + i, [i * -3.0, 7.0, 0.0], [0.0, -(i % 9.0), 0.0], -Math.PI / 2, 2));
    }
    k.hub.tick();
    k.clear();
    k.from(W(0), mapreqBase(100, 1, 2048, 0));
    const first = k.sent.map(([, f]) => hex(f.subarray(16)));
    assert.equal(first.length, 3);
    first.reverse();
    let got = run(['map', ...first]);
    let lines = got.split('\n');
    const ask = lines[0] || '';
    assert.equal(ask.startsWith('ask ') ? ask.length - 4 : null, 2 * (16 + 6 + 4), got);
    // its MAPREQ, as the hub reads it: req 1, 4096 at most, from nothing
    let a = unhex(ask.slice(4));
    assert.deepEqual([a[5], u16(a, 16), u16(a, 18), u16(a, 20)], [10, 1, 4096, 0]);
    const entry = (i, x, vy) => i + ':' + Math.trunc(x) + ',7,192,0,' + vy;
    let want = [];
    for (let i = 2; i < 301; i++) want.push(entry(i, -3.0 * i, -(i % 9)));
    assert.equal(lines[1] || '', 'map 1 299 299 ' + want.join(' '));
    // one part only: nothing yet
    got = run(['map', first[0]]);
    assert.ok(got.endsWith('map 0 0 0'), got);
    // it asks again from answer 1 (req 2): 5 went, 6 moved off; the rest where it moved them on
    k.step(300.0);
    k.from(W(5), bye(105));
    k.from(W(6), snapMoving(106, [-18.0, 40.0, 0.0], [0, 0, 0], -Math.PI / 2, 2));
    k.hub.tick();
    k.clear();
    k.from(W(0), mapreqBase(100, 2, 2048, 1));
    const second = k.sent.filter(([, f]) => f[16 + 5] === 17).map(([, f]) => hex(f.subarray(16)));
    assert.equal(second.length, 1);
    assert.deepEqual(mapdAnswer(k), [2, 1, 298, [[5, null], [6, [-18, 40, 192, 0, 0]]]]);
    got = run(['map', ...first, 'ask', ...second]);
    lines = got.split('\n');
    const l1 = lines[1] || '';
    const ask2 = unhex(l1.startsWith('ask ') ? l1.slice(4) : '');
    assert.deepEqual([u16(ask2, 16), u16(ask2, 20)], [2, 1], 'it asks from answer 1');
    want = [];
    for (let i = 2; i < 301; i++) if (i !== 5) want.push(i === 6 ? '6:-18,40,192,0,0' : entry(i, -3.0 * i, -(i % 9)));
    assert.equal(lines[2] || '', 'map 2 298 298 ' + want.join(' '));
    // the game's question (who is parked, heights, wide: flags 3) for 4096 of 4300, as the hub reads it; its 40
    // datagrams taken in any order (the last first, the halves swapped): 4096 held
    k = new Kit({ degree: 1 });
    for (let i = 0; i < 4301; i++) {
      join_(k, i);
      k.from(W(i), snap(100 + i, [i * 3.0, 0.0, 0.0]));
    }
    k.hub.tick();
    const ask3 = run(['mapwide']);
    const l0 = ask3.split('\n')[0] || '';
    a = unhex(l0.startsWith('ask ') ? l0.slice(4) : '');
    assert.equal(a.length, 16 + 8 + 4, ask3);
    assert.deepEqual([u16(a, 18), u16(a, 22)], [4096, 3]);
    k.clear();
    k.from(W(0), mapreqFlags(100, 1, 4096, 0, 3));
    let parts = k.sent.map(([, f]) => hex(f.subarray(16)));
    assert.equal(parts.length, 40);
    parts.reverse();
    parts = [...parts.slice(20), ...parts.slice(0, 20)];
    got = run(['mapwide', ...parts]);
    const held = got.split('\n')[1] || '';
    assert.ok(held.startsWith('map 1 4299 4096 ') && held.split(' ').length === 4 + 4096, held.slice(0, 80));
    // one part short: nothing yet
    got = run(['mapwide', ...parts.slice(1)]);
    assert.ok(got.endsWith('map 0 0 0'), got);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

