// Port of web/server-rs/crates/roam/tests/roam_friends.rs, every test and assertion.
//! Friends in free roam (the server's friends.rs): the server tells the hub each page's friends (their keyphrases),
//! and the hub links two friends of one room first, as two crew-mates, while each one's list names the other; a page
//! may ask to befriend only a player it is linked with; and its friends find where it plays.
//! 1. the links: a friend 2 km off a crowd is linked, in any way a room is linked; one whose list does not name the
//!    other back is not, nor a friend in another room, nor one without a keyphrase;
//! 2. linked_with: the player of that name (its Online form) that the page's player is linked with, its car within
//!    30 m, with its browser and keyphrase (if its page has one); none farther, linked or not;
//! 3. whereabouts: by keyphrase, the room and its name as the page told it; none for one not in free roam;
//! 4. the lists' friend marks: a player with friends whose core reads the hub's marks has its friends marked on its
//!    lists (MARK_FRIEND, with a crew-mate's bits where it is one), a one-way friend not; one of an older core gets a
//!    plain list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kit, V, fnv1a, helloWith, snap, frame, peersOf, crewMarks, HF_HUBCREW, MARK_FRIEND } from './kit.mjs';
import { defaultOptions, encodePeers } from '../../src/roam/hub.js';
import { ownerOfToken } from '../../src/claims/claims.js';

function owner(c) {
  const o = ownerOfToken(c.repeat(43));
  assert.ok(o !== null);
  return o;
}

/** player i's address, for more players than V's: 10.77.1.0 and on */
function U(i) {
  return (0x0a4d0100 + i) >>> 0;
}

/** a player named name, of keyphrase key (null: none), at (x, y) in room: its HELLO and SNAP */
function put(k, vip, id, room, name, key, at) {
  putWith(k, vip, id, { core: 6, room, name }, key, at);
}

function putWith(k, vip, id, h, key, at) {
  const o = key === null ? null : owner(key);
  k.hub.frameFrom(vip, frame(vip, helloWith(id, h)), o);
  k.hub.frameFrom(vip, frame(vip, snap(id, [at[0], at[1], 0.0])), o);
}

function linked(k, a, b) {
  const l = k.lists();
  const has = (x, y) => {
    const v = l.get(x + ':47210');
    return v !== undefined && v.some((e) => e.vip === y);
  };
  assert.strictEqual(has(a, b), has(b, a), 'a link is listed at both ends');
  return has(a, b);
}

function ways() {
  const o = { ...defaultOptions(), viewM: 1e-9 };
  return [['every pair', { ...o }, 60], ['the grid', { ...o, exactRoom: 1 }, 60], ['a room past exactRoom', o, 300]];
}

/** A (keyphrase 'A') with n players packed around it, and B (keyphrase bKey) 2 km off, in bRoom */
function crowd(k, n, bKey, bRoom) {
  put(k, U(0), 1000, 0, 'Alpha', 'A', [0.25, 0.25]);
  const side = Math.ceil(Math.sqrt(n)) >>> 0;
  for (let i = 1; i <= n; i++) {
    const [x, y] = [((i - 1) % side) * 3.0, Math.floor((i - 1) / side) * 3.0];
    const half = (side - 1) * 1.5;
    put(k, U(i), 1000 + i, 0, 'p' + i, null, [x - half + 1.25, y - half + 1.25]);
  }
  put(k, U(n + 1), 1000 + n + 1, bRoom, 'Bravo', bKey, [2000.25, 0.25]);
}

