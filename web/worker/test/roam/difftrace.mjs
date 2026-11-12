// Differential traces for the free-roam hub: seeded virtual players' HELLO/SNAP/BYE/MAPREQ/NEARREQ/LOBBY/RACEREP/
// RACERES (and the switch's calls: departures, blocks, page names, friends, ...) as a JSON-lines trace, replayed into the
// Rust hub (web/server-rs/crates/roam/examples/difftrace.rs) and into the Worker's port (web/worker/src/roam/hub.js),
// whose outputs (every frame the hub sends, as a digest or hex; every console line; the queries' answers) must be
// the same line for line.
//
//   node test/roam/difftrace.mjs <seed> [players] [seconds] [--hex] [--keep]   one trace, its first difference shown
//
// The Rust tool is built with: (cd web/server-rs && cargo build --release -p nfsu2-roam --example difftrace); its
// binary is looked for at $ROAM_DIFFTRACE_BIN, else web/server-rs/target/release/examples/difftrace.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../../src/roam/hub.js';
import { Claims } from '../../src/claims/claims.js';
import { Prng } from '../../src/util/prng.js';
import { crc32 } from '../../src/roam/crc32.js';
import * as K from './kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const RUST_BIN = process.env.ROAM_DIFFTRACE_BIN || join(here, '../../../server-rs/target/release/examples/difftrace');

export function haveRust() {
  return existsSync(RUST_BIN);
}

function hex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

function unhex(s) {
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return b;
}

/** a frame's digest as the Rust tool prints it */
export function digest(b) {
  let h = 0x811c9dc5;
  for (const c of b) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  return crc32(b).toString(16).padStart(8, '0') + h.toString(16).padStart(8, '0') + ':' + b.length;
}

const CAMEL = {
  degree: 'degree', tick_ms: 'tickMs', stale_ms: 'staleMs', gone_ms: 'goneMs', keep: 'keep', hold_ms: 'holdMs', max_per_vip: 'maxPerVip',
  max_players: 'maxPlayers', exact_room: 'exactRoom', min_degree: 'minDegree', busy_high: 'busyHigh', busy_low: 'busyLow',
  cap_down_ms: 'capDownMs', cap_up_ms: 'capUpMs', ask_cap: 'askCap', soon_ms: 'soonMs', look_ms: 'lookMs', away_m: 'awayM', view_m: 'viewM',
  sends: 'sends', near_m: 'nearM', near_hold_ms: 'nearHoldMs', near_fast: 'nearFast', level_slack_m: 'levelSlackM',
  level_grade: 'levelGrade', level_k: 'levelK', map_max: 'mapMax', map_gap_ms: 'mapGapMs', map_fresh_ms: 'mapFreshMs',
  near_gap_ms: 'nearGapMs', link_threads: 'linkThreads',
};

