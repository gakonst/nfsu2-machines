// Traces for the differential tests (diff.test.mjs): scenarios written out, and seeded random sessions of many
// virtual clients (logins, personas, rooms, chat, games, races and their reports, rankings, EA Messenger's friends,
// presence and messages, the redirector, the web pages, ICMP/UDP, broken input, clock moves, browsers leaving, slow
// browsers, a restart), each a JSON trace both the Rust core (difftrace.rs) and the JS port replay.

import { Prng } from '../../src/util/prng.js';

export const PORT_REDIRECTOR = 20920, PORT_LOBBY = 20922, PORT_BUDDY = 13505, PORT_HTTP = 80;
export const vipAt = (i) => (0x0a4d0000 | ((i % 96) << 8) | (2 + Math.floor(i / 96))) >>> 0;

const f32be = (x) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, x);
  return [...b];
};
const i32be = (x) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, x);
  return [...b];
};

/** a race report (rank RESU), version 3: players [{index, place, state, time, avg, top, score, jump, slide, driftBest, dropped}] */
export function resu({ kind = 0, reporter = 0, track = 4014, dir = 0, laps = 2, players }) {
  const b = [3, players.length, kind, reporter, track >> 8, track & 255, dir, laps];
  for (const p of players) {
    const r = new Array(55).fill(0);
    r[0] = p.index;
    r[1] = p.place;
    r[2] = p.state ?? (p.dropped ? 0x0c : 1);
    r[3] = p.car ?? 3;
    r.splice(8, 4, ...f32be(p.time ?? 0));
    r.splice(12, 4, ...f32be(p.lap ?? 0));
    r.splice(16, 4, ...f32be(p.avg ?? 30));
    r.splice(20, 4, ...f32be(p.top ?? 60));
    r.splice(32, 4, ...f32be(p.dropped ? -1 : 50));
    r.splice(36, 4, ...f32be(p.jump ?? 0));
    r.splice(40, 4, ...f32be(p.slide ?? 0));
    r.splice(44, 4, ...i32be(p.score ?? 0));
    r.splice(48, 4, ...i32be(p.driftBest ?? 0));
    b.push(...r);
  }
  return Buffer.from(b).toString('base64');
}

/** a trace builder: clients, streams, the login of the game's own order */
export class T {
  constructor(seed, o = {}) {
    this.tr = { seed, t0: o.t0 ?? 1792411200000, state: o.state === undefined ? {} : o.state, steps: [] };
    if (o.limits) this.tr.limits = o.limits;
    if (o.buddyLimits) this.tr.buddyLimits = o.buddyLimits;
    if (o.claims) this.tr.claims = o.claims;
    if (o.deny) this.tr.deny = o.deny;
    this.port = 50000;
    this.cid = 1;
    this.lobbyOf = new Map();
  }
  s(step) {
    this.tr.steps.push(step);
    return this;
  }
  client(i, group, extra = {}) {
    return this.s({ op: 'client', vip: vipAt(i), group: group ?? 'g' + i, ...extra });
  }
  connect(i, dport) {
    const port = this.port++, cid = this.cid++;
    this.s({ op: 'connect', vip: vipAt(i), dport, port, cid });
    return [vipAt(i), port];
  }
  send(c, kind, fields, code) {
    const st = { op: 'send', vip: c[0], port: c[1], kind, fields };
    if (code) st.code = code;
    return this.s(st);
  }
  ref(c, kind, key) {
    return { ref: [c[0], c[1], kind, key] };
  }
  login(i, name, persona = name, o = {}) {
    const c = this.connect(i, PORT_LOBBY);
    this.send(c, 'addr', [['ADDR', '10.77.0.99'], ['PORT', c[1]]]);
    this.send(c, 'skey', [['SKEY', '$5075626c6963204b6579']]);
    this.send(c, 'news', [['NAME', 7]]);
    this.send(c, 'sele', [['MYGAME', 1], ['STATS', 5000], ['ASYNC', 1], ['MESGS', 1]]);
    this.send(c, o.acct ? 'acct' : 'auth', [['NAME', name], ['PASS', 'secret'], ['REGKEY', 'AAAA-BBBB-CCCC'], ['PSES', '0123456789abcdef'], ['MID', '$024e564c0002']]);
    if (persona !== name) this.send(c, 'cper', [['PERS', persona]]);
    this.send(c, 'pers', [['PERS', persona], ['MID', '$024e564c0002']]);
    this.lobbyOf.set(i, c);
    return c;
  }
  buddy(i, lobby) {
    const c = this.connect(i, PORT_BUDDY);
    this.send(c, 'AUTH', [['PROD', 'NFS-CONSOLE-2005'], ['VERS', '0.1'], ['PRES', 20920], ['USER', '/PC/NFS-CONSOLE-2005'], ['LKEY', this.ref(lobby, 'pers', 'LKEY')]]);
    return c;
  }
  advance(ms) { return this.s({ op: 'advance', ms }); }
  sleep(ms) { return this.s({ op: 'sleep', ms }); }
  fin(c) { return this.s({ op: 'fin', vip: c[0], port: c[1] }); }
  rst(c) { return this.s({ op: 'rst', vip: c[0], port: c[1] }); }
  gone(i) { return this.s({ op: 'gone', vip: vipAt(i) }); }
  info() { return this.s({ op: 'info' }); }
  end() {
    this.info();
    this.s({ op: 'stop' });
    this.s({ op: 'files' });
    return this.tr;
  }
}

// ---- scenarios ----

