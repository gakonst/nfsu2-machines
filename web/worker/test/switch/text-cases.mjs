// The requests of the differential tests of switch/text.js, switch/plates.js, util/json.js, util/js.js and
// util/serde-json.js against the Rust (web/server-rs/crates/lan/examples/difftrace_text.rs), and the JS port's
// answers to them in the Rust example's shape.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { Rnd, bits, fixture, hex, runRust, unhex } from '../names/rust.mjs';
import { corpus, randomStrings } from '../names/corpus.mjs';
import * as T from '../../src/switch/text.js';
import * as P from '../../src/switch/plates.js';
import * as J from '../../src/util/json.js';
import * as JS from '../../src/util/js.js';
import { crc32 } from '../../src/switch/crc32.js';

const enc8 = s => new TextEncoder().encode(s);

/** a double from the hex of its bits */
export function fromBits(h) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt('0x' + h));
  return dv.getFloat64(0);
}

/** a parsed value as the Rust example's enc writes it: nothing lost */
export function enc(v) {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return { f: bits(v) };
  if (typeof v === 'string') return { s: hex(enc8(v)) };
  if (Array.isArray(v)) return v.map(enc);
  return { o: Object.keys(v).map(k => [hex(enc8(k)), enc(v[k])]) };
}

function found(f) {
  if (f === null) return null;
  if (f.kind === 'broken') return { kind: 'broken' };
  return { kind: 'plate', at: f.at, plate: hex(f.plate), name: hex(f.name) };
}

function verdict(v) {
  if (v.kind === 'last') return { kind: 'last', last: hex(v.last) };
  return v.kind === 'slur' ? { kind: 'slur', tell: v.tell } : { kind: v.kind };
}

/** the JS port's answer to a request, as difftrace_text.rs answers it */
export function answer(q) {
  switch (q.op) {
    case 'clean': return T.cleanName(q.s);
    case 'vip': return T.vipNum(q.s);
    case 'number': return bits(T.toNumber(q.s));
    case 'hash': return hex(T.tokenHash(q.s));
    case 'fits': return T.tokenFits(q.s, unhex(q.h));
    case 'parse': {
      const v = T.parseJsonOption(unhex(q.b));
      if (v === undefined) return { v: null, js: null, json: null, safe: null };
      return { v: enc(v), js: T.jsString(v), json: J.stringify(v), safe: J.safeInteger(v) };
    }
    case 'trim': return JS.trim(q.s);
    case 'collapse': return JS.collapseSpace(q.s, q.rep ?? ' ');
    case 'utf16': return JS.utf16Len(q.s);
    case 'printable': return JS.printable(q.s, q.n);
    case 'numstr': return JS.numberToString(fromBits(q.f));
    case 'fixed': return JS.toFixed(fromBits(q.f), q.d);
    case 'num': {
      const v = J.num(fromBits(q.f));
      return { v: enc(v), json: J.stringify(v) };
    }
    case 'iso': return JS.isoString(q.ms);
    case 'b64': return JS.base64url(unhex(q.b));
    case 'unb64': return hex(JS.fromBase64url(q.s));
    case 'vipstr': return JS.vipStr(q.v);
    case 'writestr': return J.writeStr(q.s);
    case 'plate': {
      const f = unhex(q.b);
      const p = P.helloPlate(f);
      const at = p && p.kind === 'plate' ? p.at : null;
      const other = q.p === undefined ? null : unhex(q.p);
      const rw = (a, pl) => {
        const x = P.rewrite(f, a, pl);
        return x === null ? null : hex(x);
      };
      return {
        found: found(p), intact: P.intact(f), ok: P.ok(f.subarray(16)), same: rw(at, other), none: rw(at, null),
        empty: rw(at, new Uint8Array(0)), bare: rw(null, null), atq: q.at === undefined ? null : rw(q.at, other),
      };
    }
    case 'judge': {
      const seen = new P.Seen();
      return q.seq.map(([p, now]) => verdict(P.judge(seen, unhex(p), now)));
    }
    default: throw new Error('no op ' + q.op);
  }
}

const AZ09 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HF_CREW = 0x0200, HF_PLATE = 0x8000;

