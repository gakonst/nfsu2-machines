// The routes whose answers come from the server's state rather than from files: /players, /seen, GET /lan (the
// check), /names and /friends, plus the /lan upgrade's budget checks.  Ports of web/server-rs/src/app/mod.rs
// (send_players, send_seen), lan.rs (send_lan_check, the budget part of on_upgrade), days.rs (id_ok, Seen),
// settings_days.rs (Report::parse), names.rs and friends.rs (the HTTP shells; the stores they ask, nfsu2-claims,
// nfsu2-vault, the Online host's buddy lists and the free-roam hub, are services passed in).
//
// These are pure functions over the state they are given: the Switch Durable Object (web/worker/src/switch/do.js)
// holds that state and calls them; the Worker forwards the request to it (docs/INTERNAL.md).  Each returns an
// "answer": {status, type, body, headers, cache, noindex}, which the Worker turns into the Response with the headers
// every answer carries (routes.js answerResponse).  Nothing here reads a clock: nowMs is passed in.

import { Rate } from './limits.js';

// ---- answers -----------------------------------------------------------------------

/** An answer as plain() writes it (mod.rs App::plain): the text and a newline, text/plain, extra headers. */
export function plainAnswer(status, text, extra = [], cache = 'store', noindex = true) {
  return { status, type: 'text/plain; charset=utf-8', body: text + '\n', headers: extra, cache, noindex };
}

/** An answer as json() writes it (names.rs App::json): a JSON answer, never cached. */
export function jsonAnswer(status, value) {
  return { status, type: 'application/json', body: JSON.stringify(value), headers: [], cache: 'store', noindex: true };
}

/** mod.rs not_found */
export function notFoundAnswer() {
  return plainAnswer(404, 'Not found');
}

/** The DO's reply to the Worker for an internal request: the answer as JSON (docs/INTERNAL.md). */
export const ANSWER_TYPE = 'application/x-nfsu2-answer+json';

/** The Response a Durable Object returns for an answer (the Worker's routes.js reads it back with answerResponse). */
export function internalResponse(ans) {
  assertAnswer(ans);
  return new Response(JSON.stringify(ans), { status: 200, headers: { 'content-type': ANSWER_TYPE } });
}

/** throws unless ans is an answer */
export function assertAnswer(ans) {
  if (!ans || !Number.isInteger(ans.status) || ans.status < 100 || ans.status > 599) throw new Error('not an answer: status');
  if (ans.body !== null && ans.body !== undefined && typeof ans.body !== 'string') throw new Error('not an answer: body');
  if (ans.headers && !Array.isArray(ans.headers)) throw new Error('not an answer: headers');
}

/** What the Worker tells the DO about the request it forwards (headers x-nfsu2-ids, x-nfsu2-own-page): the client's
 * address key and site key as Rust computes them (key, siteKey: what its budgets and rates count by), its group and
 * site ids (lan.js groupId: the keys under a keyed hash, as the switch and the Online host hold them), and whether
 * the request comes from one of this server's own pages (mod.rs own_page). */
export function internalRequestInfo(request) {
  const ids = JSON.parse(request.headers.get('x-nfsu2-ids') ?? '{"key":"","siteKey":"","group":"","site":""}');
  for (const k of ['key', 'siteKey', 'group', 'site']) if (typeof ids[k] !== 'string') throw new Error('x-nfsu2-ids: {key, siteKey, group, site}');
  return { key: ids.key, siteKey: ids.siteKey, group: ids.group, site: ids.site, ownPage: request.headers.get('x-nfsu2-own-page') === '1' };
}

// ---- numbers as Rust parses them ------------------------------------------------------

/** Rust's str::parse::<u32>(): an optional "+", then decimal digits, at most 2^32 - 1; else null. */
export function parseU32(s) {
  if (typeof s !== 'string' || !/^\+?[0-9]+$/.test(s)) return null;
  const d = s.replace(/^\+/, '').replace(/^0+(?=.)/, '');
  if (d.length > 10) return null;
  const v = Number(d);
  return v <= 0xffffffff ? v : null;
}

// ---- /players ----------------------------------------------------------------------

/** Port of mod.rs ROOMS_ASKED: /players' rooms, at most this many asked at once. */
export const ROOMS_ASKED = 8;
/** Port of mod.rs SPOTS_ASKED: /players' spots, at most this many. */
export const SPOTS_ASKED = 16;
/** Port of nfsu2_roam::CREWS (wire.rs): the crews a player is in, at most. */
export const CREWS = 4;

