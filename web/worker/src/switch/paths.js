// Where the players are and how long their paths are, for the server's 5-minute counts (its "[players]" lines): a port
// of web/server-rs/crates/lan/src/paths.rs.  Each player's round trip to the server by its country (Cloudflare's
// CF-IPCountry) and by region, and of the pairs that play together, free roam's links (the hub's) and LAN play's (a
// race, its lobby: UDP from one player to another), how many are of one country and of one region, and how long the
// way from one player to the other through the server is (the two players' round trips together).
//
// A round trip is the player's lowest of the last 30-60 s (lag.js Probe.base()): its path without the queues on it.
// Nothing here costs a datagram more than raceWith; the rest is made when the counts are.  Counts only: never a
// player's own.  The lines are byte for byte what Rust's format! makes (its {:.0} rounds ties to even: util/rustfmt.js fixed).

import { totalCmp } from '../util/f64.js';
import { fixed as fixedP } from '../util/rustfmt.js';

/** format!("{:.0}", x) */
const fixed = (x) => fixedP(x, 0);

/**
 * paths.rs code: a country as Peer::country keeps it: its two letters, big-endian (0: not known).
 * @param {ArrayLike<number>|string} c two bytes (or a two-letter string)
 */
export function code(c) {
  if (typeof c === 'string') {
    if (c.length !== 2) throw new RangeError('code: two letters');
    return ((c.charCodeAt(0) & 255) << 8) | (c.charCodeAt(1) & 255);
  }
  return ((c[0] & 255) << 8) | (c[1] & 255);
}

/** paths.rs letters: a code's two letters (each byte as its Latin-1 character, as Rust's u8 as char) */
export function letters(c) {
  return String.fromCharCode((c >>> 8) & 255, c & 255);
}

/**
 * paths.rs REGIONS: the regions the counts group countries in: the UN's geoscheme's, a few put together (Central
 * America with the Caribbean, Central with South Asia), Western Asia as the Middle East with Turkey, the Caucasus and
 * Iran, and all of Russia in Eastern Europe (most of its players are in its west).
 */
export const REGIONS = Object.freeze([
  'unknown',
  'Northern Europe',
  'Western Europe',
  'Southern Europe',
  'Eastern Europe',
  'Western Asia',
  'Central and South Asia',
  'East Asia',
  'Southeast Asia',
  'Oceania',
  'North America',
  'Central America and the Caribbean',
  'South America',
  'North Africa',
  'Sub-Saharan Africa',
  'elsewhere',
]);

/** paths.rs region's match arms, by region */
const REGION_CODES = [
  [1, 'GB IE IS NO SE FI DK EE LV LT FO AX IM JE GG SJ'],
  [2, 'FR DE NL BE LU CH AT LI MC'],
  [3, 'ES PT IT GR MT AD SM VA GI SI HR BA RS ME MK AL XK'],
  [4, 'PL CZ SK HU RO BG MD UA BY RU'],
  [5, 'TR CY GE AM AZ IL PS JO LB SY IQ IR SA AE QA KW BH OM YE'],
  [6, 'KZ UZ TM KG TJ AF PK IN BD LK NP BT MV'],
  [7, 'CN JP KR KP TW HK MO MN'],
  [8, 'ID MY SG TH VN PH MM KH LA BN TL'],
  [9, 'AU NZ PG FJ SB VU NC PF WS TO KI FM MH PW NR TV GU MP AS CK NU NF WF TK PN'],
  [10, 'US CA GL BM PM UM'],
  [11, 'MX GT BZ SV HN NI CR PA CU DO HT JM PR TT BS BB LC VC GD AG DM KN AW CW SX BQ KY TC VG VI AI MS MF BL GP MQ'],
  [12, 'BR AR CL CO PE VE EC BO PY UY GY SR GF FK GS'],
  [13, 'EG LY TN DZ MA SD EH'],
  [14, 'NG GH CI SN ML BF NE TD CM CF GA CG CD AO ZM ZW MZ MW TZ KE UG RW BI ET ER DJ SO SS ZA NA BW LS SZ MG MU SC KM RE YT CV GM GN GW SL LR TG BJ MR ST GQ SH'],
];
/** @type {Map<number, number>} */
const REGION_OF = new Map();
for (const [r, list] of REGION_CODES) for (const c of list.split(' ')) REGION_OF.set(code(c), r);

/** paths.rs region: a country's place in REGIONS (0: not known; the last: a code of no region here, as Antarctica's) */
export function region(c) {
  if (c === 0) return 0;
  return REGION_OF.get(c) ?? REGIONS.length - 1;
}

/** paths.rs LAN_TO: the players a peer's LAN play sent UDP to since the last count, at most this many (a race has six players) */
export const LAN_TO = 8;

/**
 * paths.rs race_with: LAN play's UDP from a player to dst: noted in its lanTo (a Uint32Array(LAN_TO); Rust's
 * [AtomicU32; LAN_TO]).  Two places a destination may be at; a third that hashes there takes one of them (a count is
 * not worse for it).
 * @param {Uint32Array} to
 * @param {number} dst
 */
export function raceWith(to, dst) {
  if (to.length !== LAN_TO) throw new RangeError('raceWith: LAN_TO places');
  dst >>>= 0;
  const h = Math.imul(dst, 0x9E3779B1) >>> 29;
  const x = to[h], y = to[h ^ 1];
  if (x === dst || y === dst) return;
  if (x === 0) to[h] = dst;
  else to[h ^ 1] = dst;
}

/**
 * paths.rs take: what raceWith noted since the last time, pushed onto out, and none kept
 * @param {Uint32Array} to
 * @param {number[]} out
 */
