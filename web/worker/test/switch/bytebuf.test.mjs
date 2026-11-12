// ByteBuf: Vec<u8> as an output buffer (src/switch/bytebuf.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteBuf } from '../../src/switch/bytebuf.js';

test('ByteBuf grows, writes big- and little-endian, truncates, drains', () => {
  const b = new ByteBuf(1);
  for (let i = 0; i < 300; i++) b.push(i);
  assert.equal(b.len, 300);
  assert.equal(b.bytes()[299], 299 & 255);
  b.clear();
  b.u16(0x1234);
  b.u32(0xDEADBEEF);
  b.u16le(0x1234);
  b.u32le(0xDEADBEEF);
  b.zeros(2);
  b.pushBytes(Uint8Array.of(9, 8));
  assert.deepEqual(Array.from(b.bytes()), [0x12, 0x34, 0xDE, 0xAD, 0xBE, 0xEF, 0x34, 0x12, 0xEF, 0xBE, 0xAD, 0xDE, 0, 0, 9, 8]);
  b.setU16(12, 0xABCD);
  assert.deepEqual(Array.from(b.view(12)), [0xAB, 0xCD, 9, 8]);
  b.truncate(100);
  assert.equal(b.len, 16, 'a longer truncate changes nothing');
  b.drain(2, 12);
  assert.deepEqual(Array.from(b.bytes()), [0x12, 0x34, 0xAB, 0xCD, 9, 8]);
  const copy = b.toBytes();
  b.truncate(1);
  assert.equal(copy.length, 6);
  assert.throws(() => b.setU16(0, 1));
  assert.throws(() => b.view(0, 5));
});
