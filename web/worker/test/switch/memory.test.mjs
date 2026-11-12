// tests/memory.rs: what the switch keeps of a burst once it is over.  The Rust test counted the bytes its allocator held
// for the process (a test binary of its own); JS has no allocator to count, so the same rule is asserted on the
// switch's own state: once the burst went, the receiver's connection holds no queued item, no buffered or pending
// byte, no stream queue, and no buffer grown for the burst (the writer's bundle buffer keeps its first size), and the
// switch keeps no per-burst state (its streams, the receiver's writer idle).  The kernel's buffers (SO_SNDBUF /
// SO_RCVBUF of 8 KiB) are the harness's pipe of 8 KiB that the receiver reads only when told to.

import test from 'node:test';
import assert from 'node:assert/strict';

import { start, opts, rawPeer, Client, sleep, resetWorld, headerLen } from './harness.js';

/// A receiver whose link stalls (a tunnel's hiccup: every player's at once) gets what waited in one write when the
/// link comes back.  That write's buffers are let go once it went: kept, they were a burst's worth for every
/// connection for good (at 2000 players the hello's peer list alone, about 100 KB, made it 256 MB).
test('a_bursts_buffers_are_not_kept_once_it_went', () => {
  resetWorld();
  const sw = start(opts({
    frameRate: 100000.0,
    byteRate: 64 << 20,
    groupFrameRate: 100000.0,
    groupByteRate: 64 << 20,
    sendBufferOs: 8 << 10,
  }));
  // reads nothing until told to: its link stalls
  const receiver = rawPeer(sw, 'Receiver', '?g=r', 8 << 10);
  const sender = Client.with(sw, 'Sender', '?g=s', {});
  sender.welcome();
  sleep(200);
  const pv = sw.peerNamed('Receiver');
  assert.ok(pv);
  const conn = sw.lan.table.get(pv.vip).conn;
  const bodyCap = conn.w.body.buf.length;
  // a queue of shedQueue's worth (256 KB) of LAN play's datagrams, in frames of about 100 bytes, once the kernel's
  // buffers are full: 3000 of them with the small buffers asked for above (the Rust test sent more where macOS gave
  // a loopback connection far more room; the harness's pipe holds exactly 8 KiB)
  const buffered = () => sw.peers().find((p) => p.vip === pv.vip)?.buffered ?? 0;
  let sent = 0;
  const payload = new Uint8Array(84).fill(7);
  while (sent < 3000 || (buffered() <= 128 << 10 && sent < 80_000)) {
    for (let i = 0; i < 500; i++) sender.udp(pv.vip, 1, 2, payload, 3, 0);
    sent += 500;
    sender.flush();
    sleep(5);
  }
  sleep(300);
  const queued = buffered();
  // the link is back: all of it goes, then nothing more comes (Rust: reads until 300 ms bring nothing)
  let got = 0;
  for (;;) {
    const msgs = receiver.read(64 << 10);
    if (msgs.length === 0) {
      sleep(300);
      if (receiver.read(64 << 10).length === 0 && receiver.inKernel === 0 && receiver.held === 0) break;
      continue;
    }
    for (const m of msgs) got += headerLen(m.data.length) + m.data.length;
  }
  sleep(100);
  // what the switch kept of the burst (Rust: the heap's bytes live, less than 96 KiB more than before)
  const s = sw.lan.streams.byConn.get(conn.id);
  const kept = {
    queue: conn.q.length, buffered: conn.buffered, dgram: conn.dgram, pending: conn.w.pending, busy: conn.w.busy,
    finish: conn.w.finish !== null, streams: s ? s.sq.length - s.head + s.total : 0, body: conn.w.body.buf.length,
  };
  console.log(sent + ' datagrams; queued ' + queued + ' bytes, the receiver read ' + got + '; kept after the burst: ' + JSON.stringify(kept));
  assert.ok(queued > 128 << 10, "the receiver's queue filled (" + queued + ')');
  assert.ok(got > queued, 'the receiver got it all (' + got + ')');
  assert.deepEqual(kept, { queue: 0, buffered: 0, dgram: 0, pending: 0, busy: false, finish: false, streams: 0, body: bodyCap },
    "the burst's buffers went with it");
  assert.ok(pv.open !== false && sw.has(pv.vip), 'the receiver is still on the switch (not cut for the burst)');
  sender.close();
  receiver.drop();
  sw.close();
});

