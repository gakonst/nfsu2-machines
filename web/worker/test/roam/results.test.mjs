// Port of the #[cfg(test)] tests of web/server-rs/crates/roam/src/results.rs, every assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Results, RESULTS_WAIT_MS, RS_FINISHED, RS_OURS, LOBBY_PLAYERS, resultLine, line, jumpLine } from '../../src/roam/results.js';
import { MODE_DRIFT } from '../../src/anticheat/anticheat.js';

const row0 = () => ({ id: 0, flags: 0, time: 0.0, done: 0.0, dist: 0.0, jump: 0.0 });

/** a report of lobby (a 2-lap sprint) by by: rows [id, finished, time, laps, m] */
function repOf(lobby, rows, by) {
  const r = { lobby, race: 0x0badf00d, mode: 1, laps: 2, heat: 0, heats: 0, n: rows.length, rows: Array.from({ length: LOBBY_PLAYERS }, row0) };
  rows.forEach(([id, fin, time, done, dist], k) => {
    const flags = (fin ? RS_FINISHED : 0) | (id === by ? RS_OURS : 0);
    r.rows[k] = { id, flags, time, done, dist, jump: 0.0 };
  });
  return r;
}

const rep = (rows, by) => repOf(0xa1, rows, by);

/** reporter by's client: a client of its own */
const client = (by) => 'client ' + by;

const none = () => null;

/** the cheats of the races of these reports, each judged once all its reports came */
function judgedIn(x, reports) {
  for (const [by, r] of reports) x.add(0.0, by, client(by), r, none);
  const v = x.due(0.0);
  assert.ok(v.length <= 1);
  return v.length ? v.pop() : null;
}

const judged = (reports) => judgedIn(new Results(), reports);
const p = (id) => 'p' + id;

test('a race is a result line', () => {
  const x = new Results();
  const who = (id) => '10.77.0.' + id + ' "P' + id + '"';
  const by = (r, b, lobby) => repOf(lobby, r, b);
  const rows2 = [[1, true, 95.0, 2.0, 5800.0], [2, true, 101.0, 2.0, 5810.0], [3, false, 110.0, 1.5, 4300.0]];
  const rows3 = [[1, true, 95.4, 2.0, 5800.0], [2, true, 101.0, 2.0, 5810.0], [3, false, 110.0, 1.5, 4300.0]];
  x.add(0.0, 2, client(2), by(rows2, 2, 0xa1), who);
  x.add(0.0, 3, client(3), by(rows3, 3, 0xa1), who);
  assert.deepEqual(x.judged(80_000.0), [], 'two of three reports: the third may come');
  let j = x.judged(RESULTS_WAIT_MS);
  assert.equal(j.length, 1);
  assert.equal(j[0][1], null, 'no cheat');
  assert.equal(
    resultLine(j[0][0], who),
    '[race] lobby 000000a1, race 0badf00d (sprint, 2 laps): the result by 2 of 3 racers\' games: 1 P1 1:35.0, 2 P2 ' +
      '1:41.0, DNF P3; no report from its own game: 10.77.0.1 "P1"',
  );
  // a drift race
  const d = by(rows2, 2, 0xa2);
  d.mode = MODE_DRIFT;
  x.add(0.0, 2, client(2), d, none);
  j = x.judged(RESULTS_WAIT_MS);
  assert.equal(
    resultLine(j[0][0], p),
    "[race] lobby 000000a2, race 0badf00d (drift, 2 laps): the result by 1 of 3 racers' games (won by points: no " +
      'order): finished p1, finished p2, DNF p3; no report from its own game: p1, p3',
  );
});

test('a win no car makes is a cheat', () => {
  const rows = [[2, true, 21.0, 2.0, 400.0], [1, true, 50.0, 2.0, 5800.0]];
  const v = judged([[1, rep(rows, 1)], [2, rep(rows, 2)]]);
  assert.ok(v, 'a verdict');
  assert.deepEqual([v.winner, v.time, v.seen, v.reports, v.next, v.length], [2, 21.0, 2, 2, [1, 50.0], 5800.0]);
  assert.ok(v.avg * 3.6 > 990.0, JSON.stringify(v));
  assert.equal(v.drove, null, 'it came the whole way');
});

