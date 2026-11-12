// Port of web/server-rs/crates/lan/tests/expel.rs: kicks and bans (the crate doc's Kicks and bans): a player the
// operator removes hears why and goes, its address free at once; a banned client is turned away by its address before
// it gets a place, or by its page's ids or its keyphrase at its hello (on the switch, coming back with its token, or
// waiting in line); who has the players and the ones who left.

import test from 'node:test';
import assert from 'node:assert/strict';
import { start, opts, Client, waitFor, sleep, resetWorld, ip, utf8 } from './harness.js';
import { CLOSE_BANNED, CLOSE_KICKED } from '../../src/switch/lib.js';

const page = (id, o = {}) => ({ id, ...o });

test('a_kicked_player_hears_why_and_its_address_is_free_at_once', () => {
  resetWorld();
  const sw = start(opts());
  const a = Client.with(sw, 'Alice', '?ident=A', page('pa', { claim: 'ka' }));
  a.welcome();
  const b = Client.with(sw, 'Bob', '?ident=B', page('pb'));
  b.welcome();
  waitFor(2000, () => sw.peerNamed('Bob')?.hello);
  let who = sw.lan.who();
  const alice = who.find((w) => w.name === 'Alice');
  assert.ok(alice, 'Alice on the switch');
  assert.deepEqual([alice.vip, alice.ident ?? null, alice.browser ?? null, alice.left ?? null], [a.vip, 'A', 'pa', null]);
  assert.equal(alice.owner, 'owner-ka');
  assert.equal(who.find((w) => w.name === 'Bob').owner ?? null, null);

  const msg = utf8(JSON.stringify({ t: 'kick', msg: 'Stop ramming' }));
  assert.ok(sw.expel(a.vip, msg, CLOSE_KICKED));
  assert.deepEqual(a.closed(), [CLOSE_KICKED, 'kicked']);
  assert.deepEqual(a.got().ctl.filter((m) => m.t === 'kick').map((m) => m.msg), ['Stop ramming']);
  waitFor(2000, () => !sw.has(a.vip));
  assert.ok(!sw.has(a.vip) && sw.has(b.vip));
  assert.ok(!sw.reserved().includes(a.vip), 'no reservation for a kicked player\'s token');
  assert.ok(!sw.expel(a.vip, msg, CLOSE_KICKED), 'nobody there now');
  // who: Bob on the switch, Alice gone (with what a ban takes)
  who = sw.lan.who();
  assert.deepEqual(who.filter((w) => w.left == null).map((w) => w.name), ['Bob']);
  const gone = who.find((w) => w.left != null);
  assert.ok(gone, 'Alice among the ones who left');
  assert.deepEqual([gone.name, gone.ident ?? null, gone.browser ?? null], ['Alice', 'A', 'pa']);
  // who had an address, without waiting on the hosts: the one on it now, then the ones who left it
  const at = (vip) => sw.lan.whoAt(vip).map((w) => [w.name, w.left != null, w.owner ?? null]);
  assert.deepEqual(at(a.vip), [['Alice', true, 'owner-ka']]);
  assert.deepEqual(at(b.vip), [['Bob', false, null]]);
  assert.deepEqual(at(0x0a4d1717), []);
  sw.close();
});

test('a_banned_address_is_turned_away_before_it_gets_a_place', () => {
  resetWorld();
  const sw = start(opts());
  for (const q of ['?refuse=bye', '?refuse=bye&queue', '?refuse=bye&resume']) {
    const c = Client.with(sw, 'Carol', q, {});
    if (q.endsWith('resume')) {
      c.text(JSON.stringify({ t: 'hello', name: 'Carol', vip: '10.77.0.2', token: 'x' }));
    }
    assert.deepEqual(c.closed(), [CLOSE_BANNED, 'banned'], q);
    const g = c.got();
    assert.deepEqual(g.ctl.map((m) => (typeof m.t === 'string' ? m.t : '')), ['ban'], q + ': no welcome');
    assert.equal(g.ctl[0].msg, 'bye');
  }
  assert.ok(sw.peers().length === 0 && sw.reserved().length === 0 && sw.lan.waiting() === 0);
  sw.close();
});

test('a_banned_page_is_turned_away_at_its_hello', () => {
  resetWorld();
  const sw = start(opts({ maxPeers: 2, lineTellMs: 100 }));
  // on the switch (its welcome comes before its hello)
  const d = Client.with(sw, 'Dave', '?gate=bad', page('bad'));
  const w = d.welcome();
  assert.deepEqual(d.closed(), [CLOSE_BANNED, 'banned']);
  assert.equal(d.got().ctl.find((m) => m.t === 'ban')?.msg, 'bad');
  waitFor(2000, () => sw.peers().length === 0);
  assert.equal(sw.reserved().length, 0, 'its address free at once');
  // another page is let be
  const e = Client.with(sw, 'Eve', '?gate=bad', page('good'));
  e.welcome();
  sleep(100);
  assert.ok(e.isOpen() && sw.has(e.vip));
  // back with its token: turned away before its address
  const held = [w.vip >>> 0, w.token];
  const f = new Client(sw, 'Dave', '?gate=bad', held, page('bad'));
  assert.deepEqual(f.closed(), [CLOSE_BANNED, 'banned']);
  assert.ok(f.got().ctl.every((m) => m.t !== 'welcome'));
  // waiting in line (the switch full): out of it
  const g = Client.with(sw, 'Gus', '', {});
  g.welcome();
  const h = Client.with(sw, 'Dave', '?queue&gate=bad', page('bad'));
  h.text(JSON.stringify({ t: 'hello', name: 'Dave', id: 'bad' }));
  assert.deepEqual(h.closed(), [CLOSE_BANNED, 'banned']);
  waitFor(2000, () => sw.lan.waiting() === 0);
  assert.equal(sw.lan.waiting(), 0, 'its place in line is not kept for its ticket');
  assert.equal(sw.peers().length, 2);
  sw.close();
});

test('a_hello_is_turned_away_by_an_id_its_page_found_besides_its_own_or_by_its_keyphrase', () => {
  resetWorld();
  const sw = start(opts());
  // an id the page found in its other store: the server is asked with all of them (no empty or repeated one)
  const c = Client.with(sw, 'Dave', '?gate=bad', page('new', { was: ['new', '', 'bad'] }));
  c.welcome();
  assert.deepEqual(c.closed(), [CLOSE_BANNED, 'banned']);
  const told = c.got().ctl.find((m) => m.t === 'ban');
  assert.ok(told, 'the ban\'s message');
  assert.deepEqual([told.msg, told.ids], ['bad', ['new', 'bad']]);
  // the keyphrase in another browser, and in a page without an id
  for (const o of [page('other', { claim: 'dk' }), { claim: 'dk' }]) {
    const c = Client.with(sw, 'Dave', '?gate=owner-dk', o);
    c.welcome();
    assert.deepEqual(c.closed(), [CLOSE_BANNED, 'banned']);
    assert.equal(c.got().ctl.find((m) => m.t === 'ban')?.msg, 'owner-dk');
  }
  // the first WAS_MAX of "was" only, and none without an id
  const e = Client.with(sw, 'Eve', '?gate=bad', page('e', { was: ['1', '2', '3', '4', 'bad'] }));
  e.welcome();
  const f = Client.with(sw, 'Fay', '?gate=bad', { was: ['bad'] });
  f.welcome();
  sleep(150);
  assert.ok(e.isOpen() && f.isOpen() && sw.has(e.vip) && sw.has(f.vip));
  sw.close();
});
