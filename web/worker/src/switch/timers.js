// A min-heap of timers in virtual time: what tokio's timers did, driven by the caller's clock (sans-IO).

export class Timers {
  constructor() {
    /** @type {{at:number, seq:number, fn:Function, live:boolean}[]} */
    this.h = [];
    this.seq = 0;
  }
  /** fn() at time at (ms); returns a handle whose cancel() drops it */
  at(at, fn) {
    if (!Number.isFinite(at)) throw new Error('timer at ' + at);
    const t = { at, seq: this.seq++, fn, live: true };
    const h = this.h;
    h.push(t);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(h[p], h[i])) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
    return { cancel() { t.live = false; } };
  }
  /** the soonest live timer's time, or Infinity */
  next() {
    while (this.h.length && !this.h[0].live) this.pop();
    return this.h.length ? this.h[0].at : Infinity;
  }
  pop() {
    const h = this.h;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && less(h[l], h[m])) m = l;
        if (r < h.length && less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }
  /** the soonest timer due at now, taken (null: none) */
  take(now) {
    if (this.next() > now) return null;
    return this.pop();
  }
  get size() { return this.h.length; }
}

function less(a, b) {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

/** An insertion-ordered map with IndexMap's swap_remove (the last entry takes the removed one's place). */
export class SwapMap {
  constructor() {
    this.keys = [];
    this.vals = [];
    this.idx = new Map();
  }
  get size() { return this.keys.length; }
  has(k) { return this.idx.has(k); }
  get(k) { const i = this.idx.get(k); return i === undefined ? undefined : this.vals[i]; }
  /** insert: an existing key keeps its place */
  set(k, v) {
    const i = this.idx.get(k);
    if (i !== undefined) { this.vals[i] = v; return; }
    this.idx.set(k, this.keys.length);
    this.keys.push(k);
    this.vals.push(v);
  }
  swapRemove(k) {
    const i = this.idx.get(k);
    if (i === undefined) return false;
    const last = this.keys.length - 1;
    this.idx.delete(k);
    if (i !== last) {
      this.keys[i] = this.keys[last];
      this.vals[i] = this.vals[last];
      this.idx.set(this.keys[i], i);
    }
    this.keys.pop();
    this.vals.pop();
    return true;
  }
  values() { return this.vals.slice(); }
}

