// DST scenarios of the Online host (web/worker/src/online) through the switch (web/worker/test/dst/sim.js): many
// virtual games over a seeded network with latency, jitter, slow readers and dropped connections, in virtual time.
// Each game speaks to 10.77.0.1 as the runtime's Winsock does (TCP segments in kind-4 frames): the lobby login,
// rooms, chat, games and races with their reports, EA Messenger friends and messages, the web pages, ICMP echoes.
// After every step: the host's invariants (its connections, sessions, personas, games, counts and Messenger
// connections agree).  At the end, with every game gone: nothing is left held.  A seed's run is reproducible: two
// runs of it see the same bytes.
//   DST_SEEDS=50 node --test test/dst/online.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.js';
import { OnlineHost } from '../../src/online/index.js';
import { MapStorage } from '../../src/online/files.js';
import { encodeFrame, FrameReader, FieldMap } from '../../src/online/aries.js';
import { lanFrame, VHOST_VIP, SYN, SYNACK, RST, DATA, FIN } from '../../src/online/vhost.js';
import { Prng } from '../../src/util/prng.js';
import { resu } from '../online/gen.mjs';

const PORT_LOBBY = 20922, PORT_BUDDY = 13505, PORT_HTTP = 80, PORT_REDIRECTOR = 20920;

/** the Online host's invariants (what its own maps must agree on) */
export function onlineInvariants(host, fail) {
  const core = host.core, vh = core.vh, lb = core.lobby, bs = core.buddies;
  let n = 0;
  const per = new Map();
  for (const [id, c] of vh.conns) {
    if (vh.byKey.get(c.vip + ':' + c.rport + ':' + c.cid) !== id) fail('a connection not indexed');
    per.set(c.vip, (per.get(c.vip) || 0) + 1);
    n++;
  }
  if (vh.byKey.size !== n) fail('byKey ' + vh.byKey.size + ' != conns ' + n);
  if (per.size !== vh.perVip.size || [...per].some(([v, k]) => vh.perVip.get(v) !== k)) fail('perVip out of step');
  if (vh.conns.size > vh.o.maxConns) fail('over maxConns');
  try {
    lb.checkCounts();
  } catch (e) {
    fail(e.message);
  }
  for (const s of lb.sessions) {
    const x = lb.s(s);
    if (!vh.conns.has(x.conn)) fail('a live session without its connection');
    const c = vh.conns.get(x.conn);
    if (c.svc.k !== 'lobby' || c.svc.id !== s) fail('a session\'s connection serves another');
  }
  for (const [k, s] of lb.byPersona) {
    const x = lb.sess.get(s);
    if (!x || x.gone || !lb.sessions.has(s)) fail('byPersona holds a session that left: ' + k);
    if (x.persona === null || x.persona.toLowerCase() !== k) fail('byPersona under another name: ' + k);
  }
  if (lb.graveyard.length !== 0) fail('a graveyard left after an event');
  for (const r of lb.rooms) for (const u of r.users) {
    if (!lb.sessions.has(u) || lb.s(u).room !== r.id) fail('a room holds a session that is not in it');
  }
  for (const g of lb.games.values()) {
    if (g.players.length === 0) fail('a game with no players');
    if (g.started === 0) for (const p of g.players) {
      if (p.s === null || !lb.sessions.has(p.s) || lb.s(p.s).game !== g.id) fail('an open game\'s player is not in it');
    }
    if (g.players.length > core.lobby.l.gameSize) fail('a game over its size');
  }
  for (const [k, b] of bs.online) {
    const x = bs.conns.get(b);
    if (!x || x.persona === null || x.persona.toLowerCase() !== k) fail('EA Messenger online under a name it does not have');
    if (!vh.conns.has(x.conn)) fail('EA Messenger online without its connection');
  }
  if (bs.graveyard.length !== 0) fail('a Messenger graveyard left after an event');
  for (const [id, x] of bs.conns) if (!vh.conns.has(x.conn)) fail('a Messenger connection held after its stream: ' + id);
  if (core.timers.live.size > 50 + 6 * vh.conns.size + 2 * lb.games.size + 16) fail('timers piling up: ' + core.timers.live.size);
}

