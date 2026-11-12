// The switch's own tests, the first half (lan_rules.test.mjs has the second): a port of
// web/server-rs/crates/lan/tests/lan.rs onto the sans-IO JS switch, in virtual time (test/switch/harness.js).
//
// Address assignment, peer lists, unicast and broadcast routing (source rewritten), UDP frames passed through
// untouched, ping/pong, disconnects, reconnecting to the same address (only with the token the welcome gave: the
// audit's F1), the latency of a frame through the switch, what a peer learns about the others, the peer list, the
// limits (players, frame size and rate, control messages), WebSocket keepalive and idle close, the impairment, the
// reservations.  Where a Rust test measured real time on this machine, the same rule is asserted on the virtual clock
// (the harness's links have no latency of their own, so a time measured is the switch's own delay).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BROADCAST, Client, allVips, be16, be32, drain, fill, ip, ipStr, now, opts, q, rawWs, sleep, stalledPeer, start, startFull,
  str, utf8, vipOf,
} from './harness.js';
import { Prng } from '../../src/util/prng.js';

const u8eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// addresses, peer lists, unicast, broadcast, ping, disconnect, reconnect
test('addresses_peer_lists_unicast_broadcast_ping_disconnect_reconnect', () => {
  const sw = start(opts());
  // (one after another: the addresses follow the order of arrival)
  const a = Client.connect(sw, 'Alice');
  const wa = a.welcome();
  const b = Client.connect(sw, 'Bob');
  const wb = b.welcome();
  const c = Client.connect(sw, 'Carol');
  const wc = c.welcome();
  // addresses: round the ninety-six /24s of 10.77.0.0/17 in order of arrival; mask /17
  assert.equal(wa.vipStr, '10.77.0.2');
  assert.equal(wb.vipStr, '10.77.1.2');
  assert.equal(wc.vipStr, '10.77.2.2');
  assert.equal(ipStr(vipOf(wa)), '10.77.0.2');
  assert.equal(wa.mask, '255.255.128.0');
  // everyone's peer list ends with all three names
  for (const x of [a, b, c]) x.untilTrue((g) => g.names() === 'Alice,Bob,Carol');

  // unicast A -> B, with a forged source: B sees A's real address, ports and data intact; C sees nothing
  a.udp(b.vip, 47210, 47211, 'hello bob', 1, ip('10.77.0.99'));
  const fb = b.until((g) => g.frames[0]?.[0]);
  assert.equal(fb[0], 1);
  assert.equal(be32(fb, 4), a.vip, 'source rewritten to the sender');
  assert.equal(be32(fb, 8), b.vip);
  assert.equal(be16(fb, 12), 47210);
  assert.equal(be16(fb, 14), 47211);
  assert.equal(str(fb.subarray(16)), 'hello bob');
  sleep(50);
  assert.equal(c.frames(), 0, 'unicast reaches only its destination');
  assert.equal(a.frames(), 0);

  // broadcast from C: A and B get it, C does not; kind 2 (test loopback) is routed like any kind
  c.udp(BROADCAST, 47300, 47301, 'beacon', 2, 0);
  const ga = a.until((g) => g.frames[0]?.[0]);
  const gb = b.until((g) => g.frames[1]?.[0]);
  for (const g of [ga, gb]) {
    assert.equal(g[0], 2);
    assert.equal(be32(g, 4), c.vip);
    assert.equal(be32(g, 8), BROADCAST);
    assert.equal(be16(g, 14), 47301);
    assert.equal(str(g.subarray(16)), 'beacon');
  }
  sleep(50);
  assert.equal(c.frames(), 0, 'a broadcast does not come back to its sender');

  // a frame shorter than the switch header is ignored
  a.binary(fill(8));
  // ping / pong
  a.text('{"t":"ping","id":7}');
  a.untilTrue((g) => g.ctl.some((m) => m.t === 'pong' && m.id === 7));

  // B leaves: the others' peer lists drop it; frames to its address are counted as dropped
  const bvip = b.vip;
  b.close();
  a.untilTrue((g) => g.lastPeers()?.length === 2 && !g.names().includes('Bob'));
  const d0 = sw.info().dropped;
  a.udp(bvip, 1, 2, 'into the void', 1, 0);
  sleep(50);
  assert.equal(sw.info().dropped, d0 + 1);

  // B comes back with its token (?resume, then the hello): it gets its address back
  const b2 = new Client(sw, 'Bob', '', [bvip, wb.token], {});
  const wb2 = b2.welcome();
  assert.equal(vipOf(wb2), bvip, 'a reconnect with the token gets the same address back');
  assert.notEqual(wb2.token, wb.token, 'a new token each welcome');
  // the old request (?vip=), a taken address, a wrong token, or one outside the LAN: a fresh address
  const d = new Client(sw, 'Dave', '?vip=' + ipStr(a.vip), [a.vip, 'x'.repeat(22)], {});
  const wd = d.welcome();
  assert.notEqual(vipOf(wd), a.vip);
  const e = new Client(sw, 'Eve', '?vip=192.168.1.20', [ip('192.168.1.20'), wa.token], {});
  const we = e.welcome();
  assert.equal(vipOf(we) >>> 24, 10);
  assert.equal((vipOf(we) >>> 16) & 255, 77);
  const f = Client.with(sw, 'Fred', '?vip=10.77.0.255', {});
  const wf = f.welcome();
  assert.ok((vipOf(wf) & 255) >= 2 && (vipOf(wf) & 255) <= 251, 'only host addresses .2 .. .251');
  // all addresses distinct
  assert.equal(new Set([a.vip, b2.vip, c.vip, d.vip, e.vip, f.vip]).size, 6);
  // A -> the reconnected B works again
  a.udp(bvip, 5, 6, 'welcome back', 1, 0);
  const fb2 = b2.until((g) => g.frames[0]?.[0]);
  assert.equal(str(fb2.subarray(16)), 'welcome back');

  assert.equal(sw.info().peers.length, 6);
  for (const x of [a, b2, c, d, e, f]) x.close();
  sleep(50);
  assert.equal(sw.info().peers.length, 0, 'every address freed');
  sw.close();
});

