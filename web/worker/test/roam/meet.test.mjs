// A port of web/server-rs/crates/roam/tests/meet.rs.
//
// A car meet: free roam's links from the hub and the cars the games show for them, simulated, so that the hub's
// options (and the games' way with their slots) can be compared where many players stand together and more drive
// by.  Not a test (#[ignore] in the Rust, run there with --ignored --nocapture): skipped here unless ROAM_IGNORED=1
// (smaller: see SIZES) or ROAM_FULL=1 (the Rust's sizes, every scene and way: hours in JS),
//   cd web/worker && ROAM_IGNORED=1 node --test test/roam/meet.test.mjs
// MEET_SCENE=<name> and MEET_ONLY="<way>|<way>" pick scenes and ways by name, as in the Rust.
//
// The players: about 90 at the meet, each one now parked at a spot of it (8 to 60 m from its middle, pointing any
// way) for 1.5 to 6 minutes, now driving by on straight lines through and past it (up to 200 m off its middle, 15 to
// 35 m/s), and now driving in to a spot or off from one; at a time about 50 stand and 40 drive.  Around them a city
// of 300 players (3 km a side: some driving, some parked, some in a shop), and 6 who jump: 40 s far off, then 40 s
// at a spot of the meet.  Each sends the hub a SNAP twice a second, each game asks for 64 links (core version 14),
// and each game is a model of roam_game.c's 64 slots (assign): a peer listed is shown after the handshake and its
// car loaded, the car loader serving one load after another, two queued at most; a slot of a peer gone is parked
// with its look, for that peer again or another's look.
//
// Measured: for the players parked at the meet (20 s and more), how many cars show, how many of their 64 nearest
// (by plain distance) show, how many cars a minute they load, and how many go while still within 60 m (a car that
// vanishes in front of them); for the ones who jump in, how long until 90 % of what can show shows.
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
 * the Rust's sizes (ROAM_FULL=1), else the "meet" scene alone (396 players), 150 s (60 s warm), one way: about 20 s
 * (the meet scene's 420 s take some 70 s a way in JS, the scenes of a city of 3000 far longer)
 */
const SIZES = FULL ? { end: 420.0, scenes: null, ways: null } : { end: 150.0, scenes: ['meet'], ways: ['one-way, near first'] };

class Lcg {
  constructor(s) {
    this.s = BigInt(s);
  }
  unit() {
    this.s = BigInt.asUintN(64, this.s * 6364136223846793005n + 1442695040888963407n);
    return Number(this.s >> 11n) / 2 ** 53;
  }
  range(a, b) {
    return a + (b - a) * this.unit();
  }
}

const TAU = 2 * Math.PI;
/** the simulation's step (s) */
const STEP = 0.1;
/** the game's slots (roam_game.c NSLOT) and the links it asks for */
const SLOTS = 64;
/** from a list to a peer: the list on its way and HELLOs both ways through the switch, and the car's record (s) */
const HANDSHAKE = 0.5;
/** roam_core.c T_HUB_GRACE (s) */
const GRACE = 2.5;
/** roam_game.c LOADS_AHEAD */
const LOADS_AHEAD = 2;
/** "near" for a car that goes: one that goes this near is one that vanished in front of the player */
const NEAR_M = 60.0;
/**
 * in a real meet (Scene.real): a parked player's next donut, move or stop comes this often (s, on average), and this
 * share of the drivers circle the meet instead of driving through
 */
const FIDGET_S = 25.0;
const LOOPERS = 0.35;
const JUMP_N = 6;

// what a car does (Rust enum Doing), {kind, ...}:
//   parked {until}: at a spot of the meet until then
//   leg {a, b, t0, s, park}: from a to b at speed s, from t0; then (park: at b)
//   city: a city player: straight on, now and then a turn (popin)
//   away {until}: a jumper far off until then
//   fidget {until, w, sp, park}: a parked player's donut or move (yaw rate w, speed sp) until then, then parked again until park
//   stop {until, park}: a parked player in a shop (status 4) or paused (5) until then, then parked again until park
//   loop {rr, a0, t0, w, until}: circling the meet's middle at radius rr, angle a0 at t0, angular speed w (rad/s), until then

// a game's slot (Rust SlotSt): {s: FREE} | {s: PARKED, q} (a car parked with this peer's look) | {s: LOADING, q, done}
// (loading for this peer until then) | {s: ACTIVE, q}
const FREE = 0, PARKED = 1, LOADING = 2, ACTIVE = 3;
const slotFree = () => ({ s: FREE, q: -1, done: 0 });

function speed(c) {
  return Math.sqrt(c.v[0] * c.v[0] + c.v[1] * c.v[1]);
}

/**
 * how a game ranks its peers for the slots (roam_game.c PeerView.rank): the nearest of the distances soon and look
 * seconds on, both cars at their speeds, and from its view point view m ahead (soon) to the other car
 */
function rankOf(rank, a, b) {
  const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1];
  const ux = b.v[0] - a.v[0], uy = b.v[1] - a.v[1];
  const at = (t) => Math.sqrt((dx + ux * t) ** 2 + (dy + uy * t) ** 2);
  const sx = dx + ux * rank.soon - Math.cos(a.h) * rank.view, sy = dy + uy * rank.soon - Math.sin(a.h) * rank.view;
  const view = a.status === 2 ? Math.sqrt(sx * sx + sy * sy) : Infinity;
  return Math.min(Math.min(at(rank.soon), at(rank.look)), view);
}

