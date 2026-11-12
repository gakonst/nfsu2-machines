// The line: when every place is taken, a page that can wait (/lan?queue) waits in line, first come first served:
// crates/lan/src/queue.rs (its module doc says what a waiting page hears and sends).

import { heldAddress } from './members.js';
import { newToken, parseJson, tokenFits, tokenHash } from './text.js';
import * as json from '../util/json.js';
import { bucketAt, utf8 } from './lib.js';

const PACE_MS = 5.0 * 60_000.0;
const PACE_MIN = 3;
const SILENT_MS = 60_000.0;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** queue.rs Line: the pages waiting for a place, in their order */
export class Line {
  constructor() {
    /** id -> Waiter {conn:[Conn, ctx]|null, ticket, until, told, came} */
    this.waiters = new Map();
    this.next = 0;
    this.moved = [];
    this.since = null;
    this.longest = 0;
    this.toldAt = 0;
    /** hex(ticket hash) -> {hash, vip, token, until} */
    this.seated = new Map();
  }
  /** the place a ticket's page was given lately: [vip, the connection there] or [0, null] */
  seatedFor(peers, reserved, ticket, now) {
    let s = null;
    for (const e of this.seated.values()) {
      if (e.until > now && tokenFits(ticket, e.hash)) {
        s = e;
        break;
      }
    }
    if (!s) return [0, null];
    const p = peers.get(s.vip);
    if (p) return sameBytes(p.tokenHash, s.token) ? [s.vip, p] : [0, null];
    const r = reserved.get(s.vip);
    return r && sameBytes(r.hash, s.token) && r.until > now ? [s.vip, null] : [0, null];
  }
  waiting() {
    return this.waiters.size > 0;
  }
  beforeNewcomers() {
    for (const w of this.waiters.values()) if (w.conn) return true;
    return false;
  }
  len() {
    return this.waiters.size;
  }
  /** places a second the line moves up by (null until it moved PACE_MIN times) */
  pace(now) {
    while (this.moved.length && this.moved[0] < now - PACE_MS) this.moved.shift();
    const n = this.moved.length;
    if (n < PACE_MIN) return null;
    const span = Math.max(now - this.moved[0], 10_000);
    return n / (span / 1000);
  }
}

/** {"t":"queue",...} */
function told(pos, of, eta, ticket) {
  let s = '{"t":"queue","pos":' + pos + ',"of":' + of;
  if (eta !== null) s += ',"eta":' + roundU64(eta);
  if (ticket !== null) s += ',"ticket":"' + ticket + '"';
  return utf8(s + '}');
}

/** f64::round() as u64 */
function roundU64(x) {
  if (!(x > 0)) return 0;
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return r >= 2 ** 64 ? '18446744073709551615' : BigInt(r).toString();
}

