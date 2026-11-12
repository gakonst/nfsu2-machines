// The shared deterministic simulation harness (DST): many virtual clients over a seeded network through the switch and
// its hosts, in virtual time, invariants checked after every step, reproducible by seed.
//
// The network: each client's WebSocket is a TCP connection, so what one connection carries is never lost or reordered;
// what the network does to the switch is per-connection latency (a base plus jitter, each direction's arrivals kept in
// order), slow and stalled readers (the bytes the switch hands a connection wait for the client to read them: the
// switch's queue rules and cuts see the backlog), and connections that die (the client may come back with ?resume).
// Across connections the latencies differ, so messages from different clients arrive in any order.
//
//   const sim = new Sim({seed, lan: {...LanOptions}, hosts: {online: (a) => new OnlineHost(a), roam: ...},
//                        net: {minDelayMs, maxDelayMs, dropRate /* per second per connection *\/}});
//   const c = sim.connect({name, query: {resume, queue}, group, site, ident, hello: {...} | null,
//                          readBps: Infinity, rcvBuf: 1 << 20});
//   c.sendText(obj | string); c.sendBinary(u8); c.close(code, reason); c.drop(); c.received; c.vip; c.texts('peers')
//   sim.advance(ms); sim.check((sim) => { throw ... }); sim.nowMs; sim.sw; sim.clients

import { LanSwitch, slot, BROADCAST, vipStr } from '../../src/switch/lib.js';
import { Prng } from '../../src/util/prng.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class SimClient {
  constructor(sim, id, o) {
    this.sim = sim;
    this.id = id;
    this.o = o;
    this.name = o.name ?? 'p' + id;
    this.latency = o.latencyMs ?? sim.latency();
    this.readBps = o.readBps ?? Infinity;
    this.rcvBuf = o.rcvBuf ?? 4 << 20;
    /** what reached the client: {atMs, type:'text'|'binary'|'ping'|'pong'|'close', data, text?, obj?, code?, reason?} */
    this.received = [];
    this.open = true;
    this.closed = null;
    this.vip = 0;
    this.token = null;
    /** the bytes the switch handed this connection that the client has not read yet: [{msg, left}] */
    this.unread = [];
    this.kernel = 0;
    this.pending = 0;
    this.lastArrive = sim.nowMs;
    this.lastUp = sim.nowMs;
    this.stalled = false;
    this.conn = sim.sw.attach({
      resume: !!o.query?.resume, queue: !!o.query?.queue, group: o.group ?? null, site: o.site ?? null, ident: o.ident ?? null,
      refuse: o.refuse ?? null, onHello: o.onHello ?? null, onClaim: o.onClaim ?? null, country: o.country ?? null,
    }, sim.nowMs, (conn) => {
      this.conn = conn;
      sim.byConn.set(conn, this);
    });
    if (o.hello) this.sendText({ t: 'hello', name: this.name, ...o.hello });
  }

  /** a message to the switch, arriving after this connection's latency (in order) */
  sendRaw(msg) {
    if (!this.open) return;
    const at = Math.max(this.sim.nowMs + this.sim.jitter(this.latency), this.lastUp);
    this.lastUp = at;
    this.sim.schedule(at, () => {
      if (this.conn.rd.done) return;
      this.sim.sw.message(this.conn, msg, this.sim.nowMs);
    });
  }
  sendText(v) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    this.sendRaw({ type: 'text', data: enc.encode(s) });
  }
  sendBinary(u8) {
    this.sendRaw({ type: 'binary', data: u8 });
  }
  /** the client closes (its close frame) */
  close(code = 1000, reason = '') {
    if (!this.open) return;
    this.sendRaw({ type: 'close', code, reason: enc.encode(reason) });
    this.closing = true;
  }
  /** the connection dies without a close (a dropped link) */
  drop() {
    if (!this.open) return;
    this.open = false;
    this.closed = { code: 1006, reason: '' };
    this.sim.schedule(this.sim.nowMs + this.latency, () => this.sim.sw.socketGone(this.conn, this.sim.nowMs));
  }
  stopReading() {
    this.stalled = true;
  }
  resumeReading() {
    this.stalled = false;
    this.sim.pumpReads(this);
  }

  texts(t) {
    return this.received.filter((m) => m.type === 'text' && (!t || (m.obj && m.obj.t === t))).map((m) => m.obj);
  }
  binaries() {
    return this.received.filter((m) => m.type === 'binary').map((m) => m.data);
  }

  /** a message the client read */
  arrive(msg) {
    const m = { atMs: this.sim.nowMs, type: msg.op, data: msg.data };
    if (msg.op === 'text') {
      m.text = dec.decode(msg.data);
      try {
        m.obj = JSON.parse(m.text);
      } catch {
        m.obj = null;
      }
      if (m.obj && m.obj.t === 'welcome') {
        this.vip = m.obj.vip;
        this.token = m.obj.token;
      }
    }
    if (msg.op === 'close') {
      m.code = msg.data.length >= 2 ? (msg.data[0] << 8) | msg.data[1] : 1005;
      m.reason = dec.decode(msg.data.subarray(2));
    }
    this.received.push(m);
    for (const f of this.sim.onArrive) f(this, m);
    if (msg.op === 'ping') this.sendRaw({ type: 'pong', data: msg.data.slice() });
    if (msg.op === 'close' && this.open) {
      // a browser answers a close frame with its own, then the connection ends
      if (!this.closing) this.sendRaw({ type: 'close', code: m.code, reason: enc.encode(m.reason) });
      this.closed = { code: m.code, reason: m.reason };
      this.open = false;
      this.sim.schedule(this.sim.nowMs + this.latency + 1, () => this.sim.sw.socketGone(this.conn, this.sim.nowMs));
    }
  }
}

