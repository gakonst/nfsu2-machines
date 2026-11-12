// The lobby protocol's framing (crates/online/src/aries.rs): EA DirtySock "ProtoAries".
//  [0..3] kind (4 ASCII), [4..7] code (0, an error tag or a subkind), [8..11] u32 BE the whole length, [12..] the
//  body: KEY=VALUE fields, NUL-terminated.  Values written as the game writes them (%xx escapes, quotes around a
//  value with a space); PASS, REGKEY and PSES never decoded (SECRET_KEYS).
//
// Fields here: an array of [key, value], value a string, a number (written as String(x)) or null/undefined (left out).

import { latin1Encode, latin1Decode, q } from './jsx.js';

export const SECRET_KEYS = ['PASS', 'REGKEY', 'PSES'];
export const HDR = 12;
export const MAX_FRAME = 8192;

const HEXD = '0123456789abcdef';
const HEXB = [...HEXD].map((c) => c.charCodeAt(0));

function special(c) {
  return c === 0x3d || c === 0x22 || c === 0x3a || c === 0x25 || c === 0x5e || c === 0x7f;
}

/** a value as the client writes one, appended to out (bytes) */
export function encodeValue(v, out) {
  const b = [];
  if (typeof v === 'number') latin1Encode(String(v), b);
  else if (v === null || v === undefined) latin1Encode('null', b);
  else latin1Encode(String(v), b);
  const quote = b.includes(0x20);
  if (quote) out.push(0x22);
  for (const c of b) {
    if (c < 0x20 || special(c)) out.push(0x25, HEXB[c >> 4], HEXB[c & 15]);
    else out.push(c);
  }
  if (quote) out.push(0x22);
}

/** /^[A-Za-z0-9_+@$~]{1,32}$/ */
function goodKey(k) {
  return /^[A-Za-z0-9_+@$~]{1,32}$/.test(k);
}

function encodeFieldsInto(fields, sep, out) {
  for (const [k, v] of fields) {
    if (v === null || v === undefined) continue;
    if (!goodKey(k)) throw new Error('bad field name ' + q(k));
    latin1Encode(k, out);
    out.push(0x3d);
    encodeValue(v, out);
    out.push(sep);
  }
}

/** a body "K=V<sep>..." (no NUL) as bytes (an array); throws on a bad field name */
export function encodeFields(fields, sep = 0x0a) {
  const out = [];
  encodeFieldsInto(fields, sep, out);
  return out;
}

/** the length of encodeFields(fields) (0 when a name is bad, as Rust's fit) */
export function fieldsLen(fields) {
  try {
    return encodeFields(fields).length;
  } catch {
    return 0;
  }
}

function tag4(t, what, out) {
  const b = latin1Encode(t, []);
  if (b.length > 4) throw new Error(what + ' ' + q(t) + ' is longer than 4 characters');
  while (b.length < 4) b.push(0);
  out.push(...b);
}

/** one message (code '' = 0), fields separated by newlines: a Uint8Array; throws on a bad name, kind or code */
export function encodeFrame(kind, code, fields, sep = 0x0a) {
  const f = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  encodeFieldsInto(fields, sep, f);
  f.push(0);
  const tags = [];
  tag4(kind, 'kind', tags);
  tag4(code, 'code', tags);
  for (let i = 0; i < 8; i++) f[i] = tags[i];
  const n = f.length;
  f[8] = (n >>> 24) & 255;
  f[9] = (n >>> 16) & 255;
  f[10] = (n >>> 8) & 255;
  f[11] = n & 255;
  return Uint8Array.from(f);
}

/** one message of a ready body (latin1 text, without its NUL) */
export function encodeFrameText(kind, code, text) {
  const f = [];
  tag4(kind, 'kind', f);
  tag4(code, 'code', f);
  f.push(0, 0, 0, 0);
  latin1Encode(text, f);
  f.push(0);
  const n = f.length;
  f[8] = (n >>> 24) & 255;
  f[9] = (n >>> 16) & 255;
  f[10] = (n >>> 8) & 255;
  f[11] = n & 255;
  return Uint8Array.from(f);
}

/** a 4-byte tag as text: printable kept, NULs dropped, anything else as \xNN */
export function tagText(b, from) {
  let s = '';
  for (let i = from; i < from + 4; i++) {
    const c = b[i];
    if (c === 0) continue;
    if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
    else s += '\\x' + HEXD[c >> 4] + HEXD[c & 15];
  }
  return s;
}

/** The messages in a byte stream: push returns the complete ones; a length below 12 or above max makes the stream
 *  bad (error set, nothing more returned). */
