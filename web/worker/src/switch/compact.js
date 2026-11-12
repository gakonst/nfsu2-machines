// Compact bundles (kind 33): a port of web/server-rs/crates/lan/src/compact.rs (and conn.rs with_addrs, which its
// whole entries use).  The datagrams of a bundle to a page whose hello said "compact":1, without what the page can put
// back exactly.  What reaches the game is the same, byte for byte; what goes over the network is about a quarter less.
//
// A bundle: [0] 33, [1] 0x01 when a probe's stamp of 8 bytes follows [3] (F_STAMPED: only to a page whose hello said
// "echo":1, which echoes it in its own next bundle), [2..3] reserved, then entries of
//   [0] flags: bits 0-2 the frame's kind (1-7); 0x08 to the broadcast address (else to the page's own); 0x10 the
//       ports follow (else both are RC_DEFAULT_PORT, free roam's 47210); 0x20 a free-roam datagram without its
//       "N2FR", version, length and CRC (the page writes them back, the CRC computed again: the switch checked it
//       first); 0x40 the whole frame follows as it is (its 16-byte header included; the other bits 0)
//   [1..2] u16 the source address's low 16 bits (10.77.x.y)
//   [3..4] u16 the length of what follows: the ports (u16 source, u16 destination) when 0x10, then the data
//
// To a page whose hello said "delta":1 too, a free-roam datagram to it on free roam's ports (0x20 without 0x08 and
// 0x10) may go as what changed since the last one of its type from the same source (Refs): flags 0x80 with 0x20,
// then its type, a bitmap of its body's bytes (bit i % 8 of byte i / 8: byte i of the body is new; the body as long
// as the last one's), and the new bytes in order.  Every such entry, in either form, is the last one of its source
// and type for the next; the page keeps the same, entry for entry, and the stream loses and reorders nothing.
//
// To a page whose hello said "ldelta":1 besides, any other datagram to it goes the same way, as what changed since the
// last one of its kind from its source (Refs.other): flags 0x80 without 0x20, bits 0-2 its kind; 0x10 then says that
// its length (u16) follows, for one not as long as the last one; then a bitmap of its bytes from its ports on (a byte
// past the last one's end always new), and the new bytes in order.  Every entry of such a datagram to the page's own
// address (not 0x20, 0x08 or 0x40) of at most OTHER_MAX bytes from its ports on, plain or not, is the last one of its
// source and kind for the next, kept apart from free roam's (REFS_MAX of each).
//
// Sans-IO: no clocks, no randomness; bytes are Uint8Arrays, output goes to a ByteBuf (Rust's Vec<u8>).

import { crc32 } from './crc32.js';
import { fields as fpFields } from './fpred.js';

/** lib.rs BASE: 10.77.0.0 */
const BASE = ((10 << 24) | (77 << 16)) >>> 0;
/** lib.rs BROADCAST */
const BROADCAST = 0xFFFFFFFF;
/** lib.rs KIND_UDP */
const KIND_UDP = 1;

/** compact.rs KIND_COMPACT: a compact bundle (page and switch only: the switch never routes one from a client) */
export const KIND_COMPACT = 33;
/** compact.rs F_STAMPED: a bundle's [1]: a probe's stamp of 8 bytes follows the header */
export const F_STAMPED = 0x01;
/** runtime/roam_core.h RC_DEFAULT_PORT */
const ROAM_PORT = 47210;
const F_BCAST = 0x08;
const F_PORTS = 0x10;
const F_ROAM = 0x20;
const F_WHOLE = 0x40;
const F_DELTA = 0x80;
/** compact.rs OTHER_MAX: the longest other datagram (from its ports on) that goes as what changed and is kept as the
 *  last one (a longer one goes as it is, kept by neither end) */
export const OTHER_MAX = 1500;
/** compact.rs REFS_MAX: the sources and types whose last bodies a connection keeps at most: a new one past that, and
 *  they all go first (the page does the same, so both keep the same ones) */
export const REFS_MAX = 256;
/** an entry's own bytes */
const ENTRY = 5;
/** "N2FR", version, length (left out at the front) and the CRC (at the end) */
const ROAM_CUT = 11;
/** compact.rs ROAM_OK: a frame's byte 1 (reserved on the wire) in the switch's own copy of it: its datagram is a
 *  free-roam one whose magic, version, length and CRC checked out (mark), so a compact bundle may leave them out */
