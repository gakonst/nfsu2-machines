// A port of web/server-rs/crates/roam/tests/roam_hub.rs: free roam's hub, what it links, what it reads and sends.
// 1. the wire: what runtime/roam_core.c sends the hub (HELLO, SNAP, BYE, encoded by the C core built for wasm,
//    web/test/roam_hubwire.c) is what the hub reads, and the hub's PEERS lists decode in the C core (skipped, as the
//    Rust skips them, without a wasi-sdk in deps/);
// 2. the links: nearest first, both ends of a link list each other, at most the degree (32) per player, rooms apart,
//    stale positions out, links kept at the edge, BYE and departures forgotten, the limits per address;
// 3. the hub on its thread, its busy measure the runtime's workers (no threads here: what of it does not need them).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Kit, V, ip, fnv1a, roomHash, helloWith, hello, snapN, snap, snapMoving, bye, framePorts, frame, peersOf, crewMarks, lists, ways, HF_CREW } from './kit.mjs';
import { Hub, ROAM_HUB_VIP, RoamHub, decodeRoam, encodePeers } from '../../src/roam/hub.js';
import { ownerOfToken } from '../../src/claims/claims.js';

/** the repository (web/worker/test/roam/../../../..) */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function repo(...p) {
  return path.join(REPO, ...p);
}

// the hub's address is net_proto.h's and proto.ts's NET_ROAM_HUB
test("the hub's address is net_proto.h's and proto.ts's NET_ROAM_HUB", () => {
  const h = fs.readFileSync(repo('runtime/web/net_proto.h'), 'utf8');
  const ts = fs.readFileSync(repo('web/src/net/proto.ts'), 'utf8');
  // /#define NET_ROAM_HUB\s+0x([0-9A-Fa-f]+)u/ and /NET_ROAM_HUB = 0x([0-9a-f]+)/
  const hexAfter = (s, pat) => {
    const i = s.indexOf(pat);
    assert.ok(i >= 0, pat);
    const rest = s.slice(i + pat.length).trimStart();
    assert.ok(rest.startsWith('0x'), '0x');
    const digits = /^[0-9A-Fa-f]*/.exec(rest.slice(2))[0];
    const v = parseInt(digits, 16);
    assert.ok(Number.isInteger(v), 'hex');
    return v >>> 0;
  };
  assert.equal(hexAfter(h, '#define NET_ROAM_HUB'), ROAM_HUB_VIP);
  assert.equal(hexAfter(ts, 'NET_ROAM_HUB ='), ROAM_HUB_VIP);
});

function hex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function unhex(s) {
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    assert.ok(Number.isInteger(v), 'hex');
    out[i] = v;
  }
  return out;
}

// the C core's version (roam_core.h RC_CORE_VER), which its HELLO says
function cCoreVer() {
  const hdr = fs.readFileSync(repo('runtime/roam_core.h'), 'utf8');
  const l = hdr.split('\n').find((l) => l.startsWith('#define RC_CORE_VER'));
  const v = l === undefined ? NaN : Number(l.slice('#define RC_CORE_VER'.length).trim().split(/\s+/)[0]);
  assert.ok(Number.isInteger(v), 'RC_CORE_VER');
  return v;
}

/** the newest wasi-sdk in deps/, or null */
function wasiSdk() {
  try {
    const d = repo('deps');
    const v = fs.readdirSync(d).filter((n) => n.startsWith('wasi-sdk-')).map((n) => path.join(d, n));
    v.sort();
    return v.length ? v[v.length - 1] : null;
  } catch {
    return null;
  }
}

/**
 * web/test/roam_hubwire.c with roam_core.c, built for wasm into file (each test its own), and the way to run it under
 * node, its output trimmed; null without a wasi-sdk in deps/ (the test is skipped; node is what runs this)
 */
function hubwire(file) {
  const wasi = wasiSdk();
  if (wasi === null) return null;
  const w = path.join(os.tmpdir(), file);
  const out = spawnSync(
    path.join(wasi, 'bin/clang'),
    [
      '--target=wasm32-wasip1-threads', '-pthread', '-O2', '-ffp-contract=off', '-Iruntime', '-o', w,
      'web/test/roam_hubwire.c', 'runtime/roam_core.c',
      '-Wl,--import-memory,--export-memory,--shared-memory,--initial-memory=67108864,--max-memory=268435456',
    ],
    { cwd: REPO, encoding: 'utf8' },
  );
  assert.ok(!out.error, 'clang: ' + out.error);
  assert.equal(out.status, 0, 'clang: ' + out.stderr);
  return (args) => {
    const o = spawnSync(process.execPath, [repo('web/test/wasi-run.mjs'), w, ...args], { encoding: 'utf8' });
    assert.ok(!o.error, 'node: ' + o.error);
    return o.stdout.trim();
  };
}

const NO_WASI = 'no wasi-sdk in deps/, or no node: skipped';

