// A player's name that reads as a slur: a port of web/server-rs/crates/names/src/lib.rs (nfsu2-names), which is the
// rules of web/src/app/names.mjs.  The server refuses one for the Online mode (an account or persona; the Online
// results drop the ones kept under one) and the switch's peer list shows "player" for one (switch/text.js
// cleanName).
//
// A name is read as letters only: a to z in lower case, the digits and signs that stand for letters as those
// (0 o, 1 ! | l i, 3 e, 4 @ a, 5 $ s, 7 + t, 6 9 g, 8 b), anything else left out: "N1-g g@" reads "nigga".  Digits
// that make a number are left out too: three or more in a row, or two that end a part ("Hakan1995", "Dani99",
// "Dani99GS" are no slur; "ni99a" is one); but not right after a part that is a lone n (or ni) so far, with a letter
// after them ("N1663r", "BigN199a"; "N1995" stays a letter and a year).
// Before that accents, fullwidth and styled letters go (NFKD) and the Cyrillic and Greek letters that look like
// Latin ones read as those.  A word matches where each of its letters comes at least as many times in a row as in
// the word ("niiiggga"; one g is not the two of "nigger").
//  - anywhere: a word long enough that no other word has it inside it; "niger" not where "nigeri" is (Nigeria)
//  - whole: a short one that other words have inside them ("Mustafa GS", "raccoon", "spicy", "Pakize"), only as a
//    part of the name on its own, and plural: the parts are split where a character is no letter and where a
//    capital follows a small letter, digits and signs read as letters between them or not ("f4g_42", "XxCoonXx",
//    "Big1Fag"); the name's letters together count as one too ("F A G").  "Dyke" after "Van" is the surname; a name
//    of WHOLE_OK is none ("Nazli").
//  - edge: a word that starts or ends a part (or the name's letters together), plural too ("nigabro", "biggniga"),
//    but not where a part starts or ends with a word of EDGE_OK_START or EDGE_OK_END there ("Nigar", "Zuniga",
//    "Hooniga")
// The other offensive names go the same way: Nazi ones and their nicknames, hate aimed at a group, terror, sexual
// violence; a name with 1488 in it (the neo-Nazi code), spaces, _ or - between its digits or not ("14_88"); and hate
// aimed at a group as a phrase (HATE_VERBS: a verb, a word between or none, the group).  A swear word is no such
// name.  A "pid" word (pidor, pidar, pidr) right after the start of an English word that ends in "pid" (rapid,
// cupid, stupid), or after a vowel when it runs into the next part ("TopiDrift"), is no slur ("RapidRacer";
// "dapidor", "YaPidor" are).
// The Online lobby's chat is read with the same lists, a word at a time (chatSlur).
//
// Strings: the Rust reads a &str (always well-formed); a JS string's lone surrogates are read as U+FFFD (what its
// UTF-8 would be), keeping each one's place (one UTF-16 unit), so chatSlur's span is still the line's own text.
// NFKD and the general categories are the Rust's (util/unicode.js), not the runtime's Unicode.

import { isMark, normalizeAsRust } from '../util/unicode.js';

