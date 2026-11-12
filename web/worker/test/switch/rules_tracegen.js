// Seeded traces for the switch's rules differential (rules_diff.test.mjs; crates/lan/tests/difftrace_rules.rs is the
// Rust side): what the harness's serve() adds to a connection (?ident, ?refuse, ?gate, ?rename, ?norace, a keyphrase's
// owner), hellos with ids, "was", claims, blocks and names, frames and bundles to the Online host and the free-roam hub
// (race datagrams among them), the operator's race ban and kick, resumes, the line, closes and drops.  Timing as in
// tracegen.js: a step that changes who is on the switch is followed by a wait longer than peers_ms.

import { Prng } from '../../src/util/prng.js';
import { roamDatagram } from './tracegen.js';

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const ONLINE = 0x0a4d0001;
const HUB = 0x0a4d00fd;
const IDS = ['page-1', 'page-2', 'page-3', 'page-4', '', 'x'.repeat(65), 'é'.repeat(33)];
const CLAIMS = ['k1', 'k2', 'k3', 'y'.repeat(65), ''];
const NAMES = ['Ana', 'Bob', 'Zoë', 'carl', 'Mallory', '  pad  ', 'a\u0000b', 'x'.repeat(40), '', 'Ñandú'];
const BLOCKS = [['Bob'], [' Bob ', 'carl'], ['x'.repeat(30), 7, null, '\u00e9t\u00e9', '   '], Array.from({ length: 40 }, (_, i) => 'n' + i), 'Bob', []];

