// web/worker/src/switch/text.js (with util/serde-json.js, util/json.js, util/js.js, util/sha256.js): the Rust
// tests of lan/src/text.rs, and differential tests against the Rust itself (the test-only example
// web/server-rs/crates/lan/examples/difftrace_text.rs, which includes text.rs and plates.rs by their paths), live where
// cargo runs and from the fixture web/worker/test/fixtures/text-rust.json always.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanName, jsString, newToken, parseJson, parseJsonOption, toNumber, tokenFits, tokenHash, vipNum } from '../../src/switch/text.js';

/** a parsed object as a plain one (parseJson's have a null prototype), deeply */
const plain = v => (Array.isArray(v) ? v.map(plain) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
import { Prng } from '../../src/util/prng.js';
import { TEXT_OPS, compare, parseCases, textCases, textFixture } from './text-cases.mjs';
import { runRust } from '../names/rust.mjs';

const enc = s => new TextEncoder().encode(s);

// text.rs names_as_the_switch_shows_them
test('names as the switch shows them', () => {
  const y40 = 'y'.repeat(40), a31 = 'a'.repeat(31);
  for (const [name, shown] of [
    ['  N1gg4  ', 'player'], ['Mustafa GS', 'Mustafa GS'], ['', 'player'], ['   ', 'player'], ['\u{AD}', 'player'], ['  Bob  ', 'Bob'],
    ['a\t\n b', 'a b'], ['\u{3000}x\u{A0}y\u{FEFF}', 'x y'], ['a\u{0}\u{7}b\u{7F}', 'ab'], ['a\u{85}b', 'ab'], ['a\u{200B}b\u{2060}c', 'abc'],
    ['\u{202E}evil\u{202C}', 'evil'], ['x\u{180E}y', 'xy'], ['\u{E0041}tag', 'tag'], ['e\u{301}', '\u{E9}'], ['A\u{30A}', '\u{C5}'],
    ['\u{212B}', '\u{C5}'], ['a\u{316}\u{301}', '\u{E1}\u{316}'],
    // a mark newer than the Rust tables' Unicode (16.0) stays where it is: nothing reordered or composed across it
    ['e\u{301}\u{1E6E3}\u{316}', '\u{E9}\u{1E6E3}\u{316}'], ['e\u{301}\u{10EF5}\u{316}', '\u{E9}\u{10EF5}\u{316}'],
    ['\u{1E6E3}\u{301}x', '\u{1E6E3}\u{301}x'], ['\u{1F600}\u{1F1E6}\u{1F1E8}', '\u{1F600}\u{1F1E6}\u{1F1E8}'],
    [y40, y40.slice(0, 32)], [a31 + '  b', a31],
  ]) assert.equal(cleanName(name), shown, JSON.stringify(name));
  // not in the Rust: a lone surrogate is U+FFFD, and 32 code points are 32 whatever their UTF-16 length
  assert.equal(cleanName('a\uD800b'), 'a\uFFFDb');
  assert.equal(cleanName('\u{1F600}'.repeat(40)), '\u{1F600}'.repeat(32));
});

// text.rs addresses_as_vip_num_reads_them
test('addresses as vipNum reads them', () => {
  for (const [s, v] of [['10.77.0.2', 0x0A4D0002], ['10.77.7.251', 0x0A4D07FB], ['10.77.15.251', 0x0A4D0FFB], ['10.77.19.251', 0x0A4D13FB],
    ['10.77.27.251', 0x0A4D1BFB], ['10.77.31.251', 0x0A4D1FFB], ['10.77.32.2', 0x0A4D2002], ['10.77.47.251', 0x0A4D2FFB],
    ['10.77.55.251', 0x0A4D37FB], ['10.77.56.2', 0x0A4D3802], ['10.77.63.251', 0x0A4D3FFB], ['10.77.64.2', 0x0A4D4002],
    ['10.77.95.251', 0x0A4D5FFB], ['010.077.000.002', 0x0A4D0002]]) assert.equal(vipNum(s), v, s);
  for (const s of ['10.77.0.1', '10.77.0.252', '10.77.0.255', '10.77.47.255', '10.77.55.255', '10.77.63.252', '10.77.63.255', '10.77.95.252',
    '10.77.95.255', '10.77.96.2', '10.77.127.251', '192.168.1.20', '10.77.0.02.1', '10.77.0', '', '10.77.0.2 ', ' 10.77.0.2', '10.77.0.2\n',
    '10.77.0.0002', '10.77.256.2', '1e1.77.0.2', '10.77.0.+2', 'x']) assert.equal(vipNum(s), 0, JSON.stringify(s));
});

// text.rs strings_as_js_makes_them
test('strings as JS makes them', () => {
  assert.equal(jsString(undefined), '');
  assert.equal(jsString(null), '');
  assert.equal(jsString(['10.77.0.2']), '10.77.0.2');
  assert.equal(jsString([1, null, [2, 3]]), '1,,2,3');
  assert.equal(jsString({ a: 1 }), '[object Object]');
  assert.equal(jsString(1.5), '1.5');
  assert.equal(jsString(true), 'true');
});

// text.rs numbers_as_js_reads_them
test('numbers as JS reads them', () => {
  assert.equal(toNumber('80'), 80);
  assert.equal(toNumber(' 1e3 '), 1000);
  assert.equal(toNumber(''), 0);
  assert.equal(toNumber('0x10'), 16);
  assert.ok(Number.isNaN(toNumber('inf')));
  assert.ok(Number.isNaN(toNumber('12px')));
  assert.equal(toNumber('-2.5'), -2.5);
});

// text.rs tokens_fit_only_their_hash
test('tokens fit only their hash', () => {
  const t = newToken(new Prng(42));
  assert.equal(t.length, 22);
  assert.match(t, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(newToken(new Prng(43)), t);
  assert.equal(newToken(new Prng(42)), t, 'the same seed, the same token');
  const h = tokenHash(t);
  assert.ok(tokenFits(t, h));
  assert.ok(!tokenFits('x', h));
  assert.ok(!tokenFits('a'.repeat(65), tokenHash('a'.repeat(65))));
  assert.ok(tokenFits('a'.repeat(64), tokenHash('a'.repeat(64))));
});

// text.rs lone_surrogates_read_as_replacement_characters
test('lone surrogates read as replacement characters', () => {
  assert.deepEqual(plain(parseJson(enc(String.raw`{"name":"a\ud800b"}`))), { name: 'a\u{FFFD}b' });
  assert.deepEqual(plain(parseJson(enc(String.raw`{"name":"\udc00"}`))), { name: '\u{FFFD}' });
  assert.deepEqual(plain(parseJson(enc(String.raw`{"name":"\ud83d\ude00"}`))), { name: '\u{1F600}' });
  assert.deepEqual(plain(parseJson(enc(String.raw`{"name":"\\ud800"}`))), { name: '\\ud800' });
  assert.equal(parseJson(enc('{nope')), null);
  assert.equal(parseJsonOption(enc('{nope')), undefined);
  assert.equal(parseJsonOption(enc('null')), null);
});

// not in the Rust's tests: what serde_json refuses and JSON.parse takes, and the values it makes
test('parseJson is serde_json, not JSON.parse', () => {
  const p = s => parseJsonOption(enc(s));
  assert.equal(p('[1e400]'), undefined);
  assert.equal(p('[-1e400]'), undefined);
  assert.deepEqual(p('[1e-400]'), [0]);
  assert.equal(p('\uFEFF{}'), undefined);
  assert.equal(p('[' .repeat(128) + ']'.repeat(128)), undefined);
  assert.ok(Array.isArray(p('['.repeat(127) + ']'.repeat(127))));
  assert.equal(p('{"a":1,}'), undefined);
  assert.equal(p('01'), undefined);
  assert.equal(p('1 2'), undefined);
  assert.deepEqual(plain(p('{"a":1,"b":2,"a":3}')), { a: 3, b: 2 });
  const o = p('{"t":"hello"}');
  assert.equal(Object.getPrototypeOf(o), null);
  assert.equal(o.constructor, undefined);
  assert.equal(o.toString, undefined);
  assert.equal(p('{"toString":1}').toString, 1);
  assert.deepEqual(Object.keys(p('{"b":1,"a":2,"b":3}')), ['b', 'a']);
  const proto = p('{"__proto__":{"x":1}}');
  assert.ok(Object.hasOwn(proto, '__proto__') && proto.x === undefined && Object.getPrototypeOf(proto) === null);
  assert.deepEqual(Object.keys(proto), ['__proto__']);
  assert.ok(Object.is(p('-0'), -0));
  assert.equal(p('null'), null);
  assert.equal(p(''), undefined);
  // serde_json's own decimal arithmetic (no float_roundtrip): not always the double nearest the text
  assert.equal(p('6.090346620209507122e1'), 60.903466202095075); // JSON.parse: 60.90346620209507
  assert.equal(p('2.384627058212282158e8'), 238462705.82122824); // JSON.parse: 238462705.8212282
});

test('the same answers as the Rust: fixture (web/worker/test/fixtures/text-rust.json)', t => {
  const f = textFixture();
  t.diagnostic(compare(f.inputs, f.outputs, TEXT_OPS) + ' requests');
});

test('the same answers as the Rust: live (seeds 1, 100, 200: names, addresses, numbers, tokens, JSON texts, js.rs and json.rs)', t => {
  const qs = [];
  for (const seed of [1, 100, 200]) qs.push(...textCases(seed, 3000), ...parseCases(seed + 1, 6000));
  const r = runRust('nfsu2-lan', 'difftrace_text', qs.map(q => JSON.stringify(q)));
  if (r.skip) return t.skip('no Rust: ' + r.skip);
  t.diagnostic(compare(qs, r.out, TEXT_OPS) + ' requests: the same answers');
});


