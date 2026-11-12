// The switch's differential test against the Rust crate: seeded traces (tracegen.js) replayed into the Rust LanSwitch
// (crates/lan/tests/difftrace_switch.rs, one process per trace: its mono clock starts with the switch, as the
// server's does) and into the JS switch (replay.js), every message each fake browser received compared byte for byte,
// with the counts of info().  Normalised: each client's random token and ticket (the welcome's, the queue's) replaced
// by its name.  Without cargo's build of the test, the outputs kept in test/fixtures/switch-difftrace.json are used.
//
//   node --test test/switch/difftrace.test.mjs              (DIFFTRACE_SEEDS=1-40 by default)
//   DIFFTRACE_SEEDS=1-200 DIFFTRACE_UPDATE=1 node --test test/switch/difftrace.test.mjs   (rewrites the fixture)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { genTrace } from './tracegen.js';
import { replayJs, normalise } from './replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rsDir = path.resolve(here, '../../../server-rs');
const fixture = path.resolve(here, '../fixtures/switch-difftrace.json');

function seeds() {
  const s = process.env.DIFFTRACE_SEEDS ?? '1-40';
  const out = [];
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let i = a; i <= (b ?? a); i++) out.push(i);
  }
  return out;
}

/** the Rust test's executable, built if cargo is there; null without */
function rustBinary() {
  if (process.env.DIFFTRACE_NO_RUST) return null;
  try {
    const j = execFileSync('cargo', ['test', '--release', '-p', 'nfsu2-lan', '--test', 'difftrace_switch', '--no-run', '--message-format=json'],
      { cwd: rsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
    for (const line of j.split('\n')) {
      if (!line.includes('"executable"')) continue;
      const m = JSON.parse(line);
      if (m.executable && m.target?.name === 'difftrace_switch') return m.executable;
    }
  } catch {
    return null;
  }
  return null;
}

function runRust(bin, trace) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'difftrace-'));
  const inp = path.join(dir, 'in.json'), out = path.join(dir, 'out.json');
  fs.writeFileSync(inp, JSON.stringify(trace));
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['--exact', 'difftrace_switch', '--quiet'], { env: { ...process.env, DIFFTRACE_IN: inp, DIFFTRACE_OUT: out }, stdio: 'ignore' });
    p.on('exit', (code) => {
      if (code !== 0) return reject(new Error('rust difftrace exited ' + code));
      const v = JSON.parse(fs.readFileSync(out, 'utf8'));
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(v);
    });
  });
}

async function pool(items, n, f) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i], i);
    }
  }));
  return out;
}

/** the first difference between two normalised outputs, or null */
export function firstDiff(a, b) {
  if (a.clients.length !== b.clients.length) return 'clients ' + a.clients.length + ' vs ' + b.clients.length;
  for (let c = 0; c < a.clients.length; c++) {
    const x = a.clients[c], y = b.clients[c];
    const n = Math.max(x.msgs.length, y.msgs.length);
    for (let k = 0; k < n; k++) {
      const p = JSON.stringify(x.msgs[k]), q = JSON.stringify(y.msgs[k]);
      if (p !== q) return 'client ' + x.id + ' message ' + k + ':\n  js   ' + p + '\n  rust ' + q;
    }
    if (x.ended !== y.ended) return 'client ' + x.id + ' ended ' + x.ended + ' vs ' + y.ended;
  }
  for (const k of new Set([...Object.keys(a.info), ...Object.keys(b.info)])) {
    if (JSON.stringify(a.info[k]) !== JSON.stringify(b.info[k])) return 'info.' + k + ': ' + JSON.stringify(a.info[k]) + ' vs ' + JSON.stringify(b.info[k]);
  }
  if (a.reserved !== b.reserved) return 'reserved ' + a.reserved + ' vs ' + b.reserved;
  return null;
}

test('the JS switch sends what the Rust switch sends, trace for trace', { timeout: 30 * 60_000 }, async () => {
  const list = seeds();
  const bin = rustBinary();
  let rust;
  let traces;
  if (bin) {
    traces = list.map((s) => genTrace(s));
    rust = await pool(traces, Math.max(2, Math.min(8, os.cpus().length)), (t) => runRust(bin, t));
    if (process.env.DIFFTRACE_UPDATE) {
      fs.mkdirSync(path.dirname(fixture), { recursive: true });
      fs.writeFileSync(fixture, JSON.stringify({ traces, rust }));
    }
  } else {
    const f = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    traces = f.traces;
    rust = f.rust;
    console.log('# no cargo build of difftrace_switch: comparing with the ' + traces.length + ' kept Rust outputs');
  }
  const bad = [];
  let msgs = 0;
  for (let i = 0; i < traces.length; i++) {
    const js = normalise(replayJs(traces[i]));
    const rs = normalise(rust[i]);
    msgs += rs.clients.reduce((n, c) => n + c.msgs.length, 0);
    const d = firstDiff(js, rs);
    if (d) bad.push('seed ' + traces[i].seed + ': ' + d);
  }
  console.log('# ' + traces.length + ' traces, ' + msgs + ' messages compared, ' + bad.length + ' differ');
  assert.deepEqual(bad, []);
});

