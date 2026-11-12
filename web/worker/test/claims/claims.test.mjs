// A port of web/server-rs/crates/claims/src/tests.rs (nfsu2-claims' unit tests) to web/worker/src/claims/claims.js.
// The Rust's names.json in a directory is storage here (Claims.open(storage, now) / save(storage, now) over a
// Map-backed {get, put}); the file mode check (0o600) has no storage counterpart and is left out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANGE_DAYS,
  Claims,
  DAY_MS,
  GRACE_DAYS,
  HOLD_DAYS,
  NAMES_KEY,
  SECOND_BASE,
  canonical,
  clean,
  ownerOfId,
  ownerOfToken,
  second,
  secondBase,
} from '../../src/claims/claims.js';
import { sha256 } from '../../src/util/sha256.js';

const NOW = 1800000000000;

function owner(n) {
  const o = ownerOfToken(String(n) + 'A'.repeat(42));
  assert.ok(o !== null, 'a token');
  return o;
}

/** a Map-backed storage (the Rust's directory with its names.json) */
function storage() {
  const m = new Map();
  return { m, get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v) };
}

/** Result::unwrap of a claim */
function unwrap(r) {
  assert.ok(r && 'ok' in r, 'a claim: ' + JSON.stringify(r));
  return r.ok;
}

const FREE = { kind: 'free' };
const TAKEN = { kind: 'taken' };
const yours = (until, current) => ({ kind: 'yours', until, current });

// the Online form is runtime/online.c's clean(): the same cases as its comment gives
test('the Online form', () => {
  assert.equal(clean('Alex'), 'Alex');
  assert.equal(clean('Alex the Great'), 'Alex_the_Great');
  assert.equal(clean('  Alex!!'), 'Alex');
  assert.equal(clean('a'), 'a__');
  assert.equal(clean('é!?'), null);
  assert.equal(clean(''), null);
  // cut to 15, and no _ that would only fit at the end
  assert.equal(clean('abcdefghijklmn opq'), 'abcdefghijklmno');
  assert.equal(clean('abcdefghijklm nop'), 'abcdefghijklm_n');
  assert.equal(clean('abcdefghijklmn op'), 'abcdefghijklmno');
  assert.equal(canonical('ALEX'), 'alex');
  // (the page's web/test/claim.test.mjs has these too)
  assert.equal(clean('x\u{1F600}y'), 'x_y');
  assert.equal(clean('G\u{f6}khan'), 'G_khan');
});

test('tokens and owners', () => {
  assert.equal(ownerOfToken('short'), null);
  assert.ok(ownerOfToken('A'.repeat(43)) !== null);
  assert.equal(ownerOfToken('A'.repeat(42) + '+'), null, 'base64url only');
  const o = ownerOfToken('A'.repeat(43));
  assert.equal(o.length, 22);
  // the vault's id is the token's SHA-256: the same owner from either
  const id = sha256(new TextEncoder().encode('A'.repeat(43)));
  assert.equal(ownerOfId(id), o);
});

test('a claim and who may use it', () => {
  const c = Claims.inMemory();
  const a = owner(1), b = owner(2);
  assert.deepEqual(c.status('Alex', a, NOW), FREE);
  const m = unwrap(c.claim('Alex', a, NOW));
  assert.deepEqual(m, { name: 'Alex', until: NOW + HOLD_DAYS * DAY_MS, nextChange: 0 });
  assert.deepEqual(c.status('alex', a, NOW), yours(NOW + HOLD_DAYS * DAY_MS, true));
  assert.deepEqual(c.status('ALEX', b, NOW), TAKEN);
  assert.deepEqual(c.status('Alex', null, NOW), TAKEN);
  assert.deepEqual(c.claim('aLeX', b, NOW), { err: { kind: 'taken' } });
  assert.ok(c.mayUse('Alex', a, NOW));
  assert.ok(!c.mayUse('Alex', b, NOW));
  assert.ok(!c.mayUse('Alex', null, NOW));
  assert.ok(c.mayUse('Alex4821', null, NOW));
  // the same name in other characters is the same Online name
  assert.deepEqual(c.status('Alex!', b, NOW), TAKEN);
  assert.equal(c.holder('alex', NOW), a);
});

