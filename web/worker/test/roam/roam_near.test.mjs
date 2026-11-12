// A port of web/server-rs/crates/roam/tests/roam_near.rs: the minimap's answer (NEARREQ / NEARD,
// runtime/roam_game.c near_update): the players of the asker's room in free roam within the radius it asks for, past
// itself and its links, the nearest it asks for, each where it is now, as what changed since the answer it holds, in
// one datagram; one answer a browser every 150 ms, fewer while the hub's thread is busy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join as pjoin, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Kit, bye, fnv1a, helloWith, nearreq, neardOf, snap, snapMoving } from './kit.mjs';

/** the repository's root (the Rust's CARGO_MANIFEST_DIR/../../../..) */
const REPO = pjoin(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** browser i's address, for more players than V's: 10.77.0.2 and on */
function W(i) {
  return (0x0a4d0002 + i) >>> 0;
}

/** a player of core version 4 (32 links) in room 0 */
function join(k, i) {
  k.from(W(i), helloWith(100 + i, { core: 4 }));
}

/** the NEARD datagrams the hub sent since the last clear: [vip, mapd] */
function nears(k) {
  return k.sent.map(([vip, f]) => [vip, neardOf(f)]).filter((x) => x[1] !== null);
}

/** the one NEARD answer sent since the last clear (one datagram: part 0 of 1): [req, base, total, entries] */
function nearAnswer(k) {
  const m = nears(k);
  assert.strictEqual(m.length, 1, 'one datagram');
  const [req, base, part, nparts, total, e] = m[0][1];
  assert.deepStrictEqual([part, nparts], [0, 1]);
  return [req, base, total, e];
}

// the players within the radius, past the one asking and its links; not those in a race, in another room, or farther;
// the nearest when it asks for fewer; a player alone gets one empty datagram, a stranger (no HELLO) nothing
test('the minimap shows the players within its radius', () => {
  const k = new Kit({ degree: 1 });
  for (let i = 0; i < 10; i++) join(k, i);
  k.from(W(10), helloWith(110, { room: fnv1a('blue') }));
  // player i at x = 30 i, heading a quarter turn (64); 10 (another room) right beside the one asking
  for (let i = 0; i <= 10; i++) {
    const status = i === 7 ? 3 : 2;
    const x = i === 10 ? 15.25 : i * 30.0 + 0.25;
    k.from(W(i), snapMoving(100 + i, [x, 3.75, 0.0], [0, 0, 0], Math.PI / 2, status));
  }
  k.hub.tick();
  k.clear();
  k.from(W(0), nearreq(100, 1, 64, 0, 200));
  // its link is 1 (the nearest); 7 races; 8 and 9 are past 200 m; 10 is in another room
  const want = [];
  for (let i = 2; i < 7; i++) want.push([i, [i * 30, 4, 64, 0, 0]]);
  assert.deepStrictEqual(nearAnswer(k), [1, 0, 5, want]);
  // the nearest two, for a page that asks for two (what it held goes)
  k.clear();
  k.step(200.0);
  k.from(W(0), nearreq(100, 2, 2, 1, 200));
  const [req, base, , e] = nearAnswer(k);
  assert.deepStrictEqual([req, base], [2, 1]);
  assert.deepStrictEqual(e, [[4, null], [5, null], [6, null]], '2 and 3 stay, the rest go');
  // a player alone in its room: one empty datagram; a stranger: nothing
  k.clear();
  k.from(W(10), nearreq(110, 1, 64, 0, 200));
  assert.deepStrictEqual(nearAnswer(k), [1, 0, 0, []]);
  k.clear();
  k.from(W(20), nearreq(120, 1, 64, 0, 200));
  assert.ok(nears(k).length === 0);
});

// what changed since the answer the page holds: a car going straight stays where the page moves it on, one that
// turned 3 m off (past the minimap's 2 m) is placed again, one gone goes, one standing never comes again
test('the minimap sends what changed', () => {
  const k = new Kit({ degree: 1 });
  for (let i = 0; i < 6; i++) join(k, i);
  // 0 asks; 1 its link; 2 stands; 3 drives east at 20 m/s; 4 too, then turns; 5 is to go
  const at = (i, t) => {
    if (i === 3) return [[60.0 + 20.0 * t, 0.0, 0.0], [20.0, 0.0, 0.0]];
    if (i === 4 && t > 0.0) return [[80.0 + 20.0 * t, 3.0, 0.0], [20.0, 0.0, 0.0]];
    if (i === 4) return [[80.0, 0.0, 0.0], [20.0, 0.0, 0.0]];
    return [[i * 20.0, 0.0, 0.0], [0, 0, 0]];
  };
  const snaps = (k, t) => {
    for (let i = 0; i < 6; i++) {
      const [p, v] = at(i, t);
      k.from(W(i), snapMoving(100 + i, p, v, 0.0, 2));
    }
  };
  snaps(k, 0.0);
  k.hub.tick();
  k.clear();
  k.from(W(0), nearreq(100, 1, 64, 0, 300));
  assert.deepStrictEqual(nearAnswer(k), [
    1,
    0,
    4,
    [[2, [40, 0, 0, 0, 0]], [3, [60, 0, 0, 20, 0]], [4, [80, 0, 0, 20, 0]], [5, [100, 0, 0, 0, 0]]],
  ]);
  k.step(250.0);
  k.from(W(5), bye(105));
  snaps(k, 0.25);
  k.hub.tick();
  k.clear();
  k.from(W(0), nearreq(100, 2, 64, 1, 300));
  assert.deepStrictEqual(nearAnswer(k), [2, 1, 3, [[4, [85, 3, 0, 20, 0]], [5, null]]]);
  // the next question, without a tick between (the same grid, the candidates picked at the last): the same cars,
  // where they are now
  k.clear();
  k.step(150.0);
  k.from(W(0), nearreq(100, 3, 64, 2, 300));
  assert.deepStrictEqual(nearAnswer(k), [3, 2, 3, []]);
});

// one answer a browser every 150 ms; while the hub's thread is busy, every 500 ms (60 %) or every second (75 %)
test('the minimap is answered less often while the hubs thread is busy', () => {
  const k = new Kit({});
  for (let i = 0; i < 10; i++) {
    join(k, i);
    k.from(W(i), snap(100 + i, [i * 10.0, 0.0, 0.0]));
  }
  k.hub.tick();
  let req = 0;
  const ask = (k, after) => {
    k.step(after);
    k.clear();
    req += 1;
    k.from(W(0), nearreq(100, req, 64, 0, 300));
    return nears(k).length !== 0;
  };
  assert.ok(ask(k, 0.0));
  assert.ok(!ask(k, 100.0), 'within 150 ms');
  assert.ok(ask(k, 60.0));
  k.hub.setThreadBusy(0.65);
  assert.ok(ask(k, 200.0), '(the gap after the last answer was 150 ms)');
  assert.ok(!ask(k, 300.0), 'within 500 ms');
  assert.ok(ask(k, 250.0));
  k.hub.setThreadBusy(0.8);
  assert.ok(ask(k, 600.0));
  assert.ok(!ask(k, 700.0), 'within a second');
  assert.ok(ask(k, 350.0));
  k.hub.setThreadBusy(0.1);
  assert.ok(ask(k, 1000.0));
  assert.ok(ask(k, 200.0));
});

// a crowd: the 128 nearest at most, each placed (1152 bytes, one datagram); then what changed, or from nothing again
// when that would not fit
test('the minimap answers a crowd in one datagram', () => {
  const k = new Kit({});
  for (let i = 0; i < 301; i++) {
    join(k, i);
    k.from(W(i), snap(100 + i, [(i % 20) * 5.0 + 0.25, Math.floor(i / 20) * 5.0 + 0.25, 0.0]));
  }
  k.hub.tick();
  k.clear();
  k.from(W(0), nearreq(100, 1, 1000, 0, 1000));
  let [, base, total, e] = nearAnswer(k);
  assert.deepStrictEqual([base, e.length, e.every((x) => x[1] !== null)], [0, 128, true]);
  assert.strictEqual(total, 256, 'the 256 candidates within the radius counted (past the 32 links)');
  const len = k.sent[0][1].length - 16;
  assert.strictEqual(len, 16 + 9 + 128 * 9 + 4);
  // everyone moved 10 m: the same 128, each placed again (1152 bytes: it fits)
  k.step(300.0);
  for (let i = 0; i < 301; i++) k.from(W(i), snap(100 + i, [(i % 20) * 5.0 + 10.25, Math.floor(i / 20) * 5.0 + 0.25, 0.0]));
  k.hub.tick();
  k.clear();
  k.from(W(0), nearreq(100, 2, 1000, 1, 1000));
  [, base, , e] = nearAnswer(k);
  assert.deepStrictEqual([base, e.length, e.every((x) => x[1] !== null)], [1, 128, true], 'from answer 1');
  // and again, the one asking 60 m on: some of its 128 go, the others moved: 128 placed and the gone ones would not
  // fit, so from nothing
  k.step(300.0);
  for (let i = 0; i < 301; i++) {
    const x = i === 0 ? 60.25 : (i % 20) * 5.0 + 20.25;
    k.from(W(i), snap(100 + i, [x, Math.floor(i / 20) * 5.0 + 0.25, 0.0]));
  }
  k.hub.tick();
  k.clear();
  k.from(W(0), nearreq(100, 3, 1000, 2, 1000));
  [, base, , e] = nearAnswer(k);
  assert.deepStrictEqual([base, e.length, e.every((x) => x[1] !== null)], [0, 128, true], 'from nothing');
});

/** the newest wasi-sdk in deps/ (the Rust's way to build roam_core.c to wasm), or null */
function wasiSdk() {
  const deps = pjoin(REPO, 'deps');
  if (!existsSync(deps)) return null;
  const v = readdirSync(deps).filter((n) => n.startsWith('wasi-sdk-')).sort();
  return v.length ? pjoin(deps, v[v.length - 1]) : null;
}

// roam_core asks as the hub reads it, and takes the hub's answer (web/test/roam_hubwire.c)
test('the minimap on the wire roam core asks and takes the answer', (t) => {
  const wasi = wasiSdk();
  if (wasi === null) {
    t.skip('no wasi-sdk in deps/: skipped');
    return;
  }
  const w = pjoin(mkdtempSync(pjoin(tmpdir(), 'roam-')), 'roam_hubwire_near.wasm');
  execFileSync(
    pjoin(wasi, 'bin/clang'),
    ['--target=wasm32-wasip1-threads', '-pthread', '-O2', '-ffp-contract=off', '-Iruntime', '-o', w, 'web/test/roam_hubwire.c', 'runtime/roam_core.c',
      '-Wl,--import-memory,--export-memory,--shared-memory,--initial-memory=67108864,--max-memory=268435456'],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const run = (args) => execFileSync(process.execPath, [pjoin(REPO, 'web/test/wasi-run.mjs'), w, ...args], { encoding: 'utf8' }).trim();
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const unhex = (s) => Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
  const strip = (s, pre) => (s.startsWith(pre) ? s.slice(pre.length) : '');
  const k = new Kit({ degree: 1 });
  for (let i = 0; i < 6; i++) {
    join(k, i);
    k.from(W(i), snapMoving(100 + i, [i * -40.0, 7.0, 0.0], [0.0, -i, 0.0], -Math.PI / 2, 2));
  }
  k.hub.tick();
  k.clear();
  // its NEARREQ, as the hub reads it: type 18, req 1, 64 at most, from nothing, within 300 m
  let got = run(['near']);
  const ask = unhex(strip(got.split('\n')[0] || '', 'ask '));
  assert.strictEqual(ask.length, 16 + 8 + 4, got);
  const u = (o) => ask[o] | (ask[o + 1] << 8);
  assert.deepStrictEqual([ask[5], u(16), u(18), u(20), u(22)], [18, 1, 64, 0, 300]);
  // the same question as player 0's, and the session takes the answer
  k.from(W(0), nearreq(100, 1, 64, 0, 300));
  const first = k.sent.map(([, f]) => hex(f.subarray(16)));
  assert.strictEqual(first.length, 1);
  got = run(['near', ...first]);
  const entry = (i) => i + ':' + -40 * i + ',7,192,0,' + -i;
  let want = [2, 3, 4, 5].map(entry);
  assert.strictEqual(got.split('\n')[1] || '', 'near 1 4 4 ' + want.join(' '));
  // it asks again from answer 1: 3 went, 4 moved off; the rest where it moved them on
  k.step(300.0);
  k.from(W(3), bye(103));
  k.from(W(4), snapMoving(104, [-160.0, 40.0, 0.0], [0, 0, 0], -Math.PI / 2, 2));
  k.hub.tick();
  k.clear();
  k.from(W(0), nearreq(100, 2, 64, 1, 300));
  const second = k.sent.map(([, f]) => hex(f.subarray(16)));
  assert.deepStrictEqual(nearAnswer(k), [2, 1, 3, [[3, null], [4, [-160, 40, 192, 0, 0]]]]);
  got = run(['near', ...first, 'ask', ...second]);
  const lines = got.split('\n');
  const ask2 = unhex(strip(lines[1] || '', 'ask '));
  assert.deepStrictEqual([ask2[16] | (ask2[17] << 8), ask2[20] | (ask2[21] << 8)], [2, 1], 'it asks from answer 1');
  want = [2, 4, 5].map((i) => (i === 4 ? '4:-160,40,192,0,0' : entry(i)));
  assert.strictEqual(lines[2] || '', 'near 2 3 3 ' + want.join(' '));
});
