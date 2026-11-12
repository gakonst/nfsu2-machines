// The JS side of the differential traces (web/server-rs/crates/online/src/tests/difftrace.rs is the Rust side): the
// Rust tests' World (tests/world.rs) in JS, a fake switch that records every frame the host sends and routes the
// replies to fake games, driven by the same JSON trace; runTrace gives the same output shape as the Rust run_trace.

import { Core } from '../../src/online/core.js';
import { FieldMap, FrameReader, encodeFrame, encodeFrameText } from '../../src/online/aries.js';
import { lanFrame, VHOST_VIP, SYN, SYNACK, RST, DATA, FIN } from '../../src/online/vhost.js';
import { MapStorage } from '../../src/online/files.js';
import { Prng } from '../../src/util/prng.js';
import { Deny } from '../../src/names/index.js';

export const hex = (b) => Buffer.from(b).toString('hex');
export const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
export const ip = (s) => s.split('.').reduce((a, b) => ((a << 8) | Number(b)) >>> 0, 0);
const vipOf = (v) => (typeof v === 'number' ? v >>> 0 : ip(v));

let claimsMod = null;
export async function loadClaims() {
  try {
    claimsMod = await import('../../src/claims/claims.js');
  } catch {
    claimsMod = null;
  }
  return claimsMod;
}

export class World {
  constructor({ storage = null, t0 = 1000000, prng, limits, buddyLimits, claims = null, deny = null } = {}) {
    this.t = t0;
    this.tt = 0;
    this.lines = [];
    this.outbox = [];
    this.slow = new Set();
    this.sent = [];
    this.clients = new Map();
    this.orphans = new Map();
    this.nextPort = 50000;
    this.nextCid = 1;
    this.core = new Core({
      storage, prng: prng || new Prng(1), limits, buddyLimits, claims, deny,
      log: (l, k) => this.lines.push([l, k ?? null]),
      clocks: { now: () => this.t, timer: () => this.tt },
    });
    this.core.attach((vip, f) => {
      const refused = this.slow.has(vip);
      this.sent.push([vip, f.slice(), refused]);
      if (refused) return 'full';
      this.outbox.push([vip, f.slice()]);
      return 'sent';
    });
  }
  deliver() {
    const frames = this.outbox;
    this.outbox = [];
    // (Rust's World::mute, the load measures) frames out are dropped, not read by the fake games
    if (this.mute) {
      this.sent = [];
      return;
    }
    for (const [vip, f] of frames) {
      const c = this.clients.get(vip);
      if (!c) continue;
      const port = (f[14] << 8) | f[15];
      const conn = c.conns.get(port);
      if (!conn) continue;
      switch (f[16]) {
        case SYNACK: conn.open = true; break;
        case RST: conn.reset = true; break;
        case FIN: conn.fin = true; break;
        case DATA: {
          // the bytes as they came (Rust's conn.raw)
          const raw = new Uint8Array(conn.raw.length + f.length - 24);
          raw.set(conn.raw);
          raw.set(f.subarray(24), conn.raw.length);
          conn.raw = raw;
          for (const m of conn.r.push(f.subarray(24))) conn.msgs.push({ kind: m.kind, code: m.code, f: FieldMap.parseWith(m.body, () => false) });
          break;
        }
      }
    }
  }
  advance(ms) {
    this.t += ms;
    this.core.tick();
    this.deliver();
  }
  sleep(ms) {
    const end = this.tt + ms;
    for (let n = 0; n < 1e6; n++) {
      const due = this.core.nextDue();
      if (due === null || due > end) break;
      this.tt = Math.max(due, this.tt);
      this.core.runDue(this.tt);
      this.deliver();
    }
    this.tt = end;
  }
  clientOf(vip, group) {
    const old = this.clients.get(vip);
    if (old) for (const [port, c] of old.conns) this.orphans.set(vip + ':' + port, c);
    this.clients.set(vip, { group, conns: new Map(), owner: null, noRaces: false });
    return vip;
  }
  raw(vip, frame) {
    const c = this.clients.get(vip);
    this.core.frame(vip, frame, { group: c.group, site: null, cause: null, owner: c.owner, noRaces: c.noRaces });
    this.deliver();
  }
  c(vip, port) {
    const x = this.clients.get(vip);
    const k = (x && x.conns.get(port)) || this.orphans.get(vip + ':' + port);
    if (!k) throw new Error('a stream');
    return k;
  }
  out(vip, port, op, data) {
    const k = this.c(vip, port);
    this.raw(vip, lanFrame(4, vip, VHOST_VIP, port, k.dport, op, k.cid, data));
  }
  connectAs(vip, dport, port, cid) {
    const x = this.clients.get(vip);
    if (!x) throw new Error('a client');
    x.conns.set(port, { cid, dport, r: new FrameReader(1 << 16), msgs: [], raw: new Uint8Array(0), open: false, reset: false, fin: false });
    this.out(vip, port, SYN, new Uint8Array(0));
  }
  connect(vip, dport) {
    const port = this.nextPort++, cid = this.nextCid++;
    this.connectAs(vip, dport, port, cid);
    return [vip, port];
  }
  last(vip, port, kind) {
    const m = this.c(vip, port).msgs;
    for (let i = m.length - 1; i >= 0; i--) if (m[i].kind === kind) return m[i];
    return null;
  }
  peerGone(vip) {
    this.core.peerGone(vip);
    this.deliver();
  }
}

