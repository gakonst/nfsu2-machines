// CRC-32 as zlib makes it (crc32fast::hash in the Rust server): the check of a free-roam datagram (runtime/roam_core.c
// rc_encode).  Table-driven, no dependencies.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** crc32fast::hash: zlib's CRC-32 of the bytes (a u32) */
export function crc32(bytes, from = 0, to = bytes.length) {
  let c = 0xFFFFFFFF;
  for (let i = from; i < to; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
