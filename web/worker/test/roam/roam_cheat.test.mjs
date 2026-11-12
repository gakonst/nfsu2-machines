// A port of web/server-rs/crates/roam/tests/roam_cheat.rs.
//
// The cheat watch (watch.js) through the hub: a teleport onto another player is a [cheat] line that names it, the
// game's own jumps are none, and a player who leaves after a cheat gets its summary.  The races' results (results.js):
// a race won by cheating is a line, its racers named as the endpoints that joined its lobby, its clean wins by two
// clients.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kit, V, fnv1a, helloWith, snap, dgram, bye, framePorts } from './kit.mjs';

/** a player of room "bay" named name, in status status */
function hello(k, i, name, status) {
  k.from(V(i), helloWith(100 + i, { core: 5, room: fnv1a('bay'), name, status }));
}

/** Ann (V(0)) parked at (1000, 0, 0) and Bob (V(1)) at the origin, each with a SNAP 500 ms ago */
function two() {
  const k = new Kit({});
  hello(k, 0, 'Ann', 2);
  hello(k, 1, 'Bob', 2);
  k.from(V(0), snap(100, [1000.0, 0.0, 0.0]));
  k.from(V(1), snap(101, [0.0, 0.0, 0.0]));
  k.step(500.0);
  k.from(V(0), snap(100, [1000.0, 0.0, 0.0]));
  return k;
}

function cheats(k) {
  return k.lines.filter((l) => l.startsWith('[cheat]'));
}

function clearLines(k) {
  k.lines.length = 0;
}

/** little-endian writes into a payload */
function put32(p, o, v) {
  new DataView(p.buffer, p.byteOffset, p.byteLength).setUint32(o, v >>> 0, true);
}
function put16(p, o, v) {
  new DataView(p.buffer, p.byteOffset, p.byteLength).setUint16(o, v & 0xffff, true);
}
function putF32(p, o, v) {
  new DataView(p.buffer, p.byteOffset, p.byteLength).setFloat32(o, v, true);
}

// Bob teleports 1 km onto Ann: a line with his address and hers; his BYE sums it up
test('a teleport onto a player names both', () => {
  const k = two();
  k.from(V(1), snap(101, [1005.0, 0.0, 0.0]));
  assert.deepEqual(cheats(k), [
    '[cheat] 10.77.0.11 "Bob": teleport 1: 1.0 km in 0.5 s, 918 m more than a car drives, (0, 0, 0) to (1005, 0, 0); ' +
      'next to "Ann" 10.77.0.10 (5 m)',
  ]);
  clearLines(k);
  k.step(500.0);
  k.from(V(1), bye(101));
  assert.deepEqual(cheats(k), ['[cheat] 10.77.0.11 "Bob", 1 s in free roam (left): 1 teleport (1 next to other players)']);
});

// at a race lobby's start: the line says whose
test("a teleport to a race lobby says so", () => {
  const k = two();
  const p = new Uint8Array(28);
  p[0] = 1; // advert
  p[3] = 4;
  put32(p, 8, 0xa1);
  put32(p, 12, 0x0badf00d);
  put16(p, 16, 1000);
  p[22] = 1;
  put32(p, 24, 100);
  k.from(V(0), dgram(12, 100, p));
  k.from(V(1), snap(101, [1010.0, 10.0, 0.0]));
  const l = cheats(k);
  assert.ok(l.length === 1 && l[0].endsWith('; at the start of "Ann"\'s race lobby'), JSON.stringify(l));
});