export const ROAM_OK = 1;

/** runtime/roam_core.h: a free-roam datagram's type (its byte 5), a ping's and its answer's */
const RC_SNAP = 3;
const RC_PING = 6;
const RC_PONG = 7;
/** compact.rs TIMED_MAX: the longest of them (a pong: its 16-byte frame header, the datagram's 16, three times and the
 *  CRC) */
export const TIMED_MAX = 16 + 16 + 12 + 4;

/** compact.rs timed: a free-roam ping or pong to a page that takes compact bundles: queued with the time, so that its
 *  bundle can move its send time on by its wait (waited) */
export function timed(data) {
  return stampAt(data) >= 0;
}

/** compact.rs stamp_at: where a ping's t0 or a pong's t2 is in its frame, when the frame holds it and the CRC after it
 *  (mark checks only a datagram's length field and CRC, so a pong of 40 bytes is marked too, and its t2 would be past
 *  its end); -1 for none */
function stampAt(data) {
  if (data.length < 16 + 6 || data.length > TIMED_MAX || data[1] !== ROAM_OK) return -1;
  let at;
  switch (data[16 + 5]) {
    case RC_PING: at = 16 + 16; break;
    case RC_PONG: at = 16 + 24; break;
    default: return -1;
  }
  return at + 4 + 4 <= data.length ? at : -1;
}

/** compact.rs waited: a ping's send time (t0) or a pong's (t2) moved on by the time it waited for the bundle clock (us,
 *  a u32 of microseconds), in a copy in into (a Uint8Array of TIMED_MAX); anything else as it is.  The game draws a
 *  friend's solid car ahead by half the smallest round trip of its last 8 pings: a ping or pong that waited for this
 *  clock drew the car ahead by that wait.  The CRC is left as it was: an entry of free roam's leaves it out, and the
 *  page makes it again.  Returns the bytes to use (data itself, or a view of into). */
export function waited(data, us, into) {
  const at = stampAt(data);
  if (at < 0) return data;
  if (us === 0 || us >= 1_000_000) return data;
  if (!(into instanceof Uint8Array && into.length >= TIMED_MAX)) throw new TypeError('waited: into must be a Uint8Array(TIMED_MAX)');
  const m = into.subarray(0, data.length);
  m.set(data);
  const t = ((m[at] | (m[at + 1] << 8) | (m[at + 2] << 16) | (m[at + 3] << 24)) + us) >>> 0;
  m[at] = t;
  m[at + 1] = t >>> 8;
  m[at + 2] = t >>> 16;
  m[at + 3] = t >>> 24;
  return m;
}

/** compact.rs roam_ok: a free-roam datagram (runtime/roam_core.c rc_encode) as the game's decoder takes it: "N2FR",
 *  version 1, its length (u16 LE) the datagram's, the CRC-32 (zlib's, LE) of what comes before it */
export function roamOk(d) {
  const n = d.length;
  return (
    n >= 20 &&
    d[0] === 0x4E && d[1] === 0x32 && d[2] === 0x46 && d[3] === 0x52 &&
    d[4] === 1 &&
    (d[6] | (d[7] << 8)) === n &&
    ((d[n - 4] | (d[n - 3] << 8) | (d[n - 2] << 16) | (d[n - 1] << 24)) >>> 0) === crc32(d, 0, n - 4)
  );
}

/** compact.rs mark: the switch's copy of a browser's frame, with byte 1 saying whether its free-roam datagram may go
 *  compact (byte 1 is reserved on the wire: what a client put there is not kept; the writers send 0 there) */
export function mark(data) {
  if (data.length < 2) throw new RangeError('mark: a frame of at least 2 bytes'); // Rust: an index panic
  const v = data.slice();
  v[1] = data[0] === KIND_UDP && v.length > 16 && roamOk(data.subarray(16)) ? ROAM_OK : 0;
  return v;
}

/** compact.rs plan: an entry's flags and the bytes it takes, for a datagram of data from src to dst at a page holding
 *  own, packed as n * 256 + flags.  A frame shorter than the 16 bytes of a header with ports goes whole: the reader
 *  takes any frame of 12 bytes or more, and the compact form reads the ports and what follows them */
