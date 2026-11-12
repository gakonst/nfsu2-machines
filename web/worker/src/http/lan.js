// /lan: the WebSocket upgrade's checks, port of web/server-rs/src/app/lan.rs on_upgrade (and what it calls:
// nfsu2_ws::pick_protocol, mod.rs own_host / own_page / client / group_id).  The checks that need the server's state
// (the client's /lan connections, how fast it opens them) are the Switch DO's (lan_gate.js LanGate.take), in Rust's
// order: the Worker passes the subprotocols' verdict on in opts (protocol, protocolBad) so that a malformed list is
// still refused after the 429s, where Rust (and the Node server's ws library before it) refused it.

import { addressKey, siteKey, bareIp, clientCountry } from './headers.js';
import { appOf, refuseResponse, ownHost, ownPage } from './routes.js';
import { base64url, hmacSha256 } from './etag.js';

/** Port of lan.rs ws_key: /^[+/0-9A-Za-z]{22}==$/ */
export function wsKey(k) {
  return /^[+/0-9A-Za-z]{22}==$/.test(k);
}

/** Port of nfsu2_ws is_token (validation.js's tokenChars): the characters of an HTTP token (RFC 7230). */
function isToken(c) {
  return /^[!#$%&'*+\-.0-9A-Z^_\x60a-z|~]$/.test(c);
}

/** Port of nfsu2_ws pick_protocol: ws's reading of a Sec-WebSocket-Protocol header: {ok:true, protocol:null} when
 * there is none, {ok:true, protocol:first} for the protocol ws picks (the first), {ok:false} when it is malformed
 * (tokens separated by commas, spaces and tabs around them but not first, no empty item, no token twice; an empty
 * header is malformed too). */
export function pickProtocol(h) {
  if (h === null || h === undefined) return { ok: true, protocol: null };
  const seen = new Set();
  let first = null;
  let start = -1;
  let end = -1;
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (end < 0 && isToken(c)) {
      if (start < 0) start = i;
    } else if (i !== 0 && (c === ' ' || c === '\t')) {
      if (end < 0 && start >= 0) end = i;
    } else if (c === ',') {
      if (start < 0) return { ok: false };
      const p = h.slice(start, end < 0 ? i : end);
      if (seen.has(p)) return { ok: false };
      seen.add(p);
      if (first === null) first = p;
      start = -1;
      end = -1;
    } else {
      return { ok: false };
    }
  }
  if (start < 0 || end >= 0) return { ok: false };
  const p = h.slice(start);
  if (seen.has(p)) return { ok: false };
  return { ok: true, protocol: first ?? p };
}

/** The client's address on Workers: CF-Connecting-IP (Cloudflare sets it and replaces what a client sent), its
 * first comma item as Rust's client_ip reads it from a trusted proxy; "" when it is no address. */
export function clientIp(request) {
  const first = (request.headers.get('cf-connecting-ip') ?? '').split(',')[0];
  return bareIp(first);
}

/** Port of mod.rs App::client: the client's address, and the keys its budgets count by. */
export function client(request) {
  const ip = clientIp(request);
  return { ip, key: addressKey(ip), site: siteKey(ip) };
}

/** Port of mod.rs App::group_id: the client's (or site's) budget key under a keyed hash (HMAC-SHA256, base64url, 22
 * characters), so the switch can count by it without ever holding the address.  key: the bytes of env.LAN_ID_KEY. */
export async function groupId(lanKey, key) {
  return base64url(await hmacSha256(lanKey, new TextEncoder().encode(key))).slice(0, 22);
}

/** Port of lan.rs on_upgrade's stateless checks, for a request that asks for an upgrade: the target, the Host, the
 * path, the handshake, the Origin, in that order (each refusal Rust's raw answer for its code, refuseResponse).  The
 * per-address checks are the DO's (lan_gate.js LanGate.take(key, site, nowMs, opts)), then the subprotocols, whose
 * verdict travels in opts.  Returns a Response (refused) or {key, site, opts}: key and site the client's address key
 * and site key as Rust computes them (headers.js addressKey, siteKey; "" when none), opts = {resume, queue, group,
 * site, ident, country, refuse, protocol, protocolBad} (opts.site: the site's id, null for none).  ident (nfsu2-bans'
 * keyed hash of the address) and refuse (a control message) are hooks for the bans and claims ports: null here. */
export async function lanUpgrade(request, env) {
  const app = await appOf(env);
  let u;
  try {
    u = new URL(request.url);
  } catch {
    return refuseResponse(400);
  }
  if (!ownHost(app, request)) return refuseResponse(421);
  if (u.pathname !== '/lan') return refuseResponse(404);
  // a WebSocket handshake, checked here so that every refusal looks the same
  const h = request.headers;
  const key = h.get('sec-websocket-key') ?? '';
  const upgrade = (h.get('upgrade') ?? '').toLowerCase() === 'websocket';
  if (request.method !== 'GET' || !upgrade || h.get('sec-websocket-version') !== '13' || !wsKey(key)) return refuseResponse(400);
  // only this server's own pages (a page of another site must not join the LAN through a player's browser); clients
  // without an Origin header (tools) may
  if (!ownPage(app, request)) return refuseResponse(403);
  const c = client(request);
  const picked = pickProtocol(h.get('sec-websocket-protocol'));
  const cf = request.cf;
  const opts = {
    // a reconnecting page says ?resume and sends its old address with the token in its first message
    resume: u.searchParams.has('resume'),
    // a page that can wait in line when every place is taken
    queue: u.searchParams.has('queue'),
    group: await groupId(app.lanKey, c.key),
    site: c.site !== '' ? await groupId(app.lanKey, 'site ' + c.site) : null,
    // hook: nfsu2-bans' Bans::addr(key) once the bans are ported (Rust: Some whenever the key is not empty)
    ident: null,
    // the client's country as Cloudflare names it (nfsu2-lan paths.rs's counts by country, nothing else)
    country: clientCountry(app.countryFromHeader ? h.get('cf-ipcountry') : (cf?.country ?? h.get('cf-ipcountry'))),
    refuse: null,
    protocol: picked.ok ? picked.protocol : null,
    protocolBad: !picked.ok,
  };
  return { key: c.key, site: c.site, opts };
}

