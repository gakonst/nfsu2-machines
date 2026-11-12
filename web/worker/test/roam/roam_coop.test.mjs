// A port of web/server-rs/crates/roam/tests/roam_coop.rs: co-op free roam through the hub: a browser's second local
// player is a second endpoint of its browser (player 1's port + 1), its HELLO flagged (roam_core.h RC_HF_SEAT2), its
// name the second form of player 1's ("Alex 2").
// 1. the links: two endpoints of one browser are never linked, by any way the hub links (the nearest, every pair or
//    the grid, an outrun's, a race lobby's, a crew's, friends), flagged or not; everyone else links with both;
// 2. the maps: a browser's world map and minimap leave out its other endpoints; a second player's questions go
//    unanswered (the browser's answer state is its first player's), and the second player is on everyone else's;
// 3. friends: the second player is nobody's friend (no marks either way, no friend linked first), and a keyphrase's
//    whereabouts are its first player's;
// 4. the console: a second player under the second form of its page's name, or of its claim, is a line of its own,
//    not "its game shows"; the operator's who still has its name;
// 5. the cheat watch: a second player's car put beside its first one's is no teleport; anywhere else it is, and so
//    is one beside another flagged endpoint or beside an endpoint not flagged;
// 6. a block of the second player's name, as a claimed name's, blocks its owner (both players); a second form two
//    claims of before share is one keyphrase's: another one's player under it is an impostor, and a block of it never
//    blocks that other keyphrase;
// 7. the counts: /players counts the browser once, info() its second players; a full hub of 24576 with players
//    coming and going keeps every world map's key under 16384, and a key that goes back goes to the next one shown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Claims, NAMES_KEY, ownerOfToken } from '../../src/claims/claims.js';
import { Kit, V, ways, fnv1a, dgram, helloWith, hello, snap, snapN, mapreqBase, mapreqFlags, nearreq, mapdOf, neardOf, bye, framePorts, peersOf, crewMarks, HF_HUBCREW, MARK_FRIEND } from './kit.mjs';

/** roam_core.h RC_HF_SEAT2: this endpoint is its browser's second local player */
const SEAT2 = 0x2000;
/** player 1's port and player 2's */
const P1 = 47210;
const P2 = 47211;

function owner(c) {
  const o = ownerOfToken(c.repeat(43));
  assert.ok(o !== null);
  return o;
}

/** a datagram from browser vip's endpoint at port, whose page plays with key's keyphrase (null: none) */
function send(k, vip, port, d, key) {
  const o = key != null ? owner(key) : null;
  k.hub.frameFrom(vip, framePorts(vip, d, port, 47210), o);
}

/** a player with these HELLO fields at (x, y): its HELLO and SNAP from browser vip's endpoint port */
function put(k, vip, port, id, h, key, at) {
  send(k, vip, port, helloWith(id, h), key);
  send(k, vip, port, snap(id, [at[0], at[1], 0.0]), key);
}

/** player 2's HELLO: flagged, no crews (the crew flag and a count of 0, so that the links byte is read), few links */
function seat2(name) {
  return { core: 12, name, flags: SEAT2 | HF_HUBCREW, crews: [], links: 8 };
}

/** player 1's HELLO, of a core of now */
function seat1(name) {
  return { core: 12, name, flags: HF_HUBCREW, crews: [], links: 24 };
}

function ep(vip, port) {
  return vip + ':' + port;
}

/** whether endpoint a's list names endpoint b (and b's names a: a link is listed at both ends); a, b: [vip, port] */
function linked(l, a, b) {
  const has = (x, y) => {
    const v = l.get(ep(x[0], x[1]));
    return v !== undefined && v.some((e) => e.vip === y[0] && e.port === y[1]);
  };
  assert.equal(has(a, b), has(b, a), JSON.stringify(a) + ' ' + JSON.stringify(b) + ': a link is listed at both ends');
  return has(a, b);
}

/** the MAPD and NEARD datagrams the hub sent since the last clear, to which endpoint: [[vip, port], mapd, near] */
function answers(k) {
  const to = (vip, f) => [vip, (f[14] << 8) | f[15]];
  const maps = [], nears = [];
  for (const [vip, f] of k.sent) {
    const m = mapdOf(f);
    if (m) maps.push([to(vip, f), m, false]);
  }
  for (const [vip, f] of k.sent) {
    const m = neardOf(f);
    if (m) nears.push([to(vip, f), m, true]);
  }
  return [...maps, ...nears];
}

