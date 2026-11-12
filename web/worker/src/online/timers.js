// The host's own timers (crates/online/src/timers.rs): a queue of actions by time; timers of the same time fire in
// the order they were set.  An action is a plain object naming what to do and for which session or connection (by
// id: the handler checks it is still there).  Kinds: LobbyTick, Later {key}, RedirectorIdle {c}, HttpIdle {c},
// BuddyLogin {b}, BuddyRetry {b, f}, Presence {b}, BuddyMail {b}, BuddySave.

import { assert } from './jsx.js';

export class Timers {
  constructor() {
    /** binary min-heap of [at, id] */
    this.heap = [];
    /** id -> action */
    this.live = new Map();
    this.next = 0;
  }
  static less(a, b) {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }
  push(e) {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Timers.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }
  pop() {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && Timers.less(h[l], h[m])) m = l;
        if (r < h.length && Timers.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
  /** a timer: action a at time at */
  set(at, a) {
    assert(a && typeof a.k === 'string', 'a timer action');
    this.next += 1;
    const id = this.next;
    this.push([Number.isNaN(at) ? 0 : at, id]);
    this.live.set(id, a);
    return id;
  }
  /** a timer ends (the queue compacted once it is mostly cleared places) */
  clear(id) {
    if (this.live.delete(id) && this.heap.length > 1024 && this.heap.length > 2 * this.live.size) {
      const kept = this.heap.filter((e) => this.live.has(e[1]));
      this.heap = [];
      for (const e of kept) this.push(e);
    }
  }
  queued() {
    return this.heap.length;
  }
  /** when the next live timer is due, or null */
  nextDue() {
    while (this.heap.length > 0) {
      const [at, id] = this.heap[0];
      if (this.live.has(id)) return at;
      this.pop();
    }
    return null;
  }
  /** the next timer due by now, taken off the queue: [id, action] or null */
  popDue(now) {
    const due = this.nextDue();
    if (due === null || due > now) return null;
    const [, id] = this.pop();
    const a = this.live.get(id);
    this.live.delete(id);
    return a === undefined ? null : [id, a];
  }
}

