// Ported from mp/common/fraction.kt

/** 最大公约数（恒非负；gcd(0,0)=0）。 */
export function gcd(numerator: number, denominator: number): number {
  let a = numerator;
  let b = denominator;
  while (b !== 0) {
    const oldB = b;
    b = a % b;
    a = oldB;
  }
  return Math.abs(a);
}

/** 最小公倍数。任一为 0 时返回另一个的绝对值（避免除零）——divisions 收集用得上。 */
export function lcm(a: number, b: number): number {
  const g = gcd(a, b);
  return g === 0 ? Math.abs(a || b) : Math.abs((a / g) * b);
}

export class Fraction {
  numerator = 0;
  denominator = 1;

  /** Mirrors the Kotlin (num, den) constructor (with gcd reduction). */
  constructor(num = 0, den = 1) {
    if (den < 0) {
      this.numerator = -num;
      this.denominator = -den;
    } else {
      this.numerator = num;
      this.denominator = den;
    }
    const g = gcd(this.numerator, this.denominator) || 1;
    this.numerator /= g;
    this.denominator /= g;
  }

  static fromString(s: string): Fraction {
    const idx = s.indexOf("/");
    if (idx < 0) return new Fraction(parseInt(s, 10));
    return new Fraction(
      parseInt(s.substring(0, idx), 10),
      parseInt(s.substring(idx + 1), 10),
    );
  }

  compareTo(other: Fraction): number {
    const mNum = this.numerator * other.denominator;
    const oNum = other.numerator * this.denominator;
    return mNum < oNum ? -1 : mNum > oNum ? 1 : 0;
  }

  toFloat(): number {
    return this.numerator / this.denominator;
  }
  toInt(): number {
    return Math.trunc(this.numerator / this.denominator);
  }

  plus(other: Fraction): Fraction {
    const mn = this.numerator * other.denominator;
    const md = other.numerator * this.denominator;
    return new Fraction(mn + md, this.denominator * other.denominator);
  }
  minus(other: Fraction): Fraction {
    const mn = this.numerator * other.denominator;
    const md = other.numerator * this.denominator;
    return new Fraction(mn - md, this.denominator * other.denominator);
  }
  times(other: Fraction): Fraction {
    return new Fraction(
      this.numerator * other.numerator,
      this.denominator * other.denominator,
    );
  }
  timesInt(other: number): Fraction {
    return new Fraction(this.numerator * other, this.denominator);
  }
  div(other: Fraction): Fraction {
    return new Fraction(
      this.numerator * other.denominator,
      this.denominator * other.numerator,
    );
  }
  divInt(other: number): Fraction {
    return new Fraction(this.numerator, this.denominator * other);
  }

  equals(other: Fraction | number): boolean {
    if (typeof other === "number") return this.compareTo(new Fraction(other)) === 0;
    return this.compareTo(other) === 0;
  }

  toString(): string {
    if (this.denominator === 1) return String(this.numerator);
    return `${this.numerator}/${this.denominator}`;
  }
}

export function toFraction(s: string): Fraction {
  return Fraction.fromString(s);
}
