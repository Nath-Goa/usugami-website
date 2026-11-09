// Exact decimal numbers for spreadsheet number formats: a whole number (BigInt) times a power of
// ten, as Java's BigDecimal, which the app's formats are written with. Excel rounds to 15
// significant digits and then to the places a format shows, half away from zero, and doing that on
// doubles would round 1.005 to 1.00 instead of 1.01.

const TEN = 10n;
const POWERS = [1n];

/** 10 to the `n` (n >= 0), as a BigInt. */
export function pow10(n) {
  if (n < POWERS.length) return POWERS[n];
  if (n > 4096) return TEN ** BigInt(n);
  while (POWERS.length <= n) POWERS.push(POWERS[POWERS.length - 1] * TEN);
  return POWERS[n];
}

const abs = (b) => (b < 0n ? -b : b);

const MIN_NORMAL = 2.2250738585072014e-308;

/** The number of decimal digits of `b`, 1 for 0. */
function digitCount(b) {
  return abs(b).toString().length;
}

/** `u` divided by `d` (> 0), rounded half away from zero or down. */
function divide(u, d, mode) {
  const q = u / d;
  const r = u % d;
  if (r === 0n) return q;
  if (mode === 'floor') return u < 0n ? q - 1n : q;
  return 2n * abs(r) >= d ? (u < 0n ? q - 1n : q + 1n) : q;
}

export class Decimal {
  /** The value unscaled × 10^-scale. */
  constructor(unscaled, scale = 0) {
    this.unscaled = unscaled;
    this.scale = scale;
  }

  /** The finite number `x` as the shortest decimal that reads back as it (Java's Double.toString). */
  static fromNumber(x) {
    const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(x));
    if (!m) throw new RangeError('Not a finite number: ' + x);
    const fraction = m[3] ?? '';
    const unscaled = BigInt(m[1] + m[2] + fraction);
    const d = new Decimal(unscaled, fraction.length - Number(m[4] ?? 0));
    // Java always writes two digits, the nearest two: for the few bits of the smallest subnormals
    // they differ from one digit and a zero (4.9E-324, where JavaScript writes 5e-324).
    if (x !== 0 && Math.abs(x) < MIN_NORMAL && d.stripTrailingZeros().precision() === 1) {
      const units = BigInt(Math.abs(x) * 2 ** 1000 * 2 ** 74);
      const exact = new Decimal((x < 0 ? -units : units) * 5n ** 1074n, 1074);
      return exact.round(2);
    }
    return d;
  }

  static of(n) {
    return new Decimal(BigInt(n), 0);
  }

  signum() {
    return this.unscaled > 0n ? 1 : this.unscaled < 0n ? -1 : 0;
  }

  /** How many digits the unscaled value has (Java's precision()). */
  precision() {
    return digitCount(this.unscaled);
  }

  /** The power of ten of the first digit: 2 for 123.4, -3 for 0.00123. */
  magnitude() {
    return this.precision() - this.scale - 1;
  }

  /** This value with `scale` places after the point, rounded 'half-up' (away from zero) or 'floor'. */
  setScale(scale, mode = 'half-up') {
    if (scale === this.scale) return this;
    if (scale > this.scale) return new Decimal(this.unscaled * pow10(scale - this.scale), scale);
    return new Decimal(divide(this.unscaled, pow10(this.scale - scale), mode), scale);
  }

  /** This value rounded half away from zero to `digits` significant digits (Java's round(MathContext)). */
  round(digits) {
    let d = this;
    while (d.precision() > digits) d = d.setScale(d.scale - (d.precision() - digits));
    return d;
  }

  stripTrailingZeros() {
    if (this.unscaled === 0n) return new Decimal(0n, 0);
    let u = this.unscaled;
    let s = this.scale;
    // Big steps first, so a value with thousands of zeros doesn't take thousands of divisions.
    for (const step of [256, 16, 1]) {
      const p = pow10(step);
      while (u % p === 0n) {
        u /= p;
        s -= step;
      }
    }
    return new Decimal(u, s);
  }

  /** This value times 10^n, with Java's scale for movePointRight / movePointLeft (never below 0). */
  movePoint(n) {
    const scale = this.scale - n;
    return scale < 0 ? new Decimal(this.unscaled * pow10(-scale), 0) : new Decimal(this.unscaled, scale);
  }

  /** The digits without an exponent: "0.00123", "1200". */
  toPlainString() {
    const negative = this.unscaled < 0n;
    let digits = abs(this.unscaled).toString();
    if (this.scale <= 0) {
      if (this.unscaled !== 0n || this.scale === 0) digits += '0'.repeat(-this.scale);
    } else {
      if (digits.length <= this.scale) digits = '0'.repeat(this.scale - digits.length + 1) + digits;
      digits = digits.slice(0, digits.length - this.scale) + '.' + digits.slice(digits.length - this.scale);
    }
    return negative ? '-' + digits : digits;
  }

  /** The whole part, towards zero, as a BigInt. */
  toBigInt() {
    if (this.scale <= 0) return this.unscaled * pow10(-this.scale);
    return this.unscaled / pow10(this.scale);
  }

  /** The nearest double. */
  toNumber() {
    return Number(`${this.unscaled}e${-this.scale}`);
  }

  compareTo(other) {
    const scale = Math.max(this.scale, other.scale);
    const a = this.unscaled * pow10(scale - this.scale);
    const b = other.unscaled * pow10(scale - other.scale);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  subtract(other) {
    const scale = Math.max(this.scale, other.scale);
    return new Decimal(this.unscaled * pow10(scale - this.scale) - other.unscaled * pow10(scale - other.scale), scale);
  }

  /** This value times the whole number `n` (a BigInt). */
  times(n) {
    return new Decimal(this.unscaled * n, this.scale);
  }
}
