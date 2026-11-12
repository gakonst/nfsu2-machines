#!/usr/bin/env node
// The Worker's HTTP side against the Rust server, end to end: the Rust nfsu2-server (web/server-rs, release build)
// and the Worker under wrangler dev (test/e2e/entry.js: src/worker.js with the Switch stand-in) serve the same small
// made-up game folder (fake files, no game data) and the same page (web/dist), and every request below goes to both
// as raw HTTP/1.1 (so odd paths reach them as written); status, headers and the decoded bodies must be equal.
//
// Normalised (the rest must be equal byte for byte):
//   - date, connection, keep-alive, transfer-encoding, server: the engines' own
//   - content-length of a body each side compressed itself (Content-Encoding br/gzip/zstd from the server's own
//     encoder): the decoded bodies are compared instead, and the encodings must be equal
//   - etag of the page's files (web/dist): Rust's hashes the file's real path, size and mtime, the Worker's the
//     asset's own version (both '"' + 22 base64url + '"'); each side's own ETag is used for its 304 check
//   - set-cookie, cf-*, report-to, nel, vary: none expected from either; listed if they differ
// The game files' ETags are not normalised: the fixture's R2 objects carry the Rust side's real path and Node's
// mtimeMs (customMetadata path, mtimeMs), and both sides have the same ETag key, so they must be equal.
//
// node test/e2e/http.diff.mjs [--keep] [--verbose]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(here, '../..');
const WEB = path.resolve(WORKER, '..');
const RS = path.join(WEB, 'server-rs');
const DIST = path.join(WEB, 'dist');
const VERBOSE = process.argv.includes('--verbose');
const KEEP = process.argv.includes('--keep');

function log(...a) {
  process.stdout.write(a.join(' ') + '\n');
}

// ---- the fixture -------------------------------------------------------------------------

/** testkit.rs data_bits */
function dataBits(n, bits) {
  let x = 0x2545f4914f6cdd1dn;
  const M = (1n << 64n) - 1n;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    x ^= (x << 13n) & M;
    x ^= x >> 7n;
    x ^= (x << 17n) & M;
    out[i] = bits === 2 ? Number(x & 3n) * 0x41 : Number(x & 0xffn) & ((1 << bits) - 1);
  }
  return out;
}

function makeFixture(tmp) {
  const game = path.join(tmp, 'game');
  const files = {
    'SPEED2.EXE': Buffer.from('MZ the game, not really'),
    'GLOBAL/small.bin': dataBits(1000, 2),
    'GLOBAL/Game.txt': Buffer.from('inside'),
    'GLOBAL/.hidden': Buffer.from('SECRET'),
    '.hidden': Buffer.from('SECRET'),
    'GLOBAL/\u00e9t\u00e9.bin': Buffer.from('\u00e9'),
    'TRACKS/mixed.bin': Buffer.concat([dataBits(3 << 20, 8), dataBits((2 << 20) + 12345, 2)]),
    'TRACKS/pics.bin': dataBits((1 << 20) + 5000, 2),
    'TRACKS/sub/L4RA.BUN': dataBits(3000, 7),
    'Movies/INTRO.VP6': dataBits(50000, 8),
    'unins000.dat': Buffer.from('SECRET'),
    'SAVE/profile': Buffer.from('SECRET'),
    'scripts/mod.ini': Buffer.from('SECRET'),
  };
  for (const [rel, b] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(game, rel)), { recursive: true });
    fs.writeFileSync(path.join(game, rel), b);
  }
  fs.utimesSync(path.join(game, 'SPEED2.EXE'), 1700000000.999999, 1700000000.999999);
  const out = path.join(tmp, 'out');
  fs.mkdirSync(out, { recursive: true });
  const wasm = dataBits(300_000, 2);
  fs.writeFileSync(path.join(out, 'nfsu2.wasm'), wasm);
  fs.writeFileSync(path.join(out, 'nfsu2.json'), '{"build":"e2e","when":1.0,"big":12345678901234567890,"module":"old"}');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(state, { recursive: true });
  const etagKey = crypto.randomBytes(32);
  fs.writeFileSync(path.join(state, 'etag.key'), etagKey, { mode: 0o600 });
  return { game: fs.realpathSync(game), out: fs.realpathSync(out), state, etagKey, files, wasm };
}

