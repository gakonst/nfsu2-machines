// Seeded cases for the switch's timing modules, and the JavaScript side of web/server-rs/crates/lan-diff-timing (the
// Rust modules unchanged, driven by the same JSON cases): timing-diff.test.mjs sends both the same cases and compares
// every output exactly.  Floats travel as the hex of their IEEE bits, bytes as hex.
import { Prng } from '../../src/util/prng.js';
import { Bucket, Budget, Rate } from '../../src/util/bucket.js';
import { Probe, SHARE_FULL, SHARE_MIN, isSnap, pick, PickRng } from '../../src/switch/lag.js';
import * as away from '../../src/switch/away.js';
import { code, region, LAN_TO, raceWith, take, Seen, lines } from '../../src/switch/paths.js';
import { Impair, toNumber } from '../../src/switch/impair.js';
import { parseStore, storeList } from '../../src/switch/store.js';

const view = new DataView(new ArrayBuffer(8));
/** a double's bits as hex */
export function fb(x) {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}
/** the double of hex bits */
export function bf(h) {
  view.setBigUint64(0, BigInt('0x' + h));
  return view.getFloat64(0);
}
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s) => Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));

const pickOf = (r, a) => a[r.below(a.length)];

/** a float of many kinds: whole, halves, fractions, small, big, negative, zero */
function anyFloat(r, scale) {
  switch (r.below(7)) {
    case 0: return r.below(scale + 1);
    case 1: return r.below(2 * scale + 1) / 2;
    case 2: return r.unit() * scale;
    case 3: return r.unit();
    case 4: return pickOf(r, [0, -0, 0.1, 0.2, 0.3, 1 / 3, 1e-9, 1e9, 2 ** 53, -1, -0.5]);
    case 5: return -r.unit() * scale;
    default: return Math.round(r.unit() * scale * 1000) / 1000;
  }
}

function bucketCase(r) {
  const rate = pickOf(r, [0, 0.5, 1, 2, 10, 100, 1000, anyFloat(r, 50)]);
  let now = anyFloat(r, 100000);
  const ops = [r.below(2) ? { op: 'new', rate: fb(rate), now: fb(now) } : { op: 'burst', rate: fb(rate), burst: fb(anyFloat(r, 40)), now: fb(now) }];
  const n = 1 + r.below(40);
  for (let i = 0; i < n; i++) {
    now += r.below(10) === 0 ? -anyFloat(r, 100) : anyFloat(r, 3000);
    ops.push({ op: pickOf(r, ['level', 'has', 'take', 'take', 'spend', 'spend']), now: fb(now), n: fb(Math.abs(anyFloat(r, 30))) });
  }
  return { k: 'bucket', ops };
}

function budgetCase(r) {
  const keys = ['a', 'b', 'c', 'd', 'e'], sites = ['', '', 's', 't'];
  const ops = [];
  const n = 1 + r.below(60);
  for (let i = 0; i < n; i++) ops.push({ op: pickOf(r, ['take', 'take', 'take', 'room', 'give', 'held']), key: pickOf(r, keys), site: pickOf(r, sites) });
  return {
    k: 'budget', per: 1 + r.below(4), per_site: 1 + r.below(6), total: r.below(4) === 0 ? null : 1 + r.below(10),
    free: fb(pickOf(r, [0, 0.25, 0.5, 0.1, r.unit()])), ops,
  };
}

function rateCase(r) {
  const ops = [];
  let now = anyFloat(r, 1000);
  const n = 1 + r.below(60);
  for (let i = 0; i < n; i++) {
    now += r.below(3) === 0 ? 0 : anyFloat(r, 2000);
    ops.push({ op: pickOf(r, ['take', 'take', 'check', 'prune']), key: pickOf(r, ['a', 'b', 'c', 'site s']), site: pickOf(r, ['', 's', 't']), now: fb(now) });
  }
  return { k: 'rate', burst: fb(pickOf(r, [1, 2, 3, 5, 0.5, anyFloat(r, 6)])), rate: fb(pickOf(r, [0, 0.5, 1, 3, r.unit()])), ops };
}

