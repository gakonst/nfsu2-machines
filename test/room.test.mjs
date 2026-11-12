// The room protocol end to end in node: worker/room.js's RoomCore with the real web/machines.wasm, and clients
// running web/net.js's NetClient on their own wasm instances. Run: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// MM_WASM=<path> tests another build of the wasm.
const WASM = process.env.MM_WASM ? new URL('file://' + process.env.MM_WASM) : new URL('../web/machines.wasm', import.meta.url);

// room.js imports 'cloudflare:workers' and the wasm as a module, as wrangler bundles it: give node both.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
    }
    if (specifier.endsWith('machines.wasm')) return { url: WASM.href + '?compiled', shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('machines.wasm?compiled')) {
      const file = JSON.stringify(url.replace(/\?compiled$/, ''));
      return { format: 'module', source: 'import { readFileSync } from "node:fs"; export default new WebAssembly.Module(readFileSync(new URL(' + file + ')));', shortCircuit: true };
    }
    return next(url, context);
  },
});

const { RoomCore, CAP_FRAMES, KEEP_FRAMES } = await import('../worker/room.js');
const net = await import('../web/net.js');
const { Machine, NetClient, IN, H, C, FRAME_MS } = net;
const module = new WebAssembly.Module(readFileSync(WASM));

/** A room with a fake clock and fake sockets; clients are NetClients on their own wasm. */
function world() {
  const w = { t: 0, timer: null, inbox: new Map(), clients: new Map(), closed: new Set(), seq: 0 };
  w.core = new RoomCore({
    module,
    send: (id, text) => { w.inbox.get(id)?.push(text); },
    close: (id) => { w.closed.add(id); },
    now: () => w.t,
    setInterval: (f) => { w.timer = f; return 1; },
    clearInterval: () => { w.timer = null; },
    seed: () => [0x1234567 + w.seq, 0x89abcdef],
    log: () => {},
  });
  w.join = (name) => {
    const id = w.core.connect();
    w.inbox.set(id, []);
    const events = [];
    const client = new NetClient({
      machine: new Machine(new WebAssembly.Instance(module, net.wasmImports(module)).exports),
      send: (obj) => w.core.message(id, JSON.stringify(obj)),
      now: () => w.t,
      onEvent: (e, m) => events.push([e, m]),
    });
    const c = { id, client, events, drop: false, raw: [] };
    w.clients.set(id, c);
    client.send({ t: 'hello', name });
    w.deliver();
    return c;
  };
  w.deliver = () => {
    for (const [id, q] of w.inbox) {
      const c = w.clients.get(id);
      for (const text of q.splice(0)) {
        if (!c || c.drop) continue;
        const msg = JSON.parse(text);
        c.raw.push(msg);
        c.client.onMessage(msg);
      }
    }
  };
  /** 50 ms of time: the room's timer, delivery, each client's update and input. */
  w.frame = (input) => {
    w.t += FRAME_MS;
    if (w.timer) w.timer();
    w.deliver();
    for (const c of w.clients.values()) {
      // three animation frames per room frame, as a 60 Hz page would
      for (let k = 0; k < 3; k++) c.client.update();
      if (c.client.racing && input) c.client.setInput(input(c));
    }
  };
  /** Lets every client apply all it has (clients pace at 60 Hz, so they trail the room by a frame). */
  w.drain = () => { for (const c of w.clients.values()) { c.client.owed += 2000; c.client.update(2000); } };
  return w;
}

const last = (c, t) => c.raw.filter((m) => m.t === t).at(-1);

/** Drives a car forward and keeps it near the centre of the road. */
function driver(c, extra = 0) {
  const m = c.client.m, s = m.state(), slot = c.client.you;
  if (slot < 0) return 0;
  const lat = m.car(s, slot, C.lateral_mm);
  let b = IN.THROTTLE | extra;
  if (lat > 1200) b |= IN.LEFT;
  else if (lat < -1200) b |= IN.RIGHT;
  return b;
}

