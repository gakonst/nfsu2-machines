// The names and plates of web/server-rs/crates/names/src/cross_check.rs (its corpus), made the same way in JS: the
// tests' names (tests.rs), near misses, made-up names from a fixed seed, ASCII and Unicode, long ones, and every code
// point of Unicode's planes in use in a few places of a name.  (The Rust's noise draws from a HashMap's values, in
// no fixed order: here in the order of their keys.)
import * as N from '../../src/names/index.js';
import { Rnd } from './rust.mjs';

const { read, letter } = N._internals;

/** tests.rs BLOCKED */
export const BLOCKED = [
  'nigger', 'N1gg3r', 'n i g g e r', 'n.i.g.g.a', 'NiQQa', 'nlgga', 'n!gga', 'niiiigggaaa', 'xXn1gg4Xx', 'FAG', 'f4g', 'F A G',
  'f4g_42', 'XxFagXx', 'fags', 'Faaag', 'faggot', 'f@gg0t', 'fa66ot', 'tr4nny', 'Trannie', 'r3tard', 'ibne', 'iBnE_34', 'wetback',
  'beaner', 'Ch1nk', 'g00k', 'sp1cs', 'paki', 'k1ke', 'dyke', 'c00n', 'XxCoonXx', 'towelhead', 'sandnigger', 'junglebunny', 'ni99a',
  'NI99A', 'nigga99', 'Fag42', 'Big1Fag', 'Mr5Coon', 'trannies', 'Dykes', 'Van_Fag',
  'Hitler', 'Hitler3858', 'adolfhitler', 'AdolfH', 'H1tl3r', 'gitler', 'Himmler', 'zigHael', 'NAZZI', 'JewsHunter', 'nigahunter',
  'Niga', 'NigaBoi', 'Nig4', 'MEGANIGA', 'KneeGro', 'CzarnuchJebany', 'CHURKA', 'xoxol', 'pidor', 'PIDARAZ', 'vladpidr', 'cwel666',
  'gigacwel', 'Mongoloid', 'TALIBAN', 'Et_Binladen', 'samrapist', 'RapeAddict', 'ASphaltMolester', '1488', 'Sam1488', 'kkk1488',
  'Sam14881488',
  'Nate_Higgers', 'NateHiggers', 'N8_Higgers', 'NatFigger', 'Nat_Figgers', 'BBHITLA', 'Adolph_Hitlr', 'HEIL_HTLER', 'gaskikes67',
  'HateTheColored', 'Ihateneegr_s', 'GoodestGoy', 'TheGoodGoyim', 'PedoDave', 'killnig', 'nibb3r', 'Niger', 'Nigerz', 'xN1gerx',
  'NIG_ER', 'BigNig', 'nigs', 'nigabro', 'tinyniga', 'SuperNiga', 'HOLYNIGA', 'gigaNyga', 'MrN1663r', 'BigN199a', 'N166ER', 'nupidor',
  'JaPidor', 'LolP1dr', 'TheAustrianArtist', 'austrian_painter', 'PintorAustriaco', 'Uncle_Adolf', 'Kitler88', 'AdolfFitler',
  'XitIer', 'Kristal_Nacht', 'HateJews', 'JewSlayer', 'GasJews', 'JEBAC_ZYDOW', 'pedophile', 'Pedofilo', 'OsamaBin', 'Al_Qaeda',
  'xChigga', 'Nazista', 'ZyklonB',
  'GasTheJews', 'Gas_The_Jews', 'KillAllTheJews', 'HuntTheJews', 'DeathToJews', 'g4sTh3J3ws', 'BurnDaJews',
  'SiegHail', 'Seig_Heil', 'ZigHeil', 'Heil_H', 'HeilAH42', '55Heil', 'Heil_SS', 'Hilter420', 'H1tl8r_x', 'Reltih', 'MeinFurher',
  'WaffenSS', 'TheThirdReich', 'GestapoGT', 'Goering_Fan', 'ReadMeinKampf', 'xXnaziXx', 'supernazi', 'nazidrift', 'Max14_88',
  'Dan_1_4_8_8', 'Jewhater', 'NoJewsAllowed', 'Austrian_Drawer', 'KKK_Klansman', 'Heil4thReich', 'HolocaustDenial', 'Goebbelz_Fan',
  'Big_Hitlor', 'AdolfWasRight', 'Adolf_The_Painter', 'White_Pride_TR', 'Jew_Kil', 'JewsKiller', 'YahudiSiker', 'Ya_Natsist',
  'Nacista', 'thenigaman', 'Nigakill3r', 'FuckZyd', 'Adolf', 'MrAdolf', 'Adolf_42', 'Ad0lf', 'Adolph', 'Reich', 'R3ICH_TR',
  'Holocaust_TR', 'SwastikaKing', 'Mr_Bitler',
];
/** tests.rs UNICODE */
export const UNICODE = [
  '\u{f1}igga', 'n\u{456}gga', '\u{ff4e}\u{ff49}\u{ff47}\u{ff47}\u{ff41}', '\u{39d}\u{399}GG\u{391}',
  'n\u{332}i\u{332}g\u{332}g\u{332}a\u{332}', '\u{24d5}\u{24d0}\u{24d6}', 'f\u{430}g', '\u{397}itler',
  '\u{ff28}\u{ff49}\u{ff54}\u{ff4c}\u{ff45}\u{ff52}', 'Lander\u{ff11}\u{ff14}\u{ff18}\u{ff18}',
];
/** tests.rs ALLOWED */
export const ALLOWED = [
  'Mustafa69', 'MustafaGS', 'Mustafa_GS', 'Mustafa Gamer', 'mustafagamer', 'Rafa96', 'Vefa', 'Safa', 'Pakize', 'Nigar', 'Nigeria',
  'Nigerian', 'Nigel', 'Raccoon', 'Tycoon', 'Cocoon', 'spicy', 'Spice', 'despicable', 'Pakistan', 'Fagundes', 'Bigger', 'Trigger',
  'Digger', 'Knight', 'Chinook', 'Scunthorpe', 'Cooper', 'Ahmet35', 'Emre_34', 'G\u{f6}khan', '\u{130}brahim', 'Tobi', 'Player',
  'NAME', 'OLHOST', 'Speedy', '', 'Hakan1995', 'Furkan1999', 'Ozan_1996', 'Can 1969', 'Kaan1998', 'Dani99', 'Toni69', 'Dani99GS',
  'Ozan1996GS', 'Hakan1993TR', 'Dani9912', 'Strannik', 'VanDyke', 'Van Dyke',
  'Spider', 'MR.SPIDER', 'Shinigami', 'Zuniga', 'Vlado', 'Vitaliba_Nox', 'Grapes', 'Trapezio', 'Nazim', 'Nazif', 'Nygaard', 'Mongol',
  'Churkin', 'jacob88', 'Jane8848', 'Ahmet1448',
  'RapidRacer', 'rapid racer', 'CupidRacer', 'Stupidrift', 'StupidArmy', 'TepidRide',
  'Hoonigan', 'Hooniga', 'Minigame', 'Minigas', 'Kniga', 'Kunigas', 'Niigaki', 'NIGAMI', 'Nygard', 'TonyGamer', 'Antony Gaming',
  'Brony_Gamer', 'Higgins', 'Higgs', 'Figgy', 'Figgis', 'Fighter', 'Tauhitianboy', 'Tahitien', 'Kshitij', 'Hilti_Passat',
  'hellhound057', 'Speedo', 'Torpedo', 'Goyo204', 'Nigro', 'KonigRider39', 'Rapper', 'Draped', 'KillNight', 'Austria', 'AustrianGP',
  'Painter', 'Artist', 'Osama', 'TopiDrift', 'N1995', 'Doran1994TR',
  'Jewel', 'JewishRacer', 'Andrew', 'Matthew', 'KillerQueen', 'GasMonkey', 'Deadpool', 'Bombshell', 'Shooter',
  'Nazli', 'NAZLI', 'Nazli_GS', 'Nazilli', 'Nazlican', 'Nazir', 'Nazia', 'Nazife', 'Nazik', 'Nazih', 'Nazio', 'Ignazio', 'Ignazi',
  'Schlitter', 'HellsSpawn', 'Hellhammer', 'Sheila', 'Heilig', 'Casinojewel', 'Waffen', 'Panzer', 'Reichert', 'Car14_89',
  'Nazl\u{131}', 'Nazib', 'Shitlord', 'Goebel', 'Kaiserreich', 'Adolfo', 'Adolfinho', 'Swastik', 'Zyklon', 'Rudolf',
];
/** cross_check.rs NEAR */
export const NEAR = [
  'Niger', 'Nigeria', 'NIGER', 'nigerr', 'Van Dyke', 'VanDyke', 'van dyke', 'VAN DYKE', 'Van_Dyke', 'Van Dykes', 'Vandyke', 'Van  Dyke',
  'Van1Dyke', 'Vann Dyke', 'Mr Van Dyke', 'raccoon', 'Raccoon', 'RACCOON', 'rac coon', 'racCoon', 'Hakan1995', 'Hakan 1995', 'hakan19',
  'Hakan95', 'Dani99GS', 'Dani99gs', 'dani99GS', 'DANI99GS', 'Dani99Gs', 'Dani 99GS', 'ni99a', 'Ni99a', 'nI99A', 'ni9a', 'ni999a',
  'ni99A', 'NI99a', 'F A G', 'F A G S', 'F.A.G', 'f a g g o t', 'F A G X', 'XxCoonXx', 'xXcOoNxX', 'XXCOONXX', 'xxCoonxx', 'XxCoon',
  'CoonXx', 'Big1Fag', 'big1fag', 'BIG1FAG', 'Big12Fag', 'Big123Fag', 'Big1Fagz', 'Big1Fags', 'Mustafa GS', 'MUSTAFAGS', 'Pakize',
];

