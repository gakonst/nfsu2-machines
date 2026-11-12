// mix.rs's unit tests, ported (web/server-rs/crates/lan/src/mix.rs mod tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROAM_OK } from '../../src/switch/compact.js';
import {
  ADDRS, FRAMING, HUB_VIP, IN_BUNDLE, KIND, KINDS, MSGS, OUT_BUNDLE, OUT_PING, OUT_WRITES, TEXT, fmtFixed, kindsLine, line,
  msgLine, name, ofEntry, ofHost, ofPage,
} from '../../src/switch/mix.js';

const BASE = ((10 << 24) | (77 << 16)) >>> 0;
const BROADCAST = 0xFFFFFFFF;
const ROAM_PORT = 47210;
const addr = (x) => (BASE | x) >>> 0;

test('kinds line says each kind with players, a second and each one\'s', () => {
  const k = (kind, players, msgsIn, msgsOut) => ({ kind, players, msgsIn, msgsOut });
  const kinds = [k('racing or in a race lobby', 10, 30_000, 45_000), k('in Online mode', 0, 0, 0), k('driving in free roam', 4, 24_000, 24_600)];
  assert.equal(
    kindsLine(kinds, 300.0),
    'racing or in a race lobby 10: 100 in, 150 out a second (10.0 and 15.0 each); driving in free roam 4: 80 in, 82 out a second (20.0 and 20.5 each)',
  );
  assert.equal(kindsLine([k('in Online mode', 0, 5, 5)], 300.0), null);
});

function frame(kind, b1, src, dport, data) {
  const f = new Uint8Array(16 + data.length);
  const dv = new DataView(f.buffer);
  f[0] = kind;
  f[1] = b1;
  dv.setUint32(4, src >>> 0);
  dv.setUint32(8, addr(9));
  dv.setUint16(12, ROAM_PORT);
  dv.setUint16(14, dport);
  f.set(data, 16);
  return f;
}

// every kind has a name, the entries and the hosts' messages land where they are
test('kinds', () => {
  const roam = new Uint8Array(24);
  roam.set([0x4E, 0x32, 0x46, 0x52, 1, 6]);
  assert.equal(name(ofEntry(frame(1, ROAM_OK, addr(2), ROAM_PORT, roam), addr(2), addr(9))), 'ping');
  const dents = roam.slice();
  dents[5] = 20;
  assert.equal(name(ofEntry(frame(1, ROAM_OK, addr(2), ROAM_PORT, dents), addr(2), addr(9))), 'crash damage');
  dents[5] = 18;
  assert.equal(name(ofPage(frame(1, 0, addr(2), ROAM_PORT, dents), HUB_VIP)), 'hub near ask');
  assert.equal(name(ofEntry(frame(1, 0, addr(2), ROAM_PORT, roam), addr(2), addr(9))), "free roam's port, unchecked");
  assert.equal(name(ofEntry(frame(1, 0, addr(2), 3659, roam), addr(2), addr(9))), 'UDP, other ports');
  assert.equal(name(ofEntry(frame(3, 0, addr(2), 9999, roam), addr(2), addr(9))), 'LAN UDP');
  assert.equal(name(ofEntry(frame(3, 0, addr(2), 9999, roam), addr(2), BROADCAST)), 'LAN UDP broadcast');
  assert.equal(name(ofEntry(Uint8Array.of(3, 0, 0), addr(2), addr(9))), 'other frames');
  const peers = roam.slice();
  peers[5] = 2;
  const hub = addr(0xFD), online = addr(1);
  assert.equal(name(ofHost(frame(1, 0, addr(0xFD), ROAM_PORT, peers), hub, online)), 'hub peers');
  assert.equal(name(ofEntry(frame(1, ROAM_OK, addr(0xFD), ROAM_PORT, peers), addr(0xFD), addr(9))), 'hub peers');
  assert.equal(name(ofEntry(frame(1, ROAM_OK, addr(2), ROAM_PORT, peers), addr(2), addr(9))), 'peers');
  peers[5] = 200;
  assert.equal(name(ofHost(frame(1, 0, addr(0xFD), ROAM_PORT, peers), hub, online)), 'hub ?');
  assert.equal(name(ofHost(frame(4, 0, addr(1), 0, new Uint8Array(30).fill(1)), hub, online)), 'Online server');
  assert.equal(name(ofHost(frame(4, 0, addr(7), 0, new Uint8Array(30).fill(1)), hub, online)), 'other host');
  assert.equal(name(ofPage(frame(1, 0, addr(2), ROAM_PORT, roam), addr(9))), 'ping');
  assert.equal(name(ofPage(frame(1, 0, addr(2), ROAM_PORT, peers), HUB_VIP)), 'hub ?');
  assert.equal(name(ofPage(frame(4, 0, addr(2), 0, new Uint8Array(30).fill(1)), addr(1))), 'LAN TCP');
  assert.equal(name(ofPage(frame(3, 0, addr(2), 9999, roam), BROADCAST)), 'LAN UDP broadcast');
  for (const k of [ADDRS, FRAMING, TEXT]) assert.ok(name(k).length > 0);
  const names = new Set(Array.from({ length: KINDS }, (_, i) => name(i)));
  assert.equal(names.size, KINDS, 'each its own');
});

test('the line', () => {
  const now = new Array(2 * KINDS).fill(0);
  now[3] = 30_000_000;
  now[KINDS + 3] = 1_000_000;
  now[KIND.LAN_UDP] = 60_000_000;
  now[KINDS + KIND.LAN_UDP] = 500_000;
  now[6] = 100;
  now[KINDS + 6] = 5;
  const l = line(now, [], 300.0);
  assert.ok(l.startsWith('2.4 Mbit/s: LAN UDP 67 % (1.6 Mbit/s, 1667/s, 120.0 B each), car state 33 %'), l);
  assert.ok(l.endsWith(', 1 smaller kinds'), l);
  assert.equal(line(now, now, 300.0), null);
});

test('the message line', () => {
  const now = new Array(MSGS).fill(0);
  now[IN_BUNDLE] = 6000;
  now[OUT_BUNDLE] = 3000;
  now[OUT_PING] = 300;
  now[OUT_WRITES] = 3000;
  const l = msgLine(now, [], 300.0);
  assert.ok(l.startsWith('in 20/s (bundles 20, frames 0, control 0, pongs 0, pings 0), out 11/s (bundles 10,'), l);
  assert.ok(l.endsWith('pings 1, pongs 0) in 10 writes/s'), l);
  assert.equal(msgLine(now, now, 300.0), null);
});

// (JS only) Rust's {:.0} and {:.1}: ties to even on the exact value, every digit of a large one, inf and NaN
test('numbers as format! writes them', () => {
  const cases = [
    [0.5, '0', '0.5'], [1.5, '2', '1.5'], [2.5, '2', '2.5'], [0.25, '0', '0.2'], [0.75, '1', '0.8'], [0.05, '0', '0.1'],
    [0.35, '0', '0.3'], [1e21, '1000000000000000000000', '1000000000000000000000.0'], [Infinity, 'inf', 'inf'],
    [NaN, 'NaN', 'NaN'], [-0, '-0', '-0.0'], [123.456, '123', '123.5'], [99.95, '100', '100.0'],
  ];
  for (const [x, a, b] of cases) {
    assert.equal(fmtFixed(x, 0), a, String(x));
    assert.equal(fmtFixed(x, 1), b, String(x));
  }
});
