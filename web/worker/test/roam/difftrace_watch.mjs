// Differential check of src/roam/watch.js and src/roam/results.js against the Rust server's own watch.rs and
// results.rs: seeded random traces (SNAP sequences, race reports) run through both, every Seen, line, summary,
// outcome, verdict and log line compared exactly (floats by their bits).
//
// The Rust side is a scratch crate whose sources live in test/roam/rust-watch-diff/ (main.rs drives the server's
// watch.rs, results.rs and jumps.rs by #[path], nfsu2-anticheat by path; wire.rs's RaceRes/ResRow and nfsu2-util's
// vip_str are stand-ins).  Build it outside the repo, from the repo root:
//
//   CARGO_TARGET_DIR=/tmp/watchdiff-target cargo build --release \
//     --manifest-path web/worker/test/roam/rust-watch-diff/Cargo.toml
//
// then run (from web/worker):  node test/roam/difftrace_watch.mjs   (DIFF_CASES=n cases of each kind, default 2000;
// DIFF_SEED=s the first seed).  Without the binary the test skips itself.
//
// Rust's HashMap of races is judged in no set order (results.js: in the order they came), so the traces never let two
// races come due in one judged call: each report is judged at once, and a race's wait runs out at its own call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Watch, line as watchLine, distance } from '../../src/roam/watch.js';
import { Results, resultLine, jumpLine, line as verdictLine, RESULTS_WAIT_MS, LOBBY_PLAYERS } from '../../src/roam/results.js';
import { EVENTS, SHOPS } from '../../src/roam/jumps.js';
import { hex8 } from '../../src/util/rustfmt.js';

const BIN = process.env.WATCHDIFF_BIN ?? '/tmp/watchdiff-target/release/watch-diff';
const TRACE = '/tmp/watchdiff-trace-' + process.pid + '.txt';
const CASES = Number(process.env.DIFF_CASES ?? 2000);
const SEED0 = Number(process.env.DIFF_SEED ?? 1);

// ---- encoding ----

const view = new DataView(new ArrayBuffer(8));
/** a float as its bits in hex (the trace's form) */
function fb(x) {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}
function bf(s) {
  view.setBigUint64(0, BigInt('0x' + s));
  return view.getFloat64(0);
}
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const sEnc = (s) => 's' + Array.from(enc.encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
function sDec(t) {
  assert.ok(t.startsWith('s'), 'a string token: ' + t);
  const h = t.slice(1);
  const b = new Uint8Array(h.length / 2);
  for (let k = 0; k < b.length; k++) b[k] = parseInt(h.slice(2 * k, 2 * k + 2), 16);
  return dec.decode(b);
}
/** a float as the outputs give it */
const fo = (x) => (Number.isNaN(x) ? 'NaN' : fb(x));
const ofo = (x) => (x === null ? null : fo(x));

// ---- a seeded PRNG (mulberry32: the traces are this file's own) ----

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    f: next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (a) => a[Math.floor(next() * a.length)],
    range: (lo, hi) => lo + next() * (hi - lo),
  };
  return r;
}

const NAME_CHARS = ['a', 'B', 'c', 'Z', 'x', ' ', '"', '\\', 'Σ', 'ß', 'İ', 'é', '1', '_', '\u0007', '"', 'Ω', '😀'];
function randName(r) {
  if (r.chance(0.5)) return r.pick(['Bob', 'Ann', 'QUAD69', 'mallory', 'Cid', 'ΣΙΣΥΦΟΣ', 'Ünal']);
  let s = '';
  const n = r.int(0, 8);
  for (let k = 0; k < n; k++) s += r.pick(NAME_CHARS);
  return s;
}

// ---- the watch traces ----

