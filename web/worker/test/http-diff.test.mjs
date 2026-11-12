// Differential tests of the Worker's HTTP rules against the Rust code: seeded inputs (web/worker/src/util/prng.js)
// go through the Rust functions (web/server-rs/crates/lan-diff-http, which includes src/app's url.rs, etag.rs,
// settings_days.rs and manifest.rs as they are, and calls nfsu2-headers, nfsu2-ws and nfsu2-util) and through the JS
// ports, and every output must be equal.  Without cargo, the checked-in fixture (test/fixtures/http-diff.json, the
// Rust outputs of the first seeds) is replayed instead.  NFSU2_WRITE_FIXTURES=1 rewrites it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prng } from '../src/util/prng.js';
import * as H from '../src/http/headers.js';
import { Bucket, Budget } from '../src/http/limits.js';
import { etagOf } from '../src/http/etag.js';
import { buildManifest, gameEntry, GAME_ENTRIES } from '../src/http/manifest.js';
import { pickProtocol } from '../src/http/lan.js';
import { reportParse } from '../src/http/state_routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RS = path.resolve(here, '../../server-rs');
const FIXTURE = path.join(here, 'fixtures/http-diff.json');
const SEEDS = Number(process.env.NFSU2_DIFF_SEEDS ?? 40);
const FIXTURE_SEEDS = 6;

/** the Rust tracer, built (cargo shares the server's target folder), or null without cargo */
function rustBinary() {
  if (process.env.NFSU2_NO_CARGO) return null;
  const b = spawnSync('cargo', ['build', '--release', '-q', '-p', 'nfsu2-lan-diff-http'], { cwd: RS, encoding: 'utf8', timeout: 1_800_000 });
  if (b.error || b.status !== 0) {
    if (b.error && b.error.code === 'ENOENT') return null;
    throw new Error('cargo build -p nfsu2-lan-diff-http failed: ' + (b.stderr || b.error));
  }
  return path.join(RS, 'target/release/difftrace-http');
}

