// A token bucket (nfsu2_util::bucket::Bucket): rate a second, at most cap stored (two seconds' worth, or a burst of its
// own), full at the start; times are the caller's ms.

export class Bucket {
  constructor(rate, cap, now) {
    this.rate = rate;
    this.cap = cap;
    this.v = cap;
    this.t = now;
  }
  static newAt(rate, now) {
    return new Bucket(rate, rate * 2, now);
  }
  static withBurstAt(rate, burst, now) {
    return new Bucket(rate, burst, now);
  }
  levelAt(now) {
    return Math.min(this.cap, this.v + ((now - this.t) / 1000) * this.rate);
  }
  hasAt(now, n) {
    this.v = this.levelAt(now);
    this.t = now;
    return this.v >= n;
  }
  takeAt(now, n) {
    if (!this.hasAt(now, n)) return false;
    this.v -= n;
    return true;
  }
  spendAt(now, n) {
    this.hasAt(now, 0);
    this.v = Math.max(-this.cap, this.v - n);
    return this.v >= 0;
  }
}

