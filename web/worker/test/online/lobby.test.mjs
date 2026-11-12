// The tests of crates/online/src/tests/lobby.rs, ported one for one: the online host's services driven by fake game
// clients that speak the switch's frames (harness.mjs World = tests/world.rs).  The redirector, the login, personas,
// rooms and chat, games from creation to the race start, game passwords, the game list, the countdown and kick,
// leaving, the limits, results and rankings, names with digits, the web pages, EA Messenger and the race ban.
// Randomness is a seeded Prng here: values Rust gets at random (LKEY, AUTH, digits) are asserted on their shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFields, encodeFrame } from '../../src/online/aries.js';
import { lanFrame, VHOST_VIP, DATA } from '../../src/online/vhost.js';
import { PORT_BUDDY, PORT_HTTP, PORT_LOBBY, PORT_REDIRECTOR } from '../../src/online/core.js';
import { latin1Bytes, latin1Decode, monthOf } from '../../src/online/jsx.js';
import { shelfTexts } from '../../src/online/buddy.js';
import { Deny } from '../../src/names/index.js';
import { world, ip, MapStorage } from './harness.mjs';

const isHex = (s, n) => s.length === n && /^[0-9a-f]*$/.test(s);
/** /^<prefix>\d{4}$/ */
const digits4 = (s, prefix) => s.startsWith(prefix) && /^\d{4}$/.test(s.slice(prefix.length));
const fieldsLen = (m) => encodeFields([...m.f.m]).length;
/** a record as text, for the tests that look for a secret in it (Rust: its Debug form) */
const dump = (x) =>
  JSON.stringify(x, (k, v) => {
    if (typeof v === 'bigint') return String(v);
    if (v instanceof Map) return [...v];
    if (v instanceof Set) return [...v];
    if (v instanceof Uint8Array) return Buffer.from(v).toString('latin1');
    return v;
  });
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** w.client(...) then w.login(...) for each name, at 10.77.0.2 on */
function players(w, names) {
  return names.map((n, i) => w.login(w.client('10.77.0.' + (i + 2)), n));
}

// redirector: @dir points at the lobby, @tic gets no answer, then the link closes
test('redirector', () => {
  const w = world();
  const g = w.client('10.77.0.2');
  const c = w.connect(g, PORT_REDIRECTOR);
  assert.ok(w.conn(c).open);
  w.sendText(c, '@tic', 'RC4+MD5-V2');
  assert.equal(w.conn(c).msgs.length, 0);
  w.send(c, '@dir', [['PROD', 'nfs-pc-2005'], ['MID', '$024e564c0002']]);
  const d = w.conn(c).l('@dir');
  assert.equal(d.g('ADDR'), '10.77.0.1');
  assert.equal(d.g('PORT'), String(PORT_LOBBY));
  assert.ok(isHex(d.g('MASK'), 32));
  assert.ok(/^\d+$/.test(d.g('SESS')) && BigInt(d.g('SESS')) > 0n);
  assert.ok(w.conn(c).fin, 'the redirector closes after its answer');
  const ssl = w.connect(g, 20921);
  assert.ok(w.conn(ssl).reset, 'no SSL port: refused');
});

// login: config, any name, personas, LKEY, nothing secret kept
test('login', () => {
  const w = world();
  const g = w.client('10.77.0.2');
  const c = w.loginAs(g, 'Speedy', 'Speedy', 'CANARY-PASSWORD-123');
  const m = w.conn(c).take();
  const kinds = m.map((x) => x.kind + '/' + x.code);
  assert.deepEqual(kinds.slice(0, 4), ['skey/', 'news/new7', 'sele/', 'auth/']);
  const news = m.find((x) => x.kind === 'news');
  assert.equal(news.g('BUDDY_SERVER'), '10.77.0.1');
  assert.equal(news.g('BUDDY_PORT'), String(PORT_BUDDY));
  const auth = m.find((x) => x.kind === 'auth');
  assert.equal(auth.g('PERSONAS'), 'Speedy');
  assert.equal(auth.g('ADDR'), '10.77.0.2', 'the virtual address, never another');
  assert.ok(fieldsLen(auth) <= 122, "the auth reply fits the game's 122 bytes");
  assert.equal(m.filter((x) => x.kind === '+rom').length, 7);
  const pers = m.find((x) => x.kind === 'pers');
  assert.equal(pers.g('PERS'), 'Speedy');
  assert.ok(isHex(pers.g('LKEY'), 30));
  assert.ok(fieldsLen(pers) <= 108);
  assert.ok(m.some((x) => x.kind === '+who') && m.some((x) => x.kind === '+sst'));
  // the server keeps nothing of the password, the CD key or the file checksum, and logs none of them
  const s = w.core.lobby.s(w.core.lobby.sessions.values().next().value);
  const kept = dump([s.account, s.personas, s.persona, s.lkey, s.addr, s.auxi, s.group]);
  const lines = w.text().join('\n');
  for (const secret of ['CANARY-PASSWORD-123', 'AAAA-BBBB', '0123456789abcdef', '024e564c0002']) {
    assert.ok(!kept.includes(secret), 'session keeps ' + secret);
    assert.ok(!lines.includes(secret), 'log has ' + secret);
  }
  // one holder per persona name while online (another browser gets it with digits); a bad name is refused
  const g2 = w.client('10.77.0.3');
  const c2 = w.login(g2, 'Speedy');
  assert.ok(digits4(w.conn(c2).l('pers').g('PERS'), 'Speedy'));
  const c3 = w.login(g2, 'x y');
  assert.equal(w.conn(c3).l('auth').code, 'imst');
  // ... and so is one that reads as a slur (nfsu2-names), as an account or a persona
  const c4 = w.login(g2, 'F4g_42');
  assert.equal(w.conn(c4).l('auth').code, 'imst');
  // a second persona for this session (create, select, delete)
  w.send(c, 'cper', [['PERS', 'Second']]);
  assert.equal(w.conn(c).l('cper').code, '');
  assert.equal(w.conn(c).l('cper').g('PERS'), 'Second');
  w.send(c, 'cper', [['PERS', 'Speedy']]);
  assert.equal(w.conn(c).l('cper').code, 'dupl');
  w.send(c, 'cper', [['PERS', 'Sp1cs']]);
  assert.equal(w.conn(c).l('cper').code, 'invp');
  w.send(c, 'dper', [['PERS', 'Second']]);
  assert.equal(w.conn(c).l('dper').g('RESULT'), '0');
});

// rooms and chat: the room hears it, a private message reaches one, a flood is muted
test('rooms_and_chat', () => {
  const w = world();
  const [ga, gb] = [w.client('10.77.0.2'), w.client('10.77.0.3')];
  const a = w.login(ga, 'Alpha');
  const b = w.login(gb, 'Bravo');
  w.send(a, 'move', [['NAME', 'Lounge']]);
  w.send(b, 'move', [['NAME', 'Lounge']]);
  assert.equal(w.conn(b).l('move').g('COUNT'), '2');
  assert.equal(w.conn(b).l('+usr').g('N'), 'Alpha');
  assert.equal(w.conn(a).l('+usr').g('A'), '10.77.0.3');
  w.conn(a).take();
  w.conn(b).take();
  w.send(a, 'mesg', [['TEXT', 'hello \u009b there\u0007']]);
  assert.equal(w.conn(b).l('+msg').g('T'), 'hello there');
  assert.equal(w.conn(b).l('+msg').g('N'), 'Alpha');
  w.send(b, 'mesg', [['TEXT', 'psst'], ['PRIV', 'alpha']]);
  assert.equal(w.conn(a).l('+msg').g('F'), 'P');
  assert.equal(w.conn(a).l('+msg').g('T'), 'psst');
  for (let i = 0; i < 8; i++) w.send(a, 'mesg', [['TEXT', 'spam ' + i]]);
  assert.equal(w.conn(a).l('mesg').code, 'mute');
  assert.ok(w.logged('muted'));
  const heard = w.conn(b).all().filter((x) => x.kind === '+msg' && x.get('N') === 'Alpha').length;
  assert.ok(heard <= 6, 'heard ' + heard);
  w.send(a, 'mesg', [['TEXT', 'x'.repeat(1000)]]);
  w.send(b, 'move', [['NAME', '']]);
  assert.equal(w.conn(a).l('+usr').g('T'), '1', 'Bravo left the room');
});

/** a player in Online mode with EA Messenger logged in: [lobby session, Messenger] */
function messenger(w, vip, name) {
  const g = w.client(vip);
  const l = w.login(g, name);
  const k = w.lkey(l);
  return [l, w.buddy(g, k)];
}

