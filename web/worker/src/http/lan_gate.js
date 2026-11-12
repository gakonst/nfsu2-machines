// The /lan budgets, as the Switch DO holds them: port of the App's lan_conns (connections held per client address and
// site: a Budget of WS_PER_ADDRESS / WS_PER_SITE, no total, no free share) and lan_opens (a Rate: LAN_OPEN_BURST, then
// LAN_OPEN_RATE a second, twice that per site), with lan.rs's uses of them: send_lan_check (check) and on_upgrade's
// Share::take / lan_opens.take / the Share's drop (take, release).  Sans-IO: every time is a nowMs the caller passes.
// key and site are the client's address key and IPv6 /48 as Rust computes them (headers.js addressKey / siteKey; the
// Worker sends them in x-lan-opts).

import { Budget, Rate } from '../util/bucket.js';
import { WS_PER_ADDRESS, WS_PER_SITE, LAN_OPEN_BURST, LAN_OPEN_RATE } from './state_routes.js';
import { refuseResponse } from './routes.js';

/** Port of mod.rs App's lan_conns / lan_opens and lan.rs's checks of them.  options: {wsPerAddress, wsPerSite,
 * openBurst, openRate} (Rust's limits, the defaults; for tests). */
export class LanGate {
  constructor(options = {}) {
    this.conns = new Budget(options.wsPerAddress ?? WS_PER_ADDRESS, options.wsPerSite ?? WS_PER_SITE, Infinity, 0.0);
    this.opens = new Rate(options.openBurst ?? LAN_OPEN_BURST, options.openRate ?? LAN_OPEN_RATE);
  }

  /** Port of lan.rs send_lan_check after its own-page test (the Worker answers "page" itself, before forwarding):
   * what an upgrade from this client would meet now, taking nothing: "busy" (its address holds its share of /lan
   * connections), "fast" (it opens them too fast) or "ok". */
  check(key, site, nowMs) {
    if (typeof nowMs !== 'number') throw new Error('LanGate.check: nowMs');
    if (!this.conns.room(key, site ?? '')) return 'busy';
    if (!this.opens.check(key, site ?? '', nowMs)) return 'fast';
    return 'ok';
  }

  /** Port of on_upgrade's checks of the client's /lan connections and how fast it opens them, then (opts, the
   * upgrade's opts from the Worker) the subprotocols, in that order.  Returns {share, protocol} (share: give it to
   * release() once the connection closes; protocol: the 101's Sec-WebSocket-Protocol, or null) or {refuse: "busy" |
   * "fast" | "protocol", status (429, 429, 400), body: "", log (the console line Rust writes, or null), response (Rust's
   * raw refusal: refuseResponse(status))}. */
  take(key, site, nowMs, opts = {}) {
    if (typeof nowMs !== 'number') throw new Error('LanGate.take: nowMs');
    const k = key ?? '';
    const s = site ?? '';
    if (!this.conns.take(k, s)) {
      const log = '[lan] refused a connection: ' + this.conns.held(k) + ' already open from that address';
      return refused('busy', 429, log);
    }
    if (!this.opens.take(k, s, nowMs)) {
      this.conns.give(k, s);
      return refused('fast', 429, '[lan] refused a connection: that address opens them too fast');
    }
    // the subprotocols (a malformed list: 400), last, where the Node server's ws library checked them
    if (opts.protocolBad) {
      this.conns.give(k, s);
      return refused('protocol', 400, null);
    }
    return { share: { key: k, site: s, given: false }, protocol: opts.protocol ?? null };
  }

  /** the Share's drop: its connection closed (a share is given back once, whatever calls this again) */
  release(share) {
    if (!share || share.given) return;
    share.given = true;
    this.conns.give(share.key, share.site);
  }

  /** /lan connections held in all (Budget::count) */
  count() {
    return this.conns.count();
  }

  /** /lan connections held by one address key (Budget::held) */
  held(key) {
    return this.conns.held(key);
  }

  /** the rate buckets that are full again hold nothing worth keeping (every minute) */
  prune(nowMs) {
    this.opens.prune(nowMs);
  }
}

function refused(why, status, log) {
  const response = refuseResponse(status);
  return { refuse: why, status, body: '', log, headers: Object.fromEntries(response.headers), response };
}