// no line for the game's own jumps: a Respawn (250 m), Jump to Garage (a status out of free roam between), a long
// drive at 100 m/s; and nobody is named who is not next to the car
test("the game's own jumps are none", () => {
  const k = two();
  k.from(V(1), snap(101, [250.0, 0.0, 0.0]));
  k.step(500.0);
  hello(k, 1, 'Bob', 0);
  k.step(3000.0);
  hello(k, 1, 'Bob', 2);
  k.from(V(1), snap(101, [-3000.0, 2000.0, 0.0]));
  for (let i = 1; i <= 300; i++) {
    k.step(500.0);
    k.from(V(1), snap(101, [-3000.0 + 50.0 * i, 2000.0, 0.0]));
  }
  assert.deepEqual(cheats(k), []);
  k.step(500.0);
  k.from(V(1), snap(101, [-5000.0, 2000.0, 0.0]));
  const l = cheats(k);
  assert.ok(l.length === 1 && l[0].endsWith('(12000, 2000, 0) to (-5000, 2000, 0)'), JSON.stringify(l));
  k.hub.tick();
  assert.equal(k.info('cheatLines'), 1.0);
});

// off the switch and back within a minute (a bad connection's page): Bob's watch goes on (the teleport across the
// gap is his second, the summary one, at his BYE); gone for good, his summary comes a minute later, as of when he went
test('a watch outlives a dropped connection', () => {
  const k = two();
  k.from(V(1), snap(101, [1005.0, 0.0, 0.0]));
  k.hub.peerGone(V(1));
  k.step(20000.0);
  k.hub.tick();
  assert.equal(cheats(k).length, 1, 'no summary yet: ' + JSON.stringify(cheats(k)));
  hello(k, 1, 'Bob', 2);
  k.from(V(1), snap(101, [9000.0, 0.0, 0.0]));
  const l = cheats(k);
  assert.ok(l.length === 2 && l[1].startsWith('[cheat] 10.77.0.11 "Bob": teleport 2: 8.0 km in 20.0 s'), JSON.stringify(l));
  k.from(V(1), bye(101));
  assert.equal(cheats(k)[2], '[cheat] 10.77.0.11 "Bob", 20 s in free roam (left): 2 teleports (1 next to other players)');
  // Ann (silent since, gone from the hub, her watch kept), back with a teleport of hers, then gone for good
  clearLines(k);
  hello(k, 0, 'Ann', 2);
  k.from(V(0), snap(100, [-5000.0, 0.0, 0.0]));
  k.hub.peerGone(V(0));
  k.step(30000.0);
  k.hub.tick();
  assert.equal(cheats(k).length, 1, 'her teleport, no summary yet');
  k.step(31000.0);
  k.hub.tick();
  assert.equal(cheats(k)[1], '[cheat] 10.77.0.10 "Ann", 20 s in free roam (left): 1 teleport');
  assert.equal(k.info('watchesKept'), 0.0);
});

// another start of the game (a new id) on that endpoint: where its car was counts for nothing
test('another start of the game starts its watch afresh', () => {
  const k = two();
  k.hub.peerGone(V(1));
  k.step(5000.0);
  k.from(V(1), helloWith(999, { core: 5, room: fnv1a('bay'), name: 'Bob', status: 2 }));
  k.from(V(1), snap(999, [9000.0, 0.0, 0.0]));
  assert.deepEqual(cheats(k), []);
});

/**
 * a RACERES datagram as roam_core.c lays it out: lobby, race, mode, laps, n, the heat; rows [id, flags, time, done,
 * dist]
 */
function raceres(sender, lobby, rows) {
  return raceresHeat(sender, lobby, 0, 0, rows, []);
}

/** ...of heat heat of heats (the head's last byte heats << 4 | heat), each row's car's jump (m, u16 after its flags) */
function raceresHeat(sender, lobby, heat, heats, rows, jumps) {
  const p = new Uint8Array(12 + 20 * rows.length);
  put32(p, 0, lobby);
  put32(p, 4, 0x7c80e775);
  p[8] = 1;
  p[9] = 1;
  p[10] = rows.length;
  p[11] = ((heats << 4) | heat) & 0xff;
  rows.forEach(([id, flags, time, done, dist], k) => {
    const o = 12 + 20 * k;
    put32(p, o, id);
    p[o + 4] = flags;
    put16(p, o + 5, jumps[k] ?? 0);
    putF32(p, o + 8, time);
    putF32(p, o + 12, done);
    putF32(p, o + 16, dist);
  });
  return dgram(16, sender, p);
}