test('defaults, slurs and nonsense are never claimed', () => {
  const c = Claims.inMemory();
  const a = owner(1);
  for (const n of ['NAME', 'name', 'Player', 'PLAYER', ' Player ']) {
    assert.deepEqual(c.status(n, a, NOW), { kind: 'default' }, n);
    assert.deepEqual(c.claim(n, a, NOW), { err: { kind: 'default' } }, n);
  }
  for (const n of ['Nigger', 'N1gg3r', 'n i g g e r', 'Hitler', 'xX_Hitler_Xx', '1488Racer', 'Fag']) {
    assert.deepEqual(c.status(n, a, NOW), { kind: 'blocked' }, n);
    assert.deepEqual(c.claim(n, a, NOW), { err: { kind: 'blocked' } }, n);
  }
  // a lookalike letter the Online form leaves out: read as typed
  assert.deepEqual(c.claim('N\u{0456}gger', a, NOW), { err: { kind: 'blocked' } });
  for (const n of ['', '!!!', 'ééé']) {
    assert.deepEqual(c.claim(n, a, NOW), { err: { kind: 'invalid' } }, JSON.stringify(n));
  }
  // swear words are names (nfsu2-names' scope)
  assert.ok('ok' in c.claim('Kurwa', a, NOW));
  assert.equal(c.count(NOW), 1);
});

test('a claim holds two years after the last game', () => {
  const c = Claims.inMemory();
  const a = owner(1), b = owner(2);
  unwrap(c.claim('Alex', a, NOW));
  const later = NOW + 100 * DAY_MS;
  c.seen('Alex', a, later);
  assert.equal(c.mine(a, later).until, later + HOLD_DAYS * DAY_MS);
  // another keyphrase's play does not hold it
  c.seen('Alex', b, later + DAY_MS);
  assert.equal(c.mine(a, later).until, later + HOLD_DAYS * DAY_MS);
  const gone = later + HOLD_DAYS * DAY_MS;
  assert.deepEqual(c.status('Alex', b, gone - 1), TAKEN);
  assert.deepEqual(c.status('Alex', b, gone), FREE);
  assert.equal(c.mine(a, gone), null);
  assert.ok('ok' in c.claim('Alex', b, gone));
});

// the keyphrase's cloud saves read or saved hold its current name as long as the keyphrase, not the name it changed from
test('a claim lasts as long as its keyphrase', () => {
  const c = Claims.inMemory();
  const a = owner(1), b = owner(2);
  unwrap(c.claim('Alex', a, NOW));
  const later = NOW + 500 * DAY_MS;
  c.used(a, later);
  assert.equal(c.mine(a, later).until, later + HOLD_DAYS * DAY_MS);
  // another keyphrase's use does not, nor a keyphrase without a name
  c.used(b, later + DAY_MS);
  assert.equal(c.mine(a, later).until, later + HOLD_DAYS * DAY_MS);
  assert.equal(c.mine(b, later), null);
  // after a change the old name keeps its grace, the new one holds from the use
  unwrap(c.claim('Racer', a, later + 2 * DAY_MS));
  c.used(a, later + 3 * DAY_MS);
  assert.deepEqual(c.status('Alex', a, later + 3 * DAY_MS), yours(later + 2 * DAY_MS + GRACE_DAYS * DAY_MS, false));
  assert.equal(c.mine(a, later + 3 * DAY_MS).until, later + 3 * DAY_MS + HOLD_DAYS * DAY_MS);
});

