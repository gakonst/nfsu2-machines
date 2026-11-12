// (a dev aid) the Rust side alone: node test/online/rustonly.mjs [n random seeds]
import * as g from './gen.mjs';
import { rustRun } from './rust.mjs';
const all = g.scenarios().map((x) => x[1]);
const n = Number(process.argv[2] ?? 5);
for (let s = 1; s <= n; s++) all.push(g.randomTrace(s));
const out = rustRun(all);
out.forEach((l, i) => {
  if (!Array.isArray(l)) return console.log(i, l);
  console.log(i, l.length, l.reduce((a, s) => a + s.sent.length, 0), l.reduce((a, s) => a + s.log.length, 0), JSON.stringify(l.flatMap((s) => s.log).slice(0, 4)).slice(0, 400));
});
