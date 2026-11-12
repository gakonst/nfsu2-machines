// A port of web/server-rs/crates/roam/tests/levels.rs: roads above roads, simulated: free roam's links from the hub and
// the cars the game shows for them, on a map with a highway 10 m over a street (a meet on each, one straight over the
// other), a hill of 45 m, and cars hopping over bumps (up to 8 m), with and without the hub's rule for gaps in height
// (RoamOptions level_*).  Not a test: the Rust's is #[ignore]d and run by hand,
//   web/server-rs/cargo.sh roam test --release -p nfsu2-roam --test levels -- --ignored --nocapture
// and so this one is skipped unless ROAM_LEVELS=1 (the --ignored run; LEVELS_WAYS picks the ways as in the Rust):
//   ROAM_LEVELS=1 node --test test/roam/levels.test.mjs
// In JS the Rust's sizes (900 to 1080 players, 150 s, 3 scenes of 6 ways each) take many minutes, so by default the
// scenes are a tenth of the players and 60 s (30 s measured); ROAM_FULL=1 runs the Rust's sizes.
//
// Each SNAP has the car's nose on the slope of the ground where it points.  The game is popin.rs's model (slots,
// handshake, load, the hub's grace, the game's own rank in x and y, as roam_game.c has it).  Measured for each kind of
// player (driving the highway, driving the streets, parked at the highway's meet, parked at the street's meet under
// it): of the cars in sight in front of a driver (within 250 m, 40 degrees) and of the ones around anyone (within
// 100 m), how many show, where a car on the other level within 60 m across is out of sight (the deck is in the way);
// how many of the cars shown are out of sight; cars in sight that show within 100 m (pop-ins) and that go while within
// 100 m (pop-outs), a minute a player; and the links made a second a player.

import { test } from 'node:test';

import { Kit, helloWith, snapPose } from './kit.mjs';
import { defaultOptions } from '../../src/roam/hub.js';

const FULL = process.env.ROAM_FULL === '1';

const M64 = (1n << 64n) - 1n;
class Lcg {
  constructor(seed) {
    this.s = BigInt(seed);
  }
  unit() {
    this.s = (this.s * 6364136223846793005n + 1442695040888963407n) & M64;
    return Number(this.s >> 11n) / 2 ** 53;
  }
}

/** the simulation's step (s) */
const STEP = 0.1;
/** from a list to a peer (s), from a slot to the car shown (s), roam_core.c T_HUB_GRACE (s) */
const HANDSHAKE = 0.4;
const LOAD = 1.0;
const GRACE = 2.5;
/** "in front": this near, and within 40 degrees of where the car drives; "around": this near */
const FRONT_M = 250.0;
const FRONT_COS = 0.766;
const NEAR_M = 100.0;
/** out of sight: on the other level, and within this across */
const HIDE_M = 60.0;
/** the map: x and y within HALF; the highway along y = 0, DECK m up, its lanes at y = +-5; streets every 100 m */
const HALF = 800.0;
const DECK = 10.0;
const BLOCK = 100.0;
const G = 9.81;

/** the ground's height: flat, but for a hill of 45 m around (450, 450) (up to 15 % steep) */
function ground(x, y) {
  return 45.0 * Math.exp(-((x - 450.0) ** 2 + (y - 450.0) ** 2) / (250.0 * 250.0));
}

const Kind = { Highway: 0, Street: 1, HighwayMeet: 2, StreetMeet: 3, Shop: 4 };
const KINDS = [['highway', Kind.Highway], ['streets', Kind.Street], ['highway meet', Kind.HighwayMeet], ['street meet', Kind.StreetMeet]];

const deck = (c) => c.kind === Kind.Highway || c.kind === Kind.HighwayMeet;
const drives = (c) => c.status === 2 && c.v[0] * c.v[0] + c.v[1] * c.v[1] > 100.0;

/** across (x and y) between two cars, and whether the one is out of the other's sight */
function across(a, b) {
  return Math.sqrt((a.p[0] - b.p[0]) ** 2 + (a.p[1] - b.p[1]) ** 2);
}
function hidden(a, b) {
  return deck(a) !== deck(b) && across(a, b) < HIDE_M;
}

/** the game's rank for its slots (roam_game.c PeerView.rank: x and y only) */
function rank(a, b) {
  const [dx, dy] = [b.p[0] - a.p[0], b.p[1] - a.p[1]];
  const [ux, uy] = [b.v[0] - a.v[0], b.v[1] - a.v[1]];
  const at = (t) => Math.sqrt((dx + ux * t) ** 2 + (dy + uy * t) ** 2);
  const [sx, sy] = [dx + ux - Math.cos(a.h) * 150.0, dy + uy - Math.sin(a.h) * 150.0];
  const view = a.status === 2 ? Math.sqrt(sx * sx + sy * sy) : Infinity;
  return Math.min(at(1.0), at(4.0), view);
}