export function genRulesTrace(seed, o = {}) {
  const r = new Prng(BigInt(seed) * 104729n + 7n);
  const pick = (a) => a[r.below(a.length)];
  const chance = (p) => r.unit() < p;
  const options = {
    max_peers: pick([3, 5, 128]), max_waiting: pick([2, 5000]), line_tell_ms: 100_000_000, bundle_ms: 0, probe_ms: 0,
    keepalive_ms: 100_000_000, peers_ms: 40, lan_ms: 0, away_ms: 0, resume_wait_ms: 300, group_reserve: pick([1, 8]),
    site_reserve: pick([2, 16]), fpred: true, probe_echo: false, max_text: pick([1024, 300]),
  };
  const steps = [];
  const LONG = o.long ?? 90;
  const live = [];
  const known = [];
  let next = 0;
  const nSteps = o.steps ?? 50 + r.below(60);
  const frame = (kind, dstSpec, payload, sport = 47210, dport = 47210) => {
    const b = [kind, r.below(256), 0, 0, r.below(256), 0, 0, 0, 0, 0, 0, 0, sport >> 8, sport & 255, dport >> 8, dport & 255, ...payload];
    const dst = [];
    if (typeof dstSpec === 'number') {
      b[8] = (dstSpec >>> 24) & 255; b[9] = (dstSpec >>> 16) & 255; b[10] = (dstSpec >>> 8) & 255; b[11] = dstSpec & 255;
    } else dst.push([8, dstSpec.client]);
    return { b, dst };
  };
  const randomFrame = () => {
    const to = chance(0.45) ? pick([ONLINE, HUB, HUB]) : chance(0.2) ? 0xffffffff : { client: pick(known) };
    const kind = pick([1, 1, 3, 4, 5]);
    let payload;
    if (kind === 1 && chance(0.8)) {
      const t = pick([3, 9, 12, 13, 13, 1]);
      payload = roamDatagram(t, Array.from({ length: t === 3 ? 60 : r.below(20) }, () => r.below(256)));
    } else payload = Array.from({ length: r.below(40) }, () => r.below(256));
    return frame(kind, to, payload, pick([47210, 3658, 20922]), pick([47210, 3658, 20922]));
  };
  for (let i = 0; i < nSteps; i++) {
    const w = r.below(100);
    if (w < 14 || live.length === 0) {
      const id = next++;
      const resume = known.length > 0 && chance(0.2);
      const st = {
        op: 'connect', id, resume, queue: chance(0.3), group: pick(['g0', 'g1', 'g' + id, null]), site: pick([null, 's0']),
        ident: chance(0.3) ? 'ident-' + r.below(3) : null, refuse: chance(0.05) ? 'banned ' + id : null,
        gate: chance(0.2) ? pick(['page-1', 'page-2', 'owner-k1', 'owner-k2']) : null,
        rename: chance(0.15) ? pick(['Mallory', 'Bob']) : null, norace: chance(0.25) ? pick(['page-1', 'page-3']) : null,
      };
      steps.push(st);
      known.push(id);
      live.push(id);
      if (resume) {
        const old = pick(known.slice(0, -1));
        const h = { t: 'hello', name: pick(NAMES), vip: '@VIP' + old + '@', token: chance(0.85) ? '@TOKEN' + old + '@' : 'nope' };
        if (chance(0.3)) h.ticket = '@TICKET' + old + '@';
        if (chance(0.5)) h.id = pick(IDS);
        if (chance(0.3)) h.claim = pick(CLAIMS);
        if (chance(0.4)) h.block = pick(BLOCKS);
        if (chance(0.6)) h.lan = 1;
        steps.push({ op: 'text', id, text: JSON.stringify(h) });
      }
      steps.push({ op: 'wait', ms: LONG });
      continue;
    }
    const id = pick(live);
    if (w < 32) {
      const h = { t: 'hello', name: pick(NAMES) };
      if (chance(0.7)) h.id = pick(IDS);
      if (chance(0.4)) h.was = pick([['page-1', 'page-2'], ['page-3', 5, 'page-1', 'page-4', 'page-2', 'page-3'], 'page-1', []]);
      if (chance(0.4)) h.claim = pick(CLAIMS);
      if (chance(0.5)) h.block = pick(BLOCKS);
      if (chance(0.6)) h.lan = pick([1, 0]);
      if (chance(0.4)) h.bundle = 1;
      if (chance(0.2)) h.compact = 1;
      steps.push({ op: 'text', id, text: JSON.stringify(h) });
      steps.push({ op: 'wait', ms: LONG });
    } else if (w < 36) {
      steps.push({ op: 'text', id, text: JSON.stringify({ t: 'lan', on: pick([0, 1]) }) });
    } else if (w < 66) {
      const f = randomFrame();
      steps.push({ op: 'binary', id, hex: hex(f.b), dst: f.dst });
    } else if (w < 74) {
      const parts = [32, 0, 0, 0];
      const dst = [];
      const ne = 1 + r.below(3);
      for (let e = 0; e < ne; e++) {
        const f = randomFrame();
        const k = chance(0.6) ? 0 : 1 + r.below(2);
        parts.push(k, 0, f.b.length >> 8, f.b.length & 255);
        for (let j = 0; j < k; j++) {
          if (chance(0.5)) {
            const v = pick([ONLINE, HUB]);
            parts.push(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
          } else {
            dst.push([parts.length, pick(known)]);
            parts.push(0, 0, 0, 0);
          }
        }
        const fat = parts.length;
        parts.push(...f.b);
        for (const [off, who] of f.dst) dst.push([fat + off, who]);
      }
      steps.push({ op: 'binary', id, hex: hex(parts), dst });
    } else if (w < 80) {
      steps.push({ op: 'races', id, off: chance(0.7), msg: JSON.stringify({ t: 'races', msg: 'op ' + i }) });
      steps.push({ op: 'wait', ms: 10 });
    } else if (w < 86) {
      steps.push({ op: 'close', id, code: pick([1000, 1000, 1001]), reason: pick(['idle', 'closed', '']) });
      live.splice(live.indexOf(id), 1);
      steps.push({ op: 'wait', ms: LONG });
    } else if (w < 91) {
      steps.push({ op: 'drop', id });
      live.splice(live.indexOf(id), 1);
      steps.push({ op: 'wait', ms: LONG });
    } else if (w < 94) {
      steps.push({ op: 'expel', id, code: pick([4001, 4003]), msg: JSON.stringify({ t: 'kick', msg: 'out' }) });
      live.splice(live.indexOf(id), 1);
      steps.push({ op: 'wait', ms: LONG });
    } else {
      steps.push({ op: 'wait', ms: pick([5, 50, 400]) });
    }
  }
  return { seed, options, hosts: true, settle_ms: o.settle ?? 4, end_ms: o.end ?? 300, steps };
}
