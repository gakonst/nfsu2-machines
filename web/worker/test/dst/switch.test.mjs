// DST of the switch: many players over a seeded network (latencies, slow and stalled readers, dropped links that come
// back with ?resume, a line when the switch is full), with the clocks, probes and limits of the real options, the
// switch's invariants checked after every step (sim.js switchInvariants) and the players' own view checked as it goes:
//  - nothing binary reaches a connection before its welcome
//  - every frame a page gets is to its own address or the broadcast address, from an address the switch handed out
//  - LAN play's broadcasts reach only pages that said LAN play is open
//  - a frame's bytes are the ones its sender sent (its source and destination written in)
//  - once the network is quiet, every page following the peer list holds the switch's list exactly
// Reproduce one: DST_SEEDS=17 node --test test/dst/switch.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.js';
import { Prng } from '../../src/util/prng.js';
import { unpackAll } from '../../src/switch/compact_test_util.js';
import { Fpred } from '../../src/switch/fpred.js';
import { roamDatagram } from '../switch/tracegen.js';

// the hosts, when their areas are there: every other seed runs with the Online host and the free-roam hub on the switch
const online = await import('../../src/online/index.js').catch(() => null);
const roam = await import('../../src/roam/index.js').catch(() => null);
const HOSTS = [0x0a4d0001, 0x0a4d00fd];

const BCAST = 0xffffffff;
const be32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const key = (b) => Array.from(b.subarray(12), (x) => x.toString(16).padStart(2, '0')).join('');

function seeds() {
  const s = process.env.DST_SEEDS ?? '1-30';
  const out = [];
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let i = a; i <= (b ?? a); i++) out.push(i);
  }
  return out;
}

/** the frames of one binary message as the page's game gets them */
function framesOf(c, b) {
  if (b[0] === 32) {
    const out = [];
    let at = 4;
    while (at + 4 <= b.length) {
      const len = (b[at + 2] << 8) | b[at + 3];
      out.push(b.subarray(at + 4, at + 4 + len));
      at += 4 + len;
    }
    return out;
  }
  if (b[0] === 33) {
    c.dec ??= { refs: new Map(), fp: new Fpred(), others: new Map() };
    return unpackAll(b, c.vip, c.mode.delta ? c.dec.refs : null, c.mode.fpred ? c.dec.fp : null, c.mode.ldelta ? c.dec.others : null).map((f) => Uint8Array.from(f));
  }
  return [b];
}