/** Port of mod.rs send_players' body: how many play on this server now: three counts, whether it is full and
 * whether free roam is busy, nothing else.  st = {players: the switch's peer count, full: bool, queue: the pages
 * waiting in line, online: {personas, racing} (the Online host's info; null with no Online host or no answer in
 * 2 s), roam: null with no hub, else {inRoam(), crowded(), inWorld(hash), inRoom(hash), inCrews(hashes) -> counts}}.
 * params: the request's URLSearchParams.  Returns the JSON text exactly as Rust writes it. */
export function playersBody(st, params) {
  const players = st.players;
  if (!Number.isInteger(players) || players < 0) throw new Error('playersBody: players');
  let online = null;
  if (st.online) {
    const n = (k) => (typeof st.online[k] === 'number' ? st.online[k] : NaN);
    const x = n('personas') + n('racing');
    // Math.min: NaN when either is (written as null)
    online = Number.isNaN(x) ? null : Math.min(players, x);
  }
  // (Math.min as online: the hub's last tick and the switch now, a player who just left may still be in it)
  const r = st.roam ?? null;
  const m = {
    players,
    online,
    roam: r ? Math.min(r.inRoam(), players) : null,
    full: !!st.full,
    queue: st.queue,
    roamBusy: !!(r && r.crowded()),
  };
  const room = parseU32(params.get('room'));
  if (room !== null && room !== 0 && r) m.room = Math.min(r.inWorld(room), players);
  const list = (name, max, keep) => {
    const v = params.get(name);
    if (v === null) return [];
    const out = [];
    for (const h of v.split(',')) {
      const x = parseU32(h);
      if (x === null || !keep(x)) continue;
      out.push(x);
      if (out.length === max) break;
    }
    return out;
  };
  const rooms = list('rooms', ROOMS_ASKED, () => true);
  if (r && rooms.length) m.rooms = rooms.map((h) => Math.min(r.inWorld(h), players));
  const spots = list('spots', SPOTS_ASKED, () => true);
  if (r && spots.length) m.spots = spots.map((h) => Math.min(r.inRoom(h), players));
  const crews = list('crews', CREWS, (h) => h !== 0);
  if (r && crews.length) m.crews = r.inCrews(crews).map((n) => Math.min(n, players));
  return JSON.stringify(m);
}

/** Port of mod.rs send_players: the answer (200, application/json, never cached). */
export function playersAnswer(st, params) {
  return { status: 200, type: 'application/json', body: playersBody(st, params), headers: [], cache: 'store', noindex: true };
}

// ---- /seen ------------------------------------------------------------------------

/** Port of days.rs enum Seen (its order is the sets' order). */
export const Seen = Object.freeze({ Page: 0, Play: 1, Roam: 2, Online: 3 });

/** Port of days.rs id_ok: a page id as the page makes them (22 characters of base64url; 64 at most). */
export function idOk(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id);
}

/** Port of settings_days.rs DEVICES: the kinds of device a report names (k). */
export const DEVICES = Object.freeze(['pc', 'phone', 'tablet']);
const MAX_TOLD = 4096;
const MAX_A_REPORT = 64;

/** Port of settings_days.rs key_ok: a setting's name as the page writes it. */
export function keyOk(k) {
  return k.length >= 1 && k.length <= 32 && /^[a-z0-9_]+$/.test(k);
}

/** Port of settings_days.rs value_ok: a value as the page writes it. */
export function valueOk(v) {
  return v.length >= 1 && v.length <= 24 && /^[A-Za-z0-9:._+-]+$/.test(v);
}

/** Port of settings_days.rs Report::parse: k and s of a /seen?at=play as {device, pairs}; null without them or with a
 * device this does not know.  A pair that is not key=value as the page writes them is skipped, and a setting told
 * twice counts once.  (Rust's s.len() counts UTF-8 bytes.) */
export function reportParse(k, s) {
  const device = DEVICES.indexOf(k);
  if (device < 0 || s === null || s === undefined) return null;
  if (new TextEncoder().encode(s).length > MAX_TOLD) return null;
  const pairs = [];
  for (const p of s.split(',')) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const key = p.slice(0, i);
    const value = p.slice(i + 1);
    if (!keyOk(key) || !valueOk(value) || pairs.some(([x]) => x === key)) continue;
    if (pairs.length === MAX_A_REPORT) break;
    pairs.push([key, value]);
  }
  return { device, pairs };
}

