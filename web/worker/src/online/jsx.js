// The JavaScript rules the online host keeps (crates/online/src/jsx.rs, nfsu2_util::js): the Rust server emulated
// Node's; here they are Node's own (Number(), | 0, >>> 0, Math.round, String(x), toLowerCase ...), plus the few
// helpers written out by hand: latin1 buffers, slices in UTF-16 code units, names and text.

/** a failed assertion: a bug of this code, never of the input */
export function assert(cond, what) {
  if (!cond) throw new Error('assertion failed: ' + (what || '?'));
}

/** JS Number(s) of a field's text (jsx::to_number) */
export const toNumber = (s) => Number(s);
/** ToInt32 (x | 0) */
export const toInt32 = (x) => x | 0;
/** ToUint32 (x >>> 0) */
export const toUint32 = (x) => x >>> 0;
/** Math.round */
export const round = (x) => Math.round(x);
/** Number#toString (js::number_to_string) */
export const numStr = (x) => String(x);

/** Buffer.from(s, 'latin1'): the low byte of each UTF-16 code unit, appended to out (an array of bytes) */
export function latin1Encode(s, out) {
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 255);
  return out;
}

/** latin1 bytes of a string as a Uint8Array */
export function latin1Bytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

/** buf.toString('latin1'): each byte a character */
export function latin1Decode(b, from = 0, to = b.length) {
  let s = '';
  for (let i = from; i < to; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(to, i + 8192)));
  return s;
}

/** s.slice(0, n) in UTF-16 code units; a surrogate pair the cut would split is left out (jsx::slice16) */
export function slice16(s, n) {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  if (n > 0 && c >= 0xd800 && c <= 0xdbff) {
    const d = s.charCodeAt(n);
    if (d >= 0xdc00 && d <= 0xdfff) return s.slice(0, n - 1);
  }
  return s.slice(0, n);
}

/** a persona or account name the game lets one type: letters, digits, - and _, 3 to 15 */
export function validName(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{3,15}$/.test(s);
}

/** text another player will see: NFC, control and format characters as spaces, white space collapsed and trimmed,
 *  at most max code points (jsx::clean_text) */
export function cleanText(s, max) {
  const t = s.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  let out = '', n = 0;
  for (const c of t) {
    if (n >= max) break;
    out += c;
    n++;
  }
  return out;
}

/** the name before a "@domain" or "/resource": the pattern [@/].*$ cut off */
export function stripAt(s) {
  return s.replace(/[@/].*$/, '');
}

export const lower = (s) => s.toLowerCase();

function utc(t) {
  return new Date(Math.trunc(t));
}
/** "2026.1.5" (UTC, no leading zeros) */
export function day(t) {
  const d = utc(t);
  return d.getUTCFullYear() + '.' + (d.getUTCMonth() + 1) + '.' + d.getUTCDate();
}
/** "2026-01" (UTC) */
export function monthOf(t) {
  const d = utc(t);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
/** a month as the files keep it */
export function isMonth(s) {
  return typeof s === 'string' && /^[0-9]{4}-[0-9]{2}$/.test(s);
}

const H = '0123456789abcdef';
/** lowercase hex of bytes */
export function hex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += H[b[i] >> 4] + H[b[i] & 15];
  return s;
}

/** UTF-8 bytes of a string (Rust's str::as_bytes) */
const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(s);

/** Rust's str ordering (by UTF-8 bytes = by code points), for sorts: -1, 0, 1 */
export function cmpStr(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.codePointAt(i), y = b.codePointAt(i);
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** JSON.stringify of a string (json::write_str) */
export const q = (s) => JSON.stringify(s);

/** "10.77.0.1" */
export function vipStr(v) {
  return (v >>> 24) + '.' + ((v >>> 16) & 255) + '.' + ((v >>> 8) & 255) + '.' + (v & 255);
}

/** Number#toFixed as Rust's js::to_fixed (JS's own: half up on the exact value) */
export const toFixed = (x, d) => x.toFixed(Math.min(d, 100));

/** Rust's {:.0} of an f64 (round half to even on the exact value), as the cheat lines write km/h and metres */
export function fmt0(x) {
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : x < 0 ? '-inf' : 'NaN';
  const f = Math.floor(x), r = x - f;
  let n = r > 0.5 ? f + 1 : r < 0.5 ? f : (f % 2 === 0 ? f : f + 1);
  if (n === 0 && (x < 0 || Object.is(x, -0))) return '-0';
  return String(n);
}

