#!/usr/bin/env node
// The switch end to end: the Rust nfsu2-server (web/server-rs, release build) and the Worker under wrangler dev
// (src/index.js: the real Switch Durable Object), both with the Online host and the free-roam hub off and 4 places,
// driven by the same node WebSocket clients through the same seeded scenarios (test/switch/tracegen.js: joins, hellos,
// LAN play, frames and bundles of every kind, resumes, the line, closes).  What each client received is compared:
//
//   - its text messages in order, each client's token and ticket replaced by its name (they are random), and the
//     line's eta (its pace over real time) by N
//   - a close with 1011 from the Worker for one with 1006 from Rust (ws terminate(): no close frame on Workers)
//   - its frames in order, bundles and compact bundles taken apart into the frames the page's game gets
//     (the bundle clock's ticks (50 ms, jittered) and the real network decide which datagrams share a bundle, and
//     where frames fall among the texts: that is timing, not the switch's rules)
//
// Steps that change who is on the switch are 700 ms apart (the peer list's changes go out every 250 ms), the others 40.
// Not driven (no browser API for them): dropping a link without a close, the operator's kick.
//
// node test/e2e/switch.diff.mjs [--seeds 1-6] [--verbose]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genTrace } from '../switch/tracegen.js';
import { unpackAll } from '../../src/switch/compact_test_util.js';
import { Fpred } from '../../src/switch/fpred.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(here, '../..');
const WEB = path.resolve(WORKER, '..');
const RS = path.join(WEB, 'server-rs');
const DIST = path.join(WEB, 'dist');
const VERBOSE = process.argv.includes('--verbose');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

function start(cmd, args, opts, name) {
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  const on = (d) => {
    p.out += d;
    if (VERBOSE) process.stdout.write('[' + name + '] ' + d);
  };
  p.stdout.on('data', on);
  p.stderr.on('data', on);
  return p;
}

async function waitHttp(port, proc, name, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (proc.exitCode !== null) throw new Error(name + ' exited ' + proc.exitCode + '\n' + proc.out);
    const ok = await fetch('http://127.0.0.1:' + port + '/robots.txt').then((r) => r.status === 200).catch(() => false);
    if (ok) return;
    await sleep(250);
  }
  throw new Error(name + ' did not start\n' + proc.out);
}

const BCAST = 0xffffffff;

/** one scenario against one server: what each client received */
async function drive(port, trace) {
  const clients = new Map();
  const order = [];
  const subst = (s) => {
    for (const [id, c] of clients) {
      s = s.split('@TOKEN' + id + '@').join(c.token ?? '').split('@TICKET' + id + '@').join(c.ticket ?? '');
      s = s.split('@VIPN' + id + '@').join(String(c.vip ?? 0)).split('@VIP' + id + '@').join(vipStr(c.vip ?? 0));
    }
    return s;
  };
  for (const st of trace.steps) {
    const c = clients.get(st.id);
    switch (st.op) {
      case 'connect': {
        const q = [st.resume ? 'resume' : '', st.queue ? 'queue' : ''].filter(Boolean).join('&');
        const ws = new WebSocket('ws://127.0.0.1:' + port + '/lan' + (q ? '?' + q : ''));
        ws.binaryType = 'arraybuffer';
        const nc = { id: st.id, ws, texts: [], frames: [], closed: null, vip: 0, token: '', ticket: '', mode: null, dec: { refs: new Map(), fp: new Fpred(), others: new Map() } };
        ws.onmessage = (e) => onMessage(nc, e.data);
        ws.onclose = (e) => (nc.closed = e.code === 1006 ? 1006 : e.code);
        await new Promise((r) => {
          ws.onopen = r;
          ws.onerror = r;
        });
        clients.set(st.id, nc);
        order.push(st.id);
        break;
      }
      case 'text': {
        if (!c || c.ws.readyState !== 1) break;
        const text = subst(st.text);
        try {
          const v = JSON.parse(text);
          if (v && v.t === 'hello' && !c.mode) {
            const on = (k) => v[k] === 1;
            c.mode = { compact: on('compact'), delta: on('compact') && on('delta'), fpred: on('compact') && on('delta') && on('fpred'), ldelta: on('compact') && on('delta') && on('ldelta') };
          }
        } catch {
          /* not JSON */
        }
        c.ws.send(text);
        break;
      }
      case 'binary': {
        if (!c || c.ws.readyState !== 1) break;
        const b = Buffer.from(st.hex, 'hex');
        for (const [off, who] of st.dst ?? []) b.writeUInt32BE((clients.get(who)?.vip ?? 0) >>> 0, off);
        c.ws.send(b);
        break;
      }
      case 'close':
        if (c && c.ws.readyState === 1) c.ws.close(st.code === 1001 ? 4001 : st.code, st.reason);
        break;
      case 'wait':
        await sleep(st.ms);
        continue;
      default:
        break; // drop, expel: not driven
    }
    await sleep(trace.settle_ms);
  }
  await sleep(1500);
  // every client closes, one at a time and the last first (a page in line before the players whose leaving would let
  // it in: closes that crossed would make the line's order a race between the client and the server)
  for (const c of [...clients.values()].reverse()) {
    if (c.ws.readyState !== 1) continue;
    c.ws.close(1000, 'closed');
    await sleep(150);
  }
  await sleep(300);
  return order.map((id) => {
    const c = clients.get(id);
    return { id, texts: normTexts(c.texts, clients), frames: c.frames, closed: c.closed };
  });
}

