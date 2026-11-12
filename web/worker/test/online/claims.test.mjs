// The tests of crates/online/src/tests/claims.rs: claimed names (nfsu2-claims) in the Online host: the lobby gives a
// claimed name to its keyphrase only, and takes it back for it from anyone else; EA Messenger keeps lists only for a
// claimed name, with its keyphrase (a player's report, 2026-10-28: players who kept the same name saw one another's
// friends and blocked lists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, MapStorage } from './harness.mjs';
import { Claims, ownerOfToken, HOLD_DAYS, DAY_MS } from '../../src/claims/claims.js';
import { shelfTexts } from '../../src/online/buddy.js';

/** a keyphrase's token (43 characters of base64url) */
const token = (c) => c.repeat(43);
const own = (c) => ownerOfToken(token(c));

function claim(claims, name, owner, now) {
  const r = claims.claim(name, owner, now);
  assert.ok(r.ok, 'claim ' + name + ': ' + JSON.stringify(r.err));
}

const worldWith = (claims, storage = null) => world({ claims, storage });

/** the persona the lobby gave a login */
const persona = (w, l) => w.conn(l).l('pers').g('PERS');

/** a player whose page plays with keyphrase key (null: no keyphrase): its lobby login and EA Messenger connection */
function player(w, vip, name, key) {
  const g = w.client(vip);
  if (key) w.setOwner(g, own(key));
  const l = w.login(g, name);
  const k = w.lkey(l);
  return [l, w.buddy(g, k)];
}

function roster(w, b) {
  const n = w.conn(b).msgs.length;
  w.send(b, 'RGET', [['LRSC', 'PC'], ['LIST', 'B'], ['PRES', 'Y'], ['PEND', 'Y'], ['ID', 1]]);
  return w.conn(b).all().slice(n).filter((m) => m.kind === 'ROST').map((m) => m.g('USER'));
}

function befriend(w, a, b, nameB, nameA) {
  w.send(a, 'RADM', [['LRSC', 'PC'], ['USER', nameB], ['ID', 5], ['PRES', 'Y']]);
  w.send(b, 'RRSP', [['LRSC', 'PC'], ['USER', nameA], ['ANSW', 'Y'], ['ID', 6], ['PRES', 'Y']]);
}

const now = (w) => Math.trunc(w.t);
const names = (r) => r.friends.map((f) => f.name);
const row = (name, mutual, online = mutual) => ({ name, mutual, online, contact: null });
const plain = (fs) => fs.map((f) => ({ name: f.name, mutual: f.mutual, online: f.online, contact: f.contact }));
const List = { k: 'List' }, ListMail = { k: 'ListMail' };
const Ask = (name) => ({ k: 'Ask', name });
const Answer = (name, yes) => ({ k: 'Answer', name, yes });
const Block = (name) => ({ k: 'Block', name });
const Remove = (name) => ({ k: 'Remove', name });
const Send = (name, body) => ({ k: 'Send', name, body });
const Discord = (typed) => ({ k: 'Discord', typed });

test('a_claimed_name_is_its_owners', () => {
  const claims = Claims.inMemory();
  const w = worldWith(claims);
  claim(claims, 'Alex', own('A'), now(w));
  // without the keyphrase: the name with digits, and the log says why
  let [l] = player(w, '10.77.0.2', 'Alex', null);
  const p = persona(w, l);
  assert.ok(p.startsWith('Alex') && p.length === 8 && /^[0-9]+$/.test(p.slice(4)), p);
  assert.ok(w.logged('("Alex" is claimed)'), w.text().join('\n'));
  // another keyphrase too
  [l] = player(w, '10.77.0.3', 'alex', 'B');
  assert.notEqual(persona(w, l).toLowerCase(), 'alex');
  // the owner gets it
  [l] = player(w, '10.77.0.4', 'Alex', 'A');
  assert.equal(persona(w, l), 'Alex');
  // a claim's digits are never another claimed name
  claim(claims, 'Alex4821', own('C'), now(w));
  for (let i = 5; i < 12; i++) {
    [l] = player(w, '10.77.0.' + i, 'Alex', null);
    assert.notEqual(persona(w, l), 'Alex4821');
  }
});