/** a ping and pong timeline: a path of some base, with queues coming and going, ticks, stale and foreign pongs */
function lagCase(r) {
  let now = anyFloat(r, 10000);
  const ops = [];
  const base = pickOf(r, [20, 80, 150, 350, 650, 900, 1500, r.below(1200)]);
  let sent = 0;
  const waiting = []; // indices of the pings sent
  const sentAt = [];
  const n = 20 + r.below(300);
  let queue = 0;
  for (let i = 0; i < n; i++) {
    const c = r.below(20);
    if (c < 8) {
      ops.push({ op: 'ping', now: fb(now) });
      sentAt.push(now);
      waiting.push(sent++);
    } else if (c < 16 && waiting.length) {
      // answered: the oldest mostly, sometimes a newer one (those before go), now and then one answered already
      if (r.below(4) === 0) queue = pickOf(r, [0, 0, 300, 600, 1600, 3000, r.below(5000), 149.5, 150, 150.5, 400, 400.5, 400.25, 1500, 1500.5, 1500.125, r.below(2000) / 2]);
      const j = r.below(8) === 0 ? r.below(sent) : waiting[r.below(4) === 0 ? r.below(waiting.length) : 0];
      // its round trip: the path's base and the queue now (thresholds hit exactly now and then), from when it was sent
      const at = r.below(4) === 0 ? now + base + queue : sentAt[j] + base + queue + (r.below(3) === 0 ? r.unit() * 50 : 0);
      ops.push({ op: 'pong', j, now: fb(at) });
      if (at > now) now = at;
      const w = waiting.indexOf(j);
      if (w >= 0) waiting.splice(0, w + 1);
    } else if (c === 16) ops.push({ op: 'tick', now: fb(now) });
    else if (c === 17) ops.push({ op: 'pong', d: hex(Uint8Array.from({ length: r.below(10) }, () => r.below(256))), now: fb(now) });
    else if (c === 19 && r.below(4) === 0) {
      // a burst of pings with no pong: past MAX_OUT the oldest are forgotten
      for (let k = 60 + r.below(12); k > 0; k--) {
        ops.push({ op: 'ping', now: fb(now) });
        sentAt.push(now);
        waiting.push(sent++);
        now += r.below(3);
      }
      while (waiting.length > 64) waiting.shift();
    } else ops.push({ op: 'lag', now: fb(now + r.below(5000)) });
    now += pickOf(r, [0, 100, 1000, 1000, 1000, 5000, 30000, r.below(40000), r.unit() * 3000]);
  }
  return { k: 'lag', share: pickOf(r, [SHARE_FULL, SHARE_FULL, SHARE_MIN, r.below(SHARE_FULL + 1)]), now: fb(anyFloat(r, 10000)), ops };
}

function pickCase(r) {
  const seed = r.next64();
  const shares = Array.from({ length: 50 + r.below(300) }, () => pickOf(r, [0, 1, SHARE_MIN, SHARE_FULL / 4, SHARE_FULL / 2, SHARE_FULL, SHARE_FULL + 5, r.below(SHARE_FULL)]));
  return { k: 'pick', seed: (r.below(10) === 0 ? 0n : seed).toString(), shares };
}

function framesCase(r) {
  const frames = [];
  for (let i = 0; i < 40; i++) {
    const len = pickOf(r, [r.below(60), 36, 40, 22, 21, 44]);
    const f = Uint8Array.from({ length: len }, () => r.below(256));
    if (r.below(4)) {
      if (len > 0) f[0] = pickOf(r, [1, 1, 3, 4, 7]);
      if (len > 15 && r.below(4)) { f[14] = 47210 >> 8; f[15] = 47210 & 255; }
      if (len > 19 && r.below(4)) f.set([0x4e, 0x32, 0x46, 0x52], 16);
      if (len > 20 && r.below(4)) f[20] = pickOf(r, [1, 1, 2]);
      if (len > 21 && r.below(4)) f[21] = pickOf(r, [1, 3, 3, 6]);
    }
    frames.push(hex(f));
  }
  return { k: 'frames', frames };
}