const newTally = () => ({ front: 0, frontShown: 0, around: 0, aroundShown: 0, shown: 0, shownHidden: 0, pops: 0, outs: 0, hopOuts: 0, minutes: 0.0 });
const rpad = (s, w) => String(s).padEnd(w);
const lpad = (x, w, d) => x.toFixed(d).padStart(w);
const copyCar = (c) => ({ ...c, p: c.p.slice(), v: c.v.slice() });

function run(scene, way, o) {
  const r = new Lcg(1234);
  const opts = { ...defaultOptions(), ...o };
  const k = new Kit({ ...o, maxPlayers: 8192 });
  const vip = (i) => (0x0a4d0100 + i) >>> 0;
  const line = (r) => Math.round((r.unit() * 2.0 - 1.0) * (HALF / BLOCK - 1.0)) * BLOCK;
  const cars = [];
  const blank = () => ({ kind: Kind.Street, p: [0, 0, 0], v: [0, 0, 0], h: 0.0, axis: 0, dir: 1.0, speed: 0.0, hopAt: 0.0, hopV: 0.0, status: 2, nextSnap: 0.0 });
  for (let n = 0; n < scene.highway; n++) {
    const dir = r.unit() < 0.5 ? 1.0 : -1.0;
    const x = (r.unit() * 2.0 - 1.0) * (HALF - 30.0);
    cars.push({ ...blank(), kind: Kind.Highway, p: [x, 5.0 * dir, DECK], dir, speed: 30.0 + r.unit() * 20.0 });
  }
  for (let n = 0; n < scene.street; n++) {
    const axis = r.unit() < 0.5 ? 1 : 0;
    const p = [0, 0, 0];
    p[axis] = (r.unit() * 2.0 - 1.0) * HALF;
    p[1 - axis] = line(r);
    const dir = r.unit() < 0.5 ? 1.0 : -1.0;
    cars.push({ ...blank(), kind: Kind.Street, p, axis, dir, speed: 10.0 + r.unit() * 15.0 });
  }
  // the meets: one on the highway's deck, one on the street under it (when there is a highway), each 120 by 18 m
  for (const kind of [Kind.HighwayMeet, Kind.StreetMeet]) {
    if (kind === Kind.HighwayMeet && scene.highway === 0) continue;
    for (let n = 0; n < scene.meets; n++) {
      // (Rust evaluates the array's elements in order: x, y, then the height)
      const px = (r.unit() - 0.5) * 120.0;
      const py = (r.unit() - 0.5) * 18.0;
      const p = [px, py, kind === Kind.HighwayMeet ? DECK : 0.0];
      cars.push({ ...blank(), kind, p, h: r.unit() * 2 * Math.PI });
    }
  }
  for (let n = 0; n < scene.shops; n++) {
    const px = line(r);
    const p = [px, (r.unit() * 2.0 - 1.0) * HALF, 0.0];
    cars.push({ ...blank(), kind: Kind.Shop, p, status: 4 });
  }
  const n = cars.length;
  for (const c of cars) {
    c.nextSnap = r.unit() * 0.5;
    if (!deck(c)) c.p[2] += ground(c.p[0], c.p[1]);
  }
  for (let i = 0; i < n; i++) k.from(vip(i), helloWith(1000 + i, { core: 10, links: scene.links }));
  /** each player's game: Map peer index -> {listed, first, slot (null: none), shown} */
  const games = cars.map(() => new Map());
  const lastList = new Array(n).fill(-Infinity);
  const [warm, end] = FULL ? [30.0, 150.0] : [30.0, 60.0];
  const tally = KINDS.map(() => newTally());
  const classOf = (c) => {
    const i = KINDS.findIndex((e) => e[1] === c.kind);
    return i < 0 ? null : i;
  };
  let linksMade = 0;
  let [nextTick, t, stepNo] = [0.0, 0.0, 0];
  while (t < end) {
    for (const c of cars) {
      switch (c.kind) {
        case Kind.Highway:
          c.p[0] += c.dir * c.speed * STEP;
          if (Math.abs(c.p[0]) > HALF - 20.0) {
            c.dir = -c.dir;
            c.p[1] = 5.0 * c.dir;
          }
          c.v = [c.dir * c.speed, 0.0, 0.0];
          break;
        case Kind.Street: {
          const a = c.axis;
          const old = c.p[a];
          c.p[a] += c.dir * c.speed * STEP;
          // a crossing passed: on, or a turn
          const [b0, b1] = [Math.floor(old / BLOCK), Math.floor(c.p[a] / BLOCK)];
          if (b0 !== b1 && r.unit() < 0.5) {
            c.p[a] = Math.max(b0, b1) * BLOCK;
            c.axis = 1 - a;
            c.dir = r.unit() < 0.5 ? 1.0 : -1.0;
          }
          if (Math.abs(c.p[c.axis]) > HALF) {
            c.p[c.axis] = Math.sign(c.p[c.axis]) * HALF;
            c.dir = -c.dir;
          }
          const v = [0, 0, 0];
          v[c.axis] = c.dir * c.speed;
          // over a bump now and then: up to 8 m, most of them low
          if (c.hopV === 0.0 && r.unit() < STEP / 20.0) {
            const apex = 1.0 + 7.0 * r.unit() ** 2;
            c.hopV = Math.sqrt(2.0 * G * apex);
            c.hopAt = t;
          }
          let up = 0.0;
          if (c.hopV > 0.0) {
            const s = t - c.hopAt;
            up = c.hopV * s - (G / 2.0) * s * s;
            if (up < 0.0) [up, c.hopV] = [0.0, 0.0];
          }
          // its speed up or down: the hill's and the hop's
          const z = ground(c.p[0], c.p[1]) + up;
          v[2] = (z - c.p[2]) / STEP;
          c.p[2] = z;
          c.v = v;
          break;
        }
        default:
      }
      if (drives(c)) c.h = Math.atan2(c.v[1], c.v[0]);
    }
    cars.forEach((c, i) => {
      if (t >= c.nextSnap) {
        c.nextSnap += 0.5;
        // its nose: the ground's slope where it points (on the highway, flat)
        const slope = deck(c) ? 0.0 : ground(c.p[0] + Math.cos(c.h), c.p[1] + Math.sin(c.h)) - ground(c.p[0], c.p[1]);
        k.from(vip(i), snapPose(1000 + i, c.p, c.v, c.h, slope, c.status));
      }
    });
    if (t >= nextTick) {
      nextTick += opts.tickMs / 1000.0;
      k.clear();
      k.hub.tick();
      for (const [key, list] of k.lists()) {
        const me = Number(key.split(':')[0]) - vip(0);
        lastList[me] = t;
        for (const e of list) {
          const q = e.vip - vip(0);
          let p = games[me].get(q);
          if (p === undefined) {
            if (t >= warm) linksMade++;
            p = { listed: t, first: t, slot: null, shown: false };
            games[me].set(q, p);
          }
          p.listed = t;
        }
      }
    }
    // each game: peers gone, slots (popin.rs's way: a peer the hub left out gives its slot to one it lists, else
    // the farthest shown gives way to a much nearer one), cars shown
    const measure = t >= warm;
    for (let me = 0; me < n; me++) {
      const a = copyCar(cars[me]);
      const ll = lastList[me];
      const g = games[me];
      const gone = [];
      for (const [q, p] of g) {
        const keep = t - p.listed <= GRACE;
        if (!keep && p.shown) gone.push(q);
        if (!keep) g.delete(q);
      }
      let used = 0;
      for (const p of g.values()) if (p.slot !== null) used++;
      const cands = [];
      for (const [q, p] of g) {
        if (p.slot === null && cars[q].status === 2 && t >= p.first + HANDSHAKE && p.listed === ll) cands.push([rank(a, cars[q]), q]);
      }
      cands.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
      for (const [d, q] of cands) {
        if (used < scene.links) {
          g.get(q).slot = t;
          used++;
          continue;
        }
        let out = null;
        for (const [j, p] of g) {
          if (p.slot !== null && p.listed !== ll) {
            const dj = rank(a, cars[j]);
            if (out === null || dj > out[0]) out = [dj, j];
          }
        }
        if (out === null) {
          let far = null;
          for (const [j, p] of g) {
            if (p.slot !== null) {
              const dj = rank(a, cars[j]);
              if (far === null || dj > far[0]) far = [dj, j];
            }
          }
          out = far !== null && d < far[0] * 0.6 && far[0] - d > 50.0 ? far : null;
        }
        if (out === null) break;
        const j = out[1];
        const pj = g.get(j);
        pj.slot = null;
        if (pj.shown) {
          pj.shown = false;
          gone.push(j);
        }
        g.get(q).slot = t;
      }
      const ci = classOf(a);
      if (ci === null) continue;
      for (const [q, p] of g) {
        const now = p.slot !== null && t >= p.slot + LOAD;
        if (now && !p.shown && measure && a.status === 2) {
          const b = cars[q];
          if (!hidden(a, b) && across(a, b) < NEAR_M) tally[ci].pops++;
        }
        p.shown = now;
      }
      if (measure && a.status === 2) {
        for (const q of gone) {
          const b = cars[q];
          if (b.status === 2 && !hidden(a, b) && across(a, b) < NEAR_M) {
            tally[ci].outs++;
            tally[ci].hopOuts += b.hopV > 0.0 ? 1 : 0;
          }
        }
      }
    }
    // what the players see, every half second
    if (measure && stepNo % 5 === 0) {
      for (let me = 0; me < n; me++) {
        const a = cars[me];
        const ci = classOf(a);
        if (ci === null) continue;
        const tl = tally[ci];
        tl.minutes += 0.5 / 60.0;
        const [fx, fy] = [Math.cos(a.h), Math.sin(a.h)];
        cars.forEach((b, q) => {
          if (q === me || b.status !== 2) return;
          const p = games[me].get(q);
          const shown = p !== undefined && p.shown;
          const hide = hidden(a, b);
          tl.shown += shown ? 1 : 0;
          tl.shownHidden += shown && hide ? 1 : 0;
          const d = across(a, b);
          if (hide || d === 0.0 || d > FRONT_M) return;
          if (d < NEAR_M) {
            tl.around++;
            tl.aroundShown += shown ? 1 : 0;
          }
          const cos = ((b.p[0] - a.p[0]) * fx + (b.p[1] - a.p[1]) * fy) / d;
          if (drives(a) && cos > FRONT_COS) {
            tl.front++;
            tl.frontShown += shown ? 1 : 0;
          }
        });
      }
    }
    k.step(STEP * 1000.0);
    t += STEP;
    stepNo++;
  }
  const pc = (a, b) => (b === 0 ? NaN : (100.0 * a) / b);
  KINDS.forEach(([name], ci) => {
    const tl = tally[ci];
    if (tl.minutes === 0.0) return;
    console.log(
      rpad(scene.name, 8) + ' ' + rpad(way, 18) + ' ' + rpad(name, 13) + ' in front ' + lpad(pc(tl.frontShown, tl.front), 5, 1) +
        ' %, around ' + lpad(pc(tl.aroundShown, tl.around), 5, 1) + ' %, shown out of sight ' + lpad(pc(tl.shownHidden, tl.shown), 5, 1) +
        ' %, pop-ins ' + lpad(tl.pops / tl.minutes, 5, 2) + '/min, pop-outs ' + lpad(tl.outs / tl.minutes, 5, 2) + '/min (' +
        (tl.hopOuts / tl.minutes).toFixed(2) + ' hopping)',
    );
  });
  console.log(rpad(scene.name, 8) + ' ' + rpad(way, 18) + ' links ' + (linksMade / (n * (end - warm))).toFixed(2) + '/s a player');
}

