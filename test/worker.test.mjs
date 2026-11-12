// The Worker end to end over real WebSockets, against wrangler dev (or a deployment):
//   MM_URL=http://localhost:8787 node --test test/worker.test.mjs
// Skipped when MM_URL is not set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Machine, openRoom } from '../web/net.js';

const BASE = process.env.MM_URL;
const module = BASE ? new WebAssembly.Module(readFileSync(process.env.MM_WASM ?? new URL('../web/machines.wasm', import.meta.url))) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, f, ms = 10000) {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(20);
  }
}

test('static files and routes', { skip: !BASE }, async () => {
  const page = await fetch(BASE + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /MIDNIGHT/);
  const wasm = await fetch(BASE + '/machines.wasm');
  assert.equal(wasm.status, 200);
  assert.match(wasm.headers.get('content-type') ?? '', /wasm/);
  assert.equal((await fetch(BASE + '/room/abc')).status, 400);
  assert.equal((await fetch(BASE + '/room/ABCD')).status, 426);
});

test('two drivers race in a room over WebSockets', { skip: !BASE }, async () => {
  const code = 'T' + Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
  const url = BASE.replace(/^http/, 'ws') + '/room/' + code;
  const mk = (name) => {
    const ev = [];
    const r = openRoom({ url, machine: Machine.fromModule(module), name, onEvent: (e, m) => ev.push([e, m]), now: () => performance.now() });
    r.ev = ev;
    return r;
  };
  const a = mk('Host');
  await until('host room message', () => a.client.you === 0);
  const b = mk('Guest');
  await until('guest room message', () => b.client.you === 1 && a.client.players.length === 2);
  assert.equal(a.client.host, 0);
  a.send({ t: 'garbage' });
  a.ws.send('not json');
  a.send({ t: 'start', mode: 0, track: 1, laps: 1, bots: 4 });
  await until('start', () => a.client.racing && b.client.racing);
  assert.equal(a.client.start.humans, 2);
  assert.equal(a.client.start.bots, 4);
  let compared = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    for (const c of [a, b]) { c.client.setInput(1); c.client.update(); }
    await sleep(16);
  }
  for (const c of [a, b]) {
    assert.equal(c.client.desync, null);
    assert.ok(c.client.frame > 40, 'frames applied: ' + c.client.frame);
    for (const n of c.client.myHashes.keys()) if (c.client.roomHashes.has(n)) compared++;
  }
  assert.ok(compared > 0, 'hashes compared with the room');
  a.close();
  b.close();
});

test('the fuel pump answers health', { skip: !BASE || !process.env.MM_PUMP }, async () => {
  const h = await fetch(BASE + '/mpp/health').then((r) => r.json());
  assert.equal(h.chainId > 0, true);
});