// the wire: what roam_core sends the hub reads, and its PEERS lists decode in roam_core
test("the wire what roam core sends the hub reads and its peers lists decode in roam core", (t) => {
  const run = hubwire('roam_hubwire.wasm');
  if (run === null) {
    t.skip('no wasi-sdk in deps/: skipped');
    return;
  }
  const [h, s, b] = [unhex(run(['hello'])), unhex(run(['snap'])), unhex(run(['bye']))];
  const core = cCoreVer();
  assert.deepEqual(decodeRoam(h), { type: 'hello', sender: 0x1234abcd, core, status: 2, room: fnv1a('blue'), name: 'Ann K.', crews: [] });
  assert.deepEqual(
    helloWith(0x1234abcd, { room: fnv1a('blue'), name: 'Ann K.', seen: [0x11, 0x22], core }),
    h,
    "this test's HELLO = the C core's, byte for byte",
  );
  assert.deepEqual(decodeRoam(s), { type: 'snap', sender: 0x1234abcd, status: 2, p: [1695.25, -883.5, 24.125] }, "the newest state's position");
  assert.deepEqual(decodeRoam(b), { type: 'bye', sender: 0x1234abcd });
  const bad = h.slice();
  bad[20] ^= 1;
  assert.equal(decodeRoam(bad), null, 'a wrong CRC is no datagram');
  const peers = encodePeers(0xb0b, 9, [
    { vip: ip('10.77.0.5'), port: 47210, id: 3 },
    { vip: ip('10.77.0.6'), port: 47300, id: 0xdeadbeef },
  ]);
  assert.equal(run(['peers', hex(peers)]), 'ok 2 10.77.0.5:47210:3 10.77.0.6:47300:' + 0xdeadbeef);
  assert.equal(run(['peers', hex(encodePeers(0xb0b, 10, []))]), 'ok 0', 'an empty list (the hub is there)');
});

// the wire: a session's HELLO to the hub as roam_core makes it (rc_tick's, fill_hello: the ids of the two players the
// hub listed, who said hello, then its two crews from its config) names its crews; they are the room hashes the page
// makes (players.ts roomHash, players.test.mjs's 0x160fba32 for "Blue Room") and this test's; the hub links that
// player in a crowd with a crew-mate 2 km off (a HELLO made here) first, and not one of another crew
test("the wire a session's hello to the hub names its crews", (t) => {
  const [blue, owls] = [roomHash('Blue Room'), roomHash('Night Owls')];
  // capitals and blanks do not count, a name of blanks is none (these need no C core: checked before the skip)
  assert.deepEqual([blue, roomHash('blueroom'), roomHash(' Blue Room\t'), roomHash('BLUE ROOM')], [0x160fba32, 0x160fba32, 0x160fba32, 0x160fba32]);
  assert.deepEqual([roomHash('night owls'), fnv1a('nightowls')], [owls, owls]);
  assert.deepEqual([roomHash(''), roomHash(' \t\r\n')], [0, 0]);
  const run = hubwire('roam_hubwire_crew.wasm');
  if (run === null) {
    t.skip(NO_WASI + ' (the room hashes checked)');
    return;
  }
  const h = unhex(run(['hellocrew']));
  // the crew flag, the ids it hears (the hub's list), then its crews
  assert.ok(h.length > 30 && ((h[14] | (h[15] << 8)) & HF_CREW) !== 0, 'the crew flag: ' + hex(h));
  const nl = h[28];
  const at = (o) => (h[o] | (h[o + 1] << 8) | (h[o + 2] << 16) | (h[o + 3] << 24)) >>> 0;
  const ids = [];
  for (let k = 0; k < h[29 + nl]; k++) ids.push(at(30 + nl + 4 * k));
  assert.deepEqual(ids, [0x11, 0x22], 'the ids it hears: ' + hex(h));
  const m = decodeRoam(h);
  assert.ok(m && m.type === 'hello', 'not its HELLO: ' + JSON.stringify(m) + ' (' + hex(h) + ')');
  assert.deepEqual([m.sender, m.status, m.crews], [0x1234abcd, 2, [blue, owls]]);
  // that player (V(0)) in a crowd of 60 within 15 m, and V(61) 2 km off in "Night Owls" or in "Red"
  for (const [crew, want] of [[owls, true], [roomHash('Red'), false]]) {
    const k = new Kit({ viewM: 1e-9 });
    k.from(V(0), h);
    k.from(V(0), snap(0x1234abcd, [0.25, 0.25, 0.0]));
    for (let i = 1; i <= 60; i++) {
      k.from(V(i), helloWith(100 + i, { core: 6 }));
      k.from(V(i), snap(100 + i, [((i - 1) % 8) * 3.0 - 9.25, Math.floor((i - 1) / 8) * 3.0 - 9.25, 0.0]));
    }
    k.from(V(61), helloWith(161, { core: 6, crews: [crew] }));
    k.from(V(61), snap(161, [2000.25, 0.25, 0.0]));
    k.hub.tick();
    const l = new Lists(k.lists());
    l.bothEnds();
    assert.deepEqual([l.has(0, 61), l.of(0).length], [want, 32], 'crew 0x' + crew.toString(16) + ': the crew-mate linked, the links full');
    assert.equal(k.info('crewLinks'), want ? 1.0 : 0.0);
    assert.deepEqual(k.hub.inCrews([blue, owls]), [1, 1 + (want ? 1 : 0)]);
  }
});

// the wire: a session that wants 40 links (rc_config.links, its game's Players' cars shown) says so after its crews,
// and in a crowd of 60 that want 48 the hub links it with 40; one that says nothing gets 32, as a core before version 10
test("the wire a session's hello to the hub says the links it wants", (t) => {
  const run = hubwire('roam_hubwire_links.wasm');
  if (run === null) {
    t.skip(NO_WASI);
    return;
  }
  for (const [arg, want] of [['40', 40], [null, 32]]) {
    const h = unhex(run(arg === null ? ['hellocrew'] : ['hellocrew', arg]));
    const k = new Kit({ viewM: 1e-9 });
    k.from(V(0), h);
    k.from(V(0), snap(0x1234abcd, [0.25, 0.25, 0.0]));
    for (let i = 1; i <= 60; i++) {
      k.from(V(i), helloWith(100 + i, { core: 10, links: 48 }));
      k.from(V(i), snap(100 + i, [((i - 1) % 8) * 3.0 - 9.25, Math.floor((i - 1) / 8) * 3.0 - 9.25, 0.0]));
    }
    k.hub.tick();
    const l = new Lists(k.lists());
    l.bothEnds();
    assert.equal(l.of(0).length, want, String(arg));
    const m = decodeRoam(h);
    assert.ok(m && m.type === 'hello', 'not its HELLO: ' + JSON.stringify(m));
    assert.deepEqual([m.core, m.crews.length], [cCoreVer(), 2], 'its crews still read');
  }
});