test("a win far under the race's quickest is a cheat", () => {
  const x = new Results();
  const tele = (lobby) => {
    const rows = [[2, true, 21.0, 2.0, 400.0], [1, false, 51.0, 0.56, 1624.0]];
    return [[1, repOf(lobby, rows, 1)], [2, repOf(lobby, rows, 2)]];
  };
  assert.equal(judgedIn(x, tele(0xa1)), null, 'no clean win yet');
  // (3 and 4 win in turn)
  const clean = (k) => {
    const [w, o] = k % 2 === 0 ? [3, 4] : [4, 3];
    const rows = [[w, true, 180.0 + k, 2.0, 5800.0], [o, true, 185.0 + k, 2.0, 5810.0]];
    return [[3, repOf(0x100 + k, rows, 3)], [4, repOf(0x100 + k, rows, 4)]];
  };
  for (let k = 0; k < 9; k++) assert.equal(judgedIn(x, clean(k)), null);
  assert.equal(judgedIn(x, tele(0xa2)), null, '9 clean wins: too few to go by');
  assert.equal(judgedIn(x, clean(9)), null);
  const v = judgedIn(x, tele(0xa3));
  assert.ok(v, 'a verdict');
  assert.deepEqual([v.winner, v.quickest, v.third, v.length, v.next], [2, 180.0, null, null, null]);
  const l = line(v, p);
  assert.ok(l.includes("in 0:21.0, under 50 % of the race's quickest clean win (3:00.0); nobody else finished"), l);
  // (a win alone, by one report, or by the reports of one client, is no clean win; nor do 10 clean wins of one winner)
  const y = new Results();
  const alone = [[3, true, 180.0, 2.0, 5800.0], [4, false, 210.0, 1.5, 4300.0]];
  const both = [[3, true, 180.0, 2.0, 5800.0], [4, true, 185.0, 2.0, 5810.0]];
  for (let k = 0; k < 10; k++) {
    judgedIn(y, [[3, repOf(0x200 + k, alone, 3)], [4, repOf(0x200 + k, alone, 4)]]);
    y.add(0.0, 3, client(3), repOf(0x300 + k, both, 3), none);
    assert.deepEqual(y.due(RESULTS_WAIT_MS), []);
    for (const b of [3, 4]) y.add(0.0, b, 'one', repOf(0x400 + k, both, b), none);
    assert.deepEqual(y.due(0.0), []);
  }
  assert.equal(y.best.size, 0);
  assert.equal(judgedIn(y, tele(0xa4)), null);
  const z = new Results();
  for (let k = 0; k < 10; k++) judgedIn(z, [[3, repOf(0x500 + k, both, 3)], [4, repOf(0x500 + k, both, 4)]]);
  assert.equal(judgedIn(z, tele(0xa5)), null, "10 clean wins, all 3's");
});

test("a win far under the third quickest winner's is a cheat", () => {
  const x = new Results();
  // (the next finisher at next: far behind, else a time that close can be driven)
  const race = (x, lobby, w, t, next) => {
    const rows = [[w, true, t, 1.0, 5000.0], [99, true, next, 1.0, 5000.0]];
    return judgedIn(x, [[w, repOf(lobby, rows, w)], [99, repOf(lobby, rows, 99)]]);
  };
  for (let k = 0; k < 9; k++) assert.equal(race(x, 0x100 + k, 10 + k, 100.0 + k, 105.0 + k), null);
  assert.equal(race(x, 0x200, 30, 60.0, 65.0), null, '9 clean wins: too few to go by');
  // 10 wins now: the quickest winners 60, 100 and 101 s, and 69 s is under 70 % of the third
  let v = race(x, 0x201, 31, 69.0, 99.0);
  assert.ok(v, 'a verdict');
  assert.deepEqual([v.third, v.quickest], [[101.0, 10], null]);
  const l = line(v, p);
  assert.ok(l.includes("under 70 % of the third quickest other winner's time of the race's 10 clean wins (1:41.0)"), l);
  assert.equal(race(x, 0x202, 32, 71.0, 99.0), null, '71 s is over 70 % of 101 s');
  // a next finisher close behind (over 70 %): that time can be driven
  assert.equal(race(x, 0x204, 33, 64.0, 66.0), null, '64 s with another car in 66 s');
  // 30, whose 60 s came in before there were 10 wins, wins again in 62 s: the others' quickest are 64, 71 and 100 s
  v = race(x, 0x203, 30, 62.0, 99.0);
  assert.ok(v, 'a verdict');
  assert.deepEqual(v.third, [100.0, 12]);
});

