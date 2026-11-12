import { genTrace } from './test/switch/tracegen.js';
import { replayJs, normalise } from './test/switch/replay.js';
import fs from 'node:fs';
const t = genTrace(1, {long:700, settle:40, steps:40});
const steps = [{op:'connect', id: 99}, {op:'text', id:99, text:'{"t":"hello","name":"warm"}'}, {op:'wait', ms: 500}, {op:'close', id:99, code:1000, reason:'closed'}, {op:'wait', ms:300}];
for (const s of t.steps) { if (s.op==='drop'||s.op==='expel') continue; if (s.op==='close' && s.code===1001) s.code=4001; steps.push(s); }
steps.push({op:'wait', ms:1500});
for (let i = 0; i < 20; i++) steps.push({op:'close', id:i, code:1000, reason:'closed'});
steps.push({op:'wait', ms:300}, {op:'connect', id:100}, {op:'wait', ms:100});
const tr = {...t, options: {max_peers: 4}, steps: steps.filter(s => s.op !== 'close' || s.id === 99 || s.id < 20)};
// only clients that exist
const ids = new Set(tr.steps.filter(s=>s.op==='connect').map(s=>s.id));
tr.steps = tr.steps.filter(s => s.op==='wait' || s.op==='connect' || ids.has(s.id));
fs.writeFileSync('/tmp/tr1.json', JSON.stringify(tr));
const js = normalise(replayJs(tr));
fs.writeFileSync('/tmp/tr1_js.json', JSON.stringify(js));
console.log(js.clients.at(-1).msgs[0].text);
