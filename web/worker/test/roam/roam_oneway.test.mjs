// A port of web/server-rs/crates/roam/tests/roam_oneway.rs: one-way links (roam_core version 15, hub.rs one_way): a
// player gets the cars of its nearest others, as many as it shows, even where those show fewer (a computer's 32, a
// tablet's 24, a phone's 16); each sends its car to sends players at most (64; its links under the busy cap); players of
// older cores, and the pairs linked first (outruns, lobbies, crews, friends), keep links both ways.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Kit, helloWith, snap, snapMoving, peersOf, crewMarks } from './kit.mjs';

/** browser i's address, for more players than V's: 10.77.0.2 and on */
function W(i) {
  return (0x0a4d0002 + i) >>> 0;
}

/** the way marks of the hub's lists (roam_core.h RC_MARK_RXONLY / RC_MARK_TXONLY) */
const RX = 0x20;
const TX = 0x40;

/** every player's last list: [vip, its mark] an entry; no marks: 0 each */
function listsWithMarks(k) {
  const out = new Map();
  for (const [vip, f] of k.sent) {
    const e = peersOf(f);
    const m = crewMarks(f);
    const marks = m ? m[1] : e.map(() => 0);
    out.set(vip, e.map((p, i) => [p.vip, marks[i]]));
  }
  return out;
}

/** what a player gets cars from (entries not marked TX) and sends its own to (not marked RX) */
function gets(l) {
  return l.filter((e) => (e[1] & TX) === 0).map((e) => e[0]);
}
function sends(l) {
  return l.filter((e) => (e[1] & RX) === 0).map((e) => e[0]);
}

/** where player i of a room sits: the first in the middle of the grid, the others round it */
function cell(i) {
  return i === 0 ? 55 : i <= 55 ? i - 1 : i;
}

/** n players on a grid gap m apart (row of 10), each its own links and core, the first one in the middle: [kit, at] */
function room(o, n, gap, who) {
  const k = new Kit(o);
  const at = [];
  for (let i = 0; i < n; i++) {
    const [core, links] = who(i);
    const c = cell(i);
    const p = [(c % 10) * gap + 0.25, Math.floor(c / 10) * gap + 0.25, 0.0];
    k.from(W(i), helloWith(100 + i, { core, links }));
    k.from(W(i), snap(100 + i, p));
    at.push(p);
  }
  k.hub.tick();
  return [k, at];
}

function nearest(at, i, n) {
  const d = [];
  for (let j = 0; j < at.length; j++) if (j !== i) d.push([Math.hypot(at[j][0] - at[i][0], at[j][1] - at[i][1]), j]);
  d.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return d.slice(0, n).map((e) => W(e[1]));
}

function opts() {
  return { viewM: 1e-9 };
}

/** the mark the other end's list should have for a link marked m */
function backOf(m) {
  const w = m & (RX | TX);
  return w === RX ? TX : w === TX ? RX : 0;
}

const hx = (v) => v.toString(16);

// a player who shows 64 among 99 who show 32 (all core 15): it gets the cars of its 64 nearest (before, its links
// were the ones the others had room for); none gets more than it shows, none sends to more than 64
test('a player who shows 64 among players who show 32 gets its 64 nearest', () => {
  for (const [name, o] of [['every pair', opts()], ['the grid', { ...opts(), exactRoom: 1 }]]) {
    const [k, at] = room(o, 100, 6.0, (i) => [15, i === 0 ? 64 : 32]);
    const l = listsWithMarks(k);
    const mine = gets(l.get(W(0)));
    const want = nearest(at, 0, 64);
    const hit = want.filter((v) => mine.includes(v)).length;
    assert.equal(mine.length, 64, name + ': the 64-player gets ' + mine.length + ' cars');
    assert.ok(hit >= 62, name + ': ' + hit + ' of its 64 nearest');
    for (let i = 1; i < 100; i++) {
      const li = l.get(W(i));
      assert.ok(gets(li).length <= 32, name + ': player ' + i + ' gets ' + gets(li).length);
      assert.ok(sends(li).length <= 64, name + ': player ' + i + ' sends to ' + sends(li).length);
      assert.ok(li.length <= 96, name + ': player ' + i + "'s list of " + li.length);
    }
    // each way as the other end's list has it: what one gets, the other sends
    for (const [v, li] of l) {
      for (const [q, m] of li) {
        const e = l.get(q).find((e) => e[0] === v);
        const back = e ? e[1] : undefined;
        assert.equal(back === undefined ? undefined : back & (RX | TX), backOf(m), name + ': ' + hx(v) + ' -> ' + hx(q) + ' mark 0x' + hx(m) + ', back ' + back);
      }
    }
  }
});