function genWatch(seed, out) {
  const r = rng(seed * 2 + 1);
  out.push('case ' + seed);
  const nw = r.int(1, 2);
  const st = [];
  for (let i = 0; i < nw; i++) {
    const now = r.chance(0.3) ? 0 : Math.round(r.range(0, 1e7));
    out.push('wnew ' + i + ' ' + fb(now));
    st.push({
      now,
      t: r.chance(0.2) ? (0xffffffff - r.int(0, 3_000_000)) >>> 0 : r.int(0, 0xffffffff),
      clock: r.chance(0.2) ? 255 : r.int(0, 255),
      p: [r.range(-3000, 3000), r.range(-2500, 3000), r.range(0, 60)],
      vip: r.int(0, 0xffffffff),
      name: randName(r),
      mode: 'drive',
      left: 0,
      speed: 50,
      dir: r.range(0, 2 * Math.PI),
      rate: 1,
    });
  }
  const steps = r.int(20, r.chance(0.3) ? 1600 : 400);
  const q = r.chance(0.5); // quantized values: exact ties at the rules' edges
  for (let k = 0; k < steps; k++) {
    const i = r.int(0, nw - 1);
    const s = st[i];
    if (s.left <= 0) {
      s.mode = r.pick(['drive', 'drive', 'drive', 'fast', 'jump', 'clock', 'held', 'stall', 'epoch', 'older', 'reset', 'silence', 'map', 'short', 'odd']);
      s.left = s.mode === 'clock' ? r.int(60, 400) : r.int(1, s.mode === 'drive' ? 200 : 12);
      s.speed = s.mode === 'fast' ? r.range(120, 220) : r.range(0, 130);
      s.dir = r.range(0, 2 * Math.PI);
      s.rate = r.pick([1.0, 1.2, 1.3, 1.4, 2.0, 3.0, r.range(0.5, 3)]);
    }
    s.left--;
    let recv = q ? r.pick([500, 500, 250, 750, 1, 1000]) : r.range(400, 600);
    let own = recv;
    let p = s.p.slice();
    const move = (ms) => {
      const d = (s.speed * ms) / 1000;
      p = [p[0] + Math.cos(s.dir) * d, p[1] + Math.sin(s.dir) * d, p[2] + r.range(-1, 1)];
      if (q) p = p.map((v) => Math.round(v * 2) / 2);
    };
    let beside = r.chance(0.04);
    switch (s.mode) {
      case 'drive':
      case 'fast':
        move(recv);
        break;
      case 'jump':
        p = [r.range(-3000, 3000), r.range(-2500, 3000), r.range(0, 60)];
        break;
      case 'map': {
        const t = r.chance(0.6) ? r.pick(EVENTS) : r.pick(SHOPS);
        const a = r.range(0, 2 * Math.PI);
        const d = r.pick([0, 15, 24.9, 25, 25.1, 39, 44.9, 45, 45.1, r.range(0, 60)]);
        p = [t[0] + Math.cos(a) * d, t[1] + Math.sin(a) * d, r.range(0, 40)];
        if (r.chance(0.3)) p = [t[0] + d, t[1], 10];
        break;
      }
      case 'short':
        s.dir = r.range(0, 2 * Math.PI);
        s.speed = r.pick([290 * 2, 300 * 2, 250 * 2, 400 * 2]);
        move(recv);
        break;
      case 'clock':
        own = recv * s.rate;
        move(recv);
        break;
      case 'held':
        own = recv;
        recv = r.chance(0.7) ? 1 : r.range(1000, 12000);
        move(own);
        break;
      case 'stall':
        recv = r.pick([6500, 1, 12000]);
        own = r.pick([500, 6000, 12000]);
        move(own);
        break;
      case 'epoch':
        s.clock = (s.clock + (r.chance(0.8) ? 1 : r.int(1, 255))) & 255;
        s.t = r.int(0, 0xffffffff);
        own = 0;
        move(recv);
        break;
      case 'older':
        own = -r.pick([500, 1000, 6000, r.range(1, 1e6)]);
        if (r.chance(0.3)) s.clock = (s.clock - 1) & 255;
        recv = r.pick([1, 10, 500]);
        break;
      case 'reset':
        out.push('reset ' + i);
        s.left = 0;
        break;
      case 'silence':
        recv = r.pick([20_000, 60_000, 200_000, r.range(10_000, 3_000_000)]);
        own = r.chance(0.5) ? recv : r.range(0, recv);
        move(recv);
        break;
      case 'odd': {
        const odd = r.pick([NaN, Infinity, -Infinity, -0, 0, 1e300, -1e-300]);
        p[r.int(0, 2)] = odd;
        if (r.chance(0.3)) recv = r.pick([0, -5, NaN]);
        break;
      }
    }
    s.now += recv;
    s.t = (s.t + Math.trunc(Math.max(own, -4e9) * 1000)) >>> 0;
    s.p = p.map((v) => (Number.isFinite(v) ? v : 0));
    // (the hub's near ones: a few, sometimes)
    const np = r.chance(0.2) ? r.int(1, 3) : 0;
    const near = [];
    for (let n = 0; n < np; n++) near.push(fb(r.chance(0.5) ? r.range(0, 40) : r.pick([0, 999.9, 1000, 1500])) + ' ' + sEnc(randName(r)) + ' ' + r.int(0, 0xffffffff));
    const all = np + (r.chance(0.3) ? r.int(1, 5) : 0);
    const lobby = r.chance(0.1) ? sEnc(randName(r)) : '-';
    out.push(['snap', i, fb(s.now), fb(p[0]), fb(p[1]), fb(p[2]), s.t, s.clock, beside ? 1 : 0, s.vip, sEnc(s.name), all, lobby, np, ...near].join(' '));
    if (r.chance(0.02)) out.push('wline ' + i + ' ' + fb(s.now + r.range(0, 300000)));
    if (r.chance(0.05)) out.push('sum ' + i + ' ' + s.vip + ' ' + sEnc(s.name) + ' ' + fb(s.now) + ' 0');
    if (r.chance(0.01)) out.push('dist ' + [p[0], p[1], p[2], s.p[0] + 3, s.p[1], -s.p[2]].map(fb).join(' '));
  }
  for (let i = 0; i < nw; i++) out.push('sum ' + i + ' ' + st[i].vip + ' ' + sEnc(st[i].name) + ' ' + fb(st[i].now + r.range(0, 1e6)) + ' 1');
}

