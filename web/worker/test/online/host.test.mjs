// The tests of crates/online/src/tests/thread.rs, on the JS OnlineHost wrapper (online.js).  The Rust host runs on a
// thread of its own (frames posted, info()/vips() answered through a channel after what was posted before them); the
// JS host is one sans-IO object that runs in the caller's turn, so the same scenarios run with every answer already
// there when the call returns (Rust's wait_for and blocking_recv are a plain read here), with the switch's clock
// passed to each call: its answers through the sw it was given (with the frame's budgets), an overspent client's
// stream closed, stop() writing the files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OnlineHost, PORT_LOBBY, PORT_BUDDY, VHOST_VIP } from '../../src/online/online.js';
import { FrameReader, FieldMap, encodeFrame } from '../../src/online/aries.js';
import { lanFrame, DATA, RST, SYN, SYNACK } from '../../src/online/vhost.js';
import { MapStorage, Store } from '../../src/online/files.js';
import { shelfTexts } from '../../src/online/buddy.js';
import { monthOf } from '../../src/online/jsx.js';
import { Prng } from '../../src/util/prng.js';
import { ip } from './harness.mjs';

const T0 = 1792411200000; // Date.UTC(2026, 9, 19, 12)

/** a client's budgets: overspent once over is set */
class Budget {
  constructor() {
    this.spent = 0;
    this.over = false;
  }
  spend(_frames, bytes) {
    this.spent += bytes;
  }
  overspent() {
    return this.over;
  }
}

test('on_its_own_thread', () => {
  const storage = new MapStorage();
  const lines = [];
  const out = [];
  let t = T0;
  const host = new OnlineHost({
    sw: {
      send(vip, f, cause) {
        if (cause) cause.spend(1, f.length);
        out.push([vip, f.slice()]);
        return 'sent';
      },
    },
    prng: new Prng(1),
    storage,
    nowMs: t,
    options: { log: (s, k) => lines.push([s, k ?? null]) },
  });
  const a = ip('10.77.0.2');
  const budget = new Budget();
  const ctx = (b) => ({ group: 'client a', site: null, cause: b, owner: null, noRaces: false });
  const send = (op, data) => lanFrame(4, a, VHOST_VIP, 50000, PORT_LOBBY, op, 7, data);
  host.frame(send(SYN, new Uint8Array(0)), ctx(budget), (t += 1));
  for (const [kind, f] of [
    ['auth', [['NAME', 'Alpha'], ['PASS', 'x']]],
    ['pers', [['PERS', 'Alpha']]],
    ['move', [['NAME', 'Lounge']]],
  ]) {
    host.frame(send(DATA, encodeFrame(kind, '', f)), ctx(budget), (t += 1));
  }
  let info = host.info();
  assert.deepEqual([info.sessions, info.personas, info.logins], [1, 1, 1]);
  assert.deepEqual([...host.vips()], [a]);
  assert.ok(budget.spent > 0, 'the answers were charged to the client');
  assert.ok(out.some(([v, f]) => v === a && f[16] === SYNACK));
  const r = new FrameReader(1 << 16);
  const kinds = out.filter(([, f]) => f[16] === DATA).flatMap(([, f]) => r.push(f.subarray(24))).map((m) => m.kind);
  assert.ok(kinds.includes('pers') && kinds.includes('move'), kinds.join(','));
  assert.ok(lines.some(([s, k]) => s.includes('logged in as "Alpha"') && k === 'client a'));
  // the client spent more than its share on a frame: the stream it came on goes, uncharged
  budget.over = true;
  host.frame(send(DATA, encodeFrame('mesg', '', [['TEXT', 'hi']])), ctx(budget), (t += 1));
  // (Rust waits for the host's thread here; the JS host has done it when frame returns)
  assert.ok(out.some(([, f]) => f[16] === RST), 'the stream went');
  info = host.info();
  assert.deepEqual([info.overrun, info.sessions], [1, 0]);
  // a browser that left; the server stops: the files are there when stop() returns
  host.peerGone(a, (t += 1));
  host.stop((t += 1));
  const keys = [...storage.m.keys()];
  assert.ok(!keys.includes('online/stats.json') && !keys.some((k) => k.startsWith('online/friends/')), 'nothing to keep: no file: ' + keys);
});

test('stop_writes_what_is_kept', () => {
  const storage = new MapStorage();
  storage.put('online/buddies.json', '{"personas":[{"name":"Alpha","seen":"2025-01","B":["Bravo"]}]}');
  const out = [];
  let t = T0;
  const host = new OnlineHost({
    sw: {
      send(_vip, f) {
        out.push(f.slice());
        return 'sent';
      },
    },
    prng: new Prng(2),
    storage,
    nowMs: t,
    options: { log: () => {} },
  });
  const a = ip('10.77.0.2');
  const ctx = { group: 'g', site: null, cause: null, owner: null, noRaces: false };
  const send = (op, port, cid, data) => lanFrame(4, a, VHOST_VIP, 50000 + cid, port, op, cid, data);
  const none = new Uint8Array(0);
  host.frame(send(SYN, PORT_LOBBY, 1, none), ctx, (t += 1));
  host.frame(send(DATA, PORT_LOBBY, 1, encodeFrame('auth', '', [['NAME', 'Alpha']])), ctx, (t += 1));
  host.frame(send(DATA, PORT_LOBBY, 1, encodeFrame('pers', '', [['PERS', 'Alpha']])), ctx, (t += 1));
  host.info();
  const r = new FrameReader(1 << 16);
  const msgs = out.filter((f) => f[16] === DATA).flatMap((f) => r.push(f.subarray(24)));
  const pers = msgs.find((m) => m.kind === 'pers');
  assert.ok(pers, 'the pers answer');
  const lkey = FieldMap.parse(pers.body).get('LKEY');
  assert.ok(lkey);
  // the Messenger login: the persona is seen this month, its list is written at the stop
  host.frame(send(SYN, PORT_BUDDY, 2, none), ctx, (t += 1));
  host.frame(send(DATA, PORT_BUDDY, 2, encodeFrame('AUTH', '', [['LKEY', lkey]])), ctx, (t += 1));
  host.info();
  host.stop((t += 1));
  const month = monthOf(t);
  assert.deepEqual(shelfTexts(new Store(storage)), ['{"v":4,"name":"Alpha","seen":"' + month + '","B":["Bravo"]}']);
});