// phones (16) send their car to 64 at most too (one copy from the phone, the server's for the rest): a player who
// shows 64 among 100 phones gets its 64 nearest; no phone gets more than 16, or sends to more than 64
test('a phone sends to 64 at most and gets its 16', () => {
  const [k, at] = room(opts(), 101, 6.0, (i) => [15, i === 0 ? 64 : 16]);
  const l = listsWithMarks(k);
  for (let i = 1; i < 101; i++) {
    assert.ok(sends(l.get(W(i))).length <= 64, 'phone ' + i + ' sends to ' + sends(l.get(W(i))).length);
    assert.ok(gets(l.get(W(i))).length <= 16, 'phone ' + i + ' gets ' + gets(l.get(W(i))).length);
  }
  const mine = gets(l.get(W(0)));
  const hit = nearest(at, 0, 64).filter((v) => mine.includes(v)).length;
  assert.ok(hit >= 62, hit + ' of its 64 nearest');
});

// under the busy cap a player sends to its links only
test('under the busy cap a player sends to its links', () => {
  const k = new Kit({ viewM: 1e-9, capDownMs: 1.0 });
  k.busy = 0.95;
  for (let i = 0; i < 60; i++) {
    k.from(W(i), helloWith(100 + i, { core: 15, links: i === 0 ? 64 : 16 }));
    k.from(W(i), snap(100 + i, [(i % 10) * 6.0 + 0.25, Math.floor(i / 10) * 6.0 + 0.25, 0.0]));
  }
  k.step(10.0);
  k.hub.tick();
  const l = listsWithMarks(k);
  const cap = k.lines.some((l) => l.includes('links a player'));
  assert.ok(cap, 'the cap came down');
  for (let i = 1; i < 60; i++) {
    assert.ok(sends(l.get(W(i))).length <= 16, 'player ' + i + ' sends to ' + sends(l.get(W(i))).length + ' under the cap');
  }
});

// a player of an older core (14) gets links both ways only, unmarked, and the ones of core 15 keep theirs with it
test('an older core keeps its links both ways', () => {
  const [k] = room(opts(), 100, 6.0, (i) => (i % 3 === 0 ? [14, 48] : [15, i % 2 === 0 ? 64 : 32]));
  const l = listsWithMarks(k);
  const old = [];
  for (let i = 0; i < 100; i++) if (i % 3 === 0) old.push(W(i));
  for (const v of old) {
    for (const [q, m] of l.get(v)) {
      assert.equal(m & (RX | TX), 0, "an old core's list has a way mark");
      const back = l.get(q).find((e) => e[0] === v);
      assert.ok(back, 'both ways');
      assert.equal(back[1] & (RX | TX), 0, 'a link with an old core is marked one way');
    }
  }
  // somebody's links went one way
  assert.ok(k.info('onewayLinks') > 0.0);
});

// two players alone: both ways, no marks
test('two alone are linked both ways', () => {
  const [k] = room(opts(), 2, 6.0, () => [15, 64]);
  const l = listsWithMarks(k);
  assert.deepEqual(l.get(W(0)), [[W(1), 0]]);
  assert.deepEqual(l.get(W(1)), [[W(0), 0]]);
});

function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

// every pair weighed (a small room) and the grid's walks (a large one) give the same lists, byte for byte, tick after
// tick as the players move
test('every pair and the grid give the same one way links', () => {
  const run = (exactRoom) => {
    const k = new Kit({ exactRoom });
    const out = [];
    for (let t = 0; t < 6; t++) {
      k.clear();
      for (let i = 0; i < 150; i++) {
        const a = i * 0.7;
        const r = 20.0 + (i % 7) * 15.0;
        const w = i % 4 === 0 ? 0.0 : 0.05 * (1.0 + (i % 5));
        const ang = a + w * t * 2.0;
        const p = [r * Math.cos(ang) + 0.25, r * Math.sin(ang) + 0.25, 0.0];
        const v = [-r * w * Math.sin(ang), r * w * Math.cos(ang), 0.0];
        const links = [16, 24, 32, 32, 48, 64][i % 6];
        if (t === 0) k.from(W(i), helloWith(100 + i, { core: i % 9 === 0 ? 14 : 15, links }));
        k.from(W(i), snapMoving(100 + i, p, v, ang + 1.5, 2));
      }
      k.hub.tick();
      const l = k.sent.map(([v, f]) => [v, f.slice(16 + 16)]);
      l.sort((x, y) => x[0] - y[0] || cmpBytes(x[1], y[1]));
      out.push(l);
      k.step(500.0);
    }
    return out;
  };
  const every = run(1000);
  const grid = run(1);
  every.forEach((a, t) => {
    const b = grid[t];
    assert.equal(a.length, b.length);
    a.forEach((x, i) => {
      assert.deepEqual(x, b[i], 'tick ' + t + ': player ' + hx(x[0]) + "'s list");
    });
  });
});

