// web/worker/src/util/sha256.js against node:crypto's SHA-256: the FIPS 180-4 vectors, every length 0-1100 and
// random inputs (seeded) up to 70 KB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256 } from '../../src/util/sha256.js';
import { Prng } from '../../src/util/prng.js';

const hex = b => Buffer.from(b).toString('hex');
const ref = b => createHash('sha256').update(b).digest('hex');

test('the FIPS 180-4 examples', () => {
  const e = s => new TextEncoder().encode(s);
  assert.equal(hex(sha256(e('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hex(sha256(e(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256(e('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(hex(sha256(new Uint8Array(1000000).fill(0x61))), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('every length from 0 to 1100 bytes, and random inputs (seeds 1-3), as node:crypto', () => {
  for (const seed of [1, 2, 3]) {
    const prng = new Prng(seed);
    for (let n = 0; n <= 1100; n++) {
      const b = prng.bytes(n);
      assert.equal(hex(sha256(b)), ref(b), 'seed ' + seed + ' length ' + n);
    }
    for (let k = 0; k < 50; k++) {
      const b = prng.bytes(prng.below(70000));
      assert.equal(hex(sha256(b)), ref(b));
    }
  }
  assert.equal(sha256(new Uint8Array(0)).length, 32);
  assert.throws(() => sha256('abc'), TypeError);
});

