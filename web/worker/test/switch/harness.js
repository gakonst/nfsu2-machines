// The switch's test harness in virtual time: a port of web/server-rs/crates/lan/tests/harness/mod.rs onto the sans-IO JS
// switch (src/switch/lib.js).  Rust's harness put a real switch behind a listener on 127.0.0.1:0 and drove it with
// fake browsers over sockets; here one World holds a virtual clock and an event queue, the switch's transport hands
// each message straight to the fake browser it is for, and nothing ever sleeps: sleep(ms) runs every switch timer and
// every browser's reaction due in the next ms, in time order, and until(f) runs them one by one until f says yes (or
// its time is up: it throws, as the Rust one panicked).
//
// The API follows the Rust harness (snake_case to camelCase); everything is synchronous (no awaits):
//   const sw = start(opts({...}));                         // start_full: startFull(o, impair, online, roam, storage)
//   const a = Client.connect(sw, 'Alice'); a.welcome();    // Client.with(sw, name, query, o), new Client(sw, name, query, [vip, token], o)
//   a.udp(dst, sport, dport, data, kind, fakeSrc); a.text(s); a.binary(u8); a.ping(u8); a.sendBundle(entries)
//   a.until((g) => ...value or null); a.untilTrue((g) => bool); a.got().frames / ctl / view / pings / pongs / closed
//   a.close() -> [code, reason]; a.closeWith(code, reason); a.closed(); a.terminate(); a.isOpen()
//   rawWs(sw, query), rawPeer(sw, name, query, rcvbuf): a browser on a "plain socket" that reads only when told to and
//   never answers a ping; stalledPeer(sw, name, group, cap): one whose pipe takes cap bytes and is never read
//   sleep(ms), waitFor(ms, f), now() (the virtual clock, ms), frameOf, bundleOf, dgramsOf, unpackCompact, roamDatagram
//
// The wire: a connection carries whole WebSocket messages; each counts its header and payload (RFC 6455 framing from
// the server: 2, 4 or 10 bytes of header), as the switch counts them.  A fake browser's "kernel" takes cap bytes of
// what the switch writes (Infinity for a Client, which reads at once) and the switch learns of what it read later
// through sw.drained(): the switch's queue rules see the backlog as they saw a socket's.

import { LanSwitch, vipStr, BROADCAST as BCAST } from '../../src/switch/lib.js';
import { Prng } from '../../src/util/prng.js';
import { crc32 } from '../../src/switch/crc32.js';
import { parseStore, STORE_KEY } from '../../src/switch/store.js';

export const BROADCAST = BCAST;
const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = (s) => enc.encode(s);
export const str = (b) => dec.decode(b);

/** RFC 6455's header for a payload of len from the server (conn.rs header_len) */
export function headerLen(len) {
  return len < 126 ? 2 : len < 65536 ? 4 : 10;
}
const wire = (m) => headerLen(m.data.length) + m.data.length;

// ---- the world: one virtual clock for every switch and browser ----

const START_MS = 1_700_000_000_000;

