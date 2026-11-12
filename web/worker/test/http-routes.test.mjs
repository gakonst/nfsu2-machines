// The Worker's routes over stand-ins of its bindings (an R2 bucket, the static assets, the Switch DO): the cases of
// web/server-rs/src/app/route_tests.rs, lan.rs and names.rs that apply to the Worker, and the router's own rules
// (mod.rs handler).  The runtime's own steps (compressing a body that has Content-Encoding, the WebSocket's 101) are
// workerd's: test/e2e/http.diff.mjs covers them against the Rust server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handle, refuseResponse, ROBOTS_TXT } from '../src/http/routes.js';
import { lanUpgrade } from '../src/http/lan.js';
import { EDGE_KEEP, CSP } from '../src/http/headers.js';
import { NamesRoute, WS_PER_ADDRESS, LAN_OPEN_BURST } from '../src/http/state_routes.js';
import { Switch, switchBinding } from './e2e/switch-standin.js';

/** testkit.rs data_bits: noise of bits bits a byte (2: bytes of two bits, which compress) */
function dataBits(n, bits) {
  let x = 0x2545f4914f6cdd1dn;
  const M = (1n << 64n) - 1n;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x ^= (x << 13n) & M;
    x ^= x >> 7n;
    x ^= (x << 17n) & M;
    out[i] = bits === 2 ? Number(x & 3n) * 0x41 : Number(x & 0xffn) & ((1 << bits) - 1);
  }
  return out;
}
const data = (n, compressible) => dataBits(n, compressible ? 2 : 8);

/** an R2 bucket in memory: head, get (range, onlyIf etagMatches), list (prefix, cursor), put */
class Bucket {
  constructor() {
    this.m = new Map();
    this.n = 0;
  }
  put(key, bytes, customMetadata = {}) {
    this.m.set(key, { key, bytes, size: bytes.length, etag: 'e' + ++this.n, uploaded: new Date(1_700_000_000_000 + this.n), customMetadata });
  }
  obj(o) {
    return { key: o.key, size: o.size, etag: o.etag, uploaded: o.uploaded, customMetadata: o.customMetadata };
  }
  async head(key) {
    const o = this.m.get(key);
    return o ? this.obj(o) : null;
  }
  async get(key, opts = {}) {
    const o = this.m.get(key);
    if (!o) return null;
    if (opts.onlyIf && opts.onlyIf.etagMatches && opts.onlyIf.etagMatches !== o.etag) return this.obj(o);
    let b = o.bytes;
    if (opts.range) b = b.slice(opts.range.offset, opts.range.offset + opts.range.length);
    return { ...this.obj(o), body: new Blob([b]).stream(), arrayBuffer: async () => b.slice().buffer };
  }
  async list({ prefix, cursor }) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
    const from = cursor ? Number(cursor) : 0;
    const page = keys.slice(from, from + 2);
    return { objects: page.map((k) => this.obj(this.m.get(k))), truncated: from + 2 < keys.length, cursor: String(from + 2) };
  }
}

/** the static assets: exact files, with an etag */
function assets(files) {
  return {
    async fetch(req) {
      const p = new URL(req.url).pathname;
      const b = files[p];
      if (b === undefined) return new Response('nope', { status: 404 });
      return new Response(b, { status: 200, headers: { etag: '"' + createHash('sha1').update(b).digest('hex') + '"' } });
    },
  };
}