test('one name a keyphrase and one change a week', () => {
  const c = Claims.inMemory();
  const a = owner(1), b = owner(2);
  unwrap(c.claim('Alex', a, NOW));
  // the first change is free, at once
  const m = unwrap(c.claim('Speedy', a, NOW + 60000));
  assert.equal(m.name, 'Speedy');
  assert.equal(m.nextChange, NOW + 60000 + CHANGE_DAYS * DAY_MS);
  // the name before stays its own for GRACE_DAYS: nobody else takes it, and it may go back to it
  assert.deepEqual(c.status('Alex', a, NOW + DAY_MS), yours(NOW + 60000 + GRACE_DAYS * DAY_MS, false));
  assert.deepEqual(c.status('Alex', b, NOW + DAY_MS), TAKEN);
  assert.ok(c.mayUse('Alex', a, NOW + DAY_MS));
  assert.equal(c.previous(a, NOW + DAY_MS), 'alex');
  // the next change waits a week
  assert.deepEqual(c.claim('Racer', a, NOW + DAY_MS), { err: { kind: 'tooSoon', next: NOW + 60000 + CHANGE_DAYS * DAY_MS } });
  assert.deepEqual(c.claim('Alex', a, NOW + DAY_MS), { err: { kind: 'tooSoon', next: NOW + 60000 + CHANGE_DAYS * DAY_MS } });
  // its current name again is no change
  assert.ok('ok' in c.claim('speedy', a, NOW + DAY_MS));
  assert.equal(c.mine(a, NOW + DAY_MS).name, 'speedy', 'as typed now');
  // after the grace, the old name is free
  const after = NOW + 60000 + GRACE_DAYS * DAY_MS;
  assert.deepEqual(c.status('Alex', b, after), FREE);
  assert.equal(c.previous(a, after), null);
  // and after the week, a change again
  const week = NOW + 60000 + CHANGE_DAYS * DAY_MS;
  assert.equal(unwrap(c.claim('Racer', a, week)).name, 'Racer');
  assert.deepEqual(c.status('speedy', a, week), yours(week + GRACE_DAYS * DAY_MS, false));
});

test('a keyphrase deleted lets its names go', () => {
  const c = Claims.inMemory();
  const a = owner(1), b = owner(2);
  unwrap(c.claim('Alex', a, NOW));
  unwrap(c.claim('Speedy', a, NOW + 1));
  unwrap(c.claim('Other', b, NOW));
  const g = c.generation();
  assert.equal(c.release(a), 2);
  assert.ok(c.generation() > g);
  assert.deepEqual(c.status('Alex', null, NOW + 2), FREE);
  assert.deepEqual(c.status('Speedy', null, NOW + 2), FREE);
  assert.deepEqual(c.status('Other', null, NOW + 2), TAKEN);
  assert.equal(c.mine(a, NOW + 2), null);
  assert.equal(c.unclaim('other'), 'Other');
  assert.deepEqual(c.status('Other', null, NOW + 2), FREE);
  assert.equal(c.mine(b, NOW + 2), null);
});

test('names.json read and written again', async () => {
  const dir = storage();
  const a = owner(1), b = owner(2);
  {
    const c = await Claims.open(dir, NOW);
    assert.ok(!(await c.save(dir, NOW)), 'nothing to write');
    unwrap(c.claim('Alex', a, NOW));
    unwrap(c.claim('Speedy', a, NOW + 1));
    unwrap(c.claim('Other', b, NOW + 2));
    assert.ok(await c.save(dir, NOW + 3));
    assert.ok(!(await c.save(dir, NOW + 4)));
  }
  const text = dir.m.get(NAMES_KEY);
  assert.equal(typeof text, 'string');
  // (the Rust also checks the file's mode, 0o600: storage has none)
  let c = await Claims.open(dir, NOW + 5);
  assert.equal(c.serialize(NOW + 5), text);
  assert.equal(c.mine(a, NOW + 5).name, 'Speedy');
  assert.equal(c.mine(a, NOW + 5).nextChange, NOW + 1 + CHANGE_DAYS * DAY_MS);
  assert.equal(c.previous(a, NOW + 5), 'alex');
  assert.deepEqual(c.status('Alex', b, NOW + 5), TAKEN);
  // read again after the grace and the hold: what ended is left out
  c = await Claims.open(dir, NOW + 1 + GRACE_DAYS * DAY_MS);
  assert.deepEqual(c.status('Alex', b, NOW + 1 + GRACE_DAYS * DAY_MS), FREE);
  c = await Claims.open(dir, NOW + 2 + HOLD_DAYS * DAY_MS);
  assert.equal(c.count(NOW + 2 + HOLD_DAYS * DAY_MS), 0);
});

