// Seeded traces for the switch's differential test: random players joining, saying hello, opening LAN play, sending
// frames and bundles of every kind to each other, the broadcast address and nobody, resuming, waiting in line,
// closing, dropping and being kicked.  Timing: a step that changes who is on the switch is followed by a wait longer
// than peers_ms, so that the peer list's changes go out in the same batches on both sides whatever the Rust side's
// real-time jitter (the Rust switch runs on real clocks).

import { Prng } from '../../src/util/prng.js';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** a free-roam datagram as rc_encode makes it (compact.rs tests roam) */
export function roamDatagram(kind, body) {
  const d = [0x4e, 0x32, 0x46, 0x52, 1, kind, 0, 0, 0x78, 0x56, 0x34, 0x12, 7, 0, 0, 0, ...body];
  const n = d.length + 4;
  d[6] = n & 255;
  d[7] = n >> 8;
  const c = crc32(d);
  d.push(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24);
  return d;
}

const NAMES = ['Ana', 'Bob', 'Zoë', 'ＦＵＬＬ', 'x'.repeat(40), 'a\u0000b', '  pad  ', 'Ñandú', '😀car', 'nigger', 'N1gg4', '', 'Mustafa GS', 'raccoon', '\u202Erlo', 'Dani99'];

export function genTrace(seed, o = {}) {
  const r = new Prng(BigInt(seed) * 7919n + 13n);
  const pick = (a) => a[r.below(a.length)];
  const chance = (p) => r.unit() < p;
  const maxPeers = pick([3, 4, 6, 128]);
  const options = {
    max_peers: maxPeers, max_waiting: pick([2, 3, 5000]), line_tell_ms: 100_000_000, bundle_ms: 0, probe_ms: 0, keepalive_ms: 100_000_000, peers_ms: 40,
    lan_ms: 0, away_ms: 0, resume_wait_ms: 300, group_reserve: pick([1, 2, 8]), site_reserve: pick([2, 16]), fpred: chance(0.8),
    probe_echo: false, max_frame: pick([8192, 600]), max_text: pick([1024, 200]),
  };
  const steps = [];
  const LONG = o.long ?? 90;
  const live = []; // client ids with a connection that may be open
  const known = []; // every client id
  let next = 0;
  const nSteps = o.steps ?? 60 + r.below(80);
  const frameTo = (id, kind, dstSpec, sport, dport, payload) => {
    const b = [kind, r.below(256), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, sport >> 8, sport & 255, dport >> 8, dport & 255, ...payload];
    const dst = [];
    if (typeof dstSpec === 'number') {
      b[8] = (dstSpec >>> 24) & 255; b[9] = (dstSpec >>> 16) & 255; b[10] = (dstSpec >>> 8) & 255; b[11] = dstSpec & 255;
    } else {
      dst.push([8, dstSpec.client]);
    }
    // a lie about the source: the switch writes the sender's own
    b[4] = r.below(256);
    return { b, dst };
  };
  const randomFrame = (id) => {
    const kinds = [1, 1, 1, 3, 3, 4, 5, 2, 9, 0];
    const kind = pick(kinds);
    const dstSpec = chance(0.25) ? 0xffffffff : chance(0.1) ? pick([0x0a4d0001, 0x0a4d00fd, 0x0a4d0505, 0]) : { client: pick(known) };
    let payload;
    let sport = 47210, dport = 47210;
    if (kind === 1 && chance(0.7)) {
      const t = pick([1, 2, 3, 3, 3, 9, 12, 13]); // (not 6, 7: a ping's or pong's stamp moves by the real wait in Rust)
      const body = Array.from({ length: t === 3 ? 60 + r.below(40) : r.below(30) }, () => r.below(256));
      payload = roamDatagram(t, body);
      if (chance(0.1)) payload[payload.length - 1] ^= 1; // a broken CRC
    } else {
      payload = Array.from({ length: r.below(chance(0.05) ? 900 : 60) }, () => r.below(256));
      sport = pick([47210, 3658, 9999]);
      dport = pick([47210, 3658, 6112]);
    }
    if (chance(0.03)) payload = []; // a 16-byte frame
    return frameTo(id, kind, dstSpec, sport, dport, payload);
  };
  for (let i = 0; i < nSteps; i++) {
    const w = r.below(100);
    if (w < 12 || live.length === 0) {
      // a new player (or one that comes back)
      const id = next++;
      const resume = known.length > 0 && chance(0.25);
      const queue = chance(0.4);
      const group = pick(['g0', 'g1', 'g' + id, null]);
      const site = pick([null, 's0', 's1']);
      steps.push({ op: 'connect', id, resume, queue, group, site });
      known.push(id);
      live.push(id);
      if (resume) {
        const old = pick(known.slice(0, -1));
        if (chance(0.8)) {
          const h = { t: 'hello', name: pick(NAMES), vip: chance(0.8) ? '@VIP' + old + '@' : '10.77.0.9', token: chance(0.85) ? '@TOKEN' + old + '@' : 'nope' };
          if (chance(0.3)) h.ticket = '@TICKET' + old + '@';
          if (chance(0.5)) h.lan = 1;
          if (chance(0.5)) h.bundle = 1;
          steps.push({ op: 'text', id, text: JSON.stringify(h) });
        } else if (chance(0.5)) {
          steps.push({ op: 'binary', id, hex: '010000000000000000000000' });
        } else {
          steps.push({ op: 'wait', ms: 400 });
        }
      }
      steps.push({ op: 'wait', ms: LONG });
      continue;
    }
    const id = pick(live);
    if (w < 24) {
      const h = { t: 'hello', name: pick(NAMES) };
      if (chance(0.5)) h.lan = pick([1, 0, '1', true]);
      if (chance(0.6)) h.bundle = 1;
      if (chance(0.5)) h.compact = 1;
      if (chance(0.5)) h.delta = 1;
      if (chance(0.4)) h.fpred = 1;
      if (chance(0.3)) h.ldelta = 1;
      if (chance(0.3)) h.udp = pick([0x80000000 | (1 << (3658 % 31)), 0x80000000 | (1 << (47210 % 31)), 5, -1]);
      if (chance(0.2)) h.block = ['Bob', '  x  ', 7];
      if (chance(0.1)) h.id = 'page-' + id;
      steps.push({ op: 'text', id, text: JSON.stringify(h) });
      steps.push({ op: 'wait', ms: LONG });
    } else if (w < 30) {
      const m = { t: 'lan', on: pick([0, 1, 1]) };
      if (chance(0.5)) m.udp = pick([0x80000000 | (1 << (3658 % 31)), 0x80000000 | (1 << (6112 % 31)), 0]);
      steps.push({ op: 'text', id, text: JSON.stringify(m) });
      steps.push({ op: 'wait', ms: 10 });
    } else if (w < 35) {
      steps.push({ op: 'text', id, text: pick([JSON.stringify({ t: 'ping', id: r.below(100000) }), '{"t":"ping","id":1.5}', 'not json', '{"t":"ping","id":-0}', '[1,2]', '{"t":"friend","x":1}']) });
    } else if (w < 75) {
      const f = randomFrame(id);
      steps.push({ op: 'binary', id, hex: hex(f.b), dst: f.dst });
    } else if (w < 85) {
      // a bundle: entries with n = 0 (to the frame's own) or n destinations
      const parts = [32, chance(0.1) ? 1 : 0, 0, 0];
      const dst = [];
      const ne = 1 + r.below(4);
      for (let e = 0; e < ne; e++) {
        const f = randomFrame(id);
        const k = chance(0.5) ? 0 : 1 + r.below(3);
        const at = parts.length;
        parts.push(k, 0, f.b.length >> 8, f.b.length & 255);
        for (let j = 0; j < k; j++) {
          dst.push([parts.length, pick(known)]);
          parts.push(0, 0, 0, 0);
        }
        const fat = parts.length;
        parts.push(...f.b);
        for (const [off, who] of f.dst) dst.push([fat + off, who]);
        if (chance(0.03)) parts[at + 2] = 0xff; // a broken entry
      }
      steps.push({ op: 'binary', id, hex: hex(parts), dst });
    } else if (w < 91) {
      steps.push({ op: 'close', id, code: pick([1000, 1000, 1001, 4000]), reason: pick(['idle', 'closed', '', 'bye']) });
      live.splice(live.indexOf(id), 1);
      steps.push({ op: 'wait', ms: LONG });
    } else if (w < 96) {
      steps.push({ op: 'drop', id });
      live.splice(live.indexOf(id), 1);
      steps.push({ op: 'wait', ms: LONG });
    } else if (w < 98) {
      steps.push({ op: 'expel', id, code: pick([4001, 4003]), msg: '{"t":"kick","msg":"out"}' });
      live.splice(live.indexOf(id), 1);
      steps.push({ op: 'wait', ms: LONG });
    } else {
      steps.push({ op: 'wait', ms: pick([5, 50, 400]) });
    }
  }
  return { seed, options, settle_ms: o.settle ?? 4, end_ms: o.end ?? 300, steps };
}

