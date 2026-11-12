// The Worker's HTTP routes: port of web/server-rs/src/app/mod.rs (the router, plain(), headers()), files.rs
// (send_file), manifest.rs (/data-manifest), blocks.rs (/data-blocks/), wasm.rs (/game.wasm, /game.json) over the
// Worker's stores: the game's files in the R2 bucket env.GAME, the page in the static assets env.ASSETS (web/dist).
// Status codes, headers and bodies are Rust's; docs/INTERNAL.md says where the game's files live in R2 and which
// routes the Switch Durable Object answers (/players, /lan's check, /names, /friends, /seen's counting).

import {
  Cache, HostCheck, cacheHeaders, securityHeaders, isLocalOrIp, etagMatches, pickEncoding, clientCountry, EDGE_KEEP,
} from './headers.js';
import { etagOf, num, mtimeS, sha256Hex } from './etag.js';
import { buildManifest, BLOCK, BLOCKS_MAX, V2 } from './manifest.js';
import { resolveGame, resolveInside, devOnly, extname, typeOf, hasWord, rangeOf } from './files.js';
import { client, groupId } from './lan.js';
import {
  ANSWER_TYPE, assertAnswer, seenAnswer, lanCheckAnswer, plainAnswer, notFoundAnswer,
} from './state_routes.js';

/** Port of mod.rs ROBOTS_TXT */
export const ROBOTS_TXT =
  'User-agent: *\nAllow: /\nDisallow: /data/\nDisallow: /data-manifest\nDisallow: /game.wasm\nDisallow: /game.json\n' +
  'Disallow: /players\nDisallow: /seen\nDisallow: /lan\nDisallow: /vault\nDisallow: /names\nDisallow: /friends';

/** Port of blocks.rs ENCODERS: the encoders, in the server's order of preference.  The Worker does not compress
 * itself: it sets Content-Encoding and the runtime compresses the body (encodeBody "automatic"), which knows gzip and
 * br; WORKER_ENCODERS is what it offers (zstd left out: see docs/INTERNAL.md). */
export const ENCODERS = Object.freeze(['zstd', 'br', 'gzip']);
export const WORKER_ENCODERS = Object.freeze(['br', 'gzip']);
/** Port of blocks.rs PROBE: the bytes a run is judged by */
export const PROBE = 64 << 10;
/** Port of blocks.rs EDGE_WHILE (a block answered before it is kept; the Worker keeps none, so it is never sent) */
export const EDGE_WHILE = 'public, max-age=600';

