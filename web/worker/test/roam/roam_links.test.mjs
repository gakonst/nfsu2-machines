// A port of web/server-rs/crates/roam/tests/roam_links.rs: how many links each player gets: what its HELLO asks for
// (roam_core version 10: the friends' cars its game shows, up to 64 from version 14, 48 before), the hub's degree at
// most; a core before version 10, which reads lists of 32 at most, gets 32.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Kit, helloWith, hello, snap } from './kit.mjs';

/** browser i's address, for more players than V's: 10.77.0.2 and on */
function W(i) {
  return (0x0a4d0002 + i) >>> 0;
}

/** the links of the player at W(i), as the hub's lists to it say */
function linksOf(k, i) {
  const l = k.lists().get(W(i) + ':47210');
  return l ? l.length : 0;
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
const within = (n, lo, hi) => n >= lo && n <= hi;

// 100 players within 30 m: those that ask for 16 get 16, those of a core before version 10 (which say nothing) 32 at
// most, those of version 10 that say nothing too, and those that ask for 48 more than 32, 48 at most and 90 % of that on
// the whole (the nearest pairs first: a player whose farther candidates are full keeps fewer, as at 32)
test('players get the links they ask for', () => {
  let k = new Kit({ viewM: 1e-9 });
  const ask = (i) => (i < 10 ? [10, 16] : i < 20 ? [9, 0] : i < 25 ? [10, 0] : [10, 48]);
  for (let i = 0; i < 100; i++) {
    const [core, links] = ask(i);
    k.from(W(i), helloWith(100 + i, { core, links }));
    k.from(W(i), snap(100 + i, [(i % 10) * 3.0 + 0.25, Math.floor(i / 10) * 3.0 + 0.25, 0.0]));
  }
  k.hub.tick();
  const many = [];
  for (let i = 0; i < 100; i++) {
    const n = linksOf(k, i);
    const [core, links] = ask(i);
    if (core === 10 && links === 16) assert.equal(n, 16, 'player ' + i);
    else if (links === 0) assert.ok(within(n, 29, 32), 'player ' + i + ' (' + ask(i) + '): ' + n);
    else {
      assert.ok(within(n, 33, 48), 'player ' + i + ': ' + n);
      many.push(n);
    }
  }
  assert.ok(sum(many) >= 0.9 * 48.0 * many.length, String(many));
  // asking for more than the hub gives: the hub's most
  k = new Kit({ degree: 40, viewM: 1e-9 });
  for (let i = 0; i < 60; i++) {
    k.from(W(i), helloWith(100 + i, { core: 10, links: 48 }));
    k.from(W(i), snap(100 + i, [(i % 10) * 3.0 + 0.25, Math.floor(i / 10) * 3.0 + 0.25, 0.0]));
  }
  k.hub.tick();
  const n = [];
  for (let i = 0; i < 60; i++) n.push(linksOf(k, i));
  assert.ok(n.every((x) => x <= 40) && sum(n) >= 36 * 60, "the hub's degree (40) at most: " + n);
});

// a player that asks for fewer links later (its Players' cars shown turned down) gets fewer at the next tick
test('a player that asks for fewer gets fewer', () => {
  const k = new Kit({ viewM: 1e-9 });
  const hi = (i, links) => k.from(W(i), helloWith(100 + i, { core: 10, links }));
  for (let i = 0; i < 60; i++) {
    hi(i, 48);
    k.from(W(i), snap(100 + i, [(i % 10) * 3.0 + 0.25, Math.floor(i / 10) * 3.0 + 0.25, 0.0]));
  }
  k.hub.tick();
  assert.ok(linksOf(k, 0) > 32, String(linksOf(k, 0)));
  hi(0, 20);
  k.clear();
  k.hub.tick();
  assert.equal(linksOf(k, 0), 20);
  for (let i = 1; i < 60; i++) assert.ok(within(linksOf(k, i), 33, 48), 'the others keep more than 32');
});

// the pairs the server's counts read (nfsu2-lan paths.rs): each link once, the lower address first, the same links the
// lists name; a player gone takes its pairs with it
test('link pairs are the links once', () => {
  const k = new Kit({ viewM: 1e-9 });
  for (let i = 0; i < 5; i++) {
    k.from(W(i), hello(100 + i));
    k.from(W(i), snap(100 + i, [i * 3.0 + 0.25, 0.25, 0.0]));
  }
  k.hub.tick();
  let pairs = k.hub.linkPairs();
  assert.equal(pairs.length, 10, 'five players near each other: every pair linked once, ' + JSON.stringify(pairs));
  assert.ok(pairs.every(([a, b]) => a < b));
  let listed = 0;
  for (let i = 0; i < 5; i++) listed += linksOf(k, i);
  assert.equal(listed, 2 * pairs.length, 'the lists name each link from both ends');
  k.hub.peerGone(W(4));
  k.hub.tick();
  pairs = k.hub.linkPairs();
  assert.equal(pairs.length, 6);
  assert.ok(pairs.every(([a, b]) => a !== W(4) && b !== W(4)));
});

// 100 players within 30 m: those of core version 14 that ask for 64 get more than 32, 64 at most and 90 % of that on the
// whole (those in the far corner, whose farther candidates are full, 43); those of versions 10 to 13, which read lists
// of 48 at most, get 48 at most whatever they ask for
test('players of core 14 get up to 64', () => {
  const k = new Kit({ viewM: 1e-9 });
  const ask = (i) => (i < 10 ? [13, 64] : i < 20 ? [10, 48] : [14, 64]);
  for (let i = 0; i < 100; i++) {
    const [core, links] = ask(i);
    k.from(W(i), helloWith(100 + i, { core, links }));
    k.from(W(i), snap(100 + i, [(i % 10) * 3.0 + 0.25, Math.floor(i / 10) * 3.0 + 0.25, 0.0]));
  }
  k.hub.tick();
  const many = [];
  for (let i = 0; i < 100; i++) {
    const n = linksOf(k, i);
    if (ask(i)[0] < 14) assert.ok(within(n, 33, 48), 'player ' + i + ' (' + ask(i) + '): ' + n);
    else {
      assert.ok(within(n, 33, 64), 'player ' + i + ': ' + n);
      many.push(n);
    }
  }
  assert.ok(sum(many) >= 0.9 * 64.0 * many.length, String(many));
});
