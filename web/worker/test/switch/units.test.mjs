// The unit tests inside crates/lan/src (lib.rs, members.rs, route.rs, conn.rs; queue.rs and reader.rs have none),
// ported onto the JS switch's internals.  Rust's route::tests::peer made a peer on the switch without a socket ("its
// connection's queue only fills"): here a LanSwitch built directly, its internals (admit, hello, setLan, route,
// sendTo, sendStream, closed) called outside any step, so nothing settles: what they queue stays in conn.q, as the
// Rust queue stayed in conn.out.q with no writer to take it, and no timer runs (nothing calls tick()).

import test from 'node:test';
import assert from 'node:assert/strict';

import { LanSwitch, slot, vipAt, ADDRS, BASE, BROADCAST, KIND_UDP, KIND_LAN_UDP, KIND_STREAM, KIND_LAN_ICMP, UDP_SET, Stats }
  from '../../src/switch/lib.js';
import { saneOptions, defaultOptions, bundleTickUs } from '../../src/switch/options.js';
import { blockNames } from '../../src/switch/members.js';
import { Conn, Clock, encode, headerLen, KIND_BUNDLE } from '../../src/switch/conn.js';
import { parseJson } from '../../src/switch/text.js';
import { Bucket } from '../../src/util/bucket.js';
import { Prng } from '../../src/util/prng.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const be32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const be16 = (b, at) => (b[at] << 8) | b[at + 1];

/** LanSwitch::new(o, "", online, roam, None, None) without IO: a transport that takes everything (nothing settles in
 * these tests, so it is never called) */
function newSwitch(o = {}, hosts = {}) {
  return new LanSwitch({
    options: o, prng: new Prng(7), nowMs: 1_700_000_000_000, hosts,
    transport: { write: (_c, _m, bytes) => bytes, end() {}, kill() {}, finished() {} },
  });
}

/** route.rs tests::peer: a peer on the switch without a socket: its connection's queue only fills */
function peer(sw, group) {
  const conn = new Conn(sw.connIds++, sw);
  const ctx = {
    resume: false, queue: false, group: sw.joinGroup(false, group), site: null, onJoin: null, onLeave: null,
    ident: null, onHello: null, onClaim: null, country: 0,
  };
  conn.ctx = ctx;
  const p = sw.admit(conn, ctx, null);
  assert.ok(p, 'admitted');
  return [conn, ctx, p];
}

/** route.rs tests::frame: 40 bytes, its kind and destination */
function frame(kind, dst) {
  const f = new Uint8Array(40);
  f[0] = kind;
  new DataView(f.buffer).setUint32(8, dst >>> 0);
  return f;
}

const hello = (s) => {
  const m = parseJson(enc.encode(s));
  assert.ok(m && typeof m === 'object' && !Array.isArray(m));
  return m;
};

// ---- lib.rs ----

test('the_bundle_tick_is_50_ms_or_follows_the_crowd', () => {
  // bundleTickUs is in µs (Rust's bundle_tick a Duration)
  const d = defaultOptions();
  assert.equal(bundleTickUs(d, 0), 50_000);
  assert.equal(bundleTickUs(d, 5000), 50_000);
  const o = saneOptions({ bundleMs: 4, bundleMaxMs: 25 });
  assert.equal(bundleTickUs(o, 0), 4000);
  assert.equal(bundleTickUs(o, 500), 4000);
  assert.equal(bundleTickUs(o, 1000), 8000);
  assert.equal(bundleTickUs(o, 2000), 16_000);
  assert.equal(bundleTickUs(o, 5000), 25_000);
  const fixed = saneOptions({ bundleMs: 10, bundleMaxMs: 10 });
  assert.equal(bundleTickUs(fixed, 2000), 10_000);
});