/** names/src/lib.rs ANYWHERE: words that match anywhere in a name */
export const ANYWHERE = Object.freeze([
  'nigg', 'niqq', 'faggot', 'tranny', 'trannie', 'retard', 'ibne', 'wetback', 'beaner', 'raghead', 'towelhead',
  'chingchong', 'jigaboo', 'porchmonkey', 'junglebunny', 'nibba', 'nigus', 'nygga', 'kneegro', 'wigga', 'meganiga',
  'czarnuch', 'czarnuh', 'churka', 'pidor', 'pidar', 'pidr', 'gomosek', 'cwel', 'baitola', 'maricon', 'gotveren',
  'gotoglani', 'mongoloid', 'hitler', 'gitler', 'zitler', 'adolfh', 'himler', 'fuhrer', 'fuehrer', 'siegheil',
  'zighael', 'goebbel', 'mengele', 'mussolini', 'jewhunt', 'jewshunt', 'nigahunt', 'zenciav', 'natehig', 'binladen',
  'benladen', 'rapist', 'molester', 'niger', 'higger', 'figger', 'chigga', 'negroid', 'zencigot', 'kacap', 'rusnya',
  'pideras', 'frocio', 'pretomacaco', 'kitler', 'fitler', 'ritler', 'sitler', 'xitler', 'heitler', 'nitler',
  'neonazi', 'nazist', 'uncleadolf', 'austrianartist', 'austrianpaint', 'pintoraustria', 'zyklonb', 'kristalnacht',
  'ovendodger', 'jewkil', 'jewslay', 'jewdestroy', 'jebaczyd', 'zydzidopieca', 'osamabin', 'alqaeda', 'pedophil',
  'pedofil', 'wigger', 'niglet', 'nignog', 'nibber', 'iggernay', 'neegr', 'nigoger', 'nigrigg', 'nigler', 'nigcer',
  'nigwer', 'poofter', 'binladin', 'htler', 'hitlr', 'hitlur', 'gasthejuice', 'goyim', 'goyslop', 'rapegod',
  'rapedog', 'rapeloli', 'biraped', 'sigheil', 'seigheil', 'zigheil', 'ziegheil', 'zeigheil', 'sieghail', 'seighail',
  'sighail', 'heilnaz', 'heiluncle', 'hitl8r', 'hitteru', 'reltih', 'furher', 'austriandraw', 'ausartreject',
  'wehrmacht', 'gestapo', 'waffenss', 'dasreich', 'thirdreich', 'drittesreich', 'goering', 'meinkampf', 'auschwitz',
  'holohoax', 'hakenkreuz', 'whitepower', 'kukluxklan', 'klansman', 'jewhate', 'nojews', 'jewsdid', '4threich',
  'fourthreich', 'holocaust', 'adolfwasright', 'adolfpaint', 'adolfthepaint', 'whitepride', 'jewskil', 'yahudisik',
  'natsist', 'nacist', 'nigaman', 'nigakil', 'swastika', 'bitler',
]);
/** names/src/lib.rs WHOLE: short words that match only as a part of the name on its own */
export const WHOLE = Object.freeze([
  'fag', 'dyke', 'coon', 'spic', 'paki', 'kike', 'gook', 'chink', 'niga', 'nyga', 'ngga', 'neger', 'xach', 'xoxol',
  'hohol', 'ukrop', 'pider', 'pedik', 'nazi', 'taliban', 'rape', 'nig', 'killnig', 'fucknig', 'hatenig', 'pedo', 'goy',
  'hilter', 'heilh', 'heilah', 'heilss', 'ssheil', 'heilhit', 'hitlor', 'adolf', 'adolph', 'reich',
]);
/** names/src/lib.rs EDGE: words that match where they start or end a part of the name (or its letters together) */
export const EDGE = Object.freeze(['niga', 'nyga', 'hitla', 'hitle', 'nazi']);
/** names/src/lib.rs EDGE_OK_START: the words a part may start with that would read as an edge word there and are
 * none: a name (Nigar, Nygaard; Nazir, Nazim, Nazli...), "Nigam..." ("NIGAMI", a game), a Japanese name (Niigaki) */
export const EDGE_OK_START = Object.freeze(['nigam', 'nigar', 'nigak', 'nygar', 'nazir', 'nazim', 'nazif', 'nazik', 'nazih',
  'nazib', 'nazia', 'nazio', 'nazli']);
/** names/src/lib.rs EDGE_OK_END: the words a part may end with that would read as an edge word there and are none:
 * a surname (Zuniga, Ignazi), a word (kniga: a book; kunigas: a priest; Minigas), a 7-letter cut (Hooniga,
 * Shiniga), Brony..., a name (Nazli) */
export const EDGE_OK_END = Object.freeze(['zuniga', 'kniga', 'kuniga', 'miniga', 'hooniga', 'shiniga', 'bronyga', 'manyga',
  'yanazi', 'ignazi', 'nazli']);
/** names/src/lib.rs WHOLE_OK: the names a part may be that read as a word of WHOLE and are none, as they are (no
 * more of a letter in a row, no plural): Nazli (Turkish: Nazlı), Nazilli (a town), "l" reading "i" */
export const WHOLE_OK = Object.freeze(['nazli', 'nazilli']);
/** names/src/lib.rs PID_STEMS: the starts of the English words that end in "pid": rapid, cupid, stupid, tepid,
 * vapid, insipid, lipid, limpid, sapid, intrepid, hispid */
export const PID_STEMS = Object.freeze(['ra', 'cu', 'stu', 'te', 'va', 'insi', 'li', 'lim', 'sa', 'intre', 'his']);
/** names/src/lib.rs HATE_VERBS: hate aimed at a group as a phrase, matched anywhere as the ANYWHERE words are: a
 * verb, one of HATE_BETWEEN or none, a group of HATE_GROUPS ("GasJews", "Kill_All_Jews") */
export const HATE_VERBS = Object.freeze(['gas', 'kill', 'hate', 'hunt', 'slay', 'burn', 'shoot', 'nuke', 'bomb', 'dead',
  'death', 'fck', 'fuck', 'fuk', 'destroy', 'exterminate']);
/** names/src/lib.rs HATE_BETWEEN: the words that may come between a verb and a group of a hate phrase */
export const HATE_BETWEEN = Object.freeze(['s', 'the', 'all', 'allthe', 'da', 'dem', 'them', 'those', 'every', 'dirty', 'to']);
/** names/src/lib.rs HATE_GROUPS: the groups of a hate phrase */
export const HATE_GROUPS = Object.freeze(['jew', 'kike', 'colored', 'coloured', 'zyd']);
/** names/src/lib.rs PLATE_EDGE: license plates (blockedPlate): a word that ends the plate's letters (or starts
 * them, a word of PLATE_RESTS after it) */
export const PLATE_EDGE = Object.freeze(['fag', 'coon', 'spic', 'paki', 'kike', 'kyke', 'gook', 'chink', 'dyke', 'nig', 'nigr',
  'neger', 'pedo', 'rtard']);
