// Names, addresses, tokens and the JSON of the control messages, read the way JavaScript reads them (as the Node
// server did): a port of web/server-rs/crates/lan/src/text.rs.

import { blockedName } from '../names/index.js';
import { base64url, collapseSpace, numberToString, trim, utf16Len } from '../util/js.js';
import { fromSlice, isUtf8, utf8Bytes } from '../util/serde-json.js';
import { sha256 } from '../util/sha256.js';
import { isControlOrFormat, normalizeAsRust } from '../util/unicode.js';

/** lan/src/lib.rs BASE: 10.77.0.0 */
const BASE = ((10 << 24) | (77 << 16)) >>> 0;
/** lan/src/lib.rs NETS: the third bytes the switch hands out (10.77.0-95.x) */
const NETS = 96;

/** lan/src/lib.rs slot: the address's slot, or -1 (none) */
function slot(vip) {
  const host = vip & 255;
  const net = (vip >>> 8) & 255;
  if (((vip & 0xFFFF0000) >>> 0) !== BASE || net >= NETS || !(host >= 2 && host <= 251)) return -1;
  return net + NETS * (host - 2);
}

/**
 * lan/src/text.rs clean_name: a display name: printable, no bidi or zero-width tricks (control and format characters
 * removed), at most 32 characters, none that reads as a slur (names/index.js blockedName): "player" then.
 * A lone surrogate reads as U+FFFD (the Rust's string is UTF-8).
 */
export function cleanName(s) {
  s = String(s ?? '');
  if (!s.isWellFormed()) s = s.toWellFormed();
  // NFC; each run of white space (JavaScript's \s) one space; control and format characters (Cc, Cf) out; each run
  // of spaces one space; trimmed
  const nfc = nfcAsNode(s);
  const spaced = collapseSpace(nfc, ' ');
  let t = '', space = false;
  for (const ch of spaced) {
    if (isControlOrFormat(ch.codePointAt(0))) continue;
    if (ch === ' ') {
      if (!space) t += ' ';
      space = true;
    } else {
      t += ch;
      space = false;
    }
  }
  // at most 32 code points (not UTF-16 units), trimmed again
  let first = '', n = 0;
  for (const ch of trim(t)) {
    if (n++ === 32) break;
    first += ch;
  }
  const name = trim(first);
  return name !== '' && !blockedName(name) ? name : 'player';
}

/** lan/src/text.rs nfc_as_node: NFC as Node 24 did it for the Node server (Unicode 16): a character unassigned in
 * the Rust's tables stays where it is and the text on either side is normalized on its own */
function nfcAsNode(s) {
  return normalizeAsRust(s, 'NFC');
}

/** lan/src/text.rs vip_num: an address the switch hands out ("10.77.x.y" in 10.77.0-95.x, host byte 2-251) as a
 * u32, else 0 */
export function vipNum(s) {
  // /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, each part at most 255
  const parts = String(s).split('.');
  if (parts.length !== 4) return 0;
  let v = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return 0;
    const x = Number(part);
    if (x > 255) return 0;
    v = ((v << 8) | x) >>> 0;
  }
  return slot(v) >= 0 ? v : 0;
}

/** lan/src/text.rs js_string: JS String(x ?? '') of a parsed JSON value (undefined: none) */
export function jsString(v) {
  if (v === undefined || v === null) return '';
  return toJsString(v);
}

function toJsString(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return numberToString(v);
  if (typeof v === 'string') return v;
  // Array#toString: join(','), with null as ''
  if (Array.isArray(v)) return v.map(x => (x === null ? '' : toJsString(x))).join(',');
  if (typeof v === 'object') return '[object Object]';
  throw new TypeError('jsString: not a JSON value');
}

const RADIX = [['0x', 16], ['0X', 16], ['0o', 8], ['0O', 8], ['0b', 2], ['0B', 2]];

/** lan/src/text.rs to_number: JS +s of a string (the impairment's numbers): its whitespace trimmed, "" is 0,
 * 0x/0o/0b integers (summed digit by digit in doubles, as the Rust), a decimal (Rust's f64 parse, which reads the
 * same texts as JS's StrDecimalLiteral and rounds the same) */
export function toNumber(s) {
  const t = trim(String(s));
  if (t === '') return 0;
  for (const [p, radix] of RADIX) {
    if (!t.startsWith(p)) continue;
    const d = t.slice(p.length);
    let a = 0;
    if (d === '') return NaN;
    for (const c of d) {
      const x = digit(c, radix);
      if (x < 0) return NaN;
      a = a * radix + x;
    }
    return a;
  }
  if (t === 'Infinity' || t === '+Infinity') return Infinity;
  if (t === '-Infinity') return -Infinity;
  // JS's StrDecimalLiteral: digits, one dot, an exponent (Rust's parser also takes "inf", "nan": not here)
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(t)) return NaN;
  return Number(t);
}