/** cross_check.rs chars: the characters (strings) of these ranges of code points, surrogates left out */
function chars(ranges) {
  const out = [];
  for (const [a, b] of ranges) for (let cp = a; cp <= b; cp++) if (cp < 0xD800 || cp > 0xDFFF) out.push(String.fromCodePoint(cp));
  return out;
}

/** cross_check.rs marks */
export const marks = () => chars([[0x300, 0x36f], [0x483, 0x489], [0x591, 0x5bd], [0x64b, 0x65f], [0x900, 0x903], [0x93a, 0x94f],
  [0x1ab0, 0x1ace], [0x1dc0, 0x1dff], [0x20d0, 0x20f0], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0x1d165, 0x1d169], [0x1d16d, 0x1d172],
  [0xe0100, 0xe0110], [0x10ef5, 0x10efb], [0x1e6e3, 0x1e6ef]]);

/** cross_check.rs separators */
export const separators = () => [...' _-.,;:/\\*#~^\'"?=<>()[]{}%&2\t\n', ...'' + chars([[0xa0, 0xa0], [0xad, 0xad], [0xb7, 0xb7],
  [0x61c, 0x61c], [0x85, 0x85], [0x1680, 0x1680], [0x180e, 0x180e], [0x2000, 0x200f], [0x2022, 0x2022], [0x2028, 0x202f],
  [0x205f, 0x2064], [0x2066, 0x2069], [0x3000, 0x3000], [0xfeff, 0xfeff], [0xe0001, 0xe0001], [0xe0020, 0xe007f]]).join('')]
  .filter((c, i, a) => true);