function runRust(bin, calls) {
  const r = spawnSync(bin, [], { input: calls.map((c) => JSON.stringify(c)).join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('difftrace-http: ' + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, calls.length);
  return lines.map((l) => JSON.parse(l));
}

// ---- inputs ----------------------------------------------------------------------------

const pick = (p, list) => list[p.below(list.length)];
function str(p, alphabet, max) {
  const n = p.below(max + 1);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[p.below(alphabet.length)];
  return s;
}
const A_ENC = ['gzip', 'br', 'zstd', 'deflate', 'identity', '*', 'GZIP', 'Br', ',', ', ', ';', 'q=0', 'q=1', 'q = 0.000', 'q=0.0001', 'q=0.5', ' ', '\t', 'x'];
const A_HOST = ['a', 'b', 'x', '-', '_', '.', ':', '[', ']', '1', '2', '0', '9', 'f', 'F', ':', '::', 'localhost', 'example', 'com', '127', '%', ' ', '\u212A', 'é', 'zone', 'test'];
const A_IP = ['0', '1', '2', '5', '9', '00', '255', '256', '.', ':', '::', 'ffff', 'FFFF', 'db8', '2001', 'a', 'g', '%', 'en0', '[', ']', ' ', '127', 'fe80'];
const A_URL = ['/', 'a', 'B', '.', '..', '%2e', '%2E', '%2f', '%5C', '%', '%41', '%zz', '%e9', 'é', '\\', '?', '#', '&', '=', '+', ' ', '\t', '\n', '\x00', '\x7f', '[', ']', '@', ':', 'x', '%C3%A9', '|', '^', '\u{1F600}', 'data', 'lan', '\u00FF'];
const A_ABS = ['http', 'https', 'ws', 'file', 'ftp', 'foo', ':', '//', '/', '\\', 'user', '@', 'Host', 'EXAMPLE', '.com', ':80', ':443', ':8080', '[::1]', '[::FFFF:1.2.3.4]', '127.0.0.1', '0x7f.1', '%41', '?', '#', ' ', 'null'];
// (no "xn--": url.rs refuses the bare punycode prefix as a host, as the Node server's Ada did; Node 24's takes it.  An
// Origin of such a host is none of the server's names either way)
const A_PROTO = ['a', 'b', 'chat', ',', ' ', '\t', ', ', ';', '"', 'é', '-', '.', '~', '!', '(', 'x'];
const A_REPORT = ['fps', '=', '30', ',', 'hud', '_', 'A', 'z', '9', ':', '.', '+', '-', ' ', '%', 'roam_name', 'set', '==', 'é'];

/** a double's bits as a decimal string (the tracer reads the number from them) */
function bitsOf(x) {
  const d = new DataView(new ArrayBuffer(8));
  d.setFloat64(0, x);
  return d.getBigUint64(0).toString();
}
function fromBits(b) {
  const d = new DataView(new ArrayBuffer(8));
  d.setBigUint64(0, BigInt(b));
  return d.getFloat64(0);
}

function inputs(seed) {
  const p = new Prng(BigInt(seed) * 7919n + 17n);
  const calls = [];
  for (let i = 0; i < 25; i++) {
    calls.push({ fn: 'pick_encoding', header: p.below(10) === 0 ? null : str(p, A_ENC, 8), have: pick(p, [['zstd', 'br', 'gzip'], ['br', 'gzip'], ['gzip']]) });
    const tag = '"' + str(p, ['a', 'b', 'c'], 3) + '"';
    calls.push({ fn: 'etag_matches', header: p.below(8) === 0 ? null : str(p, [tag, 'W/', '"a"', '"b"', ',', ' ', '*', 'w/', '"'], 6), etag: p.below(3) ? tag : 'W/' + tag });
    calls.push({ fn: 'host_name', h: str(p, A_HOST, 7) });
    calls.push({ fn: 'host_check', names: [str(p, A_HOST, 4), '*.' + str(p, ['a', 'zone', 'test', '.'], 3), pick(p, ['2001:DB8::1', 'game.example.com', '10.0.0.1'])], host: p.below(10) === 0 ? null : str(p, A_HOST, 6) });
    calls.push({ fn: 'is_local_or_ip', h: p.below(10) === 0 ? null : str(p, A_HOST, 6) });
    const ip = str(p, A_IP, 9);
    calls.push({ fn: 'address_key', ip }, { fn: 'site_key', ip }, { fn: 'bare_ip', ip }, { fn: 'is_ip', ip });
    calls.push({ fn: 'client_country', value: p.below(8) === 0 ? null : str(p, ['D', 'E', 'x', 'X', 'T', '1', ' ', 'b', 'r', '\t'], 4) });
    calls.push({ fn: 'pick_protocol', header: p.below(8) === 0 ? null : str(p, A_PROTO, 8) });
    const target = '/' + str(p, A_URL, 12);
    calls.push({ fn: 'parse_target', target });
    calls.push({ fn: 'decode_uri_component', s: str(p, A_URL, 10) });
    calls.push({ fn: 'params', target: '/x?' + str(p, ['a', 'b', '=', '&', '+', '%20', '%', '%zz', 'é', '?', '#', 'room', '5', ','], 10), names: ['a', 'b', 'room', 'a b', ''] });
    calls.push({ fn: 'parse_absolute', input: str(p, A_ABS, 6) });
    calls.push({ fn: 'report', k: p.below(6) === 0 ? null : pick(p, ['pc', 'phone', 'tablet', 'toaster', 'PC']), s: p.below(6) === 0 ? null : str(p, A_REPORT, 14) });
    calls.push({ fn: 'game_entry', name: pick(p, [...GAME_ENTRIES, 'SPEED2.EXE', 'TRAC\u212AS', 'Global', 'save', 'unins000.dat', '', 'tracks2']) });
    calls.push({ fn: 'num', bits: bitsOf(pick(p, [p.next32() / 7, p.next32() * 1000 + p.below(1000) / 1000, 1e21, 1e-7, -0, 0.1 + 0.2, 2 ** 53 + 2, 1729512345123.4567, p.unit()])) });
    calls.push({ fn: 'etag_of', key: Array.from(p.bytes(1 + p.below(40))), parts: Array.from({ length: p.below(4) }, () => str(p, ['a', '/', 'é', '\u0000', '1', '.'], 6)) });
  }
  for (let i = 0; i < 4; i++) {
    const ops = Array.from({ length: 40 }, () => [pick(p, ['take', 'take', 'room', 'give']), pick(p, ['a', 'b', 'c', 'd']), pick(p, ['', 's', 't'])]);
    calls.push({ fn: 'budget', per: 1 + p.below(4), per_site: 1 + p.below(6), total: p.below(4) === 0 ? null : 2 + p.below(8), free: pick(p, [0, 0.25, 0.5]), ops });
    let t = 0;
    const bops = Array.from({ length: 30 }, () => [pick(p, ['take', 'spend', 'has']), (t += p.below(700)), pick(p, [0, 0.5, 1, 2, 10])]);
    calls.push({ fn: 'bucket', rate: pick(p, [0, 0.5, 1, 10, 1 / 30]), burst: pick(p, [1, 5, 20, 2.5]), t0: 0, ops: bops });
  }
  calls.push({ fn: 'security_headers', hsts: p.below(2) === 0, noindex: p.below(2) === 0 });
  calls.push({ fn: 'cache_headers', kind: pick(p, ['store', 'revalidate', 'immutable']) });
  calls.push({ fn: 'csp', script: Array.from({ length: p.below(3) }, () => 'sha256-' + str(p, ['a', 'B', '+', '/'], 8)), style: Array.from({ length: p.below(3) }, () => 'sha256-x') });
  return calls;
}

// ---- the JS side ----------------------------------------------------------------------------

function jsUrl(u) {
  const noHash = u.href.split('#')[0];
  return { host: u.host, pathname: u.pathname, query: u.search ? u.search.slice(1) : noHash.endsWith('?') ? '' : null };
}

/** Rust's Debug of a Report (settings_days.rs derives it) */
function reportDebug(r) {
  if (!r) return null;
  const q = (s) => JSON.stringify(s);
  return 'Report { device: ' + r.device + ', pairs: [' + r.pairs.map(([k, v]) => '(' + q(k) + ', ' + q(v) + ')').join(', ') + '] }';
}

async function js(c) {
  switch (c.fn) {
    case 'pick_encoding': return H.pickEncoding(c.header, c.have);
    case 'etag_matches': return H.etagMatches(c.header, c.etag);
    case 'host_name': return H.hostName(c.h);
    case 'host_check': {
      const h = new H.HostCheck(c.names);
      return { check: h.check(c.host), names: h.names() };
    }
    case 'is_local_or_ip': return H.isLocalOrIp(c.h);
    case 'address_key': return H.addressKey(c.ip);
    case 'site_key': return H.siteKey(c.ip);
    case 'bare_ip': return H.bareIp(c.ip);
    case 'is_ip': return H.isIp(c.ip);
    case 'client_country': return H.clientCountry(c.value);
    case 'pick_protocol': return pickProtocol(c.header);
    case 'parse_target':
      try {
        // (Node's URL, as workerd's, encodes "^" in a path: WHATWG added it to the path percent-encode set after the
        // Node server url.rs follows; a route compares the decoded path, where both are "^")
        return caret(c, jsUrl(new URL('http://x' + c.target)));
      } catch {
        return null;
      }
    case 'parse_absolute':
      try {
        return caret(c, jsUrl(new URL(c.input)));
      } catch {
        return null;
      }
    case 'decode_uri_component':
      try {
        return decodeURIComponent(c.s);
      } catch {
        return null;
      }
    case 'params': {
      const u = new URL('http://x' + c.target);
      return c.names.map((n) => ({ get: u.searchParams.get(n), has: u.searchParams.has(n) }));
    }
    case 'report': return reportDebug(reportParse(c.k, c.s));
    case 'game_entry': return gameEntry(c.name);
    case 'num': return String(fromBits(c.bits));
    case 'etag_of': return etagOf(Uint8Array.from(c.key), c.parts);
    case 'budget': {
      const b = new Budget(c.per, c.per_site, c.total ?? Infinity, c.free);
      return c.ops.map(([op, k, s]) => (op === 'take' ? b.take(k, s) : op === 'room' ? b.room(k, s) : (b.give(k, s), [b.held(k), b.count()])));
    }
    case 'bucket': {
      const b = Bucket.withBurstAt(c.rate, c.burst, c.t0);
      return c.ops.map(([op, now, n]) => [op === 'take' ? b.takeAt(now, n) : op === 'spend' ? b.spendAt(now, n) : b.hasAt(now, n), b.v, b.levelAt(now + 250)]);
    }
    case 'security_headers': return H.securityHeaders(c.hsts, c.noindex);
    case 'cache_headers': return H.cacheHeaders(c.kind);
    case 'csp': return { csp: H.contentSecurityPolicy(c.script, c.style), default: H.CSP, turnstile: H.CSP_TURNSTILE, pp: H.PERMISSIONS_POLICY };
    default: throw new Error('no such fn ' + c.fn);
  }
}

/** JSON as the Rust tracer writes it (numbers JS-like: nfsu2_util::json::stringify) */
const norm = (v) => JSON.parse(JSON.stringify(v));

/** a made-up install folder from a seed (the manifest's diff): names of the game's and others, hidden ones, odd
 * characters, times to the nanosecond */
function folder(seed) {
  const p = new Prng(BigInt(seed) + 1000n);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-manifest-'));
  const names = ['SPEED2.EXE', 'GLOBAL', 'global2', 'TRACKS', 'Movies', 'SAVE', 'unins000.dat', '.hidden', 'server.cfg', 'TRAC\u212AS', 'scripts'];
  const leaf = ['a.bin', 'B.bin', 'b.bin', '_x', '.dot', '\u00e9t\u00e9', 'a"q.txt', 'z', 'Z', 'a-b', 'a/b'.replace('/', '_'), '\u{1F600}.x', '\uE000'];
  const files = [];
  for (let i = 0; i < 6 + p.below(20); i++) {
    const depth = p.below(3);
    const parts = [pick(p, names)];
    for (let d = 0; d < depth; d++) parts.push(pick(p, ['sub', 'Sub', 'x', '.h', '\u00e9']));
    parts.push(pick(p, leaf));
    const rel = depth === 0 && p.below(3) === 0 ? parts[0] : parts.join('/');
    const abs = path.join(root, rel);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (fs.existsSync(abs)) continue;
      fs.writeFileSync(abs, p.bytes(p.below(3000)));
      const sec = 1_000_000_000 + p.below(1_000_000_000);
      const nsec = pick(p, [0, 999_999_999, p.below(1_000_000_000)]);
      // (utimes takes seconds as a double: the nanoseconds as close as it gets)
      fs.utimesSync(abs, sec + nsec / 1e9, sec + nsec / 1e9);
      files.push(rel);
    } catch {
      // a file where a folder was wanted: skipped
    }
  }
  return root;
}

/** the folder's listing as the Worker sees R2: every file's path, size and Node's mtimeMs */
function listing(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) {
        const st = fs.statSync(path.join(dir, e.name));
        out.push({ p: r, s: st.size, m: st.mtimeMs });
      }
    }
  };
  walk(root, '');
  return out;
}

