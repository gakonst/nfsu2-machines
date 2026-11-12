// A port of web/server-rs/crates/lan/tests/lan_rules.rs, from its top to messages_by_kind_racing_first_then_as_the_breakdown_and_taken_each_time
// (the rest is in lan_rules2.test.mjs): the audit's F2 (what one client can make the switch send, and whom it can get
// cut), the store, the 24000 addresses, LAN play's broadcasts, a page that lets go, the breakdown, the messages by kind.
//
// Everything runs in the harness's virtual time (harness.js): Rust's sleep(ms) and Instant::now() loops become
// sleep(ms) and now() loops on the virtual clock, so "for 5 s" means 5 s of virtual time, and every switch timer and
// fake browser's reaction due in that time runs, in order.  The kernel's buffers of the Rust tests (a raw socket's
// receive buffer, an in-memory pipe of cap bytes) are the harness's per-connection cap: what the switch's writer may
// hand the browser before its writes wait (the switch's queue builds behind it, as it did behind a full socket).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  start, startFull, opts, Client, rawPeer, stalledPeer, throttle, FakeHost, MemStore, sleep, waitFor, now, resetWorld,
  world, ip, ipStr, allVips, lan, be32, utf8, BROADCAST,
} from './harness.js';
import { LanSwitch, MSG_KINDS } from '../../src/switch/lib.js';
import { Prng } from '../../src/util/prng.js';
import { STORE_KEY } from '../../src/switch/store.js';
import { base64url } from '../../src/util/js.js';

// ---- the Rust file's helpers ----

function vipOf(m) {
  return m.vip >>> 0;
}

function src(f) {
  return be32(f, 4);
}

/** the options for the F2 tests: the budgets far away, so that the queue rules are what is tested */
function unlimited(o = {}) {
  return opts({
    byteRate: 64 << 20,
    frameRate: 100000.0,
    groupByteRate: 64 << 20,
    groupFrameRate: 100000.0,
    ...o,
  });
}

function streamOpts(o = {}) {
  return unlimited({
    sendBuffer: 4 << 20,
    shedQueue: 32 << 10,
    streamQueue: 512 << 10,
    streamShare: 256 << 10,
    stallMs: 400.0,
    ...o,
  });
}

/** lan_rules.rs roam_dgram: a free-roam datagram's header and 40 bytes of zeros (no checksum) */
function roamDgram(kind) {
  const d = new Uint8Array(4 + 4 + 40);
  d.set(utf8('N2FR'), 0);
  d.set([1, kind, 0, 0], 4);
  return d;
}

const zeros = (n) => new Uint8Array(n);

/** the real time a Rust test loop's turn of sleep(ms).await took past ms (tokio's 1 ms timer ticks, the sends): the
 * mean of the half tick it rounds up by */
const TOKIO_SLACK_MS = 0.5;

/** a repeating timer in the virtual world (Rust's spawned loops of sleep(ms)); returns {abort()} */
function every(ms, f) {
  const h = { live: true, abort() { this.live = false; } };
  const run = () => {
    if (!h.live) return;
    if (f() === false) {
      h.live = false;
      return;
    }
    world().at(now() + ms, run);
  };
  world().at(now() + ms, run);
  return h;
}

/** the queue the switch holds for the player at vip (0 once it is gone) */
function bufferedOf(sw, vip) {
  return sw.peers().find((p) => p.vip === vip)?.buffered ?? 0;
}

// ---- F2 ----

