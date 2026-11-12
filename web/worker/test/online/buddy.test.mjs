// The tests of crates/online/src/buddy.rs (its tests module), and a smoke run of the Messenger's commands on a
// stand-in for the core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, MapStorage } from '../../src/online/files.js';
import { LIMITS } from '../../src/online/rules.js';
import { FieldMap, FrameReader } from '../../src/online/aries.js';
import { latin1Bytes } from '../../src/online/jsx.js';
import {
  Buddies, BUDDY_LIMITS, buddyMethods, discordName, sweep, listJson, listOfJson, shelfTexts, shelfReread, shelfFile,
  newFriendsList,
} from '../../src/online/buddy.js';

let claimsMod = null;
try {
  claimsMod = await import('../../src/claims/claims.js');
} catch {
  claimsMod = null;
}

const MAX_FRIENDS = 250;

// buddies.json of before read leniently and moved onto the shelf, one file a list, each request on both lists
test('buddies.json moved onto the shelf', () => {
  const friends = [];
  for (let i = 0; i < 260; i++) friends.push('"Friend' + i + '"');
  const many = '{"personas":[{"name":"Many","seen":"2026-03","B":[' + friends.join(',') + ']}]}';
  const most = '{"v":4,"name":"Many","seen":"2026-03","B":[' + friends.slice(0, MAX_FRIENDS).join(',') + ']}';
  const mail = [];
  for (let i = 0; i < 25; i++) mail.push('{"from":"Friend1","t":' + i + ',"body":"m' + i + '","subj":"","type":"C"}');
  const lots = '{"v":3,"personas":[{"name":"Inbox","seen":"2026-10","B":["Friend1"],"M":[' + mail.join(',') + ']}]}';
  const twenty = '{"v":4,"name":"Inbox","seen":"2026-10","B":["Friend1"],"M":[' + mail.slice(5).join(',') + ']}';
  const cases = [
    ['{not json', []],
    ['', []],
    [
      '{"v":2,"note":"NFSU2 online friends lists (persona names only)","personas":[{"name":"Alpha","seen":"2026-10","B":["Bravo","Charlie"]}]}',
      ['{"v":4,"name":"Alpha","seen":"2026-10","B":["Bravo","Charlie"]}'],
    ],
    [
      '{"personas":[{"name":"Alpha","seen":"2026-10","B":["Bravo","bravo","x y",5,null,"Delta"],"I":["Mallory"]},{"name":"alpha","seen":"2026-09","B":["Echo"]}]}',
      ['{"v":4,"name":"Alpha","seen":"2026-10","B":["bravo","Delta"],"I":["Mallory"]}'],
    ],
    [
      '{"personas":[{"name":"NoFriends","seen":"2026-10","B":[]},{"name":"Bad Name","B":["Alpha"]},{"name":"Old","B":["Alpha"]},{"name":"Mid","seen":"2026-05","B":["Alpha"]},{"name":"New","seen":"2026-12","B":"Alpha"},{"name":"Newer","seen":"2027-01","B":["Zed"]}]}',
      [
        '{"v":4,"name":"Mid","seen":"2026-05","B":["Alpha"]}',
        '{"v":4,"name":"Newer","seen":"2027-01","B":["Zed"]}',
        '{"v":4,"name":"Old","seen":"1970-01","B":["Alpha"]}',
      ],
    ],
    [many, [most]],
    [
      '{"v":3,"personas":[{"name":"Alpha","seen":"2026-10","B":["Bravo"],"I":["Mallory","x y"],"R":[["Charlie",1761200000000],["x y",1],["Delta"],["Echo",-5]],"M":[{"from":"Bravo","t":1761200000123.7,"body":"hi\\u0007 there","subj":"","type":"C"},{"from":"x y","t":1,"body":"no"},{"from":"Bravo","body":"no time"}]},{"name":"Lonely","seen":"2026-10","B":[],"R":[["Alpha",5]]}]}',
      [
        '{"v":4,"name":"Alpha","seen":"2026-10","B":["Bravo"],"I":["Mallory"],"R":[["Charlie",1761200000000]],"Q":[["Lonely",5]],"M":[{"from":"Bravo","t":1761200000123,"body":"hi there","subj":"","type":"C"}]}',
        '{"v":4,"name":"Charlie","seen":"1970-01","B":[],"Q":[["Alpha",1761200000000]]}',
        '{"v":4,"name":"Lonely","seen":"2026-10","B":[],"R":[["Alpha",5]]}',
      ],
    ],
    [lots, [twenty]],
  ];
  for (const [text, kept] of cases) {
    const store = new Store(new MapStorage());
    assert.equal(store.put('buddies.json', text), null);
    new Buddies({ store, limits: BUDDY_LIMITS, claims: null, now: 0 });
    assert.deepEqual(shelfTexts(store), kept, text);
    assert.ok(store.get('buddies.json') === null && store.get('buddies.json.moved') === text, text);
    assert.deepEqual(shelfReread(store), kept, text);
  }
});

