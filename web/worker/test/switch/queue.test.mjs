// Port of web/server-rs/crates/lan/tests/queue.rs: the line (queue.rs): pages that can wait (?queue) wait for a place
// in their order when every place is taken, a page of before still gets "LAN full", a page that lets go leaves its
// place in line, one that dropped keeps it for its ticket, newcomers never pass the line, a dropped player's token still
// gets its address back at once.

import test from 'node:test';
import assert from 'node:assert/strict';
import { start, opts, Client, waitFor, sleep, resetWorld } from './harness.js';

/** a page that can wait: /lan?queue (with ?resume and its ticket when it comes back), its hello at once as the page
 * sends it */
function waiter(sw, name, ticket = null) {
  const q = ticket !== null ? '?queue&resume' : '?queue';
  const c = Client.with(sw, name, q, {});
  const h = { t: 'hello', name, lan: 1 };
  if (ticket !== null) h.ticket = ticket;
  c.text(JSON.stringify(h));
  return c;
}

/** its newest {"t":"queue"} once it says pos (2 s at most) */
function told(c, pos) {
  return c.until((g) => {
    const m = [...g.ctl].reverse().find((m) => m.t === 'queue');
    return m && m.pos === pos ? m : null;
  });
}

const lineOpts = (maxPeers, o = {}) => opts({ maxPeers, lineTellMs: 100, ...o });
const vipNum = (w) => w.vip >>> 0;

test('the_line_lets_them_in_first_come_first_served', () => {
  resetWorld();
  const sw = start(lineOpts(2));
  const a = Client.connect(sw, 'Alice');
  a.welcome();
  const b = Client.connect(sw, 'Bob');
  b.welcome();
  assert.ok(sw.lan.full(), 'two places, two players');
  assert.equal(sw.lan.waiting(), 0);
  // full: the ones that can wait are told their place (the first time with a ticket), a page of before is refused
  const c = waiter(sw, 'Carol');
  const m = told(c, 1);
  assert.equal(m.of, 1);
  assert.ok(typeof m.ticket === 'string' && m.ticket.length >= 20, 'a ticket: ' + JSON.stringify(m));
  assert.ok(!('eta' in m), 'no pace yet: ' + JSON.stringify(m));
  const d = waiter(sw, 'Dave');
  assert.equal(told(d, 2).of, 2);
  const e = Client.connect(sw, 'Eve');
  assert.deepEqual(e.closed(), [1013, 'LAN full'], 'a page that cannot wait');
  assert.ok(sw.lan.full());
  assert.equal(sw.lan.waiting(), 2);
  assert.ok(c.got().ctl.every((m) => m.t !== 'welcome') && sw.peerNamed('Carol') === null, 'nobody waiting is on the switch');
  // a waiting page's ping is answered
  c.text('{"t":"ping","id":7}');
  c.until((g) => g.ctl.find((m) => m.t === 'pong' && m.id === 7) ?? null);
  // a place frees up (the page let go): the first in line takes it, with the hello it sent while it waited
  a.closeWith(1000, 'idle');
  const w = c.welcome();
  assert.ok(Number.isInteger(w.vip) && w.vip >= 0);
  waitFor(2000, () => sw.peerNamed('Carol')?.hello);
  c.untilTrue((g) => g.names() === 'Bob,Carol');
  // the next one moves up, and goes in when the next place frees up
  assert.equal(told(d, 1).of, 1);
  b.closeWith(1000, 'closed');
  d.welcome();
  assert.equal(sw.lan.waiting(), 0);
  const i = sw.info();
  assert.deepEqual([i.queued, i.lineIn, i.waiting], [2, 2, 0]);
  // the line is empty: a newcomer gets a place at once again (once one is free: the switch has let Carol go)
  c.closeWith(1000, 'idle');
  waitFor(2000, () => !sw.lan.full());
  const f = waiter(sw, 'Fay');
  f.welcome();
  assert.equal(f.got().count('queue'), 0);
  sw.close();
});

test('a_dropped_page_keeps_its_place_for_its_ticket_one_that_lets_go_leaves', () => {
  resetWorld();
  const sw = start(lineOpts(1));
  const a = Client.connect(sw, 'Alice');
  a.welcome();
  const c = waiter(sw, 'Carol');
  const ticket = told(c, 1).ticket;
  const d = waiter(sw, 'Dave');
  told(d, 2);
  const g = waiter(sw, 'Gina');
  told(g, 3);
  // Carol's link drops (no close frame): her place is kept; Gina lets go: hers goes at once
  c.terminate();
  g.closeWith(1000, 'idle');
  waitFor(2000, () => sw.lan.waiting() === 2);
  // a place frees up: Carol is away, so Dave (next) takes it, and Carol keeps the first place
  a.closeWith(1000, 'idle');
  d.welcome();
  assert.equal(sw.lan.waiting(), 1, 'Carol\'s place kept');
  // Carol is back with her ticket: her place again, first
  const c2 = waiter(sw, 'Carol', ticket);
  const m = told(c2, 1);
  assert.ok(!('ticket' in m), 'her ticket stays the one she has');
  const h = waiter(sw, 'Hank');
  told(h, 2);
  d.closeWith(1000, 'idle');
  c2.welcome();
  waitFor(2000, () => sw.peerNamed('Carol') !== null);
  assert.equal(told(h, 1).of, 1);
  // a ticket nobody holds is a newcomer's place, at the back
  const x = waiter(sw, 'Xena', 'no-such-ticket-0000000000');
  assert.equal(told(x, 2).of, 2);
  const i = sw.info();
  assert.equal(i.rejoined, 1);
  assert.equal(i.lineLeft, 1, 'Gina');
  c2.closeWith(1000, 'idle');
  h.welcome();
  sw.close();
});