/** a LOBBY datagram of sender's to the hub: op (1 advert, 2 an ask to join) of lobby lobby, race 0x7C80E775, with the host (100) in it */
function lobby(sender, op, l) {
  const p = new Uint8Array(28);
  p[0] = op;
  p[3] = 4;
  put32(p, 8, l);
  put32(p, 12, 0x7c80e775);
  p[22] = 1;
  put32(p, 24, 100);
  return dgram(12, sender, p);
}

/** Ann's (100) lobby l, and Bob's (101) ask to join it */
function lobbyOfTwo(k, l) {
  k.from(V(0), lobby(100, 1, l));
  k.from(V(1), lobby(101, 2, l));
}

// a race the game ended at once for Bob (a test's racewin, its real rows): his win is a [cheat] line once both reports
// came, naming him by his address though he left first
test('a race won by cheating names its winner', () => {
  const k = two();
  lobbyOfTwo(k, 0xa1);
  // (rows: Bob 101 first, Ann 100; flags 2: the reporter's own)
  k.from(V(1), raceres(101, 0xa1, [[101, 2, 4.75, 0.006, 38.0], [100, 0, 34.75, 0.168, 901.0]]));
  k.from(V(1), bye(101));
  clearLines(k);
  k.hub.tick();
  assert.deepEqual(cheats(k), [], 'one of two reports');
  k.from(V(0), raceres(100, 0xa1, [[101, 0, 4.75, 0.006, 38.0], [100, 2, 34.75, 0.168, 901.0]]));
  k.hub.tick();
  assert.deepEqual(cheats(k), [
    '[cheat] 10.77.0.11 "Bob": won the race of lobby 000000a1 (race 7c80e775: sprint, 1 lap) in 0:04.8, having ' +
      "driven 0.6 % of the way; nobody else finished (the race ends 30 s after the first): as 2 of 2 players' games saw it",
  ]);
});

/** flags 1 finished, 2 the reporter's own */
const own = (me, id) => 1 | (me === id ? 2 : 0);

// an honest race (a test's real rows): no line
test('an honest race is none', () => {
  const k = two();
  lobbyOfTwo(k, 0xa2);
  const rows = (me) => [[101, own(me, 101), 176.49, 1.0, 5265.0], [100, own(me, 100), 178.15, 1.0, 5281.0]];
  k.from(V(1), raceres(101, 0xa2, rows(101)));
  k.from(V(0), raceres(100, 0xa2, rows(100)));
  k.hub.tick();
  assert.deepEqual(cheats(k), []);
});

// results name nobody who was not in the race: Bob's of a lobby the hub never saw, or of Ann's lobby before he asked to
// join it (Ann won in 4.75 s at 0.6 % of the way, they say), count for nothing; in it, a row naming Cat (who never
// joined) is nobody; and one results message of his a lobby, none within 20 s of his last
test("results name only the lobby's players", () => {
  const k = two();
  // (91 s on, every race judged; the three back on the hub)
  const later = (k) => {
    k.step(91000.0);
    k.hub.tick();
    for (const [i, name] of [[0, 'Ann'], [1, 'Bob'], [2, 'Cat']]) hello(k, i, name, 2);
  };
  later(k);
  // (won in 4.75 s at 0.6 % of the way, by every report)
  const framed = (me, who) => [[who, 0, 4.75, 0.006, 38.0], [me, 2, 34.75, 0.168, 901.0]];
  k.from(V(1), raceres(101, 0xb1, framed(101, 100)));
  later(k);
  k.from(V(0), lobby(100, 1, 0xb2));
  k.from(V(1), raceres(101, 0xb2, framed(101, 100)));
  later(k);
  assert.deepEqual(cheats(k), [], 'no lobby, or not in it');
  lobbyOfTwo(k, 0xb3);
  k.from(V(1), raceres(101, 0xb3, framed(101, 102)));
  k.from(V(0), raceres(100, 0xb3, framed(100, 102)));
  later(k);
  assert.deepEqual(cheats(k), [], 'Cat is nobody');
  // Bob's real race's results, then fakes of the same and of another lobby of Ann's he is in
  lobbyOfTwo(k, 0xb4);
  lobbyOfTwo(k, 0xb5);
  const honest = (me) => [[100, own(me, 100), 180.0, 1.0, 5200.0], [101, own(me, 101), 185.0, 1.0, 5300.0]];
  const fake = [[100, 1, 4.0, 1.0, 5200.0], [101, 3, 185.0, 1.0, 5300.0]];
  k.from(V(1), raceres(101, 0xb4, honest(101)));
  k.from(V(1), raceres(101, 0xb5, fake));
  k.from(V(0), raceres(100, 0xb4, honest(100)));
  later(k);
  assert.deepEqual(cheats(k), [], 'one results message a lobby, 20 s apart');
  // (and the same fake 21 s on is taken: a line)
  lobbyOfTwo(k, 0xb6);
  k.from(V(1), raceres(101, 0xb6, fake));
  later(k);
  const l = cheats(k);
  assert.ok(l.length === 1 && l[0].startsWith('[cheat] 10.77.0.10 "Ann": won the race of lobby 000000b6'), JSON.stringify(l));
});