/** a synchronous storage for the hosts, as the Durable Object's kv: get/put/delete/list(prefix) */
export function memStorage() {
  const m = new Map();
  return { get: (k) => m.get(k), put: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k), list: (p) => [...m.keys()].filter((k) => k.startsWith(p)).sort(), map: m };
}

export class Sim {
  constructor(o = {}) {
    this.seed = o.seed ?? 1;
    this.prng = new Prng(BigInt(this.seed) * 2n + 1n);
    this.net = { minDelayMs: 1, maxDelayMs: 40, jitterMs: 3, dropRate: 0, ...(o.net ?? {}) };
    this.nowMs = o.startMs ?? 1_700_000_000_000;
    /** events: [{at, seq, fn}] kept sorted by (at, seq) */
    this.events = [];
    this.seq = 0;
    this.checks = [];
    this.onArrive = [];
    this.clients = [];
    this.byConn = new Map();
    this.steps = 0;
    this.storage = o.storage ?? null;
    const transport = {
      write: (conn, msgs, bytes) => this.write(conn, msgs, bytes),
      end: () => {},
      kill: (conn) => {
        const c = this.byConn.get(conn);
        if (c && c.open) {
          c.open = false;
          c.closed = { code: 1006, reason: '' };
        }
      },
    };
    this.sw = new LanSwitch({
      options: o.lan ?? {}, prng: new Prng(BigInt(this.seed) * 2n), nowMs: this.nowMs, transport, impair: o.impair ?? '',
      hosts: o.hosts ?? {}, hostOptions: o.hostOptions ?? {}, storage: this.storage, stored: o.stored ?? null,
      hostStorage: o.hostStorage ?? memStorage(),
      tap: o.tap ?? null, onText: o.onText ?? null, onLine: o.onLine ?? null,
    });
    this.hosts = { online: this.sw.online, roam: this.sw.roam };
    if (o.invariants !== false) this.check(switchInvariants);
  }

  latency() {
    return this.net.minDelayMs + this.prng.unit() * (this.net.maxDelayMs - this.net.minDelayMs);
  }
  jitter(base) {
    return base + this.prng.unit() * this.net.jitterMs;
  }