test('newcomers_never_pass_the_line_a_dropped_players_token_does', () => {
  resetWorld();
  const sw = start(lineOpts(2));
  const a = Client.connect(sw, 'Alice');
  const wa = a.welcome();
  const b = Client.connect(sw, 'Bob');
  b.welcome();
  const c = waiter(sw, 'Carol');
  told(c, 1);
  // Alice's link drops: her address is kept for her token (her place never freed), so Carol still waits
  a.terminate();
  waitFor(2000, () => sw.reserved().length === 1);
  sleep(1200);
  assert.equal(sw.lan.waiting(), 1);
  // a newcomer queues behind Carol, also once a place is free
  const d = waiter(sw, 'Dave');
  told(d, 2);
  // Alice comes back with her token: her address at once, past the line
  const a2 = new Client(sw, 'Alice', '', [vipNum(wa), wa.token], {});
  assert.equal(a2.welcome().vip, wa.vip);
  assert.equal(sw.lan.waiting(), 2);
  b.closeWith(1000, 'idle');
  c.welcome();
  a2.closeWith(1000, 'idle');
  d.welcome();
  sw.close();
});

test('a_full_line_refuses_and_the_pace_gives_a_wait', () => {
  resetWorld();
  const sw = start(lineOpts(1, { maxWaiting: 2 }));
  const a = Client.connect(sw, 'A');
  a.welcome();
  const line = [];
  for (let i = 0; i < 2; i++) {
    const c = waiter(sw, 'W' + i);
    told(c, i + 1);
    line.push(c);
  }
  const late = waiter(sw, 'Late');
  assert.deepEqual(late.closed(), [1013, 'LAN full'], 'past max_waiting');
  // three go in: from then on a page is told about how long it waits
  let holder = a;
  for (let k = 0; k < 3; k++) {
    holder.closeWith(1000, 'idle');
    const next = line.shift();
    next.welcome();
    holder = next;
    line.push(waiter(sw, 'More'));
  }
  const m = told(line[1], 2);
  assert.ok(Number.isInteger(m.eta) && m.eta > 0, 'a wait from the pace: ' + JSON.stringify(m));
  sw.close();
});

// only the ones there make it full: with a free place and only a dropped waiter in line (away, its place kept for its
// ticket), /players says not full and a newcomer goes in at once; the dropped one is back first in line
test('the_ones_away_do_not_make_it_full', () => {
  resetWorld();
  const sw = start(lineOpts(1));
  const a = Client.connect(sw, 'Alice');
  a.welcome();
  const c = waiter(sw, 'Carol');
  const ticket = told(c, 1).ticket;
  c.terminate();
  a.closeWith(1000, 'idle');
  waitFor(2000, () => !sw.lan.full());
  assert.equal(sw.lan.waiting(), 1, 'Carol\'s place kept');
  const d = waiter(sw, 'Dave');
  d.welcome();
  assert.equal(d.got().count('queue'), 0, 'no line to wait in');
  const c2 = waiter(sw, 'Carol', ticket);
  assert.equal(told(c2, 1).of, 1);
  assert.ok(sw.lan.full());
  d.closeWith(1000, 'idle');
  c2.welcome();
  sw.close();
});

// a page let in as its link went (its welcome, and so its token, lost with it): back with its ticket it takes the
// place it was given, not the back of the line, and nobody else can take it
test('a_ticket_takes_the_place_its_page_was_given_as_its_link_went', () => {
  resetWorld();
  const sw = start(lineOpts(1));
  const a = Client.connect(sw, 'Alice');
  a.welcome();
  const c = waiter(sw, 'Carol');
  const ticket = told(c, 1).ticket;
  const d = waiter(sw, 'Dave');
  told(d, 2);
  a.closeWith(1000, 'idle');
  const vip = c.welcome().vip;
  c.terminate();
  waitFor(2000, () => sw.reserved().length === 1);
  // someone else's ticket, or none, gets no such place
  const x = waiter(sw, 'Xena', 'not-carols-ticket-000000000');
  told(x, 2);
  const c2 = waiter(sw, 'Carol', ticket);
  assert.equal(c2.welcome().vip, vip, 'her place');
  assert.equal(c2.got().count('queue'), 0);
  assert.equal(sw.lan.waiting(), 2, 'Dave and Xena still wait');
  sw.close();
});
