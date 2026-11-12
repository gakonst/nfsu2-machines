// A port of web/server-rs/crates/roam/tests/bench.rs.
//
// How long a tick takes with a full hub: 2000 players in one room (the grid and the heap), in 20 rooms of 100 (every
// pair of each), and in 8 rooms of 250 (every pair of rooms just under exact_room: the most pairs a tick sorts); and
// the same with crews (bench crews: crews of 2 to 6 spread over the map, and every player in 4 crews of 64, the most a
// crew is linked first), and with blocks (bench blocks: 1 player in 20 blocks 10 others).  And what the minimap's
// questions cost the hub's thread (bench near), and the world map's (bench map 4096: 16 datagrams an answer or 48),
// and a tick from 2000 to 24000 players (bench scale).
//
// Not a test: timing benchmarks on the real clock, every one #[ignore] in the Rust (run there with --ignored
// --nocapture), so skipped here unless ROAM_IGNORED=1 (a tenth of the players, the names still say the Rust's) or
// ROAM_FULL=1 (the Rust's sizes),
//   cd web/worker && ROAM_IGNORED=1 node --test test/roam/bench.test.mjs
// BENCH_CORE=n sets the games' core version, as in the Rust; BENCH_THREADS is read into linkThreads, which the JS hub
// keeps at one thread (its links are the same).  A tick's CPU is the process's (process.cpuUsage) and the thread's own
// (process.threadCpuUsage where node has it, else the process's): the JS hub has no other threads.

import { test } from 'node:test';
import { Kit, frame, helloWith, hello, snap, snapMoving, nearreq, mapreqFlags, neardOf, mapdOf, peersOf, crewMarks, recrc } from './kit.mjs';
import { fixed } from '../../src/util/rustfmt.js';

const FULL = process.env.ROAM_FULL === '1';
const RUN = FULL || process.env.ROAM_IGNORED === '1';
const SKIP = RUN ? false : "ignored (#[ignore] in the Rust): a timing benchmark on the real clock, not a test; ROAM_IGNORED=1 runs it (a tenth of the players), ROAM_FULL=1 at the Rust's sizes";
/** a count of players at the size this run takes */
const sz = (n) => (FULL ? n : Math.max(1, Math.round(n / 10)));
const said = (what) => (FULL ? what : what + ' [a tenth of the players]');

/** a small random walk of the bench's own */
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
const nowMs = () => performance.now();
/** the process's CPU time (s) */
const processCpuSeconds = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};
/** the calling thread's CPU time (ms) */
const threadCpuMs = () => {
  const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1e3;
};
const envNum = (k) => {
  const v = process.env[k];
  if (v === undefined || v === '' || !/^\d+$/.test(v)) return null;
  return Number(v);
};
const plus = (x, p) => (x >= 0 || Number.isNaN(x) ? '+' : '') + fixed(x, p);
const num = (x) => String(x);

function bench(what, players, rooms, area) {
  benchMoving(what, players, rooms, area, 15.0);
}

/** step: how far a player moves in x and y each second at most */
function benchMoving(what, players, rooms, area, step) {
  benchLinks(what, players, rooms, area, step, 0);
}

/** links: the links every player asks for (core version 10), 0: none said (a core before, 32) */
function benchLinks(what, players, rooms, area, step, links) {
  benchWith(what, players, rooms, area, step, links, () => [], () => []);
}

/**
 * crews(i): player i's crews (none: a HELLO of before, without the crew flag); players i of one room are the ones
 * with the same i % rooms; player i is named p<i>, and blocks(i) are the names it blocks
 */
