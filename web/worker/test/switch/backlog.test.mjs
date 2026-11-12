// Port of web/server-rs/crates/lan/tests/backlog.rs: the Online host behind.  In Rust, what a client sent the Online
// host waited in that client's socket once the host's backlog passed 4096 frames (nfsu2_util::Backlog, lib.rs:959-960,
// reader.rs:78-90, route.rs:207), as Node's one busy thread stopped reading; nobody else waited, and once the host
// caught up the rest came in order.
//
// The JS port has no such backlog: the hosts run synchronously inside the switch's step (lib.js _post / _settle drain
// the hosts' mailbox before the step ends; route.js routeOne posts online.frame), so a host can never be "behind" the
// way the Rust host's thread was: a host that keeps (does not handle) its frames still has each one handed to it at
// once.  What still applies is asserted here: nobody else waits, every one of Alice's frames reaches the host, in
// order, and a page coming back on a new connection takes its address over with the old one terminated (1006).  The
// 4096-frame bound and "nothing more of Alice's while the host is behind" cannot apply (see known differences); they
// are kept below as comments next to what the JS switch does instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startFull, opts, Client, frameOf, bundleOf, waitFor, sleep, resetWorld, str } from './harness.js';

const ONLINE = 0x0a4d0001;

/** an Online host whose thread is stuck: it keeps every frame (in Rust, and with it the frame's place in the backlog) */
class Stuck {
  constructor() {
    this.vip = ONLINE;
    this.name = 'NFSU2 Online';
    this.holding = true;
    this.held = [];
    this.n = 0;
    /** the payloads in the order the host was given them (to check the order) */
    this.seen = [];
  }
  listed() {
    return true;
  }
  frame(data, ctx) {
    this.n++;
    this.seen.push(str(data.subarray(16)));
    if (this.holding) this.held.push([data, ctx]);
  }
  peerGone() {}
  info() {
    return {};
  }
  vips() {
    return new Set();
  }
  stop() {}
  got() {
    return this.n;
  }
  /** the thread catches up: what it held is handled, and from now on each frame at once */
  release() {
    this.holding = false;
    this.held.length = 0;
  }
}

/** Alice sends the host 8000 stream frames, 100 to a message (numbered, so the order can be checked) */
function feed(a) {
  for (let m = 0; m < 80; m++) {
    const e = [];
    for (let i = 0; i < 100; i++) e.push([frameOf(ONLINE, 'lobby bytes ' + (m * 100 + i), 4, 40000, 20922), []]);
    a.binary(bundleOf(e));
  }
  a.flush();
}

const inOrder = (seen) => seen.length === 8000 && seen.every((s, i) => s === 'lobby bytes ' + i);

test('a_host_behind_slows_down_only_the_clients_that_feed_it', () => {
  resetWorld();
  const stuck = new Stuck();
  // budgets that never stop these frames: the backlog alone must
  const o = opts({ frameRate: 1e7, byteRate: 1e10, groupFrameRate: 1e7, groupByteRate: 1e10, siteFrameRate: 1e7, siteByteRate: 1e10 });
  const sw = startFull(o, '', stuck, null, null);
  const a = Client.with(sw, 'Alice', '?g=a', {});
  const b = Client.with(sw, 'Bob', '?g=b', {});
  const c = Client.with(sw, 'Carol', '?g=c', {});
  for (const x of [a, b, c]) x.welcome();
  feed(a);
  sleep(500);
  const held = stuck.got();
  // Rust: assert (4096..=4096+200).contains(held): "4096 and one message more at most" while it was stuck.  The JS
  // switch has no backlog: the stuck host was handed every frame at once (known difference).
  assert.equal(held, 8000, 'no backlog in the JS switch: the host was given all of Alice\'s frames at once');
  // and nobody else waits: Bob's datagram reaches Carol
  b.udp(c.vip, 47210, 47210, 'free roam goes on', 1, 0);
  c.untilMs(2000, (g) => (g.dgrams().some((d) => d.data === 'free roam goes on') ? true : null));
  assert.equal(stuck.got(), held, 'nothing more of Alice\'s (here: nothing more to come)');
  // the host catches up: all of Alice's frames came, in order
  stuck.release();
  waitFor(5000, () => stuck.got() === 8000);
  assert.equal(stuck.got(), 8000);
  assert.ok(inOrder(stuck.seen), 'every frame, in the order Alice sent them');
  assert.ok(a.isOpen() && b.isOpen() && c.isOpen());
  sw.close();
});

// A reader that waits for the host still ends when its connection must go: Alice's page comes back on a new connection
// while her old one waits, the new one takes her address over and the old one is terminated (its socket closes only
// once its reader has returned), with the host still stuck.  Her frames the host has not handled keep their places.
// (In JS the old connection never waits: what still applies is the takeover, the 1006 and that nothing more comes.)
test('a_client_waiting_for_the_host_still_goes_when_it_must', () => {
  resetWorld();
  const stuck = new Stuck();
  const o = opts({ frameRate: 1e7, byteRate: 1e10, groupFrameRate: 1e7, groupByteRate: 1e10 });
  const sw = startFull(o, '', stuck, null, null);
  const a = Client.with(sw, 'Alice', '?g=a', {});
  a.welcome();
  feed(a);
  waitFor(2000, () => stuck.got() >= 4096);
  sleep(200);
  const held = stuck.got();
  // Rust: assert held < 8000, "Alice's reader waits".  No backlog in the JS switch: all of them were handed over
  // (known difference).
  assert.equal(held, 8000, 'no backlog in the JS switch: every frame handed to the host at once');
  assert.ok(inOrder(stuck.seen), 'in order');
  const again = new Client(sw, 'Alice', '?g=a', [a.vip, a.token], {});
  assert.equal(again.welcome().vip >>> 0, a.vip, 'her address, on the new connection');
  assert.deepEqual(a.closed(), [1006, ''], 'the old connection ended: no close frame (terminate)');
  assert.equal(sw.peers().length, 1);
  assert.equal(stuck.got(), held, 'nothing more of the old connection\'s');
  stuck.release();
  sw.close();
});
