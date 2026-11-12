// The Online audit's cases (ONL-1 to ONL-13) at the level of the online host: crates/online/src/tests/audit.rs, one
// test for each of its tests (same scenarios, same assertions).  The parts that need the LAN switch are the
// integration's.  ONL-12 (the trace file: trace.rs) is not ported, as the JS port has no lobby trace; ONL-13's folder
// mode (0700) has no counterpart in a MapStorage, its key half is ported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, MapStorage, ip } from './harness.mjs';
import { encodeFrame } from '../../src/online/aries.js';
import { shelfTexts } from '../../src/online/buddy.js';
import { LIMITS } from '../../src/online/rules.js';

const PORT_LOBBY = 20922;

/** a browser of the audit's world: its client is "client <vip>" unless named */
const client = (w, vip) => w.clientIn(vip, 'client ' + vip);

const b64 = (b) => Buffer.from(b).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const f32 = Math.fround;

/** the game's race report (rank RESU), version 3: players [index, place, time] */
function resu(kind, track, players) {
  return resuFull(kind, track, players.map(([i, p, t]) => [i, p, t, 0, false]));
}

/** the same with each player's drift score and whether it dropped out: [index, place, time, score, dropped] */
function resuFull(kind, track, players) {
  const b = new Uint8Array(8 + 55 * players.length);
  const d = new DataView(b.buffer);
  b[0] = 3;
  b[1] = players.length;
  b[2] = kind;
  d.setUint16(4, track);
  b[7] = 2;
  players.forEach(([index, place, time, score, dropped], i) => {
    const o = 8 + 55 * i;
    b[o] = index;
    b[o + 1] = place;
    b[o + 2] = dropped ? 0x0c : 1;
    d.setFloat32(o + 8, time);
    d.setInt32(o + 44, score);
  });
  return b64(b);
}

/** a started race of game name between sessions (the first creates it); its AUTH */
function race(w, name, sessions, extra = []) {
  w.send(sessions[0], 'gcre', [['NAME', name], ['PARAMS', 'TRACK=4014'], ...extra]);
  for (const s of sessions.slice(1)) w.send(s, 'gjoi', [['NAME', name]]);
  w.send(sessions[0], 'gsta', [['NAME', name]]);
  const m = w.conn(sessions[0]).last('+ses');
  return m ? m.get('AUTH') : null;
}

/** the same, a race that started (Rust: race(..).unwrap()) */
function raced(w, name, sessions, extra = []) {
  const auth = race(w, name, sessions, extra);
  assert.notEqual(auth, null, "the race " + name + " started");
  return auth;
}

function report(w, c, auth, names, players, kind) {
  const f = [['AUTH', auth], ['RESU', resu(kind, 4014, players)]];
  names.forEach((n, i) => f.push(['NAME' + i, n]));
  w.send(c, 'rank', f);
}

const login = (w, vip, name) => w.login(vip, name);
const cheatsOf = (w) => w.text().filter((l) => l.startsWith('[cheat]'));
const all = (w) => w.text().join('\n');

// ONL-1: EA Messenger: a message rate, the lists and the search rated, presence only when it changed
test('onl1_messenger_rates', () => {
  const w = world();
  const [ga, gb] = [client(w, '10.77.0.2'), client(w, '10.77.0.3')];
  const la = login(w, ga, 'Flooder');
  const lb = login(w, gb, 'Friend1');
  const [ka, kb] = [w.lkey(la), w.lkey(lb)];
  const a = w.buddy(ga, ka);
  const b = w.buddy(gb, kb);
  assert.equal(w.conn(a).l('AUTH').code, '');
  // friends (a request, and the other's request back)
  w.send(b, 'RADM', [['USER', 'Flooder'], ['ID', 1]]);
  w.send(a, 'RADM', [['USER', 'Friend1'], ['ID', 1]]);
  assert.ok(w.core.buddies.list('Friend1').b.has('flooder'));
  const pgets = () => w.conn(b).msgs.filter((m) => m.kind === 'PGET' && m.f.get('USER') === 'Flooder').length;
  // ten presences that change nothing, then ten that do, in one moment: the friend hears of the first and, a
  // second later, of the last
  const p0 = pgets();
  for (let i = 0; i < 10; i++) w.send(a, 'PSET', [['SHOW', 'CHAT'], ['STAT', ''], ['PROD', 'same']]);
  const p1 = pgets();
  assert.ok(p1 - p0 <= 1, 'the same presence ten times: ' + (p1 - p0) + ' PGET to the friend');
  for (let i = 0; i < 10; i++) w.send(a, 'PSET', [['SHOW', 'CHAT'], ['STAT', ''], ['PROD', 'p' + i]]);
  assert.ok(pgets() - p1 <= 1, 'ten changes in one moment: ' + (pgets() - p1) + ' PGET at once');
  w.sleep(1200);
  const last = w.conn(b).all().reverse().find((m) => m.kind === 'PGET' && m.get('USER') === 'Flooder');
  assert.equal(last.g('PROD'), 'p9', 'the latest presence follows');
  // the lists: four at once, then "full"; a flood of messages closes the connection
  w.advance(10000);
  for (let i = 0; i < 100; i++) w.send(a, 'RGET', [['LIST', 'B'], ['ID', i]]);
  const answered = w.conn(a).msgs.filter((m) => m.kind === 'RGET' && m.code === '').length;
  assert.ok(answered <= 5, 'RGET answered with the list ' + answered + ' times out of 100');
  assert.ok(w.conn(a).reset, 'a flood of messages: the connection is closed');
  // the search: four at once, then nothing
  const l2 = login(w, gb, 'Friend2');
  const k2 = w.lkey(l2);
  const c = w.buddy(gb, k2);
  for (let i = 0; i < 10; i++) w.send(c, 'USCH', [['USER', 'flo'], ['ID', i]]);
  const found = w.conn(c).msgs.filter((m) => m.kind === 'USCH' && m.f.get('SIZE') !== '0').length;
  assert.ok(found <= 4, '10 searches: ' + found + ' done');
});

// ONL-2: the lobby: game records to the game list only, at most once a second a game; populations the same; a
// gset that changes nothing goes nowhere
test('onl2_lobby_announcements', () => {
  const w = world();
  let g = client(w, '10.77.0.2');
  const host = login(w, g, 'MalHost');
  g = client(w, '10.77.0.3');
  const mate = login(w, g, 'Mate');
  const viewers = [4, 5, 6].map((i) => login(w, client(w, '10.77.0.' + i), 'View' + i));
  const idle = [7, 8].map((i) => login(w, client(w, '10.77.0.' + i), 'Idle' + i));
  for (const v of viewers) w.send(v, 'gsea', [['START', 0], ['COUNT', 20]]);
  w.send(host, 'gcre', [['NAME', 'junk'], ['PARAMS', 'TRACK=1']]);
  w.send(mate, 'gjoi', [['NAME', 'junk']]);
  for (let i = 0; i < 30; i++) w.send(host, 'gset', [['PARAMS', 'TRACK=' + i]]);
  for (const v of viewers) {
    const n = w.conn(v).count('+agm');
    assert.ok(n <= 3, 'a viewer got ' + n + ' game records for 31 changes in one moment');
  }
  for (const v of idle) assert.equal(w.conn(v).count('+agm'), 0, 'a player not looking at the game list gets no game records');
  w.advance(1000);
  for (const v of viewers) assert.equal(w.conn(v).l('+agm').g('PARAMS'), 'TRACK=29', 'the latest record follows');
  // a gset that changes nothing: nothing to the game's players, nothing to the list
  const [m0, a0] = [w.conn(mate).count('+mgm'), w.conn(viewers[0]).count('+agm')];
  for (let i = 0; i < 10; i++) w.send(host, 'gset', [['PARAMS', 'TRACK=29']]);
  w.advance(1000);
  assert.equal(w.conn(mate).count('+mgm') - m0, 0, 'unchanged settings: no update to the players');
  assert.equal(w.conn(viewers[0]).count('+agm') - a0, 0, 'unchanged settings: no update to the list');
  // rooms entered and left over and over: the others hear of a room's population at most once a second
  const pop0 = w.conn(viewers[1]).count('+pop');
  for (let i = 0; i < 20; i++) w.send(idle[0], 'move', [['NAME', i % 2 === 1 ? 'Lounge' : 'Circuit']]);
  const n = w.conn(viewers[1]).count('+pop') - pop0;
  assert.ok(n <= 4, '20 moves: ' + n + ' population updates to another player');
});

// (ONL-2's second half at the host's level: a receiver the switch takes no more frames for loses its online stream)
test('onl2_slow_receiver_loses_its_stream', () => {
  const w = world();
  const [ga, gb] = [client(w, '10.77.0.2'), client(w, '10.77.0.3')];
  const a = login(w, ga, 'Victim0');
  const b = login(w, gb, 'Victim1');
  w.send(a, 'move', [['NAME', 'Lounge']]);
  w.send(b, 'move', [['NAME', 'Lounge']]);
  w.slow.add(ga);
  w.send(b, 'mesg', [['TEXT', 'hello room']]);
  assert.ok(!w.personas().includes('Victim0'), 'its lobby session went');
  assert.equal(w.core.info().slow, 1);
  assert.ok(!w.conn(b).reset);
});