test('slots_are_the_order_addresses_are_handed_out_in', () => {
  for (let i = 0; i < ADDRS; i++) assert.equal(slot(vipAt(i)), i);
  for (const v of [
    BASE, BASE | 1, BASE | 252, BASE | 255, BASE | 0x6000 | 2, BASE | 0x7f00 | 2, BASE | 0x8000 | 2, 0, BROADCAST,
    BASE | 0x3f00 | 0xfc, BASE | 0x3fff, BASE | 0x5f00 | 0xfc, BASE | 0x5f00 | 0xfd, BASE | 0x5fff, BASE | 0x7fff,
  ]) {
    assert.equal(slot(v >>> 0), null, (v >>> 0).toString(16));
  }
});

test('options_keep_the_defaults_for_zero', () => {
  const o = saneOptions({ maxPeers: 0, frameRate: -1.0, idleMs: 0, stallMs: NaN, bundleMs: 0 });
  const d = defaultOptions();
  assert.equal(o.maxPeers, d.maxPeers);
  assert.equal(o.frameRate, d.frameRate);
  assert.equal(o.idleMs, d.idleMs);
  assert.equal(o.stallMs, d.stallMs);
  assert.equal(o.bundleMs, 0);
});

// ---- members.rs ----

// a hello's "block": strings only, trimmed, printable ASCII, at most 24 characters each and BLOCK_MAX names
test('a_hellos_block_is_names_as_the_game_shows_them', () => {
  const BLOCK_MAX = 32;
  const m = (v) => blockNames(v);
  assert.deepEqual(m({ t: 'hello' }), []);
  assert.deepEqual(m({ block: 'bob' }), []);
  const long = 'x'.repeat(40);
  assert.deepEqual(m({ block: ['  Bob ', 7, '', '   ', 'Zoë\u0000!', long] }), ['Bob', 'Zo!', 'x'.repeat(24)]);
  const many = Array.from({ length: 40 }, (_, i) => 'p' + i);
  assert.equal(m({ block: many }).length, BLOCK_MAX);
});

/// Node sent the welcome (and a resume's whole list) before it went back to its event loop: no frame from another
/// player could come first.  Here the other players' readers route on other cores: a newcomer they can find (the
/// table, the list of all) must have its welcome queued already.
// JS runs on one thread: the "watcher on another core" becomes a look at the newcomer at the very moment it can be
// found, the table's set and each publish of the list of all (route() finds receivers there), its queue's first item
// must be its welcome by then.
test('the_welcome_is_queued_before_anyone_can_send_to_the_newcomer', () => {
  const N = 300;
  const sw = newSwitch({ maxPeers: 24000 });
  let early = 0, seen = 0;
  const isWelcome = (p) => {
    const q = p.conn.q;
    return q.length > 0 && q[0].k === 'text' && dec.decode(q[0].data).startsWith('{"t":"welcome"');
  };
  const table = sw.table;
  const setOrig = table.set.bind(table);
  table.set = (k, p) => {
    seen++;
    if (!isWelcome(p)) early++;
    return setOrig(k, p);
  };
  const publish = sw.publish;
  sw.publish = function (m) {
    publish.call(this, m);
    for (const p of this.all) if (!isWelcome(p) && !p.conn.q.some((o) => o.k === 'text' && dec.decode(o.data).startsWith('{"t":"welcome"'))) early++;
  };
  const peers = Array.from({ length: N }, (_, i) => peer(sw, 'g' + i));
  assert.equal(seen, N, 'each newcomer went into the table');
  for (let i = 0; i < N; i++) assert.equal(peers[i][2].vip, vipAt(i));
  assert.equal(early, 0, early + ' of ' + N + ' newcomers could be sent to before their welcome was queued');
  sw.stop(sw.now);
});

/// what full() costs (under the members lock) at 1000 players: the start page asks for it with /players
// #[ignore] in Rust (a benchmark that prints, asserts nothing): run with NFSU2_BENCH=1
test('what_full_costs', { skip: !process.env.NFSU2_BENCH && 'ignored in Rust (#[ignore]): a benchmark; NFSU2_BENCH=1 runs it' }, () => {
  const sw = newSwitch({ maxPeers: 24000 });
  for (let i = 0; i < 1000; i++) peer(sw, 'g' + i);
  const t = performance.now();
  let n = 0;
  for (let i = 0; i < 10_000; i++) n += sw.full() ? 1 : 0;
  console.log('full() at 1000 players: ' + ((performance.now() - t) * 1000 / 10_000).toFixed(2) + ' us a call (' + n + ' full)');
  sw.stop(sw.now);
});

