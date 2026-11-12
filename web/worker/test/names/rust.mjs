// Runs a test-only Rust example of web/server-rs (the differential tests' other side): JSON lines in, JSON lines out.
// Skipped (a reason instead of answers) where there is no cargo, or with NFSU2_NO_CARGO=1.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_RS = path.resolve(here, '../../../server-rs');
export const FIXTURES = path.resolve(here, '../fixtures');

let cargo;
/** null when cargo runs here, else why not */
export function noCargo() {
  if (process.env.NFSU2_NO_CARGO === '1') return 'NFSU2_NO_CARGO=1';
  if (cargo === undefined) {
    const r = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
    cargo = r.error ? 'no cargo (' + r.error.message + ')' : r.status !== 0 ? 'cargo --version failed' : null;
  }
  return cargo;
}

/**
 * The example's answers, one parsed JSON value per input line, or {skip: reason}.
 * @param {string} pkg  the crate (nfsu2-names, nfsu2-lan)
 * @param {string} example
 * @param {string[]} lines  one JSON text each
 */
export function runRust(pkg, example, lines, args = []) {
  const why = noCargo();
  if (why) return { skip: why };
  // the input from a file: a Rust panic then shows in its stderr rather than as a broken pipe
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-diff-'));
  const file = path.join(dir, 'in.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const fd = fs.openSync(file, 'r');
  let r;
  try {
    r = spawnSync('cargo', ['run', '--release', '-q', '-p', pkg, '--example', example, '--', ...args], {
      cwd: SERVER_RS, stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 1 << 30, timeout: 30 * 60 * 1000,
    });
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(pkg + ' ' + example + ' failed: ' + r.stderr.slice(-4000));
  const out = r.stdout.split('\n');
  if (out[out.length - 1] === '') out.pop();
  if (out.length !== lines.length) throw new Error(example + ': ' + out.length + ' answers for ' + lines.length + ' lines');
  return { out: out.map(l => JSON.parse(l)) };
}

/** a fixture of web/worker/test/fixtures: {inputs, outputs}, written anew from Rust's answers with UPDATE_FIXTURES=1 */
export function fixture(name, make) {
  const file = path.join(FIXTURES, name);
  if (process.env.UPDATE_FIXTURES === '1') {
    const f = make();
    if (f) {
      fs.mkdirSync(FIXTURES, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(f) + '\n');
    }
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const hex = b => Buffer.from(b).toString('hex');
export const unhex = s => new Uint8Array(Buffer.from(s, 'hex'));

/** a double's bits as Rust's {:016x} of to_bits(), "nan" for a NaN */
export function bits(f) {
  if (Number.isNaN(f)) return 'nan';
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, f);
  return dv.getBigUint64(0).toString(16).padStart(16, '0');
}

/** SplitMix64 (names/src/cross_check.rs Rnd): the same numbers as the Rust's for a seed */
export class Rnd {
  constructor(seed) {
    this.s = BigInt.asUintN(64, BigInt(seed));
  }

  next(n) {
    this.s = BigInt.asUintN(64, this.s + 0x9e3779b97f4a7c15n);
    let z = this.s;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return Number((z ^ (z >> 31n)) % BigInt(n));
  }

  pick(a) {
    return a[this.next(a.length)];
  }
}

