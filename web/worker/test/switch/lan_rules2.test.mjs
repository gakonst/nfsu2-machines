// A port of web/server-rs/crates/lan/tests/lan_rules.rs, its second part (from
// bundles_each_entry_reaches_its_destinations_as_a_frame_of_its_own to the end): bundles, a player behind on its path
// (lag.rs), the probe, compact bundles, the peer list and LAN play, a player not driving (away.rs).  The first part is
// lan_rules.test.mjs.  Everything runs in the harness's virtual time: Rust's Instant::now() is now(), its sleeps advance
// the virtual clock, and its threads (the Laggy's reader and writer tasks) are events in the world.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  start, opts, Client, rawPeer, sleep, now, resetWorld, world, frameOf, bundleOf, unpackCompact, roamDatagram,
  BROADCAST, bundles, utf8, str, concat, be32,
} from './harness.js';
import { crc32 } from '../../src/switch/crc32.js';

// ---- the helpers at the top of lan_rules.rs (and the ones further down that these tests use) ----

/** the options for the F2 tests: the budgets far away, so that the queue rules are what is tested */
function unlimited(o = {}) {
  return opts({ byteRate: 64 << 20, frameRate: 100000.0, groupByteRate: 64 << 20, groupFrameRate: 100000.0, ...o });
}

const vipOf = (m) => m.vip >>> 0;
const hex = (b) => Buffer.from(b).toString('hex');
const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** a free-roam datagram as roam_core sends it, far enough for the switch: "N2FR", version 1, its type */
function roamDgram(kind) {
  return concat([utf8('N2FR'), Uint8Array.of(1, kind, 0, 0), new Uint8Array(40)]);
}

/** the datagram with its CRC (the last 4 bytes, little-endian) made again, as crc32fast::hash did */
function recrc(d) {
  const n = d.length - 4;
  const crc = crc32(d.subarray(0, n)) >>> 0;
  new DataView(d.buffer, d.byteOffset, d.byteLength).setUint32(n, crc, true);
  return d;
}

/** until the breakdown says f, at most secs (virtual): Rust polled every 50 ms of real time, this every 50 virtual */
function untilBreakdown(sw, secs, what, f) {
  const t0 = now();
  for (;;) {
    const b = sw.lan.breakdown();
    if (f(b)) return b;
    assert.ok(now() - t0 < secs * 1000, what + ': ' + JSON.stringify({ behind: b.behind, thinning: b.thinning, away: b.away }));
    sleep(50);
  }
}

/** a client's frames, compact bundles taken apart as the page does */
function framesOf(c) {
  return c.got().frames.flatMap(([b]) => (b[0] === 33 ? unpackCompact(b, c.vip) : [b.slice()]));
}

/** wait (virtual) until f is true, secs at most, polling every ms as the Rust loops did */
function pollUntil(secs, ms, f, what) {
  const t0 = now();
  while (!f()) {
    assert.ok(now() - t0 < secs * 1000, typeof what === 'function' ? what() : what);
    sleep(ms);
  }
}

/**
 * A player on a plain socket that answers the switch's pings delay ms late (its path's queues), and counts the
 * datagrams it gets by their free-roam message type (byte 21 of the frame: 1 HELLO, 3 SNAP).
 *
 * Rust's Laggy had a reader task (it read the socket as it came) and a writer task (every 5 ms: the HELLO when due,
 * the pongs whose time came).  Here the raw client's kernel takes everything (rcvbuf Infinity, so it "reads" at once,
 * as the reader task did), its messages are handled as they arrive, and the pongs and HELLOs are events in the
 * virtual world at their due time.
 */