class World {
  constructor() {
    this.now = START_MS;
    this.events = [];
    this.seq = 0;
    this.switches = new Set();
  }
  /** fn at time at (ms, not before now) */
  at(at, fn) {
    const e = { at: Math.max(at, this.now), seq: this.seq++, fn };
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const x = this.events[mid];
      if (x.at < e.at || (x.at === e.at && x.seq < e.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.events.splice(lo, 0, e);
    return e;
  }
  /** the next thing due: a browser's event or a switch's timer */
  next() {
    let t = this.events.length ? this.events[0].at : Infinity;
    for (const s of this.switches) t = Math.min(t, s.lan.nextWakeMs());
    return t;
  }
  /** everything due by now (events may add more at now) */
  runDue() {
    for (let guard = 0; ; guard++) {
      if (guard > 10_000_000) throw new Error('world did not settle');
      if (this.events.length && this.events[0].at <= this.now) {
        const e = this.events.shift();
        e.fn();
        continue;
      }
      let ran = false;
      for (const s of this.switches) {
        if (s.lan.nextWakeMs() <= this.now) {
          s.lan.tick(this.now);
          ran = true;
        }
      }
      if (!ran) return;
    }
  }
  /** one step: to the next thing due (at most to t), and it runs */
  stepTo(t) {
    const n = Math.min(this.next(), t);
    if (n > this.now) this.now = n;
    for (const s of this.switches) s.lan.tick(this.now);
    this.runDue();
  }
  advanceTo(t) {
    for (let guard = 0; ; guard++) {
      if (guard > 50_000_000) throw new Error('world did not reach ' + t);
      const n = this.next();
      if (n > t) break;
      this.stepTo(n);
    }
    if (t > this.now) this.now = t;
    for (const s of this.switches) s.lan.tick(this.now);
    this.runDue();
  }
  /** steps until f gives a value (not null, undefined or false), ms at most */
  until(ms, f, what) {
    const deadline = this.now + ms;
    for (let guard = 0; ; guard++) {
      if (guard > 50_000_000) throw new Error('until did not end');
      this.runDue();
      const v = f();
      if (v !== null && v !== undefined && v !== false) return v;
      const n = this.next();
      if (n > deadline) {
        this.advanceTo(deadline);
        const v2 = f();
        if (v2 !== null && v2 !== undefined && v2 !== false) return v2;
        throw new Error((what ?? 'until') + ': timed out');
      }
      this.stepTo(n);
    }
  }
}

let W = new World();

/** the virtual clock (ms): Instant::now() and now_ms() of the Rust tests */
export function now() {
  return W.now;
}
/** a fresh world (each test file's tests share one otherwise; time only goes forward) */
export function resetWorld() {
  W = new World();
}
export function world() {
  return W;
}

/** sleep(ms): every timer and reaction due in the next ms runs */
export function sleep(ms) {
  W.advanceTo(W.now + ms);
}

/** wait_for: until f() is true, ms at most (the Rust one polled every 20 ms) */
export function waitFor(ms, f) {
  W.until(ms, () => f() || null, 'wait_for');
}

export function ip(s) {
  return s.split('.').reduce((a, b) => ((a << 8) | Number(b)) >>> 0, 0);
}
export const ipStr = (v) => vipStr(v >>> 0);

/** every address the switch hands out: host bytes 2-251 in each of 10.77.0-95.x */
export function allVips() {
  const v = [];
  for (let b = 0; b < 96; b++) for (let i = 0; i < 250; i++) v.push(((10 << 24) | (77 << 16) | (b << 8) | (i + 2)) >>> 0);
  return v;
}

/** the tests' options: messages of up to 1 MiB taken, so that the switch's own limits decide */
export function opts(o = {}) {
  return { maxPayload: 1 << 20, ...o };
}

/** a host object as the Rust tests wrote them (vip, name, listed(), frame(data, ctx, now), peerGone(vip), info(),
 * vips(), blocks?) given the JS switch's host interface; host.sw is the switch's way to the browsers */
function asHost(h) {
  if (!h) return undefined;
  return (a) => {
    h.sw = a.sw;
    if (!h.nextTickMs) h.nextTickMs = () => Infinity;
    if (!h.tick) h.tick = () => {};
    if (!h.stop) h.stop = () => {};
    if (!h.info) h.info = () => ({});
    if (!h.vips) h.vips = () => new Set();
    if (!h.peerGone) h.peerGone = () => {};
    if (!h.frame) h.frame = () => {};
    return h;
  };
}

/** a storage of {get, put} in memory (the Durable Object's storage; the Rust tests' file) */
export class MemStore {
  constructor() {
    this.m = new Map();
  }
  get(k) {
    return this.m.get(k);
  }
  put(k, v) {
    this.m.set(k, v);
  }
  text() {
    return this.m.get(STORE_KEY);
  }
}

/** start(o): a switch in the world */
export function start(o = opts(), x = {}) {
  return startFull(o, x.impair ?? '', x.online ?? null, x.roam ?? null, x.storage ?? null, x);
}

/** start_full: impairment spec, the hosts (objects), a storage (the store's file); x: seed, tap, onText, onLine */
export function startFull(o, impair = '', online = null, roam = null, storage = null, x = {}) {
  return new Switch(o, impair, online, roam, storage, x);
}

let seeds = 1;

export class Switch {
  constructor(o, impair, online, roam, storage, x) {
    this.byConn = new Map();
    const transport = {
      write: (conn, msgs, bytes) => {
        const c = this.byConn.get(conn);
        if (!c) return bytes;
        return c._write(msgs, bytes);
      },
      end: (conn) => {
        const c = this.byConn.get(conn);
        if (c) c._ended();
      },
      kill: (conn) => {
        const c = this.byConn.get(conn);
        if (c) c._killed();
      },
      finished: () => {},
    };
    const stored = storage ? parseStore(storage.get(STORE_KEY)) : null;
    this.seed = x.seed ?? seeds++;
    this.lan = new LanSwitch({
      options: o, prng: new Prng(this.seed), nowMs: W.now, transport, impair,
      hosts: { online: asHost(online), roam: asHost(roam) }, storage, stored,
      tap: x.tap ?? null, onText: x.onText ?? null, onLine: x.onLine ?? null,
    });
    this.storage = storage;
    W.switches.add(this);
  }
  /** a call into the switch as one step (Rust's methods ran at once on their own: the writes they set going follow) */
  step(fn) {
    let r;
    this.lan._step(W.now, () => {
      r = fn(this.lan);
    });
    W.runDue();
    return r;
  }
  keepalive() {
    return this.step((l) => l.keepalive());
  }
  expel(vip, msg, code) {
    const r = this.lan.expel(vip >>> 0, msg, code, W.now);
    W.runDue();
    return r;
  }
  setRaces(vip, off, msg) {
    const r = this.lan.setRaces(vip >>> 0, off, msg, W.now);
    W.runDue();
    return r;
  }
  /** the switch stops, its connections end */
  close() {
    this.lan.stop(W.now);
    this.lan.terminateAll(W.now);
    W.runDue();
    sleep(20);
    W.switches.delete(this);
  }
  info() {
    return this.lan.info();
  }
  peers() {
    return this.lan.peersView();
  }
  peerNamed(name) {
    return this.peers().find((p) => p.name === name) ?? null;
  }
  has(vip) {
    return this.peers().some((p) => p.vip === vip >>> 0);
  }
  reserved() {
    return this.lan.reservedView().map((r) => r.vip);
  }
  /** what the page tests read of the switch (GET /state) */
  state() {
    return { peers: this.peers().map((p) => ({ vip: p.vip, name: p.name, hello: p.hello, lan: p.lan, rtt: p.rtt })), info: this.info(), reserved: this.lan.reservedView().length };
  }

  /** serve(): a connection to /lan<query>, attached as the harness's listener attached it */
  _attach(client, query) {
    const q = query.startsWith('?') ? query.slice(1) : query;
    let resume = false, queue = false, group = null, site = null, ident = null, refuse = null, gate = null, rename = null, norace = null;
    for (const kv of q.split('&').filter((s) => s.length)) {
      const i = kv.indexOf('=');
      const [k, v] = i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)];
      switch (k) {
        case 'resume': resume = true; break;
        case 'queue': queue = true; break;
        case 'g': if (group === null) group = v; break;
        case 's': if (site === null) site = v; break;
        case 'ident': ident = v; break;
        case 'refuse': refuse = utf8(JSON.stringify({ t: 'ban', msg: v })); break;
        case 'gate': gate = v; break;
        case 'rename': rename = v; break;
        case 'norace': norace = v; break;
        default:
      }
    }
    const onHello = gate !== null || rename !== null || norace !== null ? (h) => {
      const a = {};
      const hit = gate !== null ? [...h.ids, ...(h.owner != null ? [h.owner] : [])].find((x) => x === gate) : undefined;
      if (hit !== undefined) a.refuse = [utf8(JSON.stringify({ t: 'ban', msg: hit, ids: h.ids })), 4003];
      else if (rename !== null && rename === h.name) a.refuse = [utf8(JSON.stringify({ t: 'rename', name: h.name })), 4004];
      else if (norace !== null && h.ids.includes(norace)) a.noRaces = utf8(JSON.stringify({ t: 'races', msg: 'no' }));
      return a;
    } : null;
    const onClaim = (c) => 'owner-' + c;
    const conn = this.lan.attach({ resume, queue, group, site, ident, refuse, onHello, onClaim }, W.now, (c) => {
      client.conn = c;
      this.byConn.set(c, client);
    });
    W.runDue();
    return conn;
  }
}