/** plates.rs tests frame: a switch frame with a HELLO, its plate (none: no plate field at all), the header's flags,
 * length and CRC right; with the parts given (name, ids heard, crews, flag) */
export function frame(plate, flags, { name = enc8('Ann'), seen = 0, crews = 0, flag = 0, core = 17 } = {}) {
  const d = [];
  for (let i = 0; i < 29; i++) d.push(0);
  d[0] = 0x4E; d[1] = 0x32; d[2] = 0x46; d[3] = 0x52; d[4] = 1; d[5] = 1;
  d[14] = flags & 255; d[15] = flags >> 8; d[16] = core; d[28] = name.length;
  d.push(...name);
  d.push(seen);
  for (let i = 0; i < 4 * seen; i++) d.push(i & 255);
  d.push(crews);
  for (let i = 0; i < 4 * crews; i++) d.push((i * 7) & 255);
  d.push(0, 0, 0, 0, 0); // links, the outrun's player
  d.push(flag);
  for (let i = 0; i < flag; i++) d.push(0x41 + i);
  if ((flags & HF_PLATE) !== 0 || plate.length > 0) d.push(plate.length & 255, ...plate);
  const n = d.length + 4;
  d[6] = n & 255; d[7] = (n >> 8) & 255;
  const crc = crc32(Uint8Array.from(d));
  d.push(crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, crc >>> 24);
  const f = new Uint8Array(16 + d.length);
  f[0] = 1;
  f.set(d, 16);
  return f;
}

const pick = (r, s) => s[r.next(s.length)];

/** a random plate's bytes: capitals and digits mostly, now and then something else */
function randomPlate(r) {
  const n = r.next(11);
  const out = [];
  for (let i = 0; i < n; i++) {
    const m = r.next(20);
    out.push(m === 0 ? pick(r, 'abz -_\0'.split('')).charCodeAt(0) : m === 1 ? 0xC3 : pick(r, AZ09).charCodeAt(0));
  }
  return Uint8Array.from(out);
}

const SLURRY = ['N1GGER', 'BIGFAG', 'HH88', '1488', 'FAGBOY', 'KKK77', 'RACCOON', 'ABC123', 'XYZ9', 'TORPEDO', 'NGGR', 'SS14'];

/** plate requests: frames of all shapes, cut, corrupted, other plates in their place */
export function plateCases(seed, count) {
  const r = new Rnd(seed), out = [];
  for (let x = 0; x < count; x++) {
    const flags = [HF_CREW | HF_PLATE, HF_PLATE, HF_CREW, 0, HF_CREW | HF_PLATE | 0x0001][r.next(5)];
    const plate = r.next(3) === 0 ? enc8(pick(r, SLURRY)) : randomPlate(r);
    let f = frame(plate, flags, {
      name: enc8('x'.repeat(r.next(20))), seen: r.next(10) === 0 ? 65 : r.next(5), crews: r.next(10) === 0 ? 5 : r.next(3),
      flag: r.next(10) === 0 ? 7 : r.next(4), core: r.next(256),
    });
    const m = r.next(10);
    if (m === 0) f = f.subarray(0, r.next(f.length + 1));
    else if (m === 1) {
      f = Uint8Array.from(f);
      f[r.next(f.length)] ^= 1 << r.next(8);
    } else if (m === 2) {
      f = Uint8Array.from(f);
      f[0] = r.next(4);
    }
    const q = { op: 'plate', b: hex(f) };
    if (r.next(2) === 0) q.p = hex(r.next(3) === 0 ? randomPlate(r) : enc8(pick(r, SLURRY)));
    if (r.next(3) === 0) q.at = 29 + r.next(Math.max(1, f.length - 16 - 29 + 4)); // where helloPlate's could be
    out.push(q);
  }
  // the plates.rs tests' frames
  for (const p of ['A', 'AB123456', '0', 'ZZZZZZZZ', '', '123456789', 'lower', 'A B', 'A\0B', 'A-B', '\u00c9', 'N1GGER', 'OLD1']) {
    out.push({ op: 'plate', b: hex(frame(enc8(p), HF_CREW | HF_PLATE)), p: hex(enc8('OLD1')) });
  }
  out.push({ op: 'plate', b: hex(frame(new Uint8Array(0), HF_CREW)) }, { op: 'plate', b: hex(frame(enc8('AB12'), HF_PLATE)) });
  return out;
}

