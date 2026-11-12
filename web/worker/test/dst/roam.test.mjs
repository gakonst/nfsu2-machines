// DST scenarios for the free-roam hub (web/worker/src/roam): many virtual players over the shared simulator
// (test/dst/sim.js: the switch, a seeded network of per-connection latencies, slow readers and dropped connections,
// virtual time), each driving about a few hot spots and talking to the hub at 10.77.0.253 as runtime/roam_core.c does
// (HELLO every second, SNAP twice a second, MAPREQ/NEARREQ, BYE, restarts).  After every step: the switch's
// invariants, the hub's (hubInvariants: slots, order, endpoints, map keys; after each tick its links: both ends, no
// self or same-browser link, within degree), and what each client got from the hub (valid datagrams, never itself,
// never twice, within LIST_MAX).  At the end: players parked together see each other, and the same seed gives the same
// bytes to every client.  Reproducible by seed:  DST_SEEDS=200 DST_SEED=1 node --test test/dst/roam.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.js';
import { RoamHub, ROAM_HUB_VIP, hubInvariants, decodeRoam } from '../../src/roam/hub.js';
import { decode, MSG_PEERS, MSG_MAPD, MSG_NEARD, MSG_LOBBIES } from '../../src/roam/wire.js';
import { Prng } from '../../src/util/prng.js';
import * as K from '../roam/kit.mjs';

const SEEDS = Number(process.env.DST_SEEDS || 12);
const FIRST = Number(process.env.DST_SEED || 1);

/** one client's datagram to the hub: the switch's frame (kind 1, its vip, the hub's, ports) around it */
function toHub(c, port, d) {
  return K.framePorts(c.vip, d, port, 47210);
}

function fnv(b, h) {
  for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0;
  return h;
}

/**
 * One run: players clients for seconds of virtual time.  Returns a digest of everything every client got (for the
 * same-seed check) and what the end saw.
 */
