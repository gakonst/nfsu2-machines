// A port of web/server-rs/crates/roam/tests/roam_lobby.rs: race lobbies (roam_core.h RC_MSG_LOBBY, RC_MSG_LOBBIES): a
// host's advert to the hub, the open lobbies of a room with the world map's answer to a player that takes them, and the
// links a lobby needs first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join as pjoin, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Kit, HF_HUBCREW, dgram, fnv1a, frame, helloWith, mapdOf, mapreqBase, recrc, snap, snapN, ways } from './kit.mjs';
import { ownerOfToken } from '../../src/claims/claims.js';

/** the repository's root (the Rust's CARGO_MANIFEST_DIR/../../../..) */
const REPO = pjoin(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** browser i's address: 10.77.0.2 and on */
function W(i) {
  return (0x0a4d0002 + i) >>> 0;
}

/** a datagram's flags set (and its CRC again) */
function withFlags(d, flags) {
  const e = d.slice();
  e[14] = flags & 255;
  e[15] = (flags >> 8) & 255;
  return recrc(e);
}

/** a player of core version 5 in room, with the lobby flag or without */
function join(k, i, room, lobbies) {
  const h = helloWith(100 + i, { core: 5, room: fnv1a(room) });
  k.from(W(i), withFlags(h, lobbies ? 0x0080 : 0));
}

const le16 = (p, o, v) => {
  p[o] = v & 255;
  p[o + 1] = (v >> 8) & 255;
};
const le32 = (p, o, v) => {
  p[o] = v & 255;
  p[o + 1] = (v >>> 8) & 255;
  p[o + 2] = (v >>> 16) & 255;
  p[o + 3] = (v >>> 24) & 255;
};
const f32 = new DataView(new ArrayBuffer(4));
const lef32 = (p, o, v) => {
  f32.setFloat32(0, v, true);
  for (let k = 0; k < 4; k++) p[o + k] = f32.getUint8(k);
};

/** a LOBBY datagram as roam_core.c lays it out (op arg state max, to, lobby, race, x y, t, n, away seconds, ids) */
function lobby(sender, op, to, id, race, x, y, state, max, ids) {
  return lobbyT(sender, op, to, id, race, x, y, state, max, ids, 0);
}

/** lobby with its t (an ADVERT's: 0x8000 its counts said, 0x0040 for its host's friends and crew-mates only) */
function lobbyT(sender, op, to, id, race, x, y, state, max, ids, t) {
  const p = new Uint8Array(24 + 4 * ids.length);
  le16(p, 20, t);
  p[0] = op;
  p[2] = state;
  p[3] = max;
  le32(p, 4, to);
  le32(p, 8, id);
  le32(p, 12, race);
  le16(p, 16, x & 0xffff);
  le16(p, 18, y & 0xffff);
  p[22] = ids.length;
  ids.forEach((v, i) => le32(p, 24 + 4 * i, v));
  return dgram(12, sender, p);
}

/** the LOBBIES datagrams the hub sent since the last clear: [to, req, [[x, y, race, n, max, state]]] */
function lobbies(k) {
  const i16 = (d, o) => {
    const v = d[o] | (d[o + 1] << 8);
    return v >= 0x8000 ? v - 0x10000 : v;
  };
  return k.sent
    .filter(([, f]) => f[16 + 5] === 13)
    .map(([vip, f]) => {
      const d = f.subarray(16);
      const n = d[18];
      const e = [];
      for (let i = 0; i < n; i++) {
        const o = 19 + 11 * i;
        const race = (d[o + 4] | (d[o + 5] << 8) | (d[o + 6] << 16) | (d[o + 7] << 24)) >>> 0;
        e.push([i16(d, o), i16(d, o + 2), race, d[o + 8], d[o + 9], d[o + 10]]);
      }
      return [vip, d[16] | (d[17] << 8), e];
    });
}

/** whether browser i's last list has browser j */
function listed(k, i, j) {
  const l = k.lists().get(W(i) + ':47210');
  return l !== undefined && l.some((e) => e.vip === W(j));
}

// the hosts' adverts are kept per player; a player that takes lobbies gets its room's with its world map, nearest
// first; one that does not, or of another room, does not; a closed lobby, a stale advert or a bad one is not listed
test('the world map brings the rooms open lobbies', () => {
  const k = new Kit({ degree: 1 });
  join(k, 0, '', true);
  join(k, 1, '', true);
  join(k, 2, '', true);
  join(k, 3, '', false);
  join(k, 4, 'red', true);
  for (let i = 0; i < 5; i++) k.from(W(i), snap(100 + i, [i * 100.0, 0.0, 0.0]));
  // 1 and 2 host (2 nearer to 0), 4 hosts in another room; to a player, not the hub: not kept
  k.from(W(1), lobby(101, 1, 0, 0xa1, 0x1111, 500, 0, 0, 6, [101]));
  k.from(W(2), lobby(102, 1, 0, 0xa2, 0x2222, 50, -20, 0, 4, [102, 103]));
  k.from(W(4), lobby(104, 1, 0, 0xa4, 0x4444, 0, 0, 0, 6, [104]));
  k.from(W(3), lobby(103, 1, 100, 0xa3, 0x3333, 0, 0, 0, 6, [103]));
  // a bad one: the same player twice
  k.from(W(3), lobby(103, 1, 0, 0xa5, 0x5555, 0, 0, 0, 6, [103, 103]));
  k.hub.tick();
  k.clear();
  k.from(W(0), mapreqBase(100, 7, 2048, 0));
  assert.deepStrictEqual(lobbies(k), [[W(0), 7, [[50, -20, 0x2222, 2, 4, 0], [500, 0, 0x1111, 1, 6, 0]]]]);
  // without the flag: the map, no lobbies; another room: its own
  k.clear();
  k.from(W(3), mapreqBase(103, 1, 2048, 0));
  assert.ok(lobbies(k).length === 0 && k.sent.length !== 0, 'a player that takes none gets its map only');
  k.clear();
  k.from(W(4), mapreqBase(104, 1, 2048, 0));
  assert.deepStrictEqual(lobbies(k), [[W(4), 1, [[0, 0, 0x4444, 1, 6, 0]]]]);
  // 1 closes its lobby (another id closes nothing), 2's advert goes stale: none listed
  k.from(W(2), lobby(102, 5, 0, 0xff, 0x2222, 50, -20, 1, 4, []));
  k.from(W(1), lobby(101, 5, 0, 0xa1, 0x1111, 500, 0, 0, 6, []));
  k.step(1100.0);
  k.clear();
  k.from(W(0), mapreqBase(100, 8, 2048, 0));
  assert.deepStrictEqual(lobbies(k), [[W(0), 8, [[50, -20, 0x2222, 2, 4, 0]]]], "only 2's, closed with another id");
  k.step(3100.0);
  k.from(W(0), snap(100, [0.0, 0.0, 0.0]));
  k.clear();
  k.from(W(0), mapreqBase(100, 9, 2048, 0));
  assert.deepStrictEqual(lobbies(k), [[W(0), 9, []]], 'a stale advert is a lobby gone');
});

// a host the player blocks by name (any case: both are "p" here) is not on its list (Hub::blocks)
test('a blocked hosts lobby is not listed', () => {
  const k = new Kit({});
  join(k, 0, '', true);
  join(k, 1, '', true);
  for (let i = 0; i < 2; i++) k.from(W(i), snap(100 + i, [i * 100.0, 0.0, 0.0]));
  k.from(W(1), lobby(101, 1, 0, 0xa1, 0x1111, 500, 0, 0, 6, [101]));
  k.clear();
  k.from(W(0), mapreqBase(100, 7, 2048, 0));
  assert.deepStrictEqual(lobbies(k), [[W(0), 7, [[500, 0, 0x1111, 1, 6, 0]]]]);
  k.hub.blocks(W(0), ['P']);
  k.step(1100.0);
  k.clear();
  k.from(W(0), mapreqBase(100, 8, 2048, 0));
  assert.deepStrictEqual(lobbies(k), [[W(0), 8, []]]);
});

// carl hosts a lobby at its start with anna in it; Bob, whom anna blocks, stops at the start: Bob is not linked with
// carl (the link Bob would hear of the lobby and join it by, and race anna), and neither the lobby nor carl is on
// Bob's map; dave is linked with all three and sees the lobby.  Once anna is out of the lobby, Bob is linked with carl
// again.  And the other way round: Bob in the lobby, anna at the start.  (every pair | the grid)
test('a lobby is not there for one kept apart from its players', () => {
  const link = listed;
  for (const [way, o] of ways()) {
    for (const [member, outsider] of [[1, 2], [2, 1]]) {
      const k = new Kit({ ...o });
      for (const [i, name, x] of [[0, 'carl', 0.0], [1, 'anna', 4.0], [2, 'Bob', 8.0], [3, 'dave', 12.0]]) {
        const h = helloWith(100 + i, { core: 5, name });
        k.from(W(i), withFlags(h, 0x0080));
        k.from(W(i), snap(100 + i, [x, 0.0, 0.0]));
      }
      k.hub.blocks(W(1), ['bob']);
      k.from(W(0), lobby(100, 1, 0, 0xc1, 0x1111, 0, 0, 0, 6, [100, 100 + member]));
      k.hub.tick();
      assert.ok(link(k, 0, member) && !link(k, 0, outsider) && !link(k, outsider, 0), way + ': not carl and ' + outsider);
      assert.ok(!link(k, 1, 2) && link(k, 3, 0) && link(k, 3, 1) && link(k, 3, 2), way + ': dave with all of them');
      k.clear();
      k.from(W(outsider), mapreqBase(100 + outsider, 1, 2048, 0));
      const map = k.sent.map(([, f]) => mapdOf(f)).filter((m) => m !== null).flatMap((m) => m[5]);
      assert.deepStrictEqual(lobbies(k), [[W(outsider), 1, []]], way + ': no lobby on ' + outsider + "'s map");
      assert.ok(!map.some((e) => e[1] !== null && e[1][0] === 0), way + ': nor carl: ' + JSON.stringify(map));
      k.clear();
      k.from(W(3), mapreqBase(103, 1, 2048, 0));
      const l = lobbies(k);
      assert.strictEqual(l.length > 0 ? l[0][2].length : null, 1, way + ': dave sees it');
      // the member leaves the lobby
      k.step(600.0);
      k.from(W(0), lobby(100, 1, 0, 0xc1, 0x1111, 0, 0, 0, 6, [100]));
      k.clear();
      k.hub.tick();
      assert.ok(link(k, 0, outsider) && !link(k, 1, 2), way + ': ' + outsider + ' with carl again');
    }
  }
});

/** the newest wasi-sdk in deps/ (the Rust's way to build roam_core.c to wasm), or null */
function wasiSdk() {
  const deps = pjoin(REPO, 'deps');
  if (!existsSync(deps)) return null;
  const v = readdirSync(deps).filter((n) => n.startsWith('wasi-sdk-')).sort();
  return v.length ? pjoin(deps, v[v.length - 1]) : null;
}

/** roam_core.c and web/test/roam_hubwire.c built to wasm, and a run of it (its stdout, trimmed) */
function hubwire(wasi, name) {
  const w = pjoin(mkdtempSync(pjoin(tmpdir(), 'roam-')), name);
  execFileSync(
    pjoin(wasi, 'bin/clang'),
    ['--target=wasm32-wasip1-threads', '-pthread', '-O2', '-ffp-contract=off', '-Iruntime', '-o', w, 'web/test/roam_hubwire.c', 'runtime/roam_core.c',
      '-Wl,--import-memory,--export-memory,--shared-memory,--initial-memory=67108864,--max-memory=268435456'],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return (args) => execFileSync(process.execPath, [pjoin(REPO, 'web/test/wasi-run.mjs'), w, ...args], { encoding: 'utf8' }).trim();
}
const unhex = (s) => Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// the wire: roam_core's advert is the hub's lobby, and the hub's LOBBIES are roam_core's lobbies
test('lobbies on the wire roam core and the hub agree', (t) => {
  const wasi = wasiSdk();
  if (wasi === null) {
    t.skip('no wasi-sdk in deps/: skipped');
    return;
  }
  const run = hubwire(wasi, 'roam_hubwire_lobby.wasm');
  // the C core's advert, from a player (its HELLO with the flag), and another player's world map: the lobby
  const k = new Kit({ degree: 1 });
  const h = helloWith(0x1234abcd, { core: 5 });
  k.from(W(0), withFlags(h, 0x0080));
  join(k, 1, '', true);
  k.from(W(1), snap(101, [0.0, 0.0, 0.0]));
  let ad = unhex(run(['lobby']));
  assert.strictEqual(ad.length, 16 + 24 + 8 + 4);
  assert.strictEqual(ad[16 + 23], 25, 'the host\'s away seconds in the byte after n, once reserved: the hub takes the advert all the same');
  k.from(W(0), ad);
  k.clear();
  k.from(W(1), mapreqBase(101, 1, 2048, 0));
  assert.deepStrictEqual(lobbies(k), [[W(1), 1, [[-1234, 567, 0x0badf00d, 2, 6, 0]]]]);
  // the hub's datagrams to a C session that asks (req 1): it holds the lobby
  let got = run(['lobbies', ...k.sent.map(([, f]) => hex(f.subarray(16)))]);
  assert.strictEqual(got.split('\n').pop(), 'lobbies 1 1 -1234,567,' + 0x0badf00d + ',2,6,0,0,0', got);
  // a career lobby's advert (its t: the race counts in its host's career): its entry marked so, and the C core
  // takes the mark off its state (an older core drops the entry)
  ad = unhex(run(['lobbycareer']));
  k.step(1100.0);
  k.from(W(0), ad);
  k.from(W(1), snap(101, [0.0, 0.0, 0.0]));
  k.clear();
  k.from(W(1), mapreqBase(101, 1, 2048, 0));
  assert.deepStrictEqual(lobbies(k), [[W(1), 1, [[-1234, 567, 0x0badf00d, 2, 6, 0x88]]]]);
  got = run(['lobbies', ...k.sent.map(([, f]) => hex(f.subarray(16)))]);
  assert.strictEqual(got.split('\n').pop(), 'lobbies 1 1 -1234,567,' + 0x0badf00d + ',2,6,0,128,2', got);
});

// a lobby's host is linked with its players and with the players in free roam near its start before any nearer one
// (every pair | the grid): with the start crowded by players who went into its career race (their places count for
// a minute) and 4 links a player, its player 45 m off and one stopped 12 m out are linked with the host, ones in
// free roam 25 or 40 m out are not, nor a player it lists 300 m off (none of a lobby's is: an advert says what it
// likes); once its advert is stale (and the links' hold is over), the nearest again.  A lobby whose start is not
// where its host is gets no links at all.
test('a lobbys host is linked with its players and the ones at its start first', () => {
  for (const [how, o] of ways()) {
    // (the players in its race where they are, not away_m up: a crowd that is not in free roam)
    const k = new Kit({ ...o, degree: 4, awayM: 1e-9 });
    for (let i = 0; i < 11; i++) join(k, i, '', true);
    // 0 the host at the start (0, 0); 1 to 4 in a race, 1 m from it all round (its 4 nearest); 5 a player of the
    // lobby 45 m off; 6 stopped 12 m out; 7 at 25 m; 8 at 40 m; 9 a player it lists 300 m off; 10 a host 1 km off
    const snaps = (k) => {
      k.from(W(0), snap(100, [0.0, 0.0, 0.0]));
      [[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0], [0.0, -1.0]].forEach((at, i) => k.from(W(1 + i), snapN(101 + i, [at[0], at[1], 0.0], 3, 1)));
      k.from(W(5), snap(105, [-45.0, 0.0, 0.0]));
      k.from(W(6), snap(106, [12.0, 0.0, 0.0]));
      k.from(W(7), snap(107, [25.0, 0.0, 0.0]));
      k.from(W(8), snap(108, [40.0, 0.0, 0.0]));
      k.from(W(9), snap(109, [300.0, 0.0, 0.0]));
      k.from(W(10), snap(110, [1000.0, 0.0, 0.0]));
    };
    const linked = (k, a, b) => {
      assert.strictEqual(listed(k, a, b), listed(k, b, a), how + ': a link is listed at both ends');
      return listed(k, a, b);
    };
    snaps(k);
    k.hub.tick();
    assert.ok(!linked(k, 0, 5) && !linked(k, 0, 6), how + ': without a lobby, the nearest');
    // the advert: the host, 5 and 9 in it
    k.from(W(0), lobby(100, 1, 0, 0xa0, 0x1111, 0, 0, 0, 6, [100, 105, 109]));
    k.step(1000.0);
    snaps(k);
    k.clear();
    k.hub.tick();
    assert.ok(linked(k, 0, 5), how + ': its player 45 m off');
    assert.ok(linked(k, 0, 6), how + ': the one 12 m out');
    assert.ok(!linked(k, 0, 7) && !linked(k, 0, 8), how + ': not the ones 25 and 40 m out');
    assert.ok(!linked(k, 0, 9), how + ': not the one it lists 300 m off');
    assert.strictEqual(k.info('lobbyLinks'), 2.0, how + ': 2 links for the lobby');
    // 7, 25 m out, asks to join (its JOIN's copy to the hub; one for another lobby counts for nothing): linked
    // with the host too
    k.from(W(7), lobby(107, 2, 0, 0xa0, 0x1111, 0, 0, 0, 6, [100, 105]));
    k.from(W(8), lobby(108, 2, 0, 0xee, 0x1111, 0, 0, 0, 6, [100, 105]));
    k.from(W(0), lobby(100, 1, 0, 0xa0, 0x1111, 0, 0, 0, 6, [100, 105, 109]));
    k.step(1000.0);
    snaps(k);
    k.clear();
    k.hub.tick();
    assert.ok(linked(k, 0, 7), how + ': the one asking to join, 25 m out');
    assert.ok(!linked(k, 0, 8), how + ': not one asking to join another lobby');
    assert.strictEqual(k.info('lobbyLinks'), 3.0, how + ': 3 links for the lobby');
    // no advert since: stale; past the links' hold, the nearest
    for (let n = 0; n < 3; n++) {
      k.step(2500.0);
      snaps(k);
      k.clear();
      k.hub.tick();
    }
    assert.ok(!linked(k, 0, 5) && !linked(k, 0, 6) && !linked(k, 0, 7), how + ': its advert stale, the nearest again');
    assert.strictEqual(k.info('lobbyLinks'), 0.0, how + ': none for a lobby gone');
    // 10, 1 km off, advertises a lobby at the crowded start listing 6: no links for it
    k.from(W(10), lobby(110, 1, 0, 0xb0, 0x1111, 0, 0, 0, 6, [110, 106]));
    k.step(1000.0);
    snaps(k);
    k.clear();
    k.hub.tick();
    assert.strictEqual(k.info('lobbyLinks'), 0.0, how + ": none for a lobby whose start is not its host's");
  }
});

const bytes = (s) => (typeof s === 'string' ? new TextEncoder().encode(s) : s);

/**
 * a RACEREP datagram as roam_core.c lays it out: lobby, race; mode, laps, track; place, players, flags, type, class,
 * 3 zero bytes; rating, field, factor, kW, kg, km/h, time; the name in 16 bytes
 */
function racerep(sender, lobby, place, players, flags, rating, name, payloadLen) {
  return racerepIn(sender, lobby, place, players, flags, rating, name, payloadLen, 0.0);
}

/** racerep with the reporter's time (s) */
function racerepIn(sender, lobby, place, players, flags, rating, name, payloadLen, time) {
  const p = new Uint8Array(payloadLen);
  le32(p, 0, lobby);
  le32(p, 4, 0x0badf00d);
  p[8] = 2; // drag
  p[9] = 1;
  le16(p, 10, 4401);
  p[12] = place;
  p[13] = players;
  p[14] = flags;
  p[15] = 0;
  p[16] = 3;
  [rating, 241.4, 1.0, 128.0, 1055.0, 256.0, time].forEach((v, k) => lef32(p, 20 + 4 * k, v));
  p.set(bytes(name), 48);
  return dgram(14, sender, p);
}

// a player's race report is one [race] line: the race, how it did, its car; one a race (its lobby) and none sooner
// than 20 s after its last; a report with a field out of range, or from no player the hub knows, is none
test('race reports are logged once a race', () => {
  const k = new Kit({});
  k.from(W(0), helloWith(100, { core: 5, name: 'Ann' }));
  k.from(W(1), racerep(101, 0xa1, 1, 2, 0, 239.3, 'PEUGOT', 64));
  assert.ok(k.lines.length === 0, 'no report from a browser the hub does not know');
  k.from(W(0), racerep(100, 0xa1, 0, 2, 2, 239.3, 'PEUGOT', 64));
  assert.deepStrictEqual(k.lines, [
    '[race] lobby 000000a1, race 0badf00d (drag, track 4401, 1 lap, 2 cars): Ann quit; PEUGOT (type 0), class 3, rating 239.3 ' +
      "(the cars' average 241.4), 128 kW, 1055 kg, 256 km/h, power x1.000",
  ]);
  k.lines.length = 0;
  k.step(30000.0);
  k.from(W(0), racerep(100, 0xa1, 1, 2, 0, 239.3, 'PEUGOT', 64));
  assert.ok(k.lines.length === 0, 'the same race again: none');
  k.from(W(0), racerep(100, 0xa2, 1, 2, 0, 239.3, 'PEUGOT', 64));
  assert.strictEqual(k.lines.length, 1, 'another race: its line');
  assert.ok(k.lines[0].includes(': Ann 1st of 2;'), JSON.stringify(k.lines));
  k.lines.length = 0;
  k.from(W(0), racerep(100, 0xa3, 1, 2, 0, 239.3, 'PEUGOT', 64));
  assert.ok(k.lines.length === 0, 'another race within 20 s of the last: none');
  k.step(25000.0);
  for (const [what, d] of [
    ['a place past its cars', racerep(100, 0xa4, 3, 2, 0, 239.3, 'PEUGOT', 64)],
    ['no cars', racerep(100, 0xa4, 0, 0, 0, 239.3, 'PEUGOT', 64)],
    ['an unknown flag', racerep(100, 0xa4, 1, 2, 8, 239.3, 'PEUGOT', 64)],
    ['a rating out of range', racerep(100, 0xa4, 1, 2, 0, 9999.0, 'PEUGOT', 64)],
    ['a rating not a number', racerep(100, 0xa4, 1, 2, 0, NaN, 'PEUGOT', 64)],
    ['an unprintable name', racerep(100, 0xa4, 1, 2, 0, 239.3, 'PE\x07GOT', 64)],
    ['a short one', racerep(100, 0xa4, 1, 2, 0, 239.3, 'PEUGOT', 60)],
    ['another sender in the datagram', racerep(101, 0xa4, 1, 2, 0, 239.3, 'PEUGOT', 64)],
  ]) {
    k.from(W(0), d);
    assert.ok(k.lines.length === 0, what + ': none');
  }
  k.from(W(0), racerep(100, 0xa4, 1, 2, 1, 239.3, 'PEUGOT', 64));
  assert.ok(k.lines[0].includes(': Ann (host) 1st of 2;'), JSON.stringify(k.lines));
  assert.strictEqual(k.info('raceReports'), 3.0);
});

// a car no tuning makes (an edited save's: nfsu2.xyz, 2026-10-30, a 350Z of 2351 kW rated 5000) is a [cheat] line
// besides its [race] line, which nfsu2-server ctl ban takes by its handle; a car of the game's best is none
test('an edited car in a race is a cheat line', () => {
  const k = new Kit({});
  k.from(W(0), helloWith(100, { core: 5, name: 'Ed' }));
  k.from(W(0), racerep(100, 0xa1, 1, 3, 0, 804.0, 'COROLLA', 64));
  assert.strictEqual(k.lines.length, 1, JSON.stringify(k.lines));
  k.lines.length = 0;
  k.step(25000.0);
  k.from(W(0), racerep(100, 0xa2, 1, 3, 0, 5000.0, '350Z', 64));
  const lines = k.lines.slice();
  assert.strictEqual(lines.length, 2, JSON.stringify(lines));
  assert.ok(lines[0].startsWith('[race] lobby 000000a2'), JSON.stringify(lines));
  const want =
    '"Ed": raced in the race of lobby 000000a2 (race 0badf00d: drag, 1 lap) in an edited car, 1st of 3: 350Z ' +
    '(type 0), 128 kW, 1055 kg, 256 km/h, rated 5000; no car of the game makes 600 kW, 420 km/h or a rating of 1000; ' +
    'no time to compare';
  assert.ok(lines[1].startsWith('[cheat] ') && lines[1].endsWith(want), JSON.stringify(lines));
  assert.strictEqual(k.info('cheatLines'), 1.0);
});

// a car whose game data is edited (RC_RR_EDITED: its type's record in the browser's copy of GlobalB not the game's, a
// guide passed among players, 2026-10-31) is a [cheat] line when its time beat 95 % of the honest cars' rated like it in
// the same race; one no quicker than them, or with too few to compare, only adds that to its [race] line (an edit may
// gain nothing); with numbers no tuning makes it is a [cheat] line however quick, saying what its time beat
test('a car of edited game data in a race is a cheat line when it gained', () => {
  const k = new Kit({});
  k.from(W(0), helloWith(100, { core: 5, name: 'Ed' }));
  const rep = (lobby, place, flags, rating, time) => racerepIn(100, lobby, place, 3, flags, rating, 'SUPRA', 64, time);
  // too few honest times of the race yet: a note on its [race] line
  k.from(W(0), rep(0xa0, 2, 4, 239.3, 35.0));
  let lines = k.lines.slice();
  assert.strictEqual(lines.length, 1, JSON.stringify(lines));
  assert.ok(
    lines[0].endsWith("; its game has the car's data edited (GlobalB), no gain seen: its 35.00 s: too few honest times of this race to compare it with"),
    JSON.stringify(lines),
  );
  k.lines.length = 0;
  // twelve honest cars of its rating (30 .. 41 s) and one far stronger, a quick one (20 s): theirs are compared
  for (let i = 1; i <= 13; i++) {
    k.from(W(i), helloWith(100 + i, { core: 5, name: 'H' + i }));
    const [rating, time] = i === 13 ? [700.0, 20.0] : [230.0, 29.0 + i];
    k.from(W(i), racerepIn(100 + i, 0xb0 + i, 1, 3, 0, rating, 'COROLLA', 64, time));
  }
  assert.strictEqual(k.lines.length, 13, 'their [race] lines only, ' + JSON.stringify(k.lines));
  k.lines.length = 0;
  k.step(25000.0);
  k.from(W(0), rep(0xa1, 2, 4, 239.3, 35.0));
  lines = k.lines.slice();
  assert.strictEqual(lines.length, 1, 'as quick as the honest cars of its rating: no [cheat] line, ' + JSON.stringify(lines));
  assert.ok(
    lines[0].endsWith(
      "; its game has the car's data edited (GlobalB), no gain seen: its 35.00 s beat 50 % of the 12 honest cars rated " +
        '179-299 in this race (their median 36.00 s)',
    ),
    JSON.stringify(lines),
  );
  k.lines.length = 0;
  k.step(25000.0);
  k.from(W(0), rep(0xa2, 1, 5, 239.3, 25.0));
  lines = k.lines.slice();
  assert.strictEqual(lines.length, 2, JSON.stringify(lines));
  assert.ok(lines[0].includes(': Ed (host) 1st of 3 in 25.00 s;') && !lines[0].includes('GlobalB'), JSON.stringify(lines));
  const want =
    '"Ed": raced in the race of lobby 000000a2 (race 0badf00d: drag, 1 lap) in an edited car, 1st of 3: SUPRA ' +
    "(type 0), 128 kW, 1055 kg, 256 km/h, rated 239; its game has the car's data edited (GlobalB); its 25.00 s beat " +
    'all 12 honest cars rated 179-299 in this race (their median 36.00 s)';
  assert.ok(lines[1].startsWith('[cheat] ') && lines[1].endsWith(want), JSON.stringify(lines));
  k.lines.length = 0;
  // a strong car beats most of any rating's: that never decides
  k.step(25000.0);
  k.from(W(0), rep(0xa3, 1, 4, 650.0, 25.0));
  lines = k.lines.slice();
  assert.strictEqual(lines.length, 1, JSON.stringify(lines));
  assert.ok(
    lines[0].endsWith(
      'no gain seen: its 25.00 s beat 92 % of the 13 honest cars of any rating (too few rated like it) in this race ' +
        '(their median 35.00 s)',
    ),
    JSON.stringify(lines),
  );
  k.lines.length = 0;
  k.step(25000.0);
  k.from(W(0), rep(0xa4, 3, 4, 5000.0, 45.0));
  lines = k.lines.slice();
  assert.ok(
    lines[1].endsWith(
      "rated 5000; its game has the car's data edited (GlobalB); no car of the game makes 600 kW, 420 km/h or a " +
        'rating of 1000; its 45.00 s beat 0 % of the 13 honest cars of any rating (too few rated like it) in this race ' +
        '(their median 35.00 s)',
    ),
    JSON.stringify(lines),
  );
  k.lines.length = 0;
  k.step(25000.0);
  k.from(W(0), racerepIn(100, 0xa5, 1, 1, 4, 239.3, 'SUPRA', 64, 20.0));
  lines = k.lines.slice();
  assert.strictEqual(lines.length, 1, 'alone in its race: the [race] line only, ' + JSON.stringify(lines));
  assert.ok(!lines[0].includes('GlobalB'), JSON.stringify(lines));
  assert.strictEqual(k.info('cheatLines'), 2.0);
});

/** a RACEREP of a car: its type, rating, engine power (kW) and top speed (km/h), 1st of players, no time */
function racerepCar(sender, lobby, players, carType, rating, kw, kmh) {
  const p = new Uint8Array(64);
  le32(p, 0, lobby);
  le32(p, 4, 0x0badf00d);
  p[8] = 1; // sprint
  p[9] = 1;
  le16(p, 10, 4104);
  p[12] = 1;
  p[13] = players;
  p[15] = carType;
  p[16] = 0;
  [rating, 500.0, 1.0, kw, 1338.0, kmh, 0.0].forEach((v, k) => lef32(p, 20 + 4 * k, v));
  p.set(bytes('SKYLINE'), 48);
  return dgram(14, sender, p);
}

// the operator's cars to race-ban for (RoamOptions::car_bans; these numbers are the test's own): a lobby race in one
// of the player's car types at that engine power or rating or more, with others, is told on once, after its lines,
// with the player, its car and how it did; under both, alone in its race, a traffic car's figures, or top speed alone
// is none
test('a car past the operators numbers is told for a race ban', () => {
  const told = [];
  const call = (c) => told.push(c);
  let k = new Kit({ carBans: { kw: 1500.0, rating: 3000.0, call } });
  k.from(W(0), helloWith(100, { core: 5, name: 'Evl' }));
  let lobbyId = 0xc0;
  const race = (k, players, carType, rating, kw, kmh) => {
    k.step(25000.0);
    lobbyId += 1;
    k.from(W(0), racerepCar(100, lobbyId, players, carType, rating, kw, kmh));
    return lobbyId;
  };
  for (const [what, players, carType, rating, kw, kmh] of [
    ['an honest car', 4, 27, 735.0, 505.0, 362.0],
    ['under both numbers', 4, 27, 2999.0, 1499.0, 381.0],
    ['alone in its race', 1, 27, 1451.0, 2829.0, 381.0],
    ['a traffic car (a fire truck)', 4, 37, 0.0, 2829.0, 381.0],
    ['top speed alone', 4, 27, 735.0, 505.0, 1999.0],
  ]) {
    race(k, players, carType, rating, kw, kmh);
    assert.ok(told.length === 0, what + ': none');
  }
  const linesBefore = k.lines.length;
  const atKw = race(k, 4, 27, 1451.0, 2829.0, 381.0);
  assert.strictEqual(told.length, 1, 'at the power: told once');
  const c = told[0];
  assert.deepStrictEqual([c.vip, c.name, c.car, c.carType], [W(0), 'Evl', 'SKYLINE', 27]);
  assert.deepStrictEqual([c.kw, c.kg, c.kmh, c.rating], [2829.0, 1338.0, 381.0, 1451.0]);
  assert.deepStrictEqual([c.kind, c.laps, c.place, c.lobby, c.race], ['sprint', 1, '1st of 4', atKw, 0x0badf00d]);
  assert.ok(k.lines.length > linesBefore, 'its lines first');
  // the same race again: one report a race, none told
  k.from(W(0), racerepCar(100, atKw, 4, 27, 1451.0, 2829.0, 381.0));
  assert.strictEqual(told.length, 1);
  race(k, 2, 3, 3000.0, 400.0, 381.0);
  assert.strictEqual(told.length, 2, 'at the rating: told');
  assert.strictEqual(told[1].place, '1st of 2');
  assert.strictEqual(k.info('carBans'), 2.0);
  // without the operator's numbers: none, whatever the car
  k = new Kit({});
  k.from(W(0), helloWith(100, { core: 5, name: 'Evl' }));
  k.from(W(0), racerepCar(100, 0xd1, 4, 27, 5000.0, 9999.0, 381.0));
  assert.strictEqual(k.info('carBans'), 0.0);
});

// the wire: roam_core's report is the hub's line
test('race reports on the wire roam core and the hub agree', (t) => {
  const wasi = wasiSdk();
  if (wasi === null) {
    t.skip('no wasi-sdk in deps/: skipped');
    return;
  }
  const run = hubwire(wasi, 'roam_hubwire_racerep.wasm');
  const hexed = run(['racerep']);
  const d = unhex(hexed);
  assert.strictEqual(d.length, 16 + 64 + 4, hexed);
  const k = new Kit({});
  k.from(W(0), helloWith(0x1234abcd, { core: 5, name: 'Ann K.' }));
  k.from(W(0), d);
  assert.deepStrictEqual(k.lines, [
    '[race] lobby a1b2c3d4, race 0badf00d (sprint, track 4102, 1 lap, 3 cars): Ann K. (host) 2nd of 3 in 95.50 s; 350Z (type 22), ' +
      "class 2, rating 316.6 (the cars' average 280.5), 214 kW, 1450 kg, 249 km/h, power x1.250; stage 3; its lobby's stage limit; " +
      "past it as the host's friend or crew-mate",
  ]);
});

// a race that counted in the reporter's career (the report's credit byte, p[17]) says so at the end of its line
test('a race that counted in the career says so', () => {
  const k = new Kit({});
  k.from(W(0), helloWith(100, { core: 5, name: 'Ann' }));
  const d = racerep(100, 0xa3, 1, 2, 0, 239.3, 'PEUGOT', 64);
  // (the payload after the datagram's 16-byte header: its byte +17; then the CRC again, kit::dgram's way)
  d[16 + 17] = 2;
  recrc(d);
  k.from(W(0), d);
  const lines = k.lines.slice();
  assert.strictEqual(lines.length, 1, JSON.stringify(lines));
  assert.ok(lines[0].startsWith('[race] lobby 000000a3'), JSON.stringify(lines));
  assert.ok(lines[0].endsWith("power x1.000; a friend's win in the career"), JSON.stringify(lines));
});

function owner(c) {
  const o = ownerOfToken(c.repeat(43));
  assert.ok(o !== null);
  return o;
}

/**
 * a player that takes lobbies and reads the hub's crew marks (id 100 + i, browser W(i)), named name, of keyphrase
 * key, in crews, at (x, y)
 */
function put(k, i, name, key, crews, at) {
  const h = helloWith(100 + i, { core: 9, name, crews, flags: 0x0080 | HF_HUBCREW });
  const o = key === null ? null : owner(key);
  k.hub.frameFrom(W(i), frame(W(i), h), o);
  k.hub.frameFrom(W(i), frame(W(i), snap(100 + i, [at[0], at[1], 0.0])), o);
}

// A player a lobby lists far from its start is linked with its host when its own last ask to join (its JOIN's copy to
// the hub) was for that lobby, of any age: a friend the host invited joins from wherever it is.  One it lists that never
// asked is not (an advert may list anyone: the third security audit), nor one whose last ask was for another lobby.
// (every pair | the grid; the host's 4 links full of a crowd at its start)
test('a far player of a lobby is linked with its host only when it asked to join', () => {
  for (const [how, o] of ways()) {
    const k = new Kit({ ...o, degree: 4, awayM: 1e-9 });
    for (let i = 0; i < 7; i++) join(k, i, '', true);
    // 0 the host at the start; 1 to 4 a crowd 1 m from it, in a race; 5 far off (300 m), asked to join; 6 far off the other
    // way, asked to join another lobby
    const snaps = (k) => {
      k.from(W(0), snap(100, [0.0, 0.0, 0.0]));
      [[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0], [0.0, -1.0]].forEach((at, i) => k.from(W(1 + i), snapN(101 + i, [at[0], at[1], 0.0], 3, 1)));
      k.from(W(5), snap(105, [300.0, 0.0, 0.0]));
      k.from(W(6), snap(106, [-300.0, 0.0, 0.0]));
    };
    const linked = (k, a, b) => {
      assert.strictEqual(listed(k, a, b), listed(k, b, a), how + ': a link is listed at both ends');
      return listed(k, a, b);
    };
    k.from(W(5), lobby(105, 2, 0, 0xa0, 0x1111, 0, 0, 0, 6, [100]));
    k.from(W(6), lobby(106, 2, 0, 0xee, 0x1111, 0, 0, 0, 6, [100]));
    k.from(W(0), lobby(100, 1, 0, 0xa0, 0x1111, 0, 0, 0, 6, [100, 105, 106]));
    snaps(k);
    k.hub.tick();
    assert.ok(linked(k, 0, 5), how + ': the far player that asked to join');
    assert.ok(!linked(k, 0, 6), how + ': not the far one that asked for another lobby');
    // its ask long past (LOBBY_JOIN_MS): still in the lobby, still linked
    for (let n = 0; n < 4; n++) {
      k.step(2500.0);
      k.from(W(0), lobby(100, 1, 0, 0xa0, 0x1111, 0, 0, 0, 6, [100, 105, 106]));
      snaps(k);
      k.clear();
      k.hub.tick();
    }
    assert.ok(linked(k, 0, 5) && !linked(k, 0, 6), how + ': 10 s on, the same');
    assert.strictEqual(k.info('lobbyLinks'), 1.0, how + ': one link for the lobby');
    // 5 asks another lobby to join: no longer linked for this one
    k.from(W(5), lobby(105, 2, 0, 0xef, 0x1111, 0, 0, 0, 6, [100]));
    for (let n = 0; n < 4; n++) {
      k.step(2500.0);
      k.from(W(0), lobby(100, 1, 0, 0xa0, 0x1111, 0, 0, 0, 6, [100, 105, 106]));
      snaps(k);
      k.clear();
      k.hub.tick();
    }
    assert.ok(!linked(k, 0, 5), how + ': its last ask was for another lobby');
    assert.strictEqual(k.info('lobbyLinks'), 0.0, how + ': none for the lobby');
  }
});

const hex4 = (t) => '0x' + t.toString(16).padStart(4, '0');

// A lobby for its host's friends and crew-mates only (its advert's t: 0x8000 | 0x0040) is on the world map of its
// host, of the players it lists, of the host's friends (both ways) and crew-mates, and of nobody else; the same lobby
// without the bit, or with it but not 0x8000 (an older game's t is 0), is everyone's
test('a lobby for friends and crew is on their maps only', () => {
  const x = fnv1a('x crew');
  const k = new Kit({});
  put(k, 0, 'carl', 'C', [x], [0.0, 0.0]);
  put(k, 1, 'anna', 'A', [], [5.0, 0.0]);
  put(k, 2, 'dave', null, [fnv1a('y crew'), x], [10.0, 0.0]);
  put(k, 3, 'bob', 'B', [fnv1a('y crew')], [15.0, 0.0]);
  put(k, 4, 'eve', 'E', [], [20.0, 0.0]);
  put(k, 5, 'fred', 'F', [], [25.0, 0.0]);
  k.hub.friends(W(0), owner('C'), [owner('A'), owner('F')]);
  k.hub.friends(W(1), owner('A'), [owner('C')]);
  // (fred is on carl's list, carl not on fred's: a friend one way is none)
  k.hub.tick();
  const seen = (k, i) => {
    k.clear();
    k.from(W(i), mapreqBase(100 + i, 1, 2048, 0));
    const l = lobbies(k);
    return l.length > 0 && l[0][2].length !== 0;
  };
  const who = (k) => [0, 1, 2, 3, 4, 5].filter((i) => seen(k, i));
  const all = () => [0, 1, 2, 3, 4, 5];
  for (const [t, want] of [[0x8041, [0, 1, 2, 4]], [0x8001, all()], [0x0041, all()], [0, all()]]) {
    // (a browser's lobbies go with its map's answer once a second at most)
    k.step(1100.0);
    k.from(W(0), lobbyT(100, 1, 0, 0xc1, 0x1111, 0, 0, 0, 6, [100, 104], t));
    assert.deepStrictEqual(who(k), want, 't ' + hex4(t));
  }
});

// A lobby a player could not join is not on its world map (every lobby was, and players drove to ones that were not
// there for them): one on its way to the race, or full, is on its own players' maps only.  A career lobby's entry (its
// advert's t: 0x8000 | 0x0001) says so (0x80 on its state), and to its host's friends and crew-mates that its host is
// theirs (0x40): the game keeps it off the map of a player past its race's stage, as it keeps that one out, but theirs
test('a lobby one could not join is not on the map', () => {
  const x = fnv1a('x crew');
  const k = new Kit({});
  put(k, 0, 'carl', 'C', [x], [0.0, 0.0]);
  put(k, 1, 'anna', 'A', [], [5.0, 0.0]);
  put(k, 2, 'dave', 'D', [], [10.0, 0.0]);
  put(k, 3, 'bob', 'B', [], [15.0, 0.0]);
  put(k, 4, 'eve', null, [x], [20.0, 0.0]);
  k.hub.friends(W(0), owner('C'), [owner('D')]);
  k.hub.friends(W(2), owner('D'), [owner('C')]);
  k.hub.tick();
  // each player's map: the lobby's (players, state) when listed
  const maps = (k) =>
    [0, 1, 2, 3, 4].map((i) => {
      k.clear();
      k.from(W(i), mapreqBase(100 + i, 1, 2048, 0));
      const l = lobbies(k);
      const e = l.length > 0 ? l[0][2][0] : undefined;
      return e === undefined ? null : [e[3], e[5]];
    });
  // carl's lobby with anna in it: (state, most players, players, t), what each of carl, anna, dave, bob, eve sees
  const o = null;
  const open = (st) => [2, st];
  const cases = [
    [0, 6, [100, 101], 0x8000, [open(0), open(0), open(0), open(0), open(0)]],
    [1, 6, [100, 101], 0x8000, [open(1), open(1), o, o, o]],
    [2, 6, [100, 101], 0x8000, [open(2), open(2), o, o, o]],
    [0, 2, [100, 101], 0x8000, [open(0), open(0), o, o, o]],
    [0, 6, [100, 101], 0x8001, [open(0xc0), open(0x80), open(0xc0), open(0x80), open(0xc0)]],
    // (its host's stage limit, a lobby that does not count for it: the same; with its host's stage, 3, in bits 2-4)
    [0, 6, [100, 101], 0x8080, [open(0xc0), open(0x80), open(0xc0), open(0x80), open(0xc0)]],
    [0, 6, [100, 101], 0x8080 | (3 << 9), [open(0xcc), open(0x8c), open(0xcc), open(0x8c), open(0xcc)]],
  ];
  for (const [state, max, ids, t, want] of cases) {
    // (a browser's lobbies go with its map's answer once a second at most)
    k.step(1100.0);
    k.from(W(0), lobbyT(100, 1, 0, 0xc1, 0x1111, 0, 0, state, max, ids, t));
    assert.deepStrictEqual(maps(k), want, 'state ' + state + ', ' + ids.length + '/' + max + ', t ' + hex4(t));
  }
});

// A lobby for its host's friends and crew-mates only takes only them of the players near its start for its links
// first (nobody else may join it): a stranger and a friend at its start make two lobby links for an open lobby, one for
// that one
test('a lobby for friends and crew links only them at its start', () => {
  for (const [how, o] of ways()) {
    for (const [t, want] of [[0x8000, 2.0], [0x8040, 1.0]]) {
      const k = new Kit({ ...o, degree: 4 });
      put(k, 0, 'carl', 'C', [], [0.0, 0.0]);
      put(k, 1, 'anna', 'A', [], [10.0, 0.0]);
      put(k, 2, 'bob', 'B', [], [5.0, 0.0]);
      k.hub.friends(W(0), owner('C'), [owner('A')]);
      k.hub.friends(W(1), owner('A'), [owner('C')]);
      k.from(W(0), lobbyT(100, 1, 0, 0xc1, 0x1111, 0, 0, 0, 6, [100], t));
      k.hub.tick();
      assert.strictEqual(k.info('lobbyLinks'), want, how + ': t ' + hex4(t));
    }
  }
});

// hosted: the lobby a browser's player hosts, as its last advert had it, while it is fresh and open (full or not);
// none for a browser that hosts none (one in another's lobby), a lobby starting, or an advert gone stale
test('hosted is the open lobby a browser hosts', () => {
  const k = new Kit({});
  const red = fnv1a('red');
  const h = helloWith(100, { core: 9, room: red, flags: 0x0080 });
  k.from(W(0), h);
  join(k, 1, 'red', true);
  k.from(W(0), lobby(100, 1, 0, 0xa0, 0x1111, 0, 0, 0, 6, [100, 101]));
  const want = { host: 100, lobby: 0xa0, race: 0x1111, n: 2, max: 6, room: red };
  assert.deepStrictEqual(k.hub.hosted(W(0)), want);
  assert.strictEqual(k.hub.hosted(W(1)), null, 'its player is in it, not hosting it');
  assert.strictEqual(k.hub.hosted(W(9)), null, 'no such browser');
  k.from(W(0), lobby(100, 1, 0, 0xa0, 0x1111, 0, 0, 0, 2, [100, 101]));
  const hh = k.hub.hosted(W(0));
  assert.deepStrictEqual(hh === null ? null : [hh.n, hh.max], [2, 2], 'full: still its lobby (the invite says full)');
  k.from(W(0), lobby(100, 1, 0, 0xa0, 0x1111, 0, 0, 1, 6, [100, 101]));
  assert.strictEqual(k.hub.hosted(W(0)), null, 'starting');
  k.from(W(0), lobby(100, 1, 0, 0xa0, 0x1111, 0, 0, 0, 6, [100, 101]));
  k.step(3100.0);
  assert.strictEqual(k.hub.hosted(W(0)), null, 'stale');
  k.from(W(0), lobby(100, 1, 0, 0xa0, 0x1111, 0, 0, 0, 6, [100, 101]));
  k.from(W(0), lobby(100, 5, 0, 0xa0, 0x1111, 0, 0, 0, 6, []));
  assert.strictEqual(k.hub.hosted(W(0)), null, 'closed');
});
