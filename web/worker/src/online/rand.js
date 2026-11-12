// Randomness as nfsu2_util::rand draws it (Node's crypto.randomBytes / randomInt), from the injected Prng's bytes:
// the same calls in the same order, so a Rust build whose OS randomness is the same Prng's bytes gives the same
// numbers (the differential tests: web/server-rs/crates/online/src/tests/difftrace.rs).

const M64 = (1n << 64n) - 1n;

/** n random bytes */
export function randBytes(prng, n) {
  return prng.bytes(n);
}

/** crypto.randomInt(min, max): uniform in min..max-1, a u64 from 8 bytes (little-endian) with Rust's rejection */
export function randInt(prng, min, max) {
  if (!(max > min)) throw new RangeError('randInt: max must be above min');
  const range = BigInt(max - min);
  const zone = M64 - (M64 % range);
  for (let i = 0; i < 64; i++) {
    const b = prng.bytes(8);
    let v = 0n;
    for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(b[j]);
    if (v < zone) return min + Number(v % range);
  }
  throw new Error('randInt: no value in 64 draws');
}

/** lowercase hex of n random bytes */
export function randHex(prng, n) {
  const b = prng.bytes(n);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

