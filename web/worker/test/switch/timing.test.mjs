// The Rust unit tests of the switch's timing and stat modules, ported: util/src/bucket.rs, lan/src/{lag, away, paths,
// impair, store}.rs (and members.rs store_list's format).  Run: node --test web/worker/test/switch/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Bucket, Budget, Rate } from '../../src/util/bucket.js';
import { Counter, Counters } from '../../src/util/counter.js';
import { Probe, SHARE_FULL, SHARE_MIN, BASE_MAX_MS, MAX_OUT, isSnap, pick, PickRng } from '../../src/switch/lag.js';
import * as away from '../../src/switch/away.js';
import { code, letters, region, REGIONS, LAN_TO, raceWith, take, Seen, p50And90, lines } from '../../src/switch/paths.js';
import { Impair, toUint32, toNumber, KIND_STREAM } from '../../src/switch/impair.js';
import { Prng } from '../../src/util/prng.js';

// ---- bucket.rs ----

test('bucket: refills and spends into debt', () => {
  const b = Bucket.newAt(10.0, 0.0);
  assert.ok(b.takeAt(0.0, 20.0));
  assert.ok(!b.takeAt(0.0, 1.0));
  assert.ok(b.hasAt(100.0, 1.0));
  assert.ok(!b.spendAt(100.0, 100.0));
  assert.equal(b.v, -20.0);
});

test('bucket: a bucket of its own burst', () => {
  const b = Bucket.withBurstAt(2.0, 5.0, 0.0);
  assert.ok(b.takeAt(0.0, 5.0) && !b.takeAt(0.0, 1.0));
  assert.equal(b.levelAt(1000.0), 2.0);
  assert.equal(b.v, 0.0, 'a look takes nothing and fills nothing');
  assert.equal(b.levelAt(10_000.0), 5.0, 'no more than the burst');
  assert.ok(b.takeAt(500.0, 1.0) && !b.takeAt(500.0, 0.5));
});

test('budget: keeps a free share', () => {
  const b = new Budget(3, 5, 4, 0.25);
  assert.ok(b.take('a', ''));
  assert.ok(b.take('a', ''));
  assert.ok(b.take('b', ''));
  // the last one is only for a client that holds none
  assert.ok(!b.take('a', ''));
  assert.ok(b.take('c', ''));
  assert.ok(!b.take('d', ''));
  b.give('a', '');
  assert.equal(b.held('a'), 1);
  // given back to none, a client and a site are forgotten
  b.give('a', '');
  assert.deepEqual([b.held('a'), b.count()], [0, 2]);
  const s = new Budget(5, 2, 100, 0.0);
  assert.ok(s.take('x', 's') && s.take('y', 's') && !s.take('z', 's'));
  s.give('x', 's');
  assert.ok(s.take('z', 's'), 'the site has room again');
  assert.ok(!s.by.has('x'), 'nothing kept for a client that holds none');
});

test('budget: room takes nothing', () => {
  const b = new Budget(2, 3, 100, 0.0);
  assert.ok(b.room('a', 's') && b.room('a', 's'));
  assert.equal(b.count(), 0);
  assert.ok(b.take('a', 's') && b.take('a', 's'));
  assert.ok(!b.room('a', 's'), 'the client has its share');
  assert.ok(b.room('b', 's') && b.take('b', 's'));
  assert.ok(!b.room('c', 's'), 'the site has its share');
  assert.ok(b.room('c', ''));
  b.give('a', 's');
  assert.ok(b.room('a', 's') && b.room('c', 's'));
  // the free share: a client that holds some has no room in it, a newcomer has
  const f = new Budget(9, 9, 4, 0.25);
  assert.ok(f.take('a', '') && f.take('a', '') && f.take('b', ''));
  assert.ok(!f.room('a', '') && f.room('c', ''));
  // no limit in all (usize::MAX)
  const u = new Budget(1, 1, Infinity, 0.5);
  assert.ok(u.take('a', '') && u.take('b', '') && !u.take('a', ''));
});

test('rate: limits a client and its site', () => {
  const r = new Rate(2.0, 0.0);
  assert.ok(r.take('a', 's', 0));
  assert.ok(r.take('a', 's', 0));
  assert.ok(!r.take('a', 's', 0));
  assert.ok(r.take('b', 's', 0));
  assert.ok(r.take('b', 's', 0));
  assert.ok(!r.take('c', 's', 0));
});