// a flood of datagrams never gets a slower receiver cut: they are dropped for it, as a full link drops UDP
test('a_flood_of_datagrams_never_gets_a_slower_receiver_cut', () => {
  resetWorld();
  const sw = start(unlimited({ sendBuffer: 256 << 10, shedQueue: 32 << 10, roamQueue: 16 << 10 }));
  // reads nothing: the slowest possible link (its "kernel" takes 256 KiB, as the Rust raw socket's did)
  const victim = rawPeer(sw, 'Victim', '');
  const attacker = Client.connect(sw, 'Attacker');
  attacker.welcome();
  sleep(100);
  const pv = sw.peerNamed('Victim');
  assert.ok(pv);
  // 8 KB datagrams of each kind but the stream, unicast and broadcast, far past every queue limit
  for (let i = 0; i < 400; i++) {
    const dst = i % 4 === 3 ? BROADCAST : pv.vip;
    attacker.udp(dst, 1, 2, zeros(8000), [1, 2, 3, 5][i % 4], 0);
    if (i % 50 === 49) {
      attacker.flush();
      sleep(5);
    }
  }
  sleep(500);
  const info = sw.info();
  const q = bufferedOf(sw, pv.vip);
  console.log('datagram flood at a reader that never reads: victim queue ' + q + ' bytes, shed ' + info.shed + ', cuts ' + JSON.stringify(info.cuts));
  assert.ok(sw.has(pv.vip), 'the victim is still on the switch');
  assert.equal(info.cuts.slow, 0, 'nobody cut for a slow queue');
  assert.ok(info.shed > 0, 'datagrams dropped for the full queue');
  assert.ok(q <= (32 << 10) + 8192, 'the victim\'s queue stays at the drop mark (' + q + ')');
  victim.drop();
  attacker.close();
  sw.close();
});

// free roam's datagrams (kind 1) are dropped at a much shorter queue than the others: no seconds of old positions
// (The victim is on an in-memory pipe of 8 KB, full before the switch's queue builds.  On a loopback socket the
// kernel's buffers decided it: macOS's took the whole burst, the queue this test measures stayed empty, and the
// test passed or failed with how fast the build's code was.)  Here: stalledPeer's cap of 8 KB.
test('free_roams_datagrams_are_dropped_at_a_much_shorter_queue', () => {
  resetWorld();
  const sw = start(unlimited({ sendBuffer: 4 << 20, shedQueue: 256 << 10, roamQueue: 16 << 10 }));
  const victim = stalledPeer(sw, 'Victim', null, 8 << 10);
  const sender = Client.connect(sw, 'Sender');
  sender.welcome();
  sleep(100);
  const pv = sw.peerNamed('Victim');
  assert.ok(pv);
  const queue = () => bufferedOf(sw, pv.vip);
  // free roam: past the kernel's buffers, then the switch's queue stops at roamQueue
  for (let i = 0; i < 400; i++) {
    sender.udp(pv.vip, 1, 2, zeros(8000), 1, 0);
    if (i % 50 === 49) {
      sender.flush();
      sleep(5);
    }
  }
  sleep(300);
  const roamQ = queue();
  const roamShed = sw.info().shed;
  // LAN play's datagrams (kind 3) still queue up to shedQueue
  for (let i = 0; i < 60; i++) {
    sender.udp(pv.vip, 1, 2, zeros(8000), 3, 0);
    if (i % 20 === 19) {
      sender.flush();
      sleep(5);
    }
  }
  sleep(300);
  const lanQ = queue();
  console.log('kind 1 queue ' + roamQ + ' bytes (shed ' + roamShed + '), then kind 3 queue ' + lanQ + ' bytes');
  assert.ok(roamShed > 0, 'free-roam datagrams dropped');
  assert.ok(roamQ > 0 && roamQ <= (16 << 10) + 8192, 'free roam stops at roamQueue (' + roamQ + ')');
  assert.ok(lanQ > (16 << 10) + 8192 && lanQ <= (256 << 10) + 8192, 'LAN play\'s datagrams go on to shedQueue (' + lanQ + ')');
  assert.ok(sw.has(pv.vip), 'the receiver is still on the switch');
  victim.drop();
  sender.close();
  sw.close();
});