test('the_owner_takes_its_name_back', () => {
  const claims = Claims.inMemory();
  const w = worldWith(claims);
  // someone plays as Speedy before it is claimed
  const [other] = player(w, '10.77.0.2', 'Speedy', null);
  assert.equal(persona(w, other), 'Speedy');
  claim(claims, 'Speedy', own('A'), now(w));
  // its owner comes: the name is the owner's, the other session leaves the lobby
  const [l] = player(w, '10.77.0.3', 'Speedy', 'A');
  assert.equal(persona(w, l), 'Speedy');
  assert.ok(w.conn(other).fin || w.conn(other).reset, 'the other session dropped');
  assert.ok(w.logged("the name's owner logged in"), w.text().join('\n'));
  // playing holds the claim HOLD_DAYS from now
  w.advance(10.0 * 86400000.0);
  player(w, '10.77.0.3', 'Speedy', 'A');
  const m = claims.mine(own('A'), now(w));
  assert.equal(m.until, now(w) + HOLD_DAYS * DAY_MS);
});

// lists for claimed names only, with their keyphrase; a name nobody claimed has lists for its session only
test('messenger_lists_follow_the_claim', () => {
  const storage = new MapStorage();
  const claims = Claims.inMemory();
  let w = worldWith(claims, storage);
  const a = own('A'), b = own('B');
  claim(claims, 'Alpha', a, now(w));
  claim(claims, 'Bravo', b, now(w));
  // two owners become friends: kept, each with its keyphrase
  let [, ma] = player(w, '10.77.0.2', 'Alpha', 'A');
  let [, mb] = player(w, '10.77.0.3', 'Bravo', 'B');
  befriend(w, ma, mb, 'Bravo', 'Alpha');
  assert.deepEqual(roster(w, ma), ['Bravo']);
  const l = w.core.buddies.list('Alpha');
  assert.ok(l !== null && !l.temp && l.owner === a);
  // a name nobody claimed: lists for the session, never written, gone with it
  const [, mc] = player(w, '10.77.0.4', 'Charlie', null);
  befriend(w, mc, ma, 'Alpha', 'Charlie');
  assert.deepEqual(roster(w, mc), ['Alpha']);
  assert.ok(w.core.buddies.list('Charlie').temp);
  w.core.buddySave();
  const text = shelfTexts(w.core.store).join('\n');
  assert.ok(!text.includes('{"name":"Charlie"'), text);
  assert.ok(text.includes('"owner":"' + a + '"'), text);
  w.send(mc, 'DISC', []);
  assert.equal(w.core.buddies.list('Charlie'), null, 'gone with its session');
  // the next player under that name sees nothing of it
  const [, mc2] = player(w, '10.77.0.5', 'Charlie', null);
  assert.deepEqual(roster(w, mc2), []);
  // over a restart: the owners' lists are theirs again (Alpha's names Charlie, whoever plays under it)
  w.core.stop();
  w = worldWith(claims, storage);
  [, ma] = player(w, '10.77.0.2', 'Alpha', 'A');
  assert.deepEqual(roster(w, ma), ['Bravo', 'Charlie']);
  // a claim that ended: its lists go, and the next player under the name finds none
  claims.release(b);
  [, mb] = player(w, '10.77.0.6', 'Bravo', null);
  assert.deepEqual(roster(w, mb), [], "the ended claim's list is nobody's");
});

// the lists of before claims: NAME's and Player's go, the others wait for their name's first keyphrase, and nobody
// else sees them meanwhile
test('lists_of_before_go_to_the_first_claim', () => {
  const storage = new MapStorage();
  storage.put(
    'online/buddies.json',
    '{"v":3,"personas":[\n' +
      '            {"name":"NAME","seen":"2026-10","B":["Someone","Other"],"I":["Pest"]},\n' +
      '            {"name":"Player","seen":"2026-10","B":["Someone"]},\n' +
      '            {"name":"Delta","seen":"2026-10","B":["Echo"],"I":["Pest"]}\n' +
      '        ]}',
  );
  const claims = Claims.inMemory();
  const w = worldWith(claims, storage);
  // nobody claimed Delta: its list is not shown to whoever plays under it
  let [, m] = player(w, '10.77.0.2', 'Delta', null);
  assert.deepEqual(roster(w, m), []);
  const [, n] = player(w, '10.77.0.3', 'NAME', null);
  assert.deepEqual(roster(w, n), [], "NAME's shared list went");
  w.send(m, 'DISC', []);
  w.core.buddySave();
  const text = shelfTexts(w.core.store).join('\n');
  assert.ok(text.includes('"Delta"') && !text.includes('"NAME"') && !text.includes('"Player"'), text);
  // its first keyphrase gets it, with its blocked list
  claim(claims, 'Delta', own('D'), now(w));
  [, m] = player(w, '10.77.0.4', 'Delta', 'D');
  assert.deepEqual(roster(w, m), ['Echo']);
  assert.ok(w.core.buddies.blocks('delta', 'pest'));
});