// latency of a frame through the switch (Rust: on this machine over localhost; here the switch's own delay on the
// virtual clock, which must be none for a page that takes no bundles)
test('latency_of_a_frame_through_the_switch', () => {
  // limits far above the 2160 frames sent here (the limits have tests of their own)
  const sw = start(opts({ frameRate: 100000.0, groupFrameRate: 100000.0 }));
  const a = Client.connect(sw, 'A');
  a.welcome();
  const b = Client.connect(sw, 'B');
  b.welcome();
  const N = 2000;
  const lat = [];
  // 200-byte datagrams (a roam snapshot is 182 bytes), one at a time
  for (let i = 0; i < N; i++) {
    const t0 = now();
    a.udp(b.vip, 47210, 47210, fill(200, i & 255), 1, 0);
    const t = b.until((g) => g.frames[i]?.[1]);
    lat.push(t - t0);
  }
  lat.sort((x, y) => x - y);
  assert.ok(q(lat, 0.5) < 5.0, 'well under a frame');
  // a burst: 20 Hz x 8 friends for one second, sent at once, all arrive in order
  const before = b.frames();
  for (let i = 0; i < 160; i++) a.udp(b.vip, 47210, 47210, String(i), 1, 0);
  b.untilMs(3000, (g) => g.frames.length === before + 160 || null);
  const got = b.got().frames.slice(before).map((f) => Number(str(f[0].subarray(16))));
  assert.deepEqual(got, Array.from({ length: 160 }, (_, i) => i));
  a.close();
  b.close();
  sw.close();
});

/** the dotted quads in a text (what /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g finds) */
function dottedQuads(s) {
  return s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g) ?? [];
}

// what a peer learns about the others: virtual addresses and cleaned names, nothing else
test('what_a_peer_learns_about_the_others', () => {
  const sw = start(opts());
  const a = Client.connect(sw, 'Alice');
  const b = Client.with(sw, '  B\u202Eob\u0000\u200B\n\tthe\u0007 driver with a very long name indeed  ', '', {});
  a.welcome();
  b.welcome();
  // bidi, zero-width and control characters gone, spaces folded, 32 characters
  const want = 'Bob the driver with a very long';
  a.untilTrue((g) => (g.lastPeers() ?? []).some((p) => p.name.startsWith('Bob')));
  a.text('{"t":"ping","id":1}');
  a.untilTrue((g) => g.ctl.some((m) => m.t === 'pong'));
  b.udp(a.vip, 1, 2, 'x', 1, 0);
  a.untilTrue((g) => g.frames.length > 0);
  assert.equal(a.got().names(), 'Alice,' + want);
  assert.ok([...want].length <= 32);
  // every control message has only these fields, and no address but a virtual one
  b.untilTrue((g) => g.count('delta') > 0);
  const shape = (t) => {
    switch (t) {
      case 'welcome': return ['bundle', 'mask', 't', 'token', 'vip', 'vipStr'];
      case 'peers': return ['peers', 't'];
      case 'delta': return ['gone', 'peers', 't'];
      case 'pong': return ['id', 't'];
      default: throw new Error('a message of kind ' + t);
    }
  };
  const all = [...a.got().ctl, ...b.got().ctl];
  for (const m of all) {
    assert.deepEqual(Object.keys(m).sort(), shape(m.t), 'fields of ' + m.t);
    if (m.t === 'peers' || m.t === 'delta') {
      for (const p of m.peers) assert.deepEqual(Object.keys(p).sort(), ['name', 'vip']);
    }
    if (m.t === 'delta') assert.ok(m.gone.every((v) => Number.isInteger(v) && v >= 0), 'gone: addresses only');
    const s = JSON.stringify(m);
    for (const ip4 of dottedQuads(s)) {
      const r = ip4.startsWith('10.77.') ? ip4.slice(6).split('.')[0] : null;
      assert.ok((r !== null && /^\d+$/.test(r) && Number(r) <= 19) || ip4 === '255.255.128.0', 'only virtual addresses (' + ip4 + ')');
    }
    assert.ok(!s.includes('127.0.0.1') && !s.includes('::1') && !s.includes('::ffff'), 'no real address');
  }
  // a peer's token reaches that peer only
  const wa = a.got().ctl.find((m) => m.t === 'welcome');
  const wb = b.got().ctl.find((m) => m.t === 'welcome');
  const ta = wa.token;
  assert.ok(ta.length === 22 && /^[A-Za-z0-9_-]+$/.test(ta));
  const tb = wb.token;
  const tbb = utf8(tb);
  const inFrame = (f) => {
    for (let i = 0; i + tbb.length <= f.length; i++) if (u8eq(f.subarray(i, i + tbb.length), tbb)) return true;
    return false;
  };
  const seen = a.got().ctl.some((m) => JSON.stringify(m).includes(tb)) || a.got().frames.some((f) => inFrame(f[0]));
  assert.ok(!seen, "A never sees B's token");
  // the frame's header carries the sender's virtual address only
  assert.equal(be32(a.got().frames[0][0], 4), b.vip);
  assert.equal(sw.info().peers[0].from, undefined, 'the switch keeps no real address');
  a.close();
  b.close();
  sw.close();
});