class Laggy {
  constructor(sw, name, delayMs) {
    this.delay = delayMs;
    /** the pongs waiting for their time; keepUp() bumps gen so that the late ones still waiting are never sent */
    this.gen = 0;
    this.counts = new Array(16).fill(0);
    this.vip = null;
    this.stopped = false;
    this.raw = rawPeer(sw, name, '', Infinity);
    const handle = (m) => {
      if (m.op === 'text') {
        const v = JSON.parse(str(m.data));
        if (v.t === 'welcome' && this.vip === null) this.vip = vipOf(v);
      } else if (m.op === 'binary' && m.data.length > 21) {
        this.counts[m.data[21] & 15]++;
      } else if (m.op === 'ping') {
        const p = m.data.slice();
        const g = this.gen;
        world().at(now() + this.delay, () => {
          if (g === this.gen && !this.stopped) this.raw.pong(p);
        });
      }
    };
    for (const m of this.raw.got) handle(m);
    this.raw.got = [];
    this.raw._arrive = handle;
    // a page in free roam: its HELLO to the hub every second (the switch times only free roam's players by every probe)
    const hello = frameOf(0x0a4d00fd, roamDatagram(1, 40), 1, 47210, 47210);
    const tick = () => {
      if (this.stopped || this.raw.gone) return;
      this.raw.binary(hello);
      world().at(now() + 1000, tick);
    };
    tick();
    // a welcome within 5 s
    const t0 = now();
    while (this.vip === null) {
      assert.ok(now() - t0 < 5000, 'a welcome');
      sleep(5);
    }
  }
  /** its path keeps up from now on: pings answered at once, the late answers still waiting never sent */
  keepUp() {
    this.delay = 0;
    this.gen++;
  }
  /** what it got since the last call */
  take() {
    const c = this.counts;
    this.counts = new Array(16).fill(0);
    return c;
  }
  drop() {
    this.stopped = true;
    this.raw.drop();
  }
}

// ---- bundles (kind 32): several frames in one message ----

// bundles: each entry reaches its destinations as a frame of its own; a client that takes bundles gets one message a
// turn, one that does not (a tool) gets frames
test('bundles_each_entry_reaches_its_destinations_as_a_frame_of_its_own', (t) => {
  resetWorld();
  const sw = start(opts());
  const a = Client.with(sw, 'A', '', bundles());
  const b = Client.with(sw, 'B', '', bundles());
  const c = Client.connect(sw, 'C');
  const d = Client.with(sw, 'D', '', bundles());
  a.welcome();
  for (const x of [b, c, d]) x.welcome();
  sleep(100);
  // a snapshot to three friends once, one frame to B alone, a LAN broadcast
  a.sendBundle([
    [frameOf(0, 'snap', 1, 9999, 9999), [b.vip, c.vip, d.vip]],
    [frameOf(b.vip, 'only-b', 1, 9999, 9999), []],
    [frameOf(BROADCAST, 'lan', 3, 9999, 9999), []],
  ]);
  b.untilTrue((g) => g.dgrams().length >= 3);
  c.untilTrue((g) => g.dgrams().length >= 2);
  d.untilTrue((g) => g.dgrams().length >= 2);
  sleep(100);
  const got = (x) => x.dgrams().map((g) => {
    const to = g.dst === BROADCAST ? 'all' : g.dst === x.vip ? 'me' : String(g.dst);
    return g.data + '>' + to;
  });
  assert.deepEqual(got(b), ['snap>me', 'only-b>me', 'lan>all'], 'B: in order, each with its own destination');
  assert.deepEqual(got(c), ['snap>me', 'lan>all']);
  assert.deepEqual(got(d), ['snap>me', 'lan>all']);
  for (const x of [b, c, d]) {
    assert.ok(x.dgrams().every((g) => g.src === a.vip), 'from A, as the switch wrote it');
  }
  assert.equal(b.frames(), 1, 'B (takes bundles): one message for the three');
  assert.equal(b.got().frames[0][0][0], 32);
  assert.equal(c.frames(), 2, 'C (takes no bundles: a tool): two frames');
  assert.ok(c.got().frames.every((f) => f[0][0] !== 32));
  assert.equal(a.dgrams().length, 0, 'nothing back to the sender');
  const i = sw.info();
  assert.equal(i.bundlesIn, 1);
  assert.equal(i.bundlesOut, 2);
  assert.equal(i.frames, 5, 'five frames routed');
  // what comes in one turn from several senders goes to B as one message
  const n0 = b.frames();
  c.udp(b.vip, 9999, 9999, 'c1', 1, 0);
  d.udp(b.vip, 9999, 9999, 'd1', 1, 0);
  a.udp(b.vip, 9999, 9999, 'a1', 1, 0);
  b.untilTrue((g) => g.dgrams().length >= 6);
  const last = b.dgrams().slice(3).map((g) => g.data).sort();
  assert.deepEqual(last, ['a1', 'c1', 'd1']);
  // (Rust printed this; nothing asserted on it)
  t.diagnostic('three senders to B: ' + (b.frames() - n0) + ' message(s)');
  for (const x of [a, b, c, d]) x.close();
  sw.close();
});

