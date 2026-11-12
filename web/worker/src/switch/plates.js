// Players' license plates in free roam (runtime/plates.c): a port of web/server-rs/crates/lan/src/plates.rs.  A HELLO
// to a peer carries the player's plate after its flag, with the header flag RC_HF_PLATE (runtime/roam_core.h): up to
// 8 capitals and digits that every other player near it sees on its car.  The switch is where all of them pass, so
// there (route.rs plate_fix, every frame a page sends, bundled or not) a plate HELLO goes on, but
//  - one whose plate is not capitals and digits, or is cut short, goes on without it (as a game's own decoder would
//    show none);
//  - one whose plate reads as a slur (names blockedPlate: as a player's name, and the words that read as one only on
//    a plate, "BIGFAG", "HH88") goes on without it, and a [plate] line says so (once for each plate of the player);
//  - one whose plate is another than the player's last one within EVERY_MS of it goes on with the last one until
//    then, so a player who changes plates again and again costs the others a texture's pixels every 10 s at most;
//    each plate that goes is a [plate] line.
// The HELLO is rewritten for that (rewrite: the plate's bytes, the header's flag, the length, the CRC), and only one
// whose length and CRC are right: one that is not goes as it came, and every game drops it.  A HELLO without the flag
// (an older game's, a player without a plate) is not looked at.
//
// route.rs plate_fix, which the switch port does with these: not intact -> the frame as it is; Found broken ->
// rewrite(frame, null, null); Found plate -> judge(seen, plate, nowMs): go -> as it is; new -> as it is (a [plate]
// line); last -> rewrite(frame, at, verdict.last); slur -> rewrite(frame, at, null) (a [plate] line when tell).

import { blockedPlate } from '../names/index.js';
import { crc32 } from './crc32.js';

/** lan/src/plates.rs EVERY_MS: a player's plate changes for the others at most this often (runtime/roam_game.c
 * PLATE_EVERY_US) */
export const EVERY_MS = 10000;
/** lan/src/plates.rs MAX: runtime/roam_core.h RC_PLATE_MAX */
export const MAX = 8;

const HF_CREW = 0x0200;
const HF_PLATE = 0x8000;
/** the switch frame's header before the datagram: kind, addresses, ports */
const FRAME_HDR = 16;
/** lan/src/lib.rs KIND_UDP */
const KIND_UDP = 1;

const u16le = (b, i) => b[i] | (b[i + 1] << 8);

/**
 * lan/src/plates.rs hello_plate: a free-roam frame's HELLO plate (frame: a switch frame, the datagram after its
 * header), mirroring Found: null for any other frame; {kind: 'plate', at, plate, name} for its plate (Found::Plate) (at: its length
 * byte's offset in the datagram; plate and name: views into frame); {kind: 'broken'} for one whose plate is cut short
 * or not capitals and digits (or not where the flag says).
 * @param {Uint8Array} frame
 */
export function helloPlate(frame) {
  if (frame.length < FRAME_HDR) return null;
  const d = frame.subarray(FRAME_HDR);
  if (frame[0] !== KIND_UDP || d.length < 29 + 4 || d[0] !== 0x4E || d[1] !== 0x32 || d[2] !== 0x46 || d[3] !== 0x52 ||
    d[4] !== 1 || d[5] !== 1) return null;
  const flags = u16le(d, 14);
  if ((flags & HF_PLATE) === 0) return null;
  return parse(d.subarray(0, d.length - 4), flags) ?? { kind: 'broken' };
}

/** lan/src/plates.rs parse: after the 16-byte header: core 2, platform, status, port 2, cfg 2, room 4, the name (its
 * length, then it), the ids it hears (their count, then 4 each), then with RC_HF_CREW the crews (their count, 4
 * each), the links (1), the outrun's player (4), the flag (its length, then it) and the plate (its length, then it):
 * roam_core.c rc_encode */
function parse(d, flags) {
  if ((flags & HF_CREW) === 0) return null;
  if (d.length <= 28) return null;
  const nl = d[28];
  if (29 + nl > d.length) return null;
  const name = d.subarray(29, 29 + nl);
  let at = 29 + nl;
  if (at >= d.length) return null;
  const seen = d[at];
  at += 1 + 4 * seen;
  if (at >= d.length) return null;
  const crews = d[at];
  at += 1 + 4 * crews + 1 + 4;
  if (at >= d.length) return null;
  const flag = d[at];
  at += 1 + flag;
  if (at >= d.length) return null;
  const n = d[at];
  if (at + 1 + n > d.length) return null;
  const plate = d.subarray(at + 1, at + 1 + n);
  return seen <= 64 && crews <= 4 && flag <= 6 && n >= 1 && n <= MAX && ok(plate) ? { kind: 'plate', at, plate, name } : null;
}

