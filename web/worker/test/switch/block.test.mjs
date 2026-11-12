// Port of web/server-rs/crates/lan/tests/block.rs: a page's blocks: the hello's "block" goes to the free-roam hub
// (host.blocks) as the names the game shows, with the page's address; a hello without one says nothing.  Every
// connection's hello hands them over: a resumed one's (the hub forgot them when the old connection went) and one let in
// from the line too.  (tests/page.rs has the page's own code send it.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFull, opts, Client, rawPeer, rawWs, BlockHub, waitFor, sleep, resetWorld } from './harness.js';

test('a_pages_block_reaches_the_free_roam_hub_with_its_address', () => {
  resetWorld();
  const hub = new BlockHub();
  const sw = startFull(opts(), '', null, hub, null);
  const _quiet = rawPeer(sw, 'bob', '');
  const s = rawWs(sw, '');
  s.text(JSON.stringify({ t: 'hello', name: 'anna', block: [' Bob ', 'carl'] }));
  waitFor(3000, () => sw.peerNamed('anna')?.hello);
  sleep(100);
  const g = hub.got.slice();
  const anna = sw.peerNamed('anna').vip;
  assert.deepEqual(g, [[anna, ['Bob', 'carl']]], 'anna\'s blocks, and nothing for bob');
});

const BLOCKS = ['Bob', 'carl'];
const blocks = () => BLOCKS.slice();

// anna's connection drops (no close: its address kept for its token) and the hub hears it left; the page comes back
// with the token, and its hello hands the blocks over again, after the leaving
test('a_resumed_connection_hands_the_blocks_over_again', () => {
  resetWorld();
  const hub = new BlockHub();
  const sw = startFull(opts(), '', null, hub, null);
  const o = () => ({ block: BLOCKS });
  const a = Client.with(sw, 'anna', '', o());
  a.welcome();
  const [vip, token] = [a.vip, a.token];
  waitFor(3000, () => hub.got.length === 1);
  a.terminate();
  waitFor(5000, () => hub.got.length === 2);
  const b = new Client(sw, 'anna', '', [vip, token], o());
  b.welcome();
  assert.equal(b.vip, vip, 'the same address');
  waitFor(3000, () => hub.got.length === 3);
  assert.deepEqual(hub.got, [[vip, blocks()], [vip, []], [vip, blocks()]], 'blocks, gone, blocks again');
  b.close();
  sw.close();
});

// a full switch: anna's page waits in line with its hello; let in, its blocks reach the hub
test('a_page_let_in_from_the_line_hands_its_blocks_over', () => {
  resetWorld();
  const hub = new BlockHub();
  const sw = startFull(opts({ maxPeers: 1, lineTellMs: 100 }), '', null, hub, null);
  const first = Client.connect(sw, 'first');
  first.welcome();
  const a = Client.with(sw, 'anna', '?queue', {});
  a.text(JSON.stringify({ t: 'hello', name: 'anna', block: BLOCKS }));
  a.until((g) => g.ctl.find((m) => m.t === 'queue') ?? null);
  assert.equal(hub.got.length, 0, 'nothing while it waits');
  first.closeWith(1000, 'idle');
  a.welcome();
  waitFor(3000, () => hub.got.some(([, n]) => n.length > 0));
  const mine = hub.got.filter(([, n]) => n.length > 0);
  assert.deepEqual(mine, [[a.vip, blocks()]]);
  a.close();
  sw.close();
});
