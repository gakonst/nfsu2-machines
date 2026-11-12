// The Durable Object that holds every /lan WebSocket (one global switch, as the Rust server has): it accepts the
// connections, feeds the sans-IO switch core (lib.js), runs its timers (and the hosts' ticks) with one timer loop, and
// keeps what the Rust store kept (lan-addresses.json) in Durable Object storage.  No hibernation: the switch's state
// lives in memory while any connection is open, as the Rust process's did.
//
// What Workers cannot do that the Rust switch did, and what stands in for it (docs/DEVIATIONS.md, the switch):
// - a server cannot send WebSocket pings: the switch's keepalive and probe pings are answered here at once with the
//   pong a browser would send (the connection is alive while Workers holds it open; a dead one ends with its 'close'),
//   so round trips by ping read 0 ms; pages that echo compact bundles' stamps still have theirs timed.
// - clients' own pings are answered by Workers itself and never reach the switch.
// - ws terminate() (no close frame) is a close with 1011 here (a browser saw 1006; the page reconnects on either).
// - the kernel's send buffer: Workers takes every message at once (no bufferedAmount), so the switch's queue rules see
//   only what waits for its own clocks.

import { LanSwitch } from './lib.js';
import { osPrng } from '../util/prng.js';
import * as store from './store.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** a module of another area that is not there yet: the switch runs without it (literal import paths, so that the
 * bundler finds them) */
function missing(e) {
  if (String(e && e.message).includes('Cannot find') || String(e && e.code) === 'ERR_MODULE_NOT_FOUND') return null;
  throw e;
}

/** the switch's options from the environment: LAN_OPTIONS (JSON, LanOptions in camelCase), LAN_IMPAIR */
function lanOptions(env) {
  try {
    return env && env.LAN_OPTIONS ? JSON.parse(env.LAN_OPTIONS) : {};
  } catch {
    return {};
  }
}

