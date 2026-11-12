// serde_json::from_slice into a serde_json::Value, as the Rust server's serde_json (1.0.154, features preserve_order,
// no float_roundtrip, no arbitrary_precision) reads it: what it takes and what it refuses, and the values it makes.
// A port of serde_json's src/de.rs and src/read.rs (SliceRead) for Value.
//
// Values are plain JS: null, true/false, numbers, strings, arrays, objects (made with Object.create(null): every key is
// data, "__proto__", "constructor" and "toString" too, and a missing key reads undefined).  How that differs from JSON.parse:
//  - refused here and taken by JSON.parse: numbers that overflow a double (1e400; serde_json's NumberOutOfRange),
//    nesting deeper than 127 arrays/objects (RecursionLimitExceeded), a lone surrogate escape ("\ud800")
//  - numbers: serde_json without float_roundtrip reads a decimal as its first 19-20 significant digits (a u64) times
//    a power of ten, by f64 multiplication or division: not always the double nearest the text (JSON.parse's).
//    This port does the same arithmetic, so the double is the Rust one, bit for bit.  An integer serde_json keeps
//    exactly as a u64 or i64 past 2^53 is the nearest double here (what its as_f64() gives; the Rust server reads
//    numbers only through as_f64, safe_integer, is_num and js_string, which all see that double).  "-0" is -0.
//  - objects: a duplicate key keeps its first place and takes the last value (IndexMap::insert; JSON.parse the
//    same); a "__proto__" key is a plain own key.  Keys that are array indices ("0", "17") come first in a JS
//    object's key order, ascending, wherever they were in the text; serde_json keeps the text's order.
//  - text: the bytes must be UTF-8 inside strings (anything else outside strings is a syntax error anyway); a BOM is
//    refused (no whitespace but space, tab, CR, LF); trailing whitespace is fine, anything else after the value not.

/** the failure thrown inside the parser (caught in fromSlice) */
const FAIL = Object.freeze({ fail: true });
const U64_MAX = (1n << 64n) - 1n;
const I32_MAX = 2147483647, I32_MIN = -2147483648;
/** serde_json's POW10: 1e0 to 1e308 as f64 literals (correctly rounded, as JS's) */
const POW10 = Array.from({ length: 309 }, (_, i) => Number('1e' + i));
/** serde_json's starting remaining_depth (de.rs Deserializer::new) */
const DEPTH = 128;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const fail = () => {
  throw FAIL;
};

/** i32 saturating add, as Rust's i32::saturating_add */
const satAdd = (a, b) => Math.max(I32_MIN, Math.min(I32_MAX, a + b));

/** overflow!(a * 10 + b, u64::MAX) of de.rs, on a BigInt */
const overflowU64 = (a, d) => a >= U64_MAX / 10n && (a > U64_MAX / 10n || BigInt(d) > U64_MAX % 10n);

class Parser {
  /** @param {Uint8Array} b */
  constructor(b) {
    this.b = b;
    this.i = 0;
    this.depth = DEPTH;
  }

  /** the next byte, -1 at the end (peek_or_null reads 0 there: no byte of the grammar is 0 or -1) */
  peek() {
    return this.i < this.b.length ? this.b[this.i] : -1;
  }

  /** de.rs parse_whitespace: the next byte after space, LF, TAB, CR; -1 at the end */
  ws() {
    const b = this.b;
    while (this.i < b.length) {
      const c = b[this.i];
      if (c !== 0x20 && c !== 0x0A && c !== 0x09 && c !== 0x0D) return c;
      this.i++;
    }
    return -1;
  }

  /** de.rs Deserializer::end: only whitespace left */
  end() {
    if (this.ws() !== -1) fail();
  }

  /** de.rs parse_ident */
  ident(s) {
    for (let k = 0; k < s.length; k++) {
      if (this.peek() !== s.charCodeAt(k)) fail();
      this.i++;
    }
  }

  /** de.rs deserialize_any for Value */
  value() {
    const c = this.ws();
    switch (c) {
      case 0x6E: this.i++; this.ident('ull'); return null;
      case 0x74: this.i++; this.ident('rue'); return true;
      case 0x66: this.i++; this.ident('alse'); return false;
      case 0x2D: this.i++; return this.integer(false);
      case 0x22: this.i++; return this.str();
      case 0x5B: {
        if (--this.depth === 0) fail();
        this.i++;
        const a = this.seq();
        this.depth++;
        return a;
      }
      case 0x7B: {
        if (--this.depth === 0) fail();
        this.i++;
        const o = this.map();
        this.depth++;
        return o;
      }
      default:
        if (c >= 0x30 && c <= 0x39) return this.integer(true);
        return fail();
    }
  }

  /** SeqAccess for Value, then end_seq */
  seq() {
    const a = [];
    for (let first = true; ; first = false) {
      const c = this.ws();
      if (c === -1) fail();
      if (c === 0x5D) break;
      if (!first) {
        if (c !== 0x2C) fail();
        this.i++;
        const d = this.ws();
        if (d === 0x5D || d === -1) fail(); // a trailing comma, or the end
      }
      a.push(this.value());
    }
    this.i++; // the ]
    return a;
  }

