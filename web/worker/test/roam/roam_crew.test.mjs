// A port of web/server-rs/crates/roam/tests/roam_crew.rs: crews (roam_core.h RC_HF_CREW): a player's HELLO names its
// crews (a word each, up to 4, by roam_core's room hash), the hub links two crew-mates of one room before the other
// links, and /players counts each crew's players.
// 1. the wire: a HELLO of before parses as it did; one with the flag names 0 to 4 crews after its ids, and what
//    comes after them is skipped; a count past 4, a crew 0 or a short one is a bad HELLO;
// 2. the links (every pair | the grid | a room past exactRoom): a crew-mate 2 km off a crowd is linked, under the
//    busy cap too, and one of another crew or another room is not; at most 16 crew links a player, the nearest, kept
//    while the crew drives about; a crew of 65 in one room is no reason for a link;
// 3. the counts: the browsers in free roam or paused there, by crew, in any room, a browser once; on the hub's thread
//    as of its last tick;
// 4. the lists' crew marks: a player in a crew learns which of its peers share one of its crews, and no other
//    player's crews; a player in no crew gets a plain list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoamHub, decodeRoam, encodePeers } from '../../src/roam/hub.js';
import { Kit, V, ways, fnv1a, dgramFlags, helloWith, snap, bye, frame, framePorts, peersOf, crewMarks, HF_CREW } from './kit.mjs';

function le32(v) {
  return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
}

/** a HELLO as roam_core.c lays it out (core version 7, in free roam, room "blue", named "p") with these header flags:
 * its count of ids, the ids, then tail as it is */
function helloRaw(flags, nSeen, seen, tail) {
  const p = new Array(12).fill(0);
  p[0] = 7;
  p[1] = 0;
  p[2] = 1;
  p[3] = 2;
  p[4] = 47210 & 255;
  p[5] = 47210 >> 8;
  p[6] = 3;
  p[7] = 0;
  p.splice(8, 4, ...le32(fnv1a('blue')));
  p.push(1, 'p'.charCodeAt(0), nSeen);
  for (const s of seen) p.push(...le32(s));
  p.push(...tail);
  return dgramFlags(1, 0x77, flags, Uint8Array.from(p));
}

/** what a HELLO ends with after its ids: a count, then hashes */
function tail(n, crews) {
  const t = [n];
  for (const c of crews) t.push(...le32(c));
  return t;
}

/** the crews a datagram's HELLO names (null: no datagram) */
function crewsIn(d) {
  const m = decodeRoam(d);
  if (m === null) return null;
  if (m.type !== 'hello') throw new Error('not a HELLO: ' + JSON.stringify(m));
  return m.crews;
}

const fill = (n, v) => new Array(n).fill(v);