// a friend 2 km off a crowd is linked first while the friendship goes both ways and both are in one room
test('a friend far off a crowd is linked first', () => {
  for (const [how, o, n] of ways()) {
    const b = U(n + 1);
    for (const [aListsB, bListsA, bKey, bRoom, want] of [
      [true, true, 'B', 0, true],
      [true, false, 'B', 0, false],
      [false, true, 'B', 0, false],
      [true, true, 'B', fnv1a('red'), false],
      [true, true, null, 0, false],
    ]) {
      const what = how + ': A lists B ' + aListsB + ', B lists A ' + bListsA + ', B\'s key ' + bKey + ', room ' + bRoom;
      // (told before the players came: nobody is in free roam to be told back)
      const k = new Kit({ ...o });
      if (aListsB) k.hub.friends(U(0), owner('A'), [owner('B')]);
      if (bListsA) k.hub.friends(b, owner('B'), [owner('A'), owner('C')]);
      crowd(k, n, bKey, bRoom);
      k.hub.tick();
      assert.strictEqual(linked(k, U(0), b), want, what);
      assert.strictEqual(k.lists().get(U(0) + ':47210').length, 32, what + ': A\'s links are full');
    }
    // one page's friends told once both play: the other one in free roam gets it back, linked from the next tick
    const k = new Kit({ ...o });
    crowd(k, n, 'B', 0);
    k.hub.tick();
    assert.ok(!linked(k, U(0), b), how);
    k.hub.friends(b, owner('B'), [owner('A')]);
    k.clear();
    k.hub.tick();
    assert.ok(linked(k, U(0), b), how + ': friends now');
  }
});

// linked_with: the linked player of that name, by its Online form, with a keyphrase
test('a page befriends only a player it is linked with', () => {
  const k = new Kit({});
  put(k, V(0), 100, 0, 'Alpha', 'A', [0.25, 0.25]);
  put(k, V(1), 101, 0, 'Bravo Two', 'B', [3.25, 0.25]);
  put(k, V(2), 102, 0, 'Charlie', null, [6.25, 0.25]);
  put(k, V(3), 103, fnv1a('red'), 'Delta', 'D', [3.25, 3.25]);
  put(k, V(4), 104, 0, 'Echo', 'E', [600.25, 0.25]);
  k.hub.tick();
  assert.ok(linked(k, V(0), V(4)), 'a room of five: linked, 600 m off');
  assert.strictEqual(k.hub.linkedWith(V(0), 'Echo'), null, 'but its car far from this one\'s');
  assert.deepStrictEqual(k.hub.linkedWith(V(0), 'Bravo_Two'), [V(1), owner('B')], 'by its Online form');
  assert.deepStrictEqual(k.hub.linkedWith(V(0), 'bravo two'), [V(1), owner('B')]);
  assert.deepStrictEqual(k.hub.linkedWith(V(0), 'Charlie'), [V(2), null], 'linked, without a keyphrase');
  assert.strictEqual(k.hub.linkedWith(V(0), 'Delta'), null, 'another room: not linked');
  assert.strictEqual(k.hub.linkedWith(V(0), 'Alpha'), null, 'itself');
  assert.strictEqual(k.hub.linkedWith(V(9), 'Bravo_Two'), null, 'no player');
});

// whereabouts: where each keyphrase plays, with its room's name as its page told it
test('friends find where one plays', () => {
  const k = new Kit({});
  put(k, V(0), 100, 0, 'Alpha', 'A', [0.25, 0.25]);
  put(k, V(1), 101, fnv1a('blueroom'), 'Bravo', 'B', [3.25, 0.25]);
  k.hub.roomName(V(1), 'Blue Room');
  k.hub.tick();
  const w = k.hub.whereabouts([owner('A'), owner('B'), owner('C')]);
  assert.deepStrictEqual(w, [
    { room: 0, roomName: null },
    { room: fnv1a('blueroom'), roomName: 'Blue Room' },
    null,
  ]);
  // gone from the switch: nowhere, its room's name forgotten
  k.hub.peerGone(V(1));
  k.hub.tick();
  assert.deepStrictEqual(k.hub.whereabouts([owner('B')]), [null]);
});