// a burst of stream segments (kind 4) at a receiver: the sender is cut, not the receiver
// (The receiver is on an in-memory pipe of 8 KB: on a loopback socket Linux's buffers took the whole burst, and nothing
// queued on the switch.)
test('a_burst_of_stream_segments_the_sender_is_cut_not_the_receiver', () => {
  resetWorld();
  const sw = start(streamOpts());
  const victim = stalledPeer(sw, 'Victim', 'victim', 8 << 10);
  const attacker = Client.with(sw, 'Attacker', '?g=attacker', {});
  attacker.welcome();
  sleep(100);
  const pv = sw.peerNamed('Victim');
  assert.ok(pv);
  for (let i = 0; i < 300; i++) {
    if (!attacker.isOpen()) break;
    attacker.udp(pv.vip, 50000, 9900, zeros(8000), 4, 0);
    if (i % 20 === 19) {
      attacker.flush();
      sleep(5);
    }
  }
  // (tokio::time::timeout(2000 ms, attacker.closed()): at most 2 s for its close)
  try {
    attacker.untilMs(2000, (g) => g.closed);
  } catch {
    // timed out: the assertions say what happened
  }
  const info = sw.info();
  console.log('stream burst: attacker ' + (attacker.isOpen() ? 'still on' : 'cut') + ', victim ' + (sw.has(pv.vip) ? 'still on' : 'cut') + ', cuts ' + JSON.stringify(info.cuts));
  assert.equal(info.cuts.hog, 1, 'the sender is cut for flooding');
  assert.ok(sw.has(pv.vip), 'the receiver stays');
  assert.equal(info.cuts.slow, 0);
  // normal stream traffic (the LAN lobby: a few small segments) still flows
  const a = Client.connect(sw, 'A');
  a.welcome();
  const b = Client.connect(sw, 'B');
  b.welcome();
  for (let i = 0; i < 50; i++) a.udp(b.vip, 50000, 9900, 'seg' + i, 4, 0);
  b.untilTrue((g) => g.frames.length === 50);
  victim.drop();
  a.close();
  b.close();
  sw.close();
});

// the review of F2: stream segments from 9 client addresses, each under its own share, got a receiver that reads
// (slower than all of them together) cut.  (The kernel's buffers are kept small here, as in the never-reads test:
// the switch's send buffer and the victim's receive buffer, which Linux grows to megabytes for a socket that reads,
// take the 2 MB more than the victim reads in the 5 s and the switch's own queue never fills; the test fails that
// way with Linux's sizes.)  Here the victim's "kernel" holds 64 KiB and it reads 200 KiB a virtual second (throttle:
// a chunk every 250 ms); sendBufferOs (the switch socket's SO_SNDBUF) is passed on as the Rust test set it, though the
// JS switch has no socket of its own to size (the harness's cap is the whole of what the browser's side holds).
// stream segments from many clients at a receiver that reads: the clients flooding it go, it stays
test('stream_segments_from_many_clients_at_a_receiver_that_reads', () => {
  resetWorld();
  const sw = start(streamOpts({ stallMs: 1000.0, sendBufferOs: 64 << 10 }));
  const victim = rawPeer(sw, 'Victim', '?g=victim', 64 << 10);
  // reads about 250 KB/s
  const reading = throttle(victim, 200 << 10);
  const att = [];
  for (let i = 0; i < 9; i++) {
    const c = Client.with(sw, 'a' + i, '?g=a' + i, {});
    c.welcome();
    att.push(c);
  }
  sleep(100);
  const pv = sw.peerNamed('Victim');
  assert.ok(pv);
  // each sends 80 KB a second for 5 s: 720 KB/s in all
  const t0 = now();
  while (now() - t0 < 5000) {
    for (const a of att) {
      if (a.isOpen()) {
        for (let k = 0; k < 2; k++) a.udp(pv.vip, 50000, 9900, zeros(8000), 4, 0);
      }
    }
    sleep(200);
  }
  sleep(300);
  const info = sw.info();
  const cut = att.filter((a) => !a.isOpen()).length;
  console.log('9 clients streaming at a receiver reading about 250 KB/s: receiver ' + (sw.has(pv.vip) ? 'still on' : 'CUT') + '; senders cut ' + cut + '/9; cuts ' + JSON.stringify(info.cuts));
  assert.ok(sw.has(pv.vip), 'the receiver that reads stays');
  assert.equal(info.cuts.slow, 0);
  assert.ok(cut >= 1 && info.cuts.hog >= 1, 'senders cut');
  void reading; // (reading.abort(): the throttle ends with the connection, at sw.close())
  sw.close();
});

