// The tests of crates/online/src/tests/session.rs: scripted random sessions of the whole online host (a fixed seed
// each): six browsers (two of them one client) log in, chat, make and join and start games, report races, use EA
// Messenger, go and come back, fall behind (the switch refuses their frames) and leave; the lobby's clock moves.  After
// every step the lobby's counts agree with its sessions (Lobby checkCounts), nothing throws, and the files the host
// writes at its stop read back to the same bytes.  The script's LKEY and AUTH values are the ones the host gave
// ({lkey: conn}, {ses: [conn, key]}).
//
// (Ported with the JS Prng (util/prng.js) in place of the Rust test's xorshift64*: the same generator and the same
// invariants, but each seed's session is not the Rust one.  The script keeps strings and bytes as they are, where the
// Rust one keeps them as hex for its JSON.  NFSU2_SESSIONS=<n>: n sessions of each kind, 8 by default.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, MapStorage, ip } from './harness.mjs';
import { Prng } from '../../src/util/prng.js';
import { encodeFrame, encodeValue } from '../../src/online/aries.js';
import { lanFrame, VHOST_VIP, SYN, SYNACK, DATA, FIN, RST } from '../../src/online/vhost.js';
import { PORT_BUDDY, PORT_HTTP, PORT_LOBBY, PORT_REDIRECTOR } from '../../src/online/core.js';
import { latin1Bytes, latin1Decode, toNumber } from '../../src/online/jsx.js';
import { Store } from '../../src/online/files.js';
import { Stats } from '../../src/online/stats.js';
import { shelfTexts, shelfReread } from '../../src/online/buddy.js';

const T0 = 1792411200000; // Date.UTC(2026, 9, 19, 12)

/** the same session for the same seed (the JS Prng in place of session.rs's xorshift64*) */
class Rng {
  constructor(seed) {
    this.p = new Prng(BigInt(seed));
  }
  below(n) {
    return this.p.below(n);
  }
  pick(xs) {
    return xs[this.below(xs.length)];
  }
  chance(p) {
    return this.p.unit() <= p;
  }
}

const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const bytes = (s) => Uint8Array.from(latin1Bytes(s));
const none = new Uint8Array(0);
/** a number as Rust's 'as usize' takes it (NaN and below 0: 0) */
const usize = (x) => (Number.isFinite(x) && x > 0 ? Math.trunc(x) : 0);

/** a race report for n players, the places and times from the seed */
function resu(n, seed) {
  const b = new Uint8Array(8 + 55 * n);
  const v = new DataView(b.buffer);
  b[0] = 3;
  b[1] = n & 255;
  b[2] = seed % 7;
  v.setUint16(4, 4014);
  b[7] = 2;
  for (let i = 0; i < n; i++) {
    const o = 8 + 55 * i;
    b[o] = i & 255;
    b[o + 1] = (((i + seed) % n) + 1) & 255;
    b[o + 2] = (seed + i) % 5 === 0 ? 0x0c : 1;
    const t = 25.0 + i * 1.5 + (seed % 7) * 10.25;
    v.setFloat32(o + 8, t);
  }
  return Buffer.from(b).toString('base64');
}

const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
const TEXTS = ['hello', 'two words', '\u0007bell', 'caf\u00e9 \u00ff', '', '   ', 'x=y "q" %20', 'a\tb\nc', '\u009b\u00adsoft', 'long long long long long long text'];

