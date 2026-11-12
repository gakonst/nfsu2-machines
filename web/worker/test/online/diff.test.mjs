// Differential tests: the same traces (gen.mjs: scenarios and seeded random sessions) into the Rust crate
// (web/server-rs/crates/online, its tests/difftrace.rs, built with the JS Prng's bytes as its OS randomness) and into
// the JS port (harness.mjs); every frame the host sends, every console line and error, the counts and the stored
// files must be the same.  Needs cargo (skipped without it); the first build takes a minute or two.
//   DIFF_SEEDS=500 node --test test/online/diff.test.mjs     (default 150 random sessions)
//   DIFF_ONLY=<seed or scenario name>                        (one trace, its first difference in full)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrace, loadClaims, unhex } from './harness.mjs';
import { rustRun } from './rust.mjs';
import { scenarios, randomTrace } from './gen.mjs';
import { FrameReader, parseFields } from '../../src/online/aries.js';

/** a frame as text, for a difference's report: its kind, TCP op and port, and its lobby messages */
function show(hex) {
  const f = unhex(hex);
  const s = 'kind ' + f[0] + ' op ' + f[16] + ' ports ' + ((f[12] << 8) | f[13]) + '->' + ((f[14] << 8) | f[15]);
  if (f[0] !== 4 || f[16] !== 4) return s;
  const r = new FrameReader(1 << 20);
  const ms = r.push(f.subarray(24)).map((m) => m.kind + (m.code ? '/' + m.code : '') + ' ' + parseFields(m.body, () => false).map(([k, v]) => k + '=' + v).join(' '));
  return s + ' ' + (ms.join(' | ') || '(part of a message: ' + Buffer.from(f.subarray(24)).toString('latin1').slice(0, 120) + ')');
}

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

/** the first difference of two runs of one trace, as text, or null */
export function firstDiff(tr, rust, js) {
  if (!Array.isArray(rust)) return 'the Rust run failed: ' + JSON.stringify(rust);
  for (let i = 0; i < Math.max(rust.length, js.length); i++) {
    const a = rust[i], b = js[i];
    const step = i === 0 ? '(start)' : JSON.stringify(tr.steps[i - 1]).slice(0, 300);
    if (!a || !b) return 'step ' + i + ' ' + step + ': only one side has it';
    for (const k of ['sent', 'log', 'err', 'mail']) {
      const x = a[k] || [], y = b[k] || [];
      for (let j = 0; j < Math.max(x.length, y.length); j++) {
        if (JSON.stringify(x[j]) !== JSON.stringify(y[j])) {
          const fmt = (e) => (e === undefined ? '(none)' : k === 'sent' ? e[0] + (e[2] ? ' refused ' : ' ') + show(e[1]) : JSON.stringify(e));
          return 'step ' + i + ' ' + step + '\n  ' + k + '[' + j + ']\n  rust: ' + fmt(x[j]) + '\n  js:   ' + fmt(y[j]);
        }
      }
    }
    if (canon(a.x ?? null) !== canon(b.x ?? null)) {
      const ax = a.x || {}, bx = b.x || {};
      for (const key of new Set([...Object.keys(ax), ...Object.keys(bx)])) {
        if (canon(ax[key]) !== canon(bx[key])) return 'step ' + i + ' ' + step + '\n  x.' + key + '\n  rust: ' + canon(ax[key]) + '\n  js:   ' + canon(bx[key]);
      }
    }
  }
  return null;
}

test('the JS Online host sends, logs and stores what the Rust one does', async (t) => {
  await loadClaims();
  const n = Number(process.env.DIFF_SEEDS ?? 150);
  let all = scenarios().map(([name, tr]) => [name, tr]);
  for (let s = 1; s <= n; s++) all.push(['seed ' + s, randomTrace(s)]);
  if (process.env.DIFF_ONLY) all = all.filter(([name]) => name === process.env.DIFF_ONLY || name === 'seed ' + process.env.DIFF_ONLY);
  const rust = rustRun(all.map((x) => x[1]));
  if (rust === null) return t.skip('no cargo/rustc on this machine');
  const bad = [];
  let frames = 0, steps = 0;
  for (let i = 0; i < all.length; i++) {
    const [name, tr] = all[i];
    let js;
    try {
      js = runTrace(tr);
    } catch (e) {
      bad.push(name + ': the JS run threw ' + (e.stack || e));
      continue;
    }
    for (const s of js) frames += s.sent.length;
    steps += tr.steps.length;
    const d = firstDiff(tr, rust[i], js);
    if (d) bad.push(name + ': ' + d);
  }
  t.diagnostic(all.length + ' traces, ' + steps + ' steps, ' + frames + ' frames compared; ' + bad.length + ' differ');
  assert.equal(bad.length, 0, bad.slice(0, 5).join('\n\n'));
});


