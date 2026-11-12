// A port of web/server-rs/crates/roam/tests/popin.rs.
//
// Pop-in in a crowd: free roam's links from the hub and the cars the game shows for them, simulated, so that the
// hub's options (and the game's way with its slots) can be compared.  Not a test (#[ignore] in the Rust, run there
// with --ignored --nocapture): skipped here unless ROAM_IGNORED=1 (smaller crowds, fewer ways: see SIZES) or
// ROAM_FULL=1 (the Rust's sizes and every way; long in JS),
//   cd web/worker && ROAM_IGNORED=1 node --test test/roam/popin.test.mjs
// POPIN_ONLY="now|before" picks ways by name, as in the Rust.
//
// The players: some drive straight on (now and then a turn), some are parked, some are in a shop.  Each sends the
// hub a SNAP twice a second, each at its own phase, and the hub ticks every tick_ms.  The game of each player is a
// model of roam_core and roam_game.c's slots: a player listed is a peer after a handshake, a peer in free roam gets
// one of 32 slots (the nearest first, by the game's own rank), and its car shows once loaded; a peer the hub left out
// goes after T_HUB_GRACE.  Measured for the players driving: of the cars in front of them (within 250 m, 40 degrees
// of where they drive), how many show; how near a car is when it shows there (a pop-in); how far behind a car is when
// it goes; and how many links a second the hub makes (each a handshake and a car loaded).
//
// (Rust HashMap iterations, random there, are insertion order here: the measures are of the same kind, not the same
// digits.)

import { test } from 'node:test';
import { Kit, helloWith, snapMoving } from './kit.mjs';
import { defaultOptions } from '../../src/roam/hub.js';
import { fixed } from '../../src/util/rustfmt.js';

const FULL = process.env.ROAM_FULL === '1';
const RUN = FULL || process.env.ROAM_IGNORED === '1';
/**
 * the Rust's sizes (ROAM_FULL=1: some 10 minutes a way in JS), else a city and a crowd a quarter as many on a half as
 * wide (as dense), 80 s (30 s warm), three ways: about 30 s
 */
const SIZES = FULL
  ? { scenes: [{ name: 'city', n: 1400, side: 3000.0 }, { name: 'crowd', n: 600, side: 800.0 }], end: 150.0, ways: null }
  : {
      scenes: [{ name: 'city', n: 350, side: 1500.0 }, { name: 'crowd', n: 150, side: 400.0 }],
      end: 80.0,
      ways: ['before', 'now', 'one-way, near first'],
    };

class Lcg {
  constructor(s) {
    this.s = BigInt(s);
  }
  unit() {
    this.s = BigInt.asUintN(64, this.s * 6364136223846793005n + 1442695040888963407n);
    return Number(this.s >> 11n) / 2 ** 53;
  }
}

const TAU = 2 * Math.PI;
/** the simulation's step (s) */
const STEP = 0.1;
/** the game's slots (roam_game.c NSLOT) */
const SLOTS = 32;
/** from a list to a peer: the list on its way and HELLOs both ways through the switch (s) */
const HANDSHAKE = 0.4;
/** from a slot to the car shown: the ride loaded (a look the car loader has seen) and the car made (s) */
const LOAD = 1.0;
/** roam_core.c T_HUB_GRACE (s) */
const GRACE = 2.5;
/** "in front": this near, and within 40 degrees of where the car drives */
const VIEW_M = 250.0;
const VIEW_COS = 0.766;
/** a pop-in: a car that shows in front this near */
const POP_M = 100.0;
/** a driver turns now and then, a quarter turn either way at most, at this rate (radians a second: 60 degrees) */
const TURN_RATE = 1.047;

/** a car: p, v, h (where it points), turn (what is left of the turn it is in), status, nextSnap */
function drives(c) {
  return c.status === 2 && c.v[0] * c.v[0] + c.v[1] * c.v[1] > 100.0;
}