function benchWith(what, players, rooms, area, step, links, crews, blocks) {
  const linkThreads = envNum('BENCH_THREADS') ?? 1;
  const k = new Kit({ maxPlayers: 24576, linkThreads });
  const r = new Lcg(7);
  const pos = [];
  for (let i = 0; i < players; i++) {
    const x = r.unit() * area - area / 2.0, y = r.unit() * area - area / 2.0, z = r.unit() * 20.0;
    pos.push([x, y, z]);
  }
  const vip = (i) => 0x0a4d0100 + i;
  const hellos = [];
  for (let i = 0; i < players; i++) {
    const c = crews(i), room = rooms > 1 ? 1 + (i % rooms) : 0;
    // (BENCH_CORE=15: one-way links; links 1: the live mix, 60 % 32, 10 % 24, 20 % 16, 5 % 48, 5 % 64)
    const core = envNum('BENCH_CORE') ?? (links > 0 ? 14 : 2);
    const l = links === 1 ? [32, 32, 32, 32, 32, 32, 24, 16, 16, 48, 64, 32][i % 12] : links;
    hellos.push(frame(vip(i), helloWith(1000 + i, { core, room, crews: c.length > 0 ? c : null, name: 'p' + i, links: l })));
  }
  for (let i = 0; i < players; i++) {
    const b = blocks(i);
    if (b.length > 0) k.hub.blocks(vip(i), b);
  }
  const times = [], cpu = [], own = [];
  let framesMs = 0.0;
  for (let t = 0; t < 23; t++) {
    k.clear();
    let t0 = nowMs();
    for (let i = 0; i < players; i++) {
      const p = pos[i];
      const v = [(r.unit() * 2.0 - 1.0) * step, (r.unit() * 2.0 - 1.0) * step];
      p[0] += v[0];
      p[1] += v[1];
      k.hub.frame(vip(i), hellos[i]);
      // its velocity: the move of this second
      const d = snap(1000 + i, p);
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      for (let a = 0; a < 2; a++) dv.setFloat32(38 + 4 * a, v[a], true);
      recrc(d);
      k.hub.frame(vip(i), frame(vip(i), d));
    }
    framesMs += nowMs() - t0;
    t0 = nowMs();
    const c0 = processCpuSeconds(), h0 = threadCpuMs();
    k.hub.tick();
    const ms = nowMs() - t0;
    // the first ticks make the links; from then on most are kept
    if (t >= 3) {
      times.push(ms);
      cpu.push((processCpuSeconds() - c0) * 1000.0);
      own.push(threadCpuMs() - h0);
    }
    k.step(1000.0);
  }
  const by = (x, y) => x - y;
  times.sort(by);
  cpu.sort(by);
  own.sort(by);
  const crewed = k.info('crewLinks') > 0.0 || k.info('crewSkips') > 0.0 ? ' (' + num(k.info('crewLinks')) + ' for crews, ' + num(k.info('crewSkips')) + ' crews too large)' : '';
  console.log(
    what + ': a tick ' + fixed(times[times.length >> 1], 2) + ' ms (median of ' + times.length + '; ' + fixed(times[0], 2) + ' to ' +
      fixed(times[times.length - 1], 2) + '; CPU ' + fixed(cpu[cpu.length >> 1], 2) + " ms, the hub's thread " + fixed(own[own.length >> 1], 2) +
      ' ms, least ' + fixed(own[0], 2) + '), ' + num(k.info('links')) + ' links' + crewed + '; ' +
      fixed((framesMs * 1e6) / (23.0 * 2.0 * players), 0) + ' ns a frame (HELLO or SNAP)' + copies(k, pos, vip(0)),
  );
}

/**
 * The car states the players send each other a second by the last tick's lists (each list's entries not marked RX:
 * the ones a player sends its car to), as roam_core's rc_push_state sends them: by distance (every one within 300 m,
 * every 4th past it, every 10th past 1 km), to a player who only gets ours (marked TX) by the hub's hints (core 16,
 * lists) or every one (core 15: it knows nothing of where that player is)
 */