/** one game's network side for the Online mode: its TCP streams to 10.77.0.1 through the switch */
class Game {
  constructor(sim, r, i, name) {
    this.sim = sim;
    this.r = r;
    this.i = i;
    this.name = name;
    this.streams = new Map();
    this.nextPort = 40000 + i * 100;
    this.c = sim.connect({ name, group: 'g' + (i % 5), hello: { lan: 1 } });
    this.lobby = null;
    this.buddy = null;
    this.lkey = null;
    this.persona = null;
    this.ses = null;
    this.bytes = 0;
  }
  vip() {
    return this.c.vip;
  }
  open(dport) {
    const port = this.nextPort++;
    const cid = this.r.next32();
    const s = { port, dport, cid, r: new FrameReader(1 << 16), msgs: [], open: false, closed: false };
    this.streams.set(port, s);
    this.seg(s, SYN, new Uint8Array(0));
    return s;
  }
  seg(s, op, data) {
    if (!this.c.open || !this.vip()) return;
    this.c.sendBinary(lanFrame(4, this.vip(), VHOST_VIP, s.port, s.dport, op, s.cid, data));
  }
  send(s, kind, fields, code = '') {
    if (s && !s.closed) this.seg(s, DATA, encodeFrame(kind, code, fields));
  }
  fin(s) {
    if (s && !s.closed) {
      this.seg(s, FIN, new Uint8Array(0));
      s.closed = true;
    }
  }
  /** a frame from the switch */
  arrive(f) {
    this.bytes += f.length;
    if (f.length < 24 || f[0] !== 4) return;
    const port = (f[14] << 8) | f[15];
    const s = this.streams.get(port);
    if (!s) return;
    const op = f[16];
    if (op === SYNACK) {
      s.open = true;
      this.onOpen(s);
    } else if (op === RST || op === FIN) {
      s.closed = true;
      if (s === this.lobby) this.lobby = null;
      if (s === this.buddy) this.buddy = null;
    } else if (op === DATA) {
      if (s.dport === PORT_HTTP) return;
      for (const m of s.r.push(f.subarray(24))) {
        const msg = { kind: m.kind, code: m.code, f: FieldMap.parseWith(m.body, () => false) };
        s.msgs.push(msg);
        this.onMsg(s, msg);
      }
      if (s.r.error) throw new Error('the host sent a broken stream: ' + s.r.error);
    }
  }
  onOpen(s) {
    if (s.dport === PORT_LOBBY) {
      this.send(s, 'addr', [['ADDR', '10.77.0.99'], ['PORT', s.port]]);
      this.send(s, 'skey', [['SKEY', '$5075626c6963204b6579']]);
      this.send(s, 'news', [['NAME', 7]]);
      this.send(s, 'sele', [['MYGAME', 1], ['STATS', 5000], ['ASYNC', 1], ['MESGS', 1]]);
      this.send(s, 'auth', [['NAME', this.name], ['PASS', 'x'], ['MID', '$024e564c0002']]);
      this.send(s, 'pers', [['PERS', this.name], ['MID', '$024e564c0002']]);
    } else if (s.dport === PORT_BUDDY) {
      this.send(s, 'AUTH', [['PROD', 'NFS-CONSOLE-2005'], ['USER', '/PC/NFS-CONSOLE-2005'], ['LKEY', this.lkey ?? '']]);
      this.send(s, 'RGET', [['LIST', 'B'], ['PEND', 'Y'], ['ID', 1]]);
    } else if (s.dport === PORT_HTTP) {
      this.seg(s, DATA, new TextEncoder().encode('GET /news HTTP/1.0\r\n\r\n'));
    } else if (s.dport === PORT_REDIRECTOR) {
      this.send(s, '@dir', [['PROD', 'NFS-CONSOLE-2005']]);
    }
  }
  onMsg(s, m) {
    if (m.kind === 'pers' && m.code === '') {
      this.lkey = m.f.get('LKEY');
      this.persona = m.f.get('PERS');
    }
    if (m.kind === 'gcre' && m.code === '') this.created = this.sim.nowMs;
    if ((m.kind === 'gjoi' || m.kind === 'gcre') && m.code === '') this.inGame = m.f.get('NAME');
    if (m.kind === '+ses') this.fin(s);
    if (m.kind === '+ses') this.ses = { auth: m.f.get('AUTH'), names: [0, 1, 2, 3, 4, 5].map((i) => m.f.get('OPPO' + i)).filter((x) => x !== null), at: this.sim.nowMs };
    if (m.kind === '~png') this.send(s, '~png', [['REF', m.f.get('REF') ?? '']]);
  }
  /** one thing the player does */
  act(all) {
    const r = this.r, pick = (a) => a[r.below(a.length)];
    if (!this.c.open) return;
    if (!this.lobby || this.lobby.closed) {
      if (r.unit() < 0.5) this.lobby = this.open(PORT_LOBBY);
      return;
    }
    const L = this.lobby;
    const other = pick(all);
    if (this.ses && this.persona && L.msgs.some((m) => m.kind === 'pers') && this.sim.nowMs - this.ses.at > 25000) {
      const names = this.ses.names;
      const players = names.map((_, j) => ({ index: j, place: j + 1, time: 20.5 + j }));
      const f = [['AUTH', this.ses.auth], ['RESU', resu({ kind: 1, players })]];
      names.forEach((n, j) => f.push(['NAME' + j, n]));
      this.send(L, 'rank', f);
      this.ses = null;
      return;
    }
    switch (r.below(16)) {
      case 0: this.send(L, 'move', [['NAME', pick(['Lounge', 'Circuit', 'Sprint'])]]); break;
      case 1: this.send(L, 'mesg', [['TEXT', pick(['hi', 'gg', 'ready?', 'go go'])], ...(r.unit() < 0.3 && other.persona ? [['PRIV', other.persona]] : [])]); break;
      case 2: this.send(L, 'gcre', [['NAME', 'Race ' + this.i], ['MAXSIZE', 4], ['CUSTFLAGS', 0x40000f3]]); break;
      case 3: case 4: {
        const hosts = all.filter((g) => g !== this && g.created);
        if (hosts.length) this.send(L, 'gjoi', [['NAME', 'Race ' + pick(hosts).i]]);
        break;
      }
      case 5: this.send(L, 'gsta', []); break;
      case 6: this.send(L, 'gsea', [['COUNT', 20]]); break;
      case 7: this.send(L, 'glea', []); break;
      case 8:
        if (!this.buddy || this.buddy.closed) {
          if (this.lkey) this.buddy = this.open(PORT_BUDDY);
        } else if (other.persona) {
          this.send(this.buddy, pick(['RADM', 'RRSP', 'SEND', 'PSET', 'USCH']), [['USER', other.persona], ['ANSW', 'Y'], ['BODY', 'hello'], ['SHOW', 'CHAT'], ['STAT', 'x' + r.below(3)]]);
        }
        break;
      case 9: case 15:
        if (this.ses && this.persona && this.sim.nowMs - this.ses.at > 40000) {
          const names = this.ses.names;
          const players = names.map((_, j) => ({ index: j, place: j + 1, time: 25 + j + (this.sim.nowMs - this.ses.at) / 4000 }));
          const f = [['AUTH', this.ses.auth], ['RESU', resu({ kind: 1, players })]];
          names.forEach((n, j) => f.push(['NAME' + j, n]));
          this.send(L, 'rank', f);
          this.ses = null;
        }
        break;
      case 10: this.send(L, 'snap', [['CHAN', 6 + r.below(24)], ['RANGE', 10]]); break;
      case 11: if (r.unit() < 0.3) this.fin(L); break;
      case 12: if (r.unit() < 0.2) this.open(pick([PORT_HTTP, PORT_REDIRECTOR])); break;
      case 13: if (r.unit() < 0.2) this.c.sendBinary(lanFrame(5, this.vip(), VHOST_VIP, 0, 0, 0, 0, Uint8Array.from([8, 0, 0, 0, 0, 1, 0, r.below(256)]))); break;
      case 14: this.send(L, 'auxi', [['TEXT', 'car ' + r.below(30)]]); break;
      default: this.send(L, 'user', [['PERS', other.persona ?? 'nobody']]);
    }
    if (this.created && r.unit() < 0.3) this.send(L, 'gsta', []);
    if (this.inGame && r.unit() < 0.5) this.send(L, 'gset', [['USERFLAGS', 1 << 27]]);
    if (this.sim.nowMs - (this.created || 0) > 60000) this.created = 0;
    if (false) {
    }
  }
}