// the friend marks: to a player whose core reads the hub's marks, MARK_FRIEND on each friend's entry (both ways), with
// a crew-mate's bits where it is one too; none on a one-way friend's, nor on anyone's to an older core
test('the lists mark friends', () => {
  const owls = fnv1a('owls');
  const k = new Kit({});
  k.hub.friends(V(0), owner('A'), [owner('B'), owner('C'), owner('D')]);
  k.hub.friends(V(1), owner('B'), [owner('A')]);
  k.hub.friends(V(2), owner('C'), [owner('A')]);
  k.hub.friends(V(4), owner('E'), [owner('A')]);
  const reads = { core: 6, crews: [], flags: HF_HUBCREW };
  // A; B a friend; C a friend in A's crew; D listed by A, not back; E lists A, A not E; F no keyphrase
  putWith(k, V(0), 100, { ...reads, name: 'Alpha', crews: [owls] }, 'A', [0.25, 0.25]);
  putWith(k, V(1), 101, { ...reads, name: 'Bravo' }, 'B', [10.25, 0.25]);
  putWith(k, V(2), 102, { ...reads, name: 'Charlie', crews: [owls] }, 'C', [20.25, 0.25]);
  putWith(k, V(3), 103, { ...reads, name: 'Delta' }, 'D', [30.25, 0.25]);
  putWith(k, V(4), 104, { ...reads, name: 'Echo' }, 'E', [40.25, 0.25]);
  putWith(k, V(5), 105, { ...reads, name: 'Fox' }, null, [50.25, 0.25]);
  k.hub.tick();
  const sent = k.sent.slice();
  const of = (i) => {
    const e = sent.find(([vip]) => vip === V(i));
    if (e === undefined) assert.fail('a list to ' + i);
    return e[1];
  };
  const marks = (i) => {
    const f = of(i);
    const m = crewMarks(f);
    return peersOf(f).map((e, at) => [e.vip, m === null ? 0 : m[1][at]]);
  };
  const mark = (i, j) => {
    const e = marks(i).find((e) => e[0] === V(j));
    if (e === undefined) assert.fail(j + ' on ' + i + '\'s list');
    return e[1];
  };
  const mine = (f) => {
    const m = crewMarks(f);
    return m === null ? null : m[0];
  };
  assert.deepStrictEqual(mine(of(0)), [owls], 'A\'s own crew');
  assert.deepStrictEqual(
    [mark(0, 1), mark(0, 2), mark(0, 3), mark(0, 4), mark(0, 5)],
    [MARK_FRIEND, MARK_FRIEND | 1, 0, 0, 0],
    'A: B a friend, C a friend and a crew-mate; D, E one way; F none',
  );
  assert.strictEqual(mark(1, 0), MARK_FRIEND, 'B: A, in no crew of B\'s');
  assert.deepStrictEqual(mine(of(1)), [], 'B: no crews of its own');
  assert.ok(marks(1).every(([v, m]) => v === V(0) || m === 0), 'B: no other friend');
  assert.strictEqual(mark(2, 0), MARK_FRIEND | 1, 'C: A');
  assert.strictEqual(crewMarks(of(3)), null, 'D: no friends of its own (told none): a plain list');
  assert.strictEqual(mark(4, 0), 0, 'E: A lists it not');
  // an older core (no HF_HUBCREW): no marks, as before
  putWith(k, V(1), 101, { core: 6, name: 'Bravo' }, 'B', [10.25, 0.25]);
  k.clear();
  k.hub.tick();
  const e = k.sent.find(([vip]) => vip === V(1));
  assert.ok(e !== undefined);
  const f = e[1];
  assert.strictEqual(crewMarks(f), null, 'B of an older core: a plain list');
  assert.deepStrictEqual(f.subarray(16), encodePeers(0xb0b, f[28] | (f[29] << 8), peersOf(f)), 'byte for byte');
  // (mark reads the first tick's lists, as the Rust's closure over its clone of them)
  assert.strictEqual(mark(0, 1), MARK_FRIEND, 'A still sees B marked');
});