export class FrameReader {
  constructor(max = MAX_FRAME) {
    this.max = max;
    this.buf = new Uint8Array(0);
    this.error = null;
  }
  push(chunk) {
    const out = [];
    if (this.error !== null) return out;
    let buf;
    if (this.buf.length === 0) buf = chunk;
    else {
      buf = new Uint8Array(this.buf.length + chunk.length);
      buf.set(this.buf, 0);
      buf.set(chunk, this.buf.length);
    }
    let pos = 0;
    // bounded: each round takes at least HDR bytes
    while (buf.length - pos >= HDR) {
      const n = ((buf[pos + 8] << 24) | (buf[pos + 9] << 16) | (buf[pos + 10] << 8) | buf[pos + 11]) >>> 0;
      if (n < HDR || n > this.max) {
        this.error = 'a message of ' + n + ' bytes (at most ' + this.max + ')';
        this.buf = new Uint8Array(0);
        return out;
      }
      if (buf.length - pos < n) break;
      out.push({ kind: tagText(buf, pos), code: tagText(buf, pos + 4), body: buf.slice(pos + HDR, pos + n) });
      pos += n;
    }
    this.buf = pos === buf.length ? new Uint8Array(0) : buf.slice(pos);
    return out;
  }
  pending() {
    return this.buf.length;
  }
}

function hexDigit(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

/** each %xx as the character xx; any other % stays (b: bytes, from..to) */
function unescape(b, from, to) {
  let s = '';
  let i = from;
  while (i < to) {
    if (b[i] === 0x25 && i + 2 < to) {
      const h = hexDigit(b[i + 1]), l = hexDigit(b[i + 2]);
      if (h >= 0 && l >= 0) {
        s += String.fromCharCode(h * 16 + l);
        i += 3;
        continue;
      }
    }
    s += String.fromCharCode(b[i]);
    i++;
  }
  return s;
}

/** The fields of a body, in order, keys upper-cased; a key skip(k) says yes to is passed over without its value
 *  decoded (value null).  Text after the first NUL is ignored.  [[key, value|null], ...] */
export function parseFields(b, skip) {
  let end = b.indexOf(0);
  if (end < 0) end = b.length;
  const out = [];
  let i = 0;
  while (i < end) {
    while (i < end && b[i] <= 0x20) i++;
    if (i >= end) break;
    let k = i;
    while (k < end && b[k] > 0x20 && b[k] !== 0x3d) k++;
    if (k >= end || b[k] !== 0x3d) {
      i = k;
      continue;
    }
    const key = latin1Decode(b, i, k).toUpperCase();
    const j = k + 1;
    let raw;
    if (j < end && b[j] === 0x22) {
      let qq = j + 1;
      while (qq < end && b[qq] !== 0x22) qq++;
      raw = skip(key) ? null : [j + 1, qq];
      i = qq + 1;
    } else {
      let qq = j;
      while (qq < end && b[qq] > 0x20) qq++;
      raw = skip(key) ? null : [j, qq];
      i = qq;
    }
    out.push([key, raw === null ? null : unescape(b, raw[0], raw[1])]);
  }
  return out;
}

export const isSecret = (k) => SECRET_KEYS.includes(k);

/** parseFields as a map (the first of a repeated key wins), in the order the keys came */
export class FieldMap {
  constructor(m = new Map()) {
    this.m = m;
  }
  static parse(body) {
    return FieldMap.parseWith(body, isSecret);
  }
  static parseWith(body, skip) {
    const m = new Map();
    for (const [k, v] of parseFields(body, skip)) if (!m.has(k)) m.set(k, v);
    return new FieldMap(m);
  }
  /** a field's value: null when missing or skipped */
  get(k) {
    const v = this.m.get(k);
    return v === undefined ? null : v;
  }
  has(k) {
    return this.m.has(k);
  }
  /** '' when missing or skipped */
  str(k) {
    const v = this.m.get(k);
    return v === undefined || v === null ? '' : v;
  }
  /** Number(text); def when missing; 0 when skipped */
  num(k, def) {
    if (!this.m.has(k)) return def;
    const v = this.m.get(k);
    return v === null ? 0 : Number(v);
  }
  /** a copy (a timer keeps one) */
  clone() {
    return new FieldMap(new Map(this.m));
  }
}

/** keys a trace must not show: /^(PASS\w*|REGKEY|PSES|LKEY)$/ on the upper-cased key */
function redacted(k) {
  return k === 'REGKEY' || k === 'PSES' || k === 'LKEY' || /^PASS[A-Za-z0-9_]*$/.test(k);
}

/** a body as one printable line for the dev-only trace, every secret replaced */
export function redactBody(body) {
  return parseFields(body, redacted)
    .map(([k, v]) => k + '=' + (v === null ? '<redacted>' : q(v)))
    .join(' ');
}