/** the fixture's objects in the Worker's local R2 (Miniflare, wrangler's own, in the folder wrangler dev persists to) */
async function populateR2(fx, persist) {
  // (wrangler's getPlatformProxy: the bindings of a config, on the storage wrangler dev --persist-to reads)
  const { getPlatformProxy } = await import(path.join(WORKER, 'node_modules/wrangler/wrangler-dist/cli.js'));
  const cfg = path.join(persist, '..', 'r2-only.jsonc');
  fs.writeFileSync(cfg, JSON.stringify({ name: 'nfsu2-r2-fill', compatibility_date: '2026-11-01', r2_buckets: [{ binding: 'GAME', bucket_name: 'nfsu2-machines-game' }] }));
  const proxy = await getPlatformProxy({ configPath: cfg, persist: { path: path.join(persist, 'v3') } });
  const bucket = proxy.env.GAME;
  const meta = (abs) => ({ mtimeMs: String(fs.statSync(abs).mtimeMs), path: abs });
  const walk = (dir, rel) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
      else out.push(r);
    }
    return out;
  };
  for (const rel of walk(fx.game, '')) {
    const abs = path.join(fx.game, rel);
    await bucket.put('data/' + rel, fs.readFileSync(abs), { customMetadata: meta(abs) });
  }
  const wasmAbs = path.join(fx.out, 'nfsu2.wasm');
  const jsonAbs = path.join(fx.out, 'nfsu2.json');
  await bucket.put('game.wasm', fx.wasm, { customMetadata: meta(wasmAbs) });
  await bucket.put('game.json', fs.readFileSync(jsonAbs), { customMetadata: meta(jsonAbs) });
  // the module compressed as wasm.rs does it (brotli quality 5, the size as its hint), and what it was made from
  const br = zlib.brotliCompressSync(fx.wasm, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: fx.wasm.length } });
  const hash = crypto.createHash('sha256').update(fx.wasm).digest('base64url').slice(0, 22);
  const m = meta(wasmAbs);
  await bucket.put('game.wasm.br', br, { customMetadata: { hash, size: String(fx.wasm.length), mtimeMs: m.mtimeMs } });
  await proxy.dispose();
  return { hash };
}

// ---- the servers ---------------------------------------------------------------------------

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

async function waitFor(port, proc, name, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (proc.exitCode !== null) throw new Error(name + ' exited: ' + proc.exitCode + '\n' + proc.out);
    const r = await raw(port, 'GET /robots.txt HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n').catch(() => null);
    if (r && r.status === 200) return;
    await new Promise((x) => setTimeout(x, 200));
  }
  throw new Error(name + ' did not start in ' + ms + ' ms\n' + proc.out);
}

function start(cmd, args, opts, name) {
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; if (VERBOSE) process.stdout.write('[' + name + '] ' + d); });
  p.stderr.on('data', (d) => { p.out += d; if (VERBOSE) process.stdout.write('[' + name + '] ' + d); });
  return p;
}

// ---- a raw HTTP/1.1 client ---------------------------------------------------------------------

/** one request as bytes, its whole answer: {status, headers: [[name, value]], body} (Connection: close) */
function raw(port, request, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    const chunks = [];
    const t = setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, timeoutMs);
    s.on('connect', () => s.write(request));
    s.on('data', (d) => {
      chunks.push(d);
      // an upgrade's 101 keeps the connection: its head is the answer
      const all = Buffer.concat(chunks);
      if (all.slice(0, 12).toString() === 'HTTP/1.1 101' && all.includes('\r\n\r\n')) s.end();
    });
    s.on('error', (e) => { clearTimeout(t); chunks.length ? resolve(parse(Buffer.concat(chunks))) : reject(e); });
    s.on('close', () => { clearTimeout(t); try { resolve(parse(Buffer.concat(chunks))); } catch (e) { reject(e); } });
  });
}