function scenarioBasics(seed) {
  const t = new T(seed);
  t.client(0).client(1).client(2, 'g0');
  const a = t.login(0, 'Alpha');
  const b = t.login(1, 'Bravo', 'Bravo2');
  t.send(a, 'move', [['NAME', 'Lounge']]).send(b, 'move', [['NAME', 'lounge']]);
  t.send(a, 'mesg', [['TEXT', 'hello  there\u0007 friend']]).send(b, 'mesg', [['TEXT', 'hi'], ['PRIV', 'alpha']]);
  t.send(a, 'mesg', [['TEXT', 'go'], ['ATTR', 'X']]);
  for (let i = 0; i < 7; i++) t.send(b, 'mesg', [['TEXT', 'flood ' + i]]);
  t.send(a, 'auxi', [['TEXT', 'car=350Z color=red']]).send(a, 'user', [['PERS', 'Bravo2']]).send(a, 'onln', [['PERS', 'nobody here']]);
  t.send(a, 'rept', [['PERS', 'Bravo2']]).send(a, 'lost', []).send(a, 'zzzz', []).send(a, 'news', [['NAME', 3]]);
  const c = t.login(2, 'Charlie');
  t.send(c, 'cper', [['PERS', 'Delta']]).send(c, 'cper', [['PERS', 'x y']]).send(c, 'dper', [['PERS', 'Delta']]).send(c, 'dper', [['PERS', 'Charlie']]);
  t.send(c, 'move', [['NAME', 'Drift']]).send(c, 'move', [['NAME', 'nowhere']]);
  t.advance(5000).sleep(5000).advance(20000).sleep(1500);
  t.send(a, 'gsea', [['START', 0], ['COUNT', 20]]);
  t.fin(b).advance(1000).rst(c).info();
  t.advance(130000).sleep(130000);
  return t.end();
}

function scenarioRedirectorHttpIcmp(seed) {
  const t = new T(seed, { state: null });
  t.client(0);
  const r = t.connect(0, PORT_REDIRECTOR);
  t.send(r, '@tic', []).send(r, '@dir', [['PROD', 'x']]).fin(r);
  const r2 = t.connect(0, PORT_REDIRECTOR);
  t.sleep(31000);
  const h = t.connect(0, PORT_HTTP);
  t.s({ op: 'data', vip: h[0], port: h[1], hex: Buffer.from('GET /news?x=1 HTTP/1.0\r\nHost: a\r\n\r\n').toString('hex') }).fin(h);
  const h2 = t.connect(0, PORT_HTTP);
  t.s({ op: 'data', vip: h2[0], port: h2[1], hex: Buffer.from('HEAD /TOS HTTP/1.1\r\n\r\n').toString('hex') });
  const h3 = t.connect(0, PORT_HTTP);
  t.s({ op: 'data', vip: h3[0], port: h3[1], hex: Buffer.from('POST / HTTP/1.0\r\n\r\n').toString('hex') });
  const h4 = t.connect(0, PORT_HTTP);
  t.s({ op: 'data', vip: h4[0], port: h4[1], hex: Buffer.from('GET /x HTTP/1.0\r\n\r\n').toString('hex') });
  t.connect(0, PORT_HTTP);
  t.sleep(16000);
  t.connect(0, 1234);
  // ICMP echo, UDP, a short frame, an unknown kind, a SYNACK and DATA of no stream
  const icmp = '0800' + '0000' + '12340001' + '6869';
  t.s({ op: 'seg', kind: 5, vip: vipAt(0), port: 0, dport: 0, tcp: 0, cid: 0, hex: icmp });
  t.s({ op: 'seg', kind: 3, vip: vipAt(0), port: 3658, dport: 3658, tcp: 0, cid: 0, hex: 'abcd' });
  t.s({ op: 'seg', kind: 3, vip: vipAt(0), port: 3658, dport: 3658, tcp: 1, cid: 0 });
  t.s({ op: 'frame', vip: vipAt(0), hex: '0400000000000000' });
  t.s({ op: 'seg', kind: 9, vip: vipAt(0), port: 1, dport: 2, tcp: 1, cid: 7 });
  t.s({ op: 'seg', vip: vipAt(0), port: 999, dport: PORT_LOBBY, tcp: 2, cid: 77 });
  t.s({ op: 'seg', vip: vipAt(0), port: 999, dport: PORT_LOBBY, tcp: 4, cid: 77, hex: '00' });
  t.s({ op: 'seg', vip: vipAt(0), port: 999, dport: PORT_LOBBY, tcp: 9, cid: 77 });
  // a lobby stream that is not the protocol, one with a bad length
  const l = t.connect(0, PORT_LOBBY);
  t.s({ op: 'data', vip: l[0], port: l[1], hex: '61757468000000000000000300' });
  const l2 = t.connect(0, PORT_LOBBY);
  t.s({ op: 'text', vip: l2[0], port: l2[1], kind: 'a b ', text: 'X=1' });
  t.gone(0);
  return t.end();
}