test('rate: check takes nothing', () => {
  const r = new Rate(1.0, 0.0);
  assert.ok(r.check('a', 's', 0) && r.check('a', 's', 0));
  assert.ok(r.take('a', 's', 0));
  assert.ok(!r.check('a', 's', 0));
  assert.ok(r.check('b', 's', 0));
  assert.ok(r.take('b', 's', 0));
  // the site's two are spent
  assert.ok(!r.check('c', 's', 0) && !r.take('c', 's', 0));
  assert.ok(r.check('c', '', 0));
});

test('rate: prune drops the buckets full again (not in Rust\'s tests)', () => {
  const r = new Rate(2.0, 1.0);
  assert.ok(r.take('a', '', 0) && r.take('b', '', 0) && r.take('b', '', 0));
  r.prune(1000); // a is full again (2), b has 1
  assert.deepEqual([...r.m.keys()], ['b']);
  r.prune(2000);
  assert.equal(r.m.size, 0);
});

test('counters (counter.rs, no Rust tests): add, inc, get', () => {
  const c = new Counter();
  c.inc();
  c.add(41);
  assert.equal(c.get(), 42);
  const cs = new Counters(3);
  cs.add(0, 2);
  cs.add(2, 5);
  assert.deepEqual(cs.get(), [2, 0, 5]);
  assert.throws(() => cs.add(3, 1));
});

// ---- lag.rs ----

/** the OS's random bytes for a ping: a seeded PRNG here */
const prng = new Prng(7n);

/** a ping queued at sent, answered at at: what pong says, and the share after it */
function answer(p, share, sent, at) {
  const d = p.ping(sent, prng);
  const r = p.pong(d, at, share);
  return [r, share.v];
}

// the share: halved once a round trip while late, the least past LAG_SEVERE_MS, an eighth back while not
test('lag: the share follows the round trips', () => {
  const share = { v: SHARE_FULL };
  const p = new Probe(0.0);
  // a path of 80 ms: all of them
  for (let t = 0; t < 5; t++) assert.equal(answer(p, share, t * 1000.0, t * 1000.0 + 80.0)[1], SHARE_FULL);
  // 600 ms waiting: halved, once for pings queued before that cut, again for one queued after it
  const a = p.ping(5000.0, prng);
  const b = p.ping(5100.0, prng);
  p.pong(a, 5680.0, share);
  assert.equal(share.v, SHARE_FULL / 2);
  p.pong(b, 5780.0, share);
  assert.equal(share.v, SHARE_FULL / 2, 'a ping queued before the cut does not cut again');
  assert.equal(answer(p, share, 6000.0, 6700.0)[1], SHARE_FULL / 4);
  // 2 s: the least at once
  assert.equal(answer(p, share, 7000.0, 9100.0)[1], SHARE_MIN);
  // between low and high: held
  assert.equal(answer(p, share, 10000.0, 10300.0)[1], SHARE_MIN);
  // back to the base: an eighth a round trip, never past all
  let s = SHARE_MIN;
  for (let k = 0; k < 10; k++) {
    const t = 11000.0 + k * 1000.0;
    const now = answer(p, share, t, t + 90.0)[1];
    assert.ok(now > s || now === SHARE_FULL, now + ' after ' + s);
    s = now;
  }
  assert.equal(s, SHARE_FULL);
});

// the base: the lowest round trip of the last 30-60 s, at most BASE_MAX_MS
test('lag: the base is the path without queues', () => {
  let share = { v: SHARE_FULL };
  // a far path (350 ms) is its own base: never cut
  const p = new Probe(0.0);
  for (let k = 0; k < 10; k++) {
    const t = k * 1000.0;
    assert.equal(answer(p, share, t, t + 350.0 + (t / 1000.0) * 10.0)[1], SHARE_FULL);
  }
  // a path queued from its first ping does not count as its base
  const q = new Probe(0.0);
  assert.equal(answer(q, share, 0.0, 3000.0)[1], SHARE_MIN);
  // a base two windows old is forgotten: the path got longer for good (a new route, 500 ms), it counts as waiting
  // until then (cut to the least), and as its own base (at most BASE_MAX_MS) after
  share = { v: SHARE_FULL };
  const r = new Probe(0.0);
  answer(r, share, 0.0, 50.0);
  for (let k = 1; k <= 58; k++) answer(r, share, k * 1000.0, k * 1000.0 + 500.0);
  assert.equal(share.v, SHARE_MIN);
  for (let k = 59; k <= 71; k++) answer(r, share, k * 1000.0, k * 1000.0 + 500.0);
  assert.equal(share.v, SHARE_FULL);
});