/** names/src/lib.rs PLATE_END_OK: the words a plate's letters may end with that would read as a PLATE_EDGE word
 * there and are none: a word or name (raccoon, aspic, torpedo, König, Sehnig), one cut to 8 or misspelled
 * ("MIDNIG(HT)", "LIGHTNIG", "RAFAG(A)") */
export const PLATE_END_OK = Object.freeze([
  'rafag', 'tafag', 'racoon', 'cocoon', 'tycoon', 'aspic', 'ospic', 'uspic', 'papaki', 'ipaki', 'eepaki', 'klike', 'akike',
  'ekike', 'ikike', 'okyke', 'ergook', 'achink', 'uchink', 'vandyke', 'oldyke', 'odyke', 'knig', 'midnig', 'ghtnig',
  'sehnig', 'anig', 'enig', 'inig', 'onig', 'unig', 'reneger', 'torpedo', 'speedo', 'ipedo', 'ppedo',
]);
/** names/src/lib.rs PLATE_RESTS: the words after a PLATE_EDGE word that starts a plate's letters ("FAGBOY",
 * "NIGSKING") */
export const PLATE_RESTS = Object.freeze(['boy', 'boi', 'lord', 'king', 'kid', 'kill', 'killer', 'slayer', 'hunter', 'lover',
  'life']);
/** names/src/lib.rs PLATE_ANYWHERE: words that match anywhere in a plate's letters */
export const PLATE_ANYWHERE = Object.freeze(['nggr', 'jewgas', 'jewsgas', 'h8jew']);
/** names/src/lib.rs PLATE_ANYWHERE_OK: the words that hold a PLATE_ANYWHERE word and are none ("HUNGGRY",
 * Anggraini) */
export const PLATE_ANYWHERE_OK = Object.freeze(['anggr', 'unggr']);
/** names/src/lib.rs PLATE_ALONE: a plate with one of these as a part of its own (letters or digits in a row) is one
 * ("KKK77"; not "KKKK": laughter) */
export const PLATE_ALONE = Object.freeze(['KKK']);
/** names/src/lib.rs PLATE_MARKS: a plate with one of these as a part next to one of PLATE_NUMBERS is one ("HH88",
 * "88SS") */
export const PLATE_MARKS = Object.freeze(['HH', 'SS', 'WP', 'HEIL', 'SIEG']);
/** names/src/lib.rs PLATE_NUMBERS: the numbers of the codes (PLATE_MARKS; not 14: "SS14" is a car's) */
export const PLATE_NUMBERS = Object.freeze(['88']);
/** names/src/lib.rs CODE: a name with these digits in a row in it is one too (the neo-Nazi code) */
const CODE = [0x31, 0x34, 0x38, 0x38];

/** names/src/lib.rs FROM and TO: the digits and signs that stand for letters, and those letters, by position */
const FROM = '01!|l34@5$7+698';
const TO = 'oiiiieaassttggb';

/** names/src/lib.rs LETTERS: names.mjs letter(ch) for every ASCII character: the letter it reads as (a char
 * code), 0 for none.  No other character reads as a letter. */
const LETTERS = (() => {
  const table = new Uint8Array(128);
  for (let ch = 0; ch < 128; ch++) {
    const low = ch >= 65 && ch <= 90 ? ch + 32 : ch;
    let letter = low >= 97 && low <= 122 ? low : 0;
    for (let i = 0; i < FROM.length; i++) if (FROM.charCodeAt(i) === low) letter = TO.charCodeAt(i);
    table[ch] = letter;
  }
  return table;
})();

/** names/src/lib.rs letter: code point ch as a letter (a char code), else 0 */
function letter(ch) {
  return ch >= 0 && ch < 128 ? LETTERS[ch] : 0;
}

const isDigit = c => c >= 0x30 && c <= 0x39;
const isUpper = c => c >= 0x41 && c <= 0x5A;
const isLower = c => c >= 0x61 && c <= 0x7A;
const isAlpha = c => isUpper(c) || isLower(c);
const S = 0x73;

/** names/src/lib.rs Word::new: a word of the lists as the letters a name is read as ("l" reads "i", so
 * "junglebunny" is looked for as "jungiebunny"); a non-ASCII byte reads as no letter */
function word(w) {
  const out = [];
  for (const b of new TextEncoder().encode(w)) {
    const c = b < 128 ? LETTERS[b] : 0;
    if (c !== 0) out.push(c);
  }
  if (out.length > 16) throw new Error('names: a word longer than 16 letters: ' + w);
  return Uint8Array.from(out);
}

const words = list => Object.freeze(list.map(word));

const ANYWHERE_WORDS = words(ANYWHERE);
const WHOLE_WORDS = words(WHOLE);
const EDGE_WORDS = words(EDGE);
const OK_START_WORDS = words(EDGE_OK_START);
const OK_END_WORDS = words(EDGE_OK_END);
const OK_WHOLE_WORDS = words(WHOLE_OK);
const STEM_WORDS = words(PID_STEMS);
const DYKE = words(['dyke']);
const VERB_WORDS = words(HATE_VERBS);
const BETWEEN_WORDS = words(HATE_BETWEEN);
const GROUP_WORDS = words(HATE_GROUPS);
const P_EDGE_WORDS = words(PLATE_EDGE);
const P_END_OK_WORDS = words(PLATE_END_OK);
const P_REST_WORDS = words(PLATE_RESTS);
const P_ANY_WORDS = words(PLATE_ANYWHERE);
const P_ANY_OK_WORDS = words(PLATE_ANYWHERE_OK);