// the review of F2's fix: a receiver that stopped reading (and kept its connection alive with text pings) got the
// SENDER of an ordinary stream cut
// a receiver that stopped reading: it goes, not the player streaming to it
test('a_receiver_that_stopped_reading_goes_not_the_player_streaming_to_it', () => {
  resetWorld();
  const sw = start(streamOpts());
  const guest = stalledPeer(sw, 'Guest', 'guest', 8 << 10);
  // stops reading, still sends: text pings every 200 ms
  const keep = every(200, () => {
    if (guest.gone) return false;
    guest.text('{"t":"ping","id":1}');
    return true;
  });
  const host = Client.with(sw, 'Host', '?g=host', {});
  host.welcome();
  sleep(100);
  const pg = sw.peerNamed('Guest');
  assert.ok(pg);
  const t0 = now();
  while (now() - t0 < 5000 && sw.has(pg.vip) && host.isOpen()) {
    host.udp(pg.vip, 50000, 9900, zeros(8000), 4, 0);
    host.udp(pg.vip, 50000, 9900, zeros(8000), 4, 0);
    // 640 KB/s
    // (Rust's sleep(25).await lasted a little more than 25 ms: tokio's timer rounds a deadline up to its next 1 ms tick
    // and the loop's sends take time too.  In virtual time a sleep(25) is exactly 25 ms, and the guest's share (256 KB
    // at 16 KB a turn) then fills exactly stallMs (400 ms) after its first segment queued, where stalled()'s strict >
    // (route.rs stalled; route.js stalled) is not yet true and the host is cut for a hog instead.  TOKIO_SLACK_MS is
    // that bit of real time per turn, so that the switch sees the timeline the Rust test gave it.)
    sleep(25 + TOKIO_SLACK_MS);
  }
  keep.abort();
  const info = sw.info();
  console.log('host streaming to a guest that stopped reading: host ' + (host.isOpen() ? 'still on' : 'CUT') + ', guest ' + (sw.has(pg.vip) ? 'still on' : 'cut') + ' after ' + (now() - t0) + ' ms; cuts ' + JSON.stringify(info.cuts));
  assert.ok(host.isOpen(), 'the host stays');
  assert.ok(!sw.has(pg.vip), 'the guest that stopped reading goes');
  assert.equal(info.cuts.hog, 0);
  host.close();
  sw.close();
});

// a broadcast costs its size for every player it reaches; one client address shares one budget
test('a_broadcast_costs_its_size_for_every_player_it_reaches', () => {
  resetWorld();
  const RATE = 64 << 10;
  const sw = start(opts({
    byteRate: RATE,
    frameRate: 100000.0,
    groupByteRate: RATE,
    groupFrameRate: 100000.0,
    siteByteRate: RATE,
    siteFrameRate: 100000.0,
    maxPeers: 16,
    // the senders' budgets decide what gets through, not a receiver's queue: a whole burst at once is more than
    // the 64 KB a Linux socket's writer may leave queued
    roamQueue: 1 << 20,
  }));
  const rx = [];
  for (let i = 0; i < 7; i++) {
    const c = Client.connect(sw, 'R' + i);
    c.welcome();
    rx.push(c);
  }
  const tx = Client.connect(sw, 'Sender');
  tx.welcome();
  // 3 s of 1000-byte broadcasts as fast as the sender can (20 every 2 virtual ms)
  const t0 = now();
  while (now() - t0 < 3000) {
    for (let k = 0; k < 20; k++) tx.udp(BROADCAST, 1, 2, zeros(1000 - 16), 1, 0);
    sleep(2);
  }
  sleep(300);
  const out = rx.reduce((s, c) => s + c.got().frames.reduce((t, f) => t + f[0].length, 0), 0);
  const secs = (now() - t0) / 1000;
  console.log('broadcast: the switch sent the 7 receivers ' + (out >> 10) + ' KB in ' + secs.toFixed(1) + ' s for one sender limited to ' + (RATE >> 10) + ' KB/s (burst 2 s)');
  assert.ok(out <= RATE * (secs + 2.0) * 1.1, 'the switch sends no more for a sender than its rate, broadcast or not (' + out + ' bytes)');
  // two connections of one client address (one group) share its budget; another address has its own
  const g1 = Client.with(sw, 'G1', '?g=home', {});
  g1.welcome();
  const g2 = Client.with(sw, 'G2', '?g=home', {});
  g2.welcome();
  const other = Client.with(sw, 'Other', '?g=elsewhere', {});
  other.welcome();
  const dst = rx[0];
  const blast = (c) => {
    for (let k = 0; k < 400; k++) c.udp(dst.vip, 1, 2, zeros(1000 - 16), 1, 0);
  };
  const before = dst.frames();
  blast(g1);
  blast(g2);
  sleep(500);
  const fromGroup = dst.got().frames.slice(before).filter((f) => [g1.vip, g2.vip].includes(src(f[0]))).length;
  const before2 = dst.frames();
  blast(other);
  sleep(500);
  const fromOther = dst.got().frames.slice(before2).filter((f) => src(f[0]) === other.vip).length;
  console.log('one address with two connections got ' + fromGroup + ' frames through, another address alone ' + fromOther + ' (the budget of one address: ' + ((2 * RATE) >> 10) + ' KB burst)');
  assert.ok(fromGroup <= Math.floor((2 * RATE) / 1000) + 20, 'two connections of one address share one budget (' + fromGroup + ')');
  assert.ok(fromOther >= 100, 'another address is not affected (' + fromOther + ')');
  // the addresses of one site (an IPv6 /48) share the site's budget too
  const s1 = Client.with(sw, 'S1', '?g=s1&s=site', {});
  s1.welcome();
  const s2 = Client.with(sw, 'S2', '?g=s2&s=site', {});
  s2.welcome();
  const before3 = dst.frames();
  blast(s1);
  blast(s2);
  sleep(500);
  const fromSite = dst.got().frames.slice(before3).filter((f) => [s1.vip, s2.vip].includes(src(f[0]))).length;
  console.log('two addresses of one site got ' + fromSite + ' frames through (the site\'s budget: ' + ((2 * RATE) >> 10) + ' KB burst)');
  assert.ok(fromSite <= Math.floor((2 * RATE) / 1000) + 20, 'one site shares one budget (' + fromSite + ')');
  for (const c of [...rx, tx, g1, g2, other, s1, s2]) c.close();
  sw.close();
});

