// Lockstep glue shared by the page, the room (worker/room.js) and the node tests: a thin wrapper over the wasm
// exports (Machine) and the client side of the room protocol (NetClient). No DOM here.

export const TICKS_PER_FRAME = 3;
export const FRAME_MS = 50;
export const HASH_EVERY = 20;
export const MAX_CARS = 8;
export const MAX_HUMANS = 4;
export const HEADER_WORDS = 8;
export const CAR_WORDS = 16;
export const STATE_WORDS = HEADER_WORDS + MAX_CARS * CAR_WORDS;
export const COUNTDOWN_TICKS = 180;
export const MAX_FUEL_M = 10_000_000;
// rpm marks (src/sim.zig): perfect shift window, redline, limiter
export const RPM = { idle: 900, perfectLo: 6800, perfectHi: 7300, goodLo: 6200, goodHi: 7700, redline: 7500, max: 8000 };

// header word indices
export const H = { phase: 0, tick: 1, cars: 2, laps: 3, countdown: 4, track_m: 5, mode: 6, leader_finish: 7 };
// car word indices
export const C = {
  progress_mm: 0, lap: 1, place: 2, speed_x10: 3, rpm: 4, gear: 5, nitro: 6, finished: 7,
  lateral_mm: 8, flags: 9, distance_m: 10, last_shift: 11, best_lap: 12, colour: 13,
};
export const FLAG = { HUMAN: 1, FUEL_LIMITED: 2, PERFECT: 4, NITRO: 8, CRASHED: 16 };
export const IN = { THROTTLE: 1, BRAKE: 2, LEFT: 4, RIGHT: 8, NITRO: 16, SHIFT_UP: 32, SHIFT_DOWN: 64 };

const BOT_NAMES = ['Vex', 'Juno', 'Kestrel', 'Rook', 'Nova', 'Sable', 'Ember', 'Quill'];

export const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** Imports for machines.wasm: no-op stubs for whatever functions it imports (it should import none). */
export function wasmImports(module) {
  const imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') continue;
    (imports[imp.module] ??= {})[imp.name] = () => 0;
  }
  return imports;
}

/** Options a race starts with, clamped to what the simulation accepts. */
export function clampOptions(o, humans) {
  const mode = isInt(o?.mode, 0, 2) ? o.mode : 0;
  const track = isInt(o?.track, 0, 7) ? o.track : 0;
  const laps = mode === 0 ? (isInt(o?.laps, 1, 9) ? o.laps : 3) : 1;
  const maxCars = mode === 2 ? 4 : MAX_CARS;
  let bots = isInt(o?.bots, 0, MAX_CARS) ? o.bots : 0;
  bots = Math.min(bots, maxCars - humans);
  if (mode === 2 && humans + bots < 2) bots = 1;
  return { mode, track, laps, bots };
}

export function carNames(humanNames, bots) {
  const names = humanNames.slice(0, MAX_HUMANS);
  for (let i = 0; i < bots; i++) names.push(BOT_NAMES[i % BOT_NAMES.length]);
  return names;
}

/** A frame's fuel field: flat [slot, paid_m, ...] pairs, validated; null if absent or bad. */
export function fuelPairs(fu, humans) {
  if (!Array.isArray(fu) || fu.length === 0 || fu.length > 2 * MAX_HUMANS || fu.length % 2) return null;
  for (let k = 0; k < fu.length; k += 2) {
    if (!isInt(fu[k], 0, humans - 1) || !isInt(fu[k + 1], 0, MAX_FUEL_M)) return null;
  }
  return fu.slice();
}