test('a file edited by hand', async () => {
  const dir = storage();
  const a = owner(1);
  const n = NOW, m = NOW + 1;
  const text = '{"v":1,"claims":[\n' +
    '            {"name":"Alex","owner":"' + a + '","made":' + n + ',"seen":' + n + '},\n' +
    '            {"name":"Newer","owner":"' + a + '","made":' + m + ',"seen":' + m + '},\n' +
    '            {"name":"NAME","owner":"' + a + '","made":' + n + ',"seen":' + n + '},\n' +
    '            {"name":"Hitler","owner":"' + a + '","made":' + n + ',"seen":' + n + '},\n' +
    '            {"name":"x","owner":"short","made":' + n + ',"seen":' + n + '},\n' +
    '            {"name":"No Time","owner":"' + a + '"},\n' +
    '            7\n' +
    '        ],"owners":"no"}';
  await dir.put(NAMES_KEY, text);
  const c = await Claims.open(dir, NOW + 2);
  assert.equal(c.count(NOW + 2), 1, 'only the newer current name');
  assert.equal(c.mine(a, NOW + 2).name, 'Newer');
  await dir.put(NAMES_KEY, '{not json');
  assert.equal((await Claims.open(dir, NOW)).count(NOW), 0);
});

// the second form, co-op's second player's name: the Online form cut to 13, then _2, as the page's "<that> 2" is
test('the second form', () => {
  assert.equal(second('Alex'), 'Alex_2');
  assert.equal(second('Alex the Great'), 'Alex_the_Grea_2');
  assert.equal(second('a'), 'a___2');
  assert.equal(second('!!'), null);
  // the page's name for player 2 is its Online form's first 13 and " 2": the same Online form
  for (const n of ['Alex', 'Alex the Great', 'abcdefghijklmno', 'a', 'x_y', 'Bob_', 'Ab-c']) {
    const base = clean(n);
    assert.ok(base !== null);
    const page = base.slice(0, Math.min(base.length, SECOND_BASE)) + ' 2';
    assert.equal(clean(page), second(n), n + ': ' + page);
    assert.equal(secondBase(canonical(page)), base.toLowerCase().slice(0, Math.min(base.length, SECOND_BASE)), n);
  }
  assert.equal(secondBase('alex_2'), 'alex');
  assert.equal(secondBase('alex'), null);
  assert.equal(secondBase('ab_2'), null, 'no Online form of two');
  assert.equal(secondBase('alex_3'), null);
});