/** "^" in a path as one spelling ("^"): Ada encodes it, or not, by its version (Node 24's always; url.rs follows the
 * Node server's, which encoded it only beside another character of the path set); a route compares the decoded path,
 * where both are "^" */
function caret(c, v) {
  // (an opaque path's spaces before a query: newer Ada encodes the last as %20, as WHATWG now says; url.rs as the
  // Node server's left them; the routes read only an absolute URL's host)
  if (c.fn === 'parse_absolute' && v !== null && !v.pathname.startsWith('/') && !/%20/.test(c.input)) return { ...v, pathname: v.pathname.replace(/%20/g, ' ') };
  if (c.fn !== 'parse_target' || v === null || /%5e/i.test(c.target)) return v;
  return { ...v, pathname: v.pathname.replace(/%5E/g, '^') };
}

async function compare(calls, want, label) {
  let n = 0;
  for (let i = 0; i < calls.length; i++) {
    const got = norm(await js(calls[i]));
    assert.deepEqual(got, caret(calls[i], want[i]), label + ': ' + JSON.stringify(calls[i]));
    n++;
  }
  return n;
}

test('the HTTP rules: JS equals Rust over seeded inputs', async (t) => {
  const bin = rustBinary();
  let total = 0;
  if (bin) {
    const fixture = { note: 'Rust outputs (web/server-rs/crates/lan-diff-http) of test/http-diff.test.mjs inputs for the first seeds', seeds: [] };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const calls = inputs(seed);
      const want = runRust(bin, calls);
      total += await compare(calls, want, 'seed ' + seed);
      if (seed <= FIXTURE_SEEDS) fixture.seeds.push({ seed, calls, want });
    }
    if (process.env.NFSU2_WRITE_FIXTURES) fs.writeFileSync(FIXTURE, JSON.stringify(fixture) + '\n');
    t.diagnostic('compared ' + total + ' calls against the Rust code, seeds 1..' + SEEDS);
  } else {
    t.diagnostic('cargo not found: replaying the fixture ' + path.basename(FIXTURE));
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    for (const s of fixture.seeds) {
      assert.deepEqual(norm(inputs(s.seed)), s.calls, 'the inputs of seed ' + s.seed + ' are the fixture\'s');
      total += await compare(s.calls, s.want, 'fixture seed ' + s.seed);
    }
    t.diagnostic('compared ' + total + ' calls against the fixture');
  }
  assert.ok(total > 1000);
});