/**
 * how the game ranks its peers for the slots (roam_game.c PeerView.rank): the nearest of the distances soon and look
 * seconds on, both cars at their speeds, and from its view point view m ahead (soon) to the other car (x and y)
 */
function rankOf(rank, a, b) {
  const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1];
  const ux = b.v[0] - a.v[0], uy = b.v[1] - a.v[1];
  const at = (t) => Math.sqrt((dx + ux * t) ** 2 + (dy + uy * t) ** 2);
  const sx = dx + ux * rank.soon - Math.cos(a.h) * rank.view, sy = dy + uy * rank.soon - Math.sin(a.h) * rank.view;
  const view = a.status === 2 ? Math.sqrt(sx * sx + sy * sy) : Infinity;
  return Math.min(Math.min(at(rank.soon), at(rank.look)), view);
}

function median(v) {
  if (v.length === 0) return NaN;
  v.sort((x, y) => x - y);
  return v[v.length >> 1];
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pad = (s, w) => String(s).padStart(w);

function run(scene, way, end) {
  const r = new Lcg(42);
  const k = new Kit({ ...way.o, maxPlayers: 8192 });
  const vip = (i) => 0x0a4d0100 + i;
  const half = scene.side / 2.0;
  const cars = [];
  for (let i = 0; i < scene.n; i++) {
    const p = [(r.unit() - 0.5) * scene.side, (r.unit() - 0.5) * scene.side, 0.0];
    const kind = r.unit();
    const a = r.unit() * TAU, s = 15.0 + r.unit() * 35.0;
    let v, status;
    if (kind < 0.55) [v, status] = [[Math.cos(a) * s, Math.sin(a) * s, 0.0], 2];
    else if (kind < 0.9) [v, status] = [[0, 0, 0], 2];
    else [v, status] = [[0, 0, 0], 4];
    cars.push({ p, v, h: a, turn: 0.0, status, nextSnap: r.unit() * 0.5 });
  }
  for (let i = 0; i < scene.n; i++) k.from(vip(i), helloWith(1000 + i, { core: way.core, links: way.links }));
  const games = Array.from({ length: scene.n }, () => new Map());
  const lastList = new Array(scene.n).fill(-Infinity);
  const warm = 30.0;
  const tally = {
    front: 0, frontShown: 0, near: 0, nearShown: 0, pops: 0, appearFront: [], goneBehind: [], behindShown: 0, samples: 0,
    parkedFront: 0, parkedFrontShown: 0, linksMade: 0,
  };
  let nextTick = 0.0, t = 0.0, stepNo = 0;
  while (t < end) {
    // the cars move; a driver turns now and then
    for (const c of cars) {
      if (drives(c) && c.turn === 0.0 && r.unit() < STEP / 6.0) c.turn = (r.unit() - 0.5) * Math.PI;
      if (c.turn !== 0.0) {
        const a = clamp(c.turn, -TURN_RATE * STEP, TURN_RATE * STEP);
        c.turn -= a;
        if (Math.abs(c.turn) < 1e-9) c.turn = 0.0;
        const s = Math.sin(a), co = Math.cos(a);
        c.v = [c.v[0] * co - c.v[1] * s, c.v[0] * s + c.v[1] * co, 0.0];
      }
      for (let a = 0; a < 2; a++) {
        c.p[a] += c.v[a] * STEP;
        if (Math.abs(c.p[a]) > half) {
          c.p[a] = Math.sign(c.p[a]) * half;
          c.v[a] = -c.v[a];
        }
      }
      if (drives(c)) c.h = Math.atan2(c.v[1], c.v[0]);
    }
    // their SNAPs to the hub
    cars.forEach((c, i) => {
      if (t >= c.nextSnap) {
        c.nextSnap += 0.5;
        k.from(vip(i), snapMoving(1000 + i, c.p, c.v, c.h, c.status));
      }
    });
    if (t >= nextTick) {
      nextTick += way.tickMs / 1000.0;
      k.clear();
      k.hub.tick();
      for (const [key, list] of k.listsIn()) {
        const me = Number(key.split(':')[0]) - vip(0);
        lastList[me] = t;
        for (const e of list) {
          const q = e.vip - vip(0);
          const g = games[me];
          let p = g.get(q);
          if (!p) {
            if (t >= warm) tally.linksMade++;
            p = { listed: t, first: t, slot: null, shown: false };
            g.set(q, p);
          }
          p.listed = t;
        }
      }
    }
    // each game: peers gone, slots, cars shown
    for (let me = 0; me < scene.n; me++) {
      const g = games[me];
      const a = cars[me], ll = lastList[me];
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
        if (p.slot === null && cars[q].status === 2 && t >= p.first + HANDSHAKE && (!way.giveWay || p.listed === ll)) {
          cands.push([rankOf(way.rank, a, cars[q]), q]);
        }
      }
      cands.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      for (const [d, q] of cands) {
        if (used < SLOTS) {
          g.get(q).slot = t;
          used++;
          continue;
        }
        // a slot to take: one of a peer the hub left out (the farthest), else the farthest shown one for a much
        // nearer peer (step 5)
        let out = null;
        if (way.giveWay) {
          for (const [j, p] of g) {
            if (p.slot !== null && p.listed !== ll) {
              const dj = rankOf(way.rank, a, cars[j]);
              if (out === null || dj > out[0]) out = [dj, j];
            }
          }
        }
        if (out === null) {
          let far = null;
          for (const [j, p] of g) {
            if (p.slot !== null) {
              const dj = rankOf(way.rank, a, cars[j]);
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
      const measure = t >= warm && drives(a);
      const fx = Math.cos(a.h), fy = Math.sin(a.h);
      const rel = (q) => {
        const dx = cars[q].p[0] - a.p[0], dy = cars[q].p[1] - a.p[1];
        const d = Math.sqrt(dx * dx + dy * dy);
        return [d, d > 0.0 ? (dx * fx + dy * fy) / d : 1.0];
      };
      for (const [q, p] of g) {
        const now = p.slot !== null && t >= p.slot + LOAD;
        if (now && !p.shown && measure) {
          const [d, cos] = rel(q);
          if (cos > VIEW_COS && d < VIEW_M) {
            tally.appearFront.push(d);
            if (d < POP_M) tally.pops++;
          }
        }
        p.shown = now;
      }
      if (measure) {
        for (const q of gone) {
          const [d, cos] = rel(q);
          if (cos < 0.0) tally.goneBehind.push(d);
        }
      }
    }
    // what the players see, every half second: the drivers, and the parked ones in free roam
    if (t >= warm && stepNo % 5 === 0) {
      for (let me = 0; me < scene.n; me++) {
        const a = cars[me];
        const dr = drives(a);
        if (a.status !== 2) continue;
        tally.samples += dr ? 1 : 0;
        const fx = Math.cos(a.h), fy = Math.sin(a.h);
        cars.forEach((b, q) => {
          if (q === me || b.status !== 2) return;
          const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1];
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > VIEW_M || d === 0.0) return;
          const cos = (dx * fx + dy * fy) / d;
          const p = games[me].get(q);
          const shown = p !== undefined && p.shown ? 1 : 0;
          if (!dr) {
            if (cos > VIEW_COS) {
              tally.parkedFront++;
              tally.parkedFrontShown += shown;
            }
            return;
          }
          if (cos > VIEW_COS) {
            tally.front++;
            tally.frontShown += shown;
            if (d < POP_M) {
              tally.near++;
              tally.nearShown += shown;
            }
          }
          if (cos < -0.5 && d > 100.0 && shown) tally.behindShown++;
        });
      }
    }
    k.step(STEP * 1000.0);
    t += STEP;
    stepNo++;
  }
  const drivers = cars.filter(drives).length;
  const minutes = (drivers * (end - warm)) / 60.0;
  const pc = (a, b) => (100.0 * a) / Math.max(b, 1);
  const line =
    pad(scene.name, 5) + ' ' + way.name.padEnd(26) +
    ' front ' + pad(fixed(pc(tally.frontShown, tally.front), 1), 4) + ' % (<100 m ' + pad(fixed(pc(tally.nearShown, tally.near), 1), 4) + ' %)' +
    ', pops <100 m ' + pad(fixed(tally.pops / minutes, 2), 5) + '/min, appear ' + pad(fixed(median(tally.appearFront), 0), 3) + ' m' +
    ', gone ' + pad(fixed(median(tally.goneBehind), 0), 3) + ' m behind, ' + pad(fixed(tally.behindShown / Math.max(tally.samples, 1), 1), 3) +
    ' far behind | parked: front ' + pad(fixed(pc(tally.parkedFrontShown, tally.parkedFront), 1), 4) + ' %' +
    ' | links ' + fixed(tally.linksMade / (scene.n * (end - warm)), 2) + '/s';
  console.log(line);
  return line;
}

test('popin', { skip: RUN ? false : 'ignored (#[ignore] in the Rust): a measurement, not a test; ROAM_IGNORED=1 runs it, ROAM_FULL=1 at the Rust\'s sizes' }, () => {
  const scenes = SIZES.scenes;
  // the hub before 2026-10-23 (an option that is not a positive number keeps its default: 1e-9 is none), and the
  // game's slots then: a peer the hub left out kept its slot until it went
  const off = 1e-9;
  const now = defaultOptions();
  const old = { ...now, tickMs: 1000, soonMs: off, lookMs: 3000.0, awayM: off, viewM: off };
  const gameOld = { soon: 0.0, look: 3.0, view: 0.0 };
  const game = (o) => ({ soon: o.soonMs / 1000.0, look: o.lookMs / 1000.0, view: o.viewM });
  const way = (name, o, giveWay) => ({ name, tickMs: o.tickMs, rank: game(o), o, giveWay, core: 4, links: 0 });
  let ways = [
    { name: 'before', tickMs: 1000.0, rank: gameOld, o: old, giveWay: false, core: 4, links: 0 },
    way('now', { ...now }, true),
    { name: 'now, the game as before', tickMs: 500.0, rank: gameOld, o: { ...now }, giveWay: false, core: 4, links: 0 },
    way('now, tick 1 s', { ...now, tickMs: 1000 }, true),
    way('now, no view point', { ...now, viewM: off }, true),
    way('now, view 100 m', { ...now, viewM: 100.0 }, true),
    way('now, view 200 m', { ...now, viewM: 200.0 }, true),
    way('now, soon 0 s', { ...now, soonMs: off }, true),
    way('now, look 3 s', { ...now, lookMs: 3000.0 }, true),
    way('now, look 5 s', { ...now, lookMs: 5000.0 }, true),
    way('now, nobody away', { ...now, awayM: off }, true),
    way('now, keep 0.7', { ...now, keep: 0.7 }, true),
    { ...way('now, core 14', { ...now }, true), core: 14, links: 32 },
    { ...way('now, one-way (core 15)', { ...now, nearM: off }, true), core: 15, links: 32 },
    { ...way('one-way, near first', { ...now }, true), core: 15, links: 32 },
    { ...way('one-way, near 100 m', { ...now, nearM: 100.0 }, true), core: 15, links: 32 },
    { ...way('one-way, near hold 15 s', { ...now, nearHoldMs: 15000.0 }, true), core: 15, links: 32 },
    { ...way('one-way, near first at any speed', { ...now, nearFast: 1e9 }, true), core: 15, links: 32 },
  ];
  const only = process.env.POPIN_ONLY || '';
  if (only !== '') ways = ways.filter((w) => only.split('|').some((o) => w.name === o));
  else if (SIZES.ways) ways = ways.filter((w) => SIZES.ways.includes(w.name));
  for (const s of scenes) for (const w of ways) run(s, w, SIZES.end);
});