/** judge requests: sequences of plates (slurs among them) and times */
export function judgeCases(seed, count) {
  const r = new Rnd(seed), out = [];
  for (let x = 0; x < count; x++) {
    const seq = [];
    let now = r.next(3) === 0 ? -5000 : 0;
    for (let k = 1 + r.next(12); k > 0; k--) {
      now += [0, 1, 100, 9999, 10000, 10001, 5000][r.next(7)];
      const p = r.next(10) === 0 ? Uint8Array.from([0xff, 0x41]) : enc8(pick(r, [...SLURRY, 'ABC', 'DEF', 'ABC']));
      seq.push([hex(p), now]);
    }
    out.push({ op: 'judge', seq });
  }
  out.push({ op: 'judge', seq: [['N1GGER', 0], ['N1GGER', 100], ['1488', 200], ['BIGFAG', 200], ['HH88', 200], ['ABC123', 300],
    ['ABC123', 400], ['XYZ9', 10299], ['ABC123', 10299], ['XYZ9', 10300]].map(([p, t]) => [hex(enc8(p)), t]) });
  return out;
}

/** number texts: valid and not, long, extreme exponents, leading zeros */
function numberText(r) {
  const digits = n => {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(48 + r.next(10));
    return s;
  };
  const m = r.next(12);
  if (m === 0) return pick(r, ['0', '-0', '-0.0', '1e400', '-1e400', '1e-400', '0e99999999999', '1e99999999999', '1e-99999999999',
    '18446744073709551615', '18446744073709551616', '-9223372036854775808', '-9223372036854775809', '9007199254740993',
    '0.1', '1.7976931348623157e308', '1.7976931348623159e308', '4.9e-324', '2.4703282292062328e-324', '1E2', '1e+2', '01', '-',
    '1.', '.5', '1e', '1e+', '-01', '00', '1.5e3.2', '+1', 'NaN', 'Infinity', '18446744073709551619.5', '123456789012345678901234567890e-10',
    '0.' + '0'.repeat(400) + '1', '1' + '0'.repeat(400), '1' + '0'.repeat(300) + 'e-300', '2147483648e-2147483648']);
  let s = r.next(3) === 0 ? '-' : '';
  s += r.next(15) === 0 ? '0' + digits(1) : r.next(3) === 0 ? '0' : String.fromCharCode(49 + r.next(9)) + digits(r.next(m < 4 ? 30 : 6));
  if (r.next(2) === 0) s += '.' + digits(r.next(10) === 0 ? 0 : 1 + r.next(m < 6 ? 30 : 5));
  if (r.next(3) === 0) s += pick(r, ['e', 'E']) + pick(r, ['', '+', '-']) + digits(r.next(10) === 0 ? 0 : 1 + r.next(4));
  return s;
}

const STR_PIECES = ['a', 'Bob', ' ', 'é', '\u{1F600}', '\\"', '\\\\', '\\/', '\\b', '\\f', '\\n', '\\r', '\\t', '\\u0041', '\\u00e9',
  '\\ud83d\\ude00', '\\uD83D\\uDE00', '\\ud800', '\\udc00', '\\ud800\\u0041', '\\ud800\\ud800\\udc00', '\\udbff', '\\u12', '\\x',
  '\\uzzzz', '\u007f', '\\u0000', '\u2028', '10.77.0.2', 'player', '\\\\ud800'];

function stringText(r) {
  let s = '"';
  for (let k = r.next(5); k > 0; k--) s += pick(r, STR_PIECES);
  return s + '"';
}

const KEYS = ['t', 'name', 'vip', 'id', 'was', 'lan', 'udp', 'on', 'block', 'bundle', 'token', 'a', 'a', '__proto__', 'constructor', 'é'];