/** names/src/lib.rs ANYWHERE_FIRST: the anywhere words by their first letter (a to z): a word is at s[i] only when
 * s[i] is its first letter, so only those are looked for there */
const ANYWHERE_FIRST = (() => {
  const t = Array.from({ length: 26 }, () => []);
  for (const w of ANYWHERE_WORDS) t[w[0] - 0x61].push(w);
  return t;
})();

/** names/src/lib.rs hate's phrases: for each verb, its letters, a word between or none, a group's letters */
const HATE_PHRASES = VERB_WORDS.map(v => {
  const out = [];
  for (const b of [new Uint8Array(0), ...BETWEEN_WORDS]) for (const g of GROUP_WORDS) out.push(Uint8Array.from([...v, ...b, ...g]));
  return out;
});

/** names/src/lib.rs lookalike: the Cyrillic and Greek letters that look like Latin ones read as those, and a few
 * Latin ones NFKD keeps (dotless i, L, O and D with a stroke, eng, script g), the inverted exclamation mark and the
 * euro sign */
export const LOOKALIKE = Object.freeze(new Map([
  // Cyrillic А, Greek Α
  [0x0410, 'A'], [0x0391, 'A'],
  // Cyrillic В, Greek Β
  [0x0412, 'B'], [0x0392, 'B'],
  // Cyrillic С, Greek lunate sigma Ϲ
  [0x0421, 'C'], [0x03F9, 'C'],
  // Cyrillic Komi Ԁ, Latin Đ
  [0x0500, 'D'], [0x0110, 'D'],
  // Cyrillic Е, Greek Ε
  [0x0415, 'E'], [0x0395, 'E'],
  // Cyrillic Н, Greek Η
  [0x041D, 'H'], [0x0397, 'H'],
  // Cyrillic І, Greek Ι
  [0x0406, 'I'], [0x0399, 'I'],
  // Cyrillic Ј
  [0x0408, 'J'],
  // Cyrillic К, Greek Κ
  [0x041A, 'K'], [0x039A, 'K'],
  // Latin Ł
  [0x0141, 'L'],
  // Cyrillic М, Greek Μ
  [0x041C, 'M'], [0x039C, 'M'],
  // Greek Ν
  [0x039D, 'N'],
  // Cyrillic О, Greek Ο, Latin Ø
  [0x041E, 'O'], [0x039F, 'O'], [0x00D8, 'O'],
  // Cyrillic Р, Greek Ρ
  [0x0420, 'P'], [0x03A1, 'P'],
  // Cyrillic Ѕ
  [0x0405, 'S'],
  // Cyrillic Т, Greek Τ
  [0x0422, 'T'], [0x03A4, 'T'],
  // Cyrillic Х, Greek Χ
  [0x0425, 'X'], [0x03A7, 'X'],
  // Cyrillic У, Greek Υ
  [0x0423, 'Y'], [0x03A5, 'Y'],
  // Greek Ζ
  [0x0396, 'Z'],
  // Cyrillic а, Greek α
  [0x0430, 'a'], [0x03B1, 'a'],
  // Cyrillic в, Ь, ь, Greek β
  [0x0432, 'b'], [0x042C, 'b'], [0x044C, 'b'], [0x03B2, 'b'],
  // Cyrillic с, Greek lunate sigma ϲ
  [0x0441, 'c'], [0x03F2, 'c'],
  // Cyrillic Komi ԁ, Latin đ
  [0x0501, 'd'], [0x0111, 'd'],
  // Cyrillic е, Greek ε, the euro sign
  [0x0435, 'e'], [0x03B5, 'e'], [0x20AC, 'e'],
  // Latin script ɡ
  [0x0261, 'g'],
  // Cyrillic н
  [0x043D, 'h'],
  // Cyrillic і, Greek ι, Latin dotless ı, the inverted exclamation mark
  [0x0456, 'i'], [0x03B9, 'i'], [0x0131, 'i'], [0x00A1, 'i'],
  // Cyrillic ј
  [0x0458, 'j'],
  // Cyrillic к, Greek κ
  [0x043A, 'k'], [0x03BA, 'k'],
  // Latin ł
  [0x0142, 'l'],
  // Cyrillic м
  [0x043C, 'm'],
  // Cyrillic п, Greek η, Latin ŋ
  [0x043F, 'n'], [0x03B7, 'n'], [0x014B, 'n'],
  // Cyrillic о, Greek ο, Latin ø
  [0x043E, 'o'], [0x03BF, 'o'], [0x00F8, 'o'],
  // Cyrillic р, Greek ρ
  [0x0440, 'p'], [0x03C1, 'p'],
  // Cyrillic Kurdish ԛ
  [0x051B, 'q'],
  // Cyrillic ѕ
  [0x0455, 's'],
  // Cyrillic т, Greek τ
  [0x0442, 't'], [0x03C4, 't'],
  // Greek υ
  [0x03C5, 'u'],
  // Greek ν
  [0x03BD, 'v'],
  // Cyrillic х, Greek χ
  [0x0445, 'x'], [0x03C7, 'x'],
  // Cyrillic у
  [0x0443, 'y'],
].map(([k, v]) => [k, v.charCodeAt(0)])));

