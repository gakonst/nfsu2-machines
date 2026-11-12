// Ports of web/server-rs/src/paths.rs (the lexical path rules), src/app/files.rs (which file a URL path names, the
// dev-only guard, the byte range) and the small helpers of src/app/mod.rs (TYPES, type_of, has_word).  Pure.

import { gameEntry } from './manifest.js';

/** Port of paths.rs normalize_abs: path.posix.normalize of an absolute path. */
export function normalizeAbs(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.length ? '/' + parts.join('/') : '/';
}

/** Port of paths.rs resolve: path.resolve(base, p) with an absolute base. */
export function resolvePath(base, p) {
  return p.startsWith('/') ? normalizeAbs(p) : normalizeAbs(base + '/' + p);
}

/** Port of paths.rs extname: path.posix.extname. */
export function extname(p) {
  const t = p.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  const base = i >= 0 ? t.slice(i + 1) : t;
  if (base === '..') return '';
  const d = base.lastIndexOf('.');
  return d <= 0 ? '' : base.slice(d);
}

/** Port of paths.rs dirname: path.posix.dirname. */
export function dirname(p) {
  const t = p.replace(/\/+$/, '');
  if (t === '') return p.startsWith('/') ? '/' : '.';
  const i = t.lastIndexOf('/');
  if (i < 0) return '.';
  const d = t.slice(0, i).replace(/\/+$/, '');
  return d === '' ? '/' : d;
}

/** Port of files.rs resolve_inside: the file under root that a URL path names; null for anything with a dot segment
 * (.., ., .git, .DS_Store, ...) or outside root. */
export function resolveInside(root, urlPath) {
  if (urlPath.split('/').some((seg) => seg.startsWith('.'))) return null;
  const p = resolvePath(root, '.' + normalizeAbs('/' + urlPath));
  return p === root || p.startsWith(root + '/') ? p : null;
}

/** Port of files.rs resolve_game: the file of the game (GAME_ENTRIES) under the install folder that a URL path
 * names, or null. */
export function resolveGame(data, urlPath) {
  const first = urlPath.split('/').find((s) => s !== '');
  if (first === undefined) return null;
  return gameEntry(first) ? resolveInside(data, urlPath) : null;
}

/** Port of files.rs dev_only: a test page, test script or source map, by its name as a case-insensitive disk folds
 * it (NFKC folds "ſ" to "s", "K" to "k"). */
export function devOnly(p) {
  const n = p.normalize('NFKC').toLowerCase();
  let rest = null;
  if (n.startsWith('/tests')) rest = n.slice(6);
  else if (n.startsWith('/test')) rest = n.slice(5);
  return (rest !== null && (rest === '' || rest.startsWith('/'))) || n.endsWith('.map');
}

/** Port of files.rs parse_range: /^bytes=(\d*)-(\d*)$/ as [first, last] strings, or null. */
export function parseRange(r) {
  if (!r.startsWith('bytes=')) return null;
  const rest = r.slice(6);
  const i = rest.indexOf('-');
  if (i < 0) return null;
  const x = rest.slice(0, i);
  const y = rest.slice(i + 1);
  const digits = (s) => /^[0-9]*$/.test(s);
  return digits(x) && digits(y) ? [x, y] : null;
}

/** The range rule of files.rs send_file for a file of size bytes and a Range header: {code:200,a,b} for the whole
 * file, {code:206,a,b} for one range, {code:416} when it cannot be satisfied.  (Rust reads the numbers as f64:
 * "x.parse::<f64>().unwrap_or(INFINITY)"; digits only reach here, so Number() is the same reading.) */
export function rangeOf(rangeHeader, size) {
  const sz = size;
  let a = 0;
  let b = sz - 1;
  let code = 200;
  const r = rangeHeader != null && rangeHeader !== '' ? parseRange(rangeHeader.trim()) : null;
  if (r && !(r[0] === '' && r[1] === '')) {
    const n = (x) => {
      const v = Number(x);
      return Number.isFinite(v) ? v : Infinity;
    };
    a = r[0] === '' ? Math.max(sz - n(r[1]), 0) : n(r[0]);
    b = r[0] === '' || r[1] === '' ? sz - 1 : Math.min(n(r[1]), sz - 1);
    if (a > b || a >= sz) return { code: 416 };
    code = 206;
  }
  return { code, a, b };
}

/** Port of mod.rs TYPES: what a client may ask a file to be sent as. */
export const TYPES = Object.freeze([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.json', 'application/json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json'],
]);

/** Port of mod.rs type_of */
export function typeOf(ext) {
  const t = TYPES.find(([e]) => e === ext);
  return t ? t[1] : null;
}

/** Port of mod.rs has_word: /\bword\b/.test(s), word as a whole word (JS \w: ASCII letters, digits and "_"). */
export function hasWord(s, word) {
  const w = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
  let from = 0;
  for (let guard = 0; guard <= s.length; guard++) {
    const at = s.indexOf(word, from);
    if (at < 0) return false;
    const end = at + word.length;
    if ((at === 0 || !w(s[at - 1])) && (end === s.length || !w(s[end]))) return true;
    from = at + 1;
  }
  return false;
}