function parse(b) {
  const end = b.indexOf('\r\n\r\n');
  if (end < 0) return { status: 0, headers: [], body: Buffer.alloc(0), bad: b.toString('latin1').slice(0, 200) };
  const head = b.slice(0, end).toString('latin1').split('\r\n');
  const status = Number(head[0].split(' ')[1]);
  const headers = head.slice(1).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
  });
  let body = b.slice(end + 4);
  const te = headers.find(([k]) => k === 'transfer-encoding');
  if (te && /chunked/i.test(te[1])) body = dechunk(body);
  return { status, headers, body };
}

function dechunk(b) {
  const out = [];
  let i = 0;
  for (let guard = 0; guard < 1 << 20 && i < b.length; guard++) {
    const e = b.indexOf('\r\n', i);
    if (e < 0) break;
    const n = parseInt(b.slice(i, e).toString(), 16);
    if (!n) break;
    out.push(b.slice(e + 2, e + 2 + n));
    i = e + 2 + n + 2;
  }
  return Buffer.concat(out);
}

function decode(enc, body) {
  if (!enc) return body;
  if (enc === 'gzip') return zlib.gunzipSync(body);
  if (enc === 'br') return zlib.brotliDecompressSync(body);
  if (enc === 'zstd') return zlib.zstdDecompressSync(body);
  throw new Error('an encoding: ' + enc);
}

// ---- the cases ----------------------------------------------------------------------------------

const HOST = 'Host: localhost';
const WS = 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==';

