// A port of the #[cfg(test)] tests of web/server-rs/crates/roam/src/lib.rs: the race tracks' rooms and a world's count,
// and what /players reads of the hub as the switch hosts it (RoamHub).

import test from 'node:test';
import assert from 'node:assert/strict';
import { RoamHub, trackRoom, worldCount, mainWorld } from '../../src/roam/hub.js';
import { Prng } from '../../src/util/prng.js';

// the spots' rooms as the game makes them (runtime/roam_game.c room_at, uint32 maths), and a world's count with
// its spots' players: not another world's, not a spot of another world
test('a world counts its race tracks', () => {
  assert.equal(trackRoom(0, 4711), 2397071415);
  assert.equal(trackRoom(0, 4605), 199754989);
  assert.equal(trackRoom(0x12345678, 4301), 942920901);
  assert.equal(trackRoom(0xffffffff, 4201), 2745435750);
  const w2 = 0xbeef0002;
  const counts = new Map([[0, 5], [trackRoom(0, 4711), 2], [trackRoom(0, 4605), 1], [w2, 3], [trackRoom(w2, 4311), 4]]);
  assert.equal(worldCount(counts, 0), 8);
  assert.equal(worldCount(counts, w2), 7);
  assert.equal(worldCount(counts, 0xbeef0003), 0);
  assert.ok(mainWorld(0) && mainWorld(trackRoom(0, 4711)) && mainWorld(trackRoom(0, 4605)));
  assert.ok(!mainWorld(w2) && !mainWorld(trackRoom(w2, 4311)));
});

// a hub whose thread is stuck holds MAX_PENDING frames and leaves out the rest; each may keep its reader's block of
// 16 KiB alive, 128 MiB at most
test('a stuck hub holds few frames', (t) => {
  t.skip('the Rust RoamHub queues frames over a channel to its own thread (MAX_PENDING); the JS RoamHub has no thread ' +
    'and no queue: frame() reaches the hub at once, so no hub can be stuck with frames held');
});

function roamHub(options, nowMs = 1000000) {
  return new RoamHub({ sw: { send() { return 'sent'; } }, prng: new Prng(1), nowMs, options: { log: () => {}, ...options } });
}

// /players reads the hub's crowded() without its thread: as of the hub's last tick, and before the first one as
// the hub begins (a hub of fewer links than askCap is busy from the start)
test("what players reads is the hub's crowded", () => {
  const few = roamHub({ degree: 16 });
  assert.ok(few.crowded(), '16 links a player, under askCap 24: busy before any tick');
  const all = roamHub({});
  assert.ok(!all.crowded(), '32 links a player');
  // a busy server: the cap down a quarter each tick (32, 24, 18), busy once it is under 24, and back once the cap is
  // (the Rust runs the thread's own loop on a real clock, its ticks every 5 ms; here the loop's ticks on a clock of
  // its own, 1 ms a step, 5 s of it at most as the Rust waits)
  let now = 1000000;
  const hub = roamHub({ tickMs: 5, capDownMs: 1.0, capUpMs: 1.0, id: 1 }, now);
  const until = (want) => {
    const t0 = now;
    while (hub.crowded() !== want) {
      assert.ok(now - t0 < 5000, 'crowded ' + want + ': not in 5 s');
      now += 1;
      if (hub.nextTickMs() <= now) hub.tick(now);
    }
  };
  hub.setBusy(0.95);
  until(true);
  hub.setBusy(0.1);
  until(false);
  hub.stop();
});
