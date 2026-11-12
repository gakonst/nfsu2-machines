// web/worker/src/names/index.js: the Rust crate's tests (web/server-rs/crates/names/src/tests.rs), its cross check
// against names.mjs (cross_check.rs), and differential tests against the Rust crate itself (its test-only example
// difftrace_names: cargo run --release -p nfsu2-names --example difftrace_names), live where cargo runs and from the
// fixture web/worker/test/fixtures/names-rust.json always.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as N from '../../src/names/index.js';
import { unknown } from '../../src/util/unicode.js';
import { ALLOWED, BLOCKED, NEAR, UNICODE, chatLines, corpus, plates, randomStrings } from './corpus.mjs';
import { fixture, runRust } from './rust.mjs';

const { blockedName, blockedPlate, chatSlur, letters, Deny } = N;
const { letter, read, WHOLE_WORDS, ANYWHERE_WORDS } = N._internals;
const here = path.dirname(fileURLToPath(import.meta.url));
const NAMES_MJS = path.resolve(here, '../../../src/app/names.mjs');

// tests.rs lists_ways_round_and_other_words
test('names.mjs: the lists\' words, the ways round them, and not the other words', () => {
  for (const w of [...N.ANYWHERE, ...N.WHOLE, ...N.EDGE]) assert.ok(blockedName(w), w);
  for (const v of N.HATE_VERBS) for (const b of ['', ...N.HATE_BETWEEN]) for (const g of N.HATE_GROUPS) assert.ok(blockedName(v + b + g), v + b + g);
  for (const n of [...BLOCKED, ...UNICODE]) assert.ok(blockedName(n), n);
  for (const n of ALLOWED) assert.ok(!blockedName(n), n);
  assert.ok(!blockedName('xfagx') && blockedName('x_fag_x') && blockedName('xFagX'));
});

// tests.rs letters_as_the_js_reads_them
test('letters as the JS reads them', () => {
  const c = s => s.codePointAt(0);
  for (const [ch, l] of [['a', 'a'], ['Z', 'z'], ['L', 'i'], ['l', 'i'], ['|', 'i'], ['0', 'o'], ['1', 'i'], ['!', 'i'], ['3', 'e'],
    ['4', 'a'], ['@', 'a'], ['5', 's'], ['$', 's'], ['7', 't'], ['+', 't'], ['6', 'g'], ['9', 'g'], ['8', 'b']]) {
    assert.equal(letter(c(ch)), c(l), ch);
  }
  for (const ch of ['2', ' ', '_', '-', '.', '\u{e9}', '\u{430}', '\u{ff41}', '\u{1f600}']) assert.equal(letter(c(ch)), 0, ch);
  const s = w => String.fromCharCode(...w);
  assert.equal(s(WHOLE_WORDS[0]), 'fag');
  assert.equal(s(ANYWHERE_WORDS[14]), 'jungiebunny');
  assert.equal(s(ANYWHERE_WORDS[11]), 'chingchong');
});

// tests.rs read_as_nfkd_without_marks_and_lookalikes
test('read as NFKD without marks, and the lookalikes', () => {
  const t = s => String.fromCodePoint(...read(s));
  assert.equal(t('Mustafa GS'), 'Mustafa GS');
  assert.equal(t('\u{f1}i\u{332}'), 'ni');
  assert.equal(t('\u{ff4e}\u{1d41a}\u{24d0}'), 'naa');
  assert.equal(t('\u{39d}\u{430}\u{20ac}'), 'Nae');
  // a keycap: the digit stays, the variation selector and the enclosing keycap are marks
  assert.equal(t('1\u{fe0f}\u{20e3}'), '1');
  // the ligature and the fraction come apart, the emoji and the zero-width joiner stay
  assert.equal(t('\u{fb00}\u{bd}\u{1f600}\u{200d}'), 'ff1\u{2044}2\u{1f600}\u{200d}');
  // a character newer than the Rust tables' Unicode (16.0) stays as it is, the text around it read as always
  assert.equal(t('\u{e9}\u{1dfd5}\u{e9}'), 'e\u{1dfd5}e');
});