/** cross_check.rs others */
export const others = () => chars([[0x1f600, 0x1f60f], [0x1f525, 0x1f525], [0x1f44d, 0x1f44d], [0x1f3fb, 0x1f3ff], [0x1f3ce, 0x1f3ce],
  [0x1f697, 0x1f697], [0x1f1e6, 0x1f1ff], [0x1f170, 0x1f189], [0x2764, 0x2764], [0x200d, 0x200d], [0xfe0f, 0xfe0f], [0x2122, 0x2122],
  [0xa9, 0xae], [0xbc, 0xbe], [0x2150, 0x215f], [0x3380, 0x33df], [0x4e00, 0x4e0f], [0xac00, 0xac0f], [0xd55c, 0xd55c],
  [0x3131, 0x3140], [0x5d0, 0x5ea], [0x627, 0x64a], [0x660, 0x669], [0x966, 0x96f], [0xe01, 0xe0f], [0xdf, 0xdf], [0x1e9e, 0x1e9e],
  [0xfffd, 0xfffd], [0xe000, 0xe000], [0xf8ff, 0xf8ff], [0xf0000, 0xf0000], [0xfdd0, 0xfdd0], [0xfffe, 0xffff], [0x378, 0x379],
  [0x1d455, 0x1d455], [0x1d49d, 0x1d49d], [0x2ffff, 0x2ffff], [0x1b123, 0x1b126], [0x1d6a6, 0x1d6a6], [0x1df95, 0x1df95],
  [0x1dfcd, 0x1dfff]]);

