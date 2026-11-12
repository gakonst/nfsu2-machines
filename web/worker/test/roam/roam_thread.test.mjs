// A port of web/server-rs/crates/roam/tests/roam_thread.rs: free roam's hub as the switch hosts it (RoamHub), without
// the switch: frames posted reach the hub, its lists go out through the switch's send, a departure is forgotten, and an
// idle server keeps its cap on the links.
//
// The Rust RoamHub runs on a thread of its own with a real clock (RoamHub::spawn, ticks every tick_ms, info() over a
// channel).  The JS RoamHub has no thread and no hidden clock: the caller gives the time and calls tick(nowMs) when
// nextTickMs() is due, which is what this port does, with a clock of its own in place of the Rust's waits (wait_for
// becomes ticking until the list is out; "200 ms of sleep after stop()" becomes 200 ms of ticks the hub must skip).

import test from 'node:test';
import assert from 'node:assert/strict';
import { ip, hello, snap, frame, peersOf } from './kit.mjs';
import { RoamHub, ROAM_HUB_VIP } from '../../src/roam/hub.js';
import { Prng } from '../../src/util/prng.js';

function ctx() {
  return { group: 'client', site: null, cause: null, slot: null, owner: null, noRaces: false };
}

test('on its thread frames reach the hub its lists go out through the switch a departure is forgotten', () => {
  const lines = [];
  const sent = [];
  let now = 1000000;
  const hub = new RoamHub({
    sw: {
      send(vip, f, cause) {
        assert.ok(cause == null, "the hub's lists are charged to nobody");
        sent.push([vip, f]);
        return 'sent';
      },
    },
    prng: new Prng(1),
    nowMs: now,
    options: { tickMs: 50, log: (s) => lines.push(s) },
  });
  assert.equal(hub.vip, ROAM_HUB_VIP);
  assert.equal(hub.name, 'free-roam hub');
  assert.ok(!hub.listed(), 'the hub is on nobody\'s peer list');
  /** the hub's own loop: every tick due by now */
  const run = (ms) => {
    const until = now + ms;
    while (hub.nextTickMs() <= until) {
      now = Math.max(now, hub.nextTickMs());
      hub.tick(now);
    }
    now = until;
  };
  const [a, b] = [ip('10.77.0.20'), ip('10.77.0.21')];
  const post = (vip, d) => hub.frame(frame(vip, d), ctx(), now);
  post(a, hello(501));
  post(a, snap(501, [0.0, 0.0, 0.0]));
  post(b, hello(502));
  post(b, snap(502, [20.0, 0.0, 0.0]));
  // info() answers after what was posted before it
  assert.equal(hub.info().players, 2, 'both reached the hub');
  const isList = ([v, f]) => v === a && f[16 + 16] === 1;
  // wait_for("Ann's list"): within 5 s of the hub's ticks
  for (let waited = 0; !sent.some(isList); waited += 5) {
    assert.ok(waited < 5000, "Ann's list: not within 5 s");
    run(5);
  }
  const got = sent.find(isList)[1];
  assert.equal(got[0], 1);
  const be32 = (o) => ((got[o] << 24) | (got[o + 1] << 16) | (got[o + 2] << 8) | got[o + 3]) >>> 0;
  assert.equal(be32(4), ROAM_HUB_VIP, 'from 10.77.0.253');
  assert.equal(be32(8), a);
  assert.equal((got[12] << 8) | got[13], 47210);
  assert.equal((got[14] << 8) | got[15], 47210);
  assert.deepEqual(peersOf(got), [{ vip: b, port: 47210, id: 502 }]);
  assert.deepEqual(hub.vips(), new Set([a, b]));
  hub.peerGone(b, now);
  assert.equal(hub.info().players, 1, 'Bob left the switch: the hub forgot him');
  const i = hub.info();
  assert.ok(i.ticks >= 1 && typeof i.busy === 'number' && i.busy >= 0.0 && i.busy <= 100.0, JSON.stringify(i));
  // stop(): no more ticks, and so no more lists; it still answers
  hub.stop();
  const ticks = hub.info().ticks;
  const n = sent.length;
  run(200);
  hub.tick(now);
  assert.equal(sent.length, n, 'no lists after stop()');
  assert.equal(hub.info().ticks, ticks);
  assert.deepEqual(lines, [], 'an idle server keeps its cap: ' + JSON.stringify(lines));
});