class Gen {
  constructor(seed, ext) {
    const vips = ['10.77.0.2', '10.77.0.3', '10.77.0.4', '10.77.0.5', '10.77.0.6', '10.77.0.7'];
    const groups = ['g2', 'g3', 'g4', 'g5', 'g6', 'g6'];
    this.r = new Rng(seed);
    this.steps = [];
    this.conns = 0;
    this.port = 40000;
    this.ps = NAMES.map((name, i) => ({ vip: vips[i], group: groups[i], name, lobby: null, buddy: null }));
    this.races = [];
    this.games = 0;
    /** odd frames and the timers too (generateExt) */
    this.ext = ext;
  }
  step(v) {
    this.steps.push(v);
  }
  connect(p, dport) {
    const i = this.conns++;
    this.port += 1;
    const { vip, group } = this.ps[p];
    this.step({ op: 'connect', vip, group, port: this.port, dport, cid: 7000 + i });
    return i;
  }
  send(c, kind, fields) {
    this.step({ op: 'send', conn: c, kind, fields });
  }
  login(p, persona) {
    const c = this.connect(p, PORT_LOBBY);
    this.send(c, 'addr', [['ADDR', '10.77.0.99'], ['PORT', 50000 + c]]);
    this.send(c, 'skey', [['SKEY', '$5075626c6963204b6579']]);
    this.send(c, 'news', [['NAME', 7]]);
    this.send(c, 'sele', [['MYGAME', 1], ['STATS', 5000]]);
    const name = this.ps[p].name;
    this.send(c, 'auth', [['NAME', name], ['PASS', 'secret'], ['REGKEY', 'AAAA']]);
    if (persona !== name) this.send(c, 'cper', [['PERS', persona]]);
    this.send(c, 'pers', [['PERS', persona]]);
    this.ps[p].lobby = c;
  }
  buddy(p) {
    const l = this.ps[p].lobby;
    if (l === null) return;
    const c = this.connect(p, PORT_BUDDY);
    this.send(c, 'AUTH', [['PROD', 'NFS-CONSOLE-2005'], ['LKEY', { lkey: l }]]);
    this.ps[p].buddy = c;
  }
  someName() {
    const n = this.r.pick(NAMES);
    switch (this.r.below(5)) {
      case 0: return n.toLowerCase();
      case 1: return n + '@ea.com';
      case 2: return 'Nobody';
      default: return n;
    }
  }
  maybe(f, k, pool) {
    if (this.r.chance(0.6)) f.push([k, this.r.pick(pool)]);
  }

  lobbyMessage(p) {
    const c = this.ps[p].lobby;
    if (c === null) return;
    const f = [];
    const games = ['Race1', 'Race2', 'Race 3', '\u0001'];
    const kind = this.r.pick([
      'mesg', 'mesg', 'move', 'move', 'auxi', 'gsea', 'gsea', 'gcre', 'gjoi', 'gjoi', 'gset', 'gset', 'gsta', 'gdel', 'glea', 'user',
      'onln', 'snap', 'snap', 'rept', 'lost', 'sele', 'news', 'auth', 'cper', 'dper', 'pers', 'zzzz', '~png', 'skey',
    ]);
    switch (kind) {
      case 'mesg':
        f.push(['TEXT', this.r.pick(TEXTS)]);
        if (this.r.chance(0.3)) f.push(['PRIV', this.someName()]);
        this.maybe(f, 'ATTR', ['', 'G', 'X', 'GGGGGGGGGGGG']);
        break;
      case 'move': f.push(['NAME', this.r.pick(['Lounge', 'Circuit', 'sprint', 'URL', 'nowhere', ''])]); break;
      case 'auxi': f.push(['TEXT', this.r.pick(TEXTS)]); break;
      case 'gsea':
        this.maybe(f, 'START', [0, 1, -1, 'x']);
        this.maybe(f, 'COUNT', [0, 2, 20, 99]);
        this.maybe(f, 'CUSTFLAGS', [0, 0x40000f3, 0x100]);
        this.maybe(f, 'CUSTMASK', [0, 0x40001f3, -1]);
        this.maybe(f, 'SYSFLAGS', [0, 1 << 18]);
        this.maybe(f, 'SYSMASK', [0, 0xc0000]);
        break;
      case 'gcre':
        f.push(['NAME', this.r.pick(games)]);
        this.maybe(f, 'MAXSIZE', [0, 2, 4, 9, 'x']);
        this.maybe(f, 'MINSIZE', [0, 3, 7]);
        this.maybe(f, 'CUSTFLAGS', [0, 0x40000f3, 0x100, 4294967295]);
        this.maybe(f, 'SYSFLAGS', [0, 1 << 18, (1 << 16) | (1 << 19), -1]);
        this.maybe(f, 'PARAMS', ['TRACK=4014', 'TRACK=1\nLAPS=2', 'P'.repeat(300)]);
        break;
      case 'gjoi':
        if (this.r.chance(0.7)) f.push(['NAME', this.r.pick(games)]);
        else f.push(['IDENT', this.r.pick([1, 2, 3, 'x', '1.0'])]);
        break;
      case 'gset':
        this.maybe(f, 'USERFLAGS', [0, 1 << 27, 'x', -1]);
        this.maybe(f, 'PARAMS', ['TRACK=2', 'TRACK=4014']);
        this.maybe(f, 'MAXSIZE', [2, 6, 1]);
        this.maybe(f, 'MINSIZE', [2, 5]);
        this.maybe(f, 'SYSFLAGS', [0, 1 << 12, 4294967295]);
        if (this.r.chance(0.3)) {
          const a = this.someName(), b = this.someName(), c2 = this.someName();
          f.push(['KICK', a + ', ' + b + ' ,' + c2]);
        }
        break;
      case 'user': case 'onln': case 'rept':
        f.push(['PERS', this.someName()]);
        break;
      case 'snap':
        f.push(['INDEX', this.r.below(9)]);
        f.push(['CHAN', this.r.pick([0, 6, 7, 11, 12, 13, 18, 24, 29, 30, 'x'])]);
        this.maybe(f, 'START', [0, 1, -1]);
        this.maybe(f, 'RANGE', [0, 1, 10, 200]);
        if (this.r.chance(0.3)) f.push(['FIND', this.r.pick(['$', '$Alpha', 'bravo', ''])]);
        break;
      case 'sele': this.maybe(f, 'STATS', [5000, 'x', 99999, -3]); break;
      case 'news': f.push(['NAME', this.r.pick([6, 7])]); break;
      case 'auth': f.push(['NAME', this.ps[p].name]); break;
      case 'cper': case 'dper': case 'pers':
        f.push(['PERS', this.r.pick(['Second', 'Third', 'x y', 'Sp1cs', this.ps[p].name])]);
        break;
      default:
    }
    this.send(c, kind, f);
  }