// the second form of a claimed name is its owner's: to it "yours" (an old name's "old"), to anyone else taken; nobody
// else plays under it or claims it; its owner's claim of it changes nothing
test("a claimed name's second form is its owner's", () => {
  const c = Claims.inMemory();
  const a = owner(1), b = owner(2);
  assert.deepEqual(c.status('Alex 2', b, NOW), FREE, 'nobody claimed Alex');
  assert.ok(c.mayUse('Alex 2', b, NOW));
  unwrap(c.claim('Alex', a, NOW));
  const until = NOW + HOLD_DAYS * DAY_MS;
  for (const n of ['Alex 2', 'alex_2', 'ALEX 2!']) {
    assert.deepEqual(c.status(n, a, NOW), yours(until, true), n);
    assert.deepEqual(c.status(n, b, NOW), TAKEN, n);
    assert.deepEqual(c.status(n, null, NOW), TAKEN, n);
    assert.ok(c.mayUse(n, a, NOW), n);
    assert.ok(!c.mayUse(n, b, NOW) && !c.mayUse(n, null, NOW), n);
  }
  assert.deepEqual(c.status('Alex 3', b, NOW), FREE, 'only the second form');
  assert.deepEqual(c.status('Alex 2 2', b, NOW), FREE, "not the second form's second");
  assert.deepEqual(c.claim('Alex 2', b, NOW), { err: { kind: 'taken' } });
  const g = c.generation();
  assert.equal(unwrap(c.claim('Alex 2', a, NOW + 1)).name, 'Alex', 'its own already: no change');
  assert.equal(c.generation(), g);
  assert.equal(c.holder('Alex 2', NOW), null, "Messenger's holder: the claim of the name itself");
  assert.deepEqual(c.holders('Alex 2', NOW), [a]);
  assert.deepEqual(c.holders('Alex', NOW), [a]);
  assert.deepEqual(c.holders('Bob 2', NOW), []);
  // after a change, the old name's second form stays its own for the grace, and the new one's is its own too
  unwrap(c.claim('Speedy', a, NOW + DAY_MS));
  const grace = NOW + DAY_MS + GRACE_DAYS * DAY_MS;
  assert.deepEqual(c.status('Alex 2', a, NOW + 2 * DAY_MS), yours(grace, false));
  assert.deepEqual(c.status('Speedy 2', a, NOW + 2 * DAY_MS), yours(NOW + DAY_MS + HOLD_DAYS * DAY_MS, true));
  assert.deepEqual(c.claim('Alex 2', b, NOW + 2 * DAY_MS), { err: { kind: 'taken' } });
  assert.deepEqual(c.status('Alex 2', b, grace), FREE, 'the grace over');
  // a keyphrase deleted: the second forms go with its names
  c.release(a);
  assert.deepEqual(c.status('Speedy 2', b, NOW + 2 * DAY_MS), FREE);
  assert.ok('ok' in c.claim('Speedy 2', b, NOW + 2 * DAY_MS));
});

// a claim of the second form made before its name was claimed stays its claimant's: an exact claim comes first
test('an exact claim of a second form comes first', () => {
  const c = Claims.inMemory();
  const a = owner(1), b = owner(2);
  unwrap(c.claim('Alex_2', b, NOW));
  unwrap(c.claim('Alex', a, NOW));
  assert.deepEqual(c.status('Alex 2', a, NOW), TAKEN);
  assert.deepEqual(c.status('Alex 2', b, NOW), yours(NOW + HOLD_DAYS * DAY_MS, true));
  assert.ok(!c.mayUse('Alex 2', a, NOW));
  assert.ok(c.mayUse('Alex 2', b, NOW));
  assert.deepEqual(c.holders('Alex 2', NOW), [b]);
  // and once it is let go, the second form is Alex's
  c.unclaim('Alex_2');
  assert.ok(c.mayUse('Alex 2', a, NOW) && !c.mayUse('Alex 2', b, NOW));
  // so for a name of 13 too: its second form's claim (of 15) is no name that shares it
  const x = owner(3);
  unwrap(c.claim('Abcdefghijklm_2', b, NOW + 1));
  unwrap(c.claim('Abcdefghijklm', x, NOW + 1));
  assert.deepEqual(c.holders('Abcdefghijklm 2', NOW + 1), [b]);
});

// names of 13, 14 and 15 characters that begin alike have one second form: a keyphrase claims none of them while
// another keyphrase holds one, either way round (the 2026-11-05 security audit: a free "Speedracer123x" made its
// claimant the second player of "Speedracer123", no impostor, and a block of that second player blocked
// "Speedracer123" too); the owner's own change to another of them is none
test("a name that shares another's second form is taken", () => {
  const c = Claims.inMemory();
  const v = owner(1), a = owner(2), b = owner(3);
  unwrap(c.claim('Speedracer123', v, NOW));
  const p2 = 'Speedracer123 2';
  for (const n of [p2, 'Speedracer123x', 'SPEEDRACER123xy']) {
    assert.deepEqual(c.status(n, a, NOW), TAKEN, n);
    assert.deepEqual(c.claim(n, a, NOW), { err: { kind: 'taken' } }, n);
  }
  assert.deepEqual(c.status('Speedracer123x', v, NOW), FREE, 'its own to claim');
  assert.equal(c.mine(a, NOW), null);
  assert.ok(c.mayUse(p2, v, NOW) && !c.mayUse(p2, a, NOW));
  assert.deepEqual(c.status(p2, a, NOW), TAKEN);
  assert.deepEqual(c.holders(p2, NOW), [v]);
  // a name of 14 first, then its 13 (or another 15 that begins alike)
  unwrap(c.claim('Alex the Great', a, NOW));
  assert.deepEqual(c.claim('Alex the Grea', b, NOW), { err: { kind: 'taken' } });
  assert.deepEqual(c.claim('Alex the Greats', b, NOW), { err: { kind: 'taken' } });
  assert.deepEqual(c.holders('Alex the Grea 2', NOW), [a]);
  assert.ok('ok' in c.claim('Alex the Gre', b, NOW), '12: its own second form');
  // its owner changes to another of them: no one else's
  assert.equal(unwrap(c.claim('Speedracer123x', v, NOW + 1)).name, 'Speedracer123x');
  assert.ok(c.mayUse(p2, v, NOW + 1) && !c.mayUse(p2, a, NOW + 1));
  // once its names are let go, they are anyone's
  c.release(v);
  assert.ok('ok' in c.claim('Speedracer123xy', a, NOW + 2));
  assert.ok(c.mayUse(p2, a, NOW + 2));
});

