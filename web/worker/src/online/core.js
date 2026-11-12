// The online host's state and its events (crates/online/src/core.rs): one object for the virtual host, the lobby, EA
// Messenger, the results and the timers.  The services call each other freely, so they are methods of one Core
// (installed from vhost.js, lobby.js, buddy.js, races.js, http.js) that name sessions, games and connections by id.
//
// Two clocks, as the Rust core has (lib.rs Clocks): clocks.now() the wall clock the rules read (ms since 1970) and
// clocks.timer() the one the timers run on.  The host (online.js) gives both the switch's nowMs; the differential
// tests move each on its own, as the Rust tests do.

import { assert } from './jsx.js';
import { Timers } from './timers.js';
import { VHost, vhostMethods } from './vhost.js';
import { Lobby, LIMITS, lobbyMethods } from './lobby.js';
import { Buddies, BUDDY_LIMITS, buddyMethods } from './buddy.js';
import { Stats } from './stats.js';
import { racesMethods } from './races.js';
import { httpMethods } from './http.js';
import { Store } from './files.js';

export const PORT_REDIRECTOR = 20920;
export const PORT_LOBBY = 20922;
export const PORT_BUDDY = 13505;
export const PORT_HTTP = 80;

export class Core {
  /**
   * @param o {storage, log(line, key|null), tap?, claims?, deny?, clocks: {now(), timer()}, prng, limits?, buddyLimits?, vhost?}
   */
  constructor(o) {
    assert(o.clocks && o.prng, 'clocks and a prng');
    this.clocks = o.clocks;
    this.prng = o.prng;
    this.log = o.log || ((line) => console.log(line));
    this.tap = o.tap || null;
    this.send = null;
    this.store = o.storage ? new Store(o.storage, o.prefix ?? 'online/') : null;
    this.racesRead = false;
    this.cause = null;
    this.claims = o.claims || null;
    this.deny = o.deny || null;
    this.here = new Set();
    this.timers = new Timers();
    this.tickTimer = null;
    this.vh = new VHost(o.vhost);
    this.vh.listen(PORT_REDIRECTOR, 'redirector');
    this.vh.listen(PORT_LOBBY, 'lobby');
    this.vh.listen(PORT_BUDDY, 'buddy');
    this.vh.listen(PORT_HTTP, 'http');
    this.lobby = new Lobby({ ...LIMITS, ...(o.limits || {}) });
    this.stats = new Stats({ store: this.store, clocks: this.clocks, log: this.log, ...(o.stats || {}) });
    const started = Math.trunc(this.clocks.now());
    this.buddies = new Buddies({ store: this.store, limits: { ...BUDDY_LIMITS, ...(o.buddyLimits || {}) }, claims: this.claims, now: started });
    /** (tests) what a service probe was told, and the error lines */
    this.probe = [];
    this.errors = [];
    this.loadRaces();
    this.tickTimer = this.setTimeout(5000, { k: 'LobbyTick' });
  }

  /** action a once ms have passed on the timer clock (below 1 ms or past 2^31-1: 1 ms, as Node's timers) */
  setTimeout(ms, a) {
    const d = ms >= 1 && ms <= 2147483647 ? ms : 1;
    return this.timers.set(this.clocks.timer() + d, a);
  }

  /** a handler that failed, as an error line on the console */
  consoleError(line) {
    console.error(line);
    this.errors.push(line);
  }

  /** the switch's way to its browsers: send(vip, frame, cause) -> 'sent'|'full'|'gone' */
  attach(send) {
    this.send = send;
  }

  /** a frame from a browser (ctx: {group, site, owner, noRaces, cause}) */
  frame(from, data, ctx) {
    this.here.add(from);
    this.lobby.seen(from);
    this.cause = ctx.cause || null;
    this.vhFrame(from, data, ctx);
    this.cause = null;
    if (ctx.cause && ctx.cause.overspent()) this.overrun(from, data);
    this.purge();
  }

  peerGone(vip) {
    this.here.delete(vip);
    this.vhPeerGone(vip);
    this.lobby.peerGone(vip, this.clocks.now());
    this.purge();
  }

  /** what left or ended during the event is let go */
  purge() {
    this.lobby.purge();
    this.buddies.purge();
  }

  /** when the next timer is due (the timer clock), or null */
  nextDue() {
    const t = this.timers.nextDue();
    const s = this.stats.saveDue();
    if (t !== null && s !== null) return Math.min(t, s);
    return t !== null ? t : s;
  }

  /** every timer due by now (the timer clock), one event each */
  runDue(now) {
    for (let n = 0; ; n++) {
      assert(n < 10000000, 'runDue ends');
      const s = this.stats.saveDue();
      if (s !== null && s <= now) {
        const nt = this.timers.nextDue();
        if (nt === null || s <= nt) {
          this.stats.saveTimer();
          continue;
        }
      }
      const due = this.timers.popDue(now);
      if (due === null) break;
      this.run(due[0], due[1]);
      this.purge();
    }
  }

  run(id, a) {
    switch (a.k) {
      case 'LobbyTick':
        this.tickTimer = this.setTimeout(5000, { k: 'LobbyTick' });
        this.lobbyTick();
        this.buddyTick();
        return;
      case 'Later': return this.laterTimer(a.key, id);
      case 'RedirectorIdle': return this.redirectorIdle(a.c);
      case 'HttpIdle': return this.httpIdle(a.c);
      case 'BuddyLogin': return this.buddyLoginIdle(a.b);
      case 'BuddyRetry': return this.buddyRetry(a.b, a.f);
      case 'Presence': return this.presenceTimer(a.b);
      case 'BuddyMail': return this.buddyMailTimer(a.b);
      case 'BuddySave': return this.buddySaveTimer();
      default: assert(false, 'a timer action ' + a.k);
    }
  }

  /** the lobby's tick as one event (the tests call it when they move their clock) */
  tick() {
    this.lobbyTick();
    this.purge();
  }

  /** the virtual host's counts, then the lobby's, as one object (core.rs Core::info, its key order) */
  info() {
    const v = this.vh.stats, l = this.lobby.stats;
    const [sessions, personas, racing] = this.lobby.info(this.here);
    return {
      conns: this.vh.conns.size, synIn: v.synIn, refused: l.refused, limited: v.limited, rstIn: v.rstIn,
      framesIn: v.framesIn, framesOut: v.framesOut, echoes: v.echoes, udpUnreach: v.udpUnreach, bad: v.bad,
      slow: v.slow, overrun: v.overrun, sessions, personas, racing, games: l.games, logins: l.logins,
      chats: l.chats, races: l.races, dropped: l.dropped,
    };
  }

  /** the browsers in Online mode now */
  vips() {
    return this.lobby.vips(this.here);
  }

  /** the server stops: the lobby's links go, the files are written, the timers end */
  stop() {
    if (this.tickTimer !== null) {
      this.timers.clear(this.tickTimer);
      this.tickTimer = null;
    }
    this.lobbyStop();
    this.buddyStop();
    this.purge();
  }
}

Object.assign(Core.prototype, vhostMethods, lobbyMethods, buddyMethods, racesMethods, httpMethods);