// tests.rs numbers_and_letters
test('numbers and letters', () => {
  assert.ok(blockedName('fag123') && !blockedName('xni999a') && !blockedName('xni9999a') && blockedName('ni999a'));
  assert.ok(!blockedName('Dani99') && !blockedName('Dani99GS') && blockedName('ni99a'));
  assert.ok(!blockedName('Xni99A') && blockedName('XNI99A') && blockedName('Ni99A'));
  assert.ok(blockedName('f4g') && blockedName('f2ag') && blockedName('fa2g2') && !blockedName('fa2g2x'));
  assert.ok(blockedName('x1488x') && blockedName('2281488') && blockedName('x'.repeat(300) + '1488'));
  assert.ok(blockedName('14 88') && blockedName('14_88') && blockedName('1-4-8-8') && blockedName('x_14__88_'));
  assert.ok(!blockedName('1448') && !blockedName('1:48.8') && !blockedName('14.88') && !blockedName('14x88'));
});

// tests.rs parts_and_runs
test('parts and runs', () => {
  assert.ok(blockedName('niiiiggggaaaa') && blockedName('Niger') && !blockedName('Nigeria') && !blockedName('nige'));
  assert.ok(blockedName('XxCoonXx') && !blockedName('xxcoonxx') && blockedName('xx_coon_xx'));
  assert.ok(blockedName('F A G') && blockedName('f.a.g.s') && !blockedName('f a g x'));
  assert.ok(!blockedName('Van Dyke') && !blockedName('VanDyke') && blockedName('Dyke') && blockedName('X Dyke'));
  assert.ok(blockedName('Van Fag') && blockedName('Vanfag Dyke'));
});

// tests.rs a_pid_word_after_an_english_start_is_english
test('a pid word after an English start is English', () => {
  assert.ok(!blockedName('RapidRacer') && !blockedName('xStupidorx') && !blockedName('Insipidar'));
  assert.ok(blockedName('vladpidr') && blockedName('Pidr228') && blockedName('xpidrx') && blockedName('rapid_pidr'));
  assert.ok(!blockedName('TopiDrift') && !blockedName('topi drift') && blockedName('dapidor'));
  assert.ok(blockedName('YaPidor') && blockedName('ya_pidor') && blockedName('LilP1dr'));
});

// tests.rs edge_words_start_or_end_a_part
test('edge words start or end a part', () => {
  assert.ok(blockedName('nigabro') && blockedName('x_nigabro') && blockedName('bignigas') && blockedName('Big_Niga'));
  assert.ok(blockedName('n.i.g.a.b.r.o') && !blockedName('xnigabrox') && !blockedName('Hoonigan'));
  assert.ok(!blockedName('Nigar') && !blockedName('Zuniga') && !blockedName('Kniga_x') && !blockedName('Minigas'));
  assert.ok(blockedName('Nigar_niga') && blockedName('Kniga_bigniga') && blockedName('xZunigaX_niga'));
});

// tests.rs digits_after_a_lone_n
test('digits after a lone n', () => {
  assert.ok(blockedName('N1663r') && blockedName('BigN199a') && blockedName('Nl99A') && blockedName('n111gg3er'));
  assert.ok(!blockedName('N1995') && !blockedName('N1663') && !blockedName('Kaan1998GS') && !blockedName('Doran1994TR'));
  assert.ok(!blockedName('N_1663r') && !blockedName('Nas1663r'));
});

// tests.rs chat_lines
test('chat lines: a word at a time, two words together for the anywhere list, one-letter words in a row', () => {
  for (const [line, span] of [
    ['you nigger', 'nigger'], ['Kestrel> nate higgers', 'higgers'], ['nig ger lol', 'nig'], ['nibb a', 'nibb a'],
    ['SIEG HEIL', 'SIEG HEIL'], ['n i g g e r', 'n i g g e r'], ['so F A G', 'F A G'], ['u r a f a g', 'f a g'], ['f.a.g.s', 'f.a.g.s'],
    ['ur a fag!!', 'fag'], ['you n!gger', 'n!gger'], ['N1GG4 pls', 'N1GG4'], ['go 1488', '1488'], ['porch monkey', 'porch monkey'],
    ['van Dyke_fag', 'Dyke_fag'], ['van dyke-nigger', 'dyke-nigger'], ['lol niger', 'niger'], ['ya pidor', 'pidor'],
    ['big nigabro', 'nigabro'], ['austrian artist', 'austrian artist'], ['lets gasthejews', 'gasthejews'], ['gas thejews', 'gas thejews'],
    ['gas the jews', 'gas the jews'], ['KILL ALL THE J3WS now', 'KILL ALL THE J3WS'], ['we kill all the jews', 'kill all the jews'],
  ]) assert.equal(chatSlur(line), span, line);
  for (const line of ['merci kurwa', 'SEN? MERC? AMK', 'KUZO> DOM TORETTO H?S FATHER', 'rapid race', 'stupid race', 'go ok', 'go,ok',
    'fa g', 'Van Dyke', 'a b c d e', 'the spice must flow', 'hi! I\'m Nigel from Nigeria', 'topi drift', 'Zuniga and Nigar', 'lap 1:48.8',
    'las vegas the jewel', 'kill all the bots then the jews', '', '   ']) assert.equal(chatSlur(line), null, line);
  assert.equal(chatSlur('a\u{a0}porch  monkey b'), 'porch  monkey');
});

