// Rust's f64 comparisons where they differ from JS's: f64::max and f64::min ignore a NaN (Math.max and Math.min
// return it), and f64::total_cmp orders every value, NaN included, by its bits: -NaN < -inf < .. < -0 < +0 < .. < inf
// < +NaN (a sort's comparator: -1, 0 or 1).
//
// Of +0 and -0, Rust leaves f64::max/min's choice unspecified; the server's x86-64 build returns the second one
// (other: maxsd/minsd), as here: a.max(b) == fmax(a, b), so 0.0.max(-0.0) is -0.0 (test/roam/difftrace_watch.mjs
// found it, a winner "having driven -0.0 % of the way").  Where LLVM folds a constant it may pick the other one.

/** f64::max: the other one when either is NaN; b when they are equal (+0 and -0) */
export function fmax(a, b) {
  if (a !== a) return b;
  if (b !== b) return a;
  return a > b ? a : b;
}

/** f64::min: the other one when either is NaN; b when they are equal (+0 and -0) */
export function fmin(a, b) {
  if (a !== a) return b;
  if (b !== b) return a;
  return a < b ? a : b;
}

const view = new DataView(new ArrayBuffer(8));
const LOW63 = (1n << 63n) - 1n;

/** a double's bits as Rust's total_cmp compares them (an i64) */
function key(x) {
  view.setFloat64(0, x);
  const b = view.getBigInt64(0);
  return b < 0n ? b ^ LOW63 : b;
}

/** f64::total_cmp as a comparator */
export function totalCmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b && a !== 0) return 0;
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