const Q = {
  enqueue(m, conn, ctx, hello) {
    if (m.line.waiters.size >= this.o.maxWaiting || !conn.open()) return false;
    const now = this.mono();
    m.line.next++;
    const id = m.line.next;
    const ticket = newToken(this.prng);
    conn.wait = { id, hello, texts: bucketAt(this.o.textRate, now), lastIn: now };
    const of = m.line.waiters.size + 1;
    m.line.waiters.set(id, { conn: [conn, ctx], ticket: tokenHash(ticket), until: 0, told: of, came: now });
    if (m.line.since === null) {
      m.line.since = now;
      m.line.longest = 0;
    }
    this.stats.queued++;
    const p = m.line.pace(now);
    conn.push({ k: 'text', data: told(of, of, p === null ? null : of / p, ticket) });
    return true;
  },

  rejoin(m, conn, ctx, hello, ticket) {
    let pos = -1, id = 0, w = null, i = 0;
    for (const [k, v] of m.line.waiters) {
      if (tokenFits(ticket, v.ticket)) {
        pos = i;
        id = k;
        w = v;
        break;
      }
      i++;
    }
    if (pos < 0) return false;
    const now = this.mono();
    const of = m.line.waiters.size;
    const old = w.conn;
    w.conn = [conn, ctx];
    if (old) old[0].terminate();
    w.until = 0;
    w.told = pos + 1;
    conn.wait = { id, hello, texts: bucketAt(this.o.textRate, now), lastIn: now };
    this.stats.rejoined++;
    const p = m.line.pace(now);
    conn.push({ k: 'text', data: told(pos + 1, of, p === null ? null : (pos + 1) / p, null) });
    return true;
  },

  leftLine(conn) {
    const id = conn.wait.id;
    if (id === 0) return;
    const done = conn.letGo();
    const m = this.members;
    const w = m.line.waiters.get(id);
    if (!w) return;
    if (!(w.conn && w.conn[0] === conn)) return;
    if (done) {
      m.line.waiters.delete(id);
      m.line.moved.push(this.mono());
      this.stats.lineLeft++;
      if (!m.line.waiting()) m.line.since = null;
    } else {
      w.conn = null;
      w.until = this.now + this.o.reserveMs;
    }
  },

  /** the line's first ones take the places that are free, as many as there are */
  letIn() {
    for (let guard = 0; guard < 1_000_000; guard++) {
      const m = this.members;
      let id = 0, conn = null, ctx = null;
      for (const [k, w] of m.line.waiters) {
        if (w.conn && w.conn[0].open()) {
          id = k;
          [conn, ctx] = w.conn;
          break;
        }
      }
      if (!conn) return;
      const wait = conn.wait;
      const held = heldAddress(m, wait.hello, this.now);
      const place = this.place(m, held, true);
      if (!place) return;
      const [vip, old, resumed] = place;
      const hello = wait.hello;
      wait.hello = null;
      const w = m.line.waiters.get(id);
      m.line.waiters.delete(id);
      const came = w ? w.came : NaN, ticket = w ? w.ticket : null;
      const now = this.mono();
      m.line.moved.push(now);
      if (m.line.since !== null) m.line.longest = Math.max(m.line.longest, now - came);
      if (!m.line.waiting()) m.line.since = null;
      this.stats.lineIn++;
      const [peer, count] = this.seat(m, conn, ctx, hello, vip, old);
      if (ticket) m.line.seated.set(hex(ticket), { hash: ticket, vip: peer.vip, token: peer.tokenHash, until: this.now + this.o.reserveMs });
      conn.wait = { id: 0, hello: null, texts: null, lastIn: 0 };
      if (ctx.onJoin) ctx.onJoin(peer.vip, resumed, count);
    }
    throw new Error('letIn did not end');
  },

  /** every second while anyone waits */
  lineTick() {
    const now = this.mono();
    const m = this.members;
    const wall = this.now;
    for (const [k, s] of m.line.seated) if (!(s.until > wall)) m.line.seated.delete(k);
    if (!m.line.waiting()) return;
    const before = m.line.waiters.size;
    for (const [k, w] of m.line.waiters) if (!(w.conn || w.until > wall)) m.line.waiters.delete(k);
    for (let i = m.line.waiters.size; i < before; i++) {
      this.stats.lineLeft++;
      m.line.moved.push(now);
    }
    if (!m.line.waiting()) m.line.since = null;
    const silent = [];
    for (const w of m.line.waiters.values()) if (w.conn && w.conn[0].wait.lastIn < now - SILENT_MS) silent.push(w.conn[0]);
    for (const c of silent) c.terminate();
    this.letIn();
    if (!m.line.waiting() || now - m.line.toldAt < this.o.lineTellMs) return;
    m.line.toldAt = now;
    const pace = m.line.pace(now);
    const of = m.line.waiters.size;
    const out = [];
    let i = 0;
    for (const w of m.line.waiters.values()) {
      if (w.conn && w.told !== i + 1) {
        w.told = i + 1;
        out.push([w.conn[0], told(i + 1, of, pace === null ? null : (i + 1) / pace, null)]);
      }
      i++;
    }
    for (const [c, msg] of out) c.push({ k: 'text', data: msg });
  },

  /** a control message from a page in line (false: it is not waiting) */
  waitingText(conn, b) {
    const now = this.mono();
    const w = conn.wait;
    if (w.id === 0) return false;
    w.lastIn = now;
    if (b.length > this.o.maxText || !(w.texts && w.texts.takeAt(now, 1))) {
      this.stats.limited++;
      return true;
    }
    const m = parseJson(b);
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return true;
    switch (typeof m.t === 'string' ? m.t : null) {
      case 'hello':
        if (w.hello === null) w.hello = m;
        break;
      case 'lan':
        if (w.hello !== null && m.on !== undefined) {
          w.hello.lan = m.on;
          if (m.udp !== undefined) w.hello.udp = m.udp;
          else delete w.hello.udp;
        }
        break;
      case 'ping': {
        const id = m.id === undefined ? null : json.safeInteger(m.id);
        if (id !== null && id !== undefined) conn.push({ k: 'text', data: utf8('{"t":"pong","id":' + String(id) + '}') });
        break;
      }
      default:
    }
    return true;
  },

  lineView() {
    const m = this.members;
    return [m.line.len(), Math.floor(m.line.longest / 1000)];
  },
};

export function installQueue(C) {
  Object.assign(C.prototype, Q);
}