/** char::to_digit(radix) for an ASCII digit or letter, -1 for none */
function digit(c, radix) {
  const x = c.charCodeAt(0);
  let v = -1;
  if (x >= 0x30 && x <= 0x39) v = x - 0x30;
  else if (x >= 0x61 && x <= 0x7A) v = x - 0x57;
  else if (x >= 0x41 && x <= 0x5A) v = x - 0x37;
  return c.length === 1 && v < radix ? v : -1;
}

/** lan/src/text.rs new_token: a new token (128 bits, base64url: 22 characters) that only its client sees, from the
 * injected PRNG (util/prng.js) where the Rust reads the OS's */
export function newToken(prng) {
  return base64url(prng.bytes(16));
}

/** lan/src/text.rs token_hash: SHA-256 of the token's UTF-8, a Uint8Array(32) */
export function tokenHash(t) {
  return sha256(utf8Bytes(String(t)));
}

/** lan/src/text.rs token_fits: token (from a client) matches hash (of the token the switch gave), compared in
 * constant time; one longer than 64 (UTF-16 units) never does */
export function tokenFits(token, hash) {
  if (!(hash instanceof Uint8Array) || hash.length !== 32) throw new TypeError('tokenFits: a 32-byte hash');
  token = String(token);
  if (utf16Len(token) > 64) return false;
  const h = tokenHash(token);
  let a = 0;
  for (let i = 0; i < 32; i++) a |= h[i] ^ hash[i];
  return a === 0;
}

/**
 * lan/src/text.rs parse_json: JSON.parse of a control message (bytes), as serde_json reads it (util/serde-json.js:
 * what it takes, refuses and makes; objects with a null prototype), null for None: the switch only takes an
 * object, so None and JSON's null need not differ (parseJsonOption tells them apart).  JS takes a lone surrogate
 * escape ("\ud800") in a string; serde_json does not: it is read as U+FFFD instead.
 * @param {Uint8Array} b
 */
export function parseJson(b) {
  const v = parseJsonOption(b);
  return v === undefined ? null : v;
}

/** lan/src/text.rs parse_json with None as undefined (JSON's null is null) */
export function parseJsonOption(b) {
  const r = fromSlice(b);
  if (r.ok) return r.value;
  if (!isUtf8(b)) return undefined;
  const fixed = loneSurrogates(b);
  if (fixed === null) return undefined;
  const r2 = fromSlice(fixed);
  return r2.ok ? r2.value : undefined;
}

const isHex = c => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const FFFD_ESCAPE = [0x5C, 0x75, 0x66, 0x66, 0x66, 0x64]; // \ufffd

/** lan/src/text.rs lone_surrogates: the text (UTF-8 bytes) with every lone surrogate escape as a replacement
 * character's escape, or null when it has none.  Like the Rust, it looks at every backslash of the text, in a
 * string or not. */
function loneSurrogates(b) {
  const hex = i => {
    if (i + 4 > b.length) return -1;
    let n = 0;
    for (let k = 0; k < 4; k++) {
      if (!isHex(b[i + k])) return -1;
      n = n * 16 + parseInt(String.fromCharCode(b[i + k]), 16);
    }
    return n;
  };
  const out = [];
  let changed = false, i = 0, last = 0;
  while (i < b.length) {
    if (b[i] !== 0x5C) {
      i++;
      continue;
    }
    if (b[i + 1] !== 0x75) {
      i += 2;
      continue;
    }
    const u = hex(i + 2);
    if (u < 0) {
      i += 2;
      continue;
    }
    if (u >= 0xD800 && u < 0xDC00) {
      const low = b[i + 6] === 0x5C && b[i + 7] === 0x75 ? hex(i + 8) : -1;
      if (low >= 0xDC00 && low < 0xE000) {
        i += 12;
        continue;
      }
    } else if (!(u >= 0xDC00 && u < 0xE000)) {
      i += 6;
      continue;
    }
    out.push(b.subarray(last, i), FFFD_ESCAPE);
    i += 6;
    last = i;
    changed = true;
  }
  if (!changed) return null;
  out.push(b.subarray(last));
  let n = 0;
  for (const p of out) n += p.length;
  const r = new Uint8Array(n);
  let o = 0;
  for (const p of out) {
    r.set(p, o);
    o += p.length;
  }
  return r;
}