function plan(data, src, dst, own) {
  const kind = data[0];
  const len = data.length;
  if (len < 16 || kind === 0 || kind > 7 || src >>> 16 !== BASE >>> 16 || (dst !== own && dst !== BROADCAST)) {
    return (ENTRY + len) * 256 + F_WHOLE;
  }
  let flags = kind;
  let n = ENTRY;
  if (dst === BROADCAST) flags |= F_BCAST;
  if (((data[12] << 8) | data[13]) !== ROAM_PORT || ((data[14] << 8) | data[15]) !== ROAM_PORT) {
    flags |= F_PORTS;
    n += 4;
  }
  if (data[1] === ROAM_OK) {
    // only mark's copies say so, and mark checked a datagram of 20 bytes at least; Rust slices the body at [8..len - 4]
    // of the datagram and panics when that is not there (a frame under 28 bytes)
    if (len < 16 + 12) throw new RangeError('entry: a frame whose byte 1 says ROAM_OK must hold a datagram of 12 bytes or more');
    flags |= F_ROAM;
    n += len - 16 - ROAM_CUT;
  } else {
    n += len - 16;
  }
  return n * 256 + flags;
}

/** compact.rs entry_len: the bytes entry writes without deltas */
export function entryLen(data, src, dst, own) {
  return Math.floor(plan(data, src >>> 0, dst >>> 0, own >>> 0) / 256);
}

/** compact.rs Refs: the last body (a free-roam datagram past its type, as an 0x20 entry carries it) of each source and
 *  type that went to one page in a compact bundle: what its 0x80 entries are made against.  Its writer's own.  (Rust
 *  keeps them in HashMaps hashed by KeyHash; nothing iterates them, so a Map in any order is the same.) */
export class Refs {
  constructor() {
    /** @type {Map<number, Uint8Array>} by (src & 0xFFFF) << 8 | type */
    this.last = new Map();
    /** the same for the other datagrams (other), by source and kind: apart, so that a page that asks for them keeps
     *  free roam's as a switch of before does (REFS_MAX of each) */
    this.others = new Map();
  }

  /** compact.rs Refs::entry: the entry of a free-roam datagram's type and body from src as what changed since that
   *  source's and type's last body when there is one as long and that is shorter; body is their last now either way.
   *  True when it wrote that entry; false: the caller writes the plain one (Rust's `plain` callback). */
  entry(buf, flags, src, kind, body) {
    const key = ((src & 0xFFFF) << 8) | kind;
    const last = this.last.get(key);
    if (last === undefined) {
      insert(this.last, key, body);
      return false;
    }
    if (last.length !== body.length) {
      this.last.set(key, body.slice());
      return false;
    }
    // in one pass: the bitmap, the new bytes after it, the last body brought up to date
    const start = buf.len;
    const len = body.length;
    const map = (len + 7) >>> 3;
    buf.push(flags | F_DELTA);
    buf.u16(src & 0xFFFF);
    buf.push(0);
    buf.push(0);
    buf.push(kind);
    const at = buf.len;
    buf.zeros(map);
    for (let i = 0; i < len; i++) {
      const b = body[i];
      if (b !== last[i]) {
        buf.buf[at + (i >>> 3)] |= 1 << (i & 7);
        buf.push(b);
        last[i] = b;
      }
    }
    const n = buf.len - at + 1;
    if (n < 1 + len) {
      buf.setU16(start + 3, n);
      return true;
    }
    buf.truncate(start);
    return false;
  }

