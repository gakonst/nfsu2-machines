// The Online host at 10.77.0.1 (crates/online/src/lib.rs): the server's stand-in for EA's online servers, on the
// switch's virtual LAN.  One sans-IO object: the switch (one Durable Object) hands it frames with the time, it sends
// through the switch's send, its timers run when tick(nowMs) is called at nextTickMs().  Persisted state goes through
// the injected storage (files.js).
//
//   new OnlineHost({sw, prng, storage, nowMs, options})
//     sw: {send(vip, frame, cause) -> 'sent'|'full'|'gone', pageMail?}   prng: util/prng.js Prng
//     storage: {get, put, delete, list} (synchronous) or null    nowMs: the start's time
//     options: {log(line, key|null), tap(frame), claims, deny, limits, buddyLimits, vhost}
//
// What lib.rs ran on a thread of its own runs here in the caller's turn; its order is kept: timers due before a frame
// run before it (the Rust host's loop runs what is due before it takes the next event), and a handler that fails is an
// error line, the stream its frame came on closed ("service error"), and the host goes on (lib.rs guarded).

import { Core } from './core.js';
import { VHOST_VIP } from './vhost.js';
import { assert } from './jsx.js';

export { VHOST_VIP };
export const VHOST_NAME = 'NFSU2 Online';
export { PORT_REDIRECTOR, PORT_LOBBY, PORT_BUDDY, PORT_HTTP } from './core.js';
export { PAGE_MSG_LEN, discordName } from './buddy.js';

export class OnlineHost {
  constructor({ sw, prng, storage = null, nowMs, options = {} }) {
    assert(Number.isFinite(nowMs), 'the start time');
    this.vip = VHOST_VIP;
    this.name = VHOST_NAME;
    this.t = nowMs;
    const clocks = { now: () => this.t, timer: () => this.t };
    this.core = new Core({ ...options, storage, prng, clocks });
    if (sw) this.attach(sw);
  }

  /** the switch's peer lists show it ({vip, name, server: true}) */
  listed() {
    return true;
  }

  /** the switch's way to its browsers */
  attach(sw) {
    this.sw = sw;
    this.core.attach((vip, frame, cause) => sw.send(vip, frame, cause));
    if (sw.pageMail) this.core.setPageMail((name, mail) => !!sw.pageMail(name, mail));
  }

  /** the clock moves to nowMs (never back) and what is due runs */
  at(nowMs) {
    if (nowMs > this.t) this.t = nowMs;
    this.guarded(null, () => this.core.runDue(this.t));
  }

  guarded(frame, f) {
    try {
      return f();
    } catch (e) {
      try {
        this.core.consoleError('[online] a service failed: ' + (e && e.message ? e.message : String(e)));
        this.core.cause = null;
        if (frame) this.core.failStream(frame[0], frame[1]);
        this.core.purge();
      } catch {
        // as lib.rs: the host goes on
      }
      return undefined;
    }
  }

  /** a frame from browser src (its [4..7], which the switch wrote) to 10.77.0.1 */
  frame(frame, ctx, nowMs) {
    this.at(nowMs);
    const from = ((frame[4] << 24) | (frame[5] << 16) | (frame[6] << 8) | frame[7]) >>> 0;
    const c = { group: ctx.group, site: ctx.site ?? null, owner: ctx.owner ?? null, noRaces: !!ctx.noRaces, cause: ctx.cause ?? null };
    this.guarded([from, frame], () => this.core.frame(from, frame, c));
    this.guarded(null, () => this.core.runDue(this.t));
  }

  peerGone(vip, nowMs) {
    this.at(nowMs);
    this.guarded(null, () => this.core.peerGone(vip));
    this.guarded(null, () => this.core.runDue(this.t));
  }

  tick(nowMs) {
    this.at(nowMs);
  }

  /** when tick should next run (absolute ms), or Infinity */
  nextTickMs() {
    const t = this.core.nextDue();
    return t === null ? Infinity : t;
  }

  /** the counts (core.rs info) */
  info() {
    return this.core.info();
  }

  vips() {
    return this.core.vips();
  }

  /** a page's friends lists (EA Messenger's): as keyphrase owner, for client group; ask: buddy.js friends */
  friends(owner, group, ask, nowMs) {
    this.at(nowMs);
    const out = this.guarded(null, () => this.core.friends(owner, group, ask));
    this.guarded(null, () => this.core.runDue(this.t));
    return out ?? { me: null, done: '', friends: [], asks: [], sent: [], mail: [], contact: null };
  }

  /** where a friend's message goes when its persona is not in EA Messenger: fn(name, {from, body, t}) -> taken */
  setPageMail(fn) {
    this.core.setPageMail(fn);
  }

  /** the server stops: the lobby's links go, the files are written, the timers end */
  stop(nowMs) {
    if (nowMs !== undefined) this.at(nowMs);
    this.guarded(null, () => this.core.stop());
  }
}