function newTally() {
  return {
    samples: 0, shown: 0, nearest: 0, nearestShown: 0, near60: 0, near60Shown: 0, loads: 0, goneNear: 0, observerS: 0.0,
    jumpFill: [], jumpLinks: [], jumpMiss: 0, driveSamples: 0, driveNear: 0, driveNearShown: 0, linksMade: 0,
    // for the players parked at the meet: how long each car showed that went, and how many came back within 30 s
    lives: [], back30: 0,
    // ...and of the ones that went within NEAR_M, how long each showed
    nearLives: [],
  };
}

function pct(v, q) {
  if (v.length === 0) return NaN;
  v.sort((x, y) => x - y);
  return v[Math.round((v.length - 1) * q)];
}

function spot(r) {
  // uniform over the ring 8..60 m
  const rr = Math.sqrt(r.range(8.0 * 8.0, 60.0 * 60.0));
  const a = r.unit() * TAU;
  return [rr * Math.cos(a), rr * Math.sin(a)];
}

/** a line through or past the meet: up to 200 m off its middle, 600 m either side */
function line(r, t) {
  const a = r.unit() * TAU;
  const d = [Math.cos(a), Math.sin(a)], n = [-Math.sin(a), Math.cos(a)];
  const b = r.range(-200.0, 200.0);
  const from = [n[0] * b - d[0] * 600.0, n[1] * b - d[1] * 600.0];
  const to = [n[0] * b + d[0] * 600.0, n[1] * b + d[1] * 600.0];
  return { kind: 'leg', a: from, b: to, t0: t, s: r.range(15.0, 35.0), park: false };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const pad = (s, w) => String(s).padStart(w);
const f = (x, w, p) => pad(fixed(x, p), w);

function run(sc, way, end) {
  const MEET_N = sc.meet, CITY_N = sc.city, half = sc.side / 2.0;
  const r = new Lcg(7);
  const k = new Kit({ ...way.o, maxPlayers: 8192 });
  const n = MEET_N + CITY_N + sc.jump;
  const vip = (i) => 0x0a4d0100 + i;
  const cars = [];
  for (let i = 0; i < n; i++) {
    const h = r.unit() * TAU;
    const nextSnap = r.unit() * 0.5;
    const nextFidget = sc.real && i < sc.meet ? r.range(0.0, 2.0 * FIDGET_S) : Infinity;
    const c = { p: [0, 0, 0], v: [0, 0, 0], h, turn: 0.0, status: 2, nextSnap, doing: { kind: 'city' }, since: 0.0, nextFidget };
    if (i < MEET_N) {
      if (r.unit() < 0.55) {
        const s = spot(r);
        c.p = [s[0], s[1], 0.0];
        c.doing = { kind: 'parked', until: r.range(10.0, 360.0) };
      } else {
        const t0 = -r.range(0.0, 40.0);
        c.doing = line(r, t0);
      }
    } else if (i < MEET_N + CITY_N) {
      c.p = [r.range(-half, half), r.range(-half, half), 0.0];
      const kind = r.unit();
      if (kind < 0.55) {
        const s = r.range(15.0, 50.0);
        c.v = [Math.cos(c.h) * s, Math.sin(c.h) * s, 0.0];
      } else if (kind >= 0.9) {
        c.status = 4;
      }
    } else {
      c.doing = { kind: 'away', until: r.range(0.0, 40.0) };
      c.p = [half + 500.0, half + 500.0 + i * 30.0, 0.0];
    }
    cars.push(c);
  }
  const watched = (i) => (i < MEET_N && (!sc.mix || i % 4 === 0)) || i >= MEET_N + CITY_N;
  const linksOf = new Array(n).fill(SLOTS);
  for (let i = 0; i < n; i++) {
    let links;
    if (!sc.mix) links = SLOTS;
    else if (watched(i)) links = sc.watchLinks;
    else {
      const u = r.unit();
      links = u < 0.6 ? 32 : u < 0.7 ? 24 : u < 0.9 ? 16 : u < 0.95 ? 48 : 64;
    }
    linksOf[i] = links;
    k.from(vip(i), helloWith(1000 + i, { core: way.core, links }));
  }
  const games = [];
  for (let i = 0; i < n; i++) {
    games.push({
      peers: new Map(),
      slots: Array.from({ length: linksOf[i] }, slotFree),
      loaderAt: 0.0,
      jumped: null,
      linked90: false,
      shownAt: new Map(),
      goneAt: new Map(),
    });
  }
  const lastList = new Array(n).fill(-Infinity);
  const warm = 60.0;
  // the players measured: parked at the meet (20 s and more, 0), and driving round it or through it (1)
  const tallies = [newTally(), newTally()];
  const observed = (me, a, t) => {
    if (!watched(me) || me >= MEET_N || t < warm) return null;
    const rr = Math.sqrt(a.p[0] * a.p[0] + a.p[1] * a.p[1]);
    const kd = a.doing.kind;
    if ((kd === 'parked' || kd === 'fidget') && t - a.since >= 20.0 && rr < 70.0) return 0;
    if (kd === 'loop') return 1;
    if (kd === 'leg' && rr < 150.0) return 1;
    return null;
  };
  let nextTick = 0.0, t = 0.0, stepNo = 0;
  const jumpers = [];
  for (let i = MEET_N + CITY_N; i < n; i++) jumpers.push(i);
  const games0 = [];
  for (let i = 0; i < MEET_N; i++) games0.push(i);
  const mine = games0.concat(jumpers);
  while (t < end) {
    // the cars move
    for (const c of cars) {
      const d = c.doing;
      if (d.kind === 'parked' && t >= c.nextFidget && t < d.until) {
        const until = d.until;
        c.nextFidget = t - FIDGET_S * Math.log(1.0 - r.unit());
        const u = r.unit();
        if (u < 0.45) {
          // a donut: 6 to 12 m/s round a circle of 4 to 8 m, 3 to 8 s
          const sp = r.range(6.0, 12.0);
          const w = (sp / r.range(4.0, 8.0)) * (r.unit() < 0.5 ? -1.0 : 1.0);
          c.doing = { kind: 'fidget', until: t + r.range(3.0, 8.0), w, sp, park: until };
        } else if (u < 0.75) {
          // to another spot near: 4 to 8 m/s for 2 to 6 s, turning a little
          const fu = t + r.range(2.0, 6.0);
          const w = r.range(-0.4, 0.4);
          c.doing = { kind: 'fidget', until: fu, w, sp: r.range(4.0, 8.0), park: until };
        } else {
          // a shop or the pause menu, 10 to 60 s
          c.status = r.unit() < 0.5 ? 4 : 5;
          c.doing = { kind: 'stop', until: t + r.range(10.0, 60.0), park: until };
        }
      } else if (d.kind === 'fidget') {
        c.h += d.w * STEP;
        c.v = [Math.cos(c.h) * d.sp, Math.sin(c.h) * d.sp, 0.0];
        c.p[0] += c.v[0] * STEP;
        c.p[1] += c.v[1] * STEP;
        if (t >= d.until) {
          c.v = [0, 0, 0];
          c.doing = { kind: 'parked', until: Math.max(d.park, t + 5.0) };
        }
      } else if (d.kind === 'stop') {
        c.v = [0, 0, 0];
        if (t >= d.until) {
          c.status = 2;
          c.doing = { kind: 'parked', until: Math.max(d.park, t + 5.0) };
        }
      } else if (d.kind === 'loop') {
        const a = d.a0 + d.w * (t - d.t0);
        c.p = [d.rr * Math.cos(a), d.rr * Math.sin(a), 0.0];
        const sp = d.w * d.rr;
        c.v = [-Math.sin(a) * sp, Math.cos(a) * sp, 0.0];
        c.h = Math.atan2(c.v[1], c.v[0]);
        if (t >= d.until) c.doing = line(r, t);
      } else if (d.kind === 'parked') {
        c.v = [0, 0, 0];
        if (t >= d.until) {
          // off, the way it points, to 600 m
          const dd = [Math.cos(c.h), Math.sin(c.h)];
          const to = [c.p[0] + dd[0] * 600.0, c.p[1] + dd[1] * 600.0];
          c.doing = { kind: 'leg', a: [c.p[0], c.p[1]], b: to, t0: t, s: r.range(15.0, 25.0), park: false };
        }
      } else if (d.kind === 'leg') {
        const { a, b, t0, s, park } = d;
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.sqrt(dx * dx + dy * dy);
        const u = Math.min((t - t0) * s, len);
        const dd = [dx / len, dy / len];
        c.p = [a[0] + dd[0] * u, a[1] + dd[1] * u, 0.0];
        c.v = [dd[0] * s, dd[1] * s, 0.0];
        c.h = Math.atan2(dd[1], dd[0]);
        if (u >= len) {
          if (park) {
            c.v = [0, 0, 0];
            c.doing = { kind: 'parked', until: t + r.range(90.0, 360.0) };
            c.since = t;
          } else if (sc.real && r.unit() < LOOPERS) {
            // round the meet, 40 to 150 m out at 10 to 25 m/s, for 20 to 90 s
            const rr = r.range(40.0, 150.0);
            const w = (r.range(10.0, 25.0) / rr) * (r.unit() < 0.5 ? -1.0 : 1.0);
            const a0 = r.unit() * TAU;
            c.doing = { kind: 'loop', rr, a0, t0: t, w, until: t + r.range(20.0, 90.0) };
          } else if (r.unit() < 0.4) {
            // in to a spot, from 500 m
            const sp = spot(r);
            const an = r.unit() * TAU;
            const from = [sp[0] - Math.cos(an) * 500.0, sp[1] - Math.sin(an) * 500.0];
            c.doing = { kind: 'leg', a: from, b: sp, t0: t, s: r.range(12.0, 20.0), park: true };
          } else {
            c.doing = line(r, t);
          }
        }
      } else if (d.kind === 'city') {
        const moving = c.status === 2 && speed(c) > 1.0;
        if (moving && c.turn === 0.0 && r.unit() < STEP / 6.0) c.turn = (r.unit() - 0.5) * Math.PI;
        if (c.turn !== 0.0) {
          const a = clamp(c.turn, -1.047 * STEP, 1.047 * STEP);
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
        if (moving) c.h = Math.atan2(c.v[1], c.v[0]);
      } else if (d.kind === 'away') {
        if (t >= d.until) {
          const sp = spot(r);
          c.p = [sp[0], sp[1], 0.0];
          c.h = r.unit() * TAU;
          c.doing = { kind: 'parked', until: t + 40.0 };
          c.since = t;
        }
      }
    }
    // jumpers away again after their 40 s
    for (const i of jumpers) {
      const d = cars[i].doing;
      if (d.kind === 'parked' && t >= d.until - STEP) {
        cars[i].doing = { kind: 'away', until: t + 40.0 };
        cars[i].p = [half + 500.0, half + 500.0 + i * 30.0, 0.0];
        cars[i].v = [0, 0, 0];
      }
    }
    cars.forEach((c, i) => {
      if (t >= c.nextSnap) {
        c.nextSnap += 0.5;
        k.from(vip(i), snapMoving(1000 + i, c.p, c.v, c.h, c.status));
      }
    });
    if (t >= nextTick) {
      nextTick += way.o.tickMs / 1000.0;
      k.clear();
      k.hub.tick();
      const lists = [];
      for (const [key, list] of k.listsIn()) lists.push([Number(key.split(':')[0]) - vip(0), list.map((e) => e.vip - vip(0))]);
      for (const [me, list] of lists) {
        lastList[me] = t;
        for (const q of list) {
          const g = games[me];
          let p = g.peers.get(q);
          if (!p) {
            if (t >= warm && me < MEET_N) tallies[0].linksMade++;
            p = { listed: t, first: t };
            g.peers.set(q, p);
          }
          p.listed = t;
        }
      }
    }
    // the jumpers' jumps in
    for (const i of jumpers) {
      const landed = cars[i].doing.kind === 'parked' && Math.abs(t - cars[i].since) < STEP / 2.0;
      if (landed && t >= warm) games[i].jumped = t;
    }
    // each game (of the players watched: the meet's and the jumpers'; the city's games change nothing the hub does)
    for (const me of mine) {
      const a = cars[me];
      const ll = lastList[me];
      const cls = observed(me, a, t);
      const observer = cls !== null;
      const tally = tallies[cls ?? 0];
      const g = games[me];
      // peers gone
      const gone = new Set();
      for (const [q, p] of g.peers) {
        if (!(t - p.listed <= GRACE)) {
          gone.add(q);
          g.peers.delete(q);
        }
      }
      const near = (q) => Math.sqrt((cars[q].p[0] - a.p[0]) ** 2 + (cars[q].p[1] - a.p[1]) ** 2) < NEAR_M;
      for (const sl of g.slots) {
        if ((sl.s === ACTIVE || sl.s === LOADING) && gone.has(sl.q)) {
          const q = sl.q;
          const wentNear = observer && sl.s === ACTIVE && near(q) && cars[q].status === 2;
          if (wentNear) tally.goneNear++;
          if (g.shownAt.has(q)) {
            const t0 = g.shownAt.get(q);
            g.shownAt.delete(q);
            if (observer) {
              tally.lives.push(t - t0);
              if (wentNear) tally.nearLives.push(t - t0);
            }
          }
          g.goneAt.set(q, t);
          if (sl.s === ACTIVE) sl.s = PARKED;
          else Object.assign(sl, slotFree());
        } else if (sl.s === LOADING && t >= sl.done) {
          sl.s = ACTIVE;
          g.shownAt.set(sl.q, t);
        }
      }
      // slots: the nearest listed peer without one, while the loader has room
      const has = (q) => g.slots.some((s) => (s.s === ACTIVE || s.s === LOADING) && s.q === q);
      const cands = [];
      for (const [q, p] of g.peers) {
        if (cars[q].status === 2 && t >= p.first + HANDSHAKE && p.listed === ll && !has(q)) cands.push([rankOf(way.rank, a, cars[q]), q]);
      }
      cands.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      const backWithin30 = (q) => g.goneAt.has(q) && t - g.goneAt.get(q) < 30.0;
      for (const [d, q] of cands) {
        // 1. a parked car with this look
        const pj = g.slots.findIndex((s) => s.s === PARKED && s.q === q);
        if (pj >= 0) {
          g.slots[pj] = { s: ACTIVE, q, done: 0 };
          g.shownAt.set(q, t);
          if (observer && backWithin30(q)) tally.back30++;
          continue;
        }
        const queued = g.slots.filter((s) => s.s === LOADING).length;
        if (queued >= LOADS_AHEAD) break;
        // 2. a free slot, 3. a parked one, 4.-6. one to give way
        let j = g.slots.findIndex((s) => s.s === FREE);
        if (j < 0) j = g.slots.findIndex((s) => s.s === PARKED);
        if (j < 0) {
          const rankX = (x) => rankOf(way.rank, a, cars[x]);
          let out = null;
          g.slots.forEach((s, jj) => {
            if (s.s === ACTIVE) {
              const x = s.q;
              const p = g.peers.get(x);
              if (cars[x].status !== 2 || (p !== undefined && p.listed !== ll)) {
                const dx = rankX(x);
                if (out === null || dx > out[0]) out = [dx, jj];
              }
            }
          });
          if (out === null) {
            let far = null;
            g.slots.forEach((s, jj) => {
              if (s.s === ACTIVE) {
                const dx = rankX(s.q);
                if (far === null || dx > far[0]) far = [dx, jj];
              }
            });
            out = far !== null && d < far[0] * 0.6 && far[0] - d > 50.0 ? far : null;
          }
          if (out === null) break;
          const jj = out[1];
          if (g.slots[jj].s === ACTIVE) {
            const x = g.slots[jj].q;
            const wentNear = observer && near(x) && cars[x].status === 2;
            if (wentNear) tally.goneNear++;
            if (g.shownAt.has(x)) {
              const t0 = g.shownAt.get(x);
              g.shownAt.delete(x);
              if (observer) {
                tally.lives.push(t - t0);
                if (wentNear) tally.nearLives.push(t - t0);
              }
            }
            g.goneAt.set(x, t);
          }
          j = jj;
        }
        const done = Math.max(g.loaderAt, t) + way.load;
        g.loaderAt = done;
        g.slots[j] = { s: LOADING, q, done };
        if (observer) {
          tally.loads++;
          if (backWithin30(q)) tally.back30++;
        }
      }
      if (observer) tally.observerS += STEP;
    }
    // what the players see, every half second
    if (t >= warm && stepNo % 5 === 0) {
      for (const me of mine) {
        const a = cars[me];
        let g = games[me];
        const shown = new Set();
        for (const s of g.slots) if (s.s === ACTIVE && cars[s.q].status === 2) shown.add(s.q);
        const dist = (q) => Math.sqrt((cars[q].p[0] - a.p[0]) ** 2 + (cars[q].p[1] - a.p[1]) ** 2);
        const others = [];
        for (let q = 0; q < n; q++) {
          if (q !== me && cars[q].status === 2) {
            const e = dist(q);
            if (e < 300.0) others.push([e, q]);
          }
        }
        others.sort((x, y) => x[0] - y[0]);
        const kk = Math.min(others.length, linksOf[me]);
        let kj = 0;
        while (kj < others.length && others[kj][0] < 100.0) kj++;
        kj = Math.min(kj, SLOTS);
        if (g.jumped !== null) {
          const t0 = g.jumped;
          const tally = tallies[0];
          const ll = lastList[me];
          const linked = others.slice(0, kj).filter((e) => {
            const p = g.peers.get(e[1]);
            return p !== undefined && p.listed === ll;
          }).length;
          if (linked >= 0.9 * kj && !g.linked90) {
            tally.jumpLinks.push(t - t0);
            g.linked90 = true;
          }
          const got = others.slice(0, kj).filter((e) => shown.has(e[1])).length;
          if (got >= 0.9 * kj) {
            tally.jumpFill.push(t - t0);
            g.jumped = null;
            g.linked90 = false;
          } else if (t - t0 > 35.0) {
            tally.jumpMiss++;
            g.jumped = null;
            g.linked90 = false;
          }
        }
        g = games[me];
        const cls = observed(me, a, t);
        if (cls !== null) {
          const tally = tallies[cls];
          tally.samples++;
          tally.shown += shown.size;
          tally.nearest += kk;
          tally.nearestShown += others.slice(0, kk).filter((e) => shown.has(e[1])).length;
          for (const e of others) {
            if (!(e[0] < NEAR_M)) break;
            tally.near60++;
            tally.near60Shown += shown.has(e[1]) ? 1 : 0;
          }
        }
        // a driver going by the meet: the cars within 100 m
        if (watched(me) && me < MEET_N && a.doing.kind === 'leg' && Math.sqrt(a.p[0] * a.p[0] + a.p[1] * a.p[1]) < 150.0) {
          const tally = tallies[0];
          tally.driveSamples++;
          for (const e of others) {
            if (!(e[0] < 100.0)) break;
            tally.driveNear++;
            tally.driveNearShown += shown.has(e[1]) ? 1 : 0;
          }
        }
      }
    }
    k.step(STEP * 1000.0);
    t += STEP;
    stepNo++;
  }
  const pc = (a, b) => (100.0 * a) / Math.max(b, 1);
  const t0 = tallies[0];
  const jumps =
    'jump in: 90 % linked ' + f(pct(t0.jumpLinks, 0.5), 4, 1) + ' s, shown ' + f(pct(t0.jumpFill.slice(), 0.5), 4, 1) +
    ' s (p90 ' + f(pct(t0.jumpFill, 0.9), 4, 1) + ', ' + t0.jumpMiss + ' never) | links ' +
    fixed(t0.linksMade / (MEET_N * (end - warm)), 2) + '/s | driving by: <100 m ' + f(pc(t0.driveNearShown, t0.driveNear), 4, 1) + ' %';
  const out = [];
  tallies.forEach((tally, c) => {
    const mins = tally.observerS / 60.0;
    const l =
      sc.name.padEnd(6) + ' ' + way.name.padEnd(26) + ' ' + (c === 0 ? 'parked ' : 'driving') +
      ': shown ' + f(tally.shown / Math.max(tally.samples, 1), 4, 1) +
      ', nearest N ' + f(pc(tally.nearestShown, tally.nearest), 4, 1) + ' %, <60 m ' + f(pc(tally.near60Shown, tally.near60), 4, 1) +
      ' %, loads ' + f(tally.loads / mins, 5, 1) + '/min, gone <60 m ' + f(tally.goneNear / mins, 5, 2) + '/min (shown ' +
      f(pct(tally.nearLives, 0.5), 4, 1) + ' s, median), all gone: shown <10 s ' +
      f(pc(tally.lives.filter((x) => x < 10.0).length, tally.lives.length), 3, 0) + ' % (median ' + f(pct(tally.lives.slice(), 0.5), 4, 1) +
      ' s), back within 30 s ' + f(tally.back30 / mins, 4, 1) + '/min' +
      (c === 1 ? ' | ' + jumps + " | the hub's near links gone, why: " + JSON.stringify(k.hub.info().nearGone) : '');
    console.log(l);
    out.push(l);
  });
  return out;
}

test('meet', { skip: RUN ? false : 'ignored (#[ignore] in the Rust): a measurement, not a test; ROAM_IGNORED=1 runs it, ROAM_FULL=1 at the Rust\'s sizes' }, () => {
  const now = defaultOptions();
  const game = (o) => ({ soon: o.soonMs / 1000.0, look: o.lookMs / 1000.0, view: o.viewM });
  const way = (name, o, core) => ({ name, rank: game(o), o, load: 0.12, core });
  let only = process.env.MEET_ONLY || '';
  // the hub of before (links both ways: a game of core 14) and one-way links (core 15)
  const before = { ...now, nearM: 1e-9 };
  const ways = [
    way('links both ways (core 14)', { ...now }, 14),
    way('one-way (15, released)', before, 15),
    way('one-way, near first', { ...now }, 15),
    way('one-way, near first at any speed', { ...now, nearFast: 1e9 }, 15),
  ];
  const S = (name, meet, city, side, mix, watchLinks, real) => ({ name, meet, city, side, jump: JUMP_N, mix, watchLinks, real });
  const scenes = [
    S('meet', 90, 300, 3000.0, false, 64, false),
    S('busy', 45, 3000, 4000.0, false, 64, false),
    S('mixed', 90, 3000, 4000.0, true, 64, false),
    S('mix32', 90, 3000, 4000.0, true, 32, false),
    S('mix16', 90, 3000, 4000.0, true, 16, false),
    S('real', 90, 3000, 4000.0, true, 64, true),
    S('real32', 90, 3000, 4000.0, true, 32, true),
    S('real16', 90, 3000, 4000.0, true, 16, true),
    // as dense as the player's meet of 2026-11-05 (60 and more within 60 m)
    S('dense', 160, 3000, 4000.0, true, 64, true),
    S('dense32', 160, 3000, 4000.0, true, 32, true),
  ];
  let scene = process.env.MEET_SCENE || '';
  const scenesRun = scenes.filter((s) => (scene === '' ? !SIZES.scenes || SIZES.scenes.includes(s.name) : s.name === scene));
  for (const sc of scenesRun) {
    for (const w of ways.filter((w) => (only === '' ? !SIZES.ways || SIZES.ways.includes(w.name) : only.split('|').some((o) => w.name === o)))) {
      run(sc, w, SIZES.end);
    }
  }
});