const COUNTRIES = ['DE', 'FR', 'NL', 'GB', 'US', 'CA', 'BR', 'AR', 'RU', 'PL', 'TR', 'IN', 'JP', 'AU', 'ZA', 'EG', 'MX', 'SE', 'IT', 'ES', 'AQ', 'ZZ', 'XK', 'SH'];

function pathsCase(r) {
  const np = r.below(45);
  const players = [];
  const pool = Array.from({ length: 3 + r.below(COUNTRIES.length - 2) }, () => pickOf(r, COUNTRIES));
  for (let i = 0; i < np; i++) {
    const c = r.below(8) === 0 ? 0 : r.below(20) === 0 ? r.below(65536) : code(pickOf(r, pool));
    const base = r.below(6) === 0 ? null : pickOf(r, [r.below(500), r.below(1000) / 2, r.unit() * 400, 12.5, 0]);
    const vip = r.below(10) === 0 && players.length ? players[r.below(players.length)][0] : 1 + r.below(60);
    players.push([vip, c, base === null ? null : fb(base)]);
  }
  const pairs = () => Array.from({ length: r.below(30) }, () => [1 + r.below(70), 1 + r.below(70)]);
  return { k: 'paths', players, roam: pairs(), lan: pairs() };
}

function raceCase(r) {
  const pool = Array.from({ length: 1 + r.below(12) }, () => (r.below(3) ? 0x0A4D0000 + r.below(0x6000) : r.next32()) || 1);
  const ops = [];
  for (let i = 0; i < 1 + r.below(80); i++) ops.push(r.below(8) === 0 ? null : pickOf(r, pool));
  ops.push(null);
  return { k: 'race', ops };
}

function numCase(r) {
  const alpha = '0123456789.eE+-xXoObB aF_\t';
  const s = [];
  for (let i = 0; i < 60; i++) {
    if (r.below(4) === 0) s.push(pickOf(r, ['', ' ', 'Infinity', '-Infinity', '+Infinity', 'inf', 'nan', 'NaN', '0x', '0x1F', '0b101', '0o777', '1e400', '-0', '1.', '.5', '+.5', '1.e5', '.', 'e5', '1e', '0x' + 'f'.repeat(20), '0x941df83afbaa44decce1', '0X2b4174e363ffed1', '0b' + '1'.repeat(60) + '01', '\u00a01\u2028', '\ufeff7']));
    else s.push(Array.from({ length: 1 + r.below(8) }, () => alpha[r.below(alpha.length)]).join(''));
  }
  return { k: 'num', s };
}

const SPEC_KEYS = ['delay', 'jitter', 'loss', 'reorder', 'hold', 'holdms', 'seed', 'leg', 'legjitter', 'stall', 'stallms', 'leg.2', 'leg.3', 'leg.10', 'stall.3', 'stall.4', 'leg.+5', 'leg.-1', 'leg.99999999999', 'leg.4294967295', 'stall.x', 'leg.', 'bogus', ''];

function specCase(r) {
  if (r.below(20) === 0) return { k: 'spec', spec: '' };
  const parts = [];
  for (let i = 0; i < 1 + r.below(8); i++) {
    const v = pickOf(r, [String(r.below(500)), String(r.unit() * 100), '0x1f', '', 'x', ' 5 ', '1e3', '-20', 'Infinity', '0', '2.5', '1e400', '-0']);
    parts.push(r.below(15) === 0 ? pickOf(r, SPEC_KEYS) : pickOf(r, SPEC_KEYS) + '=' + v + (r.below(15) === 0 ? '=9' : ''));
  }
  return { k: 'spec', spec: parts.join(',') };
}