/** [name, method, target, extra header lines (or a function of this side's earlier answers), body, options] */
function cases(fx, hash) {
  const c = [];
  const add = (name, method, target, headers = '', body = '', o = {}) => c.push({ name, method, target, headers, body, o });
  const distFiles = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel + '/' + e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else distFiles.push(r);
    }
  };
  walk(DIST, '');
  for (const f of distFiles) add('page ' + f, 'GET', encodeURI(f), '', '', { page: true });
  add('page /', 'GET', '/', '', '', { page: true });
  add('page HEAD /', 'HEAD', '/', '', '', { page: true });
  add('page HEAD main.js', 'HEAD', '/main.js', '', '', { page: true });
  add('page 304', 'GET', '/main.js', (prev) => 'If-None-Match: ' + prev('page /main.js').etag, '', { page: true });
  add('page weak 304', 'GET', '/main.js', (prev) => 'If-None-Match: "x", W/' + prev('page /main.js').etag, '', { page: true });
  for (const r of ['bytes=0-9', 'bytes=-5', 'bytes=10-', 'bytes=100000000-', 'bytes=5-2', 'bytes=0-1,3-4', 'items=0-1', 'bytes=-', ' bytes=0-0 ', 'bytes=-0']) {
    add('page range ' + r, 'GET', '/index.html', 'Range: ' + r, '', { page: true });
  }
  for (const p of ['/main.js.map', '/x.MAP', '/test/play.html', '/TEST/x', '/te%C5%BFt/play.html', '/tests', '/testing', '/.git/config', '/%2e%2e/etc/passwd',
    '/..%2f..%2fetc/passwd', '/a%5cb', '/a\\b', '//robots.txt', '/robots.txt?x=1', '/%00', '/%zz', '/%E9', '/\u00e9', '/a/../robots.txt', '/robots.txt/',
    '/lang', '/lang/', '/lang/../index.html', '/index.html/', '/nothing', '/%20', '/a%09b', '/robots.txt#frag', '/./robots.txt', '/%2E/robots.txt', '/x?\u00e9=1']) {
    add('path ' + p, 'GET', p);
  }
  add('robots', 'GET', '/robots.txt');
  add('robots HEAD', 'HEAD', '/robots.txt');
  add('POST robots', 'POST', '/robots.txt', 'Content-Length: 0');
  add('DELETE /', 'DELETE', '/');
  add('OPTIONS /', 'OPTIONS', '/');
  add('PUT /vault', 'PUT', '/vault', 'Content-Length: 1', 'x');
  add('GET /vault', 'GET', '/vault');
  add('PUT /lastfm', 'PUT', '/lastfm', 'Content-Length: 0');
  add('GET /names', 'GET', '/names?name=Alex');
  add('POST /names', 'POST', '/names', 'Content-Length: 15\r\nContent-Type: application/json', '{"name":"Alex"}');
  add('GET /friends', 'GET', '/friends');
  add('GET with a body', 'GET', '/robots.txt', 'Content-Length: 5', 'hello');
  add('GET chunked', 'GET', '/robots.txt', 'Transfer-Encoding: chunked', '5\r\nhello\r\n0\r\n\r\n');
  add('host evil', 'GET', '/robots.txt', '', '', { host: 'Host: evil.example' });
  add('host 127.0.0.1', 'GET', '/robots.txt', '', '', { host: 'Host: 127.0.0.1' });
  add('host [::1]', 'GET', '/robots.txt', '', '', { host: 'Host: [::1]:9' });
  add('players', 'GET', '/players');
  add('players HEAD', 'HEAD', '/players');
  add('players rooms', 'GET', '/players?room=5&rooms=0,1,+2,x&spots=3&crews=0,4');
  add('seen page', 'GET', '/seen?at=page&id=AAAAAAAAAAAAAAAAAAAAAA');
  add('seen HEAD', 'HEAD', '/seen?at=play&id=AAAAAAAAAAAAAAAAAAAAAA');
  add('seen nothing', 'GET', '/seen');
  add('country NL', 'GET', '/country', 'CF-IPCountry: NL');
  add('country br', 'GET', '/country', 'CF-IPCountry:  br ');
  add('country XX', 'GET', '/country', 'CF-IPCountry: XX');
  add('country none', 'GET', '/country');
  add('lan check', 'GET', '/lan');
  add('lan check ?check', 'GET', '/lan?check');
  add('lan check own origin', 'GET', '/lan', 'Origin: http://localhost');
  add('lan check other origin', 'GET', '/lan', 'Origin: https://elsewhere.example');
  add('lan check bad origin', 'GET', '/lan', 'Origin: null');
  // the game's files
  add('manifest', 'GET', '/data-manifest');
  add('manifest gzip', 'GET', '/data-manifest', 'Accept-Encoding: gzip, deflate, br', '', { gzipBytes: true });
  add('manifest 304', 'GET', '/data-manifest', (prev) => 'If-None-Match: ' + prev('manifest').etag);
  add('manifest HEAD', 'HEAD', '/data-manifest');
  add('manifest refresh', 'GET', '/data-manifest?refresh');
  for (const p of ['/data/SPEED2.EXE', '/data/speed2.exe', '/data/GLOBAL/small.bin', '/data/GLOBAL/Game.txt', '/data/GLOBAL/%C3%A9t%C3%A9.bin', '/data/unins000.dat',
    '/data/.hidden', '/data/GLOBAL/.hidden', '/data/SAVE/profile', '/data/scripts/mod.ini', '/data', '/data/', '/data/GLOBAL', '/data/GLOBAL/',
    '/data/TRACKS/sub/L4RA.BUN', '/data//SPEED2.EXE', '/data/GLOBAL/../SPEED2.EXE', '/data/nothing.bin', '/data-x/SPEED2.EXE']) {
    add('game ' + p, 'GET', p);
  }
  add('game range', 'GET', '/data/GLOBAL/small.bin', 'Range: bytes=10-19');
  add('game range suffix', 'GET', '/data/TRACKS/pics.bin', 'Range: bytes=-100');
  add('game range 416', 'GET', '/data/GLOBAL/small.bin', 'Range: bytes=1000-');
  add('game HEAD', 'HEAD', '/data/TRACKS/mixed.bin');
  add('game 304', 'GET', '/data/SPEED2.EXE', (prev) => 'If-None-Match: ' + prev('game /data/SPEED2.EXE').etag);
  add('game big', 'GET', '/data/TRACKS/mixed.bin');
  const st = fs.statSync(path.join(fx.game, 'TRACKS/mixed.bin'));
  const v = 'm=' + Math.floor(st.mtimeMs / 1000) + '&s=' + st.size;
  const sp = fs.statSync(path.join(fx.game, 'TRACKS/pics.bin'));
  const vp = 'm=' + Math.floor(sp.mtimeMs / 1000) + '&s=' + sp.size;
  for (const enc of ['', 'gzip', 'br', 'gzip, br', 'identity', 'br;q=0, gzip']) {
    for (const [b, n] of [[0, 3], [3, 2], [2, 8], [4, 1]]) {
      add('blocks b=' + b + ' n=' + n + ' [' + enc + ']', 'GET', '/data-blocks/v2/TRACKS/mixed.bin?b=' + b + '&n=' + n + '&' + v, enc ? 'Accept-Encoding: ' + enc : '', '', { decoded: true });
    }
  }
  add('blocks HEAD', 'HEAD', '/data-blocks/v2/TRACKS/mixed.bin?b=4&n=1&' + v, 'Accept-Encoding: br');
  add('blocks no version', 'GET', '/data-blocks/v2/TRACKS/mixed.bin?b=4&n=1', 'Accept-Encoding: gzip', '', { decoded: true });
  add('blocks movie', 'GET', '/data-blocks/v2/Movies/INTRO.VP6?b=0&n=1', 'Accept-Encoding: gzip', '', { decoded: true });
  add('blocks 416', 'GET', '/data-blocks/v2/TRACKS/pics.bin?b=2&n=1');
  for (const bad of ['b=0&n=0', 'b=0&n=9', 'b=12345678&n=1', 'b=0&n=001', 'b=&n=1', 'n=1', '', 'b=1e2&n=1', 'b=+1&n=1']) add('blocks bad ' + bad, 'GET', '/data-blocks/v2/TRACKS/pics.bin?' + bad);
  for (const [o, l] of [[0, 16], [16, 30000], [(1 << 20) - 100, 4000], [sp.size - 10, 100]]) {
    add('exact o=' + o + ' l=' + l, 'GET', '/data-blocks/v2/TRACKS/pics.bin?o=' + o + '&l=' + l + '&' + vp, 'Accept-Encoding: gzip, br');
  }
  add('exact no version', 'GET', '/data-blocks/v2/TRACKS/pics.bin?o=0&l=16');
  add('exact HEAD', 'HEAD', '/data-blocks/v2/TRACKS/pics.bin?o=16&l=30000&' + vp);
  add('exact 416', 'GET', '/data-blocks/v2/TRACKS/pics.bin?o=' + sp.size + '&l=1');
  for (const bad of ['o=0&l=0', 'o=0', 'o=x&l=1', 'o=-1&l=1', 'o=0&l=8388609', 'o=1234567890123&l=1']) add('exact bad ' + bad, 'GET', '/data-blocks/v2/TRACKS/pics.bin?' + bad);
  add('blocks old address', 'GET', '/data-blocks/TRACKS/pics.bin?b=0&n=1');
  add('blocks v3', 'GET', '/data-blocks/v3/TRACKS/pics.bin?b=0&n=1');
  add('blocks none', 'GET', '/data-blocks/v2/TRACKS/none.bin?b=0&n=1');
  add('blocks not the game', 'GET', '/data-blocks/v2/unins000.dat?b=0&n=1');
  // the module
  add('game.json', 'GET', '/game.json');
  add('game.json HEAD', 'HEAD', '/game.json');
  add('wasm as it is', 'GET', '/game.wasm');
  add('wasm br', 'GET', '/game.wasm', 'Accept-Encoding: gzip, deflate, br', '', { decoded: true });
  add('wasm br this hash', 'GET', '/game.wasm?v=' + hash, 'Accept-Encoding: br', '', { decoded: true });
  add('wasm br HEAD', 'HEAD', '/game.wasm?v=' + hash, 'Accept-Encoding: br', '', { decodedLength: true });
  add('wasm another hash', 'GET', '/game.wasm?v=nope', 'Accept-Encoding: br');
  add('wasm range', 'GET', '/game.wasm', 'Accept-Encoding: br\r\nRange: bytes=100-199');
  add('wasm 304', 'GET', '/game.wasm', (prev) => 'Accept-Encoding: br\r\nIf-None-Match: ' + prev('wasm br').etag);
  add('wasm as it is 304', 'GET', '/game.wasm', (prev) => 'If-None-Match: ' + prev('wasm as it is').etag);
  // /lan upgrades: the refusals, and one that goes through
  add('ws ok', 'GET', '/lan', WS, '', { ws: true });
  add('ws protocol', 'GET', '/lan?resume', WS + '\r\nSec-WebSocket-Protocol: a, b', '', { ws: true });
  add('ws bad protocol', 'GET', '/lan', WS + '\r\nSec-WebSocket-Protocol: a,,b', '', { ws: true });
  add('ws other origin', 'GET', '/lan', WS + '\r\nOrigin: https://evil.example', '', { ws: true });
  add('ws own origin', 'GET', '/lan', WS + '\r\nOrigin: http://localhost', '', { ws: true });
  add('ws other path', 'GET', '/other', WS, '', { ws: true });
  add('ws robots', 'GET', '/robots.txt', WS, '', { ws: true });
  add('ws bad key', 'GET', '/lan', WS.replace('dGhlIHNhbXBsZSBub25jZQ==', 'nope'), '', { ws: true });
  add('ws version 8', 'GET', '/lan', WS.replace('Version: 13', 'Version: 8'), '', { ws: true });
  add('ws host evil', 'GET', '/lan', WS, '', { ws: true, host: 'Host: evil.example' });
  add('ws POST', 'POST', '/lan', WS + '\r\nContent-Length: 0', '', { ws: true });
  return c;
}