/** a JSON text (mostly valid): objects, arrays, strings, numbers, literals, whitespace */
function jsonText(r, depth) {
  const ws = () => (r.next(6) === 0 ? pick(r, [' ', '\n', '\t', '\r', '  ']) : '');
  const m = r.next(depth > 3 ? 4 : 7);
  if (m === 0) return numberText(r);
  if (m === 1) return stringText(r);
  if (m === 2) return pick(r, ['null', 'true', 'false', 'nul', 'True']);
  if (m === 3) return r.next(2) === 0 ? numberText(r) : stringText(r);
  if (m === 4 || m === 5) {
    const items = [];
    for (let k = r.next(5); k > 0; k--) {
      const key = r.next(12) === 0 ? stringText(r) : JSON.stringify(pick(r, KEYS));
      items.push(ws() + key + ws() + ':' + ws() + jsonText(r, depth + 1) + ws());
    }
    return '{' + items.join(',') + (r.next(30) === 0 ? ',' : '') + '}';
  }
  const items = [];
  for (let k = r.next(5); k > 0; k--) items.push(ws() + jsonText(r, depth + 1) + ws());
  return '[' + items.join(',') + (r.next(30) === 0 ? ',' : '') + ']';
}

const nest = (n, open, close, inner = '1') => open.repeat(n) + inner + close.repeat(n);

/** parse requests: generated texts, mutated bytes, the edge cases */
export function parseCases(seed, count) {
  const r = new Rnd(seed), out = [];
  const add = b => out.push({ op: 'parse', b: hex(b) });
  for (let x = 0; x < count; x++) {
    let b = enc8((r.next(4) === 0 ? ' ' : '') + jsonText(r, 0) + (r.next(4) === 0 ? pick(r, [' ', '\n', ' x', ',', '\ufeff']) : ''));
    const m = r.next(6);
    if (m === 0 && b.length > 0) {
      const a = Array.from(b);
      for (let k = 1 + r.next(3); k > 0; k--) {
        const i = r.next(a.length + 1), op = r.next(3);
        const ins = pick(r, [[0x22], [0x5C], [0x2C], [0x5D], [0x7D], [0x75], [0x64], [0x38], [0x30], [0x20], [0x00], [0xC3], [0xFF],
          [0xEF, 0xBB, 0xBF], [0x5C, 0x75, 0x64, 0x38, 0x30, 0x30], [0xED, 0xA0, 0x80], [0xF4, 0x90, 0x80, 0x80], [0xC3, 0xA9]]);
        if (op === 0) a.splice(i, 1);
        else if (op === 1) a.splice(i, 0, ...ins);
        else a.length = Math.min(a.length, i);
      }
      b = Uint8Array.from(a);
    } else if (m === 1) {
      b = Uint8Array.from([0xEF, 0xBB, 0xBF, ...b]);
    }
    add(b);
  }
  for (const t of ['{"name":"a\\ud800b"}', '{"name":"\\udc00"}', '{"name":"\\ud83d\\ude00"}', '{"name":"\\\\ud800"}', '{nope', '',
    ' ', 'null', '{"a":1,"a":2}', '{"b":1,"a":2,"b":3}', '{"__proto__":{"x":1}}', '{"2":1,"1":2,"a":3}', '[1,2', '[1,]', '{"a":1,}',
    '{,}', '[,1]', '1 2', '"\\u00"', '"abc', '"\t"', '"\u007f"', '\ufeff{}', '{"a" :1 , "b":[ ]}', '\u3000{}', '[1e400]', '-',
    '{"t":"hello","name":"x","lan":1}', '{"udp":2147483648.0}', '{"id":9007199254740993}', '[18446744073709551616, -0, 0.30000000000000004]',
    nest(126, '[', ']'), nest(127, '[', ']'), nest(128, '[', ']'), nest(129, '[', ']'), nest(127, '[', ']', ''),
    nest(127, '{"a":', '}'), nest(128, '{"a":', '}'), '[' + nest(126, '{"a":', '}') + ']', '[' + nest(127, '{"a":', '}') + ']']) {
    add(enc8(t));
  }
  add(Uint8Array.from([0x22, 0xFF, 0x22]));
  add(Uint8Array.from([0x22, 0xED, 0xA0, 0x80, 0x22]));
  add(Uint8Array.from([0x22, 0x5C, 0x75, 0x64, 0x38, 0x30, 0x30, 0xFF, 0x22]));
  return out;
}