/** JSON with every object's keys sorted (serde_json's maps are sorted; a JS object keeps insertion order) */
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v !== null && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/** the trace replayed into the Worker's hub: its output lines (canon JSON) */
export function replayJs(trace, full = false) {
  let t = 0;
  let busy = 0;
  let hub = null;
  let claims = null;
  const out = [];
  let pending = [];
  for (let i = 0; i < trace.length; i++) {
    const v = trace[i];
    if (typeof v.t === 'number') t = v.t;
    let answer;
    switch (v.op) {
      case 'new': {
        const o = {};
        for (const [k, x] of Object.entries(v.options || {})) o[CAMEL[k]] = x;
        if (o.linkThreads === undefined) o.linkThreads = 1;
        hub = new Hub(o, {
          now: () => t,
          busy: () => busy,
          log: (line) => pending.push({ log: line }),
          send: (vip, f) => {
            pending.push(full ? { vip, hex: hex(f) } : { vip, d: digest(f) });
            return true;
          },
          id: v.id ?? 0xb0b,
          claims,
        });
        break;
      }
      case 'claims':
        claims = Claims.inMemory();
        if (hub) hub.setClaims(claims);
        break;
      case 'claim':
        if (claims) answer = 'ok' in claims.claim(v.name, v.owner, Math.trunc(t));
        break;
      default: {
        if (!hub) break;
        switch (v.op) {
          case 'frame':
            hub.frameOf(v.from, unhex(v.hex), v.owner ?? null, v.client ?? null);
            break;
          case 'tick':
            if (typeof v.busy === 'number') busy = v.busy;
            hub.tick();
            break;
          case 'gone':
            hub.peerGone(v.vip);
            break;
          case 'blocks':
            hub.blocks(v.vip, v.names);
            break;
          case 'page':
            hub.pageName(v.vip, v.name);
            break;
          case 'friends':
            hub.friends(v.vip, v.me, v.owners);
            break;
          case 'room_name':
            hub.roomName(v.vip, v.name);
            break;
          case 'flew':
            hub.flew(v.vip, v.secs);
            break;
          case 'thread_busy':
            hub.setThreadBusy(v.busy);
            break;
          case 'info':
            answer = { ...hub.info(), tickMsMax: 0 };
            break;
          case 'links':
            answer = hub.links();
            break;
          case 'pairs':
            answer = hub.linkPairs();
            break;
          case 'linked':
            answer = hub.linkedWith(v.vip, v.name);
            break;
          case 'hosted':
            answer = hub.hosted(v.vip);
            break;
          case 'where':
            answer = hub.whereabouts(v.owners);
            break;
          case 'crews':
            answer = hub.inCrews(v.crews);
            break;
          case 'counts': {
            const rooms = [...hub.inRooms()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            answer = { crowded: hub.crowded(), inRoam: hub.inRoam(), coop: hub.coopSeats(), rooms, vips: [...hub.vips()].sort((a, b) => a - b) };
            break;
          }
          default:
            throw new Error('unknown op ' + v.op);
        }
      }
    }
    for (const e of pending) out.push(canon({ i, e }));
    pending = [];
    if (answer !== undefined) out.push(canon({ i, a: answer }));
  }
  return out;
}

/** the trace replayed into the Rust hub: its output lines (canon JSON) */
export function replayRust(trace, full = false) {
  const dir = mkdtempSync(join(tmpdir(), 'roamdiff-'));
  try {
    const f = join(dir, 'trace.jsonl');
    writeFileSync(f, trace.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const args = full ? ['--hex'] : [];
    const text = execFileSync('sh', ['-c', '"$0" "$@" < "' + f + '"', RUST_BIN, ...args], { maxBuffer: 1 << 30, encoding: 'utf8' });
    return text.split('\n').filter((l) => l.trim() !== '').map((l) => canon(JSON.parse(l)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** the first difference of two outputs: null, or {at, rust, js} */
export function firstDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let k = 0; k < n; k++) if (a[k] !== b[k]) return { at: k, rust: a.slice(Math.max(0, k - 2), k + 3), js: b.slice(Math.max(0, k - 2), k + 3) };
  return null;
}

// ---- the trace generator ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * A seeded trace.  cfg: {players, seconds, rooms, cores ('mix' | 'old' | 'new'), area (m), hotspots, exactRoom, degree,
 * viewM, maps, lobbies, races, crews, social (blocks, friends, claims, page names), churn, busy, bad, queries}
 */
export function genTrace(seed, cfg = {}) {
  const c = {
    players: 40, seconds: 12, rooms: 2, cores: 'mix', area: 600, hotspots: 3, exactRoom: undefined, degree: undefined, viewM: undefined,
    maps: true, lobbies: true, races: true, crews: true, social: true, churn: 0.02, busy: true, bad: 0.002, queries: true, coop: 0.03, lattice: false, ...cfg,
  };
  const r = new Prng(BigInt(seed) * 0x9e3779b97f4a7c15n + 12345n);
  const unit = () => r.unit();
  const pick = (a) => a[r.below(a.length)];
  const chance = (p) => unit() < p;
  const trace = [];
  let t = 1000000;
  const options = {};
  if (c.exactRoom !== undefined) options.exact_room = c.exactRoom;
  if (c.degree !== undefined) options.degree = c.degree;
  if (c.viewM !== undefined) options.view_m = c.viewM;
  if (chance(0.3)) options.hold_ms = pick([1000, 2000, 5000]);
  if (chance(0.2)) options.sends = pick([16, 32, 64, 96]);
  if (chance(0.2)) options.cap_down_ms = 1000;
  if (chance(0.2)) options.cap_up_ms = 2000;
  if (chance(0.2)) options.min_degree = pick([4, 8, 12]);
  if (chance(0.15)) options.max_per_vip = pick([1, 2, 3]);
  if (chance(0.1)) options.max_players = Math.max(4, Math.floor(c.players * 0.8));
  if (chance(0.15)) options.map_max = pick([16, 100, 500, 4096]);
  if (chance(0.2)) options.gone_ms = pick([1500, 3000, 6000]);
  if (chance(0.2)) options.stale_ms = pick([3000, 10000, 60000]);
  trace.push({ t, op: 'new', id: 1 + r.below(0xfffffffe), options });
  const owners = [];
  for (let k = 0; k < Math.max(4, c.players >> 2); k++) {
    let o = '';
    for (let x = 0; x < 22; x++) o += B64[r.below(64)];
    owners.push(o);
  }
  if (c.social) {
    trace.push({ t, op: 'claims' });
    for (let k = 0; k < 4; k++) trace.push({ t, op: 'claim', name: 'Star' + k, owner: owners[k] });
  }
  const rooms = [0];
  for (let k = 1; k < c.rooms; k++) rooms.push(chance(0.5) ? K.trackRoomOf(0, pick([4711, 4701, 4311])) : r.next32() || 1);
  const crews = [K.roomHash('Blue Room'), K.roomHash('Night Owls'), r.next32() || 1, r.next32() || 1, r.next32() || 1];
  const spots = [];
  for (let k = 0; k < Math.max(1, c.hotspots); k++) spots.push([(unit() - 0.5) * c.area, (unit() - 0.5) * c.area]);
  const coreOf = () => (c.cores === 'old' ? pick([6, 9, 10, 13, 14]) : c.cores === 'new' ? pick([15, 16, 17]) : pick([6, 9, 10, 13, 14, 15, 16, 17]));
  const players = [];
  let nextVip = 0;
  const vipOf = (n) => ((10 << 24) | (77 << 16) | ((1 + Math.floor(n / 250)) << 8) | (1 + (n % 250))) >>> 0;
  const newPlayer = (seat2Of = null) => {
    const n = nextVip++;
    const spot = pick(spots);
    const roomed = rooms[r.below(rooms.length)];
    const p = {
      vip: seat2Of ? seat2Of.vip : vipOf(n),
      port: seat2Of ? seat2Of.port + 1 : 47210 + (chance(0.1) ? r.below(50) : 0),
      id: 1 + r.below(0xfffffffe),
      room: seat2Of ? seat2Of.room : roomed,
      core: coreOf(),
      links: pick([0, 0, 8, 16, 24, 32, 40, 48, 64, 70]),
      crews: c.crews && chance(0.3) ? crews.filter(() => chance(0.4)).slice(0, 4) : null,
      name: chance(0.1) ? 'Star' + r.below(5) : 'P' + n + (chance(0.1) ? ' x' : ''),
      owner: chance(0.6) ? pick(owners) : null,
      status: chance(0.85) ? 2 : pick([0, 1, 3, 4, 5]),
      pos: [spot[0] + (unit() - 0.5) * 120, spot[1] + (unit() - 0.5) * 120, chance(0.15) ? 12 + unit() * 3 : unit() * 2],
      vel: [0, 0, 0],
      slope: 0,
      seat2: !!seat2Of,
      lobbies: chance(0.7),
      nextHello: t + r.below(1000),
      nextSnap: t + r.below(500),
      nextAsk: t + r.below(2000),
      req: 1 + r.below(100),
      base: 0,
      nreq: 1 + r.below(100),
      nbase: 0,
      duel: 0,
      lobby: null,
      join: null,
      clock: r.below(256),
      tus: r.next32(),
      alive: true,
    };
    if (c.lattice) {
      // (parked on a lattice of 4 m: many players at one distance from each other)
      const k = players.length;
      p.pos = [spots[0][0] + 4 * (k % 25), spots[0][1] + 4 * Math.floor(k / 25), 0];
      p.status = 2;
    } else if (chance(0.6)) {
      const sp = unit() * (chance(0.3) ? 70 : 25);
      const h = unit() * 2 * Math.PI;
      p.vel = [Math.cos(h) * sp, Math.sin(h) * sp, (unit() - 0.5) * 2];
      p.slope = chance(0.3) ? (unit() - 0.5) * 0.3 : 0;
    }
    players.push(p);
    return p;
  };
  for (let k = 0; k < c.players; k++) {
    const p = newPlayer();
    if (chance(c.coop)) newPlayer(p);
  }
  // outruns: pairs naming each other (and a few naming whom they like)
  for (let k = 0; k + 1 < players.length && k < 6; k += 2) {
    if (!chance(0.5)) continue;
    const a = players[r.below(players.length)], b = players[r.below(players.length)];
    if (a !== b) {
      a.duel = b.id;
      if (chance(0.8)) b.duel = a.id;
    }
  }
  const frame = (p, d, extra = {}) => {
    let data = K.framePorts(p.vip, d, p.port, chance(0.05) ? 47211 : 47210);
    if (c.bad && chance(c.bad)) {
      data = data.slice();
      data[16 + r.below(data.length - 16)] ^= 1 << r.below(8);
    }
    const e = { t, op: 'frame', from: p.vip, hex: hex(data) };
    if (p.owner !== null) e.owner = p.owner;
    if (chance(0.5)) e.client = 'c' + (p.vip & 0xff);
    Object.assign(e, extra);
    trace.push(e);
  };
  const helloOf = (p) =>
    K.helloWith(p.id, {
      room: p.room, status: p.status, name: p.name, core: p.core, crews: p.crews, links: p.core >= 10 ? p.links : 0, duel: p.duel,
      flags: (p.lobbies ? K.HF_LOBBY : 0) | (p.core >= 8 ? K.HF_HUBCREW : 0) | (p.seat2 ? K.HF_SEAT2 : 0),
      seen: chance(0.3) ? [r.next32(), r.next32()] : [],
    });
  const lobbyIds = new Map();
  const raceOf = new Map();
  const steps = Math.round((c.seconds * 1000) / 100);
  for (let step = 0; step < steps; step++) {
    t += 100;
    for (const p of players.slice()) {
      if (!p.alive) {
        if (chance(0.01)) {
          p.alive = true;
          p.id = 1 + r.below(0xfffffffe);
          p.nextHello = t;
        }
        continue;
      }
      if (t >= p.nextHello) {
        p.nextHello += 1000;
        frame(p, helloOf(p));
      }
      if (t >= p.nextSnap) {
        p.nextSnap += 500;
        if (!c.lattice) for (let k = 0; k < 3; k++) p.pos[k] += p.vel[k] * 0.5;
        p.pos[2] = Math.max(-50, Math.min(50, p.pos[2]));
        if (chance(0.1)) {
          const h = Math.atan2(p.vel[1], p.vel[0]) + (unit() - 0.5);
          const sp = Math.hypot(p.vel[0], p.vel[1]);
          p.vel = [Math.cos(h) * sp, Math.sin(h) * sp, p.vel[2] * 0.5];
        }
        if (!c.lattice && chance(0.01)) p.pos = [p.pos[0] + 800, p.pos[1] - 500, p.pos[2]];
        p.tus = (p.tus + 500000 + r.below(20000)) >>> 0;
        const heading = Math.atan2(p.vel[1], p.vel[0]);
        frame(p, chance(0.5) ? K.snapPose(p.id, p.pos, p.vel, heading, p.slope, p.status) : K.snapMoving(p.id, p.pos, p.vel, heading, p.status));
        // (the SNAP's time on the player's clock: tUs at [22..26] of the datagram, its epoch at [21])
        const last = trace[trace.length - 1];
        const d = unhex(last.hex);
        const o = 16 + 16;
        d[o + 5] = p.clock;
        d[o + 6] = p.tus & 255; d[o + 7] = (p.tus >>> 8) & 255; d[o + 8] = (p.tus >>> 16) & 255; d[o + 9] = p.tus >>> 24;
        K.recrc(d.subarray(16));
        last.hex = hex(d);
      }
      if (c.maps && t >= p.nextAsk) {
        p.nextAsk += chance(0.5) ? 250 : 1000 + r.below(2000);
        if (chance(0.6)) {
          const flags = chance(0.5) ? pick([0, 1, 2, 3]) : null;
          const req = (p.req = (p.req + 1) & 0xffff);
          const base = chance(0.8) ? p.base : r.below(3);
          const d = flags === null ? K.mapreqBase(p.id, req, pick([64, 200, 4096, 65535]), base) : K.mapreqFlags(p.id, req, pick([64, 500, 4096]), base, flags);
          p.base = req;
          frame(p, d);
        } else {
          const req = (p.nreq = (p.nreq + 1) & 0xffff);
          const base = chance(0.85) ? p.nbase : 0;
          p.nbase = req;
          frame(p, K.nearreq(p.id, req, pick([16, 64, 128, 200]), base, pick([100, 300, 600, 1000, 2000])));
        }
      }
      if (c.lobbies && chance(0.004) && p.lobby === null) {
        p.lobby = { id: 1 + r.below(0xfffffffe), race: 1 + r.below(0xfffffffe), x: Math.round(p.pos[0]), y: Math.round(p.pos[1]), max: 2 + r.below(5), state: 0, t: 0 };
        p.lobby.t = chance(0.5) ? 0x8000 | (chance(0.3) ? 0x40 : 0) | (chance(0.3) ? 0x81 : 0) | (r.below(8) << 9) : 0;
        lobbyIds.set(p.lobby.id, [p.id]);
        raceOf.set(p.lobby.id, p);
      }
      if (p.lobby !== null && step % 10 === players.indexOf(p) % 10) {
        const ids = lobbyIds.get(p.lobby.id).slice(0, p.lobby.max);
        if (chance(0.03)) p.lobby.state = pick([0, 1, 2]);
        frame(p, K.lobbyMsg(p.id, { op: 1, state: p.lobby.state, max: p.lobby.max, lobby: p.lobby.id, race: p.lobby.race, x: p.lobby.x, y: p.lobby.y, t: p.lobby.t, ids }));
        if (chance(0.02)) {
          frame(p, K.lobbyMsg(p.id, { op: 5, max: p.lobby.max, lobby: p.lobby.id, race: p.lobby.race, x: p.lobby.x, y: p.lobby.y, ids: [] }));
          p.lobby = null;
        }
      }
      if (c.lobbies && chance(0.003) && raceOf.size > 0) {
        const host = pick([...raceOf.values()]);
        if (host.lobby && host !== p) {
          const ids = lobbyIds.get(host.lobby.id);
          if (!ids.includes(p.id) && ids.length < 6) ids.push(p.id);
          p.join = host.lobby;
          frame(p, K.lobbyMsg(p.id, { op: 2, max: host.lobby.max, lobby: host.lobby.id, race: host.lobby.race, x: host.lobby.x, y: host.lobby.y, ids: [] }));
        }
      }
      if (c.races && p.join && chance(0.01)) {
        const l = p.join;
        const ids = (lobbyIds.get(l.id) || [p.id]).slice(0, 6);
        frame(p, K.raceRep(p.id, r, l, ids.length));
        frame(p, K.raceRes(p.id, r, l, ids));
        p.join = null;
      }
      if (c.churn) {
        if (chance(c.churn / 10)) {
          frame(p, K.bye(p.id));
          p.alive = false;
        } else if (chance(c.churn / 20)) {
          trace.push({ t, op: 'gone', vip: p.vip });
        } else if (chance(c.churn / 10)) {
          p.status = pick([2, 2, 2, 5, 0, 3]);
        } else if (chance(c.churn / 30)) {
          p.id = 1 + r.below(0xfffffffe);
        } else if (chance(c.churn / 30)) {
          p.name = 'N' + r.below(1000);
        }
      }
    }
    if (c.churn && chance(c.churn)) newPlayer();
    if (c.social && chance(0.02)) {
      const p = pick(players);
      switch (r.below(6)) {
        case 0:
          trace.push({ t, op: 'blocks', vip: p.vip, names: [pick(players).name, 'Star' + r.below(5), 'nobody'] });
          break;
        case 1:
          trace.push({ t, op: 'page', vip: p.vip, name: chance(0.5) ? p.name : 'Page' + r.below(9) });
          break;
        case 2:
          if (p.owner) trace.push({ t, op: 'friends', vip: p.vip, me: p.owner, owners: owners.filter(() => chance(0.3)) });
          break;
        case 3:
          trace.push({ t, op: 'room_name', vip: p.vip, name: 'Room ' + r.below(9) });
          break;
        case 4:
          if (chance(0.2)) trace.push({ t, op: 'flew', vip: p.vip, secs: unit() * 100 });
          break;
        default:
          trace.push({ t, op: 'thread_busy', busy: pick([0, 0, 0.65, 0.8]) });
      }
    }
    if (step % 5 === 4) {
      trace.push({ t, op: 'tick', busy: c.busy ? pick([0.1, 0.1, 0.5, 0.7, 0.9, 0.95]) : 0 });
      if (c.queries && chance(0.3)) {
        const p = pick(players);
        trace.push({ t, op: pick(['info', 'counts', 'pairs']) });
        trace.push({ t, op: 'linked', vip: p.vip, name: pick(players).name });
        trace.push({ t, op: 'hosted', vip: p.vip });
        trace.push({ t, op: 'where', owners: owners.slice(0, 5) });
        trace.push({ t, op: 'crews', crews });
      }
    }
  }
  trace.push({ t, op: 'info' });
  trace.push({ t, op: 'links' });
  return trace;
}

/** one seed: [first difference or null, output lines] */
export function compareSeed(seed, cfg = {}, full = false) {
  const trace = genTrace(seed, cfg);
  const a = replayRust(trace, full);
  const b = replayJs(trace, full);
  return { diff: firstDiff(a, b), lines: a.length, trace };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const seed = Number(process.argv[2] || 1);
  const players = Number(process.argv[3] || 40);
  const seconds = Number(process.argv[4] || 12);
  const full = process.argv.includes('--hex');
  const t0 = Date.now();
  const { diff, lines, trace } = compareSeed(seed, { players, seconds }, full);
  if (process.argv.includes('--keep')) writeFileSync('/tmp/roam-trace-' + seed + '.jsonl', trace.map((x) => JSON.stringify(x)).join('\n') + '\n');
  console.log(diff ? 'DIFF ' + JSON.stringify(diff, null, 1) : 'same: ' + lines + ' lines, ' + trace.length + ' inputs, ' + (Date.now() - t0) + ' ms');
}