// the wire: a HELLO of before (no flag) parses as before, whatever follows its ids; with the flag, 0 to 4 crews after
// its ids (or nothing), what comes after them skipped; a count past 4, a crew 0, crews or ids cut short, or more ids
// than roam_core takes, is a bad HELLO
test('the wire a hello names its crews after its ids', () => {
  const a = fnv1a('bluebirds'), b = fnv1a('owls'), c = 7, d = 0xffffffff;
  const ids = [0x11, 0x22];
  assert.deepEqual(crewsIn(helloRaw(0, 2, ids, [])), [], 'a HELLO of before');
  assert.deepEqual(crewsIn(helloRaw(0, 2, ids, tail(9, [0]))), [], 'without the flag: what follows its ids is not read');
  assert.deepEqual(crewsIn(helloRaw(0, 9, ids, [])), [], 'without the flag: ids cut short, as before');
  assert.deepEqual(crewsIn(helloRaw(0, 40, fill(40, 1), [])), [], 'without the flag: 40 ids, as before');
  assert.deepEqual(crewsIn(helloWith(0x77, { seen: ids })), [], "the kit's HELLO of before");
  assert.deepEqual(crewsIn(helloRaw(HF_CREW, 2, ids, [])), [], 'the flag, nothing after its ids');
  assert.deepEqual(crewsIn(helloRaw(HF_CREW, 0, [], [])), [], 'the flag, no ids, nothing after them');
  // quick chat's flag (roam_core.h RC_HF_SAY, the bit below the crews'): bytes after its ids are not crews
  assert.deepEqual(crewsIn(helloRaw(0x0100, 2, ids, tail(1, [0x1234]))), [], 'RC_HF_SAY is not the crew flag');
  for (const crews of [[], [a], [a, b], [d, c, b], [a, b, c, d], [b, b]]) {
    const want = crews.slice();
    const what = JSON.stringify(crews);
    assert.deepEqual(crewsIn(helloRaw(HF_CREW, 2, ids, tail(crews.length, crews))), want, what);
    assert.deepEqual(crewsIn(helloRaw(HF_CREW | 0x0080, 0, [], tail(crews.length, crews))), want, 'no ids: ' + what);
    const more = [...tail(crews.length, crews), 1, 2, 3, 4, 5, 6, 7];
    assert.deepEqual(crewsIn(helloRaw(HF_CREW, 2, ids, more)), want, 'what follows its crews skipped: ' + what);
    assert.deepEqual(crewsIn(helloWith(0x77, { seen: ids, crews })), want, "the kit's: " + what);
  }
  for (const [what, h] of [
    ['5 crews', helloRaw(HF_CREW, 2, ids, tail(5, [a, b, c, d, 9]))],
    ['a count of 255', helloRaw(HF_CREW, 2, ids, tail(255, [a]))],
    ['a crew 0', helloRaw(HF_CREW, 2, ids, tail(2, [a, 0]))],
    ['crews cut short', helloRaw(HF_CREW, 2, ids, tail(2, [a]))],
    ['a crew cut short', helloRaw(HF_CREW, 2, ids, tail(1, [a]).slice(0, 3))],
    ['ids cut short', helloRaw(HF_CREW, 3, ids, [])],
    ['65 ids', helloRaw(HF_CREW, 65, fill(65, 1), tail(1, [a]))],
  ]) {
    assert.equal(crewsIn(h), null, what + ': a bad HELLO');
  }
  // the hub counts it bad, and takes no player of it
  const k = new Kit();
  k.from(V(0), helloRaw(HF_CREW, 2, ids, tail(2, [a, 0])));
  assert.deepEqual([k.info('bad'), k.info('players')], [1.0, 0.0]);
  k.from(V(0), helloRaw(HF_CREW, 2, ids, tail(2, [a, b])));
  assert.deepEqual([k.info('bad'), k.info('players')], [1.0, 1.0]);
});

// the lists' crew marks: to a player in a crew, its own crews, then a mark a link, bit c: that player is in its crew c
// too; a player in no crew gets a plain list, byte for byte; and no list carries a crew of anyone but its receiver
test('the lists mark crew mates and name no other crews', () => {
  const x = fnv1a('bluebirds'), y = fnv1a('owls'), z = fnv1a('hawks'), w = fnv1a('wrens');
  for (const [how, o] of ways()) {
    const k = new Kit(o);
    // A (x, y), B (y, z), C (z, x), D in no crew, E (z, w): all within 40 m, so all linked
    const who = [[x, y], [y, z], [z, x], null, [z, w]];
    who.forEach((crews, i) => {
      k.from(V(i), helloWith(100 + i, { crews }));
      k.from(V(i), snap(100 + i, [i * 10.0 + 0.25, 0.25, 0.0]));
    });
    k.hub.tick();
    const sent = k.sent.slice();
    const of = (i) => {
      const e = sent.find(([vip]) => vip === V(i));
      if (!e) throw new Error(how + ': a list to ' + i);
      return e[1];
    };
    const mark = (i, j) => {
      const f = of(i);
      const at = peersOf(f).findIndex((e) => e.vip === V(j));
      if (at < 0) throw new Error(how + ': ' + j + " on " + i + "'s list");
      const m = crewMarks(f);
      if (!m) throw new Error(how + ': marks on ' + i + "'s list");
      return m[1][at];
    };
    for (let i = 0; i < 5; i++) assert.equal(peersOf(of(i)).length, 4, how + ': ' + i + ' linked with the 4 others');
    const own = (i) => {
      const m = crewMarks(of(i));
      return m ? m[0] : null;
    };
    assert.deepEqual(own(0), [x, y], how + ": A's own crews");
    assert.deepEqual([mark(0, 1), mark(0, 2), mark(0, 3), mark(0, 4)], [0b10, 0b01, 0, 0], how + ': B in y, C in x');
    assert.deepEqual(own(1), [y, z], how + ": B's own crews");
    assert.deepEqual([mark(1, 0), mark(1, 2), mark(1, 3), mark(1, 4)], [0b01, 0b10, 0, 0b10], how + ': A in y, C and E in z');
    assert.deepEqual(own(2), [z, x], how + ": C's own crews");
    assert.deepEqual([mark(2, 0), mark(2, 1), mark(2, 3), mark(2, 4)], [0b10, 0b01, 0, 0b01], how + ': A in x, B and E in z');
    assert.deepEqual([mark(4, 0), mark(4, 1), mark(4, 2), mark(4, 3)], [0, 0b01, 0b01, 0], how + ': E (z, w): B and C in z');
    const f = of(3);
    assert.equal(crewMarks(f), null, how + ': in no crew: no marks');
    assert.deepEqual(f.slice(16), encodePeers(0xb0b, f[28] | (f[29] << 8), peersOf(f)), how + ': in no crew: a plain list');
    // no crew of anyone but the receiver in its datagram (C's x and z are A's and B's too: w is E's alone)
    const has = (f, h) => {
      const b = le32(h);
      for (let i = 0; i + 4 <= f.length; i++) if (f[i] === b[0] && f[i + 1] === b[1] && f[i + 2] === b[2] && f[i + 3] === b[3]) return true;
      return false;
    };
    for (let i = 0; i < 4; i++) assert.ok(!has(of(i).subarray(16), w), how + ": E's crew w on " + i + "'s list");
    assert.ok(!has(of(0).subarray(16), z) && !has(of(3).subarray(16), x) && !has(of(2).subarray(16), y), how + ': no crews but its own');
  }
});