// ONL-3: EA Messenger memory: a friend taken off is gone, only adding a friend makes a list, lists are capped, a
// second login is refused
test('onl3_messenger_memory', () => {
  const w = world({ buddy: { lists: 10, listRate: 5 } });
  const g = client(w, '10.77.0.2');
  const l = login(w, g, 'Flooder');
  const k = w.lkey(l);
  const b = w.buddy(g, k);
  for (let i = 0; i < 300; i++) {
    w.send(b, 'RADD', [['USER', 'Ghost' + i], ['LIST', 'B']]);
    w.send(b, 'RDEL', [['USER', 'Ghost' + i], ['LIST', 'B']]);
    if (i % 10 === 9) w.advance(3000);
  }
  assert.ok(!w.conn(b).reset);
  assert.equal(w.core.buddies.list('Flooder').b.size, 0, 'names of friends taken off are gone');
  // a persona that only asks and talks has no list
  const g2 = client(w, '10.77.0.3');
  const l2 = login(w, g2, 'Quiet');
  const k2 = w.lkey(l2);
  const q = w.buddy(g2, k2);
  w.send(q, 'EPGT', [['ID', 1]]);
  w.send(q, 'RGET', [['LIST', 'B']]);
  w.send(q, 'PSET', [['SHOW', 'CHAT']]);
  w.send(q, 'PING', []);
  assert.ok(!w.core.buddies.lists.has('quiet'), 'no list without a friend added');
  // a second login on a connection that is logged in
  const l3 = login(w, g2, 'Quiet2');
  const k3 = w.lkey(l3);
  w.send(q, 'AUTH', [['LKEY', k3]]);
  assert.equal(w.conn(q).l('AUTH').code, 'logn');
  // one client makes list_rate new lists an hour; the store keeps lists of them, the least recently seen going
  const made = (group) => {
    let ok = 0;
    for (let i = 0; i < 6; i++) {
      const c = w.clientIn('10.77.' + group.charCodeAt(0) + '.' + (10 + i), group);
      const cl = login(w, c, 'P' + group + i);
      const kk = w.lkey(cl);
      const cb = w.buddy(c, kk);
      w.send(cb, 'RADD', [['USER', 'Someone'], ['LIST', 'B'], ['ID', 1]]);
      if (w.conn(cb).l('RADD').code === '') ok += 1;
      // (gone: a persona online keeps its list in memory, one that left makes room)
      w.close(cb);
      w.close(cl);
    }
    return ok;
  };
  assert.ok(made('G') <= 5, 'one client: at most listRate new lists');
  made('H');
  made('I');
  assert.ok(w.core.buddies.lists.size <= 10, w.core.buddies.lists.size + ' lists in memory (the cap is 10)');
});

// ONL-4: a Messenger connection that logged in twice and closed breaks nobody's Messenger
test('onl4_double_login', () => {
  const w = world();
  const v = client(w, '10.77.0.10');
  const l = login(w, v, 'Victim1');
  const k = w.lkey(l);
  const vb = w.buddy(v, k);
  w.send(vb, 'PSET', [['SHOW', 'CHAT'], ['STAT', 'EX=0'], ['PROD', 'x']]);
  const a = client(w, '10.77.0.20');
  const l1 = login(w, a, 'Mal1');
  const l2 = login(w, a, 'Mal2');
  const [k1, k2] = [w.lkey(l1), w.lkey(l2)];
  const ab = w.buddy(a, k1);
  w.send(ab, 'AUTH', [['LKEY', k2]]);
  w.close(ab);
  w.send(vb, 'PSET', [['SHOW', 'AWAY'], ['STAT', 'EX=0'], ['PROD', 'x']]);
  assert.ok(!w.conn(vb).reset, "the victim's Messenger after the other left");
  const n = client(w, '10.77.0.11');
  const ln = login(w, n, 'Victim2');
  const kn = w.lkey(ln);
  const nb = w.buddy(n, kn);
  w.send(nb, 'PSET', [['SHOW', 'CHAT']]);
  assert.ok(!w.conn(nb).reset, "a new player's Messenger");
  const x = client(w, '10.77.0.12');
  const lx = login(w, x, 'Victim3');
  const kx = w.lkey(lx);
  const xb = w.buddy(x, kx);
  w.send(xb, 'SEND', [['USER', 'Mal1'], ['BODY', 'hi']]);
  w.send(xb, 'SEND', [['USER', 'Mal2'], ['BODY', 'hi']]);
  assert.ok(!w.conn(xb).reset, 'a message to the names that connection used');
  assert.deepEqual(w.core.errors, [], 'no handler failed');
});

// ONL-5: one browser is one player of a race; a browser keeps few open games; a race whose players left the server
// ends
test('onl5_races_and_browsers', () => {
  const w = world();
  const one = client(w, '10.77.0.2');
  const sa = login(w, one, 'MalA');
  const sb = login(w, one, 'MalB');
  w.send(sa, 'gcre', [['NAME', 'g1']]);
  w.send(sb, 'gjoi', [['NAME', 'g1']]);
  w.send(sa, 'gsta', [['NAME', 'g1']]);
  assert.equal(w.conn(sa).l('gsta').code, 'nepl', 'two players in one browser cannot start a race');
  // open games: openPerVip (2) for one browser
  const b = client(w, '10.77.0.3');
  const s1 = login(w, b, 'Open1');
  const s2 = login(w, b, 'Open2');
  const s3 = login(w, b, 'Open3');
  w.send(s1, 'gcre', [['NAME', 'o1']]);
  w.send(s2, 'gcre', [['NAME', 'o2']]);
  w.send(s3, 'gcre', [['NAME', 'o3']]);
  assert.equal(w.conn(s3).l('gcre').code, 'full', 'a third open game from one browser');
  // a race whose players' browsers left the switch ends after a while; one whose players are still here goes on
  const ps = [4, 5, 6, 7].map((i) => login(w, client(w, '10.77.0.' + i), 'Racer' + (i - 3)));
  assert.notEqual(race(w, 'left', ps.slice(0, 2)), null);
  assert.notEqual(race(w, 'stays', ps.slice(2, 4)), null);
  for (const c of ps) w.close(c);
  w.peerGone(ip('10.77.0.4'));
  w.peerGone(ip('10.77.0.5'));
  w.advance(130000);
  const names = [...w.core.lobby.games.values()].map((g) => g.name);
  assert.ok(!names.includes('left'), 'the race of browsers that left ended');
  assert.ok(names.includes('stays'), 'the race of browsers still here goes on');
});

// ONL-6, as the players chose on 2026-10-23: the blocked list follows the name like its friends, kept over a restart,
// and the block holds while its persona is away (no message waits for it, no request arrives)
test('onl6_blocked_list_follows_the_name', () => {
  const storage = new MapStorage();
  let w = world({ storage });
  const ga = client(w, '10.77.0.50');
  const la = w.loginAs(ga, 'AliceAcct', 'Alice', 'secret');
  const ka = w.lkey(la);
  const ab = w.buddy(ga, ka);
  const gm = client(w, '10.77.0.51');
  const lm = login(w, gm, 'Mallory');
  const km = w.lkey(lm);
  const mb = w.buddy(gm, km);
  // Mallory a friend (a request, answered), then blocked
  w.send(mb, 'RADM', [['USER', 'Alice'], ['ID', 1]]);
  w.send(ab, 'RRSP', [['USER', 'Mallory'], ['ANSW', 'Y'], ['ID', 1]]);
  assert.ok(w.core.buddies.list('Alice').b.has('mallory'));
  w.send(ab, 'RADD', [['LIST', 'I'], ['USER', 'Mallory'], ['ID', 1]]);
  // while Alice is online the block works
  w.send(mb, 'SEND', [['USER', 'Alice'], ['BODY', 'hi']]);
  assert.equal(w.conn(ab).count('RECV'), 0, "a blocked sender's message does not arrive");
  // and while she is away, though Mallory is on her friends list too
  w.close(ab);
  w.close(la);
  w.send(mb, 'SEND', [['USER', 'Alice'], ['BODY', 'still there?']]);
  w.send(mb, 'RADM', [['USER', 'Alice'], ['ID', 3]]);
  w.close(mb);
  w.core.buddySave();
  const stored = shelfTexts(w.core.store).join('\n');
  assert.ok(stored.includes('"I":["Mallory"]'), 'the blocked list is kept: ' + stored);
  assert.ok(!stored.includes('still there') && !stored.includes('"R"'), "nothing of Mallory's waits: " + stored);
  // over a restart: whoever plays as Alice has the list
  w.core.stop();
  w = world({ storage });
  const g2 = client(w, '10.77.0.52');
  const l2 = w.loginAs(g2, 'Other', 'Alice', 'secret');
  const k2 = w.lkey(l2);
  const b2 = w.buddy(g2, k2);
  w.send(b2, 'RGET', [['LIST', 'I'], ['PRES', 'Y'], ['PEND', 'Y'], ['ID', 2]]);
  assert.deepEqual([w.conn(b2).l('RGET').g('SIZE'), w.conn(b2).l('ROST').g('USER'), w.conn(b2).l('ROST').g('ID')], ['1', 'Mallory', '2']);
  assert.ok(w.core.buddies.blocked('mallory'), "the lobby's chat knows Mallory is blocked");
  // unblocked: gone from the file
  w.send(b2, 'RDEL', [['LIST', 'I'], ['USER', 'Mallory']]);
  assert.ok(!w.core.buddies.blocked('mallory'));
  w.core.buddySave();
  assert.ok(!shelfTexts(w.core.store).join('\n').includes('"I"'));
});