// Claims of before that share a second form (names.json: made before a claim of one was refused) give it to one
// keyphrase: the holder of the name of 13, else the oldest claim's.  It goes with the last of them (the operator's
// unclaim, a release, the hold's end), and holds over a restart.
test('claims of before that share a second form give it to one', async () => {
  const dir = storage();
  const a = owner(1), b = owner(2), x = owner(3), y = owner(4);
  const claim = (name, o, made) => '{"name":"' + name + '","owner":"' + o + '","made":' + made + ',"seen":' + made + '}';
  const claims = [claim('Abcdefghijklmn', a, NOW + 1), claim('ABCDEFGHIJKLMNO', b, NOW), claim('abcdefghijklm', x, NOW + 2)];
  await dir.put(NAMES_KEY, '{"v":1,"claims":[' + claims.join(',') + ']}');
  const t = NOW + 10;
  let c = await Claims.open(dir, t);
  assert.equal(c.count(t), 3);
  const p2 = 'Abcdefghijklm 2';
  // the name of 13's holder, the youngest of them
  assert.deepEqual(c.holders(p2, t), [x]);
  assert.ok(c.mayUse(p2, x, t) && !c.mayUse(p2, a, t) && !c.mayUse(p2, b, t));
  // without it, the oldest claim's
  assert.equal(c.unclaim('abcdefghijklm'), 'abcdefghijklm');
  assert.deepEqual(c.holders(p2, t), [b]);
  assert.ok(c.mayUse(p2, b, t) && !c.mayUse(p2, a, t) && !c.mayUse(p2, null, t));
  assert.deepEqual(c.status(p2, a, t), TAKEN);
  assert.deepEqual(c.status(p2, b, t), yours(NOW + HOLD_DAYS * DAY_MS, true));
  assert.deepEqual(c.claim(p2, a, t), { err: { kind: 'taken' } });
  assert.deepEqual(c.claim('abcdefghijklm', y, t), { err: { kind: 'taken' } }, 'no third one');
  // over a restart
  assert.ok(await c.save(dir, t));
  c = await Claims.open(dir, t + 1);
  assert.deepEqual(c.holders(p2, t + 1), [b]);
  // b's keyphrase deleted: a's (and only b's name left the index)
  assert.equal(c.release(b), 1);
  assert.deepEqual(c.holders(p2, t + 1), [a]);
  assert.deepEqual(c.long.get('abcdefghijklm'), ['abcdefghijklmn']);
  assert.equal(c.unclaim('abcdefghijklmn'), 'Abcdefghijklmn');
  assert.equal(c.long.size, 0);
  assert.deepEqual(c.status(p2, y, t + 1), FREE);
  // a claim's end lets its second form go (the prune's index)
  unwrap(c.claim('Abcdefghijklmnz', y, t + 2));
  assert.ok(!c.mayUse(p2, x, t + 2));
  const end = t + 2 + HOLD_DAYS * DAY_MS;
  assert.ok(c.prune(end));
  assert.ok(c.mayUse(p2, x, end));
});

