// A multiplayer room (SPEC.md "Multiplayer"). RoomCore is the whole protocol as a plain class (a send function, a
// clock and timers are injected, so node tests drive it without workerd); Room is the Durable Object around it.
import { DurableObject } from 'cloudflare:workers';
import wasmModule from '../web/machines.wasm';
import {
  FRAME_MS, HASH_EVERY, MAX_FUEL_M, MAX_HUMANS, TICKS_PER_FRAME, H, Machine, carNames, clampOptions, isInt, results,
} from '../web/net.js';

export const KEEP_FRAMES = 600;
export const CAP_FRAMES = (6 * 60 * 1000) / FRAME_MS; // a race never runs past 6 minutes
const MAX_MSG = 512; // bytes of one client message
const MAX_RESEND = 256; // frames sent for one resend request
const MAX_CATCHUP = 10; // frames sent by one late timer tick
const MAX_CONNS = 16; // sockets, including ones that never said hello

export function cleanName(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 16);
  return s || fallback;
}

export class RoomCore {
  /**
   * send(id, text): to one socket; close(id): drop a socket; now(): ms; setInterval/clearInterval: the frame timer;
   * seed(): two u32 words.
   */
  constructor({ module, send, close, now, setInterval, clearInterval, seed, log }) {
    this.machine = Machine.fromModule(module);
    this.sendRaw = send;
    this.closeRaw = close ?? (() => {});
    this.now = now;
    this.setTimer = setInterval;
    this.clearTimer = clearInterval;
    this.seed = seed;
    this.log = log ?? (() => {});
    this.conns = new Map(); // id -> { id, name, member, joined, slot, b, fuel, lastResend }
    this.members = []; // joined connections in join order; members[0] is host
    this.nextId = 1;
    this.racing = false;
    this.race = null; // { names, humans, bots, mode, track, laps, slots: id per race slot }
    this.timer = null;
    this.t0 = 0;
    this.sent = 0; // frames sent this race
    this.ring = new Array(KEEP_FRAMES).fill(null); // ring[n % KEEP_FRAMES] = text of frame n
    this.fuelDirty = [];
  }

  connect() {
    if (this.conns.size >= MAX_CONNS) return 0;
    const id = this.nextId++;
    this.conns.set(id, { id, name: '', joined: false, slot: -1, b: 0, fuel: -1, fuelSent: -1, lastResend: -1e9 });
    return id;
  }

  disconnect(id) {
    const c = this.conns.get(id);
    if (!c) return;
    this.conns.delete(id);
    const i = this.members.indexOf(c);
    if (i < 0) return;
    this.members.splice(i, 1);
    if (this.racing && this.members.every((m) => m.slot < 0)) this.finish('empty');
    if (!this.racing) this.reslot();
    this.broadcastRoom();
  }

  /** One message from socket id; anything malformed is ignored. */
  message(id, data) {
    const c = this.conns.get(id);
    if (!c || typeof data !== 'string' || data.length > MAX_MSG) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    try {
      if (m.t === 'hello') this.onHello(c, m);
      else if (!c.joined) return;
      else if (m.t === 'start') this.onStart(c, m);
      else if (m.t === 'in') { if (isInt(m.b, 0, 127)) c.b = m.b; }
      else if (m.t === 'resend') this.onResend(c, m);
      else if (m.t === 'fuel') this.onFuel(c, m);
    } catch (e) {
      this.log('room: ' + e);
    }
  }

  onHello(c, m) {
    if (c.joined) { c.name = cleanName(m.name, c.name); this.broadcastRoom(); return; }
    if (this.members.length >= MAX_HUMANS) {
      this.send(c.id, { t: 'full' });
      this.closeRaw(c.id);
      return;
    }
    c.joined = true;
    c.name = cleanName(m.name, 'Driver ' + (this.members.length + 1));
    this.members.push(c);
    if (!this.racing) this.reslot();
    this.broadcastRoom();
  }

  onStart(c, m) {
    if (this.racing || this.members[0] !== c) return;
    const humans = this.members.length;
    const o = clampOptions(m, humans);
    const [lo, hi] = this.seed();
    const names = carNames(this.members.map((x) => x.name), o.bots);
    this.race = { ...o, humans, names, slots: this.members.map((x) => x.id) };
    this.members.forEach((x, i) => { x.slot = i; x.b = 0; x.fuel = -1; x.fuelSent = -1; });
    this.machine.init(lo, hi, o.mode, o.track, o.laps, humans, o.bots);
    this.machine.netReset();
    this.first = this.machine.next();
    this.ring.fill(null);
    this.sent = 0;
    this.racing = true;
    this.t0 = this.now();
    this.broadcast({ t: 'start', seed: [lo >>> 0, hi >>> 0], mode: o.mode, track: o.track, laps: o.laps, humans, bots: o.bots, names });
    this.broadcastRoom();
    this.timer = this.setTimer(() => this.tick(), FRAME_MS);
  }