// a list read from the shelf the next time it is needed, as it was written; lists past lists go from memory (written
// first) and come back from the shelf; the sweep takes the lists of claims that ended
test('lists come and go from memory', { skip: claimsMod === null ? 'web/worker/src/claims/claims.js is not there yet' : false }, () => {
  const { Claims, ownerOfToken } = claimsMod;
  const store = new Store(new MapStorage());
  const claims = Claims.inMemory ? Claims.inMemory() : new Claims();
  const a = ownerOfToken('A'.repeat(43)), b = ownerOfToken('B'.repeat(43));
  claims.claim('Alpha', a, 0);
  claims.claim('Bravo', b, 0);
  const s = new Buddies({ store, limits: { ...BUDDY_LIMITS, lists: 2 }, claims, now: 0 });
  const none = () => false;
  for (const [n, o] of [['Alpha', a], ['Bravo', b]]) {
    const x = newFriendsList(n, '2026-10');
    x.owner = o;
    s.putList(n.toLowerCase(), x);
  }
  s.addFriend('alpha', 'bravo', 'Bravo');
  s.addFriend('bravo', 'alpha', 'Alpha');
  s.ask('alpha', 'charlie', 'Charlie', 7);
  assert.equal(s.writeDirty(), null);
  // a third list pushes the least recently seen out of memory
  s.makeRoom(none);
  s.lists.set('charlie', newFriendsList('Charlie', '2026-10'));
  assert.ok(!s.lists.has('alpha') && !s.fans.has('bravo'), "Alpha's list out, and its fan entry");
  assert.ok(s.fetch('alpha', 0, none), 'back from the shelf');
  const x = s.list('Alpha');
  assert.deepEqual([[...x.b.keys()], x.r.size, x.owner], [['bravo'], 1, a]);
  // (Bravo's went for it) a list the caller pins is never pushed out: Charlie's goes for Bravo's
  assert.ok(!s.lists.has('bravo'));
  assert.ok(s.fetch('bravo', 0, (k) => k === 'alpha'));
  assert.ok(s.lists.has('alpha') && !s.lists.has('charlie'));
  // a claim that ended: its list goes from the shelf when it is read, or when the shelf is swept
  claims.release(b);
  assert.equal(sweep(store, claims, 0, new Set()), 1);
  assert.ok(store.get(shelfFile('bravo')) === null && store.get(shelfFile('alpha')) !== null);
});

test('discord names', () => {
  assert.equal(discordName('  @Some.One_9 '), 'some.one_9');
  assert.equal(discordName('a'), null);
  assert.equal(discordName('a..b'), null);
  assert.equal(discordName('x'.repeat(33)), null);
  assert.equal(discordName('\uFEFFabc'), null, 'Rust trim leaves U+FEFF');
  assert.equal(discordName('\u0085abc'), 'abc', 'Rust trim takes U+0085');
  assert.equal(discordName('Ünï'), null);
});