// a path longer than BASE_MAX_MS without queues (a satellite link): cut while it looks late, its share back once two
// windows of a cut share show its round trips are that long anyway; a queue on top of it cuts again
test('lag: a long path gets its share back', () => {
  // the review of 2026-10-23: 650 ms with one spike to 850 stayed at half for good, 900 ms at the least
  for (const [rtt, spike] of [[650.0, 850.0], [900.0, 900.0]]) {
    const share = { v: SHARE_FULL };
    const p = new Probe(0.0);
    let cut = false;
    for (let k = 0; k < 200; k++) {
      const t = k * 1000.0;
      const s = answer(p, share, t, t + (k === 20 ? spike : rtt))[1];
      cut ||= s < SHARE_FULL;
      if (k >= 120) assert.equal(s, SHARE_FULL, rtt + ' ms: all again at ' + k + ' s');
    }
    assert.ok(cut, rtt + ' ms: cut first, as a path that may be queued');
    // queued on top of it: cut again
    assert.equal(answer(p, share, 200_000.0, 200_000.0 + rtt + 600.0)[1], SHARE_FULL / 2);
    assert.equal(answer(p, share, 201_000.0, 201_000.0 + rtt + 2000.0)[1], SHARE_MIN);
  }
  // a path queued from the start that drains under the cut share: its base is the drained one, never raised
  const share = { v: SHARE_FULL };
  const q = new Probe(0.0);
  for (let k = 0; k < 10; k++) answer(q, share, k * 1000.0, k * 1000.0 + 3000.0 - k * 250.0);
  for (let k = 10; k < 130; k++) answer(q, share, k * 1000.0, k * 1000.0 + 120.0);
  assert.equal(share.v, SHARE_FULL);
  assert.equal(q.floor, BASE_MAX_MS);
  assert.equal(answer(q, share, 130_000.0, 130_000.0 + 700.0)[1], SHARE_FULL / 2);
});

// a pong: ours or not, and whether it says the client is there (a ping queued since the keepalive's tick)
test('lag: a pong is ours and a sign of life only for a ping since the tick', () => {
  const share = { v: SHARE_FULL };
  const p = new Probe(0.0);
  const old = p.ping(100.0, prng);
  p.tick(500.0);
  const nw = p.ping(600.0, prng);
  assert.equal(p.pong(new TextEncoder().encode('not ours'), 700.0, share), null);
  assert.equal(p.pong(old, 700.0, share), false, 'a ping from before the tick times, does not count');
  assert.equal(p.pong(nw, 750.0, share), true);
  assert.equal(p.pong(nw, 760.0, share), null, 'answered once');
  // the newest of several answered: those before it go, unanswered
  const a = p.ping(1000.0, prng);
  const b = p.ping(1100.0, prng);
  const c = p.ping(1200.0, prng);
  assert.equal(p.pong(c, 1300.0, share), true);
  assert.equal(p.pong(a, 1310.0, share), null);
  assert.equal(p.pong(b, 1320.0, share), null);
});

// how far behind: the last round trip, or a ping waiting longer
test('lag: lag counts a ping still waiting', () => {
  const share = { v: SHARE_FULL };
  const p = new Probe(0.0);
  assert.equal(p.lag(0.0), 0.0);
  assert.equal(p.rtt(), null);
  assert.equal(p.base(), null);
  answer(p, share, 0.0, 120.0);
  assert.equal(p.rtt(), 120.0);
  assert.equal(p.base(), 120.0);
  assert.equal(p.lag(500.0), 120.0);
  p.ping(1000.0, prng);
  assert.equal(p.lag(1050.0), 120.0);
  assert.equal(p.lag(4000.0), 3000.0);
  // never more than MAX_OUT waiting
  for (let t = 0; t < 200; t++) p.ping(5000.0 + t, prng);
  assert.equal(p.out.length, MAX_OUT);
});

