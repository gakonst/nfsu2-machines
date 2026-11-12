// The page's side of compact bundles, for tests and the DST: a port of the helpers in compact.rs's tests module
// (unpack, unpack_with, unpack_fp, unpack_all, roam, frame, dgram, roam_frame).  What the page does with a compact bundle
// (web/src/net/proto.ts unpackCompact): the frames as the game gets them.  Throws where the Rust asserts.

import { crc32 } from './crc32.js';
import { F_FPRED } from './fpred.js';
import { KIND_COMPACT, REFS_MAX, OTHER_MAX } from './compact.js';

const BASE = ((10 << 24) | (77 << 16)) >>> 0;
const BROADCAST = 0xFFFFFFFF;
const ROAM_PORT = 47210;
const ENTRY = 5;
const ROAM_CUT = 11;
const F_BCAST = 0x08;
const F_PORTS = 0x10;
const F_ROAM = 0x20;
const F_WHOLE = 0x40;
const F_DELTA = 0x80;

function assert(ok, what) {
  if (!ok) throw new Error('compact unpack: ' + what);
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function be16(x) {
  return Uint8Array.of(x >>> 8, x & 0xFF);
}
function be32(x) {
  return Uint8Array.of(x >>> 24, (x >>> 16) & 0xFF, (x >>> 8) & 0xFF, x & 0xFF);
}
function le16(x) {
  return Uint8Array.of(x & 0xFF, (x >>> 8) & 0xFF);
}
function le32(x) {
  return Uint8Array.of(x & 0xFF, (x >>> 8) & 0xFF, (x >>> 16) & 0xFF, x >>> 24);
}
const N2FR = Uint8Array.of(0x4E, 0x32, 0x46, 0x52);

/** compact.rs tests::unpack: the frames of a compact bundle b at a page holding own */
export function unpack(b, own) {
  return unpackWith(b, own, null);
}

/** compact.rs tests::unpack_with: the same for a page that takes deltas: refs (a Map) its last bodies by source and
 *  type, as Refs keeps them */
export function unpackWith(b, own, refs) {
  return unpackFp(b, own, refs, null);
}

/** compact.rs tests::dgram: a free-roam datagram ("N2FR", version 1, its type and length, the body (from its sender's id
 *  on), the CRC) */
export function dgram(kind, body) {
  const d = concat([N2FR, Uint8Array.of(1, kind), le16(body.length + 1 + ROAM_CUT), body]);
  return concat([d, le32(crc32(d))]);
}

/** compact.rs tests::roam_frame: that in a frame from src to own on free roam's ports */
export function roamFrame(kind, body, src, own) {
  return frame(1, src, own, ROAM_PORT, ROAM_PORT, dgram(kind, body));
}

/** compact.rs tests::unpack_fp: the same for a page that takes car states by their fields too: fp the page's last ones
 *  (an Fpred, fpred.js decode) */
export function unpackFp(b, own, refs, fp) {
  return unpackAll(b, own, refs, fp, null);
}

/** compact.rs tests::unpack_all: the same for a page that takes every other datagram as what changed too (its hello said
 *  "ldelta":1): others (a Map) its last ones by source and kind */
export function unpackAll(b, own, refs, fp, others) {
  own >>>= 0;
  assert(b[0] === KIND_COMPACT, 'not a compact bundle');
  const out = [];
  let at = 4;
  for (let guard = 0; at + ENTRY <= b.length; guard++) {
    assert(guard <= b.length, 'entries past the bundle');
    const flags = b[at];
    if (flags === F_FPRED) {
      const src = (b[at + 1] << 8) | b[at + 2];
      const end = at + 4 + b[at + 3];
      assert(fp, 'an entry by fields to a page that takes them');
      const body = fp.decode(src, b.subarray(at + 4, end));
      assert(body !== null, 'it decodes');
      out.push(roamFrame(3, body, (BASE | src) >>> 0, own));
      at = end;
      continue;
    }
    const src = (BASE | ((b[at + 1] << 8) | b[at + 2])) >>> 0;
    const n = (b[at + 3] << 8) | b[at + 4];
    let p = at + ENTRY;
    const end = p + n;
    assert(end <= b.length, 'an entry past the bundle');
    if (flags === F_WHOLE) {
      out.push(b.slice(p, end));
      at = end;
      continue;
    }
    const otherKey = ((src & 0xFFFF) << 8) | (flags & 7);
    if ((flags & (F_DELTA | F_ROAM)) === F_DELTA) {
      assert(others, 'only to a page that takes them');
      const last = others.get(otherKey);
      assert(last !== undefined, 'its last one');
      let len;
      if (flags & F_PORTS) {
        p += 2;
        len = (b[p - 2] << 8) | b[p - 1];
      } else {
        len = last.length;
      }
      let next = p + ((len + 7) >>> 3);
      const rest = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        if ((b[p + (i >>> 3)] >> (i & 7)) & 1) rest[i] = b[next++];
        else {
          assert(i < last.length, 'a byte past the last one taken from it');
          rest[i] = last[i];
        }
      }
      assert(next === end, 'the new bytes fill the entry');
      const f = concat([Uint8Array.of(flags & 7, 0, 0, 0), be32(src), be32(own), rest]);
      others.set(otherKey, rest);
      out.push(f);
      at = end;
      continue;
    }
    const head = [Uint8Array.of(flags & 7, 0, 0, 0), be32(src), be32(flags & F_BCAST ? BROADCAST : own)];
    if (flags & F_PORTS) {
      head.push(b.slice(p, p + 4));
      p += 4;
    } else {
      head.push(be16(ROAM_PORT), be16(ROAM_PORT));
    }
    if (flags & F_ROAM) {
      const kind = b[p];
      const key = ((src & 0xFFFF) << 8) | kind;
      let body;
      if (flags & F_DELTA) {
        assert(refs, 'a delta to a page that takes them');
        const last = refs.get(key);
        assert(last !== undefined, "a delta's last body");
        const map = (last.length + 7) >>> 3;
        let next = p + 1 + map;
        body = new Uint8Array(last.length);
        for (let i = 0; i < last.length; i++) body[i] = (b[p + 1 + (i >>> 3)] >> (i & 7)) & 1 ? b[next++] : last[i];
        assert(next === end, 'the new bytes fill the entry');
      } else {
        body = b.slice(p + 1, end);
      }
      if (refs && (flags & (F_PORTS | F_BCAST)) === 0) {
        if (refs.size >= REFS_MAX && !refs.has(key)) refs.clear();
        refs.set(key, body.slice());
      }
      out.push(concat([...head, dgram(kind, body)]));
    } else {
      const f = concat([...head, b.subarray(p, end)]);
      if (others && (flags & F_BCAST) === 0 && f.length - 12 <= OTHER_MAX) {
        if (others.size >= REFS_MAX && !others.has(otherKey)) others.clear();
        others.set(otherKey, f.slice(12));
      }
      out.push(f);
    }
    at = end;
  }
  return out;
}

/** compact.rs tests::roam: a free-roam datagram as rc_encode makes it: a type, a body (after a fixed sender 0x12345678
 *  and byte 7), the length and CRC filled in */
export function roam(kind, body) {
  const d = concat([N2FR, Uint8Array.of(1, kind, 0, 0), le32(0x12345678), Uint8Array.of(7, 0, 0, 0), body]);
  const n = d.length + 4;
  d[6] = n & 0xFF;
  d[7] = (n >>> 8) & 0xFF;
  return concat([d, le32(crc32(d))]);
}

/** compact.rs tests::frame: a frame as the browser sends it (its source and destination as the switch writes them going
 *  out) */
export function frame(kind, src, dst, sport, dport, data) {
  return concat([Uint8Array.of(kind, 0, 0, 0), be32(src >>> 0), be32(dst >>> 0), be16(sport), be16(dport), data]);
}