// a URL race of 3 heats: each racer's game sends a report a heat, the last heat's first, all at once, and each heat is
// judged as a race of its own; in heat 2 Ann's game had Bob's car jump 280 m once: a line naming him and the heat (the
// only other game of the race); a heat's second report of the same player counts for nothing
test('every heat is judged and a jump is a line', () => {
  const k = two();
  lobbyOfTwo(k, 0xc1);
  const rows = (me, a, b) => [[101, own(me, 101), a, 1.0, 5000.0], [100, own(me, 100), b, 1.0, 5000.0]];
  for (const [heat, a, b, jump] of [[3, 157.3, 167.9, 0], [1, 93.9, 94.8, 0], [2, 187.9, 206.4, 280]]) {
    k.from(V(0), raceresHeat(100, 0xc1, heat, 3, rows(100, a, b), [jump, 0]));
    k.from(V(1), raceresHeat(101, 0xc1, heat, 3, rows(101, a, b), [0, 0]));
  }
  // (Bob again, heat 2, his car with a jump of its own: refused, the heat's report came)
  k.from(V(1), raceresHeat(101, 0xc1, 2, 3, rows(101, 187.9, 206.4), [0, 900]));
  clearLines(k);
  k.hub.tick();
  assert.deepEqual(cheats(k), [
    '[cheat] 10.77.0.11 "Bob": its car jumped 280 m at once in the race of lobby 000000c1 (race 7c80e775: sprint, 1 lap, ' +
      "heat 2 of 3), as 1 of 1 other players' games had it (the largest each: 280 m; honest races' largest are under 50 " +
      'm); it won',
  ]);
  const races = k.lines.filter((l) => l.startsWith('[race] lobby 000000c1')).sort();
  assert.equal(races.length, 3, 'a result line a heat: ' + JSON.stringify(races));
  assert.ok(races[0].includes("(sprint, 1 lap, heat 1 of 3): the result by 2 of 2 racers' games: 1 Bob 1:33.9"), JSON.stringify(races));
});

// Bob's game says his car was in the air for 2 minutes (runtime/roam_game.c fly_frame), and his page leaves the switch:
// one line, with where his car was last and how many others were within 200 m along the ground (Ann, under him; not
// Cat, 300 m off), once a page; a page whose player is not on the hub has its name on the switch
test('a car in the air for minutes is one line a page', () => {
  const k = new Kit({});
  hello(k, 0, 'Ann', 2);
  hello(k, 1, 'Bob', 2);
  hello(k, 2, 'Cat', 2);
  k.hub.pageName(V(1), 'Bob');
  k.from(V(0), snap(100, [150.0, 0.0, 0.0]));
  k.from(V(1), snap(101, [0.0, 0.0, 40.0]));
  k.from(V(2), snap(102, [300.0, 0.0, 0.0]));
  k.hub.flew(V(1), 120.0);
  k.hub.flew(V(1), 120.0);
  assert.deepEqual(cheats(k), [
    '[cheat] 10.77.0.11 "Bob": its car was in the air in free roam for 120 s, by its own game, last at 0 0 40, 1 other ' +
      'player within 200 m: its page left the switch',
  ]);
  k.hub.pageName(V(5), 'Eve');
  k.hub.flew(V(5), NaN);
  assert.equal(
    cheats(k)[1],
    '[cheat] 10.77.0.15 "Eve": its car was in the air in free roam for 0 s, by its own game, not on the hub now: its ' +
      'page left the switch',
  );
});