// ---- comparing ---------------------------------------------------------------------------------

/** the requests the platform answers (or changes) before the Worker sees them, under wrangler dev: their differences
 * are listed, not counted as failures (test/http-routes.test.mjs checks the Worker's own answer to each) */
const KNOWN = new Map([
  ['path /é', 'a raw non-ASCII byte in the request target: the HTTP parser of the Rust server refuses it (400), workerd takes it percent-encoded'],
  ['path /x?é=1', 'a raw non-ASCII byte in the request target: the HTTP parser of the Rust server refuses it (400), workerd takes it percent-encoded'],
  ['GET chunked', 'Workers shows neither Transfer-Encoding nor the body of a GET: Rust answers 413, the Worker sees a plain GET'],
  ['ws bad key', 'the proxy of wrangler dev opens its own WebSocket to the Worker (a fresh Sec-WebSocket-Key): the key of the client never reaches it'],
  ['ws version 8', 'workerd refuses a WebSocket version other than 13 itself (426, its own text)'],
  ['ws POST', 'workerd refuses a WebSocket upgrade that is not a GET itself (its own 400 text)'],
]);

const DROP = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'server']);

function headerMap(hs) {
  const m = new Map();
  for (const [k, v] of hs) {
    if (DROP.has(k)) continue;
    m.set(k, m.has(k) ? m.get(k) + ', ' + v : v);
  }
  return m;
}

