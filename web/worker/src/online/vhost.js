// The server's own host on the virtual LAN, 10.77.0.1 (crates/online/src/vhost.rs): kind 4 (TCP) a stream endpoint
// (SYN to a listened port -> SYNACK, else RST; DATA in order; FIN; RST: the switch is reliable and ordered), kind 5
// (ICMP) echo requests answered, kind 3 (UDP) "port unreachable".
//
// Frame layout (big-endian): [0] kind, [4..7] source vip (the switch wrote the sender's own), [8..11] destination vip,
// [12..13] source port, [14..15] destination port, then the 8-byte LAN header ([16] op, [17] ttl, [20..23] connection
// id little-endian) and the data.  A connection is named by the browser's address, its port and its connection id.

import { assert, vipStr } from './jsx.js';

export const VHOST_VIP = 0x0a4d0001;
export const K_UDP = 3;
export const K_TCP = 4;
export const K_ICMP = 5;
export const SYN = 1;
export const SYNACK = 2;
export const RST = 3;
export const DATA = 4;
export const FIN = 5;
const UDP_UNREACH = 1;
const LAN_HDR = 8;
const F_DATA = 16;
/** the most data one TCP frame carries (net_proto.h NET_MAX_PAYLOAD - NET_LAN_HDR) */
export const TCP_CHUNK = 1472 - LAN_HDR;

export const VHOST_LIMITS = Object.freeze({ maxConns: 48000, perVip: 8 });

export class VHost {
  constructor(o) {
    this.o = { ...VHOST_LIMITS, ...(o || {}) };
    /** port -> 'redirector'|'lobby'|'buddy'|'http' (tests: 'probe', 'silent') */
    this.listeners = new Map();
    /** id -> connection, in the order they were opened */
    this.conns = new Map();
    this.byKey = new Map();
    this.perVip = new Map();
    this.next = 0;
    this.stats = { synIn: 0, refused: 0, limited: 0, rstIn: 0, framesIn: 0, framesOut: 0, echoes: 0, udpUnreach: 0, bad: 0, slow: 0, overrun: 0 };
    /** the redirector's connections: id -> {reader, timer} */
    this.redirs = new Map();
    /** the web pages' connections: id -> {buf, done, timer} */
    this.https = new Map();
  }
  listen(port, l) {
    this.listeners.set(port, l);
  }
}

const key = (vip, port, cid) => vip + ':' + port + ':' + cid;

/** one switch frame of a LAN kind */
export function lanFrame(kind, src, dst, sport, dport, op, cid, data) {
  const f = new Uint8Array(F_DATA + LAN_HDR + data.length);
  const v = new DataView(f.buffer);
  f[0] = kind;
  v.setUint32(4, src >>> 0);
  v.setUint32(8, dst >>> 0);
  v.setUint16(12, sport);
  v.setUint16(14, dport);
  f[F_DATA] = op;
  f[F_DATA + 1] = 64;
  v.setUint32(F_DATA + 4, cid >>> 0, true);
  f.set(data, F_DATA + LAN_HDR);
  return f;
}

function icmpChecksum(m) {
  m[2] = 0;
  m[3] = 0;
  let sum = 0;
  let i = 0;
  while (i + 1 < m.length) {
    sum += (m[i] << 8) | m[i + 1];
    i += 2;
  }
  if (m.length & 1) sum += m[m.length - 1] << 8;
  while (sum >> 16 !== 0) sum = (sum & 0xffff) + (sum >>> 16);
  sum = ~sum & 0xffff;
  m[2] = sum >> 8;
  m[3] = sum & 255;
}

const be16 = (d, at) => (d[at] << 8) | d[at + 1];
const le32 = (d, at) => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;