/** One simulation instance (one wasm instance). */
export class Machine {
  constructor(exports) {
    this.x = exports;
    this.humans = 1;
    this.cars = 1;
  }
  static fromModule(module) {
    return new Machine(new WebAssembly.Instance(module, wasmImports(module)).exports);
  }
  bytes(ptr, n) { return new Uint8Array(this.x.memory.buffer, ptr, n); }
  init(seedLo, seedHi, mode, track, laps, humans, bots) {
    this.humans = humans;
    this.cars = humans + bots;
    this.x.mm_init(seedLo >>> 0, seedHi >>> 0, mode, track, laps, humans, bots);
  }
  state() { return new Int32Array(this.x.memory.buffer, this.x.mm_state_ptr(), STATE_WORDS); }
  car(state, slot, word) { return state[HEADER_WORDS + slot * CAR_WORDS + word]; }
  trackName() {
    const b = this.bytes(this.x.mm_track_name_ptr(), 64);
    let s = '';
    for (let i = 0; i < b.length && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  setInput(slot, b) { this.bytes(this.x.mm_input_ptr(), MAX_CARS)[slot] = b & 127; }
  tick() { this.x.mm_tick(); }
  hash() { return this.x.mm_hash() >>> 0; }
  fuel(slot, on, paidM) { this.x.mm_fuel(slot, on ? 1 : 0, Math.max(0, paidM) >>> 0); }
  render(slot, w, h) {
    this.x.mm_render(slot, w, h);
    return new Uint8ClampedArray(this.x.memory.buffer, this.x.mm_fb_ptr(), w * h * 4);
  }
  netReset() { this.x.mm_net_reset(); }
  next() { return this.x.mm_net_next() >>> 0; }
  push(n, inputs) {
    this.bytes(this.x.mm_net_buf_ptr(), inputs.length).set(inputs);
    return this.x.mm_net_push(n >>> 0);
  }
  pump(maxTicks) { return this.x.mm_net_pump(maxTicks) >>> 0; }
}

/** Race time of a car in ticks since GO (0 if not finished). */
export function raceTicks(machine, state, slot) {
  const f = machine.car(state, slot, C.finished);
  return f > 0 ? Math.max(0, f - COUNTDOWN_TICKS) : 0;
}

/** Results from a finished (or capped) race, best place first. */
export function results(machine, names) {
  const s = machine.state();
  const out = [];
  for (let c = 0; c < machine.cars; c++) {
    out.push({ slot: c, name: names[c] ?? 'Car ' + (c + 1), place: machine.car(s, c, C.place), ticks: raceTicks(machine, s, c) });
  }
  out.sort((a, b) => a.place - b.place);
  return out;
}

/**
 * The client side of the room protocol over any transport: feed it the room's messages (onMessage), call update()
 * every animation frame, and setInput() with the local input byte. send(obj) is the transport.
 */
export class NetClient {
  constructor({ machine, send, now, onEvent }) {
    this.m = machine;
    this.send = send;
    this.now = now;
    this.onEvent = onEvent ?? (() => {});
    this.you = -1;
    this.host = -1;
    this.players = [];
    this.racing = false;
    this.start = null;
    this.endResults = null;
    this.desync = null;
    this.firstFrame = 0;
    this.ticks = 0; // ticks applied this race
    this.owed = 0; // ticks owed to the 60 Hz clock
    this.lastUpdate = 0;
    this.lastProgress = 0;
    this.lastResend = -1e9;
    this.newest = -1; // newest frame number received
    this.roomHashes = new Map();
    this.myHashes = new Map();
    this.inByte = -1;
    this.inAt = -1e9;
    this.resends = 0;
    this.fuelAt = new Map(); // frame -> [slot, paid_m, ...] to apply before that frame
  }

  get frame() { return this.firstFrame + Math.floor(this.ticks / TICKS_PER_FRAME); } // next frame to apply

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'room') return this.onRoom(msg);
    if (msg.t === 'start') return this.onStart(msg);
    if (!this.racing && msg.t !== 'end') return;
    if (msg.t === 'f') return this.onFrame(msg);
    if (msg.t === 'h') return this.onHash(msg);
    if (msg.t === 'end') return this.onEnd(msg);
  }

  onRoom(msg) {
    this.you = isInt(msg.you, -1, MAX_HUMANS - 1) ? msg.you : -1;
    this.host = isInt(msg.host, -1, MAX_HUMANS - 1) ? msg.host : -1;
    this.players = Array.isArray(msg.players) ? msg.players.slice(0, MAX_HUMANS) : [];
    this.onEvent('room', msg);
  }

  onStart(msg) {
    if (!Array.isArray(msg.seed) || msg.seed.length !== 2) return;
    if (!isInt(msg.humans, 1, MAX_HUMANS) || !isInt(msg.bots, 0, MAX_CARS - msg.humans)) return;
    if (!isInt(msg.mode, 0, 2) || !isInt(msg.track, 0, 7) || !isInt(msg.laps, 1, 99)) return;
    this.m.init(msg.seed[0], msg.seed[1], msg.mode, msg.track, msg.laps, msg.humans, msg.bots);
    this.m.netReset();
    this.firstFrame = this.m.next();
    this.ticks = 0;
    this.owed = 0;
    this.newest = this.firstFrame - 1;
    this.roomHashes.clear();
    this.myHashes.clear();
    this.fuelAt.clear();
    this.desync = null;
    this.endResults = null;
    this.racing = true;
    this.start = msg;
    this.lastUpdate = this.lastProgress = this.now();
    this.onEvent('start', msg);
  }

  onFrame(msg) {
    const want = TICKS_PER_FRAME * this.m.humans;
    if (!isInt(msg.n, 0, 0xffffffff) || !Array.isArray(msg.i) || msg.i.length !== want) return;
    const bytes = new Uint8Array(want);
    for (let k = 0; k < want; k++) bytes[k] = isInt(msg.i[k], 0, 255) ? msg.i[k] : 0;
    const fu = fuelPairs(msg.fu, this.m.humans);
    if (fu && msg.n >= this.frame && this.fuelAt.size < 600) this.fuelAt.set(msg.n, fu);
    const r = this.m.push(msg.n, bytes);
    if (msg.n > this.newest) this.newest = msg.n;
    if (r === 2) this.askResend(true);
  }