function makeWorld(tr, storage, t0, prng) {
  let claims = null;
  if (Array.isArray(tr.claims)) {
    if (!claimsMod) throw new Error('claims.js is not there');
    claims = claimsMod.Claims.inMemory();
    for (const x of tr.claims) claims.claim(x[0], claimsMod.ownerOfToken(x[1]), Math.trunc(x[2] ?? t0));
  }
  let deny = null;
  if (Array.isArray(tr.deny)) {
    deny = new Deny();
    deny.set(tr.deny);
  }
  return new World({ storage, t0, prng, limits: tr.limits, buddyLimits: tr.buddyLimits, claims, deny });
}

/** one trace: its steps' outputs, as the Rust run_trace gives them */
export function runTrace(tr) {
  const prng = new Prng(BigInt(tr.seed));
  let storage = null;
  if (tr.state !== null && tr.state !== undefined) {
    storage = new MapStorage();
    for (const [k, v] of Object.entries(tr.state)) storage.put('online/' + k, v);
  }
  const t0 = tr.t0 ?? 1000000;
  let w = makeWorld(tr, storage, t0, prng);
  const mail = [];
  const drain = () => {
    const out = { sent: w.sent.map(([v, f, r]) => [v, hex(f), r]), log: w.lines, err: w.core.errors };
    if (mail.length > 0) out.mail = mail.splice(0);
    w.sent = [];
    w.lines = [];
    w.core.errors = [];
    return out;
  };
  /** the streams of the worlds before a restart: what they got */
  const old = new Map();
  const value = (v) => {
    if (v !== null && typeof v === 'object') {
      const [rv, port, kind, key] = v.ref;
      const vip = vipOf(rv);
      const cl = w.clients.get(vip);
      const held = (cl && cl.conns.get(port)) || old.get(vip + ':' + port) || w.c(vip, port);
      let m = null;
      for (let i = held.msgs.length - 1; i >= 0; i--) if (held.msgs[i].kind === kind) { m = held.msgs[i]; break; }
      return m ? m.f.get(key) ?? '' : '';
    }
    return v;
  };
  const outs = [drain()];
  for (const s of tr.steps) {
    const vip = s.vip !== undefined ? vipOf(s.vip) : 0;
    const port = s.port ?? 0;
    let extra = null;
    switch (s.op) {
      case 'client': {
        w.clientOf(vip, s.group);
        const c = w.clients.get(vip);
        c.owner = s.owner ? claimsMod.ownerOfToken(s.owner) : null;
        c.noRaces = !!s.noRaces;
        break;
      }
      case 'noRaces': w.clients.get(vip).noRaces = !!s.on; break;
      case 'connect': w.connectAs(vip, s.dport, port, s.cid); break;
      case 'send': {
        const fields = s.fields.map(([k, v]) => [k, value(v)]);
        w.out(vip, port, DATA, encodeFrame(s.kind, s.code ?? '', fields));
        break;
      }
      case 'text': w.out(vip, port, DATA, encodeFrameText(s.kind, s.code ?? '', s.text)); break;
      case 'data': w.out(vip, port, DATA, unhex(s.hex)); break;
      case 'fin': w.out(vip, port, FIN, new Uint8Array(0)); break;
      case 'rst': w.out(vip, port, RST, new Uint8Array(0)); break;
      case 'frame': w.raw(vip, unhex(s.hex)); break;
      case 'seg': w.raw(vip, lanFrame(s.kind ?? 4, vip, VHOST_VIP, port, s.dport, s.tcp, s.cid, unhex(s.hex ?? ''))); break;
      case 'advance': w.advance(s.ms); break;
      case 'sleep': w.sleep(s.ms); break;
      case 'gone': w.peerGone(vip); break;
      case 'slow': if (s.on) w.slow.add(vip); else w.slow.delete(vip); break;
      case 'info': {
        extra = w.core.info();
        extra.vips = [...w.core.vips()].sort((a, b) => a - b);
        break;
      }
      case 'stop': w.core.stop(); w.deliver(); break;
      case 'restart':
        for (const [v, cl] of w.clients) for (const [p, k] of cl.conns) old.set(v + ':' + p, k);
        w = makeWorld(tr, storage, w.t, prng);
        break;
      case 'friends': {
        const r = w.core.friends(claimsMod.ownerOfToken(s.owner), s.group, s.ask);
        w.deliver();
        extra = { me: r.me, done: r.done, friends: r.friends.map((f) => ({ name: f.name, mutual: f.mutual, online: f.online, contact: f.contact })),
          asks: r.asks, sent: r.sent, mail: r.mail.map((m) => ({ from: m.from, body: m.body, t: m.t })), contact: r.contact };
        break;
      }
      case 'pageMail': {
        const on = !!s.on;
        w.core.setPageMail((name, m) => {
          mail.push([name, m.from, m.body, m.t]);
          return on;
        });
        break;
      }
      case 'files': {
        extra = {};
        if (storage) for (const k of [...storage.m.keys()].sort()) if (k.startsWith('online/')) extra[k.slice(7)] = storage.m.get(k);
        break;
      }
      default: throw new Error('op ' + s.op);
    }
    const out = drain();
    if (extra !== null) out.x = extra;
    outs.push(out);
  }
  return outs;
}