/** Port of mod.rs send_seen's counting: /seen?at=page|play&id=<the page's id> counted for the day (days.seen), a
 * day's first Play's device and settings too (days.told).  days = {seen(id, what, nowMs), told(id, report, nowMs)}
 * (days.rs Days, which checks id_ok itself).  Returns what was counted, for tests. */
export function seenCall(days, params, method, nowMs) {
  const at = params.get('at');
  const what = at === 'page' ? Seen.Page : at === 'play' ? Seen.Play : null;
  const id = params.get('id');
  if (what === null || id === null || method !== 'GET') return null;
  days.seen(id, what, nowMs);
  let report = null;
  if (what === Seen.Play) {
    report = reportParse(params.get('k'), params.get('s'));
    if (report) days.told(id, report, nowMs);
  }
  return { id, what, report };
}

/** Port of mod.rs send_seen's answer: 204, no body, whatever it said. */
export function seenAnswer() {
  return { status: 204, type: null, body: null, headers: [], cache: 'store', noindex: true };
}

// ---- /lan's budgets ----------------------------------------------------------------

/** Port of mod.rs limits: /lan connections at once per client and per site, opening them (a burst, then a rate). */
export const WS_PER_ADDRESS = 8;
export const WS_PER_SITE = 16;
export const LAN_OPEN_BURST = 20.0;
export const LAN_OPEN_RATE = 1.0;

/** Port of lan.rs send_lan_check's budget part over the DO's LanGate (lan_gate.js): "busy" | "fast" | "ok". */
export function lanCheck(gate, key, site, nowMs) {
  return gate.check(key, site ?? '', nowMs);
}

/** Port of lan.rs send_lan_check's answer: {"lan":"ok"|"busy"|"fast"|"page"}. */
export function lanCheckAnswer(v) {
  if (!['ok', 'busy', 'fast', 'page'].includes(v)) throw new Error('lanCheckAnswer: ' + v);
  return { status: 200, type: 'application/json', body: '{"lan":"' + v + '"}', headers: [], cache: 'store', noindex: true };
}

/** The DO's reply to the Worker's /lan-check for a check's answer ("ok" | "busy" | "fast"): the Worker makes the
 * client's Response from it with every answer's headers (routes.js answerResponse), exactly as Rust's
 * send_lan_check writes it. */
export function lanCheckResponse(answer) {
  return internalResponse(lanCheckAnswer(answer));
}

// ---- /names ------------------------------------------------------------------------

/** Port of names.rs limits: per client (and twice that per site) READ_BURST reads, then READ_RATE a second;
 * CLAIM_BURST claims, then CLAIM_PER_DAY a day. */
export const NAMES_READ_BURST = 120.0;
export const NAMES_READ_RATE = 2.0;
export const CLAIM_BURST = 10.0;
export const CLAIM_PER_DAY = 10.0;
/** names.rs MAX_BODY: the most of a claim's body */
export const NAMES_MAX_BODY = 4096;

/** Port of names.rs token: Bearer <43 characters of base64url>, the keyphrase's token (as /vault takes it), or null */
export function bearerToken(authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  const t = authorization.slice(7);
  return t.length === 43 && /^[A-Za-z0-9_-]+$/.test(t) ? t : null;
}

/** Port of names.rs NamesRoute: the store (claims: the nfsu2-claims port), Cloudflare's check (turnstile: {site,
 * passed(answer) -> Promise<bool>} or null), the limits.  claims = {status(name, owner, now) -> {kind:"invalid"|
 * "default"|"blocked"|"free"|"yours"|"taken", until, current}, mine(owner, now) -> {name, until, next_change}|null,
 * claim(name, owner, now) -> {mine} | {refusal: {kind, next}}, clean(name) -> string|null, ownerOfToken(token) ->
 * string|null}; denied(name) -> bool (the operator's renames, nfsu2-bans deny); keyphraseKnown(token, now) ->
 * Promise<bool> (nfsu2-vault meta: the cloud has the keyphrase; null: no vault, a 404). */
export class NamesRoute {
  constructor({ claims, turnstile = null, denied = () => false, keyphraseKnown = null }) {
    this.claims = claims;
    this.turnstile = turnstile;
    this.denied = denied;
    this.keyphraseKnown = keyphraseKnown;
    this.reads = new Rate(NAMES_READ_BURST, NAMES_READ_RATE);
    this.claimed = new Rate(CLAIM_BURST, CLAIM_PER_DAY / 86400.0);
  }
  prune(nowMs) {
    this.reads.prune(nowMs);
    this.claimed.prune(nowMs);
  }
}