test('a list written and read again', () => {
  const l = newFriendsList('Alpha', '2026-11');
  l.owner = 'A'.repeat(22);
  l.b.set('bravo', 'Bravo');
  l.r.set('charlie', ['Charlie', 1761200000000]);
  l.m.push({ from: 'Bravo', body: 'he said "hi"\\', subj: '', kind: 'C', t: 5 });
  l.contact = 'alpha.d';
  const t = listJson(l);
  assert.equal(t, '{"v":4,"name":"Alpha","seen":"2026-11","owner":"AAAAAAAAAAAAAAAAAAAAAA","B":["Bravo"],"R":[["Charlie",1761200000000]],"M":[{"from":"Bravo","t":5,"body":"he said \\"hi\\"\\\\","subj":"","type":"C"}],"C":"alpha.d"}');
  assert.equal(listJson(listOfJson(JSON.parse(t))), t);
  assert.match(shelfFile('alpha'), /^friends\/[0-9a-f]{2}\/[0-9a-f]{32}\.json$/);
});

// ---- a smoke run on a stand-in core (no lobby.js here: its sessions are given by hand) ----

function frame(kind, fields) {
  const body = fields.map(([k, v]) => k + '=' + v).join('\n') + '\0';
  const b = latin1Bytes('    ' + '\0\0\0\0' + '\0\0\0\0' + body);
  for (let i = 0; i < 4; i++) b[i] = kind.charCodeAt(i);
  const n = b.length;
  b[8] = n >>> 24; b[9] = (n >>> 16) & 255; b[10] = (n >>> 8) & 255; b[11] = n & 255;
  return b;
}

function host(storage) {
  let t = 1762900000000;
  const out = [];
  const logs = [];
  const sessions = new Map();
  const timers = new Map();
  let tid = 0;
  const conns = new Map();
  const h = Object.assign(Object.create(null), buddyMethods, {
    clocks: { now: () => t, timer: () => t },
    store: storage ? new Store(storage) : null,
    lobby: {
      l: LIMITS,
      byPersona: new Map(),
      ofVip: (vip) => [...sessions].filter(([, s]) => s.vip === vip).map(([id]) => id),
      s: (id) => sessions.get(id),
    },
    stats: { startingWith: () => [] },
    timers: { clear: (id) => timers.delete(id) },
    setTimeout(ms, a) {
      tid += 1;
      timers.set(tid, a);
      return tid;
    },
    log: (line) => logs.push(line),
    consoleError: (line) => logs.push('ERR ' + line),
    connIds: (c) => (conns.has(c) ? [conns.get(c).vip, '', 'g' + conns.get(c).vip, 's'] : null),
    connOpen: (c) => conns.has(c) && conns.get(c).open,
    connWrite(c, f) {
      const r = new FrameReader();
      for (const m of r.push(f)) out.push([c, m.kind, m.code, [...FieldMap.parse(m.body).m].map(([k, v]) => k + '=' + v).join(' ')]);
    },
    connEnd: (c) => out.push([c, 'END']),
    connDestroy(c, why) {
      out.push([c, 'DESTROY', why]);
      const x = conns.get(c);
      if (x && x.open) {
        x.open = false;
        h.buddyClosed(x.b);
      }
    },
    setSvc(c, svc) {
      conns.get(c).b = svc.id;
    },
  });
  h.buddies = new Buddies({ store: h.store, limits: BUDDY_LIMITS, claims: null, now: t });
  return {
    h, out, logs, timers,
    advance: (ms) => (t += ms),
    session(id, vip, persona, lkey) {
      sessions.set(id, { vip, persona, lkey, owner: null });
      h.lobby.byPersona.set(persona.toLowerCase(), id);
    },
    connect(c, vip) {
      conns.set(c, { vip, open: true, b: 0 });
      h.buddyConnect(c);
      return conns.get(c).b;
    },
    send(c, kind, fields) {
      h.buddyData(conns.get(c).b, frame(kind, fields));
      h.buddies.purge();
    },
  };
}