// a name change: the lists move to the new name, and the friends' lists name it so
test('a_name_change_takes_the_lists_along', () => {
  const claims = Claims.inMemory();
  const w = worldWith(claims);
  const a = own('A'), b = own('B');
  claim(claims, 'Alpha', a, now(w));
  claim(claims, 'Bravo', b, now(w));
  const [, ma] = player(w, '10.77.0.2', 'Alpha', 'A');
  const [, mb] = player(w, '10.77.0.3', 'Bravo', 'B');
  befriend(w, ma, mb, 'Bravo', 'Alpha');
  w.send(ma, 'DISC', []);
  claim(claims, 'Speedy', a, now(w));
  const [, ms] = player(w, '10.77.0.2', 'Speedy', 'A');
  assert.deepEqual(roster(w, ms), ['Bravo']);
  assert.equal(w.core.buddies.list('Alpha'), null);
  assert.deepEqual(roster(w, mb), ['Speedy']);
  assert.ok(w.logged('lists moved from "alpha"'), w.text().join('\n'));
});

// a name changed on the start page, the Messenger never opened: the page's next look at its lists moves them, into
// the list the new name got meanwhile (a request to it), and the friend's list names it so, over a restart too
test('a_name_change_on_the_page_takes_the_lists_along', () => {
  const storage = new MapStorage();
  const claims = Claims.inMemory();
  let w = worldWith(claims, storage);
  const [a, b, c] = ['A', 'B', 'C'].map(own);
  for (const [n, o] of [['Alpha', a], ['Bravo', b], ['Charlie', c]]) claim(claims, n, o, now(w));
  const g = 'g1';
  assert.equal(w.core.friends(a, g, Ask('Bravo')).done, 'asked');
  assert.equal(w.core.friends(b, g, Ask('Alpha')).done, 'friends');
  w.core.buddySave();
  claim(claims, 'Speedy', a, now(w));
  assert.equal(w.core.friends(c, g, Ask('Speedy')).done, 'asked');
  const r = w.core.friends(a, g, List);
  assert.deepEqual([r.me, names(r), r.asks], ['Speedy', ['Bravo'], ['Charlie']]);
  assert.deepEqual(names(w.core.friends(b, g, List)), ['Speedy']);
  assert.equal(w.core.buddies.list('Alpha'), null);
  assert.ok(w.logged('lists moved from "alpha"'), w.text().join('\n'));
  // once only: the next look finds nothing left under the old name
  const moves = (w) => w.text().filter((l) => l.includes('lists moved')).length;
  const n = moves(w);
  assert.deepEqual(names(w.core.friends(a, g, List)), ['Bravo']);
  assert.equal(moves(w), n);
  w.core.stop();
  const text = shelfTexts(w.core.store).join('\n');
  assert.ok(!text.includes('"Alpha"'), text);
  w = worldWith(claims, storage);
  assert.deepEqual(names(w.core.friends(a, g, List)), ['Bravo']);
  assert.deepEqual(names(w.core.friends(b, g, List)), ['Speedy']);
});