  /** compact.rs Refs::other: the entry of another datagram from src (flags without F_ROAM, F_BCAST and F_WHOLE; rest its
   *  frame from its ports on) as what changed since that source's last one of its kind when there is one and that is
   *  shorter; rest is their last now either way.  True when it wrote that entry; false: the caller writes the plain
   *  one. */
  other(buf, flags, src, rest) {
    const key = ((src & 0xFFFF) << 8) | (flags & 7);
    const last = this.others.get(key);
    if (last === undefined) {
      insert(this.others, key, rest);
      return false;
    }
    const start = buf.len;
    const len = rest.length;
    const same = last.length === len;
    buf.push((flags & 7) | F_DELTA | (same ? 0 : F_PORTS));
    buf.u16(src & 0xFFFF);
    buf.push(0);
    buf.push(0);
    if (!same) buf.u16(len);
    const at = buf.len;
    buf.zeros((len + 7) >>> 3);
    const ll = last.length;
    for (let i = 0; i < len; i++) {
      const b = rest[i];
      if (i >= ll || last[i] !== b) {
        buf.buf[at + (i >>> 3)] |= 1 << (i & 7);
        buf.push(b);
      }
    }
    // shorter than the plain entry (its 5 bytes, the ports when it carries them, the rest)
    const plainLen = ENTRY + len - (flags & F_PORTS ? 0 : 4);
    let wrote = false;
    if (buf.len - start < plainLen) {
      buf.setU16(start + 3, buf.len - start - ENTRY);
      wrote = true;
    } else {
      buf.truncate(start);
    }
    this.others.set(key, rest.slice());
    return wrote;
  }
}

/** compact.rs insert: a new source and type: past REFS_MAX of them, all go first (the page does the same) */
function insert(map, key, body) {
  if (map.size >= REFS_MAX) map.clear();
  map.set(key, body.slice());
}

/** compact.rs entry (a test helper there): one entry; with refs (a page that takes deltas) a free-roam datagram to it
 *  goes as what changed when that is shorter, and is its source's last either way */
export function entry(buf, data, src, dst, own, refs) {
  entryFp(buf, data, src, dst, own, refs, null, false);
}

/** compact.rs entry_fp: one entry of data (the switch's marked copy, or waited's) from src to dst into buf, for a page
 *  holding own; with fp too (a page whose hello said "fpred":1) a friend's car state to it goes by its fields (fpred.js)
 *  when it can, and leaves refs alone then; with others (its hello said "ldelta":1) any other datagram to it goes as
 *  what changed too (Refs.other) */
export function entryFp(buf, data, src, dst, own, refs, fp, others) {
  src >>>= 0;
  dst >>>= 0;
  own >>>= 0;
  const p = plan(data, src, dst, own);
  const flags = p & 0xFF;
  const n = Math.floor(p / 256);
  const sel = flags & (F_ROAM | F_PORTS | F_BCAST | F_WHOLE);
  if (fp && sel === F_ROAM && data[16 + 5] === RC_SNAP) {
    const v = fpFields(data.subarray(16 + 8, data.length - 4));
    if (v !== null && fp.encode(buf, src & 0xFFFF, v)) return;
  }
  if (refs) {
    if (sel === F_ROAM) {
      const d = data.subarray(16);
      if (refs.entry(buf, flags, src, d[5], d.subarray(8, d.length - 4))) return;
    } else if (others && (flags & (F_ROAM | F_BCAST | F_WHOLE)) === 0 && data.length - 12 <= OTHER_MAX) {
      if (refs.other(buf, flags, src, data.subarray(12))) return;
    }
  }
  plain(buf, data, src, dst, flags, n);
}

/** compact.rs plain: the entry as it is (no delta) */
function plain(buf, data, src, dst, flags, n) {
  buf.push(flags);
  if (flags === F_WHOLE) {
    buf.push(0);
    buf.push(0);
    buf.u16((n - ENTRY) & 0xFFFF);
    withAddrs(buf, data, src, dst);
    return;
  }
  buf.u16(src & 0xFFFF);
  buf.u16((n - ENTRY) & 0xFFFF);
  if (flags & F_PORTS) buf.pushBytes(data.subarray(12, 16));
  const d = data.subarray(16);
  if (flags & F_ROAM) {
    buf.push(d[5]);
    buf.pushBytes(d.subarray(8, d.length - 4));
  } else {
    buf.pushBytes(d);
  }
}

/** conn.rs with_addrs: a frame with its source and destination written in (the one copy a datagram gets); bytes 1-3
 *  are reserved: 0 on the wire, whatever the switch's copy holds there (mark) */
export function withAddrs(buf, data, src, dst) {
  if (data.length < 12) throw new RangeError('withAddrs: a frame of at least 12 bytes'); // Rust: a slice panic
  buf.push(data[0]);
  buf.push(0);
  buf.push(0);
  buf.push(0);
  buf.u32(src >>> 0);
  buf.u32(dst >>> 0);
  buf.pushBytes(data.subarray(12));
}