// the wire: a session in an outrun (rc_set_duel) names its other player after the links it wants; in a crowd of 60
// nearer to it than that player (2 km off), the hub links the two first once that one names it back, and not before
test("the wire a session's hello to the hub names its outrun's other player", (t) => {
  const run = hubwire('roam_hubwire_duel.wasm');
  if (run === null) {
    t.skip(NO_WASI);
    return;
  }
  const h = unhex(run(['hellocrew', '40', 'a1']));
  const none = unhex(run(['hellocrew', '40']));
  assert.equal(h.length, none.length + 4, 'four bytes more: ' + hex(h));
  assert.deepEqual(Array.from(h.slice(h.length - 8, h.length - 4)), [0xa1, 0, 0, 0], 'the id last, before the CRC: ' + hex(h));
  assert.equal(h[h.length - 9], 40, 'after the links it wants');
  for (const back of [0, 0x1234abcd]) {
    const k = new Kit({ viewM: 1e-9 });
    k.from(V(0), h);
    k.from(V(0), snap(0x1234abcd, [0.25, 0.25, 0.0]));
    for (let i = 1; i <= 60; i++) {
      k.from(V(i), helloWith(100 + i, { core: 10, links: 48 }));
      k.from(V(i), snap(100 + i, [((i - 1) % 8) * 3.0 - 9.25, Math.floor((i - 1) / 8) * 3.0 - 9.25, 0.0]));
    }
    k.from(V(61), helloWith(0xa1, { core: 11, links: 40, duel: back }));
    k.from(V(61), snap(0xa1, [2000.25, 0.25, 0.0]));
    k.hub.tick();
    const l = new Lists(k.lists());
    l.bothEnds();
    assert.deepEqual([l.has(0, 61), l.of(0).length], [back !== 0, 40], 'named back: 0x' + back.toString(16));
  }
});

// the hub's crew marks as the C core takes them: a session's own HELLO and four players near it, in its "Night Owls",
// in "Red", in its "Blue Room", in none; the list the hub makes for it, given to a session in those two crews, colours
// each player as the hub marked it (rc_peer_crew), and names no crew but the session's own; with friends (the
// server's friends lists: the session's keyphrase and the one in "Red", and the one in none), it marks those two as
// its friends (rc_peer_friend), the crew-mate's crew kept
test("the wire the hub's crew marks colour a session's peers", (t) => {
  const run = hubwire('roam_hubwire_marks.wasm');
  if (run === null) {
    t.skip(NO_WASI);
    return;
  }
  const h = unhex(run(['hellocrew']));
  const [blue, owls, red] = [roomHash('Blue Room'), roomHash('Night Owls'), roomHash('Red')];
  const key = (c) => {
    const o = ownerOfToken(c.repeat(43));
    assert.notEqual(o, null);
    return o;
  };
  for (const friends of [false, true]) {
    const k = new Kit({ viewM: 1e-9 });
    const owners = [key('A'), null, key('C'), null, key('E')];
    if (friends) {
      k.hub.friends(V(0), key('A'), [key('C'), key('E')]);
      k.hub.friends(V(2), key('C'), [key('A')]);
      k.hub.friends(V(4), key('E'), [key('A')]);
    }
    k.hub.frameFrom(V(0), frame(V(0), h), owners[0]);
    k.hub.frameFrom(V(0), frame(V(0), snap(0x1234abcd, [0.25, 0.25, 0.0])), owners[0]);
    const who = [[owls], [red], [red, blue], null];
    who.forEach((crews, i0) => {
      const i = i0 + 1;
      const o = owners[i];
      k.hub.frameFrom(V(i), frame(V(i), helloWith(100 + i, { crews })), o);
      k.hub.frameFrom(V(i), frame(V(i), snap(100 + i, [i * 10.0 + 0.25, 0.25, 0.0])), o);
    });
    k.hub.tick();
    const found = k.sent.find(([vip]) => vip === V(0));
    assert.ok(found, "the session's list");
    const f = found[1];
    const cm = crewMarks(f);
    assert.deepEqual(cm === null ? null : cm[0], [blue, owls], 'its own crews, and no other: ' + hex(f.subarray(16)));
    const want = (e) => {
      const i = [0, 1, 2, 3].find((i) => V(i + 1) === e.vip);
      const crew = i === 0 ? 1 : i === 2 ? 0 : -1;
      return String(crew) + (friends && (i === 1 || i === 3) ? 'f' : '');
    };
    const list = peersOf(f);
    assert.equal(list.length, 4);
    const expect = list.map((e) => (e.vip >>> 24) + '.' + ((e.vip >>> 16) & 255) + '.' + ((e.vip >>> 8) & 255) + '.' + (e.vip & 255) + ':' + e.port + ':' + want(e));
    assert.equal(
      run(['hubcrew', hex(f.subarray(16))]),
      'ok ' + expect.join(' '),
      'friends ' + friends + ": the session's crews and friends by the hub's marks",
    );
    const r = [red & 255, (red >>> 8) & 255, (red >>> 16) & 255, red >>> 24];
    let any = false;
    for (let o = 0; o + 4 <= f.length; o++) if (f[o] === r[0] && f[o + 1] === r[1] && f[o + 2] === r[2] && f[o + 3] === r[3]) any = true;
    assert.ok(!any, "no crew of another player's on its list");
  }
});

