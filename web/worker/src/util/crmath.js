// Correctly rounded hypot and atan2 for the hub's arithmetic (the Rust server's f64::hypot and f64::atan2 are glibc's,
// which round correctly where V8's Math.hypot and Math.atan2 may be an ulp off), and the cos/sin of a heading byte as
// the Rust server computes them (a table made from it: glibc's cos and sin of h * PI / 128).

const SPLIT = 134217729; // 2^27 + 1

/** [s, e]: a + b = s + e exactly */
function twoSum(a, b) {
  const s = a + b;
  const bb = s - a;
  return [s, (a - (s - bb)) + (b - bb)];
}

/** a * b = p + e exactly (|a|, |b| < 2^996) */
function twoProd(a, b) {
  const p = a * b;
  let c = SPLIT * a;
  const ah = c - (c - a), al = a - ah;
  c = SPLIT * b;
  const bh = c - (c - b), bl = b - bh;
  return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
}

/** Math.hypot(x, y) correctly rounded (C's hypot: an infinity wins over a NaN) */
export function hypot2(x, y) {
  x = Math.abs(x);
  y = Math.abs(y);
  if (x === Infinity || y === Infinity) return Infinity;
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x < y) { const t = x; x = y; y = t; }
  if (y === 0) return x;
  // scaled so that the squares neither overflow nor lose bits (powers of two: exact)
  let scale = 1;
  if (x > 2 ** 500) { x *= 2 ** -600; y *= 2 ** -600; scale = 2 ** 600; }
  else if (x < 2 ** -500) { x *= 2 ** 600; y *= 2 ** 600; scale = 2 ** -600; }
  const [p1, e1] = twoProd(x, x);
  const [p2, e2] = twoProd(y, y);
  const [s, t] = twoSum(p1, p2);
  const [sh, sl] = twoSum(s, t + e1 + e2);
  const r0 = Math.sqrt(sh);
  const [a, b] = twoProd(r0, r0);
  const d = ((sh - a) - b) + sl;
  return (r0 + d / (2 * r0)) * scale;
}

// --- double-double helpers for atan2 ---

function ddAdd(ah, al, bh, bl) {
  let [s, e] = twoSum(ah, bh);
  e += al + bl;
  return twoSum(s, e);
}

function ddMul(ah, al, bh, bl) {
  const [p, e] = twoProd(ah, bh);
  return twoSum(p, e + (ah * bl + al * bh));
}

function ddMulD(ah, al, b) {
  const [p, e] = twoProd(ah, b);
  return twoSum(p, e + al * b);
}

// pi/2 in three parts
const PIO2_1 = 1.5707963267948966, PIO2_2 = 6.123233995736766e-17, PIO2_3 = -1.4973849048591698e-33;

/** [cos hi, cos lo, sin hi, sin lo] of a double-double r within about pi/4 (Taylor, 30 terms: far past 2^-106) */
function ddSinCosSmall(rh, rl) {
  const [r2h, r2l] = ddMul(rh, rl, rh, rl);
  // sin = r (1 - r^2/3! (1 - r^2/(4*5) (1 - ...))) by Horner from the far end
  let sh = 1, sl = 0, ch = 1, cl = 0;
  for (let k = 27; k >= 1; k -= 2) {
    // sin: term ratio r^2 / ((k+1)(k+2)) for the series in odd powers
    let [th, tl] = ddMul(sh, sl, r2h, r2l);
    let q = (k + 1) * (k + 2);
    // t / q
    let qh = th / q;
    let [ph, pl] = twoProd(qh, q);
    let ql = ((th - ph) - pl + tl) / q;
    [sh, sl] = ddAdd(1, 0, -qh, -ql);
    [th, tl] = ddMul(ch, cl, r2h, r2l);
    q = k * (k + 1);
    qh = th / q;
    [ph, pl] = twoProd(qh, q);
    ql = ((th - ph) - pl + tl) / q;
    [ch, cl] = ddAdd(1, 0, -qh, -ql);
  }
  const [s2h, s2l] = ddMul(sh, sl, rh, rl);
  return [ch, cl, s2h, s2l];
}