/** Port of names.rs status_json */
function statusJson(claims, name, s) {
  const m = { name: claims.clean(name), state: null };
  let until = null;
  switch (s.kind) {
    case 'yours':
      m.state = s.current ? 'yours' : 'old';
      until = s.until;
      break;
    case 'invalid': case 'default': case 'blocked': case 'free': case 'taken':
      m.state = s.kind;
      break;
    default:
      throw new Error('a claim status: ' + s.kind);
  }
  if (until !== null) m.until = until;
  return m;
}

/** Port of names.rs mine_json */
function mineJson(m) {
  return { name: m.name, until: m.until, next: m.next_change };
}

/** Port of names.rs App::name_status: a name's claim as owner sees it; one the operator took away as one that reads
 * as a slur. */
function nameStatus(n, name, owner, now) {
  const s = n.claims.status(name, owner, now);
  if (s.kind === 'invalid' || s.kind === 'default') return s;
  return n.denied(name) ? { kind: 'blocked' } : s;
}

/** Port of names.rs App::names (the route): n is a NamesRoute or null (no keyphrase saves: 404).  req = {method,
 * params (URLSearchParams), authorization, secFetchSite, body: Uint8Array|null (null: too large), ownPage, key,
 * siteKey (the rates' keys), group, site} (internalReq makes it).  Returns a Promise of an answer. */
export async function namesAnswer(n, req, nowMs) {
  if (!n) return notFoundAnswer();
  const siteOk = req.secFetchSite == null || req.secFetchSite === 'same-origin';
  if (!req.ownPage || !siteOk) return plainAnswer(403, 'Forbidden');
  const key = req.key;
  const site = req.siteKey ?? '';
  const now = nowMs;
  const t = bearerToken(req.authorization);
  const owner = t ? n.claims.ownerOfToken(t) : null;
  const tooMany = () => plainAnswer(429, 'Too many requests', [['retry-after', '60']]);
  if (req.method === 'GET') {
    if (!n.reads.take(key, site, now)) return tooMany();
    const name = req.params.get('name') ?? '';
    const v = statusJson(n.claims, name, nameStatus(n, name, owner, now));
    const alt = req.params.get('alt');
    if (alt !== null) v.alt = statusJson(n.claims, alt, nameStatus(n, alt, owner, now));
    const mine = owner ? n.claims.mine(owner, now) : null;
    if (mine) {
      const j = mineJson(mine);
      if (n.denied(mine.name)) j.blocked = true;
      v.mine = j;
    }
    if (n.turnstile) v.captcha = n.turnstile.site;
    return jsonAnswer(200, v);
  }
  if (req.method === 'POST') {
    if (!t || !owner) return jsonAnswer(401, { error: 'keyphrase' });
    if (req.body === null) return jsonAnswer(413, { error: 'large' });
    let b;
    try {
      b = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body));
    } catch {
      b = null;
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return jsonAnswer(400, { error: 'invalid' });
    const name = typeof b.name === 'string' ? b.name : '';
    const s = nameStatus(n, name, owner, now);
    if (s.kind === 'invalid') return jsonAnswer(400, { error: 'invalid' });
    if (s.kind === 'default') return jsonAnswer(400, { error: 'default' });
    if (s.kind === 'blocked') return jsonAnswer(400, { error: 'blocked' });
    if (s.kind === 'taken') return jsonAnswer(409, { error: 'taken' });
    if (s.kind === 'yours' && s.current) {
      const r = n.claims.claim(name, owner, now);
      if (!r.mine) throw new Error('claims: its own name');
      return jsonAnswer(200, { state: 'yours', mine: mineJson(r.mine) });
    }
    const m = n.claims.mine(owner, now);
    if (m && m.next_change > now) return jsonAnswer(429, { error: 'soon', next: m.next_change });
    if (!n.claimed.take(key, site, now)) return tooMany();
    if (!n.keyphraseKnown) return notFoundAnswer();
    if (!(await n.keyphraseKnown(t, now))) return jsonAnswer(404, { error: 'keyphrase' });
    if (n.turnstile) {
      const answer = typeof b.captcha === 'string' ? b.captcha : '';
      let passed;
      try {
        passed = await n.turnstile.passed(answer);
      } catch {
        return jsonAnswer(503, { error: 'captcha-down' });
      }
      if (!passed) return jsonAnswer(403, { error: 'captcha' });
    }
    const r = n.claims.claim(name, owner, now);
    if (r.mine) return jsonAnswer(200, { state: 'yours', mine: mineJson(r.mine) });
    const k = r.refusal.kind;
    if (k === 'invalid' || k === 'default' || k === 'blocked') return jsonAnswer(400, { error: k });
    if (k === 'taken') return jsonAnswer(409, { error: 'taken' });
    if (k === 'soon') return jsonAnswer(429, { error: 'soon', next: r.refusal.next });
    if (k === 'full') return jsonAnswer(507, { error: 'full' });
    throw new Error('a claim refusal: ' + k);
  }
  return plainAnswer(405, 'Method not allowed', [['allow', 'GET, POST'], ['connection', 'close']]);
}