export function take(to, out) {
  for (let i = 0; i < to.length; i++) {
    const d = to[i];
    to[i] = 0;
    if (d !== 0) out.push(d);
  }
}

/**
 * paths.rs Seen: one player as the counts see it: its address, country (code; 0 not known) and round trip (lag.js
 * Probe.base(): null before its first pong).
 */
export class Seen {
  /** @param {number} vip @param {number} country @param {number|null} base */
  constructor(vip, country, base) {
    this.vip = vip >>> 0;
    this.country = country;
    this.base = base ?? null;
  }
}

/** paths.rs p50_90: the median and the 90th percentile (nearest rank) of v, sorted here; null for none */
export function p50And90(v) {
  if (v.length === 0) return null;
  v.sort(totalCmp);
  const at = (p) => v[Math.min(Math.max(Math.ceil(p * v.length), 1), v.length) - 1];
  return [at(0.5), at(0.9)];
}

/** paths.rs spread: "n p50/p90" of round trips (ms, whole) */
function spread(v) {
  const p = p50And90(v);
  return p === null ? '0' : `${v.length} ${fixed(p[0])}/${fixed(p[1])}`;
}

/** paths.rs TOP_COUNTRIES: the countries most players are in, the most first, then one entry for the rest */
export const TOP_COUNTRIES = 12;

/**
 * paths.rs lines: the counts' lines (without "[players] "): the round trips by country and by region, and the pairs'
 * of free roam (roam, the hub's links now) and of LAN play (lan, since the last count), each pair once.  None while
 * no player has a round trip yet.
 * @param {Seen[]} players
 * @param {Array<[number, number]>} roam
 * @param {Array<[number, number]>} lan
 * @returns {string[]}
 */
export function lines(players, roam, lan) {
  const out = [];
  const timed = players.filter((p) => p.base != null);
  if (timed.length === 0) return out;
  const untimed = players.length - timed.length;
  const all = timed.map((p) => p.base);
  // by country, the unknown ones last
  /** @type {Map<number, number[]>} */
  const by = new Map();
  for (const p of timed) {
    let v = by.get(p.country);
    if (v === undefined) by.set(p.country, (v = []));
    v.push(p.base);
  }
  const unknown = by.get(0) ?? [];
  by.delete(0);
  const countries = [...by.entries()];
  countries.sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  let l = 'round trips to the server by country (each player\'s lowest of the last 30-60 s, players and ms p50/p90): all ' +
    spread(all);
  for (const [c, v] of countries.slice(0, TOP_COUNTRIES)) l += '; ' + letters(c) + ' ' + spread(v);
  if (countries.length > TOP_COUNTRIES) {
    const rest = countries.slice(TOP_COUNTRIES).flatMap(([, v]) => v);
    l += '; ' + (countries.length - TOP_COUNTRIES) + ' more countries ' + spread(rest);
  }
  if (unknown.length > 0) l += '; unknown ' + spread(unknown);
  if (untimed > 0) l += '; ' + untimed + ' not timed yet';
  out.push(l);
  // by region, the most first
  const regions = REGIONS.map(() => []);
  for (const p of timed) regions[region(p.country)].push(p.base);
  const order = [];
  for (let r = 1; r < REGIONS.length; r++) if (regions[r].length > 0) order.push(r);
  order.sort((a, b) => regions[b].length - regions[a].length); // stable, as Rust's sort_by_key
  if (regions[0].length > 0) order.push(0);
  l = 'round trips to the server by region:';
  order.forEach((r, i) => {
    l += (i === 0 ? '' : ';') + ' ' + REGIONS[r] + ' ' + spread(regions[r]);
  });
  out.push(l);
  // the pairs
  /** @type {Map<number, Seen>} */
  const at = new Map();
  for (const p of players) at.set(p.vip >>> 0, p);
  const r1 = pairs(at, roam);
  if (r1 !== null) out.push('free-roam links now: ' + r1);
  const r2 = pairs(at, lan);
  if (r2 !== null) out.push('LAN play\'s pairs since the last count (races, their lobbies): ' + r2);
  return out;
}

/**
 * paths.rs pairs: one kind of pairs: how many, the shares of one country and one region (of those whose two countries
 * are known), and the way from one player to the other through the server (both round trips together): all, within
 * one region, across regions.  null for no pair of two players on the switch.
 */
function pairs(at, list) {
  let n = 0, known = 0, country = 0, region_ = 0;
  const all = [], same = [], across = [];
  for (const [va, vb] of list) {
    const a = at.get(va >>> 0), b = at.get(vb >>> 0);
    if (a === undefined || b === undefined) continue;
    n += 1;
    const both = a.country !== 0 && b.country !== 0;
    const one = both && region(a.country) === region(b.country);
    if (both) {
      known += 1;
      if (a.country === b.country) country += 1;
      if (one) region_ += 1;
    }
    if (a.base != null && b.base != null) {
      const x = a.base, y = b.base;
      all.push(x + y);
      if (both) {
        if (one) same.push(x + y);
        else across.push(x + y);
      }
    }
  }
  if (n === 0) return null;
  const pct = (k) => (known === 0 ? 0.0 : (100.0 * k) / known);
  let l = n + ' ' + (n === 1 ? 'pair' : 'pairs') + ' of players';
  if (known > 0) {
    l += ', ' + fixed(pct(country)) + ' % in one country and ' + fixed(pct(region_)) + ' % in one region (of the ' + known +
      ' whose countries are known)';
  }
  l += '; from one player to the other through the server (their round trips together, pairs and ms p50/p90): all ' +
    spread(all) + ', within one region ' + spread(same) + ', across regions ' + spread(across);
  return l;
}
