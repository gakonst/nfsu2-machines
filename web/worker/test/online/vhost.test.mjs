// The tests of crates/online/src/tests/vhost.rs (the server's own host on the virtual LAN, 10.77.0.1: TCP as
// runtime/web/net_lan.c speaks it, the per-browser connection limit, ICMP echo, UDP "port unreachable") and of
// tests/edge.rs (numbers at the ends of their range, cleared timers), ported one for one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Core, PORT_BUDDY, PORT_HTTP, PORT_REDIRECTOR } from '../../src/online/core.js';
import { lanFrame, VHOST_VIP, SYN, SYNACK, RST, DATA, FIN, TCP_CHUNK } from '../../src/online/vhost.js';
import { Prng } from '../../src/util/prng.js';
import { world, ip } from './harness.mjs';

const enc = (s) => new TextEncoder().encode(s);
const none = new Uint8Array(0);

function parse(vip, f) {
  const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
  return {
    vip,
    kind: f[0],
    src: v.getUint32(4),
    dst: v.getUint32(8),
    sport: v.getUint16(12),
    dport: v.getUint16(14),
    op: f[16],
    cid: v.getUint32(20, true),
    data: f.slice(24),
  };
}

/** a virtual host on its own: no services but the tests', every frame out kept */
function host(o = {}) {
  const t = { t: 0 };
  const core = new Core({
    storage: null,
    log: () => {},
    claims: null,
    deny: null,
    clocks: { now: () => t.t, timer: () => t.t },
    prng: new Prng(1),
    vhost: o,
  });
  core.vh.listeners.clear();
  const out = [];
  core.attach((vip, f) => {
    out.push(parse(vip, f));
    return 'sent';
  });
  return [core, out];
}

function frame(h, from, f) {
  h.frame(from, f, { group: 'vip ' + from, site: null, cause: null, owner: null, noRaces: false });
}

// TCP: refused, accepted, data both ways, FIN, RST, a browser that leaves
test('tcp', () => {
  const [a, b] = [ip('10.77.0.2'), ip('10.77.0.3')];
  const [h, out] = host();
  frame(h, a, lanFrame(4, a, VHOST_VIP, 50000, 20920, SYN, 7, none));
  assert.deepEqual([out[0].op, out[0].dport, out[0].sport, out[0].cid], [RST, 50000, 20920, 7], 'no listener: RST');
  h.vh.listen(20920, 'probe');
  out.length = 0;
  frame(h, a, lanFrame(4, a, VHOST_VIP, 50001, 20920, SYN, 9, none));
  assert.equal(out[0].op, SYNACK);
  const [id] = h.vh.conns.entries().next().value;
  assert.equal(h.connIds(id)[1], '10.77.0.2');
  frame(h, a, lanFrame(4, a, VHOST_VIP, 50001, 20920, SYN, 9, none));
  assert.equal(out.length, 1, 'a duplicate SYN is ignored');
  frame(h, a, lanFrame(4, a, VHOST_VIP, 50001, 20920, DATA, 9, enc('hello')));
  assert.deepEqual(h.probe, ['data hello']);
  h.connWrite(id, new Uint8Array(TCP_CHUNK * 2 + 10).fill(0x41));
  {
    const data = out.filter((f) => f.op === DATA);
    assert.deepEqual(data.map((f) => f.data.length), [TCP_CHUNK, TCP_CHUNK, 10]);
    assert.ok(data.every((f) => f.src === VHOST_VIP && f.dst === a && f.vip === a && f.sport === 20920 && f.dport === 50001 && f.cid === 9));
  }
  frame(h, a, lanFrame(4, a, VHOST_VIP, 50001, 20920, FIN, 9, none));
  assert.deepEqual(h.probe, ['data hello', 'end', 'close closed']);
  assert.equal(out[out.length - 1].op, FIN);
  assert.equal(h.info().conns, 0);
  out.length = 0;
  frame(h, a, lanFrame(4, a, VHOST_VIP, 50001, 20920, DATA, 9, enc('late')));
  assert.equal(out[0].op, RST, 'data for an unknown connection: RST');
  // the browser resets; another one leaves the switch
  frame(h, a, lanFrame(4, a, VHOST_VIP, 50002, 20920, SYN, 10, none));
  frame(h, a, lanFrame(4, a, VHOST_VIP, 50002, 20920, RST, 10, none));
  assert.equal(h.probe[h.probe.length - 1], 'close reset by the game');
  frame(h, b, lanFrame(4, b, VHOST_VIP, 50003, 20920, SYN, 11, none));
  h.peerGone(b);
  assert.equal(h.probe[h.probe.length - 1], 'close the browser left');
  assert.equal(h.info().conns, 0);
});