function runSeed(seed) {
  const r = new Prng(BigInt(seed) * 1_000_003n);
  const pick = (a) => a[r.below(a.length)];
  const chance = (p) => r.unit() < p;
  const lan = { maxPeers: pick([6, 12, 40]), maxWaiting: pick([3, 50]), peersMs: 250, keepaliveMs: pick([25_000, 3_000]), probeMs: 1000,
    reserveMs: pick([60_000, 5_000]), resumeWaitMs: 2_000, sendBuffer: pick([8 << 20, 256 << 10]), roamQueue: pick([128 << 10, 8 << 10]) };
  const withHosts = seed % 2 === 0 && online?.OnlineHost && roam?.RoamHub;
  const hosts = withHosts ? { online: (a) => new online.OnlineHost(a), roam: (a) => new roam.RoamHub(a) } : {};
  const sim = new Sim({ seed, lan, hosts, net: { minDelayMs: 2, maxDelayMs: pick([20, 120]), jitterMs: 5 } });
  /** what each address's senders sent: vip -> Set(hex of bytes 12..) */
  const sent = new Map();
  const handed = new Set(HOSTS);
  const stats = { frames: 0, checked: 0 };
  sim.onArrive.push((c, m) => {
    c.conns ??= 0;
    if (m.type === 'text' && m.obj?.t === 'welcome') {
      c.welcomed = true;
      handed.add(m.obj.vip >>> 0);
    }
    if (m.type !== 'binary') return;
    assert.ok(c.welcomed, 'seed ' + seed + ': a binary message before the welcome');
    for (const f of framesOf(c, m.data)) {
      stats.frames++;
      if (f.length < 12) continue;
      const src = be32(f, 4), dst = be32(f, 8);
      assert.ok(dst === c.vip || dst === BCAST, 'seed ' + seed + ': a frame to ' + dst.toString(16) + ' at ' + c.vip.toString(16));
      assert.ok(handed.has(src), 'seed ' + seed + ': a frame from an address never handed out ' + src.toString(16));
      if (dst === BCAST && f[0] >= 3 && f[0] <= 5) assert.ok(c.saidLan, 'seed ' + seed + ': a LAN broadcast to a page without LAN play');
      // (a car state by its fields comes back rounded: fpred.rs)
      const exact = !(c.mode.fpred && f.length > 21 && f[21] === 3) && !HOSTS.includes(src);
      if (exact) {
        assert.ok(sent.get(src)?.has(key(f)), 'seed ' + seed + ': a frame its sender never sent');
        stats.checked++;
      }
    }
  });
  const players = [];
  const hello = (c) => {
    const h = { lan: chance(0.5) ? 1 : 0, bundle: chance(0.7) ? 1 : 0 };
    if (h.bundle && chance(0.6)) {
      h.compact = 1;
      if (chance(0.6)) h.delta = 1;
      if (h.delta && chance(0.5)) h.fpred = 1;
      if (h.delta && chance(0.4)) h.ldelta = 1;
    }
    c.mode = { delta: !!h.delta && !!h.compact, fpred: !!h.fpred && !!h.delta && !!h.compact, ldelta: !!h.ldelta && !!h.delta && !!h.compact };
    c.saidLan = c.saidLan || h.lan === 1;
    return h;
  };
  const join = (resumeOf) => {
    const o = { name: 'p' + players.length, group: pick(['a', 'b', null]), readBps: chance(0.15) ? pick([20_000, 200_000]) : Infinity, rcvBuf: pick([64 << 10, 1 << 20]) };
    let h;
    if (resumeOf && resumeOf.vip && resumeOf.token) {
      o.query = { resume: true };
      h = { ...hello(o), vip: resumeOf.vip, token: resumeOf.token };
    } else {
      o.query = { queue: chance(0.5) };
      h = hello(o);
    }
    o.hello = h;
    const c = sim.connect(o);
    c.mode = o.mode;
    c.saidLan = o.saidLan;
    players.push(c);
    return c;
  };
  for (let i = 0; i < 4; i++) join(null);
  const send = (c, f) => {
    if (!c.open || !c.vip) return;
    const k = new Uint8Array(f);
    const ks = Array.from(k.subarray(12), (x) => x.toString(16).padStart(2, '0')).join('');
    if (!sent.has(c.vip)) sent.set(c.vip, new Set());
    sent.get(c.vip).add(ks);
    c.sendBinary(k);
  };
  const frame = (c) => {
    const others = players.filter((p) => p !== c && p.vip);
    const dst = withHosts && chance(0.1) ? pick(HOSTS) : chance(0.3) || !others.length ? BCAST : pick(others).vip;
    const kind = pick([1, 1, 1, 3, 4, 5]);
    const payload = kind === 1 && chance(0.7) ? roamDatagram(pick([2, 3, 3, 9]), Array.from({ length: 30 + r.below(60) }, () => r.below(256)))
      : Array.from({ length: 4 + r.below(200) }, () => r.below(256));
    const port = pick([47210, 3658]);
    return [kind, 0, 0, 0, 0, 0, 0, 0, dst >>> 24, (dst >>> 16) & 255, (dst >>> 8) & 255, dst & 255, port >> 8, port & 255, port >> 8, port & 255, ...payload];
  };
  const T = 20_000;
  for (let t = 0; t < T; t += 20) {
    const w = r.below(1000);
    if (w < 8) join(null);
    else if (w < 14 && players.some((p) => !p.open && p.token)) join(pick(players.filter((p) => !p.open && p.token)));
    else if (w < 18) {
      const c = pick(players);
      if (c.open) chance(0.5) ? c.drop() : c.close(1000, pick(['idle', 'bye']));
    } else if (w < 22) {
      const c = pick(players);
      if (c.open && c.vip) {
        const on = chance(0.6) ? 1 : 0;
        c.saidLan = c.saidLan || on === 1;
        c.sendText({ t: 'lan', on });
      }
    } else if (w < 24) {
      const c = pick(players);
      c.stalled ? c.resumeReading() : c.stopReading();
    }
    for (const c of players) {
      if (c.open && c.vip && chance(0.25)) send(c, frame(c));
      if (c.open && c.vip && chance(0.02)) c.sendText({ t: 'ping', id: r.below(1000) });
    }
    sim.advance(20);
  }
  // quiet: every page that reads catches up, then each one following the list holds the switch's
  for (const c of players) if (c.stalled) c.resumeReading();
  sim.advance(5_000);
  const want = new Map(sim.sw.all.map((p) => [p.vip, p.name()]));
  let lists = 0;
  for (const c of players) {
    const p = sim.sw.table.get(c.vip >>> 0);
    if (!c.open || !p || p.conn !== c.conn || !p.listed) continue;
    const view = new Map();
    let listed = false;
    for (const m of c.texts()) {
      if (m.t === 'peers') {
        view.clear();
        for (const e of m.peers) if (!e.server) view.set(e.vip, e.name);
        listed = true;
      } else if (m.t === 'delta' && listed) {
        for (const g of m.gone) view.delete(g);
        for (const e of m.peers) view.set(e.vip, e.name);
      }
    }
    assert.deepEqual([...view].sort(), [...want].sort(), 'seed ' + seed + ': ' + c.name + "'s peer list");
    lists++;
  }
  return { hosts: withHosts ? 1 : 0, steps: sim.steps, players: players.length, frames: stats.frames, checked: stats.checked, lists, cuts: sim.sw.stats.cuts.join('/') };
}

test('switch DST: invariants hold under a seeded network, seed by seed', () => {
  const rows = [];
  for (const s of seeds()) rows.push({ seed: s, ...runSeed(s) });
  const sum = (k) => rows.reduce((n, x) => n + x[k], 0);
  console.log('# ' + rows.length + ' seeds, ' + sum('steps') + ' steps checked, ' + sum('frames') + ' frames received (' + sum('checked') + ' byte-checked), ' + sum('lists') + ' peer lists compared, ' + sum('hosts') + ' seeds with the hosts');
});

