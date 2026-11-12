// Port of web/server-rs/src/app/etag.rs: ETags without file-system detail: a keyed hash of what names a version.
// The parts are joined by NUL, numbers as JS's Number#toString writes them.  WebCrypto's HMAC is async, so etagOf
// returns a Promise.

const enc = new TextEncoder();

/** base64url without padding (nfsu2_util::js::base64url) */
export function base64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** HMAC-SHA256(key, data) as a Uint8Array */
export async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** Port of etag.rs etag_of: '"' + HMAC-SHA256(key, parts joined by NUL), base64url, 22 characters + '"'. */
export async function etagOf(key, parts) {
  if (!(key instanceof Uint8Array) || key.length === 0) throw new Error('etagOf: a key of bytes');
  const joined = enc.encode(parts.join('\0'));
  return '"' + base64url(await hmacSha256(key, joined)).slice(0, 22) + '"';
}

/** Port of etag.rs num: a number as JS writes it into a string. */
export function num(x) {
  return String(x);
}

/** Port of etag.rs mtime_s: Math.floor(mtimeMs / 1000), the manifest's m. */
export function mtimeS(mtimeMs) {
  return Math.floor(mtimeMs / 1000);
}

/** sha256 of bytes, as lower-case hex */
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