// the two lists in one stay within a list's limits, on both sides: requests to the old name and to the new one, more
// than a list keeps, leave the newest; the askers whose request went no longer have it as sent
test('a_name_change_keeps_both_sides_within_the_limits', () => {
  const claims = Claims.inMemory();
  const w = worldWith(claims);
  const a = own('A');
  claim(claims, 'Alpha', a, now(w));
  const askers = [];
  for (let i = 0; i < 30; i++) {
    const o = ownerOfToken(String(i).padStart(43, '0'));
    const n = 'Fan' + i;
    claim(claims, n, o, now(w));
    askers.push([n, o]);
  }
  const g = 'g1';
  askers.forEach(([, o], i) => {
    if (i === 15) claim(claims, 'Speedy', a, now(w));
    w.advance(1000.0);
    // (each from its own network: a network makes only so many lists)
    assert.equal(w.core.friends(o, 'g' + i, Ask(i < 15 ? 'Alpha' : 'Speedy')).done, 'asked', String(i));
  });
  const r = w.core.friends(a, g, List);
  assert.equal(r.me, 'Speedy');
  assert.equal(r.asks.length, 20, JSON.stringify(r.asks));
  for (const [n, o] of askers) {
    const sent = w.core.friends(o, g, List).sent;
    const kept = r.asks.includes(n);
    assert.deepEqual(sent, kept ? ['Speedy'] : [], n + ': kept ' + kept);
  }
  assert.ok(r.asks.includes('Fan29'), 'the newest stay');
});

// a list of another keyphrase's claim on the new name, ended (its cloud saves deleted) while the list stayed in
// memory, is not taken in: the player who claims that name next gets its own friends only
test('a_name_change_takes_no_one_elses_list', () => {
  const claims = Claims.inMemory();
  const w = worldWith(claims);
  const [a, b, c, x] = ['A', 'B', 'C', 'X'].map(own);
  for (const [n, o] of [['Alpha', a], ['Bravo', b], ['Charlie', c], ['Speedy', x]]) claim(claims, n, o, now(w));
  const g = 'g1';
  assert.equal(w.core.friends(x, g, Ask('Bravo')).done, 'asked');
  assert.equal(w.core.friends(b, g, Ask('Speedy')).done, 'friends');
  assert.equal(w.core.friends(a, g, Ask('Charlie')).done, 'asked');
  assert.equal(w.core.friends(c, g, Ask('Alpha')).done, 'friends');
  assert.equal(claims.release(x), 1);
  claim(claims, 'Speedy', a, now(w));
  const r = w.core.friends(a, g, List);
  assert.deepEqual([r.me, names(r)], ['Speedy', ['Charlie']]);
});

// free roam's pages befriend through the Messenger's lists, as their keyphrase's claimed name: a request waits on
// both lists, a request back makes friends, and the Messenger hears of it; names nobody claimed take no part
test('pages_befriend_through_the_messenger_lists', () => {
  const storage = new MapStorage();
  const claims = Claims.inMemory();
  let w = worldWith(claims, storage);
  const [a, b, c] = ['A', 'B', 'C'].map(own);
  for (const [n, o] of [['Alpha', a], ['Bravo', b], ['Charlie', c]]) claim(claims, n, o, now(w));
  const g = 'g1';
  // Alpha's Messenger is open: it hears of Bravo's request
  const [, ma] = player(w, '10.77.0.2', 'Alpha', 'A');
  let r = w.core.friends(b, g, Ask('Alpha'));
  assert.deepEqual([r.me, r.done, r.sent], ['Bravo', 'asked', ['Alpha']]);
  w.deliver();
  assert.equal(w.conn(ma).l('RNOT').g('ATTR'), 'R');
  assert.deepEqual(w.core.friends(a, g, List).asks, ['Bravo']);
  // asked back: friends, each on the other's list, the Messenger told
  r = w.core.friends(a, g, Ask('Bravo'));
  assert.deepEqual([r.done, names(r), r.asks.length], ['friends', ['Bravo'], 0]);
  assert.deepEqual(roster(w, ma), ['Bravo']);
  r = w.core.friends(b, g, List);
  assert.deepEqual(plain(r.friends), [row('Alpha', true, true)]);
  assert.equal(w.core.friends(b, g, Ask('Alpha')).done, 'friends', 'already');
  // what takes no part: oneself, a name nobody claimed, a keyphrase without a name
  assert.equal(w.core.friends(a, g, Ask('alpha')).done, 'self');
  assert.equal(w.core.friends(a, g, Ask('Delta')).done, 'claim');
  r = w.core.friends(own('D'), g, List);
  assert.deepEqual([r.me, r.done], [null, 'claim']);
  // a request declined goes from both lists
  assert.equal(w.core.friends(c, g, Ask('Alpha')).done, 'asked');
  assert.equal(w.core.friends(a, g, Answer('Charlie', false)).done, 'ok');
  assert.ok(w.core.friends(c, g, List).sent.length === 0 && w.core.friends(a, g, List).asks.length === 0);
  assert.equal(w.core.friends(a, g, Answer('Charlie', true)).done, 'none', 'nothing to answer');
  // blocked: its requests never arrive
  assert.equal(w.core.friends(a, g, Block('Charlie')).done, 'ok');
  assert.equal(w.core.friends(c, g, Ask('Alpha')).done, 'asked');
  assert.equal(w.core.friends(a, g, List).asks.length, 0);
  // over a restart: the friends are kept
  w.core.stop();
  w = worldWith(claims, storage);
  assert.deepEqual(names(w.core.friends(a, g, List)), ['Bravo']);
  // friends no more, on neither list
  assert.equal(w.core.friends(b, g, Remove('Alpha')).done, 'ok');
  assert.ok(w.core.friends(a, g, List).friends.length === 0 && w.core.friends(b, g, List).friends.length === 0);
  assert.equal(w.core.friends(b, g, Remove('Alpha')).done, 'none');
});

