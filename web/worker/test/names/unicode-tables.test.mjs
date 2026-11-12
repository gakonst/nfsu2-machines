// web/worker/src/util/unicode-tables.js is the Rust server's tables (its unicode-general-category, dumped by
// cargo run --release -p nfsu2-names --example difftrace_names -- --tables), and how they differ from this runtime's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isControlOrFormat, isMark, isUnassigned, SOURCE } from '../../src/util/unicode.js';
import { source } from '../../scripts/gen-unicode-tables.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the tables are the Rust crate\'s, code point by code point (live)', async t => {
  const { spawnSync } = await import('node:child_process');
  const { noCargo, SERVER_RS } = await import('./rust.mjs');
  const why = noCargo();
  if (why) return t.skip('no Rust: ' + why);
  const r = spawnSync('cargo', ['run', '--release', '-q', '-p', 'nfsu2-names', '--example', 'difftrace_names', '--', '--tables'],
    { cwd: SERVER_RS, encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr);
  const tables = JSON.parse(r.stdout);
  const file = fs.readFileSync(path.resolve(here, '../../src/util/unicode-tables.js'), 'utf8');
  assert.equal(file, source(tables, SOURCE), 'unicode-tables.js is out of date: node web/worker/scripts/gen-unicode-tables.mjs');
  const inAny = (ranges, cp) => ranges.some(([a, b]) => cp >= a && cp <= b);
  for (let cp = 0; cp <= 0x10FFFF; cp += cp < 0x30000 ? 1 : 61) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;
    assert.equal(isUnassigned(cp), inAny(tables.unassigned, cp), 'Cn U+' + cp.toString(16));
    assert.equal(isMark(cp), inAny(tables.marks, cp), 'M U+' + cp.toString(16));
    assert.equal(isControlOrFormat(cp), inAny(tables.controlFormat, cp), 'Cc/Cf U+' + cp.toString(16));
  }
});

// the runtime's own \p{...} (its ICU's Unicode) against the Rust tables: they differ only where the runtime's
// Unicode assigned what the Rust tables' has not (which is why the port does not read the runtime's)
test('this runtime\'s Unicode against the Rust tables', t => {
  const cn = /^\p{Cn}$/u, m = /^\p{M}$/u, cf = /^[\p{Cc}\p{Cf}]$/u;
  let newer = 0;
  for (let cp = 0; cp <= 0x10FFFF; cp++) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;
    const ch = String.fromCodePoint(cp);
    const rt = { cn: cn.test(ch), m: m.test(ch), cf: cf.test(ch) };
    const ours = { cn: isUnassigned(cp), m: isMark(cp), cf: isControlOrFormat(cp) };
    if (rt.cn === ours.cn && rt.m === ours.m && rt.cf === ours.cf) continue;
    assert.ok(ours.cn && !rt.cn, 'U+' + cp.toString(16) + ' differs other than as newly assigned: ' + JSON.stringify({ rt, ours }));
    newer++;
  }
  t.diagnostic('Unicode ' + process.versions.unicode + ' (ICU ' + process.versions.icu + ') assigns ' + newer +
    ' code points the Rust tables (' + SOURCE + ') leave unassigned; no other category differs');
});