// the peer list: the whole list at the hello, then what changed; a name is the first hello's
test('the_peer_list_the_whole_list_then_the_changes', () => {
  const sw = start(opts());
  const a = Client.connect(sw, 'Alice');
  const b = Client.connect(sw, 'Bob');
  const wa = a.welcome();
  b.welcome();
  for (const c of [a, b]) c.untilTrue((g) => g.names() === 'Alice,Bob');
  // Carol joins: the pages get her as a change, not the whole list again
  const c = Client.connect(sw, 'Carol');
  c.welcome();
  for (const x of [a, b]) x.untilTrue((g) => g.names() === 'Alice,Bob,Carol');
  for (const x of [a, b]) {
    assert.equal(x.got().count('peers'), 1, "the whole list once: at the page's hello");
    assert.ok(x.got().ctl.some((m) => m.t === 'delta' && m.peers.some((p) => p.name === 'Carol')));
  }
  // more hellos from Carol (the audit: each sent everyone the whole list): her name stays, nobody hears a thing
  sleep(300);
  const n0 = a.got().ctl.length, m0 = b.got().ctl.length;
  for (let i = 0; i < 30; i++) c.text('{"t":"hello","name":"Mallory' + i + '"}');
  c.text('{"t":"ping","id":5}');
  c.untilTrue((g) => g.ctl.some((m) => m.t === 'pong' && m.id === 5));
  sleep(1300);
  assert.equal(a.got().ctl.length, n0, 'nothing more to the page');
  assert.equal(b.got().ctl.length, m0, 'nothing more to the other page');
  assert.equal(a.got().names(), 'Alice,Bob,Carol');
  // joins in a burst: one change to each player
  const d0 = a.got().ctl.length, f0 = b.got().ctl.length;
  const burst = [];
  for (let i = 0; i < 5; i++) burst.push(Client.connect(sw, 'P' + i));
  for (const x of burst) x.welcome();
  const all = 'Alice,Bob,Carol,P0,P1,P2,P3,P4';
  for (const x of [a, b]) x.untilTrue((g) => g.names() === all);
  for (const x of burst) x.untilTrue((g) => g.names() === all);
  assert.ok(a.got().ctl.length - d0 <= 2, 'the page: ' + (a.got().ctl.length - d0) + ' messages for 5 joins');
  assert.ok(b.got().ctl.length - f0 <= 2, 'the other page: ' + (b.got().ctl.length - f0) + ' messages for 5 joins');
  // a player who leaves and is back (with its token) before the change goes out: gone, then back
  sleep(1100);
  const cv = c.vip;
  const wc = c.got().ctl.find((m) => m.t === 'welcome');
  c.terminate();
  const c2 = new Client(sw, 'Carol', '', [cv, wc.token], {});
  assert.equal(vipOf(c2.welcome()), cv);
  const back = a.until((g) => g.ctl.find((m) => m.t === 'delta' && m.gone.includes(cv)) ?? null);
  assert.ok(back.peers.some((p) => p.vip === cv && p.name === 'Carol'), 'gone and back in one change');
  for (const x of [a, b]) x.untilTrue((g) => g.names() === all);
  // leaves: off every list
  c2.close();
  for (const x of burst) x.close();
  for (const x of [a, b]) x.untilTrue((g) => g.names() === 'Alice,Bob');
  assert.ok(a.got().names() !== '' && wa.vip != null);
  a.close();
  b.close();
  sw.close();
});

