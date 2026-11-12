// Counters: a port of web/server-rs/crates/util/src/counter.rs.  Rust shards each counter over cache lines so many
// threads can add at once; a Worker / Durable Object is one thread, so here a counter is one number (exact up to
// 2^53, where Rust's u64 goes on: far past what a switch counts).

/** counter.rs Counter: a count that only grows */
export class Counter {
  constructor() {
    this.n = 0;
  }
  /** counter.rs Counter::add */
  add(n) {
    this.n += n;
  }
  /** counter.rs Counter::inc */
  inc() {
    this.n += 1;
  }
  /** counter.rs Counter::get */
  get() {
    return this.n;
  }
}

/** counter.rs Counters<N>: N counters as one */
export class Counters {
  constructor(n) {
    if (!(Number.isInteger(n) && n >= 0)) throw new RangeError('Counters: n must be a whole number');
    this.v = new Array(n).fill(0);
  }
  /** counter.rs Counters::add */
  add(i, n) {
    if (!(i >= 0 && i < this.v.length)) throw new RangeError('Counters.add: index out of range');
    this.v[i] += n;
  }
  /** counter.rs Counters::get: each one's sum (a copy) */
  get() {
    return this.v.slice();
  }
}