function copies(k, pos, vip0) {
  const rate = (d) => (d > 1000.0 ? 2.0 : d > 300.0 ? 5.0 : 20.0);
  let both = 0.0, txBefore = 0.0, txAfter = 0.0, nTx = 0;
  let listBytes = 0, nLists = 0;
  for (const [vip, f] of k.sent) {
    listBytes += f.length;
    nLists++;
    const e = peersOf(f);
    const cm = crewMarks(f);
    const marks = cm ? cm[1] : new Array(e.length).fill(0);
    const a = pos[vip - vip0];
    e.forEach((q, i) => {
      const m = marks[i];
      if (m === undefined || m & 0x20) return;
      const b = pos[q.vip - vip0];
      const rr = rate(Math.hypot(a[0] - b[0], a[1] - b[1]));
      if (m & 0x40) {
        txBefore += 20.0;
        txAfter += rr;
        nTx++;
      } else {
        both += rr;
      }
    });
  }
  // (the lists: two a second, each to its player)
  const lists = '; lists ' + fixed(listBytes / Math.max(nLists, 1), 0) + ' B each, ' + fixed((listBytes * 2.0 * 8.0) / 1e6, 1) + ' Mbit/s';
  if (nTx === 0) return '; car states ' + fixed(both, 0) + '/s' + lists;
  return (
    '; car states ' + fixed(both + txBefore, 0) + '/s, ' + fixed(txBefore, 0) + ' of them to the ' + nTx + ' who only get ours (hub: ' +
    JSON.stringify(k.hub.info().txOnly) + '), with the hints ' + fixed(both + txAfter, 0) + '/s (' + plus((100.0 * (txAfter - txBefore)) / (both + txBefore), 1) +
    ' %)' + lists
  );
}

/**
 * crews of 2 to 6 players of one room, one after another (sizes 2, 3, 4, 5, 6 again and again: 500 crews of 2000
 * players), spread over the map as the players are
 */
function smallCrews(rooms) {
  return (i) => {
    const room = i % rooms, q = Math.floor(i / rooms);
    // the cycle of 20 players: 5 crews
    const cycle = Math.floor(q / 20), at = q % 20;
    const crew = [0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4][at];
    return [(0x10000000 + room * 100000 + cycle * 5 + crew) >>> 0];
  };
}

test('bench 2000 players in one room', { skip: SKIP }, () => {
  bench(said('2000 players in one room of 3 km'), sz(2000), 1, 3000.0);
  bench(said('2000 players in one room of 300 m'), sz(2000), 1, 300.0);
  // where a game puts everyone at the start: a crowd on one spot, every other player within a cell or two
  benchMoving(said('2000 players on one spot of 10 m'), sz(2000), 1, 10.0, 0.5);
});

test('bench 2000 players in 20 rooms', { skip: SKIP }, () => {
  bench(said('2000 players in 20 rooms of 100'), sz(2000), 20, 1000.0);
});

test('bench 2000 players in 8 rooms of 250', { skip: SKIP }, () => {
  bench(said('2000 players in 8 rooms of 250'), sz(2000), 8, 1000.0);
});

/**
 * each crowd of bench crews without crews, then with them (the same players, places and moves): one after the other,
 * so that what else the machine does weighs on both alike
 */
function withAndWithout(what, players, rooms, area, step, crews) {
  const at = what.indexOf(',') >= 0 ? what.indexOf(',') : what.length;
  benchWith(said(what.slice(0, at) + ', no crews'), players, rooms, area, step, 0, () => [], () => []);
  benchWith(said(what), players, rooms, area, step, 0, crews, () => []);
}

test('bench crews', { skip: SKIP }, () => {
  withAndWithout('2000 players in one room of 3 km, 500 crews of 2-6', sz(2000), 1, 3000.0, 15.0, smallCrews(1));
  withAndWithout('2000 players in 20 rooms of 100, crews of 2-6', sz(2000), 20, 1000.0, 15.0, smallCrews(20));
  withAndWithout('2000 players in 8 rooms of 250, crews of 2-6', sz(2000), 8, 1000.0, 15.0, smallCrews(8));
  withAndWithout('2000 players on one spot of 10 m, 500 crews of 2-6', sz(2000), 1, 10.0, 0.5, smallCrews(1));
  // the most a tick does for crews: every player in 4 crews of (at most) 64, each of the 4 a grouping of its own
  // (128 crews, 250,000 pairs)
  const big = (i) => [0, 1, 2, 3].map((k) => (0x20000000 + k * 1000 + Math.floor((i + 16 * k) / 64)) >>> 0);
  withAndWithout('2000 players in one room of 3 km, each in 4 crews of 64', sz(2000), 1, 3000.0, 15.0, big);
  withAndWithout('4000 players in one room of 3 km, 1000 crews of 2-6', sz(4000), 1, 3000.0, 15.0, smallCrews(1));
});