// the cost of the peer list: a rename costs nothing, a join one small change to each player (the security review)
test('the_cost_of_the_peer_list_a_rename_costs_nothing', () => {
  const sw = start(opts({ maxPeers: 250 }));
  // 100 players
  const N = 100;
  const players = [];
  for (let i = 0; i < N; i++) players.push(Client.with(sw, 'Driver ' + String(i).padStart(3, '0'), '?g=' + i, {}));
  for (const p of players) p.welcome();
  for (const p of players) p.untilMs(5000, (g) => g.view?.size === N || null);
  sleep(1200);
  const bytes = (ps) => ps.reduce((s, p) => s + p.got().ctlBytes, 0);
  // a client sends 40 hellos with new names: before, each sent the whole list (4 KB) to all 100
  let b0 = bytes(players);
  const m = Client.with(sw, 'M', '?g=m', {});
  m.welcome();
  m.untilTrue((g) => g.view?.size === N + 1);
  for (let i = 0; i < 40; i++) {
    const n = i % 2 === 1 ? 'A'.repeat(32) : 'B'.repeat(32);
    m.text('{"t":"hello","name":"' + n + '"}');
  }
  sleep(1300);
  const rename = bytes(players) - b0;
  // its join (one change to each page) and nothing for the renames
  assert.ok(rename < N * 120, rename + ' bytes');
  // churn: one client opens and closes connections 10 times; each costs the pages one small change
  b0 = bytes(players);
  for (let i = 0; i < 10; i++) {
    const x = Client.with(sw, 'churn', '?g=m', {});
    x.welcome();
    x.close();
  }
  sleep(1300);
  const churn = bytes(players) - b0;
  assert.ok(churn < 20 * N * 120, churn + ' bytes');
  m.close();
  for (const p of players) p.terminate();
  sw.close();
});

// limits: players, frame size, frame rate, control messages
test('limits_players_frame_size_frame_rate_control_messages', () => {
  const sw = start(opts({ maxPeers: 2, maxFrame: 1600, frameRate: 50.0, textRate: 5.0, maxText: 256 }));
  assert.ok(!sw.lan.full());
  const a = Client.connect(sw, 'A');
  a.welcome();
  const b = Client.connect(sw, 'B');
  b.welcome();
  assert.ok(sw.lan.full(), 'full: maxPeers on the switch');
  // a third player: the switch is full (1013, a fixed reason)
  const c = Client.connect(sw, 'C');
  assert.deepEqual(c.closed(), [1013, 'LAN full']);
  // a frame over maxFrame is dropped, one at the limit goes through
  a.udp(b.vip, 1, 2, fill(1600 - 16 + 1), 1, 0);
  a.udp(b.vip, 1, 2, fill(1600 - 16), 1, 0);
  b.untilTrue((g) => g.frames.length === 1);
  assert.equal(b.got().frames[0][0].length, 1600);
  // frame rate: a burst of 500 at 50/s (bucket of 2 s = 100) loses the rest
  for (let i = 0; i < 500; i++) a.udp(b.vip, 1, 2, 'x', 1, 0);
  sleep(300);
  const got = b.frames() - 1;
  assert.ok(got >= 95 && got <= 120, 'burst limited to about two seconds\' worth (' + got + ')');
  // control messages: over maxText dropped; a flood of pings answered up to the bucket (2 s x 5)
  a.text('{"t":"ping","id":99,"pad":"' + 'x'.repeat(300) + '"}');
  for (let i = 0; i < 50; i++) a.text('{"t":"ping","id":' + i + '}');
  sleep(300);
  const pongs = a.got().ctl.filter((m) => m.t === 'pong');
  assert.ok(!pongs.some((m) => m.id === 99), 'an oversized control message is ignored');
  assert.ok(pongs.length >= 9 && pongs.length <= 12, 'pings answered up to the bucket (' + pongs.length + ')');
  assert.ok(sw.info().limited >= 400);
  a.close();
  b.close();
  sw.close();
});

// keepalive: pings well under a proxy idle cut, dead and idle connections closed
test('keepalive_pings_dead_and_idle_connections_closed', () => {
  const sw = start(opts({ keepaliveMs: 150, idleMs: 600 }));
  // a live client answers pings (tungstenite does by itself)
  const a = Client.connect(sw, 'A');
  a.welcome();
  // a dead one does not answer: gone after two intervals
  const dead = drain(rawWs(sw, ''));
  const t0 = now();
  sleep(0);
  for (let i = 0; i < 1000 && !dead.closed; i++) sleep(5);
  const tDead = now() - t0;
  assert.ok(dead.closed && tDead < 600.0, 'no pong: closed after ' + tDead + ' ms');
  // (the tick that cut the dead one pinged A too)
  try {
    a.untilMs(100, (g) => g.pings >= 2 || null);
  } catch {
    /* as the Rust timeout */
  }
  const pings = a.got().pings;
  assert.ok(pings >= 2, 'pings to a live client (' + pings + ')');
  // A answers pings but never sends anything: closed once idle for idleMs
  const t1 = now();
  a.closed();
  const tIdle = now() - t1;
  assert.ok(tIdle < 1200.0, 'idle client closed (' + tIdle + ' ms)');
  sw.close();
});

