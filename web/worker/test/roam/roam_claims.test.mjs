// Port of web/server-rs/crates/roam/tests/roam_claims.rs, every test and assertion.
//! Free roam's hub and claimed names (nfsu2-claims): a player under a name another keyphrase claimed gets no links,
//! is on nobody's map and counts nowhere; its owner, and a name nobody claimed, play as before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kit, V, roomHash, helloWith, snap, frame, framePorts } from './kit.mjs';
import { Claims, ownerOfToken, HOLD_DAYS, DAY_MS } from '../../src/claims/claims.js';
import { Deny } from '../../src/names/index.js';

const T0 = 1_000_000;

function owner(c) {
  const o = ownerOfToken(c.repeat(43));
  assert.ok(o !== null);
  return o;
}

function unwrap(r) {
  assert.ok('ok' in r, 'claim: ' + JSON.stringify(r));
  return r.ok;
}

/** a player of name at x, whose page plays with key's keyphrase (null: none) */
function place(k, i, name, x, key) {
  const o = key === null ? null : owner(key);
  const h = helloWith(100 + i, { core: 4, name, room: roomHash('claims') });
  k.hub.frameFrom(V(i), frame(V(i), h), o);
  k.hub.frameFrom(V(i), frame(V(i), snap(100 + i, [x, 0.0, 0.0])), o);
}

function linked(k, i, j) {
  const l = k.lists().get(V(i) + ':47210');
  return l !== undefined && l.some((e) => e.vip === V(j));
}

test('a claimed name plays alone under another keyphrase', () => {
  const claims = Claims.inMemory();
  unwrap(claims.claim('Alex', owner('A'), T0));
  const k = new Kit({});
  k.hub.setClaims(claims);
  place(k, 0, 'Racer', 0.0, null);
  place(k, 1, 'Alex', 10.0, null);
  place(k, 2, 'alex', 20.0, 'B');
  place(k, 3, 'Alex', 30.0, 'A');
  k.hub.tick();
  assert.ok(linked(k, 0, 3) && linked(k, 3, 0), 'the owner plays with the others');
  for (const i of [1, 2]) {
    assert.ok(!linked(k, 0, i) && !linked(k, i, 0) && !linked(k, i, 3), 'player ' + i + ' under another\'s name: no links');
  }
  assert.strictEqual(k.hub.inRooms().get(roomHash('claims')), 2, 'they count nowhere');
  assert.strictEqual(k.lines.filter((l) => l.includes('a name another keyphrase claimed')).length, 2, JSON.stringify(k.lines));
  // the claim let go: they play with everyone at their next HELLO
  claims.release(owner('A'));
  k.clear();
  place(k, 1, 'Alex', 10.0, null);
  place(k, 2, 'alex', 20.0, 'B');
  k.hub.tick();
  assert.ok(linked(k, 0, 1) && linked(k, 0, 2));
  // a name claimed while its impostor drives: alone from its next HELLO on
  unwrap(claims.claim('Racer', owner('C'), T0));
  k.clear();
  place(k, 0, 'Racer', 0.0, null);
  k.hub.tick();
  assert.ok(!linked(k, 0, 1) && !linked(k, 1, 0));
});

test('playing holds the claim', () => {
  const claims = Claims.inMemory();
  unwrap(claims.claim('Alex', owner('A'), T0));
  const k = new Kit({});
  k.hub.setClaims(claims);
  k.step(30.0 * 86_400_000.0);
  place(k, 0, 'Alex', 0.0, 'A');
  const now = T0 + 30 * 86_400_000;
  const mine = claims.mine(owner('A'), now);
  assert.ok(mine !== null);
  assert.strictEqual(mine.until, now + HOLD_DAYS * DAY_MS);
});