/** cos and sin of a double a (|a| <= 4) as double-doubles */
function ddSinCos(a) {
  const k = Math.round(a / PIO2_1);
  // r = a - k pi/2, in double-double (k is small: k * PIO2_1 is exact to 53 + 3 bits)
  let [rh, rl] = twoProd(-k, PIO2_1);
  [rh, rl] = ddAdd(a, 0, rh, rl);
  [rh, rl] = ddAdd(rh, rl, -k * PIO2_2, -k * PIO2_3);
  const [ch, cl, sh, sl] = ddSinCosSmall(rh, rl);
  switch (((k % 4) + 4) % 4) {
    case 0: return [ch, cl, sh, sl];
    case 1: return [-sh, -sl, ch, cl];
    case 2: return [-ch, -cl, -sh, -sl];
    default: return [sh, sl, -ch, -cl];
  }
}

/** Math.atan2(y, x) correctly rounded (glibc's): V8's, refined by one step in double-double */
export function atan2(y, x) {
  const a0 = Math.atan2(y, x);
  if (!Number.isFinite(a0) || a0 === 0 || !Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return a0;
  const [ch, cl, sh, sl] = ddSinCos(a0);
  // delta = atan((y cos a0 - x sin a0) / (x cos a0 + y sin a0)): tiny, so the ratio itself to its own precision
  const [nh, nl] = ddAdd(...ddMulD(ch, cl, y), ...ddMulD(-sh, -sl, x));
  const [dh, dl] = ddAdd(...ddMulD(ch, cl, x), ...ddMulD(sh, sl, y));
  const delta = (nh + nl) / (dh + dl);
  // a0 + delta, rounded once (delta is about an ulp of a0 or less)
  return a0 + delta;
}


const H_SCALE = 2 ** -600, H_LARGE = 2 ** 511, H_TINY = 2 ** -459, H_EPS = 2 ** -54;

/** glibc 2.35+'s hypot kernel (sysdeps/ieee754/dbl-64/e_hypot.c, without FMA: Borges' correction) */
function hypotKernel(ax, ay) {
  let h = Math.sqrt(ax * ax + ay * ay);
  let t1, t2;
  if (h <= 2.0 * ay) {
    const delta = h - ay;
    t1 = ax * (2.0 * delta - ax);
    t2 = (delta - 2.0 * (ax - ay)) * delta;
  } else {
    const delta = h - ax;
    t1 = 2.0 * delta * (ax - 2.0 * ay);
    t2 = (4.0 * delta - ay) * ay + delta * delta;
  }
  h -= (t1 + t2) / (2.0 * h);
  return h;
}

/** f64::hypot as the Rust server computes it (glibc's hypot, x86-64 without FMA) */
export function hypot(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    if (Math.abs(x) === Infinity || Math.abs(y) === Infinity) return Infinity;
    return x + y;
  }
  x = Math.abs(x);
  y = Math.abs(y);
  const ax = x < y ? y : x, ay = x < y ? x : y;
  if (ax > H_LARGE) {
    if (ay <= ax * H_EPS) return ax + ay;
    return hypotKernel(ax * H_SCALE, ay * H_SCALE) / H_SCALE;
  }
  if (ay < H_TINY) {
    if (ax >= ay / H_EPS) return ax + ay;
    return hypotKernel(ax / H_SCALE, ay / H_SCALE) * H_SCALE;
  }
  if (ay <= ax * H_EPS) return ax + ay;
  return hypotKernel(ax, ay);
}