  buddyMessage(p) {
    const c = this.ps[p].buddy;
    if (c === null) return;
    const kind = this.r.pick([
      'RGET', 'RADD', 'RADD', 'RDEL', 'RADM', 'RADM', 'RRSP', 'PADD', 'PDEL', 'USCH', 'PSET', 'PSET', 'SEND', 'GINV', 'GRSP', 'EPGT',
      'PING', 'DISC', 'AUTH', 'ZZZZ',
    ]);
    const f = [];
    this.maybe(f, 'ID', [1, 7, 'x']);
    switch (kind) {
      case 'RGET': this.maybe(f, 'LIST', ['B', 'I', 'i', 'x']); break;
      case 'RADD': case 'RDEL': case 'RADM': case 'PADD': case 'PDEL':
        f.push(['USER', this.someName()]);
        this.maybe(f, 'LIST', ['B', 'I']);
        break;
      case 'RRSP':
        f.push(['USER', this.someName()]);
        this.maybe(f, 'ANSW', ['Y', 'N', 'no', 'FALSE', '0', 'yes', '']);
        break;
      case 'USCH':
        f.push(['USER', this.r.pick(['a', 'b', 'al', 'zz', '', 'CH', 'd@x'])]);
        this.maybe(f, 'MAXR', [0, 1, 5, 30]);
        break;
      case 'PSET':
        this.maybe(f, 'SHOW', ['CHAT', 'AWAY', 'XA-VERY-LONG']);
        this.maybe(f, 'STAT', ['', 'EX=0\nP=nfs5\n']);
        this.maybe(f, 'PROD', ['racing', 'in the lobby', '\u0007x']);
        break;
      case 'SEND': case 'GINV': case 'GRSP':
        f.push(['USER', this.someName()]);
        f.push(['BODY', this.r.pick(TEXTS)]);
        this.maybe(f, 'SUBJ', ['hi', '']);
        this.maybe(f, 'TYPE', ['C', 'GAMEINVITE']);
        this.maybe(f, 'LKEY', ['x']);
        if (kind !== 'SEND' && this.r.chance(0.2)) {
          // a field name the server cannot pass on (its own encoder refuses it): the body as text
          f.push(['A-B', 'bad key']);
          const text = [];
          for (const [k, v] of f) {
            text.push(...latin1Bytes(k), 0x3d);
            encodeValue(v, text);
            text.push(0x0a);
          }
          this.step({ op: 'text', conn: c, kind, text: latin1Decode(Uint8Array.from(text)) });
          return;
        }
        break;
      case 'AUTH': f.push(['LKEY', { lkey: this.ps[p].lobby ?? 0 }]); break;
      default:
    }
    this.send(c, kind, f);
  }