// tests.rs letters_past_255_are_not_read
test('letters past 255 are not read', () => {
  const x = n => 'x'.repeat(n);
  assert.ok(blockedName(x(250) + 'nigga'));
  assert.ok(!blockedName(x(252) + 'nigga'));
  assert.ok(blockedName(x(300) + '_fag') && blockedName(x(300) + ' ' + x(300) + '_fag'));
  assert.ok(!blockedName(x(300) + 'fag'));
});

// tests.rs names_taken_away_by_their_letters
test('names taken away by their letters', () => {
  assert.equal(letters('B4d_N4me'), 'badname');
  assert.equal(letters('Bad Name 1995'), 'badname');
  assert.equal(letters('Dani99GS'), 'danigs');
  assert.equal(letters('1234'), '');
  const d = new Deny();
  assert.ok(!d.has('BadName'));
  const g = d.generation();
  d.set(['Bad_Name', '4444']);
  assert.ok(d.generation() > g);
  for (const same of ['BadName', 'b4d n4me', 'BADNAME', 'Bad.Name.2000', '8adName']) assert.ok(d.has(same), same);
  for (const other of ['BadNames', 'Bad', 'GoodName', '', '1234']) assert.ok(!d.has(other), other);
  d.set([]);
  assert.ok(!d.has('BadName'));
});

// not in the Rust: a JS string can hold a lone surrogate; it reads as U+FFFD, in its place
test('lone surrogates read as U+FFFD', () => {
  const strs = randomStrings(99, 3000).map((s, i) => {
    const a = [...s];
    a.splice(i % (a.length + 1), 0, String.fromCharCode(0xD800 + (i * 37) % 2048));
    return a.join('');
  });
  strs.push('n\uD800igga', 'f\uDC00ag', 'F \uD83D A G', 'nig\uDBFFger');
  for (const s of strs) {
    const w = s.toWellFormed();
    assert.equal(blockedName(s), blockedName(w), JSON.stringify(s));
    assert.equal(blockedPlate(s), blockedPlate(w));
    assert.equal(letters(s), letters(w));
    const c = chatSlur(s), cw = chatSlur(w);
    assert.equal(c === null ? null : c.toWellFormed(), cw);
  }
});

/** each name's answers here, as difftrace_names writes them */
const ours = s => ({ n: blockedName(s), p: blockedPlate(s), c: chatSlur(s), l: letters(s) });

/** the names whose answers differ from Rust's (at most 20 shown) */
function compare(inputs, outputs) {
  assert.equal(outputs.length, inputs.length);
  const diff = [];
  for (let i = 0; i < inputs.length; i++) {
    const a = ours(inputs[i]), b = outputs[i];
    if (a.n !== b.n || a.p !== b.p || a.c !== b.c || a.l !== b.l) diff.push(JSON.stringify(inputs[i]) + ': js ' + JSON.stringify(a) + ', rust ' + JSON.stringify(b));
  }
  assert.deepEqual(diff.slice(0, 20), [], diff.length + ' of ' + inputs.length + ' answered otherwise');
}

/** the fixture's names: every Rust test case, and a few of each generator's */
function fixtureNames() {
  return [...N.ANYWHERE, ...N.WHOLE, ...BLOCKED, ...UNICODE, ...ALLOWED, ...NEAR, ...corpus({ scale: 0.01, step: 1500 }),
    ...plates({ scale: 0.01 }).filter((_, i) => i % 97 === 0), ...chatLines(1, 300), ...randomStrings(2, 300),
    'you nigger', 'van Dyke_fag', 'a\u{a0}porch  monkey b', 'KILL ALL THE J3WS now', 'u r a f a g'];
}