/** a player of core version 7 at (x, y), with these crews (null: a HELLO of before), its HELLO and its SNAP */
function put(k, vip, id, room, crews, at) {
  k.from(vip, helloWith(id, { core: 6, room, crews }));
  k.from(vip, snap(id, [at[0], at[1], 0.0]));
}

/** player i's address, for more players than V's: 10.77.1.0 and on */
function U(i) {
  return (0x0a4d0100 + i) >>> 0;
}

/** whether players a and b (addresses) are linked, checked at both ends */
function linked(k, a, b) {
  const l = k.lists();
  const has = (x, y) => {
    const v = l.get(x + ':47210');
    return v !== undefined && v.some((e) => e.vip === y);
  };
  assert.equal(has(a, b), has(b, a), 'a link is listed at both ends');
  return has(a, b);
}

/** the ways a room is linked: every pair (a room of at most exactRoom), the grid (exactRoom 1), and the grid for a
 * room larger than exactRoom (300 players), with the crowd's size each; without view points (the cars point along x) */
function crowds() {
  const o = { viewM: 1e-9 };
  return [['every pair', o, 60], ['the grid', { ...o, exactRoom: 1 }, 60], ['a room past exactRoom', o, 300]];
}

/** A crowd: player 0 (A, crews a) and n players around it within 50 m (lattice points 3 m apart, HELLOs without
 * crews), and B, 2 km off, crews b, in bRoom: their HELLOs and SNAPs */
function crowd(k, n, a, b, bRoom) {
  put(k, U(0), 1000, 0, a, [0.25, 0.25]);
  const side = Math.ceil(Math.sqrt(n));
  for (let i = 1; i <= n; i++) {
    const x = ((i - 1) % side) * 3.0, y = Math.floor((i - 1) / side) * 3.0;
    const half = (side - 1) * 1.5;
    put(k, U(i), 1000 + i, 0, null, [x - half + 1.25, y - half + 1.25]);
  }
  put(k, U(n + 1), 1000 + n + 1, bRoom, b, [2000.25, 0.25]);
}

