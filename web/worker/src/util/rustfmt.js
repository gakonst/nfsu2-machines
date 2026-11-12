// Exact emulation of the Rust float formatting the ported server modules use, so their log lines match the Rust
// server's byte for byte:
//
//   fixed(x, p)        == format!("{:.p$}", x)       the exact binary value, rounded half to even on exact ties
//   fixedPad(x, w, p)  == format!("{:0w$.p$}", x)    zero padded to width w, the sign first
//   display(x)         == format!("{}", x)           shortest round-trip digits, never exponent notation
//   hex8(n)            == format!("{:08x}", n)       n a u32
//
// Rust prints '-' for every negative value, -0.0 and values that round to zero included ("-0", "-0.0"), "NaN" for
// every NaN (no sign), "inf" and "-inf"; with the 0 flag it pads those too ("0NaN", "-0000inf").  Zero dependencies.

const view = new DataView(new ArrayBuffer(8));

/** a finite non-negative double as [mantissa, exponent]: x == m * 2^e exactly */
function decompose(x) {
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const be = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (be === 0) return [m, -1074];
  m |= 1n << 52n;
  return [m, be - 1075];
}

/** whether Rust prints a '-' for x (a negative sign bit; NaN never) */
function negative(x) {
  return x < 0 || Object.is(x, -0);
}

/** |x| (finite) to prec digits after the point, without a sign */
function fixedAbs(x, prec) {
  const [m, e] = decompose(Math.abs(x));
  const p10 = 10n ** BigInt(prec);
  let q;
  if (e >= 0) {
    q = (m << BigInt(e)) * p10;
  } else {
    const num = m * p10;
    const den = 1n << BigInt(-e);
    q = num / den;
    const r2 = (num - q * den) * 2n;
    if (r2 > den || (r2 === den && (q & 1n) === 1n)) q += 1n;
  }
  let s = q.toString();
  if (prec > 0) {
    s = s.padStart(prec + 1, '0');
    s = s.slice(0, s.length - prec) + '.' + s.slice(s.length - prec);
  }
  return s;
}

function checkPrec(prec) {
  if (!Number.isInteger(prec) || prec < 0 || prec > 1100) throw new RangeError('precision ' + prec);
}

/**
 * format!("{:.prec$}", x)
 * @param {number} x
 * @param {number} prec
 */
export function fixed(x, prec) {
  checkPrec(prec);
  if (Number.isNaN(x)) return 'NaN';
  const sign = negative(x) ? '-' : '';
  if (!Number.isFinite(x)) return sign + 'inf';
  return sign + fixedAbs(x, prec);
}

/**
 * format!("{:0width$.prec$}", x): the sign, then zeros up to width in all
 * @param {number} x
 * @param {number} width
 * @param {number} prec
 */
export function fixedPad(x, width, prec) {
  checkPrec(prec);
  if (Number.isNaN(x)) return 'NaN'.padStart(width, '0');
  const sign = negative(x) ? '-' : '';
  const body = Number.isFinite(x) ? fixedAbs(x, prec) : 'inf';
  return sign + body.padStart(width - sign.length, '0');
}

/**
 * format!("{}", x) of an f64: the shortest digits that read back as x (as JS's own), written out in full
 * @param {number} x
 */
export function display(x) {
  if (Number.isNaN(x)) return 'NaN';
  const sign = negative(x) ? '-' : '';
  if (!Number.isFinite(x)) return sign + 'inf';
  if (x === 0) return sign + '0';
  // (toExponential() with no digits asked: as many as it takes to tell x apart, the same shortest digits as Rust's)
  const ex = Math.abs(x).toExponential();
  const k = ex.indexOf('e');
  const digits = ex.slice(0, k).replace('.', '');
  const exp = Number(ex.slice(k + 1));
  // the value is 0.digits * 10^(exp + 1)
  const point = exp + 1;
  let s;
  if (point <= 0) s = '0.' + '0'.repeat(-point) + digits;
  else if (point >= digits.length) s = digits + '0'.repeat(point - digits.length);
  else s = digits.slice(0, point) + '.' + digits.slice(point);
  return sign + s;
}

/**
 * format!("{:08x}", n) of a u32
 * @param {number} n
 */
export function hex8(n) {
  return (n >>> 0).toString(16).padStart(8, '0');
}
