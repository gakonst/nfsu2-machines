// The Rust side of the differential tests: the traces into web/server-rs/crates/online's tests/difftrace.rs (built
// with RUSTFLAGS='--cfg getrandom_backend="custom"' in its own target folder, ~/.cache/nfsu2-rs/online-diff).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUST = fileURLToPath(new URL('../../../server-rs/', import.meta.url));

function hostTriple() {
  const r = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /host: (\S+)/.exec(r.stdout);
  return m ? m[1] : null;
}

/** the Rust outputs of traces, or null (no cargo) */
export function rustRun(traces) {
  const triple = hostTriple();
  if (!triple) return null;
  const dir = mkdtempSync(join(tmpdir(), 'difftrace-'));
  const inp = join(dir, 'in.json'), out = join(dir, 'out.jsonl');
  writeFileSync(inp, JSON.stringify(traces));
  const r = spawnSync('cargo', ['test', '-q', '-p', 'nfsu2-online', '--target', triple, '--lib', 'difftrace', '--', '--test-threads=1'], {
    cwd: RUST, encoding: 'utf8', timeout: 1800000, maxBuffer: 1 << 28,
    env: { ...process.env, CARGO_TARGET_DIR: join(homedir(), '.cache/nfsu2-rs/online-diff'), RUSTFLAGS: '--cfg getrandom_backend="custom"', DIFFTRACE_IN: inp, DIFFTRACE_OUT: out },
  });
  if (r.status !== 0) throw new Error('cargo test failed:\n' + r.stdout + r.stderr);
  return readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}