/** the lists by player i (10.77.0.(10 + i), port 47210) */
class Lists {
  constructor(m) {
    this.m = m;
  }
  of(i) {
    return this.m.get(V(i) + ':47210') ?? [];
  }
  ofVip(vip) {
    return this.m.get(vip + ':47210') ?? [];
  }
  has(i, j) {
    return this.of(i).some((e) => e.vip === V(j));
  }
  /** every link listed at both ends */
  bothEnds() {
    for (const [k, l] of this.m) {
      for (const e of l) {
        assert.ok(this.ofVip(e.vip).some((x) => x.vip + ':47210' === k), k + ': its links list it too');
      }
    }
  }
}

// links at a degree of 7 (every pair | the grid): the nearest, both ends, at most 7 a player, only in free roam
// lately, rooms apart
test('links the nearest both ends at most the degree only in free roam lately rooms apart', () => {
  for (const [how, o] of ways()) {
    const k = new Kit({ ...o, degree: 7 });
    // 20 players on a line 10 m apart, one far away, two in another room, one with no position yet
    for (let i = 0; i < 20; i++) {
      k.from(V(i), hello(100 + i));
      k.from(V(i), snap(100 + i, [i * 10.0, 0.0, 0.0]));
    }
    k.from(V(20), hello(120));
    k.from(V(20), snap(120, [5000.0, 0.0, 0.0]));
    for (const i of [21, 22]) {
      k.from(V(i), helloWith(100 + i, { room: fnv1a('red') }));
      k.from(V(i), snap(100 + i, [i, 0.0, 0.0]));
    }
    k.from(V(23), hello(123));
    k.hub.tick();
    const l = new Lists(k.lists());
    assert.equal(l.m.size, 24, how + ': every player gets a list, an empty one too');
    for (let i = 0; i < 24; i++) {
      assert.ok(l.of(i).length <= 7, how + ': player ' + i + ': at most 7 (' + l.of(i).length + ')');
    }
    l.bothEnds();
    assert.ok(l.has(0, 1) && l.has(10, 9) && l.has(10, 11), how + ': neighbours on the line are linked');
    for (let i = 5; i < 15; i++) {
      for (const e of l.of(i)) {
        assert.ok(Math.abs(e.vip - V(i)) <= 4, how + ': player ' + i + ': its links are the nearest');
      }
    }
    assert.ok(l.has(19, 20) || l.of(20).length > 0, how + ': the far one is linked to somebody');
    assert.ok(l.has(21, 22) && l.of(21).length === 1, how + ': another room: only each other');
    assert.equal(l.of(23).length, 0, how + ': no position yet: no links');
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 20; j++) {
        if (i !== j && l.of(i).length < 7 && l.of(j).length < 7) {
          assert.ok(l.has(i, j), how + ': ' + i + ' and ' + j + ' both have room, so they are linked');
        }
      }
    }
    // a position older than 60 s: no links (one in a shop keeps them until then)
    k.clear();
    k.step(30000.0);
    for (let i = 1; i < 23; i++) {
      k.from(V(i), hello(100 + i));
      k.from(V(i), snap(100 + i, i === 1 ? [10.0, 0.0, 0.0] : [i * 10.0, 0.0, 0.0]));
    }
    k.from(V(0), hello(100));
    k.hub.tick();
    assert.ok(new Lists(k.lists()).of(0).length > 0, how + ': 30 s without a SNAP: still linked');
    k.clear();
    k.step(31000.0);
    for (let i = 0; i < 23; i++) {
      k.from(V(i), hello(100 + i));
    }
    for (let i = 1; i < 23; i++) {
      k.from(V(i), snap(100 + i, [i * 10.0, 0.0, 0.0]));
    }
    k.hub.tick();
    assert.equal(new Lists(k.lists()).of(0).length, 0, how + ': 61 s without a SNAP: no links');
  }
});

// links at the default degree (every pair | the grid): at most 32 a player
test('links at most 32 a player', () => {
  for (const [how, o] of ways()) {
    const k = new Kit(o);
    // 50 players on a line 10 m apart
    for (let i = 0; i < 50; i++) {
      k.from(V(i), hello(100 + i));
      k.from(V(i), snap(100 + i, [i * 10.0, 0.0, 0.0]));
    }
    k.hub.tick();
    const l = new Lists(k.lists());
    for (let i = 0; i < 50; i++) {
      assert.ok(l.of(i).length <= 32, how + ': player ' + i + ': at most 32 (' + l.of(i).length + ')');
    }
    l.bothEnds();
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < 50; j++) {
        if (i !== j && l.of(i).length < 32 && l.of(j).length < 32) {
          assert.ok(l.has(i, j), how + ': ' + i + ' and ' + j + ' both have room, so they are linked');
        }
      }
    }
    assert.ok(l.of(25).length > 16, how + ': more than 16 (' + l.of(25).length + ')');
  }
});

// links stay put at the edge, players come and go (every pair | the grid)
test('links stay put at the edge players come and go', () => {
  for (const [how, o] of ways()) {
    const k = new Kit({ ...o, degree: 1 });
    // A at 0, B at 100: linked; C comes 10 m from A: a link stays its first 5 s
    const at = (k, i, x) => {
      k.from(V(i), hello(200 + i));
      k.from(V(i), snap(200 + i, [x, 0.0, 0.0]));
    };
    const first = (k) => new Lists(k.lists()).of(0)[0].vip;
    at(k, 0, 0.0);
    at(k, 1, 100.0);
    k.hub.tick();
    assert.equal(first(k), V(1), how);
    k.clear();
    k.step(1000.0);
    at(k, 0, 0.0);
    at(k, 1, 100.0);
    at(k, 2, -10.0);
    k.hub.tick();
    assert.equal(first(k), V(1), how + ': a link stays at least 5 s');
    // after that it counts as half its distance: 60 m does not beat a linked 100 m, 40 m does
    k.clear();
    k.step(5000.0);
    at(k, 0, 0.0);
    at(k, 1, 100.0);
    at(k, 2, -60.0);
    k.hub.tick();
    assert.equal(first(k), V(1), how + ': 60 m does not beat a linked 100 m');
    k.clear();
    k.step(1000.0);
    at(k, 0, 0.0);
    at(k, 1, 100.0);
    at(k, 2, -40.0);
    k.hub.tick();
    assert.equal(first(k), V(2), how + ': under half the distance: the link moves');
    // BYE, silence, a departure from the switch
    assert.deepEqual(k.hub.vips(), new Set([V(0), V(1), V(2)]), how + ": the browsers in free roam (the server's console)");
    k.from(V(2), bye(202));
    assert.equal(k.info('players'), 2.0, how + ': BYE: forgotten at once');
    k.step(7000.0);
    at(k, 0, 0.0);
    k.hub.tick();
    assert.equal(k.info('players'), 1.0, how + ': 6 s without a word: forgotten');
    assert.deepEqual(k.hub.vips(), new Set([V(0)]));
    k.hub.peerGone(V(0));
    assert.equal(k.info('players'), 0.0, how + ': left the switch: forgotten');
  }
});