/** lan/src/plates.rs ok: capitals and digits only, at most MAX (runtime/roam_core.c rc_plate_ok) */
export function ok(plate) {
  if (plate.length > MAX) return false;
  for (const b of plate) if (!((b >= 0x41 && b <= 0x5A) || (b >= 0x30 && b <= 0x39))) return false;
  return true;
}

/**
 * lan/src/plates.rs rewrite: a plate HELLO's frame with plate in place of its own (the plate's bytes at at), or
 * without one (plate null: the header's flag off, the plate's bytes gone; at null: a plate not found, only the flag
 * off); the datagram's length and CRC made right.  An empty plate (not null) leaves a zero length byte, the flag off.
 * null: the frame's length or CRC was not right to begin with (it goes as it came, and no game takes it).
 * @param {Uint8Array} frame
 * @param {number|null} at
 * @param {Uint8Array|null} plate
 */
export function rewrite(frame, at, plate) {
  if (!intact(frame)) return null;
  const d = frame.subarray(FRAME_HDR);
  const n = d.length;
  const parts = [frame.subarray(0, FRAME_HDR)];
  if (at !== null && at !== undefined) {
    if (!(Number.isInteger(at) && at >= 0) || at >= n) return null;
    const end = at + 1 + d[at];
    if (end > n - 4) return null;
    parts.push(d.subarray(0, at));
    if (plate !== null && plate !== undefined) parts.push(Uint8Array.of(plate.length & 255), plate);
    parts.push(d.subarray(end, n - 4));
  } else {
    parts.push(d.subarray(0, n - 4));
  }
  let len = 4;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  // the Rust indexes the header's flags here: a panic for an at before them (helloPlate's never is)
  if (len < FRAME_HDR + 16 + 4) throw new RangeError('plates.rewrite: at ' + at + ' cuts into the header');
  let flags = u16le(out, FRAME_HDR + 14);
  if (!(plate && plate.length > 0)) flags &= ~HF_PLATE;
  out[FRAME_HDR + 14] = flags & 255;
  out[FRAME_HDR + 15] = (flags >> 8) & 255;
  const dl = (len - FRAME_HDR) & 0xFFFF;
  out[FRAME_HDR + 6] = dl & 255;
  out[FRAME_HDR + 7] = dl >> 8;
  const crc = crc32(out.subarray(FRAME_HDR, len - 4));
  out[len - 4] = crc & 255;
  out[len - 3] = (crc >>> 8) & 255;
  out[len - 2] = (crc >>> 16) & 255;
  out[len - 1] = crc >>> 24;
  return out;
}

/** lan/src/plates.rs intact: a frame's datagram has the length and CRC it says: a game takes it (one that has not is
 * not judged either) */
export function intact(frame) {
  if (frame.length < FRAME_HDR) return false;
  const d = frame.subarray(FRAME_HDR);
  const n = d.length;
  if (n < 29 + 4 || u16le(d, 6) !== n) return false;
  const crc = (d[n - 4] | (d[n - 3] << 8) | (d[n - 2] << 16) | (d[n - 1] << 24)) >>> 0;
  return crc === crc32(d.subarray(0, n - 4));
}

const bytesEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** lan/src/plates.rs Seen: what the switch keeps of a player's plates (lib.rs Peer) */
export class Seen {
  constructor() {
    /** the plate that last went to the others, and when (mono ms): {plate, at} or null */
    this.last = null;
    /** the last plate taken out as a slur (its line is written once), or null */
    this.refused = null;
  }
}

/**
 * lan/src/plates.rs judge: the verdict on plate (checked by helloPlate) from the player whose plates seen keeps, at
 * nowMs (mono ms), mirroring Verdict: {kind: 'go'} on as it is; {kind: 'new'} on, a new plate (a [plate] line);
 * {kind: 'last', last} on with the player's last plate instead (a change too soon); {kind: 'slur', tell} on
 * without its plate (it reads as a slur; a [plate] line the first time).  The plate is read as UTF-8 ("" if it is
 * none), as the Rust.
 * @param {Seen} seen
 * @param {Uint8Array} plate
 * @param {number} nowMs
 */
export function judge(seen, plate, nowMs) {
  let text = '';
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plate);
  } catch {
    text = '';
  }
  if (blockedPlate(text)) {
    const tell = !(seen.refused !== null && bytesEq(seen.refused, plate));
    seen.refused = Uint8Array.from(plate);
    return { kind: 'slur', tell };
  }
  const last = seen.last;
  if (last !== null && bytesEq(last.plate, plate)) return { kind: 'go' };
  if (last !== null && nowMs - last.at < EVERY_MS) return { kind: 'last', last: Uint8Array.from(last.plate) };
  seen.last = { plate: Uint8Array.from(plate), at: nowMs };
  return { kind: 'new' };
}