// ---- route.rs ----

/** the 64-bit xorshift of the Rust test (BigInt, so the cases are the Rust ones) */
function xorshift(seed) {
  let x = seed;
  const M = (1n << 64n) - 1n;
  return (m) => {
    x ^= (x << 13n) & M;
    x ^= x >> 7n;
    x ^= (x << 17n) & M;
    return Number(x % BigInt(m));
  };
}

const cloneBucket = (b) => new Bucket(b.rate, b.cap, b.v, b.t);
const clonePair = (p) => ({ frames: cloneBucket(p.frames), bytes: cloneBucket(p.bytes) });

/// The buckets charged once for a bundle entry's destinations come to what charging them one destination after
/// the other comes to: the same destinations paid for (the first that does not fit ends the bundle) and the same
/// frames and bytes left in each bucket, to the bit.
test('charging_a_list_at_once_is_charging_it_one_by_one', () => {
  const sw = newSwitch();
  const rnd = xorshift(0x9E37_79B9_7F4A_7C15n);
  const peers = Array.from({ length: 50 }, (_, i) => peer(sw, 'g' + i));
  let cutShort = 0, whole = 0;
  for (let c = 0; c < 20_000; c++) {
    const p = peers[c % peers.length][2];
    // mostly free roam's snapshots, now and then up to maxFrame
    const n = 12 + (rnd(4) === 0 ? rnd(8180) : rnd(200));
    // levels anywhere from empty to full, with fractions (a refill leaves them), and a debt (the Online host's)
    const set = (pair) => {
      for (const b of [pair.frames, pair.bytes]) {
        b.v = (rnd(1_000_000) / 1_000_000.0) * b.cap * 1.1 - b.cap * 0.1;
        b.t = 1e12;
      }
    };
    set(p.buckets);
    set(p.group.buckets);
    // 1 to 255 destinations, now and then a broadcast's count among them
    const costs = Array.from({ length: 1 + rnd(255) }, () => (rnd(20) === 0 ? 1 + rnd(3000) : 1));
    const want = [clonePair(p.buckets), clonePair(p.group.buckets)];
    let paidWant = 0;
    for (const k of costs) {
      const ok = want.every((q) => q.frames.hasAt(1e12, k) && q.bytes.hasAt(1e12, n * k));
      if (!ok) break;
      for (const q of want) {
        q.frames.takeAt(1e12, k);
        q.bytes.takeAt(1e12, n * k);
      }
      paidWant++;
    }
    const [paid, all] = sw.charge(p, 1e12, n, costs);
    assert.deepEqual([paid, all], [paidWant, paidWant === costs.length], 'case ' + c);
    for (const [got, w] of [[p.buckets, want[0]], [p.group.buckets, want[1]]]) {
      assert.ok(Object.is(got.frames.v, w.frames.v), 'case ' + c + ': frames left ' + got.frames.v + ' vs ' + w.frames.v);
      assert.ok(Object.is(got.bytes.v, w.bytes.v), 'case ' + c + ': bytes left ' + got.bytes.v + ' vs ' + w.bytes.v);
    }
    if (all) whole++;
    else cutShort++;
  }
  assert.ok(cutShort > 1000 && whole > 1000, 'both cases came up (' + cutShort + ' cut short, ' + whole + ' whole)');
  sw.stop(sw.now);
});