/** the x of each player placed in an answer (a sorted array, for the Rust's HashSet) */
function xs(m) {
  return Array.from(new Set(m[5].filter((e) => e[1] !== null).map((e) => e[1][0]))).sort((a, b) => a - b);
}

// a browser's two endpoints, player 1 and player 2 three metres apart among three others: everyone is linked with both
// of them, they never with each other; nor two endpoints of a browser without the flag (a restart's lingering one)
test('a browsers endpoints are never linked', () => {
  for (const [how, o] of ways()) {
    const k = new Kit(o);
    put(k, V(0), P1, 100, seat1('Alex'), 'A', [0.25, 0.25]);
    put(k, V(0), P2, 200, seat2('Alex 2'), 'A', [3.25, 0.25]);
    for (let i = 1; i <= 3; i++) put(k, V(i), P1, 100 + i, seat1('p' + i), null, [3.0 * i + 3.25, 0.25]);
    put(k, V(4), P1, 104, seat1('Restart'), null, [20.25, 0.25]);
    put(k, V(4), 47212, 204, seat1('Restart'), null, [20.25, 1.25]);
    k.hub.tick();
    const l = k.lists();
    assert.ok(!linked(l, [V(0), P1], [V(0), P2]), how + ': player 1 and player 2');
    assert.ok(!linked(l, [V(4), P1], [V(4), 47212]), how + ": a browser's endpoints without the flag");
    for (let i = 1; i <= 3; i++) {
      assert.ok(linked(l, [V(0), P1], [V(i), P1]) && linked(l, [V(0), P2], [V(i), P1]), how + ': ' + i + ' with both');
    }
    assert.ok(linked(l, [V(4), P1], [V(0), P2]) && linked(l, [V(4), 47212], [V(0), P2]), how + ": two browsers' endpoints");
    assert.equal(k.hub.linkPairs().length, 10, how + ': every pair of the five browsers');
  }
});

// the links made before any other are none of them either: the two in one crew, in an outrun with each other, player
// 1 hosting a race lobby with player 2 at its start
test('a browsers endpoints are linked first by nothing', () => {
  const owls = fnv1a('owls');
  for (const [how, o] of ways()) {
    const k = new Kit(o);
    const one = { ...seat1('Alex'), crews: [owls], duel: 200 };
    const two = { ...seat2('Alex 2'), crews: [owls], duel: 100 };
    put(k, V(0), P1, 100, one, 'A', [0.25, 0.25]);
    put(k, V(0), P2, 200, two, 'A', [3.25, 0.25]);
    // a crew-mate 2 km off and a player beside them
    put(k, V(1), P1, 101, { ...seat1('Owl'), crews: [owls] }, null, [2000.25, 0.25]);
    put(k, V(2), P1, 102, seat1('Near'), null, [6.25, 0.25]);
    // player 1's lobby, its start where it is (an advert: op 1, max 4, lobby a1, race, x 0, y 0, n 1, its id)
    const p = new Uint8Array(28);
    p[0] = 1;
    p[3] = 4;
    p.set([0xa1, 0, 0, 0], 8);
    p.set([0x0d, 0xf0, 0xad, 0x0b], 12);
    p[22] = 1;
    p.set([100, 0, 0, 0], 24);
    send(k, V(0), P1, dgram(12, 100, p), 'A');
    k.hub.tick();
    const l = k.lists();
    assert.ok(!linked(l, [V(0), P1], [V(0), P2]), how);
    assert.ok(linked(l, [V(0), P1], [V(1), P1]), how + ": player 1's crew-mate far off");
    assert.ok(linked(l, [V(0), P1], [V(2), P1]) && linked(l, [V(0), P2], [V(2), P1]), how);
    assert.equal(k.info('duelLinks'), 0.0, how);
  }
});

