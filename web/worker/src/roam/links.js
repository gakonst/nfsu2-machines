// The pieces the links are made of (a port of web/server-rs/crates/roam/src/links.rs): the distance (Math.hypot as V8
// computes it, written out), the grid and its nearest-first walk (Near), and the heap that merges the walks.  Together
// they give the pairs in the order a sort of every pair would, bit for bit, ties included: the order decides between
// pairs at one distance, and so the links.
//
// A Place is [x, y, height, up] (up: how far up a player not in free roam counts).

/** Math.hypot(x, y, z) as V8 computes it (scaled by the largest, Kahan's sum): links.rs hypot3 */
export function hypot3(x, y, z) {
  const a0 = Math.abs(x), a1 = Math.abs(y), a2 = Math.abs(z);
  // (the largest that is not NaN, and whether any is NaN: V8's order of tests)
  let max = 0;
  let nan = false;
  if (a0 !== a0) nan = true;
  else if (a0 > max) max = a0;
  if (a1 !== a1) nan = true;
  else if (a1 > max) max = a1;
  if (a2 !== a2) nan = true;
  else if (a2 > max) max = a2;
  if (max === Infinity) return Infinity;
  if (nan) return NaN;
  if (max === 0) return 0;
  // Kahan's sum of the squares of each scaled by the largest, in the order x, y, z
  let sum = 0, compensation = 0;
  let n = a0 / max;
  let summand = n * n - compensation;
  let preliminary = sum + summand;
  compensation = (preliminary - sum) - summand;
  sum = preliminary;
  n = a1 / max;
  summand = n * n - compensation;
  preliminary = sum + summand;
  compensation = (preliminary - sum) - summand;
  sum = preliminary;
  n = a2 / max;
  summand = n * n - compensation;
  preliminary = sum + summand;
  compensation = (preliminary - sum) - summand;
  sum = preliminary;
  return Math.sqrt(sum) * max;
}

/** the distance of two positions: hypot3 of their differences in x, y and z */
export function distance(a, b) {
  return hypot3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** How the links weigh a gap in height that no road between two places explains (links.rs Level) */
export class Level {
  constructor(slack = Infinity, grade = 0, k = 0) {
    this.slack = slack;
    this.grade = grade;
    this.k = k;
    this.grade2 = grade * grade;
  }

  /** a gap in height dz as it counts, between two places h2 apart across (the square of the distance in x and y) */
  gap(h2, dz) {
    const v = Math.abs(dz);
    const over = v - this.slack;
    if (over <= 0.0 || over * over <= this.grade2 * h2) return v;
    const t = over - this.grade * Math.sqrt(h2);
    return v + this.k * (t > 0 ? t : 0);
  }

  /** the third side of a pair's distance: the gap in height as it counts and the difference in up */
  up(a, b, h2) {
    return this.gap(h2, a[2] - b[2]) + Math.abs(a[3] - b[3]);
  }
}

function oneLevel(a, b, dz, l) {
  return Math.abs(dz) <= l.slack && a[3] === b[3];
}

/** How far apart two places count for the links (links.rs weigh) */
export function weigh(a, b, l) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  if (oneLevel(a, b, dz, l)) return hypot3(dx, dy, dz);
  return hypot3(dx, dy, l.up(a, b, dx * dx + dy * dy));
}

/** the square of weigh, rounded (links.rs square) */
export function square(a, b, l) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  const h2 = dx * dx + dy * dy;
  if (oneLevel(a, b, dz, l)) return h2 + dz * dz;
  const u = l.up(a, b, h2);
  return h2 + u * u;
}