test('lag: snapshots and picks', () => {
  const f = Uint8Array.from([1, 0, 0, 0, 10, 77, 0, 2, 10, 77, 1, 2, 0, 1, 0, 2, ...new TextEncoder().encode('N2FR'), 1, 3, 0, 0]);
  assert.ok(isSnap(f));
  f[21] = 1;
  assert.ok(!isSnap(f), 'a HELLO');
  f[21] = 3;
  f[20] = 2;
  assert.ok(!isSnap(f), 'another version');
  assert.ok(!isSnap(f.subarray(0, 21)));
  // picks: about the share, and every one at the full share (Rust's xorshift64; and with a Prng)
  for (const rng of [new PickRng(0x1234_5678_9abc_def0n), PickRng.fromPrng(new Prng(3n)), new Prng(5n)]) {
    const n = 100_000;
    let kept = 0;
    for (let i = 0; i < n; i++) if (pick(SHARE_FULL / 4, rng)) kept++;
    assert.ok(kept >= 23_000 && kept < 27_000, kept + ' of ' + n + ' at a quarter');
    for (let i = 0; i < 1000; i++) assert.ok(pick(SHARE_FULL, rng));
    for (let i = 0; i < 1000; i++) assert.ok(!pick(0, rng));
  }
});

test('lag: PickRng is xorshift64 (13, 7, 17) from seed | 1', () => {
  const M = (1n << 64n) - 1n;
  let x = 0x0123_4567_89ab_cdefn | 1n;
  const r = new PickRng(0x0123_4567_89ab_cdefn);
  for (let i = 0; i < 1000; i++) {
    x ^= (x << 13n) & M;
    x ^= x >> 7n;
    x ^= (x << 17n) & M;
    assert.equal(r.next32(), Number(x >> 32n));
  }
  assert.equal(new PickRng(0n).lo, 1, 'a zero seed is 1');
});

// ---- away.rs ----

function frame(kind, port, body) {
  const f = new Uint8Array(16 + 4 + 12 + body.length + 4);
  f[0] = 1; // KIND_UDP
  f[12] = away.ROAM_PORT >> 8;
  f[13] = away.ROAM_PORT & 255;
  f[14] = port >> 8;
  f[15] = port & 255;
  f.set(new TextEncoder().encode('N2FR'), 16);
  f.set([1, kind, 0, 0, 1, 2, 3, 4, 0, 1, 0, 0], 20);
  f.set(body, 32);
  return f;
}

test("away: a HELLO's and a SNAP's status", () => {
  // HELLO: core version 8, platform 3, status 4 (a shop)
  assert.equal(away.status(frame(1, away.ROAM_PORT, [8, 0, 3, 4, 0, 0, 0, 0])), 4);
  // SNAP: status 2 (driving) first
  assert.equal(away.status(frame(3, away.ROAM_PORT, [2, 7, 0, 0, 1, 0, 0, 0])), 2);
  // a ping, another port, another kind of frame: none
  assert.equal(away.status(frame(6, away.ROAM_PORT, new Array(8).fill(0))), null);
  assert.equal(away.status(frame(1, 9999, [8, 0, 3, 4, 0, 0, 0, 0])), null);
  const lan = frame(1, away.ROAM_PORT, [8, 0, 3, 4, 0, 0, 0, 0]);
  lan[0] = 3; // KIND_LAN_UDP
  assert.equal(away.status(lan), null);
  assert.equal(away.status(frame(1, away.ROAM_PORT, []).subarray(0, 30)), null);
  assert.ok(away.away(0) && away.away(1) && away.away(3) && away.away(4) && !away.away(2) && !away.away(5) && !away.away(6) && !away.away(202));
  assert.equal(away.SHARE, SHARE_FULL / 16);
});

// ---- paths.rs ----

const seen = (vip, c, base) => new Seen(vip, c === '--' ? 0 : code(c), base);