// ---- the results traces ----

function genResults(seed, out) {
  const r = rng(seed * 2 + 2);
  out.push('case ' + seed);
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, 0, 0xfffffffe, 0x7dcff53a];
  const idOf = () => (r.chance(0.95) ? r.int(1, 8) : r.pick(ids));
  // who: names as the hub writes them, and odd ones
  for (const id of ids) {
    if (r.chance(0.85)) {
      const n = randName(r);
      const w = r.chance(0.8) ? '10.77.0.' + (id & 255) + ' "' + n + '"' : r.pick([n, n + '""', ' "' + n, '"' + n + '"', 'x " y "z"']);
      out.push('who ' + id + ' ' + sEnc(w));
    }
  }
  const events = []; // [time, order, line]
  let now = r.int(0, 1_000_000);
  const tracks = Array.from({ length: r.int(1, 3) }, () => ({ race: r.chance(0.8) ? 0x0badf00d + r.int(0, 2) : r.int(1, 0xffffffff), t: r.range(20, 450), laps: r.pick([0, 1, 2, 3]) }));
  const races = r.int(3, 70);
  let ev = 0;
  const push = (time, order, l) => events.push([time, order, ev++, l]);
  for (let k = 0; k < races; k++) {
    const tr = r.pick(tracks);
    const lobby = r.chance(0.7) ? r.int(1, 12) : r.int(1, 0xffffffff);
    const mode = r.pick([1, 1, 1, 0, 0, 2, 3, 4, 10, 7]);
    const heats = r.chance(0.2) ? 3 : 0;
    const heat = heats ? r.int(1, 3) : 0;
    const laps = r.chance(0.9) ? tr.laps : r.int(0, 5);
    const n = r.int(1, LOBBY_PLAYERS);
    const racers = [];
    for (let m = 0; m < n; m++) {
      let id = idOf();
      if (racers.some((x) => x.id === id) && r.chance(0.9)) id = (100 + m) >>> 0;
      racers.push({ id, t: tr.t * r.range(0.9, 1.4) });
    }
    // a cheater: far quicker, a short way, or a game that ended the race
    const cheat = r.chance(0.3) ? r.int(0, n - 1) : -1;
    if (cheat >= 0) racers[cheat].t = tr.t * r.pick([0.1, 0.3, 0.45, 0.6, 0.69, 0.71]);
    if (r.chance(0.5)) racers.forEach((x) => (x.t = Math.round(x.t * 100) / 100));
    const ended = r.chance(0.12);
    const e0 = r.pick([4.76, 5, 1, r.range(0.5, 8)]);
    const first = Math.min(...racers.map((x) => x.t));
    const dist = r.range(1000, 20000);
    const rowsOf = (by) =>
      racers.map((x, m) => {
        let fin = !ended && (x.t <= first + 30 || r.chance(0.1));
        let time = fin ? x.t : first + r.pick([30, 25, 24.9, r.range(0, 40)]);
        if (ended) time = m === 0 ? e0 : e0 + r.pick([25, 25, 30, 24.99, 20, r.range(20, 40)]);
        let done = fin ? Math.max(laps, 1) : r.range(0, Math.max(laps, 1));
        if (m === cheat && r.chance(0.4)) done = r.pick([0.006, 0.4, 0.49, 0.5, 0.95]);
        let d = fin ? dist * r.range(0.99, 1.01) : dist * r.range(0, 1);
        if (m === cheat && r.chance(0.5)) d = r.range(10, 2000);
        let jump = x.id === by ? 0 : r.chance(0.85) ? r.range(0, 50) : r.pick([150, 149.9, 279.9, r.range(100, 500)]);
        if (r.chance(0.05)) time = r.pick([0, -1, NaN, Infinity, 1e-9]);
        if (r.chance(0.03)) done = r.pick([NaN, Infinity, -1]);
        if (r.chance(0.03)) d = r.pick([NaN, 0, -5, Infinity]);
        if (r.chance(0.03)) fin = !fin;
        let flags = (fin ? 1 : 0) | (x.id === by ? 2 : 0);
        if (r.chance(0.02)) flags = r.int(0, 255);
        return { id: x.id, flags, time, done, dist: d, jump };
      });
    const reporters = racers.filter(() => r.chance(0.8)).map((x) => x.id);
    if (r.chance(0.1)) reporters.push(r.pick(ids));
    if (r.chance(0.1) && reporters.length) reporters.push(reporters[0]);
    const shared = r.chance(0.2);
    for (const by of reporters) {
      now += r.chance(0.1) ? r.int(80_000, 200_000) : r.int(1, 6000);
      let rows = rowsOf(by);
      if (r.chance(0.1)) rows.reverse();
      if (r.chance(0.05)) rows[0] = { ...rows[0], time: rows[0].time * 0.1, flags: rows[0].flags | 1 };
      let rn = rows.length;
      if (r.chance(0.05)) rn = r.int(1, rows.length);
      while (rows.length < LOBBY_PLAYERS) rows.push({ id: r.chance(0.8) ? 0 : idOf(), flags: r.int(0, 3), time: r.range(0, 500), done: r.range(0, 3), dist: r.range(0, 9000), jump: r.range(0, 400) });
      const client = shared ? 'one' : r.chance(0.05) ? 'client ' + r.int(1, 3) : 'client ' + by;
      const rowToks = rows.flatMap((x) => [x.id >>> 0, x.flags, fb(x.time), fb(x.done), fb(x.dist), fb(x.jump)]);
      push(now, 1, ['add', fb(now), by >>> 0, sEnc(client), lobby, tr.race, mode, laps, heat, heats, rn, ...rowToks].join(' '));
      push(now, 2, 'judged ' + fb(now));
      push(now + RESULTS_WAIT_MS, 0, 'judged ' + fb(now + RESULTS_WAIT_MS));
      if (r.chance(0.05)) push(now, 3, 'who ' + idOf() + ' ' + (r.chance(0.5) ? '-' : sEnc('10.77.0.9 "' + randName(r) + '"')));
    }
    if (r.chance(0.3)) now += r.int(0, 100_000);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  for (const e of events) out.push(e[3]);
}