/** a Uint8Array of a hex string (the keys' form in env), or null */
function hexKey(s) {
  if (typeof s !== 'string' || !/^([0-9a-fA-F]{2}){16,}$/.test(s.trim())) return null;
  const t = s.trim();
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const apps = new WeakMap();
const manifests = new WeakMap();

/** The App of an env (mod.rs App::new's part the Worker has): the Host check (env.HOSTS, comma list as --host), the
 * ETag key (env.ETAG_KEY, hex, 16 bytes or more: the state folder's etag.key), the /lan id key (env.LAN_ID_KEY, hex;
 * Rust's group_key, random at each start), HSTS (on unless env.HSTS is "off": the Worker is behind Cloudflare's TLS,
 * Rust's hsts_ok with --behind-proxy).  A key that is missing is made at random for this isolate (ETags and /lan ids
 * then differ between isolates: set them). */
export async function appOf(env) {
  let a = apps.get(env);
  if (a) return a;
  const hosts = String(env.HOSTS ?? '').split(',').map((h) => {
    const x = h.trim().toLowerCase();
    return x.endsWith('.') ? x.slice(0, -1) : x;
  }).filter((h) => h !== '');
  const random = () => crypto.getRandomValues(new Uint8Array(32));
  a = {
    hostCheck: new HostCheck(hosts),
    etagKey: hexKey(env.ETAG_KEY) ?? random(),
    lanKey: hexKey(env.LAN_ID_KEY) ?? random(),
    hstsOk: String(env.HSTS ?? 'on') !== 'off',
    // tests and local runs: CF-IPCountry as the client sent it, not request.cf.country
    countryFromHeader: String(env.COUNTRY_FROM ?? '') === 'header',
    names: String(env.NAMES ?? 'off') === 'on',
    friends: String(env.FRIENDS ?? 'off') === 'on',
    game: env.GAME ?? null,
    assets: env.ASSETS ?? null,
    switch: env.SWITCH ?? null,
  };
  apps.set(env, a);
  return a;
}

// ---- headers ---------------------------------------------------------------------

/** Port of mod.rs App::hsts_for: HSTS only over https, never for localhost or an IP literal. */
export function hstsFor(app, request) {
  return app.hstsOk && new URL(request.url).protocol === 'https:' && !isLocalOrIp(request.headers.get('host'));
}

/** Port of mod.rs App::headers: the security headers, then the cache headers, as a Headers object (Workers sends
 * them in its own order). */
export function baseHeaders(app, request, cache, noindex) {
  const h = new Headers();
  for (const [k, v] of securityHeaders(hstsFor(app, request), noindex)) h.set(k, v);
  for (const [k, v] of cacheHeaders(cache)) h.set(k, v);
  return h;
}

const enc = new TextEncoder();

/** a Response with the method's body rule (HEAD: none, its Content-Length kept) */
function respond(request, status, h, body, init = {}) {
  const head = request.method === 'HEAD' || status === 304 || status === 204;
  return new Response(head ? null : body, { status, headers: h, ...init });
}

/** Port of mod.rs App::plain: a short text answer: the code, the text (a newline after it), headers besides the
 * usual ones, the cache rule, and whether search engines are told to keep out. */
export function plain(app, request, code, text, extra = [], cache = Cache.Store, noindex = true) {
  const body = enc.encode(text + '\n');
  const h = baseHeaders(app, request, cache, noindex);
  h.set('content-type', 'text/plain; charset=utf-8');
  h.set('content-length', String(body.length));
  for (const [k, v] of extra) h.set(k, v);
  return respond(request, code, h, body);
}

/** Port of mod.rs App::not_found */
export function notFound(app, request) {
  return plain(app, request, 404, 'Not found');
}

/** Port of mod.rs App::bad_request */
function badRequest(app, request) {
  return plain(app, request, 400, 'Bad request');
}

/** Port of mod.rs App::raw_response: the answer for code written on the raw connection (refused upgrades): the same
 * headers as every answer, nothing else (no HSTS, noindex, no-store, Content-Length 0, Connection: close); a code it
 * has none for is the 400. */
export function refuseResponse(code) {
  const known = [400, 403, 404, 408, 421, 429, 431, 503];
  const c = known.includes(code) ? code : 400;
  const h = new Headers();
  for (const [k, v] of securityHeaders(false, true)) h.set(k, v);
  for (const [k, v] of cacheHeaders(Cache.Store)) h.set(k, v);
  h.set('content-length', '0');
  h.set('connection', 'close');
  return new Response(null, { status: c, headers: h });
}

/** An answer of state_routes.js as the Response, with the headers every answer carries (mod.rs plain / json /
 * send_players: the base headers, content-type, content-length, then the answer's own). */
export function answerResponse(app, request, ans) {
  assertAnswer(ans);
  const h = baseHeaders(app, request, ans.cache ?? Cache.Store, ans.noindex ?? true);
  const body = ans.body === null || ans.body === undefined ? null : enc.encode(ans.body);
  if (ans.type) h.set('content-type', ans.type);
  if (body !== null) h.set('content-length', String(body.length));
  for (const [k, v] of ans.headers ?? []) h.set(k, v);
  return respond(request, ans.status, h, body);
}

// ---- who asks ----------------------------------------------------------------------

/** Port of mod.rs App::own_host: the request's Host is one of this server's names.  (The Worker sees the request's
 * URL already absolute: Rust's absolute-form target check has nothing to read.) */
export function ownHost(app, request) {
  return app.hostCheck.check(request.headers.get('host'));
}

/** Port of mod.rs App::own_page: a request from one of this server's own pages, or from no page at all (tools send
 * no Origin): its Origin, when it has one, is the host it asked for and one of this server's names. */
export function ownPage(app, request) {
  const o = request.headers.get('origin');
  if (o === null || o === '') return true;
  let origin;
  try {
    origin = new URL(o).host.toLowerCase();
  } catch {
    return false;
  }
  const host = (request.headers.get('host') ?? '').toLowerCase();
  return host !== '' && host === origin && app.hostCheck.check(origin);
}

/** a header that is there and not empty (an empty one counts as none): mod.rs present */
function present(request, name) {
  const v = request.headers.get(name);
  return v !== null && v !== '';
}

/** the client's Accept-Encoding.  Cloudflare replaces the header on a request to a Worker with what its edge takes
 * (it compresses for the client itself) and keeps the client's own in request.cf.clientAcceptEncoding: the routes
 * choose by the client's, as Rust does by the header it got. */
export function acceptEncoding(request) {
  const cf = request.cf;
  if (cf && typeof cf.clientAcceptEncoding === 'string') return cf.clientAcceptEncoding;
  return request.headers.get('accept-encoding');
}

/** whether a request asks for an upgrade (Rust's engine: Connection: upgrade and an Upgrade header; Workers may not
 * show Connection, so an Upgrade header with no Connection header counts) */
export function isUpgrade(request) {
  const up = request.headers.get('upgrade');
  if (up === null || up === '') return false;
  const c = request.headers.get('connection');
  return c === null || c.toLowerCase().split(',').some((t) => t.trim() === 'upgrade');
}

// ---- the game's files in R2 ---------------------------------------------------------

/** A game file's version as Rust's ETag names it: its real path (customMetadata.path, else "r2:" + its key), its
 * size and its time (customMetadata.mtimeMs, Node's String(stat.mtimeMs); else the upload time). */
export function versionOf(obj) {
  const md = obj.customMetadata ?? {};
  const m = md.mtimeMs !== undefined && md.mtimeMs !== '' && Number.isFinite(Number(md.mtimeMs)) ? Number(md.mtimeMs) : obj.uploaded.getTime();
  return { path: md.path ?? 'r2:' + obj.key, size: obj.size, mtimeMs: m };
}

/** Port of etag.rs of_file over an R2 object */
export async function fileEtag(app, obj) {
  const v = versionOf(obj);
  return etagOf(app.etagKey, [v.path, num(v.size), num(v.mtimeMs)]);
}

/** Port of files.rs send_file over a source: src = {size, etag, type (by the real file's extension), body(a, b) ->
 * Promise<BodyInit> (bytes a..b inclusive)}; o = {type, cache, extra, noindex}.  One byte range (206, 416), 304, HEAD,
 * and the bytes; null src: 404. */
export async function sendFile(app, request, src, o = {}) {
  if (!src) return notFound(app, request);
  const cache = o.cache ?? Cache.Store;
  const noindex = o.noindex ?? true;
  const size = src.size;
  const h = baseHeaders(app, request, cache, noindex);
  h.set('content-type', o.type ?? src.type ?? 'application/octet-stream');
  h.set('accept-ranges', 'bytes');
  h.set('etag', src.etag);
  for (const [k, v] of o.extra ?? []) h.set(k, v);
  if (etagMatches(request.headers.get('if-none-match'), src.etag)) return respond(request, 304, h, null);
  // one range (bytes=a-b, a-, -n); anything else is answered with the whole file
  const r = rangeOf(request.headers.get('range'), size);
  if (r.code === 416) {
    h.set('content-range', 'bytes */' + size);
    h.set('content-length', '0');
    return respond(request, 416, h, null);
  }
  if (r.code === 206) h.set('content-range', 'bytes ' + r.a + '-' + r.b + '/' + size);
  h.set('content-length', size > 0 ? String(r.b - r.a + 1) : '0');
  if (request.method === 'HEAD' || size === 0) return respond(request, r.code, h, null);
  return respond(request, r.code, h, await src.body(r.a, r.b));
}

/** an R2 object as send_file's source (the bytes read with a range, and only while the object is the version looked
 * at: R2's etag; another version since is null, and the caller looks again) */
async function r2Source(app, bucket, obj, type) {
  return {
    size: obj.size,
    etag: await fileEtag(app, obj),
    type,
    body: async (a, b) => {
      const got = await bucket.get(obj.key, { range: { offset: a, length: b - a + 1 }, onlyIf: { etagMatches: obj.etag } });
      if (!got || !('body' in got) || !got.body) throw new Error('the file changed while it was sent: ' + obj.key);
      return got.body;
    },
  };
}

/** the R2 key of a game file under /data/ (or /data-blocks/v2/): files.rs resolve_game, "data/" + its path */
export function gameKey(rest) {
  const root = '/data';
  const file = resolveGame(root, rest);
  if (file === null || file === root) return null;
  return 'data/' + file.slice(root.length + 1);
}

// ---- the routes ---------------------------------------------------------------------

/** Port of mod.rs App::handler (the router) and on_req's 500, for a request that is not an upgrade (index.js sends
 * those to lan.js).  opts = {nowMs, ctx}: the time (Date.now() in index.js) and the ExecutionContext (waitUntil). */
export async function handle(request, env, opts = {}) {
  const app = await appOf(env);
  try {
    return await route(app, request, opts);
  } catch (e) {
    // the details stay on this console; the client gets a plain 500
    console.error('[error] ' + request.method.slice(0, 8) + ' ' + String(request.url).slice(0, 96) + ': ' + (e && e.stack ? e.stack : e));
    return plain(app, request, 500, 'Server error');
  }
}

async function route(app, request, opts) {
  const nowMs = opts.nowMs ?? 0;
  const CLOSE = [['connection', 'close']];
  // HTTP/1.1 needs a Host
  if (!present(request, 'host')) return plain(app, request, 400, 'Bad request', CLOSE);
  // only this server's own names (DNS rebinding, scanners on the bare address): before anything else
  if (!ownHost(app, request)) return plain(app, request, 421, 'Misdirected request', CLOSE);
  // no encoded separator and, once decoded, no empty segment: every route compares the path it sees
  let u;
  try {
    u = new URL(request.url);
  } catch {
    return badRequest(app, request);
  }
  const lower = u.pathname.toLowerCase();
  if (lower.includes('%2f') || lower.includes('%5c')) return badRequest(app, request);
  let p;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return badRequest(app, request);
  }
  if (/[\x00-\x1f\x7f\\]/.test(p) || p.includes('//')) return badRequest(app, request);
  const method = request.method;
  // keyphrase saves, claimed names, friends and Last.fm: their own methods and bodies; not on the Worker (/vault,
  // /lastfm: none, as Rust with --vault-gb 0 and no Last.fm account) or in the Switch DO (/names, /friends)
  if (p === '/vault' || p === '/lastfm') return notFound(app, request);
  if (p === '/names') return app.names ? forward(app, request, '/names', u, opts) : notFound(app, request);
  if (p === '/friends') return app.friends ? forward(app, request, '/friends', u, opts) : notFound(app, request);
  if (method !== 'GET' && method !== 'HEAD') {
    return plain(app, request, 405, 'Method not allowed', [['allow', 'GET, HEAD'], ['connection', 'close']]);
  }
  // nothing here takes a request body
  // (Workers does not show Transfer-Encoding: a request that has a body of unknown length has a body stream)
  if (Number(request.headers.get('content-length') ?? '0') > 0 || present(request, 'transfer-encoding') || (request.body !== null && !request.headers.has('content-length'))) {
    return plain(app, request, 413, 'Too large', CLOSE);
  }
  if (p === '/data-manifest') return sendManifest(app, request, u, nowMs);
  // the game's files are bytes for the game, whatever their names say
  if (p.startsWith('/data/')) return sendGameFile(app, request, gameKey(p.slice(5)));
  if (p.startsWith('/data-blocks/')) {
    const rest = p.slice('/data-blocks'.length);
    if (!(rest.startsWith(V2) && rest.slice(V2.length).startsWith('/'))) return notFound(app, request);
    return sendBlocks(app, request, gameKey(rest.slice(V2.length)), u);
  }
  if (p === '/game.wasm') return sendWasm(app, request, u);
  if (p === '/game.json') return sendGameJson(app, request);
  if (p === '/players') return forward(app, request, '/players', u, opts);
  if (p === '/seen') return sendSeen(app, request, u, opts);
  if (p === '/country') return sendCountry(app, request);
  if (p === '/lan') return sendLanCheck(app, request, opts);
  if (p === '/robots.txt') return plain(app, request, 200, ROBOTS_TXT, [], Cache.Revalidate, false);
  // a second guard, for a web/dist that an older build left test pages or maps in (Rust's --dev and its dist-dev
  // folder are not on the Worker)
  if (devOnly(p)) return notFound(app, request);
  const rel = p.endsWith('/') ? p + 'index.html' : p;
  const indexable = rel === '/index.html';
  const cache = rel.endsWith('.html') ? Cache.Store : Cache.Revalidate;
  return sendFile(app, request, await assetSource(app, request, rel), { cache, noindex: !indexable });
}

