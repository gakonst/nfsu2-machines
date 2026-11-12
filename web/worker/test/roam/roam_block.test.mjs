// Port of web/server-rs/crates/roam/tests/roam_block.rs, every test and assertion.
//! Blocking (the page's hello "block", Hub::blocks): a browser that blocks a name is linked with no player of that
//! name, either way, and neither is on the other's world map; the others are as before; any case; until it leaves
//! the switch; the console says who blocks whom.  A blocked pair takes no place in either one's links, a crew links
//! no blocked pair, a name is its Online form, and a claimed name's keyphrase stays blocked under its next name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kit, V, fnv1a, helloWith, snap, mapreqBase, mapdOf, frame, ways } from './kit.mjs';
import { Claims, ownerOfToken } from '../../src/claims/claims.js';

function has(k, i, j) {
  const l = k.lists().get(V(i) + ':47210');
  return l !== undefined && l.some((e) => e.vip === V(j));
}

function links(k, i) {
  const l = k.lists().get(V(i) + ':47210');
  return l === undefined ? [] : l.map((e) => e.vip);
}

/** player i of name at x (its HELLO and a SNAP) */
function place(k, i, name, x) {
  k.from(V(i), helloWith(100 + i, { name, core: 2 }));
  k.from(V(i), snap(100 + i, [x, 0.0, 0.0]));
}

function mapEntries(k) {
  return k.sent.map(([, f]) => mapdOf(f)).filter((m) => m !== null).flatMap((m) => m[5]);
}

function unwrap(r) {
  assert.ok('ok' in r, 'claim: ' + JSON.stringify(r));
  return r.ok;
}

test('a blocked name is linked with nobody who blocks it either way until they leave', () => {
  const k = new Kit({});
  const drive = (k) => {
    for (const [i, name] of [[0, 'anna'], [1, 'Bob'], [2, 'carl']]) {
      k.from(V(i), helloWith(100 + i, { name, core: 2 }));
      k.from(V(i), snap(100 + i, [i * 10.0, 0.0, 0.0]));
    }
  };
  drive(k);
  k.hub.blocks(V(0), ['bob']);
  assert.ok(k.lines.some((l) => l === '[roam] 10.77.0.10 blocks "bob"'), JSON.stringify(k.lines));
  k.clear();
  k.hub.tick();
  assert.ok(!has(k, 0, 1) && !has(k, 1, 0), 'anna blocks Bob: neither lists the other');
  assert.ok(has(k, 0, 2) && has(k, 2, 0) && has(k, 1, 2) && has(k, 2, 1), 'carl still sees both');
  // the world map: Bob's (carl is linked: not on it) has no anna
  k.step(1000.0);
  drive(k);
  k.clear();
  k.from(V(1), mapreqBase(101, 1, 2048, 0));
  const map = mapEntries(k);
  assert.ok(map.length === 0, 'no anna on Bob\'s map: ' + JSON.stringify(map));
  // anna leaves the switch and comes back blocking nobody: linked again
  k.hub.peerGone(V(0));
  drive(k);
  k.clear();
  k.hub.tick();
  assert.ok(has(k, 0, 1) && has(k, 1, 0), 'the block went with her');
});

// 2 links a player (every pair | the grid): anna's nearest is Bob, whom she blocks.  The pair takes no place: both
// still get 2 links, from the others (dropped after the links were chosen, anna had 1).  On the map before the first
// tick too.
test('a blocked pair takes no place in either ones links', () => {
  for (const [way, o] of ways()) {
    const k = new Kit({ ...o, degree: 2, minDegree: 2 });
    for (const [i, name, x] of [[0, 'anna', 0.0], [1, 'Bob', 5.0], [2, 'carl', 30.0], [3, 'dave', 60.0], [4, 'eve', 90.0]]) {
      place(k, i, name, x);
    }
    k.hub.blocks(V(1), ['ANNA']);
    k.from(V(0), mapreqBase(100, 1, 2048, 0));
    const map = mapEntries(k);
    assert.ok(!map.some((e) => e[1] !== null && e[1][0] === 5), way + ': Bob not on anna\'s map before a tick: ' + JSON.stringify(map));
    k.clear();
    k.hub.tick();
    for (const [i, j] of [[0, 1], [1, 0]]) {
      const l = links(k, i);
      assert.ok(l.length === 2 && !l.includes(V(j)), way + ': player ' + i + '\'s links ' + JSON.stringify(l));
    }
  }
});

// anna, Bob and carl share a crew, 400 m apart (crew-mates are linked first, however far): anna blocks Bob
test('a crew links no blocked pair', () => {
  for (const [way, o] of ways()) {
    const k = new Kit(o);
    const crew = [fnv1a('night owls')];
    for (const [i, name] of [[0, 'anna'], [1, 'Bob'], [2, 'carl']]) {
      k.from(V(i), helloWith(100 + i, { name, core: 7, crews: crew }));
      k.from(V(i), snap(100 + i, [i * 400.0, 0.0, 0.0]));
    }
    k.hub.tick();
    assert.ok(has(k, 0, 1), way + ': crew-mates linked');
    k.hub.blocks(V(0), ['bob']);
    k.clear();
    k.hub.tick();
    assert.ok(!has(k, 0, 1) && !has(k, 1, 0), way + ': not the blocked pair');
    assert.ok(has(k, 0, 2) && has(k, 1, 2), way + ': carl with both');
  }
});

// a name is its Online form (nfsu2-claims canonical): any case, a run of what is no letter or digit one _, cut to 15
test('a name is blocked as its online form', () => {
  const k = new Kit({});
  place(k, 0, 'anna', 0.0);
  place(k, 1, 'Bob_The_Great', 10.0);
  place(k, 2, 'carl', 20.0);
  place(k, 3, 'Bobby', 30.0);
  k.hub.blocks(V(0), ['bob the  great!', '  CARL ', '?']);
  k.hub.tick();
  assert.deepStrictEqual(links(k, 0), [V(3)], 'Bob_The_Great and carl blocked, Bobby not');
});

// Bob's keyphrase claimed "Bob"; anna blocks "bob"; Bob changes its name to Robert: still blocked (the old name is
// that keyphrase's for 14 days); dave is not
test('a claimed names keyphrase stays blocked under its next name', () => {
  const owner = (c) => {
    const o = ownerOfToken(c.repeat(43));
    assert.ok(o !== null);
    return o;
  };
  const [bob, dave] = [owner('B'), owner('D')];
  const claims = Claims.inMemory();
  const now = 1_000_000;
  unwrap(claims.claim('Bob', bob, now));
  const k = new Kit({});
  k.hub.setClaims(claims);
  const put = (k, i, name, o) => {
    const h = helloWith(100 + i, { name, core: 2 });
    k.hub.frameFrom(V(i), frame(V(i), h), o);
    k.hub.frameFrom(V(i), frame(V(i), snap(100 + i, [i * 10.0, 0.0, 0.0])), o);
  };
  put(k, 0, 'anna', null);
  put(k, 1, 'Bob', bob);
  put(k, 2, 'dave', dave);
  k.hub.blocks(V(0), ['bob']);
  k.hub.tick();
  assert.ok(!has(k, 0, 1) && has(k, 0, 2));
  unwrap(claims.claim('Robert', bob, now + 1000));
  put(k, 1, 'Robert', bob);
  k.clear();
  k.hub.tick();
  assert.ok(!has(k, 0, 1) && !has(k, 1, 0), 'Robert is Bob\'s keyphrase');
  assert.ok(has(k, 0, 2) && has(k, 1, 2));
});