// ---- /friends ----------------------------------------------------------------------

/** Port of friends.rs limits (the ones /friends takes). */
export const FRIENDS_READ_BURST = 60.0;
export const FRIENDS_READ_RATE = 1.0;
export const MSG_BURST = 3.0;
export const MSG_RATE = 0.5;
export const ASK_BURST = 5.0;
export const ASK_RATE = 1.0 / 30.0;
export const INVITE_BURST = 6.0;
export const INVITE_RATE = 1.0 / 5.0;
export const DISCORD_BURST = 5.0;
export const DISCORD_RATE = 1.0 / 10.0;
/** friends.rs MAX_BODY: the most of a POST's body */
export const FRIENDS_MAX_BODY = 1024;
/** nfsu2_online::PAGE_MSG_LEN (buddy.rs): a page message's characters at most */
export const PAGE_MSG_LEN = 120;

/** Port of friends.rs Friends (the part /friends uses): the limits, and svc, the services behind it: {ownerOfToken(t),
 * lists(owner, group, ask) -> Promise<reply> (Online host friends()), told(name, me, owner, group, done) -> Promise,
 * pageJson(reply) -> Promise<object>, crewInvite(owner, group, name, crew, room) -> Promise<[reply, done]>,
 * claimedName(name, now) -> string|null (claims.holder then mine().name)}.  ask is {op, name, body?, yes?} for
 * FriendAsk::{ListMail, Send, AskByName, Discord, Answer, Remove, Block}. */
export class FriendsRoute {
  constructor(svc) {
    this.svc = svc;
    this.reads = new Rate(FRIENDS_READ_BURST, FRIENDS_READ_RATE);
    this.msgs = new Rate(MSG_BURST, MSG_RATE);
    this.asks = new Rate(ASK_BURST, ASK_RATE);
    this.invites = new Rate(INVITE_BURST, INVITE_RATE);
    this.discords = new Rate(DISCORD_BURST, DISCORD_RATE);
  }
  prune(nowMs) {
    for (const r of [this.reads, this.msgs, this.asks, this.invites, this.discords]) r.prune(nowMs);
  }
}

/** the first n characters (Rust's chars().take(n)) */
function chars(s, n) {
  return Array.from(s).slice(0, n).join('');
}

/** Port of friends.rs App::friends_route: f is a FriendsRoute or null (404).  req as for namesAnswer. */
export async function friendsAnswer(f, req, nowMs) {
  if (!f) return notFoundAnswer();
  const siteOk = req.secFetchSite == null || req.secFetchSite === 'same-origin';
  if (!req.ownPage || !siteOk) return plainAnswer(403, 'Forbidden');
  const key = req.key;
  const site = req.siteKey ?? '';
  if (!f.reads.take(key, site, nowMs)) return plainAnswer(429, 'Too many requests', [['retry-after', '60']]);
  const t = bearerToken(req.authorization);
  const owner = t ? f.svc.ownerOfToken(t) : null;
  if (!owner) return jsonAnswer(401, { error: 'keyphrase' });
  const group = req.group;
  let ask;
  if (req.method === 'GET') {
    ask = { op: 'list-mail' };
  } else if (req.method === 'POST') {
    if (req.body === null) return jsonAnswer(413, { error: 'large' });
    let b;
    try {
      b = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body));
    } catch {
      b = null;
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return jsonAnswer(400, { error: 'invalid' });
    const name = chars(typeof b.name === 'string' ? b.name : '', 64);
    const op = typeof b.op === 'string' ? b.op : null;
    const rate = () => jsonAnswer(200, { done: 'rate' });
    if (op === 'msg') {
      if (!f.msgs.take(owner, '', nowMs)) return rate();
      ask = { op: 'send', name, body: chars(typeof b.body === 'string' ? b.body : '', PAGE_MSG_LEN) };
    } else if (op === 'ask') {
      if (!f.asks.take(owner, '', nowMs)) return rate();
      // the name as its claim spells it (a typed "bo" asks "Bo_"); nobody's: as typed
      ask = { op: 'ask-by-name', name: f.svc.claimedName(name, nowMs) ?? name };
    } else if (op === 'discord') {
      if (!f.discords.take(owner, '', nowMs)) return rate();
      ask = { op: 'discord', name };
    } else if (op === 'crew') {
      if (!f.invites.take(owner, '', nowMs)) return rate();
      const text = (k) => chars(typeof b[k] === 'string' ? b[k] : '', 64);
      const [r, done] = await f.svc.crewInvite(owner, group, name, text('crew'), text('room'));
      const v = await f.svc.pageJson(r);
      v.done = done;
      return jsonAnswer(200, v);
    } else if (op === 'accept' || op === 'decline') {
      ask = { op: 'answer', name, yes: op === 'accept' };
    } else if (op === 'remove' || op === 'block') {
      ask = { op, name };
    } else {
      return jsonAnswer(400, { error: 'invalid' });
    }
  } else {
    return plainAnswer(405, 'Method not allowed', [['allow', 'GET, POST'], ['connection', 'close']]);
  }
  const asked = ask.op === 'ask-by-name' || (ask.op === 'answer' && ask.yes) ? ask.name : null;
  const r = await f.svc.lists(owner, group, ask);
  if (asked !== null && r && r.me) await f.svc.told(asked, r.me, owner, group, r.done);
  return jsonAnswer(200, await f.svc.pageJson(r));
}