// control frames: pings answered a few a second, a ping flood cut, unasked pongs never count
// (WebSocket control frames: the switch answers pings itself, a few a second; a client that floods them, or sends
// pongs nobody asked for, is cut, and only a pong to the switch's own ping counts as a sign of life: the phase-2
// deploy review's finding 1)
test('control_frames_pings_answered_a_flood_cut_unasked_pongs_never_count', () => {
  const sw = start(opts({ keepaliveMs: 200, ctlRate: 10.0 }));
  // a few pings: each answered exactly once, with its own payload
  const a = Client.connect(sw, 'A');
  for (let i = 0; i < 5; i++) a.ping(utf8('p' + i));
  sleep(200);
  assert.deepEqual(a.got().pongs.map((p) => str(p)), ['p0', 'p1', 'p2', 'p3', 'p4'], 'one pong per ping, payload echoed');
  // a flood from a client that never reads: cut at once, whatever it sends next (Rust wrote 512 masked pings of 125
  // bytes at a time to a socket until a write failed; here the pings go one by one as messages, with a pong after
  // every 8 x 512, until the switch has cut the connection)
  const f = rawWs(sw, '');
  const one = 6 + 125;
  let sent = 0;
  const t0 = now();
  for (let i = 0; !f.closed && now() - t0 < 3000 && sent < 64 << 20; i++) {
    f.ping(fill(125, 0x41));
    sent += one;
    if (i % (512 * 8) === 512 * 8 - 1) f.pong(new Uint8Array(0));
    if (i % 512 === 511) sleep(1);
  }
  assert.ok(f.closed, 'the flooding client is cut (sent ' + (sent / 1048576).toFixed(1) + ' MB)');
  assert.ok(sent < 64 << 20, 'cut early (after ' + (sent / 1048576).toFixed(1) + ' MB)');
  // a client that never answers the switch's pings but sends pongs of its own, a few a second: still dead
  const d = rawWs(sw, '');
  const t1 = now();
  while (!d.closed && now() - t1 < 3000) {
    d.pong(utf8('alive?'));
    for (let k = 0; k < 15 && !d.closed; k++) sleep(10);
  }
  assert.ok(d.closed, 'unasked pongs do not keep a connection alive');
  assert.ok(now() - t1 < 1500, 'closed by the keepalive (' + (now() - t1) + ' ms)');
  // a client that answers the switch's pings stays (tungstenite does by itself)
  const p0 = a.got().pings;
  a.text('{"t":"hello","name":"A"}');
  sleep(700);
  assert.ok(a.isOpen(), 'a live client stays');
  const pinged = a.got().pings - p0;
  assert.ok(pinged >= 2, 'pinged (' + pinged + ')');
  a.close();
  sw.close();
});

// a receiver that never reads: cut by the keepalive tick once its queue is over the limit
// B sends to A, which never reads, until A's queue on the switch is just over the limit, then stops: no further send
// finds it, the next keepalive tick does (before the missing pong would).  A is on a pipe of 8 KB that is never read
// (stalledPeer); "over the limit" counts once it stays so for 100 ms.
test('a_receiver_that_never_reads_is_cut_by_the_keepalive_tick', () => {
  const sw = start(opts({
    keepaliveMs: 400, sendBuffer: 16 << 10, shedQueue: 1 << 20, byteRate: 64 << 20, frameRate: 100000.0,
    groupByteRate: 64 << 20, groupFrameRate: 100000.0, peersMs: 1, ctlRate: 1000.0,
  }));
  const a = stalledPeer(sw, 'A', null, 8 << 10);
  const b = Client.connect(sw, 'B');
  b.welcome();
  sleep(50);
  const pa = sw.peers().find((p) => p.name !== 'B');
  const buffered = () => sw.peers().find((p) => p.vip === pa.vip)?.buffered ?? 0;
  let n = 0;
  while (n < 100) {
    if (buffered() > 16 << 10) {
      // over the limit: for good once the pipe is full
      sleep(100);
      if (buffered() > 16 << 10) break;
      continue;
    }
    const f = fill(8000);
    f[0] = 1;
    new DataView(f.buffer).setUint32(8, pa.vip);
    b.binary(f);
    n++;
    // the answer to a ping sent after it: the switch reads B's messages in order, so the frame is in A's queue
    b.ping([0]);
    b.untilTrue((g) => g.pongs.length >= n);
  }
  const qn = buffered();
  assert.ok(qn > 16 << 10, "A's queue grew (" + qn + ' bytes after ' + n + ' frames)');
  const t0 = now();
  while (sw.has(pa.vip) && now() - t0 < 1500) sleep(20);
  assert.ok(!sw.has(pa.vip), 'A is off the switch');
  const cuts = sw.info().cuts;
  assert.equal(cuts.queue, 1, 'cut by the tick for its queue: ' + JSON.stringify(cuts));
  b.close();
  a.drop();
  sw.close();
});