// TCP: at most perVip connections per browser
test('per_vip', () => {
  const [a, b] = [ip('10.77.0.2'), ip('10.77.0.3')];
  const [h, out] = host({ perVip: 2 });
  h.vh.listen(20922, 'silent');
  for (let i = 0; i < 3; i++) frame(h, a, lanFrame(4, a, VHOST_VIP, 50010 + i, 20922, SYN, 100 + i, none));
  assert.deepEqual(out.map((f) => f.op), [SYNACK, SYNACK, RST]);
  frame(h, b, lanFrame(4, b, VHOST_VIP, 50020, 20922, SYN, 200, none));
  assert.equal(out[out.length - 1].op, SYNACK, 'another browser has its own budget');
});

// ICMP echo and UDP
test('icmp_and_udp', () => {
  const a = ip('10.77.0.2');
  const [h, out] = host();
  const req = Uint8Array.from([8, 0, 0, 0, 0x12, 0x34, 0, 1, 1, 2, 3, 4, 5]);
  frame(h, a, lanFrame(5, a, VHOST_VIP, 0, 0, 0, 0, req));
  {
    const r = out[0];
    assert.equal(r.kind, 5);
    assert.equal(r.data[0], 0);
    assert.deepEqual([...r.data.subarray(4)], [...req.subarray(4)]);
    let sum = 0;
    let i = 0;
    while (i + 1 < r.data.length) {
      sum += (r.data[i] << 8) | r.data[i + 1];
      i += 2;
    }
    sum += r.data[r.data.length - 1] << 8;
    while (sum >>> 16 !== 0) sum = (sum & 0xffff) + (sum >>> 16);
    assert.equal(sum, 0xffff, 'the reply checksum is right');
  }
  frame(h, a, lanFrame(5, a, VHOST_VIP, 0, 0, 0, 0, new Uint8Array(8)));
  assert.equal(out.length, 1, 'only echo requests are answered');
  frame(h, a, lanFrame(3, a, VHOST_VIP, 3658, 3658, 0, 0, enc('x')));
  assert.deepEqual([out[1].kind, out[1].op, out[1].sport, out[1].dport], [3, 1, 3658, 3658]);
});

// ---- tests/edge.rs ----

// a ranking asked for on the channel of the lowest 32-bit number (CHAN=2147483648 is -2^31 for `| 0`): the answer is
// an empty ranking; `chan - 6` overflowed here once in the Rust host
test('snap_on_the_channel_at_the_end_of_the_range', () => {
  const w = world();
  const g = w.client('10.77.0.2');
  const a = w.login(g, 'Alpha');
  for (const chan of ['2147483648', '-2147483648', '-2147483643', '2147483647', '4294967295']) {
    w.send(a, 'snap', [['INDEX', 1], ['CHAN', chan], ['RANGE', 10]]);
    const m = w.conn(a).l('snap');
    assert.deepEqual([m.g('COUNT'), m.g('TOTAL')], ['0', '0'], 'CHAN=' + chan);
    w.send(a, 'snap', [['INDEX', 1], ['CHAN', chan], ['FIND', '$']]);
    assert.equal(w.conn(a).l('snap').g('COUNT'), '0', 'CHAN=' + chan + ' FIND=$');
  }
  assert.equal(w.conn(a).l('snap').g('CHAN'), '-1', "the channel as JavaScript's | 0 makes it");
  assert.ok(!w.conn(a).reset, 'the session stays');
});

// streams opened and reset as fast as a client may: each sets a time-out (EA Messenger's 60 s for a login, the
// redirector's 30 s, the web pages' 15 s) that its reset clears; a cleared timer is gone, not held in the queue
test('cleared_timers_leave_the_queue', () => {
  const w = world();
  w.mute = true;
  const g = w.client('10.77.0.2');
  const before = w.core.timers.queued();
  for (let k = 0; k < 100000; k++) {
    const port = [PORT_BUDDY, PORT_REDIRECTOR, PORT_HTTP][k % 3];
    const sport = 1000 + (k % 50000);
    w.raw(g, lanFrame(4, g, VHOST_VIP, sport, port, SYN, k, none));
    w.raw(g, lanFrame(4, g, VHOST_VIP, sport, port, RST, k, none));
  }
  assert.equal(w.core.vh.conns.size, 0);
  const queued = w.core.timers.queued();
  assert.ok(queued < before + 2048, queued + ' places in the timer queue for ' + before + ' live timers');
});