// ---- the JS side: the same trace, the same outputs ----

const seenJ = (s) =>
  s === null ? null
  : s.kind === 'jump' ? ['jump', s.from.map(fo), s.to.map(fo), fo(s.d), fo(s.ms), fo(s.over)]
  : s.kind === 'fast' ? ['fast', s.from.map(fo), s.to.map(fo), fo(s.mps), fo(s.ms)]
  : ['clock', fo(s.rate), fo(s.ms)];
const namesJ = (m) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => [k, n]);

function runJs(lines) {
  const out = [];
  let watches = new Map();
  let res = new Results();
  let who = new Map();
  for (const l of lines) {
    const t = l.split(' ').filter((x) => x !== '');
    if (t.length === 0) continue;
    let k = 1;
    const tok = () => t[k++];
    const u = () => Number(tok());
    const f = () => bf(tok());
    const s = () => sDec(tok());
    const optS = () => (t[k] === '-' ? (k++, null) : s());
    switch (t[0]) {
      case 'case':
        watches = new Map();
        res = new Results();
        who = new Map();
        out.push(['case', u()]);
        break;
      case 'wnew': {
        const i = u();
        watches.set(i, new Watch(f()));
        break;
      }
      case 'reset':
        watches.get(u()).reset();
        break;
      case 'snap': {
        const i = u();
        const now = f();
        const p = [f(), f(), f()];
        const tUs = u() >>> 0, clock = u() & 255, beside = u() !== 0;
        const vip = u() >>> 0, name = s(), all = u(), lobby = optS();
        const np = u();
        const players = [];
        for (let n = 0; n < np; n++) players.push([f(), s(), u() >>> 0]);
        const w = watches.get(i);
        const got = w.snap(now, p, tUs, clock, beside);
        out.push(['snap', i, seenJ(got[0]), seenJ(got[1])]);
        for (const sn of got) {
          if (sn === null) continue;
          if (sn.kind === 'jump' && players.length > 0) w.landedNear();
          const may = w.line(now);
          out.push(['may', may]);
          if (may !== null) out.push(['line', watchLine(vip, name, sn, { players, all, lobby }, w.jumps, may)]);
        }
        break;
      }
      case 'sum': {
        const i = u();
        const vip = u() >>> 0, name = s(), now = f(), left = u() !== 0;
        const w = watches.get(i);
        out.push(['sum', i, w.summary(vip, name, now, left), w.jumps]);
        break;
      }
      case 'wline': {
        const i = u();
        out.push(['wline', watches.get(i).line(f())]);
        break;
      }
      case 'dist': {
        const a = [f(), f(), f()], b = [f(), f(), f()];
        out.push(['dist', fo(distance(a, b))]);
        break;
      }
      case 'who': {
        const id = u() >>> 0;
        const n = optS();
        if (n === null) who.delete(id);
        else who.set(id, n);
        break;
      }
      case 'add': {
        const now = f(), reporter = u() >>> 0, client = s();
        const r = { lobby: u() >>> 0, race: u() >>> 0, mode: u() & 255, laps: u() & 255, heat: u() & 255, heats: u() & 255, n: u(), rows: [] };
        for (let m = 0; m < LOBBY_PLAYERS; m++) r.rows.push({ id: u() >>> 0, flags: u() & 255, time: f(), done: f(), dist: f(), jump: f() });
        out.push(['add', res.add(now, reporter, client, r, (id) => who.get(id) ?? null)]);
        break;
      }
      case 'judged': {
        const j = res.judged(f());
        out.push(['judged', j.length]);
        for (const [o, v] of j) {
          const by = (id) => o.names.get(id) ?? hex8(id);
          out.push(['outcome', o.lobby, o.race, o.mode, o.laps, o.heat, o.heats, o.order.map(([id, tt]) => [id, ofo(tt)]), o.silent, o.reports, o.racers, namesJ(o.names), o.jumps.map((x) => [x.id, x.seen.map(fo), x.others, x.place])]);
          out.push(['race', resultLine(o, by)]);
          for (const x of o.jumps) out.push(['jumpline', jumpLine(o, x, by)]);
          if (v !== null) {
            const own = v.own === null ? null : [v.own.kind, v.own.t === null ? null : fo(v.own.t)];
            out.push(['verdict', v.lobby, v.race, v.mode, v.laps, v.heat, v.heats, v.winner, fo(v.time), ofo(v.length), ofo(v.avg), v.next === null ? null : [v.next[0], fo(v.next[1])], ofo(v.drove), ofo(v.quickest), v.third === null ? null : [fo(v.third[0]), v.third[1]], own, v.seen, v.reports, namesJ(v.names)]);
            out.push(['cheat', verdictLine(v, (id) => v.names.get(id) ?? hex8(id))]);
          }
        }
        break;
      }
      default:
        throw new Error('an op ' + t[0]);
    }
  }
  return out;
}