/** a race of n players from n browsers: create, join, ready, start, the lobby links close, logins again, reports */
function scenarioRace(seed, o = {}) {
  const n = o.n ?? 3;
  const kind = o.kind ?? 0;
  const ranked = o.ranked ?? false;
  const t = new T(seed, { claims: o.claims });
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].slice(0, n);
  const lobby = [];
  for (let i = 0; i < n; i++) {
    t.client(i);
    lobby.push(t.login(i, names[i]));
    t.send(lobby[i], 'move', [['NAME', 'Circuit']]);
    t.send(lobby[i], 'gsea', [['START', 0], ['COUNT', 20], ['CUSTFLAGS', 0x40000f3], ['CUSTMASK', 0x40001f3], ['SYSMASK', 0xc0000]], o.filt ? 'filt' : undefined);
  }
  const sys = ranked ? 1 << 18 : 0;
  t.send(lobby[0], 'gcre', [['NAME', 'Race of ' + names[0]], ['MAXSIZE', 6], ['MINSIZE', 2], ['CUSTFLAGS', 0x40000f3], ['SYSFLAGS', sys], ['PARAMS', 'trk=4014'], ...(o.pass ? [['PASS', 'pw']] : [])]);
  t.sleep(1200);
  for (let i = 1; i < n; i++) {
    t.send(lobby[i], 'gjoi', [['NAME', 'Race of ' + names[0]], ...(o.pass ? [['PASS', i === 1 && o.wrongPass ? 'nope' : 'pw']] : [])]);
    if (i === 1 && o.wrongPass) t.send(lobby[i], 'gjoi', [['NAME', 'Race of ' + names[0]], ['PASS', 'pw']]);
  }
  for (let i = 0; i < n; i++) t.send(lobby[i], 'gset', [['USERFLAGS', 1 << 27]]);
  t.send(lobby[0], 'gset', [['PARAMS', 'trk=4015'], ['MAXSIZE', 5], ['MINSIZE', 3], ['SYSFLAGS', 1 << 12]]);
  t.send(lobby[1], 'gsta', []);
  t.send(lobby[0], 'gsta', []);
  t.sleep(1500);
  for (let i = 0; i < n; i++) t.fin(lobby[i]);
  t.advance(5000).sleep(5000);
  t.info();
  t.advance(o.raceMs ?? 60000);
  const times = names.map((_, i) => 61.5 + i * 2.25);
  const reportOf = (i, again) => {
    const c = t.login(i, names[i]);
    const players = names.map((_, j) => ({ index: j, place: o.dnf === j ? 0 : j + 1, time: times[j], avg: 35 + j, top: 70 + j, score: 1000 * (n - j), driftBest: 100 * j, dropped: o.dnf === j }));
    if (o.differ && i === 1) [players[0].place, players[1].place] = [2, 1];
    const fields = [['AUTH', t.ref(lobby[i], '+ses', 'AUTH')], ['RESU', resu({ kind, reporter: i, players })]];
    names.forEach((nm, j) => fields.push(['NAME' + j, nm]));
    t.send(c, 'rank', fields, o.code && i === 2 ? o.code : undefined);
    if (again) t.send(c, 'rank', fields);
    t.send(c, 'user', [['PERS', names[i]]]);
    t.send(c, 'gsea', []);
    return c;
  };
  const back = [];
  for (let i = 0; i < n; i++) back.push(reportOf(i, i === 0));
  for (let k = 0; k < 6; k++) t.send(back[0], 'snap', [['CHAN', 6 + k], ['INDEX', 'x'], ['START', 0], ['RANGE', 10]]);
  t.send(back[0], 'snap', [['CHAN', 12], ['FIND', '$']]).send(back[1], 'snap', [['CHAN', 18], ['FIND', '$Alpha']]).send(back[1], 'snap', [['CHAN', 2]]);
  t.advance(5000).sleep(5000);
  t.s({ op: 'stop' }).s({ op: 'files' }).s({ op: 'restart' });
  for (let i = 0; i < n; i++) t.client(i);
  const again = t.login(0, names[0]);
  t.send(again, 'user', [['PERS', names[1]]]).send(again, 'snap', [['CHAN', 6], ['RANGE', 5]]);
  return t.end();
}

