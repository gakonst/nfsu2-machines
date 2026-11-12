// A connection's reader: a resume's wait for its hello, then its messages (text, binary, ping, pong, close), each frame
// routed here: crates/lan/src/reader.rs.  The transport hands the switch whole messages (Workers did the framing):
//   sw.message(conn, {type:'text', data:Uint8Array /*UTF-8*\/} | {type:'binary', data} | {type:'ping', data} |
//              {type:'pong', data} | {type:'close', code, reason:Uint8Array} | {type:'error', code}, nowMs)
//   sw.socketGone(conn, nowMs): the connection ended (the ws reader's ReadError::Closed)

import { F_STAMPED, KIND_COMPACT } from './compact.js';
import { KIND_BUNDLE } from './conn.js';
import { parseJson } from './text.js';
import * as mix from './mix.js';
import * as json from '../util/json.js';
import { CUT, WAS_MAX, be32, udpOf, utf8 } from './lib.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byteLen = (s) => utf8(s).length;

const D = {
  /** read_loop's start */
  readerStart(conn, ctx) {
    const rd = conn.rd;
    rd.peer = conn.peer;
    if (ctx.resume && !rd.peer) {
      rd.wait = this.now + this.o.resumeWaitMs;
      rd.waitTimer = this.timers.at(rd.wait, () => {
        if (rd.wait === null || rd.done || conn.killed) return;
        // no hello in time: a fresh address
        rd.wait = null;
        rd.peer = this.admit(conn, ctx, null);
      });
    }
  },

  /** one message from the client */
  message(conn, msg, nowMs) {
    this._step(nowMs, () => this.readOne(conn, msg));
  },

  /** the client's connection ended (no more messages): its close logic runs */
  socketGone(conn, nowMs) {
    this._step(nowMs, () => {
      conn.socketGone = true;
      this._killed(conn);
    });
  },

  readOne(conn, msg) {
    const rd = conn.rd;
    if (rd.done || conn.killed || rd.draining) return;
    this.readMsg(conn, msg);
    // the top of read_loop's loop, before it waits for the next message: a page let in from the line meanwhile has its
    // peer only from then on (what it sent in between was read without one)
    if (!rd.peer && rd.wait === null) rd.peer = conn.peer;
  },

  readMsg(conn, msg) {
    const rd = conn.rd;
    const ctx = conn.ctx;
    // WsReader: a message over max_payload is a 1009
    if ((msg.type === 'text' || msg.type === 'binary') && msg.data.length > this.o.maxPayload) msg = { type: 'error', code: 1009 };
    switch (msg.type) {
      case 'text': {
        const b = msg.data;
        if (rd.firstText) {
          rd.firstText = false;
          if (this.helloRefused(conn, ctx, b)) return;
        }
        if (rd.wait !== null) {
          rd.wait = null;
          if (rd.waitTimer) rd.waitTimer.cancel();
          rd.peer = this.admit(conn, ctx, firstHello(this, b));
        } else if (rd.peer && conn.open()) {
          this.onMessage(rd.peer, true, b);
        } else if (!rd.peer && conn.open() && !this.waitingText(conn, b)) {
          rd.peer = conn.peer;
          if (rd.peer) this.onMessage(rd.peer, true, b);
        }
        return;
      }
      case 'binary': {
        if (rd.wait !== null) {
          rd.wait = null;
          if (rd.waitTimer) rd.waitTimer.cancel();
          rd.peer = this.admit(conn, ctx, null);
        } else if (rd.peer && conn.open()) {
          this.onMessage(rd.peer, false, msg.data);
        }
        return;
      }
      case 'ping': {
        this.stats.msg(mix.IN_PING);
        conn.msgsIn++;
        const p = rd.peer;
        if (p && conn.open() && !this.flood(p) && this.room(p, CUT.Slow)) conn.push({ k: 'pong', data: msg.data.slice() });
        return;
      }
      case 'pong': {
        this.stats.msg(mix.IN_PONG);
        conn.msgsIn++;
        const p = rd.peer;
        if (p) {
          const ours = p.probe.pong(msg.data, this.mono(), p.share);
          if (ours === true) p.alive = true;
          else if (ours === null || ours === undefined) this.flood(p);
        }
        return;
      }
      case 'close':
        conn.closeReceived(msg.code, msg.reason ?? new Uint8Array(0));
        rd.draining = true;
        return;
      case 'error':
        conn.protocolError(msg.code);
        rd.draining = true;
        return;
      default:
        throw new Error('unknown message type ' + msg.type);
    }
  },

  /** lib.rs hello_refused: a first hello whose ids, keyphrase or name the server turns away */
  helloRefused(conn, ctx, b) {
    if (b.length > this.o.maxText || !conn.open()) return false;
    const m = parseJson(b);
    if (!isObj(m) || m.t !== 'hello') return false;
    if (typeof m.claim === 'string' && byteLen(m.claim) <= 64 && ctx.onClaim) {
      const owner = ctx.onClaim(m.claim);
      if (owner != null && conn.owner === null) conn.owner = owner;
    }
    const idOk = (i) => typeof i === 'string' && i.length > 0 && byteLen(i) <= 64;
    const id = idOk(m.id) ? m.id : null;
    const ids = id !== null ? [id] : [];
    if (id !== null) {
      if (conn.browser === null) conn.browser = id;
      const was = Array.isArray(m.was) ? m.was.slice(0, WAS_MAX) : [];
      for (const w of was) if (idOk(w) && !ids.includes(w)) ids.push(w);
    }
    const owner = conn.owner;
    const name = typeof m.name === 'string' ? m.name : '';
    if (!ctx.onHello) return false;
    const a = ctx.onHello({ ids, owner, name }) ?? {};
    if (a.refuse) {
      const [msg, code] = a.refuse;
      this.expelConn(conn, typeof msg === 'string' ? utf8(msg) : msg, code);
      return true;
    }
    if (a.noRaces != null) {
      conn.noRaces = true;
      conn.push({ k: 'text', data: typeof a.noRaces === 'string' ? utf8(a.noRaces) : a.noRaces });
    }
    return false;
  },

  /** reader.rs flood: a control frame over ctl_rate cuts the connection */
  flood(p) {
    if (p.ctl.ctl.takeAt(this.mono(), 1)) return false;
    this.cut(p, CUT.Flood);
    return true;
  },

  /** reader.rs on_message: a message of an admitted connection */
  onMessage(peer, text, data) {
    peer.alive = true;
    peer.conn.msgsIn++;
    peer.lastIn = this.now;
    const n = data.length;
    const o = this.o;
    if (text) {
      this.stats.msg(mix.IN_TEXT);
      this.stats.entryIn(mix.TEXT, n);
      if (n > o.maxText || !peer.ctl.texts.takeAt(this.mono(), 1)) {
        this.stats.limited++;
        return;
      }
      const m = parseJson(data);
      if (!isObj(m)) return;
      switch (typeof m.t === 'string' ? m.t : null) {
        case 'hello':
          this.hello(peer, m);
          break;
        case 'lan':
          peer.udp = udpOf(m.udp);
          this.setLan(peer, json.isNum(m.on, 1));
          break;
        case 'ping': {
          const id = m.id === undefined ? null : json.safeInteger(m.id);
          if (id !== null && id !== undefined) this.send(peer, { k: 'text', data: utf8('{"t":"pong","id":' + String(id) + '}') });
          break;
        }
        case 'friend': case 'room': case 'flying':
          this.pageText(peer, m);
          break;
        default:
      }
      return;
    }
    if (n < 12) return;
    if (data[0] === KIND_BUNDLE) {
      if (n > o.maxBundle) {
        this.stats.limited++;
        return;
      }
      this.stats.bundlesIn++;
      this.stats.msg(mix.IN_BUNDLE);
      this.stats.entryIn(mix.FRAMING, 4);
      let at = 4;
      if ((data[1] & F_STAMPED) !== 0) {
        if (n < 16) {
          this.stats.limited++;
          return;
        }
        this.stats.entryIn(mix.FRAMING, 12);
        const held = Math.min(be32(data, 12) / 1000, 10_000);
        const ours = peer.probe.pong(data.subarray(4, 12), this.mono() - held, peer.share);
        if (ours === true) peer.alive = true;
        else if (ours === null || ours === undefined) this.flood(peer);
        this.stats.echoes++;
        at = 16;
      }
      for (let guard = 0; at + 4 <= n; guard++) {
        if (guard > n) throw new Error('bundle walk did not end');
        const k = data[at];
        const len = (data[at + 2] << 8) | data[at + 3];
        const f = at + 4 + 4 * k;
        const end = f + len;
        if (len < 12 || len > o.maxFrame || end > n || data[f] === KIND_BUNDLE || data[f] === KIND_COMPACT) {
          this.stats.limited++;
          return;
        }
        const frame = data.subarray(f, end);
        this.stats.entryIn(mix.FRAMING, 4);
        if (k > 0) this.stats.entryIn(mix.ADDRS, 4 * k);
        this.stats.entryIn(mix.ofPage(frame, k === 0 ? be32(frame, 8) : be32(data, at + 4)), len);
        const dsts = [];
        if (k === 0) dsts.push(be32(frame, 8));
        else for (let j = 0; j < k; j++) dsts.push(be32(data, at + 4 + 4 * j));
        if (!this.route(peer, frame, dsts)) return;
        at = end;
      }
      return;
    }
    this.stats.msg(mix.IN_FRAME);
    if (n > o.maxFrame || data[0] === KIND_COMPACT) {
      this.stats.limited++;
      return;
    }
    this.stats.entryIn(mix.ofPage(data, be32(data, 8)), n);
    this.route(peer, data, [be32(data, 8)]);
  },
};

/** reader.rs first_hello: a resume's first message, a hello when it is one */
function firstHello(sw, b) {
  if (b.length > sw.o.maxText) return null;
  const m = parseJson(b);
  return isObj(m) && m.t === 'hello' ? m : null;
}

export function installReader(C) {
  Object.assign(C.prototype, D);
}

