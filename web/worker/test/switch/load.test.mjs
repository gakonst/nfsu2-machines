// tests/load.rs: the switch under free roam's load, scaled down and in virtual time.  The Rust test (ignored by default,
// run in release) put N = 120, 480 and 1000 players in free roam on pages that take bundles, each sending 20 bundles a
// second, a snapshot of 94 bytes to its 32 friends in each (free roam's most common case), and printed the
// deliveries a second, the messages they came in, the switch's ping, the CPU of its threads and the shed, limited and
// cut counts; it asserted nothing.  Here the same crowd runs (NFSU2_LOAD_N picks the sizes, default 40, 120 and 480;
// NFSU2_LOAD_N=120,480,1000 runs the Rust sizes, about 5 s;
// NFSU2_LOAD_SECS the measured seconds, default 2, after 1 s to warm up) and the rules it was run to watch are
// asserted: every datagram sent reaches every friend (nothing lost, nothing shed, nothing limited, nobody cut), the
// frames routed are the destinations paid for, the receivers' queues stay within what one bundle tick holds, the
// datagrams come in bundles, and the switch's {"t":"ping"} comes back within a bundle tick.  CPU and threads (the
// /proc/self/task counts, the switch's and the players' runtimes) have no meaning on one virtual clock: not measured.

import test from 'node:test';
import assert from 'node:assert/strict';

import { start, rawWs, sleep, now, world, resetWorld, frameOf, bundleOf, q, str } from './harness.js';
import { Prng } from '../../src/util/prng.js';

const FRIENDS = 32;
const HZ = 20;
const SNAP = 94;

/** a player on the switch: its socket (it reads everything at once), its address */
function join(sw, i) {
  const s = rawWs(sw, '?g=p' + i, Infinity);
  const w = s.got.map((m) => (m.op === 'text' ? JSON.parse(str(m.data)) : null)).find((m) => m && m.t === 'welcome');
  assert.ok(w, 'the welcome');
  s.got.length = 0;
  s.text(JSON.stringify({ t: 'hello', name: 'P' + i, lan: 0, bundle: 1 }));
  return [s, w.vip >>> 0];
}