test('paths: percentiles by nearest rank', () => {
  assert.equal(p50And90([]), null);
  assert.deepEqual(p50And90([7.0]), [7.0, 7.0]);
  assert.deepEqual(p50And90([4.0, 1.0, 3.0, 2.0]), [2.0, 4.0]);
  assert.deepEqual(p50And90([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), [5.0, 9.0]);
  assert.deepEqual(p50And90(Array.from({ length: 100 }, (_, i) => i + 1)), [50.0, 90.0]);
});

test('paths: countries and regions', () => {
  assert.equal(REGIONS[region(code('DE'))], 'Western Europe');
  assert.equal(REGIONS[region(code('RU'))], 'Eastern Europe');
  assert.equal(REGIONS[region(code('TR'))], 'Western Asia');
  assert.equal(REGIONS[region(code('BR'))], 'South America');
  assert.equal(REGIONS[region(code('MX'))], 'Central America and the Caribbean');
  assert.equal(REGIONS[region(code('ZA'))], 'Sub-Saharan Africa');
  assert.equal(REGIONS[region(code('AQ'))], 'elsewhere');
  assert.equal(region(0), 0);
  assert.equal(letters(code('NL')), 'NL');
  assert.equal(code([0x4e, 0x4c]), code('NL'));
});

// a destination noted once, at most LAN_TO of them, all taken at once
test('paths: LAN pairs noted and taken', () => {
  let to = new Uint32Array(LAN_TO);
  for (const d of [5, 6, 5, 7, 6, 5]) raceWith(to, d);
  let got = [];
  take(to, got);
  got.sort((a, b) => a - b);
  assert.deepEqual(got, [5, 6, 7]);
  take(to, got);
  assert.equal(got.length, 3, 'taken: none left');
  // a race's five others, each noted (they may share a place: then each is there or its neighbour)
  to = new Uint32Array(LAN_TO);
  const others = [0x0A4D_0003, 0x0A4D_0104, 0x0A4D_0205, 0x0A4D_0306, 0x0A4D_0407];
  for (let i = 0; i < 3; i++) others.forEach((d) => raceWith(to, d));
  got = [];
  take(to, got);
  assert.ok(got.length >= 3 && got.every((d) => others.includes(d)), got.map((d) => d.toString(16)).join(' '));
});

test('paths: the lines', () => {
  const p = [
    seen(1, 'DE', 20.0),
    seen(2, 'DE', 30.0),
    seen(3, 'NL', 15.0),
    seen(4, 'BR', 200.0),
    seen(5, 'BR', 220.0),
    seen(6, '--', 90.0),
    seen(7, 'RU', null),
  ];
  let l = lines(p, [[1, 2], [1, 3], [4, 5], [1, 4], [3, 6], [2, 99]], [[4, 5]]);
  assert.equal(l.length, 4, JSON.stringify(l));
  assert.equal(
    l[0],
    "round trips to the server by country (each player's lowest of the last 30-60 s, players and ms p50/p90): " +
      'all 6 30/220; BR 2 200/220; DE 2 20/30; NL 1 15/15; unknown 1 90/90; 1 not timed yet',
  );
  assert.equal(l[1], 'round trips to the server by region: Western Europe 3 20/30; South America 2 200/220; unknown 1 90/90');
  // (2, 99): a player gone; (3, 6): a country not known, in the ways only
  assert.equal(
    l[2],
    'free-roam links now: 5 pairs of players, 50 % in one country and 75 % in one region (of the 4 whose countries ' +
      'are known); from one player to the other through the server (their round trips together, pairs and ms ' +
      'p50/p90): all 5 105/420, within one region 3 50/420, across regions 1 220/220',
  );
  assert.ok(l[3].startsWith("LAN play's pairs since the last count (races, their lobbies): 1 pair of players, 100 % in one country"));
  // nobody timed: nothing
  assert.deepEqual(lines([seen(1, 'DE', null)], [], []), []);
  // the rest past the top countries in one entry
  const many = Array.from({ length: 20 }, (_, i) => new Seen(i + 1, code([65 + i, 65]), i));
  l = lines(many, [], []);
  assert.ok(l[0].endsWith('; 8 more countries 8 15/19'), l[0]);
});

test("paths: {:.0} rounds ties to even, as Rust's format! does", () => {
  // 12.5 % (1 of 8) is "12", 37.5 % "38"; a p50 of 2.5 ms is "2"
  const p = [];
  for (let i = 0; i < 8; i++) p.push(new Seen(i + 1, code(i === 0 ? 'DE' : 'FR'), i === 0 ? 2.5 : 3.5));
  p.push(new Seen(100, code('US'), 1.0));
  const pairsList = [];
  for (let i = 1; i < 8; i++) pairsList.push([1, i + 1]);
  pairsList.push([1, 100]);
  const l = lines(p, pairsList, []);
  assert.ok(l[2].includes(', 0 % in one country and 88 % in one region (of the 8'), l[2]);
  const one = lines([new Seen(1, code('DE'), 2.5)], [], []);
  assert.ok(one[0].endsWith('all 1 2/2; DE 1 2/2'), one[0]);
});

// ---- impair.rs ----

test('impair: spec and random numbers', () => {
  const im = Impair.parse('delay=80,jitter=0,loss=100,seed=3,bogus=1,reorder=x');
  assert.equal(JSON.stringify(im.specJson()), '{"delay":80,"jitter":0,"loss":100,"reorder":0,"seed":3}');
  // x = 3: the xorshift32's first step, by hand
  let x = 3;
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ (x << 5)) >>> 0;
  assert.equal(im.rand(), x / 4_294_967_296.0);
  assert.equal(Impair.parse(''), null);
  assert.equal(toUint32(-1.0), 0xFFFFFFFF);
  assert.equal(toUint32(4_294_967_297.5), 1);
  assert.equal(toNumber(' 0x1F '), 31);
  assert.ok(Number.isNaN(toNumber('1e')));
});