// ---- frames ----

/** a frame as Client.udp makes one */
export function frameOf(dst, data, kind, sport, dport) {
  const d = typeof data === 'string' ? utf8(data) : Uint8Array.from(data);
  const f = new Uint8Array(16 + d.length);
  const v = new DataView(f.buffer);
  f[0] = kind;
  v.setUint32(8, dst >>> 0);
  v.setUint16(12, sport);
  v.setUint16(14, dport);
  f.set(d, 16);
  return f;
}

/** a bundle (kind 32) of entries [frame, destinations (none: the frame's own)] */
export function bundleOf(entries) {
  const parts = [Uint8Array.of(32, 0, 0, 0)];
  for (const [f, to] of entries) {
    const h = new Uint8Array(4 + 4 * to.length);
    const v = new DataView(h.buffer);
    h[0] = to.length;
    v.setUint16(2, f.length);
    to.forEach((x, i) => v.setUint32(4 + 4 * i, x >>> 0));
    parts.push(h, f);
  }
  return concat(parts);
}

export function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const b = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    b.set(p, at);
    at += p.length;
  }
  return b;
}

export function be32(b, at) {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}
export function be16(b, at) {
  return (b[at] << 8) | b[at + 1];
}

/** the datagrams in a client's frames, the bundles taken apart: {msg, kind, src, dst, data (text), buf} */
export function dgramsOf(frames) {
  const out = [];
  frames.forEach(([buf], msg) => {
    const one = (b) => out.push({ msg, kind: b[0], src: be32(b, 4), dst: be32(b, 8), data: str(b.subarray(16)), buf: b.slice() });
    if (buf[0] !== 32) {
      one(buf);
      return;
    }
    let at = 4;
    while (at + 4 <= buf.length) {
      const f = at + 4 + 4 * buf[at];
      const end = f + be16(buf, at + 2);
      one(buf.subarray(f, end));
      at = end;
    }
  });
  return out;
}

