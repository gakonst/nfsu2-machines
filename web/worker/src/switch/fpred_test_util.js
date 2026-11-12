// The tests' made-up car states: a port of fpred.rs tests::body.

import { layout } from './fpred.js';

const F32 = new Float32Array(1);
const F32B = new Uint8Array(F32.buffer);

/** fpred.rs tests::body: a SNAP's body (the datagram from its sender's id on, without the CRC) as roam_core.c rc_encode
 *  makes it: one state, with an extension of x bytes when x is not null (its fields from k, so that each state differs).
 *  p and v: three numbers each, written as f32 (pass values already rounded to f32 where the Rust computes in f32). */
export function body(sender, seq, t, p, v, k, x) {
  const b = [];
  const u16 = (n) => b.push(n & 0xFF, (n >>> 8) & 0xFF);
  const u32 = (n) => b.push(n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF);
  const f32 = (f) => {
    F32[0] = f;
    b.push(F32B[0], F32B[1], F32B[2], F32B[3]);
  };
  u32(sender >>> 0);
  u16(seq);
  u16((x != null ? 0x0040 : 0) | 0x0020);
  b.push(2, 7);
  u16(0x0102);
  b.push(1, 3);
  u32(t >>> 0);
  for (const f of p) f32(f);
  for (const f of v) f32(f);
  for (const q of [100 + k, -200, 30000 - k, 5]) u16(q);
  for (const w of [k * 3, -k, 7]) u16(w);
  u16(k * 101);
  b.push(200, (k % 3) & 0xFF);
  u16(3000 + 7 * k);
  u16(1500 + k);
  b.push(4, 0x10);
  if (x != null) {
    b.push(x);
    if (x > 0) {
      for (let i = 0; i < 4; i++) u16(-300 + k + i);
      b.push(0);
      const g = layout(x);
      if (g < 0) throw new Error('body: a layout');
      if (g & 1) b.push(1, 2);
      if (g & 2) for (let i = 0; i < 12; i++) b.push((i * 9 + k) & 0xFF);
      if (g & 4) {
        u16(4000 + k);
        b.push(10, 20, 30);
      }
    }
  }
  return Uint8Array.from(b);
}