// the links a tick makes for players that ask for 32, 48 and 64 (core version 14): a crowd's links cost the tick
// about their number
test('bench links 32 48 64', { skip: SKIP }, () => {
  for (const links of [32, 48, 64]) {
    benchLinks(said('3000 players in one room of 4 km, 15 m/s, ' + links + ' links'), sz(3000), 1, 4000.0, 15.0, links);
    benchLinks(said('3000 players in one room of 1 km, 15 m/s, ' + links + ' links'), sz(3000), 1, 1000.0, 15.0, links);
    benchLinks(said('2000 players on one spot of 10 m, ' + links + ' links'), sz(2000), 1, 10.0, 0.5, links);
  }
});

// one-way links' cost (run with BENCH_CORE=15, and without for the links of before): the live mix of links
test('bench oneway', { skip: SKIP }, () => {
  benchLinks(said('3000 players in one room of 4 km, 15 m/s, the live mix'), sz(3000), 1, 4000.0, 15.0, 1);
  benchLinks(said('3000 players in one room of 1 km, 15 m/s, the live mix'), sz(3000), 1, 1000.0, 15.0, 1);
  benchLinks(said('2000 players on one spot of 10 m, the live mix'), sz(2000), 1, 10.0, 0.5, 1);
  benchLinks(said('12000 players in one room of 4 km, 15 m/s, the live mix'), sz(12000), 1, 4000.0, 15.0, 1);
});

test('bench 4000 players', { skip: SKIP }, () => {
  benchMoving(said('4000 players in one room of 3 km, 15 m/s'), sz(4000), 1, 3000.0, 15.0);
  benchMoving(said('4000 players in one room of 3 km, 40 m/s'), sz(4000), 1, 3000.0, 40.0);
  benchMoving(said('4000 players on one spot of 10 m'), sz(4000), 1, 10.0, 0.5);
});

// each crowd without blocks, then with 1 player in 20 blocking 10 others of its room (the same players, places and
// moves)
test('bench blocks', { skip: SKIP }, () => {
  const blocks = (rooms) => (i) => {
    if (i % 20 !== 0) return [];
    const out = [];
    for (let k = 1; k <= 10; k++) out.push('p' + ((i + k * 37 * rooms) % 2000));
    return out;
  };
  for (const [what, rooms, area, step] of [
    ['2000 players in one room of 3 km', 1, 3000.0, 15.0],
    ['2000 players in 8 rooms of 250', 8, 1000.0, 15.0],
    ['2000 players on one spot of 10 m', 1, 10.0, 0.5],
  ]) {
    benchWith(said(what + ', no blocks'), sz(2000), rooms, area, step, 0, () => [], () => []);
    benchWith(said(what + ', 100 blocking 10 each'), sz(2000), rooms, area, step, 0, () => [], blocks(rooms));
  }
});

/**
 * The minimap's questions (NEARREQ, roam_game.c near_*): players in one room of area m square, crowd of them in
 * 300 m square in its middle (a car park everyone drives to); 30 % standing, the rest at 5 to 30 m/s (15 in the
 * crowd) turning now and then; each one's SNAP to the hub every snapMs, its question every askMs for the 64 nearest
 * within radius m.  What a question costs the hub's thread (its answer made and sent), an answer's bytes and what it
 * placed, and the thread's time a second for questions, SNAPs and ticks.  (A car: p, h, s its speed, w how fast it
 * turns.)
 */
