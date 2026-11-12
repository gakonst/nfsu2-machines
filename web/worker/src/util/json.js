// JSON.stringify of a parsed JSON value with the Rust server's rules: a port of web/server-rs/crates/util/src/json.rs.
// Values are plain JS (null, booleans, numbers, strings, arrays, objects): see serde-json.js for what a number is.

import { numberToString } from './js.js';

/** util/src/json.rs stringify: JSON.stringify(v), no spaces, keys in the object's order, numbers as JS writes them
 * (NaN and the infinities as null).  An integer past 2^53 that serde_json held exactly is a double here (see
 * serde-json.js): it is written as JS writes that double. */
export function stringify(v) {
  const out = [];
  writeValue(out, v, 0);
  return out.join('');
}

function writeValue(out, v, depth) {
  if (depth > 10000) throw new RangeError('stringify: nested too deep');
  if (v === null || v === undefined) out.push('null');
  else if (v === true) out.push('true');
  else if (v === false) out.push('false');
  else if (typeof v === 'number') out.push(Number.isFinite(v) ? numberToString(v) : 'null');
  else if (typeof v === 'string') out.push(writeStr(v));
  else if (Array.isArray(v)) {
    out.push('[');
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(',');
      writeValue(out, v[i], depth + 1);
    }
    out.push(']');
  } else if (typeof v === 'object') {
    out.push('{');
    let i = 0;
    for (const k of Object.keys(v)) {
      if (i++ > 0) out.push(',');
      out.push(writeStr(k), ':');
      writeValue(out, v[k], depth + 1);
    }
    out.push('}');
  } else {
    throw new TypeError('stringify: not a JSON value: ' + typeof v);
  }
}

/** util/src/json.rs write_str: a JSON string as JSON.stringify writes it: " and \ escaped, \b \f \n \r \t, other
 * controls as \u00XX (lower-case hex).  Returns the quoted string (the Rust appends it to a String).  A lone
 * surrogate (which a Rust string cannot hold) is written as U+FFFD. */
export function writeStr(s) {
  s = s.isWellFormed() ? s : s.toWellFormed();
  let out = '"', from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let e;
    if (c === 0x22) e = '\\"';
    else if (c === 0x5C) e = '\\\\';
    else if (c === 0x08) e = '\\b';
    else if (c === 0x0C) e = '\\f';
    else if (c === 0x0A) e = '\\n';
    else if (c === 0x0D) e = '\\r';
    else if (c === 0x09) e = '\\t';
    else if (c < 0x20) e = '\\u00' + (c < 16 ? '0' : '') + c.toString(16);
    else continue;
    out += s.slice(from, i) + e;
    from = i + 1;
  }
  return out + s.slice(from) + '"';
}

/** util/src/json.rs num: the JSON number JS would read from x (a whole number as an integer: -0 is 0), null for
 * NaN and the infinities */
export function num(x) {
  if (!Number.isFinite(x)) return null;
  return x === 0 ? 0 : x;
}

/** util/src/json.rs safe_integer: JS Number.isSafeInteger(v) for a parsed JSON value, the integer (1.0 counts; -0
 * is 0), else null */
export function safeInteger(v) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) return null;
  return v === 0 ? 0 : v;
}

/** util/src/json.rs is_num: v === n in JS for a parsed JSON value (undefined: no value) and a number */
export function isNum(v, n) {
  return typeof v === 'number' && v === n;
}