/** an impairment spec the delivery replay runs: sane sizes (Rust panics on durations past u64 seconds) */
function impairSpec(r) {
  const kv = [];
  const add = (k, v) => kv.push(k + '=' + v);
  if (r.below(4)) add('delay', pickOf(r, [0, 1, 20, 80, 150, r.below(300)]));
  if (r.below(2)) add('jitter', pickOf(r, [0, 10, 30, r.below(100)]));
  if (r.below(3) === 0) add('loss', pickOf(r, [5, 20, 50, 100]));
  if (r.below(3) === 0) add('reorder', pickOf(r, [5, 25, 50]));
  if (r.below(3) === 0) { add('hold', pickOf(r, [5, 20, 60])); if (r.below(2)) add('holdms', pickOf(r, [50, 300, r.below(1000)])); }
  if (r.below(3) === 0) add('leg', pickOf(r, [10, 50, r.below(200)]));
  if (r.below(4) === 0) add('legjitter', pickOf(r, [5, 30]));
  if (r.below(4) === 0) add('stall', pickOf(r, [2, 10]));
  if (r.below(5) === 0) add('stall.' + (2 + r.below(4)), pickOf(r, [20, 100]));
  if (r.below(5) === 0) add('leg.' + (2 + r.below(4)), r.below(150));
  if (r.below(4) === 0) add('stallms', pickOf(r, [100, 500, r.below(1500)]));
  add('seed', r.below(5) === 0 ? 0 : r.below(1 << 30));
  return kv.join(',');
}

function impairCase(r) {
  const spec = impairSpec(r);
  const vips = Array.from({ length: 2 + r.below(4) }, (_, i) => 0x0A4D0002 + i + (r.below(4) === 0 ? 0x100 : 0));
  let t = r.below(100);
  const events = [];
  for (let i = 0; i < 1 + r.below(120); i++) {
    if (r.below(30) === 0) events.push({ t, op: 'f', vip: pickOf(r, vips) });
    else {
      const from = pickOf(r, vips);
      let to = pickOf(r, vips);
      if (to === from) to = vips[(vips.indexOf(from) + 1) % vips.length];
      const data = Uint8Array.from({ length: 1 + r.below(4) }, () => r.below(256));
      data[0] = pickOf(r, [3, 3, 4, 5]);
      events.push({ t, op: 'd', from, to, data: hex(data), dst: to });
    }
    t += pickOf(r, [0, 0, 1, 5, 16, 50, r.below(400)]);
  }
  return { k: 'impair', spec, events, end: t + 20000 };
}

function storeCase(r) {
  const h32 = () => {
    const b = Uint8Array.from({ length: 32 }, () => r.below(256));
    let s = Buffer.from(b).toString('base64url');
    if (r.below(6) === 0) s = Buffer.from(b).toString('base64'); // '+', '/', padding
    if (r.below(10) === 0) s = s.slice(0, 2) + '!*' + s.slice(2);
    return s;
  };
  const vipText = () => pickOf(r, ['10.77.0.2', '10.77.95.251', '10.77.96.2', '10.77.0.1', '10.77.0.252', '10.77.1.1', '10.077.0.2', '10.77.0.2 ', '1.2.3.4', '10.77.12.200']);
  const entries = [];
  for (let i = 0; i < r.below(12); i++) {
    const c = r.below(14);
    if (c < 7) entries.push('{"v":"' + vipText() + '","h":"' + h32() + '"}');
    else if (c === 7) entries.push('{"v":["' + vipText() + '"],"h":"' + h32() + '"}');
    else if (c === 8) entries.push('{"h":"' + h32() + '","v":"' + vipText() + '","v":"10.77.3.4"}');
    else if (c === 9) entries.push('{"v":"' + vipText() + '","h":"short"}');
    else if (c === 10) entries.push(pickOf(r, ['7', 'null', '"x"', '[]', '{}', '{"v":167575554,"h":"' + h32() + '"}', '1e400', '{"v":"10.77.0.2","h":7}']));
    else if (c === 11) entries.push('{"v":"' + vipText() + '","h":"' + h32() + '","x":[1,{"y":null}]}');
    else entries.push('{"v":"10.77.' + r.below(100) + '.' + r.below(256) + '","h":"' + h32() + '"}');
  }
  let text = '[' + entries.join(',') + ']';
  const c = r.below(12);
  if (c === 0) text = text.slice(0, r.below(text.length + 1));
  else if (c === 1) text = ' \n' + text + '\t ';
  else if (c === 2) text = '{"v":"10.77.0.2"}';
  let bytes = new TextEncoder().encode(text);
  if (c === 3 && bytes.length > 4) { bytes = Uint8Array.from(bytes); bytes[r.below(bytes.length)] = 0xff; }
  if (c === 4) return { k: 'store' }; // no file
  return { k: 'store', bytes: hex(bytes) };
}