  race() {
    const who = this.ps.map((_, i) => i).filter((i) => this.ps[i].lobby !== null);
    if (who.length < 2) return;
    const n = 2 + this.r.below(Math.min(2, who.length - 1));
    const ps = [];
    for (let i = 0; i < n; i++) ps.push(who.splice(this.r.below(who.length), 1)[0]);
    this.games += 1;
    const name = 'R' + this.games;
    const conns = ps.map((p) => this.ps[p].lobby);
    this.send(conns[0], 'gcre', [['NAME', name], ['PARAMS', 'TRACK=4014']]);
    for (const c of conns.slice(1)) this.send(c, 'gjoi', [['NAME', name]]);
    this.send(conns[0], 'gsta', [['NAME', name]]);
    const seed = this.r.below(1000);
    this.races.push([ps, conns, seed]);
  }

  /** a friend request between two players with Messenger, answered (yes, no, or a request back) */
  friends() {
    const who = this.ps.map((_, i) => i).filter((i) => this.ps[i].buddy !== null);
    if (who.length < 2) return;
    const a = this.r.pick(who), b = this.r.pick(who);
    const ca = this.ps[a].buddy, cb = this.ps[b].buddy;
    const na = this.ps[a].name, nb = this.ps[b].name;
    if (this.r.chance(0.3)) this.send(ca, 'RADD', [['USER', nb], ['LIST', 'B']]);
    this.send(ca, 'RADM', [['USER', nb], ['ID', 3]]);
    switch (this.r.below(3)) {
      case 0: this.send(cb, 'RADM', [['USER', na]]); break;
      case 1: this.send(cb, 'RRSP', [['USER', na], ['ANSW', 'N']]); break;
      default: this.send(cb, 'RRSP', [['USER', na.toLowerCase()], ['ANSW', 'Y'], ['ID', 4]]);
    }
    if (this.r.chance(0.5)) this.send(cb, 'RGET', [['LIST', 'B']]);
  }

  /** a game whose creator kicks some players (the countdown's end), then starts or deletes it */
  kick() {
    const who = this.ps.map((_, i) => i).filter((i) => this.ps[i].lobby !== null);
    if (who.length < 3) return;
    const ps = [];
    for (let i = 0; i < 3; i++) ps.push(who.splice(this.r.below(who.length), 1)[0]);
    this.games += 1;
    const name = 'K' + this.games;
    const conns = ps.map((p) => this.ps[p].lobby);
    this.send(conns[0], 'gcre', [['NAME', name], ['MAXSIZE', 4], ['PARAMS', 'TRACK=4011']]);
    for (const c of conns.slice(1)) this.send(c, 'gjoi', [['NAME', name]]);
    this.send(conns[1], 'gset', [['USERFLAGS', 1 << 27]]);
    this.send(conns[0], 'gset', [['SYSFLAGS', 1 << 12], ['USERFLAGS', 1 << 27]]);
    const kicked = ' ' + this.ps[ps[2]].name.toUpperCase() + ' ,' + this.ps[ps[0]].name;
    this.send(conns[0], 'gset', [['KICK', kicked]]);
    const last = this.r.chance(0.5) ? 'gsta' : 'gdel';
    this.send(conns[0], last, []);
  }

  report() {
    if (this.races.length === 0) return;
    const [ps, conns, seed] = this.races.splice(this.r.below(this.races.length), 1)[0];
    ps.forEach((p, i) => {
      const old = conns[i];
      if (this.r.chance(0.8)) {
        const name = this.ps[p].name;
        const l = this.ps[p].lobby;
        if (l !== null) this.step({ op: 'fin', conn: l });
        this.login(p, name);
      }
      const l = this.ps[p].lobby;
      if (l === null) return;
      const agree = this.r.chance(0.85) ? seed : seed + 1;
      const f = [['AUTH', { ses: [old, 'AUTH'] }], ['RESU', { resu: [old, agree] }], ['VENUE', 'NFSUG2']];
      this.step({ op: 'send', conn: l, kind: 'rank', fields: f, names: old });
    });
  }