// a line that reads as a slur reaches only its sender (three mute it), a blocked persona is not heard, and a
// complaint logs what the player said where the complainer could hear it
test('slurs_blocks_and_complaints', () => {
  // a minute, not ten: a session says nothing for two at most
  const w = world({ limits: { slurWindowMs: 60000, slurMuteMs: 60000, saidMs: 60000 } });
  const [a] = messenger(w, '10.77.0.2', 'Alpha');
  const [b, bm] = messenger(w, '10.77.0.3', 'Bravo');
  const [c] = messenger(w, '10.77.0.4', 'Charlie');
  for (const x of [a, b, c]) w.send(x, 'move', [['NAME', 'Lounge']]);
  const heard = (x, t) => w.conn(x).all().some((m) => m.kind === '+msg' && m.get('T') === t);
  // the sender sees its line as said; the room does not
  w.send(a, 'mesg', [['TEXT', 'nate higgers']]);
  assert.ok(heard(a, 'nate higgers') && !heard(b, 'nate higgers') && !heard(c, 'nate higgers'));
  assert.ok(w.logged('"Alpha": a line with "higgers" in it, shown to no one else'));
  // swearing goes through
  w.advance(2000);
  w.send(a, 'mesg', [['TEXT', 'merci kurwa']]);
  assert.ok(heard(b, 'merci kurwa') && heard(c, 'merci kurwa'));
  // private lines: one to Charlie, one to Bravo
  w.advance(2000);
  w.send(a, 'mesg', [['TEXT', 'psst charlie'], ['PRIV', 'Charlie']]);
  w.send(a, 'mesg', [['TEXT', 'psst bravo'], ['PRIV', 'bravo']]);
  assert.ok(heard(c, 'psst charlie') && heard(b, 'psst bravo'));
  // the third line that reads as a slur in the window mutes the sender
  w.advance(2000);
  w.send(a, 'mesg', [['TEXT', 'n i g g e r']]);
  assert.ok(!w.logged('muted for 60 s'));
  w.advance(2000);
  w.send(a, 'mesg', [['TEXT', 'SIEG HEIL']]);
  assert.ok(w.logged('"Alpha": a line with "SIEG HEIL" in it, shown to no one else; muted for 60 s'));
  w.advance(2000);
  w.send(a, 'mesg', [['TEXT', 'hello?']]);
  assert.equal(w.conn(a).l('mesg').code, 'mute');
  assert.ok(!heard(b, 'hello?'));
  // Bravo blocks Charlie (EA Messenger): Charlie's lines reach Alpha, not Bravo
  w.send(bm, 'RADD', [['USER', 'Charlie'], ['LIST', 'I'], ['ID', 9]]);
  w.send(c, 'mesg', [['TEXT', 'hi all']]);
  assert.ok(heard(a, 'hi all') && !heard(b, 'hi all') && heard(c, 'hi all'));
  w.advance(2000);
  w.send(c, 'mesg', [['TEXT', 'hi bravo'], ['PRIV', 'Bravo']]);
  assert.ok(!heard(b, 'hi bravo'));
  // ... until Bravo takes the block back
  w.send(bm, 'RDEL', [['USER', 'Charlie'], ['LIST', 'I'], ['ID', 10]]);
  w.advance(2000);
  w.send(c, 'mesg', [['TEXT', 'hi again']]);
  assert.ok(heard(b, 'hi again') && !w.core.buddies.blocked('charlie'));
  // Bravo's complaint about Alpha: its address, its last five lines but the private one to Charlie
  w.send(b, 'rept', [['PERS', 'Alpha'], ['LANG', 'EN'], ['TYPE', '0']]);
  assert.equal(w.conn(b).l('rept').g('TEXT'), 'Report complete');
  const line = w.text().find((l) => l.includes('a complaint about'));
  assert.ok(line, "the complaint's line");
  assert.equal(
    line,
    '[online] 10.77.0.3 "Bravo": a complaint about 10.77.0.2 "Alpha", who said: "merci kurwa" "psst bravo" ' +
      '"n i g g e r" (shown to no one) "SIEG HEIL" (shown to no one)',
  );
  // a minute on, nothing is kept, and Alpha may speak again
  w.advance(61000);
  assert.ok(!w.core.lobby.said.has('alpha'));
  w.send(c, 'rept', [['PERS', 'Alpha']]);
  assert.ok(w.logged('"Charlie": a complaint about 10.77.0.2 "Alpha" (no lines of its kept)'));
  w.send(a, 'mesg', [['TEXT', 'sorry']]);
  assert.ok(heard(b, 'sorry'));
});

// a game: create, list, join, ready, start; +ses names every player by virtual address
test('a_game', () => {
  const w = world();
  const [ga, gb] = [w.client('10.77.0.2'), w.client('10.77.0.3')];
  const a = w.login(ga, 'Alpha');
  const b = w.login(gb, 'Bravo');
  const p = 'TRACK=4123\nDIR=0\nLAPS=2';
  // a game name that reads as a slur (nfsu2-names) is refused, as a name would be
  w.send(a, 'gcre', [['NAME', '088.N1663r'], ['PARAMS', p]]);
  assert.equal(w.conn(a).l('gcre').code, 'inam');
  w.send(a, 'gcre', [['NAME', '088.Alpha'], ['MAXSIZE', 4], ['MINSIZE', 2], ['CUSTFLAGS', 134217971], ['SYSFLAGS', 0], ['PARAMS', p]]);
  const cre = w.conn(a).l('gcre');
  assert.equal(cre.code, '');
  assert.equal(cre.g('HOST'), 'Alpha');
  assert.equal(cre.g('ADDR0'), '10.77.0.2');
  assert.equal(cre.g('PARAMS'), p);
  assert.ok(w.conn(a).last('+mgm') !== null && w.conn(a).l('+who').g('F') === 'G');
  // the game list: a Filter of another race type lists it too
  w.send(b, 'gsea', [['START', 0], ['COUNT', 20], ['CUSTFLAGS', 67109107], ['CUSTMASK', 67109363], ['SYSFLAGS', 0], ['SYSMASK', 786432]]);
  assert.equal(w.conn(b).l('gsea').g('COUNT'), '1');
  assert.equal(w.conn(b).l('+gam').g('NAME'), '088.Alpha');
  w.send(b, 'gjoi', [['NAME', '088.Alpha']]);
  const j = w.conn(b).l('gjoi');
  assert.deepEqual([j.g('COUNT'), j.g('OPPO1'), j.g('ADDR1')], ['2', 'Bravo', '10.77.0.3']);
  assert.equal(w.conn(a).l('+mgm').g('COUNT'), '2');
  // the game room's chat
  w.send(b, 'mesg', [['TEXT', 'hi room'], ['ATTR', 'G']]);
  assert.equal(w.conn(a).l('+msg').g('T'), 'hi room');
  assert.equal(w.conn(a).l('+msg').g('N'), 'Bravo');
  w.send(b, 'gset', [['NAME', '088.Alpha'], ['USERFLAGS', 134217728]]);
  assert.equal(w.conn(a).l('+mgm').g('OPFLAG1'), '134217728');
  w.send(a, 'gset', [['NAME', '088.Alpha'], ['USERFLAGS', 134217728]]);
  w.send(b, 'gsta', [['NAME', '088.Alpha']]);
  assert.equal(w.conn(b).l('gsta').code, 'host', 'only the creator starts');
  w.send(a, 'gsta', [['NAME', '088.Alpha']]);
  const [sa, sb] = [w.conn(a).l('+ses'), w.conn(b).l('+ses')];
  assert.equal(sa.g('SELF'), 'Alpha');
  assert.equal(sb.g('SELF'), 'Bravo');
  assert.equal(sa.g('SEED'), sb.g('SEED'));
  assert.equal(sa.g('AUTH'), sb.g('AUTH'));
  assert.ok(sa.g('AUTH') !== '');
  assert.deepEqual([sb.g('ADDR0'), sb.g('LADDR0'), sb.g('ADDR1')], ['10.77.0.2', '10.77.0.2', '10.77.0.3']);
  assert.equal((Number(sb.g('SYSFLAGS')) & (1 << 19)) >>> 0, 1 << 19, 'started');
  // the game closes its lobby links at the start: the race (the game record) goes on
  w.close(a);
  w.close(b);
  assert.equal(w.core.lobby.games.size, 1);
  assert.equal(w.core.lobby.byPersona.size, 0);
  // after the race the players log in again, with the same names
  const ga2 = w.client('10.77.0.2');
  const a2 = w.login(ga2, 'Alpha');
  assert.equal(w.conn(a2).l('pers').code, '');
  w.send(a2, 'gsea', [['START', 0], ['COUNT', 20], ['CUSTFLAGS', 0], ['CUSTMASK', 0], ['SYSFLAGS', 0], ['SYSMASK', 0]]);
  assert.equal(w.conn(a2).l('gsea').g('COUNT'), '0', 'a started race is not listed');
  w.advance(31 * 60000);
  assert.equal(w.core.lobby.games.size, 0, 'forgotten after raceMs');
});

