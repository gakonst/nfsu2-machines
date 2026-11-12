// What the pages were sent, by kind: a port of web/server-rs/crates/lan/src/mix.rs, the [players] count of where the
// bytes go.  Each entry of a compact bundle (compact.js) counts its bytes as it went, under its datagram's kind: free
// roam's by their type (runtime/roam_core.h RC_MSG_*), LAN play's UDP (the game's own races, Online's and free roam's
// lobby races) and the rest; each message of a host (the free-roam hub's lists and map, the Online server's segments: a
// WebSocket message each, never in a bundle) counts as its whole frame.
//
// The same kinds count what the pages send (ofPage): each entry of a page's bundle under its datagram's kind (those to
// the hub as the hub's), the destinations an entry lists past the first, the bundles' and entries' headers and the
// control messages (JSON) as kinds of their own.  MSGS: how many messages each way, which cloudflared paid for one by
// one.
//
// The lines' numbers are formatted as Rust's format! does them ({:.0}, {:.1} of an f64: the exact decimal value rounded,
// ties to even; "inf", "NaN"): fmtFixed.

import { ROAM_OK } from './compact.js';

/** lib.rs BASE, BROADCAST, KIND_UDP */
const BASE = ((10 << 24) | (77 << 16)) >>> 0;
const BROADCAST = 0xFFFFFFFF;
const KIND_UDP = 1;

/** runtime/roam_core.h RC_MSG_*: a free-roam datagram's type (0: one this does not know) */
const ROAM_TYPES = Object.freeze([
  '?',
  'hello',
  'peers',
  'car state',
  'car look',
  'car look ask',
  'ping',
  'pong',
  'bye',
  'duel',
  'map ask',
  'map',
  'lobby',
  'lobbies',
  'race report',
  'say',
  'race results',
  'map delta',
  'near ask',
  'near',
  'crash damage',
]);
const R = ROAM_TYPES.length;
/** a free-roam datagram whose magic, length or CRC did not check out (or another kind 1 on free roam's ports) */
const ROAM_BAD = R;
const UDP_OTHER = R + 1;
/** LAN play's UDP (KIND_LAN_UDP), to the page's own address, to all */
const LAN_UDP = R + 2;
const LAN_BCAST = R + 3;
const OTHER_KIND = R + 4;
/** the hub's messages, by free roam's types (R of them) */
const HUB = R + 5;
const ONLINE = HUB + R;
const OTHER_HOST = ONLINE + 1;
/** mix.rs ADDRS, FRAMING, TEXT: from the pages: the destinations a bundle entry lists (4 bytes each; one alone is in its
 *  frame), the bundles' and their entries' headers, the control messages (JSON) */
export const ADDRS = OTHER_HOST + 1;
export const FRAMING = OTHER_HOST + 2;
export const TEXT = OTHER_HOST + 3;
/** LAN play's TCP segments (the Online server's and a LAN race host's streams) */
const LAN_TCP = OTHER_HOST + 4;
/** mix.rs KINDS: the kinds */
export const KINDS = LAN_TCP + 1;
/** runtime/web/net_proto.h: LAN play's UDP and TCP */
const KIND_LAN_UDP = 3;
const KIND_LAN_TCP = 4;
/** runtime/roam_core.h RC_DEFAULT_PORT */
const ROAM_PORT = 47210;

/** the private kinds, for tests (mix.rs's consts) */
export const KIND = Object.freeze({ R, ROAM_BAD, UDP_OTHER, LAN_UDP, LAN_BCAST, OTHER_KIND, HUB, ONLINE, OTHER_HOST, ADDRS, FRAMING, TEXT, LAN_TCP });

/** mix.rs name: a kind's name in the count */
export function name(i) {
  if (i < R) return ROAM_TYPES[i];
  switch (i) {
    case ROAM_BAD: return "free roam's port, unchecked";
    case UDP_OTHER: return 'UDP, other ports';
    case LAN_UDP: return 'LAN UDP';
    case LAN_BCAST: return 'LAN UDP broadcast';
    case OTHER_KIND: return 'other frames';
  }
  if (i < ONLINE) return 'hub ' + ROAM_TYPES[i - HUB];
  switch (i) {
    case ONLINE: return 'Online server';
    case OTHER_HOST: return 'other host';
    case ADDRS: return 'destinations';
    case FRAMING: return 'bundle headers';
    case TEXT: return 'control messages';
    default: return 'LAN TCP';
  }
}

/** mix.rs roam_type: a free-roam datagram's type at [16 + 5] of its frame, as a kind (0 for one past those known) */
function roamType(data) {
  const t = data[16 + 5];
  return t < R ? t : 0;
}

/** nfsu2-roam's ROAM_HUB_VIP: the free-roam hub's address, whose lists, map and lobbies go in bundles too */
const HUB_VIP = (BASE | 0xFD) >>> 0;
export { HUB_VIP };