// a browser's world map and minimap leave out its other endpoints (its game shows their cars itself); player 2's
// questions go unanswered, and take nothing of player 1's answers; player 2 is on another player's map and minimap
test('a browsers maps are its first players', () => {
  const k = new Kit({ degree: 1, viewM: 1e-9 });
  const plain = (name) => ({ core: 4, name });
  put(k, V(0), P1, 100, plain('Alex'), null, [0.25, 0.25]);
  put(k, V(0), P2, 200, { ...plain('Alex 2'), flags: SEAT2 }, null, [3.25, 0.25]);
  for (let i = 1; i <= 3; i++) put(k, V(i), P1, 100 + i, plain('p'), null, [100.0 * i + 0.25, 0.25]);
  // (a degree of 1: player 2 with 1, 2 with 3, player 1 with nobody)
  k.hub.tick();
  const l = k.lists();
  assert.ok(linked(l, [V(0), P2], [V(1), P1]) && linked(l, [V(2), P1], [V(3), P1]));
  assert.equal(l.get(ep(V(0), P1)).length, 0);
  k.clear();
  // player 2 asks first: nothing; player 1 at once after it: its answers
  send(k, V(0), P2, mapreqBase(200, 1, 64, 0), null);
  send(k, V(0), P2, nearreq(200, 1, 64, 0, 1000), null);
  assert.equal(answers(k).length, 0, "player 2's questions unanswered");
  send(k, V(0), P1, mapreqBase(100, 2, 64, 0), null);
  send(k, V(0), P1, nearreq(100, 3, 64, 0, 1000), null);
  const a = answers(k);
  assert.equal(a.length, 2, "player 1's map and minimap: " + JSON.stringify(a));
  for (const [to, m, near] of a) {
    assert.deepEqual(to, [V(0), P1], 'near ' + near);
    assert.deepEqual(xs(m), [100, 200, 300], 'near ' + near + ': the others, not player 2 (x 3)');
  }
  // another player's: player 2 is on them (3's: past its link, 2)
  k.clear();
  send(k, V(3), P1, mapreqBase(103, 1, 64, 0), null);
  send(k, V(3), P1, nearreq(103, 2, 64, 0, 1000), null);
  for (const [, m, near] of answers(k)) {
    assert.deepEqual(xs(m), [0, 3, 100], 'near ' + near + ": both of the browser's players");
  }
});

// player 2 is nobody's friend: player 1's friend sees player 1 marked and player 2 not, player 2's list marks nobody,
// and player 1's friend 2 km off is linked first with player 1 only; the keyphrase's whereabouts are player 1's
test('a second player is nobodys friend', () => {
  let k = new Kit({ degree: 2, viewM: 1e-9 });
  k.hub.friends(V(0), owner('A'), [owner('B')]);
  k.hub.friends(V(1), owner('B'), [owner('A')]);
  const two = (name) => ({ ...seat2(name), links: 2 });
  const one = (name) => ({ ...seat1(name), links: 2 });
  put(k, V(0), P1, 100, one('Alex'), 'A', [0.25, 0.25]);
  put(k, V(0), P2, 200, two('Alex 2'), 'A', [3.25, 0.25]);
  put(k, V(1), P1, 101, one('Bravo'), 'B', [2000.25, 0.25]);
  for (let i = 2; i <= 5; i++) put(k, V(i), P1, 100 + i, one('x'), null, [i + 3.25, 0.25]);
  k.hub.tick();
  let l = k.lists();
  assert.ok(linked(l, [V(0), P1], [V(1), P1]), "player 1's friend far off: linked first");
  assert.ok(!linked(l, [V(0), P2], [V(1), P1]), "player 2's links are by distance");
  // the marks: Bravo near both of them
  k = new Kit();
  k.hub.friends(V(0), owner('A'), [owner('B')]);
  k.hub.friends(V(1), owner('B'), [owner('A')]);
  put(k, V(0), P1, 100, seat1('Alex'), 'A', [0.25, 0.25]);
  put(k, V(0), P2, 200, seat2('Alex 2'), 'A', [3.25, 0.25]);
  put(k, V(1), P1, 101, seat1('Bravo'), 'B', [1.25, 1.25]);
  k.hub.tick();
  const sent = k.sent.slice();
  const list = (vip, port) => {
    const f = sent.find(([v, f]) => v === vip && ((f[14] << 8) | f[15]) === port)[1];
    const m = crewMarks(f);
    return new Map(peersOf(f).map((e, at) => [ep(e.vip, e.port), m ? m[1][at] : 0]));
  };
  const bravo = list(V(1), P1);
  assert.deepEqual([bravo.get(ep(V(0), P1)), bravo.get(ep(V(0), P2))], [MARK_FRIEND, 0], "Bravo's list: player 1 a friend, player 2 not");
  assert.equal(list(V(0), P1).get(ep(V(1), P1)), MARK_FRIEND, "player 1's: Bravo");
  assert.ok(Array.from(list(V(0), P2).values()).every((m) => m === 0), "player 2's: nobody");
  // whereabouts: player 1's room, player 2 in another
  const red = fnv1a('red');
  put(k, V(0), P2, 200, { ...seat2('Alex 2'), room: red }, 'A', [3.25, 0.25]);
  k.hub.tick();
  const w = k.hub.whereabouts([owner('A')])[0];
  assert.equal(w ? w.room : null, 0);
});