// friends message each other from their pages: to the Messenger of a friend logged in there, else to its pages (the
// server's hook), else the message waits and the friend's page takes it with its list; the Messenger's own messages
// to a friend who is away reach its pages too; strangers, empty messages and slurs reach no one
test('pages_message_friends', () => {
  const claims = Claims.inMemory();
  const w = worldWith(claims);
  const [a, b, c] = ['A', 'B', 'C'].map(own);
  for (const [n, o] of [['Alpha', a], ['Bravo', b], ['Charlie', c]]) claim(claims, n, o, now(w));
  const g = 'g1';
  assert.equal(w.core.friends(a, g, Ask('Bravo')).done, 'asked');
  assert.equal(w.core.friends(b, g, Ask('Alpha')).done, 'friends');
  // the pages: what they took, and whether one is open
  const got = [];
  let open = true;
  w.core.setPageMail((to, m) => {
    if (open) got.push([to, { ...m }]);
    return open;
  });
  // Bravo's page is open: it gets the message now, cut to 120 characters
  const long = 'x'.repeat(200);
  assert.equal(w.core.friends(a, g, Send('bravo', '  hi\u0007 there  ' + long)).done, 'sent');
  assert.deepEqual([got.length, got[0][0], got[0][1].from], [1, 'Bravo', 'Alpha']);
  assert.ok(got[0][1].body.startsWith('hi there xxx') && [...got[0][1].body].length === 120, got[0][1].body);
  assert.ok(w.logged('"Alpha" sent "Bravo" a message (got it)'), w.text().join('\n'));
  // no page open: it waits, and Bravo's page takes it with its list, once
  open = false;
  assert.equal(w.core.friends(a, g, Send('Bravo', 'race later?')).done, 'kept');
  assert.equal(w.core.friends(b, g, List).mail.length, 0, 'a plain list leaves them');
  const r = w.core.friends(b, g, ListMail);
  assert.deepEqual(r.mail.map((m) => [m.from, m.body]), [['Alpha', 'race later?']]);
  assert.equal(w.core.friends(b, g, ListMail).mail.length, 0);
  // Bravo's Messenger is open: the message goes there (RECV), not to the pages
  open = true;
  const [, mb] = player(w, '10.77.0.3', 'Bravo', 'B');
  w.deliver();
  assert.equal(w.core.friends(a, g, Send('Bravo', 'on my way')).done, 'sent');
  w.deliver();
  const m = w.conn(mb).l('RECV');
  assert.deepEqual([m.g('USER'), m.g('BODY')], ['Alpha', 'on my way']);
  assert.equal(got.length, 1);
  // the Messenger's own message to Alpha, who is not in it: to Alpha's pages
  w.send(mb, 'SEND', [['USER', 'Alpha'], ['BODY', 'see you'], ['SUBJ', ''], ['TYPE', 'C']]);
  assert.deepEqual([got.length, got[1][0], got[1][1].from, got[1][1].body], [2, 'Alpha', 'Bravo', 'see you']);
  // what reaches no one: a stranger's, an empty one, one without a claimed name
  assert.equal(w.core.friends(c, g, Send('Alpha', 'hey')).done, 'none');
  assert.equal(w.core.friends(a, g, Send('Bravo', ' \u0007 ')).done, 'empty');
  assert.equal(w.core.friends(own('D'), g, Send('Alpha', 'hey')).done, 'claim');
  // one that reads as a slur goes to no one (its sender sees it go); the third in the window turns them off
  const n = got.length;
  for (let i = 0; i < 3; i++) assert.equal(w.core.friends(b, g, Send('Alpha', 'SIEG HEIL')).done, 'sent');
  assert.equal(got.length, n);
  assert.ok(w.logged('"Bravo": a message with "SIEG HEIL" in it, sent to no one; messages off for 600 s'), w.text().join('\n'));
  assert.equal(w.core.friends(b, g, Send('Alpha', 'sorry')).done, 'off');
  // the Messenger's too
  w.send(mb, 'SEND', [['USER', 'Alpha'], ['BODY', 'sorry'], ['SUBJ', ''], ['TYPE', 'C']]);
  assert.equal(got.length, n);
  w.advance(600001.0);
  assert.equal(w.core.friends(b, g, Send('Alpha', 'sorry')).done, 'sent');
  assert.equal(got.length, n + 1);
});