  /** a whole switch frame from player p's browser: short ones, other kinds and ops, streams that are not there */
  oddFrame(p) {
    const vip = ip(this.ps[p].vip), group = this.ps[p].group;
    const host = VHOST_VIP;
    const port = this.r.pick([PORT_LOBBY, PORT_BUDDY, PORT_HTTP, PORT_REDIRECTOR, 9]);
    // a stream of this player's (its port and id), or one that is not
    const c = this.ps[p].lobby;
    const [sport, cid] = c !== null && this.r.chance(0.5) ? [(40000 + c + 1) & 0xffff, 7000 + c] : [39999, 1];
    const kind = this.r.below(10);
    let f;
    switch (kind) {
      case 0: f = unhex(this.r.pick(['', '04', '040000000a4d0002', '04000000000000000000000000000000000000'])); break;
      case 1: f = lanFrame(4, vip, host, sport, port, this.r.pick([0, 2, 6, 255]), cid, bytes('x')); break;
      case 2: f = lanFrame(4, vip, host, sport, port, SYNACK, cid, none); break;
      case 3: f = lanFrame(4, vip, host, sport, port, DATA, cid, none); break;
      case 4: f = lanFrame(4, vip, host, sport, port, FIN, cid, none); break;
      case 5: f = lanFrame(this.r.pick([0, 1, 2, 6, 9]), vip, host, sport, port, 1, cid, bytes('abc')); break;
      case 6: {
        const echo = unhex(this.r.pick(['0800aabb00010002', '08', '0000aabb00010002', '0800000000000000ff']));
        f = lanFrame(5, vip, host, 0, 0, 0, 0, echo);
        break;
      }
      case 7: {
        const dport = this.r.pick([3658, 53]);
        f = lanFrame(3, vip, host, 3658, dport, this.r.pick([0, 1]), 0, bytes('udp'));
        break;
      }
      // a duplicate SYN of a stream that is there
      case 8: f = lanFrame(4, vip, host, sport, PORT_LOBBY, SYN, cid, none); break;
      // the middle of a message, then nothing: its stream resets
      default: {
        const part = encodeFrame('mesg', '', [['TEXT', 'cut short']]).subarray(0, 15);
        f = lanFrame(4, vip, host, sport, PORT_LOBBY, DATA, cid, part);
      }
    }
    this.step({ op: 'frame', vip: this.ps[p].vip, group, frame: f });
    // (a stream left in the middle of a message always resets: what came after it would be read from the middle of a
    // message, and each side's own random values would be taken for its length)
    if (kind === 9 || this.r.chance(0.3)) {
      const rst = lanFrame(4, vip, host, sport, PORT_LOBBY, RST, cid, none);
      this.step({ op: 'frame', vip: this.ps[p].vip, group, frame: rst });
    }
  }

  /** what the timers do: streams that never say anything (the redirector's, the web pages', a Messenger that never
   *  logs in), a Messenger login before its lobby login is done (tried again), presence held back, a second lobby
   *  session of one browser, then time passes */
  timed(p) {
    switch (this.r.below(6)) {
      case 0: this.connect(p, this.r.pick([PORT_REDIRECTOR, PORT_HTTP, PORT_BUDDY])); break;
      case 1: {
        const c = this.connect(p, PORT_BUDDY);
        const key = this.r.pick(['', '0123456789abcdef0123456789abcdef', 'short']);
        this.send(c, 'AUTH', [['LKEY', key]]);
        break;
      }
      case 2: {
        const b = this.ps[p].buddy;
        if (b !== null) for (const prod of ['a', 'b', 'c']) this.send(b, 'PSET', [['SHOW', 'CHAT'], ['PROD', prod]]);
        break;
      }
      case 3:
        // a reconnect that overlaps the old session (the old one is not closed first)
        this.login(p, this.ps[p].name);
        break;
      default:
    }
    const ms = this.r.pick([1.0, 300.0, 499.0, 500.0, 999.0, 1000.0, 1001.0, 3000.0, 5000.0, 10000.0, 15000.0, 30001.0, 61000.0]);
    this.step({ op: 'sleep', ms });
  }