/** a file of the page (web/dist, the static assets): files.rs resolve_inside, then the asset as it is (null: none) */
async function assetSource(app, request, rel) {
  const root = '/dist';
  const file = resolveInside(root, rel);
  if (file === null || file === root || !app.assets) return null;
  const path = file.slice(root.length);
  const r = await app.assets.fetch(new Request(new URL(path, request.url), { method: 'GET' }));
  if (r.status !== 200) {
    await r.body?.cancel();
    return null;
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  // (the asset's own version, its etag, else its bytes: under the ETag key, so the answer's ETag looks as Rust's)
  const version = r.headers.get('etag') ?? (await sha256Hex(bytes));
  return {
    size: bytes.length,
    etag: await etagOf(app.etagKey, ['asset', path, version]),
    type: typeOf(extname(path).toLowerCase()),
    body: async (a, b) => bytes.slice(a, b + 1),
  };
}

/** /data/<path>: files.rs send_file of the game file, application/octet-stream whatever its name says */
async function sendGameFile(app, request, key) {
  if (key === null || !app.game) return notFound(app, request);
  for (let tries = 0; tries < 3; tries++) {
    const obj = await app.game.head(key);
    if (!obj) return notFound(app, request);
    try {
      return await sendFile(app, request, await r2Source(app, app.game, obj, null), { type: 'application/octet-stream' });
    } catch (e) {
      if (!String(e && e.message).startsWith('the file changed')) throw e;
    }
  }
  throw new Error('a game file that keeps changing: ' + key);
}

// ---- /data-manifest -------------------------------------------------------------------

/** the game files' listing from R2 (data/...), as buildManifest takes it */
async function listGame(bucket) {
  const out = [];
  let cursor;
  for (let page = 0; page < 10000; page++) {
    const l = await bucket.list({ prefix: 'data/', cursor, include: ['customMetadata'] });
    for (const o of l.objects) out.push({ p: o.key.slice(5), s: o.size, m: versionOf(o).mtimeMs });
    if (!l.truncated) return out;
    cursor = l.cursor;
  }
  throw new Error('the game files: too many pages');
}

/** gzip of bytes (CompressionStream) */
async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Port of manifest.rs build over R2: {body, gz, etag, count, at, files} */
export async function makeManifest(app, nowMs) {
  const m = buildManifest(await listGame(app.game));
  const body = enc.encode(m.body);
  return {
    body,
    gz: await gzip(body),
    etag: await etagOf(app.etagKey, ['manifest', await sha256Hex(body)]),
    count: m.count,
    at: nowMs,
    files: m.files,
  };
}

/** Port of mod.rs send_manifest: /data-manifest, built at its first request, again on ?refresh at most every 10 s
 * (one build at a time: a request while one is under way takes its result) */
async function sendManifest(app, request, u, nowMs) {
  if (!app.game) return notFound(app, request);
  let cell = manifests.get(app.game);
  if (!cell) {
    cell = { cur: null, walk: null };
    manifests.set(app.game, cell);
  }
  let m = cell.cur;
  if (!m || (u.searchParams.has('refresh') && nowMs - m.at > 10_000)) {
    if (!cell.walk) {
      cell.walk = makeManifest(app, nowMs).then(
        (x) => { cell.cur = x; cell.walk = null; return x; },
        (e) => { cell.walk = null; throw e; },
      );
    }
    m = await cell.walk;
  }
  const gz = hasWord(acceptEncoding(request) ?? '', 'gzip');
  const h = baseHeaders(app, request, Cache.Revalidate, true);
  h.set('content-type', 'application/json');
  h.set('etag', m.etag);
  h.set('vary', 'accept-encoding');
  if (etagMatches(request.headers.get('if-none-match'), m.etag)) return respond(request, 304, h, null);
  const body = gz ? m.gz : m.body;
  h.set('content-length', String(body.length));
  if (gz) h.set('content-encoding', 'gzip');
  // (the gzip bytes as they are: never encoded again)
  return respond(request, 200, h, body, { encodeBody: 'manual' });
}

// ---- /data-blocks/ -------------------------------------------------------------------

/** Port of blocks.rs digits: a query value of 1 to max digits */
function digits(x, max) {
  return x.length >= 1 && x.length <= max && /^[0-9]+$/.test(x);
}

/** Port of blocks.rs names_version: whether the address names this version of the file (m and s, the manifest's
 * mtime and size) */
export function namesVersion(params, v) {
  return params.get('m') === num(mtimeS(v.mtimeMs)) && params.get('s') === num(v.size);
}

/** Port of blocks.rs compresses: whether the bytes from start compress, judged from the first PROBE of them (raw
 * deflate: workerd's zlib at its default level, where Rust's is zlib-rs level 2) */
async function compresses(bucket, obj, start, end) {
  const want = Math.min(PROBE, end - start);
  const got = await bucket.get(obj.key, { range: { offset: start, length: want }, onlyIf: { etagMatches: obj.etag } });
  if (!got || !got.body) return true;
  const raw = new Uint8Array(await new Response(got.body).arrayBuffer());
  const s = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const z = new Uint8Array(await new Response(s).arrayBuffer());
  return z.length < raw.length * 0.97;
}

/** Port of blocks.rs send_blocks: the run of the game file that b and n name (null: 404), compressed or as it is.
 * The Worker keeps no blocks (kept.rs: none, as Rust with NFSU2_COMPRESS_THREADS=0) and has no compressor budget
 * (every answer that would compress is compressed). */
async function sendBlocks(app, request, key, u) {
  if (key === null || !app.game) return notFound(app, request);
  const obj = await app.game.head(key);
  if (!obj) return notFound(app, request);
  const params = u.searchParams;
  const v = versionOf(obj);
  if (params.get('o') !== null) return sendExact(app, request, obj, v, params);
  const bs = params.get('b') ?? '';
  const ns = params.get('n') ?? '';
  if (!digits(bs, 7) || !digits(ns, 2)) return badRequest(app, request);
  const b = Number(bs);
  const n = Number(ns);
  if (!(n >= 1 && n <= BLOCKS_MAX)) return badRequest(app, request);
  const size = obj.size;
  const start = b * BLOCK;
  const end = Math.min(size, (b + n) * BLOCK);
  if (start >= size) return plain(app, request, 416, 'Range not satisfiable');
  const named = namesVersion(params, v);
  const e = pickEncoding(acceptEncoding(request), WORKER_ENCODERS);
  const held = e !== null && request.method !== 'HEAD';
  // a run whose probe failed is compressed: never kept as it is
  const asIs = held && !(await compresses(app.game, obj, start, end).catch(() => true));
  const z = held && !asIs;
  const keep = (z || asIs) && named;
  const h = baseHeaders(app, request, Cache.Store, true);
  h.set('content-type', 'application/octet-stream');
  h.set('vary', 'accept-encoding');
  if (keep) {
    h.set('cdn-cache-control', EDGE_KEEP);
    h.set('cloudflare-cdn-cache-control', EDGE_KEEP);
  }
  if (z) h.set('content-encoding', e);
  else h.set('content-length', String(end - start));
  if (request.method === 'HEAD') return respond(request, 200, h, null);
  const got = await app.game.get(key, { range: { offset: start, length: end - start }, onlyIf: { etagMatches: obj.etag } });
  if (!got || !got.body) throw new Error('the file changed while it was sent: ' + key);
  // (with Content-Encoding set, the runtime compresses the body: encodeBody "automatic")
  return respond(request, 200, h, got.body);
}

/** Port of blocks.rs send_exact: ?o=&l=, the file's bytes o .. o+l-1 (as far as it goes) as they are */
async function sendExact(app, request, obj, v, params) {
  const os = params.get('o') ?? '';
  const ls = params.get('l') ?? '';
  if (!digits(os, 12) || !digits(ls, 8)) return badRequest(app, request);
  const o = Number(os);
  const l = Number(ls);
  if (!(l >= 1 && l <= BLOCK * BLOCKS_MAX)) return badRequest(app, request);
  const size = obj.size;
  if (o >= size) return plain(app, request, 416, 'Range not satisfiable');
  const end = Math.min(size, o + l);
  const h = baseHeaders(app, request, Cache.Store, true);
  h.set('content-type', 'application/octet-stream');
  if (namesVersion(params, v)) {
    h.set('cdn-cache-control', EDGE_KEEP);
    h.set('cloudflare-cdn-cache-control', EDGE_KEEP);
  }
  h.set('content-length', String(end - o));
  if (request.method === 'HEAD') return respond(request, 200, h, null);
  const got = await app.game.get(obj.key, { range: { offset: o, length: end - o }, onlyIf: { etagMatches: obj.etag } });
  if (!got || !got.body) throw new Error('the file changed while it was sent: ' + obj.key);
  return respond(request, 200, h, got.body);
}

// ---- /game.wasm, /game.json ------------------------------------------------------------

/** Port of wasm.rs App::compressed_wasm over R2: the module compressed (game.wasm.br, made when it was uploaded, with
 * customMetadata {hash, size, mtimeMs} of the game.wasm it was made from) for the module there now: {etag, hash,
 * size}; null when there is none or it is of another version. */
export async function compressedWasm(app) {
  if (!app.game) return null;
  const raw = await app.game.head('game.wasm');
  if (!raw) return null;
  const br = await app.game.head('game.wasm.br');
  if (!br) return null;
  const v = versionOf(raw);
  const md = br.customMetadata ?? {};
  if (Number(md.size) !== v.size || Number(md.mtimeMs) !== v.mtimeMs || typeof md.hash !== 'string' || md.hash.length !== 22) return null;
  return { etag: await etagOf(app.etagKey, ['br', v.path, num(v.size), num(v.mtimeMs)]), hash: md.hash, size: br.size, raw, br };
}

/** Port of wasm.rs App::send_wasm: /game.wasm.  ?v=<hash>: the module /game.json named.  This one: every cache may
 * keep it for good.  Another (a new build since): 409, and the page asks /game.json again. */
async function sendWasm(app, request, u) {
  const v = u.searchParams.get('v');
  const c = await compressedWasm(app);
  if (v !== null && c && v !== c.hash) {
    return plain(app, request, 409, 'The game module changed: ask /game.json again');
  }
  const range = present(request, 'range');
  if (c && !range && hasWord(acceptEncoding(request) ?? '', 'br')) {
    const cache = v === c.hash ? Cache.Immutable : Cache.Revalidate;
    const h = baseHeaders(app, request, cache, true);
    h.set('content-type', typeOf('.wasm') ?? 'application/wasm');
    h.set('etag', c.etag);
    h.set('vary', 'accept-encoding');
    if (etagMatches(request.headers.get('if-none-match'), c.etag)) return respond(request, 304, h, null);
    h.set('content-encoding', 'br');
    h.set('content-length', String(c.size));
    if (request.method === 'HEAD') return respond(request, 200, h, null);
    const got = await app.game.get('game.wasm.br', { onlyIf: { etagMatches: c.br.etag } });
    if (!got || !got.body) throw new Error('game.wasm.br changed while it was sent');
    // (the brotli bytes as they are: never encoded again)
    return respond(request, 200, h, got.body, { encodeBody: 'manual' });
  }
  // as it is (a client without br, a byte range): revalidated, never kept for good
  if (!app.game) return notFound(app, request);
  const raw = await app.game.head('game.wasm');
  if (!raw) return notFound(app, request);
  const type = typeOf(extname(versionOf(raw).path).toLowerCase());
  return sendFile(app, request, await r2Source(app, app.game, raw, type), { cache: Cache.Revalidate, extra: [['vary', 'accept-encoding']] });
}

/** Port of wasm.rs App::send_game_json: /game.json, what was built, and which module this server sends now (module:
 * its hash, for /game.wasm?v=) */
async function sendGameJson(app, request) {
  if (!app.game) return notFound(app, request);
  const f = await app.game.get('game.json');
  if (!f) return notFound(app, request);
  const bytes = new Uint8Array(await f.arrayBuffer());
  const c = await compressedWasm(app);
  let m = null;
  if (c) {
    try {
      const v = JSON.parse(new TextDecoder().decode(bytes));
      if (v && typeof v === 'object' && !Array.isArray(v)) m = v;
    } catch {
      m = null;
    }
  }
  if (!m) {
    const type = typeOf(extname(versionOf(f).path).toLowerCase());
    const src = { size: bytes.length, etag: await fileEtag(app, f), type, body: async (a, b) => bytes.slice(a, b + 1) };
    return sendFile(app, request, src);
  }
  m.module = c.hash;
  const body = enc.encode(JSON.stringify(m));
  const h = baseHeaders(app, request, Cache.Store, true);
  h.set('content-type', typeOf('.json') ?? 'application/json');
  h.set('content-length', String(body.length));
  return respond(request, 200, h, body);
}

// ---- the small routes -----------------------------------------------------------------

/** Port of mod.rs send_country: {"country":"nl"}, the country the browser's connection comes from as Cloudflare
 * names it (request.cf.country, else CF-IPCountry), lower case; null when there is none. */
function sendCountry(app, request) {
  const raw = app.countryFromHeader ? request.headers.get('cf-ipcountry') : (request.cf?.country ?? request.headers.get('cf-ipcountry'));
  const c = clientCountry(raw);
  const body = JSON.stringify({ country: c === null ? null : c.toLowerCase() });
  return answerResponse(app, request, { status: 200, type: 'application/json', body, headers: [], cache: Cache.Store, noindex: true });
}

/** Port of mod.rs send_seen: 204, no body, whatever it said; a GET with at=page|play and an id is counted by the
 * Switch DO (its /seen: state_routes.js seenCall), after the answer */
function sendSeen(app, request, u, opts) {
  const at = u.searchParams.get('at');
  if (request.method === 'GET' && (at === 'page' || at === 'play') && u.searchParams.has('id') && app.switch) {
    const stub = app.switch.get(app.switch.idFromName('switch'));
    const sent = stub.fetch(new Request('https://switch/seen' + u.search, { method: 'GET' })).then((r) => r.body?.cancel(), (e) => console.error('[seen] ' + e));
    if (opts.ctx) opts.ctx.waitUntil(sent);
  }
  return answerResponse(app, request, seenAnswer());
}

/** Port of lan.rs send_lan_check: GET /lan without an upgrade: what the upgrade's checks of this client would say
 * now, taking nothing ("page" here; "busy" / "fast" / "ok" from the Switch DO's budgets) */
async function sendLanCheck(app, request, opts) {
  if (!ownPage(app, request)) return answerResponse(app, request, lanCheckAnswer('page'));
  return forward(app, request, '/lan-check', new URL(request.url), opts);
}

/** A route the Switch DO answers (docs/INTERNAL.md): the request as it came (method, the headers the routes read,
 * the body), to https://switch<path><search>, with the client's ids and the own-page verdict; the DO's answer
 * (state_routes.js internalResponse) as the Response. */
async function forward(app, request, path, u, opts) {
  if (!app.switch) return notFound(app, request);
  const c = client(request);
  const ids = { key: c.key, siteKey: c.site, group: await groupId(app.lanKey, c.key), site: c.site !== '' ? await groupId(app.lanKey, 'site ' + c.site) : '' };
  const h = new Headers();
  for (const k of ['authorization', 'content-type', 'sec-fetch-site', 'content-length']) {
    const v = request.headers.get(k);
    if (v !== null) h.set(k, v);
  }
  h.set('x-nfsu2-ids', JSON.stringify(ids));
  h.set('x-nfsu2-own-page', ownPage(app, request) ? '1' : '0');
  h.set('x-nfsu2-method', request.method);
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const stub = app.switch.get(app.switch.idFromName('switch'));
  const r = await stub.fetch(new Request('https://switch' + path + u.search, {
    method: hasBody ? request.method : 'GET',
    headers: h,
    body: hasBody ? request.body : null,
    duplex: 'half',
  }));
  if (r.headers.get('content-type') !== ANSWER_TYPE) {
    await r.body?.cancel();
    throw new Error('the Switch DO answered ' + path + ' with ' + r.status + ' ' + r.headers.get('content-type'));
  }
  return answerResponse(app, request, await r.json());
}

export { plainAnswer, notFoundAnswer };