const framesOfKind = (c, k) => c.got().frames.filter((f) => f[0][0] === k);

// LAN impairment (--lan-impair): UDP lost, TCP delayed in order, free roam untouched
test('lan_impairment_udp_lost_tcp_delayed_in_order_free_roam_untouched', () => {
  const sw = startFull(opts(), 'delay=80,jitter=0,loss=100,seed=3');
  const a = Client.connect(sw, 'A');
  a.welcome();
  const b = Client.connect(sw, 'B');
  b.welcome();
  // LAN UDP (kind 3) and ICMP (kind 5): every one lost at loss=100
  a.udp(b.vip, 9999, 9999, 'udp', 3, 0);
  a.udp(b.vip, 0, 0, 'icmp', 5, 0);
  // free roam (kind 1): not impaired, arrives at once
  const t0 = now();
  a.udp(b.vip, 47210, 47210, 'roam', 1, 0);
  const r = b.until((g) => g.frames.find((f) => f[0][0] === 1)?.[1]);
  assert.ok(r - t0 < 60.0, 'kind 1 not delayed (' + (r - t0) + ' ms)');
  // LAN TCP (kind 4): never lost, delayed by 80 ms, in order
  const t1 = now();
  for (let i = 0; i < 5; i++) a.udp(b.vip, 50000, 9900, 'seg' + i, 4, 0);
  b.untilMs(3000, () => framesOfKind(b, 4).length === 5 || null);
  const tcp = framesOfKind(b, 4).map((f) => [str(f[0].subarray(16)), f[1]]);
  assert.deepEqual(tcp.map((t) => t[0]), ['seg0', 'seg1', 'seg2', 'seg3', 'seg4'], 'in order');
  assert.ok(tcp[0][1] - t1 >= 75.0, 'TCP delayed (' + (tcp[0][1] - t1) + ' ms)');
  sleep(200);
  assert.equal(b.got().frames.filter((f) => f[0][0] === 3 || f[0][0] === 5).length, 0, 'UDP and ICMP lost');
  assert.equal(sw.info().lost, 2);
  a.close();
  b.close();
  sw.close();
});

// LAN impairment's hold (a lost TCP segment on a player's path): a link's datagrams wait for the hold's end, then come
// at once, in the order they were sent; another link has holds of its own
test('lan_impairment_hold_releases_a_links_datagrams_at_once_in_order', () => {
  const sw = startFull(opts(), 'hold=100,holdms=300,seed=5');
  const a = Client.connect(sw, 'A');
  a.welcome();
  const b = Client.connect(sw, 'B');
  b.welcome();
  const t0 = now();
  for (let i = 0; i < 5; i++) {
    a.udp(b.vip, 3658, 3658, 'd' + i, 3, 0);
    sleep(40);
  }
  b.untilMs(3000, () => framesOfKind(b, 3).length === 5 || null);
  const got = framesOfKind(b, 3).map((f) => [str(f[0].subarray(16)), f[1] - t0]);
  assert.deepEqual(got.map((g) => g[0]), ['d0', 'd1', 'd2', 'd3', 'd4'], 'in order');
  assert.ok(got[0][1] >= 290.0, "held until the hold's end: " + JSON.stringify(got));
  assert.ok(got[4][1] - got[0][1] < 30.0, 'then at once: ' + JSON.stringify(got));
  // the other way, B to A, is a link of its own: its first datagram starts its own hold
  const t1 = now();
  b.udp(a.vip, 3658, 3658, 'back', 3, 0);
  const r = a.until((g) => g.frames.find((f) => f[0][0] === 3)?.[1]);
  assert.ok(r - t1 >= 290.0, 'B to A held too (' + (r - t1) + ' ms)');
  const im = sw.info().impair;
  assert.deepEqual([im.hold, im.holdms], [100, 300], JSON.stringify(im));
  a.close();
  b.close();
  sw.close();
});

// LAN impairment's legs (each player's own way to the server): a datagram takes its sender's leg up and its receiver's
// leg down; one passed on by a third browser takes four legs; leg.N is browser N's own
test('lan_impairment_legs_add_up_per_player', () => {
  let sw = startFull(opts(), 'leg=60');
  let a = Client.connect(sw, 'A');
  a.welcome();
  let b = Client.connect(sw, 'B');
  b.welcome();
  const c = Client.connect(sw, 'C');
  c.welcome();
  // A to B straight: 120 ms; A to C, then C passing it on to B: 240 ms
  let t0 = now();
  a.udp(c.vip, 3658, 3658, 'via-c', 3, 0);
  a.udp(b.vip, 3659, 3659, 'straight', 3, 0);
  c.until((g) => g.frames.find((f) => f[0][0] === 3)?.[1]);
  c.udp(b.vip, 3658, 3658, 'via-c', 3, 0);
  b.untilMs(3000, () => framesOfKind(b, 3).length === 2 || null);
  const got = framesOfKind(b, 3).map((f) => [str(f[0].subarray(16)), f[1] - t0]);
  assert.equal(got[0][0], 'straight', JSON.stringify(got));
  assert.ok(got[0][1] >= 115 && got[0][1] < 200 && got[1][1] >= 235 && got[1][1] < 340, JSON.stringify(got));
  assert.equal(sw.info().impair.leg, 60);
  a.close();
  b.close();
  c.close();
  sw.close();
  // leg.2: the first browser on the switch (host number 2) has a way of its own
  sw = startFull(opts(), 'leg=60,leg.2=150');
  a = Client.connect(sw, 'A');
  a.welcome();
  b = Client.connect(sw, 'B');
  b.welcome();
  assert.equal(a.vip & 0x7fff, 2);
  t0 = now();
  a.udp(b.vip, 3658, 3658, 'own', 3, 0);
  const r = b.until((g) => g.frames.find((f) => f[0][0] === 3)?.[1]);
  const ms = r - t0;
  assert.ok(ms >= 205 && ms < 300, "A's own leg (150) and B's (60): " + ms + ' ms');
  a.close();
  b.close();
  sw.close();
});