  /** MapAccess for Value (keys are strings; a later duplicate's value replaces the first's, in its place), then
   * end_map; a null-prototype object */
  map() {
    const o = Object.create(null);
    for (let first = true; ; first = false) {
      const c = this.ws();
      if (c === -1) fail();
      if (c === 0x7D) break;
      if (!first) {
        if (c !== 0x2C) fail();
        this.i++;
        if (this.ws() !== 0x22) fail(); // a trailing comma, the end, or a key that is no string
      } else if (c !== 0x22) {
        fail();
      }
      this.i++;
      const k = this.str();
      if (this.ws() !== 0x3A) fail(); // parse_object_colon
      this.i++;
      const v = this.value();
      o[k] = v;
    }
    this.i++; // the }
    return o;
  }

  /** read.rs SliceRead::parse_str (validate: control characters refused, \u surrogates paired, the bytes UTF-8):
   * after the opening quote */
  str() {
    const b = this.b;
    let out = '', start = this.i;
    for (;;) {
      if (this.i >= b.length) fail();
      const c = b[this.i];
      if (c === 0x22) {
        out += this.decode(start, this.i);
        this.i++;
        return out;
      }
      if (c < 0x20) fail();
      if (c !== 0x5C) {
        this.i++;
        continue;
      }
      out += this.decode(start, this.i);
      this.i++;
      if (this.i >= b.length) fail();
      const e = b[this.i++];
      switch (e) {
        case 0x22: out += '"'; break;
        case 0x5C: out += '\\'; break;
        case 0x2F: out += '/'; break;
        case 0x62: out += '\b'; break;
        case 0x66: out += '\f'; break;
        case 0x6E: out += '\n'; break;
        case 0x72: out += '\r'; break;
        case 0x74: out += '\t'; break;
        case 0x75: out += this.unicodeEscape(); break;
        default: fail();
      }
      start = this.i;
    }
  }

  /** the raw bytes b[a..e) of a string: UTF-8, else the string is refused */
  decode(a, e) {
    if (a === e) return '';
    const b = this.b;
    let ascii = true;
    for (let k = a; k < e; k++) if (b[k] >= 0x80) { ascii = false; break; }
    if (ascii) return String.fromCharCode.apply(null, b.subarray(a, e));
    try {
      return utf8.decode(b.subarray(a, e));
    } catch {
      return fail();
    }
  }

