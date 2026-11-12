// A seeded PRNG for the sans-IO cores: xoshiro128** seeded through splitmix64.  No hidden randomness: every core
// that needs random numbers takes one of these (production seeds it from crypto.getRandomValues once, at the edge).

const M64 = (1n << 64n) - 1n;

/** splitmix64 step on a BigInt state: [next state, output] */
function splitmix(s) {
  s = (s + 0x9E3779B97F4A7C15n) & M64;
  let z = s;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M64;
  return [s, z ^ (z >> 31n)];
}

const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;

export class Prng {
  /** @param {bigint|number} seed */
  constructor(seed) {
    let s = BigInt.asUintN(64, typeof seed === 'bigint' ? seed : BigInt(Math.trunc(seed)));
    const st = new Uint32Array(4);
    for (let i = 0; i < 2; i++) {
      let z;
      [s, z] = splitmix(s);
      st[2 * i] = Number(z & 0xFFFFFFFFn);
      st[2 * i + 1] = Number(z >> 32n);
    }
    if ((st[0] | st[1] | st[2] | st[3]) === 0) st[0] = 1;
    this.s = st;
  }

  /** a uniform u32 */
  next32() {
    const s = this.s;
    const r = Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return r;
  }

  /** uniform in 0..n-1 (n in 1..2^32), no modulo bias */
  below(n) {
    if (!(Number.isInteger(n) && n >= 1 && n <= 0x100000000)) throw new RangeError('Prng.below: n must be 1..2^32');
    if (n === 0x100000000) return this.next32();
    const zone = 0x100000000 - (0x100000000 % n);
    for (let i = 0; i < 64; i++) {
      const v = this.next32();
      if (v < zone) return v % n;
    }
    return this.next32() % n; // 2^-64 odds of reaching this: bounded loop, tiny bias
  }

  /** uniform in [0, 1) with 53 bits */
  unit() {
    const hi = this.next32() >>> 5, lo = this.next32() >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  /** a uniform u64 as a BigInt */
  next64() {
    const lo = BigInt(this.next32()), hi = BigInt(this.next32());
    return (hi << 32n) | lo;
  }

  /** n random bytes */
  bytes(n) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i += 4) {
      const v = this.next32();
      for (let j = 0; j < 4 && i + j < n; j++) b[i + j] = (v >>> (8 * j)) & 255;
    }
    return b;
  }

  /** lowercase hex of n random bytes */
  hex(n) {
    let s = '';
    for (const x of this.bytes(n)) s += x.toString(16).padStart(2, '0');
    return s;
  }
}

/** a Prng seeded from the platform's CSPRNG: only at the edge (the Durable Object), never in a core */
export function osPrng() {
  const b = new Uint32Array(2);
  globalThis.crypto.getRandomValues(b);
  return new Prng((BigInt(b[1]) << 32n) | BigInt(b[0]));
}