/** EA Messenger: friends, requests, presence, messages, invites, search, blocking, mail across a restart */
function scenarioBuddy(seed, o = {}) {
  const t = new T(seed, { claims: o.claims });
  const names = ['Alpha', 'Bravo', 'Charlie'];
  const lob = [], bud = [];
  for (let i = 0; i < 3; i++) {
    t.client(i, undefined, o.claims ? { owner: o.tokens[i] } : {});
    lob.push(t.login(i, names[i]));
    bud.push(t.buddy(i, lob[i]));
    t.send(bud[i], 'RGET', [['LIST', 'B'], ['PRES', 'Y'], ['PEND', 'Y'], ['ID', 1]]).send(bud[i], 'RGET', [['LIST', 'I'], ['ID', 2]]);
    t.send(bud[i], 'PSET', [['SHOW', 'CHAT'], ['STAT', 'In lobby'], ['PROD', 'NFS'], ['ID', 3]]);
  }
  t.send(bud[0], 'RADM', [['USER', 'Bravo@pcnfs'], ['PRES', 'Y'], ['ID', 4]]);
  t.send(bud[1], 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', 5]]);
  t.send(bud[1], 'RRSP', [['USER', 'Alpha'], ['ANSW', 'Y'], ['ID', 6]]);
  t.send(bud[0], 'RADM', [['USER', 'Charlie'], ['ID', 7]]).send(bud[2], 'RRSP', [['USER', 'Alpha'], ['ANSW', 'B'], ['ID', 8]]);
  t.send(bud[2], 'RADD', [['LIST', 'I'], ['USER', 'Bravo'], ['ID', 9]]);
  t.send(lob[1], 'move', [['NAME', 'Lounge']]).send(lob[2], 'move', [['NAME', 'Lounge']]);
  t.send(lob[1], 'mesg', [['TEXT', 'can Charlie hear me']]);
  t.send(bud[0], 'PSET', [['SHOW', 'AWAY'], ['STAT', 'Racing'], ['PROD', 'NFS']]).send(bud[0], 'PSET', [['SHOW', 'CHAT'], ['STAT', 'Back'], ['PROD', 'NFS']]);
  t.sleep(1200);
  t.send(bud[0], 'SEND', [['USER', 'Bravo'], ['BODY', 'hello friend'], ['SUBJ', 's'], ['TYPE', 'C']]);
  t.send(bud[0], 'GINV', [['USER', 'Bravo'], ['GAME', 'x'], ['ROOM', '2'], ['ID', 10]]);
  t.s({ op: 'text', vip: bud[0][0], port: bud[0][1], kind: 'GINV', text: 'USER=Bravo BAD-KEY=x ID=3' });
  t.send(bud[1], 'USCH', [['USER', 'a'], ['MAXR', 5], ['ID', 11]]).send(bud[1], 'PADD', [['USER', 'Charlie']]).send(bud[1], 'EPGT', [['ID', 12]]).send(bud[1], 'PING', []);
  t.send(bud[1], 'DISC', []);
  t.send(bud[0], 'SEND', [['USER', 'Bravo'], ['BODY', 'while away'], ['TYPE', 'C']]);
  t.sleep(11000);
  const b2 = t.buddy(1, lob[1]);
  t.send(b2, 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', 1]]).sleep(3500);
  t.send(bud[0], 'RDEM', [['USER', 'Bravo']]).send(bud[0], 'RDEL', [['LIST', 'B'], ['USER', 'Bravo']]);
  t.send(bud[0], 'AUTH', [['LKEY', 'x']]);
  const bad = t.connect(2, PORT_BUDDY);
  t.send(bad, 'AUTH', [['LKEY', 'abcdefabcdefabcdefabcdefabcdef']]);
  t.send(bad, 'RGET', []);
  t.sleep(4000).sleep(61000);
  t.s({ op: 'stop' }).s({ op: 'files' }).s({ op: 'restart' });
  for (let i = 0; i < 2; i++) t.client(i, undefined, o.claims ? { owner: o.tokens[i] } : {});
  const l0 = t.login(0, 'Alpha');
  const bb = t.buddy(0, l0);
  t.send(bb, 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', 1]]).sleep(4000);
  return t.end();
}


/** a race among some of the clients, in the random sessions: logins under their own names, a game, its start, the
 *  reports (agreeing or not, short, dropped racers, edited cars, jumps), a restart or browsers leaving in between */
function raceMacro(t, r, nClients, groups, k) {
  const pick = (a) => a[r.below(a.length)];
  const coin = (p) => r.unit() < p;
  const n = Math.min(nClients, 2 + r.below(4));
  const who = [];
  for (let i = 0; who.length < n && i < 50; i++) {
    const c = r.below(nClients);
    if (!who.includes(c)) who.push(c);
  }
  const names = who.map((c) => 'Racer' + c);
  const lob = who.map((c, j) => t.login(c, names[j]));
  const room = pick(['Circuit', 'Sprint', 'Lounge', null]);
  if (room) for (const c of lob) t.send(c, 'move', [['NAME', room]]);
  for (const c of lob) if (coin(0.7)) t.send(c, 'gsea', [['COUNT', 20]]);
  const ranked = coin(0.4);
  const gname = 'Race ' + k;
  const pass = coin(0.15);
  t.send(lob[0], 'gcre', [['NAME', gname], ['MAXSIZE', 6], ['CUSTFLAGS', pick([0x40000f3, 0x40000f3 | (1 << 25), 0x40001f3])], ['SYSFLAGS', ranked ? 1 << 18 : 0], ...(pass ? [['PASS', 'pw']] : [])]);
  if (coin(0.5)) t.sleep(pick([200, 1200]));
  for (let j = 1; j < n; j++) t.send(lob[j], 'gjoi', [['NAME', gname], ...(pass ? [['PASS', 'pw']] : [])]);
  for (let j = 0; j < n; j++) if (coin(0.9)) t.send(lob[j], 'gset', [['USERFLAGS', 1 << 27]]);
  if (coin(0.3)) t.send(lob[0], 'gset', [['KICK', lower(names[n - 1])]]);
  if (coin(0.3)) t.send(lob[1 % n], 'mesg', [['TEXT', 'ready?'], ['ATTR', 'G']]);
  t.send(lob[0], 'gsta', []);
  if (coin(0.8)) for (const c of lob) t.fin(c);
  const kind = pick([0, 0, 1, 2, 3, 4, 5, 6]);
  const raceS = 15 + r.below(90);
  t.advance(raceS * 1000);
  if (coin(0.5)) t.sleep(5000);
  let restarted = false;
  if (coin(0.1) && t.tr.state !== null) {
    t.s({ op: 'stop' }).s({ op: 'files' }).s({ op: 'restart' });
    for (let i = 0; i < nClients; i++) t.client(i, groups[i]);
    restarted = true;
  }
  if (coin(0.1)) {
    for (const c of who) t.gone(c);
    for (const c of who) t.client(c, groups[c]);
    t.advance(pick([60000, 130000]));
  }
  const base = Array.from({ length: n }, (_, j) => 10 + r.below(raceS) + r.unit());
  base.sort((a, b) => a - b);
  const dropped = Array.from({ length: n }, () => coin(0.12));
  const out = Array.from({ length: n }, () => coin(0.1));
  const code = coin(0.15) ? pick(['ed0f', 'edff', 'ed1e', 'j0ff', 'j1a0', 'j' + r.below(9) + 'ff', 'jx12']) : undefined;
  let place = 1;
  const places = base.map((_, j) => (dropped[j] ? 0 : place++));
  for (let j = 0; j < n; j++) {
    if (!coin(0.85)) continue;
    const c = t.login(who[j], names[j]);
    const players = names.map((_, x) => ({
      index: x, place: places[x], time: base[x] + (coin(0.1) ? r.unit() * 3 : 0), state: out[x] ? 0x0b : undefined,
      avg: coin(0.05) ? 120 : 20 + r.below(40), top: coin(0.05) ? 130 : 40 + r.below(60), score: 1000 + r.below(9000),
      driftBest: r.below(3000), jump: r.unit() * 3, slide: r.below(500), dropped: dropped[x],
    }));
    if (coin(0.15) && n > 1) [players[0].place, players[1].place] = [players[1].place, players[0].place];
    const f = [['AUTH', t.ref(lob[j], '+ses', 'AUTH')], ['RESU', resu({ kind, reporter: j, track: 4000 + r.below(30), laps: r.below(4), players })]];
    names.forEach((nm, x) => f.push(['NAME' + x, nm]));
    t.send(c, 'rank', f, coin(0.5) ? code : undefined);
    if (coin(0.3)) t.send(c, 'rank', f);
    if (coin(0.5)) t.send(c, 'gsea', []);
    if (coin(0.3)) t.send(c, 'snap', [['CHAN', 6 + r.below(24)], ['RANGE', 10], ...(coin(0.5) ? [['FIND', '$']] : [])]);
    if (coin(0.2)) t.advance(pick([1000, 20000]));
  }
  return restarted;
}

/** friends between two clients in EA Messenger, in the random sessions: a request, its answer, messages, presence,
 *  a message while away and its delivery at the next login */
function friendsMacro(t, r, nClients, groups) {
  const pick = (a) => a[r.below(a.length)];
  const coin = (p) => r.unit() < p;
  const a = r.below(nClients);
  let b = r.below(nClients);
  if (b === a) b = (a + 1) % nClients;
  const na = 'Pal' + a, nb = 'Pal' + b;
  const la = t.login(a, na), lb = t.login(b, nb);
  const ba = t.buddy(a, la), bb = t.buddy(b, lb);
  t.send(ba, 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', 1]]).send(bb, 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', 1]]);
  t.send(ba, pick(['RADM', 'RADD']), [['USER', nb + pick(['', '@x', '/y'])], ['LIST', 'B'], ['ID', 2]]);
  if (coin(0.3)) t.send(bb, 'RADM', [['USER', na], ['ID', 3]]);
  t.send(bb, 'RRSP', [['USER', na], ['ANSW', pick(['Y', 'Y', 'N', 'B', 'y'])], ['ID', 4]]);
  t.send(ba, 'PSET', [['SHOW', pick(['CHAT', 'AWAY'])], ['STAT', 'x' + r.below(3)], ['PROD', 'p']]);
  if (coin(0.5)) t.sleep(pick([300, 1100]));
  t.send(ba, 'SEND', [['USER', nb], ['BODY', pick(['hi', 'gg wp', 'nigger', 'see you'])], ['TYPE', 'C']]);
  if (coin(0.5)) {
    t.send(bb, 'DISC', []);
    t.send(ba, 'SEND', [['USER', nb], ['BODY', 'while you were away'], ['SUBJ', 's'], ['TYPE', 'C']]);
    if (coin(0.3)) t.sleep(11000);
    if (coin(0.2) && t.tr.state !== null) {
      t.s({ op: 'stop' }).s({ op: 'files' }).s({ op: 'restart' });
      for (let i = 0; i < nClients; i++) t.client(i, groups[i]);
      const la2 = t.login(a, na);
      const lb2 = t.login(b, nb);
      const bb2 = t.buddy(b, lb2);
      t.buddy(a, la2);
      t.send(bb2, 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', 1]]).sleep(3500);
      return true;
    }
    const lb2 = t.login(b, nb);
    const bb2 = t.buddy(b, lb2);
    t.send(bb2, 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', 1]]).sleep(3500);
  }
  if (coin(0.3)) t.send(ba, 'RDEM', [['USER', nb]]);
  if (coin(0.3)) t.send(ba, 'RADD', [['LIST', 'I'], ['USER', nb]]);
  if (coin(0.3)) t.send(ba, 'USCH', [['USER', 'pal'], ['MAXR', 10]]);
  return false;
}


/** the same players race one track again and again (clean races: the track's quickest), then one wins far quicker;
 *  two games see a car jump */
function scenarioQuickWin(seed) {
  const t = new T(seed);
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
  for (let i = 0; i < 4; i++) t.client(i);
  for (let k = 0; k < 12; k++) {
    const lob = names.map((nm, i) => t.login(i, nm));
    t.send(lob[0], 'gcre', [['NAME', 'Lap ' + k], ['MAXSIZE', 4]]);
    for (let i = 1; i < 4; i++) t.send(lob[i], 'gjoi', [['NAME', 'Lap ' + k]]);
    t.send(lob[0], 'gsta', []);
    for (const c of lob) t.fin(c);
    t.advance(70000);
    const quick = k === 11;
    const times = quick ? [25.5, 61.25, 62.5, 64] : [60 + (k % 3), 61.5 + (k % 2), 63.25, 64.5];
    for (let i = 0; i < 4; i++) {
      const c = t.login(i, names[i]);
      const players = names.map((_, j) => ({ index: j, place: j + 1, time: times[j], avg: 30, top: 60 }));
      const f = [['AUTH', t.ref(lob[i], '+ses', 'AUTH')], ['RESU', resu({ kind: 1, track: 4100, laps: 0, players })]];
      names.forEach((nm, j) => f.push(['NAME' + j, nm]));
      t.send(c, 'rank', f, quick && i > 0 ? 'j0' + (i === 1 ? 'c0' : 'ff') : undefined);
      t.send(c, 'gsea', []);
    }
    t.advance(5000);
  }
  return t.end();
}


const TOK = (c) => c.repeat(43);

/** claimed names in the lobby: the owner plays under its name, anyone else gets digits ("is claimed"), the owner's
 *  session takes the name from another player's */
function scenarioClaimsLobby(seed) {
  const claims = [['Alpha', TOK('A')], ['Bravo', TOK('B')], ['Speedracer123', TOK('C')]];
  const t = new T(seed, { claims });
  t.client(0, 'g0', { owner: TOK('A') }).client(1, 'g1', { owner: TOK('B') }).client(2, 'g2').client(3, 'g3', { owner: TOK('D') });
  const x = t.login(2, 'Alpha');
  t.send(x, 'user', [['PERS', 'Alpha']]);
  t.login(0, 'Alpha');
  t.login(3, 'Bravo');
  t.login(1, 'Bravo');
  t.login(3, 'Speedracer123');
  t.login(2, 'Speedracer123', 'Speedracer12_2');
  t.login(2, 'Charlie');
  t.login(3, 'Charlie');
  t.login(0, 'NAME');
  t.advance(31000);
  t.login(3, 'Charlie');
  return t.end();
}

/** EA Messenger with claimed names: lists kept for the claimed only, the pages' friends API, page mail */
function scenarioClaimsBuddy(seed) {
  const claims = [['Alpha', TOK('A')], ['Bravo', TOK('B')], ['Delta', TOK('D')]];
  const t = new T(seed, { claims });
  const own = [TOK('A'), TOK('B'), null, TOK('D')];
  const names = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
  const lob = [], bud = [];
  for (let i = 0; i < 4; i++) {
    t.client(i, 'g' + i, own[i] ? { owner: own[i] } : {});
    lob.push(t.login(i, names[i]));
    bud.push(t.buddy(i, lob[i]));
    t.send(bud[i], 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', 1]]);
  }
  t.send(bud[0], 'RADM', [['USER', 'Bravo'], ['ID', 2]]).send(bud[1], 'RRSP', [['USER', 'Alpha'], ['ANSW', 'Y'], ['ID', 3]]);
  t.send(bud[2], 'RADM', [['USER', 'Alpha'], ['ID', 4]]).send(bud[0], 'RRSP', [['USER', 'Charlie'], ['ANSW', 'Y'], ['ID', 5]]);
  const fr = (o, g, ask) => t.s({ op: 'friends', owner: o, group: g, ask });
  fr(TOK('A'), 'g0', { k: 'List' });
  fr(TOK('D'), 'g3', { k: 'Ask', name: 'Alpha' });
  fr(TOK('A'), 'g0', { k: 'Answer', name: 'Delta', yes: true });
  fr(TOK('A'), 'g0', { k: 'Discord', typed: ' @Alpha.Racer ' });
  fr(TOK('D'), 'g3', { k: 'List' });
  fr(TOK('D'), 'g3', { k: 'Send', name: 'Alpha', body: 'see you in free roam' });
  t.send(bud[0], 'DISC', []);
  t.s({ op: 'pageMail', on: false });
  fr(TOK('D'), 'g3', { k: 'Send', name: 'Alpha', body: 'are you there?' });
  t.s({ op: 'pageMail', on: true });
  fr(TOK('B'), 'g1', { k: 'Send', name: 'Alpha', body: 'to your page' });
  fr(TOK('A'), 'g0', { k: 'ListMail' });
  fr(TOK('A'), 'g0', { k: 'AskByName', name: 'Nobody' });
  fr(TOK('A'), 'g0', { k: 'Block', name: 'Delta' });
  fr(TOK('A'), 'g0', { k: 'Remove', name: 'Bravo' });
  fr(TOK('Z'), 'g9', { k: 'List' });
  fr(TOK('B'), 'g1', { k: 'Discord', typed: 'no way!' });
  t.sleep(11000);
  t.s({ op: 'stop' }).s({ op: 'files' }).s({ op: 'restart' });
  for (let i = 0; i < 4; i++) t.client(i, 'g' + i, own[i] ? { owner: own[i] } : {});
  const l0 = t.login(0, 'Alpha');
  const b0 = t.buddy(0, l0);
  t.send(b0, 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', 1]]).send(b0, 'RGET', [['LIST', 'I'], ['ID', 2]]).sleep(3500);
  fr(TOK('D'), 'g3', { k: 'List' });
  return t.end();
}

// ---- random sessions ----

const NAMES = ['Alpha', 'Alpha', 'Bravo', 'Charlie', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'NAME', 'Player', 'speedy_1', 'x', 'bad name', 'Fag', 'AbcdefghijklmnoP'];
const TEXTS = ['hi', 'gg', 'hello there', '  spaced\tout  ', 'a\u0001b', 'nigger', 'f a g', '', 'x'.repeat(300), 'caf\u00e9', 'ok "quoted" 100% ^^ a=b'];

export function randomTrace(seed) {
  const r = new Prng(BigInt(seed) * 7919n + 17n);
  const pick = (a) => a[r.below(a.length)];
  const coin = (p) => r.unit() < p;
  const nClients = 2 + r.below(6);
  const t = new T(seed, {
    state: coin(0.1) ? null : {},
    limits: coin(0.3) ? { perVip: 1 + r.below(3), perGroup: 2 + r.below(4), msgRate: 5 + r.below(20), createRate: 1, actRate: 2 } : undefined,
    buddyLimits: coin(0.3) ? { lists: 2 + r.below(5), listRate: 2 + r.below(5) } : undefined,
    deny: coin(0.1) ? ['Golf'] : undefined,
    claims: undefined,
  });
  const claimed = coin(0.25);
  const toks = [TOK('A'), TOK('B'), TOK('P'), TOK('Q')];
  if (claimed) t.tr.claims = [['Alpha', toks[0]], ['Bravo', toks[1]], ['Pal0', toks[2]], ['Racer1', toks[3]]];
  const groups = Array.from({ length: nClients }, (_, i) => (coin(0.2) ? 'shared' : 'g' + i));
  const lobby = new Map(), buddy = new Map(), started = new Map();
  const owners = Array.from({ length: nClients }, () => (claimed && coin(0.7) ? pick(toks) : null));
  for (let i = 0; i < nClients; i++) t.client(i, groups[i], { ...(coin(0.1) ? { noRaces: true } : {}), ...(owners[i] ? { owner: owners[i] } : {}) });
  const steps = 20 + r.below(80);
  for (let k = 0; k < steps; k++) {
    const i = r.below(nClients);
    const c = lobby.get(i);
    const b = buddy.get(i);
    const roll = r.below(42);
    if (!c || roll === 0) {
      const name = pick(NAMES);
      const pers = coin(0.3) ? pick(NAMES) : name;
      lobby.set(i, t.login(i, name, pers, { acct: coin(0.2) }));
      continue;
    }
    switch (roll) {
      case 1: case 2: t.send(c, 'move', [['NAME', pick(['Lounge', 'Circuit', 'Drag', 'x'])]]); break;
      case 3: case 4: t.send(c, 'mesg', [['TEXT', pick(TEXTS)], ...(coin(0.3) ? [['PRIV', lower(pick(NAMES))]] : []), ...(coin(0.2) ? [['ATTR', pick(['G', 'X', 'GX'])]] : [])]); break;
      case 5: t.send(c, 'gcre', [['NAME', pick(['Race A', 'Race B', 'Race ' + i, '', 'Fag race'])], ['MAXSIZE', r.below(9)], ['MINSIZE', r.below(4)], ['CUSTFLAGS', pick([0x40000f3, 0x40001f3, 0])], ['SYSFLAGS', pick([0, 1 << 18, 1 << 19])], ...(coin(0.2) ? [['PASS', 'pw']] : [])]); break;
      case 6: t.send(c, 'gjoi', [['NAME', pick(['Race A', 'Race B', 'Race ' + r.below(nClients)])], ...(coin(0.3) ? [['PASS', pick(['pw', 'no'])]] : [])]); break;
      case 7: t.send(c, 'gjoi', [['IDENT', r.below(6)]]); break;
      case 8: t.send(c, 'gset', [['USERFLAGS', pick([1 << 27, 0])], ...(coin(0.3) ? [['KICK', lower(pick(NAMES))]] : []), ...(coin(0.3) ? [['MAXSIZE', r.below(8)]] : [])]); break;
      case 9: t.send(c, 'gsta', []); started.set(i, c); break;
      case 10: t.send(c, 'glea', []); break;
      case 11: t.send(c, 'gdel', []); break;
      case 12: t.send(c, 'gsea', [['START', r.below(3)], ['COUNT', r.below(30)], ['CUSTFLAGS', 0x40000f3], ['CUSTMASK', pick([0x40001f3, 0])]], coin(0.5) ? 'filt' : undefined); break;
      case 13: t.send(c, 'auxi', [['TEXT', pick(TEXTS)]]); break;
      case 14: t.send(c, 'user', [['PERS', pick(NAMES)]]); break;
      case 15: t.send(c, 'onln', [['PERS', pick(NAMES)]]); break;
      case 16: t.send(c, 'snap', [['CHAN', 6 + r.below(26)], ['START', r.below(3)], ['RANGE', r.below(20)], ...(coin(0.3) ? [['FIND', '$']] : [])]); break;
      case 17: t.send(c, 'rept', [['PERS', pick(NAMES)]]); break;
      case 18: {
        const s = started.get(r.below(nClients));
        if (!s) break;
        const n = 2 + r.below(3);
        const names = Array.from({ length: n }, () => pick(NAMES));
        const players = names.map((_, j) => ({ index: j, place: j + 1, time: 20 + r.below(100) + r.unit(), avg: 20 + r.below(120), top: 40 + r.below(90), score: r.below(5000), dropped: coin(0.15) }));
        const f = [['AUTH', t.ref(s, '+ses', 'AUTH')], ['RESU', coin(0.1) ? 'garbage' : resu({ kind: r.below(8), players })]];
        names.forEach((nm, j) => f.push(['NAME' + j, nm]));
        t.send(c, 'rank', f, coin(0.2) ? pick(['j1ff', 'ed0f', 'edff', 'j9zz']) : undefined);
        break;
      }
      case 19: if (!b) buddy.set(i, t.buddy(i, c)); else t.send(b, 'RGET', [['LIST', pick(['B', 'I'])], ['PEND', 'Y'], ['ID', r.below(9)]]); break;
      case 20: if (b) t.send(b, pick(['RADM', 'RADD', 'RDEM', 'PADD', 'PDEL']), [['USER', pick(NAMES)], ...(coin(0.3) ? [['LIST', pick(['B', 'I'])]] : [])]); break;
      case 21: if (b) t.send(b, 'RRSP', [['USER', pick(NAMES)], ['ANSW', pick(['Y', 'N', 'B', 'yes'])]]); break;
      case 22: if (b) t.send(b, 'SEND', [['USER', pick(NAMES)], ['BODY', pick(TEXTS)], ['TYPE', 'C']]); break;
      case 23: if (b) t.send(b, 'PSET', [['SHOW', pick(['CHAT', 'AWAY'])], ['STAT', pick(TEXTS)], ['PROD', 'x']]); break;
      case 24: if (b) t.send(b, 'USCH', [['USER', pick(['a', 'b', 'Ch', ''])], ['MAXR', r.below(30)]]); break;
      case 25: if (b) t.send(b, pick(['GINV', 'GRSP', 'PING', 'EPGT', 'XXXX', 'DISC']), [['USER', pick(NAMES)], ['ID', 1]]); break;
      case 26: t.advance(pick([1000, 5000, 20000, 60000, 130000])); break;
      case 27: case 28: t.sleep(pick([500, 1000, 3000, 10000, 31000, 61000])); break;
      case 29: t.fin(c); lobby.delete(i); break;
      case 30: if (coin(0.5)) { t.rst(c); lobby.delete(i); } break;
      case 31: if (coin(0.3)) { t.gone(i); lobby.delete(i); buddy.delete(i); t.client(i, groups[i], owners[i] ? { owner: owners[i] } : {}); } break;
      case 32: t.s({ op: 'slow', vip: vipAt(i), on: coin(0.5) }); break;
      case 33: t.s({ op: 'data', vip: c[0], port: c[1], hex: Buffer.from(Array.from({ length: 1 + r.below(30) }, () => r.below(256))).toString('hex') }); break;
      case 34: t.send(c, pick(['cper', 'dper', 'pers']), [['PERS', pick(NAMES)]]); break;
      case 35: t.info(); break;
      case 36: if (coin(0.15) && t.tr.state !== null) {
        t.s({ op: 'stop' }).s({ op: 'files' }).s({ op: 'restart' });
        lobby.clear(); buddy.clear(); started.clear();
        for (let j = 0; j < nClients; j++) t.client(j, groups[j], owners[j] ? { owner: owners[j] } : {});
      } break;
      case 37: t.send(c, 'mesg', [['TEXT', 'nigger ' + k]]); break;
      case 38: if (raceMacro(t, r, nClients, groups, k)) { buddy.clear(); started.clear(); } lobby.clear(); break;
      case 39: if (friendsMacro(t, r, nClients, groups)) started.clear(); lobby.clear(); buddy.clear(); break;
      case 40: case 41: if (claimed) {
        const ask = pick([{ k: 'List' }, { k: 'ListMail' }, { k: 'Ask', name: pick(NAMES) }, { k: 'AskByName', name: pick(['Alpha', 'Bravo', 'Pal0', 'Racer1']) },
          { k: 'Answer', name: pick(['Alpha', 'Bravo', 'Pal0', 'Racer1']), yes: coin(0.7) }, { k: 'Remove', name: pick(NAMES) }, { k: 'Block', name: pick(NAMES) },
          { k: 'Send', name: pick(['Alpha', 'Bravo', 'Pal0', 'Racer1']), body: pick(TEXTS) }, { k: 'Discord', typed: pick(['me.x', '', 'Bad Name', '@ok_1']) }]);
        if (coin(0.2)) t.s({ op: 'pageMail', on: coin(0.5) });
        t.s({ op: 'friends', owner: pick(toks), group: groups[i], ask });
      } break;
      default: t.send(c, pick(['~png', 'addr', 'sele', 'skey']), [['STATS', r.below(9999)]]);
    }
  }
  return t.end();
}

const lower = (s) => s.toLowerCase();

export function scenarios() {
  return [
    ['basics', scenarioBasics(1)],
    ['redirector, http, icmp', scenarioRedirectorHttpIcmp(2)],
    ['race unranked 2', scenarioRace(3, { n: 2 })],
    ['race ranked 3', scenarioRace(4, { n: 3, ranked: true })],
    ['race ranked 2 (no points)', scenarioRace(5, { n: 2, ranked: true })],
    ['race drift ranked 4', scenarioRace(6, { n: 4, kind: 3, ranked: true })],
    ['race drag 3 with a DNF', scenarioRace(7, { n: 3, kind: 2, dnf: 2 })],
    ['race reports differ', scenarioRace(8, { n: 3, differ: true })],
    ['race with password, filter', scenarioRace(9, { n: 3, pass: true, wrongPass: true, filt: true })],
    ['race too short', scenarioRace(10, { n: 2, raceMs: 3000 })],
    ['race jump code', scenarioRace(11, { n: 3, code: 'j0ff' })],
    ['race edited car', scenarioRace(12, { n: 3, code: 'ed0f' })],
    ['buddy', scenarioBuddy(13)],
    ['quick win, jumps', scenarioQuickWin(14)],
    ['claims in the lobby', scenarioClaimsLobby(15)],
    ['claims in EA Messenger, the pages', scenarioClaimsBuddy(16)],
    ['buddy with claims', scenarioBuddy(17, { claims: [['Alpha', TOK('A')], ['Bravo', TOK('B')]], tokens: [TOK('A'), TOK('B'), null] })],
  ];
}