// bundles: LAN play's datagrams (a race's car updates) go to a client that takes bundles at once; free roam's wait for
// the bundle clock's tick
test('bundles_lan_play_datagrams_do_not_wait_for_the_clock', (t) => {
  resetWorld();
  // a fixed tick of 400 ms: 8 datagrams 50 ms apart that wait for it wait 350 ms or more, one of them at least (no
  // probes: a ping wakes the writer, which takes the datagrams queued along; no jitter: a tick of 240 ms made the
  // longest wait under 300 ms in about a quarter of the runs).  The waits are virtual ms here: from the send to the
  // virtual time at which B's message arrived.
  const sw = start(opts({ bundleMs: 400, bundleMaxMs: 400, bundleJitter: 0.0, probeMs: 0 }));
  const a = Client.connect(sw, 'A');
  const b = Client.with(sw, 'B', '', bundles());
  a.welcome();
  b.welcome();
  sleep(100);
  // ms from sending to B's getting it, for each of 8 datagrams of this kind
  const waits = (kind) => {
    const sent = [];
    for (let i = 0; i < 8; i++) {
      const tag = 'k' + kind + '-' + i;
      sent.push([tag, now()]);
      a.udp(b.vip, 3658, 3658, tag, kind, 0);
      sleep(50);
    }
    const pre = 'k' + kind + '-';
    b.untilTrue((g) => g.dgrams().filter((x) => x.data.startsWith(pre)).length === 8);
    const g = b.got();
    const got = g.dgrams();
    return sent.map(([tag, t]) => {
      const x = got.find((y) => y.data === tag);
      return g.frames[x.msg][1] - t;
    });
  };
  const lanW = waits(3);
  const roam = waits(1);
  t.diagnostic('LAN play: ' + JSON.stringify(lanW) + ' ms; free roam: ' + JSON.stringify(roam) + ' ms');
  assert.ok(lanW.every((ms) => ms < 150), "LAN play's go at once: " + JSON.stringify(lanW));
  assert.ok(roam.some((ms) => ms >= 300), "free roam's wait for the tick: " + JSON.stringify(roam));
  a.close();
  b.close();
  sw.close();
});

// bundles: each frame pays the budgets as a frame of its own; a broken entry, one over the budget, or a bundle too
// large ends it
test('bundles_each_frame_pays_the_budgets_a_broken_entry_ends_it', () => {
  resetWorld();
  const sw = start(opts({ frameRate: 10.0 }));
  let a = Client.with(sw, 'A', '?g=a', {});
  a.welcome();
  let b = Client.with(sw, 'B', '?g=b', {});
  b.welcome();
  sleep(50);
  // 30 times to B in one entry: the burst (2 s of 10 a second) gets through, the rest and what follows do not
  a.sendBundle([[frameOf(0, 'x', 1, 9999, 9999), new Array(30).fill(b.vip)], [frameOf(b.vip, 'after', 1, 9999, 9999), []]]);
  sleep(300);
  assert.equal(b.dgrams().length, 20);
  assert.ok(b.dgrams().every((g) => g.data === 'x'));
  assert.ok(sw.info().limited >= 1);
  sw.close();
  const sw2 = start(opts());
  a = Client.connect(sw2, 'A');
  a.welcome();
  b = Client.connect(sw2, 'B');
  b.welcome();
  sleep(50);
  const good = bundleOf([[frameOf(b.vip, 'one', 1, 9999, 9999), []]]);
  // an entry longer than what is left: the ones before it went, nothing after
  const broken = concat([good, Uint8Array.of(0, 0, 0x10, 0x00), frameOf(b.vip, 'cut off', 1, 9999, 9999)]);
  a.binary(broken);
  // a bundle in a bundle, a bundle over maxBundle (64 KB)
  const nested = concat([Uint8Array.of(32, 0, 0, 0), frameOf(b.vip, 'nested', 1, 9999, 9999).subarray(4)]);
  a.sendBundle([[nested, []]]);
  const big = Array.from({ length: 9 }, () => [frameOf(b.vip, 'z'.repeat(8000), 1, 9999, 9999), []]);
  a.binary(bundleOf(big));
  sleep(300);
  assert.deepEqual(b.dgrams().map((g) => g.data), ['one']);
  const limited = sw2.info().limited;
  assert.ok(limited >= 3, 'limited ' + limited);
  a.udp(b.vip, 9999, 9999, 'still fine', 1, 0);
  b.untilTrue((g) => g.dgrams().length === 2);
  sw2.close();
});

