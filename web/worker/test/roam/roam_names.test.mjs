// A port of web/server-rs/crates/roam/tests/roam_names.rs: a page's name on the switch against the name its game shows
// over its car (Hub.pageName, Hub.otherNames): another one is a console line with the address and both names, and the
// operator's who finds the player by it.  The game's form of the page's name (any case, printable ASCII, 24 characters)
// is no other name.  Each name once, a few a page at most; a game heard before its page is held against it when the
// page comes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Kit, V, helloWith, bye } from './kit.mjs';

/** browser i's game says it is name */
function hello(k, i, name) {
  k.from(V(i), helloWith(100 + i, { core: 5, name, status: 2 }));
}

function names(k) {
  return k.lines.filter((l) => l.includes('its game shows'));
}

test('a game that shows another name than its pages is on the console and in who', () => {
  const k = new Kit({});
  k.hub.pageName(V(0), 'player');
  hello(k, 0, 'Mallory');
  assert.deepEqual(names(k), ['[roam] 10.77.0.10 "player": its game shows "Mallory" over its car']);
  assert.deepEqual(k.hub.otherNames(), new Map([[V(0), ['Mallory']]]));
  // its HELLOs go on with that name: no more lines
  hello(k, 0, 'Mallory');
  assert.equal(names(k).length, 1);
  // it leaves free roam: no other name now
  k.from(V(0), bye(100));
  assert.equal(k.hub.otherNames().size, 0);
});

test("the game's form of the page's name is no other name", () => {
  const k = new Kit({});
  for (const [i, page, game] of [
    [0, 'Bob', 'BOB'],
    [1, 'player', 'Player'],
    [2, 'Zoë', 'Zo?'],
    [3, 'A name of twenty-nine letters', 'A name of twenty-nine le'],
  ]) {
    k.hub.pageName(V(i), page);
    hello(k, i, game);
  }
  assert.deepEqual(names(k), []);
  assert.equal(k.hub.otherNames().size, 0);
});

test('a game before its page is held against it when the page comes', () => {
  const k = new Kit({});
  hello(k, 1, 'Eve2');
  assert.deepEqual(names(k), [], 'no page to hold it against');
  assert.deepEqual(k.hub.otherNames(), new Map([[V(1), ['Eve2']]]), 'who shows it: nothing to tell it by');
  k.hub.pageName(V(1), 'Eve');
  assert.deepEqual(names(k), ['[roam] 10.77.0.11 "Eve": its game shows "Eve2" over its car']);
});

test('each name once and a few a page until it leaves the switch', () => {
  const k = new Kit({});
  k.hub.pageName(V(0), 'Ann');
  for (const n of ['X1', 'X2', 'X1', 'Ann', 'X2', 'X3', 'X4', 'X5', 'X6']) hello(k, 0, n);
  const told = names(k).map((l) => l.split('"')[3]);
  assert.deepEqual(told, ['X1', 'X2', 'X3', 'X4']);
  assert.deepEqual(k.hub.otherNames(), new Map([[V(0), ['X6']]]), 'who has the one it shows now');
  // the page leaves the switch, and another takes the address
  k.hub.peerGone(V(0));
  k.hub.pageName(V(0), 'Ann');
  hello(k, 0, 'X7');
  assert.equal(names(k).at(-1), '[roam] 10.77.0.10 "Ann": its game shows "X7" over its car');
});