// the most free roam sends goes through one connection: 32 friends at 60 snapshots a second
test('the_most_free_roam_sends_goes_through_one_connection', () => {
  resetWorld();
  const sw = start(opts());
  const a = Client.connect(sw, 'Roamer');
  a.welcome();
  const b = Client.connect(sw, 'Friend');
  b.welcome();
  // 4 s (past the 2 s burst) of 2000 snapshots of 94 bytes a second: 32 x 60, HELLOs and PINGs
  const t0 = now();
  let sent = 0;
  while (now() - t0 < 4000) {
    const due = Math.floor(((now() - t0) / 1000) * 2000);
    while (sent < due) {
      a.udp(b.vip, 47210, 47210, zeros(94 - 16), 1, 0);
      sent++;
    }
    sleep(5);
  }
  sleep(300);
  const got = b.frames();
  console.log('free roam at the most: ' + got + ' of ' + sent + ' snapshots through');
  assert.ok(got >= sent * 0.99, 'none dropped by the connection\'s limits (' + got + ' of ' + sent + ')');
  a.close();
  b.close();
  sw.close();
});

// ---- the store ----

// with a store, a restart of the server keeps each player's address for its token (and only for it)
// (the Rust test's file lan-addresses.json in a temporary folder is the harness's MemStore under the same key)
test('with_a_store_a_restart_keeps_each_players_address_for_its_token', () => {
  resetWorld();
  const store = new MemStore();
  const sw = startFull(opts(), '', null, null, store);
  const a = Client.connect(sw, 'Alice');
  const wa = a.welcome();
  const b = Client.connect(sw, 'Bob');
  const wb = b.welcome();
  sleep(600);
  const saved = store.text();
  assert.equal(typeof saved, 'string', 'the store was written');
  const list = JSON.parse(saved);
  assert.equal(list.length, 2, 'both addresses stored');
  assert.ok(!saved.includes(wa.token) && !saved.includes(wb.token), 'hashes, not the tokens');
  sw.close();
  a.closed();
  b.closed();
  // the server comes back: an attacker who asks first gets neither address; the players get theirs
  const sw2 = startFull(opts(), '', null, null, store);
  const m = new Client(sw2, 'Mallory', '', [a.vip, wb.token], {});
  const wm = m.welcome();
  assert.ok(![a.vip, b.vip].includes(vipOf(wm)), 'the attacker got ' + wm.vipStr);
  const a2 = new Client(sw2, 'Alice', '', [a.vip, wa.token], {});
  const b2 = new Client(sw2, 'Bob', '', [b.vip, wb.token], {});
  assert.equal(vipOf(a2.welcome()), a.vip);
  assert.equal(vipOf(b2.welcome()), b.vip);
  for (const c of [m, a2, b2]) c.close();
  sw2.close();
});