function benchNear(what, players, crowd, area, snapMs, askMs, radius) {
  const k = new Kit({ maxPlayers: 16384 });
  const r = new Lcg(11);
  const vip = (i) => 0x0a4d0100 + i;
  const cars = [];
  for (let i = 0; i < players; i++) {
    const side = i < crowd ? 300.0 : area;
    const fast = i < crowd ? 15.0 : 30.0;
    const s = r.unit() < 0.3 ? 0.0 : 5.0 + r.unit() * (fast - 5.0);
    const p = [r.unit() * side - side / 2.0, r.unit() * side - side / 2.0];
    cars.push({ p, h: r.unit() * TAU, s, w: 0.0 });
  }
  const hellos = [];
  for (let i = 0; i < players; i++) hellos.push(frame(vip(i), helloWith(1000 + i, { core: 9 })));
  const step = 50.0, secs = 16.0, warm = 4.0;
  let asked = 0, answered = 0, bytes = 0, placed = 0, gone = 0, near = 0;
  let askS = 0.0, snapS = 0.0, tickS = 0.0, snaps = 0, ticks = 0;
  const held = new Array(players).fill(0);
  const req = new Array(players).fill(0);
  const n = Math.trunc((secs * 1000.0) / step);
  for (let t = 0; t < n; t++) {
    const ms = t * step;
    const counting = ms >= warm * 1000.0;
    for (const c of cars) {
      if (r.unit() < step / 4000.0) c.w = r.unit() < 0.5 ? 0.0 : (r.unit() * 2.0 - 1.0) * 0.5;
      c.h += (c.w * step) / 1000.0;
      c.p[0] += (c.s * Math.cos(c.h) * step) / 1000.0;
      c.p[1] += (c.s * Math.sin(c.h) * step) / 1000.0;
      if (Math.abs(c.p[0]) > area / 2.0 || Math.abs(c.p[1]) > area / 2.0) c.h += Math.PI;
    }
    // each player's HELLO every second, SNAP every snapMs, question every askMs, at a phase of its own
    let t0 = nowMs();
    for (let i = 0; i < players; i++) {
      const phase = (i * 7.0) % 1000.0;
      if ((ms + phase) % 1000.0 < step) k.hub.frame(vip(i), hellos[i]);
      if ((ms + phase) % snapMs < step) {
        const c = cars[i];
        const v = [c.s * Math.cos(c.h), c.s * Math.sin(c.h), 0.0];
        k.hub.frame(vip(i), frame(vip(i), snapMoving(1000 + i, [c.p[0], c.p[1], 0.0], v, c.h, 2)));
        snaps += counting ? 1 : 0;
      }
    }
    if (counting) snapS += (nowMs() - t0) / 1000.0;
    if (t % Math.trunc(500.0 / step) === 0) {
      t0 = nowMs();
      k.hub.tick();
      if (counting) {
        tickS += (nowMs() - t0) / 1000.0;
        ticks++;
      }
    }
    k.clear();
    const askers = [];
    t0 = nowMs();
    for (let i = 0; i < players; i++) {
      const phase = (i * 13.0) % askMs;
      if ((ms + phase) % askMs < step) {
        req[i] = Math.max((req[i] + 1) & 0xffff, 1);
        k.hub.frame(vip(i), frame(vip(i), nearreq(1000 + i, req[i], 64, held[i], radius)));
        askers.push(i);
      }
    }
    if (counting) {
      askS += (nowMs() - t0) / 1000.0;
      asked += askers.length;
    }
    for (const [to, f] of k.sent) {
      const m = neardOf(f);
      if (m === null) continue;
      const i = to - vip(0);
      held[i] = m[0];
      if (counting) {
        answered++;
        bytes += f.length - 16;
        placed += m[5].filter((e) => e[1] !== null).length;
        gone += m[5].filter((e) => e[1] === null).length;
        near += m[4];
      }
    }
    k.step(step);
  }
  const a = Math.max(answered, 1);
  const span = secs - warm;
  console.log(
    what + ': a question ' + fixed((askS * 1e9) / Math.max(asked, 1), 0) + ' ns, ' + answered + ' answers of ' + asked + ': ' +
      fixed(bytes / a, 0) + ' B each (' + fixed(placed / a, 1) + ' placed, ' + fixed(gone / a, 1) + ' gone, ' + fixed(near / a, 0) + ' near); ' +
      'a SNAP ' + fixed((snapS * 1e9) / Math.max(snaps, 1), 0) + ' ns, a tick ' + fixed((tickS * 1e3) / Math.max(ticks, 1), 2) + " ms; the hub's thread a second: questions " +
      fixed((askS * 1e3) / span, 1) + ' ms, SNAPs and HELLOs ' + fixed((snapS * 1e3) / span, 1) + ' ms, ticks ' + fixed((tickS * 1e3) / span, 1) + ' ms; ' +
      'answers ' + fixed(bytes / span / 1000.0, 0) + ' kB/s',
  );
}

