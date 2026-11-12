// A frame from a browser to the browsers it reaches, the free-roam hub or the Online host (the sender's budgets, the
// receivers' queue rules, the stream rules): crates/lan/src/route.rs.

import * as away from './away.js';
import * as compact from './compact.js';
import * as lag from './lag.js';
import * as plates from './plates.js';
import * as paths from './paths.js';
import { BROADCAST, CUT, KIND_LAN_ICMP, KIND_LAN_UDP, KIND_STREAM, KIND_UDP, STREAM_LOW, slot, races, vipStr, Cause } from './lib.js';

/** what a stream segment waiting at the switch costs it besides its bytes */
const SEGMENT_COST = 128;
const cost = (d) => d.length + SEGMENT_COST;

/** route.rs Streams: the stream segments waiting at each receiver (by connection) */
export class Streams {
  constructor() {
    /** conn id -> StreamQueue */
    this.byConn = new Map();
    this.era = 0;
  }
  remove(conn) {
    this.byConn.delete(conn);
  }
  get(id) {
    let s = this.byConn.get(id);
    if (!s) {
      s = { sq: [], head: 0, queued: [], total: 0, since: 0, out: 0 };
      this.byConn.set(id, s);
    }
    return s;
  }
}

const sqLen = (s) => s.sq.length - s.head;
const mine = (s, g) => s.queued.findIndex((q) => q.group === g);

/** the frame as sent to a host (or the trace): its own copy, with its source and destination written in */
export function own(data, src, dst) {
  const b = data.slice();
  const v = new DataView(b.buffer);
  v.setUint32(4, src >>> 0);
  v.setUint32(8, dst >>> 0);
  return b;
}