test('messenger smoke run: login, request, answer, message, roster', () => {
  const storage = new MapStorage();
  const w = host(storage);
  const K1 = 'k'.repeat(30), K2 = 'z'.repeat(30);
  w.session(1, 101, 'Alpha', K1);
  w.session(2, 102, 'Bravo', K2);
  w.connect(10, 101);
  w.connect(20, 102);
  w.send(10, 'AUTH', [['LKEY', K1]]);
  w.send(20, 'AUTH', [['LKEY', K2]]);
  assert.deepEqual(w.out.splice(0), [[10, 'AUTH', '', 'TITL=EA MESSENGER'], [20, 'AUTH', '', 'TITL=EA MESSENGER']]);
  w.send(10, 'RADM', [['USER', 'Bravo'], ['ID', '3']]);
  assert.deepEqual(w.out.splice(0).map((x) => x.slice(0, 2)), [[10, 'RADM'], [10, 'PGET'], [20, 'RNOT'], [20, 'PGET']]);
  w.send(20, 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', '1']]);
  const roster = w.out.splice(0);
  assert.deepEqual(roster[0], [20, 'RGET', '', 'ID=1 SIZE=1']);
  assert.deepEqual(roster[1], [20, 'ROST', '', 'ID=1 USER=Alpha LIST=B ATTR=R']);
  w.send(20, 'RRSP', [['USER', 'Alpha'], ['ANSW', 'Y']]);
  assert.deepEqual(w.out.splice(0).map((x) => x.slice(0, 2)), [[20, 'RRSP'], [20, 'RNOT'], [20, 'PGET'], [10, 'RNOT'], [10, 'PGET']]);
  assert.deepEqual(w.logs.splice(0), ['[online] "Alpha" asked "Bravo" to be friends', '[online] "Bravo" and "Alpha" are friends (ANSW=Y)']);
  w.send(10, 'SEND', [['USER', 'Bravo'], ['BODY', 'hello%20there'], ['TYPE', 'C']]);
  const sent = w.out.splice(0);
  assert.equal(sent[1][1], 'RECV');
  assert.match(sent[1][3], /^USER=Alpha BODY=hello there SUBJ= TYPE=C TIME=\d+$/);
  // a presence goes to the friends
  w.send(10, 'PSET', [['SHOW', 'CHAT'], ['STAT', 'racing']]);
  assert.deepEqual(w.out.splice(0).map((x) => x.slice(0, 2)), [[10, 'PSET'], [20, 'PGET']]);
  // a game invite with a key that is no field name: the console line and the connection goes
  w.send(10, 'GINV', [['USER', 'Bravo'], ['A!B', 'x']]);
  assert.deepEqual(w.logs.splice(0), ['ERR [online] buddy "GINV" failed: Error: bad field name "A!B"']);
  const gone = w.out.splice(0);
  assert.deepEqual(gone.slice(-2), [
    [10, 'DESTROY', 'server error'],
    [20, 'PGET', '', 'USER=Alpha SHOW=DISC STAT= PROD= TITL=Need for Speed Underground 2 [PC] EXTR=NFS-CONSOLE-2005 ATTR=D'],
  ]);
  // Bravo hears Alpha is gone; a message to Alpha now waits on its list (written at the save)
  w.send(20, 'SEND', [['USER', 'Alpha'], ['BODY', 'later']]);
  assert.deepEqual(w.out.splice(0), [[20, 'SEND', '', '']]);
  w.h.buddySave();
  const texts = shelfTexts(w.h.store);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /^\{"v":4,"name":"Alpha","seen":"2025-11","B":\["Bravo"\],"M":\[\{"from":"Bravo","t":\d+,"body":"later","subj":"","type":"C"\}\]\}$/);
  assert.equal(texts[1], '{"v":4,"name":"Bravo","seen":"2025-11","B":["Alpha"]}');
  // not logged in: code auth
  w.connect(30, 103);
  w.send(30, 'RGET', [['ID', '1']]);
  assert.deepEqual(w.out.splice(0), [[30, 'RGET', 'auth', '']]);
});