test('bench near minimap', { skip: SKIP }, () => {
  for (const [askMs, radius] of [[250.0, 660], [250.0, 350], [250.0, 200]]) {
    const at = 'questions ' + askMs + ' ms within ' + radius + ' m';
    benchNear(said('3000 in 4 km, 500 in 300 m; ' + at), sz(3000), sz(500), 4000.0, 500.0, askMs, radius);
    benchNear(said('12000 in 4 km, 1000 in 300 m; ' + at), sz(12000), sz(1000), 4000.0, 500.0, askMs, radius);
    benchNear(said('12000 in 8 km, 1000 in 300 m; ' + at), sz(12000), sz(1000), 8000.0, 500.0, askMs, radius);
  }
});

// 2000 to 24000 players in one room, and 8000 to 24000 in a smaller one and in 8 rooms: what a tick costs up to the
// switch's 24000 players (BENCH_THREADS=1: the walks on the hub's thread alone)
test('bench scale', { skip: SKIP }, () => {
  for (const n of [2000, 4000, 6000, 8000, 12000, 16000, 20000, 24000]) {
    benchLinks(said(n + ' players in one room of 8 km, 15 m/s, 32 links'), sz(n), 1, 8000.0, 15.0, 32);
  }
  for (const n of [8000, 16000, 24000]) {
    benchLinks(said(n + ' players in one room of 3 km, 15 m/s, 32 links'), sz(n), 1, 3000.0, 15.0, 32);
    benchLinks(said(n + ' players in 8 rooms of 4 km, 15 m/s, 32 links'), sz(n), 8, 4000.0, 15.0, 32);
  }
});

/**
 * The world map's questions (MAPREQ, roam_core.c rc_ask_map): players in one room area m across driving about (30 %
 * standing), open of them with the map open, each asking every 250 ms (roam_game.c WM_LIVE_US) for 4096 with flags
 * from the answer it holds (1: who is parked, and heights, in 16 datagrams at most, as a page before; 3: in 48).  What
 * a question costs the hub's thread (its answer made and sent), an answer's bytes and what it placed, the first
 * answer's (from nothing), the thread's time a second for the questions, and the bytes a second to the open maps.
 */
