// Ported from mp/common/skia.kt geometry helpers + org.jetbrains.skija Point/Rect/Matrix33.
// Skija value types are immutable: offset/inset/union return new instances.

export class Point {
  constructor(
    public x = 0,
    public y = 0,
  ) {}

  /** offset(dx, dy) or offset(p) -> new Point */
  offset(dx: number | Point, dy = 0): Point {
    if (dx instanceof Point) return new Point(this.x + dx.x, this.y + dx.y);
    return new Point(this.x + dx, this.y + dy);
  }

  rotate(cos: number, sin: number): Point {
    const nx = this.x * cos + this.y * sin;
    const ny = this.y * cos - this.x * sin;
    return new Point(nx, ny);
  }
}

export class Rect {
  constructor(
    public left = 0,
    public top = 0,
    public right = 0,
    public bottom = 0,
  ) {}

  static makeLTRB(l: number, t: number, r: number, b: number): Rect {
    return new Rect(l, t, r, b);
  }
  static makeWH(w: number, h: number): Rect {
    return new Rect(0, 0, w, h);
  }

  get width(): number {
    return this.right - this.left;
  }
  get height(): number {
    return this.bottom - this.top;
  }
  get isEmpty(): boolean {
    return this.left >= this.right || this.top >= this.bottom;
  }

  offset(dx: number, dy: number): Rect {
    return new Rect(this.left + dx, this.top + dy, this.right + dx, this.bottom + dy);
  }

  inset(x: number, y: number): Rect {
    return Rect.makeLTRB(this.left + x, this.top + y, this.right - x, this.bottom - y);
  }

  union(rr: Rect): Rect {
    if (this.isEmpty) return new Rect(rr.left, rr.top, rr.right, rr.bottom);
    return Rect.makeLTRB(
      Math.min(this.left, rr.left),
      Math.min(this.top, rr.top),
      Math.max(this.right, rr.right),
      Math.max(this.bottom, rr.bottom),
    );
  }

  contains(x: number, y: number): boolean {
    return x >= this.left && x < this.right && y >= this.top && y < this.bottom;
  }
}

// --- Matrix33: row-major 3x3, mirrors org.jetbrains.skija.Matrix33 ---
// indices: [scaleX skewX transX  skewY scaleY transY  persp0 persp1 persp2]
const M_SCALEX = 0,
  M_SKEWX = 1,
  M_TRANSX = 2,
  M_SKEWY = 3,
  M_SCALEY = 4,
  M_TRANSY = 5;

// affine 6-array order (kA*): [scaleX skewY skewX scaleY transX transY]
const A_SCALEX = 0,
  A_SKEWY = 1,
  A_SKEWX = 2,
  A_SCALEY = 3,
  A_TRANSX = 4,
  A_TRANSY = 5;

export class Matrix33 {
  mat: number[];

  constructor(mat?: number[]) {
    this.mat = mat ? mat.slice() : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }

  get translateX(): number {
    return this.mat[M_TRANSX];
  }
  set translateX(v: number) {
    this.mat[M_TRANSX] = v;
  }
  get translateY(): number {
    return this.mat[M_TRANSY];
  }
  set translateY(v: number) {
    this.mat[M_TRANSY] = v;
  }
  get scaleY(): number {
    return this.mat[M_SCALEY];
  }
  get skewX(): number {
    return this.mat[M_SKEWX];
  }
  get skewY(): number {
    return this.mat[M_SKEWY];
  }

  postTranslate(x: number, y: number): void {
    this.mat[M_TRANSX] += x;
    this.mat[M_TRANSY] += y;
  }

  setAffine(buffer: number[]): void {
    this.mat[M_SCALEX] = buffer[A_SCALEX];
    this.mat[M_SKEWX] = buffer[A_SKEWX];
    this.mat[M_TRANSX] = buffer[A_TRANSX];
    this.mat[M_SKEWY] = buffer[A_SKEWY];
    this.mat[M_SCALEY] = buffer[A_SCALEY];
    this.mat[M_TRANSY] = buffer[A_TRANSY];
    this.mat[6] = 0;
    this.mat[7] = 0;
    this.mat[8] = 1;
  }

  /** SVG transform="matrix(a b c d e f)" string (a c e / b d f). */
  toSvg(): string {
    const m = this.mat;
    return `matrix(${m[M_SCALEX]} ${m[M_SKEWY]} ${m[M_SKEWX]} ${m[M_SCALEY]} ${m[M_TRANSX]} ${m[M_TRANSY]})`;
  }

  /** Whether this matrix is identity (no transform needed). */
  get isIdentity(): boolean {
    const m = this.mat;
    return (
      m[0] === 1 &&
      m[1] === 0 &&
      m[2] === 0 &&
      m[3] === 0 &&
      m[4] === 1 &&
      m[5] === 0
    );
  }
}

export function newMatrix(): Matrix33 {
  return new Matrix33();
}

// Color helpers (Skija Color.makeARGB) - we keep ints, render as #rrggbb / rgba.
export class Colors {
  static readonly black = 0xff000000;
  static readonly blue = 0xff0000ff;
}

export function colorToCss(argb: number): string {
  const a = (argb >>> 24) & 0xff;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  if (a === 0xff) {
    return `rgb(${r},${g},${b})`;
  }
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}