  action() {
    const p = this.r.below(this.ps.length);
    if (this.ext && this.r.chance(0.25)) return this.r.chance(0.5) ? this.oddFrame(p) : this.timed(p);
    const x = this.r.below(100);
    const P = this.ps[p];
    if (x <= 29) this.lobbyMessage(p);
    else if (x <= 54) this.buddyMessage(p);
    else if (x <= 57) {
      if (P.lobby !== null) this.step({ op: 'fin', conn: P.lobby });
      const persona = this.r.chance(0.2) ? this.r.pick(NAMES) : P.name;
      this.login(p, persona);
    } else if (x <= 64) {
      this.step({ op: 'advance', ms: this.r.pick([0.0, 500.0, 1000.0, 5000.0, 30000.0, 130000.0]) });
    } else if (x <= 66) {
      this.step({ op: 'gone', vip: P.vip });
      P.lobby = null;
      P.buddy = null;
    } else if (x <= 68) {
      this.step({ op: 'slow', vip: P.vip, on: this.r.chance(0.5) });
    } else if (x <= 71) this.buddy(p);
    else if (x <= 73) this.step({ op: 'info' });
    else if (x <= 75) {
      const c = this.connect(p, PORT_REDIRECTOR);
      this.step({ op: 'text', conn: c, kind: '@tic', text: 'RC4' });
      this.send(c, '@dir', [['PROD', 'nfs-pc-2005']]);
      if (this.r.chance(0.5)) this.step({ op: 'fin', conn: c });
    } else if (x <= 77) {
      const c = this.connect(p, PORT_HTTP);
      const req = this.r.pick(['GET /news HTTP/1.0\r\n\r\n', 'HEAD /TOS?x HTTP/1.1\r\n\r\n', 'GET /x HTTP/1.0\r\n\r\n', 'BAD\r\n\r\n', 'GET /news']);
      this.step({ op: 'raw', conn: c, bytes: bytes(req) });
      if (this.r.chance(0.5)) this.step({ op: 'fin', conn: c });
    } else if (x <= 83) this.race();
    else if (x <= 86) {
      if (this.r.chance(0.5)) this.friends();
      else this.kick();
    } else if (x <= 91) this.report();
    else if (x <= 94) {
      if (P.lobby !== null) {
        const junk = this.r.pick(['61016263000000000000000d00', '6d657367000000000000000c', '6d657367000000000000ffff00']);
        this.step({ op: 'raw', conn: P.lobby, bytes: unhex(junk) });
      }
    } else if (x <= 96) {
      if (P.buddy !== null) this.step({ op: this.r.chance(0.5) ? 'fin' : 'rst', conn: P.buddy });
    } else if (P.lobby !== null) {
      this.step({ op: 'fin', conn: P.lobby });
      P.lobby = null;
    }
  }
}

/** a session of n actions from seed (ext: with odd switch frames and time passing on the timers' clock) */
function generate(seed, n, ext = false) {
  const g = new Gen(seed, ext);
  NAMES.forEach((name, p) => {
    g.login(p, name);
    g.buddy(p);
  });
  for (let i = 0; i < n; i++) g.action();
  g.step({ op: 'info' });
  g.step({ op: 'stop' });
  return { steps: g.steps };
}
const generateExt = (seed, n) => generate(seed, n, true);