// ---- the run ----

const BATCH = 500;

function run() {
  const total = { lines: 0, bad: 0, report: [], stats: {}, kinds: {}, rustLines: 0, jsLines: 0 };
  for (let c0 = 0; c0 < CASES; c0 += BATCH) {
    const lines = [];
    const end = Math.min(CASES, c0 + BATCH);
    for (let c = c0; c < end; c++) genWatch(SEED0 + c, lines);
    for (let c = c0; c < end; c++) genResults(SEED0 + c, lines);
    const r = runBatch(lines);
    total.lines += r.lines;
    total.bad += r.bad;
    total.report.push(...r.report.slice(0, Math.max(0, 8 - total.report.length)));
    for (const [k, v] of Object.entries(r.stats)) total.stats[k] = (total.stats[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.kinds)) total.kinds[k] = (total.kinds[k] ?? 0) + v;
    total.rustLines += r.rustLines;
    total.jsLines += r.jsLines;
  }
  return total;
}

/** one batch of trace lines through both sides */
function runBatch(lines) {
  writeFileSync(TRACE, lines.join('\n') + '\n');
  const rs = spawnSync(BIN, [TRACE], { maxBuffer: 1 << 30, encoding: 'utf8' });
  rmSync(TRACE, { force: true });
  assert.equal(rs.status, 0, 'the Rust side failed: ' + rs.stderr);
  const rust = rs.stdout.split('\n').filter((l) => l !== '');
  const js = runJs(lines).map((v) => JSON.stringify(v));
  let bad = 0;
  let kase = '';
  const report = [];
  const stats = { snap: 0, seen: 0, line: 0, sum: 0, outcome: 0, verdict: 0, jumpline: 0 };
  const kinds = { teleport: 0, fast: 0, clock: 0, avg: 0, quickest: 0, third: 0, drove: 0, ownFirst: 0, ownFinished: 0, ownOut: 0, ownNone: 0 };
  const has = (b, re, key) => { if (re.test(b)) kinds[key]++; };
  const n = Math.max(rust.length, js.length);
  for (let k = 0; k < n; k++) {
    const a = rust[k] === undefined ? undefined : JSON.stringify(JSON.parse(rust[k]));
    const b = js[k];
    if (b && b.startsWith('["case"')) kase = b;
    if (b) {
      const op = JSON.parse(b)[0];
      if (op in stats) stats[op]++;
      if (op === 'snap') stats.seen += (b.match(/\["(jump|fast|clock)"/g) ?? []).length;
      if (op === 'line') {
        has(b, /: teleport \d/, 'teleport');
        has(b, /km\/h for /, 'fast');
        has(b, /clock ran/, 'clock');
      }
      if (op === 'cheat') {
        has(b, /which no car does/, 'avg');
        has(b, /quickest clean win/, 'quickest');
        has(b, /third quickest/, 'third');
        has(b, /having driven/, 'drove');
        has(b, /its own game: first/, 'ownFirst');
        has(b, /not first, finished/, 'ownFinished');
        has(b, /did not finish"\]$/, 'ownOut');
        has(b, /sent no report/, 'ownNone');
      }
    }
    if (a !== b) {
      bad++;
      if (report.length < 8) report.push(kase + ' line ' + k + ':\n  rust ' + a + '\n  js   ' + b);
      if (a === undefined || b === undefined) break;
    }
  }
  return { lines: n, bad, report, stats, kinds, rustLines: rust.length, jsLines: js.length };
}

test('watch.js and results.js match the Rust server, trace for trace', { skip: !existsSync(BIN) && 'no ' + BIN + ' (see the top of this file to build it)' }, () => {
  const r = run();
  console.log('difftrace: ' + CASES + ' watch cases and ' + CASES + ' results cases, ' + r.lines + ' output lines (' + JSON.stringify(r.stats) + ', lines by kind ' + JSON.stringify(r.kinds) + '), ' + r.bad + ' differences');
  assert.equal(r.bad, 0, r.report.join('\n'));
  assert.equal(r.rustLines, r.jsLines);
});