// limits: three endpoints a browser (co-op's two players and a restart's), a player starts with its HELLO, bad
// datagrams counted
test('limits three endpoints a browser a player starts with its hello bad datagrams counted', () => {
  const k = new Kit({});
  for (const port of [47210, 47211, 47212, 47213]) {
    k.hub.frame(V(0), framePorts(V(0), hello(300 + port), port, 47210));
  }
  assert.equal(k.info('players'), 3.0);
  assert.equal(k.info('refused'), 1.0);
  k.from(V(1), snap(301, [0.0, 0.0, 0.0]));
  assert.equal(k.info('players'), 3.0, 'a SNAP before any HELLO: nobody new');
  k.hub.frame(V(1), new TextEncoder().encode('nonsense, not a frame at all'));
  const f = frame(V(1), hello(301));
  f[30] ^= 0xff;
  k.hub.frame(V(1), f);
  assert.equal(k.info('bad'), 2.0);
  const far = frame(V(1), snap(301, [1e6, 0.0, 0.0]));
  k.from(V(1), hello(301));
  k.hub.frame(V(1), far);
  assert.equal(k.info('bad'), 3.0, 'a position out of the map: refused');
});

// in free roam (/players' roam): the browsers driving there or paused there, as their last HELLO or SNAP says, each
// once whatever its endpoints; in a race, a shop, the menus or loading, not
test('in free roam driving or paused each browser once', () => {
  const k = new Kit({});
  // roam_core.h RC_ST_*: 0 menus, 1 loading, 2 free roam, 3 a race, 4 a shop, 5 paused
  for (let st = 0; st < 6; st++) {
    k.from(V(st), helloWith(400 + st, { status: st }));
  }
  assert.equal(k.hub.inRoam(), 2, 'free roam, and paused there');
  // another start of the game in the browser in free roam: a second endpoint
  k.hub.frame(V(2), framePorts(V(2), hello(500), 47211, 47210));
  assert.equal(k.hub.inRoam(), 2, 'a browser once');
  k.from(V(5), snapN(405, [0.0, 0.0, 0.0], 3, 1));
  assert.equal(k.hub.inRoam(), 1, 'a SNAP says the paused one went into a race');
  k.from(V(0), hello(400));
  assert.equal(k.hub.inRoam(), 2, 'out of the menus into free roam');
  k.from(V(2), bye(402));
  assert.equal(k.hub.inRoam(), 2, 'BYE from one endpoint: its other one is in free roam');
  k.hub.peerGone(V(2));
  assert.equal(k.hub.inRoam(), 1, 'left the switch');
});

// /players' room and rooms: in free roam by room (room 0, none, the main world, too), each browser once
test('in free roam by room', () => {
  const k = new Kit({});
  const [blue, red] = [fnv1a('blue'), fnv1a('red')];
  k.from(V(1), helloWith(601, { room: blue }));
  k.from(V(2), helloWith(602, { room: blue, status: 5 }));
  k.from(V(3), helloWith(603, { room: blue, status: 3 }));
  k.from(V(4), helloWith(604, { room: red }));
  k.from(V(5), hello(605));
  k.hub.frame(V(1), framePorts(V(1), helloWith(606, { room: blue }), 47211, 47210));
  const rooms = k.hub.inRooms();
  assert.deepEqual(
    [rooms.get(blue), rooms.get(red), rooms.get(0), rooms.size],
    [2, 1, 1, 3],
    'driving or paused, a browser once: ' + JSON.stringify([...rooms]),
  );
  assert.equal(k.hub.inRoam(), 4);
});

