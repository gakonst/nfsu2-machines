// The online crate's unit tests (aries.rs, jsx.rs, omap.rs, http.rs, lobby.rs, timers) ported, and a few of the JS
// port's own (rand.js against nfsu2_util::rand's way, races.js serde numbers).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, encodeFrameText, encodeFields, encodeValue, FrameReader, parseFields, FieldMap, isSecret, SECRET_KEYS, HDR, redactBody } from '../../src/online/aries.js';
import { latin1Decode, latin1Encode, slice16, cleanText, stripAt, validName, day, monthOf, toInt32, toUint32, round, fmt0 } from '../../src/online/jsx.js';
import { fit, fmtTime, finishersOf, othersOf, fourPrintable } from '../../src/online/lobby.js';
import { requestLine, offerPage } from '../../src/online/http.js';
import { Timers } from '../../src/online/timers.js';
import { serdeF64 } from '../../src/online/races.js';
import { randInt, randHex } from '../../src/online/rand.js';
import { md5 } from '../../src/online/md5.js';
import { Prng } from '../../src/util/prng.js';
import { createHash } from 'node:crypto';

const latin1 = (b) => latin1Decode(b);

test('aries: header', () => {
  const f = encodeFrame('auth', '', [['NAME', 'Bob'], ['ADDR', '10.77.0.3']]);
  assert.equal(latin1(f.subarray(0, 4)), 'auth');
  assert.deepEqual([...f.subarray(4, 8)], [0, 0, 0, 0]);
  assert.equal(new DataView(f.buffer).getUint32(8), f.length);
  assert.equal(latin1(f.subarray(HDR)), 'NAME=Bob\nADDR=10.77.0.3\n\0');
  const e = encodeFrame('auth', 'pass', []);
  assert.equal(latin1(e.subarray(4, 8)), 'pass');
  assert.equal(e.length, HDR + 1);
  assert.equal(latin1(encodeFrameText('news', 'new7', 'X=1').subarray(4, 8)), 'new7');
  assert.throws(() => encodeFrame('toolong', '', []));
  assert.throws(() => encodeFields([['BAD KEY', 1]]));
});

test('aries: values as the game writes them', () => {
  const ev = (v) => {
    const o = [];
    encodeValue(v, o);
    return latin1(Uint8Array.from(o));
  };
  assert.equal(ev('plain'), 'plain');
  assert.equal(ev('two words'), '"two words"');
  assert.equal(ev('a=b'), 'a%3db');
  assert.equal(ev('q"u:o%t^e'), 'q%22u%3ao%25t%5ee');
  assert.equal(ev('tab\there\nnl'), 'tab%09here%0anl');
  assert.equal(ev('\x7f'), '%7f');
  assert.equal(ev(1234), '1234');
  assert.equal(ev('\u00c4'), '\u00c4');
});

test('aries: round trip, both separators, quotes, escapes', () => {
  const fields = [['NAME', 'two words'], ['TEXT', 'hi = "you": 100% ^^'], ['N', '7'], ['EMPTY', '']];
  for (const sep of [0x0a, 0x09]) {
    const f = encodeFrame('mesg', '', fields, sep);
    const m = new FrameReader().push(f);
    assert.equal(m[0].kind, 'mesg');
    assert.equal(m[0].code, '');
    assert.deepEqual(parseFields(m[0].body, isSecret), fields);
  }
  const body = latin1Encode('NAME=x  junk PERS="a b"\tLKEY=k\0NAME=after', []);
  assert.deepEqual(parseFields(Uint8Array.from(body), isSecret), [['NAME', 'x'], ['PERS', 'a b'], ['LKEY', 'k']]);
  const m = FieldMap.parse(Uint8Array.from(latin1Encode('name=a\nNAME=b\n\0', [])));
  assert.equal(m.get('NAME'), 'a');
});