// cos and sin of h * PI / 128 for each heading byte h, as the Rust server computes them (glibc 2.39 on x86-64; made by
// a Rust program printing f64::cos and f64::sin bits): V8's Math.cos and Math.sin differ in the last bit for 14 of them
const HEADING_BITS = [
  '3ff00000000000000000000000000000',
  '3feffd886084cd0d3f992155f7a3667e',
  '3feff621e3796d7e3fa91f65f10dd814',
  '3fefe9cdad01883a3fb2d52092ce19f6',
  '3fefd88da3d125263fb917a6bc29b42c',
  '3fefc26470e19fd33fbf564e56a9730e',
  '3fefa7557f08a5173fc2c8106e8e613a',
  '3fef8764fa714ba93fc5e214448b3fc6',
  '3fef6297cff75cb03fc8f8b83c69a60a',
  '3fef38f3ac64e5893fcc0b826a7e4f63',
  '3fef0a7efb9230d73fcf19f97b215f1a',
  '3feed740e76849633fd111d262b1f677',
  '3fee9f4156c62dda3fd294062ed59f05',
  '3fee6288ec48e1123fd4135c94176602',
  '3fee212104f686e53fd58f9a75ab1fdd',
  '3feddb13b6ccc23d3fd7088530fa459e',
  '3fed906bcf328d463fd87de2a6aea963',
  '3fed4134d14dc93a3fd9ef7943a8ed8a',
  '3feced7af43cc7733fdb5d1009e15cc0',
  '3fec954b213411f53fdcc66e9931c45d',
  '3fec38b2f180bdb13fde2b5d3806f63b',
  '3febd7c0ac6f952a3fdf8ba4dbf89aba',
  '3feb728345196e3e3fe073879922ffed',
  '3feb090a581502003fe11eb3541b4b22',
  '3fea9b66290ea1a33fe1c73b39ae68c8',
  '3fea29a7a04627823fe26d054cdd12df',
  '3fe9b3e047f387413fe30ff7fce17035',
  '3fe93a22499263fc3fe3affa292050b9',
  '3fe8bc806b1517413fe44cf325091dd6',
  '3fe83b0e0bff976e3fe4e6cabbe3e5e9',
  '3fe7b5df226aafaf3fe57d69348cec9f',
  '3fe72d0837efff973fe610b7551d2cde',
  '3fe6a09e667f3bcd3fe6a09e667f3bcc',
  '3fe610b7551d2cdf3fe72d0837efff96',
  '3fe57d69348cec9f3fe7b5df226aafaf',
  '3fe4e6cabbe3e5e93fe83b0e0bff976d',
  '3fe44cf325091dd63fe8bc806b151741',
  '3fe3affa292050b93fe93a22499263fb',
  '3fe30ff7fce170363fe9b3e047f38740',
  '3fe26d054cdd12df3fea29a7a0462782',
  '3fe1c73b39ae68c93fea9b66290ea1a3',
  '3fe11eb3541b4b233feb090a581501ff',
  '3fe073879922ffed3feb728345196e3e',
  '3fdf8ba4dbf89abb3febd7c0ac6f9529',
  '3fde2b5d3806f63e3fec38b2f180bdb0',
  '3fdcc66e9931c45e3fec954b213411f5',
  '3fdb5d1009e15cc23feced7af43cc773',
  '3fd9ef7943a8ed8a3fed4134d14dc93a',
  '3fd87de2a6aea9643fed906bcf328d46',
  '3fd7088530fa45a13feddb13b6ccc23c',
  '3fd58f9a75ab1fdd3fee212104f686e5',
  '3fd4135c941766033fee6288ec48e112',
  '3fd294062ed59f053fee9f4156c62ddb',
  '3fd111d262b1f6783feed740e7684963',
  '3fcf19f97b215f1e3fef0a7efb9230d7',
  '3fcc0b826a7e4f623fef38f3ac64e589',
  '3fc8f8b83c69a60d3fef6297cff75cb0',
  '3fc5e214448b3fcb3fef8764fa714ba9',
  '3fc2c8106e8e613a3fefa7557f08a517',
  '3fbf564e56a973143fefc26470e19fd3',
  '3fb917a6bc29b4383fefd88da3d12525',
  '3fb2d52092ce19f83fefe9cdad01883a',
  '3fa91f65f10dd8243feff621e3796d7e',
  '3f992155f7a366773feffd886084cd0d',
  '3c91a62633145c073ff0000000000000',
  'bf992155f7a366543feffd886084cd0d',
  'bfa91f65f10dd8133feff621e3796d7e',
  'bfb2d52092ce19ef3fefe9cdad01883a',
  'bfb917a6bc29b42f3fefd88da3d12526',
  'bfbf564e56a9730b3fefc26470e19fd3',
  'bfc2c8106e8e61363fefa7557f08a517',
  'bfc5e214448b3fc73fef8764fa714ba9',
  'bfc8f8b83c69a6083fef6297cff75cb0',
  'bfcc0b826a7e4f5e3fef38f3ac64e589',
  'bfcf19f97b215f1a3fef0a7efb9230d7',
  'bfd111d262b1f6763feed740e7684963',
  'bfd294062ed59f023fee9f4156c62ddb',
  'bfd4135c941766003fee6288ec48e112',
  'bfd58f9a75ab1fdb3fee212104f686e5',
  'bfd7088530fa459f3feddb13b6ccc23c',
  'bfd87de2a6aea9623fed906bcf328d46',
  'bfd9ef7943a8ed883fed4134d14dc93a',
  'bfdb5d1009e15cbc3feced7af43cc774',
  'bfdcc66e9931c4603fec954b213411f4',
  'bfde2b5d3806f63c3fec38b2f180bdb1',
  'bfdf8ba4dbf89ab93febd7c0ac6f952a',
  'bfe073879922ffed3feb728345196e3e',
  'bfe11eb3541b4b213feb090a58150201',
  'bfe1c73b39ae68c63fea9b66290ea1a5',
  'bfe26d054cdd12df3fea29a7a0462782',
  'bfe30ff7fce170353fe9b3e047f38741',
  'bfe3affa292050b83fe93a22499263fc',
  'bfe44cf325091dd53fe8bc806b151742',
  'bfe4e6cabbe3e5e73fe83b0e0bff976f',
  'bfe57d69348ceca03fe7b5df226aafae',
  'bfe610b7551d2cdf3fe72d0837efff96',
  'bfe6a09e667f3bcc3fe6a09e667f3bcd',
  'bfe72d0837efff953fe610b7551d2ce0',
  'bfe7b5df226aafad3fe57d69348ceca1',
  'bfe83b0e0bff976e3fe4e6cabbe3e5e8',
  'bfe8bc806b1517413fe44cf325091dd6',
  'bfe93a22499263fb3fe3affa292050ba',
  'bfe9b3e047f387403fe30ff7fce17036',
  'bfea29a7a04627813fe26d054cdd12e0',
  'bfea9b66290ea1a43fe1c73b39ae68c8',
  'bfeb090a581502003fe11eb3541b4b22',
  'bfeb728345196e3d3fe073879922ffee',
  'bfebd7c0ac6f95293fdf8ba4dbf89abc',
  'bfec38b2f180bdb03fde2b5d3806f63f',
  'bfec954b213411f43fdcc66e9931c463',
  'bfeced7af43cc7733fdb5d1009e15cbf',
  'bfed4134d14dc93a3fd9ef7943a8ed8b',
  'bfed906bcf328d463fd87de2a6aea965',
  'bfeddb13b6ccc23c3fd7088530fa45a2',
  'bfee212104f686e43fd58f9a75ab1fe2',
  'bfee6288ec48e1123fd4135c94176600',
  'bfee9f4156c62dda3fd294062ed59f06',
  'bfeed740e76849633fd111d262b1f679',
  'bfef0a7efb9230d73fcf19f97b215f21',
  'bfef38f3ac64e5883fcc0b826a7e4f6c',
  'bfef6297cff75cb03fc8f8b83c69a617',
  'bfef8764fa714ba93fc5e214448b3fc6',
  'bfefa7557f08a5173fc2c8106e8e613c',
  'bfefc26470e19fd33fbf564e56a97319',
  'bfefd88da3d125253fb917a6bc29b43c',
  'bfefe9cdad01883a3fb2d52092ce1a0c',
  'bfeff621e3796d7e3fa91f65f10dd80d',
  'bfeffd886084cd0d3f992155f7a36689',
  'bff00000000000003ca1a62633145c07',
  'bfeffd886084cd0dbf992155f7a36642',
  'bfeff621e3796d7ebfa91f65f10dd7ea',
  'bfefe9cdad01883abfb2d52092ce19fb',
  'bfefd88da3d12526bfb917a6bc29b42b',
  'bfefc26470e19fd3bfbf564e56a97307',
  'bfefa7557f08a517bfc2c8106e8e6134',
  'bfef8764fa714baabfc5e214448b3fbd',
  'bfef6297cff75cb0bfc8f8b83c69a60e',
  'bfef38f3ac64e589bfcc0b826a7e4f63',
  'bfef0a7efb9230d7bfcf19f97b215f18',
  'bfeed740e7684964bfd111d262b1f675',
  'bfee9f4156c62ddbbfd294062ed59f01',
  'bfee6288ec48e113bfd4135c941765fc',
  'bfee212104f686e5bfd58f9a75ab1fde',
  'bfeddb13b6ccc23dbfd7088530fa459e',
  'bfed906bcf328d47bfd87de2a6aea961',
  'bfed4134d14dc93abfd9ef7943a8ed87',
  'bfeced7af43cc774bfdb5d1009e15cbb',
  'bfec954b213411f5bfdcc66e9931c45f',
  'bfec38b2f180bdb1bfde2b5d3806f63b',
  'bfebd7c0ac6f952abfdf8ba4dbf89ab8',
  'bfeb728345196e3ebfe073879922ffec',
  'bfeb090a58150201bfe11eb3541b4b20',
  'bfea9b66290ea1a5bfe1c73b39ae68c6',
  'bfea29a7a0462782bfe26d054cdd12df',
  'bfe9b3e047f38741bfe30ff7fce17034',
  'bfe93a22499263fcbfe3affa292050b8',
  'bfe8bc806b151742bfe44cf325091dd4',
  'bfe83b0e0bff9770bfe4e6cabbe3e5e7',
  'bfe7b5df226aafafbfe57d69348ceca0',
  'bfe72d0837efff97bfe610b7551d2cde',
  'bfe6a09e667f3bcebfe6a09e667f3bcc',
  'bfe610b7551d2ce0bfe72d0837efff95',
  'bfe57d69348ceca2bfe7b5df226aafad',
  'bfe4e6cabbe3e5ecbfe83b0e0bff976b',
  'bfe44cf325091ddabfe8bc806b15173e',
  'bfe3affa292050bdbfe93a22499263f8',
  'bfe30ff7fce17033bfe9b3e047f38742',
  'bfe26d054cdd12debfea29a7a0462783',
  'bfe1c73b39ae68c8bfea9b66290ea1a3',
  'bfe11eb3541b4b23bfeb090a581501ff',
  'bfe073879922ffeebfeb728345196e3d',
  'bfdf8ba4dbf89abdbfebd7c0ac6f9529',
  'bfde2b5d3806f63fbfec38b2f180bdb0',
  'bfdcc66e9931c464bfec954b213411f4',
  'bfdb5d1009e15cc7bfeced7af43cc771',
  'bfd9ef7943a8ed93bfed4134d14dc938',
  'bfd87de2a6aea96dbfed906bcf328d44',
  'bfd7088530fa459bbfeddb13b6ccc23d',
  'bfd58f9a75ab1fdbbfee212104f686e5',
  'bfd4135c94176601bfee6288ec48e112',
  'bfd294062ed59f07bfee9f4156c62dda',
  'bfd111d262b1f67abfeed740e7684963',
  'bfcf19f97b215f23bfef0a7efb9230d7',
  'bfcc0b826a7e4f6ebfef38f3ac64e588',
  'bfc8f8b83c69a619bfef6297cff75caf',
  'bfc5e214448b3fd7bfef8764fa714ba8',
  'bfc2c8106e8e614ebfefa7557f08a516',
  'bfbf564e56a972fdbfefc26470e19fd4',
  'bfb917a6bc29b421bfefd88da3d12526',
  'bfb2d52092ce19f1bfefe9cdad01883a',
  'bfa91f65f10dd816bfeff621e3796d7e',
  'bf992155f7a3669bbfeffd886084cd0d',
  'bcaa79394c9e8a0abff0000000000000',
  '3f992155f7a36631bfeffd886084cd0d',
  '3fa91f65f10dd7e1bfeff621e3796d7e',
  '3fb2d52092ce19d6bfefe9cdad01883a',
  '3fb917a6bc29b407bfefd88da3d12526',
  '3fbf564e56a972e3bfefc26470e19fd4',
  '3fc2c8106e8e6141bfefa7557f08a516',
  '3fc5e214448b3fcabfef8764fa714ba9',
  '3fc8f8b83c69a60cbfef6297cff75cb0',
  '3fcc0b826a7e4f61bfef38f3ac64e589',
  '3fcf19f97b215f16bfef0a7efb9230d7',
  '3fd111d262b1f674bfeed740e7684964',
  '3fd294062ed59f00bfee9f4156c62ddb',
  '3fd4135c941765fbbfee6288ec48e113',
  '3fd58f9a75ab1fd5bfee212104f686e6',
  '3fd7088530fa4595bfeddb13b6ccc23e',
  '3fd87de2a6aea967bfed906bcf328d45',
  '3fd9ef7943a8ed8dbfed4134d14dc939',
  '3fdb5d1009e15cc1bfeced7af43cc773',
  '3fdcc66e9931c45ebfec954b213411f5',
  '3fde2b5d3806f63abfec38b2f180bdb1',
  '3fdf8ba4dbf89ab7bfebd7c0ac6f952a',
  '3fe073879922ffecbfeb728345196e3f',
  '3fe11eb3541b4b20bfeb090a58150201',
  '3fe1c73b39ae68c5bfea9b66290ea1a5',
  '3fe26d054cdd12dbbfea29a7a0462785',
  '3fe30ff7fce17031bfe9b3e047f38744',
  '3fe3affa292050bbbfe93a22499263fa',
  '3fe44cf325091dd7bfe8bc806b151740',
  '3fe4e6cabbe3e5e9bfe83b0e0bff976e',
  '3fe57d69348cec9fbfe7b5df226aafaf',
  '3fe610b7551d2cdebfe72d0837efff97',
  '3fe6a09e667f3bcbbfe6a09e667f3bce',
  '3fe72d0837efff94bfe610b7551d2ce1',
  '3fe7b5df226aafadbfe57d69348ceca2',
  '3fe83b0e0bff976bbfe4e6cabbe3e5ec',
  '3fe8bc806b15173ebfe44cf325091dda',
  '3fe93a22499263f8bfe3affa292050be',
  '3fe9b3e047f38742bfe30ff7fce17034',
  '3fea29a7a0462782bfe26d054cdd12de',
  '3fea9b66290ea1a3bfe1c73b39ae68c8',
  '3feb090a581501ffbfe11eb3541b4b23',
  '3feb728345196e3dbfe073879922ffef',
  '3febd7c0ac6f9529bfdf8ba4dbf89abe',
  '3fec38b2f180bdafbfde2b5d3806f640',
  '3fec954b213411f3bfdcc66e9931c465',
  '3feced7af43cc771bfdb5d1009e15cc8',
  '3fed4134d14dc938bfd9ef7943a8ed94',
  '3fed906bcf328d44bfd87de2a6aea96e',
  '3feddb13b6ccc23dbfd7088530fa459c',
  '3fee212104f686e5bfd58f9a75ab1fdc',
  '3fee6288ec48e112bfd4135c94176602',
  '3fee9f4156c62ddabfd294062ed59f08',
  '3feed740e7684963bfd111d262b1f67b',
  '3fef0a7efb9230d7bfcf19f97b215f25',
  '3fef38f3ac64e588bfcc0b826a7e4f70',
  '3fef6297cff75cafbfc8f8b83c69a61b',
  '3fef8764fa714ba8bfc5e214448b3fda',
  '3fefa7557f08a516bfc2c8106e8e6151',
  '3fefc26470e19fd3bfbf564e56a97302',
  '3fefd88da3d12526bfb917a6bc29b425',
  '3fefe9cdad01883abfb2d52092ce19f5',
  '3feff621e3796d7ebfa91f65f10dd81f',
  '3feffd886084cd0dbf992155f7a366ac',
];
const HEADING_COS = new Float64Array(256), HEADING_SIN = new Float64Array(256);
{
  const dv = new DataView(new ArrayBuffer(8));
  for (let h = 0; h < 256; h++) {
    const b = HEADING_BITS[h];
    dv.setUint32(0, parseInt(b.slice(0, 8), 16)); dv.setUint32(4, parseInt(b.slice(8, 16), 16));
    HEADING_COS[h] = dv.getFloat64(0);
    dv.setUint32(0, parseInt(b.slice(16, 24), 16)); dv.setUint32(4, parseInt(b.slice(24, 32), 16));
    HEADING_SIN[h] = dv.getFloat64(0);
  }
}

/** f64::cos of h * PI / 128 for a heading byte h, as the Rust server has it */
export function headingCos(h) { return HEADING_COS[h & 255]; }
/** f64::sin of h * PI / 128 for a heading byte h, as the Rust server has it */
export function headingSin(h) { return HEADING_SIN[h & 255]; }