/** names/src/lib.rs lookalike (above) of a code point */
function lookalike(cp) {
  return LOOKALIKE.get(cp) ?? cp;
}

/** a JS string as the Rust's &str would be: lone surrogates as U+FFFD (same length in UTF-16 units) */
function wellFormed(s) {
  s = String(s ?? '');
  return s.isWellFormed() ? s : s.toWellFormed();
}

/** names/src/lib.rs read: the name's characters (code points) as names.mjs reads them,
 * [...name.normalize('NFKD').replace(/\p{M}/gu, '')] with the lookalikes as their Latin letters; NFKD and the marks
 * as the Rust has them (a character its Unicode has not assigned stays as it is, the text around it read alone) */
function read(name) {
  const out = [];
  let ascii = true;
  for (let i = 0; i < name.length; i++) if (name.charCodeAt(i) >= 0x80) { ascii = false; break; }
  if (ascii) {
    for (let i = 0; i < name.length; i++) out.push(name.charCodeAt(i));
    return out;
  }
  const n = normalizeAsRust(name, 'NFKD');
  // normalizeAsRust leaves the unassigned characters as they are: none of them is a mark in the tables, and none
  // is a lookalike, so the filter and the map leave them as the Rust does
  for (let i = 0; i < n.length;) {
    const cp = n.codePointAt(i);
    i += cp > 0xFFFF ? 2 : 1;
    if (!isMark(cp)) out.push(lookalike(cp));
  }
  return out;
}

/** names/src/lib.rs number: the run of n digits at str[i] is a number, not letters: three or more, or two with no
 * letter after them or a capital after a small letter before them */
function number(str, i, n) {
  if (n !== 2) return n > 2;
  const before = i > 0 ? str[i - 1] : undefined;
  if (i + 2 >= str.length) return true;
  const after = str[i + 2];
  return letter(after) === 0 || (isUpper(after) && before !== undefined && isLower(before));
}

/** names/src/lib.rs at: the end of word w (its letters) at s[i], each letter at least as many times in a row as in
 * w (the name's run of it is taken whole); -1 if it is not there */
function at(s, i, w) {
  let j = 0;
  while (j < w.length) {
    const c = w[j];
    let m = 0;
    while (j + m < w.length && w[j + m] === c) m++;
    let k = 0;
    while (i + k < s.length && s[i + k] === c) k++;
    if (k < m) return -1;
    i += k;
    j += m;
  }
  return i;
}

/** t[e..] is all s (a plural's end, or nothing) */
function restIsS(t, e) {
  for (let k = e; k < t.length; k++) if (t[k] !== S) return false;
  return true;
}

/** names/src/lib.rs whole: t is all one of words, or its plural */
function whole(t, list) {
  for (const w of list) {
    const e = at(t, 0, w);
    if (e >= 0 && restIsS(t, e)) return true;
  }
  return false;
}

function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** names/src/lib.rs whole_word: t is a word of WHOLE (or its plural), and no name of WHOLE_OK */
function wholeWord(t) {
  return whole(t, WHOLE_WORDS) && !OK_WHOLE_WORDS.some(x => eq(x, t));
}

/** names/src/lib.rs starts_with: t starts with word w (its letters) */
function startsWith(t, w) {
  return at(t, 0, w) >= 0;
}

/** names/src/lib.rs ends_with: t ends with word w (its letters), or its plural */
function endsWith(t, w) {
  for (let i = 0; i < t.length; i++) {
    const e = at(t, i, w);
    if (e >= 0 && restIsS(t, e)) return true;
  }
  return false;
}

/** names/src/lib.rs edge: t starts or ends with a word of the edge list, and not with a word of EDGE_OK_START or
 * EDGE_OK_END there */
function edge(t) {
  return EDGE_WORDS.some(w => (startsWith(t, w) && !OK_START_WORDS.some(x => startsWith(t, x))) ||
    (endsWith(t, w) && !OK_END_WORDS.some(x => endsWith(t, x))));
}

/** names/src/lib.rs CAP: the JS keeps at most 255 letters of a name, and of a part of it: the rest of a longer one
 * is not read */
const CAP = 255;

/** names/src/lib.rs Letters: letters read so far, at most CAP of them, and whether a part of the name starts at
 * each */
class Letters {
  constructor() {
    this.buf = new Uint8Array(CAP);
    this.st = new Array(CAP).fill(false);
    this.len = 0;
  }

  /** c, the first letter of a part or not */
  push(c, start) {
    if (this.len < CAP) {
      this.buf[this.len] = c;
      this.st[this.len] = start;
      this.len++;
    }
  }