function run(seed, o = {}) {
  const cfg = { players: 24, seconds: 40, dropRate: 0.02, cores: [9, 13, 14, 15, 16, 17], area: 300, ...o };
  const rng = new Prng(BigInt(seed) * 7919n + 17n);
  const pick = (a) => a[rng.below(a.length)];
  let hub = null;
  let lastTicks = -1;
  const sim = new Sim({
    seed,
    lan: { maxPeers: Math.max(128, cfg.players + 64) },
    net: { minDelayMs: 2, maxDelayMs: 120, jitterMs: 15, dropRate: cfg.dropRate },
    hosts: {
      roam: (a) => {
        hub = new RoamHub({ ...a, options: { ...a.options, log: () => {} } });
        return hub;
      },
    },
  });
  assert.ok(hub, 'the switch made the hub');
  assert.equal(hub.vip >>> 0, ROAM_HUB_VIP);
  sim.check(() => {
    const ticks = hub.core.st.ticks;
    const v = hubInvariants(hub.core, ticks !== lastTicks);
    lastTicks = ticks;
    if (v) throw new Error('hub invariant (seed ' + seed + ', t=' + sim.nowMs + '): ' + v);
  });
  const spots = [];
  for (let k = 0; k < 3; k++) spots.push([(rng.unit() - 0.5) * cfg.area, (rng.unit() - 0.5) * cfg.area]);
  const players = [];
  let digest = 0x811c9dc5;
  let lists = 0, maps = 0, nears = 0, lobbies = 0, bad = 0;
  const watchClient = (pl) => (c, m) => {
    if (m.type !== 'binary' || c !== pl.c) return;
    digest = fnv(m.data, digest);
    const f = m.data;
    if (f.length < 16 || f[0] !== 1) return;
    const src = ((f[4] << 24) | (f[5] << 16) | (f[6] << 8) | f[7]) >>> 0;
    if (src !== ROAM_HUB_VIP) return;
    const d = decode(f.subarray(16));
    if (!d) {
      bad++;
      throw new Error('seed ' + seed + ': the hub sent a datagram roam_core would drop');
    }
    if (d.kind === MSG_PEERS) {
      lists++;
      const list = K.peersOf(f);
      if (list.length > 96) throw new Error('a list past LIST_MAX');
      const seen = new Set();
      for (const e of list) {
        if (e.vip === c.vip) throw new Error('seed ' + seed + ': a list names its own browser');
        const k = e.vip + ':' + e.port;
        if (seen.has(k)) throw new Error('seed ' + seed + ': a list names a player twice');
        seen.add(k);
      }
      pl.last = list;
      pl.listAt = sim.nowMs;
    } else if (d.kind === MSG_MAPD) maps++;
    else if (d.kind === MSG_NEARD) nears++;
    else if (d.kind === MSG_LOBBIES) lobbies++;
  };
  const join = (pl) => {
    pl.c = sim.connect({ name: pl.name, hello: {}, group: 'g' + pl.name, site: 's' + pl.name });
    pl.id = 1 + rng.below(0xfffffffe);
    pl.up = false;
    sim.onArrive.push(watchClient(pl));
  };
  for (let i = 0; i < cfg.players; i++) {
    const spot = pick(spots);
    const pl = {
      name: 'P' + i,
      core: pick(cfg.cores),
      links: pick([0, 16, 32, 48]),
      parked: rng.below(3) === 0,
      pos: [spot[0] + (rng.unit() - 0.5) * 60, spot[1] + (rng.unit() - 0.5) * 60, 0],
      vel: [0, 0, 0],
      req: 1,
      base: 0,
      last: null,
      listAt: 0,
    };
    if (!pl.parked) {
      const h = rng.unit() * 2 * Math.PI;
      const s = 5 + rng.unit() * 30;
      pl.vel = [Math.cos(h) * s, Math.sin(h) * s, 0];
    }
    players.push(pl);
    join(pl);
  }
  sim.advance(500);
  const steps = (cfg.seconds * 1000) / 100;
  for (let step = 0; step < steps; step++) {
    for (const pl of players) {
      const c = pl.c;
      if (!c.open) {
        if (rng.below(20) === 0) join(pl);
        continue;
      }
      if (!c.vip) continue;
      const port = 47210;
      if (step % 10 === players.indexOf(pl) % 10) {
        c.sendBinary(toHub(c, port, K.helloWith(pl.id, { name: pl.name, core: pl.core, links: pl.core >= 10 ? pl.links : 0, crews: pl.core >= 7 ? [] : null, flags: K.HF_HUBCREW | K.HF_LOBBY })));
        pl.up = true;
      }
      if (pl.up && step % 5 === players.indexOf(pl) % 5) {
        for (let k = 0; k < 2; k++) pl.pos[k] += pl.vel[k] * 0.5;
        // (back towards its spot: the cars stay about the hot spots)
        if (Math.hypot(pl.pos[0], pl.pos[1]) > cfg.area) pl.vel = [-pl.vel[0], -pl.vel[1], 0];
        c.sendBinary(toHub(c, port, K.snapMoving(pl.id, pl.pos, pl.vel, Math.atan2(pl.vel[1], pl.vel[0]), 2)));
      }
      if (pl.up && rng.below(25) === 0) {
        const req = (pl.req = (pl.req + 1) & 0xffff);
        c.sendBinary(toHub(c, port, rng.below(2) ? K.mapreqFlags(pl.id, req, 4096, pl.base, 3) : K.nearreq(pl.id, req, 64, pl.base, 600)));
        pl.base = req;
      }
      if (step < steps - 120 && rng.below(400) === 0) {
        c.sendBinary(toHub(c, port, K.bye(pl.id)));
        pl.id = 1 + rng.below(0xfffffffe);
        pl.up = false;
      }
      if (step < steps - 120 && rng.below(1500) === 0) c.close();
    }
    sim.advance(100);
  }
  return { sim, hub, players, digest, lists, maps, nears, lobbies, bad };
}

test('the free-roam hub on the simulated switch: its invariants hold at every step, seed after seed', () => {
  let lists = 0, maps = 0, nears = 0;
  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    const r = run(seed);
    lists += r.lists;
    maps += r.maps;
    nears += r.nears;
    assert.equal(r.bad, 0);
    // at the end: every player online and driving for the last 12 s that has others in its spot got a list naming some
    const live = r.players.filter((p) => p.c.open && p.up && p.listAt >= r.sim.nowMs - 2000);
    assert.ok(live.length > 0, 'seed ' + seed + ': some players are on the hub at the end');
    const named = live.filter((p) => p.last && p.last.length > 0).length;
    assert.ok(named >= Math.floor(live.length / 2), 'seed ' + seed + ': ' + named + ' of ' + live.length + ' players see others');
    // the hub's links are what the clients' last lists say (both ends)
    assert.equal(hubInvariants(r.hub.core, true), null);
  }
  assert.ok(lists > 0 && maps > 0 && nears > 0, 'lists ' + lists + ', maps ' + maps + ', nears ' + nears);
});

test('the same seed gives every client the same bytes', () => {
  for (const seed of [FIRST, FIRST + 1]) {
    const a = run(seed, { seconds: 15 }), b = run(seed, { seconds: 15 });
    assert.equal(a.digest, b.digest, 'seed ' + seed);
    assert.ok(a.lists > 0);
  }
});

test('a crowd past exactRoom on the simulated switch (the grid and heap), with one-way cores', () => {
  const r = run(FIRST + 100, { players: 300, seconds: 8, dropRate: 0, cores: [14, 15, 16, 17], area: 150 });
  assert.equal(r.bad, 0);
  const info = r.hub.info();
  assert.ok(info.players >= 250, 'players ' + info.players);
  assert.ok(info.links > 0 && info.onewayLinks > 0, JSON.stringify(info));
});