  onHash(msg) {
    if (!isInt(msg.n, 0, 0xffffffff) || !isInt(msg.hash, 0, 0xffffffff)) return;
    this.roomHashes.set(msg.n, msg.hash);
    this.compare(msg.n);
    if (this.roomHashes.size > 32) this.roomHashes.delete(this.roomHashes.keys().next().value);
  }

  onEnd(msg) {
    this.racing = false;
    this.endResults = Array.isArray(msg.results) ? msg.results.slice(0, MAX_CARS) : [];
    this.onEvent('end', msg);
  }

  compare(n) {
    const a = this.roomHashes.get(n), b = this.myHashes.get(n);
    if (a === undefined || b === undefined) return;
    if (a !== b && !this.desync) {
      this.desync = { n, room: a, mine: b };
      this.onEvent('desync', this.desync);
    }
  }

  askResend(force) {
    const t = this.now();
    if (t - this.lastResend < 300 && !force) return;
    if (t - this.lastResend < 100) return;
    this.lastResend = t;
    this.resends++;
    this.send({ t: 'resend', from: this.m.next() });
  }

  /** Applies buffered frames paced at 60 Hz (faster when behind). maxTicks bounds one call. */
  update(maxTicks = 120) {
    if (!this.racing) return 0;
    const t = this.now();
    this.owed += Math.min(250, t - this.lastUpdate) * 60 / 1000;
    this.lastUpdate = t;
    const behind = (this.newest + 1 - this.frame) * TICKS_PER_FRAME - (this.ticks % TICKS_PER_FRAME);
    if (behind > 4 * TICKS_PER_FRAME) this.owed += behind / 4; // catch up after a stall
    let todo = Math.min(maxTicks, Math.floor(this.owed));
    let done = 0;
    for (let guard = 0; guard < 64 && todo > 0; guard++) {
      // stop at frame boundaries that carry a hash (record ours) or a fuel change (apply it first)
      const f = this.frame - this.firstFrame;
      const hashFrame = f + ((HASH_EVERY - 1 - (f % HASH_EVERY)) + HASH_EVERY) % HASH_EVERY;
      const hashAt = (hashFrame + 1) * TICKS_PER_FRAME;
      let boundary = hashAt;
      if (this.ticks % TICKS_PER_FRAME === 0) this.applyFuel(this.frame);
      for (const n of this.fuelAt.keys()) {
        if (n > this.frame) boundary = Math.min(boundary, (n - this.firstFrame) * TICKS_PER_FRAME);
      }
      const got = this.m.pump(Math.min(todo, boundary - this.ticks));
      if (got === 0) break;
      this.ticks += got;
      todo -= got;
      done += got;
      if (this.ticks === hashAt) {
        const n = this.firstFrame + hashFrame;
        this.myHashes.set(n, this.m.hash());
        if (this.myHashes.size > 32) this.myHashes.delete(this.myHashes.keys().next().value);
        this.compare(n);
      }
    }
    this.owed = Math.min(this.owed - done, 2 * TICKS_PER_FRAME);
    if (done > 0) this.lastProgress = t;
    else if (t - this.lastProgress >= 300) { this.askResend(false); }
    return done;
  }

  applyFuel(n) {
    const fu = this.fuelAt.get(n);
    if (!fu) return;
    this.fuelAt.delete(n);
    for (let k = 0; k + 1 < fu.length; k += 2) this.m.fuel(fu[k], 1, fu[k + 1]);
  }

  /** The local input byte: sent on change and every 250 ms. */
  setInput(b) {
    b &= 127;
    const t = this.now();
    if (b === this.inByte && t - this.inAt < 250) return;
    this.inByte = b;
    this.inAt = t;
    this.send({ t: 'in', b });
  }
}

/** Browser/Node WebSocket to /room/<code>, wired to a NetClient. Returns { client, ws, close }. */
export function openRoom({ url, machine, name, onEvent, now = () => performance.now() }) {
  const ws = new WebSocket(url);
  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const client = new NetClient({ machine, send, now, onEvent });
  ws.addEventListener('open', () => { send({ t: 'hello', name }); onEvent?.('open'); });
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string' || e.data.length > 65536) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg?.t === 'full' || msg?.t === 'error') onEvent?.('error', msg);
    client.onMessage(msg);
  });
  ws.addEventListener('close', () => onEvent?.('close'));
  ws.addEventListener('error', () => onEvent?.('error', { t: 'error', why: 'connection failed' }));
  return { client, ws, send, close: () => ws.close() };
}