function board(w, kind) {
  return w.core.stats.board(kind, 'all').map((r) => r.name + ':' + r.points + ':' + r.wins + ':' + r.losses).sort();
}

// ONL-7: results: one report or reports that differ decide nothing; ranked needs three; a race too short is not
// taken
test('onl7_results', () => {
  const w = world();
  // (a) one player's report alone
  let g = client(w, '10.77.0.2');
  const m = login(w, g, 'Mallory');
  g = client(w, '10.77.0.3');
  const al = login(w, g, 'Alice');
  let auth = raced(w, 'a', [m, al]);
  w.advance(60000);
  report(w, m, auth, ['Mallory', 'Alice'], [[0, 1, 50.0], [1, 2, 55.0]], 0);
  assert.deepEqual(board(w, 0), [], 'one report decides nothing');
  // (b) two reports that differ: neither counts
  g = client(w, '10.77.0.4');
  const bob = login(w, g, 'Bob');
  g = client(w, '10.77.0.5');
  const carol = login(w, g, 'Carol');
  auth = raced(w, 'b', [bob, carol]);
  w.advance(60000);
  report(w, carol, auth, ['Bob', 'Carol'], [[1, 1, 50.0], [0, 2, 51.0]], 0);
  report(w, bob, auth, ['Bob', 'Carol'], [[0, 1, 50.0], [1, 2, 51.0]], 0);
  assert.deepEqual(board(w, 0), [], 'reports that differ decide nothing');
  // (c) a ranked race of two: counted, no points
  g = client(w, '10.77.0.6');
  const x = login(w, g, 'Xeno');
  g = client(w, '10.77.0.7');
  const y = login(w, g, 'Yuri');
  auth = raced(w, 'c', [x, y], [['SYSFLAGS', 1 << 18]]);
  w.advance(60000);
  for (const c of [x, y]) report(w, c, auth, ['Xeno', 'Yuri'], [[0, 1, 50.0], [1, 2, 51.0]], 0);
  assert.deepEqual(board(w, 0), ['Xeno:0:1:0', 'Yuri:0:0:1'], 'a ranked race of two players gives no points');
  // (d) too short for its type, though both agree
  g = client(w, '10.77.0.8');
  const p = login(w, g, 'Quick1');
  g = client(w, '10.77.0.9');
  const q = login(w, g, 'Quick2');
  auth = raced(w, 'd', [p, q]);
  w.advance(3000);
  for (const c of [p, q]) report(w, c, auth, ['Quick1', 'Quick2'], [[0, 1, 1.5], [1, 2, 2.0]], 0);
  assert.ok(!board(w, 0).some((r) => r.startsWith('Quick')), 'a 3-second circuit race is not taken');
});

// a race won in under 40 % of the next finisher's time is a [cheat] line with the winner's address, once (the report
// that makes the result); a close race, and a drift race (won by points), are none
test('a_race_won_far_ahead_is_a_cheat_line', () => {
  const w = world();
  const raceOf = (name, a, b, players, kind) => {
    const [ga, gb] = [client(w, '10.77.1.' + name.length), client(w, '10.77.2.' + name.length)];
    const [x, y] = [login(w, ga, a), login(w, gb, b)];
    const auth = raced(w, name, [x, y]);
    assert.notEqual(auth, null);
    w.advance(61000);
    for (const c of [x, y]) report(w, c, auth, [a, b], players, kind);
  };
  raceOf('close', 'Fast1', 'Slow1', [[0, 1, 40.0], [1, 2, 55.0]], 1);
  raceOf('drifty', 'Fast2', 'Slow2', [[0, 1, 21.0], [1, 2, 64.0]], 3);
  assert.deepEqual(cheatsOf(w), []);
  raceOf('far', 'Warp', 'Honest', [[1, 2, 64.0], [0, 1, 21.0]], 1);
  assert.deepEqual(cheatsOf(w), [
    '[cheat] 10.77.1.3 "Warp": won the online race "far" (sprint) in 0:21.00, under 40 % of the next finisher\'s ' +
      '1:04.00 ("Honest")',
  ]);
});

/** the game's race report with each player's average speed: [index, place, time, average m/s, dropped or still on
 *  the way when the race ended: flags 0x0b] */
function resuAvg(kind, players) {
  const b = new Uint8Array(8 + 55 * players.length);
  const d = new DataView(b.buffer);
  b[0] = 3;
  b[1] = players.length;
  b[2] = kind;
  d.setUint16(4, 4102);
  b[7] = 1;
  players.forEach(([index, place, time, avg, out], i) => {
    const o = 8 + 55 * i;
    b[o] = index;
    b[o + 1] = place;
    b[o + 2] = out ? 0x0b : 1;
    d.setFloat32(o + 8, time);
    d.setFloat32(o + 16, avg);
    d.setFloat32(o + 20, f32(f32(avg) * 1.25));
    if (out) d.setFloat32(o + 32, -1.0);
  });
  return b64(b);
}

// what a racer's own game measured that no racer does is a [cheat] line, the report taken or not: a race the game
// ended at once, a teleport to the finish at 25 s (212 m/s on average); an honest sprint is none
test('a_race_no_racer_drives_is_a_cheat_line', () => {
  const w = world();
  const raceOf = (name, a, b, players) => {
    const [ga, gb] = [client(w, '10.77.3.' + name.length), client(w, '10.77.4.' + name.length)];
    const [x, y] = [login(w, ga, a), login(w, gb, b)];
    const auth = raced(w, name, [x, y]);
    assert.notEqual(auth, null);
    w.advance(61000);
    for (const c of [x, y]) w.send(c, 'rank', [['AUTH', auth], ['RESU', resuAvg(1, players)], ['NAME0', a], ['NAME1', b]]);
  };
  raceOf('honest', 'Fast1', 'Slow1', [[0, 1, 56.49, 29.83, false], [1, 2, 58.15, 29.64, false]]);
  assert.deepEqual(cheatsOf(w), []);
  raceOf('warp', 'Honest', 'Warp', [[1, 1, 4.77, 13.58, false], [0, 2, 34.76, 29.36, true]]);
  assert.deepEqual(cheatsOf(w), [
    '[cheat] 10.77.4.4 "Warp": won the online race "warp" (sprint, track 4102, 1 lap) in 0:04.77, under the 20 s a ' +
      'sprint race takes at least, having driven 65 m, under half the 1021 m "Honest" drove: each by its own game; ' +
      'its top speed 61 km/h',
  ]);
  raceOf('tele', 'Honest2', 'Tele', [[1, 1, 25.0, 212.0, false], [0, 2, 55.0, 29.0, true]]);
  let l = cheatsOf(w);
  assert.deepEqual(l.slice(1), [
    '[cheat] 10.77.4.4 "Tele": won the online race "tele" (sprint, track 4102, 1 lap) in 0:25.00, 763 km/h on ' +
      'average, which no car does, an edited car (no car of the game makes 420 km/h): by its own game; its top speed ' +
      '954 km/h',
  ]);
  // an edited car is a line whether it finished or not (its top speed: 96 m/s on average, 432 km/h at the most)
  raceOf('planes', 'Honest3', 'Plane', [[0, 1, 56.49, 29.83, false], [1, 0, 10.0, 96.0, true]]);
  l = cheatsOf(w);
  assert.deepEqual(l.slice(2), [
    '[cheat] 10.77.4.6 "Plane": raced in the online race "planes" (sprint, track 4102, 1 lap), an edited car (no ' +
      'car of the game makes 420 km/h): by its own game; its top speed 432 km/h',
  ]);
  // a racer whose game went on alone long after the race ended says nothing of the winner's way
  raceOf('split', 'Funny', 'Gone', [[0, 1, 174.09, 55.97, false], [1, 0, 720.0, 27.28, true]]);
  assert.equal(cheatsOf(w).length, 3, JSON.stringify(cheatsOf(w)));
});