// a player behind on its path (its pings answered 2.5 s late) gets a share of free roam's snapshots and every other
// message, and all of them again once it keeps up (lag.rs)
test('a_player_behind_gets_a_share_of_the_snapshots_and_all_again_once_it_keeps_up', () => {
  resetWorld();
  const sw = start(unlimited({ probeMs: 100 }));
  const laggy = new Laggy(sw, 'Laggy', 2500);
  const s = Client.connect(sw, 'Sender');
  s.welcome();
  const snap = roamDgram(3), hello = roamDgram(1);
  const send = (n) => {
    for (let i = 0; i < n; i++) s.udp(laggy.vip, 47210, 47210, i % 5 === 4 ? hello : snap, 1, 0);
  };
  // before its first round trip it gets all of them
  send(100);
  sleep(300);
  assert.equal(laggy.take()[3], 80);
  // its round trips 2.5 s: behind, and the least share at once
  let b = untilBreakdown(sw, 6, 'thinned', (x) => x.thinning === 1);
  assert.equal(b.behind, 1, JSON.stringify({ behind: b.behind, thinning: b.thinning }));
  send(500);
  sleep(300);
  let got = laggy.take();
  assert.equal(got[1], 100, 'every HELLO');
  assert.ok(got[3] < 80, 'a share of the 400 snapshots (' + got[3] + ')');
  assert.ok(sw.info().thinned >= 320);
  assert.equal(sw.info().shed, 0, 'nothing for a long queue: it reads everything');
  // its round trips back to the path's own: all of them again, an eighth more a round trip
  laggy.keepUp();
  b = untilBreakdown(sw, 6, 'all again', (x) => x.thinning === 0);
  assert.equal(b.behind, 0, JSON.stringify({ behind: b.behind, thinning: b.thinning }));
  const thinned = sw.info().thinned;
  send(500);
  sleep(300);
  got = laggy.take();
  assert.deepEqual([got[3], got[1]], [400, 100]);
  assert.equal(sw.info().thinned, thinned);
  s.close();
  laggy.drop();
  sw.close();
});

