// Differential test of the switch's timing modules against the Rust code: the seeded cases of timing-cases.mjs go to
// web/server-rs/crates/lan-diff-timing (lag.rs, away.rs, paths.rs, impair.rs, store.rs, text.rs to_number and
// util/bucket.rs, unchanged, included by #[path]; members.rs store_list copied) and to the JavaScript port, and every
// output must be equal (floats bit for bit).
//
// With cargo: built and run here (TIMING_DIFF_SEEDS=n seeds, 300 by default; TIMING_DIFF_FIRST the first).  Without
// it: skipped with a note, and the checked-in fixture (test/fixtures/lan-timing-diff.json, Rust's answers to a few
// seeds) is compared instead.  TIMING_DIFF_WRITE_FIXTURE=1 rewrites the fixture from a cargo run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeCases, runJs } from './timing-cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '../../../server-rs');
const FIXTURE = join(here, '../fixtures/lan-timing-diff.json');

/** the Rust answers to cases, or null (with why) when cargo is not there */
function rust(cases) {
  const input = cases.map((c) => JSON.stringify(c)).join('\n') + '\n';
  const r = spawnSync('cargo', ['run', '--release', '-q', '-p', 'lan-diff-timing'], {
    cwd: SERVER, input, maxBuffer: 1 << 30, encoding: 'utf8', timeout: 30 * 60 * 1000,
  });
  if (r.error && r.error.code === 'ENOENT') return { skip: 'cargo is not installed: the Rust side is skipped (the fixture still runs)' };
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('lan-diff-timing failed (' + r.status + '):\n' + r.stderr.slice(-4000));
  const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(out.length, cases.length, 'one answer a case');
  return { out };
}

/** each case's JS answer against Rust's; the first differences in full */
function compare(cases, expected) {
  const kinds = new Map();
  const bad = [];
  cases.forEach((c, i) => {
    const got = runJs(c, expected[i]);
    kinds.set(c.k, (kinds.get(c.k) ?? 0) + 1);
    try {
      assert.deepStrictEqual(got, expected[i]);
    } catch (e) {
      bad.push({ i, k: c.k, msg: e.message.slice(0, 3000), c: JSON.stringify(c).slice(0, 2000) });
    }
  });
  if (bad.length) {
    assert.fail(bad.length + ' of ' + cases.length + ' cases differ; first:\n' +
      bad.slice(0, 3).map((b) => '#' + b.i + ' ' + b.k + '\n' + b.c + '\n' + b.msg).join('\n----\n'));
  }
  return [...kinds].map(([k, n]) => k + ' ' + n).join(', ');
}

test('timing modules: JS port == Rust on seeded cases (cargo)', { timeout: 40 * 60 * 1000 }, (t) => {
  const first = Number(process.env.TIMING_DIFF_FIRST ?? 1);
  const n = Number(process.env.TIMING_DIFF_SEEDS ?? 300);
  const cases = makeCases(first, n, true);
  const r = rust(cases);
  if (r.skip) return t.skip(r.skip);
  const kinds = compare(cases, r.out);
  t.diagnostic('seeds ' + first + '..' + (first + n - 1) + ': ' + cases.length + ' cases equal (' + kinds + ')');
  if (process.env.TIMING_DIFF_WRITE_FIXTURE === '1') {
    const fc = makeCases(1, 3, false);
    const fr = rust(fc);
    writeFileSync(FIXTURE, JSON.stringify({ note: 'Rust answers (web/server-rs/crates/lan-diff-timing) to timing-cases.mjs makeCases(1, 3, false); rewrite: TIMING_DIFF_WRITE_FIXTURE=1 node --test test/switch/timing-diff.test.mjs', cases: fc, out: fr.out }) + '\n');
    t.diagnostic('fixture written: ' + FIXTURE);
  }
});

test('timing modules: JS port == the checked-in Rust answers (fixture, no cargo needed)', (t) => {
  const f = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  // the generator still makes the fixture's cases (else the fixture is stale: rewrite it)
  assert.deepStrictEqual(makeCases(1, 3, false), f.cases, 'timing-cases.mjs changed: rewrite the fixture');
  const kinds = compare(f.cases, f.out);
  t.diagnostic(f.cases.length + ' fixture cases equal (' + kinds + ')');
});