  onResend(c, m) {
    if (!this.racing || !isInt(m.from, 0, 0xffffffff)) return;
    const t = this.now();
    if (t - c.lastResend < 100) return;
    c.lastResend = t;
    const newest = this.first + this.sent - 1;
    const from = Math.max(m.from, this.first, newest - KEEP_FRAMES + 1);
    const to = Math.min(newest, from + MAX_RESEND - 1);
    for (let n = from; n <= to; n++) {
      const text = this.ring[n % KEEP_FRAMES];
      if (text) this.sendRaw(c.id, text);
    }
  }

  onFuel(c, m) {
    if (!this.racing || c.slot < 0 || !isInt(m.m, 0, MAX_FUEL_M) || m.m <= c.fuel) return;
    c.fuel = m.m;
  }

  /** Timer: sends every frame due by now (a few at most per call). */
  tick() {
    if (!this.racing) return;
    let due = Math.floor((this.now() - this.t0) / FRAME_MS) + 1;
    if (due - this.sent > 4 * MAX_CATCHUP) { // the timer slept: shift the clock rather than burst
      this.t0 += (due - this.sent - MAX_CATCHUP) * FRAME_MS;
      due = this.sent + MAX_CATCHUP;
    }
    try {
      for (let k = 0; k < MAX_CATCHUP && this.racing && this.sent < due; k++) this.step();
    } catch (e) {
      this.log('room step: ' + e);
      this.finish('error');
    }
  }

  /** Builds, applies and sends the next frame. */
  step() {
    const r = this.race;
    const n = this.first + this.sent;
    const bytes = new Array(TICKS_PER_FRAME * r.humans).fill(0);
    const fu = [];
    for (let s = 0; s < r.humans; s++) {
      const c = this.conns.get(r.slots[s]);
      const b = c && c.slot === s ? c.b : 0;
      for (let k = 0; k < TICKS_PER_FRAME; k++) bytes[k * r.humans + s] = b;
      if (c && c.slot === s && c.fuel > c.fuelSent) { fu.push(s, c.fuel); c.fuelSent = c.fuel; }
    }
    const frame = fu.length ? { t: 'f', n, i: bytes, fu } : { t: 'f', n, i: bytes };
    for (let k = 0; k < fu.length; k += 2) this.machine.fuel(fu[k], 1, fu[k + 1]);
    const res = this.machine.push(n, Uint8Array.from(bytes));
    if (res !== 0) throw new Error('room push ' + res + ' at ' + n);
    const ticks = this.machine.pump(TICKS_PER_FRAME);
    if (ticks !== TICKS_PER_FRAME) throw new Error('room pump ' + ticks + ' at ' + n);
    const text = JSON.stringify(frame);
    this.ring[n % KEEP_FRAMES] = text;
    this.sent++;
    this.broadcastRacers(text);
    if (this.sent % HASH_EVERY === 0) this.broadcastRacers(JSON.stringify({ t: 'h', n, hash: this.machine.hash() }));
    if (this.machine.state()[H.phase] === 2) this.finish('finished');
    else if (this.sent >= CAP_FRAMES) this.finish('cap');
  }

  finish(why) {
    if (!this.racing) return;
    this.racing = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.broadcast({ t: 'end', why, results: results(this.machine, this.race.names) });
    for (const c of this.conns.values()) c.slot = -1;
    this.reslot();
    this.broadcastRoom();
  }

  reslot() { this.members.forEach((c, i) => { c.slot = i; }); }

  broadcastRoom() {
    const players = this.members.map((c) => ({ slot: c.slot, name: c.name }));
    const host = this.members.length ? this.members[0].slot : -1;
    for (const c of this.members) this.send(c.id, { t: 'room', you: c.slot, host, players, racing: this.racing });
  }

  send(id, obj) { this.sendRaw(id, JSON.stringify(obj)); }
  broadcast(obj) { const text = JSON.stringify(obj); for (const c of this.members) this.sendRaw(c.id, text); }
  broadcastRacers(text) { for (const c of this.members) if (c.slot >= 0) this.sendRaw(c.id, text); }
}

/** The Durable Object: one per room code, WebSockets in, a 50 ms timer while a race runs. */
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.socks = new Map();
    this.core = new RoomCore({
      module: wasmModule,
      send: (id, text) => { try { this.socks.get(id)?.send(text); } catch { /* socket gone */ } },
      close: (id) => { try { this.socks.get(id)?.close(1008, 'room full'); } catch { /* gone */ } },
      now: () => Date.now(),
      setInterval: (f, ms) => setInterval(f, ms),
      clearInterval: (h) => clearInterval(h),
      seed: () => Array.from(crypto.getRandomValues(new Uint32Array(2))),
      log: (s) => console.log(s),
    });
  }

  async fetch(request) {
    if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return new Response('WebSocket only', { status: 426 });
    const id = this.core.connect();
    if (!id) return new Response('room busy', { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.socks.set(id, server);
    server.addEventListener('message', (e) => this.core.message(id, e.data));
    const gone = () => { if (this.socks.delete(id)) this.core.disconnect(id); };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }
}