export class Switch {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sw = null;
    this.gate = null;
    this.http = null;
    this.byConn = new Map();
    this.timer = null;
    this.timerAt = Infinity;
    this.pongs = [];
    this.pruned = 0;
    this.onClaim = null;
    this.ready = state.blockConcurrencyWhile ? state.blockConcurrencyWhile(() => this.init()) : this.init();
  }

  async init() {
    const storage = {
      get: (k) => this.state.storage.get(k),
      put: (k, v) => this.state.storage.put(k, v),
    };
    const stored = await store.load(storage);
    // the hosts' storage: synchronous (the SQLite-backed Durable Object's kv), keys under their own prefixes
    const kv = this.state.storage.kv;
    const mem = new Map();
    const hostStorage = kv
      ? { get: (k) => kv.get(k), put: (k, v) => kv.put(k, v), delete: (k) => kv.delete(k), list: (p) => Array.from(kv.list({ prefix: p }), ([k]) => k) }
      : { get: (k) => mem.get(k), put: (k, v) => void mem.set(k, v), delete: (k) => void mem.delete(k), list: (p) => [...mem.keys()].filter((k) => k.startsWith(p)).sort() };
    const online = await import('../online/index.js').catch(missing);
    const roam = await import('../roam/index.js').catch(missing);
    const gate = await import('../http/lan_gate.js').catch(missing);
    this.http = await import('../http/state_routes.js').catch(missing);
    const claims = await import('../claims/claims.js').catch(missing);
    // lan.rs: on_claim only with the claimed names on (the server's names service; NAMES=on here)
    this.onClaim = claims && claims.ownerOfToken && this.env?.NAMES === 'on' ? (c) => claims.ownerOfToken(c) ?? null : null;
    if (gate && gate.LanGate) this.gate = new gate.LanGate({});
    const transport = {
      write: (conn, msgs, bytes) => this.write(conn, msgs, bytes),
      end: () => {},
      kill: (conn) => this.kill(conn),
    };
    const hosts = {};
    // (the Rust server's --online off and --roam-hub off: env ONLINE, ROAM_HUB)
    if (online && online.OnlineHost && this.env?.ONLINE !== 'off') hosts.online = (a) => new online.OnlineHost(a);
    if (roam && roam.RoamHub && this.env?.ROAM_HUB !== 'off') hosts.roam = (a) => new roam.RoamHub(a);
    this.sw = new LanSwitch({
      options: lanOptions(this.env), prng: osPrng(), nowMs: Date.now(), transport, impair: this.env?.LAN_IMPAIR ?? '',
      hosts, storage, hostStorage, stored,
      onLine: (s) => console.log(s),
    });
    this.arm();
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/lan' && (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') return this.upgrade(request);
    if (this.http && this.http.handle) {
      const r = await this.http.handle(request, this.stateView());
      if (r) return r;
    }
    return new Response('Not Found', { status: 404 });
  }

  /** what the HTTP routes read of the switch (state_routes.js) */
  stateView() {
    const sw = this.sw;
    return { sw, gate: this.gate, nowMs: Date.now(), full: () => sw.full(), peerCount: () => sw.peerCount(), waiting: () => sw.waiting() };
  }

  upgrade(request) {
    let lan = {};
    try {
      lan = JSON.parse(request.headers.get('x-lan-opts') ?? '{}');
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    const opts = lan.opts ?? lan;
    const now = Date.now();
    // lan.rs on_upgrade's per-address checks (its connections held, how fast it opens them, the subprotocols)
    let share = null;
    let protocol = null;
    if (this.gate) {
      if (now - this.pruned >= 60_000) {
        this.pruned = now;
        this.gate.prune(now);
      }
      const t = this.gate.take(lan.key ?? '', lan.site ?? '', now, opts);
      if (t.refuse) {
        if (t.log) console.log(t.log);
        return t.response ?? new Response(t.body ?? '', { status: t.status ?? 429, headers: t.headers ?? {} });
      }
      share = t.share;
      protocol = t.protocol ?? null;
    }
    const pair = new WebSocketPair();
    const [client, ws] = Object.values(pair);
    ws.accept();
    // (the standard's default is Blob, which workerd follows from 2026's compatibility dates: whole messages as bytes)
    ws.binaryType = 'arraybuffer';
    const entry = { ws, share, gone: false };
    const conn = this.sw.attach({
      resume: !!opts.resume, queue: !!opts.queue, group: opts.group ?? null, site: opts.site ?? null, ident: opts.ident ?? null,
      refuse: opts.refuse ?? null, country: opts.country ?? null, onClaim: this.onClaim,
      onJoin: (vip, resumed, n) => console.log('[lan] ' + vipText(vip) + ' ' + (resumed ? 'is back' : 'joined') + ' (' + n + ' on the switch)'),
      onLeave: (vip, name, n) => console.log('[lan] ' + vipText(vip) + ' ' + JSON.stringify(name) + ' left (' + n + ' on the switch)'),
    }, now, (c) => this.byConn.set(c, entry));
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' && !(e.data instanceof ArrayBuffer)) throw new Error('a binary message that is not an ArrayBuffer');
      const msg = typeof e.data === 'string' ? { type: 'text', data: enc.encode(e.data) } : { type: 'binary', data: new Uint8Array(e.data) };
      this.step(() => this.sw.message(conn, msg, Date.now()));
    });
    ws.addEventListener('close', (e) => {
      this.step(() => {
        if (e.code !== 1006) this.sw.message(conn, { type: 'close', code: e.code || 1005, reason: enc.encode(e.reason ?? '') }, Date.now());
        this.gone(conn);
      });
    });
    ws.addEventListener('error', () => this.step(() => this.gone(conn)));
    this.settle();
    return new Response(null, { status: 101, webSocket: client, headers: protocol ? { 'sec-websocket-protocol': protocol } : {} });
  }

  gone(conn) {
    const e = this.byConn.get(conn);
    if (!e || e.gone) return;
    e.gone = true;
    this.sw.socketGone(conn, Date.now());
    this.byConn.delete(conn);
    if (e.share && this.gate) this.gate.release(e.share);
  }

  /** the transport: Workers takes every message at once */
  write(conn, msgs, bytes) {
    const e = this.byConn.get(conn);
    if (!e || e.gone) return bytes;
    for (const m of msgs) {
      try {
        switch (m.op) {
          case 'text':
            e.ws.send(dec.decode(m.data));
            break;
          case 'binary':
            e.ws.send(m.data);
            break;
          case 'ping':
            // no server pings on Workers: the pong a browser answers with
            this.pongs.push([conn, m.data.slice()]);
            break;
          case 'pong':
            break;
          case 'close': {
            const code = m.data.length >= 2 ? (m.data[0] << 8) | m.data[1] : undefined;
            const reason = m.data.length > 2 ? dec.decode(m.data.subarray(2)) : undefined;
            if (code === undefined) e.ws.close();
            else e.ws.close(code, reason);
            break;
          }
          default:
            throw new Error('unknown op ' + m.op);
        }
      } catch (err) {
        console.error('[lan] send: ' + err);
      }
    }
    return bytes;
  }

  kill(conn) {
    const e = this.byConn.get(conn);
    if (!e || e.gone) return;
    try {
      e.ws.close(1011);
    } catch {
      /* gone already */
    }
    this.gone(conn);
  }

  step(f) {
    try {
      f();
    } finally {
      this.settle();
    }
  }

  /** the synthetic pongs, then the timer for the switch's next due work */
  settle() {
    for (let guard = 0; this.pongs.length && guard < 1000; guard++) {
      const p = this.pongs;
      this.pongs = [];
      for (const [conn, data] of p) if (this.byConn.has(conn)) this.sw.message(conn, { type: 'pong', data }, Date.now());
    }
    this.arm();
  }

  arm() {
    const at = this.sw.nextWakeMs();
    if (at >= this.timerAt && this.timer) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = at;
    if (!Number.isFinite(at)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.step(() => this.sw.tick(Date.now()));
    }, Math.max(1, at - Date.now()));
  }
}

function vipText(v) {
  return ((v >>> 24) & 255) + '.' + ((v >>> 16) & 255) + '.' + ((v >>> 8) & 255) + '.' + (v & 255);
}