/** The request a Durable Object got from the Worker's forward (routes.js), as namesAnswer and friendsAnswer take it:
 * {method (the client's: x-nfsu2-method), params, authorization, secFetchSite, body (at most max bytes, else null),
 * ownPage, key, siteKey, group, site}. */
export async function internalReq(request, max) {
  const info = internalRequestInfo(request);
  const method = request.headers.get('x-nfsu2-method') ?? request.method;
  let body = new Uint8Array(0);
  if (request.body) {
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > max) {
      await request.body.cancel();
      body = null;
    } else {
      const reader = request.body.getReader();
      const parts = [];
      let n = 0;
      for (let guard = 0; guard < 1 << 20; guard++) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > max) {
          await reader.cancel();
          body = null;
          break;
        }
        parts.push(value);
      }
      if (body !== null) {
        body = new Uint8Array(n);
        let at = 0;
        for (const p of parts) {
          body.set(p, at);
          at += p.length;
        }
      }
    }
  }
  return {
    method,
    params: new URL(request.url).searchParams,
    authorization: request.headers.get('authorization'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    body,
    ownPage: info.ownPage,
    key: info.key,
    siteKey: info.siteKey,
    group: info.group,
    site: info.site,
  };
}


/** The DO's dispatcher of the Worker's internal requests (docs/INTERNAL.md): the Response for /players, /lan-check,
 * /seen, /names and /friends, or null for anything else (the /lan upgrade is the DO's own).  view = {peerCount(),
 * full(), waiting(), nowMs, gate (lan_gate.js LanGate), online: {personas, racing} | null (or a function giving it),
 * roam: the hub's counts | null, days: {seen, told} | null, names: NamesRoute | null, friends: FriendsRoute | null}. */
export async function handle(request, view) {
  const u = new URL(request.url);
  if (request.headers.get('x-lan-opts') !== null) return null;
  const now = view.nowMs;
  if (typeof now !== 'number') throw new Error('handle: view.nowMs');
  switch (u.pathname) {
    case '/players': {
      const online = typeof view.online === 'function' ? await view.online() : (view.online ?? null);
      const st = { players: view.peerCount(), full: view.full(), queue: view.waiting(), online, roam: view.roam ?? null };
      return internalResponse(playersAnswer(st, u.searchParams));
    }
    case '/lan-check': {
      const info = internalRequestInfo(request);
      return lanCheckResponse(view.gate ? view.gate.check(info.key, info.siteKey, now) : 'ok');
    }
    case '/seen':
      if (view.days) seenCall(view.days, u.searchParams, request.headers.get('x-nfsu2-method') ?? request.method, now);
      return new Response(null, { status: 204 });
    case '/names':
      return internalResponse(await namesAnswer(view.names ?? null, await internalReq(request, NAMES_MAX_BODY), now));
    case '/friends':
      return internalResponse(await friendsAnswer(view.friends ?? null, await internalReq(request, FRIENDS_MAX_BODY), now));
    default:
      return null;
  }
}