  /** read.rs decode_hex_escape: four hex digits */
  hex4() {
    const b = this.b;
    if (this.i + 4 > b.length) fail();
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const c = b[this.i + k];
      let d;
      if (c >= 0x30 && c <= 0x39) d = c - 0x30;
      else if (c >= 0x41 && c <= 0x46) d = c - 0x37;
      else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
      else fail();
      n = n * 16 + d;
    }
    this.i += 4;
    return n;
  }

  /** read.rs parse_unicode_escape with validate: a trailing surrogate on its own, a leading one not followed by a
   * \u trailing one, are refused */
  unicodeEscape() {
    const n = this.hex4();
    if (n >= 0xDC00 && n <= 0xDFFF) fail();
    if (n < 0xD800 || n > 0xDBFF) return String.fromCharCode(n);
    if (this.peek() !== 0x5C) fail();
    this.i++;
    if (this.peek() !== 0x75) fail();
    this.i++;
    const n2 = this.hex4();
    if (n2 < 0xDC00 || n2 > 0xDFFF) fail();
    return String.fromCharCode(n, n2);
  }

  /** de.rs parse_integer (after a '-' for a negative one) and parse_number */
  integer(positive) {
    const b = this.b;
    const c = this.peek();
    if (c === -1) fail();
    this.i++;
    let sig;
    if (c === 0x30) {
      const d = this.peek();
      if (d >= 0x30 && d <= 0x39) fail(); // only one leading 0
      sig = 0n;
    } else if (c >= 0x31 && c <= 0x39) {
      // digits as a Number while they stay exact, then as a BigInt
      let small = c - 0x30;
      while (this.i < b.length && b[this.i] >= 0x30 && b[this.i] <= 0x39 && small < 1e14) small = small * 10 + (b[this.i++] - 0x30);
      sig = BigInt(small);
      for (;;) {
        const d = this.peek();
        if (!(d >= 0x30 && d <= 0x39)) break;
        if (overflowU64(sig, d - 0x30)) return this.longInteger(positive, sig);
        this.i++;
        sig = sig * 10n + BigInt(d - 0x30);
      }
    } else {
      return fail();
    }
    const d = this.peek();
    if (d === 0x2E) return this.decimal(positive, sig, 0);
    if (d === 0x65 || d === 0x45) return this.exponent(positive, sig, 0);
    // U64, I64, or F64 for -0 and below i64::MIN: all of them this double
    const f = Number(sig);
    return positive ? f : -f;
  }

  /** de.rs parse_decimal: at the '.' */
  decimal(positive, sig, exponentBefore) {
    this.i++;
    let after = 0;
    for (;;) {
      const c = this.peek();
      if (!(c >= 0x30 && c <= 0x39)) break;
      if (overflowU64(sig, c - 0x30)) return this.decimalOverflow(positive, sig, exponentBefore + after);
      this.i++;
      sig = sig * 10n + BigInt(c - 0x30);
      after--;
    }
    if (after === 0) fail(); // a digit after the point
    const e = exponentBefore + after;
    const c = this.peek();
    if (c === 0x65 || c === 0x45) return this.exponent(positive, sig, e);
    return this.fromParts(positive, sig, e);
  }

  /** de.rs parse_exponent: at the 'e' */
  exponent(positive, sig, startingExp) {
    this.i++;
    let positiveExp = true;
    const s = this.peek();
    if (s === 0x2B) this.i++;
    else if (s === 0x2D) {
      this.i++;
      positiveExp = false;
    }
    const c = this.peek();
    if (!(c >= 0x30 && c <= 0x39)) fail();
    this.i++;
    let exp = c - 0x30;
    for (;;) {
      const d = this.peek();
      if (!(d >= 0x30 && d <= 0x39)) break;
      this.i++;
      const digit = d - 0x30;
      if (exp >= 214748364 && (exp > 214748364 || digit > 7)) return this.exponentOverflow(positive, sig === 0n, positiveExp);
      exp = exp * 10 + digit;
    }
    return this.fromParts(positive, sig, positiveExp ? satAdd(startingExp, exp) : satAdd(startingExp, -exp));
  }

  /** de.rs parse_exponent_overflow: an error instead of +/- infinity, else zero */
  exponentOverflow(positive, zeroSignificand, positiveExp) {
    if (!zeroSignificand && positiveExp) fail();
    this.skipDigits();
    return positive ? 0 : -0;
  }

  /** de.rs parse_long_integer (no float_roundtrip): the digits past a u64 only count */
  longInteger(positive, sig) {
    let exponent = 0;
    for (;;) {
      const c = this.peek();
      if (c >= 0x30 && c <= 0x39) {
        this.i++;
        exponent++;
      } else if (c === 0x2E) {
        return this.decimal(positive, sig, exponent);
      } else if (c === 0x65 || c === 0x45) {
        return this.exponent(positive, sig, exponent);
      } else {
        return this.fromParts(positive, sig, exponent);
      }
    }
  }

  /** de.rs parse_decimal_overflow (no float_roundtrip): the digits past a u64 ignored */
  decimalOverflow(positive, sig, exponent) {
    this.skipDigits();
    const c = this.peek();
    if (c === 0x65 || c === 0x45) return this.exponent(positive, sig, exponent);
    return this.fromParts(positive, sig, exponent);
  }

  skipDigits() {
    const b = this.b;
    while (this.i < b.length && b[this.i] >= 0x30 && b[this.i] <= 0x39) this.i++;
  }

  /** de.rs f64_from_parts (no float_roundtrip): the significand as a double times or over a power of ten; an
   * error where that overflows */
  fromParts(positive, sig, exponent) {
    let f = Number(sig);
    for (let guard = 0; ; guard++) {
      if (guard > 8) throw new Error('serde-json: f64_from_parts did not end');
      // exponent.wrapping_abs() as usize: i32::MIN stays past the table
      const idx = exponent === I32_MIN ? Infinity : Math.abs(exponent);
      if (idx <= 308) {
        if (exponent >= 0) {
          f *= POW10[idx];
          if (!Number.isFinite(f)) fail();
        } else {
          f /= POW10[idx];
        }
        break;
      }
      if (f === 0) break;
      if (exponent >= 0) fail();
      f /= 1e308;
      exponent += 308;
    }
    return positive ? f : -f;
  }
}

/**
 * serde_json::from_slice::<Value>(b): {ok: true, value} or {ok: false} for text serde_json refuses.
 * @param {Uint8Array} b
 */
export function fromSlice(b) {
  if (!(b instanceof Uint8Array)) throw new TypeError('fromSlice: a Uint8Array');
  const p = new Parser(b);
  try {
    const value = p.value();
    p.end();
    return { ok: true, value };
  } catch (e) {
    if (e === FAIL) return { ok: false };
    throw e;
  }
}

/** UTF-8 of a string (a lone surrogate as U+FFFD, as TextEncoder does) */
export function utf8Bytes(s) {
  return new TextEncoder().encode(s);
}

/** serde_json::from_str::<Value>(s), as fromSlice of its UTF-8 */
export function fromStr(s) {
  return fromSlice(utf8Bytes(s));
}

/** b is UTF-8 (std::str::from_utf8(b).is_ok()) */
export function isUtf8(b) {
  try {
    utf8.decode(b);
    return true;
  } catch {
    return false;
  }
}

