// Port of web/server-rs/crates/lan/tests/races.rs: a player under a race ban (the crate doc's Kicks and bans) stays on
// the switch, but no frame that races another player goes from it or to it: LAN play, free roam's outrun and lobby
// messages (in a bundle too); its other free-roam datagrams pass.  A hello under a name taken away is turned away with
// CLOSE_RENAME.

import test from 'node:test';
import assert from 'node:assert/strict';
import { start, opts, Client, waitFor, sleep, resetWorld, frameOf, utf8, cmpStr } from './harness.js';
import { CLOSE_RENAME } from '../../src/switch/lib.js';

const ROAM_PORT = 47210;

/** a free-roam datagram of type t (runtime/roam_core.h: "N2FR", version 1, type, then the rest of its header) */
function roam(t) {
  return Uint8Array.from([...utf8('N2FR'), 1, t, ...new Array(26).fill(0)]);
}

/** what c got from 'from' (sorted: LAN play's datagrams and stream segments wait for clocks of their own): LAN play's
 * kinds, and free roam's datagram types */
function gotFrom(c, from) {
  return c.got().dgrams()
    .filter((d) => d.src === from >>> 0)
    .map((d) => (d.kind === 1 && d.buf.length > 21 ? 'roam ' + d.buf[21] : 'kind ' + d.kind))
    .sort(cmpStr);
}

/** a sends b LAN play's UDP and TCP, an outrun's, a lobby's and a PING's datagram, and an outrun's in a bundle */
function sendAll(a, b) {
  a.udp(b.vip, 9999, 9999, 'lan', 3, 0);
  a.udp(b.vip, 50000, 9900, 'seg', 4, 0);
  for (const t of [9, 12, 6]) a.udp(b.vip, ROAM_PORT, ROAM_PORT, roam(t), 1, 0);
  a.sendBundle([[frameOf(b.vip, roam(9), 1, ROAM_PORT, ROAM_PORT), []]]);
}

test('a_race_banned_player_races_nobody_and_drives_on', () => {
  resetWorld();
  const sw = start(opts());
  const a = Client.with(sw, 'Ann', '?norace=pa', { id: 'pa', lan: 1 });
  a.welcome();
  const b = Client.with(sw, 'Bob', '?norace=pa', { id: 'pb', lan: 1 });
  b.welcome();
  a.until((g) => g.ctl.find((m) => m.t === 'races') ?? null);
  waitFor(2000, () => sw.peerNamed('Bob')?.hello);
  assert.ok(b.got().ctl.every((m) => m.t !== 'races'));
  // either way: only the PING
  sendAll(a, b);
  sendAll(b, a);
  sleep(300);
  assert.deepEqual(gotFrom(b, a.vip), ['roam 6']);
  assert.deepEqual(gotFrom(a, b.vip), ['roam 6']);
  assert.ok(a.isOpen() && b.isOpen());

  // the operator lifts it while Ann plays: everything goes; and puts one on Bob
  assert.ok(sw.setRaces(a.vip, false, utf8(JSON.stringify({ t: 'races', lifted: true }))));
  a.until((g) => g.ctl.find((m) => m.lifted === true) ?? null);
  sendAll(a, b);
  sleep(300);
  assert.deepEqual(gotFrom(b, a.vip), ['kind 3', 'kind 4', 'roam 12', 'roam 6', 'roam 6', 'roam 9', 'roam 9']);
  assert.ok(sw.setRaces(b.vip, true, utf8(JSON.stringify({ t: 'races', msg: 'x' }))));
  sendAll(a, b);
  sleep(300);
  assert.equal(gotFrom(b, a.vip).length, 8, 'one more: the PING');
  assert.ok(!sw.setRaces(0x0a4d1717, true, utf8('{}')), 'nobody there');
  sw.close();
});

test('a_name_taken_away_is_asked_for_another', () => {
  resetWorld();
  const sw = start(opts());
  const c = Client.with(sw, 'BadName', '?rename=BadName', { id: 'pc' });
  c.welcome();
  assert.deepEqual(c.closed(), [CLOSE_RENAME, 'rename']);
  assert.equal(c.got().ctl.find((m) => m.t === 'rename')?.name, 'BadName');
  waitFor(2000, () => sw.peers().length === 0);
  assert.equal(sw.reserved().length, 0, 'its address free at once');
  // under another name: let be
  const d = Client.with(sw, 'GoodName', '?rename=BadName', { id: 'pc' });
  d.welcome();
  sleep(100);
  assert.ok(d.isOpen() && sw.has(d.vip));
  sw.close();
});