/** the session on one online host, the lobby's counts checked after every step */
function run(s, storage) {
  const w = world({ storage, t0: T0 });
  const conns = [];
  const last = (i, kind, k) => {
    const m = w.conn(conns[i]).last(kind);
    return (m && m.get(k)) ?? '';
  };
  const value = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (v.lkey !== undefined) return last(v.lkey, 'pers', 'LKEY');
    if (v.ses !== undefined) return last(v.ses[0], '+ses', v.ses[1]);
    if (v.resu !== undefined) {
      const [i, seed] = v.resu;
      const n = w.conn(conns[i]).last('+ses') !== null ? usize(toNumber(last(i, '+ses', 'COUNT'))) : 2;
      return resu(n, seed);
    }
    throw new Error('a value: ' + JSON.stringify(v));
  };
  for (const [at, st] of s.steps.entries()) {
    const conn = st.conn !== undefined ? conns[st.conn] : null;
    try {
      switch (st.op) {
        case 'connect': {
          const vip = ip(st.vip);
          if (!w.clients.has(vip)) w.clientIn(st.vip, st.group);
          w.connectAs(vip, st.dport, st.port, st.cid);
          conns.push([vip, st.port]);
          break;
        }
        case 'send': {
          const f = st.fields.map(([k, v]) => [k, value(v)]);
          if (st.names !== undefined) {
            const ses = w.conn(conns[st.names]).last('+ses');
            if (ses !== null) {
              const n = usize(toNumber(ses.get('COUNT') ?? '0'));
              for (let k = 0; k < n; k++) f.push(['NAME' + k, ses.get('OPPO' + k)]);
            }
          }
          w.send(conn, st.kind, f);
          break;
        }
        case 'text': w.sendText(conn, st.kind, st.text); break;
        case 'raw': w.sendRaw(conn, st.bytes); break;
        case 'frame': {
          const vip = ip(st.vip);
          if (!w.clients.has(vip)) w.clientIn(st.vip, st.group);
          w.raw(vip, st.frame);
          break;
        }
        case 'fin': w.close(conn); break;
        case 'rst': w.rst(conn); break;
        case 'advance': w.advance(st.ms); break;
        case 'sleep': w.sleep(st.ms); break;
        case 'gone': w.peerGone(ip(st.vip)); break;
        case 'slow': {
          const vip = ip(st.vip);
          if (st.on) w.slow.add(vip);
          else w.slow.delete(vip);
          break;
        }
        case 'info':
          // (what /players and the console read of the host)
          w.core.info();
          w.core.vips();
          break;
        case 'stop':
          w.core.stop();
          w.deliver();
          break;
        default: throw new Error('a step: ' + st.op);
      }
      w.core.lobby.checkCounts();
    } catch (e) {
      e.message = 'step ' + at + ' ' + JSON.stringify(st, (k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)) + ': ' + e.message;
      throw e;
    }
  }
  const store = new Store(storage);
  return { frames: w.sent.length, lines: w.text(), stats: store.get('stats.json'), buddies: shelfTexts(store), t: w.t, errors: w.core.errors };
}

/** a session from its seed: consistent after every step, and its files read back as they were written */
function check(t, s, seed) {
  const storage = new MapStorage();
  const r = run(s, storage);
  const clock = { t: r.t };
  const clocks = { now: () => clock.t, timer: () => clock.t };
  const store = new Store(storage);
  if (r.stats !== null) {
    const back = new Stats({ store, clocks, log: () => {} });
    assert.equal(r.stats, back.serialize(), 'seed ' + seed + ': stats.json read back');
  }
  assert.deepEqual(r.buddies, shelfReread(store), 'seed ' + seed + ': the friends lists read back');
  // what the session went through (each seed's share of the rules)
  const n = (p) => r.lines.filter((l) => l.includes(p)).length;
  t.diagnostic(
    'session ' + seed + ': ' + s.steps.length + ' steps, ' + r.frames + ' frames, ' + r.lines.length + ' lines, ' + r.errors.length + ' errors; results ' +
      (n('ranked)') + n('ranked):')) + ', not taken ' + n('not taken') + ', differs ' + n('differs') + ', friends ' + n('are friends') +
      ', asked ' + n('to be friends') + ', kicked ' + n('kicked out') + ', ended ' + n('ended:') + ', dropped ' + n('dropped:') +
      ', slow ' + n('does not keep up') + ', refused ' + n('refused') + ', races ' + n('the race starts'),
  );
}

const SESSIONS = Number(process.env.NFSU2_SESSIONS) > 0 ? Math.trunc(Number(process.env.NFSU2_SESSIONS)) : 8;

test('random_sessions_keep_the_lobby_consistent', (t) => {
  for (let seed = 11; seed < 11 + SESSIONS; seed++) check(t, generate(seed, 900), seed);
});

// the same with odd switch frames, streams that reset in the middle of a message, overlapping sessions of one
// browser, and time passing on the timers' clock (the services' time-outs, the game list's and the populations'
// once-a-second, held-back presence, the Messenger login tried again, the files' saves)
test('random_sessions_with_timers_keep_the_lobby_consistent', (t) => {
  for (let seed = 1011; seed < 1011 + SESSIONS; seed++) check(t, generateExt(seed, 900), seed);
});