/** what one comparison found: diffs (must be none), and notes (the platform's own steps, normalised: counted) */
function compareOne(cs, a, b) {
  const diffs = [];
  const notes = [];
  if (a.status !== b.status) diffs.push('status ' + a.status + ' vs ' + b.status);
  const ha = headerMap(a.headers);
  const hb = headerMap(b.headers);
  const ea = ha.get('content-encoding') ?? null;
  const eb = hb.get('content-encoding') ?? null;
  // the platform's own compression of a text answer (the proxy of wrangler dev, as Cloudflare's edge, compresses some
  // types for a client that takes it): the decoded body is compared, and the encoding noted
  const platformEnc = !ea && eb && !cs.o.decoded && !cs.o.gzipBytes && !cs.o.decodedLength;
  const staticEtag = !/^\/(data|game)/.test(cs.target);
  for (const k of new Set([...ha.keys(), ...hb.keys()])) {
    const x = ha.get(k);
    const y = hb.get(k);
    if (x === y) continue;
    if (k === 'etag' && staticEtag && x && y && /^"[A-Za-z0-9_-]{22}"$/.test(x) && /^"[A-Za-z0-9_-]{22}"$/.test(y)) continue;
    if (k === 'content-length' && ea && ea === eb && (cs.o.decoded || cs.o.decodedLength)) continue;
    // the platform's re-encoding of an encoded body into the client's first choice (Cloudflare's edge, as
    // Miniflare emulates it): the decoded bodies must be equal
    if ((k === 'content-encoding' || k === 'content-length') && ea && eb && ea !== eb && cs.o.decoded) {
      if (k === 'content-encoding') notes.push('platform re-encoded ' + ea + ' as ' + eb);
      continue;
    }
    if (platformEnc && (k === 'content-encoding' || k === 'content-length')) continue;
    // wrangler dev streams text/html (its live-reload path) without a Content-Length
    if (k === 'content-length' && y === undefined && (hb.get('content-type') ?? '').startsWith('text/html') && b.body.length === Number(x)) {
      notes.push('html without content-length');
      continue;
    }
    if (a.status === 101 && b.status === 101) continue;
    diffs.push(k + ': ' + JSON.stringify(x) + ' vs ' + JSON.stringify(y));
  }
  if (platformEnc) notes.push('platform ' + eb);
  let ba = a.body;
  let bb = b.body;
  try {
    if (cs.o.decoded) {
      ba = decode(ea, ba);
      bb = decode(eb, bb);
    } else if (platformEnc && bb.length) {
      bb = decode(eb, bb);
    }
  } catch (e) {
    diffs.push('decode: ' + e.message);
  }
  if (a.status === 101 && b.status === 101) {
    // (the switch's first frames after a 101: the Rust switch's welcome, the stand-in sends none)
  } else if (cs.o.gzipBytes && !ba.equals(bb)) {
    try {
      if (zlib.gunzipSync(ba).equals(zlib.gunzipSync(bb))) notes.push('gzip bytes differ (same content)');
      else diffs.push('gzipped content differs');
    } catch (e) {
      diffs.push('gunzip: ' + e.message);
    }
  } else if (!ba.equals(bb)) {
    diffs.push('body ' + ba.length + ' bytes vs ' + bb.length + (ba.length < 300 && bb.length < 300 ? ': ' + JSON.stringify(ba.toString('latin1')) + ' vs ' + JSON.stringify(bb.toString('latin1')) : ''));
  }
  return { diffs, notes };
}