  schedule(at, fn) {
    const e = { at: Math.max(at, this.nowMs), seq: this.seq++, fn };
    // insertion keeps the list sorted (events are few; a binary search finds the place)
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const x = this.events[mid];
      if (x.at < e.at || (x.at === e.at && x.seq < e.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.events.splice(lo, 0, e);
  }

  connect(o = {}) {
    const c = new SimClient(this, this.clients.length, o);
    this.clients.push(c);
    this.afterStep();
    return c;
  }

  /** the transport: the bytes the switch's writer hands a connection: the kernel takes what fits its buffer (rcvBuf),
   * the rest waits in the switch's count (buffered) until the client reads */
  write(conn, msgs, bytes) {
    const c = this.byConn.get(conn);
    if (!c || !c.open) return bytes; // the kernel takes it and it goes nowhere
    for (const m of msgs) {
      const n = (m.data.length < 126 ? 2 : m.data.length < 65536 ? 4 : 10) + m.data.length;
      c.unread.push({ msg: m, left: n });
    }
    const took = Math.min(bytes, Math.max(0, c.rcvBuf - c.kernel));
    c.kernel += took;
    c.pending += bytes - took;
    this.schedule(this.nowMs, () => this.pumpReads(c));
    return took;
  }

  /** a client reads what it can of its connection's bytes (at its rate), and the kernel takes more from the switch */
  pumpReads(c) {
    if (c.stalled || !c.unread.length || !c.open) return;
    const can = c.readBps === Infinity ? Infinity : Math.max(1, Math.floor(c.readBps / 100));
    let budget = Math.min(can, c.kernel);
    let freed = 0;
    while (c.unread.length && budget > 0) {
      const u = c.unread[0];
      const k = Math.min(u.left, budget);
      u.left -= k;
      budget -= k;
      freed += k;
      if (u.left === 0) {
        c.unread.shift();
        const at = Math.max(this.nowMs + this.jitter(c.latency), c.lastArrive);
        c.lastArrive = at;
        const msg = u.msg;
        this.schedule(at, () => c.arrive(msg));
      }
    }
    c.kernel -= freed;
    if (c.pending > 0) {
      const k = Math.min(c.pending, Math.max(0, c.rcvBuf - c.kernel));
      if (k > 0) {
        c.pending -= k;
        c.kernel += k;
        this.sw.drained(c.conn, k, this.nowMs);
      }
    }
    if (c.unread.length) this.schedule(this.nowMs + 10, () => this.pumpReads(c));
  }

  check(fn) {
    this.checks.push(fn);
  }

  afterStep() {
    this.steps++;
    for (const f of this.checks) f(this);
  }

  /** runs every event and switch timer due in the next ms, in time order */
  advance(ms) {
    const end = this.nowMs + ms;
    for (let guard = 0; ; guard++) {
      if (guard > 50_000_000) throw new Error('sim did not settle');
      const ev = this.events.length ? this.events[0].at : Infinity;
      const tw = this.sw.nextWakeMs();
      const t = Math.min(ev, tw);
      if (t > end) break;
      this.nowMs = Math.max(this.nowMs, t);
      if (ev <= tw) {
        const e = this.events.shift();
        e.fn();
      } else {
        this.sw.tick(this.nowMs);
      }
      if (this.net.dropRate > 0) this.maybeDrop();
      this.afterStep();
    }
    this.nowMs = end;
    this.sw.tick(this.nowMs);
    this.afterStep();
  }

  maybeDrop() {
    for (const c of this.clients) {
      if (c.open && this.prng.unit() < this.net.dropRate / 1000) c.drop();
    }
  }
}

/** what must hold of the switch after every step */
export function switchInvariants(sim) {
  const sw = sim.sw;
  const m = sw.members;
  const fail = (s) => {
    throw new Error('invariant (seed ' + sim.seed + ', step ' + sim.steps + ', t=' + sim.nowMs + '): ' + s);
  };
  if (sw.all.length !== m.peers.size) fail('all and peers differ');
  if (sw.table.size !== m.peers.size) fail('table ' + sw.table.size + ' != peers ' + m.peers.size);
  let i = 0;
  for (const [vip, p] of m.peers) {
    if (sw.all[i++] !== p) fail('all out of order');
    if (p.vip !== vip) fail('peer under the wrong address');
    if (slot(vip) === null) fail('peer on an address the switch never hands out: ' + vipStr(vip));
    if (sw.table.get(vip) !== p) fail('table does not hold ' + vipStr(vip));
    if (m.reserved.has(vip)) fail(vipStr(vip) + ' both held and reserved');
    if (p.conn.peer !== p) fail('conn.peer not its peer');
    if (p.conn.buffered < 0 || p.conn.dgram < 0) fail('negative queue');
    if (p.lan !== m.lan.has(vip)) fail('lan list out of step for ' + vipStr(vip));
    if (p.conn.rd.done) fail('a finished connection still holds ' + vipStr(vip));
  }
  if (m.lan.size > m.peers.size) fail('lan list longer than peers');
  if (sw.lanAll.length !== m.lan.size) fail('lanAll stale');
  for (const w of m.line.waiters.values()) {
    if (w.conn && w.conn[0].peer) fail('a waiter holds an address');
  }
  for (const [, s] of sw.streams.byConn) {
    if (s.total < 0) fail('stream total < 0');
  }
}

export { BROADCAST };

