// The Rust unit tests of the Worker's HTTP side, ported: crates/headers/src/tests.rs (what applies to the Worker),
// crates/util/src/bucket.rs, crates/ws pick_protocol, src/app/files.rs, mod.rs, etag.rs, wasm.rs, lan.rs (ws_key),
// settings_days.rs (Report::parse), days.rs (id_ok) and manifest.rs (the walk's order, over a listing).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from '../src/http/headers.js';
import { Bucket, Budget, Rate } from '../src/http/limits.js';
import { resolveInside, resolveGame, devOnly, parseRange, hasWord, rangeOf, extname, dirname } from '../src/http/files.js';
import { etagOf, num } from '../src/http/etag.js';
import { buildManifest, gameEntry } from '../src/http/manifest.js';
import { wsKey, pickProtocol, groupId } from '../src/http/lan.js';
import { reportParse, idOk, parseU32 } from '../src/http/state_routes.js';

test('csp and policies (headers tests.rs csp_and_policies, the_policy_with_turnstile)', () => {
  assert.equal(H.contentSecurityPolicy([], []), H.CSP);
  assert.equal(H.CSP,
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; " +
    "img-src 'self' data: blob:; style-src 'self'; font-src 'self'; media-src 'self'; object-src 'none'; " +
    "base-uri 'none'; form-action 'self'; frame-src 'none'; frame-ancestors 'none'");
  const w = H.contentSecurityPolicy(['sha256-a', 'sha256-b'], ['sha256-c']);
  assert.ok(w.includes("script-src 'self' 'wasm-unsafe-eval' 'sha256-a' 'sha256-b'; worker-src"));
  assert.ok(w.includes("style-src 'self' 'sha256-c'; font-src"));
  assert.ok(H.PERMISSIONS_POLICY.startsWith('gamepad=(self), fullscreen=(self), '));
  assert.ok(H.PERMISSIONS_POLICY.endsWith(', window-management=(), xr-spatial-tracking=()'));
  assert.equal(H.PERMISSIONS_POLICY.split(', ').length, 27);
  const cf = 'https://challenges.cloudflare.com';
  assert.equal(H.CSP_TURNSTILE, H.CSP.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' " + cf).replace("frame-src 'none'", 'frame-src ' + cf));
});

test('security headers in order', () => {
  const h = H.securityHeaders(false, true);
  assert.deepEqual(h.map(([k]) => k), [
    'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'content-security-policy',
    'x-content-type-options', 'referrer-policy', 'x-frame-options', 'permissions-policy', 'x-robots-tag']);
  assert.equal(h[1][1], 'require-corp');
  assert.equal(h[8][1], 'noindex, nofollow');
  const h2 = H.securityHeaders(true, false);
  assert.equal(h2[8][1], 'index, follow');
  assert.deepEqual(h2.at(-1), ['strict-transport-security', H.HSTS]);
});

test('cache headers by kind', () => {
  assert.deepEqual(H.cacheHeaders(H.Cache.Store), [
    ['cache-control', 'private, no-store, no-transform'], ['cdn-cache-control', 'no-store'], ['cloudflare-cdn-cache-control', 'no-store']]);
  assert.deepEqual(H.cacheHeaders(H.Cache.Revalidate)[0], ['cache-control', 'private, no-cache, no-transform']);
  assert.deepEqual(H.cacheHeaders(H.Cache.Immutable), [
    ['cache-control', 'public, max-age=31536000, immutable, no-transform'], ['cdn-cache-control', H.EDGE_KEEP], ['cloudflare-cdn-cache-control', H.EDGE_KEEP]]);
});

test('accept-encoding: the first the client takes', () => {
  const have = ['zstd', 'br', 'gzip'];
  assert.equal(H.pickEncoding('gzip, deflate, br, zstd', have), 'zstd');
  assert.equal(H.pickEncoding('gzip, br', have), 'br');
  assert.equal(H.pickEncoding('GZIP', have), 'gzip');
  assert.equal(H.pickEncoding('br;q=0, gzip', have), 'gzip');
  assert.equal(H.pickEncoding('zstd;q=0.0, br; q=1', have), 'br');
  assert.equal(H.pickEncoding('identity', have), null);
  assert.equal(H.pickEncoding('*', have), null);
  assert.equal(H.pickEncoding(null, have), null);
  assert.equal(H.pickEncoding('zstd, br', ['br', 'gzip']), 'br');
  assert.equal(H.pickEncoding('zstd; q = 0.000, br;q=0.0000', have), 'br');
  assert.equal(H.pickEncoding('zstd;q=0.001', have), 'zstd');
});

test('if-none-match', () => {
  assert.ok(H.etagMatches('"abc"', '"abc"'));
  assert.ok(H.etagMatches('W/"abc"', '"abc"'));
  assert.ok(H.etagMatches('"abc"', 'W/"abc"'));
  assert.ok(H.etagMatches('"x", "abc"', '"abc"'));
  assert.ok(H.etagMatches(' * ', '"abc"'));
  assert.ok(!H.etagMatches('"ab"', '"abc"'));
  assert.ok(!H.etagMatches('w/"abc"', '"abc"'));
  assert.ok(!H.etagMatches('', '"abc"'));
  assert.ok(!H.etagMatches(null, '"abc"'));
});

test('bare ip examples', () => {
  assert.equal(H.bareIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(H.bareIp('::FFFF:10.0.0.1'), '10.0.0.1');
  assert.equal(H.bareIp('[::1]'), '::1');
  assert.equal(H.bareIp('fe80::1%en0'), 'fe80::1');
  assert.equal(H.bareIp(' 2001:DB8::1 '), '2001:db8::1');
  assert.equal(H.bareIp('::ffff:7f00:1'), '::ffff:7f00:1');
  for (const not of ['', 'garbage', '1.2.3', '01.2.3.4', '256.1.1.1', '::ffff:1.2.3', '2001::db8::1', '[::1]:80', '%1']) assert.equal(H.bareIp(not), '', not);
  assert.equal(H.isIp('1.2.3.4'), 4);
  assert.equal(H.isIp('fe80::1%eth0'), 6);
  assert.equal(H.isIp('[::1]'), 0);
});

test('address and site keys', () => {
  assert.equal(H.addressKey('2001:db8:1:2ff::1'), '2001:db8:1:200::/56');
  assert.equal(H.addressKey('2001:db8:1:2ff:ffff:ffff:ffff:ffff'), '2001:db8:1:200::/56');
  assert.equal(H.siteKey('2001:db8:1:2ff::1'), '2001:db8:1::/48');
  assert.equal(H.addressKey('[2001:0DB8:0001:00ff::]'), '2001:db8:1:0::/56');
  assert.equal(H.addressKey('::1'), '0:0:0:0::/56');
  assert.equal(H.siteKey('::1.2.3.4'), '0:0:0::/48');
  assert.equal(H.addressKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(H.siteKey('1.2.3.4'), '');
  assert.equal(H.addressKey('garbage'), '');
  assert.equal(H.siteKey('garbage'), '');
});

test('host names', () => {
  const cases = [
    ['localhost', 'localhost'], ['Game.Example.Com.:443', 'game.example.com'], ['127.0.0.1:8527', '127.0.0.1'],
    ['1.2.3.4:99999', '1.2.3.4'], ['[::1]:8080', '::1'], ['[2001:DB8:0::1]', '2001:db8::1'], ['2001:db8::1', '2001:db8::1'],
    ['[::FFFF:1.2.3.4]:443', '::ffff:102:304'], ['under_score.example', 'under_score.example'], ['a-.example', 'a-.example'],
    ['\u212Aelvin.example', 'kelvin.example'], [' x.example ', 'x.example'], ['[fe80::1%25eth0]', ''], ['fe80::1%eth0', ''],
    ['1.2.3.4:123456', ''], ['x:y', ''], ['[::1', ''], ['[::1]x', ''], ['[::1]:', ''], ['[1.2.3.4]', ''], ['-bad.example', ''],
    ['a..b', ''], ['a.b..', ''], ['é.example', ''], ['', ''],
  ];
  for (const [h, n] of cases) assert.equal(H.hostName(h), n, JSON.stringify(h));
  const long = 'x'.repeat(63);
  assert.equal(H.hostName(long + '.com'), long + '.com');
  assert.equal(H.hostName(long + 'x.com'), '');
});

test('local or ip', () => {
  for (const yes of ['localhost:8080', 'LOCALHOST.', 'a.localhost:80', '[::1]:80', '[anything', '1.2.3.4:443', 'fe80::1%eth0', '2001:db8::abc']) assert.ok(H.isLocalOrIp(yes), yes);
  for (const no of ['example.com', '::1', '2001:db8::1', '', 'localhost.example']) assert.ok(!H.isLocalOrIp(no), no);
  assert.ok(!H.isLocalOrIp(null));
});

test('host check (without the certificate names)', () => {
  const c = new H.HostCheck(['game.example.com', '*.zone.test', '2001:DB8::1']);
  for (const yes of ['game.example.com:443', 'GAME.example.com.', 'a.zone.test', 'localhost:1', '127.9.9.9', '[::1]:80', '[2001:db8::1]', '[2001:db8:0::1]:8']) assert.ok(c.check(yes), yes);
  for (const no of ['b.a.zone.test', 'zone.test', '.zone.test', 'evil.example', '', '[::2]']) assert.ok(!c.check(no), no);
  assert.ok(!c.check(null));
  assert.deepEqual(c.names(), ['game.example.com', '2001:db8::1', '*.zone.test']);
});

test('the country (as a trusted proxy names it)', () => {
  assert.equal(H.clientCountry('DE'), 'DE');
  assert.equal(H.clientCountry(' br '), 'BR');
  for (const v of ['XX', 'T1', 'D', 'DEU', '1A', '']) assert.equal(H.clientCountry(v), null, v);
  assert.equal(H.clientCountry(null), null);
});

test('buckets, budgets, rates (util bucket.rs tests)', () => {
  const b = Bucket.newAt(10, 0);
  assert.ok(b.takeAt(0, 20));
  assert.ok(!b.takeAt(0, 1));
  assert.ok(b.hasAt(100, 1));
  assert.ok(!b.spendAt(100, 100));
  assert.equal(b.v, -20);
  const o = Bucket.withBurstAt(2, 5, 0);
  assert.ok(o.takeAt(0, 5) && !o.takeAt(0, 1));
  assert.equal(o.levelAt(1000), 2);
  assert.equal(o.v, 0);
  assert.equal(o.levelAt(10000), 5);
  assert.ok(o.takeAt(500, 1) && !o.takeAt(500, 0.5));
  const g = new Budget(3, 5, 4, 0.25);
  assert.ok(g.take('a', '') && g.take('a', '') && g.take('b', ''));
  assert.ok(!g.take('a', ''));
  assert.ok(g.take('c', ''));
  assert.ok(!g.take('d', ''));
  g.give('a', '');
  assert.equal(g.held('a'), 1);
  g.give('a', '');
  assert.deepEqual([g.held('a'), g.count()], [0, 2]);
  const s = new Budget(5, 2, 100, 0);
  assert.ok(s.take('x', 's') && s.take('y', 's') && !s.take('z', 's'));
  s.give('x', 's');
  assert.ok(s.take('z', 's'));
  assert.ok(!s.by.has('x'));
  const r = new Budget(2, 3, 100, 0);
  assert.ok(r.room('a', 's') && r.room('a', 's'));
  assert.equal(r.count(), 0);
  assert.ok(r.take('a', 's') && r.take('a', 's'));
  assert.ok(!r.room('a', 's'));
  assert.ok(r.room('b', 's') && r.take('b', 's'));
  assert.ok(!r.room('c', 's'));
  assert.ok(r.room('c', ''));
  r.give('a', 's');
  assert.ok(r.room('a', 's') && r.room('c', 's'));
  const f = new Budget(9, 9, 4, 0.25);
  assert.ok(f.take('a', '') && f.take('a', '') && f.take('b', ''));
  assert.ok(!f.room('a', '') && f.room('c', ''));
  const rate = new Rate(2, 0);
  assert.ok(rate.take('a', 's', 0) && rate.take('a', 's', 0) && !rate.take('a', 's', 0));
  assert.ok(rate.take('b', 's', 0) && rate.take('b', 's', 0) && !rate.take('c', 's', 0));
  const r2 = new Rate(1, 1);
  assert.ok(r2.take('k', '', 0) && !r2.check('k', '', 500) && r2.check('k', '', 1000));
  r2.prune(5000);
  assert.equal(r2.m.size, 0);
});

test('websocket keys (lan.rs) and subprotocols (ws pick_protocol)', () => {
  assert.ok(wsKey('dGhlIHNhbXBsZSBub25jZQ=='));
  assert.ok(wsKey('+/+/+/+/+/+/+/+/+/+/+/=='));
  for (const bad of ['nope', 'dGhlIHNhbXBsZSBub25jZQ=', 'dGhlIHNhbXBsZSBub25jZQ==x', 'dGhlIHNhbXBsZSBub25jZ-==']) assert.ok(!wsKey(bad), bad);
  assert.deepEqual(pickProtocol(null), { ok: true, protocol: null });
  assert.deepEqual(pickProtocol('a'), { ok: true, protocol: 'a' });
  assert.deepEqual(pickProtocol('a, b'), { ok: true, protocol: 'a' });
  assert.deepEqual(pickProtocol('a ,b\t, c'), { ok: true, protocol: 'a' });
  for (const bad of ['', ' a', 'a,', ',a', 'a,,b', 'a, a', 'a b', 'a;b', 'a,b,a', 'é']) assert.deepEqual(pickProtocol(bad), { ok: false }, JSON.stringify(bad));
});

test('paths under a root (files.rs)', () => {
  assert.equal(resolveInside('/srv/dist', '/index.html'), '/srv/dist/index.html');
  assert.equal(resolveInside('/srv/dist', '/a/b/'), '/srv/dist/a/b');
  assert.equal(resolveInside('/srv/dist', ''), '/srv/dist');
  for (const bad of ['/../x', '/.git/config', '/a/.hidden', '/./x', '/a/..', '/...']) assert.equal(resolveInside('/srv/dist', bad), null, bad);
  assert.equal(resolveInside('/', '/x'), null);
  assert.equal(resolveGame('/g', '/SPEED2.EXE'), '/g/SPEED2.EXE');
  assert.equal(resolveGame('/g', '/global/x.bin'), '/g/global/x.bin');
  assert.equal(resolveGame('/g', '//TRACKS/a'), '/g/TRACKS/a');
  assert.equal(resolveGame('/g', '/TRAC\u212AS/a'), '/g/TRAC\u212AS/a');
  for (const bad of ['/unins000.dat', '/SAVE/profile', '/', '', '/scripts/mod.ini', '/.hidden']) assert.equal(resolveGame('/g', bad), null, bad);
});

test('dev-only names (files.rs)', () => {
  for (const p of ['/test/play.html', '/tests/x', '/test', '/TEST/x', '/te\u017Ft/play.html', '/main.js.map', '/main.js.MAP', '/\uFF54est/x', '/main.js.\uFF4Dap', '/TE\u017FT/hostcheck.html']) assert.ok(devOnly(p), p);
  for (const p of ['/testing', '/index.html', '/map', '/x/test/y', '/main.js']) assert.ok(!devOnly(p), p);
});

test('ranges (files.rs)', () => {
  assert.deepEqual(parseRange('bytes=0-99'), ['0', '99']);
  assert.deepEqual(parseRange('bytes=-5'), ['', '5']);
  assert.deepEqual(parseRange('bytes=-'), ['', '']);
  assert.equal(parseRange('bytes=0-1,5-6'), null);
  assert.equal(parseRange('bytes=a-1'), null);
  assert.equal(parseRange('items=0-1'), null);
  assert.deepEqual(rangeOf('bytes=0-99', 1000), { code: 206, a: 0, b: 99 });
  assert.deepEqual(rangeOf('bytes=-5', 1000), { code: 206, a: 995, b: 999 });
  assert.deepEqual(rangeOf('bytes=990-', 1000), { code: 206, a: 990, b: 999 });
  assert.deepEqual(rangeOf('bytes=5-2', 1000), { code: 416 });
  assert.deepEqual(rangeOf('bytes=1000-', 1000), { code: 416 });
  assert.deepEqual(rangeOf('bytes=-', 1000), { code: 200, a: 0, b: 999 });
  assert.deepEqual(rangeOf(' bytes=0-0 ', 1000), { code: 206, a: 0, b: 0 });
  assert.deepEqual(rangeOf('bytes=0-1,2-3', 1000), { code: 200, a: 0, b: 999 });
  assert.deepEqual(rangeOf('bytes=-2000', 1000), { code: 206, a: 0, b: 999 });
  assert.equal(extname('/a/b.JS'), '.JS');
  assert.equal(extname('/a/.x'), '');
  assert.equal(dirname('/a/b/c.wasm'), '/a/b');
});

test('words as JS regexes find them (mod.rs)', () => {
  assert.ok(hasWord('gzip, deflate, br', 'br'));
  assert.ok(hasWord('br', 'br'));
  assert.ok(hasWord('gzip;q=1', 'gzip'));
  assert.ok(!hasWord('brotli', 'br'));
  assert.ok(!hasWord('x-gzip2', 'gzip'));
  assert.ok(!hasWord('BR', 'br'));
  assert.ok(hasWord('x-gzip', 'gzip'));
  assert.ok(hasWord('abr, br', 'br'));
});

test('etags equal the Node server\'s (etag.rs)', async () => {
  const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
  assert.equal(await etagOf(KEY, ['manifest', 'abc']), '"hWN06E5JbvKr11mCWqBV1D"');
  assert.equal(await etagOf(KEY, ['/x/y', num(123), num(1729512345123.4567)]), '"6Nn736TQhXw_HdiX9IqQRT"');
  assert.equal(await etagOf(KEY, ['br', '/a/b.wasm', num(0), num(0)]), '"ykFGyTmIRH6O7HRQfcAlfX"');
  assert.equal(await etagOf(KEY, ['/home/user/é.bin', num(65536), num(1760000000999.9998)]), '"X9qPpgFd4gaFHgBuGGlC1c"');
  assert.equal((await groupId(KEY, '1.2.3.4')).length, 22);
});

test('numbers as JSON.parse reads them (wasm.rs js_numbers, as the Worker does it)', () => {
  const m = JSON.parse('{"a":1.0,"b":12345678901234567890,"c":[1e3,-0,0.5],"d":"x","module":"old"}');
  m.module = 'h';
  assert.equal(JSON.stringify(m), '{"a":1,"b":12345678901234567000,"c":[1000,0,0.5],"d":"x","module":"h"}');
});

test('settings reports (settings_days.rs) and page ids (days.rs)', () => {
  assert.deepEqual(reportParse('phone', 'fps=30,roam_name=set'), { device: 1, pairs: [['fps', '30'], ['roam_name', 'set']] });
  assert.deepEqual(reportParse('pc', ''), { device: 0, pairs: [] });
  assert.deepEqual(reportParse('pc', 'fps=1,fps=2,BAD=x,x=,=y,k=v w,ok=a:b._+-'), { device: 0, pairs: [['fps', '1'], ['ok', 'a:b._+-']] });
  assert.equal(reportParse('toaster', 'fps=30'), null);
  assert.equal(reportParse('pc', null), null);
  assert.equal(reportParse(null, 'fps=30'), null);
  assert.equal(reportParse('pc', 'x'.repeat(4097)), null);
  const many = Array.from({ length: 70 }, (_, i) => 'k' + i + '=1').join(',');
  assert.equal(reportParse('pc', many).pairs.length, 64);
  assert.ok(idOk('AAAAAAAAAAAAAAAAAAAAAA') && idOk('a-_') && !idOk('') && !idOk('x'.repeat(65)) && !idOk('not an id'));
  assert.equal(parseU32('+5'), 5);
  assert.equal(parseU32('007'), 7);
  assert.equal(parseU32('4294967295'), 4294967295);
  assert.equal(parseU32('4294967296'), null);
  assert.equal(parseU32('-1'), null);
  assert.equal(parseU32(''), null);
  assert.equal(parseU32(' 1'), null);
});

test('only the game\'s entries in byte order (manifest.rs, over a listing)', () => {
  const list = [
    ['SPEED2.EXE', 7, 1700000000999.999], ['GLOBAL/Game.txt', 6, 1760000123456.789], ['GLOBAL/b.bin', 1000, 1], ['GLOBAL/B.bin', 10, 1],
    ['GLOBAL/_x', 1, 1], ['GLOBAL/\u00e9t\u00e9', 2, 1], ['GLOBAL/a"q.txt', 1, 1], ['GLOBAL/.hidden', 6, 1], ['.hidden', 6, 1],
    ['TRACKS/sub/L4RA.BUN', 3000, 1], ['Movies/INTRO.VP6', 50, 1], ['unins000.dat', 6, 1], ['SAVE/profile', 6, 1], ['scripts/mod.ini', 6, 1],
  ].map(([p, s, m]) => ({ p, s, m }));
  const m = buildManifest(list);
  const v = JSON.parse(m.body);
  assert.deepEqual(v.files.map((f) => f.p), [
    'GLOBAL', 'GLOBAL/B.bin', 'GLOBAL/Game.txt', 'GLOBAL/_x', 'GLOBAL/a"q.txt', 'GLOBAL/b.bin', 'GLOBAL/\u00e9t\u00e9', 'Movies',
    'Movies/INTRO.VP6', 'SPEED2.EXE', 'TRACKS', 'TRACKS/sub', 'TRACKS/sub/L4RA.BUN']);
  assert.equal(m.count, 13);
  assert.deepEqual(v.files[9], { p: 'SPEED2.EXE', s: 7, m: 1700000000 });
  assert.deepEqual(v.blocks, { url: '/data-blocks/v2/', size: 1048576, max: 8 });
  assert.ok(gameEntry('TRAC\u212AS'));
});