/**
 * a racer: its browser, its endpoint (port), its game's id and name, and its client (an opaque id of its address, as
 * the switch gives the hub with each frame; null: its browser is a client of its own)
 */
function seat(vip, id, name) {
  return { vip, port: 47210, id, name, client: null };
}

/** a datagram from a racer's endpoint */
function at(k, s, d) {
  k.hub.frameOf(s.vip, framePorts(s.vip, d, s.port, 47210), null, s.client);
}

/** a racer's HELLO */
function helloOf(k, s) {
  at(k, s, helloWith(s.id, { core: 5, room: fnv1a('bay'), name: s.name }));
}

/**
 * a race of lobby l (race 0x7C80E775, a sprint of 1 lap) that a hosts and b joins, after their HELLOs; both games
 * report it alike, a row [id, finished, time, laps, m] a racer; then the hub's tick, and 21 s on (a player's results
 * are taken 20 s after its last)
 */
function race(k, l, a, b, rows) {
  helloOf(k, a);
  helloOf(k, b);
  at(k, a, lobby(a.id, 1, l));
  at(k, b, lobby(b.id, 2, l));
  for (const s of [a, b]) {
    const mine = rows.map(([id, fin, t, done, m]) => [id, (fin ? 1 : 0) | (id === s.id ? 2 : 0), t, done, m]);
    at(k, s, raceres(s.id, l, mine));
  }
  k.hub.tick();
  k.step(21000.0);
}

/** the [race] result lines of lobby l */
function resultsOf(k, l) {
  const head = '[race] lobby ' + (l >>> 0).toString(16).padStart(8, '0') + ', ';
  return k.lines.filter((x) => x.startsWith(head));
}

// The 2026-11-05 security audit: a game says its own id, and any PEERS list has the others'.  Mal's browser (V(1)) has
// two endpoints: its first hosts a lobby, its second says Vic's id and joins it; the first's report has Vic's car jump
// 300 m.  Vic (V(5)) never raced: the lines name the endpoint that joined with that id, Mal's second.
test('a borrowed id names the borrower', () => {
  const k = new Kit({});
  const vic = seat(V(5), 0x5555, 'Vic');
  const mal = seat(V(1), 0x1111, 'Mal');
  const mal2 = { ...seat(V(1), 0x5555, 'Mal 2'), port: 47211 };
  helloOf(k, vic);
  k.from(V(5), snap(0x5555, [0.0, 0.0, 0.0]));
  helloOf(k, mal);
  helloOf(k, mal2);
  at(k, mal, lobby(0x1111, 1, 0xa1));
  at(k, mal2, lobby(0x5555, 2, 0xa1));
  const own2 = (me, id) => (me === id ? 2 : 0);
  const rows = (me) => [[0x1111, 1 | own2(me, 0x1111), 60.0, 1.0, 3000.0], [0x5555, 1 | own2(me, 0x5555), 61.0, 1.0, 3000.0]];
  at(k, mal, raceresHeat(0x1111, 0xa1, 0, 0, rows(0x1111), [0, 300]));
  at(k, mal2, raceresHeat(0x5555, 0xa1, 0, 0, rows(0x5555), [0, 0]));
  k.hub.tick();
  const l = cheats(k);
  assert.ok(
    l.length === 1 && l[0].startsWith('[cheat] 10.77.0.11 "Mal 2": its car jumped 300 m at once in the race of lobby 000000a1'),
    JSON.stringify(l),
  );
  const r = resultsOf(k, 0xa1);
  assert.ok(r.length === 1 && r[0].endsWith("the result by 2 of 2 racers' games: 1 Mal 1:00.0, 2 Mal 2 1:01.0"), JSON.stringify(r));
  assert.ok(k.lines.every((x) => !x.includes('Vic') && !x.includes('10.77.0.15')), JSON.stringify(k.lines));
});

