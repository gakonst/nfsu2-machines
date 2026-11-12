// Port of web/server-rs/crates/roam/tests/roam_duel.rs, every test and assertion.
//! Outruns between players (runtime/roam_game.c du_*, roam_core.c rc_set_duel): two players who name each other as
//! their outrun's other player in their HELLOs (core version 11) are linked before anyone else, however many players
//! are nearer to either; one player's word alone links nobody; the link goes with the outrun.  By distance alone the
//! one who fell behind went from both screens in a crowd, and both games won.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kit, V, helloWith, snap, ways } from './kit.mjs';

/** the hub's last list to the player at V(i) names the one at V(j) */
function linked(k, i, j) {
  const l = k.lists().get(V(i) + ':47210');
  return l !== undefined && l.some((e) => e.vip === V(j));
}

function linksOf(k, i) {
  const l = k.lists().get(V(i) + ':47210');
  return l === undefined ? 0 : l.length;
}

/** A (V(0), id 100) at the origin and B (V(1), id 101) 100 m off, each naming its outrun's other player (0: none), and 60
 * players within 12 m round B (ids 102..): every one of B's 32 nearest is nearer than A, and some 30 of A's are nearer
 * than B.  Everyone's HELLO and SNAP again (a tick later on, after gone_ms, still sees them all). */
function crowd(k, duelA, duelB) {
  k.from(V(0), helloWith(100, { core: 11, links: 32, duel: duelA }));
  k.from(V(0), snap(100, [0.25, 0.25, 0.0]));
  k.from(V(1), helloWith(101, { core: 11, links: 32, duel: duelB, name: 'Bob' }));
  k.from(V(1), snap(101, [100.25, 0.25, 0.0]));
  for (let i = 2; i < 62; i++) {
    k.from(V(i), helloWith(100 + i, { core: 10, links: 32 }));
    k.from(V(i), snap(100 + i, [100.25 + ((i - 2) % 8) * 3.0 - 10.5, Math.floor((i - 2) / 8) * 3.0 - 10.5, 0.0]));
  }
}

// the two who name each other are linked, the crowd nearer to both however (every pair | the grid); without the
// outrun they are not; each still has its 32 links at most, both ends list each other
test('an outruns two players are linked first whatever the crowd', () => {
  for (const [how, o] of ways()) {
    let k = new Kit({ ...o });
    crowd(k, 0, 0);
    k.hub.tick();
    assert.ok(!linked(k, 0, 1) && !linked(k, 1, 0), how + ': no outrun, the crowd\'s nearer: not linked');
    assert.strictEqual(k.info('duelLinks'), 0.0);

    k = new Kit({ ...o });
    crowd(k, 101, 100);
    k.hub.tick();
    assert.ok(linked(k, 0, 1) && linked(k, 1, 0), how + ': the outrun\'s two linked, both ends');
    // (A, out of the crowd, gets what the crowd's own leave: a few)
    assert.ok(
      linksOf(k, 0) <= 32 && linksOf(k, 1) === 32,
      how + ': 32 links at most, the outrun\'s one of them (' + linksOf(k, 0) + ', ' + linksOf(k, 1) + ')',
    );
    assert.strictEqual(k.info('duelLinks'), 1.0, how);
    // under the busy cap (8 links a player): still linked
    k.busy = 0.95;
    for (let n = 0; n < 12; n++) {
      k.step(5_000.0);
      crowd(k, 101, 100);
      k.clear();
      k.hub.tick();
    }
    assert.ok(k.info('cap') <= 8.0, how + ': the busy cap down (' + k.info('cap') + ')');
    assert.ok(linked(k, 0, 1) && linked(k, 1, 0) && linksOf(k, 1) <= 8, how + ': under the busy cap, still linked');
  }
});

// one player's word links nobody: A names B, and B names nobody, or another player (who names nobody); a far player
// who names A back is linked, 2 km off
test('one players word alone links nobody', () => {
  for (const [how, o] of ways()) {
    for (const b of [0, 102]) {
      const k = new Kit({ ...o });
      crowd(k, 101, b);
      k.hub.tick();
      assert.ok(!linked(k, 0, 1), how + ': A names B, B names ' + b + ': not linked');
      assert.strictEqual(k.info('duelLinks'), 0.0, how);
    }
    const k = new Kit({ ...o });
    crowd(k, 162, 0);
    k.from(V(62), helloWith(162, { core: 11, links: 32, duel: 100 }));
    k.from(V(62), snap(162, [2000.25, 0.25, 0.0]));
    k.hub.tick();
    assert.ok(linked(k, 0, 62) && linked(k, 62, 0), how + ': the two naming each other, 2 km apart: linked');
  }
});

// the link goes with the outrun: once neither names the other, it is kept as any link (hold_ms young, then at keep
// its distance) and goes for the crowd
test('the link goes with the outrun', () => {
  for (const [how, o] of ways()) {
    const k = new Kit({ ...o });
    crowd(k, 101, 100);
    k.hub.tick();
    assert.ok(linked(k, 0, 1), how + ': linked in the outrun');
    k.step(1_000.0);
    crowd(k, 0, 0);
    k.clear();
    k.hub.tick();
    assert.ok(linked(k, 0, 1), how + ': a second on, a young link: kept');
    assert.strictEqual(k.info('duelLinks'), 0.0, how);
    k.step(o.holdMs);
    crowd(k, 0, 0);
    k.clear();
    k.hub.tick();
    assert.ok(!linked(k, 0, 1) && !linked(k, 1, 0), how + ': past hold_ms, the crowd\'s nearer: gone');
  }
});

// a pair of the outrun kept apart (A blocks B's name) is no link: the blocks come first
test('a blocked player is no outruns link', () => {
  const k = new Kit({ viewM: 1e-9 });
  k.hub.blocks(V(0), ['bob']);
  crowd(k, 101, 100);
  k.hub.tick();
  assert.ok(!linked(k, 0, 1) && !linked(k, 1, 0), 'kept apart');
});