// The 2026-11-05 security audit's one-sided friend: the Messenger's RADD LIST=B (the game sends none) put the victim
// on the adder's list at once, unasked, and the free-roam hub then linked the two anywhere and told the adder where
// the victim played.  Now it is a friend request, as RADM: on neither list until the victim accepts it.
test('a_messenger_radd_is_a_friend_request', () => {
  const claims = Claims.inMemory();
  const w = worldWith(claims);
  const a = own('A'), v = own('V');
  claim(claims, 'Mallory', a, now(w));
  claim(claims, 'Victim', v, now(w));
  const [, mv] = player(w, '10.77.0.3', 'Victim', 'V');
  const [, ma] = player(w, '10.77.0.2', 'Mallory', 'A');
  w.send(ma, 'RADD', [['USER', 'Victim'], ['LIST', 'B'], ['ID', 1]]);
  assert.equal(w.conn(ma).l('RADD').code, '');
  w.deliver();
  assert.equal(w.conn(mv).l('RNOT').g('ATTR'), 'R', "the victim's Messenger: a request to answer");
  const g = 'g1';
  let r = w.core.friends(a, g, List);
  assert.deepEqual(names(r), [], 'no friend unasked: ' + names(r));
  assert.deepEqual(r.sent, ['Victim']);
  r = w.core.friends(v, g, List);
  assert.deepEqual(names(r), []);
  assert.deepEqual(r.asks, ['Mallory']);
  // accepted: friends both ways
  w.send(mv, 'RRSP', [['USER', 'Mallory'], ['ANSW', 'Y'], ['ID', 2]]);
  r = w.core.friends(a, g, List);
  assert.deepEqual(plain(r.friends), [row('Victim', true, true)]);
});