test('two clients race with bots: frames, hashes, resend, fuel, results', () => {
  const w = world();
  const a = w.join('Ana');
  const b = w.join('Ben');
  assert.equal(last(a, 'room').host, 0);
  assert.equal(last(a, 'room').you, 0);
  assert.equal(last(b, 'room').you, 1);
  assert.deepEqual(last(b, 'room').players.map((p) => p.name), ['Ana', 'Ben']);

  // garbage never throws and changes nothing
  const bad = ['', 'nope', '{', '[]', 'null', '7', '{"t":"start"}', JSON.stringify({ t: 'in', b: 999 }), JSON.stringify({ t: 'in', b: 'x' }),
    JSON.stringify({ t: 'resend', from: -5 }), JSON.stringify({ t: 'hello', name: { x: 1 } }), 'x'.repeat(100000), JSON.stringify({ t: '__proto__' }),
    JSON.stringify({ t: 'fuel', m: -1 })];
  for (const text of bad) { w.core.message(b.id, text); w.core.message(a.id, text === '{"t":"start"}' ? 'x' : text); }
  w.core.message(b.id, new Uint8Array([1, 2, 3]));
  w.core.message(9999, JSON.stringify({ t: 'start' }));
  w.core.message(b.id, JSON.stringify({ t: 'start', mode: 0, track: 1, laps: 1, bots: 2 })); // not host
  w.deliver();
  assert.equal(w.core.racing, false);
  assert.equal(last(b, 'room').players[1].name, 'Ben');

  a.client.send({ t: 'start', mode: 0, track: 3, laps: 1, bots: 3 });
  w.deliver();
  assert.equal(w.core.racing, true);
  const st = last(b, 'start');
  assert.equal(st.humans, 2);
  assert.equal(st.bots, 3);
  assert.equal(st.names.length, 5);
  assert.deepEqual(st, last(a, 'start'));
  assert.ok(a.client.racing && b.client.racing);

  // a late joiner waits; a fifth socket would be refused only past 4 humans
  const late = w.join('Cy');
  assert.equal(last(late, 'room').you, -1);
  assert.equal(late.client.racing, false);

  let n = 0;
  for (; n < 200; n++) w.frame((c) => driver(c));
  assert.equal(a.client.desync, null);
  assert.equal(b.client.desync, null);
  w.drain();
  const room = w.core.machine.hash();
  assert.equal(a.client.m.hash(), room, 'client A hash = room hash after the same frames');
  assert.equal(b.client.m.hash(), room, 'client B hash = room hash after the same frames');
  assert.ok(b.client.myHashes.size > 0 && b.client.roomHashes.size > 0);

  // B misses 40 frames, then asks for them and catches up
  b.drop = true;
  for (let k = 0; k < 40; k++, n++) w.frame((c) => driver(c, IN.NITRO));
  b.drop = false;
  const before = b.client.resends;
  for (let k = 0; k < 40; k++, n++) w.frame((c) => driver(c));
  assert.ok(b.client.resends > before, 'B asked for a resend');
  w.drain();
  assert.equal(b.client.frame, w.core.first + w.core.sent, 'B caught up');
  assert.equal(b.client.m.hash(), w.core.machine.hash());

  // fuel paid for A lands at the same frame everywhere
  a.client.send({ t: 'fuel', m: 300 });
  for (let k = 0; k < 30; k++, n++) w.frame((c) => driver(c));
  w.drain();
  assert.ok(a.raw.some((m) => m.t === 'f' && Array.isArray(m.fu)), 'a frame carried the fuel');
  assert.equal(a.client.m.hash(), w.core.machine.hash());
  assert.equal(b.client.m.hash(), w.core.machine.hash());
  assert.equal(a.client.desync, null);

  // resend of something older than the ring is clamped, not thrown
  w.core.message(a.id, JSON.stringify({ t: 'resend', from: 0 }));

  // run to the end
  for (let k = 0; k < CAP_FRAMES + 10 && w.core.racing; k++, n++) w.frame((c) => driver(c, k % 2 ? IN.SHIFT_UP : 0));
  assert.equal(w.core.racing, false);
  w.deliver();
  const end = last(a, 'end');
  assert.ok(end, 'end message');
  assert.equal(end.why, 'finished');
  assert.equal(end.results.length, 5);
  assert.deepEqual(end.results.map((r) => r.place).sort(), [1, 2, 3, 4, 5]);
  assert.equal(a.client.racing, false);
  assert.equal(b.client.desync, null);
  assert.ok(a.client.myHashes.size > 0);
  // after the race the late joiner has a slot again
  assert.equal(last(late, 'room').you, 2);
  assert.ok(KEEP_FRAMES >= 600);
});

test('a drag race ends with results; host passes on; room full', () => {
  const w = world();
  const a = w.join('A');
  const b = w.join('B');
  w.join('C');
  w.join('D');
  const e = w.join('E');
  assert.ok(w.closed.has(e.id), 'fifth human refused');
  assert.equal(last(e, 'full')?.t, 'full');
  w.core.disconnect(a.id);
  w.clients.delete(a.id);
  w.deliver();
  assert.equal(last(b, 'room').you, 0);
  assert.equal(last(b, 'room').host, 0);
  b.client.send({ t: 'start', mode: 2, track: 0, laps: 5, bots: 7 });
  w.deliver();
  const st = last(b, 'start');
  assert.equal(st.mode, 2);
  assert.equal(st.humans + st.bots <= 4, true);
  assert.equal(st.laps, 1);
  let shifts = 0;
  for (let k = 0; k < CAP_FRAMES + 10 && w.core.racing; k++) {
    w.frame((c) => {
      const m = c.client.m, s = m.state();
      const rpm = c.client.you >= 0 ? m.car(s, c.client.you, C.rpm) : 0;
      if (rpm > 7000 && k % 3 === 0) { shifts++; return IN.THROTTLE | IN.SHIFT_UP; }
      return IN.THROTTLE;
    });
  }
  w.deliver();
  const end = last(b, 'end');
  assert.ok(end, 'drag race ended');
  assert.equal(end.why, 'finished');
  assert.ok(end.results.some((r) => r.ticks > 0));
  w.drain();
  console.log('drag race: ' + w.core.sent + ' frames, results ' + JSON.stringify(end.results));
  assert.ok(shifts > 0);
  for (const c of w.clients.values()) assert.equal(c.client.desync, null);
});

test('everyone leaving stops the race', () => {
  const w = world();
  const a = w.join('Solo');
  a.client.send({ t: 'start', mode: 1, track: 5, laps: 1, bots: 7 });
  w.deliver();
  for (let k = 0; k < 20; k++) w.frame(() => IN.THROTTLE);
  w.core.disconnect(a.id);
  assert.equal(w.core.racing, false);
  assert.equal(w.timer, null);
});