test('the same answers as the Rust crate: fixture (web/worker/test/fixtures/names-rust.json)', () => {
  const f = fixture('names-rust.json', () => {
    const inputs = fixtureNames();
    const r = runRust('nfsu2-names', 'difftrace_names', inputs.map(s => JSON.stringify(s)));
    return r.skip ? null : { inputs, outputs: r.out };
  });
  assert.ok(f.inputs.length > 1500);
  compare(f.inputs, f.outputs);
});

test('the same answers as the Rust crate: live, cross_check.rs\'s corpus (seed 7), its plates (seed 11), chat lines (seeds 1-3), any characters (seeds 4-6)', t => {
  const inputs = [...corpus(), ...plates()];
  for (const seed of [1, 2, 3]) inputs.push(...chatLines(seed, 20000));
  for (const seed of [4, 5, 6]) inputs.push(...randomStrings(seed, 20000));
  const r = runRust('nfsu2-names', 'difftrace_names', inputs.map(s => JSON.stringify(s)));
  if (r.skip) return t.skip('no Rust: ' + r.skip);
  compare(inputs, r.out);
  t.diagnostic(inputs.length + ' names, plates and lines: the same answers');
});

// cross_check.rs: names.mjs itself (the page's), on this Node's ICU: the same lists and lookalikes, and the same
// answers for every name without a character the Rust tables' Unicode has not assigned (for those, names.mjs reads
// this Node's Unicode, and the Rust and this port read them as the Node 24 of their writing did)
test('names.mjs: the same lists, lookalikes and answers', async t => {
  if (!fs.existsSync(NAMES_MJS)) return t.skip('no ' + NAMES_MJS);
  const M = await import(pathToFileURL(NAMES_MJS).href);
  assert.deepEqual([...M.SLURS.anywhere], [...N.ANYWHERE]);
  assert.deepEqual([...M.SLURS.whole], [...N.WHOLE]);
  assert.deepEqual([...M.SLURS.edge], [...N.EDGE]);
  assert.deepEqual([...M.EDGE_OK.start], [...N.EDGE_OK_START]);
  assert.deepEqual([...M.EDGE_OK.end], [...N.EDGE_OK_END]);
  assert.deepEqual([...M.WHOLE_OK], [...N.WHOLE_OK]);
  assert.deepEqual([...M.PID_STEMS], [...N.PID_STEMS]);
  assert.deepEqual([...M.HATE.verbs], [...N.HATE_VERBS]);
  assert.deepEqual([...M.HATE.between], [...N.HATE_BETWEEN]);
  assert.deepEqual([...M.HATE.groups], [...N.HATE_GROUPS]);
  for (const [k, ours] of [['edge', N.PLATE_EDGE], ['endOk', N.PLATE_END_OK], ['rests', N.PLATE_RESTS], ['anywhere', N.PLATE_ANYWHERE],
    ['anywhereOk', N.PLATE_ANYWHERE_OK], ['alone', N.PLATE_ALONE], ['marks', N.PLATE_MARKS], ['numbers', N.PLATE_NUMBERS]]) {
    assert.deepEqual([...M.PLATE[k]], [...ours], 'PLATE.' + k);
  }
  const m = /const LOOKALIKE = (\{[\s\S]*?\});/.exec(fs.readFileSync(NAMES_MJS, 'utf8'));
  const table = Object.entries(Function('return (' + m[1] + ')')()).map(([k, v]) => [k.codePointAt(0), v.codePointAt(0)]);
  assert.deepEqual(new Map(table), new Map(N.LOOKALIKE));
  // the corpus with every 4th code point of the sweep (names.mjs is slow; the Rust comparison above takes them all)
  const names = corpus({ step: 4 });
  let differ = 0, newer = 0;
  for (const n of names) {
    if (blockedName(n) === M.blockedName(n)) continue;
    differ++;
    if ([...n].some(ch => unknown(ch.codePointAt(0)))) newer++;
    else assert.fail('names.mjs answers otherwise for ' + JSON.stringify(n));
  }
  t.diagnostic(names.length + ' names; names.mjs (ICU ' + process.versions.icu + ', Unicode ' + process.versions.unicode + ') answers ' +
    differ + ' otherwise, all with a character the Rust tables have not assigned');
  const plateAll = plates();
  for (const p of plateAll) assert.equal(blockedPlate(p), M.blockedPlate(p), p);
});