const isGraphic = cp => cp > 0x20 && cp < 0x7f;

/** cross_check.rs alternatives: the code points read as one ASCII character, by that character */
export function alternatives() {
  const alts = new Map();
  const ranges = [[0xa0, 0x2ff], [0x370, 0x52f], [0x1d00, 0x1dbf], [0x1e00, 0x1eff], [0x2070, 0x20c0], [0x2100, 0x218f],
    [0x2460, 0x24ff], [0xff00, 0xff5e], [0x1d400, 0x1d7ff], [0x1f100, 0x1f1ff]];
  for (const ch of chars(ranges)) {
    const r = read(ch);
    if (r.length === 1 && isGraphic(r[0])) {
      const k = String.fromCharCode(r[0]);
      if (!alts.has(k)) alts.set(k, []);
      alts.get(k).push(ch);
    }
  }
  return alts;
}

/** cross_check.rs pieces */
export function pieces() {
  const p = [...N.ANYWHERE, ...N.WHOLE, ...N.EDGE, ...N.EDGE_OK_START, ...N.EDGE_OK_END, ...N.WHOLE_OK, ...N.PID_STEMS, ...NEAR];
  p.push('mustafa', 'gs', 'raccoon', 'spice', 'spicy', 'niger', 'pakize', 'pakistan', 'xx', 'gamer', 'a', 'g', 'dani', 'hakan', 'van',
    'tycoon', 'trigger', 'ibrahim', '99', '1995', '69', '42');
  p.push('1488', '88', '14', '1_4', '8-8', 'spider', 'shinigami', 'zuniga', 'adolf');
  p.push('n', '1663', 'pid', 'topi', 'drift', 'nigeria');
  p.push(...N.HATE_VERBS, ...N.HATE_BETWEEN, ...N.HATE_GROUPS, 'jewel');
  return p;
}

/** cross_check.rs swap: the digits and signs that stand for a letter */
export function swap(ch) {
  switch (ch.length === 1 ? ch.toLowerCase() : '') {
    case 'o': return ['0'];
    case 'i': return ['1', '!', '|', 'l'];
    case 'e': return ['3'];
    case 'a': return ['4', '@'];
    case 's': return ['5', '$'];
    case 't': return ['7', '+'];
    case 'g': return ['6', '9', 'q'];
    case 'b': return ['8'];
    default: return [];
  }
}

const upper = ch => (ch >= 'a' && ch <= 'z' ? ch.toUpperCase() : ch);

/** cross_check.rs push_number */
function pushNumber(r, alts) {
  let n = '';
  for (let k = 1 + r.next(4); k > 0; k--) {
    const d = String.fromCharCode(48 + r.next(10));
    const styled = alts?.get(d);
    if (styled && r.next(3) === 0) n += r.pick(styled);
    else n += d;
  }
  return n;
}

/** cross_check.rs ascii_names */
export function asciiNames(r, pcs, names, count = 20000, noise = 5000) {
  for (let x = 0; x < count; x++) {
    let n = '';
    for (let k = 1 + r.next(3); k > 0; k--) {
      for (const ch of r.pick(pcs)) {
        const m = r.next(10);
        if (m === 0 && swap(ch).length > 0) n += r.pick(swap(ch));
        else if (m === 1) n += upper(ch);
        else if (m === 2) n += ch + ch;
        else n += ch;
        if (r.next(12) === 0) n += r.pick([' ', '_', '-', '.', '2']);
      }
      if (r.next(3) === 0) n += r.pick(['', ' ', '_', '42']);
      if (r.next(4) === 0) n += pushNumber(r, null);
    }
    names.push(n.slice(0, 24));
  }
  for (let x = 0; x < noise; x++) {
    let n = '';
    for (let k = r.next(25); k > 0; k--) n += String.fromCharCode(32 + r.next(95));
    names.push(n);
  }
}