function kit(vars = {}) {
  const game = new Bucket();
  game.put('data/SPEED2.EXE', new TextEncoder().encode('MZ the game'), { mtimeMs: '1700000000123.456' });
  game.put('data/GLOBAL/small.bin', data(1000, true), { mtimeMs: '1760000000999.9998' });
  const raw = data(300_000, true);
  game.put('game.wasm', raw, { mtimeMs: '1760000000000', path: '/srv/out/web/nfsu2.wasm' });
  const hash = createHash('sha256').update(raw).digest('base64url').slice(0, 22);
  game.put('game.wasm.br', new Uint8Array([1, 2, 3, 4]), { hash, size: String(raw.length), mtimeMs: '1760000000000' });
  game.put('game.json', new TextEncoder().encode('{"build":"x","n":1.0,"module":"old"}'));
  const standIn = new Switch(null, null, () => kit.now);
  const env = {
    GAME: game,
    ASSETS: assets({ '/index.html': '<!doctype html>', '/main.js': 'x()', '/a/b.css': 'b{}', '/main.js.map': '{}', '/x.unknown': 'u' }),
    SWITCH: switchBinding(standIn),
    ETAG_KEY: '00'.repeat(32),
    LAN_ID_KEY: '11'.repeat(32),
    HOSTS: 'game.example.com',
    COUNTRY_FROM: 'header',
    ...vars,
  };
  const req = async (method, path, headers = {}, body = null) => {
    const r = await handle(new Request('http://localhost' + path, { method, headers: { host: 'localhost', ...headers }, body }), env, { nowMs: kit.now });
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, h: r.headers, body: b, text: new TextDecoder().decode(b) };
  };
  return { env, game, raw, hash, standIn, req, get: (p, h) => req('GET', p, h) };
}
kit.now = 1_000_000;