// game passwords: listed with the password bit, asked for on every join (by name or id), in no reply, log or record
test('game_passwords', () => {
  const PASSWORD = 1 << 16;
  const w = world();
  const [a, b, c] = players(w, ['Alpha', 'Bravo', 'Charlie']);
  const sys = (m) => Number(m.g('SYSFLAGS')) >>> 0;
  const pw = 'Room Secret:%=42';
  // the game's gcre: the password, SYSFLAGS without the bit (SPEED2.EXE 0x58d580)
  w.send(a, 'gcre', [['NAME', 'Locked'], ['SYSFLAGS', 0], ['PASS', pw], ['PARAMS', 'TRACK=4011']]);
  assert.equal(sys(w.conn(a).l('gcre')) & PASSWORD, PASSWORD);
  const id = Number(w.conn(a).l('gcre').g('IDENT'));
  w.send(b, 'gsea', [['START', 0], ['COUNT', 20]]);
  assert.equal(sys(w.conn(b).l('+gam')) & PASSWORD, PASSWORD, 'listed as a game with a password');
  // a join refused leaves the player in its own game
  w.send(b, 'gcre', [['NAME', 'Other'], ['PARAMS', 'TRACK=4011']]);
  const other = Number(w.conn(b).l('gcre').g('IDENT'));
  const inGame = (name) => {
    const s = [...w.core.lobby.sessions].find((s) => w.core.lobby.s(s).persona === name);
    return w.core.lobby.s(s).game;
  };
  for (const f of [
    [['NAME', 'Locked']],
    [['IDENT', id], ['PASS', '']],
    [['NAME', 'Locked'], ['PASS', 'wrong']],
    [['IDENT', id], ['PASS', pw.toLowerCase()]],
  ]) {
    w.advance(1000);
    w.send(b, 'gjoi', f);
    assert.equal(w.conn(b).l('gjoi').code, 'pass');
    assert.equal(w.core.lobby.games.get(id).players.length, 1);
    assert.equal(inGame('Bravo'), other);
  }
  // a gset clears no password, the creator's or a player's
  w.send(a, 'gset', [['SYSFLAGS', 0], ['PASS', '']]);
  w.advance(1000);
  w.send(b, 'gjoi', [['IDENT', id], ['PASS', pw]]);
  assert.equal(w.conn(b).l('gjoi').code, '');
  assert.equal(w.conn(b).l('gjoi').g('COUNT'), '2');
  assert.ok(!w.core.lobby.games.has(other), "Bravo's own game ended as Bravo left it");
  w.send(b, 'gset', [['SYSFLAGS', 0], ['PASS', '']]);
  w.send(c, 'gjoi', [['NAME', 'Locked']]);
  assert.equal(w.conn(c).l('gjoi').code, 'pass');
  w.send(c, 'gjoi', [['NAME', 'Locked'], ['PASS', pw]]);
  assert.equal(w.conn(c).l('gjoi').code, '');
  // a join into the game one is in changes nothing (the creator's does not end it)
  w.send(a, 'gjoi', [['NAME', 'Locked'], ['PASS', pw]]);
  assert.equal(w.conn(a).l('gjoi').g('COUNT'), '3');
  w.advance(1000);
  w.send(b, 'gjoi', [['IDENT', id], ['PASS', pw]]);
  const g = w.core.lobby.games.get(id);
  assert.deepEqual(g.players.map((p) => p.name), ['Alpha', 'Bravo', 'Charlie']);
  assert.equal(g.sysFlags & PASSWORD, PASSWORD);
  // the password: in no record, log line or message
  assert.ok(!dump(g).includes(pw));
  assert.ok(!w.text().join('\n').includes(pw));
  for (const x of [a, b, c]) {
    for (const m of w.conn(x).msgs) assert.ok(!m.f.has('PASS') && !m.f.has('PASSWORD'), m.kind + ' has a password field');
    // (as sent or escaped: "Room Secret%3a%25%3d42")
    assert.ok(!Buffer.from(w.conn(x).raw).includes('Room Secret'));
  }
});

// game passwords: an empty one is none, and the bit alone (from a creator, not the game) makes no password game
test('game_passwords_open', () => {
  const PASSWORD = 1 << 16;
  const w = world();
  const [ga, gb] = [w.client('10.77.0.2'), w.client('10.77.0.3')];
  const a = w.login(ga, 'Alpha');
  const b = w.login(gb, 'Bravo');
  for (const [name, f] of [['Empty', [['PASS', '']]], ['Bit', [['SYSFLAGS', PASSWORD]]]]) {
    w.send(a, 'gcre', [['NAME', name], ['PARAMS', 'TRACK=4011'], ...f]);
    assert.equal(Number(w.conn(a).l('gcre').g('SYSFLAGS')) & PASSWORD, 0, name);
    w.advance(1000);
    w.send(b, 'gjoi', [['NAME', name]]);
    assert.equal(w.conn(b).l('gjoi').code, '', name);
    w.send(b, 'glea', []);
    w.send(a, 'gdel', []);
    w.advance(1000);
  }
});