/** a race report with each player's average and top speed: [index, place, time, average m/s, top m/s, dropped] */
function resuTop(kind, players) {
  const b = fromB64(resuAvg(kind, players.map((p) => [p[0], p[1], p[2], p[3], p[5]])));
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  players.forEach((p, i) => d.setFloat32(8 + 55 * i + 20, p[4]));
  return b64(b);
}

// a racer's own time, average and way count once another racer's game saw it finish at that time, and nobody finished
// close to it; a cheat's own figures are the others' too
test('a_racers_own_figures_count_once_another_game_saw_them', () => {
  const w = world();
  const raceOf = (name, a, b, kind, ra, rb) => {
    const k = a.charCodeAt(a.length - 1) - 48;
    const [ga, gb] = [client(w, '10.77.10.' + k), client(w, '10.77.11.' + k)];
    const [x, y] = [login(w, ga, a), login(w, gb, b)];
    const auth = raced(w, name, [x, y]);
    assert.notEqual(auth, null);
    // (a game that says nothing for 120 s is dropped: each pings once on the way)
    w.advance(100000);
    for (const c of [x, y]) w.send(c, '~png', [['TIME', 1]]);
    w.advance(80000);
    for (const [c, rows] of [[x, ra], [y, rb]]) {
      if (!rows) continue;
      w.send(c, 'rank', [['AUTH', auth], ['RESU', resuTop(kind, rows)], ['NAME0', a], ['NAME1', b]]);
    }
  };
  // its own game 7 s short (0:17.35 at 99 m/s, 357 km/h; top 89 m/s), the other's 0:24.14
  raceOf('short', 'Drag1', 'Other1', 2,
    [[0, 1, 17.35, 99.2, 89.2, false], [1, 2, 31.3, 60.0, 80.0, false]],
    [[0, 1, 24.14, 70.0, 89.2, false], [1, 2, 31.3, 60.0, 80.0, false]]);
  // its own report alone (500 km/h on average)
  raceOf('alone', 'Drag2', 'Other2', 2, [[0, 1, 14.09, 138.9, 96.7, false], [1, 2, 20.0, 60.0, 80.0, false]], null);
  // a close race (388 km/h on average, top 51 m/s), both games agree
  const close = [[0, 1, 81.11, 107.8, 50.8, false], [1, 2, 81.3, 30.0, 50.0, false]];
  raceOf('close', 'Circ1', 'Other3', 0, close, close);
  // its own game counted one lap of two: 3087 m in 1:22.13, the other 6418 m; the other's game saw it at 2:35.34
  raceOf('lap', 'Circ2', 'Other4', 0,
    [[0, 1, 82.13, 37.59, 48.6, false], [1, 2, 174.95, 36.68, 50.0, false]],
    [[0, 1, 155.34, 41.3, 48.6, false], [1, 2, 174.95, 36.68, 50.0, false]]);
  assert.deepEqual(cheatsOf(w), []);
  // a circuit won in 0:30.08 at 383 km/h on average (top 113 m/s), the other game saw it too and gave up
  const fast = [[0, 1, 30.08, 106.4, 113.0, false], [1, 0, 40.0, 30.0, 50.0, true]];
  raceOf('warp', 'Circ3', 'Other5', 0, fast, fast);
  assert.deepEqual(cheatsOf(w), [
    '[cheat] 10.77.10.3 "Circ3": won the online race "warp" (circuit, track 4102, 1 lap) in 0:30.08, 383 km/h on ' +
      'average, which no car does: by its own game; its top speed 407 km/h',
  ]);
});

// a racer whose game says its car's data is edited (the rank's code "ed" and the car type) is a [cheat] line however
// it did, finished or not; the game's own code (0) and other codes are none
test('a_car_of_edited_game_data_is_a_cheat_line', () => {
  const w = world();
  const raceOf = (name, a, b, codes, players) => {
    const [ga, gb] = [client(w, '10.77.5.' + name.length), client(w, '10.77.6.' + name.length)];
    const [x, y] = [login(w, ga, a), login(w, gb, b)];
    const auth = raced(w, name, [x, y]);
    assert.notEqual(auth, null);
    w.advance(61000);
    [x, y].forEach((c, i) => {
      const f = [['AUTH', auth], ['RESU', resuAvg(1, players)], ['NAME0', a], ['NAME1', b]];
      w.sendRaw(c, encodeFrame('rank', codes[i], f));
    });
  };
  const honest = [[0, 1, 56.49, 29.83, false], [1, 2, 58.15, 29.64, false]];
  raceOf('plain', 'Fast1', 'Slow1', ['', 'filt'], honest);
  raceOf('odd', 'Fast2', 'Slow2', ['edz9', 'ed1'], honest);
  assert.deepEqual(cheatsOf(w), []);
  raceOf('supra', 'Tuner', 'Slow3', ['ed0f', ''], honest);
  assert.deepEqual(cheatsOf(w), [
    '[cheat] 10.77.5.5 "Tuner": won the online race "supra" (sprint, track 4102, 1 lap) in 0:56.49, an edited car ' +
      '(SUPRA, type 15: its game has the car\'s data edited, GlobalB): by its own game; its top speed 134 km/h',
  ]);
  // not finished, and a car its game could not tell
  raceOf('gone', 'Slow4', 'Quit', ['', 'edff'], [[0, 1, 56.49, 29.83, false], [1, 0, 30.0, 25.0, true]]);
  assert.deepEqual(cheatsOf(w).slice(1), [
    '[cheat] 10.77.6.4 "Quit": raced in the online race "gone" (sprint, track 4102, 1 lap), an edited car (type ' +
      'unknown: its game has the car\'s data edited, GlobalB): by its own game; its top speed 112 km/h',
  ]);
});

// a racer whose car jumped at once by the other racers' games (the rank's code "j", its slot and the jump in 4 m
// steps): a line once two other games said so, or the only other one of a race of two; one of two others, a jump
// honest races make, or a game naming its own racer: none
test('a_car_that_jumped_is_a_cheat_line', () => {
  const w = world();
  const raceOf = (name, who, codes) => {
    const cs = who.map((_, i) => client(w, '10.77.' + (8 + i) + '.' + name.length));
    const xs = cs.map((c, i) => login(w, c, who[i]));
    const auth = raced(w, name, xs);
    assert.notEqual(auth, null);
    w.advance(61000);
    const rows = who.map((_, i) => [i, i + 1, f32(f32(56.49) + 2.0 * i), 29.8, false]);
    xs.forEach((c, j) => {
      if (j >= codes.length) return;
      const f = [['AUTH', auth], ['RESU', resuAvg(1, rows)]];
      who.forEach((n, i) => f.push(['NAME' + i, n]));
      w.sendRaw(c, encodeFrame('rank', codes[j], f));
    });
  };
  // (0x46 steps: 280 m; 0x0a: 40 m)
  raceOf('self', ['Jumper1', 'Slow1'], ['j046', '']);
  raceOf('small', ['Jumper2', 'Slow2'], ['', 'j00a']);
  raceOf('one', ['Jumper3', 'Slow3', 'Mid3'], ['', 'j046', '']);
  raceOf('bad', ['Jumper4', 'Slow4'], ['', 'jz46']);
  assert.deepEqual(cheatsOf(w), []);
  raceOf('two', ['Jumper5', 'Slow5'], ['', 'j046']);
  raceOf('three', ['Jumper6', 'Slow6', 'Mid6'], ['', 'j046', 'j044']);
  assert.deepEqual(cheatsOf(w), [
    '[cheat] 10.77.8.3 "Jumper5": its car jumped 280 m at once in the online race "two" (sprint, track 4102, 1 ' +
      'lap), as 1 other players\' games had it (the largest each: 280 m; honest races\' largest are under 50 m); it won',
    '[cheat] 10.77.8.5 "Jumper6": its car jumped 280 m at once in the online race "three" (sprint, track 4102, 1 ' +
      'lap), as 2 other players\' games had it (the largest each: 280, 272 m; honest races\' largest are under 50 m); it ' +
      'won',
  ]);
});

/** a drift race's report: [index, place, time, points, the biggest single drift's points, top speed m/s, dropped] */
function resuDrift(players) {
  const b = new Uint8Array(8 + 55 * players.length);
  const d = new DataView(b.buffer);
  b[0] = 3;
  b[1] = players.length;
  b[2] = 3;
  d.setUint16(4, 4311);
  b[7] = 3;
  players.forEach(([index, place, time, score, best, top, out], i) => {
    const o = 8 + 55 * i;
    b[o] = index;
    b[o + 1] = place;
    b[o + 2] = out ? 0x0b : 1;
    d.setFloat32(o + 8, time);
    d.setFloat32(o + 16, f32(f32(top) * f32(0.6)));
    d.setFloat32(o + 20, top);
    d.setInt32(o + 44, score);
    d.setInt32(o + 48, best);
    if (out) d.setFloat32(o + 32, -1.0);
  });
  return b64(b);
}