/** clean, vip, number, hash, fits and the js.rs/json.rs requests */
export function textCases(seed, count) {
  const r = new Rnd(seed), out = [];
  const names = corpus({ scale: 0.05, step: 211 });
  const strs = randomStrings(seed, count);
  const spaces = ['', ' ', '\t', '\n', '\u00a0', '\u3000', '\ufeff', '\u0085', '\u180e', '\u2028', '\u200b', '\u202e', '\u0000'];
  for (let x = 0; x < count; x++) {
    const s = r.next(2) === 0 ? pick(r, names) : strs[x];
    const sp = () => pick(r, spaces);
    out.push({ op: 'clean', s: sp() + s + sp() + (r.next(4) === 0 ? sp() + s : '') });
    const v = [r.next(3) === 0 ? 10 : r.next(300), r.next(3) ? 77 : r.next(300), r.next(120), r.next(260)];
    const vs = v.map(n => (r.next(10) === 0 ? '0' + n : r.next(20) === 0 ? n + 'x' : String(n))).slice(0, 2 + r.next(4)).join('.');
    out.push({ op: 'vip', s: r.next(10) === 0 ? sp() + vs : vs });
    out.push({ op: 'number', s: sp() + pick(r, [numberText(r), numberText(r), '0x' + 'f'.repeat(r.next(30)), '0b101', '0o17', '0x',
      '0xg', 'Infinity', '-Infinity', '+Infinity', 'inf', 'nan', '12px', '1_000', '0X1F', '0B2', '+.5', '-.5e1', '.', '+', '1e-7']) + sp() });
    const tok = r.next(4) === 0 ? 'a'.repeat(60 + r.next(8)) : s;
    out.push({ op: 'hash', s: tok });
    out.push({ op: 'fits', s: tok, h: hex(T.tokenHash(r.next(3) === 0 ? tok + 'x' : tok)) });
    out.push({ op: 'trim', s: sp() + s + sp() }, { op: 'collapse', s: sp() + s.replaceAll('a', sp()) + sp(), rep: pick(r, [' ', '', '--']) });
    out.push({ op: 'utf16', s }, { op: 'printable', s, n: r.next(30) }, { op: 'writestr', s: s + pick(r, ['"', '\\', '\b', '\u0001', '\u001f', '\u007f', '\u2028']) });
    const f = r.next(4) === 0 ? T.toNumber(numberText(r)) : r.next(2) ? (r.next(1000000) - 500000) / [1, 8, 1000, 3][r.next(4)] : fromBits(
      r.next(65536).toString(16).padStart(4, '0') + r.next(65536).toString(16).padStart(4, '0') + r.next(65536).toString(16).padStart(4, '0') + r.next(65536).toString(16).padStart(4, '0'));
    if (!Number.isNaN(f)) {
      out.push({ op: 'numstr', f: bits(f) }, { op: 'num', f: bits(f) }, { op: 'fixed', f: bits(f), d: pick(r, [0, 1, 2, 3, 5, 20, 100, 150]) });
    }
    const ms = (pick(r, [0, -1, 1, 86399999, -86400001, 1792565740123, 253402300800000, -62198755200000, 8640000000000000,
      -8640000000000001, 9007199254740991, -9007199254740991]) + (r.next(2) ? r.next(1000000) * 86400 - 500000 * 86400 : 0));
    if (Number.isSafeInteger(ms)) out.push({ op: 'iso', ms });
    const bytes = enc8(s).subarray(0, r.next(40));
    out.push({ op: 'b64', b: hex(bytes) }, { op: 'unb64', s: JS.base64url(bytes) + pick(r, ['', '=', '==', 'A', '+/', ' !', 'AB']) });
    out.push({ op: 'vipstr', v: r.next(2) ? 0x0A4D0000 + r.next(65536) : r.next(4294967296) });
  }
  // the text.rs tests' names and addresses
  for (const s of ['  N1gg4  ', 'Mustafa GS', '', '   ', '\u{AD}', '  Bob  ', 'a\t\n b', '\u{3000}x\u{A0}y\u{FEFF}', 'a\u{0}\u{7}b\u{7F}',
    'a\u{85}b', 'a\u{200B}b\u{2060}c', '\u{202E}evil\u{202C}', 'x\u{180E}y', '\u{E0041}tag', 'e\u{301}', 'A\u{30A}', '\u{212B}',
    'a\u{316}\u{301}', 'e\u{301}\u{1E6E3}\u{316}', 'e\u{301}\u{10EF5}\u{316}', '\u{1E6E3}\u{301}x', '\u{1F600}\u{1F1E6}\u{1F1E8}',
    'y'.repeat(40), 'a'.repeat(31) + '  b']) out.push({ op: 'clean', s });
  for (const s of ['10.77.0.2', '10.77.95.251', '10.77.96.2', '010.077.000.002', '10.77.0.02.1', '10.77.0', '1e1.77.0.2', '10.77.0.+2',
    '10.77.0.0002', '10.77.256.2', '\u0661\u0660.77.0.2']) out.push({ op: 'vip', s });
  return out;
}