function storeListCase(r) {
  const used = new Set();
  const vip = () => {
    for (let i = 0; i < 100; i++) {
      const v = (0x0A4D0000 | (r.below(96) << 8) | (2 + r.below(250))) >>> 0;
      if (!used.has(v)) return used.add(v), v;
    }
    throw new Error('vips');
  };
  const h = () => hex(Uint8Array.from({ length: 32 }, () => r.below(256)));
  const now = 1_700_000_000_000 + r.below(1_000_000);
  const peers = Array.from({ length: r.below(8) }, () => [vip(), h()]);
  const reserved = Array.from({ length: r.below(8) }, () => [r.below(3) === 0 && peers.length ? peers[r.below(peers.length)][0] : vip(), now + r.below(2000) - 1000, h()]);
  // a reservation's address unique among the reservations (IndexMap keys)
  const seenR = new Set();
  return { k: 'storelist', peers, reserved: reserved.filter(([v]) => !seenR.has(v) && seenR.add(v)), now };
}

const KINDS = [bucketCase, budgetCase, rateCase, lagCase, pickCase, framesCase, pathsCase, raceCase, numCase, specCase, impairCase, impairCase, storeCase, storeListCase];

/** the cases of seeds first..first+n-1 (each seed one of every kind), and the regions of codes (all of them, or a sample) */
export function makeCases(first, n, allRegions) {
  const cases = [];
  for (let s = first; s < first + n; s++) {
    for (let k = 0; k < KINDS.length; k++) cases.push(KINDS[k](new Prng(BigInt(s) * 1000n + BigInt(k))));
  }
  const codes = [];
  if (allRegions) for (let c = 0; c < 65536; c++) codes.push(c);
  else {
    const r = new Prng(99n);
    for (const c of COUNTRIES) codes.push(code(c));
    for (let i = 0; i < 300; i++) codes.push(r.below(65536));
    codes.push(0, 0x4142, 0x5a5a);
  }
  cases.push({ k: 'regions', codes });
  return cases;
}

// ---- the JavaScript side: each case as the Rust driver answers it ----

/** a stand-in for the OS's random bytes: the payloads the Rust run's pings got, in order */
class Replay {
  constructor(list) {
    this.list = list;
    this.i = 0;
  }
  bytes(n) {
    if (this.i >= this.list.length) throw new Error('Replay: no payload left');
    const b = this.list[this.i++];
    if (b.length !== n) throw new Error('Replay: payload size');
    return b;
  }
}

/**
 * what the JavaScript port answers to a case; expected (the Rust answer) only gives the lag case its pings' payloads
 * (Rust's come from the OS)
 */