function crowd(sw, n, warmMs, runMs, seed) {
  const W = world();
  const rnd = new Prng(seed);
  const players = [];
  for (let i = 0; i < n; i++) players.push(join(sw, i));
  const vips = players.map((p) => p[1]);
  const friends = Math.min(FRIENDS, n - 1);
  const counts = { delivered: 0, messages: 0, sent: 0 };
  const got = new Array(n).fill(0);
  let stopped = false;
  const t0 = now() + 200;
  players.forEach(([s], i) => {
    // a snapshot to the next 32 players round the ring, in one bundle entry (n = 32)
    const to = Array.from({ length: friends }, (_, k) => vips[(i + k + 1) % n]);
    const snap = frameOf(0, new Uint8Array(SNAP - 16).fill(i & 255), 1, 47210, 47210);
    const bundle = bundleOf([[snap, to]]);
    // each player's ticks at a phase of its own, at random
    const phase = rnd.below(1_000_000 / HZ) / 1000;
    const tick = () => {
      if (stopped || s.gone) return;
      s.binary(bundle);
      counts.sent++;
      W.at(now() + 1000 / HZ, tick);
    };
    W.at(t0 + phase, tick);
    s._arrive = (m) => {
      if (m.op !== 'binary' || m.data.length === 0) return;
      const p = m.data;
      counts.messages++;
      let d = 0;
      if (p[0] !== 32) d = 1;
      else {
        let at = 4;
        while (at + 4 <= p.length) {
          const f = at + 4 + 4 * p[at];
          at = f + ((p[at + 2] << 8) | p[at + 3]);
          d++;
        }
      }
      counts.delivered += d;
      got[i] += d;
    };
  });
  // the switch's ping as a page measures it ({"t":"ping"} and its pong), every 100 ms from a player of its own
  const [probe] = join(sw, n);
  const lat = [];
  let id = 0, asked = null, pings = 0;
  probe._arrive = (m) => {
    if (m.op !== 'text') return;
    const v = JSON.parse(str(m.data));
    if (v.t === 'pong' && asked && v.id === asked.id) {
      lat.push(now() - asked.at);
      asked = null;
      W.at(now() + 100, ping);
    }
  };
  const ping = () => {
    if (stopped) return;
    asked = { id: id++, at: now() };
    pings++;
    probe.text(JSON.stringify({ t: 'ping', id: asked.id }));
  };
  W.at(t0 + warmMs, ping);
  // the receivers' queues, every 10 ms: what waits for the writer (bytes queued and datagrams waiting for a bundle)
  let maxQueue = 0;
  const look = () => {
    if (stopped) return;
    for (const v of vips) {
      const p = sw.lan.table.get(v);
      if (p) maxQueue = Math.max(maxQueue, p.conn.buffered + p.conn.dgram);
    }
    W.at(now() + 10, look);
  };
  W.at(t0, look);
  sleep(t0 + warmMs - now());
  const [d0, m0, s0, f0] = [counts.delivered, counts.messages, counts.sent, sw.info().frames];
  const got0 = got.slice();
  sleep(runMs);
  const [d1, m1, s1, f1] = [counts.delivered, counts.messages, counts.sent, sw.info().frames];
  const got1 = got.slice();
  const secs = runMs / 1000;
  stopped = true;
  // what was sent last is delivered within a bundle tick (70 ms at most with its jitter)
  sleep(200);
  const info = sw.info();
  const per = (a, b) => (b - a) / secs;
  lat.sort((a, b) => a - b);
  console.log(n + ' players: ' + per(d0, d1).toFixed(0) + ' deliveries/s (of ' + n * friends * HZ + '), ' + per(s0, s1).toFixed(0) +
    ' bundles in/s, ' + per(f0, f1).toFixed(0) + ' frames routed/s, ' + per(m0, m1).toFixed(0) + ' messages out/s (' +
    ((d1 - d0) / Math.max(m1 - m0, 1)).toFixed(1) + ' datagrams each); switch ping p50/p90/p99 ' +
    (lat.length ? q(lat, 0.5) + ' / ' + q(lat, 0.9) + ' / ' + q(lat, 0.99) + ' ms' : 'none') + '; largest queue ' + maxQueue +
    ' bytes; shed ' + info.shed + ', limited ' + info.limited + ', cuts ' + JSON.stringify(info.cuts));
  // nothing lost: every bundle sent reached each of its friends
  assert.equal(counts.delivered, counts.sent * friends, 'every datagram sent was delivered to every friend');
  // the rate: N x 640 a second (each player's 20 bundles a second at their phases: a tick at most either side)
  assert.ok(Math.abs(per(s0, s1) - n * HZ) <= n / secs, 'bundles in/s ' + per(s0, s1));
  assert.ok(Math.abs(per(d0, d1) - n * friends * HZ) <= (n * friends * 3) / secs, 'deliveries/s ' + per(d0, d1));
  // everyone got its friends' frames: 32 friends x 20 a second, give or take the ticks at the window's ends
  for (let i = 0; i < n; i++) {
    const g = got1[i] - got0[i];
    assert.ok(Math.abs(g - friends * HZ * secs) <= friends * 3, 'player ' + i + ' got ' + g + ' of ' + friends * HZ * secs);
  }
  // the frames routed are the destinations paid for: each bundle entry's 32
  assert.equal(f1 - f0, (s1 - s0) * friends, 'frames routed');
  assert.equal(info.shed, 0, 'nothing shed');
  assert.equal(info.limited, 0, 'nobody over its budgets');
  assert.equal(info.dropped, 0, 'nothing dropped');
  assert.deepEqual(Object.values(info.cuts).filter((x) => x !== 0), [], 'nobody cut: ' + JSON.stringify(info.cuts));
  assert.equal(sw.peers().length, n + 1, 'everyone still on');
  // the queues stay within a bundle tick's worth: 70 ms (50 ms and its jitter of 40 %) of each friend's snapshots, at
  // most two of them, as bundle entries of 4 + 94 bytes; far under roamQueue (128 KiB) where shedding starts
  assert.ok(maxQueue <= friends * 2 * (4 + SNAP), 'largest queue ' + maxQueue);
  // they come in bundles: a message holds about a tick's worth of the friends' snapshots
  assert.ok((d1 - d0) / Math.max(m1 - m0, 1) > friends / 4, 'datagrams a message ' + (d1 - d0) / Math.max(m1 - m0, 1));
  // the switch's ping comes back at once (a control message does not wait for the bundle clock)
  assert.ok(pings >= (runMs / 100) * 0.9 && lat.length >= pings - 1, pings + ' pings, ' + lat.length + ' answered');
  assert.ok(q(lat, 0.99) < 50, 'switch ping p99 ' + q(lat, 0.99) + ' ms');
  for (const [s] of players) s.drop();
  probe.drop();
}

test('free_roam_crowd_on_the_switch', () => {
  const sizes = process.env.NFSU2_LOAD_N ? process.env.NFSU2_LOAD_N.split(',').map((x) => Number(x.trim())).filter((x) => x > 1) : [40, 120, 480];
  const secs = Number(process.env.NFSU2_LOAD_SECS) || 2;
  for (const n of sizes) {
    resetWorld();
    const sw = start({ maxPeers: 24000 });
    crowd(sw, n, 1000, secs * 1000, 0x10ad + n);
    sw.close();
  }
});