/** cross_check.rs unicode_names */
export function unicodeNames(r, pcs, names, count = 30000, noise = 3000) {
  const alts = alternatives(), mk = marks(), sep = separators(), oth = others();
  const alt = ch => (alts.has(ch) ? r.pick(alts.get(ch)) : null);
  for (let x = 0; x < count; x++) {
    let n = '';
    for (let k = 1 + r.next(3); k > 0; k--) {
      for (let ch of r.pick(pcs)) {
        if (r.next(5) === 0) ch = upper(ch);
        const m = r.next(10);
        if (m < 4) n += alt(ch) ?? ch;
        else if (m === 4 && swap(ch).length > 0) {
          const sign = r.pick(swap(ch));
          const a = alt(sign);
          n += a !== null && r.next(2) === 0 ? a : sign;
        } else if (m === 5) n += ch + (alt(ch) ?? ch);
        else n += ch;
        const q = r.next(25);
        if (q <= 1) n += r.pick(mk);
        else if (q === 2) n += r.pick(sep);
        else if (q === 3) n += r.pick(oth);
      }
      const q = r.next(4);
      if (q === 0) n += r.pick(sep);
      else if (q === 1) n += pushNumber(r, alts);
    }
    if (r.next(10) === 0) n = r.pick(oth) + n;
    names.push(n);
  }
  const all = [...[...alts.keys()].sort().flatMap(k => alts.get(k)), ...mk, ...sep, ...oth];
  for (let x = 0; x < noise; x++) {
    let n = '';
    for (let k = r.next(30); k > 0; k--) n += r.pick(all);
    names.push(n);
  }
}

/** cross_check.rs long_names */
export function longNames(r, pcs, names, count = 2000) {
  for (let x = 0; x < count; x++) {
    let n = '';
    for (let k = 240 + r.next(40); k > 0; k--) n += r.pick(['x', 'y', 'X', ' ', '_', '4']);
    const at = r.next(n.length + 1);
    names.push(n.slice(0, at) + r.pick(pcs) + n.slice(at));
  }
}

const SWEEP_WORDS = ['f?g', 'i?ne', '?oon', '?yke', 'ibn?', '?ag', 'fa?', 'c?ink', 'k?ke', '?igaboo', '?ike', 'porch?onkey', 'chi?k',
  'g?ok', 's?ic', 'ni?q', '?etard', '?pic', '?ranny', 'j?nglebunny', '?etback', 'd?ke'];

/** cross_check.rs sweep: every code point of the planes in use (and every 97th of the rest) in a few places of a
 * name; step > 1 takes every step-th of them only */
export function sweep(names, step = 1) {
  let k = 0;
  for (let cp = 0x80; cp <= 0x10ffff; cp++) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;
    const inUse = cp <= 0x3ffff || (cp >= 0xe0000 && cp <= 0xeffff);
    if (!(inUse || cp % 97 === 0)) continue;
    if (k++ % step !== 0) continue;
    const c = String.fromCodePoint(cp);
    for (const t of ['Dani?99GS', 'x?Fag', 'f?g']) names.push(t.replace('?', c));
    if (read(c).some(x => letter(x) !== 0 || (x >= 0x30 && x <= 0x39))) for (const t of SWEEP_WORDS) names.push(t.replace('?', c));
  }
}

/** cross_check.rs corpus (sizes scaled by scale, the sweep every step-th code point) */
export function corpus({ scale = 1, step = 1 } = {}) {
  const names = [...N.ANYWHERE, ...N.WHOLE, ...BLOCKED, ...UNICODE, ...ALLOWED, ...NEAR, 'xfagx', 'x_fag_x', 'xFagX'];
  const r = new Rnd(7), pcs = pieces();
  asciiNames(r, pcs, names, Math.round(20000 * scale), Math.round(5000 * scale));
  unicodeNames(r, pcs, names, Math.round(30000 * scale), Math.round(3000 * scale));
  longNames(r, pcs, names, Math.round(2000 * scale));
  sweep(names, step);
  return names;
}