// a drift race: each racer's own game's points and biggest drift on a line of its own, the result by points with the
// track; a top speed no car makes is an edited car's, as in other races
test('a_drift_races_points_are_logged_and_an_edited_car_is_a_cheat_line', () => {
  const w = world();
  const [ga, gb] = [client(w, '10.77.7.1'), client(w, '10.77.7.2')];
  const [x, y] = [login(w, ga, 'Slider'), login(w, gb, 'Rocket')];
  const auth = raced(w, 'dh', [x, y]);
  assert.notEqual(auth, null);
  w.advance(100000);
  // (Rocket first with 1.2 million points and 125 m/s: 450 km/h)
  const rows = [[1, 1, 70.0, 1200000, 1150000, 125.0, false], [0, 2, 80.5, 310400, 42000, 61.0, false]];
  for (const c of [x, y]) w.send(c, 'rank', [['AUTH', auth], ['RESU', resuDrift(rows)], ['NAME0', 'Slider'], ['NAME1', 'Rocket']]);
  const t = w.text();
  const has = (want) => t.includes(want);
  assert.ok(has('[online] "dh" (drift, track 4311, 3 laps): Slider\'s own game: 2 of 2, 310400 points, its biggest drift 42000, top speed 220 km/h, 1:20.50'), t.join('\n'));
  assert.ok(has('[online] "dh" (drift, track 4311, 3 laps): Rocket\'s own game: 1 of 2, 1200000 points, its biggest drift 1150000, top speed 450 km/h, 1:10.00'), t.join('\n'));
  assert.ok(has('[online] "dh" (drift, unranked, track 4311, 3 laps): 1 Rocket 1200000 points, 2 Slider 310400 points'), t.join('\n'));
  assert.deepEqual(t.filter((l) => l.startsWith('[cheat]')), [
    '[cheat] 10.77.7.2 "Rocket": won the online race "dh" (drift, track 4311, 3 laps) with 1200000 points, an edited car ' +
      '(no car of the game makes 420 km/h): by its own game; its top speed 450 km/h',
  ]);
});

// what a game shows of another racer is no [cheat] line: only each racer's own game's figures count
test('what_a_game_shows_of_the_others_is_no_cheat_line', () => {
  const w = world();
  const [ga, gb, gc] = [client(w, '10.77.6.1'), client(w, '10.77.6.2'), client(w, '10.77.6.3')];
  const [x, y, z] = [login(w, ga, 'Ann'), login(w, gb, 'Bob'), login(w, gc, 'Left')];
  const auth = raced(w, 'seen', [x, y, z]);
  assert.notEqual(auth, null);
  // (a game that says nothing for 120 s is dropped: each pings on the way)
  for (let i = 0; i < 3; i++) {
    w.advance(80000);
    for (const c of [x, y, z]) w.send(c, '~png', [['TIME', 1]]);
  }
  const send = (c, rows) => {
    w.send(c, 'rank', [['AUTH', auth], ['RESU', resuAvg(1, rows)], ['NAME0', 'Ann'], ['NAME1', 'Bob'], ['NAME2', 'Left']]);
  };
  send(x, [[1, 1, 223.37, 2071.4, false], [0, 2, 225.18, 36.98, false], [2, 3, 57.34, 1600.0, true]]);
  send(y, [[1, 1, 223.37, 37.5, false], [0, 2, 225.18, 37.1, false], [2, 3, 57.34, 30.0, true]]);
  send(z, [[1, 1, 223.37, 37.5, false], [0, 2, 225.18, 37.1, false], [2, 3, 57.34, 30.0, true]]);
  assert.ok(w.logged('"seen" (sprint, unranked): 1 Bob 3:43.37, 2 Ann 3:45.18'), all(w));
  assert.ok(!w.text().some((l) => l.startsWith('[cheat]')), all(w));
});

// a report of the wrong shape is no [cheat] line: one that names a racer twice is not taken and says nothing of that
// racer
test('a_report_naming_a_racer_twice_is_no_cheat_line', () => {
  const w = world();
  const [ga, gb] = [client(w, '10.77.5.1'), client(w, '10.77.5.2')];
  const [x, y] = [login(w, ga, 'Host'), login(w, gb, 'Other')];
  const auth = raced(w, 'twice', [x, y]);
  assert.notEqual(auth, null);
  w.advance(61000);
  const r = resuAvg(1, [[0, 2, 0.25, 30.0, false], [0, 2, 0.23, 30.0, false]]);
  w.send(y, 'rank', [['AUTH', auth], ['RESU', r], ['NAME0', 'Host'], ['NAME1', 'Other']]);
  assert.ok(w.logged('"twice": Other\'s race report not taken: players named twice'), all(w));
  assert.ok(!w.text().some((l) => l.startsWith('[cheat]')), all(w));
});

// a report that leaves out a player of the game is taken: the others' games leave out one who joined as the race
// started and never raced
test('a_report_without_a_player_who_never_raced_is_taken', () => {
  const w = world();
  const [ga, gb, gc] = [client(w, '10.77.8.1'), client(w, '10.77.8.2'), client(w, '10.77.8.3')];
  const [x, y, z] = [login(w, ga, 'Ran1'), login(w, gb, 'Ran2'), login(w, gc, 'Late')];
  const auth = raced(w, 'late', [x, y, z]);
  assert.notEqual(auth, null);
  w.advance(120000);
  for (const c of [x, y]) report(w, c, auth, ['Ran1', 'Ran2'], [[0, 1, 100.5], [1, 2, 102.25]], 1);
  assert.ok(w.text().some((l) => l.endsWith('"late" (sprint, unranked): 1 Ran1 1:40.50, 2 Ran2 1:42.25')), all(w));
  // (one that names a racer not of the game is not)
  report(w, z, auth, ['Ran1', 'Nobody'], [[0, 1, 100.5], [1, 2, 102.25]], 1);
  assert.ok(w.logged('"late": Late\'s race report not taken: not the game\'s players'), all(w));
});

// a win far quicker than the track's best racers: once the track had 10 clean races, one under 70 % of the third
// quickest other racer's time (any finisher's, not the winners' alone) is a [cheat] line
test('a_win_far_under_the_tracks_third_quickest_is_a_cheat_line', () => {
  const w = world();
  const raceOf = (k, a, t, next) => {
    const [ga, gb] = [client(w, '10.77.9.' + (2 * k + 1)), client(w, '10.77.9.' + (2 * k + 2))];
    const b = 'Other' + k;
    const [x, y] = [login(w, ga, a), login(w, gb, b)];
    const auth = raced(w, 'q' + k, [x, y]);
    assert.notEqual(auth, null);
    w.advance(120000);
    for (const c of [x, y]) report(w, c, auth, [a, b], [[0, 1, t], [1, 2, next]], 1);
  };
  for (let k = 0; k < 10; k++) raceOf(k, 'Fair' + k, 100.0 + k, 105.0 + k);
  raceOf(10, 'Fast', 72.0, 100.0);
  assert.deepEqual(cheatsOf(w), [], '72 s: over 70 % of 102 s');
  // two cars far quicker than the track's best winners, close together: that time can be driven, and it is a clean win
  raceOf(11, 'Pair', 60.0, 62.0);
  assert.deepEqual(cheatsOf(w), [], 'the next finisher close behind');
  // as quick as the track's quick racers, the winners' and the others'
  raceOf(12, 'Peer', 58.0, 100.0);
  assert.deepEqual(cheatsOf(w), [], '58 s: over 70 % of 72 s (Pair 60, Other11 62, Fast 72)');
  raceOf(13, 'Rocket', 40.0, 100.0);
  assert.deepEqual(cheatsOf(w), [
    '[cheat] 10.77.9.27 "Rocket": won the online race "q13" (sprint, track 4014, 2 laps) in 0:40.00, under 70 % of the ' +
      "third quickest other racer's time of the track's 13 clean races (1:02.00): as the result stands",
  ]);
});