export function runJs(c, expected) {
  switch (c.k) {
    case 'bucket': {
      let bk = null;
      return c.ops.map((o) => {
        let res = null;
        if (o.op === 'new') bk = Bucket.newAt(bf(o.rate), bf(o.now));
        else if (o.op === 'burst') bk = Bucket.withBurstAt(bf(o.rate), bf(o.burst), bf(o.now));
        else if (o.op === 'level') res = fb(bk.levelAt(bf(o.now)));
        else if (o.op === 'has') res = bk.hasAt(bf(o.now), bf(o.n));
        else if (o.op === 'take') res = bk.takeAt(bf(o.now), bf(o.n));
        else if (o.op === 'spend') res = bk.spendAt(bf(o.now), bf(o.n));
        return [res, fb(bk.rate), fb(bk.cap), fb(bk.v), fb(bk.t)];
      });
    }
    case 'budget': {
      const bg = new Budget(c.per, c.per_site, c.total === null ? Infinity : c.total, bf(c.free));
      return c.ops.map((o) => {
        let res = null;
        if (o.op === 'take') res = bg.take(o.key, o.site);
        else if (o.op === 'room') res = bg.room(o.key, o.site);
        else if (o.op === 'give') bg.give(o.key, o.site);
        else res = bg.held(o.key);
        return [res, bg.count()];
      });
    }
    case 'rate': {
      const rt = new Rate(bf(c.burst), bf(c.rate));
      return c.ops.map((o) => {
        const now = bf(o.now);
        if (o.op === 'take') return rt.take(o.key, o.site, now);
        if (o.op === 'check') return rt.check(o.key, o.site, now);
        rt.prune(now);
        return null;
      });
    }
    case 'lag': {
      const payloads = [];
      c.ops.forEach((o, i) => {
        if (o.op === 'ping') payloads.push(unhex(expected?.[i]?.[0] ?? '0000000000000000'));
      });
      const prng = new Replay(payloads);
      const share = { v: c.share };
      const p = new Probe(bf(c.now));
      const sent = [];
      return c.ops.map((o) => {
        const now = bf(o.now);
        let res = null;
        if (o.op === 'ping') {
          const d = p.ping(now, prng);
          sent.push(d);
          res = hex(d);
        } else if (o.op === 'tick') p.tick(now);
        else if (o.op === 'pong') res = p.pong(o.j !== undefined ? sent[o.j] : unhex(o.d), now, share);
        else res = fb(p.lag(now));
        const rtt = p.rtt(), base = p.base();
        return [res, share.v, rtt === null ? null : fb(rtt), base === null ? null : fb(base)];
      });
    }
    case 'pick': {
      const rng = new PickRng(BigInt(c.seed));
      return c.shares.map((s) => (pick(s, rng) ? '1' : '0')).join('');
    }
    case 'frames': {
      const aw = [];
      for (let s = 0; s < 256; s++) aw.push(away.away(s));
      return { frames: c.frames.map((h) => { const f = unhex(h); return [isSnap(f), away.status(f)]; }), away: aw };
    }
    case 'regions':
      return c.codes.map(region);
    case 'paths':
      return lines(c.players.map(([v, ct, b]) => new Seen(v, ct, b === null ? null : bf(b))), c.roam, c.lan);
    case 'race': {
      const to = new Uint32Array(LAN_TO);
      const out = [];
      for (const o of c.ops) {
        if (o === null) {
          const got = [];
          take(to, got);
          out.push(got);
        } else raceWith(to, o);
      }
      return out;
    }
    case 'num':
      return c.s.map((s) => fb(toNumber(s)));
    case 'spec': {
      const im = Impair.parse(c.spec);
      return im === null ? null : JSON.stringify(im.specJson());
    }
    case 'impair':
      return runImpairJs(c);
    case 'store':
      return parseStore(c.bytes === undefined ? undefined : unhex(c.bytes)).map(([v, h]) => [v, hex(h)]);
    case 'storelist': {
      // members.js storeList's choice: the peers, then the reservations still running whose address no peer holds
      const held = new Set(c.peers.map((p) => p[0]));
      const e = c.peers.map(([v, h]) => [v, unhex(h)]);
      for (const [v, until, h] of c.reserved) if (until > c.now && !held.has(v)) e.push([v, unhex(h)]);
      return storeList(e);
    }
    default:
      throw new Error('case kind ' + c.k);
  }
}

/**
 * The impairment as the switch drives it: at each event time the frames due by then first (on whole-ms ticks, as
 * tokio's timer wheel fires: the first tick at or after a frame's time), then the event.
 */
function runImpairJs(c) {
  const im = Impair.parse(c.spec);
  if (im === null) return null;
  const peers = new Map();
  const peer = (v) => {
    let p = peers.get(v);
    if (!p) peers.set(v, (p = { vip: v }));
    return p;
  };
  const out = [];
  let lost = '';
  const stats = { lost: 0 };
  const fire = (until) => {
    for (let i = 0; i < 1_000_000; i++) {
      const n = im.nextDueMs();
      if (n === Infinity) return;
      const tick = Math.ceil(n);
      if (tick > until) return;
      for (const d of im.due(tick)) out.push([tick * 1_000_000, d.from.vip, d.to.vip, d.dst, hex(d.data)]);
    }
    throw new Error('fire: unbounded');
  };
  for (const e of c.events) {
    fire(e.t);
    if (e.op === 'd') {
      const before = stats.lost;
      im.deliver(stats, peer(e.from), peer(e.to), unhex(e.data), e.dst, e.t);
      lost += stats.lost > before ? '1' : '0';
    } else im.forget(e.vip);
  }
  fire(c.end);
  return { lost, out };
}
