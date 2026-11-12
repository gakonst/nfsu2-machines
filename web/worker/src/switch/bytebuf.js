// A growable byte buffer: what the Rust switch's writers do with a Vec<u8> they append to (a bundle being made, an
// entry's bytes).  Zero dependencies; the view bytes() gives shares the buffer until the next push.

const MIN_CAP = 64;

/** Vec<u8> as an output buffer (Rust's `buf: &mut Vec<u8>` in crates/lan: compact.rs, fpred.rs, conn.rs). */
export class ByteBuf {
  /** @param {number} [cap] the bytes to hold before growing */
  constructor(cap = MIN_CAP) {
    if (!(Number.isInteger(cap) && cap >= 0)) throw new RangeError('ByteBuf: cap must be a whole number');
    /** @type {Uint8Array} */
    this.buf = new Uint8Array(Math.max(cap, MIN_CAP));
    /** the bytes in it */
    this.len = 0;
  }

  /** room for n more bytes (Vec::reserve) */
  reserve(n) {
    const want = this.len + n;
    if (want <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < want) cap *= 2;
    const b = new Uint8Array(cap);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }

  /** one byte (Vec::push); only its low 8 bits */
  push(byte) {
    if (this.len === this.buf.length) this.reserve(1);
    this.buf[this.len++] = byte;
  }

  /** bytes (Vec::extend_from_slice) */
  pushBytes(u8a) {
    const n = u8a.length;
    this.reserve(n);
    this.buf.set(u8a, this.len);
    this.len += n;
  }

  /** a u16, big-endian (u16::to_be_bytes) */
  u16(x) {
    this.reserve(2);
    this.buf[this.len] = x >>> 8;
    this.buf[this.len + 1] = x;
    this.len += 2;
  }

  /** a u32, big-endian (u32::to_be_bytes) */
  u32(x) {
    this.reserve(4);
    const b = this.buf, o = this.len;
    b[o] = x >>> 24;
    b[o + 1] = x >>> 16;
    b[o + 2] = x >>> 8;
    b[o + 3] = x;
    this.len += 4;
  }

  /** a u16, little-endian */
  u16le(x) {
    this.reserve(2);
    this.buf[this.len] = x;
    this.buf[this.len + 1] = x >>> 8;
    this.len += 2;
  }

  /** a u32, little-endian */
  u32le(x) {
    this.reserve(4);
    const b = this.buf, o = this.len;
    b[o] = x;
    b[o + 1] = x >>> 8;
    b[o + 2] = x >>> 16;
    b[o + 3] = x >>> 24;
    this.len += 4;
  }

  /** n zero bytes more (Vec::resize to len + n with 0) */
  zeros(n) {
    this.reserve(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
  }

  /** a u16 big-endian written over bytes at..at+1 (already in it) */
  setU16(at, x) {
    if (!(at >= 0 && at + 2 <= this.len)) throw new RangeError('ByteBuf.setU16: past the end');
    this.buf[at] = x >>> 8;
    this.buf[at + 1] = x;
  }

  /** the first n bytes kept (Vec::truncate: a longer n changes nothing) */
  truncate(n) {
    if (n < this.len) this.len = n;
  }

  /** empty (Vec::clear); keeps its room */
  clear() {
    this.len = 0;
  }

  /** the bytes, a view into the buffer (valid until the next push) */
  bytes() {
    return this.buf.subarray(0, this.len);
  }

  /** the bytes from..to (default the end) as a view */
  view(from, to = this.len) {
    if (!(from >= 0 && from <= to && to <= this.len)) throw new RangeError('ByteBuf.view: out of range');
    return this.buf.subarray(from, to);
  }

  /** the bytes as a copy of their own */
  toBytes() {
    return this.buf.slice(0, this.len);
  }

  /** Vec::drain(from..to): those bytes taken out, the rest moved down */
  drain(from, to) {
    if (!(from >= 0 && from <= to && to <= this.len)) throw new RangeError('ByteBuf.drain: out of range');
    this.buf.copyWithin(from, to, this.len);
    this.len -= to - from;
  }
}
