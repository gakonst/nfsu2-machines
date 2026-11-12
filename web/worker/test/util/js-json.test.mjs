// web/worker/src/util/js.js and json.js: the Rust tests of util/src/js.rs and json.rs (their differential tests
// against the Rust are in test/switch/text.test.mjs: the trim, collapse, utf16, printable, numstr, fixed, iso, b64,
// unb64, vipstr, writestr, num and parse requests).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as JS from '../../src/util/js.js';
import { isNum, num, safeInteger, stringify, writeStr } from '../../src/util/json.js';
import { fromStr } from '../../src/util/serde-json.js';

// js.rs numbers_as_js_writes_them
test('numbers as JS writes them', () => {
  for (const [x, s] of [[0, '0'], [-0, '0'], [1, '1'], [-1.5, '-1.5'], [0.1, '0.1'], [1e21, '1e+21'], [1e20, '100000000000000000000'],
    [123456789012345680000, '123456789012345680000'], [1.5e-7, '1.5e-7'], [1e-6, '0.000001'], [1e-7, '1e-7'],
    [1729512345123.4567, '1729512345123.4568'], [0.30000000000000004, '0.30000000000000004'], [5e-324, '5e-324'],
    [1.7976931348623157e308, '1.7976931348623157e+308'], [NaN, 'NaN'], [Infinity, 'Infinity'], [2.5e25, '2.5e+25'], [100, '100'],
    [1234.5678, '1234.5678'], [-69633 / 131072, '-0.5312576293945312']]) assert.equal(JS.numberToString(x), s, String(x));
});

// js.rs to_fixed_rounds_half_up
test('toFixed rounds half up', () => {
  assert.equal(JS.toFixed(0.125, 2), '0.13');
  assert.equal(JS.toFixed(1.005, 2), '1.00');
  assert.equal(JS.toFixed(61.125, 2), '61.13');
  assert.equal(JS.toFixed(9.995, 2), '9.99');
  assert.equal(JS.toFixed(99.999, 2), '100.00');
  assert.equal(JS.toFixed(-0.0001, 2), '-0.00');
  assert.equal(JS.toFixed(-0, 2), '0.00');
  assert.equal(JS.toFixed(-0.5, 0), '-1');
  assert.equal(JS.toFixed(1e20, 2), '100000000000000000000.00');
  assert.equal(JS.toFixed(-1.5, 0), '-2');
  assert.equal(JS.toFixed(2.5, 0), '3');
  assert.equal(JS.toFixed(12, 3), '12.000');
  assert.equal(JS.toFixed(1.234, 0), '1');
  assert.equal(JS.toFixed(0.5, 5000), JS.toFixed(0.5, 100));
  assert.equal(JS.toFixed(0.5, 100).length, 102);
});

// js.rs printable_counts_utf16
test('printable counts UTF-16', () => {
  assert.equal(JS.printable('a\u{1F600}b', 160), 'a??b');
  assert.equal(JS.printable('h\u00e9llo\n', 4), 'h?ll');
  assert.equal(JS.printable('abc', 2), 'ab');
  assert.equal(JS.printable('a\uD800', 5), 'a?');
});

// js.rs trim_and_space
test('trim and space', () => {
  assert.equal(JS.trim('\u{FEFF} a b \u{3000}'), 'a b');
  assert.equal(JS.trim('\u{0085}x'), '\u{0085}x');
  assert.equal(JS.collapseSpace('a \t\n b', ' '), 'a b');
  assert.equal(JS.collapseSpace('\u180e\u200b', ' '), '\u180e\u200b'); // not \s in the Rust's set, whatever the runtime's
  assert.equal(JS.utf16Len('a\u{1F600}'), 3);
});

// js.rs dates
test('dates', () => {
  assert.equal(JS.isoString(0), '1970-01-01T00:00:00.000Z');
  assert.equal(JS.isoString(1792565740123), '2026-10-21T06:55:40.123Z');
  assert.deepEqual(JS.utcParts(951782400000).slice(0, 3), [2000, 2, 29]);
  assert.equal(JS.isoString(-1), '1969-12-31T23:59:59.999Z');
  assert.equal(JS.isoString(9007199254740991), '+287396-10-12T08:59:00.991Z');
  for (const ms of [0, -1, 1e12, -62198755200000, 253402300800000, 8.64e15, -8.64e15]) assert.equal(JS.isoString(ms), new Date(ms).toISOString());
});

// js.rs base64url_both_ways
test('base64url both ways', () => {
  assert.equal(JS.base64url(Uint8Array.of(0xfb, 0xff)), '-_8');
  assert.deepEqual(JS.fromBase64url('-_8'), Uint8Array.of(0xfb, 0xff));
  assert.deepEqual(JS.fromBase64url('-_8='), Uint8Array.of(0xfb, 0xff));
  for (let n = 0; n < 40; n++) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    assert.equal(JS.base64url(b), Buffer.from(b).toString('base64url'));
    assert.deepEqual(JS.fromBase64url(JS.base64url(b) + '=\n'), b);
    assert.deepEqual(Buffer.from(JS.fromBase64url('+/' + JS.base64url(b))), Buffer.from('+/' + JS.base64url(b), 'base64url'));
  }
  assert.equal(JS.vipStr(0x0A4D0001), '10.77.0.1');
});

// json.rs as_js_writes_it
test('JSON as JS writes it', () => {
  const v = { b: 5.0, a: [1e21, 0.5, -0, 'x"\n\u{1}\u00e9'], c: null, d: true };
  assert.equal(stringify(v), '{"b":5,"a":[1e+21,0.5,0,"x\\"\\n\\u0001\u00e9"],"c":null,"d":true}');
  assert.equal(stringify(v), JSON.stringify(v));
  assert.equal(stringify(num(5.0)), '5');
  assert.equal(num(NaN), null);
  assert.ok(Object.is(num(-0), 0));
  assert.equal(safeInteger(3.0), 3);
  assert.equal(safeInteger(3.5), null);
  assert.equal(safeInteger(9007199254740992), null);
  assert.equal(safeInteger('3'), null);
  assert.ok(isNum(1.0, 1) && !isNum(undefined, 1) && !isNum('1', 1));
  assert.equal(writeStr('a\uD800'), '"a\uFFFD"');
  assert.equal(stringify(fromStr('{"b":[1,{"c":"\\u00e9"}],"a":null}').value), '{"b":[1,{"c":"\u00e9"}],"a":null}');
  assert.equal(stringify([NaN, Infinity]), '[null,null]');
});