// a player that comes and goes, HELLO and BYE over and over (a client may send the hub 2500 frames a second), costs the
// hub little: a player gone is taken out of the others' links once in a while, for many at once, not with every BYE
// (each walked every player's links: 2000 players' 64,000)
test('a player that comes and goes costs the hub little', (t) => {
  const k = new Kit({});
  const v = (i) => (0x0a4d0100 + i) >>> 0;
  const crowd = (k) => {
    for (let i = 0; i < 2000; i++) {
      k.from(v(i), hello(1000 + i));
      k.from(v(i), snap(1000 + i, [(i % 50) * 20.0, Math.floor(i / 50) * 20.0, 0.0]));
    }
  };
  crowd(k);
  let t0 = performance.now();
  k.hub.tick();
  const tick = performance.now() - t0;
  const links = k.info('links');
  assert.ok(links > 30000.0, String(links));
  const x = v(3000);
  t0 = performance.now();
  for (let n = 0; n < 2000; n++) {
    const port = 47210 + (n % 2);
    k.hub.frame(x, framePorts(x, hello(50000 + n), port, 47210));
    if (n % 7 === 3) {
      // links of the crowd's own come and go too: Ann of the crowd leaves and is back at once
      k.from(v(n % 2000), bye(1000 + (n % 2000)));
      k.from(v(n % 2000), hello(1000 + (n % 2000)));
    }
    k.hub.frame(x, framePorts(x, bye(50000 + n), port, 47210));
  }
  const churn = performance.now() - t0;
  t.diagnostic('2000 comings and goings: ' + churn.toFixed(2) + ' ms; a tick of 2000 players: ' + tick.toFixed(2) + ' ms');
  assert.ok(churn < tick, '2000 comings and goings took ' + churn + ' ms, longer than a whole tick (' + tick + ' ms)');
  // what they left: the crowd, and the links of those that were not back as new players
  assert.equal(k.info('players'), 2000.0);
  const left = k.hub.links().reduce((a, [, l]) => a + l.length, 0) / 2.0;
  assert.equal(k.info('links'), left, 'info() counts the links listed');
  assert.ok(left < links, "the ones that went are out of the others' links");
  const names = new Set(k.hub.links().map(([n]) => n));
  assert.ok(k.hub.links().every(([, l]) => l.every((n) => names.has(n))), 'no link to a player gone');
  // and the next tick links the crowd as before
  k.step(1000.0);
  crowd(k);
  k.hub.tick();
  assert.ok(k.info('links') > 30000.0);
});

// 64 players in one place, at a degree of 7 | 32: each list at most that, the tick stays cheap
test('sixty four players in one place each list at most its degree the tick stays cheap', (t) => {
  for (const most of [7, 32]) {
    const k = new Kit({ degree: most });
    for (let i = 0; i < 64; i++) {
      const v = ip('10.77.0.' + (2 + i));
      k.from(v, hello(400 + i));
      k.from(v, snap(400 + i, [Math.cos(i) * 30.0, Math.sin(i) * 30.0, 0.0]));
    }
    for (let n = 0; n < 20; n++) {
      k.hub.tick();
    }
    const l = lists(k.sent.slice(k.sent.length - 64));
    const n = [...l.values()].map((l) => l.length);
    assert.ok(n.every((x) => x <= most) && n.filter((x) => x === most).length >= 60, 'lists of ' + most + ' (' + JSON.stringify(n) + ')');
    t.diagnostic('64 players at a degree of ' + most + ': ' + k.info('links') + ' links, tick at most ' + k.info('tickMsMax').toFixed(2) + ' ms');
    assert.ok(k.info('tickMsMax') < 50.0);
  }
});

// a panic in a tick (a bug: here the switch's send, halfway through the lists) leaves a hub that goes on: its thread
// catches the panic, and the next ticks link everyone and send every list
test('a panic in a tick leaves a hub that goes on', () => {
  // the last tick's lists of a hub whose send panics at its panicAt-th list (null: never)
  const run = (exactRoom, panicAt) => {
    const sent = [];
    let t = 1000000.0;
    let n = 0;
    const hub = new Hub(
      { exactRoom },
      {
        now: () => t,
        busy: () => 0.0,
        log: () => {},
        send: (vip, f) => {
          const c = n++;
          if (c === panicAt) throw new Error('a bug in the middle of a tick');
          sent.push([vip, f]);
          return true;
        },
        id: 0xb0b,
      },
    );
    const v = (i) => (0x0a4d0100 + i) >>> 0;
    for (let tick = 0; tick < 4; tick++) {
      for (let i = 0; i < 100; i++) {
        hub.frame(v(i), frame(v(i), hello(1000 + i)));
        hub.frame(v(i), frame(v(i), snap(1000 + i, [(i % 10) * 15.0, Math.floor(i / 10) * 15.0, 0.0])));
      }
      let err = false;
      try {
        hub.tick();
      } catch {
        err = true;
      }
      assert.equal(err, panicAt !== null && tick === 1, "the second tick's 51st list panics, nothing else");
      t += 1000.0;
    }
    assert.equal(hub.info().players, 100);
    return lists(sent.slice(sent.length - 100));
  };
  for (const exactRoom of [1000, 1]) {
    const last = run(exactRoom, 150);
    assert.equal(last.size, 100, "every player's list");
    const byVip = new Map([...last].map(([k, l]) => [Number(k.split(':')[0]) || 0, l]));
    const of = (vip) => {
      const l = byVip.get(vip);
      assert.ok(l !== undefined, 'a list of ' + vip);
      return l;
    };
    for (const [a, l] of byVip) {
      assert.ok(l.length <= 32 && l.every((e) => of(e.vip).some((x) => x.vip === a)), 'at most 32, both ends');
    }
    const open = [...byVip].filter(([, l]) => l.length < 32).map(([a]) => a);
    for (const a of open) {
      assert.ok(open.every((b) => a === b || of(a).some((e) => e.vip === b)), 'two with room are linked');
    }
    assert.deepEqual(last, run(exactRoom, null), 'the same lists as a hub that never panicked');
  }
});

// a list waiting in a slow player's queue keeps a block of 4 KiB at most (its own 357 bytes and its neighbours'), not
// every list of its tick (2000 players' lists were one buffer of 700 KB, kept whole for as long as any of them waited)
test('a list waiting holds little', () => {
  // (the lattice's links by distance alone: player 7 has 32)
  const k = new Kit(ways()[0][1]);
  for (let i = 0; i < 300; i++) {
    const v = (0x0a4d0100 + i) >>> 0;
    k.from(v, hello(1000 + i));
    k.from(v, snap(1000 + i, [(i % 20) * 10.0, Math.floor(i / 20) * 10.0, 0.0]));
  }
  k.hub.tick();
  const one = k.sent[7][1];
  // (Bytes::try_into_mut: no other list holds its block; here, no other list's frame is a view of its buffer)
  const shared = k.sent.some(([, f], i) => i !== 7 && f.buffer === one.buffer);
  k.clear();
  const len = one.length;
  assert.equal(len, 16 + 16 + 1 + 10 * 32 + 4, 'a list of 32');
  // (what it keeps: the rest of its block, from where it starts)
  assert.ok(!shared, 'its block is in other hands');
  const capacity = one.buffer.byteLength - one.byteOffset;
  assert.ok(capacity <= 4096, 'it keeps ' + capacity + ' bytes for a list of ' + len);
});