/// The second security audit: a bundle entry of 255 broadcasts, refused by the budgets, walked every peer 255
/// times before the refusal (2000 such messages here: 2 billion looks at a peer, seconds; without a walk, well
/// under a millisecond).
// The Rust bound is CPU time (500 ms); kept as real time here (a pure computation, no IO), and the rule asserted
// directly too: no destination of a refused message reaches routeOne or deliver.
test('a_broadcast_refused_walks_no_peer', () => {
  const sw = newSwitch({ maxPeers: 24000 });
  const peers = Array.from({ length: 24000 }, (_, i) => peer(sw, 'g' + i));
  const p = peers[0][2];
  for (const b of [p.buckets, p.group.buckets]) {
    b.frames.v = 0.0;
    b.frames.t = 1e15;
  }
  let walked = 0;
  const routeOne = sw.routeOne, deliver = sw.deliver;
  sw.routeOne = function (...a) { walked++; return routeOne.apply(this, a); };
  sw.deliver = function (...a) { walked++; return deliver.apply(this, a); };
  const f = frame(KIND_UDP, BROADCAST);
  const dsts = new Array(255).fill(BROADCAST);
  const t = performance.now();
  for (let i = 0; i < 2000; i++) assert.ok(!sw.route(p, f, dsts));
  const ms = performance.now() - t;
  assert.ok(ms < 500.0, '2000 refused messages of 255 broadcasts at 24000 players took ' + ms.toFixed(0) + ' ms');
  assert.equal(walked, 0, 'no destination of a refused message was walked');
  assert.ok(peers.every(([c]) => c.q.length <= 1), 'nothing sent (a welcome at most)');
  sw.stop(sw.now);
});

/// LAN play's broadcasts go to the list of those with LAN play open: a page that said nothing (no hello yet, or
/// none of LAN play in it) and one that shut LAN play are not on it, and one that left or was replaced is gone
test('the_list_of_lan_play_follows_hellos_lan_messages_and_closes', () => {
  const sw = newSwitch();
  const [, , a] = peer(sw, 'a');
  const [bc, bctx, b] = peer(sw, 'b');
  const on = (sw) => sw.lanAll.map((p) => p.vip).sort((x, y) => x - y);
  assert.deepEqual(on(sw), [], 'no hello yet: none of them');
  const h = (lan) => hello('{"t":"hello","name":"x","lan":' + lan + '}');
  sw.hello(a, h(1));
  assert.deepEqual(on(sw), [a.vip]);
  sw.hello(b, h(0));
  assert.deepEqual(on(sw), [a.vip]);
  sw.setLan(b, true);
  assert.deepEqual(on(sw), [a.vip, b.vip]);
  sw.setLan(a, true);
  sw.setLan(b, false);
  assert.deepEqual(on(sw), [a.vip]);
  // a LAN broadcast from a reaches nobody: b's LAN play is shut
  assert.ok(sw.route(a, frame(KIND_LAN_UDP, BROADCAST), [BROADCAST]));
  assert.ok(b.conn.q.every((o) => o.k !== 'frame'));
  sw.setLan(b, true);
  assert.ok(sw.route(a, frame(KIND_LAN_UDP, BROADCAST), [BROADCAST]));
  assert.equal(b.conn.q.filter((o) => o.k === 'frame').length, 1);
  bc.terminate();
  sw.closed(bc, bctx);
  assert.deepEqual(on(sw), [a.vip], 'gone with its connection');
  sw.stop(sw.now);
});

