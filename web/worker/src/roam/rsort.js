// Rust's slice::sort_unstable_by (core::slice::sort::unstable, Rust 1.99: ipnsort), step for step, for the hub's two
// sorts whose ties it can tell apart (hub.rs: a one-way list's links by slot, the minimap grid's players by cell): an
// unstable sort leaves equal keys in an order of its own, and the hub's links and answers hang on it.  Only what those
// element types take: Freeze + Copy types of more than 8 bytes and at most 96 (the general small sort, threshold 32;
// sort8 for 16 bytes or less; the cyclic branchless Lomuto partition), on a 64-bit target.

const SMALL_SORT_GENERAL_THRESHOLD = 32;
const MAX_LEN_ALWAYS_INSERTION_SORT = 20;
const PSEUDO_MEDIAN_REC_THRESHOLD = 64;

/**
 * a.sort_unstable_by(is_less) of Rust, in place
 * @template T
 * @param {T[]} a
 * @param {(x: T, y: T) => boolean} isLess
 * @param {number} size the element type's size_of in bytes (9 to 96)
 */
export function sortUnstable(a, isLess, size) {
  if (!(size > 8 && size <= 96)) throw new RangeError('sortUnstable: a type of 9 to 96 bytes');
  const len = a.length;
  if (len < 2) return;
  if (len <= MAX_LEN_ALWAYS_INSERTION_SORT) {
    insertionSortShiftLeft(a, 0, len, 1, isLess);
    return;
  }
  // ipnsort
  let runLen = 2;
  const desc = isLess(a[1], a[0]);
  if (desc) while (runLen < len && isLess(a[runLen], a[runLen - 1])) runLen++;
  else while (runLen < len && !isLess(a[runLen], a[runLen - 1])) runLen++;
  if (runLen === len) {
    if (desc) a.reverse();
    return;
  }
  const limit = 2 * Math.floor(Math.log2(len | 1));
  quicksort(a, 0, len, null, limit, isLess, size);
}

function insertTail(a, begin, tail, isLess) {
  let sift = tail - 1;
  if (!isLess(a[tail], a[sift])) return;
  const tmp = a[tail];
  let dst = tail;
  for (;;) {
    a[dst] = a[sift];
    dst = sift;
    if (sift === begin) break;
    sift--;
    if (!isLess(tmp, a[sift])) break;
  }
  a[dst] = tmp;
}

function insertionSortShiftLeft(a, lo, hi, offset, isLess) {
  for (let tail = lo + offset; tail < hi; tail++) insertTail(a, lo, tail, isLess);
}

function median3(a, i, j, k, isLess) {
  const x = isLess(a[i], a[j]);
  const y = isLess(a[i], a[k]);
  if (x === y) {
    const z = isLess(a[j], a[k]);
    return z !== x ? k : j;
  }
  return i;
}

function median3Rec(a, i, j, k, n, isLess) {
  if (n * 8 >= PSEUDO_MEDIAN_REC_THRESHOLD) {
    const n8 = Math.floor(n / 8);
    i = median3Rec(a, i, i + n8 * 4, i + n8 * 7, n8, isLess);
    j = median3Rec(a, j, j + n8 * 4, j + n8 * 7, n8, isLess);
    k = median3Rec(a, k, k + n8 * 4, k + n8 * 7, n8, isLess);
  }
  return median3(a, i, j, k, isLess);
}

/** the pivot's index in a[lo..hi) (shared/pivot.rs choose_pivot) */
function choosePivot(a, lo, hi, isLess) {
  const len = hi - lo;
  const d8 = Math.floor(len / 8);
  const i = lo, j = lo + d8 * 4, k = lo + d8 * 7;
  return len < PSEUDO_MEDIAN_REC_THRESHOLD ? median3(a, i, j, k, isLess) : median3Rec(a, i, j, k, d8, isLess);
}

/** the cyclic branchless Lomuto partition of a[lo..hi) by pivot: how many are less (in front) */
function partitionLomutoCyclic(a, lo, hi, pivot, isLess) {
  const len = hi - lo;
  if (len === 0) return 0;
  const gapValue = a[lo];
  let numLt = 0, right = lo + 1, gapPos = lo;
  const body = (rv, isTmp) => {
    const lt = isLess(rv, pivot);
    const left = lo + numLt;
    a[gapPos] = a[left];
    a[left] = rv;
    gapPos = isTmp ? -1 : right;
    numLt += lt ? 1 : 0;
    right++;
  };
  while (right < hi) body(a[right], false);
  body(gapValue, true);
  return numLt;
}

/** quicksort.rs partition: a[lo..hi) by the pivot at pivotPos, the pivot then at lo + the count returned */
function partition(a, lo, hi, pivotPos, isLess) {
  const len = hi - lo;
  if (len === 0) return 0;
  let t = a[lo];
  a[lo] = a[pivotPos];
  a[pivotPos] = t;
  const pivot = a[lo];
  const numLt = partitionLomutoCyclic(a, lo + 1, hi, pivot, isLess);
  t = a[lo];
  a[lo] = a[lo + numLt];
  a[lo + numLt] = t;
  return numLt;
}