// a busy server: every player gets fewer links, and more again once it has room (every pair | the grid): the cap on
// the links a quarter down at most every 5 s to 8, nothing between 60 and 85 %, 2 up every 15 s
test('a busy server every player gets fewer links and more again once it has room', () => {
  for (const [way, o] of ways()) {
    const k = new Kit(o);
    k.busy = 0.95;
    // one second of the 40 players: the lists checked, then the cap and whether free roam counts as busy
    const second = (k) => {
      k.clear();
      for (let i = 0; i < 40; i++) {
        const v = ip('10.77.0.' + (2 + i));
        k.from(v, hello(500 + i));
        k.from(v, snap(500 + i, [Math.cos(i) * 30.0, Math.sin(i) * 30.0, 0.0]));
      }
      k.hub.tick();
      k.step(1000.0);
      const cap = k.info('cap');
      const l = new Lists(k.lists());
      const n = [...l.m.values()].map((l) => l.length);
      assert.ok(
        n.every((x) => x <= cap) && n.reduce((a, b) => a + b, 0) >= 0.9 * cap * n.length,
        way + ': lists of ' + cap + ' (' + JSON.stringify(n) + ')',
      );
      l.bothEnds();
      const open = [...l.m].filter(([, l]) => l.length < cap);
      for (const [a, la] of open) {
        for (const [b] of open) {
          if (a !== b) {
            assert.ok(la.some((x) => x.vip + ':47210' === b), way + ': two with room left: linked');
          }
        }
      }
      return [cap, k.hub.crowded()];
    };
    const caps = [], crowded = [];
    const seconds = (k, n) => {
      for (let i = 0; i < n; i++) {
        const [c, b] = second(k);
        caps.push(c);
        crowded.push(b);
      }
    };
    seconds(k, 30);
    assert.deepEqual([caps[0], caps[4], caps[5], caps[10], caps[15], caps[20], caps[29]], [24, 24, 18, 13, 9, 8, 8], way + ': ' + JSON.stringify(caps));
    k.busy = 0.7;
    seconds(k, 30);
    assert.ok(caps.slice(30, 60).every((c) => c === 8), way + ': between busyLow and busyHigh: as it is');
    k.busy = 0.2;
    seconds(k, 31);
    assert.deepEqual([caps[60], caps[74], caps[75], caps[90]], [10, 10, 12, 14], way + ': ' + JSON.stringify(caps.slice(60)));
    {
      const lines = k.lines;
      assert.equal(lines.length, 8, JSON.stringify(lines));
      assert.equal(lines[0], "[roam] the server's thread was 95 % busy: at most 24 links a player (was 32)");
    }
    assert.equal(k.info('capCuts'), 5.0);
    // busy for the start page's question (/players roamBusy) while the cap is under 24: from 18 down, until it is
    // 24 again
    seconds(k, 90);
    assert.ok(caps[caps.length - 1] > 24, way + ': ' + JSON.stringify(caps.slice(91)));
    assert.ok(crowded.every((c, i) => c === caps[i] < 24), way + ': ' + JSON.stringify(caps) + ' ' + JSON.stringify(crowded));
    const lastBusy = crowded.lastIndexOf(true);
    assert.ok(lastBusy >= 0);
    const back60 = caps.slice(60).indexOf(24);
    assert.ok(back60 >= 0);
    const back = 60 + back60;
    assert.deepEqual([crowded[4], crowded[5], lastBusy + 1 === back], [false, true, true], way);
  }
});

// 600 players in a city | a district | a crowd: the grid links as every pair does: a room larger than exactRoom,
// the grid's links against every pair's, for the same players (two rooms; a few far out):
// the same rules (at most the degree, both ends, no two with room left unlinked) and about the same distances
test('six hundred players the grid links as every pair does', (t) => {
  for (const [where, w] of [['a city', 8000.0], ['a district', 1500.0], ['a crowd', 100.0]]) {
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296.0;
    };
    const players = [];
    for (let i = 0; i < 600; i++) {
      let p;
      if (i % 97 === 5) {
        p = [15000.0 - i, -15000.0, 0.0];
      } else {
        const x = rnd() * w - w / 2.0;
        const y = rnd() * w - w / 2.0;
        p = [x, y, rnd() * 20.0];
      }
      players.push({ v: ip('10.77.' + (i & 7) + '.' + (2 + (i >> 3))), id: 700 + i, room: i % 10 === 3 ? fnv1a('red') : 0, p });
    }
    const run = (o) => {
      const k = new Kit(o);
      for (let n = 0; n < 3; n++) {
        k.clear();
        for (const q of players) {
          k.from(q.v, helloWith(q.id, { room: q.room }));
          k.from(q.v, snap(q.id, q.p));
        }
        k.hub.tick();
        k.step(1000.0);
      }
      return [new Lists(k.lists()), k.info('tickMsMax')];
    };
    const [all, allMs] = run({ exactRoom: 1000 });
    const [grid, gridMs] = run({});
    const at = new Map(players.map((q) => [q.v, q]));
    const d = (a, b) => Math.sqrt((a.p[0] - b.p[0]) ** 2 + (a.p[1] - b.p[1]) ** 2 + (a.p[2] - b.p[2]) ** 2);
    const sum = (l) => {
      let n = 0, m = 0.0;
      for (const q of players) {
        const lq = l.ofVip(q.v);
        assert.ok(lq.length <= 32, 'at most 32 (' + lq.length + ')');
        for (const e of lq) {
          assert.ok(l.ofVip(e.vip).some((x) => x.vip === q.v), 'both ends');
          assert.equal(at.get(e.vip).room, q.room, 'one room');
          n += 1;
          m += d(q, at.get(e.vip));
        }
      }
      const open = players.filter((q) => l.ofVip(q.v).length < 32);
      for (const a of open) {
        for (const b of open) {
          if (a.v !== b.v && a.room === b.room) {
            assert.ok(l.ofVip(a.v).some((e) => e.vip === b.v), 'two with room are linked');
          }
        }
      }
      return [n / 2.0, m / n];
    };
    const [aLinks, aMean] = sum(all);
    const [gLinks, gMean] = sum(grid);
    t.diagnostic(
      '600 players in ' + w + ' m (' + where + '): every pair ' + aLinks + ' links of ' + aMean.toFixed(1) + ' m (' + allMs.toFixed(0) +
        ' ms), the grid ' + gLinks + ' of ' + gMean.toFixed(1) + ' m (' + gridMs.toFixed(0) + ' ms)',
    );
    assert.ok(Math.abs(gLinks - aLinks) <= aLinks * 0.01, 'as many links');
    assert.ok(gMean <= aMean * 1.03, 'as near');
  }
});

