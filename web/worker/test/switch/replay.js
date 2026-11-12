// The JavaScript side of the switch's differential traces (crates/lan/tests/difftrace_switch.rs is the Rust side):
// the same trace into the JS switch in virtual time, the same fake browsers, the same output shape.

import { LanSwitch, vipStr } from '../../src/switch/lib.js';
import { Prng } from '../../src/util/prng.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

/** snake_case LanOptions (as the Rust test takes them) to the JS switch's camelCase */
export function camel(o) {
  const r = {};
  for (const [k, v] of Object.entries(o ?? {})) r[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  return r;
}

export function replayJs(trace, seed = 1) {
  const start = 1_700_000_000_000;
  const clients = new Map();
  const order = [];
  const byConn = new Map();
  let reactions = [];
  const transport = {
    write(conn, msgs, bytes) {
      const c = byConn.get(conn);
      for (const m of msgs) {
        if (!c || c.ended) continue;
        if (m.op === 'text') {
          const t = dec.decode(m.data);
          try {
            const v = JSON.parse(t);
            if (v.t === 'welcome') {
              c.vip = v.vip;
              c.token = v.token;
            }
            if (v.t === 'queue' && typeof v.ticket === 'string') c.ticket = v.ticket;
          } catch {
            /* not JSON */
          }
          c.msgs.push({ op: 'text', text: t });
        } else if (m.op === 'binary') {
          c.msgs.push({ op: 'binary', hex: hex(m.data) });
        } else if (m.op === 'close') {
          const code = m.data.length >= 2 ? (m.data[0] << 8) | m.data[1] : 1005;
          c.msgs.push({ op: 'close', code, reason: dec.decode(m.data.subarray(2)) });
          if (!c.wclosed) {
            c.wclosed = true;
            const data = m.data.slice();
            reactions.push(() => {
              sw.message(conn, { type: 'close', code, reason: data.subarray(2) }, now);
              sw.socketGone(conn, now);
            });
          }
        } else if (m.op === 'ping') {
          const data = m.data.slice();
          reactions.push(() => sw.message(conn, { type: 'pong', data }, now));
        }
      }
      return bytes;
    },
    end(conn) {
      const c = byConn.get(conn);
      if (c) c.ended = true;
    },
    kill(conn) {
      const c = byConn.get(conn);
      if (c) c.ended = true;
    },
    finished(conn) {
      const c = byConn.get(conn);
      if (c) c.ended = true;
    },
  };
  let now = start;
  const sw = new LanSwitch({ options: camel(trace.options), prng: new Prng(seed), nowMs: now, transport });
  const react = () => {
    for (let g = 0; reactions.length && g < 10000; g++) {
      const r = reactions;
      reactions = [];
      for (const f of r) f();
    }
  };
  const advance = (ms) => {
    const end = now + ms;
    for (let g = 0; g < 10_000_000; g++) {
      const t = sw.nextWakeMs();
      if (t > end) break;
      now = Math.max(now, t);
      sw.tick(now);
      react();
    }
    now = end;
    sw.tick(now);
    react();
  };
  const subst = (s) => {
    for (const [id, c] of clients) {
      s = s.split('@TOKEN' + id + '@').join(c.token ?? '');
      s = s.split('@TICKET' + id + '@').join(c.ticket ?? '');
      s = s.split('@VIPN' + id + '@').join(String(c.vip ?? 0));
      s = s.split('@VIP' + id + '@').join(vipStr(c.vip ?? 0));
    }
    return s;
  };
  const settle = trace.settle_ms ?? 3;
  for (const st of trace.steps) {
    const c = clients.get(st.id ?? 0);
    switch (st.op) {
      case 'connect': {
        const nc = { id: st.id, msgs: [], ended: false, vip: 0, token: '', ticket: '', wclosed: false };
        clients.set(st.id, nc);
        sw.attach({ resume: !!st.resume, queue: !!st.queue, group: st.group ?? null, site: st.site ?? null }, now, (conn) => {
          nc.conn = conn;
          byConn.set(conn, nc);
        });
        order.push(st.id);
        break;
      }
      case 'text':
        if (!c.wclosed) sw.message(c.conn, { type: 'text', data: enc.encode(subst(st.text)) }, now);
        break;
      case 'binary': {
        const b = unhex(st.hex);
        for (const [off, who] of st.dst ?? []) {
          const v = clients.get(who)?.vip ?? 0;
          new DataView(b.buffer).setUint32(off, v >>> 0);
        }
        if (!c.wclosed) sw.message(c.conn, { type: 'binary', data: b }, now);
        break;
      }
      case 'close': {
        if (!c.wclosed) {
          const r = enc.encode(st.reason ?? '');
          sw.message(c.conn, { type: 'close', code: st.code ?? 1000, reason: r }, now);
        }
        break;
      }
      case 'drop':
        if (!c.wclosed) {
          c.wclosed = true;
          sw.socketGone(c.conn, now);
        }
        break;
      case 'expel':
        sw.expel(c.vip, enc.encode(st.msg ?? ''), st.code ?? 4001, now);
        break;
      case 'wait':
        advance(st.ms);
        continue;
      default:
        throw new Error('unknown op ' + st.op);
    }
    react();
    advance(settle);
  }
  advance(trace.end_ms ?? 200);
  return {
    clients: order.map((id) => ({ id, msgs: clients.get(id).msgs, ended: clients.get(id).ended })),
    info: sw.info(),
    reserved: sw.reservedView().length,
  };
}

/** both sides' outputs made comparable: each client's token and ticket replaced by a name */
export function normalise(out) {
  const o = JSON.parse(JSON.stringify(out));
  const names = new Map();
  for (const c of o.clients) {
    for (const m of c.msgs) {
      if (m.op !== 'text') continue;
      try {
        const v = JSON.parse(m.text);
        if (v.t === 'welcome' && v.token && !names.has(v.token)) names.set(v.token, '@TOKEN' + c.id + '@');
        if (v.t === 'queue' && v.ticket && !names.has(v.ticket)) names.set(v.ticket, '@TICKET' + c.id + '@');
      } catch {
        /* not JSON */
      }
    }
  }
  for (const c of o.clients) for (const m of c.msgs) if (m.op === 'text') for (const [k, v] of names) m.text = m.text.split(k).join(v);
  return o;
}