// a crew-mate 2 km off a crowd (60 | 300 players packed around A, who has 32 nearer players) is linked with A, in one
// of its crews or in all; one in no crew of A's is not, nor a crew-mate in another room
test('a crew mate far off a crowd is linked first', () => {
  const x = fnv1a('bluebirds'), y = fnv1a('owls'), z = fnv1a('hawks');
  for (const [how, o, n] of crowds()) {
    const b = U(n + 1);
    for (const [crewsA, crewsB, bRoom, want] of [
      [[x], [y, x], 0, true],
      [[x, z], [z, y], 0, true],
      [[x], [x], 0, true],
      [[x], [y], 0, false],
      [[], [x], 0, false],
      [[x], [x], fnv1a('red'), false],
    ]) {
      const what = how + ': A ' + JSON.stringify(crewsA) + ', B ' + JSON.stringify(crewsB) + ' in room ' + bRoom;
      const k = new Kit(o);
      crowd(k, n, crewsA, crewsB, bRoom);
      k.hub.tick();
      assert.equal(linked(k, U(0), b), want, what);
      assert.equal(k.info('crewLinks'), want ? 1.0 : 0.0, what);
      assert.equal(k.lists().get(U(0) + ':47210').length, 32, what + ": A's links are full");
    }
    // B leaves the crew (a HELLO without it), and at the next tick (the link's hold over) it is linked no more
    const k = new Kit(o);
    crowd(k, n, [x], [x], 0);
    k.hub.tick();
    assert.ok(linked(k, U(0), b), how);
    for (let s = 0; s < 6; s++) {
      k.step(1000.0);
      crowd(k, n, [x], [y], 0);
      k.clear();
      k.hub.tick();
    }
    assert.ok(!linked(k, U(0), b), how + ': B left the crew');
    assert.equal(k.info('crewLinks'), 0.0, how);
  }
});

// under the busy cap (8 links a player) a crew-mate 2 km off the crowd is still linked
test('a crew mate far off is linked under the busy cap', () => {
  const x = fnv1a('bluebirds');
  for (const [how, o, n] of crowds()) {
    const k = new Kit({ ...o, capDownMs: 1.0 });
    k.busy = 0.95;
    // the cap a quarter down each tick: 24, 18, 13, 9, 8
    for (let s = 0; s < 6; s++) {
      crowd(k, n, [x], [x], 0);
      k.clear();
      k.hub.tick();
      k.step(1000.0);
    }
    assert.equal(k.info('cap'), 8.0, how);
    assert.ok(linked(k, U(0), U(n + 1)), how + ': linked under the busy cap');
    assert.equal(k.info('crewLinks'), 1.0, how);
    const l = k.lists();
    assert.ok(Array.from(l.values()).every((v) => v.length <= 8), how + ': 8 links at most');
    assert.equal(l.get(U(0) + ':47210').length, 8, how + ": A's 8 links: B and 7 of the crowd");
  }
});

/** A crew of 20 spread out (members 300 m apart on a line, member m at the place(m)-th spot of it), each member
 * with 31 players packed around it (within 3 m: they fill its links once its crew's are in, so its links to
 * crew-mates are its crew links): their HELLOs and SNAPs */
function crewOf20(k, crew, place) {
  for (let m = 0; m < 20; m++) {
    const x = place(m) * 300.0 + 0.25;
    put(k, U(m * 32), 5000 + m * 32, 0, [crew], [x, 0.25]);
    for (let s = 1; s < 32; s++) {
      const dx = (s % 6) * 0.5, dy = Math.floor(s / 6) * 0.5 + 0.25;
      put(k, U(m * 32 + s), 5000 + m * 32 + s, 0, null, [x + dx, dy]);
    }
  }
}

/** the crew-mates each member of crewOf20 is linked with, by member (sorted arrays, for the Rust's HashSets) */
function matesOf20(k) {
  const l = k.lists();
  const members = new Set();
  for (let m = 0; m < 20; m++) members.add(U(m * 32));
  const out = [];
  for (let m = 0; m < 20; m++) {
    const mine = l.get(U(m * 32) + ':47210');
    const s = new Set(mine.filter((e) => members.has(e.vip)).map((e) => (e.vip - U(0)) / 32));
    out.push(Array.from(s).sort((a, b) => a - b));
  }
  return out;
}