// ...and an id is the first browser's to join a lobby with: Vic joins Mal's lobby, then Mal's second endpoint asks to
// join it under Vic's id and reports first as Vic's game, that Vic won at 0.6 % of the way (a race the game ended at
// once), as Mal's own report does.  Its ask and its report count for nothing; Vic's own report (Mal won, Vic 5 s
// behind) is taken, and the two reports name no winner.
test("an id is the first browser's to join with it", () => {
  const k = new Kit({});
  const vic = seat(V(5), 0x5555, 'Vic');
  const mal = seat(V(1), 0x1111, 'Mal');
  const mal2 = { ...seat(V(1), 0x5555, 'Mal 2'), port: 47211 };
  helloOf(k, vic);
  helloOf(k, mal);
  at(k, mal, lobby(0x1111, 1, 0xa2));
  at(k, vic, lobby(0x5555, 2, 0xa2));
  helloOf(k, mal2);
  at(k, mal2, lobby(0x5555, 2, 0xa2));
  const own2 = (me, id) => (me === id ? 2 : 0);
  const framed = (me) => [[0x5555, own2(me, 0x5555), 4.75, 0.006, 38.0], [0x1111, own2(me, 0x1111), 34.75, 0.168, 901.0]];
  at(k, mal, raceres(0x1111, 0xa2, framed(0x1111)));
  at(k, mal2, raceres(0x5555, 0xa2, framed(0x5555)));
  at(k, vic, raceres(0x5555, 0xa2, [[0x1111, 1, 180.0, 1.0, 5800.0], [0x5555, 3, 185.0, 1.0, 5810.0]]));
  k.hub.tick();
  assert.deepEqual(cheats(k), []);
  const r = resultsOf(k, 0xa2);
  assert.ok(r.length === 1 && r[0].endsWith("the result by 2 of 2 racers' games: 1 Mal 3:00.0, 2 Vic 3:05.0"), JSON.stringify(r));
});