// ---- the Rust tests' World API (tests/world.rs), for the ported tests ----

/** a message a fake game got: kind, code, its fields (f: FieldMap); get(k), g(k) (throws when missing) */
function M(m) {
  return {
    kind: m.kind, code: m.code, f: m.f,
    get(k) { return m.f.get(k); },
    g(k) {
      const v = m.f.get(k);
      if (v === null) throw new Error(m.kind + ' has no ' + k);
      return v;
    },
  };
}

Object.assign(World.prototype, {
  text() { return this.lines.map((l) => l[0]); },
  logged(part) { return this.lines.some((l) => l[0].includes(part)); },
  client(vipText) { const v = ip(vipText); return this.clientOf(v, 'vip ' + v); },
  clientIn(vipText, group) { return this.clientOf(ip(vipText), group); },
  setOwner(vip, owner) { this.clients.get(vip).owner = owner; },
  send(c, kind, fields, code = '') { this.out(c[0], c[1], DATA, encodeFrame(kind, code, fields)); },
  sendText(c, kind, text, code = '') { this.out(c[0], c[1], DATA, encodeFrameText(kind, code, text)); },
  sendRaw(c, data) { this.out(c[0], c[1], DATA, data); },
  close(c) { this.out(c[0], c[1], FIN, new Uint8Array(0)); },
  rst(c) { this.out(c[0], c[1], RST, new Uint8Array(0)); },
  /** a stream: {cid, dport, msgs, raw, open, reset, fin, lkey, last(kind), l(kind), count(kind), take()} */
  conn(c) {
    const k = this.c(c[0], c[1]);
    if (!k.api) {
      k.api = true;
      k.last = (kind) => { for (let i = k.msgs.length - 1; i >= 0; i--) if (k.msgs[i].kind === kind) return M(k.msgs[i]); return null; };
      k.l = (kind) => { const m = k.last(kind); if (!m) throw new Error('no ' + kind + ' among ' + k.msgs.map((x) => x.kind).join(',')); return m; };
      k.count = (kind) => k.msgs.filter((m) => m.kind === kind).length;
      k.take = () => k.msgs.splice(0).map(M);
      k.all = () => k.msgs.map(M);
    }
    return k;
  },
  /** a lobby session up to a persona, as the game does it */
  loginAs(vip, name, persona, pass = 'secret') {
    const c = this.connect(vip, 20922);
    this.send(c, 'addr', [['ADDR', '10.77.0.99'], ['PORT', c[1]]]);
    this.send(c, 'skey', [['SKEY', '$5075626c6963204b6579']]);
    this.send(c, 'news', [['NAME', 7]]);
    this.send(c, 'sele', [['MYGAME', 1], ['STATS', 5000], ['ASYNC', 1], ['MESGS', 1]]);
    this.send(c, 'auth', [['NAME', name], ['PASS', pass], ['REGKEY', 'AAAA-BBBB-CCCC'], ['PSES', '0123456789abcdef'], ['MID', '$024e564c0002']]);
    if (persona !== name) this.send(c, 'cper', [['PERS', persona]]);
    this.send(c, 'pers', [['PERS', persona], ['MID', '$024e564c0002']]);
    const p = this.conn(c).last('pers');
    this.conn(c).lkey = p ? p.get('LKEY') : null;
    return c;
  },
  login(vip, name) { return this.loginAs(vip, name, name, 'secret'); },
  /** an EA Messenger connection, logged in with a lobby session's key */
  buddy(vip, lkey) {
    const c = this.connect(vip, 13505);
    this.send(c, 'AUTH', [['PROD', 'NFS-CONSOLE-2005'], ['VERS', '0.1'], ['PRES', 20920], ['USER', '/PC/NFS-CONSOLE-2005'], ['LKEY', lkey]]);
    return c;
  },
  lkey(c) { return this.conn(c).lkey ?? ''; },
  /** the lobby's sessions' personas, for the tests that count them */
  personas() { return [...this.core.lobby.sessions].map((s) => this.core.lobby.s(s).persona); },
});

/** a World for a ported test: Opts as the Rust tests' (limits, buddy, storage, t0, claims, deny), a seeded Prng */
export function world(o = {}) {
  return new World({ storage: o.storage ?? null, t0: o.t0 ?? 1000000, prng: o.prng ?? new Prng(7), limits: o.limits, buddyLimits: o.buddy, claims: o.claims ?? null, deny: o.deny ?? null });
}
export { MapStorage };

