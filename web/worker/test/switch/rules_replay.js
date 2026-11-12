// The JavaScript side of the rules differential (crates/lan/tests/difftrace_rules.rs is the Rust side): replay.js's
// replay with what the harness's serve() adds to a connection, recording hosts on the Online and hub addresses, the
// tap, the operator's race ban and the peer view at the end, in the same output shape.

import { LanSwitch, vipStr } from '../../src/switch/lib.js';
import { Prng } from '../../src/util/prng.js';
import { camel } from './replay.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const be32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** a host that keeps every call of the switch's (difftrace_rules.rs Rec) */
function recHost(vip, name, listed, tag, ev) {
  return () => ({
    vip, name, listed: () => listed,
    frame: (f, ctx) => ev.push({ h: tag, ev: 'frame', from: be32(f, 4), hex: hex(f), group: ctx.group, site: ctx.site ?? null,
      owner: ctx.owner ?? null, no_races: !!ctx.noRaces, cause: ctx.cause != null }),
    peerGone: (v) => ev.push({ h: tag, ev: 'gone', vip: v }),
    blocks: (v, names) => ev.push({ h: tag, ev: 'blocks', vip: v, names }),
    pageName: (v, n) => ev.push({ h: tag, ev: 'name', vip: v, name: n }),
    info: () => ({}), vips: () => new Set(), nextTickMs: () => Infinity, tick: () => {}, stop: () => {},
  });
}

export function replayRules(trace, seed = 1) {
  const start = 1_700_000_000_000;
  const clients = new Map();
  const order = [];
  const byConn = new Map();
  const ev = [];
  const tapped = [];
  let reactions = [];
  let now = start;
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
  const hosts = trace.hosts ? {
    online: recHost(0x0a4d0001, 'NFSU2 Online', true, 'online', ev),
    roam: recHost(0x0a4d00fd, 'hub', false, 'roam', ev),
  } : {};
  const sw = new LanSwitch({ options: camel(trace.options), prng: new Prng(seed), nowMs: now, transport, hosts, tap: (b) => tapped.push(hex(b)) });
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
        const gate = st.gate ?? null, rename = st.rename ?? null, norace = st.norace ?? null;
        const onHello = gate !== null || rename !== null || norace !== null ? (h) => {
          const a = {};
          const hit = gate !== null ? [...h.ids, ...(h.owner != null ? [h.owner] : [])].find((x) => x === gate) : undefined;
          if (hit !== undefined) a.refuse = [enc.encode(JSON.stringify({ t: 'ban', msg: hit, ids: h.ids })), 4003];
          else if (rename !== null && rename === h.name) a.refuse = [enc.encode(JSON.stringify({ t: 'rename', name: h.name })), 4004];
          else if (norace !== null && h.ids.includes(norace)) a.noRaces = enc.encode(JSON.stringify({ t: 'races', msg: 'no' }));
          return a;
        } : null;
        sw.attach({
          resume: !!st.resume, queue: !!st.queue, group: st.group ?? null, site: st.site ?? null, ident: st.ident ?? null,
          refuse: st.refuse != null ? enc.encode(JSON.stringify({ t: 'ban', msg: st.refuse })) : null, onHello,
          onClaim: (k) => 'owner-' + k,
        }, now, (conn) => {
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
        for (const [off, who] of st.dst ?? []) new DataView(b.buffer).setUint32(off, (clients.get(who)?.vip ?? 0) >>> 0);
        if (!c.wclosed) sw.message(c.conn, { type: 'binary', data: b }, now);
        break;
      }
      case 'close':
        if (!c.wclosed) sw.message(c.conn, { type: 'close', code: st.code ?? 1000, reason: enc.encode(st.reason ?? '') }, now);
        break;
      case 'drop':
        if (!c.wclosed) {
          c.wclosed = true;
          sw.socketGone(c.conn, now);
        }
        break;
      case 'expel':
        sw.expel(c.vip, enc.encode(st.msg ?? ''), st.code ?? 4001, now);
        break;
      case 'races':
        sw.setRaces(c.vip, st.off ?? true, enc.encode(st.msg ?? ''), now);
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
  const info = sw.info();
  delete info.online;
  delete info.roam;
  return {
    clients: order.map((id) => ({ id, msgs: clients.get(id).msgs, ended: clients.get(id).ended })),
    info,
    reserved: sw.reservedView().length,
    peers: sw.peersView().map((p) => ({ vip: p.vip, name: p.name, hello: p.hello, bundle: p.bundle, lan: p.lan, open: p.open })),
    hosts: ev,
    tap: tapped,
  };
}