// with a store, an address of before the restart that nobody came back for counts as a browser that left for the
// hosts, once, when its reservation ends (the sweep, or the admission of a newcomer); one a departure reserved, they
// heard of at the departure.  (The Online host keeps a race and its players' names until it hears they left.)
test('with_a_store_an_address_nobody_came_back_for_is_gone_for_the_hosts', () => {
  resetWorld();
  const store = new MemStore();
  const o = opts({ reserveMs: 400 });
  const kept = (n) => '{"v":"10.77.' + n + '.2","h":"' + base64url(new Uint8Array(32).fill(n)) + '"}';
  const [a, b] = [ip('10.77.0.2'), ip('10.77.1.2')];
  const host = () => new FakeHost(0x0a4d0001, 'online', true);
  // the sweep: the two addresses of before, once; Alice, who dropped after the start, at her departure only
  store.put(STORE_KEY, '[' + kept(0) + ',' + kept(1) + ']');
  let online = host();
  let sw = startFull(o, '', online, null, store);
  const alice = Client.connect(sw, 'Alice');
  alice.welcome();
  assert.ok(![a, b].includes(alice.vip), 'a newcomer gets no address of before');
  assert.deepEqual(online.gone, [], 'not before their time');
  sw.lan.terminateAll(now());
  waitFor(2000, () => online.gone.length === 1);
  sleep(500);
  sw.keepalive();
  sw.keepalive();
  assert.deepEqual(online.gone, [alice.vip, a, b]);
  alice.closed();
  sw.close();
  // a newcomer's admission: the same, before its welcome
  store.put(STORE_KEY, '[' + kept(0) + ',' + kept(1) + ']');
  online = host();
  sw = startFull(o, '', online, null, store);
  sleep(500);
  const carol = Client.connect(sw, 'Carol');
  carol.welcome();
  assert.deepEqual(online.gone, [a, b]);
  carol.close();
  sw.close();
});

// ---- addresses ----

// addresses: 24000 on 10.77.0.0/17, handed out round the ninety-six of its /24s; never .0, .1 or .252 and up; full past them
test('addresses_24000_round_the_ninety_six_24s_full_past_them', () => {
  resetWorld();
  const transport = { write: (_c, _m, bytes) => bytes, end() {}, kill() {}, finished() {} };
  const t = now();
  const sw = new LanSwitch({ options: { maxPeers: 24000 }, prng: new Prng(1), nowMs: t, transport });
  const got = [];
  for (let i = 0; i < 24000; i++) {
    const v = sw.allocate();
    assert.ok(v !== 0, 'address ' + i);
    got.push(v);
    sw.reserveForTest(v, new Uint8Array(32), t + 60_000, 'g' + i, null);
  }
  const first = got.slice(0, 18).map(ipStr);
  const want = [];
  for (let b = 0; b < 16; b++) want.push('10.77.' + b + '.2');
  want.push('10.77.16.2', '10.77.17.2');
  assert.deepEqual(first, want);
  assert.equal(ipStr(got[63]), '10.77.63.2');
  assert.equal(ipStr(got[64]), '10.77.64.2');
  assert.equal(ipStr(got[95]), '10.77.95.2');
  assert.equal(ipStr(got[96]), '10.77.0.3');
  assert.equal(ipStr(got[23999]), '10.77.95.251');
  assert.equal(new Set(got).size, 24000, 'all distinct');
  const sorted = got.slice().sort((x, y) => x - y);
  const all = allVips().sort((x, y) => x - y);
  assert.deepEqual(sorted, all, 'every one of them');
  assert.equal(sw.allocate(), 0, 'none left');
  assert.ok(sw.full());
  sw.stop(t);
});

// ---- LAN play ----