// the console: a second player under the second form of its page's name (or of its keyphrase's claim) is its own line;
// a game that shows another name, a name like it without the flag, or the flag with another name: "its game shows"
test('a known second player is a line of its own', () => {
  const claims = Claims.inMemory();
  assert.equal(claims.claim('Charlie', owner('C'), 1000000).err, undefined, 'the claim');
  const k = new Kit();
  k.hub.setClaims(claims);
  const pages = [
    [0, 'Alex', 'Alex 2', true],
    [1, 'Bob', 'Bob 2', false],
    [2, 'Dan', 'Mallory', true],
    [3, 'Alex the Great', 'Alex_the_Grea 2', true],
  ];
  for (const [i, page, p2, flag] of pages) {
    k.hub.pageName(V(i), page);
    put(k, V(i), P1, 100 + i, seat1(page), null, [0.25, 0.25]);
    const h = { ...seat2(p2), flags: flag ? SEAT2 : 0 };
    put(k, V(i), P2, 200 + i, h, null, [3.25, 0.25]);
  }
  // its page goes by digits, its keyphrase's claimed name is Charlie
  k.hub.pageName(V(4), 'Charlie1234');
  put(k, V(4), P1, 104, seat1('Charlie1234'), 'C', [0.25, 0.25]);
  put(k, V(4), P2, 204, seat2('Charlie 2'), 'C', [3.25, 0.25]);
  // and again: told once
  put(k, V(0), P2, 200, seat2('Alex 2'), null, [3.25, 0.25]);
  const lines = k.lines.slice();
  assert.deepEqual(
    lines.filter((l) => l.includes('(co-op)')),
    [
      '[roam] 10.77.0.10 "Alex": its second player (co-op) shows "Alex 2" over its car',
      '[roam] 10.77.0.13 "Alex the Great": its second player (co-op) shows "Alex_the_Grea 2" over its car',
      '[roam] 10.77.0.14 "Charlie1234": its second player (co-op) shows "Charlie 2" over its car',
    ],
  );
  assert.deepEqual(
    lines.filter((l) => l.includes('its game shows')),
    ['[roam] 10.77.0.11 "Bob": its game shows "Bob 2" over its car', '[roam] 10.77.0.12 "Dan": its game shows "Mallory" over its car'],
  );
  // who: the second players' names, as every other name its game shows
  const who = k.hub.otherNames();
  assert.deepEqual(who.get(V(0)), ['Alex 2']);
  assert.deepEqual(who.get(V(4)), ['Charlie 2']);
});

/** Ann (V(0) player 1) parked at (1000, 0, 0) and a second endpoint of hers (flags, port) at the origin, a SNAP of
 * each 500 ms ago; Bob (V(1)) far off */
function annAnd(port, flags) {
  const k = new Kit();
  const h = (name, flags) => ({ core: 12, room: fnv1a('bay'), name, flags });
  send(k, V(0), P1, helloWith(100, h('Ann', 0)), null);
  send(k, V(0), port, helloWith(200, h('Ann 2', flags)), null);
  send(k, V(1), P1, helloWith(101, h('Bob', 0)), null);
  send(k, V(0), P1, snap(100, [1000.0, 0.0, 0.0]), null);
  send(k, V(0), port, snap(200, [0.0, 0.0, 0.0]), null);
  send(k, V(1), P1, snap(101, [-3000.0, 0.0, 0.0]), null);
  k.step(500.0);
  send(k, V(0), P1, snap(100, [1000.0, 0.0, 0.0]), null);
  return k;
}

function cheats(k) {
  return k.lines.filter((l) => l.startsWith('[cheat]'));
}