  get() {
    return this.buf.subarray(0, this.len);
  }

  starts() {
    return this.st.slice(0, this.len);
  }
}

/** s ends with the letters of w */
function sliceEndsWith(s, end, w) {
  if (w.length > end) return false;
  for (let k = 0; k < w.length; k++) if (s[end - w.length + k] !== w[k]) return false;
  return true;
}

const VOWELS = new Set([0x61, 0x65, 0x69, 0x6F, 0x75, 0x79]);
const PID = [0x70, 0x69, 0x64];

/** names/src/lib.rs english_pid: a "pid" word of the anywhere list (pidor, pidar, pidr) at s[i] is the end of an
 * English word: not at the start of a part (starts[j]: a part starts at s[j]), and right after the start of one of
 * those words ("RapidRacer", "Stupidrift"), or after a vowel and into the next part ("TopiDrift"); "vladpidr",
 * "dapidor", "YaPidor" are slurs */
function englishPid(s, i, w, starts) {
  if (!(w.length >= 3 && w[0] === PID[0] && w[1] === PID[1] && w[2] === PID[2]) || starts[i]) return false;
  if (STEM_WORDS.some(st => sliceEndsWith(s, i, st))) return true;
  const e = at(s, i, w);
  const end = e >= 0 ? e : i + 1;
  if (!(i > 0 && VOWELS.has(s[i - 1]))) return false;
  for (let k = i + 1; k < end; k++) if (starts[k]) return true;
  return false;
}

/** names/src/lib.rs NIGERIA: "nigeri", where "niger" is no slur (Nigeria) */
const NIGERIA = word('nigeri');
const NIGER = word('niger');

/** names/src/lib.rs hate: a hate phrase (a verb, a word between or none, a group: "gasthejews") at s[i] */
function hate(s, i) {
  for (let v = 0; v < VERB_WORDS.length; v++) {
    if (at(s, i, VERB_WORDS[v]) < 0) continue;
    for (const p of HATE_PHRASES[v]) if (at(s, i, p) >= 0) return true;
  }
  return false;
}

/** names/src/lib.rs anywhere: a word of the anywhere list or a hate phrase is in s (letters; starts[j]: a part
 * starts at s[j]), and no English "pid" word or Nigeria */
function anywhere(s, starts) {
  for (let i = 0; i < s.length; i++) {
    if (hate(s, i)) return true;
    for (const w of ANYWHERE_FIRST[s[i] - 0x61]) {
      const nigeria = w === NIGER_WORD && sliceStartsAt(s, i, NIGERIA);
      if (at(s, i, w) >= 0 && !englishPid(s, i, w, starts) && !nigeria) return true;
    }
  }
  return false;
}

/** the anywhere list's own "niger" (compared by identity: w == b"niger") */
const NIGER_WORD = ANYWHERE_WORDS.find(w => eq(w, NIGER));

/** s[i..] starts with w */
function sliceStartsAt(s, i, w) {
  if (i + w.length > s.length) return false;
  for (let k = 0; k < w.length; k++) if (s[i + k] !== w[k]) return false;
  return true;
}

const VAN = word('van');
const N1 = word('n');
const NI = word('ni');

/** names/src/lib.rs scan: the name's letters (and whether each of its parts is one letter: {s, single}), null when
 * 1488 or a part of its own that is a word of the whole list (or starts or ends with a word of the edge list) is in
 * it */
function scan(name) {
  const str = read(name);
  // spaces, _ or - between its digits or not ("14_88"; not "1:48.8", a lap time)
  const code = str.filter(c => c !== 0x20 && c !== 0x5F && c !== 0x2D);
  for (let k = 0; k + CODE.length <= code.length; k++) {
    if (code[k] === CODE[0] && code[k + 1] === CODE[1] && code[k + 2] === CODE[2] && code[k + 3] === CODE[3]) return null;
  }
  // s: all the name's letters; t: the part being read
  const s = new Letters(), t = new Letters();
  // the part before was "van"; the last letter (not a digit or sign read as one) was a small one
  let afterVan = false, low = false, single = true;
  let i = 0;
  while (i <= str.length) {
    const ch = i < str.length ? str[i] : -1;
    let r = 0;
    while (i + r < str.length && isDigit(str[i + r])) r++;
    // after a lone n (or ni) and before a letter, digits are letters: "N1663r"
    const tg = t.get();
    const loneN = (eq(tg, N1) || eq(tg, NI)) && i + r < str.length && letter(str[i + r]) !== 0;
    const num = r > 0 && number(str, i, r) && !loneN;
    const c = num || ch < 0 ? 0 : letter(ch);
    if ((c === 0 || (low && isUpper(ch))) && t.len > 0) {
      const part = t.get();
      if ((wholeWord(part) && !(afterVan && whole(part, DYKE))) || edge(part)) return null;
      afterVan = eq(part, VAN);
      single = single && t.len === 1;
      t.len = 0;
    }
    if (c !== 0) {
      s.push(c, t.len === 0);
      t.push(c, false);
      if (isAlpha(ch)) low = isLower(ch);
    } else {
      low = false;
    }
    i += num ? r : 1;
  }
  return { s, single };
}