test("the line says what the winner's own game said", () => {
  const seen = [[2, true, 49.0, 3.0, 3000.0], [1, true, 401.8, 3.0, 19200.0], [3, true, 431.0, 3.0, 19210.0]];
  const own = [[2, false, 59.0, 0.4, 3000.0], [1, true, 401.8, 3.0, 19200.0], [3, true, 431.0, 3.0, 19210.0]];
  const x = new Results();
  let v = judgedIn(x, [[1, rep(seen, 1)], [3, rep(seen, 3)], [2, rep(own, 2)]]);
  assert.ok(v, 'a verdict');
  assert.deepEqual([v.winner, v.seen, v.reports, v.own], [2, 2, 3, { kind: 'out', t: null }]);
  const l = line(v, p);
  assert.ok(l.endsWith(": as 2 of 3 players' games saw it; its own game: did not finish"), l);
  // (two reports of three: judged 90 s on)
  for (const by of [1, 3]) x.add(0.0, by, client(by), repOf(0xb1, seen, by), none);
  v = x.due(RESULTS_WAIT_MS).pop();
  assert.ok(v, 'a verdict');
  assert.ok(line(v, p).endsWith(": as 2 of 2 players' games saw it; its own game sent no report"), JSON.stringify(v));
  v = judgedIn(x, [1, 2, 3].map((by) => [by, repOf(0xb2, seen, by)]));
  assert.ok(v, 'a verdict');
  assert.ok(line(v, p).endsWith(": as 3 of 3 players' games saw it"), 'agrees: nothing more');
});

test('one report of a race the others quit is none', () => {
  const rows = [[2, false, 36.4, 0.146, 60.0], [1, false, 66.4, 0.0, 0.0]];
  const r = rep(rows, 2);
  r.mode = 2;
  r.laps = 1;
  assert.equal(judged([[2, r]]), null);
});

test('a race the game ended at once is a cheat', () => {
  const rows = [[2, false, 4.76, 0.006, 38.0], [1, false, 34.76, 0.168, 901.0]];
  const r = [rep(rows, 1), rep(rows, 2)];
  r[0].laps = 1;
  r[1].laps = 1;
  const v = judged([[1, r[0]], [2, r[1]]]);
  assert.ok(v, 'a verdict');
  assert.deepEqual([v.winner, v.time, v.next, v.length], [2, 4.76, null, null]);
  assert.ok(Math.abs(v.drove - 0.006) < 1e-9, JSON.stringify(v));
  const l = line(v, p);
  assert.ok(l.includes('in 0:04.8, having driven 0.6 % of the way; nobody else finished'), l);
});

test('honest races are none', () => {
  const close = [[1, true, 186.82, 2.0, 5822.0], [2, true, 187.67, 2.0, 5838.0]];
  assert.equal(judged([[1, rep(close, 1)], [2, rep(close, 2)]]), null);
  const sprint = [[2, true, 176.49, 1.0, 5265.0], [1, true, 178.15, 1.0, 5281.0]];
  assert.equal(judged([[1, rep(sprint, 1)], [2, rep(sprint, 2)]]), null);
  const afk = [[2, true, 180.0, 2.0, 5800.0], [1, false, 210.0, 0.2, 580.0]];
  assert.equal(judged([[1, rep(afk, 1)], [2, rep(afk, 2)]]), null);
  assert.equal(judged([[1, rep(afk, 1)]]), null, "the loser's report alone");
  const lost = [[2, true, 180.0, 2.0, 5800.0], [1, false, 210.0, 0.4, 1160.0], [3, true, 200.0, 2.0, 5810.0]];
  assert.equal(judged([[1, rep(lost, 1)], [2, rep(lost, 2)], [3, rep(lost, 3)]]), null);
});

test('racers still on the way say nothing of the length', () => {
  const rows = [[2, true, 82.71, 1.0, 4600.0], [1, false, 112.71, 0.8, 7000.0], [3, false, 112.71, 0.75, 6600.0]];
  const r = [[1, rep(rows, 1)], [2, rep(rows, 2)], [3, rep(rows, 3)]];
  for (const e of r) e[1].laps = 1;
  assert.equal(judged(r), null);
});

test('a next finisher far behind says nothing', () => {
  const honest = [[2, true, 180.0, 2.0, 5800.0], [3, false, 210.0, 0.3, 900.0]];
  const fake = [[2, true, 180.0, 2.0, 5800.0], [3, true, 1000.0, 2.0, 5800.0]];
  assert.equal(judged([[2, rep(honest, 2)], [3, rep(fake, 3)]]), null);
});