// ---- the audit's F1: a departed player's address and the frames meant for it ----

// a departed player's address goes only to its token: an attacker who asks first gets nothing of it
test('a_departed_players_address_goes_only_to_its_token', () => {
  const sw = start(opts({ reserveMs: 1500 }));
  const alice = Client.connect(sw, 'Alice');
  alice.welcome();
  const bob = Client.connect(sw, 'Bob');
  const wb = bob.welcome();
  const mallory = Client.connect(sw, 'Mallory');
  mallory.welcome();
  mallory.untilTrue((g) => g.lastPeers()?.length === 3);
  // Bob drops; Mallory sees it in the peer list and asks for Bob's address at once, every way it can
  const bvip = bob.vip;
  bob.terminate();
  mallory.untilTrue((g) => { const p = g.lastPeers(); return p?.length === 2 && !p.some((x) => x.vip === bvip); });
  const grabs = [];
  for (let i = 0; i < 4; i++) {
    const resume = i % 2 === 1 ? [bvip, 'B'.repeat(22)] : null;
    grabs.push(new Client(sw, 'Bob', '?vip=' + ipStr(bvip), resume, {}));
  }
  const got = grabs.map((g) => g.welcome());
  assert.ok(got.every((w) => vipOf(w) !== bvip), "Mallory's connections got " + got.map((w) => w.vipStr) + ', never ' + ipStr(bvip));
  // Bob's page comes back 250 ms later with its token: its own address
  sleep(250);
  const bob2 = new Client(sw, 'Bob', '', [bvip, wb.token], {});
  assert.equal(vipOf(bob2.welcome()), bvip, 'Bob gets its address back');
  // Alice's frame for Bob reaches Bob, and none of Mallory's connections
  alice.udp(bvip, 9999, 9999, 'race-data-for-Bob', 3, 0);
  const f = bob2.until((g) => g.frames[0]?.[0]);
  assert.equal(str(f.subarray(16)), 'race-data-for-Bob');
  sleep(100);
  assert.equal(mallory.frames() + grabs.reduce((s, g) => s + g.frames(), 0), 0, 'nothing for Bob reached the attacker');
  // one Bob on the switch at Bob's address (the peer list comes up to a second later)
  alice.untilTrue((g) => (g.lastPeers() ?? []).filter((p) => p.vip === bvip).length === 1);
  // a reservation ends: after reserveMs the address is an ordinary free one again (no token needed)
  bob2.close();
  sleep(50);
  assert.ok(sw.info().reserved >= 1, 'reserved while it waits for its token');
  sleep(1700);
  sw.keepalive();
  assert.ok(!sw.reserved().includes(bvip), 'the reservation ended');
  for (const c of [alice, mallory]) c.close();
  for (const c of grabs) c.close();
  sw.close();
});

// a resume replaces the same client's older connection (one that died without a close), and only with the token
test('a_resume_replaces_the_same_clients_older_connection_only_with_the_token', () => {
  const sw = start(opts());
  const a = Client.connect(sw, 'Alice');
  a.welcome();
  const b = Client.connect(sw, 'Bob');
  const wb = b.welcome();
  // a wrong token while Bob is still connected: a fresh address, Bob stays
  const x = new Client(sw, 'Bob', '', [b.vip, 'C'.repeat(22)], {});
  const wx = x.welcome();
  assert.notEqual(vipOf(wx), b.vip);
  assert.ok(b.isOpen());
  // Bob's page thinks its connection is gone and comes back with its token: the old one is closed
  const b2 = new Client(sw, 'Bob', '', [b.vip, wb.token], {});
  const wb2 = b2.welcome();
  assert.equal(vipOf(wb2), b.vip);
  b.closed();
  sleep(50);
  assert.ok(sw.peers().some((p) => p.vip === b.vip && p.open), 'the new connection holds the address after the old one closed');
  a.udp(b.vip, 1, 2, 'to the new one', 1, 0);
  assert.equal(str(b2.until((g) => g.frames[0]?.[0]).subarray(16)), 'to the new one');
  // Bob, and the wrong-token client
  a.untilTrue((g) => (g.lastPeers() ?? []).filter((p) => p.name === 'Bob').length === 2);
  x.close();
  a.close();
  b2.close();
  sw.close();
});

