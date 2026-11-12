// Port of web/server-rs/crates/headers (lib.rs, ip.rs): what every response of the server carries, and who the
// client is.  Pure functions over strings.  Addresses are read as Node reads them (net.isIP), host names as the
// WHATWG URL parser writes them.  Only what the Worker needs: the security and cache headers, the Accept-Encoding and
// If-None-Match rules, the Host check, the address keys.  The proxy trust (ProxyTrust, client_ip, via_https,
// forwarded_host) has no Worker counterpart: Cloudflare's edge is the only peer, so CF-Connecting-IP and
// CF-IPCountry are always believed (see lan.js / routes.js).

// ---- Content-Security-Policy ---------------------------------------------------

const CSP_HEAD = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'";
const CSP_MID = "; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'";
const CSP_TAIL =
  "; font-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; " +
  "frame-src 'none'; frame-ancestors 'none'";

/** Port of headers/src/lib.rs CSP: the Content-Security-Policy without hashes (every response but a page with inline
 * code of its own). */
export const CSP = CSP_HEAD + CSP_MID + CSP_TAIL;

/** Port of headers/src/lib.rs CSP_TURNSTILE: CSP with Cloudflare Turnstile's script and frame, for a server whose
 * claimed names ask for its check. */
export const CSP_TURNSTILE =
  CSP_HEAD + ' https://challenges.cloudflare.com' + CSP_MID +
  "; font-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; " +
  "frame-src https://challenges.cloudflare.com; frame-ancestors 'none'";

/** Port of headers/src/lib.rs content_security_policy: the policy with a page's own hashes in script-src and
 * style-src. */
export function contentSecurityPolicy(scriptHashes, styleHashes) {
  const list = (l) => l.map((h) => " '" + h + "'").join('');
  return CSP_HEAD + list(scriptHashes) + CSP_MID + list(styleHashes) + CSP_TAIL;
}

/** Port of headers/src/lib.rs PERMISSIONS_POLICY: only what the game uses. */
export const PERMISSIONS_POLICY =
  'gamepad=(self), fullscreen=(self), keyboard-map=(self), autoplay=(self), cross-origin-isolated=(self), ' +
  'screen-wake-lock=(self), accelerometer=(self), gyroscope=(self), hid=(self), ' +
  'bluetooth=(), browsing-topics=(), camera=(), clipboard-read=(), display-capture=(), ' +
  'encrypted-media=(), geolocation=(), idle-detection=(), local-fonts=(), ' +
  'magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), ' +
  'serial=(), usb=(), window-management=(), xr-spatial-tracking=()';

/** Port of headers/src/lib.rs ISOLATION: what makes the page cross-origin isolated (SharedArrayBuffer). */
export const ISOLATION = Object.freeze([
  ['cross-origin-opener-policy', 'same-origin'],
  ['cross-origin-embedder-policy', 'require-corp'],
  ['cross-origin-resource-policy', 'same-origin'],
]);

/** Port of headers/src/lib.rs HSTS: Strict-Transport-Security, a year. */
export const HSTS = 'max-age=31536000';

/** Port of headers/src/lib.rs security_headers: the headers every response carries, with the default CSP, in the
 * order they are sent; HSTS where hsts, X-Robots-Tag "noindex, nofollow" where noindex ("index, follow" otherwise).
 * Returns [name, value] pairs. */
export function securityHeaders(hsts, noindex) {
  const h = ISOLATION.map(([k, v]) => [k, v]);
  h.push(['content-security-policy', CSP]);
  h.push(['x-content-type-options', 'nosniff']);
  h.push(['referrer-policy', 'no-referrer']);
  h.push(['x-frame-options', 'DENY']);
  h.push(['permissions-policy', PERMISSIONS_POLICY]);
  h.push(['x-robots-tag', noindex ? 'noindex, nofollow' : 'index, follow']);
  if (hsts) h.push(['strict-transport-security', HSTS]);
  return h;
}

// ---- caching -------------------------------------------------------------------

/** Port of headers/src/lib.rs EDGE_KEEP: what every cache, the CDN's too, may keep for good. */
export const EDGE_KEEP = 'public, max-age=31536000, immutable';

/** Port of headers/src/lib.rs enum Cache: who may keep a response (Store: the browser keeps nothing; Revalidate: a
 * copy it revalidates each time; Immutable: an address that names its content, kept for good by every cache). */