function heapsort(a, lo, hi, isLess) {
  const len = hi - lo;
  for (let i = len + Math.floor(len / 2) - 1; i >= 0; i--) {
    let node;
    if (i >= len) node = i - len;
    else {
      const t = a[lo];
      a[lo] = a[lo + i];
      a[lo + i] = t;
      node = 0;
    }
    const n = Math.min(i, len);
    for (;;) {
      let child = 2 * node + 1;
      if (child >= n) break;
      if (child + 1 < n && isLess(a[lo + child], a[lo + child + 1])) child++;
      if (!isLess(a[lo + node], a[lo + child])) break;
      const t = a[lo + node];
      a[lo + node] = a[lo + child];
      a[lo + child] = t;
      node = child;
    }
  }
}

function sort4Stable(src, s, dst, d, isLess) {
  const c1 = isLess(src[s + 1], src[s]);
  const c2 = isLess(src[s + 3], src[s + 2]);
  const ia = s + (c1 ? 1 : 0), ib = s + (c1 ? 0 : 1), ic = s + 2 + (c2 ? 1 : 0), id = s + 2 + (c2 ? 0 : 1);
  const c3 = isLess(src[ic], src[ia]);
  const c4 = isLess(src[id], src[ib]);
  const min = c3 ? ic : ia;
  const max = c4 ? ib : id;
  const ul = c3 ? ia : c4 ? ic : ib;
  const ur = c4 ? id : c3 ? ib : ic;
  const c5 = isLess(src[ur], src[ul]);
  const lo = c5 ? ur : ul, hi = c5 ? ul : ur;
  dst[d] = src[min];
  dst[d + 1] = src[lo];
  dst[d + 2] = src[hi];
  dst[d + 3] = src[max];
}

/** smallsort.rs bidirectional_merge of src[s..s+len) (two sorted halves) into dst[d..) */
function bidirectionalMerge(src, s, len, dst, d, isLess) {
  const half = Math.floor(len / 2);
  let left = s, right = s + half, out = d;
  let leftRev = s + half - 1, rightRev = s + len - 1, outRev = d + len - 1;
  for (let k = 0; k < half; k++) {
    let isL = !isLess(src[right], src[left]);
    dst[out] = isL ? src[left] : src[right];
    if (isL) left++;
    else right++;
    out++;
    isL = !isLess(src[rightRev], src[leftRev]);
    dst[outRev] = isL ? src[rightRev] : src[leftRev];
    if (isL) rightRev--;
    else leftRev--;
    outRev--;
  }
  const leftEnd = leftRev + 1, rightEnd = rightRev + 1;
  if (len % 2 !== 0) {
    const leftNonempty = left < leftEnd;
    dst[out] = leftNonempty ? src[left] : src[right];
    if (leftNonempty) left++;
    else right++;
  }
  if (left !== leftEnd || right !== rightEnd) throw new Error('user-provided comparison function does not correctly implement a total order');
}

function sort8Stable(a, v, dst, d, scratch, sc, isLess) {
  sort4Stable(a, v, scratch, sc, isLess);
  sort4Stable(a, v + 4, scratch, sc + 4, isLess);
  bidirectionalMerge(scratch, sc, 8, dst, d, isLess);
}

/** smallsort.rs small_sort_general_with_scratch on a[lo..hi) */
function smallSortGeneral(a, lo, hi, isLess, size) {
  const len = hi - lo;
  if (len < 2) return;
  const scratch = new Array(len + 16);
  const half = Math.floor(len / 2);
  let presorted;
  if (size <= 16 && len >= 16) {
    sort8Stable(a, lo, scratch, 0, scratch, len, isLess);
    sort8Stable(a, lo + half, scratch, half, scratch, len + 8, isLess);
    presorted = 8;
  } else if (len >= 8) {
    sort4Stable(a, lo, scratch, 0, isLess);
    sort4Stable(a, lo + half, scratch, half, isLess);
    presorted = 4;
  } else {
    scratch[0] = a[lo];
    scratch[half] = a[lo + half];
    presorted = 1;
  }
  for (const offset of [0, half]) {
    const want = offset === 0 ? half : len - half;
    for (let i = presorted; i < want; i++) {
      scratch[offset + i] = a[lo + offset + i];
      insertTail(scratch, offset, offset + i, isLess);
    }
  }
  bidirectionalMerge(scratch, 0, len, a, lo, isLess);
}

function quicksort(a, lo, hi, ancestor, limit, isLess, size) {
  for (let guard = 0; ; guard++) {
    if (guard > 1e7) throw new Error('quicksort runs away');
    const len = hi - lo;
    if (len <= SMALL_SORT_GENERAL_THRESHOLD) {
      smallSortGeneral(a, lo, hi, isLess, size);
      return;
    }
    if (limit === 0) {
      heapsort(a, lo, hi, isLess);
      return;
    }
    limit--;
    const pivotPos = choosePivot(a, lo, hi, isLess);
    if (ancestor !== null && !isLess(ancestor, a[pivotPos])) {
      const numLt = partition(a, lo, hi, pivotPos, (x, y) => !isLess(y, x));
      lo = lo + numLt + 1;
      ancestor = null;
      continue;
    }
    const numLt = partition(a, lo, hi, pivotPos, isLess);
    const pivot = a[lo + numLt];
    quicksort(a, lo, lo + numLt, ancestor, limit, isLess, size);
    lo = lo + numLt + 1;
    ancestor = pivot;
  }
}