// player 2's car put beside player 1's, 1 km from where it was: no teleport, and none adds up from it; 2 km on from
// there, beside nobody, a teleport; and a jump beside player 1 of an endpoint without the flag, one 100 m off it, and
// one beside another flagged endpoint (no player 1), are teleports as ever
test('a second player put beside its first is no teleport', () => {
  let k = annAnd(P2, SEAT2);
  send(k, V(0), P2, snap(200, [1010.0, 5.0, 0.0]), null);
  k.step(500.0);
  send(k, V(0), P2, snap(200, [1015.0, 5.0, 0.0]), null);
  assert.deepEqual(cheats(k), []);
  k.step(500.0);
  send(k, V(0), P2, snap(200, [3015.0, 5.0, 0.0]), null);
  let l = cheats(k);
  assert.ok(l.length === 1 && l[0].startsWith('[cheat] 10.77.0.10 "Ann 2": teleport 1: 2.0 km'), JSON.stringify(l));
  // the same jump of an endpoint without the flag; one 100 m off player 1
  for (const [port, flags, to] of [[47212, 0, [1010.0, 5.0, 0.0]], [P2, SEAT2, [1100.0, 0.0, 0.0]]]) {
    const k = annAnd(port, flags);
    send(k, V(0), port, snap(200, to), null);
    const l = cheats(k);
    assert.ok(l.length === 1 && l[0].startsWith('[cheat] 10.77.0.10 "Ann 2": teleport 1'), 'port ' + port + ': ' + JSON.stringify(l));
  }
  // two flagged endpoints: neither is a first player
  k = annAnd(P2, SEAT2);
  const h = { core: 12, room: fnv1a('bay'), name: 'Ann', flags: SEAT2 };
  send(k, V(0), P1, helloWith(100, h), null);
  send(k, V(0), P2, snap(200, [1010.0, 5.0, 0.0]), null);
  assert.equal(cheats(k).length, 1, JSON.stringify(cheats(k)));
});

// another page blocks player 2 by its name: as a claimed name's, its owner is blocked, both players (and player 1's
// name blocks player 2, its keyphrase's)
test('a block of a second players name blocks its owner', () => {
  const claims = Claims.inMemory();
  assert.equal(claims.claim('Alex', owner('A'), 1000000).err, undefined, 'the claim');
  for (const blocked of ['Alex 2', 'Alex']) {
    const k = new Kit();
    k.hub.setClaims(claims);
    k.hub.blocks(V(1), [blocked]);
    put(k, V(0), P1, 100, seat1('Alex'), 'A', [0.25, 0.25]);
    put(k, V(0), P2, 200, seat2('Alex 2'), 'A', [3.25, 0.25]);
    put(k, V(1), P1, 101, seat1('Blocker'), 'B', [6.25, 0.25]);
    put(k, V(2), P1, 102, seat1('Other'), null, [9.25, 0.25]);
    k.hub.tick();
    const l = k.lists();
    assert.ok(!linked(l, [V(1), P1], [V(0), P1]) && !linked(l, [V(1), P1], [V(0), P2]), blocked + ' blocked');
    assert.ok(linked(l, [V(2), P1], [V(0), P1]) && linked(l, [V(2), P1], [V(0), P2]), blocked + ': the others see both');
  }
});

// The 2026-11-05 security audit's case: "Speedracer123" (V) and "Speedracer123x" (A), claims of before that share one
// second form, "Speedracer123 2" (a claim of the second now is refused: nfsu2-claims).  It is V's only, the holder of
// the name of 13: A's player under it is an impostor, linked with nobody, and a block of it blocks V (its second
// player's name), never A's player under A's own claim.  (The Rust writes names.json to a directory and opens the
// claims there; the Worker's claims open from a storage: one in memory with that names.json.)
test('a second form two claims share is one keyphrases', async () => {
  const t0 = 1000000;
  const claim = (name, c, made) => JSON.stringify({ name, owner: owner(c), made, seen: made });
  const file = '{"v":1,"claims":[' + claim('Speedracer123x', 'A', t0) + ',' + claim('Speedracer123', 'V', t0 + 1) + ']}';
  const storage = { get: async (key) => (key === NAMES_KEY ? file : null), put: async () => {} };
  const claims = await Claims.open(storage, t0 + 2);
  assert.equal(claims.count(t0 + 2), 2);
  for (const block of [false, true]) {
    const k = new Kit();
    k.hub.setClaims(claims);
    if (block) k.hub.blocks(V(0), ['Speedracer123 2']);
    put(k, V(0), P1, 100, seat1('Watcher'), null, [0.25, 0.25]);
    put(k, V(1), P1, 101, seat1('Speedracer123'), 'V', [10.25, 0.25]);
    put(k, V(2), P1, 102, seat1('Speedracer123x'), 'A', [20.25, 0.25]);
    put(k, V(3), P1, 103, seat1('Speedracer123 2'), 'A', [30.25, 0.25]);
    k.hub.tick();
    const l = k.lists();
    assert.ok(!linked(l, [V(0), P1], [V(3), P1]), 'block ' + block + ": A under V's second form, an impostor");
    assert.ok(linked(l, [V(0), P1], [V(2), P1]), 'block ' + block + ': A under its own claim');
    assert.equal(linked(l, [V(0), P1], [V(1), P1]), !block, 'block ' + block + ": V, the second form's owner");
  }
});