// LAN play's broadcasts (kinds 3-5) reach only the browsers with LAN play open; free roam's reach everyone
test('lan_plays_broadcasts_reach_only_the_browsers_with_lan_play_open', () => {
  resetWorld();
  const sw = start(opts());
  const open = Client.with(sw, 'Open', '', lan(1));
  const shut = Client.with(sw, 'Shut', '', lan(0));
  const later = Client.with(sw, 'Later', '', lan(0));
  const tx = Client.with(sw, 'Host', '', lan(1));
  for (const c of [open, shut, later, tx]) c.welcome();
  // its hello is in
  for (const c of [open, shut, later, tx]) c.untilTrue((g) => g.count('peers') > 0);
  tx.udp(BROADCAST, 9999, 9999, 'any LAN games?', 3, 0);
  tx.udp(BROADCAST, 47210, 47210, 'free roam', 1, 0);
  open.untilTrue((g) => g.frames.length === 2);
  shut.untilTrue((g) => g.frames.length === 1);
  later.untilTrue((g) => g.frames.length === 1);
  sleep(50);
  const kinds = (c) => c.got().frames.map((f) => f[0][0]).sort((x, y) => x - y);
  assert.deepEqual(kinds(shut), [1], 'LAN play shut: free roam\'s broadcast only');
  // LAN play opens later ({"t":"lan"}), then shuts again
  later.text('{"t":"lan","on":1}');
  sleep(50);
  tx.udp(BROADCAST, 9999, 9999, 'again', 5, 0);
  later.untilTrue((g) => g.frames.length === 2);
  assert.equal(later.got().frames[1][0][0], 5);
  later.text('{"t":"lan","on":0}');
  sleep(50);
  tx.udp(BROADCAST, 9999, 9999, 'once more', 3, 0);
  open.untilTrue((g) => g.frames.length === 4);
  sleep(50);
  assert.equal(later.frames(), 2, 'shut again: no more of them');
  assert.equal(shut.frames(), 1);
  // unicast is not affected
  tx.udp(shut.vip, 9999, 9999, 'to you', 3, 0);
  shut.untilTrue((g) => g.frames.length === 2);
  for (const c of [open, shut, later, tx]) c.close();
  sw.close();
});

// a page that lets go (1000 "idle" or "closed") frees its address at once; a connection lost otherwise keeps it for its
// token
test('a_page_that_lets_go_frees_its_address_at_once', () => {
  resetWorld();
  const sw = start(opts());
  const cs = [];
  for (const n of ['A', 'B', 'C', 'D']) {
    const c = Client.connect(sw, n);
    c.welcome();
    cs.push(c);
  }
  cs[0].closeWith(1000, 'idle');
  cs[1].closeWith(1000, 'closed');
  cs[2].closeWith(1000, 'bye');
  cs[3].terminate();
  for (const c of cs.slice(0, 3)) c.closed();
  waitFor(5000, () => sw.peers().length === 0);
  const kept = sw.reserved().sort((x, y) => x - y);
  const want = [cs[2].vip, cs[3].vip].sort((x, y) => x - y);
  assert.deepEqual(kept, want, 'only the ones that did not say so keep their address');
  assert.equal(sw.info().released, 2);
  sw.close();
});

// ---- the console's counts ----