function digest(sim) {
  let h = 2166136261;
  for (const c of sim.clients) for (const m of c.received) {
    if (m.type !== 'binary') continue;
    for (const b of m.data) h = Math.imul(h ^ b, 16777619) >>> 0;
  }
  return h;
}

/** one seed's run: its digest of every byte the games got, and what it saw */
export function runSeed(seed, o = {}) {
  const r = new Prng(BigInt(seed) * 31n + 7n);
  const storage = new MapStorage();
  const lines = [];
  const sim = new Sim({
    seed, storage,
    net: { minDelayMs: 2, maxDelayMs: 80, jitterMs: 15, dropRate: o.dropRate ?? 0 },
    hosts: { online: (a) => new OnlineHost(a) },
    hostOptions: { online: { log: (l) => lines.push(l) } },
  });
  const host = sim.hosts.online;
  assert.ok(host, 'the switch made the Online host');
  sim.check((s) => onlineInvariants(host, (what) => {
    throw new Error('online invariant (seed ' + seed + ', step ' + s.steps + ', t=' + s.nowMs + '): ' + what);
  }));
  const n = o.games ?? 4 + r.below(8);
  const games = [];
  sim.onArrive.push((c, m) => {
    if (m.type !== 'binary') return;
    const g = games.find((x) => x.c === c);
    if (g) g.arrive(m.data);
  });
  for (let i = 0; i < n; i++) {
    games.push(new Game(sim, r, i, ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet', 'Kilo', 'Lima'][i]));
    sim.advance(r.below(500));
  }
  const rounds = o.rounds ?? 150;
  for (let k = 0; k < rounds; k++) {
    for (const g of games) if (r.unit() < 0.6) g.act(games);
    sim.advance(100 + r.below(900));
    // a game whose connection died comes back (a new page)
    for (let i = 0; i < games.length; i++) {
      if (!games[i].c.open && r.unit() < 0.3) games[i] = new Game(sim, r, i, games[i].name);
    }
  }
  // everyone leaves; the host lets everything go
  for (const g of games) for (const s of g.streams.values()) g.fin(s);
  sim.advance(5000);
  for (const g of games) g.c.close(1000, 'closed');
  sim.advance(130000);
  const core = host.core;
  assert.equal(core.vh.conns.size, 0, 'no connection left (seed ' + seed + ')');
  assert.equal(core.lobby.sessions.size, 0, 'no session left');
  assert.equal(core.lobby.byPersona.size, 0, 'no persona held');
  assert.equal(core.buddies.conns.size, 0, 'no Messenger connection left');
  assert.equal([...core.lobby.games.values()].filter((g) => g.started === 0).length, 0, 'no open game left');
  return { digest: digest(sim), lines, info: host.info(), steps: sim.steps };
}

test('the Online host through the switch: invariants after every step, nothing left held, reproducible', () => {
  const seeds = Number(process.env.DST_SEEDS ?? 6);
  let logins = 0, races = 0, steps = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const a = runSeed(seed);
    steps += a.steps;
    logins += a.info.logins;
    races += a.info.races;
    if (seed <= 3) {
      const b = runSeed(seed);
      assert.equal(b.digest, a.digest, 'seed ' + seed + ' runs the same twice');
      assert.deepEqual(b.lines, a.lines);
    }
  }
  assert.ok(logins > seeds, 'logins happened: ' + logins);
  console.log('# DST online: ' + seeds + ' seeds, ' + steps + ' steps, ' + logins + ' logins, ' + races + ' races');
});

test('a slow, lossy network: the host keeps its invariants', () => {
  for (let seed = 100; seed < 104; seed++) runSeed(seed, { dropRate: 0.01, rounds: 80 });
});