/// A LAN broadcast goes only to the pages with a socket on its port as their "udp" says (server.dll's advert on
/// 9999: a joiner closed the server list's socket, the Online screens never had one), and to every page that does
/// not say (an older page or module); one that sends its ports with {"t":"lan"} changes where they go
test('a_lan_broadcast_goes_only_where_a_socket_takes_its_port', async () => {
  const { udpOf } = await import('../../src/switch/lib.js');
  const sw = newSwitch();
  const [, , a] = peer(sw, 'a');
  const [, , b] = peer(sw, 'b');
  const [, , c] = peer(sw, 'c');
  const [, , d] = peer(sw, 'd');
  const h = (udp) => hello('{"t":"hello","name":"x","lan":1' + udp + '}');
  // (u32 in Rust: >>> 0 keeps JS's bit operations unsigned)
  const bit = (port) => (1 << (port % 31)) >>> 0;
  const mask = (...ports) => ports.reduce((m, p) => (m | bit(p)) >>> 0, UDP_SET) >>> 0;
  sw.hello(a, h(''));
  sw.hello(b, h(',"udp":' + mask(9999, 3658)));
  sw.hello(c, h(',"udp":' + mask(3658)));
  sw.hello(d, h(''));
  const advert = (port) => {
    const f = frame(KIND_LAN_UDP, BROADCAST);
    const v = new DataView(f.buffer);
    v.setUint16(12, port);
    v.setUint16(14, port);
    return f;
  };
  const got = (p) => p.conn.q.filter((o) => o.k === 'frame').length;
  assert.ok(sw.route(a, advert(9999), [BROADCAST]));
  assert.deepEqual([got(b), got(c), got(d)], [1, 0, 1], 'b has 9999, c only 3658, d does not say');
  assert.equal(sw.stats.bcastSkipped, 1);
  assert.equal(sw.stats.bcastSkippedBytes, 40);
  // the same bit (3658 + 31 x 1): it goes, as a port with a socket would
  assert.ok(sw.route(a, advert(3658 + 31), [BROADCAST]));
  assert.deepEqual([got(b), got(c), got(d)], [2, 1, 2]);
  // c's server list opens (9999 bound): {"t":"lan"} with its ports; a mask without UDP_SET, or none, says nothing
  c.udp = udpOf(mask(9999));
  b.udp = udpOf(bit(5));
  assert.ok(sw.route(a, advert(9999), [BROADCAST]));
  assert.deepEqual([got(b), got(c), got(d)], [3, 2, 3]);
  // not LAN play's UDP (its ICMP, kind 5): every page with LAN play open, whatever its ports
  c.udp = UDP_SET;
  assert.ok(sw.route(a, frame(KIND_LAN_ICMP, BROADCAST), [BROADCAST]));
  assert.equal(got(c), 3);
  assert.equal(sw.stats.bcastSkipped, 1);
  sw.stop(sw.now);
});

/** the free-roam hub for these tests: only its address (10.77.0.253) */
const hubHost = () => ({
  vip: (BASE | 0xfd) >>> 0, name: '', listed: () => false, frame() {}, peerGone() {}, info: () => ({}), vips: () => new Set(),
  stop() {}, nextTickMs: () => Infinity, tick() {},
});

/// The hub's lists, map and lobbies (send_to from 10.77.0.253) to a page that takes bundles go in its next
/// bundle, marked for the compact form; to one that does not, a message of their own as before, and so does any
/// other host's frame (the Online host's TCP segments)
test('the_hubs_frames_go_in_a_bundle_to_a_page_that_takes_them', () => {
  const sw = newSwitch({}, { roam: () => hubHost() });
  const [, , a] = peer(sw, 'a');
  const [, , b] = peer(sw, 'b');
  const h = (bundle) => hello('{"t":"hello","name":"x","bundle":' + bundle + ',"compact":' + bundle + '}');
  sw.hello(a, h(1));
  sw.hello(b, h(0));
  const from = (src, to, kind) => {
    const f = frame(kind, to);
    new DataView(f.buffer).setUint32(4, src >>> 0);
    return f;
  };
  const hub = (BASE | 0xfd) >>> 0;
  assert.equal(sw.sendTo(a.vip, from(hub, a.vip, KIND_UDP), null), 'sent');
  assert.equal(sw.sendTo(b.vip, from(hub, b.vip, KIND_UDP), null), 'sent');
  assert.equal(sw.sendTo(a.vip, from(BASE | 1, a.vip, KIND_STREAM), null), 'sent');
  const x = (v) => (v >>> 0).toString(16);
  const kinds = (p) => p.conn.q.flatMap((o) => (o.k === 'dgram' ? ['dgram ' + x(o.src) + '>' + x(o.dst)] : o.k === 'raw' ? ['raw ' + x(be32(o.data, 4))] : []));
  assert.deepEqual(kinds(a), ['dgram ' + x(hub) + '>' + x(a.vip), 'raw ' + x(BASE | 1)]);
  assert.deepEqual(kinds(b), ['raw ' + x(hub)]);
  assert.ok(a.conn.dgram > 0, "counted as a bundle's entry");
  sw.stop(sw.now);
});