// The 2026-11-05 security audit: a race's clean wins are what its winners are measured by, and two endpoints of one
// browser "raced" a race no one had won yet, both reports alike, to a slow clean win (33:20); then an honest winner far
// ahead of the next car was a line.  A clean win is by the reports of two clients: one browser's endpoints are one, and
// so are two browsers of one address.  Two players of two addresses race honestly: each race is a [race] line, and
// their clean wins are the race's (10 of two winners: a teleport to the finish is a line).
test('a clean win is by two clients', () => {
  const k = new Kit({});
  const slow = (w, o, n) => [[w.id, true, 2000.0 + n, 1.0, 9000.0], [o.id, true, 2100.0 + n, 1.0, 9000.0]];
  // (one browser's two endpoints, and two browsers of one address: 10 races each, the two winning in turn)
  const m = [seat(V(1), 0x1111, 'm1'), { ...seat(V(1), 0x2222, 'm2'), port: 47211 }];
  const n = [{ ...seat(V(3), 0x3333, 'n1'), client: 'one' }, { ...seat(V(4), 0x4444, 'n2'), client: 'one' }];
  for (let i = 0; i < 10; i++) {
    for (const [l, [a, b]] of [[0xa0 + i, m], [0xb0 + i, n]]) {
      const [w, o] = i % 2 === 0 ? [a, b] : [b, a];
      race(k, l, a, b, slow(w, o, i));
    }
  }
  // Ann (V(5)) wins in 1:00, Bob (V(6)) gave up at 60 % of the way
  const ann = seat(V(5), 100, 'Ann'), bob = seat(V(6), 101, 'Bob');
  race(k, 0xc0, ann, bob, [[100, true, 60.0, 1.0, 3000.0], [101, false, 50.0, 0.6, 1800.0]]);
  assert.deepEqual(cheats(k), []);
  let r = resultsOf(k, 0xc0);
  assert.ok(r[0].endsWith("the result by 2 of 2 racers' games: 1 Ann 1:00.0, DNF Bob"), JSON.stringify(r));
  // 10 honest races, Ann and Bob winning in turn; then Bob in 0:21, Ann still on the way
  for (let i = 0; i < 10; i++) {
    const [w, o] = i % 2 === 0 ? [ann, bob] : [bob, ann];
    race(k, 0xd0 + i, ann, bob, [[w.id, true, 180.0 + i, 1.0, 5800.0], [o.id, true, 185.0 + i, 1.0, 5810.0]]);
  }
  r = resultsOf(k, 0xd1);
  assert.ok(r[0].endsWith("the result by 2 of 2 racers' games: 1 Bob 3:01.0, 2 Ann 3:06.0"), JSON.stringify(r));
  assert.deepEqual(cheats(k), []);
  race(k, 0xda, ann, bob, [[101, true, 21.0, 1.0, 400.0], [100, false, 51.0, 0.56, 1624.0]]);
  assert.deepEqual(cheats(k), [
    '[cheat] 10.77.0.16 "Bob": won the race of lobby 000000da (race 7c80e775: sprint, 1 lap) in 0:21.0, under 50 % of ' +
      "the race's quickest clean win (3:00.0); nobody else finished (the race ends 30 s after the first): as 2 of 2 " +
      "players' games saw it",
  ]);
});

// A race's quickest clean win goes for a teleport to the finish (nobody else over the line) once the race had 10
// clean wins by two winners at least, as the third quickest winner's does (the 2026-11-05 security audit: from the
// first, a slow "race" of a race no one had won yet, 33:20, made every honest winner in under half of it with no car
// close behind a line, and a win with a line is never a clean win that brings it down).  Cid and Dee (two addresses)
// agree on such a race: Ann's win in 1:00 is no line.
test('the quickest clean win waits for ten by two winners', () => {
  const k = new Kit({});
  const cid = seat(V(7), 0x7777, 'Cid'), dee = seat(V(8), 0x8888, 'Dee');
  const ann = seat(V(5), 100, 'Ann'), bob = seat(V(6), 101, 'Bob');
  race(k, 0xb0, cid, dee, [[0x7777, true, 2000.0, 1.0, 9000.0], [0x8888, true, 2100.0, 1.0, 9000.0]]);
  race(k, 0xc0, ann, bob, [[100, true, 60.0, 1.0, 3000.0], [101, false, 50.0, 0.6, 1800.0]]);
  assert.deepEqual(cheats(k), [], 'one clean win');
  // (9 more, all Cid's, 3:00 the quickest)
  for (let i = 1; i < 10; i++) {
    race(k, 0xb0 + i, cid, dee, [[0x7777, true, 179.0 + i, 1.0, 5800.0], [0x8888, true, 185.0 + i, 1.0, 5810.0]]);
  }
  const tele = [[101, true, 21.0, 1.0, 400.0], [100, false, 51.0, 0.56, 1624.0]];
  race(k, 0xc1, ann, bob, tele);
  assert.deepEqual(cheats(k), [], "10 clean wins, all Cid's");
  race(k, 0xba, cid, dee, [[0x8888, true, 190.0, 1.0, 5800.0], [0x7777, true, 195.0, 1.0, 5810.0]]);
  race(k, 0xc2, ann, bob, tele);
  const l = cheats(k);
  assert.ok(
    l.length === 1 &&
      l[0].startsWith(
        '[cheat] 10.77.0.16 "Bob": won the race of lobby 000000c2 (race 7c80e775: sprint, 1 lap) in 0:21.0, under 50 % ' +
          "of the race's quickest clean win (3:00.0); ",
      ),
    JSON.stringify(l),
  );
});