// the probe times free roam's drivers every time and the others every 10th: only free roam's car states follow the
// round trips (and a player in free roam who is not driving gets one in 16), and each ping and its pong were two
// messages through cloudflared for every page (lib.rs probe)
test('the_probe_times_free_roams_drivers_every_time_the_others_every_tenth', () => {
  resetWorld();
  const sw = start(unlimited({ probeMs: 0, keepaliveMs: 3_600_000 }));
  const roamer = Client.connect(sw, 'Roamer');
  roamer.welcome();
  const menus = Client.connect(sw, 'Menus');
  menus.welcome();
  const racer = Client.connect(sw, 'Racer');
  racer.welcome();
  // the roamer's HELLO to the hub, as its page sends one every second in free roam (its status byte, 122, is none of
  // the not-driving ones); the racer's says it is in a race (RC_ST 3), its CRC made again
  roamer.udp(0x0a4d00fd, 47210, 47210, roamDatagram(1, 40), 1, 0);
  const d = roamDatagram(1, 40);
  d[19] = 3;
  recrc(d);
  racer.udp(0x0a4d00fd, 47210, 47210, d, 1, 0);
  for (const c of [roamer, racer]) {
    c.ping([1]);
    c.untilTrue((g) => g.pongs.length > 0);
  }
  const r0 = roamer.got().pings, m0 = menus.got().pings, c0 = racer.got().pings;
  // sw.lan.probe() ran at once in Rust; here each call is a step of its own so that its pings go out
  for (let i = 0; i < 20; i++) sw.step((l) => l.probe());
  roamer.untilTrue((g) => g.pings >= r0 + 20);
  sleep(200);
  const r = roamer.got().pings - r0, m = menus.got().pings - m0, c = racer.got().pings - c0;
  assert.deepEqual([r, m, c], [20, 2, 2], '20 probes: the driver timed by each, the pages in the menus and in a race by every 10th');
  roamer.close();
  menus.close();
  racer.close();
  sw.close();
});

// compact bundles: a page that takes them (its hello's "compact":1) gets the same frames as one that does not, byte for
// byte, in about a quarter fewer bytes; a client cannot send one (it could name any source) (compact.rs)
test('compact_bundles_carry_the_same_frames_in_fewer_bytes', () => {
  resetWorld();
  const sw = start(unlimited());
  const full = Client.with(sw, 'Full', '', bundles());
  full.welcome();
  const small = Client.with(sw, 'Small', '', { bundle: true, compact: true });
  small.welcome();
  const s = Client.connect(sw, 'Sender');
  s.welcome();
  sleep(100);
  const broken = roamDatagram(3, 70);
  broken[broken.length - 1] ^= 0x55;
  const both = [full.vip, small.vip];
  const frames = [
    // free roam: snapshots to both, a HELLO broadcast (discovery), one on other ports, one whose CRC is wrong
    [frameOf(0, roamDatagram(3, 70), 1, 47210, 47210), both],
    [frameOf(0, roamDatagram(3, 82), 1, 47210, 47210), both],
    [frameOf(BROADCAST, roamDatagram(1, 40), 1, 47210, 47210), []],
    [frameOf(0, roamDatagram(3, 70), 1, 47211, 47300), both],
    [frameOf(0, broken, 1, 47210, 47210), both],
    // not free roam's: LAN play's UDP, some other bytes
    [frameOf(0, [1, 64, 0, 0, 0, 0, 0, 7, 42, 42, 42], 3, 6112, 6112), both],
    [frameOf(0, 'just bytes', 1, 47210, 47210), both],
  ];
  for (let i = 0; i < 20; i++) s.sendBundle(frames);
  const want = 20 * 7;
  full.untilTrue((g) => g.dgrams().length >= want);
  pollUntil(5, 20, () => framesOf(small).length >= want, () => framesOf(small).length + ' of ' + want + ' frames');
  // the same frames, in the same order: to each its own address, the rest byte for byte
  const mine = (f, vip) => {
    const x = f.slice();
    if (be32(x, 8) === vip >>> 0) x.set([0, 0, 0, 0], 8);
    return hex(x);
  };
  const fa = full.dgrams().map((g) => mine(g.buf, full.vip));
  const fb = framesOf(small).map((f) => mine(f, small.vip));
  assert.equal(fa.length, fb.length);
  assert.deepEqual(fb, fa, 'the same frames');
  assert.ok(small.got().frames.every(([m]) => m[0] === 33), 'all of them compact');
  const bytes = (c) => c.got().frames.reduce((n, [m]) => n + m.length, 0);
  const bf = bytes(full), bs = bytes(small);
  assert.ok(bs * 100 < bf * 85, 'fewer bytes: ' + bs + ' against ' + bf);
  // a client's compact bundle, alone or in a bundle, reaches nobody
  const before = [small.got().frames.length, sw.info().limited];
  const fake = concat([Uint8Array.of(33, 0, 0, 0, 0x01, 0x01, 0x02, 0x00, 0x04), utf8('evil')]);
  s.binary(frameOf(small.vip, fake, 33, 47210, 47210));
  s.sendBundle([[frameOf(small.vip, fake, 33, 47210, 47210), []]]);
  s.udp(small.vip, 47210, 47210, 'after', 1, 0);
  pollUntil(5, 20, () => {
    const l = framesOf(small).at(-1);
    return l !== undefined && str(l.subarray(16)) === 'after';
  }, 'the frame after');
  assert.equal(small.got().frames.length, before[0] + 1, 'only the frame after');
  assert.equal(sw.info().limited, before[1] + 2);
  s.close();
  full.close();
  small.close();
  sw.close();
});