function vipStr(v) {
  return [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

function onMessage(c, data) {
  if (typeof data === 'string') {
    c.texts.push(data);
    try {
      const v = JSON.parse(data);
      if (v.t === 'welcome') {
        c.vip = v.vip;
        c.token = v.token;
      }
      if (v.t === 'queue' && v.ticket) c.ticket = v.ticket;
    } catch {
      /* not JSON */
    }
    return;
  }
  const b = new Uint8Array(data);
  if (b[0] === 32) {
    let at = 4;
    while (at + 4 <= b.length) {
      const len = (b[at + 2] << 8) | b[at + 3];
      c.frames.push(hex(b.subarray(at + 4, at + 4 + len)));
      at += 4 + len;
    }
  } else if (b[0] === 33) {
    const m = c.mode ?? {};
    for (const f of unpackAll(b, c.vip, m.delta ? c.dec.refs : null, m.fpred ? c.dec.fp : null, m.ldelta ? c.dec.others : null)) c.frames.push(hex(Uint8Array.from(f)));
  } else {
    c.frames.push(hex(b));
  }
}

function normTexts(texts, clients) {
  return texts.map((t) => {
    // the line's eta is its pace over real time (queue.rs pace): timing, not a rule
    t = t.replace(/"eta":[0-9]+/, '"eta":N');
    for (const [id, c] of clients) {
      if (c.token) t = t.split(c.token).join('@TOKEN' + id + '@');
      if (c.ticket) t = t.split(c.ticket).join('@TICKET' + id + '@');
    }
    return t;
  });
}

function compare(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (!x || !y) {
      out.push('client ' + i + ' missing on one side');
      continue;
    }
    for (const k of ['texts', 'frames']) {
      const n = Math.max(x[k].length, y[k].length);
      for (let j = 0; j < n; j++) {
        if (x[k][j] !== y[k][j]) {
          out.push('client ' + x.id + ' ' + k + '[' + j + ']:\n   rust   ' + String(x[k][j]).slice(0, 300) + '\n   worker ' + String(y[k][j]).slice(0, 300));
          break;
        }
      }
    }
    // (ws terminate(): a browser saw 1006, a Worker cannot end a connection without a close frame and sends 1011)
    if (x.closed !== y.closed && !(x.closed === 1006 && y.closed === 1011)) out.push('client ' + x.id + ' closed ' + x.closed + ' vs ' + y.closed);
  }
  return out;
}

async function main() {
  if (spawnSync('cargo', ['--version']).error) {
    log('SKIP: cargo is not installed');
    return 0;
  }
  if (spawnSync('cargo', ['build', '--release', '-q', '-p', 'nfsu2-server'], { cwd: RS, stdio: 'inherit' }).status !== 0) throw new Error('cargo build failed');
  if (!fs.existsSync(path.join(WORKER, 'node_modules/wrangler'))) {
    log('SKIP: npm install in web/worker first (wrangler)');
    return 0;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-switch-diff-'));
  const game = path.join(tmp, 'game');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(game, 'SPEED2.EXE'), 'MZ not the game');
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'nfsu2.wasm'), Buffer.alloc(16));
  const state = path.join(tmp, 'state');
  fs.mkdirSync(state);
  const dist = fs.existsSync(path.join(DIST, 'index.html')) ? DIST : (fs.mkdirSync(path.join(tmp, 'dist')), fs.writeFileSync(path.join(tmp, 'dist/index.html'), '<!doctype html>'), path.join(tmp, 'dist'));
  const [pr, pw] = [await freePort(), await freePort()];
  const rust = start(path.join(RS, 'target/release/nfsu2-server'), ['--data', game, '--dist', dist, '--wasm', path.join(out, 'nfsu2.wasm'), '--state', state,
    '--http-port', String(pr), '--port', '0', '--online', 'off', '--roam-hub', 'off', '--vault-gb', '0', '--max-peers', '4'],
  { env: { ...process.env, NFSU2_COMPRESS_THREADS: '0' } }, 'rust');
  const cfg = path.join(tmp, 'wrangler.jsonc');
  fs.writeFileSync(cfg, JSON.stringify({
    name: 'nfsu2-machines', main: path.join(WORKER, 'src/index.js'), compatibility_date: '2026-11-01',
    durable_objects: { bindings: [{ name: 'SWITCH', class_name: 'Switch' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Switch'] }],
    r2_buckets: [{ binding: 'GAME', bucket_name: 'nfsu2-machines-game' }],
    assets: { directory: dist, binding: 'ASSETS', run_worker_first: true, html_handling: 'none', not_found_handling: 'none' },
    vars: { HOSTS: '', HSTS: 'on', NAMES: 'off', FRIENDS: 'off', ONLINE: 'off', ROAM_HUB: 'off', LAN_OPTIONS: JSON.stringify({ maxPeers: 4 }), ETAG_KEY: '00'.repeat(32), LAN_ID_KEY: '11'.repeat(32) },
  }));
  const wr = start(path.join(WORKER, 'node_modules/.bin/wrangler'), ['dev', '--config', cfg, '--port', String(pw), '--ip', '127.0.0.1', '--persist-to', path.join(tmp, 'wr'),
    '--inspector-port', String(await freePort()), '--show-interactive-dev-session=false', '--log-level', 'warn'], { cwd: tmp, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } }, 'wrangler');
  let bad = 0;
  try {
    await waitHttp(pr, rust, 'the Rust server', 30000);
    await waitHttp(pw, wr, 'wrangler dev', 120000);
    // a first connection to each (wrangler starts the Durable Object on the first): both hand out their first address
    for (const port of [pr, pw]) {
      const w = await drive(port, { settle_ms: 40, steps: [{ op: 'connect', id: 0 }, { op: 'text', id: 0, text: '{"t":"hello","name":"warm"}' }, { op: 'wait', ms: 500 }] });
      if (VERBOSE) log('warm-up ' + port + ': ' + JSON.stringify(w));
    }
    const [a, b] = (arg('--seeds', '1-6')).split('-').map(Number);
    for (let s = a; s <= (b ?? a); s++) {
      const trace = genTrace(s, { long: 700, settle: 40, steps: 40 });
      // the two servers one after the other, each with its own switch state from the trace before: a fresh switch for
      // each would need restarts; instead every scenario ends with every client closed ("closed": no reservations)
      const [x, y] = [await drive(pr, trace), await drive(pw, trace)];
      const d = compare(x, y);
      if (VERBOSE) for (const [side, v] of [['rust', x], ['worker', y]]) for (const c of v) log(side + ' client ' + c.id + ': ' + c.texts.map((t) => t.slice(0, 70)).join(' | ') + ' closed ' + c.closed);
      const n = x.reduce((k, c) => k + c.texts.length + c.frames.length, 0);
      if (d.length) {
        bad++;
        log('seed ' + s + ': ' + d.length + ' differences (of ' + n + ' messages)\n  ' + d.slice(0, 5).join('\n  '));
      } else log('seed ' + s + ': same (' + n + ' messages, ' + x.length + ' clients)');
      await sleep(1000);
    }
  } finally {
    rust.kill();
    wr.kill();
  }
  log(bad ? 'FAIL: ' + bad + ' scenarios differ' : 'PASS');
  return bad ? 1 : 0;
}

main().then((c) => process.exit(c), (e) => {
  console.error(e);
  process.exit(2);
});