// /players counts a browser once, its second player too; info() counts the second players in free roam
test('a second player counts as its browser', () => {
  const k = new Kit();
  put(k, V(0), P1, 100, seat1('Alex'), null, [0.25, 0.25]);
  put(k, V(0), P2, 200, seat2('Alex 2'), null, [3.25, 0.25]);
  put(k, V(1), P1, 101, seat1('Bravo'), null, [6.25, 0.25]);
  assert.deepEqual([k.hub.inRoam(), k.info('players'), k.info('coopSeats')], [2, 3.0, 1.0]);
  // player 2 in a shop: not driving there
  send(k, V(0), P2, helloWith(200, { ...seat2('Alex 2'), status: 4 }), null);
  assert.equal(k.info('coopSeats'), 0.0);
  // the flag gone (another game on the port): no second player
  send(k, V(0), P2, helloWith(200, seat1('Alex 2')), null);
  assert.equal(k.info('coopSeats'), 0.0);
});

// a full hub (24576 endpoints: the switch's 24000 places, nearly all of which can be in free roam, and co-op's second
// players), 2000 coming as others go: the 24577th is refused.  A world map names each player it shows by a key of its
// own, under 16384, the most a parked map's key names (one past it read as another one's, parked): with everyone
// driving the keys run out (the first 16384 have one, the others show on no map), each leaver's goes to a newcomer, the
// new ones' map shows each of them once, and a key one gives back (to the menus) goes to the next player shown
test('a full hub keeps every maps key under 16384', () => {
  const k = new Kit();
  const v = (i) => (0x0a4d0100 + i) >>> 0;
  for (let i = 0; i < 24576; i++) k.from(v(i), hello(1000 + i));
  k.from(v(25000), hello(99));
  assert.deepEqual([k.info('players'), k.info('refused')], [24576.0, 1.0]);
  assert.equal(k.info('mapKeys'), 16384.0, 'every key handed out');
  const late = fnv1a('late');
  for (let n = 0; n < 2000; n++) {
    k.from(v(n), bye(1000 + n));
    const vip = v(30000 + n), id = 50000 + n;
    k.from(vip, helloWith(id, { room: late }));
    k.from(vip, snap(id, [(n % 50) * 20.0, Math.floor(n / 50) * 20.0, 0.0]));
  }
  assert.equal(k.info('players'), 24576.0);
  assert.equal(k.info('mapKeys'), 16384.0, "each leaver's key to a newcomer");
  k.clear();
  // the world map of one of them, with who is parked and heights (the game's), as wide as it takes
  k.from(v(30000), mapreqFlags(50000, 1, 4096, 0, 1 | 2));
  const keys = answers(k).flatMap(([, m]) => m[5].map((e) => e[0]));
  assert.equal(keys.length, 1999, "the room's others");
  assert.ok(keys.every((s) => s < 0x4000), 'a key past 16383: ' + JSON.stringify(keys.filter((s) => s >= 0x4000).slice(0, 3)));
  assert.equal(new Set(keys).size, 1999, 'each once');
  // one of them goes to the menus: its key goes back, and a player without one takes it at its next SNAP
  k.from(v(30001), snapN(50001, [20.0, 0.0, 0.0], 0, 1));
  assert.equal(k.info('mapKeys'), 16383.0, 'a key back');
  k.from(v(20000), snap(21000, [0.0, 0.0, 0.0]));
  assert.equal(k.info('mapKeys'), 16384.0, 'taken by the next one shown');
});