/** whether two places are the same (Rust's == of [f64; 4]) */
export function samePlace(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * order_key(d) of links.rs as a number to compare: the distances here are never NaN, so the order of order_key is the
 * order of the numbers, -0 as 0 (which compare equal)
 */
export function orderKey(d) {
  return d + 0.0;
}

const PER_CELL = 8.0;
const MIN_CELL = 5.0;

/** The players of a room (indices into its list) by their cell in x and y (links.rs Grid) */
export class Grid {
  constructor() {
    this.cell = MIN_CELL;
    this.x1 = 0;
    this.x2 = -1;
    this.y1 = 0;
    this.y2 = -1;
    this.rows = 0;
    this.start = new Uint32Array(1);
    this.end = new Uint32Array(0);
    this.members = new Uint32Array(0);
    /** @type {Array<number[]>} */
    this.mpos = [];
    this.at = new Uint32Array(0);
    this.cellOf = new Uint32Array(0);
    this.level = new Level();
  }

  /** the grid of every position in pos, its walks weighing gaps in height as level says */
  build(pos, level) {
    this.level = level;
    const n = pos.length;
    if (n === 0) {
      this.cell = MIN_CELL;
      this.x1 = 0;
      this.x2 = -1;
      this.y1 = 0;
      this.y2 = -1;
      this.rows = 0;
      this.start = new Uint32Array(1);
      this.end = new Uint32Array(0);
      this.members = new Uint32Array(0);
      this.mpos = [];
      this.at = new Uint32Array(0);
      this.cellOf = new Uint32Array(0);
      return;
    }
    let w1 = Infinity, w2 = -Infinity, h1 = Infinity, h2 = -Infinity;
    for (const p of pos) {
      if (p[0] < w1) w1 = p[0];
      if (p[0] > w2) w2 = p[0];
      if (p[1] < h1) h1 = p[1];
      if (p[1] > h2) h2 = p[1];
    }
    const cell = Math.max(MIN_CELL, Math.sqrt((Math.max(1, w2 - w1) * Math.max(1, h2 - h1) * PER_CELL) / n));
    this.cell = cell;
    this.x1 = Math.floor(w1 / cell);
    this.x2 = Math.floor(w2 / cell);
    this.y1 = Math.floor(h1 / cell);
    this.y2 = Math.floor(h2 / cell);
    this.rows = this.y2 - this.y1 + 1;
    const cells = (this.x2 - this.x1 + 1) * this.rows;
    const start = new Uint32Array(cells + 1);
    const cellOf = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.index(pos[i]);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const members = new Uint32Array(n);
    const at = new Uint32Array(n);
    const fill = start.slice(0, cells);
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      members[fill[c]] = i;
      at[i] = fill[c];
      fill[c]++;
    }
    this.start = start;
    this.end = fill;
    this.members = members;
    this.at = at;
    this.cellOf = cellOf;
    const mpos = new Array(n);
    for (let k = 0; k < n; k++) mpos[k] = pos[members[k]];
    this.mpos = mpos;
  }

  /** takes list[i] out: the walks read from then on pass it by (links.rs Grid::remove) */
  remove(i) {
    if (i >= this.cellOf.length) return;
    const c = this.cellOf[i], p = this.at[i];
    let last = this.end[c];
    if (p >= last) return;
    last -= 1;
    const j = this.members[last];
    const m = this.members[p];
    this.members[p] = this.members[last];
    this.members[last] = m;
    const q = this.mpos[p];
    this.mpos[p] = this.mpos[last];
    this.mpos[last] = q;
    this.at[j] = p;
    this.at[i] = last;
    this.end[c] -= 1;
  }

  index(p) {
    const x = Math.floor(p[0] / this.cell), y = Math.floor(p[1] / this.cell);
    return (x - this.x1) * this.rows + (y - this.y1);
  }
}

/** The ready ones put in order at a time */
const CHUNK = 32;
/** How far one square may be from another, relatively, and still be taken for the same distance */
const MARGIN = 1e-9;