// a crew of 20 spread out: each member gets at most 16 crew links, nearest first (a pair is left out only when one of
// its two has 16 nearer ones), and they stay while the crew drives about
test('a crew of 20 at most 16 crew links each the nearest', () => {
  const crew = fnv1a('bluebirds');
  const o = { viewM: 1e-9 };
  for (const [how, oo] of [['every pair', { ...o, exactRoom: 1000 }], ['the grid', { ...o, exactRoom: 1 }]]) {
    const k = new Kit(oo);
    crewOf20(k, crew, (m) => m);
    k.hub.tick();
    const links = matesOf20(k);
    const total = links.reduce((s, l) => s + l.length, 0);
    assert.equal(k.info('crewLinks'), Math.floor(total / 2), how + ': every crew-mate link is a crew link');
    links.forEach((l, m) => {
      assert.ok(l.length <= 16, how + ': member ' + m + ': ' + l.length + ' crew links');
      for (const j of l) assert.ok(links[j].includes(m), how + ': both ends');
    });
    // the middle ones: their 8 nearest on each side
    for (const m of [9, 10]) {
      const want = [];
      for (let j = m - 8; j <= m + 8; j++) if (j !== m && j < 20) want.push(j);
      assert.deepEqual(links[m], want, how + ': member ' + m);
    }
    // nearest first: a pair left out has an end with 16 nearer (or as near) crew links
    const gap = (a, b) => Math.abs(a - b);
    for (let a = 0; a < 20; a++) {
      for (let b = a + 1; b < 20; b++) {
        if (!links[a].includes(b)) {
          const full = (m) => links[m].length === 16 && links[m].every((j) => gap(m, j) <= gap(a, b));
          assert.ok(full(a) || full(b), how + ': ' + a + ' and ' + b + ' not linked: ' + JSON.stringify(links[a]) + ' ' + JSON.stringify(links[b]));
        }
      }
    }
    // a second later the members are in other places (each one's nearest are others): the same crew links, as
    // links younger than holdMs stay
    k.step(1000.0);
    k.clear();
    crewOf20(k, crew, (m) => (m * 7) % 20);
    k.hub.tick();
    assert.deepEqual(matesOf20(k), links, how + ': kept while the crew drives about');
  }
});

// a crew of 65 players in one room gets no links first (counted in crewSkips), and its players link by distance, the
// first and the last of them (6.4 km apart) as a crew of their own too; one of 64 gets them (and its first and last
// had their 16 crew links nearer)
test('a crew of 65 in one room gets no links first', () => {
  const crew = fnv1a('everyone');
  for (const [how, o] of ways()) {
    for (const [n, skips] of [[64, 0.0], [65, 1.0]]) {
      const k = new Kit(o);
      for (let i = 0; i < n; i++) put(k, U(i), 100 + i, 0, [crew], [i * 100.0 + 0.25, 0.25]);
      put(k, U(0), 100, 0, [crew, 77], [0.25, 0.25]);
      put(k, U(n - 1), 100 + n - 1, 0, [77, crew], [(n - 1) * 100.0 + 0.25, 0.25]);
      k.hub.tick();
      assert.equal(k.info('crewSkips'), skips, how + ': a crew of ' + n);
      if (n === 64) {
        assert.ok(k.info('crewLinks') > 400.0, how + ': a crew of ' + n + ': ' + k.info('crewLinks') + ' crew links');
      } else {
        assert.equal(k.info('crewLinks'), 1.0, how + ': a crew of ' + n + ": only the two's");
        assert.ok(linked(k, U(0), U(n - 1)), how + ': a crew of ' + n + ': the two, 6.4 km apart');
      }
    }
  }
});

// players in crews come and go every way (a HELLO without them, BYE, gone from the switch, silent past goneMs, another
// start of the game on the same endpoint): with none left the tick looks for no crews, and the next ones are linked
// first again (every pair | the grid)
test('players in crews come and go', () => {
  const x = fnv1a('bluebirds');
  for (const [how, o, n] of crowds().slice(0, 2)) {
    const k = new Kit(o);
    const a = U(0), b = U(n + 1);
    crowd(k, n, [x], [x], 0);
    k.hub.tick();
    assert.ok(linked(k, a, b), how);
    // B: a HELLO of before, then back in the crew, then BYE; A: gone from the switch
    k.from(b, helloWith(1000 + n + 1, { core: 6 }));
    k.from(b, helloWith(1000 + n + 1, { core: 6, crews: [x] }));
    k.from(b, bye(1000 + n + 1));
    k.hub.peerGone(a);
    k.step(1000.0);
    k.clear();
    k.hub.tick();
    assert.deepEqual([k.info('crewLinks'), k.info('players')], [0.0, n], how);
    // both back, as another start of the game each (a new id on A's endpoint): linked first again
    k.step(1000.0);
    put(k, a, 3000, 0, [x], [0.25, 0.25]);
    put(k, b, 3001, 0, [x], [2000.25, 0.25]);
    put(k, a, 3002, 0, [x], [0.25, 0.25]);
    for (let i = 1; i <= n; i++) put(k, U(i), 1000 + i, 0, null, [((i % 9.0) * 3.0) - 12.25, Math.floor(i / 9) * 3.0 - 12.25]);
    k.clear();
    k.hub.tick();
    assert.ok(linked(k, a, b) && k.info('crewLinks') === 1.0, how + ': back');
    // all of them silent past goneMs: forgotten, and the counts with them
    k.step(7000.0);
    k.hub.tick();
    assert.deepEqual([k.info('players'), k.hub.inCrews([x])[0]], [0.0, 0], how);
    put(k, a, 3003, 0, [x], [0.25, 0.25]);
    put(k, b, 3004, 0, [x], [2000.25, 0.25]);
    k.clear();
    k.hub.tick();
    assert.ok(linked(k, a, b) && k.info('crewLinks') === 1.0, how + ': two of a crew alone');
  }
});