test('one report frames nobody', () => {
  const honest = [[2, true, 180.0, 2.0, 5800.0], [1, true, 185.0, 2.0, 5800.0], [3, true, 190.0, 2.0, 5800.0]];
  const framed = [[1, true, 10.0, 2.0, 5800.0], [2, true, 180.0, 2.0, 5800.0], [3, true, 190.0, 2.0, 5800.0]];
  assert.equal(judged([[1, rep(honest, 1)], [2, rep(honest, 2)], [3, rep(framed, 3)]]), null);
  const quick = [[2, true, 20.0, 2.0, 5800.0], [1, false, 50.0, 1.0, 2900.0]];
  const real = [[2, true, 180.0, 2.0, 5800.0], [1, true, 185.0, 2.0, 5800.0]];
  assert.equal(judged([[1, rep(quick, 1)], [2, rep(real, 2)]]), null, 'the slowest time any report gave him');
});

test('drifts are left out and races wait', () => {
  let rows = [[2, false, 4.76, 0.006, 38.0], [1, false, 34.76, 0.168, 901.0]];
  const d = rep(rows, 1);
  d.mode = MODE_DRIFT;
  assert.equal(judged([[1, d]]), null);
  // (three racers, two reports: the game's end of the race needs two)
  rows = [[2, false, 4.76, 0.006, 38.0], [1, false, 34.76, 0.168, 901.0], [3, false, 34.76, 0.15, 800.0]];
  const x = new Results();
  x.add(0.0, 1, client(1), rep(rows, 1), p);
  x.add(0.0, 3, client(3), rep(rows, 3), p);
  assert.deepEqual(x.due(80_000.0), [], 'two of three reports, 80 s on');
  const v = x.due(90_000.0);
  assert.equal(v.length, 1, '90 s on');
  assert.equal(v[0].names.get(2), 'p2', 'the racers as the hub knew them then');
  assert.deepEqual(x.due(90_000.0), [], 'judged once');
});

/** a report like repOf's, of heat heat of 3, with each row's jump (by the rows' order) */
function heatOf(lobby, heat, rows, jumps, by) {
  const r = repOf(lobby, rows, by);
  r.heat = heat;
  r.heats = heat > 0 ? 3 : 0;
  jumps.forEach((j, k) => {
    if (r.rows[k].id !== by) r.rows[k].jump = j;
  });
  return r;
}

test('a car that jumped is a line', () => {
  const who = (id) => '10.77.0.' + id + ' "P' + id + '"';
  const rows = [[1, true, 187.88, 3.0, 9503.0], [2, true, 206.35, 3.0, 9657.0], [3, false, 217.88, 2.97, 9524.0]];
  let x = new Results();
  for (const [by, j] of [[1, [0.0, 3.2, 7.6]], [2, [279.9, 0.0, 7.6]], [3, [275.0, 3.2, 0.0]]]) x.add(0.0, by, client(by), heatOf(0xc1, 2, rows, j, by), who);
  const j = x.judged(0.0);
  assert.equal(j.length, 1);
  let [o, v] = j[0];
  assert.deepEqual([v, o.heat, o.heats], [null, 2, 3], 'no time rule: 1 won by 18 s');
  assert.deepEqual(o.jumps, [{ id: 1, seen: [279.9, 275.0], others: 2, place: 1 }]);
  const l = jumpLine(o, o.jumps[0], who);
  assert.equal(
    l,
    '[cheat] 10.77.0.1 "P1": its car jumped 280 m at once in the race of lobby 000000c1 (race 0badf00d: sprint, 2 ' +
      "laps, heat 2 of 3), as 2 of 2 other players' games had it (the largest each: 280, 275 m; honest races' largest " +
      'are under 50 m); it won',
  );
  assert.ok(l.includes(' the race of lobby '), "a race's line: the operator's handle goes after it (control.rs)");
  assert.ok(resultLine(o, who).startsWith('[race] lobby 000000c1, race 0badf00d (sprint, 2 laps, heat 2 of 3): '));
  // one of two other games: none
  x = new Results();
  for (const [by, jj] of [[1, [0.0, 3.2, 7.6]], [2, [279.9, 0.0, 7.6]], [3, [40.0, 3.2, 0.0]]]) x.add(0.0, by, client(by), heatOf(0xc2, 2, rows, jj, by), none);
  assert.deepEqual(x.judged(0.0)[0][0].jumps, []);
  // two racers: the only other game; the racer's own report says nothing of its own car
  const two = [[2, true, 180.0, 2.0, 5800.0], [1, false, 210.0, 1.5, 4300.0]];
  x = new Results();
  x.add(0.0, 2, client(2), heatOf(0xc3, 0, two, [0.0, 0.0], 2), none);
  x.add(0.0, 1, client(1), heatOf(0xc3, 0, two, [400.0, 0.0], 1), none);
  [o] = x.judged(0.0)[0];
  assert.deepEqual(o.jumps, [{ id: 2, seen: [400.0], others: 1, place: 1 }]);
  assert.ok(jumpLine(o, o.jumps[0], p).includes('(race 0badf00d: sprint, 2 laps), as 1 of 1 other'));
  // honest jumps (a reset to the road, a hit): none
  x = new Results();
  for (const [by, jj] of [[1, [0.0, 44.0, 31.0]], [2, [39.5, 0.0, 42.9]], [3, [44.1, 7.6, 0.0]]]) x.add(0.0, by, client(by), heatOf(0xc4, 1, rows, jj, by), none);
  assert.deepEqual(x.judged(0.0)[0][0].jumps, []);
});