/// A frame waiting in a receiver's queue has bytes of its own: not the block the sender's reader read it into,
/// which a frame of a few bytes kept whole (the second security audit)
// Rust compared pointers; a JS view (subarray) keeps its whole ArrayBuffer alive the same way, so: the queued frame's
// buffer is not the sender's block's.
test('a_queued_frame_holds_its_own_bytes_not_the_senders_block', () => {
  const sw = newSwitch();
  const [, , a] = peer(sw, 'a');
  const [, , b] = peer(sw, 'b');
  for (const kind of [KIND_UDP, KIND_LAN_UDP, KIND_STREAM]) {
    const block = new Uint8Array(64 << 10);
    block.set(frame(kind, b.vip), 100);
    assert.ok(sw.route(a, block.subarray(100, 140), [b.vip]));
    const fr = b.conn.q.filter((o) => o.k === 'frame');
    assert.ok(fr.length > 0, 'kind ' + kind + ': queued');
    const data = fr[fr.length - 1].data;
    assert.notEqual(data.buffer, block.buffer, 'kind ' + kind + ": the queued frame is a slice of the sender's block");
    assert.ok(data.buffer.byteLength < block.buffer.byteLength, 'kind ' + kind + ': its own bytes, not a 64 KiB block');
    assert.deepEqual([...data], [...block.subarray(100, 140)]);
  }
  sw.stop(sw.now);
});

/// A stream segment whose receiver closed between the sender's look at it and the streams' lock: nothing of it
/// stays at the switch (the receiver's queue was let go with its connection, and must not come back).
test('a_segment_to_a_receiver_that_just_left_leaves_nothing_behind', () => {
  const sw = newSwitch();
  const [, , a] = peer(sw, 'a');
  const [bc, bctx, b] = peer(sw, 'b');
  // the sender saw b open (deliverNow); b's connection ends and its close logic runs; then the segment
  bc.terminate();
  sw.closed(bc, bctx);
  assert.ok(!sw.sendStream(a, b, frame(KIND_STREAM, b.vip), b.vip));
  assert.equal(sw.streams.byConn.size, 0, 'no stream queue for a connection that is gone');
  sw.stop(sw.now);
});

// ---- conn.rs ----

function dg(len, dst) {
  const d = new Uint8Array(len).fill(1);
  new DataView(d.buffer).setUint32(8, 0xffffffff);
  return { k: 'dgram', data: d, src: 0x0a4d0002, dst: dst >>> 0, at: 0 };
}
const text = (s) => ({ k: 'text', data: enc.encode(s) });
/** the bytes of the messages on the wire (RFC 6455 from the server: the JS writer hands whole messages to the
 * transport, which frames them; Rust's encode wrote the frames) */
const wire = (msgs) => msgs.reduce((n, m) => n + headerLen(m.data.length) + m.data.length, 0);

test('a_tick_wanders_within_its_jitter_and_keeps_its_mean', () => {
  // nextPeriodUs: µs (Rust a Duration); the injected Prng for Rust's xorshift state
  const c = new Clock(null, 50, 0.4, 0);
  const rng = new Prng(0x1234_5678_9abc_def1n);
  const ticks = Array.from({ length: 10_000 }, () => c.nextPeriodUs(rng));
  assert.ok(ticks.every((t) => t >= 30_000 && t <= 70_000));
  const mean = ticks.reduce((a, b) => a + b, 0) / ticks.length;
  assert.ok(mean >= 49_500 && mean <= 50_500, String(mean));
  assert.ok(ticks.some((t) => t < 32_000) && ticks.some((t) => t > 68_000));
  assert.equal(new Clock(null, 50, 0.0, 0).nextPeriodUs(rng), 50_000);
  assert.equal(new Clock(null, 50, NaN, 0).nextPeriodUs(rng), 50_000);
});