/** What a fake browser got. */
export class Got {
  constructor() {
    /** binary messages as they came: [bytes, when (ms)] */
    this.frames = [];
    /** control messages (parsed) */
    this.ctl = [];
    this.ctlBytes = 0;
    /** the peer list as the whole lists and the changes made it: vip -> entry (null before the first list) */
    this.view = null;
    this.pings = 0;
    this.pongs = [];
    /** [code, reason] of the switch's close frame (1005 without a code, 1006 without a frame) */
    this.closed = null;
  }
  lastPeers() {
    return this.view ? [...this.view.values()] : null;
  }
  names() {
    return (this.lastPeers() ?? []).map((p) => (typeof p.name === 'string' ? p.name : '')).sort(cmpStr).join(',');
  }
  count(t) {
    return this.ctl.filter((m) => m.t === t).length;
  }
  dgrams() {
    return dgramsOf(this.frames);
  }
}

/** Rust's str ordering (bytes) */
export function cmpStr(a, b) {
  const x = utf8(a), y = utf8(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** a browser's connection: what the switch's writer hands it, its kernel's room, its close */
class Wire {
  constructor(sw, cap) {
    this.sw = sw;
    this.conn = null;
    /** bytes the kernel holds for the browser at most (Infinity: it reads at once) */
    this.cap = cap;
    this.inKernel = 0;
    /** bytes the switch's writer still holds (it reports them sent as the kernel takes them) */
    this.held = 0;
    /** messages in the kernel not read yet: [{op, data, left}] */
    this.unread = [];
    this.ended = false;
    this.gone = false;
    this.sentClose = false;
  }
  _write(msgs, bytes) {
    if (this.ended) return bytes;
    if (this.cap === Infinity) {
      for (const m of msgs) this._arrive(m);
      return bytes;
    }
    for (const m of msgs) this.unread.push({ op: m.op, data: m.data, left: wire(m) });
    const took = Math.min(bytes, Math.max(0, this.cap - this.inKernel));
    this.inKernel += took;
    this.held += bytes - took;
    return took;
  }
  /** the browser reads n bytes at most of what is there: the messages it read whole */
  _read(n) {
    const out = [];
    let budget = Math.min(n, this.inKernel);
    let freed = 0;
    while (this.unread.length && budget > 0) {
      const u = this.unread[0];
      const k = Math.min(u.left, budget);
      u.left -= k;
      budget -= k;
      freed += k;
      if (u.left === 0) {
        this.unread.shift();
        out.push(u);
      }
    }
    this.inKernel -= freed;
    const more = Math.min(this.held, Math.max(0, this.cap - this.inKernel));
    if (more > 0 && !this.gone) {
      this.held -= more;
      this.inKernel += more;
      this.sw.lan.drained(this.conn, more, W.now);
    }
    for (const m of out) this._arrive(m);
    W.runDue();
    return out;
  }
  _arrive(_m) {}
  /** the switch's writer ended its half after the close frames: the browser's socket goes, the switch's reader ends */
  _ended() {
    this.ended = true;
    if (!this.gone) {
      this.gone = true;
      W.at(W.now, () => this.sw.lan.socketGone(this.conn, W.now));
    }
  }
  /** the switch cut it (ws terminate()) */
  _killed() {
    this.ended = true;
    this.gone = true;
  }
  /** a message to the switch (dropped once the connection is over or the browser closed it) */
  _send(msg) {
    if (this.gone || this.sentClose) return;
    if (msg.type === 'close') this.sentClose = true;
    this.sw.lan.message(this.conn, msg, W.now);
    W.runDue();
  }
  /** the connection goes, no close frame */
  terminate() {
    if (this.gone) return;
    this.gone = true;
    this.ended = true;
    this.sw.lan.socketGone(this.conn, W.now);
    W.runDue();
  }
}

/** what a Client's hello says (Rust's Opts) */
export function lan(on) {
  return { lan: on };
}
export function bundles() {
  return { bundle: true };
}

/**
 * A fake browser: collects control messages and frames, answers pings (tungstenite does by itself) and close frames;
 * resume = [vip, token]: reconnects as the page does (/lan?resume, then a hello with the old address and the token);
 * its hello says lan and bundle as o says.  o: {lan (0|1, default 1), bundle, compact, id, was, claim, block}.
 */
export class Client extends Wire {
  static connect(sw, name) {
    return new Client(sw, name, '', null, {});
  }
  static with(sw, name, query, o = {}) {
    return new Client(sw, name, query, null, o);
  }
  constructor(sw, name, query = '', resume = null, o = {}) {
    super(sw, Infinity);
    this.name = name;
    this.vip = 0;
    this.token = '';
    this.st = new Got();
    this.resume = resume !== null;
    const extra = { lan: o.lan ?? 1 };
    if (o.bundle) extra.bundle = 1;
    if (o.compact) extra.compact = 1;
    if (o.id != null) extra.id = o.id;
    if (o.was != null) extra.was = o.was;
    if (o.claim != null) extra.claim = o.claim;
    if (o.block != null) extra.block = o.block;
    this.extra = extra;
    const q = resume ? (query === '' ? '?resume' : query + '&resume') : query;
    sw._attach(this, q);
    if (resume) {
      const [vip, token] = resume;
      this.text(JSON.stringify({ t: 'hello', name, vip: ipStr(vip), token, ...extra }));
    }
  }
  _arrive(m) {
    const g = this.st;
    switch (m.op) {
      case 'binary':
        g.frames.push([m.data.slice(), W.now]);
        break;
      case 'text': {
        const v = JSON.parse(str(m.data));
        g.ctlBytes += m.data.length;
        if (v.t === 'peers') g.view = new Map(v.peers.map((p) => [p.vip >>> 0, p]));
        if (v.t === 'delta' && g.view) {
          for (const x of v.gone) g.view.delete(x >>> 0);
          for (const p of v.peers) g.view.set(p.vip >>> 0, p);
        }
        g.ctl.push(v);
        break;
      }
      case 'ping': {
        g.pings++;
        const d = m.data.slice();
        W.at(W.now, () => this._send({ type: 'pong', data: d }));
        break;
      }
      case 'pong':
        g.pongs.push(m.data.slice());
        break;
      case 'close': {
        const code = m.data.length >= 2 ? be16(m.data, 0) : 1005;
        const reason = str(m.data.subarray(2));
        if (g.closed === null) g.closed = [code, reason];
        // tungstenite answers a close frame with the same one
        if (!this.sentClose) {
          const r = m.data.subarray(2).slice();
          W.at(W.now, () => this._send({ type: 'close', code, reason: r }));
        }
        break;
      }
      default:
    }
  }
  _ended() {
    if (this.st.closed === null) this.st.closed = [1006, ''];
    super._ended();
  }
  _killed() {
    if (this.st.closed === null) this.st.closed = [1006, ''];
    super._killed();
  }
  got() {
    return this.st;
  }
  /** waits until f says yes (2 s at most) */
  until(f) {
    return this.untilMs(2000, f);
  }
  untilMs(ms, f) {
    return W.until(ms, () => f(this.st), this.name);
  }
  untilTrue(f) {
    this.until((g) => (f(g) ? true : null));
  }
  /** the welcome; then its hello (a resume sent it first) */
  welcome() {
    const m = this.until((g) => g.ctl.find((x) => x.t === 'welcome') ?? null);
    this.vip = m.vip >>> 0;
    this.token = m.token;
    if (!this.resume) this.text(JSON.stringify({ t: 'hello', name: this.name, ...this.extra }));
    return m;
  }
  text(s) {
    this._send({ type: 'text', data: utf8(s) });
  }
  binary(b) {
    this._send({ type: 'binary', data: Uint8Array.from(b) });
  }
  /** a WebSocket ping */
  ping(data) {
    this._send({ type: 'ping', data: typeof data === 'string' ? utf8(data) : Uint8Array.from(data) });
  }
  /** a datagram with ports, from fakeSrc as it claims */
  udp(dst, sport, dport, data, kind, fakeSrc = 0) {
    const f = frameOf(dst, data, kind, sport, dport);
    new DataView(f.buffer).setUint32(4, fakeSrc >>> 0);
    this.binary(f);
  }
  sendBundle(entries) {
    this.binary(bundleOf(entries));
  }
  /** what it sent is with the switch (it is at once here) */
  flush() {}
  dgrams() {
    return this.st.dgrams();
  }
  frames() {
    return this.st.frames.length;
  }
  isOpen() {
    return this.st.closed === null && !this.gone;
  }
  /** ws close(): a close frame without a code, then its 'close' */
  close() {
    this._send({ type: 'close', code: 1005, reason: new Uint8Array(0) });
    return this.closed();
  }
  /** ws close(code, reason), without waiting */
  closeWith(code, reason) {
    this._send({ type: 'close', code, reason: utf8(reason) });
  }
  closed() {
    return this.untilMs(5000, (g) => g.closed);
  }
}

/**
 * A browser on a "plain socket": it reads only when told to (read(n), or drain() for good) and never answers a ping;
 * its kernel holds rcvbuf bytes of what the switch writes (default 256 KiB: what a loopback socket held before the
 * switch's writer had to wait).  read() returns the messages read whole ({op, data}); closed: the switch ended it.
 */
export class RawClient extends Wire {
  constructor(sw, query, rcvbuf) {
    super(sw, rcvbuf ?? 256 << 10);
    this.got = [];
    this.draining = false;
    sw._attach(this, query);
  }
  _arrive(m) {
    this.got.push({ op: m.op, data: m.data });
  }
  read(n = Infinity) {
    return this._read(n);
  }
  get closed() {
    return this.ended;
  }
  text(s) {
    this._send({ type: 'text', data: utf8(s) });
  }
  binary(b) {
    this._send({ type: 'binary', data: Uint8Array.from(b) });
  }
  ping(data) {
    this._send({ type: 'ping', data: Uint8Array.from(data) });
  }
  pong(data) {
    this._send({ type: 'pong', data: Uint8Array.from(data) });
  }
  closeWith(code, reason = '') {
    this._send({ type: 'close', code, reason: utf8(reason) });
  }
  /** the browser's end goes (dropping the Rust stream) */
  drop() {
    this.terminate();
  }
}

/** raw_ws: a client on a plain socket, no hello */
export function rawWs(sw, query = '', rcvbuf) {
  return new RawClient(sw, query, rcvbuf);
}
export const rawWsWith = rawWs;

/** raw_peer: the same, its hello sent */
export function rawPeer(sw, name, query = '', rcvbuf) {
  const s = rawWs(sw, query, rcvbuf);
  s.text(JSON.stringify({ t: 'hello', name }));
  return s;
}
export const rawPeerWith = rawPeer;

/** stalled_peer: a client that never reads, its hello sent, on a pipe that holds cap bytes; drop() closes it */
export function stalledPeer(sw, name, group, cap) {
  const s = new RawClient(sw, group != null ? '?g=' + group : '', cap);
  s.text(JSON.stringify({ t: 'hello', name }));
  return s;
}

/** drain: a raw socket that reads (and drops) everything as it comes, never answering a ping; .closed once the
 * switch ended it */
export function drain(s) {
  s.draining = true;
  if (s.held > 0 || s.inKernel > 0) s.read(Infinity);
  s.cap = Infinity;
  s._write = function (msgs, bytes) {
    if (this.ended) return bytes;
    for (const m of msgs) this._arrive(m);
    return bytes;
  };
  return s;
}

/** throttle: a raw peer that reads about rate bytes a second (a chunk every 250 ms) */
export function throttle(s, rate) {
  const tick = () => {
    if (s.gone) return;
    s.read(Math.floor(rate / 4));
    W.at(W.now + 250, tick);
  };
  W.at(W.now + 250, tick);
  return s;
}

/** a host on the switch for the tests (the breakdown's: its address, name and vips(); the browsers it heard leave) */
export class FakeHost {
  constructor(vip, name, listed = false) {
    this.vip = vip >>> 0;
    this.name = name;
    this._listed = listed;
    this.vipSet = new Set();
    this.gone = [];
  }
  listed() {
    return this._listed;
  }
  frame() {}
  peerGone(vip) {
    this.gone.push(vip);
  }
  info() {
    return {};
  }
  vips() {
    return new Set(this.vipSet);
  }
  stop() {}
}

/** a free-roam hub that keeps what it is told of blocks: [vip, names], and [vip, []] for a browser that left */
export class BlockHub {
  constructor() {
    this.vip = ip('10.77.0.253');
    this.name = 'hub';
    this.got = [];
  }
  listed() {
    return false;
  }
  frame() {}
  peerGone(vip) {
    this.got.push([vip, []]);
  }
  info() {
    return {};
  }
  vips() {
    return new Set();
  }
  blocks(vip, names) {
    this.got.push([vip, names]);
  }
  stop() {}
}

/** a percentile of sorted values */
export function q(sorted, p) {
  return sorted[Math.min(Math.floor(p * sorted.length), sorted.length - 1)];
}
export function msSince(t) {
  return W.now - t;
}

/** a compact bundle's frames put together again as the page does (web/src/net/proto.ts unpackCompact) */
export function unpackCompact(b, own) {
  if (b[0] !== 33) throw new Error('a compact bundle');
  const out = [];
  let at = 4;
  while (at + 5 <= b.length) {
    const flags = b[at];
    let p = at + 5;
    const end = p + be16(b, at + 3);
    if (flags === 0x40) {
      out.push(b.slice(p, end));
      at = end;
      continue;
    }
    const f = [flags & 7, 0, 0, 0];
    const src = (0x0a4d0000 | be16(b, at + 1)) >>> 0;
    const dst = flags & 0x08 ? BROADCAST : own >>> 0;
    for (const v of [src, dst]) f.push(v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
    if (flags & 0x10) {
      f.push(...b.subarray(p, p + 4));
      p += 4;
    } else {
      f.push(0xb8, 0x6a, 0xb8, 0x6a);
    }
    if (flags & 0x20) {
      const len = end - p + 11;
      const d = [...utf8('N2FR'), 1, b[p], len & 255, len >> 8, ...b.subarray(p + 1, end)];
      const crc = crc32(Uint8Array.from(d));
      d.push(crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, crc >>> 24);
      f.push(...d);
    } else {
      f.push(...b.subarray(p, end));
    }
    out.push(Uint8Array.from(f));
    at = end;
  }
  return out;
}

/** a free-roam datagram as runtime/roam_core.c rc_encode makes it, around a body of n bytes */
export function roamDatagram(kind, n) {
  const d = [...utf8('N2FR'), 1, kind, 0, 0, 0x78, 0x56, 0x34, 0x12, 7, 0, 0, 0];
  for (let i = 0; i < n; i++) d.push((i * 37 + 11) & 255);
  const len = d.length + 4;
  d[6] = len & 255;
  d[7] = len >> 8;
  const crc = crc32(Uint8Array.from(d));
  d.push(crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, crc >>> 24);
  return Uint8Array.from(d);
}

/** vip of a welcome */
export const vipOf = (m) => m.vip >>> 0;

export const fill = (n, v = 0) => new Uint8Array(n).fill(v);