// a frame of 12 to 15 bytes (the reader takes it: no ports, no data) reaches a page that takes compact bundles as it
// is, and the page stays connected (the third audit: one such broadcast panicked every compact page's writer)
test('a_frame_without_ports_reaches_a_compact_page_whole', () => {
  resetWorld();
  const sw = start(unlimited());
  const small = Client.with(sw, 'Small', '', { bundle: true, compact: true });
  small.welcome();
  const s = Client.connect(sw, 'Sender');
  s.welcome();
  sleep(100);
  const short = (kind, dst, len) => {
    const f = new Uint8Array(len).fill(0xab);
    f.set([kind, 0, 0, 0, 0, 0, 0, 0]);
    new DataView(f.buffer).setUint32(8, dst >>> 0);
    return f;
  };
  s.binary(short(1, BROADCAST, 12));
  s.binary(short(1, small.vip, 15));
  s.sendBundle([[short(3, BROADCAST, 13), []], [short(5, small.vip, 14), []]]);
  s.udp(small.vip, 47210, 47210, 'after', 1, 0);
  const frames = () => framesOf(small);
  pollUntil(5, 20, () => {
    const l = frames().at(-1);
    return l !== undefined && l.length >= 16 && str(l.subarray(16)) === 'after';
  }, () => 'the frame after: ' + JSON.stringify(frames().map(hex)));
  const got = frames();
  assert.equal(got.length, 5, JSON.stringify(got.map(hex)));
  const want = [[1, 12], [1, 15], [3, 13], [5, 14]];
  want.forEach(([kind, len], i) => {
    const f = got[i];
    assert.deepEqual([f[0], f.length], [kind, len]);
    assert.equal(be32(f, 4), s.vip, 'from the sender');
    assert.ok(f.subarray(12).every((x) => x === 0xab), 'its bytes as they were');
  });
  assert.ok(small.isOpen(), 'the page stays connected');
  s.close();
  small.close();
  sw.close();
});

// the peer list follows LAN play: a page with it shut gets the server's own hosts only and no changes, the whole
// list when it opens LAN play and the changes after that, none again once it shuts it
test('the_peer_list_goes_only_to_pages_with_lan_play_open', () => {
  resetWorld();
  const sw = start(opts());
  const withLan = (on) => ({ lan: on });
  const shut = Client.with(sw, 'Shut', '', withLan(0));
  shut.welcome();
  const open = Client.with(sw, 'Open', '', withLan(1));
  open.welcome();
  open.untilTrue((g) => g.names() === 'Open,Shut');
  shut.untilTrue((g) => g.count('peers') === 1);
  assert.equal(shut.got().names(), '', 'the hosts only (none on this switch)');
  const late = Client.with(sw, 'Late', '', withLan(1));
  late.welcome();
  open.untilTrue((g) => g.names() === 'Late,Open,Shut');
  sleep(400);
  {
    const g = shut.got();
    assert.deepEqual([g.count('delta'), g.names()], [0, ''], 'no changes while LAN play is shut');
  }
  // LAN play opens: the whole list, then the changes
  shut.text('{"t":"lan","on":1}');
  shut.untilTrue((g) => g.names() === 'Late,Open,Shut');
  const more = Client.with(sw, 'More', '', withLan(0));
  more.welcome();
  shut.untilTrue((g) => g.names() === 'Late,More,Open,Shut');
  // shut again: no more changes
  shut.text('{"t":"lan","on":0}');
  sleep(100);
  const deltas = shut.got().count('delta');
  const last = Client.with(sw, 'Last', '', withLan(1));
  last.welcome();
  open.untilTrue((g) => g.names() === 'Last,Late,More,Open,Shut');
  sleep(400);
  assert.equal(shut.got().count('delta'), deltas);
  sw.close();
});