const R = {
  /**
   * route.rs route: one frame, to each of dsts in turn, within peer's budgets.  False: over them.
   * @param {number[]} dsts
   */
  route(peer, data, dsts) {
    const p0 = plates.helloPlate(data);
    if (p0) {
      const f = this.plateFix(peer, data, p0);
      if (f) data = f;
    }
    const n = data.length;
    const lanOnly = data[0] >= KIND_LAN_UDP && data[0] <= KIND_LAN_ICMP;
    if (lanOnly) peer.conn.lanSent++;
    const reaches = (p) => p !== peer && p.open() && (!lanOnly || p.lan);
    const list = dsts.some((d) => d === BROADCAST) ? (lanOnly ? this.lanAll : this.all) : null;
    const onList = !lanOnly || peer.lan;
    const reached = list ? Math.max(0, list.length - (onList ? 1 : 0)) : 0;
    const costs = dsts.map((d) => (d === BROADCAST ? Math.max(reached, 1) : 1));
    const [paid, allPaid] = this.charge(peer, this.mono(), n, costs);
    const st = away.status(data);
    if (st !== null && st !== undefined) {
      peer.away = away.away(st);
      peer.roamAt = Math.max(Math.floor(this.mono()), 1);
    }
    if (paid > 0) {
      this.stats.frames += paid;
      this.stats.bytes += n * paid;
      peer.framesIn += paid;
    }
    const paidDsts = dsts.slice(0, paid);
    if (paidDsts.some((d) => d !== this.roamVip && d !== this.onlineVip)) data = compact.mark(data);
    for (const dst of paidDsts) {
      const count = dst === BROADCAST ? reached : 0;
      this.routeOne(peer, data, dst, list, count, reaches);
    }
    if (!allPaid) this.stats.limited++;
    return allPaid;
  },

  /** route.rs plate_fix */
  plateFix(peer, data, p) {
    if (!plates.intact(data)) return null;
    if (p.kind !== 'plate') return plates.rewrite(data, null, null);
    const { at, plate } = p;
    const name = [...new TextDecoder().decode(p.name)].map((c) => (isControl(c) ? '?' : c)).join('');
    const plateS = utf8OrEmpty(plate);
    const v = plates.judge(peer.plates, plate, Math.floor(this.mono()));
    switch (v.kind) {
      case 'go':
        return null;
      case 'new':
        this.line('[plate] ' + vipStr(peer.vip) + ' "' + name + '" ' + plateS);
        return null;
      case 'last':
        return plates.rewrite(data, at, v.last);
      case 'slur':
        if (v.tell) this.line('[plate] ' + vipStr(peer.vip) + ' "' + name + '" ' + plateS + ': reads as a slur, dropped (its HELLOs go on without it)');
        return plates.rewrite(data, at, null);
      default:
        throw new Error('plate verdict ' + v.kind);
    }
  },

  /** route.rs route_one: one destination that was paid for */
  routeOne(peer, data, dst, all, count, reaches) {
    const vip = peer.vip;
    if (this.tap) this.tap(own(data, vip, dst));
    if (this.roamVip === dst) {
      if (peer.conn.noRaces && races(data)) {
        this.stats.dropped++;
        return;
      }
      if (this.roam) {
        const f = own(data, vip, dst), ctx = this.frameCtx(peer, null);
        this._post(() => this.roam.frame(f, ctx, this.now));
      }
      return;
    }
    if (this.onlineVip === dst) {
      if (this.online) {
        const cause = new Cause(this, peer);
        const f = own(data, vip, dst), ctx = this.frameCtx(peer, cause);
        this._post(() => this.online.frame(f, ctx, this.now));
      }
      return;
    }
    if (dst === BROADCAST) {
      if (all && count > 0) {
        const port = data[0] === KIND_LAN_UDP && data.length >= 16 ? (data[14] << 8) | data[15] : null;
        for (const p of all) {
          if (!reaches(p)) continue;
          if (port !== null && !p.takesUdp(port)) {
            this.stats.bcastSkipped++;
            this.stats.bcastSkippedBytes += data.length;
            continue;
          }
          this.deliver(peer, p, data, dst);
        }
      } else {
        this.stats.dropped++;
      }
      return;
    }
    const p = this._peerAt(dst);
    if (p && p.open()) {
      if (data[0] === KIND_LAN_UDP) paths.raceWith(peer.lanTo, dst);
      this.deliver(peer, p, data, dst);
    } else {
      this.stats.dropped++;
    }
  },

  /** route.rs charge: how many of the destinations the sender's buckets pay for, and whether that was all */
  charge(peer, now, n, costs) {
    const a = peer.buckets, b = peer.group.buckets, c = peer.site ? peer.site.buckets : null;
    let [frames, bytes] = a.refill(now);
    for (const x of c ? [b, c] : [b]) {
      const [f, y] = x.refill(now);
      frames = Math.min(frames, f);
      bytes = Math.min(bytes, y);
    }
    let total = 0, paid = 0, all = true;
    for (const k of costs) {
      const t = total + k;
      if (t > frames || t * n > bytes) {
        all = false;
        break;
      }
      total = t;
      paid++;
    }
    if (paid > 0) {
      a.spendPaid(total, total * n);
      b.spendPaid(total, total * n);
      if (c) c.spendPaid(total, total * n);
    }
    return [paid, all];
  },

  frameCtx(peer, cause) {
    return { group: peer.group.id, site: peer.site ? peer.site.id : null, cause, owner: peer.conn.owner, noRaces: peer.conn.noRaces };
  },

  /** route.rs deliver: one frame to one peer, through the impairment when it is on (LAN play's kinds only) */
  deliver(from, p, data, dst) {
    if ((from.conn.noRaces || p.conn.noRaces) && races(data)) {
      this.stats.dropped++;
      return;
    }
    if (this.impair && data[0] >= KIND_LAN_UDP && data[0] <= KIND_LAN_ICMP) {
      this.impair.deliver(this.stats, from, p, data, dst, this.now);
    } else {
      this.deliverNow(from, p, data, dst);
    }
  },

  deliverNow(from, p, data, dst) {
    if (p.open() && this.sendFrame(from, p, data, dst)) p.framesOut++;
  },

  /** route.rs send_frame: a datagram is dropped while the receiver's queue is long, a stream segment never is */
  sendFrame(from, p, data, dst) {
    if (data[0] === KIND_STREAM) return this.sendStream(from, p, data, dst);
    if (data[0] === KIND_UDP) {
      const share = p.share.v;
      if (share < lag.SHARE_FULL && lag.isSnap(data) && !lag.pick(share, this.pickRng)) {
        this.stats.thinned++;
        return false;
      }
      if (p.away && this.slow && lag.isSnap(data) && !lag.pick(away.SHARE, this.pickRng)) return false;
    }
    const q = p.conn;
    const limit = data[0] === KIND_UDP ? this.o.roamQueue : this.o.shedQueue;
    if (q.buffered + q.dgram > limit) {
      this.stats.shed++;
      return false;
    }
    return this.post(p, data, from.vip, dst);
  },

  /** route.rs post: a datagram to p, into its bundle when it takes them, else as it is */
  post(p, data, src, dst) {
    if (!p.takesBundles()) return this.send(p, { k: 'frame', data, src, dst });
    if (!this.room(p, CUT.Slow)) {
      this.stats.dropped++;
      return false;
    }
    let clock;
    if (data[0] >= KIND_LAN_UDP && data[0] <= KIND_LAN_ICMP) clock = this.lanClock;
    else if (p.away && data[1] === compact.ROAM_OK && src !== this.roamVip && this.slow) clock = this.slow;
    else clock = this.clock;
    p.conn.pushDgram(data, src, dst, clock);
    return true;
  },

  /** route.rs send_stream */
  sendStream(from, p, data, dst) {
    const g = from.group.id;
    const len = cost(data);
    const now = this.mono();
    if (!p.open()) return false;
    const st = this.streams;
    let s = st.get(p.conn.id);
    const i0 = mine(s, g);
    const mineN = i0 >= 0 ? s.queued[i0].n : 0;
    if (mineN + len > this.o.streamShare || s.total + len > this.o.streamQueue) {
      if (this.stalled(s, now)) {
        this.cut(p, CUT.Stall);
        return false;
      }
      let top = g, most = mineN;
      for (const q of s.queued) {
        if (q.n > most) {
          most = q.n;
          top = q.group;
        }
      }
      this.cutGroup(st, top, CUT.Hog);
      if (top === g) return false;
    }
    if (!this.room(p, CUT.Slow)) {
      this.stats.dropped++;
      return false;
    }
    s = st.get(p.conn.id);
    if (sqLen(s) === 0 && p.conn.buffered <= STREAM_LOW) {
      p.conn.push({ k: 'frame', data, src: from.vip, dst });
      return true;
    }
    if (sqLen(s) === 0) {
      s.since = now;
      s.out = now;
    }
    const i = mine(s, g);
    let era;
    if (i >= 0) {
      s.queued[i].n += len;
      era = s.queued[i].era;
    } else {
      st.era++;
      s.queued.push({ group: g, era: st.era, n: len });
      era = st.era;
    }
    s.total += len;
    s.sq.push({ data, src: from.vip, dst, group: g, era });
    p.conn.streaming = true;
    this.pumpOne(p.conn, s);
    return true;
  },

  stalled(s, now) {
    const ms = this.o.stallMs;
    return sqLen(s) > 0 && now - s.since > ms && now - s.out > ms;
  },

  /** every connection of one client goes, and the stream segments of it still waiting at the others */
  cutGroup(st, id, why) {
    for (const q of this.all.slice()) {
      if (q.group.id === id && q.open()) this.cut(q, why);
      const s = st.byConn.get(q.conn.id);
      if (!s) continue;
      const i = mine(s, id);
      if (i < 0) continue;
      const e = s.queued.splice(i, 1)[0];
      s.total -= e.n;
      const rest = s.sq.slice(s.head).filter((x) => !(x.era === e.era && x.group === e.group));
      s.sq = rest;
      s.head = 0;
    }
  },

  /** p's queued stream segments into its connection, as far as it has taken the ones before */
  pump(conn) {
    const s = this.streams.byConn.get(conn.id);
    if (s) this.pumpOne(conn, s);
    else conn.streaming = false;
  },

  pumpOne(conn, s) {
    if (!conn.open()) {
      s.sq = [];
      s.head = 0;
    }
    for (let guard = 0; sqLen(s) > 0 && conn.buffered <= STREAM_LOW; guard++) {
      if (guard > 10_000_000) throw new Error('pump did not end');
      const x = s.sq[s.head++];
      const len = cost(x.data);
      const i = s.queued.findIndex((q) => q.era === x.era && q.group === x.group);
      if (i >= 0) {
        s.queued[i].n -= Math.min(len, s.queued[i].n);
        if (s.queued[i].n === 0) s.queued.splice(i, 1);
      }
      s.total -= Math.min(len, s.total);
      s.out = this.mono();
      conn.push({ k: 'frame', data: x.data, src: x.src, dst: x.dst });
    }
    if (s.head > 1024 && s.head * 2 > s.sq.length) {
      s.sq = s.sq.slice(s.head);
      s.head = 0;
    }
    conn.streaming = sqLen(s) > 0;
  },
};

export function installRoute(C) {
  Object.assign(C.prototype, R);
}

/** char::is_control: the Cc category */
function isControl(c) {
  const x = c.codePointAt(0);
  return x < 0x20 || (x >= 0x7f && x < 0xa0);
}

function utf8OrEmpty(b) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return '';
  }
}