/** every request of a seed */
export function allCases(seed, n) {
  return [...textCases(seed, n), ...parseCases(seed + 1, n * 2), ...plateCases(seed + 2, n), ...judgeCases(seed + 3, Math.ceil(n / 4))];
}


/** an encoded value's objects in a JS object's key order: array-index keys first, ascending, then the rest in order */
function jsOrder(v) {
  if (Array.isArray(v)) return v.map(jsOrder);
  if (v === null || typeof v !== 'object' || !('o' in v)) return v;
  const key = h => Buffer.from(h, 'hex').toString();
  const isIndex = k => /^(0|[1-9][0-9]*)$/.test(k) && Number(k) < 4294967295;
  const idx = v.o.filter(([k]) => isIndex(key(k))).sort((x, y) => Number(key(x[0])) - Number(key(y[0])));
  return { o: [...idx, ...v.o.filter(([k]) => !isIndex(key(k)))].map(([k, x]) => [k, jsOrder(x)]) };
}

export const sameAnswer = (q, js, rs) => {
  if (isDeepStrictEqual(js, rs)) return true;
  if (q.op !== 'parse' || !js || !rs || rs.v === null) return false;
  // known: a JS object puts its array-index keys first ({"2":1,"1":2} is {"1":2,"2":1}); and the Rust's stringify
  // writes an integer it holds exactly as a u64/i64 past 2^53 with all its digits, where here it is a double (see
  // util/serde-json.js).  The same values otherwise: the Rust's text read back by JS is ours.
  return isDeepStrictEqual(js.v, jsOrder(rs.v)) && js.js === rs.js && js.safe === rs.safe && JSON.stringify(JSON.parse(rs.json)) === js.json;
};

/** the requests whose answers differ from the Rust's (at most 20 shown) */
export function compare(qs, outs, ops) {
  assert.equal(outs.length, qs.length);
  const diff = [];
  let n = 0;
  for (let i = 0; i < qs.length; i++) {
    if (!ops.includes(qs[i].op)) continue;
    n++;
    let js;
    try {
      js = answer(qs[i]);
    } catch (e) {
      js = 'threw ' + e.message;
    }
    if (!sameAnswer(qs[i], js, outs[i].r)) diff.push(JSON.stringify(qs[i]).slice(0, 400) + '\n  js   ' + JSON.stringify(js).slice(0, 400) + '\n  rust ' + JSON.stringify(outs[i].r).slice(0, 400));
  }
  assert.deepEqual(diff.slice(0, 20), [], diff.length + ' of ' + n + ' answered otherwise');
  return n;
}

export const TEXT_OPS = ['clean', 'vip', 'number', 'hash', 'fits', 'parse', 'trim', 'collapse', 'utf16', 'printable', 'writestr', 'numstr', 'num',
  'fixed', 'iso', 'b64', 'unb64', 'vipstr'];

/** the fixture's requests (seed 7) and Rust's answers */
export function textFixture() {
  return fixture('text-rust.json', () => {
    const inputs = [...allCases(7, 30), ...plateCases(9, 150), ...judgeCases(10, 40)];
    const r = runRust('nfsu2-lan', 'difftrace_text', inputs.map(q => JSON.stringify(q)));
    return r.skip ? null : { inputs, outputs: r.out };
  });
}