// a player in free roam who is not driving (its own HELLO says a race): what its friends send it waits for the slow
// clock, and of their car states it gets a share; a driver gets the same as ever, and a HELLO that says it drives again
// ends it (away.rs)
test('a_player_not_driving_gets_fewer_messages_and_a_driver_the_same_as_ever', (t) => {
  resetWorld();
  const sw = start(unlimited());
  // (free roam alone: a page on the LAN screens is not counted as away)
  const roamer = { lan: 0, bundle: true };
  const racer = Client.with(sw, 'Racer', '', roamer);
  racer.welcome();
  const driver = Client.with(sw, 'Driver', '', roamer);
  driver.welcome();
  const s = Client.connect(sw, 'Sender');
  s.welcome();
  // a HELLO of status st (after its 16-byte header: the core's version, the platform, the status), its CRC made again
  const hello = (st) => {
    const d = roamDatagram(1, 24);
    d[19] = st;
    return recrc(d);
  };
  const ping = roamDatagram(6, 8), snap = roamDatagram(3, 40);
  const snaps = (c) => c.dgrams().filter((g) => g.buf[21] === 3).length;
  // 2 s of a ping every 20 ms to each and 8 car states each tick: messages, and car states, each got
  const burst = () => {
    const r0 = racer.frames(), d0 = driver.frames();
    const rs0 = snaps(racer), ds0 = snaps(driver);
    for (let i = 0; i < 100; i++) {
      for (const to of [racer.vip, driver.vip]) {
        s.udp(to, 47210, 47210, ping, 1, 0);
        for (let k = 0; k < 8; k++) s.udp(to, 47210, 47210, snap, 1, 0);
      }
      sleep(20);
    }
    sleep(800);
    return [racer.frames() - r0, driver.frames() - d0, snaps(racer) - rs0, snaps(driver) - ds0];
  };

  racer.udp(s.vip, 47210, 47210, hello(3), 1, 0);
  untilBreakdown(sw, 3, 'away', (b) => b.away === 1);
  let [rm, dm, rs, ds] = burst();
  t.diagnostic('in a race: racer ' + rm + ' messages, ' + rs + ' car states; driver ' + dm + ' messages, ' + ds + ' car states');
  assert.ok(rm <= 10, "the racer's on the slow clock: " + rm + ' messages in 2.8 s');
  assert.ok(dm >= 25, "the driver's on the bundle clock: " + dm + ' messages in 2 s');
  assert.ok(rs > 0 && rs < 120, 'a share of the 800 car states: ' + rs);
  assert.equal(ds, 800, 'every car state to the driver');

  // LAN play's datagrams go at once, also to it
  const n = racer.frames();
  racer.udp(s.vip, 47210, 47210, hello(3), 1, 0);
  s.udp(racer.vip, 5000, 5000, 'race', 3, 0);
  racer.untilMs(300, (g) => (g.frames.length > n ? true : null));

  // driving again: as the driver
  racer.udp(s.vip, 47210, 47210, hello(2), 1, 0);
  untilBreakdown(sw, 3, 'driving', (b) => b.away === 0);
  [rm, dm, rs, ds] = burst();
  t.diagnostic('driving: racer ' + rm + ' messages, ' + rs + ' car states; driver ' + dm + ' messages, ' + ds + ' car states');
  assert.ok(rm >= 25 && dm >= 25, rm + ' and ' + dm + ' messages');
  assert.deepEqual([rs, ds], [800, 800]);
  racer.close();
  driver.close();
  s.close();
  sw.close();
});