/** a HELLO of core version 7 in room, status, with these crews (null: a HELLO of before) */
function hello6(id, room, status, crews) {
  return helloWith(id, { core: 6, room, status, crews });
}

// /players' crews: the browsers in free roam or paused there (not in a race), by crew, in any room, a browser once
// whatever its endpoints and however often it names a crew; a new HELLO replaces a player's crews (one of before,
// none)
test('in free roam by crew', () => {
  const a = fnv1a('bluebirds'), b = fnv1a('owls'), c = fnv1a('hawks');
  const k = new Kit();
  k.from(V(1), hello6(601, fnv1a('blue'), 2, [a, b, a]));
  k.from(V(2), hello6(602, 0, 5, [a]));
  k.from(V(3), hello6(603, 0, 3, [a, b]));
  k.from(V(4), hello6(604, fnv1a('red'), 2, [b]));
  k.from(V(5), hello6(605, 0, 2, null));
  k.hub.frame(V(1), framePorts(V(1), hello6(606, 0, 2, [a]), 47211, 47210));
  assert.deepEqual(k.hub.inCrews([a, b, c, a]), [2, 2, 0, 2]);
  assert.deepEqual(k.hub.inCrews([]), []);
  assert.equal(k.hub.inRoam(), 4);
  // 2 leaves its crews with a HELLO of before, 4 changes them, 3 is back from its race
  k.from(V(2), hello6(602, 0, 5, null));
  k.from(V(4), hello6(604, fnv1a('red'), 2, [c]));
  k.from(V(3), hello6(603, 0, 2, [a, b]));
  assert.deepEqual(k.hub.inCrews([a, b, c]), [2, 2, 1]);
  k.hub.peerGone(V(1));
  assert.deepEqual(k.hub.inCrews([a, b, c]), [1, 1, 1]);
});

function ctx() {
  return { group: 'client', site: null, cause: null, slot: null, owner: null, noRaces: false };
}

// on its thread the hub keeps the crews' counts of its last tick for /players.  The Rust spawns the hub on a thread of
// its own (a tick each 20 ms) and polls for 5 s of real time; the Worker's RoamHub is sans-IO (no thread, its ticks are
// the caller's): here its clock goes on a tick at a time, at nextTickMs(), for at most the same 5 s.
test('on its thread the crews counts of the last tick', () => {
  const a = fnv1a('bluebirds'), b = fnv1a('owls');
  let now = 1000000.0;
  const hub = new RoamHub({ sw: { send: () => 'sent' }, prng: { below: () => 0 }, nowMs: now, options: { tickMs: 20, id: 0xb0b, log: () => {} } });
  assert.deepEqual(hub.inCrews([a, b]), [0, 0], 'before its first tick');
  const post = (vip, d) => hub.frame(frame(vip, d), ctx(), now);
  post(V(1), helloWith(701, { core: 6, crews: [a, b] }));
  post(V(2), helloWith(702, { core: 6, crews: [b] }));
  const until = (want, crews) => {
    const t0 = now;
    while (JSON.stringify(hub.inCrews(crews)) !== JSON.stringify(want)) {
      assert.ok(now - t0 < 5000, JSON.stringify(hub.inCrews(crews)));
      now = Math.max(now + 5, hub.nextTickMs());
      hub.tick(now);
    }
  };
  until([2, 1, 0], [b, a, 9]);
  hub.peerGone(V(1), now);
  until([1, 0], [b, a]);
  hub.stop();
});