// nobody moves: the links stay as they were, tick after tick
test('links stay while nobody moves', () => {
  const [k] = room(opts(), 100, 6.0, (i) => [15, [16, 32, 64][i % 3]]);
  const first = listsWithMarks(k);
  for (let n = 0; n < 8; n++) {
    k.step(500.0);
    k.clear();
    for (let i = 0; i < 100; i++) {
      const c = cell(i);
      k.from(W(i), snap(100 + i, [(c % 10) * 6.0 + 0.25, Math.floor(c / 10) * 6.0 + 0.25, 0.0]));
    }
    k.hub.tick();
  }
  const last = listsWithMarks(k);
  const sorted = (l) =>
    Array.from(l, ([a, b]) => [a, b.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1])]).sort((x, y) => x[0] - y[0]);
  assert.deepEqual(sorted(first), sorted(last));
});

// 300 players on one spot, all of them 64 and the room's 32s and 16s round them: no list names more than 96 (a core
// takes RC_LIST_MAX), each list's ways agree with the other ends'
test('no list is longer than 96', () => {
  const [k] = room(opts(), 300, 2.0, (i) => [15, [64, 64, 32, 16][i % 4]]);
  const l = listsWithMarks(k);
  for (const [v, li] of l) {
    assert.ok(li.length <= 96, hx(v) + "'s list of " + li.length);
    for (const [q, m] of li) {
      const e = l.get(q).find((e) => e[0] === v);
      assert.equal(e ? e[1] & (RX | TX) : undefined, backOf(m));
    }
  }
});

/** a room of n core-15 players of links on a grid round the start, plus two at a and b set up by hello */
function crowdAndTwo(n, links, a, b, hello) {
  const k = new Kit(opts());
  for (let i = 0; i < n; i++) {
    k.from(W(i), helloWith(100 + i, { core: 15, links }));
    k.from(W(i), snap(100 + i, [(i % 10) * 4.0 + 0.25, Math.floor(i / 10) * 4.0 + 0.25, 0.0]));
  }
  for (const [x, p] of [[n, a], [n + 1, b]]) {
    k.from(W(x), helloWith(100 + x, hello(x)));
    k.from(W(x), snap(100 + x, p));
  }
  k.hub.tick();
  return listsWithMarks(k);
}

function wayOf(l, a, b) {
  const e = l.get(a).find((e) => e[0] === b);
  return e ? e[1] & (RX | TX) : null;
}

// two crew-mates 300 m apart, each among 100 players of core 15: linked both ways, unmarked, as before one-way links
test('crew mates far apart are linked both ways', () => {
  const CREW = [0x12345678];
  const l = crowdAndTwo(100, 32, [20.25, 20.25, 0.0], [320.25, 20.25, 0.0], () => ({ core: 15, links: 32, crews: CREW, flags: 0x0400 }));
  const a = W(100), b = W(101);
  const ab = wayOf(l, a, b), ba = wayOf(l, b, a);
  assert.deepEqual([ab, ba], [0, 0], 'crew-mates: ' + ab + ' ' + ba);
});

// two players in an outrun (each names the other), 400 m apart in a crowd: linked both ways
test('an outrun s two are linked both ways', () => {
  const l = crowdAndTwo(100, 16, [20.25, 20.25, 0.0], [420.25, 20.25, 0.0], (x) => ({ core: 15, links: 32, duel: x === 100 ? 201 : 200 }));
  const a = W(100), b = W(101);
  const ab = wayOf(l, a, b), ba = wayOf(l, b, a);
  assert.deepEqual([ab, ba], [0, 0], "the outrun's pair: " + ab + ' ' + ba);
});

// a crowded meet: 150 players 3 m apart who show 32, 16 or 24, and one who shows 64 in the middle: the cars in the
// middle are wanted by more players than they send to, and it still gets 64 (the second round walks further)
test('a player who shows 64 at a crowded meet gets 64', () => {
  const [k, at] = room(opts(), 150, 3.0, (i) => [15, i === 0 ? 64 : [32, 16, 24, 32][i % 4]]);
  const l = listsWithMarks(k);
  const mine = gets(l.get(W(0)));
  assert.equal(mine.length, 64, 'it gets ' + mine.length);
  const hit = nearest(at, 0, 64).filter((v) => mine.includes(v)).length;
  assert.ok(hit >= 48, hit + ' of its 64 nearest');
  for (let i = 1; i < 150; i++) assert.ok(sends(l.get(W(i))).length <= 64);
});