function isN2fr(data) {
  return data[16] === 0x4E && data[17] === 0x32 && data[18] === 0x46 && data[19] === 0x52;
}

/** mix.rs of_entry: the kind of a datagram (the switch's copy: byte 1 says whether free roam's checked out) that went
 *  from src to dst in a compact bundle (the hub's by their type, as its messages of their own were: ofHost) */
export function ofEntry(data, src, dst) {
  if (data.length < 16) return OTHER_KIND;
  src >>>= 0;
  dst >>>= 0;
  switch (data[0]) {
    case KIND_UDP:
      if (src === HUB_VIP && data[1] === ROAM_OK && data.length > 16 + 5) return HUB + roamType(data);
      if (data[1] === ROAM_OK && data.length > 16 + 5) return roamType(data);
      if (((data[14] << 8) | data[15]) === ROAM_PORT) return ROAM_BAD;
      return UDP_OTHER;
    case KIND_LAN_UDP:
      return dst === BROADCAST ? LAN_BCAST : LAN_UDP;
    default:
      return OTHER_KIND;
  }
}

/** mix.rs of_page: the kind of a frame a page sent to dst: free roam's by their type (those to the hub as the hub's) */
export function ofPage(data, dst) {
  if (data.length < 16) return OTHER_KIND;
  dst >>>= 0;
  const roam = data.length > 16 + 5 && isN2fr(data);
  switch (data[0]) {
    case KIND_UDP:
      if (roam && dst === HUB_VIP) return HUB + roamType(data);
      if (roam) return roamType(data);
      if (((data[14] << 8) | data[15]) === ROAM_PORT) return ROAM_BAD;
      return UDP_OTHER;
    case KIND_LAN_UDP:
      return dst === BROADCAST ? LAN_BCAST : LAN_UDP;
    case KIND_LAN_TCP:
      return LAN_TCP;
    default:
      return OTHER_KIND;
  }
}

/** mix.rs IN_* / OUT_*: WebSocket messages each way by type (Stats::msg), and the writes the server made (each batch a
 *  page's writer took): every one is work for the kernel and for cloudflared, whatever its size */
export const IN_BUNDLE = 0;
export const IN_FRAME = 1;
export const IN_TEXT = 2;
export const IN_PONG = 3;
export const IN_PING = 4;
export const OUT_BUNDLE = 5;
export const OUT_FRAME = 6;
export const OUT_TEXT = 7;
export const OUT_HOST = 8;
export const OUT_PING = 9;
export const OUT_PONG = 10;
export const OUT_WRITES = 11;
/** mix.rs MSGS */
export const MSGS = 12;

/** f64::max: NaN loses to a number (Math.max would give NaN) */
function fmax(a, b) {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  return a > b ? a : b;
}

/** u64::saturating_sub of two counts (safe whole Numbers, or BigInts), as a Number */
function satSub(a, b) {
  const x = typeof a === 'bigint' ? Number(a) : a;
  const y = typeof b === 'bigint' ? Number(b) : b;
  if (!(Number.isSafeInteger(x) && x >= 0 && Number.isSafeInteger(y) && y >= 0)) throw new RangeError('mix: counts must be whole numbers within 2^53');
  return x > y ? x - y : 0;
}

/** Rust's format!("{:.p}", x) for an f64 and p 0 or 1: the exact decimal value rounded to p places, ties to even; a
 *  minus for a negative one (and -0.0); "inf", "-inf" and "NaN" */
export function fmtFixed(x, p) {
  if (p !== 0 && p !== 1) throw new RangeError('fmtFixed: 0 or 1 places');
  if (Number.isNaN(x)) return 'NaN';
  const neg = x < 0 || Object.is(x, -0);
  const a = Math.abs(x);
  if (a === Infinity) return neg ? '-inf' : 'inf';
  let s;
  if (a >= 1e21) {
    // a whole number (past 2^53): every digit, as Rust writes it (toFixed would give an exponent)
    s = BigInt(a).toString() + (p === 1 ? '.0' : '');
  } else {
    s = a.toFixed(p);
    // toFixed takes the larger of two as near; Rust the even one.  A tie needs the exact value at a half: 2a odd
    // (p 0), 4a odd (p 1: a = m/4 is the only binary fraction ending in 5 at the second place)
    const k = p === 0 ? 2 * a : 4 * a;
    if (k < 2 ** 53 && Number.isInteger(k) && k % 2 === 1) {
      const lowN = Math.floor(p === 0 ? a : (k * 10) / 4); // the smaller of the two candidates, in units of 10^-p
      if (lowN % 2 === 0) s = p === 0 ? String(lowN) : String(Math.floor(lowN / 10)) + '.' + String(lowN % 10);
    }
  }
  return (neg ? '-' : '') + s;
}

