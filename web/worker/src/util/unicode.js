// Lookups in the general-category tables the Rust server reads (unicode-tables.js, generated from its
// unicode-general-category crate), so that the ports read every code point as the Rust code does, whatever Unicode
// the runtime's ICU has (Node 24 here: ICU 78, Unicode 17; the Rust crate's tables: Unicode 16).

import { CONTROL_FORMAT, MARKS, UNASSIGNED, SOURCE } from './unicode-tables.js';

export { SOURCE };

/** the packed ranges as [first0, last0, first1, last1, ...] */
function unpack(packed) {
  const parts = packed.split(',');
  if (parts.length % 2 !== 0) throw new Error('unicode tables: a range without its length');
  const out = new Uint32Array(parts.length);
  let next = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const a = next + parseInt(parts[i], 36), b = a + parseInt(parts[i + 1], 36);
    if (!(b <= 0x10FFFF)) throw new Error('unicode tables: past U+10FFFF');
    out[i] = a;
    out[i + 1] = b;
    next = b + 1;
  }
  return out;
}

const T_UNASSIGNED = unpack(UNASSIGNED);
const T_MARKS = unpack(MARKS);
const T_CONTROL = unpack(CONTROL_FORMAT);

/** cp is in one of the ranges (binary search) */
function inRanges(t, cp) {
  let lo = 0, hi = t.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < t[2 * mid]) hi = mid - 1;
    else if (cp > t[2 * mid + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/** get_general_category(c) == Unassigned (Cn), as the Rust server's unicode-general-category reads it */
export function isUnassigned(cp) {
  return inRanges(T_UNASSIGNED, cp);
}

/** a mark (Mn, Mc, Me): names/src/lib.rs is_mark */
export function isMark(cp) {
  return inRanges(T_MARKS, cp);
}

/** a control or format character (Cc, Cf): lan/src/text.rs clean_name's filter */
export function isControlOrFormat(cp) {
  return inRanges(T_CONTROL, cp);
}

/** names/src/lib.rs unknown, lan/src/text.rs nfc_as_node's unknown: a non-ASCII character the tables' Unicode has
 * not assigned (to Node's ICU of the Node server: a starter with no decomposition that composes with nothing) */
export function unknown(cp) {
  return cp >= 0x80 && isUnassigned(cp);
}

/**
 * s normalized ('NFC' or 'NFKD') as the Rust server does (names/src/lib.rs read, lan/src/text.rs nfc_as_node): each
 * run between characters unassigned in the tables' Unicode normalized on its own, those characters left as they are.
 * The runs hold only characters assigned in that Unicode, which normalize the same under any later Unicode
 * (Unicode's normalization stability): the runtime's String#normalize does them.  s must be well-formed.
 */
export function normalizeAsRust(s, form) {
  let ascii = true;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x80) { ascii = false; break; }
  if (ascii) return s;
  let out = '', from = 0;
  for (let i = 0; i < s.length;) {
    const cp = s.codePointAt(i), n = cp > 0xFFFF ? 2 : 1;
    if (unknown(cp)) {
      out += s.slice(from, i).normalize(form) + s.slice(i, i + n);
      from = i + n;
    }
    i += n;
  }
  return out + s.slice(from).normalize(form);
}