function benchMap(what, players, open, area, flags) {
  const k = new Kit({ maxPlayers: 16384 });
  const r = new Lcg(13);
  const vip = (i) => 0x0a4d0100 + i;
  const cars = [];
  for (let i = 0; i < players; i++) {
    const s = r.unit() < 0.3 ? 0.0 : 5.0 + r.unit() * 25.0;
    const p = [r.unit() * area - area / 2.0, r.unit() * area - area / 2.0];
    cars.push({ p, h: r.unit() * TAU, s, w: 0.0 });
  }
  const hellos = [];
  for (let i = 0; i < players; i++) hellos.push(frame(vip(i), hello(1000 + i)));
  // (the maps open once everyone is in, at opens s; counted from warm s)
  const step = 50.0, secs = 18.0, opens = 2.0, warm = 6.0, askMs = 250.0;
  let asked = 0, answered = 0, bytes = 0, placed = 0, gone = 0;
  let firstB = 0, firsts = 0, askS = 0.0;
  const held = new Array(open).fill(0);
  const req = new Array(open).fill(0);
  const n = Math.trunc((secs * 1000.0) / step);
  for (let t = 0; t < n; t++) {
    const ms = t * step;
    const counting = ms >= warm * 1000.0, asking = ms >= opens * 1000.0;
    for (const c of cars) {
      if (r.unit() < step / 4000.0) c.w = r.unit() < 0.5 ? 0.0 : (r.unit() * 2.0 - 1.0) * 0.5;
      c.h += (c.w * step) / 1000.0;
      c.p[0] += (c.s * Math.cos(c.h) * step) / 1000.0;
      c.p[1] += (c.s * Math.sin(c.h) * step) / 1000.0;
      if (Math.abs(c.p[0]) > area / 2.0 || Math.abs(c.p[1]) > area / 2.0) c.h += Math.PI;
    }
    for (let i = 0; i < players; i++) {
      const phase = (i * 7.0) % 1000.0;
      if ((ms + phase) % 1000.0 < step) k.hub.frame(vip(i), hellos[i]);
      if ((ms + phase) % 500.0 < step) {
        const c = cars[i];
        const v = [c.s * Math.cos(c.h), c.s * Math.sin(c.h), 0.0];
        k.hub.frame(vip(i), frame(vip(i), snapMoving(1000 + i, [c.p[0], c.p[1], 0.0], v, c.h, 2)));
      }
    }
    if (t % Math.trunc(500.0 / step) === 0) k.hub.tick();
    k.clear();
    const t0 = nowMs();
    let nowAsked = 0;
    for (let i = 0; i < open; i++) {
      const phase = (i * 13.0) % askMs;
      if (asking && (ms + phase) % askMs < step) {
        req[i] = Math.max((req[i] + 1) & 0xffff, 1);
        k.hub.frame(vip(i), frame(vip(i), mapreqFlags(1000 + i, req[i], 4096, held[i], flags)));
        nowAsked++;
      }
    }
    if (counting) {
      askS += (nowMs() - t0) / 1000.0;
      asked += nowAsked;
    }
    // (the answers from nothing, at any time: the map as it opens; the others after the warm-up)
    for (const [to, f] of k.sent) {
      const m = mapdOf(f);
      if (m === null) continue;
      if (m[2] + 1 === m[3]) held[to - vip(0)] = m[0];
      if (m[1] === 0) {
        firsts += m[2] === 0 ? 1 : 0;
        firstB += f.length - 16;
      } else if (counting) {
        answered += m[2] === 0 ? 1 : 0;
        bytes += f.length - 16;
        placed += m[5].filter((e) => e[1] !== null).length;
        gone += m[5].filter((e) => e[1] === null).length;
      }
    }
    k.step(step);
  }
  const a = Math.max(answered, 1);
  const span = secs - warm;
  console.log(
    what + ': the first answer ' + fixed(firstB / Math.max(firsts, 1) / 1000.0, 1) + ' kB; then a question ' + fixed((askS * 1e6) / Math.max(asked, 1), 0) +
      ' µs, ' + answered + ' answers of ' + asked + ': ' + fixed(bytes / a, 0) + ' B each (' + fixed(placed / a, 1) + ' placed, ' + fixed(gone / a, 1) +
      " gone); the hub's thread " + fixed((askS * 1e3) / span, 1) + ' ms a second; to the open maps ' + fixed(bytes / span / 1000.0, 0) + ' kB/s, ' +
      fixed(bytes / span / 1000.0 / open, 2) + ' kB/s each',
  );
}

test('bench map 4096', { skip: SKIP }, () => {
  for (const [players, open] of [[2500, 125], [4000, 200], [8000, 400], [12000, 600]]) {
    for (const [flags, page] of [[1, 'a page before (16 datagrams)'], [3, 'wide (48)']]) {
      benchMap(said(players + ' in 4 km, ' + open + ' maps open, ' + page), sz(players), sz(open), 4000.0, flags);
    }
  }
});

