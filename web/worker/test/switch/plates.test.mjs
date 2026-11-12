// web/worker/src/switch/plates.js: the Rust tests of lan/src/plates.rs, and differential tests against it (the
// test-only example web/server-rs/crates/lan/examples/difftrace_text.rs), live and from the fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EVERY_MS, MAX, Seen, helloPlate, intact, judge, ok, rewrite } from '../../src/switch/plates.js';
import { compare, frame, judgeCases, plateCases, textFixture } from './text-cases.mjs';
import { runRust } from '../names/rust.mjs';

const HF_CREW = 0x0200, HF_PLATE = 0x8000;
const enc = s => new TextEncoder().encode(s);
const u16 = (b, i) => b[i] | (b[i + 1] << 8);

test('constants', () => {
  assert.equal(EVERY_MS, 10000);
  assert.equal(MAX, 8);
  assert.ok(ok(enc('AB12')) && !ok(enc('ab')) && !ok(enc('123456789')) && ok(new Uint8Array(0)));
});

// plates.rs capitals_and_digits_are_a_plate_anything_else_is_broken
test('capitals and digits are a plate, anything else is broken', () => {
  for (const p of ['A', 'AB123456', '0', 'ZZZZZZZZ']) {
    const f = helloPlate(frame(enc(p), HF_CREW | HF_PLATE));
    assert.equal(f.kind, 'plate', p);
    assert.deepEqual(f.plate, enc(p));
    assert.deepEqual(f.name, enc('Ann'));
  }
  for (const p of ['', '123456789', 'lower', 'A B', 'A\0B', 'A-B', '\u{c9}']) {
    assert.deepEqual(helloPlate(frame(enc(p), HF_CREW | HF_PLATE)), { kind: 'broken' }, JSON.stringify(p));
  }
  assert.equal(helloPlate(frame(new Uint8Array(0), HF_CREW)), null);
  assert.deepEqual(helloPlate(frame(enc('AB12'), HF_PLATE)), { kind: 'broken' });
});

// plates.rs a_hello_cut_short_is_broken
test('a HELLO cut short is broken', () => {
  const f = frame(enc('ABCDEFGH'), HF_CREW | HF_PLATE);
  for (let n = 16 + 29 + 4; n < f.length; n++) {
    const p = helloPlate(f.subarray(0, n));
    assert.ok(!(p && p.kind === 'plate' && new TextDecoder().decode(p.plate) === 'ABCDEFGH'), String(n));
  }
});

// plates.rs a_rewritten_hello_is_the_one_a_game_would_send_with_that_plate_or_none
test('a rewritten HELLO is the one a game would send with that plate, or none', () => {
  const f = frame(enc('N1GGER'), HF_CREW | HF_PLATE);
  const p = helloPlate(f);
  assert.equal(p.kind, 'plate');
  assert.deepEqual(rewrite(f, p.at, enc('OLD1')), frame(enc('OLD1'), HF_CREW | HF_PLATE));
  const none = rewrite(f, p.at, null);
  assert.deepEqual(none, frame(new Uint8Array(0), HF_CREW));
  assert.equal(helloPlate(none), null, 'no plate HELLO any more');
  const b = frame(enc('A B'), HF_CREW | HF_PLATE);
  const r = rewrite(b, null, null);
  assert.equal(u16(r, 16 + 14), HF_CREW);
  assert.equal(r.length, b.length);
  assert.equal(helloPlate(r), null);
  const bad = Uint8Array.from(f);
  bad[bad.length - 1] ^= 1;
  assert.equal(rewrite(bad, p.at, null), null);
  assert.equal(rewrite(f.subarray(0, f.length - 1), p.at, null), null);
  assert.ok(intact(f) && !intact(bad));
});

// plates.rs slurs_are_taken_out_and_told_once_changes_wait_ten_seconds
test('slurs are taken out and told once, changes wait ten seconds', () => {
  const seen = new Seen();
  assert.deepEqual(judge(seen, enc('N1GGER'), 0), { kind: 'slur', tell: true });
  assert.deepEqual(judge(seen, enc('N1GGER'), 100), { kind: 'slur', tell: false });
  assert.deepEqual(judge(seen, enc('1488'), 200), { kind: 'slur', tell: true });
  assert.deepEqual(judge(seen, enc('BIGFAG'), 200), { kind: 'slur', tell: true });
  assert.deepEqual(judge(seen, enc('HH88'), 200), { kind: 'slur', tell: true });
  assert.deepEqual(judge(seen, enc('ABC123'), 300), { kind: 'new' });
  assert.deepEqual(judge(seen, enc('ABC123'), 400), { kind: 'go' });
  assert.deepEqual(judge(seen, enc('XYZ9'), 300 + EVERY_MS - 1), { kind: 'last', last: enc('ABC123') });
  assert.deepEqual(judge(seen, enc('ABC123'), 300 + EVERY_MS - 1), { kind: 'go' });
  assert.deepEqual(judge(seen, enc('XYZ9'), 300 + EVERY_MS), { kind: 'new' });
});

test('the same answers as the Rust: fixture (web/worker/test/fixtures/text-rust.json)', t => {
  const f = textFixture();
  t.diagnostic(compare(f.inputs, f.outputs, ['plate', 'judge']) + ' requests');
});

test('the same answers as the Rust: live (frames of seeds 3, 102, 202; judge sequences of seeds 4, 103, 203)', t => {
  const qs = [];
  for (const seed of [1, 100, 200]) qs.push(...plateCases(seed + 2, 5000), ...judgeCases(seed + 3, 1500));
  const r = runRust('nfsu2-lan', 'difftrace_text', qs.map(q => JSON.stringify(q)));
  if (r.skip) return t.skip('no Rust: ' + r.skip);
  t.diagnostic(compare(qs, r.out, ['plate', 'judge']) + ' requests: the same answers');
});