test('impair: legs in order per browser and stalls', () => {
  const im = Impair.parse('leg=100,leg.3=40,legjitter=30,stall.4=100,stallms=500,seed=7');
  assert.ok(im.legsOn());
  assert.equal(
    JSON.stringify(im.specJson()),
    '{"delay":0,"jitter":0,"loss":0,"reorder":0,"seed":7,"leg":100,"legjitter":30,"stall":0,"stallms":500,"leg.3":40,"stall.4":100}',
  );
  const [a, b, c] = [0x0a4d_0002, 0x0a4d_0003, 0x0a4d_0004];
  const t0 = 1_000_000;
  // 100 +- 30 ms, never before the frame before it on the same leg
  let last = 0.0;
  for (let i = 0; i < 50; i++) {
    const t = im.legTime(a, true, t0 + i) - t0;
    assert.ok(t >= last && t >= i + 69.9 && t <= i + 130.1, String(t));
    last = t;
  }
  // leg.3: 40 +- 30; its way down is its own leg (in order with nothing on its way up)
  const t = im.legTime(b, false, t0) - t0;
  assert.ok(t >= 9.9 && t <= 70.1, String(t));
  // stall.4=100: the first frame stalls the leg for 500 ms, and the next ones wait for it too
  const t1 = im.legTime(c, true, t0) - t0;
  const t2 = im.legTime(c, true, t0 + 100) - t0;
  assert.ok(t1 >= 499.9 && t2 >= t1, t1 + ' ' + t2);
  // none of it without the keys
  assert.ok(!Impair.parse('delay=80').legsOn());
});