// reservations: never handed to another client, not even when every address is held or reserved (LAN full instead); a
// silent ?resume times out to a fresh one
test('reservations_never_handed_to_another_client_a_silent_resume_times_out', () => {
  const sw = start(opts({ maxPeers: 24000, resumeWaitMs: 300 }));
  const t = now();
  const rnd = new Prng(77);
  allVips().forEach((v, i) => sw.lan.reserveForTest(v, rnd.bytes(32), t + 60_000 + i, 'others', null));
  const c = Client.with(sw, 'C', '?g=newcomer', {});
  assert.deepEqual(c.closed(), [1013, 'LAN full'], "a newcomer waits for an address to free; nobody's reservation is given away");
  assert.equal(sw.info().reserved, 24000, 'every reservation kept');
  sw.lan.clearReserved();
  const t0 = now();
  // a connection to /lan?resume that never says hello
  const r = Client.with(sw, 'R', '?resume', {});
  const m = r.until((g) => g.ctl[0] ?? null);
  assert.equal(m.t, 'welcome');
  assert.ok(now() - t0 >= 250, 'after the wait');
  sw.close();
});

// the review of F1: with every address held or reserved, opening and closing connections fast enough made the switch
// hand out the oldest reservation, a dropped player's address, within 60 ms
// churning connections never takes a dropped player's address; each client keeps only its own share of reservations
test('churning_connections_never_takes_a_dropped_players_address', () => {
  const sw = start(opts({ maxPeers: 24000, groupReserve: 8, siteReserve: 16 }));
  const alice = Client.with(sw, 'Alice', '?g=alice', {});
  alice.welcome();
  const bob = Client.with(sw, 'Bob', '?g=bob', {});
  const wb = bob.welcome();
  // the rest of the addresses held by others, so that the switch has no free one left once Bob drops
  const t = now();
  const rnd = new Prng(78);
  for (const v of allVips()) if (v !== alice.vip && v !== bob.vip) sw.lan.reserveForTest(v, rnd.bytes(32), t + 60_000, 'others', null);
  const bvip = bob.vip;
  bob.terminate();
  alice.untilTrue((g) => !(g.lastPeers() ?? []).some((p) => p.vip === bvip));
  assert.ok(sw.lan.full(), 'full with one player on: every other address kept for its player');
  // Mallory opens and closes connections as fast as it can, from many addresses of its own (4000 at most), for 600 ms
  // of the virtual clock: 20 connections at a time, a millisecond between the rounds
  let got = 0, full = 0;
  const t0 = now();
  while (now() - t0 < 600 && full < 4000) {
    const ends = [];
    for (let i = 0; i < 20; i++) ends.push(Client.with(sw, 'm', '?g=m' + (i % 5) + '&s=mallory', {}));
    for (const e of ends) {
      const r = e.until((g) => {
        const w = g.ctl.find((m) => m.t === 'welcome');
        if (w) return vipOf(w);
        return g.closed ? g.closed[0] : null;
      });
      if (r === bvip) got++;
      else if (r === 1013) full++;
    }
    sleep(1);
  }
  assert.equal(got, 0, "never Bob's address");
  assert.ok(full > 0, 'LAN full instead');
  const bob2 = new Client(sw, 'Bob', '?g=bob', [bvip, wb.token], {});
  assert.equal(vipOf(bob2.welcome()), bvip, 'Bob gets his address back');
  bob2.close();
  alice.close();
  sw.lan.expireReserved();
  assert.ok(!sw.lan.full(), 'not full once the kept addresses run out');
  sw.close();
  // a client that drops many connections keeps groupReserve reservations (its own oldest go), a site siteReserve
  const sw2 = start(opts({ maxPeers: 24000, groupReserve: 3, siteReserve: 5 }));
  const leave = (q, n) => {
    const cs = [];
    for (let i = 0; i < n; i++) cs.push(Client.with(sw2, 'x', q, {}));
    const v = cs.map((c) => vipOf(c.welcome()));
    for (const c of cs) c.close();
    sleep(20);
    return v;
  };
  const first = leave('?g=one', 6);
  const kept = sw2.reserved().sort((x, y) => x - y);
  const newest = first.slice(3).sort((x, y) => x - y);
  assert.deepEqual(kept, newest, 'the newest 3 of one client kept, its own oldest gone');
  leave('?g=two&s=site', 3);
  leave('?g=three&s=site', 3);
  const r = sw2.lan.reservedView();
  assert.equal(r.filter((x) => x.site === 'site').length, 5, 'one site keeps 5');
  assert.equal(r.filter((x) => x.group === 'one').length, 3, "another client's reservations untouched");
  sw2.close();
});