test('every answer has the security and cache headers; plain answers as Rust writes them', async () => {
  const k = kit();
  const r = await k.get('/nothing/here.js');
  assert.equal(r.status, 404);
  assert.equal(r.text, 'Not found\n');
  assert.equal(r.h.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(r.h.get('content-length'), '10');
  assert.equal(r.h.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(r.h.get('content-security-policy'), CSP);
  assert.equal(r.h.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(r.h.get('cache-control'), 'private, no-store, no-transform');
  assert.equal(r.h.get('strict-transport-security'), null);
  const robots = await k.get('/robots.txt');
  assert.deepEqual([robots.status, robots.text, robots.h.get('cache-control'), robots.h.get('x-robots-tag')], [200, ROBOTS_TXT + '\n', 'private, no-cache, no-transform', 'index, follow']);
  // HSTS over https, not for localhost
  const s = await handle(new Request('https://game.example.com/robots.txt', { headers: { host: 'game.example.com' } }), k.env, {});
  assert.equal(s.headers.get('strict-transport-security'), 'max-age=31536000');
  const l = await handle(new Request('https://localhost/robots.txt', { headers: { host: 'localhost' } }), k.env, {});
  assert.equal(l.headers.get('strict-transport-security'), null);
});

test('the router: Host, paths, methods, bodies', async () => {
  const k = kit();
  const r = await handle(new Request('http://evil.example/robots.txt', { headers: { host: 'evil.example' } }), k.env, {});
  assert.deepEqual([r.status, await r.text(), r.headers.get('connection')], [421, 'Misdirected request\n', 'close']);
  for (const p of ['/a%2fb', '/a%5Cb', '/%E0%A4%A', '/a%00b', '/x%7f', '/a//b', '/a%5c']) assert.equal((await k.get(p)).status, 400, p);
  const m = await k.req('POST', '/robots.txt');
  assert.deepEqual([m.status, m.h.get('allow'), m.h.get('connection')], [405, 'GET, HEAD', 'close']);
  for (const p of ['/vault', '/lastfm', '/names', '/friends']) assert.equal((await k.req('PUT', p)).status, 404, p);
  assert.equal((await k.get('/robots.txt', { 'content-length': '5' })).status, 413);
  assert.equal((await k.get('/robots.txt', { 'content-length': ' 0x10 ' })).status, 413);
  assert.equal((await k.get('/robots.txt', { 'content-length': 'abc' })).status, 200);
  const head = await k.req('HEAD', '/robots.txt');
  assert.deepEqual([head.status, head.body.length, head.h.get('content-length')], [200, 0, String(ROBOTS_TXT.length + 1)]);
});

test('the page: index, types, ETags, ranges, 404s', async () => {
  const k = kit();
  const i = await k.get('/');
  assert.deepEqual([i.status, i.text, i.h.get('content-type'), i.h.get('x-robots-tag'), i.h.get('cache-control')], [200, '<!doctype html>', 'text/html; charset=utf-8', 'index, follow', 'private, no-store, no-transform']);
  assert.match(i.h.get('etag'), /^"[A-Za-z0-9_-]{22}"$/);
  assert.equal(i.h.get('accept-ranges'), 'bytes');
  const js = await k.get('/main.js');
  assert.deepEqual([js.h.get('content-type'), js.h.get('cache-control'), js.h.get('x-robots-tag')], ['text/javascript; charset=utf-8', 'private, no-cache, no-transform', 'noindex, nofollow']);
  assert.equal((await k.get('/main.js', { 'if-none-match': js.h.get('etag') })).status, 304);
  const rg = await k.get('/main.js', { range: 'bytes=1-' });
  assert.deepEqual([rg.status, rg.text, rg.h.get('content-range'), rg.h.get('content-length')], [206, '()', 'bytes 1-2/3', '2']);
  const bad = await k.get('/main.js', { range: 'bytes=5-' });
  assert.deepEqual([bad.status, bad.h.get('content-range'), bad.h.get('content-length')], [416, 'bytes */3', '0']);
  assert.equal((await k.get('/x.unknown')).h.get('content-type'), 'application/octet-stream');
  for (const p of ['/main.js.map', '/test/play.html', '/TE\u017FT/x', '/.git/config', '/a', '/a/', '/index.html/']) assert.equal((await k.get(p)).status, 404, p);
  assert.equal((await k.get('/a/b.css')).status, 200);
});

test('game files: /data/ as bytes, ranges, 304, names not the game\'s', async () => {
  const k = kit();
  const a = await k.get('/data/GLOBAL/small.bin');
  assert.deepEqual([a.status, a.body.length, a.h.get('content-type')], [200, 1000, 'application/octet-stream']);
  assert.equal((await k.get('/data/global/small.bin')).status, 404, 'R2 keys keep their case');
  assert.equal((await k.get('/data/GLOBAL/small.bin', { 'if-none-match': a.h.get('etag') })).status, 304);
  const r = await k.get('/data/SPEED2.EXE', { range: 'bytes=-4' });
  assert.deepEqual([r.status, r.text], [206, 'game']);
  for (const p of ['/data/unins000.dat', '/data/', '/data/.hidden', '/data/GLOBAL/%2e%2e/x', '/data']) assert.equal((await k.get(p)).status, 404, p);
});

test('runs and exact ranges of /data-blocks/v2/ (route_tests.rs runs_come_back_exact, exact_ranges_come_back_as_they_are)', async () => {
  const k = kit();
  const b = data(3 << 20, false);
  const mixed = new Uint8Array((3 << 20) + (2 << 20) + 12345);
  mixed.set(b);
  mixed.set(data((2 << 20) + 12345, true), 3 << 20);
  k.game.put('data/TRACKS/mixed.bin', mixed, { mtimeMs: '1760000000500' });
  for (const enc of ['zstd', 'br', 'gzip', '']) {
    for (const [bb, n] of [[0, 3], [3, 2], [2, 8], [4, 1]]) {
      const a = await k.get('/data-blocks/v2/TRACKS/mixed.bin?b=' + bb + '&n=' + n, { 'accept-encoding': enc });
      assert.equal(a.status, 200);
      const want = mixed.slice(bb << 20, Math.min(mixed.length, (bb + n) << 20));
      // (the body as it is: workerd compresses it when Content-Encoding is set)
      assert.deepEqual(a.body, want, 'b=' + bb + ' n=' + n + ' ' + enc);
      const wantEnc = bb < 3 || enc === '' || enc === 'zstd' ? null : enc;
      assert.equal(a.h.get('content-encoding'), wantEnc, 'b=' + bb + ' n=' + n + ' ' + enc);
      assert.equal(a.h.get('content-length'), wantEnc ? null : String(want.length));
      assert.equal(a.h.get('vary'), 'accept-encoding');
    }
  }
  const pics = data((1 << 20) + 5000, true);
  k.game.put('data/TRACKS/pics.bin', pics, { mtimeMs: '1760000000999.5' });
  const v = 'm=1760000000&s=' + pics.length;
  const all = { 'accept-encoding': 'zstd, br, gzip' };
  const url = (o, l, vv) => '/data-blocks/v2/TRACKS/pics.bin?o=' + o + '&l=' + l + '&' + vv;
  for (const [o, l] of [[0, 16], [16, 30000], [(1 << 20) - 100, 4000], [pics.length - 10, 10]]) {
    const a = await k.get(url(o, l, v), all);
    assert.equal(a.status, 200);
    assert.equal(a.h.get('content-encoding'), null);
    assert.equal(a.h.get('content-length'), String(l));
    assert.deepEqual(a.body, pics.slice(o, o + l));
    assert.equal(a.h.get('cloudflare-cdn-cache-control'), EDGE_KEEP);
    assert.equal(a.h.get('cdn-cache-control'), EDGE_KEEP);
  }
  const past = await k.get(url(pics.length - 10, 100, v), all);
  assert.deepEqual([past.status, past.body], [200, pics.slice(pics.length - 10)]);
  for (const other of ['', 'm=1&s=16']) {
    const a = await k.get(url(0, 16, other), all);
    assert.deepEqual([a.status, a.h.get('cloudflare-cdn-cache-control')], [200, 'no-store'], other);
  }
  const head = await k.req('HEAD', url(16, 30000, v), all);
  assert.deepEqual([head.status, head.h.get('content-length'), head.body.length], [200, '30000', 0]);
  assert.equal((await k.get(url(pics.length, 1, v), all)).status, 416);
  for (const bad of ['o=0&l=0', 'o=0', 'o=x&l=1', 'o=-1&l=1', 'o=0&l=8388609', 'o=1234567890123&l=1']) assert.equal((await k.get('/data-blocks/v2/TRACKS/pics.bin?' + bad, all)).status, 400, bad);
  assert.equal((await k.get('/data-blocks/v2/TRACKS/none.bin?o=0&l=16', all)).status, 404);
  // the address from before /v2: none; a run named by its version: kept for good; one that names none: not
  assert.equal((await k.get('/data-blocks/TRACKS/pics.bin?b=1&n=1&' + v, all)).status, 404);
  const named = await k.get('/data-blocks/v2/TRACKS/pics.bin?b=1&n=1&' + v, all);
  assert.deepEqual([named.h.get('content-encoding'), named.h.get('cloudflare-cdn-cache-control')], ['br', EDGE_KEEP]);
  assert.equal((await k.get('/data-blocks/v2/TRACKS/pics.bin?b=1&n=1', all)).h.get('cloudflare-cdn-cache-control'), 'no-store');
  // a HEAD takes no compressor: as it is, never kept by a shared cache (Rust's held is None for a HEAD)
  const h2 = await k.req('HEAD', '/data-blocks/v2/TRACKS/pics.bin?b=1&n=1&' + v, all);
  assert.deepEqual([h2.h.get('content-encoding'), h2.h.get('content-length'), h2.h.get('cloudflare-cdn-cache-control')], [null, '5000', 'no-store']);
  for (const bad of ['b=0&n=0', 'b=0&n=9', 'b=12345678&n=1', 'b=0&n=001', 'b=&n=1', 'n=1']) assert.equal((await k.get('/data-blocks/v2/TRACKS/pics.bin?' + bad)).status, 400, bad);
  const far = await k.get('/data-blocks/v2/TRACKS/pics.bin?b=2&n=1');
  assert.deepEqual([far.status, far.text], [416, 'Range not satisfiable\n']);
});

test('the manifest: built from R2, gzip, ETag, 304, ?refresh at most every 10 s', async () => {
  const k = kit();
  const a = await k.get('/data-manifest');
  assert.equal(a.status, 200);
  assert.equal(a.text, '{"v":1,"files":[{"p":"GLOBAL","d":1},{"p":"GLOBAL/small.bin","s":1000,"m":1760000000},{"p":"SPEED2.EXE","s":11,"m":1700000000}],"blocks":{"url":"/data-blocks/v2/","size":1048576,"max":8}}');
  assert.deepEqual([a.h.get('content-type'), a.h.get('vary'), a.h.get('cache-control'), a.h.get('content-encoding')], ['application/json', 'accept-encoding', 'private, no-cache, no-transform', null]);
  const gz = await k.get('/data-manifest', { 'accept-encoding': 'gzip, br' });
  assert.equal(gz.h.get('content-encoding'), 'gzip');
  const { gunzipSync } = await import('node:zlib');
  assert.equal(gunzipSync(gz.body).toString(), a.text);
  assert.equal((await k.get('/data-manifest', { 'if-none-match': a.h.get('etag') })).status, 304);
  k.game.put('data/TRACKS/new.bin', new Uint8Array(5), { mtimeMs: '1' });
  assert.equal((await k.get('/data-manifest?refresh')).text, a.text, 'within 10 s of the last');
  kit.now += 10_001;
  assert.ok((await k.get('/data-manifest?refresh')).text.includes('TRACKS/new.bin'));
  kit.now -= 10_001;
});

test('the module: br for this hash for good, 409 for another, as it is for a range', async () => {
  const k = kit();
  const j = await k.get('/game.json');
  assert.deepEqual([j.status, j.text, j.h.get('content-type'), j.h.get('cache-control')], [200, '{"build":"x","n":1,"module":"' + k.hash + '"}', 'application/json', 'private, no-store, no-transform']);
  const w = await k.get('/game.wasm?v=' + k.hash, { 'accept-encoding': 'gzip, br' });
  assert.deepEqual([w.status, w.h.get('content-encoding'), w.h.get('content-length'), w.h.get('cache-control'), w.h.get('content-type')], [200, 'br', '4', 'public, max-age=31536000, immutable, no-transform', 'application/wasm']);
  assert.deepEqual(w.body, new Uint8Array([1, 2, 3, 4]));
  assert.equal((await k.get('/game.wasm', { 'accept-encoding': 'br' })).h.get('cache-control'), 'private, no-cache, no-transform');
  assert.equal((await k.get('/game.wasm', { 'accept-encoding': 'br', 'if-none-match': w.h.get('etag') })).status, 304);
  const old = await k.get('/game.wasm?v=nope', { 'accept-encoding': 'br' });
  assert.deepEqual([old.status, old.text], [409, 'The game module changed: ask /game.json again\n']);
  const r = await k.get('/game.wasm', { 'accept-encoding': 'br', range: 'bytes=0-9' });
  assert.deepEqual([r.status, r.body, r.h.get('vary'), r.h.get('content-encoding')], [206, k.raw.slice(0, 10), 'accept-encoding', null]);
  const plain = await k.get('/game.wasm');
  assert.deepEqual([plain.status, plain.body.length, plain.h.get('cache-control')], [200, k.raw.length, 'private, no-cache, no-transform']);
  // a compressed module of another build: none (the module as it is), and /game.json as its file
  k.game.put('game.wasm', new Uint8Array(10), { mtimeMs: '5' });
  assert.equal((await k.get('/game.wasm', { 'accept-encoding': 'br' })).h.get('content-encoding'), null);
  const j2 = await k.get('/game.json');
  assert.deepEqual([j2.status, j2.text, j2.h.get('accept-ranges')], [200, '{"build":"x","n":1.0,"module":"old"}', 'bytes']);
  k.game.m.delete('game.json');
  assert.equal((await k.get('/game.json')).status, 404);
});

test('/seen counts each browser once, and the settings told at Play (route_tests.rs)', async () => {
  const k = kit();
  const [a, b] = ['AAAAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBB'];
  const ctx = { waits: [], waitUntil(p) { this.waits.push(p); } };
  const seen = async (method, path) => {
    const r = await handle(new Request('http://localhost' + path, { method, headers: { host: 'localhost' } }), k.env, { nowMs: 1, ctx });
    await Promise.all(ctx.waits);
    return r;
  };
  for (const p of ['/seen?at=page&id=' + a, '/seen?at=page&id=' + a, '/seen?at=play&id=' + a, '/seen?at=page&id=' + b, '/seen?at=roam&id=' + b, '/seen?at=play&id=not%20an%20id', '/seen?at=play']) {
    const r = await seen('GET', p);
    assert.equal(r.status, 204, p);
    assert.equal((await r.arrayBuffer()).byteLength, 0);
    assert.equal(r.headers.get('cache-control'), 'private, no-store, no-transform');
  }
  assert.equal((await seen('HEAD', '/seen?at=play&id=' + b)).status, 204);
  assert.deepEqual(k.standIn.days.today(), [2, 1, 0, 0]);
  const k2 = kit();
  const seen2 = async (p) => {
    await handle(new Request('http://localhost' + p, { headers: { host: 'localhost' } }), k2.env, { nowMs: 1, ctx });
    await Promise.all(ctx.waits);
  };
  for (const p of ['/seen?at=play&id=' + a + '&k=phone&s=fps%3D30%2Croam_name%3Dset', '/seen?at=play&id=' + b + '&k=pc&s=', '/seen?at=play&id=' + b + '&k=pc&s=fps=120,hud=43',
    '/seen?at=page&id=' + a + '&k=pc&s=fps%3D60', '/seen?at=play&id=' + a + '&k=toaster&s=fps%3D60', '/seen?at=play&id=' + a, '/seen?at=play&k=pc&s=fps%3D60']) await seen2(p);
  assert.deepEqual(k2.standIn.days.reports, [2, 1, 0]);
  assert.deepEqual(k2.standIn.days.counts.get('fps=30'), [0, 1, 0]);
  assert.deepEqual(k2.standIn.days.counts.get('fps=120'), [1, 0, 0]);
  assert.deepEqual(k2.standIn.days.counts.get('roam_name=set'), [0, 1, 0]);
  assert.equal(k2.standIn.days.counts.get('fps=60'), undefined);
});

test('/country is the connection\'s own (route_tests.rs country_is_the_connections_own)', async () => {
  const k = kit();
  for (const [cc, want] of [['NL', '{"country":"nl"}'], [' br ', '{"country":"br"}'], ['XX', '{"country":null}'], ['T1', '{"country":null}'], ['Netherlands', '{"country":null}'], [null, '{"country":null}']]) {
    const r = await k.get('/country', cc === null ? {} : { 'cf-ipcountry': cc });
    assert.deepEqual([r.status, r.text, r.h.get('content-type')], [200, want, 'application/json'], String(cc));
    assert.ok(r.h.get('cache-control').includes('no-store'));
  }
  // in production the country is request.cf's
  const k2 = kit({ COUNTRY_FROM: '' });
  const r = await handle(Object.assign(new Request('http://localhost/country', { headers: { host: 'localhost', 'cf-ipcountry': 'DE' } }), { cf: { country: 'FR' } }), k2.env, {});
  assert.equal(await r.text(), '{"country":"fr"}');
});

test('/players from the Switch DO', async () => {
  const k = kit();
  k.standIn.peers = 3;
  const r = await k.get('/players?room=5&rooms=1,2&crews=0,7');
  assert.deepEqual([r.status, r.text, r.h.get('content-type'), r.h.get('cache-control')], [200, '{"players":3,"online":null,"roam":null,"full":false,"queue":0,"roamBusy":false}', 'application/json', 'private, no-store, no-transform']);
  const head = await k.req('HEAD', '/players');
  assert.deepEqual([head.status, head.body.length, head.h.get('content-length')], [200, 0, '79']);
});

test('a page can ask why its connection fails (lan.rs a_page_can_ask_why_its_connection_fails)', async () => {
  const k = kit();
  const up = async (ip, origin) => {
    const h = { host: 'localhost', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'cf-connecting-ip': ip };
    if (origin) h.origin = origin;
    const r = await lanUpgrade(new Request('http://localhost/lan', { headers: h }), k.env);
    if (r instanceof Response) return { status: r.status };
    const t = k.standIn.gate.take(r.key, r.site, kit.now, r.opts);
    return { opts: r.opts, admit: t.refuse ? { refuse: t.status, why: t.refuse, log: t.log } : { release: () => k.standIn.gate.release(t.share) } };
  };
  const ask = async (ip, origin) => {
    const h = { 'cf-connecting-ip': ip };
    if (origin) h.origin = origin;
    const r = await k.get('/lan?check', h);
    assert.deepEqual([r.status, r.h.get('content-type')], [200, 'application/json']);
    assert.ok(r.h.get('cache-control').includes('no-store'));
    return r.text;
  };
  const [a, b] = ['203.0.113.7', '203.0.113.8'];
  assert.equal(await ask(a), '{"lan":"ok"}');
  const held = [];
  for (let i = 0; i < WS_PER_ADDRESS; i++) {
    const r = await up(a);
    assert.ok(r.admit && r.admit.release, 'admitted');
    held.push(r.admit);
  }
  const ninth = (await up(a)).admit;
  assert.deepEqual([ninth.refuse, ninth.why, ninth.log], [429, 'busy', '[lan] refused a connection: 8 already open from that address'], 'the 9th from that address');
  assert.equal(await ask(a), '{"lan":"busy"}');
  assert.equal(await ask(b), '{"lan":"ok"}');
  held.pop().release();
  assert.equal(await ask(a, 'http://localhost'), '{"lan":"ok"}');
  assert.equal(await ask(a, 'https://elsewhere.example'), '{"lan":"page"}');
  const c = '203.0.113.9';
  for (let i = 0; i < LAN_OPEN_BURST; i++) {
    const r = await up(c);
    assert.ok(r.admit.release);
    r.admit.release();
  }
  assert.equal(await ask(c), '{"lan":"fast"}');
  const fast = (await up(c)).admit;
  assert.deepEqual([fast.refuse, fast.why], [429, 'fast'], 'as its upgrade meets it');
  // the checks before the budgets, in Rust's order, each its raw answer
  assert.equal((await up(a, 'https://elsewhere.example')).status, 403);
  const bad = async (path, h) => {
    const r = await lanUpgrade(new Request('http://localhost' + path, { headers: { host: 'localhost', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...h } }), k.env);
    return r instanceof Response ? r.status : 'opts';
  };
  assert.equal(await bad('/lan', { host: 'evil.example' }), 421);
  assert.equal(await bad('/other', {}), 404);
  assert.equal(await bad('/lan', { 'sec-websocket-version': '8' }), 400);
  assert.equal(await bad('/lan', { 'sec-websocket-key': 'nope' }), 400);
  assert.equal(await bad('/lan', { upgrade: 'h2c' }), 400);
  // a malformed subprotocol list: 400, after the budgets (opts.protocolBad)
  const d = '198.51.100.1';
  const r = await lanUpgrade(new Request('http://localhost/lan?resume&queue', { headers: { host: 'localhost', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-protocol': 'a,,b', 'cf-connecting-ip': '2001:db8:1:2ff::1', 'cf-ipcountry': 'de' } }), k.env);
  assert.deepEqual([r.key, r.site, r.opts.resume, r.opts.queue, r.opts.protocolBad, r.opts.country, r.opts.group.length, r.opts.site.length], ['2001:db8:1:200::/56', '2001:db8:1::/48', true, true, true, 'DE', 22, 22]);
  const pb = k.standIn.gate.take(r.key, r.site, kit.now, r.opts);
  assert.deepEqual([pb.refuse, pb.status, pb.response.status], ['protocol', 400, 400]);
  assert.equal(k.standIn.gate.held(r.key), 0, 'its share given back');
  void d;
  const raw = refuseResponse(429);
  assert.deepEqual([raw.status, raw.headers.get('content-length'), raw.headers.get('connection'), raw.headers.get('x-robots-tag')], [429, '0', 'close', 'noindex, nofollow']);
  assert.equal(refuseResponse(999).status, 400);
});

test('/names with a claims store: own pages only, reads, claims, refusals (names.rs, the HTTP shell)', async () => {
  const k = kit({ NAMES: 'on' });
  const claimed = new Map();
  const claims = {
    clean: (n) => (/^[A-Za-z0-9 _]{1,15}$/.test(n) ? n.replace(/ /g, '_') : null),
    ownerOfToken: (t) => 'o' + t[0],
    status(name, owner) {
      const c = this.clean(name);
      if (c === null) return { kind: 'invalid' };
      if (c.toLowerCase() === 'name') return { kind: 'default' };
      const h = claimed.get(c.toLowerCase());
      if (!h) return { kind: 'free' };
      return h === owner ? { kind: 'yours', until: 99, current: true } : { kind: 'taken' };
    },
    mine(owner) {
      for (const [n, o] of claimed) if (o === owner) return { name: n, until: 99, next_change: 0 };
      return null;
    },
    claim(name, owner) {
      claimed.set(this.clean(name).toLowerCase(), owner);
      return { mine: { name: this.clean(name).toLowerCase(), until: 99, next_change: 0 } };
    },
  };
  k.standIn.names = new NamesRoute({ claims, keyphraseKnown: async (t) => t[0] === 'A' });
  const A = { authorization: 'Bearer ' + 'A'.repeat(43) };
  const B = { authorization: 'Bearer ' + 'B'.repeat(43) };
  const g = await k.get('/names?name=Alex%20the%20Great');
  assert.deepEqual([g.status, g.text, g.h.get('cache-control')], [200, '{"name":"Alex_the_Great","state":"free"}', 'private, no-store, no-transform']);
  assert.equal((await k.get('/names?name=%21%21')).text, '{"name":null,"state":"invalid"}');
  const post = (who, name, extra = {}) => k.req('POST', '/names', { ...who, 'content-type': 'application/json', ...extra }, JSON.stringify({ name }));
  assert.equal((await post({}, 'Alex')).status, 401);
  assert.deepEqual([(await post(B, 'Alex')).status, (await post(B, 'Alex')).text], [404, '{"error":"keyphrase"}']);
  assert.equal((await post(A, 'NAME')).text, '{"error":"default"}');
  const c = await post(A, 'Alex');
  assert.deepEqual([c.status, JSON.parse(c.text).state], [200, 'yours']);
  assert.equal(JSON.parse((await k.get('/names?name=alex&alt=Alex4821', A)).text).alt.state, 'free');
  assert.equal((await post(B, 'ALEX')).status, 409);
  assert.equal((await post(A, 'Evil', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(A, 'Evil', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await k.req('PUT', '/names', A)).status, 405);
  assert.equal((await k.req('POST', '/names', A, 'x'.repeat(5000))).status, 413);
  assert.equal((await k.req('POST', '/names', A, '[1]')).status, 400);
});


test('the DO side: LanGate and the internal dispatcher (state_routes.js handle)', async () => {
  const { LanGate } = await import('../src/http/lan_gate.js');
  const { handle: dispatch } = await import('../src/http/state_routes.js');
  const g = new LanGate({});
  const held = [];
  for (let i = 0; i < 8; i++) held.push(g.take('1.2.3.4', '', 0, { protocol: 'a' }));
  assert.ok(held.every((t) => t.share && t.protocol === 'a'));
  assert.deepEqual([g.count(), g.held('1.2.3.4')], [8, 8]);
  const no = g.take('1.2.3.4', '', 0, {});
  assert.deepEqual([no.refuse, no.status, no.body, no.headers['content-length'], no.headers.connection], ['busy', 429, '', '0', 'close']);
  assert.equal(g.check('1.2.3.4', '', 0), 'busy');
  g.release(held[7].share);
  g.release(held[7].share);
  assert.deepEqual([g.check('1.2.3.4', '', 0), g.count()], ['ok', 7]);
  // a site's share: 16 for the /48
  const s = new LanGate();
  for (let i = 0; i < 16; i++) assert.ok(s.take('k' + (i % 4), 'site', 0).share);
  assert.equal(s.take('k9', 'site', 0).refuse, 'busy');
  assert.equal(s.check('k9', '', 0), 'ok');
  // the open rate: a burst of 20, then 1 a second (a share taken and given each time)
  const f = new LanGate();
  for (let i = 0; i < 20; i++) f.release(f.take('x', '', 0).share);
  assert.equal(f.check('x', '', 0), 'fast');
  const fr = f.take('x', '', 0);
  assert.deepEqual([fr.refuse, fr.log, f.count()], ['fast', '[lan] refused a connection: that address opens them too fast', 0]);
  assert.equal(f.check('x', '', 1000), 'ok');
  assert.equal(new LanGate().take('h', '', 0, { protocolBad: true }).status, 400);
  const view = { peerCount: () => 2, full: () => true, waiting: () => 1, nowMs: 5, gate: g, online: async () => ({ personas: 1, racing: 0 }), roam: null, days: null };
  const r = await dispatch(new Request('https://switch/players?room=1'), view);
  assert.equal(JSON.parse((await r.json()).body).online, 1);
  const c = await dispatch(new Request('https://switch/lan-check', { headers: { 'x-nfsu2-ids': JSON.stringify({ key: '1.2.3.4', siteKey: '', group: 'g', site: '' }) } }), view);
  assert.equal((await c.json()).body, '{"lan":"ok"}');
  assert.equal((await dispatch(new Request('https://switch/names'), view).then((x) => x.json())).status, 404);
  assert.equal(await dispatch(new Request('https://switch/other'), view), null);
  assert.equal(await dispatch(new Request('https://switch/lan', { headers: { 'x-lan-opts': '{}' } }), view), null);
});
