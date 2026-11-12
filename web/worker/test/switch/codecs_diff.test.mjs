// Differential tests of the switch's datagram codecs: the same seeded queries (codecs_diff_gen.mjs) through the Rust code
// (web/server-rs/crates/lan/src/compact.rs, fpred.rs, mix.rs, driven by the test-only crate crates/lan-diff-codecs) and
// through the JS port (src/switch/compact.js, fpred.js, mix.js, compact_test_util.js), compared exactly.
//
// - with cargo: the full run (~12,800 queries: frames, streams of entries with Refs and Fpred carried across bundles in
//   all 8 modes, car states through fields/rounded/encode/decode, any fields through encode/write, broken entries
//   through decode, mix's kinds and lines, Rust's float formatting); CODECS_DIFF_NO_CARGO=1 skips it
// - always: the checked-in fixture of Rust's answers (test/fixtures/codecs-rust.json), a smaller run of the same; write
//   it again with CODECS_WRITE_FIXTURE=1 (needs cargo)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { allQueries, answer } from './codecs_diff_gen.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '..', '..', '..', 'server-rs');
const FIXTURE = join(here, '..', 'fixtures', 'codecs-rust.json');

function haveCargo() {
  if (process.env.CODECS_DIFF_NO_CARGO) return false;
  if (!existsSync(join(SERVER, 'crates', 'lan-diff-codecs', 'Cargo.toml'))) return false;
  const r = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

/** the Rust driver's answers to qs, one each */
function rustAnswers(qs) {
  const dir = mkdtempSync(join(tmpdir(), 'codecs-diff-'));
  try {
    const inp = join(dir, 'in.jsonl'), out = join(dir, 'out.jsonl');
    writeFileSync(inp, qs.map((q) => JSON.stringify(q)).join('\n') + '\n');
    const r = spawnSync(
      'cargo',
      ['test', '--release', '-q', '-p', 'nfsu2-lan-diff-codecs', '--lib', '--', '--ignored', '--exact', 'difftrace::difftrace'],
      { cwd: SERVER, env: { ...process.env, DIFFTRACE_IN: inp, DIFFTRACE_OUT: out }, encoding: 'utf8', maxBuffer: 1 << 26 },
    );
    if (r.status !== 0) throw new Error('the Rust driver failed (' + r.status + '):\n' + r.stdout + r.stderr);
    const lines = readFileSync(out, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, qs.length, 'an answer for each query');
    return lines.map((l) => JSON.parse(l));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** each query's JS answer against Rust's: the first difference, located */
function compare(qs, want) {
  const byOp = {};
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const got = JSON.parse(JSON.stringify(answer(q)));
    byOp[q.op] = (byOp[q.op] ?? 0) + (Array.isArray(want[i]) && q.op !== 'names' ? want[i].length : q.op === 'stream' ? q.frames.length : 1);
    if (q.op === 'stream') {
      for (const k of ['entries', 'kinds', 'unpacked']) {
        const a = got[k], b = want[i][k];
        assert.equal(a.length, b.length, 'stream ' + i + ' ' + k + ': as many');
        for (let j = 0; j < b.length; j++) assert.deepEqual(a[j], b[j], 'query ' + i + ' (stream, refs ' + q.refs + ' fp ' + q.fp + ' others ' + q.others + ') ' + k + ' ' + j + (k === 'entries' ? ' frame ' + q.frames[j][0] : ''));
      }
    } else if (Array.isArray(want[i]) && q.op !== 'names') {
      assert.equal(got.length, want[i].length);
      for (let j = 0; j < want[i].length; j++) assert.deepEqual(got[j], want[i][j], 'query ' + i + ' (' + q.op + ') item ' + j + ': ' + JSON.stringify(q[Object.keys(q)[1]][j]).slice(0, 400));
    } else {
      assert.deepEqual(got, want[i], 'query ' + i + ': ' + JSON.stringify(q).slice(0, 600));
    }
  }
  return byOp;
}

test('the JS codecs answer as the Rust ones (live, through cargo)', { skip: haveCargo() ? false : 'cargo or web/server-rs/crates/lan-diff-codecs not here (or CODECS_DIFF_NO_CARGO): the fixture test still runs' }, (t) => {
  const { qs } = allQueries(true);
  const want = rustAnswers(qs);
  const byOp = compare(qs, want);
  t.diagnostic('compared: ' + JSON.stringify(byOp));
  if (process.env.CODECS_WRITE_FIXTURE) {
    const small = allQueries(false).qs;
    const ans = rustAnswers(small);
    writeFileSync(FIXTURE, JSON.stringify({ about: 'Rust answers (web/server-rs/crates/lan-diff-codecs) to codecs_diff_gen.mjs allQueries(false): written by CODECS_WRITE_FIXTURE=1 node --test test/switch/codecs_diff.test.mjs', cases: small.map((q, i) => ({ q, a: ans[i] })) }) + '\n');
    t.diagnostic('wrote ' + FIXTURE);
  }
});

test('the JS codecs answer as the Rust ones (the checked-in fixture)', (t) => {
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const qs = fx.cases.map((c) => c.q), want = fx.cases.map((c) => c.a);
  assert.ok(qs.length > 100);
  const byOp = compare(qs, want);
  t.diagnostic('compared: ' + JSON.stringify(byOp));
});