// The JS writer does not frame (Workers' WebSocket does): what is left of this one is header_len's rule itself
test('header_lengths_match_rfc6455', () => {
  const want = { 0: 2, 1: 2, 125: 2, 126: 4, 1000: 4, 65535: 4, 65536: 10, 100000: 10 };
  for (const [len, h] of Object.entries(want)) assert.equal(headerLen(Number(len)), h, len);
});

test('datagrams_become_bundles_of_at_most_bundle_out_one_alone_as_it_is', () => {
  const stats = new Stats();
  // one alone: as it is, its addresses written in
  let out = [];
  const cs = { closeSent: false };
  const e = encode(stats, [dg(20, 0x0a4d0103)], out, cs, null);
  assert.equal(e.extra, wire(out));
  assert.equal(out.length, 1);
  assert.equal(out[0].op, 'binary');
  assert.equal(out[0].data.length, 20);
  assert.equal(be32(out[0].data, 4), 0x0a4d0002);
  assert.equal(be32(out[0].data, 8), 0x0a4d0103);
  assert.equal(stats.bundlesOut, 0);
  // 8 KB datagrams: four to a bundle (4 x 8004 bytes fit in 32 KB), then the fifth alone
  out = [];
  encode(stats, Array.from({ length: 5 }, (_, i) => dg(8000, i)), out, cs, null);
  assert.equal(stats.bundlesOut, 1);
  assert.equal(out.length, 2);
  assert.equal(out[0].op, 'binary');
  assert.equal(headerLen(out[0].data.length), 4, "a 16-bit length (Rust's buf[1] == 126)");
  assert.equal(out[0].data.length, 4 + 4 * 8004);
  assert.equal(out[0].data[0], KIND_BUNDLE);
  assert.equal(be16(out[0].data, 4 + 2), 8000, "the first entry's length");
  assert.equal(out[1].data.length, 8000);
  assert.equal(be32(out[1].data, 8), 4);
  // 4 x 8192 + 4 x 4 is over 32 KB: three, then one alone
  out = [];
  encode(stats, Array.from({ length: 4 }, (_, i) => dg(8192, i)), out, cs, null);
  assert.equal(stats.bundlesOut, 2);
  assert.equal(out[0].data.length, 4 + 3 * 8196);
});

// a newcomer's welcome, queued before its first datagrams, goes before their bundle (a page in line takes bundles
// from its first moment); what came after the first datagram goes after the bundle; after a close frame nothing
test('the_welcome_goes_before_the_first_bundle', () => {
  const stats = new Stats();
  let out = [];
  encode(stats, [text('w'), dg(20, 1), text('p'), dg(20, 2)], out, { closeSent: false }, null);
  assert.deepEqual(out.map((m) => m.op), ['text', 'binary', 'text']);
  assert.equal(dec.decode(out[0].data), 'w');
  assert.equal(out[1].data.length, 4 + 2 * 24);
  assert.equal(out[1].data[0], KIND_BUNDLE);
  assert.equal(dec.decode(out[2].data), 'p');
  out = [];
  encode(stats, [{ k: 'close', data: Uint8Array.of(3, 0xe8) }, dg(20, 1)], out, { closeSent: false }, null);
  assert.deepEqual(out.map((m) => [m.op, [...m.data]]), [['close', [3, 0xe8]]], 'nothing after the close frame');
});

test('nothing_goes_after_a_close_frame', () => {
  const stats = new Stats();
  const out = [];
  const cs = { closeSent: false };
  const items = [text('a'), { k: 'close', data: Uint8Array.of(3, 0xf5) }, text('b')];
  const e = encode(stats, items, out, cs, null);
  assert.ok(e.close && cs.closeSent);
  assert.deepEqual(out.map((m) => [m.op, [...m.data]]), [['text', [97]], ['close', [3, 0xf5]]]);
  assert.equal(wire(out), 3 + 4);
  assert.equal(e.counted, 3 + 4 + 3);
});

