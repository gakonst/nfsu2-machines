// The switch's rules differential against the Rust crate: seeded traces (rules_tracegen.js) of what the ported tests
// exercise at a connection's edges (the server's hello-time bans, keyphrase owners, race bans, blocks and names handed to
// the hub, frames to the Online host and the hub, the operator's kick and race ban) replayed into the Rust LanSwitch
// (crates/lan/tests/difftrace_rules.rs) and into the JS switch (rules_replay.js): every message each fake browser got,
// every call the switch made of its hosts (in order), every frame its tap saw, info() and the peer view, compared
// exactly (each client's random token and ticket replaced by its name).  Without cargo the outputs kept in
// test/fixtures/switch-rules-rust.json are used.
//
//   node --test test/switch/rules_diff.test.mjs                 (RULES_SEEDS=1-40 by default)
//   RULES_SEEDS=1-200 node --test test/switch/rules_diff.test.mjs     (more seeds; checked: 1-200 differ in nothing)
//   RULES_SEEDS=1-12 RULES_UPDATE=1 node --test test/switch/rules_diff.test.mjs   (rewrites the fixture: seeds 1-12)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { genRulesTrace } from './rules_tracegen.js';
import { replayRules } from './rules_replay.js';
import { normalise } from './replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rsDir = path.resolve(here, '../../../server-rs');
const fixture = path.resolve(here, '../fixtures/switch-rules-rust.json');

function seeds() {
  const s = process.env.RULES_SEEDS ?? '1-40';
  const out = [];
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let i = a; i <= (b ?? a); i++) out.push(i);
  }
  return out;
}

function rustBinary() {
  if (process.env.DIFFTRACE_NO_RUST) return null;
  try {
    const j = execFileSync('cargo', ['test', '--release', '-p', 'nfsu2-lan', '--test', 'difftrace_rules', '--no-run', '--message-format=json'],
      { cwd: rsDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
    for (const line of j.split('\n')) {
      if (!line.includes('"executable"')) continue;
      const m = JSON.parse(line);
      if (m.executable && m.target?.name === 'difftrace_rules') return m.executable;
    }
  } catch {
    return null;
  }
  return null;
}

function runRust(bin, trace) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulesdiff-'));
  const inp = path.join(dir, 'in.json'), out = path.join(dir, 'out.json');
  fs.writeFileSync(inp, JSON.stringify(trace));
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['--exact', 'difftrace_rules', '--quiet'], { env: { ...process.env, DIFFTRACE_RULES_IN: inp, DIFFTRACE_RULES_OUT: out }, stdio: 'ignore' });
    p.on('exit', (code) => {
      if (code !== 0) return reject(new Error('rust difftrace_rules exited ' + code));
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

/** a normalised output's tokens in its host events and tap too (they never carry one; kept for the shape) */
function norm(out) {
  const o = normalise(out);
  o.hosts = out.hosts;
  o.tap = out.tap;
  o.peers = out.peers;
  return o;
}

function firstDiff(a, b) {
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
  for (const k of ['hosts', 'tap', 'peers']) {
    const n = Math.max(a[k].length, b[k].length);
    for (let i = 0; i < n; i++) {
      const p = JSON.stringify(a[k][i]), q = JSON.stringify(b[k][i]);
      if (p !== q) return k + '[' + i + ']:\n  js   ' + p + '\n  rust ' + q;
    }
  }
  for (const k of new Set([...Object.keys(a.info), ...Object.keys(b.info)])) {
    if (JSON.stringify(a.info[k]) !== JSON.stringify(b.info[k])) return 'info.' + k + ': ' + JSON.stringify(a.info[k]) + ' vs ' + JSON.stringify(b.info[k]);
  }
  if (a.reserved !== b.reserved) return 'reserved ' + a.reserved + ' vs ' + b.reserved;
  return null;
}

test('the JS switch treats hellos, bans, blocks and hosts as the Rust switch does, trace for trace', { timeout: 30 * 60_000 }, async () => {
  const list = seeds();
  const bin = rustBinary();
  let rust, traces;
  if (bin) {
    traces = list.map((s) => genRulesTrace(s));
    rust = await pool(traces, Math.max(2, Math.min(8, os.cpus().length)), (t) => runRust(bin, t));
    if (process.env.RULES_UPDATE) {
      fs.mkdirSync(path.dirname(fixture), { recursive: true });
      fs.writeFileSync(fixture, JSON.stringify({ traces, rust }));
    }
  } else {
    const f = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    traces = f.traces;
    rust = f.rust;
    console.log('# no cargo build of difftrace_rules: comparing with the ' + traces.length + ' kept Rust outputs');
  }
  const bad = [];
  let msgs = 0, hostEvents = 0, taps = 0;
  for (let i = 0; i < traces.length; i++) {
    const js = norm(replayRules(traces[i]));
    const rs = norm(rust[i]);
    msgs += rs.clients.reduce((n, c) => n + c.msgs.length, 0);
    hostEvents += rs.hosts.length;
    taps += rs.tap.length;
    const d = firstDiff(js, rs);
    if (d) bad.push('seed ' + traces[i].seed + ': ' + d);
  }
  console.log('# ' + traces.length + ' traces: ' + msgs + ' messages, ' + hostEvents + ' host calls, ' + taps + ' tapped frames compared; ' + bad.length + ' differ');
  assert.deepEqual(bad, []);
});