test('aries: a stream, split and packed messages, the size limit', () => {
  const a = encodeFrame('addr', '', [['ADDR', '10.77.0.5'], ['PORT', '50000']]);
  const b = encodeFrame('skey', '', [['SKEY', '$37940faf2a8d1381a3b7d0d2f570e6a7']]);
  const all = new Uint8Array([...a, ...b]);
  for (let cut = 1; cut < all.length; cut += 3) {
    const r = new FrameReader();
    const got = r.push(all.subarray(0, cut)).concat(r.push(all.subarray(cut)));
    assert.deepEqual(got.map((m) => m.kind), ['addr', 'skey'], 'cut at ' + cut);
    assert.equal(r.pending(), 0);
  }
  const r = new FrameReader(64);
  assert.equal(r.push(encodeFrame('mesg', '', [['TEXT', 'x'.repeat(100)]])).length, 0);
  assert.ok(r.error.includes('at most 64'));
  assert.equal(r.push(a).length, 0, 'nothing after a bad length');
  const tiny = new Uint8Array(12);
  tiny.set([120, 120, 120, 120]);
  tiny[11] = 4;
  const r2 = new FrameReader();
  r2.push(tiny);
  assert.ok(r2.error !== null);
});

test('aries: secrets never decoded, never in the trace', () => {
  const pw = 'CANARY-PASSWORD-123';
  const body = Uint8Array.from([...encodeFields([['NAME', 'Bob'], ['PASS', pw], ['TOS', '1'], ['REGKEY', 'ABCD-EFGH'], ['PSES', '0123abcd'], ['PASSWORD', 'gamepw']]), 0]);
  const f = parseFields(body, isSecret);
  assert.deepEqual(f.map(([k]) => k), ['NAME', 'PASS', 'TOS', 'REGKEY', 'PSES', 'PASSWORD']);
  for (const [k, v] of f) if (SECRET_KEYS.includes(k)) assert.equal(v, null, k);
  assert.ok(FieldMap.parse(body).has('PASS') && FieldMap.parse(body).get('PASS') === null);
  const quoted = Uint8Array.from(latin1Encode('NAME=a PASS="' + pw + ' x" REGKEY=' + pw + '\0', []));
  assert.ok(parseFields(quoted, isSecret).every(([k, v]) => k === 'NAME' || v === null));
  const line = redactBody(body);
  assert.ok(!line.includes(pw) && !line.includes('ABCD') && !line.includes('0123abcd') && !line.includes('gamepw'), line);
  assert.ok(line.includes('PASS=<redacted>') && line.includes('NAME="Bob"'));
});

test('jsx: numbers as JS reads them, text', () => {
  assert.equal(toInt32(Number('4294967297')), 1);
  assert.equal(toInt32(Number('2147483648')), -2147483648);
  assert.equal(toUint32(Number('-1')), 4294967295);
  assert.equal(toUint32(Number('x')), 0);
  assert.equal(round(2.5), 3);
  assert.equal(round(-2.5), -2);
  assert.equal(round(0.49999999999999994), 0);
  assert.equal(stripAt('a@b'), 'a');
  assert.equal(stripAt('a@b\nc'), 'a@b\nc');
  assert.equal(stripAt('a@b\u2028c@d'), 'a@b\u2028c');
  assert.equal(stripAt('x/y'), 'x');
  assert.equal(cleanText('hello \u009b there\u0007', 255), 'hello there');
  assert.equal(cleanText('  a\u00adb  ', 255), 'a b');
  assert.equal(cleanText('abcdef', 3), 'abc');
  assert.equal(slice16('a\u{1F600}b', 2), 'a');
  assert.ok(validName('Speedy') && !validName('x y') && !validName('ab') && !validName('abcdefghijklmnop'));
  assert.equal(day(1000000), '1970.1.1');
  assert.equal(monthOf(1792565740123), '2026-10');
  assert.deepEqual(latin1Encode('A\u0100\u{1F600}', []), [0x41, 0x00, 0x3d, 0x00]);
  assert.equal(fmt0(2.5), '2');
  assert.equal(fmt0(3.5), '4');
  assert.equal(fmt0(419.99999), '420');
});