test('the manifest: JS over the listing equals Rust\'s walk of the folder', async (t) => {
  const bin = rustBinary();
  if (!bin) {
    t.skip('cargo not found: the manifest diff needs the Rust walk of a real folder');
    return;
  }
  const key = Array.from({ length: 32 }, (_, i) => i * 7);
  let n = 0;
  for (let seed = 1; seed <= Math.max(8, SEEDS / 2); seed++) {
    const root = folder(seed);
    try {
      const [want] = runRust(bin, [{ fn: 'manifest', dir: root, key }]);
      const list = listing(root);
      const m = buildManifest(list);
      const { sha256Hex } = await import('../src/http/etag.js');
      const etag = await etagOf(Uint8Array.from(key), ['manifest', await sha256Hex(new TextEncoder().encode(m.body))]);
      // (a folder Rust lists that has no file under it, at any depth, is not in R2's listing: compared without them)
      const wantFiles = want.files;
      assert.deepEqual(m.files, wantFiles, 'seed ' + seed + ' files');
      const hasFiles = (p) => list.some((f) => f.p.startsWith(p + '/'));
      const rv = JSON.parse(want.body);
      rv.files = rv.files.filter((f) => f.d !== 1 || hasFiles(f.p));
      if (rv.files.length === want.count) {
        assert.equal(m.body, want.body, 'seed ' + seed + ' body');
        assert.equal(etag, want.etag, 'seed ' + seed + ' etag');
      } else {
        assert.deepEqual(JSON.parse(m.body), rv, 'seed ' + seed + ' body (without empty folders)');
      }
      n++;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  t.diagnostic('compared ' + n + ' manifests');
});

