// Port of web/server-rs/src/app/manifest.rs: the install folder's manifest (/data-manifest), as a pure function of
// the game files' list (path, size, time).  The Worker's files are R2 objects under "data/", so there is no walk of a
// folder: the listing is turned into the tree the walk would have met (folders are the paths' prefixes) and walked in
// the order Node's readdir gives (sorted by byte).

/** Port of manifest.rs GAME_ENTRIES: what /data/ and /data-blocks/ serve, the top-level entries of the install folder
 * that are the game's. */
export const GAME_ENTRIES = Object.freeze([
  'speed2.exe', 'server.dll', 'server.cfg', 'cars', 'credits', 'frontend', 'global',
  'hqvinyls', // the HQ vinyls' pictures (tools/hqvinyls.py), if the folder has them
  'langpacks', // the language packs (tools/langpacks.py), if the folder has them
  'languages', 'memcard',
  'modpacks', // what community mods add, for everyone (tools/modpacks.py), if the folder has it
  'movies', 'nis', 'pfdata', 'sound', 'speech', 'subtitles',
  'texpacks', // the texture packs (tools/texpacks.py), if the folder has them
  'tracks',
  'vinylpacks', // the Japanese release's vinyls (tools/vinylpacks.py), if the folder has them
]);

/** Port of manifest.rs BLOCK / BLOCKS_MAX: the blocks of /data-blocks/, 1 MiB each, at most 8 in one answer. */
export const BLOCK = 1 << 20;
export const BLOCKS_MAX = 8;
/** Port of blocks.rs V2: the addresses' own folder since blocks are kept. */
export const V2 = '/v2';

/** Port of manifest.rs game_entry: a top-level name of the game's, compared in lower case (Unicode's, as JS's
 * toLowerCase). */
export function gameEntry(name) {
  return GAME_ENTRIES.includes(name.toLowerCase());
}

const enc = new TextEncoder();

/** byte order of two names' UTF-8 (libuv's scandir sort) */
export function byteCompare(a, b) {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** Port of manifest.rs build (and walk) over a listing: files is [{p: "GLOBAL/x.bin", s: size, m: mtimeMs}] (the
 * paths relative to the install folder, "/"-separated).  Returns {body, count, files} where body is the manifest's
 * JSON text exactly as Rust writes it and files the listed files' paths in walk order.  As the walk: names that start
 * with "." are left out at every level (with what is under them), and at the top only GAME_ENTRIES.  An empty path
 * segment (a key such as "data/a//b") cannot be a file of a folder and is left out. */
export function buildManifest(list) {
  const root = new Map();
  for (const f of list) {
    if (typeof f.p !== 'string' || !Number.isFinite(f.s) || !Number.isFinite(f.m)) throw new Error('buildManifest: {p, s, m}');
    const segs = f.p.split('/');
    if (segs.some((s) => s === '')) continue;
    let dir = root;
    let ok = true;
    for (let i = 0; i < segs.length - 1; i++) {
      let d = dir.get(segs[i]);
      if (d === undefined) {
        d = new Map();
        dir.set(segs[i], d);
      } else if (!(d instanceof Map)) {
        ok = false; // a file and a folder of one name: the file wins, as a folder cannot have it
        break;
      }
      dir = d;
    }
    const last = segs[segs.length - 1];
    if (ok && !dir.has(last)) dir.set(last, { s: f.s, m: f.m });
  }
  const out = [];
  const files = [];
  const walk = (dir, rel, depth) => {
    if (depth > 64) throw new Error('buildManifest: too deep');
    const names = [...dir.keys()].sort(byteCompare);
    for (const name of names) {
      if (name.startsWith('.') || (rel === '' && !gameEntry(name))) continue;
      const r = rel === '' ? name : rel + '/' + name;
      const e = dir.get(name);
      if (e instanceof Map) {
        out.push('{"p":' + JSON.stringify(r) + ',"d":1}');
        walk(e, r, depth + 1);
      } else {
        out.push('{"p":' + JSON.stringify(r) + ',"s":' + String(e.s) + ',"m":' + String(Math.floor(e.m / 1000)) + '}');
        files.push(r);
      }
    }
  };
  walk(root, '', 0);
  const body = '{"v":1,"files":[' + out.join(',') + '],"blocks":{"url":"/data-blocks' + V2 + '/","size":' + BLOCK + ',"max":' + BLOCKS_MAX + '}}';
  return { body, count: out.length, files };
}