test('lobby: fit and times; kept reports', () => {
  assert.equal(fmtTime(186.82000732421875), '3:06.82');
  assert.equal(fmtTime(11.199999809265137), '0:11.20');
  assert.equal(fmtTime(5.0), '0:05.00');
  assert.equal(fit([['A', 'x'.repeat(10)], ['B', 'y']], 6, ['A']).length, 1);
  assert.ok(fourPrintable('auth') && fourPrintable('\\x80') && !fourPrintable('ab') && !fourPrintable('a b '));
  assert.equal(finishersOf('Bob:1,Ann:2|Cat,Dan'), 'Bob:1,Ann:2');
  assert.deepEqual(othersOf('Bob:1,Ann:2|Cat,Dan'), ['Cat', 'Dan']);
  assert.equal(finishersOf('Bob:1,Ann:2,Cat:0'), 'Bob:1,Ann:2');
  assert.deepEqual(othersOf('Bob:1,Ann:2,Cat:0'), ['Cat']);
  assert.equal(finishersOf('Bob:1|'), 'Bob:1');
  assert.deepEqual(othersOf('Bob:1|'), []);
  assert.equal(finishersOf('|Ann,Bob'), '');
});

test('http: request lines, the page', () => {
  assert.deepEqual(requestLine('GET /news HTTP/1.0'), ['GET', '/news']);
  assert.deepEqual(requestLine('HEAD /tos?x=1#y HTTP/1.1'), ['HEAD', '/tos']);
  assert.equal(requestLine('GET /a b HTTP/1.0'), null);
  assert.equal(requestLine('POST /news HTTP/1.0'), null);
  assert.equal(requestLine('GET news HTTP/1.0'), null);
  assert.equal(requestLine('GET / HTTP/1.2'), null);
  assert.ok(offerPage({ title: 'NFSU2 Online', text: 'Welcome' }).startsWith('%{ CMD=news TITLE="NFSU2 Online" BTN1="OK" BTN1-GOTO="$quit" %}\r\nWelcome'));
});

test('timers: in time order, same time in the order set; cleared places compacted', () => {
  const t = new Timers();
  const a = t.set(10, { k: 'A' }), b = t.set(5, { k: 'B' }), c = t.set(10, { k: 'C' });
  t.clear(b);
  assert.equal(t.nextDue(), 10);
  assert.equal(t.popDue(9), null);
  assert.deepEqual(t.popDue(10), [a, { k: 'A' }]);
  assert.deepEqual(t.popDue(10), [c, { k: 'C' }]);
  assert.equal(t.nextDue(), null);
  const ids = [];
  for (let i = 0; i < 3000; i++) ids.push(t.set(i, { k: 'X' }));
  for (const id of ids.slice(0, 2900)) t.clear(id);
  assert.ok(t.queued() < 2000, 'compacted: ' + t.queued());
  assert.equal(t.nextDue(), 2900);
});

test('races: serde numbers', () => {
  assert.equal(serdeF64(4), '4.0');
  assert.equal(serdeF64(1792411200000), '1792411200000.0');
  assert.equal(serdeF64(1e16), '1e16');
  assert.equal(serdeF64(1.5e-7), '1.5e-7');
  assert.equal(serdeF64(0.001), '0.001');
  assert.equal(serdeF64(12.25), '12.25');
  assert.equal(serdeF64(-3), '-3.0');
  assert.equal(serdeF64(123456789012345680000), '1.2345678901234568e20');
});

test('rand and md5: as the Rust server draws them', () => {
  const p = new Prng(42n);
  for (let i = 0; i < 1000; i++) {
    const v = randInt(p, 1000, 10000);
    assert.ok(Number.isInteger(v) && v >= 1000 && v < 10000);
  }
  assert.match(randHex(p, 15), /^[0-9a-f]{30}$/);
  for (const s of ['', 'a', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(200)]) {
    assert.equal(Buffer.from(md5(new TextEncoder().encode(s))).toString('hex'), createHash('md5').update(s).digest('hex'));
  }
});