// A one-way entry on a list (one of before RADD stopped making them, or a friend's name that its keyphrase let go and
// another one claimed since) is a name on the list only: no friendship both ways, so the pages are told nothing of
// where it is (not even whether it is online) and the hub links nothing first (the server's friends.rs)
test('a_one_way_friend_is_told_nothing', () => {
  const claims = Claims.inMemory();
  const w = worldWith(claims, new MapStorage());
  const [a, v, b, c] = ['A', 'V', 'B', 'C'].map(own);
  for (const [n, o] of [['Mallory', a], ['Victim', v], ['Bravo', b]]) claim(claims, n, o, now(w));
  const [, ma] = player(w, '10.77.0.2', 'Mallory', 'A');
  const [, mv] = player(w, '10.77.0.3', 'Victim', 'V');
  const [, mb] = player(w, '10.77.0.4', 'Bravo', 'B');
  befriend(w, ma, mv, 'Victim', 'Mallory');
  befriend(w, ma, mb, 'Bravo', 'Mallory');
  const g = 'g1';
  assert.deepEqual(plain(w.core.friends(a, g, List).friends), [row('Victim', true), row('Bravo', true)]);
  // Victim's list no longer names Mallory (as a list of before RADD's would not)
  w.core.buddies.lists.get('victim').b.delete('mallory');
  // Bravo's keyphrase let its name go, and another claimed it: Bravo's old list, still in memory, is not the new
  // claimer's
  claims.release(b);
  claim(claims, 'Bravo', c, now(w));
  assert.deepEqual(plain(w.core.friends(a, g, List).friends), [row('Victim', false), row('Bravo', false)]);
  assert.equal(w.core.friends(v, g, List).friends.length, 0);
  // a one-way entry is asked as anyone: a request that waits for its answer, then friends both ways
  assert.equal(w.core.friends(a, g, Ask('Victim')).done, 'asked');
  assert.deepEqual(w.core.friends(v, g, List).asks, ['Mallory']);
  assert.equal(w.core.friends(v, g, Answer('Mallory', true)).done, 'friends');
  assert.deepEqual(plain(w.core.friends(a, g, List).friends), [row('Victim', true), row('Bravo', false)]);
});

// a page's Discord username: Discord's form only (taken as typed, with a leading @ and capitals let go), not one the
// name filter refuses; its friends both ways see it on their lists, nobody else; "" takes it away; kept over a
// restart; the log says it changed, never what it is
test('pages_give_friends_a_discord_name', () => {
  const storage = new MapStorage();
  const claims = Claims.inMemory();
  let w = worldWith(claims, storage);
  const [a, b, c] = ['A', 'B', 'C'].map(own);
  for (const [n, o] of [['Alpha', a], ['Bravo', b], ['Charlie', c]]) claim(claims, n, o, now(w));
  const g = 'g1';
  const seen = (w, o, name) => {
    const f = w.core.friends(o, g, List).friends.find((f) => f.name === name);
    return f ? f.contact : null;
  };
  assert.equal(w.core.friends(a, g, Ask('Bravo')).done, 'asked');
  assert.equal(w.core.friends(b, g, Ask('Alpha')).done, 'friends');
  // Charlie asked Alpha, who did not answer: no friend
  assert.equal(w.core.friends(c, g, Ask('Alpha')).done, 'asked');
  let r = w.core.friends(a, g, Discord('  @Alpha.Drives_9 '));
  assert.deepEqual([r.done, r.contact], ['ok', 'alpha.drives_9']);
  assert.equal(seen(w, b, 'Alpha'), 'alpha.drives_9');
  assert.equal(w.core.friends(c, g, List).friends.length, 0, 'a request is no friendship');
  assert.ok(w.logged('"Alpha" set a Discord name') && !w.logged('alpha.drives_9'));
  // not Discord's form, or a name the filter refuses: refused, the one before kept
  for (const bad of ['a', 'a..b', 'ann drives', 'ann-drives', 'ännchen', '#1234', 'x'.repeat(33), 'hitler.fan']) {
    r = w.core.friends(a, g, Discord(bad));
    assert.deepEqual([r.done, r.contact], ['name', 'alpha.drives_9'], bad);
  }
  assert.equal(w.core.friends(a, g, Discord('._.')).contact, '._.', 'Discord allows it');
  // over a restart
  w.core.buddySave();
  w.core.stop();
  w = worldWith(claims, storage);
  assert.equal(seen(w, b, 'Alpha'), '._.');
  assert.equal(w.core.friends(a, g, List).contact, '._.');
  // a player without friends gives one too (its list made for it), and takes it away again
  assert.equal(w.core.friends(c, g, Discord('charlie')).contact, 'charlie');
  r = w.core.friends(c, g, Discord(' '));
  assert.deepEqual([r.done, r.contact], ['ok', null]);
  assert.ok(w.logged('"Charlie" took its Discord name away'));
  // friends no more: Bravo sees it no more
  assert.equal(w.core.friends(b, g, Remove('Alpha')).done, 'ok');
  w.core.friends(b, g, Ask('Alpha'));
  assert.equal(seen(w, b, 'Alpha'), null, 'a request again is no friendship');
});