const f0 = (x) => fmtFixed(x, 0);
const f1 = (x) => fmtFixed(x, 1);

/** mix.rs kinds_line: the count's line of messages by kind of player (LanSwitch::messages_by_kind): for each kind with
 *  players, how many, their messages each way a second, and each one's.  kinds: [{kind, players, msgsIn, msgsOut}]
 *  (lib.rs KindMsgs); null for none. */
export function kindsLine(kinds, secs) {
  const parts = [];
  for (const k of kinds) {
    if (!(k.players > 0 && secs > 0.0)) continue;
    const i = Number(k.msgsIn) / secs, o = Number(k.msgsOut) / secs, n = Number(k.players);
    parts.push(k.kind + ' ' + String(k.players) + ': ' + f0(i) + ' in, ' + f0(o) + ' out a second (' + f1(i / n) + ' and ' + f1(o / n) + ' each)');
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

/** mix.rs msg_line: the count's line of messages: each way a second, by type, and the writes; now and was: counts by
 *  IN_* / OUT_* (was may be shorter: 0 past its end); null when none went */
export function msgLine(now, was, secs) {
  if (now.length < MSGS) throw new RangeError('msgLine: MSGS counts'); // Rust: an index panic
  const s = fmax(secs, 1.0);
  const d = (i) => satSub(now[i], i < was.length ? was[i] : 0) / s;
  let inn = -0.0, out = -0.0;
  for (let i = IN_BUNDLE; i <= IN_PING; i++) inn += d(i);
  for (let i = OUT_BUNDLE; i <= OUT_PONG; i++) out += d(i);
  if (inn + out === 0.0) return null;
  return (
    'in ' + f0(inn) + '/s (bundles ' + f0(d(IN_BUNDLE)) + ', frames ' + f0(d(IN_FRAME)) + ', control ' + f0(d(IN_TEXT)) +
    ', pongs ' + f0(d(IN_PONG)) + ', pings ' + f0(d(IN_PING)) + '), out ' + f0(out) + '/s (bundles ' + f0(d(OUT_BUNDLE)) +
    ', frames ' + f0(d(OUT_FRAME)) + ', control ' + f0(d(OUT_TEXT)) + ', hosts ' + f0(d(OUT_HOST)) + ', pings ' +
    f0(d(OUT_PING)) + ', pongs ' + f0(d(OUT_PONG)) + ') in ' + f0(d(OUT_WRITES)) + ' writes/s'
  );
}

/** mix.rs of_host: the kind of a host's message (its source at [4..8]); roam and online: the hub's and the Online
 *  server's addresses, or null */
export function ofHost(data, roam, online) {
  const src = data.length >= 8 ? ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0 : null;
  if (src !== null && roam != null && src === roam >>> 0) {
    return data.length > 16 + 5 && data[0] === KIND_UDP && isN2fr(data) ? HUB + roamType(data) : HUB;
  } else if (src !== null && online != null && src === online >>> 0) {
    return ONLINE;
  }
  return OTHER_HOST;
}

/** mix.rs line: the count's line: the kinds by their bytes since was, the largest first, those of at least 0.5 % of all
 *  (and how many fell under that).  now and was: bytes of each kind, then entries of each (2 * KINDS; was may be
 *  shorter); null when nothing went. */
export function line(now, was, secs) {
  if (now.length < 2 * KINDS) throw new RangeError('line: 2 * KINDS counts'); // Rust: an index panic
  const d = (i) => satSub(now[i], i < was.length ? was[i] : 0);
  let total = 0;
  for (let i = 0; i < KINDS; i++) total += d(i);
  if (!Number.isSafeInteger(total)) throw new RangeError('line: a total past 2^53');
  if (total === 0) return null;
  const ks = [];
  for (let i = 0; i < KINDS; i++) if (d(i) > 0) ks.push(i);
  // sort_by_key(Reverse): stable, the largest first (Array.prototype.sort is stable)
  ks.sort((a, b) => d(b) - d(a));
  const s = fmax(secs, 1.0);
  const shown = [];
  for (const i of ks) {
    if (!(d(i) * 200 >= total)) continue;
    const b = d(i), n = Math.max(d(KINDS + i), 1);
    shown.push(name(i) + ' ' + f0((b * 100.0) / total) + ' % (' + f1((b * 8.0) / s / 1e6) + ' Mbit/s, ' + f0(n / s) + '/s, ' + f1(b / n) + ' B each)');
  }
  const rest = ks.length - shown.length;
  return f1((total * 8.0) / s / 1e6) + ' Mbit/s: ' + shown.join(', ') + (rest > 0 ? ', ' + String(rest) + ' smaller kinds' : '');
}