// results: race types by the game's numbers (drag 2, drift 3); its seventh (6) is a result that counts nowhere
test('race_types', () => {
  const w = world();
  const boards = () => [0, 1, 2, 3, 4, 5].map((t) => w.core.stats.board(t, 'all').length);
  // a quarter-mile drag: times well under the other types' 20 s
  let g = client(w, '10.77.0.2');
  const a = login(w, g, 'Drag1');
  g = client(w, '10.77.0.3');
  const b = login(w, g, 'Drag2');
  let auth = raced(w, 'drag', [a, b]);
  w.advance(40000);
  for (const c of [a, b]) report(w, c, auth, ['Drag1', 'Drag2'], [[0, 1, 11.2], [1, 2, 12.5]], 2);
  assert.ok(w.text().some((l) => l.endsWith('"drag" (drag, unranked): 1 Drag1 0:11.20, 2 Drag2 0:12.50')), all(w));
  // drift: places by points, not by time
  g = client(w, '10.77.0.4');
  const c = login(w, g, 'Drift1');
  g = client(w, '10.77.0.5');
  const d = login(w, g, 'Drift2');
  auth = raced(w, 'drift', [c, d]);
  w.advance(110000);
  for (const x of [c, d]) report(w, x, auth, ['Drift1', 'Drift2'], [[0, 1, 104.0], [1, 2, 92.0]], 3);
  assert.ok(w.logged('"drift" (drift, unranked, track 4014, 2 laps): 1 Drift1 0 points, 2 Drift2 0 points'), all(w));
  assert.deepEqual(boards(), [0, 0, 2, 2, 0, 0]);
  // the seventh: the result is taken and logged; no board or career counts it
  g = client(w, '10.77.0.6');
  const e = login(w, g, 'Seven1');
  g = client(w, '10.77.0.7');
  const f = login(w, g, 'Seven2');
  auth = raced(w, 'seven', [e, f]);
  w.advance(110000);
  for (const x of [e, f]) report(w, x, auth, ['Seven1', 'Seven2'], [[0, 1, 100.0], [1, 2, 104.0]], 6);
  assert.ok(w.text().some((l) => l.includes('"seven" (type 6, unranked): 1 Seven1') && l.endsWith('(no stats for this race type)')), all(w));
  assert.ok(!w.logged('not taken'), all(w));
  assert.deepEqual(boards(), [0, 0, 2, 2, 0, 0]);
  assert.equal(w.core.lobby.games.size, 0, 'every race is over');
});

const row = (m, i) => m.g('OPPO' + i) + ' ' + m.g('DATA' + i);

// a ranked race's table on its players' results screens: whose reports came ($rup) until the result stands, then
// places, times or drift scores and points in hex ($rfn) to every reporter, and to a later one; unranked: none; the
// careers of the players who reported before it stood are sent again, with the race's points
test('ranked_table', () => {
  const w = world();
  const ranked = [['SYSFLAGS', 1 << 18]];
  const names = ['Ann', 'Bob', 'Cat'];
  const gs = [0, 1, 2].map((i) => client(w, '10.77.0.' + (i + 2)));
  // logged in (again: after a race the game's results screen logs in and reports)
  const loginAll = () => [0, 1, 2].map((i) => login(w, gs[i], names[i]));
  const rep = (c, auth, kind, players) => {
    w.send(c, 'rank', [['AUTH', auth], ['RESU', resuFull(kind, 4014, players)], ['NAME0', 'Ann'], ['NAME1', 'Bob'], ['NAME2', 'Cat']]);
  };
  // a circuit: Bob first in 186.5 s, Ann second in 190.25 s, Cat dropped out after 60 s
  let s = loginAll();
  let auth = raced(w, 'c', s, ranked);
  w.advance(200000);
  s = loginAll();
  const circuit = [[0, 2, 190.25, 0, false], [1, 1, 186.5, 0, false], [2, 3, 60.0, 0, true]];
  rep(s[1], auth, 0, circuit);
  const up = w.conn(s[1]).l('$rup');
  const stat = [0, 1, 2].map((i) => up.g('OPPO' + i) + ' ' + up.g('STAT' + i));
  assert.deepEqual(stat, ['Ann 0', 'Bob 1', 'Cat 0']);
  assert.equal(up.g('TIME'), '60000');
  assert.equal(w.conn(s[1]).count('$rfn'), 0, 'one report decides nothing');
  rep(s[0], auth, 0, circuit);
  for (const c of [s[0], s[1]]) {
    const t = w.conn(c).l('$rfn');
    assert.deepEqual([0, 1, 2].map((i) => row(t, i)), ['Ann 2e72a,2,0,0,32', 'Bob 2d884,1,0,0,64', 'Cat ea60,-2,0,0,0']);
  }
  assert.equal(w.conn(s[0]).count('$rup'), 0, "the result stood with Ann's report");
  assert.deepEqual(board(w, 0), ['Ann:50:0:1', 'Bob:100:1:0', 'Cat:0:0:1'], "the table's points are the rankings'");
  // and the careers': Bob's report came before the result stood, and his game is told his 100 points too (STAT's
  // circuit rating, its 9th number)
  const rating = (c) => w.conn(c).l('user').g('STAT').split(',')[8];
  assert.deepEqual([rating(s[1]), rating(s[0])], ['64', '32']);
  // a later report: the table to it alone
  rep(s[2], auth, 0, circuit);
  assert.equal(row(w.conn(s[2]).l('$rfn'), 2), 'Cat ea60,-2,0,0,0');
  assert.deepEqual([w.conn(s[0]).count('$rfn'), w.conn(s[1]).count('$rfn')], [1, 1]);
  // drift: the score in place of the time
  auth = raced(w, 'd', s, ranked);
  w.advance(200000);
  s = loginAll();
  const drift = [[0, 1, 150.0, 41250, false], [1, 3, 150.0, 9800, false], [2, 2, 150.0, 22001, false]];
  for (const c of [s[2], s[0]]) rep(c, auth, 3, drift);
  const t = w.conn(s[0]).l('$rfn');
  assert.deepEqual([0, 1, 2].map((i) => row(t, i)), ['Ann a122,1,0,0,64', 'Bob 2648,3,0,0,0', 'Cat 55f1,2,0,0,32']);
  // unranked: the game's own results screen, no table
  auth = raced(w, 'u', s);
  w.advance(200000);
  s = loginAll();
  for (const c of s) rep(c, auth, 0, circuit);
  assert.ok(w.logged('"u" (circuit, unranked)'), all(w));
  assert.equal(s.reduce((n, c) => n + w.conn(c).count('$rup') + w.conn(c).count('$rfn'), 0), 0);
});

// results: only players who finished decide them.  Two who left report first; the finishers' result stands, and the
// leavers see its table.  A race that only leavers reported counts nowhere.
test('leavers_decide_nothing', () => {
  const w = world();
  const names = ['Ann', 'Bob', 'Cat', 'Dan'];
  const gs = [0, 1, 2, 3].map((i) => client(w, '10.77.0.' + (i + 2)));
  const loginAll = () => [0, 1, 2, 3].map((i) => login(w, gs[i], names[i]));
  const rep = (c, auth, players) => {
    const f = [['AUTH', auth], ['RESU', resuFull(0, 4014, players)]];
    names.forEach((n, i) => f.push(['NAME' + i, n]));
    w.send(c, 'rank', f);
  };
  const gone = [[0, 1, 60.0, 0, true], [1, 2, 60.0, 0, true], [2, 3, 60.0, 0, true], [3, 4, 60.0, 0, true]];
  let s = loginAll();
  let auth = raced(w, 'c', s, [['SYSFLAGS', 1 << 18]]);
  w.advance(200000);
  s = loginAll();
  for (const c of [s[2], s[3]]) rep(c, auth, gone);
  assert.deepEqual(board(w, 0), [], 'two players who left decide nothing');
  assert.ok(w.logged('"c": Dan did not finish: the report decides nothing (DNF Ann, DNF Bob, DNF Cat, DNF Dan)'), all(w));
  // the finishers: Bob first, Ann second
  const real = [[0, 2, 190.0, 0, false], [1, 1, 186.0, 0, false], [2, 3, 60.0, 0, true], [3, 4, 70.0, 0, true]];
  for (const c of [s[1], s[0]]) rep(c, auth, real);
  assert.ok(w.logged('"c" (circuit, ranked): 1 Bob 3:06.00, 2 Ann 3:10.00, DNF Cat, DNF Dan'), all(w));
  assert.deepEqual(board(w, 0), ['Ann:67:0:1', 'Bob:100:1:0', 'Cat:0:0:1', 'Dan:0:0:1']);
  assert.deepEqual([s[2], s[3]].map((c) => w.conn(c).count('$rfn')), [1, 1], 'the leavers see the table');
  // a race only leavers reported
  auth = raced(w, 'd', s);
  w.advance(200000);
  s = loginAll();
  for (const c of [s[0], s[1]]) rep(c, auth, gone);
  assert.ok(!w.logged('"d" (circuit'), all(w));
  assert.deepEqual(board(w, 0), ['Ann:67:0:1', 'Bob:100:1:0', 'Cat:0:0:1', 'Dan:0:0:1'], 'counted nowhere');
});

/** The three games' reports of a test race (online-pair, 2026-11-02): a ranked circuit of OLHOST, OLJOIN3 and OLJOIN
 *  (NAME0..2).  OLJOIN3 finished first (0:29.9); the others were still on the way when the race ended 30 s later. */
