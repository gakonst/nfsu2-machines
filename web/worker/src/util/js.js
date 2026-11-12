// Text and numbers the way JavaScript makes them: a port of web/server-rs/crates/util/src/js.rs (and lib.rs vip_str).
// The Rust code emulates JavaScript; here the JavaScript built-ins are used where they are what the Rust emulates
// (Number#toString, Number#toFixed), and the Rust's own rules where it fixes them (its \s set, not the runtime's).

/** util/src/js.rs is_space: JS \s and what String#trim() removes (WhiteSpace and LineTerminator, ECMA-262), as a
 * fixed set of code points (not the runtime's Unicode) */
export function isSpace(cp) {
  return (cp >= 0x09 && cp <= 0x0D) || cp === 0x20 || cp === 0xA0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) ||
    cp === 0x2028 || cp === 0x2029 || cp === 0x202F || cp === 0x205F || cp === 0x3000 || cp === 0xFEFF;
}

/** util/src/js.rs trim: JS String#trim() (every \s character is one UTF-16 unit) */
export function trim(s) {
  let a = 0, b = s.length;
  while (a < b && isSpace(s.charCodeAt(a))) a++;
  while (b > a && isSpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** util/src/js.rs collapse_space: JS s.replace(/\s+/g, rep) */
export function collapseSpace(s, rep) {
  let out = '', inSpace = false, from = 0;
  for (let i = 0; i < s.length; i++) {
    if (isSpace(s.charCodeAt(i))) {
      if (!inSpace) out += s.slice(from, i) + rep;
      inSpace = true;
      from = i + 1;
    } else {
      inSpace = false;
    }
  }
  return out + s.slice(from);
}

/** util/src/js.rs utf16_len: JS s.length */
export function utf16Len(s) {
  return s.length;
}

/** util/src/js.rs printable: every UTF-16 unit outside printable ASCII a '?', at most n of them
 * (String(x).replace(/[^\x20-\x7e]/g, '?').slice(0, n): what the Rust emulates) */
export function printable(s, n) {
  if (!(Number.isInteger(n) && n >= 0)) throw new RangeError('printable: n must be a whole number');
  return String(s).slice(0, n).replace(/[^\x20-\x7e]/g, '?');
}

/** util/src/js.rs number_to_string: JS Number#toString() (radix 10), which the Rust emulates */
export function numberToString(x) {
  return String(x);
}

/** util/src/js.rs to_fixed: JS Number#toFixed(digits), digits past 100 taken as 100 (a RangeError in JS) */
export function toFixed(x, digits) {
  if (!(Number.isInteger(digits) && digits >= 0)) throw new RangeError('toFixed: digits must be a whole number');
  return x.toFixed(Math.min(digits, 100));
}

/** util/src/js.rs utc_parts: [year, month 1-12, day 1-31, hours, minutes, seconds, ms] of a UTC time in ms (any
 * integer ms; Howard Hinnant's civil_from_days, as the Rust: no RangeError past JS's dates) */
export function utcParts(ms) {
  if (!Number.isSafeInteger(ms)) throw new RangeError('utcParts: ms must be a safe integer');
  const days = Math.floor(ms / 86400000);
  const rem = ms - days * 86400000;
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.trunc((doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36524) - Math.trunc(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const d = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d, Math.trunc(rem / 3600000), Math.trunc(rem / 60000) % 60, Math.trunc(rem / 1000) % 60, rem % 1000];
}

const pad = (x, n) => String(x).padStart(n, '0');

/** util/src/js.rs iso_string: JS new Date(ms).toISOString() ("2026-10-21T06:55:40.123Z"; years past 0-9999 as
 * +/-YYYYYY, and no RangeError: as the Rust) */
export function isoString(ms) {
  const [y, m, d, h, mi, s, msec] = utcParts(ms);
  const tail = '-' + pad(m, 2) + '-' + pad(d, 2) + 'T' + pad(h, 2) + ':' + pad(mi, 2) + ':' + pad(s, 2) + '.' + pad(msec, 3) + 'Z';
  if (y >= 0 && y <= 9999) return pad(y, 4) + tail;
  return (y < 0 ? '-' : '+') + pad(Math.abs(y), 6) + tail;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** util/src/js.rs base64url: Node's Buffer#toString('base64url') (no padding) of a Uint8Array */
export function base64url(b) {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64URL[v >> 18] + B64URL[(v >> 12) & 63] + B64URL[(v >> 6) & 63] + B64URL[v & 63];
  }
  if (b.length - i === 1) {
    const v = b[i] << 16;
    out += B64URL[v >> 18] + B64URL[(v >> 12) & 63];
  } else if (b.length - i === 2) {
    const v = (b[i] << 16) | (b[i + 1] << 8);
    out += B64URL[v >> 18] + B64URL[(v >> 12) & 63] + B64URL[(v >> 6) & 63];
  }
  return out;
}

/** util/src/js.rs from_base64url: Node's Buffer.from(s, 'base64url'), lenient as Node is: padding and characters
 * outside the alphabet skipped, '+' and '/' read as '-' and '_', a last group of one character dropped, the bits
 * past the last whole byte ignored.  A Uint8Array. */
export function fromBase64url(s) {
  const vals = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let v = -1;
    if (c >= 65 && c <= 90) v = c - 65;
    else if (c >= 97 && c <= 122) v = c - 71;
    else if (c >= 48 && c <= 57) v = c + 4;
    else if (c === 45 || c === 43) v = 62;
    else if (c === 95 || c === 47) v = 63;
    if (v >= 0) vals.push(v);
  }
  const n = vals.length % 4 === 1 ? vals.length - 1 : vals.length;
  const out = new Uint8Array(Math.floor(n * 6 / 8));
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < n; i++) {
    acc = ((acc << 6) | vals[i]) & 0xFFFFFF;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  if (o !== out.length) throw new Error('fromBase64url: byte count');
  return out;
}

/** util/src/lib.rs vip_str: "10.77.0.1" for 0x0A4D0001 */
export function vipStr(v) {
  return (v >>> 24) + '.' + ((v >>> 16) & 255) + '.' + ((v >>> 8) & 255) + '.' + (v & 255);
}

