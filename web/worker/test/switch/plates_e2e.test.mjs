// Port of web/server-rs/crates/lan/tests/plates.rs: free roam's license plates through the switch (src/plates.rs,
// src/switch/plates.js): a HELLO whose plate is broken or reads as a slur goes on without it (a [plate] line for the
// slur), so the player is still heard; a new plate goes once per 10 s at most (the HELLO goes on with the last one
// meanwhile), the same one always; and a HELLO without one is not looked at.

import test from 'node:test';
import assert from 'node:assert/strict';
import { start, opts, Client, sleep, resetWorld, utf8 } from './harness.js';
import { crc32 } from '../../src/switch/crc32.js';

/** a HELLO of core 17 from "Ann": its header's flags, then (ext) the crews' count, the links, the outrun's player and
 * the flag's length, 0 each, and with plate its length and bytes; CRC and length right */
function datagram(flags, ext, plate) {
  const d = new Array(29).fill(0);
  d.splice(0, 4, ...utf8('N2FR'));
  d[4] = 1;
  d[5] = 1;
  d[14] = flags & 255;
  d[15] = flags >> 8;
  d[16] = 17;
  d[19] = 2;
  d[28] = 3;
  d.push(...utf8('Ann'));
  d.push(0); // the ids it hears
  if (ext) d.push(0, 0, 0, 0, 0, 0, 0); // crews, links, outrun, flag
  if (plate != null) {
    d.push(plate.length);
    d.push(...plate);
  }
  const n = d.length + 4;
  d[6] = n & 255;
  d[7] = n >> 8;
  const crc = crc32(Uint8Array.from(d)) >>> 0;
  d.push(crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, crc >>> 24);
  return Uint8Array.from(d);
}

/** the HELLO a game sends with plate text ("" none: no flag, no plate) */
function hello(text) {
  const t = typeof text === 'string' ? utf8(text) : text;
  return t.length === 0 ? datagram(0x0200, false, null) : datagram(0x8200, true, t);
}

test('broken_plates_and_slurs_go_on_without_their_plate_a_new_plate_once_per_ten_seconds', () => {
  resetWorld();
  const sw = start(opts());
  const lines = [];
  sw.lan.onLine((s) => lines.push(s));
  const a = Client.connect(sw, 'Ann');
  a.welcome();
  const b = Client.connect(sw, 'Bob');
  b.welcome();
  const send = (d) => a.udp(b.vip, 47210, 47210, d, 1, 0);
  const broken = ['123456789', 'bad', 'A B', 'A\0B', '\u00c9'].map(utf8);
  const slurs = ['N1GGER', 'N1GGER', '1488'].map(utf8);
  for (const t of [...broken, ...slurs]) send(hello(t));
  // a good one, the same one again, another within 10 s, one without a plate; and one whose CRC is wrong
  send(hello('AB123456'));
  send(hello('AB123456'));
  send(hello('XYZ789'));
  send(hello(''));
  const bad = hello('N1GGER');
  bad[bad.length - 1] ^= 1;
  send(bad);
  const want = broken.map((t) => datagram(0x0200, true, t)); // the flag off, the rest as it came
  want.push(...slurs.map(() => datagram(0x0200, true, null))); // the plate taken out
  want.push(hello('AB123456'), hello('AB123456'), hello('AB123456'), hello(''), bad.slice());
  b.untilTrue((g) => g.frames.length >= want.length);
  // Rust slept 300 ms of real time for anything more to come: 300 ms of virtual time here
  sleep(300);
  const got = b.got().frames.map(([f]) => Array.from(f.subarray(16)));
  assert.deepEqual(got, want.map((w) => Array.from(w)), 'what came');
  const l = lines.slice();
  assert.equal(l.length, 3, JSON.stringify(l));
  assert.ok(l[0].startsWith('[plate] ') && l[0].endsWith('"Ann" N1GGER: reads as a slur, dropped (its HELLOs go on without it)'), JSON.stringify(l));
  assert.ok(l[1].endsWith('"Ann" 1488: reads as a slur, dropped (its HELLOs go on without it)'), JSON.stringify(l));
  assert.ok(l[2].endsWith('"Ann" AB123456'), JSON.stringify(l));
  a.close();
  b.close();
  sw.close();
});