/** two hubs' frames, tick after tick, byte for byte */
function sameSent(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      const [va, fa] = a[i][j], [vb, fb] = b[i][j];
      if (va !== vb || fa.length !== fb.length) return false;
      for (let k = 0; k < fa.length; k++) if (fa[k] !== fb[k]) return false;
    }
  }
  return true;
}

// 1500 players in a room of 2 km, driving (view points), a few not driving, 16, 32 or 48 links each, some coming and
// going: with their walks read on 4 threads, the hub sends what it sends with them read on its own thread, byte for
// byte, tick after tick (RoamOptions::link_threads; the option is here, its threads are not: the walks are read on
// the hub's own thread either way)
test("walks read on threads link as on the hub's own", () => {
  const run = (threads) => {
    const k = new Kit({ linkThreads: threads });
    let seed = 4242;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296.0;
    };
    const n = 1500;
    const vip = (i) => (0x0a4d0100 + i) >>> 0;
    const pos = [];
    for (let i = 0; i < n; i++) pos.push([rnd() * 2000.0 - 1000.0, rnd() * 2000.0 - 1000.0, rnd() * 10.0]);
    const vel = [];
    for (let i = 0; i < n; i++) vel.push([rnd() * 60.0 - 30.0, rnd() * 60.0 - 30.0, 0.0]);
    const sent = [];
    for (let tick = 0; tick < 6; tick++) {
      k.clear();
      for (let i = 0; i < n; i++) {
        // players 7 mod 13 go at the fourth tick
        if (i % 13 === 7 && tick >= 3) {
          continue;
        }
        const p = pos[i], v = vel[i];
        p[0] += v[0] * 0.5;
        p[1] += v[1] * 0.5;
        const status = i % 11 === 4 ? 3 : 2;
        const links = [16, 32, 48][i % 3];
        k.from(vip(i), helloWith(1000 + i, { core: 10, status, links }));
        k.from(vip(i), snapMoving(1000 + i, p, v, Math.atan2(v[1], v[0]), status));
      }
      k.hub.tick();
      sent.push(k.sent.slice());
      k.step(500.0);
    }
    return [sent, k.info('links')];
  };
  const [one, links] = run(1);
  // (pairs: about 32 a player, two players a pair)
  assert.ok(links > 1500.0 * 10.0, "a crowd's links (" + links + ')');
  assert.ok(sameSent(one, run(4)[0]), 'the same lists, byte for byte');
});

// ---- the hub on its thread (the idle hub, frames posted and its lists: tests/roam_thread.rs) ----

// on its thread in the server's runtime, the hub's busy measure is the runtime's workers' (they run the switch): with
// all of them busy the cap on the links comes down, few of the machine's cores as they may be (the process's CPU time
// over every core read 2 busy workers of 24 cores as 8 %, and the cap never moved)
test('on its thread busy workers cut the links', (t) => {
  // (no tokio runtime, no workers, no thread here: RoamHub is ticked by its caller, its busy measure the caller's
  // busy(); what is checked: with the server all busy, the cap comes down within 5 s of ticks every 250 ms)
  const lines = [];
  let busy = 1.0;
  const hub = new RoamHub({
    sw: { send: () => 'sent' },
    prng: { below: () => 0 },
    nowMs: 1000000.0,
    options: { tickMs: 250, log: (s) => lines.push(s), busy: () => busy },
  });
  let now = 1000000.0;
  const t0 = now;
  while (lines.length === 0) {
    assert.ok(now - t0 < 5000.0, 'the cap cut: not within 5 s');
    now = hub.nextTickMs();
    hub.tick(now);
  }
  busy = 0.0;
  hub.stop();
  const first = lines[0];
  assert.ok(first.endsWith('% busy: at most 48 links a player (was 64)'), first);
  t.skip("the runtime's workers' busy measure (a tokio runtime's threads) does not exist here: the cap cut checked with RoamHub's busy()");
});

test('on its thread a hub given up ends its thread', (t) => {
  // (no thread here: what was asked before the hub is given up still has its answer)
  const hub = new RoamHub({ sw: { send: () => 'sent' }, prng: { below: () => 0 }, nowMs: 1000000.0, options: { log: () => {} } });
  const info = hub.info();
  hub.stop();
  assert.ok(info !== null && typeof info === 'object' && info.players === 0);
  t.skip('no hub thread to end here (RoamHub is ticked by its caller): its answer checked');
});