/** names/src/lib.rs blocked_name: names.mjs blockedName(name): the name reads as a slur (above) */
export function blockedName(name) {
  const n = scan(wellFormed(name));
  if (n === null) return true;
  const s = n.s.get();
  return anywhere(s, n.s.starts()) || wholeWord(s) || edge(s);
}

/** names/src/lib.rs held: word x holds s[i..e): it is there from s[j], j <= i, to e or past it */
function held(s, i, e, x) {
  for (let j = Math.max(0, i - x.length); j <= i; j++) if (at(s, j, x) >= e) return true;
  return false;
}

/**
 * names/src/lib.rs blocked_plate: names.mjs blockedPlate(plate): a license plate (capitals and digits, at most 8;
 * anything else is read as a name only) reads as a slur, as a name or as a plate.  A plate has no small letters to
 * split its parts by ("BIGFAG" is "BigFag") and its words run into each other, so:
 *  - a word of PLATE_EDGE that ends the plate's letters, plural too ("BIGFAG", "KILLFAGS"), unless they end with a
 *    word of PLATE_END_OK ("RACCOON"), or that starts them with a word of PLATE_RESTS after it, plural or not
 *    ("FAGBOY")
 *  - a word of PLATE_ANYWHERE anywhere in its letters, unless a word of PLATE_ANYWHERE_OK holds it
 *  - its letters as a name's, but a lone digit at its end is a number ("MUSTAFA6", "HUZAIFA9")
 *  - codes: a part (letters or digits in a row) of PLATE_ALONE, or one of PLATE_MARKS next to one of PLATE_NUMBERS
 *    ("HH88", "88SS")
 */
export function blockedPlate(plate) {
  plate = wellFormed(plate);
  if (blockedName(plate)) return true;
  if (!/^[A-Z0-9]{0,8}$/.test(plate)) return false;
  const p = [];
  for (let k = 0; k < plate.length; k++) p.push(plate.charCodeAt(k));
  // the parts: letters or digits in a row
  const parts = [];
  for (let k = 0; k < plate.length;) {
    let e = k + 1;
    while (e < plate.length && isDigit(p[e]) === isDigit(p[k])) e++;
    parts.push(plate.slice(k, e));
    k = e;
  }
  for (let k = 0; k < parts.length; k++) {
    const marked = (k > 0 && PLATE_MARKS.includes(parts[k - 1])) || (k + 1 < parts.length && PLATE_MARKS.includes(parts[k + 1]));
    if (PLATE_ALONE.includes(parts[k]) || (PLATE_NUMBERS.includes(parts[k]) && marked)) return true;
  }
  // its letters as a name's, a lone digit at its end left out
  const q = p.length >= 2 && isUpper(p[p.length - 2]) && isDigit(p[p.length - 1]) ? p.slice(0, -1) : p;
  const sl = [];
  for (let i = 0; i < q.length;) {
    let r = 0;
    while (i + r < q.length && isDigit(q[i + r])) r++;
    if (r > 0 && number(q, i, r)) {
      i += r;
      continue;
    }
    const c = letter(q[i]);
    if (c !== 0) sl.push(c);
    i++;
  }
  const s = Uint8Array.from(sl);
  const edgeHit = P_EDGE_WORDS.some(w => {
    if (endsWith(s, w) && !P_END_OK_WORDS.some(x => endsWith(s, x))) return true;
    const e = at(s, 0, w);
    if (e < 0) return false;
    let b = e;
    while (b < s.length && s[b] === S) b++;
    const rest = s.subarray(e), bare = s.subarray(b);
    return P_REST_WORDS.some(r => whole(rest, [r]) || whole(bare, [r]));
  });
  if (edgeHit) return true;
  return P_ANY_WORDS.some(w => {
    for (let i = 0; i < s.length; i++) {
      const e = at(s, i, w);
      if (e >= 0 && !P_ANY_OK_WORDS.some(x => held(s, i, e, x))) return true;
    }
    return false;
  });
}

/** names/src/lib.rs WHOLE_RUN: the most one-letter words in a row read as a word of the whole list ("f a g s") */
const WHOLE_RUN = 8;

/** Rust's char::is_whitespace (Unicode White_Space): where chatSlur splits a line into words */
function isWhitespace(cp) {
  return (cp >= 0x09 && cp <= 0x0D) || cp === 0x20 || cp === 0x85 || cp === 0xA0 || cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200A) || cp === 0x2028 || cp === 0x2029 || cp === 0x202F || cp === 0x205F || cp === 0x3000;
}