// ---- main -------------------------------------------------------------------------------------

async function main() {
  const bin = path.join(RS, 'target/release/nfsu2-server');
  if (spawnSync('cargo', ['--version']).error) {
    log('SKIP: cargo is not installed (the Rust server is the reference)');
    return 0;
  }
  const b = spawnSync('cargo', ['build', '--release', '-q', '-p', 'nfsu2-server'], { cwd: RS, stdio: 'inherit' });
  if (b.status !== 0) throw new Error('cargo build --release failed');
  if (!fs.existsSync(path.join(WORKER, 'node_modules/wrangler'))) {
    log('SKIP: run npm install in web/worker first (wrangler)');
    return 0;
  }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('web/dist has no index.html: build the page first (web/build.sh)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-http-diff-'));
  const fx = makeFixture(tmp);
  const persist = path.join(tmp, 'wrangler');
  const { hash } = await populateR2(fx, persist);
  const [pr, pw] = [await freePort(), await freePort()];
  const rust = start(bin, ['--data', fx.game, '--dist', DIST, '--wasm', path.join(fx.out, 'nfsu2.wasm'), '--state', fx.state, '--http-port', String(pr), '--port', '0',
    '--online', 'off', '--roam-hub', 'off', '--vault-gb', '0'], { env: { ...process.env, NFSU2_COMPRESS_THREADS: '0', NFSU2_LASTFM_KEY: '', NFSU2_LASTFM_SECRET: '' } }, 'rust');
  const cfg = path.join(tmp, 'wrangler.jsonc');
  fs.writeFileSync(cfg, JSON.stringify({
    name: 'nfsu2-machines', main: path.join(here, 'entry.js'), compatibility_date: '2026-11-01',
    durable_objects: { bindings: [{ name: 'SWITCH', class_name: 'Switch' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Switch'] }],
    r2_buckets: [{ binding: 'GAME', bucket_name: 'nfsu2-machines-game' }],
    assets: { directory: DIST, binding: 'ASSETS', run_worker_first: true, html_handling: 'none', not_found_handling: 'none' },
    vars: { HOSTS: '', HSTS: 'on', NAMES: 'off', FRIENDS: 'off', COUNTRY_FROM: 'header', ETAG_KEY: fx.etagKey.toString('hex'), LAN_ID_KEY: crypto.randomBytes(32).toString('hex') },
  }));
  const wr = start(path.join(WORKER, 'node_modules/.bin/wrangler'), ['dev', '--config', cfg, '--port', String(pw), '--ip', '127.0.0.1', '--persist-to', persist,
    '--inspector-port', String(await freePort()), '--show-interactive-dev-session=false', '--log-level', 'warn'], { cwd: tmp, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } }, 'wrangler');
  let failed = 0;
  let same = 0;
  let known = 0;
  const noted = new Map();
  const report = [];
  try {
    await waitFor(pr, rust, 'the Rust server', 30000);
    await waitFor(pw, wr, 'wrangler dev', 120000);
    const all = cases(fx, hash);
    const prev = { rust: new Map(), worker: new Map() };
    for (const cs of all) {
      const got = {};
      for (const [side, port] of [['rust', pr], ['worker', pw]]) {
        const earlier = (name) => {
          const r = prev[side].get(name);
          if (!r) throw new Error('no earlier answer ' + name);
          return { etag: (r.headers.find(([k]) => k === 'etag') ?? [])[1] };
        };
        const extra = typeof cs.headers === 'function' ? cs.headers(earlier) : cs.headers;
        const lines = [cs.method + ' ' + cs.target + ' HTTP/1.1', cs.o.host ?? HOST];
        if (extra) lines.push(extra);
        if (!cs.o.ws) lines.push('Connection: close');
        const req = Buffer.concat([Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'utf8'), Buffer.from(cs.body)]);
        got[side] = await raw(port, req);
        prev[side].set(cs.name, got[side]);
      }
      const { diffs: d, notes } = compareOne(cs, got.rust, got.worker);
      for (const n of notes) noted.set(n, (noted.get(n) ?? 0) + 1);
      if (d.length && KNOWN.has(cs.name)) {
        known++;
        report.push('KNOWN ' + cs.name + ': ' + KNOWN.get(cs.name) + ' [' + d.join('; ').slice(0, 160) + ']');
      } else if (d.length) {
        failed++;
        report.push('DIFF ' + cs.name + ' (' + cs.method + ' ' + JSON.stringify(cs.target) + '): ' + d.join('; '));
      } else {
        same++;
        if (VERBOSE) report.push('same ' + cs.name + ' ' + got.rust.status + (notes.length ? ' (' + notes.join(', ') + ')' : ''));
      }
    }
  } finally {
    rust.kill('SIGTERM');
    wr.kill('SIGTERM');
    if (!KEEP) setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 500);
    else log('kept ' + tmp);
  }
  for (const l of report) log(l);
  for (const [n, c] of noted) log('normalised: ' + n + ' x' + c);
  log(same + ' requests answered the same, ' + known + ' differently where the platform answers first (KNOWN), ' + failed + ' differently');
  return failed ? 1 : 0;
}

main().then((code) => setTimeout(() => process.exit(code), 800), (e) => {
  console.error(e);
  process.exit(2);
});