const OUT_OF_TIME = [
  ['OLJOIN3', 'AwMAAQ+rAAIAAgsEP4m32UJwK4ZCXtcLQejLTkITDAhBCj1xAAAAAL+AAAAAAAAAAAAAAAAAAAAAAAAAAAACAAYBAQEEPvgFa0HvSsEAAAAAQcasJUITKMZBBwo+QXx64kIntncAAAAAAAAAAAAAAAAAAAAAAAAAAgMLBD+DJh9CbyuGQmrhSEHfmzxCEkAiQQ/XCwAAAAC/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='],
  ['OLJOIN', 'AwMAAg+rAAIAAgsEP4o5X0JwpyxCXhR8QelCK0IS5VdBDXCkAAAAAL+AAAAAAAAAAAAAAAAAAAAAAAAAAAACAAgBAQEEPvkMtEHxo9gAAAAAQdrPN0IUPcZBC9cLQXThSEIdnkUAAAAAAAAAAAAAAAAAAAAAAAgAAAECAwsEP4PSeEJvsKVCaczOQdaGTkITRdFBDwo+AAAAAL+AAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
  ['OLHOST', 'AwMAAA+rAAIAAgsEP4nvTkJvsGNCXpmaQd+VMkITPLlBBZmaAAAAAL+AAAAAAAAAAAAAAAAAAAAAAAAAAAACAAYBAQEEPvk9okHxOdwAAAAAQeytxEIUhHZBCj1xQX199UIalBoAAAAAAAAAAAAAAAAAAAAAAAoAAAEAAQIDCwQ/g5CJQm70vUJpCj5B53kdQhOipUEVHrkAAAAAv4AAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
];

// a race that one racer finished and the others ran out of time in counts: the reports of the racers put out on the
// road decide it with the finisher's.  The racers out of time did not finish, and did not leave: no disconnect in
// their careers
test('racers_out_of_time_decide_with_the_finisher', () => {
  const w = world();
  const names = ['OLHOST', 'OLJOIN3', 'OLJOIN'];
  const gs = [0, 1, 2].map((i) => client(w, '10.77.0.' + (i + 2)));
  let s = [0, 1, 2].map((i) => login(w, gs[i], names[i]));
  const auth = raced(w, 'o', s, [['SYSFLAGS', 1 << 18]]);
  assert.notEqual(auth, null);
  w.advance(125000);
  s = [0, 1, 2].map((i) => login(w, gs[i], names[i]));
  const session = (who) => s[names.indexOf(who)];
  const rep = ([who, r]) => {
    const f = [['AUTH', auth], ['RESU', r]];
    names.forEach((n, i) => f.push(['NAME' + i, n]));
    w.send(session(who), 'rank', f);
  };
  rep(OUT_OF_TIME[0]);
  assert.deepEqual(board(w, 0), [], "the finisher's report alone decides nothing");
  rep(OUT_OF_TIME[1]);
  assert.ok(w.logged('"o" (circuit, ranked): 1 OLJOIN3 0:30.21, DNF OLHOST (out of time), DNF OLJOIN (out of time)'), all(w));
  assert.deepEqual(board(w, 0), ['OLHOST:0:0:1', 'OLJOIN3:100:1:0', 'OLJOIN:0:0:1']);
  assert.deepEqual([s[1], s[2]].map((c) => w.conn(c).count('$rfn')), [1, 1], 'Official Race Results on both screens');
  rep(OUT_OF_TIME[2]);
  assert.ok(!w.logged('decides nothing') && !w.logged('differs'), all(w));
  assert.equal(w.conn(s[0]).count('$rfn'), 1);
  // no disconnect for a racer who ran out of time (STAT [1]); one for a racer who left
  const disconnects = (who) => {
    w.send(s[0], 'user', [['PERS', who]]);
    return w.conn(s[0]).l('user').g('STAT').split(',')[1];
  };
  assert.equal(disconnects('OLJOIN'), '0');
  assert.equal(w.core.lobby.games.size, 0, 'every racer reported: the race is over');
});

// two finishers' games may tell a racer who did not finish differently.  Only the finishers' places are compared, and
// the result has every racer either report named
test('the_others_places_do_not_decide', () => {
  const w = world();
  const names = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve'];
  const gs = [0, 1, 2, 3, 4].map((i) => client(w, '10.77.0.' + (i + 2)));
  const loginAll = () => [0, 1, 2, 3, 4].map((i) => login(w, gs[i], names[i]));
  const rep = (c, auth, ns, players) => {
    const f = [['AUTH', auth], ['RESU', resuFull(0, 4014, players)]];
    ns.forEach((n, i) => f.push(['NAME' + i, n]));
    w.send(c, 'rank', f);
  };
  // Ann, Bob and Cat, ranked: Cat leaves; Ann's game counts it as gone, Bob's leaves it out
  let s = loginAll();
  let auth = raced(w, 'l', s.slice(0, 3), [['SYSFLAGS', 1 << 18]]);
  w.advance(200000);
  s = loginAll();
  rep(s[0], auth, names.slice(0, 3), [[0, 2, 190.0, 0, false], [1, 1, 186.0, 0, false], [2, 3, 60.0, 0, true]]);
  rep(s[1], auth, names.slice(0, 2), [[0, 2, 190.1, 0, false], [1, 1, 186.0, 0, false]]);
  assert.ok(w.logged('"l" (circuit, ranked): 1 Bob 3:06.00, 2 Ann 3:10.10, DNF Cat'), all(w));
  assert.deepEqual(board(w, 0), ['Ann:50:0:1', 'Bob:100:1:0', 'Cat:0:0:1']);
  rep(s[2], auth, names.slice(0, 3), [[0, 1, 60.0, 0, true], [1, 2, 60.0, 0, true], [2, 3, 60.0, 0, true]]);
  // all five (Ann first, Bob second; Cat and Dan left, Eve never got going)
  auth = raced(w, 'm', s, [['SYSFLAGS', 1 << 18], ['MAXSIZE', 6]]);
  w.advance(200000);
  s = loginAll();
  const ann = [[0, 1, 180.0, 0, false], [1, 2, 181.0, 0, false], [2, 4, 50.0, 0, true], [3, 3, 51.0, 0, true], [4, 5, 9.0, 0, true]];
  const bob = [[0, 1, 180.0, 0, false], [1, 2, 181.0, 0, false], [2, 3, 50.0, 0, true], [3, 4, 51.0, 0, true]];
  rep(s[0], auth, names, ann);
  rep(s[1], auth, names.slice(0, 4), bob);
  assert.ok(w.logged('"m" (circuit, ranked): 1 Ann 3:00.00, 2 Bob 3:01.00, DNF Cat, DNF Dan, DNF Eve'), all(w));
  assert.ok(!w.logged('differs'), all(w));
  assert.deepEqual(board(w, 0), ['Ann:150:1:1', 'Bob:175:1:1', 'Cat:0:0:2', 'Dan:0:0:1', 'Eve:0:0:1']);
  // the leavers' careers: a disconnect for each race they left
  w.send(s[0], 'user', [['PERS', 'Cat']]);
  assert.equal(w.conn(s[0]).l('user').g('STAT').split(',')[1], '2');
  // finishers whose games had the finishers the other way round still differ
  auth = raced(w, 'n', s.slice(0, 3), [['SYSFLAGS', 1 << 18]]);
  w.advance(200000);
  s = loginAll();
  rep(s[0], auth, names.slice(0, 3), [[0, 1, 180.0, 0, false], [1, 2, 180.1, 0, false], [2, 3, 190.0, 0, false]]);
  rep(s[1], auth, names.slice(0, 3), [[0, 2, 180.1, 0, false], [1, 1, 180.0, 0, false], [2, 3, 190.0, 0, false]]);
  assert.ok(w.logged('"n": Bob\'s report differs (1 Bob 3:00.00, 2 Ann 3:00.10, 3 Cat 3:10.00)'), all(w));
  assert.ok(!w.logged('"n" (circuit'), all(w));
});

// a restart (a release) mid-race: the races go on in their players' browsers and count when the players report after
// it, with the reports, result and table of before it; a racer's name stays its own.  The file goes at the first tick;
// open games are not kept, nor races past raceMs
test('races_over_a_restart', () => {
  const storage = new MapStorage();
  const FILE = 'online/races.json';
  const exists = () => storage.get(FILE) !== undefined;
  let w = world({ storage });
  const names = ['Ann', 'Bob', 'Cat', 'Dan', 'Eve'];
  let gs = [0, 1, 2, 3, 4].map((i) => client(w, '10.77.0.' + (i + 2)));
  const rep = (c, auth, ns, players) => {
    const f = [['AUTH', auth], ['RESU', resuFull(0, 4014, players)]];
    ns.forEach((n, i) => f.push(['NAME' + i, n]));
    w.send(c, 'rank', f);
  };
  const unranked = [[0, 2, 190.0, 0, false], [1, 1, 186.0, 0, false]];
  const ranked = [[0, 1, 180.0, 0, false], [1, 2, 185.0, 0, false], [2, 3, 190.0, 0, false]];
  // Ann and Bob race unranked, Cat, Dan and Eve ranked; their games close their lobby links for the race
  let s = [0, 1, 2, 3, 4].map((i) => login(w, gs[i], names[i]));
  const u = raced(w, 'u', s.slice(0, 2));
  const r = raced(w, 'r', s.slice(2, 5), [['SYSFLAGS', 1 << 18]]);
  assert.ok(u !== null && r !== null);
  for (const c of s) w.close(c);
  // before the restart: Bob reports (that alone decides nothing), Cat and Dan decide theirs; a game not started
  w.advance(200000);
  const bob = login(w, gs[1], 'Bob');
  rep(bob, u, names.slice(0, 2), unranked);
  const cat = login(w, gs[2], 'Cat');
  const dan = login(w, gs[3], 'Dan');
  for (const c of [cat, dan]) rep(c, r, names.slice(2, 5), ranked);
  const before = [0, 1, 2].map((i) => row(w.conn(cat).l('$rfn'), i));
  const gf = client(w, '10.77.0.9');
  const fay = login(w, gf, 'Fay');
  w.send(fay, 'gcre', [['NAME', 'open'], ['PARAMS', 'TRACK=4014']]);
  w.core.stop();
  assert.ok(w.logged('2 races going on written to'), all(w));
  const t = w.t;

  // the restart
  w = world({ storage, t0: t + 10000 });
  assert.ok(w.logged('2 races going on read back from'), all(w));
  assert.ok(exists(), 'kept until the start went well');
  w.advance(5000);
  assert.ok(!exists(), 'gone at the first tick');
  const kept = [...w.core.lobby.games.values()].map((g) => g.name).sort();
  assert.deepEqual(kept, ['r', 'u'], 'the open game is not kept');
  gs = [0, 1, 2, 3, 4].map((i) => client(w, '10.77.0.' + (i + 2)));
  // Ann's name is still hers: another browser gets it with digits, Ann's own its name
  const go = client(w, '10.77.0.10');
  const other = login(w, go, 'Ann');
  assert.notEqual(w.conn(other).l('pers').g('PERS'), 'Ann');
  const ann = login(w, gs[0], 'Ann');
  assert.equal(w.conn(ann).l('pers').g('PERS'), 'Ann');
  // her report and Bob's of before the restart make the result
  rep(ann, u, names.slice(0, 2), unranked);
  assert.ok(w.logged('"u" (circuit, unranked): 1 Bob 3:06.00, 2 Ann 3:10.00'), all(w));
  // Eve sees the table of before the restart; everyone is back: the races are over
  const eve = login(w, gs[4], 'Eve');
  rep(eve, r, names.slice(2, 5), ranked);
  assert.deepEqual([0, 1, 2].map((i) => row(w.conn(eve).l('$rfn'), i)), before);
  assert.equal(w.core.lobby.games.size, 0, all(w));
  assert.deepEqual(board(w, 0), ['Ann:0:0:1', 'Bob:0:1:0', 'Cat:100:1:0', 'Dan:50:0:1', 'Eve:0:0:1'], 'each race counted once');

  // a race that started more than raceMs before the next start is over, one under it is not; a start that never got
  // to its first tick leaves the file for the next
  s = [0, 1].map((i) => login(w, gs[i], names[i]));
  assert.notEqual(raced(w, 'late', s), null);
  const started = [...w.core.lobby.games.values()][0].started;
  w.core.stop();
  const raceMs = LIMITS.raceMs;
  w = world({ storage, t0: started + raceMs + 1000 });
  assert.equal(w.core.lobby.games.size, 0);
  assert.ok(w.logged('0 races going on read back from') && w.logged('(1 long over left out)'), all(w));
  w = world({ storage, t0: started + raceMs - 1000 });
  assert.equal(w.core.lobby.games.size, 1, all(w));
  w.advance(5000);
  assert.ok(!exists());
});

// a restart keeps who left: a racer whose browser left before it has its name back at once after it, and a race whose
// players all left ends as it would have without the restart, orphanMs after
test('races_over_a_restart_who_left', () => {
  const storage = new MapStorage();
  let w = world({ storage });
  const names = ['Ann', 'Bob', 'Cat', 'Dan'];
  const gs = [0, 1, 2, 3].map((i) => client(w, '10.77.0.' + (i + 2)));
  const s = [0, 1, 2, 3].map((i) => login(w, gs[i], names[i]));
  assert.notEqual(raced(w, 'a', s.slice(0, 2)), null);
  assert.notEqual(raced(w, 'b', s.slice(2, 4)), null);
  for (const c of s) w.close(c);
  // Ann's tab closes mid-race, before the restart
  w.advance(30000);
  w.peerGone(gs[0]);
  w.advance(10000);
  w.core.stop();
  const t = w.t;
  w = world({ storage, t0: t + 5000 });
  // her name is free for her new tab (another address); Cat's is not, while his browser may still come back
  let g = client(w, '10.77.0.20');
  const ann = login(w, g, 'Ann');
  assert.equal(w.conn(ann).l('pers').g('PERS'), 'Ann');
  g = client(w, '10.77.0.21');
  const early = login(w, g, 'Cat');
  assert.notEqual(w.conn(early).l('pers').g('PERS'), 'Cat');
  // Cat's and Dan's browsers never come back: their addresses lapse at the switch, 60 s after the start
  w.advance(60000);
  for (const x of [gs[2], gs[3]]) w.peerGone(x);
  g = client(w, '10.77.0.22');
  const cat = login(w, g, 'Cat');
  assert.equal(w.conn(cat).l('pers').g('PERS'), 'Cat');
  // "b" ends orphanMs later; "a" goes on while Bob races
  w.advance(125000);
  assert.ok(w.logged('the game "b" ended: its players left the server'), all(w));
  const left = [...w.core.lobby.games.values()].map((x) => x.name);
  assert.deepEqual(left, ['a']);
});

// ONL-7: the results store: the rankings built once for many asks (the store's other parts: stats.rs)
test('onl7_rankings_built_once', () => {
  const w = world();
  const g = client(w, '10.77.0.2');
  const a = login(w, g, 'Asker');
  const before = w.core.stats.builds;
  for (let i = 0; i < 30; i++) w.send(a, 'snap', [['INDEX', i], ['CHAN', 6], ['START', 0], ['RANGE', 10]]);
  const n = w.core.stats.builds - before;
  assert.ok(n <= 2, 'the board was built ' + n + ' times for 30 asks');
});

// ONL-8: no line per friend added; the lines a client causes carry its key
test('onl8_lines_and_keys', () => {
  const w = world();
  const g = w.clientIn('10.77.0.2', 'G8');
  const l = login(w, g, 'Flooder');
  const k = w.lkey(l);
  const b = w.buddy(g, k);
  for (let i = 0; i < 20; i++) w.send(b, 'RADD', [['USER', 'Pal' + i], ['LIST', 'B']]);
  assert.ok(!w.logged('added a friend'));
  const line = w.lines.find(([s]) => s.includes('logged in as "Flooder"'));
  const key = line ? line[1] : null;
  assert.equal(key, 'G8', "a client's line carries its key (logged a few a minute per key)");
});

// ONL-9: one client holds only its share of the lobby; the last quarter is for clients that hold none
test('onl9_share_of_the_lobby', () => {
  const w = world({ limits: { sessions: 12 } });
  const conns = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const g = w.clientIn('10.77.0.' + (10 + i), 'Big');
      conns.push(w.connect(g, PORT_LOBBY));
    }
  }
  assert.equal(conns.filter((c) => w.conn(c).reset).length, 1, 'one client: 8 lobby sessions, the 9th refused');
  // 8 + 1 of 12 in use: the last quarter only for a client with none
  let g = w.clientIn('10.77.0.20', 'Other');
  const other = w.connect(g, PORT_LOBBY);
  assert.ok(!w.conn(other).reset);
  g = w.clientIn('10.77.0.21', 'Other');
  const again = w.connect(g, PORT_LOBBY);
  assert.ok(w.conn(again).reset, 'a client that holds a session already: none of the last quarter');
  g = w.clientIn('10.77.0.22', 'Fresh');
  const fresh = w.connect(g, PORT_LOBBY);
  assert.ok(!w.conn(fresh).reset, 'a client that holds none gets one');
});

// ONL-12: the trace file (trace.rs: LobbyTrace, TraceState) has no counterpart in the JS port
test('onl12_trace', { skip: 'the JS port has no lobby trace (trace.rs)' }, () => {});

// ONL-13: a Messenger login key works only from its own browser (the online folder's mode, 0700, has no counterpart
// in a MapStorage)
test('onl13_folder_and_key', () => {
  const storage = new MapStorage();
  const w = world({ storage });
  const g = client(w, '10.77.0.2');
  const l = login(w, g, 'Alpha');
  const k = w.lkey(l);
  const b = w.buddy(g, k);
  w.send(b, 'RADD', [['USER', 'Bravo'], ['LIST', 'B']]);
  w.core.buddySave();
  assert.ok(storage.list('online/').length > 0, 'the online folder is written');
  const o = client(w, '10.77.0.9');
  const other = w.buddy(o, k);
  w.sleep(3500);
  const m = w.conn(other).last('AUTH');
  assert.equal(m ? m.code : null, 'pass', "Alpha's key from another browser");
  w.core.stop();
});