function concat(...arrays) {
  let n = 0;
  for (const a of arrays) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/**
 * names/src/lib.rs chat_slur: a chat line's words that read as a slur (the Online lobby's chat, nfsu2-online): the
 * first such span of the line (the line's own text), null for none.  The line is no name: its letters all together
 * would read words across its words ("rapid race" has "pidr" in it, "go ok" is "gook"), so it is read a word
 * (between spaces, without the ! at its end) at a time:
 *  - a word as a name: 1488 or a part of the whole list in it, a word of the anywhere list in its letters; its
 *    letters together only when each part is one letter ("f.a.g", not "go,ok"); "Dyke" after "van" is the surname
 *  - two words in a row: a word of the anywhere list across them ("nig ger", "sieg heil", "nate higgers")
 *  - three or four words in a row: a hate phrase from the first one's start ("gas the jews", not "vegas the jewel")
 *  - one-letter words in a row: their letters, for the anywhere list ("n i g g a"), and three to eight of them for
 *    the whole list ("F A G", "u r a f a g")
 */
export function chatSlur(line) {
  line = wellFormed(line);
  // the words: [from, end) in UTF-16 units
  const ws = [];
  let from = -1;
  for (let i = 0; i <= line.length;) {
    const cp = i < line.length ? line.codePointAt(i) : 0x20;
    const n = cp > 0xFFFF ? 2 : 1;
    if (isWhitespace(cp)) {
      if (from >= 0) {
        // the ! at a word's end is punctuation, not an i
        let e = i;
        while (e > from && line.charCodeAt(e - 1) === 0x21) e--;
        if (e > from) ws.push([from, e]);
        from = -1;
      }
    } else if (from < 0) {
      from = i;
    }
    i += n;
  }
  // each word's letters, and where its parts start
  const letters = [], starts = [];
  for (let k = 0; k < ws.length; k++) {
    const [a, b] = ws[k];
    // a word after "van" is read with it, as the name "van ..." ("van Dyke")
    const afterVan = k > 0 && eq(letters[k - 1], VAN);
    let n = scan(line.slice(a, b)), skip = 0;
    if (n === null && afterVan) {
      n = scan(line.slice(ws[k - 1][0], b));
      skip = 3;
    }
    if (n === null) return line.slice(a, b);
    const ns = n.s.get(), nst = n.s.starts();
    if (anywhere(ns, nst) || (n.single && (wholeWord(ns) || edge(ns)))) return line.slice(a, b);
    if (ns.length < skip) throw new Error('chatSlur: "van" not read'); // the Rust's slice would panic
    const s = ns.slice(skip), st = nst.slice(skip);
    if (k > 0 && anywhere(concat(letters[k - 1], s), [...starts[k - 1], ...st])) return line.slice(ws[k - 1][0], b);
    // three or four words in a row, a hate phrase from the first one's start ("gas the jews")
    for (let j = Math.max(0, k - 3); j < Math.max(0, k - 1); j++) {
      if (hate(concat(...letters.slice(j, k), s), 0)) return line.slice(ws[j][0], b);
    }
    letters.push(s);
    starts.push(st);
  }
  // the one-letter words in a row
  let k = 0;
  while (k < ws.length) {
    let n = 0;
    while (k + n < ws.length && letters[k + n].length === 1) n++;
    if (n >= 3) {
      const s = Uint8Array.from(letters.slice(k, k + n), x => x[0]);
      const span = (i, j) => line.slice(ws[k + i][0], ws[k + j - 1][1]);
      if (anywhere(s, new Array(n).fill(true))) return span(0, n);
      for (let i = 0; i < n; i++) {
        for (let j = i + 3; j <= Math.min(i + WHOLE_RUN, n); j++) {
          if (wholeWord(s.subarray(i, j))) return span(i, j);
        }
      }
    }
    k += Math.max(n, 1);
  }
  return null;
}

/** names/src/lib.rs letters: a name's letters as the lists read it (the digits and signs that stand for letters as
 * those, numbers and everything else left out): what names that read the same have in common ("B4d_Name", "bad
 * name", "BadName99").  The names the operator took away (Deny) are compared by it. */
export function letters(name) {
  const str = read(wellFormed(name));
  let out = '';
  for (let i = 0; i < str.length;) {
    let r = 0;
    while (i + r < str.length && isDigit(str[i + r])) r++;
    if (r > 0 && number(str, i, r)) {
      i += r;
      continue;
    }
    const c = letter(str[i]);
    if (c !== 0) out += String.fromCharCode(c);
    i++;
  }
  return out;
}

/** names/src/lib.rs Deny: the names the server's operator took away (nfsu2-bans: rename), by their letters: nobody
 * plays under one, or under a name that reads the same.  Each set moves generation on. */
export class Deny {
  constructor() {
    this._set = new Set();
    this._generation = 0;
  }

  /** names/src/lib.rs Deny::set: the names taken away now (as they were typed, or their letters already: the same) */
  set(names) {
    const set = new Set();
    for (const n of names) {
      const l = letters(n);
      if (l !== '') set.add(l);
    }
    this._set = set;
    this._generation++;
  }

  /** names/src/lib.rs Deny::has: whether name reads as one of them */
  has(name) {
    if (this._set.size === 0) return false;
    const l = letters(name);
    return l !== '' && this._set.has(l);
  }

  /** names/src/lib.rs Deny::generation: moves on with each set */
  generation() {
    return this._generation;
  }
}

/** for the tests (names/src/tests.rs reads these private pieces): letter, the words' letters, read */
export const _internals = Object.freeze({ letter, read, WHOLE_WORDS, ANYWHERE_WORDS });