test('heats are judged apart', () => {
  const x = new Results();
  const h1 = [[1, true, 93.94, 3.0, 4932.0], [2, true, 94.77, 3.0, 4990.0]];
  const h2 = [[1, true, 187.88, 3.0, 9503.0], [2, true, 206.35, 3.0, 9657.0]];
  for (const by of [1, 2]) {
    x.add(0.0, by, client(by), heatOf(0xd1, 1, h1, [], by), none);
    x.add(0.0, by, client(by), heatOf(0xd1, 2, h2, [], by), none);
  }
  const j = x.judged(0.0);
  j.sort((a, b) => a[0].heat - b[0].heat);
  assert.deepEqual(
    j.map(([o, v]) => [o.heat, o.order[0], v === null]),
    [[1, [1, 93.94], true], [2, [1, 187.88], true]],
  );
  // (best's keys are "race,laps,heat")
  assert.deepEqual([...new Set([...x.best.keys()].map((k) => Number(k.split(',')[2])))].sort(), [1, 2], "each heat's own");
});

test('a close finish is no time cheat', () => {
  const x = new Results();
  // (10 clean wins to go by, 3 and 4 in turn, 7:08.4 the quickest)
  for (let k = 0; k < 10; k++) {
    const [w, o] = k % 2 === 0 ? [3, 4] : [4, 3];
    const slow = [[w, true, 428.4 + k, 2.0, 5700.0], [o, true, 440.0 + k, 2.0, 5710.0]];
    assert.equal(judgedIn(x, [[3, repOf(0xe100 + k, slow, 3)], [4, repOf(0xe100 + k, slow, 4)]]), null);
  }
  const close = [[1, true, 144.4, 2.0, 5700.0], [2, true, 145.9, 2.0, 5700.0]];
  assert.equal(judgedIn(x, [[1, repOf(0xe2, close, 1)], [2, repOf(0xe2, close, 2)]]), null);
  const behind = [[5, true, 129.6, 2.0, 5700.0], [6, true, 151.1, 2.0, 5700.0]];
  assert.equal(judgedIn(x, [[5, repOf(0xe3, behind, 5)], [6, repOf(0xe3, behind, 6)]]), null, '13 % behind');
  // (a winner far ahead still is one)
  const far = [[7, true, 60.0, 2.0, 5700.0], [8, true, 140.0, 2.0, 5700.0]];
  assert.ok(judgedIn(x, [[7, repOf(0xe4, far, 7)], [8, repOf(0xe4, far, 8)]]) !== null);
  // an average no car makes, with the next car as close: the race's length was off
  const long = [[1, true, 127.4, 2.0, 12700.0], [2, true, 131.7, 2.0, 12700.0]];
  assert.equal(judged([[1, rep(long, 1)], [2, rep(long, 2)]]), null);
});

test('a race the others quit is no time cheat', () => {
  const x = new Results();
  const drag = (lobby, rows, by) => ({ ...repOf(lobby, rows, by), laps: 1 });
  // (10 clean wins to go by, 3 and 4 in turn)
  for (let k = 0; k < 10; k++) {
    const [w, o] = k % 2 === 0 ? [3, 4] : [4, 3];
    const clean = [[w, true, 23.8, 1.0, 1600.0], [o, true, 26.6, 1.0, 1600.0]];
    assert.equal(judgedIn(x, [[3, drag(0xf0 + k, clean, 3)], [4, drag(0xf0 + k, clean, 4)]]), null);
  }
  const quit = [[1, false, 5.1, 0.035, 56.0], [2, false, 35.1, 0.0, 0.0]];
  x.add(0.0, 1, client(1), drag(0xff, quit, 1), none);
  assert.deepEqual(x.due(RESULTS_WAIT_MS), [], 'the one report, 90 s on');
  // (by two games it is the game's end of the race: a line, as before)
  const v = judgedIn(x, [[1, drag(0xfe, quit, 1)], [2, drag(0xfe, quit, 2)]]);
  assert.ok(v !== null && v.drove !== null);
});