export const Cache = Object.freeze({ Store: 'store', Revalidate: 'revalidate', Immutable: 'immutable' });

/** Port of headers/src/lib.rs cache_headers: Cache-Control, CDN-Cache-Control and Cloudflare-CDN-Cache-Control for a
 * Cache, in that order. */
export function cacheHeaders(kind) {
  if (kind === Cache.Immutable) {
    return [
      ['cache-control', EDGE_KEEP + ', no-transform'],
      ['cdn-cache-control', EDGE_KEEP],
      ['cloudflare-cdn-cache-control', EDGE_KEEP],
    ];
  }
  if (kind !== Cache.Store && kind !== Cache.Revalidate) throw new Error('cacheHeaders: not a Cache: ' + kind);
  return [
    ['cache-control', kind === Cache.Revalidate ? 'private, no-cache, no-transform' : 'private, no-store, no-transform'],
    ['cdn-cache-control', 'no-store'],
    ['cloudflare-cdn-cache-control', 'no-store'],
  ];
}

/** JS's \s (String.prototype.trim's white space), one character. */
function isSpace(c) {
  return /^\s$/.test(c);
}

/** Port of headers/src/lib.rs q_zero: /^q=0(\.0{0,3})?$/ once the parameter's white space (JS's \s) is gone. */
function qZero(param) {
  const s = Array.from(param).filter((c) => !isSpace(c)).join('');
  return /^q=0(\.0{0,3})?$/.test(s);
}

/** Port of headers/src/lib.rs pick_encoding: of the encodings the server has (in its order of preference), the first
 * that an Accept-Encoding header takes (a q=0 refuses one; "*" is not read as taking any), or null. */
export function pickEncoding(header, have) {
  const lower = (header ?? '').toLowerCase();
  const ok = [];
  for (const part of lower.split(',')) {
    const pieces = part.split(';');
    const name = pieces[0].trim();
    if (!pieces.slice(1).some((p) => qZero(p.trim()))) ok.push(name);
  }
  for (const e of have) if (ok.includes(e)) return e;
  return null;
}

/** Port of headers/src/lib.rs etag_matches: If-None-Match against an ETag, as a browser or a proxy (which may make it
 * weak) sends it. */
export function etagMatches(header, etag) {
  if (header == null || header === '') return false;
  const bare = etag.startsWith('W/') ? etag.slice(2) : etag;
  return header.split(',').map((t) => t.trim()).some((t) => t === '*' || (t.startsWith('W/') ? t.slice(2) : t) === bare);
}

// ---- addresses (ip.rs) -----------------------------------------------------------

/** Port of ip.rs v4_octet: 0 to 255 without a leading zero. */
function v4Octet(s) {
  if (s.length === 0 || s.length > 3 || !/^[0-9]+$/.test(s) || (s.length > 1 && s[0] === '0')) return null;
  const v = Number(s);
  return v <= 255 ? v : null;
}

/** Port of ip.rs v4: Node's IPv4Reg; the address as a number (0 .. 2^32-1), or null. */
export function v4(s) {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    const o = v4Octet(p);
    if (o === null) return null;
    v = v * 256 + o;
  }
  return v;
}