/** the virtual host's methods, on Core */
export const vhostMethods = {
  /** a frame to one browser through the switch (the tap sees it first): 'sent'|'full'|'gone' */
  out(vip, frame) {
    this.vh.stats.framesOut += 1;
    if (this.tap) this.tap(frame);
    if (!this.send) return 'full';
    const r = this.send(vip, frame, this.cause);
    assert(r === 'sent' || r === 'full' || r === 'gone', 'a send result');
    return r;
  },

  /** a frame from a browser to 10.77.0.1 */
  vhFrame(from, data, ctx) {
    const vh = this.vh;
    vh.stats.framesIn += 1;
    if (data.length < F_DATA + LAN_HDR) {
      vh.stats.bad += 1;
      return;
    }
    const kind = data[0], sport = be16(data, 12), dport = be16(data, 14), op = data[F_DATA];
    const cid = le32(data, F_DATA + 4);
    const payload = data.subarray(F_DATA + LAN_HDR);
    if (kind === K_ICMP) {
      if (payload.length < 8 || payload[0] !== 8) return;
      const rep = payload.slice();
      rep[0] = 0;
      rep[1] = 0;
      icmpChecksum(rep);
      vh.stats.echoes += 1;
      this.out(from, lanFrame(K_ICMP, VHOST_VIP, from, 0, 0, 0, 0, rep));
      return;
    }
    if (kind === K_UDP) {
      if (op === UDP_UNREACH) return;
      vh.stats.udpUnreach += 1;
      this.out(from, lanFrame(K_UDP, VHOST_VIP, from, dport, sport, UDP_UNREACH, 0, new Uint8Array(0)));
      return;
    }
    if (kind !== K_TCP) {
      vh.stats.bad += 1;
      return;
    }
    const c = vh.byKey.get(key(from, sport, cid));
    const rst = () => {
      this.out(from, lanFrame(K_TCP, VHOST_VIP, from, dport, sport, RST, cid, new Uint8Array(0)));
    };
    switch (op) {
      case SYN: {
        if (c !== undefined) return;
        vh.stats.synIn += 1;
        const l = vh.listeners.get(dport);
        if (l === undefined) {
          vh.stats.refused += 1;
          return rst();
        }
        if (vh.conns.size >= vh.o.maxConns || (vh.perVip.get(from) || 0) >= vh.o.perVip) {
          vh.stats.limited += 1;
          return rst();
        }
        vh.next += 1;
        const id = vh.next;
        vh.conns.set(id, {
          vip: from, rport: sport, lport: dport, cid,
          group: ctx.group, site: ctx.site ?? null, owner: ctx.owner ?? null, noRaces: !!ctx.noRaces,
          rxFin: false, txFin: false, bytesIn: 0, bytesOut: 0, svc: { k: 'none', id: 0 },
        });
        vh.byKey.set(key(from, sport, cid), id);
        vh.perVip.set(from, (vh.perVip.get(from) || 0) + 1);
        this.out(from, lanFrame(K_TCP, VHOST_VIP, from, dport, sport, SYNACK, cid, new Uint8Array(0)));
        this.onConnect(l, id);
        return;
      }
      case DATA: {
        if (c === undefined) return rst();
        const conn = vh.conns.get(c);
        assert(conn, 'indexed');
        if (conn.rxFin) return;
        conn.noRaces = !!ctx.noRaces;
        conn.bytesIn += payload.length;
        if (payload.length > 0) this.onData(c, payload);
        return;
      }
      case FIN: {
        if (c === undefined) return;
        const conn = vh.conns.get(c);
        assert(conn, 'indexed');
        if (conn.rxFin) return;
        conn.rxFin = true;
        this.onEnd(c);
        const now = vh.conns.get(c);
        if (now && now.txFin) this.connDrop(c, 'closed');
        return;
      }
      case RST:
        if (c !== undefined) {
          vh.stats.rstIn += 1;
          this.connDrop(c, 'reset by the game');
        }
        return;
      case SYNACK:
        if (c === undefined) rst();
        return;
      default:
        vh.stats.bad += 1;
    }
  },

  /** bytes to the browser in frames of at most TCP_CHUNK; one the switch does not take ends the connection */
  connWrite(id, buf) {
    const c = this.vh.conns.get(id);
    if (!c || c.txFin) return false;
    const { vip, lport, rport, cid } = c;
    let at = 0;
    // bounded: each round sends up to TCP_CHUNK bytes of buf (an empty buf sends nothing)
    while (at < buf.length) {
      const part = buf.subarray(at, Math.min(buf.length, at + TCP_CHUNK));
      at += part.length;
      const sent = this.out(vip, lanFrame(K_TCP, VHOST_VIP, vip, lport, rport, DATA, cid, part));
      if (sent !== 'sent') {
        if (sent === 'full') this.vh.stats.slow += 1;
        this.connDestroy(id, sent === 'full' ? 'the browser does not keep up' : 'the browser left');
        return false;
      }
    }
    const c2 = this.vh.conns.get(id);
    if (c2) c2.bytesOut += buf.length;
    return true;
  },

  /** graceful close of our side (FIN); the connection goes once both sides closed */
  connEnd(id) {
    const c = this.vh.conns.get(id);
    if (!c || c.txFin) return;
    c.txFin = true;
    this.out(c.vip, lanFrame(K_TCP, VHOST_VIP, c.vip, c.lport, c.rport, FIN, c.cid, new Uint8Array(0)));
    if (c.rxFin) this.connDrop(id, 'closed');
  },

  /** abortive close (RST) */
  connDestroy(id, why) {
    const c = this.vh.conns.get(id);
    if (!c) return;
    this.out(c.vip, lanFrame(K_TCP, VHOST_VIP, c.vip, c.lport, c.rport, RST, c.cid, new Uint8Array(0)));
    this.connDrop(id, why);
  },

  /** the connection is gone; its service hears why */
  connDrop(id, why) {
    const vh = this.vh;
    const c = vh.conns.get(id);
    if (!c) return;
    vh.conns.delete(id);
    vh.byKey.delete(key(c.vip, c.rport, c.cid));
    const n = Math.max(0, (vh.perVip.has(c.vip) ? vh.perVip.get(c.vip) : 1) - 1);
    if (n > 0) vh.perVip.set(c.vip, n);
    else vh.perVip.delete(c.vip);
    this.onClose(c.svc, id, why);
  },

  /** what this host sent because of the frame was more than that client's budgets: the stream it came on goes */
  overrun(from, data) {
    if (data.length < F_DATA + LAN_HDR || data[0] !== K_TCP) return;
    const id = this.vh.byKey.get(key(from, be16(data, 12), le32(data, F_DATA + 4)));
    if (id !== undefined) {
      this.vh.stats.overrun += 1;
      this.connDestroy(id, 'it made the server send others more than its share');
    }
  },

  /** a handler failed on this frame: the stream it came on goes */
  failStream(from, data) {
    if (data.length < F_DATA + LAN_HDR || data[0] !== K_TCP) return;
    const id = this.vh.byKey.get(key(from, be16(data, 12), le32(data, F_DATA + 4)));
    if (id !== undefined) this.connDestroy(id, 'service error');
  },

  /** a browser left the switch: its streams are gone, in the order they were opened */
  vhPeerGone(vip) {
    const ids = [];
    for (const [id, c] of this.vh.conns) if (c.vip === vip) ids.push(id);
    for (const id of ids) this.connDrop(id, 'the browser left');
  },

  onConnect(l, id) {
    switch (l) {
      case 'redirector': return this.redirectorConnect(id);
      case 'lobby': return this.lobbyConnect(id);
      case 'buddy': return this.buddyConnect(id);
      case 'http': return this.httpConnect(id);
      case 'probe': return this.setSvc(id, { k: 'probe', id: 0 });
      case 'silent': return;
      default: assert(false, 'a listener ' + l);
    }
  },

  setSvc(id, svc) {
    const c = this.vh.conns.get(id);
    if (c) c.svc = svc;
  },

  onData(id, payload) {
    const c = this.vh.conns.get(id);
    if (!c) return;
    const svc = c.svc;
    switch (svc.k) {
      case 'none': return;
      case 'redirector': return this.redirectorData(id, payload);
      case 'lobby': return this.lobbyData(svc.id, payload);
      case 'buddy': return this.buddyData(svc.id, payload);
      case 'http': return this.httpData(id, payload);
      case 'probe': this.probe.push('data ' + new TextDecoder().decode(payload)); return;
    }
  },

  onEnd(id) {
    const c = this.vh.conns.get(id);
    if (!c) return;
    const svc = c.svc;
    switch (svc.k) {
      case 'none': return;
      case 'redirector': return this.connEnd(id);
      case 'lobby':
        this.lobbyLeave(svc.id, 'closed by the game');
        return this.connEnd(id);
      case 'buddy':
        this.buddyGone(svc.id);
        return this.connEnd(id);
      case 'http': {
        const h = this.vh.https.get(id);
        if (!(h && h.done)) this.connEnd(id);
        return;
      }
      case 'probe':
        this.probe.push('end');
        return this.connEnd(id);
    }
  },

  onClose(svc, id, why) {
    switch (svc.k) {
      case 'none': return;
      case 'redirector': {
        const r = this.vh.redirs.get(id);
        this.vh.redirs.delete(id);
        if (r && r.timer !== null) this.timers.clear(r.timer);
        return;
      }
      case 'lobby': return this.lobbyLeave(svc.id, why);
      case 'buddy': return this.buddyClosed(svc.id);
      case 'http': {
        const h = this.vh.https.get(id);
        this.vh.https.delete(id);
        if (h && h.timer !== null) this.timers.clear(h.timer);
        return;
      }
      case 'probe': this.probe.push('close ' + why); return;
    }
  },

  /** the connection's [vip, its address as text, group, site], or null */
  connIds(id) {
    const c = this.vh.conns.get(id);
    return c ? [c.vip, vipStr(c.vip), c.group, c.site] : null;
  },

  connOwner(id) {
    const c = this.vh.conns.get(id);
    return c ? c.owner : null;
  },

  connOpen(id) {
    return this.vh.conns.has(id);
  },
};