// the server's console says what the players on the switch do (src/app/run.rs, every 5 minutes): each counted once
// breakdown: Online mode, the LAN or Online screens, free roam, leaving or starting
test('breakdown_online_lan_screens_free_roam_leaving_or_starting', () => {
  resetWorld();
  const online = new FakeHost(0x0a4d0001, 'online', true);
  const roam = new FakeHost(0x0a4d00fd, '', false);
  const sw = startFull(opts(), '', online, roam, null);
  const all = [];
  for (const [name, l] of [['Online', 1], ['LanScreens', 1], ['Roamer', 0], ['Roamer2', 0], ['Leaving', 0]]) {
    const c = Client.with(sw, name, '', { lan: l });
    c.welcome();
    all.push(c);
  }
  for (const x of all) x.untilTrue((g) => g.count('peers') > 0);
  online.vipSet.add(all[0].vip);
  for (const v of [all[2].vip, all[3].vip, all[0].vip]) roam.vipSet.add(v);
  // (what the pages were sent by kind left out: nothing yet, a count for each kind)
  const b = sw.lan.breakdown();
  assert.ok(b.mix.every((n) => n === 0), JSON.stringify(b.mix));
  b.mix = [];
  // (nor what they sent and the messages: their hellos, the welcomes)
  assert.ok(b.msgs.some((n) => n > 0) && b.mixIn.some((n) => n > 0));
  b.mixIn = [];
  b.msgs = [];
  // Breakdown { players: 5, online: 1, lan: 1, roam: 2, other: 1, ..Breakdown::default() }
  assert.deepEqual(b, {
    players: 5, online: 1, lan: 1, roam: 2, other: 1, behind: 0, thinning: 0, away: 0, thinned: 0, bcastSkipped: 0,
    bcastSkippedBytes: 0, snapBytes: 0, snapEntries: 0, fpredEntries: 0, otherBytes: 0, otherEntries: 0, mix: [], mixIn: [],
    msgs: [], waiting: 0, waited: 0,
  });
  // (the Online host is on the peer list, as { vip, name, server: true }; the hub is on none)
  const list = all[1].got().ctl.slice().reverse().find((m) => m.t === 'peers');
  assert.ok(list);
  const last = list.peers[list.peers.length - 1];
  assert.deepEqual(last, { vip: 0x0a4d0001, name: 'online', server: true });
  for (const x of all) x.close();
  sw.close();
});

// the messages by kind of player (src/app/run.rs, every 5 minutes): a page that sent LAN play's datagrams races, the
// rest as the breakdown has them, free roam split by the page's own word that it drives; each call takes the counts
test('messages_by_kind_racing_first_then_as_the_breakdown_and_taken_each_time', () => {
  resetWorld();
  const online = new FakeHost(0x0a4d0001, 'online', true);
  const roam = new FakeHost(0x0a4d00fd, '', false);
  const sw = startFull(opts(), '', online, roam, null);
  const all = [];
  for (const [name, l] of [['Racer', 1], ['Online', 1], ['LanScreens', 1], ['Driver', 0], ['Away', 0], ['Leaving', 0]]) {
    const c = Client.with(sw, name, '', { lan: l });
    c.welcome();
    all.push(c);
  }
  for (const x of all) x.untilTrue((g) => g.count('peers') > 0);
  online.vipSet.add(all[1].vip);
  roam.vipSet.add(all[3].vip);
  roam.vipSet.add(all[4].vip);
  // (what came before is taken: the hellos, the welcomes, the peer lists)
  sw.lan.messagesByKind();
  // the racer's LAN play to the LAN screens, each roamer's HELLO (status 2: driving; 0: the menus) to the other
  const driving = roamDgram(1), menus = roamDgram(1);
  driving[19] = 2;
  menus[19] = 0;
  for (let i = 0; i < 3; i++) all[0].udp(all[2].vip, 9999, 9999, 'race', 3, 0);
  all[3].udp(all[4].vip, 47210, 47210, driving, 1, 0);
  all[4].udp(all[3].vip, 47210, 47210, menus, 1, 0);
  sleep(300);
  const got = sw.lan.messagesByKind();
  const show = JSON.stringify(got);
  assert.deepEqual(got.map((k) => k.kind), MSG_KINDS.slice());
  assert.deepEqual(got.map((k) => k.players), [1, 1, 1, 1, 1, 1], show);
  const k = (i) => got[i];
  assert.deepEqual([k(0).msgsIn, k(3).msgsIn, k(4).msgsIn], [3, 1, 1], 'each frame a message from its page: ' + show);
  assert.ok(k(2).msgsOut >= 1 && k(3).msgsOut >= 1 && k(4).msgsOut >= 1, 'what reached them: ' + show);
  assert.deepEqual([k(1).msgsIn, k(5).msgsIn], [0, 0], show);
  // taken: a second call has the players and no messages
  const again = sw.lan.messagesByKind();
  assert.ok(again.every((x) => x.msgsIn === 0 && x.msgsOut === 0), JSON.stringify(again));
  assert.deepEqual(again[0], { kind: MSG_KINDS[0], players: 0, msgsIn: 0, msgsOut: 0 }, 'no LAN play since: not racing');
  assert.equal(again[2].players, 2, 'the racer, back on the LAN screens');
  for (const x of all) x.close();
  sw.close();
});

