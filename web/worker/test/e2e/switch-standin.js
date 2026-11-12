// A stand-in for the Switch Durable Object (web/worker/src/switch/do.js, agent 4's), for the HTTP tests only: the
// internal routes of docs/INTERNAL.md through state_routes.js handle with the state of a Rust server that nobody plays
// on (--online off --roam-hub off: no Online host, no hub, no names), and the /lan upgrade's budgets (lan_gate.js).  It
// shows the wiring the real DO does; it is not the switch (an admitted WebSocket is accepted and closed at once).
import { handle, idOk } from '../../src/http/state_routes.js';
import { LanGate } from '../../src/http/lan_gate.js';

/** days.rs Days, in memory (no days.json, no day roll): each id once per set, Seen's sets up to what it did */
export class DaysStandIn {
  constructor() {
    this.sets = [new Set(), new Set(), new Set(), new Set()];
    this.reports = [0, 0, 0];
    this.counts = new Map();
  }
  seen(id, what) {
    if (!idOk(id)) return;
    for (let i = 0; i <= what; i++) this.sets[i].add(id);
  }
  told(id, r) {
    if (!idOk(id)) return;
    this.reports[r.device]++;
    for (const [k, v] of r.pairs) {
      const key = k + '=' + v;
      const c = this.counts.get(key) ?? [0, 0, 0];
      c[r.device]++;
      this.counts.set(key, c);
    }
  }
  today() {
    return this.sets.map((s) => s.size);
  }
}

export class Switch {
  constructor(state, env, clock = () => Date.now()) {
    this.state = state;
    this.env = env;
    this.clock = clock;
    this.gate = new LanGate();
    this.days = new DaysStandIn();
    this.names = null;
    this.friends = null;
    this.peers = 0;
  }

  /** the /lan upgrade as the DO takes it: x-lan-opts = {key, site, opts} from the Worker */
  upgrade(fwd, now) {
    const t = this.gate.take(fwd.key, fwd.site, now, fwd.opts);
    if (t.refuse) return t.response;
    if (typeof WebSocketPair === 'undefined') {
      this.gate.release(t.share);
      return new Response('admitted', { status: 200, headers: { 'x-protocol': t.protocol ?? '' } });
    }
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    server.addEventListener('close', () => this.gate.release(t.share));
    server.addEventListener('error', () => this.gate.release(t.share));
    const h = new Headers();
    if (t.protocol) h.set('sec-websocket-protocol', t.protocol);
    return new Response(null, { status: 101, webSocket: client, headers: h });
  }

  async fetch(request) {
    const now = this.clock();
    const fwd = request.headers.get('x-lan-opts');
    if (fwd !== null) return this.upgrade(JSON.parse(fwd), now);
    const view = {
      peerCount: () => this.peers, full: () => false, waiting: () => 0, nowMs: now, gate: this.gate,
      online: null, roam: null, days: this.days, names: this.names, friends: this.friends,
    };
    return (await handle(request, view)) ?? new Response('no such route', { status: 404 });
  }
}

/** an env.SWITCH binding for node tests: one stand-in, its stubs' fetch its own */
export function switchBinding(standIn) {
  return {
    idFromName: (n) => n,
    get: () => ({ fetch: (req) => standIn.fetch(req) }),
  };
}