/** cross_check.rs plates (sizes scaled by scale) */
export function plates({ scale = 1, seed = 11 } = {}) {
  const AZ09 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const out = [''];
  for (let n = 1; n <= 3; n++) {
    for (let k = 0; k < AZ09.length ** n; k++) {
      let s = '';
      for (let d = 0; d < n; d++) s += AZ09[Math.floor(k / AZ09.length ** d) % AZ09.length];
      out.push(s);
    }
  }
  const pcs = [...N.PLATE_EDGE, ...N.PLATE_END_OK, ...N.PLATE_RESTS, ...N.PLATE_ANYWHERE, ...N.PLATE_ANYWHERE_OK, ...N.PLATE_ALONE,
    ...N.PLATE_MARKS, ...N.PLATE_NUMBERS, ...N.WHOLE, ...N.EDGE, 'big', 'lil', 'x', 's', 'kkkk', 'night', 'mustafa', 'nigga', '1488',
    '88', '14', '6', '9', '0', '1', '3', '4', '8', '42', '123', '1995'].map(w => w.toUpperCase());
  const r = new Rnd(seed);
  for (let x = 0; x < Math.round(30000 * scale); x++) {
    let n = '';
    for (let k = 1 + r.next(3); k > 0; k--) {
      for (const ch of r.pick(pcs)) {
        const digits = swap(ch).filter(c => c >= '0' && c <= '9');
        n += r.next(8) === 0 && digits.length > 0 ? r.pick(digits) : ch;
      }
    }
    out.push([...n].slice(0, 8).join(''));
  }
  for (let x = 0; x < Math.round(10000 * scale); x++) {
    let n = '';
    for (let k = r.next(9); k > 0; k--) n += r.pick(AZ09);
    out.push(n);
  }
  out.push('bigfag', 'BIG FAG', 'BIGFAGBIGFAG', 'Fag', 'KKK_88');
  return out;
}

/** chat lines: words of the pieces (some one letter, some with signs, a ! at the end) between spaces of all kinds */
export function chatLines(seed, count) {
  const r = new Rnd(seed), pcs = pieces();
  const spaces = [' ', ' ', ' ', '  ', '\t', '\u00a0', '\u3000', '\u2028', '\u0085', '\ufeff', '\u180e'];
  const out = [];
  for (let x = 0; x < count; x++) {
    let line = '';
    for (let k = r.next(9); k > 0; k--) {
      let w = r.pick(pcs);
      const m = r.next(8);
      if (m === 0) w = [...w].join(r.pick([' ', '.', '']));
      else if (m === 1) w = upper(w[0] ?? '') + w.slice(1);
      else if (m === 2) w = w.toUpperCase();
      else if (m === 3 && swap(w[0] ?? '').length) w = r.pick(swap(w[0])) + w.slice(1);
      if (r.next(6) === 0) w += '!'.repeat(1 + r.next(3));
      line += (line ? r.pick(spaces) : '') + w;
    }
    out.push(line);
  }
  return out;
}

/** any characters at all: ASCII, accents, fullwidth, Cyrillic and Greek, emoji, format characters, marks, and
 * unassigned ones (no lone surrogates: the Rust cannot take them) */
export function randomStrings(seed, count, maxLen = 24) {
  const r = new Rnd(seed);
  const pools = [chars([[0x20, 0x7e]]), chars([[0xa0, 0x24f]]), chars([[0xff01, 0xff5e]]), chars([[0x370, 0x4ff]]), others(), marks(),
    separators(), chars([[0x1d400, 0x1d4ff], [0x2460, 0x24ff], [0x1f100, 0x1f1ff]])];
  const out = [];
  for (let x = 0; x < count; x++) {
    let s = '';
    for (let k = r.next(maxLen + 1); k > 0; k--) {
      if (r.next(40) === 0) s += String.fromCodePoint(r.next(0x110000 - 0x800) + 0x800 >= 0xD800 ? r.next(0x110000 - 0xE000) + 0xE000 : r.next(0xD800));
      else s += r.pick(r.pick(pools));
    }
    out.push(s);
  }
  return out;
}