// a name the operator took away (nfsu2-bans rename, RoamOptions::deny), and one that reads as it, plays alone the
// same way, claims or none; from its next HELLO on when it is taken away while its player drives
test('a name taken away plays alone', () => {
  const deny = new Deny();
  deny.set(['B4d_N4me']);
  const k = new Kit({ deny });
  place(k, 0, 'Racer', 0.0, null);
  place(k, 1, 'BadName', 10.0, null);
  place(k, 2, 'Driver', 20.0, 'B');
  k.hub.tick();
  assert.ok(linked(k, 0, 2) && linked(k, 2, 0));
  assert.ok(!linked(k, 0, 1) && !linked(k, 1, 0) && !linked(k, 2, 1));
  assert.strictEqual(k.lines.filter((l) => l.includes('a name the operator took away')).length, 1, JSON.stringify(k.lines));
  // Driver's name taken away now: alone from its next HELLO
  deny.set(['B4d_N4me', 'Driver']);
  k.clear();
  place(k, 2, 'Driver', 20.0, 'B');
  k.hub.tick();
  assert.ok(!linked(k, 0, 2) && !linked(k, 2, 0));
  // given back
  deny.set([]);
  k.clear();
  place(k, 1, 'BadName', 10.0, null);
  place(k, 2, 'Driver', 20.0, 'B');
  k.hub.tick();
  assert.ok(linked(k, 0, 1) && linked(k, 0, 2));
});

/** co-op's second player of browser i (port 47211, its HELLO flagged: roam_core.h RC_HF_SEAT2) under name at x */
function placeSecond(k, i, name, x, key) {
  const o = key === null ? null : owner(key);
  const h = helloWith(200 + i, { core: 4, name, room: roomHash('claims'), flags: 0x2000 });
  k.hub.frameFrom(V(i), framePorts(V(i), h, 47211, 47210), o);
  k.hub.frameFrom(V(i), framePorts(V(i), snap(200 + i, [x, 0.0, 0.0]), 47211, 47210), o);
}

function linkedSecond(k, i, j) {
  const l = k.lists().get(V(i) + ':47211');
  return l !== undefined && l.some((e) => e.vip === V(j));
}

// a claimed name's second form ("Alex 2", co-op's second player) is its owner's: its page's second player plays with
// everyone, another keyphrase's under it alone; a claim of the second form itself, older, comes first
test('a claimed names second form is its owners', () => {
  const claims = Claims.inMemory();
  unwrap(claims.claim('Bob_2', owner('C'), T0));
  unwrap(claims.claim('Alex', owner('A'), T0));
  unwrap(claims.claim('Bob', owner('D'), T0));
  const k = new Kit({});
  k.hub.setClaims(claims);
  place(k, 0, 'Racer', 0.0, null);
  place(k, 1, 'Alex', 10.0, 'A');
  placeSecond(k, 1, 'Alex 2', 13.0, 'A');
  placeSecond(k, 2, 'Alex 2', 20.0, 'B');
  place(k, 3, 'Bob', 30.0, 'D');
  placeSecond(k, 3, 'Bob 2', 33.0, 'D');
  place(k, 4, 'Bob 2', 40.0, 'C');
  k.hub.tick();
  assert.ok(linkedSecond(k, 1, 0) && linked(k, 0, 1), 'the owner\'s two players play with the others');
  assert.ok(!linkedSecond(k, 2, 0) && !linkedSecond(k, 2, 1), 'another keyphrase\'s Alex 2: no links');
  assert.ok(!linkedSecond(k, 3, 0) && linked(k, 3, 0), 'Bob 2 is C\'s claim: D\'s second player plays alone');
  assert.ok(linked(k, 4, 0), 'C under its own claim');
  assert.strictEqual(k.lines.filter((l) => l.includes('a name another keyphrase claimed')).length, 2, JSON.stringify(k.lines));
});

// the second form of a name taken away (co-op's second player's "BadName 2") plays alone as that name does: names are
// compared by their letters (nfsu2-names letters), and a 2 is none
test('a taken names second form plays alone', () => {
  const deny = new Deny();
  deny.set(['B4d_N4me']);
  const k = new Kit({ deny });
  place(k, 0, 'Racer', 0.0, null);
  place(k, 1, 'Driver', 10.0, null);
  placeSecond(k, 1, 'BadName 2', 13.0, null);
  place(k, 2, 'BadName_2', 20.0, null);
  k.hub.tick();
  assert.ok(linked(k, 0, 1));
  assert.ok(!linkedSecond(k, 1, 0) && !linked(k, 0, 2) && !linked(k, 2, 0));
  assert.strictEqual(k.lines.filter((l) => l.includes('a name the operator took away')).length, 2, JSON.stringify(k.lines));
});