// the game list: every open game but a private one, the Filter's games first; once the player set the Filter
// (code "filt"), only those, unless it asks for its defaults
test('the_game_list', () => {
  const w = world();
  const [a, b, c, d, e] = players(w, ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
  // the game's default search: race type 0, Collision Detection and Race Breaker on, no car restriction, unranked,
  // not private (CUSTMASK bit 8)
  const search = () => [['START', 0], ['COUNT', 20], ['CUSTFLAGS', 0x40000f3], ['CUSTMASK', 0x40001f3], ['SYSFLAGS', 0], ['SYSMASK', 0xc0000]];
  w.send(e, 'gsea', search());
  w.send(a, 'gcre', [['NAME', 'no collision'], ['CUSTFLAGS', 0x40000f2], ['PARAMS', 'TRACK=4011']]);
  w.send(b, 'gcre', [['NAME', 'private'], ['CUSTFLAGS', 0x40001f3], ['PARAMS', 'TRACK=4011']]);
  w.send(c, 'gcre', [['NAME', 'as asked'], ['CUSTFLAGS', 0x40000f3], ['PARAMS', 'TRACK=4011']]);
  w.send(d, 'gcre', [['NAME', 'ranked sprint'], ['CUSTFLAGS', 0x80000f3], ['SYSFLAGS', 1 << 18], ['PARAMS', 'TRACK=4011']]);
  w.advance(1000);
  const names = (kind) => w.conn(e).take().filter((m) => m.kind === kind).map((m) => m.g('NAME'));
  const agm = names('+agm').sort();
  assert.deepEqual(agm, ['as asked', 'no collision', 'ranked sprint'], 'a private game is not announced');
  w.send(e, 'gsea', search());
  assert.equal(w.conn(e).l('gsea').g('COUNT'), '3');
  assert.deepEqual(names('+gam'), ['as asked', 'no collision', 'ranked sprint']);
  const s = [['START', 1], ['COUNT', 1], ...search().slice(2)];
  w.send(e, 'gsea', s);
  assert.deepEqual(names('+gam'), ['no collision']);
  // ranked sprints: unset (the settings of a game made or joined) the others come after; set, only those; set to
  // the defaults, all of them again
  const sprint = () => [['START', 0], ['COUNT', 20], ['CUSTFLAGS', 0x80000f3], ['CUSTMASK', 0x80001f3], ['SYSFLAGS', 1 << 18], ['SYSMASK', 0xc0000]];
  w.send(e, 'gsea', sprint());
  assert.deepEqual(names('+gam'), ['ranked sprint', 'no collision', 'as asked']);
  w.sendRaw(e, encodeFrame('gsea', 'filt', sprint()));
  assert.equal(w.conn(e).l('gsea').g('COUNT'), '1');
  assert.deepEqual(names('+gam'), ['ranked sprint']);
  w.sendRaw(e, encodeFrame('gsea', 'filt', search()));
  assert.deepEqual(names('+gam'), ['as asked', 'no collision', 'ranked sprint']);
  // a private game's players come by invitation: by its name
  w.send(e, 'gjoi', [['NAME', 'private']]);
  assert.equal(w.conn(e).l('gjoi').code, '');
});

// the game list in one search: the config sets the game's page (GAMES_PER_UPDATE), its search asks for that many, and
// gets every open game, oldest first; past the page, the next one
test('the_game_list_in_one_search', () => {
  const w = world();
  const hosts = [];
  for (let i = 0; i < 210; i++) {
    const g = w.client('10.77.' + (1 + Math.floor(i / 200)) + '.' + (2 + (i % 200)));
    hosts.push(w.login(g, 'Host' + i));
  }
  const g = w.client('10.77.0.2');
  const e = w.login(g, 'Looker');
  assert.equal(w.conn(e).l('news').g('GAMES_PER_UPDATE'), '200');
  hosts.forEach((h, i) => w.send(h, 'gcre', [['NAME', i + '00.Host' + i], ['CUSTFLAGS', 0x40000f3], ['PARAMS', 'TRACK=4011']]));
  const names = () => w.conn(e).take().filter((m) => m.kind === '+gam').map((m) => m.g('NAME'));
  const search = (s, n) => [['START', s], ['COUNT', n], ['CUSTFLAGS', 0x40000f3], ['CUSTMASK', 0x40001f3], ['SYSFLAGS', 0], ['SYSMASK', 0xc0000]];
  const made = (from, to) => Array.from({ length: to - from }, (_, k) => from + k + '00.Host' + (from + k));
  w.conn(e).take();
  w.send(e, 'gsea', search(0, 200));
  assert.equal(w.conn(e).l('gsea').g('COUNT'), '200');
  assert.deepEqual(names(), made(0, 200), 'a page of 200, oldest first');
  w.send(e, 'gsea', search(200, 200));
  assert.deepEqual(names(), made(200, 210));
  w.send(e, 'gsea', search(0, 1000));
  assert.equal(w.conn(e).l('gsea').g('COUNT'), '200', 'never more than a page');
});

// six players: a game asked for 8 takes 6, the seventh finds it full; +ses names all six
test('six_players', () => {
  const w = world();
  const cs = players(w, ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf']);
  w.send(cs[0], 'gcre', [['NAME', 'six'], ['MAXSIZE', 8], ['PARAMS', 'TRACK=4123']]);
  assert.equal(w.conn(cs[0]).l('gcre').g('MAXSIZE'), '6');
  for (const c of cs.slice(1, 6)) {
    w.send(c, 'gjoi', [['NAME', 'six']]);
    assert.equal(w.conn(c).l('gjoi').code, '');
  }
  w.send(cs[6], 'gjoi', [['NAME', 'six']]);
  assert.equal(w.conn(cs[6]).l('gjoi').code, 'full');
  w.send(cs[0], 'gsta', [['NAME', 'six']]);
  const s = w.conn(cs[5]).l('+ses');
  assert.deepEqual([s.g('COUNT'), s.g('OPPO5'), s.g('ADDR5')], ['6', 'Foxtrot', '10.77.0.7']);
});

// Start Race before every player is ready: the room counts down, the players still not ready are kicked, the race
// starts
test('start_race_countdown_kick', () => {
  const READY = 1 << 27;
  const COUNTDOWN = 1 << 12;
  const RANKED = 1 << 18;
  const ACTIVE = 1 << 19;
  const w = world();
  const [a, b, c, d] = players(w, ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  w.send(a, 'gcre', [['NAME', 'g'], ['MAXSIZE', 4], ['MINSIZE', 2], ['PARAMS', 'TRACK=4011']]);
  for (const x of [b, c, d]) w.send(x, 'gjoi', [['NAME', 'g']]);
  w.send(b, 'gset', [['NAME', 'g'], ['USERFLAGS', READY]]);
  const sys = (m) => Number(m.g('SYSFLAGS')) >>> 0;
  // the creator's Start Race (SPEED2.EXE 0x58aa20): the game's SYSFLAGS with the countdown, the creator ready; only
  // the countdown bit is the creator's to set
  const cur = sys(w.conn(a).l('+mgm'));
  w.send(a, 'gset', [['NAME', 'g'], ['SYSFLAGS', (cur | COUNTDOWN | RANKED | ACTIVE) >>> 0], ['USERFLAGS', READY]]);
  assert.equal(sys(w.conn(a).l('gset')), COUNTDOWN);
  for (const x of [b, c, d]) assert.equal(sys(w.conn(x).l('+mgm')), COUNTDOWN, 'every game in the room counts down');
  assert.equal(w.conn(a).l('+mgm').g('OPFLAG0'), String(READY));
  w.send(c, 'gset', [['NAME', 'g'], ['SYSFLAGS', 0]]);
  assert.equal(sys(w.conn(c).l('gset')), COUNTDOWN, 'a joiner does not stop it');
  // a start that fails clears it (0x58ab40), and Start Race sets it again
  w.send(a, 'gset', [['NAME', 'g'], ['SYSFLAGS', 0], ['USERFLAGS', 0]]);
  assert.equal(sys(w.conn(b).l('+mgm')), 0);
  w.send(a, 'gset', [['NAME', 'g'], ['SYSFLAGS', COUNTDOWN], ['USERFLAGS', READY]]);
  // the countdown's end (0x58a7e0): the players not ready in one KICK list, then the start
  w.send(a, 'gset', [['NAME', 'g'], ['KICK', 'Charlie,Delta']]);
  for (const [x, n] of [[c, 'Charlie'], [d, 'Delta']]) {
    // the game leaves the room on the game's record after its own without the game (SPEED2.EXE 0x58dab0)
    const msgs = w.conn(x).all();
    const [who, mgm] = [msgs[msgs.length - 2], msgs[msgs.length - 1]];
    assert.deepEqual([who.kind, who.g('G')], ['+who', '0'], n + ' is out of the game');
    assert.equal(mgm.kind, '+mgm');
    const named = [...mgm.f.m].filter(([k]) => k.startsWith('OPPO')).map(([, v]) => v).filter((v) => v !== null);
    assert.ok(named.includes('Bravo') && !named.includes(n), n + "'s game record without " + n + ': ' + named);
  }
  assert.equal(w.conn(b).l('+mgm').g('COUNT'), '2');
  w.send(a, 'gsta', [['NAME', 'g']]);
  assert.equal(w.conn(a).l('gsta').code, '');
  const s = w.conn(b).l('+ses');
  assert.equal(s.g('COUNT'), '2');
  assert.deepEqual([s.g('OPPO0'), s.g('OPPO1')], ['Alpha', 'Bravo']);
  assert.ok(w.conn(c).last('+ses') === null && w.conn(d).last('+ses') === null);
});

// leaving: a joiner leaves, the creator leaves, the creator deletes; a browser that goes
test('leaving', () => {
  const w = world();
  const [ga, gb] = [w.client('10.77.0.2'), w.client('10.77.0.3')];
  const a = w.login(ga, 'Alpha');
  const b = w.login(gb, 'Bravo');
  w.send(a, 'gcre', [['NAME', 'g1'], ['MAXSIZE', 2], ['PARAMS', 'TRACK=1']]);
  w.send(b, 'gjoi', [['NAME', 'g1']]);
  const gc = w.client('10.77.0.4');
  const c = w.login(gc, 'Charlie');
  w.send(c, 'gjoi', [['NAME', 'g1']]);
  assert.equal(w.conn(c).l('gjoi').code, 'full');
  w.send(b, 'glea', []);
  assert.equal(w.conn(a).l('+mgm').g('COUNT'), '1');
  w.send(b, 'gjoi', [['NAME', 'g1']]);
  w.send(a, 'gdel', []);
  assert.equal(w.conn(b).l('+mgm').g('IDENT'), '1');
  assert.equal(w.conn(b).l('+mgm').get('COUNT'), null, 'IDENT only: deleted');
  assert.equal(w.core.lobby.games.size, 0);
  w.send(a, 'gcre', [['NAME', 'g2'], ['PARAMS', 'TRACK=1']]);
  w.send(b, 'gjoi', [['NAME', 'g2']]);
  // the creator's browser leaves the switch
  w.peerGone(ip('10.77.0.2'));
  assert.equal(w.core.lobby.games.size, 0);
  assert.equal(w.conn(b).l('+mgm').get('COUNT'), null);
  assert.equal(w.core.lobby.sessions.size, 2);
});

// limits: message flood, sessions per browser, frame size, silence
test('limits', () => {
  const w = world({ limits: { perVip: 2 } });
  const g = w.client('10.77.0.2');
  const a = w.login(g, 'Alpha');
  for (let i = 0; i < 60; i++) w.send(a, '~png', [['TIME', 1]]);
  assert.ok(w.conn(a).reset, 'more than 40 messages at once: dropped');
  w.login(g, 'Beta');
  w.login(g, 'Gamma');
  const d = w.login(g, 'Delta');
  assert.ok(w.conn(d).reset, 'a third session from one browser: refused');
  const w2 = world();
  const h = w2.client('10.77.0.5');
  const big = w2.connect(h, PORT_LOBBY);
  w2.send(big, 'mesg', [['TEXT', 'x'.repeat(9000)]]);
  assert.ok(w2.conn(big).reset, 'a message over 8 KB: dropped');
  const odd = w2.login(h, 'Oddball');
  const cid = w2.conn(odd).cid;
  const data = Uint8Array.from([0x61, 0x01, 0x62, 0x63, 0, 0, 0, 0, 0, 0, 0, 13, 0]);
  w2.raw(h, lanFrame(4, h, VHOST_VIP, odd[1], PORT_LOBBY, DATA, cid, data));
  assert.ok(w2.conn(odd).reset, 'a kind that is not four letters: dropped');
  const quiet = w2.login(h, 'Quiet');
  w2.advance(60000);
  w2.advance(61000);
  assert.ok(w2.conn(quiet).reset, 'silent for 120 s: dropped');
  assert.ok(w2.conn(quiet).msgs.some((m) => m.kind === '~png'), 'pinged first');
});

/** a real race report (SPEED2.EXE, a 2-lap circuit here: index 1 first in 186.82 s, index 0 second in 187.67 s) */
const RESU =
  'AwIAAQ+uAAIBAQEVQAADJ0M60exCuGZnQflKqkIogLdAsZmaQU2tD0I5HwoAAAAAAAAAAAAAAAAAAAAAAAAAAAIBFUAAAOhDO6uGQreo9kH44idCKNlYQL3CkEFciThCPgV4AAAAAAAAAAAAAAAAAAAAAAAAAA==';

function report(w, c, auth) {
  w.send(c, 'rank', [
    ['AUTH', auth], ['REPT', 'x'], ['RESU', RESU], ['VENUE', 'NFSUG2'],
    ['NAME0', 'Alpha'], ['TEAM0', 'NFSUG2'], ['NAME1', 'Bravo'], ['TEAM1', 'NFSUG2'],
  ]);
}

const statOf = (m) => m.g('STAT').split(',').slice(0, 38).map((x) => {
  assert.ok(/^[0-9a-fA-F]+$/.test(x), 'a hex number: ' + x);
  return parseInt(x, 16);
});

const race = (kind, names) => ({
  kind, ranked: true, track: 4011, players: names.map((name, i) => ({ name, place: i + 1, time: 60.0, left: false })),
});

// results: the race report counts once, is checked, and shows in the career and the rankings
test('results', () => {
  const w = world();
  const [ga, gb] = [w.client('10.77.0.2'), w.client('10.77.0.3')];
  const a = w.login(ga, 'Alpha');
  const b = w.login(gb, 'Bravo');
  w.send(a, 'gcre', [['NAME', 'r1'], ['PARAMS', 'TRACK=4014']]);
  w.send(b, 'gjoi', [['NAME', 'r1']]);
  w.send(a, 'gsta', [['NAME', 'r1']]);
  const auth = w.conn(a).l('+ses').g('AUTH');
  w.close(a);
  w.close(b);
  // too early: 186 s of racing cannot have happened 10 s after the start
  w.advance(10000);
  const gb2 = w.client('10.77.0.3');
  const b2 = w.login(gb2, 'Bravo');
  report(w, b2, auth);
  assert.equal(w.conn(b2).l('rank').g('RANK'), 'Unranked');
  assert.ok(w.logged('not taken: a race of 10.0 s (a circuit race takes 20 s at least)'), w.text().join('\n'));
  // 30 s after the start: a race that long, but not 186 s of it
  w.advance(20000);
  report(w, b2, auth);
  assert.ok(w.logged('not taken: a time the race has not had'));
  assert.equal(w.core.stats.board(0, 'all').length, 0);
  assert.equal(w.core.stats.rec('Bravo', false), null, 'no records from a report not taken');
  // after the race: Bravo's report alone decides nothing (a report not taken was not his one report); Alpha's,
  // from another browser with the same places, makes the result
  w.advance(200000);
  const gb3 = w.client('10.77.0.3');
  const b3 = w.login(gb3, 'Bravo');
  report(w, b3, auth);
  assert.ok(!w.logged('"r1" (circuit'), 'one report alone');
  assert.equal(w.core.stats.board(0, 'all').length, 0);
  const ga2 = w.client('10.77.0.2');
  const a2 = w.login(ga2, 'Alpha');
  report(w, a2, auth);
  assert.ok(w.logged('"r1" (circuit, unranked): 1 Bravo 3:06.82, 2 Alpha 3:07.67'), w.text().join('\n'));
  report(w, a2, auth);
  assert.equal(sum(w.core.stats.board(0, 'all').map((r) => r.races)), 2, 'counted once');
  assert.equal(w.core.lobby.games.size, 0, 'both players reported: the race is over');
  // a report for no race of this server's
  w.send(a2, 'rank', [['AUTH', 'f00'], ['RESU', RESU], ['NAME0', 'Alpha'], ['NAME1', 'Bravo']]);
  assert.ok(w.text().at(-1).includes('no race of this server'));
  // the career: unranked win for Bravo (circuit block: values 9..13 = rating, ranked W/L, unranked W/L)
  w.send(a2, 'user', [['PERS', 'Bravo']]);
  const stat = statOf(w.conn(a2).l('user'));
  assert.equal(stat.length, 38);
  assert.deepEqual(stat.slice(8, 13), [0, 0, 0, 1, 0]);
  // the reporter got its career again right after its report (the game asked at the login, before it)
  assert.ok(w.conn(a2).all().some((m) => m.kind === 'user' && m.get('PERS') === 'Alpha'));
  w.send(a2, 'user', [['PERS', 'Alpha']]);
  assert.deepEqual(statOf(w.conn(a2).l('user')).slice(8, 13), [0, 0, 0, 0, 1]);
  // the records (Top Speed Achieved in mm/s): each player's from its own entry in its own report (both sent the
  // same one: Bravo is index 1, 42.126 m/s; Alpha index 0, 42.212 m/s)
  assert.deepEqual(statOf(w.conn(a2).l('user')).slice(3, 8), [42212, 0, 0, 0, 0]);
  w.send(a2, 'user', [['PERS', 'Bravo']]);
  assert.deepEqual(statOf(w.conn(a2).l('user')).slice(3, 8), [42126, 0, 0, 0, 0]);
  // the rankings: the circuit board, and one's own row
  w.send(a2, 'snap', [['INDEX', 4], ['CHAN', 6], ['START', 0], ['RANGE', 100]]);
  assert.equal(w.conn(a2).l('snap').g('COUNT'), '2');
  const rows = w.conn(a2).all().filter((m) => m.kind === '+snp').map((m) => [m.g('N'), m.g('R'), m.g('S')]);
  assert.deepEqual(rows, [['Bravo', '1', '0,1,0'], ['Alpha', '2', '0,0,1']]);
  w.send(a2, 'snap', [['INDEX', 4], ['CHAN', 12], ['RANGE', 1], ['FIND', '$']]);
  assert.equal(w.conn(a2).l('snap').g('COUNT'), '1');
  assert.equal(w.conn(a2).l('+snp').g('N'), 'Alpha');
  w.send(a2, 'snap', [['INDEX', 4], ['CHAN', 7], ['START', 0], ['RANGE', 100]]);
  assert.equal(w.conn(a2).l('snap').g('COUNT'), '0', 'no sprint races yet');
  // points in P are decimal, in S hex: 28 ranked wins, 2800 points (hex af0: the game read P "af0" as 0)
  for (let i = 0; i < 28; i++) w.core.stats.addRace({ ...race(4, ['Alpha', 'Bravo']) });
  w.send(a2, 'snap', [['INDEX', 4], ['CHAN', 16], ['RANGE', 1], ['FIND', '$']]);
  const row = w.conn(a2).l('+snp');
  assert.deepEqual([row.g('N'), row.g('R'), row.g('P'), row.g('S')], ['Alpha', '1', '2800', 'af0,1c,0']);
});

// the rankings: the screens' channels go in their own order, Drift before Drag (SPEED2.EXE 0x58ce30, 0x5826e0): the
// overall boards 6..11, one's own row 12..17, the month's leaders 18..23, last month's 24..29 (the month before's, as
// it ended, from November 2026 on: stats.rs FIRST_WHOLE_MONTH)
test('rankings_channels', () => {
  const w = world({ t0: 1792411200000 }); // Date.UTC(2026, 9, 19, 12)
  const g = w.client('10.77.0.2');
  const a = w.login(g, 'Alpha');
  const add = (kind, names) => w.core.stats.addRace(race(kind, names));
  add(3, ['Alpha', 'Drifter']);
  add(2, ['Dragger', 'Other']);
  const rows = (chan, own) => {
    const from = w.conn(a).msgs.length;
    const f = [['INDEX', 21], ['CHAN', chan], ['START', 0], ['RANGE', own ? 1 : 100]];
    if (own) f.push(['FIND', '$']);
    w.send(a, 'snap', f);
    return w.conn(a).all().slice(from).filter((m) => m.kind === '+snp').map((m) => m.g('N') + ' ' + m.g('P'));
  };
  assert.deepEqual(rows(8, false), ['Alpha 100', 'Drifter 0'], 'Drift: the drift board');
  assert.deepEqual(rows(9, false), ['Dragger 100', 'Other 0'], 'Drag: the drag board');
  assert.deepEqual(rows(14, true), ['Alpha 100'], "one's own Drift row");
  assert.deepEqual(rows(15, true), [], 'no drag race of one\'s own');
  assert.deepEqual(rows(20, false), ['Alpha 100', 'Drifter 0'], "the month's drift leaders");
  assert.deepEqual(rows(26, false), [], "last month's leaders: no month before yet");
  assert.equal(w.conn(a).l('snap').g('TOTAL'), '0');
  assert.deepEqual(rows(30, false), [], 'past the last channel: nothing');
  const nextMonth = () => {
    const m0 = monthOf(w.t);
    while (monthOf(w.t) === m0) w.t += 86400000;
  };
  // November 2026: October shows nowhere (the server before kept no month whole)
  nextMonth();
  assert.deepEqual(rows(20, false), [], "this month's drift leaders: none yet");
  assert.deepEqual(rows(26, false), [], "October 2026's leaders: not shown");
  add(3, ['Alpha', 'Drifter']);
  add(2, ['Dragger', 'Other']);
  // the next month (the Monthly Point Leaders' Last Month's Leaderboard): the month that ended is last month's
  nextMonth();
  assert.deepEqual(rows(20, false), [], "this month's drift leaders: none yet");
  assert.deepEqual(rows(26, false), ['Alpha 100', 'Drifter 0'], "last month's drift leaders");
  assert.deepEqual(rows(27, false), ['Dragger 100', 'Other 0'], "last month's drag leaders");
  assert.deepEqual(rows(8, false), ['Alpha 200', 'Drifter 0'], 'the overall board stays');
});

// names: a name another browser holds comes with four digits (the same for one client); its own browser takes it
// back
test('names_digits', () => {
  const w = world();
  let g = w.client('10.77.0.2');
  const a = w.login(g, 'NAME');
  assert.equal(w.conn(a).l('pers').g('PERS'), 'NAME');
  g = w.client('10.77.0.3');
  const b = w.login(g, 'NAME');
  const bn = w.conn(b).l('pers').g('PERS');
  assert.equal(w.conn(b).l('pers').code, '');
  assert.ok(digits4(bn, 'NAME'));
  assert.equal(w.conn(b).l('+who').g('N'), bn, 'the lobby knows the player by it');
  assert.ok(w.logged('plays as "' + bn + '" ("NAME" is taken)'), w.text().join('\n'));
  g = w.client('10.77.0.4');
  const c = w.login(g, 'NAME');
  const cn = w.conn(c).l('pers').g('PERS');
  assert.ok(digits4(cn, 'NAME'));
  assert.notEqual(cn, bn);
  const keys = [...w.core.lobby.byPersona.keys()].sort();
  const want = ['name', bn.toLowerCase(), cn.toLowerCase()].sort();
  assert.deepEqual(keys, want);
  // the digits take the end of a long name: still a persona name (15 characters at most)
  g = w.client('10.77.0.5');
  w.login(g, 'ABCDEFGHIJKLMNO');
  g = w.client('10.77.0.6');
  const l = w.login(g, 'ABCDEFGHIJKLMNO');
  assert.ok(digits4(w.conn(l).l('pers').g('PERS'), 'ABCDEFGHIJK'));
  // the same client logging in again: the same digits (the game asks for them now: the runtime took them)
  w.close(b);
  g = w.client('10.77.0.3');
  let x = w.login(g, 'NAME');
  assert.equal(w.conn(x).l('pers').g('PERS'), bn);
  // (the old b again: a FIN for a stream the host no longer has does nothing)
  w.close(b);
  g = w.client('10.77.0.3');
  x = w.login(g, bn);
  assert.equal(w.conn(x).l('pers').g('PERS'), bn);
  // ... and asking for the name while its older session still plays under the digits (its game's new lobby link):
  // the same digits, from that session
  g = w.client('10.77.0.3');
  x = w.login(g, 'NAME');
  assert.equal(w.conn(x).l('pers').g('PERS'), bn);
  assert.equal(w.personas().filter((p) => p === bn).length, 1, 'the old session went');
  assert.equal(w.core.lobby.byPersona.size, 5, 'NAME and two with digits, the long name and one with digits');
  // the holder's own browser logging in again (its game's new lobby link): the name, from its old session
  g = w.client('10.77.0.2');
  const a2 = w.login(g, 'NAME');
  assert.equal(w.conn(a2).l('pers').g('PERS'), 'NAME');
  assert.equal(w.personas().filter((p) => p === 'NAME').length, 1, 'the old session went');
  // a shortened name that reads as a slur is "Player" with the digits
  g = w.client('10.77.0.7');
  w.login(g, 'AbcdefghFagxyz');
  g = w.client('10.77.0.8');
  const p = w.login(g, 'AbcdefghFagxyz');
  assert.ok(digits4(w.conn(p).l('pers').g('PERS'), 'Player'), w.conn(p).l('pers').g('PERS'));
});

// names: a racer keeps the name until back; another player under it gets digits and ends nothing
test('names_racer', () => {
  const w = world();
  const [ga, gb] = [w.client('10.77.0.2'), w.client('10.77.0.3')];
  const a = w.login(ga, 'Alpha');
  const b = w.login(gb, 'Bravo');
  w.send(a, 'gcre', [['NAME', 'r2'], ['PARAMS', 'TRACK=4014']]);
  w.send(b, 'gjoi', [['NAME', 'r2']]);
  w.send(a, 'gsta', [['NAME', 'r2']]);
  const auth = w.conn(a).l('+ses').g('AUTH');
  // the game closes its lobby link for the race
  w.close(a);
  w.close(b);
  // another browser under the racer's name: digits, and its game list does not take the racer back
  const go = w.client('10.77.0.4');
  const other = w.login(go, 'Alpha');
  assert.ok(digits4(w.conn(other).l('pers').g('PERS'), 'Alpha'));
  w.send(other, 'gsea', [['START', 0], ['COUNT', 20]]);
  w.advance(200000);
  const rep = (c) =>
    w.send(c, 'rank', [['AUTH', auth], ['REPT', 'x'], ['RESU', RESU], ['VENUE', 'NFSUG2'], ['NAME0', 'Alpha'], ['NAME1', 'Bravo']]);
  const gb2 = w.client('10.77.0.3');
  const b2 = w.login(gb2, 'Bravo');
  w.send(b2, 'gsea', [['START', 0], ['COUNT', 20]]);
  rep(b2);
  assert.equal(w.core.lobby.games.size, 1, 'Alpha is still racing');
  // the racer, back from its own browser: its name, and its report makes the result
  const ga2 = w.client('10.77.0.2');
  const a2 = w.login(ga2, 'Alpha');
  assert.equal(w.conn(a2).l('pers').g('PERS'), 'Alpha');
  rep(a2);
  assert.ok(w.logged('"r2" (circuit, unranked): 1 Bravo 3:06.82, 2 Alpha 3:07.67'), w.text().join('\n'));
  assert.equal(w.core.lobby.games.size, 0);
});

// web pages: the news and terms pages as web-offer scripts, nothing else
test('web_pages', () => {
  const w = world();
  const g = w.client('10.77.0.2');
  const get = (req) => {
    const c = w.connect(g, PORT_HTTP);
    w.sendRaw(c, latin1Bytes(req));
    return [latin1Decode(w.conn(c).raw), w.conn(c).fin];
  };
  const [n, fin] = get('GET /news HTTP/1.0\r\nUser-Agent: Custom/1.0\r\n\r\n');
  assert.ok(n.startsWith('HTTP/1.0 200 OK\r\n'));
  assert.ok(n.includes('\r\n\r\n%{ CMD=news TITLE="NFSU2 Online" BTN1="OK" BTN1-GOTO="$quit" %}\r\n'));
  assert.ok(fin);
  assert.ok(get('GET /tos HTTP/1.0\r\n\r\n')[0].includes('Terms of Service'));
  assert.ok(get('GET /card HTTP/1.0\r\n\r\n')[0].startsWith('HTTP/1.0 404'));
  assert.ok(get('POST /news HTTP/1.0\r\n\r\n')[0].startsWith('HTTP/1.0 400'));
  for (const p of ['/news', '/tos']) {
    const t = get('GET ' + p + ' HTTP/1.0\r\n\r\n')[0];
    assert.ok(!t.includes('CMD=card') && !t.includes('CMD=prom'));
  }
});

// EA Messenger: the login by LKEY, friends, presence, messages, blocking, leaving
test('ea_messenger', () => {
  const w = world();
  const [ga, gb] = [w.client('10.77.0.2'), w.client('10.77.0.3')];
  const la = w.login(ga, 'Alpha');
  const lb = w.login(gb, 'Bravo');
  const [ka, kb] = [w.lkey(la), w.lkey(lb)];
  const a = w.buddy(ga, ka);
  const b = w.buddy(gb, kb);
  assert.equal(w.conn(a).l('AUTH').code, '');
  assert.equal(w.conn(a).l('AUTH').g('TITL'), 'EA MESSENGER');
  w.send(a, 'EPGT', [['LRSC', 'PC'], ['ID', 4]]);
  assert.equal(w.conn(a).l('EPGT').g('ENAB'), 'N');
  w.send(a, 'RGET', [['LRSC', 'PC'], ['LIST', 'B'], ['PRES', 'Y'], ['PEND', 'Y'], ['ID', 1]]);
  assert.deepEqual([w.conn(a).l('RGET').g('ID'), w.conn(a).l('RGET').g('SIZE')], ['1', '0']);
  // the Search finds Bravo, not Alpha itself
  w.send(a, 'USCH', [['USER', 'bra'], ['MAXR', 10], ['ID', 3]]);
  assert.equal(w.conn(a).l('USCH').g('SIZE'), '1');
  assert.equal(w.conn(a).l('USER').g('USER'), 'Bravo');
  w.send(a, 'USCH', [['USER', 'alp'], ['ID', 3]]);
  assert.equal(w.conn(a).l('USCH').g('SIZE'), '0');
  // Alpha adds Bravo (RADD LIST=B, which the game never sends: a friend request, as RADM, since the 2026-11-05
  // security audit): Bravo hears of the request, Alpha sees Bravo's presence; no friend before Bravo's answer
  w.send(b, 'PSET', [['SHOW', 'CHAT'], ['STAT', 'EX=0\nP=nfs5\n'], ['PROD', 'is playing Underground 2']]);
  w.send(a, 'RADD', [['LRSC', 'PC'], ['USER', 'Bravo'], ['LIST', 'B'], ['ID', 5]]);
  assert.equal(w.conn(a).l('RADD').code, '');
  assert.equal(w.conn(a).l('PGET').g('USER'), 'Bravo');
  assert.equal(w.conn(a).l('PGET').g('SHOW'), 'CHAT');
  assert.deepEqual([w.conn(b).l('RNOT').g('USER'), w.conn(b).l('RNOT').g('ATTR')], ['Alpha', 'R']);
  w.send(a, 'RGET', [['LIST', 'B'], ['ID', 2]]);
  assert.equal(w.conn(a).l('RGET').g('SIZE'), '0');
  // declined: the request goes, Alpha told
  w.send(b, 'RRSP', [['LRSC', 'PC'], ['USER', 'Alpha'], ['ANSW', 'N'], ['ID', 6]]);
  assert.deepEqual([w.conn(a).l('RNOT').g('USER'), w.conn(a).l('RNOT').g('CHNG')], ['Bravo', 'D']);
  const lb2 = w.core.buddies.list('Bravo');
  assert.ok(!(lb2 !== null && lb2.q.has('alpha')));
  // a message, and a game invite passed on with the sender named by the server
  w.send(a, 'SEND', [['USER', 'Bravo'], ['BODY', 'race?\u0007'], ['SUBJ', ''], ['TYPE', 'C']]);
  assert.equal(w.conn(b).l('RECV').g('USER'), 'Alpha');
  assert.equal(w.conn(b).l('RECV').g('BODY'), 'race?');
  w.send(a, 'GINV', [['USER', 'Bravo'], ['HOST', 'Alpha'], ['TYPE', 'G'], ['LKEY', 'x']]);
  assert.equal(w.conn(b).l('GINV').g('USER'), 'Alpha');
  assert.equal(w.conn(b).l('GINV').g('HOST'), 'Alpha');
  assert.equal(w.conn(b).l('GINV').get('LKEY'), null);
  // a friend request from Bravo (to Alpha: one that waits for Alpha's answer), accepted by Alpha: both lists
  w.send(b, 'RADM', [['LRSC', 'PC'], ['USER', 'Alpha'], ['ID', 102], ['PRES', 'Y']]);
  assert.equal(w.conn(a).l('RNOT').g('USER'), 'Bravo');
  assert.equal(w.conn(a).l('RNOT').g('ATTR'), 'R');
  w.send(a, 'RRSP', [['LRSC', 'PC'], ['USER', 'Bravo'], ['ANSW', 'Y'], ['ID', 7]]);
  assert.equal(w.conn(b).l('RNOT').g('USER'), 'Alpha');
  assert.equal(w.conn(b).l('RNOT').g('CHNG'), 'A');
  assert.ok(w.core.buddies.list('Bravo').b.has('alpha'));
  // (the lists asked: 4 at once, then one a second)
  w.advance(1000);
  w.send(a, 'RGET', [['LIST', 'B'], ['ID', 2]]);
  assert.equal(w.conn(a).l('RGET').g('SIZE'), '1');
  assert.equal(w.conn(a).l('ROST').g('USER'), 'Bravo');
  // presence changes reach the friend (at most once a second)
  w.send(b, 'PSET', [['SHOW', 'AWAY'], ['STAT', ''], ['PROD', 'racing']]);
  assert.equal(w.conn(a).l('PGET').g('SHOW'), 'AWAY');
  const friendsLines = () => w.text().filter((l) => l.includes('are friends')).length;
  assert.equal(friendsLines(), 1);
  w.send(a, 'RRSP', [['USER', 'Bravo'], ['ANSW', 'Y']]);
  assert.equal(friendsLines(), 1, 'an answer without a request does nothing');
  // crossing requests make friends too (the asked one uses "Send Friend Request" back)
  const gc = w.client('10.77.0.4');
  const lc = w.login(gc, 'Charlie');
  const kc = w.lkey(lc);
  const c = w.buddy(gc, kc);
  w.send(c, 'RADM', [['USER', 'Alpha'], ['ID', 1]]);
  assert.equal(w.conn(a).l('RNOT').g('USER'), 'Charlie');
  assert.equal(w.conn(a).l('PGET').g('USER'), 'Charlie');
  w.send(a, 'RADM', [['USER', 'Charlie'], ['ID', 2]]);
  assert.equal(friendsLines(), 2);
  assert.equal(w.conn(c).l('RNOT').g('ATTR'), '0');
  assert.ok(w.core.buddies.list('Charlie').b.has('alpha') && w.core.buddies.list('Alpha').b.has('charlie'));
  // Bravo blocks Alpha: Alpha's messages no longer arrive
  w.send(b, 'RADD', [['USER', 'Alpha'], ['LIST', 'I'], ['ID', 9]]);
  const before = w.conn(b).count('RECV');
  w.send(a, 'SEND', [['USER', 'Bravo'], ['BODY', 'hello?']]);
  assert.equal(w.conn(b).count('RECV'), before);
  // Bravo leaves: Alpha sees him offline; the friends list stays
  w.send(b, 'DISC', []);
  assert.equal(w.conn(a).l('PGET').g('SHOW'), 'DISC');
  assert.ok(w.core.buddies.list('Alpha').b.has('bravo'));
  // an unknown key: refused once the lobby had a moment to finish
  const gx = w.client('10.77.0.9');
  const x = w.buddy(gx, '0123456789abcdef0123456789');
  w.sleep(3300);
  assert.equal(w.conn(x).l('AUTH').code, 'pass');
  w.send(x, 'RGET', [['LIST', 'B']]);
  assert.equal(w.conn(x).l('RGET').code, 'auth');
});

/** the friends list as the game's login asks for it: [name, ATTR] of each ROST */
function roster(w, b) {
  const n = w.conn(b).msgs.length;
  w.send(b, 'RGET', [['LRSC', 'PC'], ['LIST', 'B'], ['PRES', 'Y'], ['PEND', 'Y'], ['ID', 1]]);
  return w.conn(b).all().slice(n).filter((m) => m.kind === 'ROST').map((m) => [m.g('USER'), m.get('ATTR') ?? '']);
}

function told(w, c, user, chng) {
  return w.conn(c).all().filter((m) => m.kind === 'RNOT' && m.get('USER') === user && m.get('CHNG') === chng).length;
}

// EA Messenger for players who are away: friend requests wait for their answer, over a restart too, and so do
// friends' messages; requests declined, blocked and taken back, a friend taken off; what waits too long goes
test('ea_messenger_away', () => {
  const pair = (a, b) => [[a, b]];
  const storage = new MapStorage();
  let w = world({ storage });
  let [, a] = messenger(w, '10.77.0.2', 'Alpha');
  // a request to a player who was never here waits; the asker's list shows it as its own
  w.send(a, 'RADM', [['LRSC', 'PC'], ['USER', 'Bravo'], ['ID', 5], ['PRES', 'Y']]);
  assert.equal(w.conn(a).l('RADM').code, '');
  assert.deepEqual(roster(w, a), pair('Bravo', 'S'));
  // Bravo comes: on its list, a request that waits for its answer, with the asker's presence
  let [, b] = messenger(w, '10.77.0.3', 'Bravo');
  assert.deepEqual(roster(w, b), pair('Alpha', 'R'));
  assert.deepEqual([w.conn(b).l('PGET').g('USER'), w.conn(b).l('PGET').g('SHOW')], ['Alpha', 'CHAT']);
  // Alpha leaves, then Bravo accepts: friends on both lists
  w.send(a, 'DISC', []);
  w.send(b, 'RRSP', [['LRSC', 'PC'], ['USER', 'Alpha'], ['ANSW', 'Y'], ['ID', 6], ['PRES', 'Y']]);
  assert.deepEqual([w.conn(b).l('RNOT').g('USER'), w.conn(b).l('RNOT').g('ATTR')], ['Alpha', '0']);
  assert.ok(w.core.buddies.list('Alpha').b.has('bravo'));
  // a message to Alpha, away: it waits, as Alpha has Bravo as a friend; a stranger's does not
  const sent = w.t;
  w.send(b, 'SEND', [['USER', 'Alpha'], ['BODY', 'race me'], ['SUBJ', ''], ['TYPE', 'C']]);
  assert.equal(w.conn(b).l('SEND').code, '');
  let [, c] = messenger(w, '10.77.0.4', 'Charlie');
  w.send(c, 'SEND', [['USER', 'Alpha'], ['BODY', 'spam']]);
  assert.equal(w.core.buddies.list('Alpha').m.length, 1);
  // over a restart: Alpha's list has Bravo as a friend, then, a moment later (the game files it under the friend's
  // entry only then), the message comes, once
  w.core.stop();
  w = world({ storage });
  [, a] = messenger(w, '10.77.0.2', 'Alpha');
  assert.deepEqual(roster(w, a), pair('Bravo', ''));
  assert.equal(w.conn(a).count('RECV'), 0, 'not with the list');
  w.sleep(3000);
  const m = w.conn(a).l('RECV');
  assert.deepEqual([m.g('USER'), m.g('BODY'), m.g('TYPE')], ['Bravo', 'race me', 'C']);
  assert.equal(m.g('TIME'), String(Math.floor(sent / 1000)));
  w.advance(1000);
  roster(w, a);
  w.sleep(3000);
  assert.equal(w.conn(a).count('RECV'), 1, 'a message comes once');
  // declined: Charlie's request goes, Charlie is told
  [, b] = messenger(w, '10.77.0.3', 'Bravo');
  [, c] = messenger(w, '10.77.0.4', 'Charlie');
  w.send(c, 'RADM', [['USER', 'Alpha'], ['ID', 1]]);
  assert.deepEqual([w.conn(a).l('RNOT').g('USER'), w.conn(a).l('RNOT').g('ATTR')], ['Charlie', 'R']);
  w.send(a, 'RRSP', [['USER', 'Charlie'], ['ANSW', 'N'], ['ID', 2]]);
  assert.equal(told(w, c, 'Alpha', 'D'), 1);
  // blocked: Delta's request makes no friend, Delta is blocked, a request again never arrives
  const [, d] = messenger(w, '10.77.0.5', 'Delta');
  w.send(d, 'RADM', [['USER', 'Alpha'], ['ID', 1]]);
  w.send(a, 'RRSP', [['USER', 'Delta'], ['ANSW', 'B'], ['ID', 3]]);
  assert.ok(w.core.buddies.blocks('alpha', 'delta'));
  assert.ok(!w.core.buddies.list('Alpha').b.has('delta'), 'a request blocked makes no friend');
  w.send(d, 'RADM', [['USER', 'Alpha'], ['ID', 2]]);
  assert.equal(told(w, a, 'Delta', 'A'), 1, "Delta's second request");
  // taken back: Echo's request comes and goes
  const [, e] = messenger(w, '10.77.0.6', 'Echo');
  w.send(e, 'RADM', [['USER', 'Alpha'], ['ID', 1]]);
  w.send(e, 'RDEM', [['LRSC', 'PC'], ['USER', 'Alpha'], ['ID', 2]]);
  assert.equal(told(w, a, 'Echo', 'D'), 1);
  w.advance(1000);
  assert.deepEqual(roster(w, a), pair('Bravo', ''), "no request of Charlie's, Delta's or Echo's");
  // a friend taken off (the game: RDEM, then RDEL with the same fields): off both lists, Bravo told once
  for (const [kind, id] of [['RDEM', 7], ['RDEL', -1]]) {
    w.send(a, kind, [['LRSC', 'PC'], ['LIST', 'B'], ['PRES', 'Y'], ['USER', 'Bravo'], ['ID', id]]);
  }
  assert.equal(told(w, b, 'Alpha', 'D'), 1);
  assert.ok(w.core.buddies.list('Alpha').b.size === 0 && w.core.buddies.list('Bravo').b.size === 0);
  // what waits too long goes: a message after 7 days, a request after 30
  w.send(b, 'RADM', [['USER', 'Alpha'], ['ID', 3]]);
  w.send(a, 'RRSP', [['USER', 'Bravo'], ['ANSW', 'Y'], ['ID', 4]]);
  w.send(e, 'RADM', [['USER', 'Alpha'], ['ID', 3]]);
  w.send(a, 'DISC', []);
  w.send(b, 'SEND', [['USER', 'Alpha'], ['BODY', 'old news']]);
  assert.equal(w.core.buddies.list('Alpha').m.length, 1);
  w.advance(8 * 86400000);
  [, a] = messenger(w, '10.77.0.2', 'Alpha');
  const rows = roster(w, a);
  w.sleep(3000);
  assert.equal(w.conn(a).count('RECV'), 0, 'a message 8 days old');
  assert.ok(rows.some(([n, t]) => n === 'Echo' && t === 'R'), 'a request 8 days old: ' + JSON.stringify(rows));
  w.send(a, 'DISC', []);
  w.advance(23 * 86400000);
  [, a] = messenger(w, '10.77.0.2', 'Alpha');
  assert.deepEqual(roster(w, a), pair('Bravo', ''), 'a request 31 days old');
  w.core.buddySave();
  const stored = shelfTexts(w.core.store).join('\n');
  assert.ok(!stored.includes('old news') && !stored.includes('"R"'), stored);
});

// the count of players in Online mode (the server's /players): logged in, or racing until back
test('count_of_players', () => {
  const w = world();
  const [ga, gb] = [w.client('10.77.0.2'), w.client('10.77.0.3')];
  const a = w.login(ga, 'Alpha');
  const b = w.login(gb, 'Bravo');
  // and the browsers it counts (vips(): the server's console), the same
  const count = () => {
    const i = w.core.info();
    const v = w.core.vips();
    const [p, r] = [i.personas, i.racing];
    assert.equal(v.size, p + r);
    return [p, r];
  };
  assert.deepEqual(count(), [2, 0]);
  w.send(a, 'gcre', [['NAME', 'c1'], ['PARAMS', 'TRACK=4014']]);
  w.send(b, 'gjoi', [['NAME', 'c1']]);
  w.send(a, 'gsta', [['NAME', 'c1']]);
  // the game closes its lobby link for the race
  w.close(a);
  w.close(b);
  assert.deepEqual(count(), [0, 2], 'racing: still in Online mode');
  // Bravo's browser leaves during the race
  w.peerGone(ip('10.77.0.3'));
  assert.deepEqual(count(), [0, 1]);
  assert.deepEqual([...w.core.vips()], [ip('10.77.0.2')], 'Alpha, racing');
  w.advance(200000);
  const ga2 = w.client('10.77.0.2');
  // back online under the name: counted once
  w.login(ga2, 'Alpha');
  assert.deepEqual(count(), [1, 0]);
});

// the operator's race ban (FrameCtx::no_races): its player chats in the lobby but makes and joins no game, from its
// next frame on (one can come while it plays); a name taken away (nfsu2-bans rename) logs in nowhere
test('a_race_banned_player_gets_no_game_and_a_name_taken_away_no_login', () => {
  const deny = new Deny();
  deny.set(['B4d_N4me']);
  const w = world({ deny });
  const [ga, gb] = [w.client('10.77.0.2'), w.client('10.77.0.3')];
  const a = w.login(ga, 'Alpha');
  const b = w.login(gb, 'Bravo');
  const p = 'TRACK=4123\nDIR=0\nLAPS=2';
  w.clients.get(ga).noRaces = true;
  w.send(a, 'gcre', [['NAME', '088.Alpha'], ['MAXSIZE', 4], ['PARAMS', p]]);
  assert.equal(w.conn(a).l('gcre').code, 'full');
  assert.ok(w.logged('"Alpha": under a race ban: made no game'));
  w.send(b, 'gcre', [['NAME', '088.Bravo'], ['MAXSIZE', 4], ['PARAMS', p]]);
  assert.equal(w.conn(b).l('gcre').code, '');
  w.send(a, 'gjoi', [['NAME', '088.Bravo']]);
  assert.equal(w.conn(a).l('gjoi').code, 'full');
  assert.ok(w.logged('"Alpha": under a race ban: joined no game'));
  // lifted: it joins
  w.clients.get(ga).noRaces = false;
  w.send(a, 'gjoi', [['NAME', '088.Bravo']]);
  assert.equal(w.conn(a).l('gjoi').code, '');
  // the name taken away, and one that reads as it
  for (const name of ['B4d_N4me', 'BadName']) {
    const g = w.client('10.77.0.4');
    const c = w.connect(g, PORT_LOBBY);
    w.send(c, 'auth', [['NAME', name], ['PASS', 'x']]);
    assert.equal(w.conn(c).l('auth').code, 'imst', name);
  }
});