/** Port of ip.rs hex_group: one to four hex digits, either case. */
function hexGroup(s) {
  if (s.length === 0 || s.length > 4 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  return parseInt(s, 16);
}

/** Port of ip.rs v6_groups: the address part (before a zone) of Node's IPv6Reg, as its eight groups, or null. */
export function v6Groups(s) {
  const g = [0, 0, 0, 0, 0, 0, 0, 0];
  const i = s.indexOf('::');
  if (i < 0) {
    let n = 0;
    let dotted = false;
    for (const part of s.split(':')) {
      if (n === 8 || dotted) return null;
      if (part.includes('.')) {
        if (n !== 6) return null;
        const v = v4(part);
        if (v === null) return null;
        g[6] = Math.floor(v / 65536);
        g[7] = v % 65536;
        n = 8;
        dotted = true;
      } else {
        const x = hexGroup(part);
        if (x === null) return null;
        g[n++] = x;
      }
    }
    return n === 8 ? g : null;
  }
  const head = s.slice(0, i);
  const tail = s.slice(i + 2);
  let k = 0;
  if (head.length) {
    for (const part of head.split(':')) {
      if (k === 7) return null;
      const x = hexGroup(part);
      if (x === null) return null;
      g[k++] = x;
    }
  }
  const ts = [];
  if (tail.length) {
    let dotted = false;
    for (const part of tail.split(':')) {
      if (dotted || k + ts.length >= 7) return null;
      if (part.includes('.')) {
        if (k + ts.length + 2 > 7) return null;
        const v = v4(part);
        if (v === null) return null;
        ts.push(Math.floor(v / 65536), v % 65536);
        dotted = true;
      } else {
        const x = hexGroup(part);
        if (x === null) return null;
        ts.push(x);
      }
    }
  }
  if (k + ts.length > 7) return null;
  for (let j = 0; j < ts.length; j++) g[8 - ts.length + j] = ts[j];
  return g;
}

/** Port of ip.rs is_v6 (headers is_ipv6): Node's net.isIPv6, the address then an optional zone. */
export function isIpv6(s) {
  let addr = s;
  const p = s.indexOf('%');
  if (p >= 0) {
    const zone = s.slice(p + 1);
    if (!/^[0-9A-Za-z.:-]+$/.test(zone)) return false;
    addr = s.slice(0, p);
  }
  return v6Groups(addr) !== null;
}

/** Port of headers is_ip: Node's net.isIP, 4, 6 or 0. */
export function isIp(s) {
  if (v4(s) !== null) return 4;
  return isIpv6(s) ? 6 : 0;
}

/** Port of headers is_ipv4: Node's net.isIPv4. */
export function isIpv4(s) {
  return v4(s) !== null;
}

/** Port of ip.rs mapped_dotted: /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i (the octets unchecked). */
function mappedDotted(s) {
  return /^::ffff:[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/i.test(s);
}

/** Port of ip.rs bare: the address text (in its own case) and its value ({v4:number} or {v6:groups}), or null when
 * it is not an address.  "::ffff:1.2.3.4" is "1.2.3.4", "[::1]" is "::1", and a zone goes. */
export function bare(a) {
  let s = a.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const p = s.indexOf('%');
  if (p > 0) s = s.slice(0, p);
  if (mappedDotted(s)) s = s.slice(7);
  const v = v4(s);
  if (v !== null) return { text: s, v4: v };
  const g = v6Groups(s);
  return g ? { text: s, v6: g } : null;
}

/** Port of headers bare_ip: an address in its plain form, lower case; "" if not an address. */
export function bareIp(a) {
  const b = bare(a);
  return b ? b.text.toLowerCase() : '';
}

/** Port of headers address_key: what the per-address limits count by: an IPv4 address, or an IPv6 address's /56;
 * "" when it is not an address. */
export function addressKey(ip) {
  const b = bare(ip);
  if (!b) return '';
  if (b.v4 !== undefined) return b.text;
  const g = b.v6;
  const h = (x) => x.toString(16);
  return h(g[0]) + ':' + h(g[1]) + ':' + h(g[2]) + ':' + h(g[3] & 0xff00) + '::/56';
}

/** Port of headers site_key: an IPv6 address's /48 (one site); "" for IPv4 and for what is not an address. */
export function siteKey(ip) {
  const b = bare(ip);
  if (!b || b.v6 === undefined) return '';
  const g = b.v6;
  const h = (x) => x.toString(16);
  return h(g[0]) + ':' + h(g[1]) + ':' + h(g[2]) + '::/48';
}

/** Port of ip.rs serialize6: the WHATWG URL serializer of an IPv6 host. */
export function serialize6(g) {
  let compress = -1;
  let longest = 1;
  let i = 0;
  while (i < 8) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    const start = i;
    while (i < 8 && g[i] === 0) i++;
    if (i - start > longest) {
      compress = start;
      longest = i - start;
    }
  }
  let out = '';
  let ignore0 = false;
  for (let idx = 0; idx < 8; idx++) {
    const piece = g[idx];
    if (ignore0 && piece === 0) continue;
    ignore0 = false;
    if (compress === idx) {
      out += idx === 0 ? '::' : ':';
      ignore0 = true;
      continue;
    }
    out += piece.toString(16);
    if (idx !== 7) out += ':';
  }
  return out;
}

/** Port of ip.rs canon6: an IPv6 host as a URL holds it; '' for a zone. */
export function canon6(s) {
  if (s.includes('%')) return '';
  const g = v6Groups(s);
  return g ? serialize6(g) : '';
}

// ---- the server's own names ------------------------------------------------------

/** Port of headers/src/lib.rs is_port: \d{1,5} */
function isPort(p) {
  return /^[0-9]{1,5}$/.test(p);
}

/** Port of headers/src/lib.rs is_dns_name: dot-separated labels of 1 to 63 characters. */
function isDnsName(s) {
  return s.split('.').every((l) => /^[a-z0-9_][a-z0-9_-]{0,62}$/.test(l));
}

/** Port of headers/src/lib.rs host_name: the host of a Host header or an Origin, lower case, without the port,
 * brackets or a trailing dot; "" when it is none of these. */
export function hostName(h) {
  const s = h.trim().toLowerCase();
  if (s === '') return '';
  if (s.startsWith('[')) {
    const rest = s.slice(1);
    const e = rest.indexOf(']');
    if (e < 0) return '';
    const after = rest.slice(e + 1);
    if (!(after === '' || (after.startsWith(':') && isPort(after.slice(1))))) return '';
    const inner = rest.slice(0, e);
    return isIpv6(inner) ? canon6(inner) : '';
  }
  if (isIpv6(s)) return canon6(s);
  const c = s.indexOf(':');
  const name0 = c < 0 ? s : s.slice(0, c);
  const port = c < 0 ? null : s.slice(c + 1);
  if (name0 === '' || (port !== null && !isPort(port))) return '';
  const name = name0.endsWith('.') ? name0.slice(0, -1) : name0;
  return v4(name) !== null || isDnsName(name) ? name : '';
}

/** Port of headers/src/lib.rs is_loopback_name: this machine's own names, which every check takes. */
function isLoopbackName(n) {
  return n === 'localhost' || n === '::1' || (v4(n) !== null && n.startsWith('127.'));
}

/** Port of headers/src/lib.rs is_local_or_ip: localhost or an IP literal (with or without a port): HSTS means
 * nothing (or harm) there. */
export function isLocalOrIp(hostHeader) {
  const lower = (hostHeader ?? '').trim().toLowerCase();
  if (lower.startsWith('[')) return true;
  let h = lower;
  const p = h.lastIndexOf(':');
  if (p >= 0) {
    const digits = h.slice(p + 1);
    if (digits !== '' && /^[0-9]+$/.test(digits)) h = h.slice(0, p);
  }
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h === 'localhost' || h.endsWith('.localhost') || isIp(h) !== 0;
}

/** Port of headers/src/lib.rs HostCheck: the names the server answers for (Host, Origin): this machine always, the
 * given names (exact, or "*.zone" for one label under zone).  (The certificate's names, set_cert_names, have no
 * Worker counterpart: env.HOSTS lists every name.) */
export class HostCheck {
  constructor(names) {
    this.exact = new Set();
    this.order = [];
    this.wild = [];
    for (const raw of names) {
      const n = raw.toLowerCase();
      if (n.startsWith('*.')) {
        this.wild.push(n.slice(1));
        continue;
      }
      const h = n.includes(':') && !n.startsWith('[') && isIpv6(n) ? hostName('[' + n + ']') : hostName(n);
      if (h !== '' && !this.exact.has(h)) {
        this.exact.add(h);
        this.order.push(h);
      }
    }
  }

  /** the host of a Host header (or an Origin) is one of the server's own names */
  check(host) {
    const n = hostName(host ?? '');
    if (n === '') return false;
    if (isLoopbackName(n)) return true;
    return this.exact.has(n) || this.wild.some((w) => n.length > w.length && n.endsWith(w) && !n.slice(0, n.length - w.length).includes('.'));
  }

  /** the exact names, then the wildcards ("*.zone") */
  names() {
    return [...this.order, ...this.wild.map((w) => '*' + w)];
  }
}

/** Port of headers/src/lib.rs client_country for the Worker: the client's country as Cloudflare names it (two
 * letters of ISO 3166-1, upper case), or null, and null for "XX" (no country known) and "T1" (Tor).  Rust reads
 * CF-IPCountry from a trusted proxy only; on Workers the value comes from Cloudflare itself (request.cf.country, else
 * the CF-IPCountry header), so it is always believed. */
export function clientCountry(value) {
  if (value == null) return null;
  const c = String(value).trim();
  if (!/^[A-Za-z]{2}$/.test(c)) return null;
  const u = c.toUpperCase();
  return u === 'XX' || u === 'T1' ? null : u;
}