/** the hub's ways compared: without the rule (a gap counts as it is), the rule as it is, and with other numbers */
function levelWays() {
  return [
    ['no rule', { levelK: 1e-9 }],
    ['rule', {}],
    ['rule, k 10', { levelK: 10.0 }],
    ['rule, k 50', { levelK: 50.0 }],
    ['rule, slack 3', { levelSlackM: 3.0 }],
    ['rule, grade 0.3', { levelGrade: 0.3 }],
  ];
}

test('levels', (t) => {
  if (process.env.ROAM_LEVELS !== '1') {
    t.skip('ignored, as the Rust #[ignore]s it: a simulation that prints, not a test (ROAM_LEVELS=1 runs it)');
    return;
  }
  const f = FULL ? 1 : 10;
  const scenes = [
    { name: 'highway', highway: 300 / f, street: 600 / f, meets: 60 / f, shops: 60 / f, links: 32 },
    { name: 'city', highway: 0, street: 900 / f, meets: 60 / f, shops: 60 / f, links: 32 },
    { name: 'phones', highway: 300 / f, street: 600 / f, meets: 60 / f, shops: 60 / f, links: 16 },
  ];
  const only = process.env.LEVELS_WAYS ? process.env.LEVELS_WAYS : null;
  for (const s of scenes) {
    for (const [name, o] of levelWays()) {
      if (only !== null && !only.split(',').some((x) => x === name)) continue;
      run(s, name, o);
    }
  }
});