test('impair: the delivery queue (sans-IO stand-in for Impair::start)', () => {
  const im = Impair.parse('delay=50');
  const [A, B] = [{ vip: 0x0a4d_0002 }, { vip: 0x0a4d_0003 }];
  const stats = { lost: 0 };
  assert.equal(im.nextDueMs(), Infinity);
  assert.ok(im.deliver(stats, A, B, Uint8Array.of(3, 1), B.vip, 0));
  assert.ok(im.deliver(stats, A, B, Uint8Array.of(KIND_STREAM, 2), B.vip, 0));
  assert.ok(im.deliver(stats, B, A, Uint8Array.of(5, 3), A.vip, 10));
  assert.equal(im.nextDueMs(), 50);
  assert.deepEqual(im.due(49), []);
  const got = im.due(50).map((d) => [d.from.vip, d.data[1]]);
  assert.deepEqual(got, [[A.vip, 1], [A.vip, 2]], 'equal times in the order they came');
  assert.equal(im.due(60).length, 1);
  assert.equal(im.waiting, 0);
  // loss=100: every datagram lost, counted; TCP never
  const lossy = Impair.parse('loss=100');
  assert.ok(!lossy.deliver(stats, A, B, Uint8Array.of(3), B.vip, 0));
  assert.ok(lossy.deliver(stats, A, B, Uint8Array.of(KIND_STREAM), B.vip, 0));
  assert.equal(stats.lost, 1);
  // TCP stays in order: a segment never overtakes the one before it; forget() drops a browser's order
  const tcp = Impair.parse('delay=100');
  tcp.deliver(null, A, B, Uint8Array.of(KIND_STREAM, 1), B.vip, 0);
  tcp.delay = 10;
  tcp.deliver(null, A, B, Uint8Array.of(KIND_STREAM, 2), B.vip, 5);
  assert.deepEqual(tcp.due(100).map((d) => d.data[1]), [1, 2]);
  tcp.forget(A.vip);
  assert.equal(tcp.tcpLast.size, 0);
});

// ---- store.rs, members.rs store_list ----

let storeMod = null;
try {
  storeMod = await import('../../src/switch/store.js');
} catch (e) {
  if (!(e && e.code === 'ERR_MODULE_NOT_FOUND')) throw e;
  console.log('# store.js skipped: ' + e.message.split('\n')[0]);
}

test('store: reads what it wrote and skips what is broken', { skip: storeMod ? false : 'src/switch/text.js (vipNum, jsString) is not there yet' }, async () => {
  const { load, save, storeList, STORE_KEY } = storeMod;
  const { base64url } = await import('../../src/util/js.js');
  const m = new Map();
  const s = { get: (k) => m.get(k), put: (k, v) => void m.set(k, v) };
  assert.deepEqual(await load(s), []);
  const h = base64url(new Uint8Array(32).fill(7));
  const json = '[{"v":"10.77.0.2","h":"' + h + '"},{"v":"10.77.0.1","h":"' + h + '"},{"v":"10.77.1.2","h":"short"},7,null,{"v":["10.77.2.2"],"h":"' + h + '"}]';
  assert.equal(await save(s, 1, json), true);
  assert.equal(m.get(STORE_KEY), json);
  assert.deepEqual(await load(s), [[0x0A4D_0002, new Uint8Array(32).fill(7)], [0x0A4D_0202, new Uint8Array(32).fill(7)]]);
  // an older list never overwrites a newer one
  assert.equal(await save(s, 1, '[]'), false);
  assert.equal((await load(s)).length, 2);
  m.set(STORE_KEY, '{not json');
  assert.deepEqual(await load(s), []);
  // the list's format
  assert.equal(storeList([[0x0A4D_0002, new Uint8Array(32).fill(7)], [0x0A4D_5F03, new Uint8Array(32)]]),
    '[{"v":"10.77.0.2","h":"' + h + '"},{"v":"10.77.95.3","h":"' + base64url(new Uint8Array(32)) + '"}]');
  assert.equal(storeList([]), '[]');
});

test('store: async storage: saves run in order, a failed one leaves the seq to the next', { skip: storeMod ? false : 'src/switch/text.js missing' }, async () => {
  const { load, save, STORE_KEY } = storeMod;
  const m = new Map();
  const log = [];
  let fail = false;
  const s = {
    get: async (k) => m.get(k),
    put: (k, v) =>
      new Promise((res, rej) => setTimeout(() => {
        if (fail) return rej(new Error('disk full'));
        log.push(v);
        m.set(k, v);
        res();
      }, v === '[1]' ? 20 : 1)),
  };
  const p1 = save(s, 1, '[1]');
  const p2 = save(s, 2, '[2]');
  const p0 = save(s, 1, '[old]');
  assert.deepEqual(await Promise.all([p1, p2, p0]), [true, true, false]);
  assert.deepEqual(log, ['[1]', '[2]']);
  assert.equal(m.get(STORE_KEY), '[2]');
  fail = true;
  assert.equal(await save(s, 3, '[3]'), false);
  fail = false;
  assert.equal(await save(s, 3, '[3]'), true, 'tried again at the same seq');
  assert.deepEqual(await load(s), []);
});