/** the k-th smallest (0-based) of the numbers in a (a copy is made): select_nth_unstable's value there */
let kthBuf = new Float64Array(256);
function kth(a, n, k) {
  if (kthBuf.length < n) kthBuf = new Float64Array(Math.max(n, 2 * kthBuf.length));
  const v = kthBuf;
  for (let i = 0; i < n; i++) v[i] = a[i];
  let lo = 0, hi = n - 1;
  for (let guard = 0; guard < 200 && lo < hi; guard++) {
    const pivot = v[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (v[i] < pivot) i++;
      while (v[j] > pivot) j--;
      if (i <= j) {
        const t = v[i];
        v[i] = v[j];
        v[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return v[k];
  }
  if (lo < hi) {
    // (never: the guard is far past what a quickselect takes) sorted
    const s = Array.from(v.subarray(lo, hi + 1)).sort((x, y) => x - y);
    return s[k - lo];
  }
  return v[k];
}

/** What a Near found and has not given yet (links.rs Found): its arrays are kept from tick to tick */
export class Found {
  constructor() {
    this.poolSq = [];
    this.poolJ = [];
    this.readySq = [];
    this.readyJ = [];
    /** the nearest of the ones within reach, in order, the nearest last: [distance, j] */
    this.next = [];
  }
  clear() {
    this.poolSq.length = 0;
    this.poolJ.length = 0;
    this.readySq.length = 0;
    this.readyJ.length = 0;
    this.next.length = 0;
  }
}

/** list[i]'s others in the grid, nearest first (links.rs Near) */
export class Near {
  /** the others of list[i] nearest first from point at (or its own position: Near.of) */
  constructor(g, at, i, found) {
    this.i = i;
    this.at = at;
    this.level = g.level;
    this.x0 = Math.floor(at[0] / g.cell);
    this.y0 = Math.floor(at[1] / g.cell);
    this.last = Math.max(this.x0 - g.x1, g.x2 - this.x0, this.y0 - g.y1, g.y2 - this.y0);
    this.r = 0;
    found.clear();
    this.found = found;
  }

  static of(g, pos, i, found) {
    return new Near(g, pos[i], i, found);
  }

  intoFound() {
    const f = this.found;
    f.clear();
    return f;
  }

  /** the next nearest: [distance, j], or null after the last */
  next(g, pos) {
    const f = this.found;
    for (;;) {
      if (f.next.length > 0) return f.next.pop();
      if (f.readySq.length > 0) {
        this.order(pos);
        continue;
      }
      const reach = this.r <= this.last ? this.r * g.cell : Infinity;
      if (reach === Infinity && f.poolSq.length === 0) return null;
      const near = reach * reach * (1.0 - MARGIN), far = reach * reach * (1.0 + MARGIN);
      const a = this.at, l = this.level;
      // the pool's ones within reach into ready (retain the rest, in order)
      const ps = f.poolSq, pj = f.poolJ;
      let k = 0;
      for (let x = 0; x < ps.length; x++) {
        const sq = ps[x], j = pj[x];
        if (sq > far || (sq >= near && weigh(a, pos[j], l) > reach)) {
          ps[k] = sq;
          pj[k] = j;
          k++;
        } else {
          f.readySq.push(sq);
          f.readyJ.push(j);
        }
      }
      ps.length = k;
      pj.length = k;
      if (this.r <= this.last) {
        this.ring(g, this.r, reach, near, far);
        this.r += 1;
      }
    }
  }

  /** the nearest CHUNK of the ready ones (or all, when they are few) into next, in order (links.rs Near::order) */
  order(pos) {
    const a = this.at, l = this.level, f = this.found;
    const rs = f.readySq, rj = f.readyJ, nx = f.next;
    if (rs.length <= 2 * CHUNK) {
      for (let x = 0; x < rs.length; x++) nx.push([weigh(a, pos[rj[x]], l), rj[x]]);
      rs.length = 0;
      rj.length = 0;
    } else {
      const s = kth(rs, rs.length, CHUNK - 1);
      const far = s * (1.0 + MARGIN), within = Math.sqrt(s) * (1.0 + MARGIN / 5.0);
      let k = 0;
      for (let x = 0; x < rs.length; x++) {
        const sq = rs[x], j = rj[x];
        let keep = sq > far;
        if (!keep) {
          const d = weigh(a, pos[j], l);
          if (d > within) keep = true;
          else nx.push([d, j]);
        }
        if (keep) {
          rs[k] = sq;
          rj[k] = j;
          k++;
        }
      }
      rs.length = k;
      rj.length = k;
    }
    // in order, the nearest last (by distance, then j: descending)
    if (nx.length > 1) nx.sort((p, q) => q[0] - p[0] || q[1] - p[1]);
  }

  /** the cells r rings around its own */
  ring(g, r, reach, near, far) {
    const x0 = this.x0, y0 = this.y0;
    if (r === 0) {
      this.cell(g, x0, y0, reach, near, far);
      return;
    }
    const xa = Math.max(x0 - r, g.x1), xb = Math.min(x0 + r, g.x2);
    for (let side = 0; side < 2; side++) {
      const y = side === 0 ? y0 - r : y0 + r;
      if (y >= g.y1 && y <= g.y2) {
        for (let x = xa; x <= xb; x++) this.cell(g, x, y, reach, near, far);
      }
    }
    const ya = Math.max(y0 - r + 1, g.y1), yb = Math.min(y0 + r - 1, g.y2);
    for (let side = 0; side < 2; side++) {
      const x = side === 0 ? x0 - r : x0 + r;
      if (x >= g.x1 && x <= g.x2) {
        for (let y = ya; y <= yb; y++) this.cell(g, x, y, reach, near, far);
      }
    }
  }

  /** a cell's players into the pool, or into ready when they are within reach of the ring being read */
  cell(g, x, y, reach, near, far) {
    if (x < g.x1 || x > g.x2 || y < g.y1 || y > g.y2) return;
    const c = (x - g.x1) * g.rows + (y - g.y1);
    const a = this.at, l = this.level, f = this.found, me = this.i;
    const z = g.end[c];
    for (let k = g.start[c]; k < z; k++) {
      const j = g.members[k];
      if (j === me) continue;
      const b = g.mpos[k];
      const sq = square(a, b, l);
      if (sq > far || (sq >= near && weigh(a, b, l) > reach)) {
        f.poolSq.push(sq);
        f.poolJ.push(j);
      } else {
        f.readySq.push(sq);
        f.readyJ.push(j);
      }
    }
  }
}

/** the walks a player's nearest ones come from (link_many) */
export const WALK_SOON = 0;
export const WALK_AHEAD = 1;
export const WALK_VIEW = 2;

/**
 * An entry of the order a large room's pairs are taken in (links.rs Cand): d, the pair (lo, hi), which walk found it,
 * whether it is i's nearest one (else a link of the last tick) and whether i is the higher one
 */
export class Cand {
  constructor(d, i, j, nearest, walk = 0) {
    this.d = d;
    this.lo = i < j ? i : j;
    this.hi = i < j ? j : i;
    this.ihigh = i > j;
    this.nearest = nearest;
    this.walk = nearest ? walk & 3 : 0;
  }
  static by(d, i, j, walk) {
    return new Cand(d, i, j, true, walk);
  }
  i() {
    return this.ihigh ? this.hi : this.lo;
  }
  j() {
    return this.ihigh ? this.lo : this.hi;
  }
}

/** the least by d, then min(i, j), then max(i, j) */
export function before(x, y) {
  return x.d < y.d || (x.d === y.d && (x.lo < y.lo || (x.lo === y.lo && x.hi < y.hi)));
}

/** A binary heap, the least on top (links.rs Heap) */
export class Heap {
  constructor() {
    /** @type {Cand[]} */
    this.a = [];
  }
  clear() {
    this.a.length = 0;
  }
  peek() {
    return this.a.length > 0 ? this.a[0] : null;
  }
  push(e) {
    const a = this.a;
    a.push(e);
    let k = a.length - 1;
    while (k > 0) {
      const up = (k - 1) >> 1;
      if (!before(e, a[up])) break;
      a[k] = a[up];
      k = up;
    }
    a[k] = e;
  }
  pop() {
    const a = this.a;
    if (a.length === 0) return null;
    const top = a[0];
    const e = a.pop();
    if (a.length > 0) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && before(a[c + 1], a[c])) c += 1;
        if (!before(a[c], e)) break;
        a[k] = a[c];
        k = c;
      }
      a[k] = e;
    }
    return top;
  }
}
