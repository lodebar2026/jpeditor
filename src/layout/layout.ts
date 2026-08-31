// Ported from mp/layout/layout.kt. Pure model + geometry; SVG emission lives in
// painter.ts. Skija Path/Canvas/Font replaced by GraphicPath command lists,
// the common geom types, and the Font abstraction (measurement via SVG/canvas).

import { Fraction } from "../common/fraction";
import { Point, Rect, Matrix33, newMatrix, Colors } from "../common/geom";
import { pathTightBounds } from "../common/measure";
import { LYRIC_SPLIT_PUNCT, type CompressMode } from "../common/cjkpunct";
import { Font } from "./font";
import { MetaData, GlyphCodes } from "../smufl/smufl";
import { chordTextSegs, layoutHarmonySegs } from "./harmony";
import * as S from "../score/score";

function getOrNull<T>(arr: T[], i: number): T | null {
  return i >= 0 && i < arr.length ? arr[i] : null;
}

export function pointRotate(p: Point, cos: number, sin: number): Point {
  return p.rotate(cos, sin);
}

// ---------------- PageItem hierarchy ----------------

export class PageItem {
  parent: PageItem | null = null;
  children: PageItem[] = [];
  _width = 0;
  _height = 0;
  matrix: Matrix33 = newMatrix();
  classes = new Set<string>();
  data: unknown = null;
  _selected = false;
  selectable = false;

  get selected(): boolean {
    return this._selected;
  }
  set selected(v: boolean) {
    this._selected = v;
  }

  get bound(): Rect {
    return new Rect(0, 0, this.width, this.height);
  }

  changeColor(clr: number): void {
    for (const it of this.children) it.changeColor(clr);
    if (this instanceof TextFrame) {
      this.color = clr;
    } else if (this instanceof GraphicLine) {
      this.strokeColor = clr;
    } else if (this instanceof GraphicPath) {
      if (this.stroke) this.strokeColor = clr;
      if (this.fill) this.fillColor = clr;
    }
  }

  pos(root: PageItem | null): Point {
    let loc = new Point(this.x, this.y);
    if (this.parent === root) return loc;
    const pp = this.parent!.pos(root);
    loc = loc.offset(pp);
    return loc;
  }

  get x(): number {
    return this.matrix.translateX;
  }
  set x(v: number) {
    this.matrix.translateX = v;
  }
  get y(): number {
    return this.matrix.translateY;
  }
  set y(v: number) {
    this.matrix.translateY = v;
  }
  get width(): number {
    return this._width;
  }
  set width(v: number) {
    this._width = v;
  }
  get height(): number {
    return this._height;
  }
  set height(v: number) {
    this._height = v;
  }

  get childrenBound(): Rect {
    let r = new Rect();
    for (const ch of this.children) {
      let rr = ch instanceof Group ? ch.childrenBound : ch.bound;
      rr = rr.offset(ch.x, ch.y);
      r = r.union(rr);
    }
    return r;
  }

  update(): void {
    let r = new Rect();
    for (const ch of this.children) {
      ch.update();
      let rr1 = ch.bound;
      rr1 = rr1.offset(ch.x, ch.y);
      r = r.union(rr1);
    }
    this.width = r.right;
    this.height = r.bottom;
  }

  add(pageItem: PageItem): void {
    this.children.push(pageItem);
    pageItem.parent = this;
  }
}

export type PathSeg = { op: "M" | "L" | "C" | "Z"; pts: number[] };

export class GraphicPath extends PageItem {
  segs: PathSeg[] = [];
  strokeWidth = 1;
  strokeColor = 0;
  fillColor = 0;
  stroke = false;
  fill = false;

  get d(): string {
    let s = "";
    for (const seg of this.segs) {
      if (seg.op === "Z") s += "Z";
      else s += `${seg.op}${seg.pts.join(" ")} `;
    }
    return s.trim();
  }

  override update(): void {
    const bnd = this.computeTightBounds();
    this.width = bnd.width;
    this.height = bnd.height;
    this.x += bnd.left;
    this.y += bnd.top;
    this.offset(-bnd.left, -bnd.top);
  }

  offset(dx: number, dy: number): void {
    for (const seg of this.segs) {
      for (let i = 0; i < seg.pts.length; i += 2) {
        seg.pts[i] += dx;
        seg.pts[i + 1] += dy;
      }
    }
  }
  moveTo(x: number | Point, y = 0): void {
    if (x instanceof Point) this.segs.push({ op: "M", pts: [x.x, x.y] });
    else this.segs.push({ op: "M", pts: [x, y] });
  }
  lineTo(x: number | Point, y = 0): void {
    if (x instanceof Point) this.segs.push({ op: "L", pts: [x.x, x.y] });
    else this.segs.push({ op: "L", pts: [x, y] });
  }
  cubicTo(p1: Point, p2: Point, p3: Point): void;
  cubicTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
  cubicTo(
    a: number | Point,
    b?: number | Point,
    c?: number | Point,
    d?: number,
    e?: number,
    f?: number,
  ): void {
    if (a instanceof Point) {
      const p1 = a, p2 = b as Point, p3 = c as Point;
      this.segs.push({ op: "C", pts: [p1.x, p1.y, p2.x, p2.y, p3.x, p3.y] });
    } else {
      this.segs.push({ op: "C", pts: [a, b as number, c as number, d!, e!, f!] });
    }
  }
  computeTightBounds(): Rect {
    if (this.segs.length === 0) return new Rect();
    return pathTightBounds(this.d);
  }
  close(): void {
    this.segs.push({ op: "Z", pts: [] });
  }
}

export class Group extends PageItem {
  get minY(): number | null {
    if (this.children.length === 0) return null;
    return this.children.reduce((m, c) => (c.y < m.y ? c : m)).y;
  }
  get minX(): number | null {
    if (this.children.length === 0) return null;
    return this.children.reduce((m, c) => (c.x < m.x ? c : m)).x;
  }
  get maxX(): number | null {
    if (this.children.length === 0) return null;
    const it = this.children.reduce((m, c) => (c.x + c.width > m.x + m.width ? c : m));
    return it.x + it.width;
  }
  get maxY(): number | null {
    if (this.children.length === 0) return null;
    const it = this.children.reduce((m, c) => (c.y + c.height > m.y + m.height ? c : m));
    return it.y + it.height;
  }

  normalizeX(): void {
    if (this.children.length === 0) return;
    const mx = this.minX!;
    for (const it of this.children) it.x -= mx;
    this.x += mx;
  }
  normalizeY(): void {
    if (this.children.length === 0) return;
    const mx = this.minY!;
    for (const it of this.children) it.y -= mx;
    this.y += mx;
  }

  override update(): void {
    for (const it of this.children) it.update();
    const bnd = this.childrenBound;
    for (const it of this.children) {
      it.x -= bnd.left;
      it.y -= bnd.top;
    }
    this.x += bnd.left;
    this.y += bnd.top;
    this.width = bnd.width;
    this.height = bnd.height;
  }
}

export class TextFrame extends PageItem {
  text = "";
  color = Colors.black;
  font!: Font;
  previous: TextFrame | null = null;
  next: TextFrame | null = null;
  /** 用**紧包围盒**而不是字体的全局 ascent/descent 来算 bound。
   *  给 SMuFL 那类字体用：Bravura 的 ascent−descent 是 4.02 em，一个和弦里夹一个升号，
   *  这一行就凭空高出四个字号——行距全乱。SmuflText 自己重写了 bound，
   *  但 layout/harmony.ts 里的音乐段是普通 TextFrame，靠这个开关。 */
  inkBound = false;
  /** 逐字笔位（相对本 item 的 x，按码点）。null = 连排，由字体的 advance 说了算。
   *  标点挤压后的歌词用它——测量与绘制拿同一串坐标，`<text>` 的 `x` 直接吃它，
   *  绝不在渲染端再叠 font-feature-settings（会挤两遍）。见 common/measure.ts。 */
  charXs: number[] | null = null;

  measureText(beg = 0, len = -1): number {
    const str = len < 0 ? this.text.substring(beg) : this.text.substring(beg, beg + len);
    return this.font.measureText(str);
  }

  override get bound(): Rect {
    if (this.inkBound) {
      const b = this.font.charBound(this.text);
      return new Rect(0, Math.min(b.top, 0), this.width, Math.max(b.bottom, 0));
    }
    const fm = this.font.metrics;
    return new Rect(0, fm.ascent, this.width, fm.descent);
  }

  override update(): void {
    this.width = this.measureText();
    this.height = this.font.size;
  }
}

export class GraphicLine extends PageItem {
  p0 = new Point();
  p1 = new Point();
  strokeWidth = 1;
  strokeColor = 0;

  override update(): void {
    this.y += this.p0.y;
    this.x += this.p0.x;
    this.p1 = this.p1.offset(-this.p0.x, -this.p0.y);
    this.p0 = new Point(0, 0);
    this.width = Math.abs(this.p1.x);
    this.height = Math.abs(this.p1.y);
    if (this.p0.x === this.p1.x) this.width = this.strokeWidth;
    if (this.p0.y === this.p1.y) this.height = this.strokeWidth;
  }
}

export class SmuflText extends TextFrame {
  asPath = false;
  meta: MetaData;
  constructor(options: LayoutOptions) {
    super();
    this.meta = options.smuflMeta;
    this.font = options.smuflFont;
  }
  override get bound(): Rect {
    const first = this.text[0];
    const box = this.meta.getBBox(first);
    if (!box) throw new Error("no smufl bbox");
    const dy1 = (box.bBoxNE[1] * this.font.size) / 4;
    const dy2 = (box.bBoxSW[1] * this.font.size) / 4;
    const l = (box.bBoxSW[0] * this.font.size) / 4;
    const r = (box.bBoxNE[0] * this.font.size) / 4;
    return new Rect(l, dy2, r, dy1);
  }
}

export class JpOctaveDot extends TextFrame {
  constructor() {
    super();
    this.text = ".";
    this.selectable = true;
  }
  override get bound(): Rect {
    const bnd = LayoutOptions.charBound(this.font, this.text[0]);
    return new Rect(0, bnd.top, this.width, bnd.bottom);
  }
}

export class JpNumber extends TextFrame {
  constructor() {
    super();
    this.selectable = true;
  }
  get left(): number {
    return this.measureText(0, 1) / 2;
  }
  get right(): number {
    return this.measureText(0, 1) / 2 + this.measureText(1);
  }
  /**
   * Anchor for decorations that must look centred on the digit: octave dots,
   * slur/tie ends, tuplet brackets. Uses the *ink* centre, not advance/2 —
   * PingFang SC's "1" is a narrow proportional glyph sitting 3.1% of an em
   * left of its advance centre, which is visible as an off-centre octave dot.
   * (musicpp render.cpp:906 and the Kotlin original both use advance/2 here
   * and carry the same offset; FreeType/Skija gave them no ink bounds on that
   * path, whereas the browser hands us actualBoundingBoxLeft/Right for free.)
   * Horizontal spacing goes through `width`/`left`/`right`, never `cx`, so
   * this does not move the notes themselves.
   */
  get cx(): number {
    return this.font.inkCenter(this.text[0]);
  }
  get numberPos(): number {
    let end = this.text.length;
    if (this.text.endsWith("·")) end--;
    return this.measureText(0, end);
  }
  override get bound(): Rect {
    const bnd = LayoutOptions.charBound(this.font, this.text[0]);
    return new Rect(0, bnd.top, this.width, bnd.bottom);
  }
}

export class Lyric extends TextFrame {
  _widths = [0, 0, 0];
  /** 标点挤压的档（`LayoutOptions.punctCompress`）。 */
  compress: CompressMode = "halfwidth";
  constructor() {
    super();
    this.selectable = true;
  }
  /** 开头那串标点的宽度（`“凡` 的引号）。避让时可以悬挂出去，见 calcXPos。 */
  get leadWidth(): number {
    return this._widths[0];
  }
  get left(): number {
    return this._widths[0] + this._widths[1] / 2;
  }
  get right(): number {
    return this._widths[1] / 2 + this._widths[2];
  }
  /** 末字右侧的留白（advance 减墨迹）。相邻两条歌词能挤多近由它和下一条的左留白决定。 */
  get tailBlank(): number {
    const t = this.text;
    if (!t) return 0;
    const chars = [...t];
    const last = chars[chars.length - 1];
    // 末字的落笔点按**挤压后**的笔位算（charXs 是 update 时量的，与绘制同一串坐标）
    const upto = this.charXs ? this.charXs[chars.length - 1] : this.measureText(0, t.length - last.length);
    return Math.max(0, this.width - (upto + LayoutOptions.charBound(this.font, last).right));
  }
  /** 首字左侧的留白（墨迹离本条歌词的落笔点多远）。`“` 这种标点的墨只占方框右半边。
   *  **要从挤压后的笔位起算**：半角档下前引号的笔位已经左挪了半格（墨正好落在格内左半），
   *  照字形的 inkLeft 算就把这半格又算了一遍，避让时凭空多出半格空档，
   *  上一个字的尾标点就被压住了（076「说：」压「“忠」、159 两处、376「召：」压「“将」）。 */
  get headBlank(): number {
    const t = this.text;
    if (!t) return 0;
    const pen = this.charXs?.[0] ?? 0;
    return Math.max(0, pen + LayoutOptions.charBound(this.font, [...t][0]).left);
  }
  override update(): void {
    // 切成「左标点 / 主体 / 右标点」三段。表在 common/cjkpunct.ts（含数字与半角冒号的
    // 缘由写在那里）。**按码点切**，索引就是 `run()` 里 xs 的索引。
    const chars = [...this.text];
    let nl = 0, nc = chars.length;
    if (chars.length > 1) {
      const punct = LYRIC_SPLIT_PUNCT;
      let pos = 0;
      while (pos < chars.length && punct.includes(chars[pos])) pos++;
      nl = pos;
      while (pos < chars.length && !punct.includes(chars[pos])) pos++;
      nc = pos - nl;
    }
    // 宽度取**挤压后**的笔位（`召：` 的冒号右半格、`“凡` 的引号左半格在这里就压掉了）。
    // 三段宽按落笔点划分，段与段之间的挤压自然落在它该在的那一段里。
    const { xs, width } = this.compress !== "none"
      ? this.font.run(this.text, this.compress)
      : { xs: chars.map((_, i) => this.font.measureText(chars.slice(0, i).join(""))), width: this.measureText() };
    this.charXs = this.compress !== "none" && xs.length > 1 ? xs : null;
    const at = (i: number): number => (i <= 0 ? 0 : i >= xs.length ? width : xs[i]);
    this._widths[0] = at(nl);
    this._widths[1] = at(nl + nc) - at(nl);
    this._widths[2] = width - at(nl + nc);
    this.width = width;
    this.height = this.font.size;
  }
}

/** 弧线（圆滑线 / 连音线）的样式参数。位置参数太多不可读，统一走这个对象。 */
export interface SlurStyle {
  /** 月牙形的最大厚度（musicpp 的 `lw0`），也是扁平式线宽的折算基准。 */
  thickness: number;
  color: number;
  /** 整条弧随字号缩放（成书排版用小字号，绝对像素会显得过高）。默认 1。 */
  heightScale?: number;
  /** 细描边的线宽。默认 0.7。 */
  outlineWidth?: number;
  /** 弧高上限，**未乘 `heightScale` 的原始像素口径**。<=0 或省略 = 不封顶。 */
  maxHeight?: number;
  /** 弧高下限，同样是未乘 `heightScale` 的原始像素口径。<=0 或省略 = 只用公式自带的 1.2。 */
  minHeight?: number;
  /** 跨度超过它就改画扁平长连音线。<=0 或省略 = 一律画弧。 */
  flatSpan?: number;
  /** 扁平式**中段**的墨迹厚度（两端一样收尖）。省略 = `thickness * 0.45`。 */
  flatLineWidth?: number;
}

export abstract class SlurTieBase extends Group {
  /**
   * 弧高（正数，实际画的时候取负——简谱的弧一律在音符上方、开口朝下）。
   * **这是弧高的唯一算法**：谱面排版、成书重排、文本谱的绘制与纵向预留全走它。
   *
   * musicpp 的公式（按 jianpuFont≈28 调的绝对像素）在**短弧**上会算出负值
   * ——dist < 10^(16/17) ≈ 8.7pt 时 h 变正，弧就翻过来开口朝上了，所以钳住下限。
   *
   * 上限是本项目加的（musicpp / 原 Kotlin 都没有）：对数虽然涨得慢却**没有上限**，
   * 28px 字号下典型跨度（3 个音符步距，dist≈90）弧高 17px，整行的长弧（dist≈600）
   * 冲到 31px，将近两倍——顶到上方的和弦符号上。参考 open-fanqie
   * （renderer.ts:703，弧高恒定 10px 与跨度无关）封顶，短弧的手感一点不变。
   */
  static arcHeight(dist: number, o: Pick<SlurStyle, "heightScale" | "maxHeight" | "minHeight"> = {}): number {
    const floor = o.minHeight !== undefined && o.minHeight > 0 ? o.minHeight : 1.2;
    const raw = Math.max(Math.log10(Math.max(dist, 1e-6)) * 17 - 16, floor);
    const cap = o.maxHeight !== undefined && o.maxHeight > 0 ? Math.max(o.maxHeight, floor) : Infinity;
    return Math.min(raw, cap) * (o.heightScale ?? 1);
  }

  static calcSlurPoints(pl: Point, pr: Point, o: Pick<SlurStyle, "heightScale" | "maxHeight" | "minHeight"> = {}): [Point, Point, number] {
    const xr = pr.x, xl = pl.x, yr = pr.y, yl = pl.y;
    const dx = xr - xl, dy = yr - yl;
    const square = dx * dx + dy * dy;
    const dist = Math.sqrt(square);
    const theta = Math.atan2(dy, dx);
    const cos = Math.cos(-theta);
    const sin = Math.sin(-theta);
    const xlen = Math.min(dist * 0.04 + 10, dist * 0.25);
    const h = -SlurTieBase.arcHeight(dist, o);
    let p1 = new Point(xlen, h).rotate(cos, sin);
    let p2 = new Point(dist - xlen, h).rotate(cos, sin);
    p1 = p1.offset(xl, yl);
    p2 = p2.offset(xl, yl);
    return [p1, p2, cos];
  }

  init(pl: Point, pr: Point, style: SlurStyle): void {
    const dx = pr.x - pl.x, dy = pr.y - pl.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (style.flatSpan !== undefined && style.flatSpan > 0 && dist > style.flatSpan) {
      this.initFlat(pl, pr, dist, style);
      return;
    }
    this.initArc(pl, pr, style);
  }

  private initArc(pl: Point, pr: Point, style: SlurStyle): void {
    const [pt0, pt1, cos] = SlurTieBase.calcSlurPoints(pl, pr, style);
    const clr = style.color;
    const lw0 = style.thickness / cos;

    // musicpp drawSlurTied (render.cpp:1078-1104): a filled crescent — out
    // along the curve, back with both control points pushed *down* by lw0/2 so
    // the shape is thick in the middle and pointed at both ends — plus a thin
    // outline stroked along a curve offset by lw0/4.
    // (The earlier port pushed pt0 along x instead of y, which flattened the
    // left end and made the arc visibly lopsided.)
    const obj = new GraphicPath();
    obj.fill = true;
    obj.stroke = false;
    obj.fillColor = clr;
    obj.moveTo(pl);
    obj.cubicTo(pt0, pt1, pr);
    obj.cubicTo(pt1.offset(0, lw0 / 2), pt0.offset(0, lw0 / 2), pl);
    obj.close();

    const outline = new GraphicPath();
    outline.fill = false;
    outline.stroke = true;
    outline.strokeWidth = style.outlineWidth ?? 0.7;
    outline.strokeColor = clr;
    outline.moveTo(pl);
    outline.cubicTo(pt0.offset(0, lw0 / 4), pt1.offset(0, lw0 / 4), pr);

    this.finish([obj, outline]);
  }

  /**
   * 超长跨度的扁平长连音线：两端各一小段钩弧，中间一条水平细线。
   *
   * 照 open-fanqie（renderer.ts:690-700，`slurStyle: auto` 下跨度 > 100px 就改这个
   * 画法，用 `lianyinxian_zuo`/`lianyinxian_you` 两个钩字形 + `stroke-width 1.2` 的直线）。
   * 本项目没有那两个字形，钩自己用贝塞尔画。
   *
   * 高度取**阈值处那条弧的弧顶**（`arcHeight(flatSpan) * 0.75`——贝塞尔的弧顶约为控制点
   * 高的 0.75），所以跨度跨过阈值的一刻高度连续，同一页里弧形与扁平并存也不会一高一低。
   */
  private initFlat(pl: Point, pr: Point, dist: number, style: SlurStyle): void {
    const h = SlurTieBase.arcHeight(style.flatSpan!, style) * 0.75;
    // 钩的水平长度：短了会显得两端急折，长了中段的直线就没了。h 的 2.5 倍最耐看。
    const hx = Math.min(dist * 0.12, h * 2.5);
    const t = style.flatLineWidth !== undefined && style.flatLineWidth > 0
      ? style.flatLineWidth
      : style.thickness * 0.45;
    const clr = style.color;

    // 与弧形同一套形状语言：**填充的月牙**，中段厚 t、两端收到端点上成尖角
    // （去程画上缘、回程沿同一条形状下压 t 画回来，两端共用 pl/pr 所以天然是尖的）。
    // 早先这里是一条等宽描边线，两端齐头齐脑，跟满页的月牙弧摆在一起很扎眼。
    const obj = new GraphicPath();
    obj.fill = true;
    obj.stroke = false;
    obj.fillColor = clr;
    this.flatEdge(obj, pl, pr, hx, h, 0, false);
    this.flatEdge(obj, pl, pr, hx, h, t, true);
    obj.close();

    this.finish([obj]);
  }

  /**
   * 扁平连音线的一条边：`down` = 回程（从右往左、整体下压 `dy`）。
   * 钩子在端点处陡、接上平线处水平：控制点一个贴端点抬起、一个落在平线上。
   */
  private flatEdge(p: GraphicPath, pl: Point, pr: Point, hx: number, h: number, dy: number, down: boolean): void {
    const topL = pl.y - h + dy, topR = pr.y - h + dy;
    if (!down) {
      p.moveTo(pl);
      p.cubicTo(new Point(pl.x + hx * 0.15, pl.y - h * 0.55), new Point(pl.x + hx * 0.45, topL), new Point(pl.x + hx, topL));
      p.lineTo(new Point(pr.x - hx, topR));
      p.cubicTo(new Point(pr.x - hx * 0.45, topR), new Point(pr.x - hx * 0.15, pr.y - h * 0.55), pr);
    } else {
      p.cubicTo(new Point(pr.x - hx * 0.15, pr.y - h * 0.55 + dy), new Point(pr.x - hx * 0.45, topR), new Point(pr.x - hx, topR));
      p.lineTo(new Point(pl.x + hx, topL));
      p.cubicTo(new Point(pl.x + hx * 0.45, topL), new Point(pl.x + hx * 0.15, pl.y - h * 0.55 + dy), pl);
    }
  }

  /** 把画好的路径挪到自身坐标系原点，并把包围盒记到 x/y/width/height 上。 */
  private finish(paths: GraphicPath[]): void {
    let box = paths[0].computeTightBounds();
    for (const p of paths.slice(1)) box = box.union(p.computeTightBounds());
    for (const p of paths) {
      p.offset(-box.left, -box.top);
      p.x = 0;
      p.y = 0;
      p.width = box.width;
      p.height = box.height;
      this.add(p);
    }
    this.x = box.left;
    this.y = box.top;
    this.width = box.width;
    this.height = box.height;
  }
}
export class Tie extends SlurTieBase {}
export class Slur extends SlurTieBase {}

/** LayoutOptions → SlurStyle。谱面这一路的弧全由它配参数，别在调用点各配各的。 */
export function slurStyleOf(opt: LayoutOptions): SlurStyle {
  return {
    thickness: opt.slurTieThickness,
    color: opt.color,
    heightScale: opt.slurHeightScale,
    outlineWidth: opt.slurOutlineWidth,
    maxHeight: opt.slurMaxHeight,
    minHeight: opt.slurMinHeight,
    flatSpan: opt.slurFlatSpan < 0 ? 0 : opt.slurFlatSpan || opt.numberSize * 5,
    flatLineWidth: opt.slurFlatWidth,
  };
}

// ---------------- Entry hierarchy ----------------

export abstract class Entry {
  group = new Group();
  selected = false;
  line!: Line;
  constructor() {
    this.group.classes.add("entry");
  }
  update(): void {
    this.group.update();
  }
  abstract entryItem(): PageItem | null;
  entryWidth(): number {
    return this.entryItem()?.width ?? 0;
  }
}

export class KeySig extends Entry {
  /** 转调标记那个文本框。`liftOverChords` 要按它的墨迹框判避让，故留住引用。 */
  readonly label: TextFrame;
  constructor(key: S.Key, opt: LayoutOptions) {
    super();
    const names = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
    const name = names[key.fifths + 7];
    const tf = new TextFrame();
    tf.classes.add("key-change"); // 见 browser.ts::roleOfItem —— line-check 的 L12 靠它认
    tf.color = opt.color;
    tf.y = -opt.numberSize;
    tf.text = `转1=${name}`;
    tf.font = opt.lrcFont.scaled(0.6);
    const w = tf.measureText();
    tf.x = -w / 2;
    // `liftKeySigOverChords` 要按 width/bound 判避让，这里就把尺寸算出来
    //（`Line.load` 之后到 `group.update()` 之间还隔着好几步）。
    tf.update();
    this.label = tf;
    this.group.add(tf);
    this.group.data = this;
  }
  entryItem(): PageItem | null {
    return null;
  }
  override entryWidth(): number {
    return 0;
  }
}

export class TimeSig extends Entry {
  hline!: GraphicLine;
  width = 0;
  beats: number;
  beatType: number;
  constructor(beats: number, beatType: number, opt: LayoutOptions) {
    super();
    this.beats = beats;
    this.beatType = beatType;
    this.layout(opt);
    this.group.data = this;
  }
  static fromTime(t: S.Time, opt: LayoutOptions): TimeSig {
    return new TimeSig(t.beats, t.beatType, opt);
  }
  entryItem(): PageItem | null {
    return this.hline;
  }
  override entryWidth(): number {
    return this.width;
  }
  layout(opt: LayoutOptions): void {
    const top = opt.jpStaffTop;
    const bot = opt.jpStaffBottom;
    const cy = (bot + top) / 2;
    const font = opt.numberFont.withBold().makeWithSize(opt.numberSize * 0.75);
    const tf1 = new TextFrame();
    tf1.color = opt.color;
    tf1.font = font;
    tf1.text = String(this.beats);
    const w1 = tf1.measureText();
    const tf2 = new TextFrame();
    tf2.font = font;
    tf2.color = opt.color;
    tf2.text = String(this.beatType);
    const w2 = tf2.measureText();
    this.width = Math.max(w1, w2);
    const ln = new GraphicLine();
    // 分数线的粗细：原书量到的才 0.3pt（比小节线 1.0 还细一半多），
    // 引擎默认的 1.5 是按屏幕上 fontSize≈28 调的，缩到成书字号就成了一道黑杠。
    ln.strokeWidth = opt.timeSigRuleWidth > 0 ? opt.timeSigRuleWidth : 1.5;
    ln.strokeColor = opt.color;
    const y = cy - ln.strokeWidth / 2;
    ln.p0 = new Point(0, y);
    ln.p1 = new Point(this.width, y);
    tf1.y = y - opt.numberSize * 0.1;
    tf1.x = (this.width - w1) / 2;
    tf2.y = y + opt.numberSize * 0.625;
    tf2.x = (this.width - w2) / 2;
    this.hline = ln;
    this.group.add(tf1);
    this.group.add(tf2);
    this.group.add(ln);
  }
}

export class NoteEntry extends Entry {
  chord!: S.Chord;
  verse = 0; // repeat pass / lyric verse this rendered entry belongs to
  lrc: Lyric | null = null;
  /** 叠排时这个音符底下的各段歌词（lrc 是其中第一段，供既有的宽度/链表逻辑用）。 */
  lrcs: Lyric[] = [];
  number: JpNumber | null = null;
  accidental: TextFrame | null = null;
  beams = 0;
  octaveDot: JpOctaveDot[] = [];
  notations: SmuflText[] = [];

  constructor() {
    super();
    this.group.data = this;
  }
  get jpOctave(): number {
    return this.chord.notes[0].jpOctave;
  }
  get numberPos(): number {
    return this.number!.numberPos;
  }
  /** 和弦符号：排在音符正上方（以数字墨迹中心对齐）。
   *  富文本分段（根音升降号走 SMuFL、后缀上标）复用 layout/harmony.ts，与五线谱、文本谱同一套。 */
  static addHarmony(ch: S.Chord, opt: LayoutOptions, ent: NoteEntry, num: JpNumber): void {
    if (!ch.harmony || opt.chordSize <= 0) return;
    const wordFont = opt.numberFont.makeWithSize(opt.chordSize);
    const musicFont = opt.smuflFont.makeWithSize(opt.chordSize);
    const g = layoutHarmonySegs(chordTextSegs(ch.harmony), wordFont, musicFont, opt.color);
    g.classes.add("chord-group"); // 段落词要按它的位置让路，见 Line.addSectionWords
    g.update();
    g.x = num.x + num.cx - g.width / 2;
    // 挂在这个音符**已有内容的栈顶**之上（八度点已经加过了），不是固定高度——
    // 否则带高音点的音符上，和弦会压到点上。原书的 chordGap 就是量的这个净距。
    //
    // 和弦一律**按基线对齐**（同一行的和弦要齐平），不能按墨迹顶或底摆：
    // 带升降号的那些用 Bravura 的 csym 字形，em 框比字母高得多，按墨迹摆会比邻近的
    // 和弦高出十来个点。`g.update()` 之后 `g.y` 正好是「墨迹顶相对基线」的偏移，
    // 所以这里**累加**目标基线，而不是赋值。
    // 基准是音符的**墨迹顶**，不是 -numberSize（那是字号，Times 的数字墨迹只占 0.66em，
    // 拿字号当墨迹顶会把和弦白白多抬三四个点）。原书量的 chordToNote 也是
    // 「音符墨迹顶 − 和弦基线」（stats.ts: noteTop − baselineY），两边口径必须一致。
    const inkTop = opt.numberBound("1").top;
    const top = Math.min(inkTop, ent.group.childrenBound.top);
    g.y += top - opt.chordGap;
    ent.group.add(g);
  }

  addAccidental(tf: TextFrame): void {
    this.accidental = tf;
    this.group.add(tf);
  }
  add(item: JpNumber | Lyric): void {
    if (item instanceof JpNumber) {
      this.number = item;
      this.group.add(item);
    } else {
      if (this.lrc === null) this.lrc = item;
      this.lrcs.push(item);
      this.group.add(item);
    }
  }
  get left(): number {
    return this.number !== null ? this.number.left : 0;
  }
  get cx(): number {
    return this.number!.x + this.number!.cx;
  }
  get right(): number {
    return this.number?.right ?? 0;
  }
  entryItem(): TextFrame | null {
    return this.number;
  }
  get beginOfSlurTied(): boolean {
    if (this.chord.slurStart) return true;
    if (this.chord.notes[0].tieStart) return true;
    return false;
  }
  get endOfSlurTied(): boolean {
    if (this.chord.slurEnd) return true;
    if (this.chord.notes[0].tieEnd) return true;
    return false;
  }
  /** Ink top of the digit plus whatever octave dots sit above it — i.e. the
   * top of the shared vertical ladder, which slurs/ties then continue. */
  entryTop(opt: LayoutOptions): number {
    const oct = this.chord.notes[0].jpOctave;
    const bnd = opt.numberBound("1");
    if (oct <= 0) return bnd.top;
    return bnd.top - oct * opt.jpDotRung;
  }
  /** Where a slur/tie sits: one `jpStackGap` above whatever the note already
   * stacks — the same gap that separates the digit from its first octave dot,
   * and one dot from the next. */
  slurRung(opt: LayoutOptions): number {
    return this.entryTop(opt) - opt.jpStackGap;
  }
  /** Mirror of entryTop below the baseline (low octave dots clear the beams). */
  entryBottom(options: LayoutOptions): number {
    const oct = this.chord.notes[0].jpOctave;
    const bnd = options.numberBound("1");
    const beamBottom = options.jpBeamBottom(this.chord.beams);
    if (oct >= 0) return beamBottom;
    const above = Math.max(bnd.bottom, beamBottom);
    const dotBnd = options.numberBound(".");
    return above + options.jpStackGap + (-oct - 1) * options.jpDotRung + dotBnd.height;
  }

  static addAccidental(it: JpNumber, options: LayoutOptions, ch: S.Chord, ent: NoteEntry): void {
    const alt = ch.notes[0].jpAlter;
    if (alt !== " ") {
      const tf = new SmuflText(options);
      tf.color = options.color;
      if (options.smuflAsPath) tf.asPath = true;
      let smufl: string;
      switch (alt) {
        case "b": smufl = GlyphCodes.accidentalFlat; break;
        case "#": smufl = GlyphCodes.accidentalSharp; break;
        case "n": smufl = GlyphCodes.accidentalNatural; break;
        default: throw new Error("");
      }
      const yOffset = alt === "b" ? 0.1 : 0; // 简谱中降号下移
      tf.text = smufl;
      const kernMap: Record<string, number> = { "4": 0.1, "2": -0.07, "1": -0.07 };
      let xx = -tf.font.size * 0.2;
      xx += (kernMap[it.text[0]] ?? 0) * tf.font.size;
      const numBnd = options.numberBound("1");
      let yy = numBnd.top;
      yy += options.smuflFont.size * yOffset;
      const sc = 0.8;
      tf.matrix.setAffine([sc, 0, 0, sc, xx * sc, yy]);
      ent.addAccidental(tf);
    }
  }
  /**
   * Octave dots stack outward from the digit on the shared vertical ladder
   * (see LayoutOptions.jpStackGap / jpDotRung). Row `d` = 0 is the row
   * nearest the digit, so `entryTop`/`slurTop` can simply continue the same
   * ladder at row `oct`.
   *
   * NB musicpp does the opposite — it pins the *outermost* dot at a fixed y
   * and fills back down toward the digit (render.cpp:906, `octY + i*dotDist`
   * with octY independent of the dot count), which is not how jianpu is
   * normally engraved.
   */
  static octaveDot(ch: S.Chord, options: LayoutOptions, ent: NoteEntry): void {
    const oct = ch.notes[0].jpOctave;
    const numBound = options.numberBound("1");
    for (let d = 0; d < Math.abs(oct); d++) {
      const tf = new JpOctaveDot();
      tf.font = options.numberFont;
      tf.color = options.color;
      // Ladder positions are ink-to-ink, so convert to a text baseline by
      // backing off the dot glyph's own ink offset (a "." sits above its
      // baseline, so the two sides need different corrections).
      const dotBound = options.numberBound(".");
      if (oct >= 0) {
        const inkBottom = numBound.top - options.jpStackGap - d * options.jpDotRung;
        tf.y = inkBottom - dotBound.bottom;
      } else {
        const above = Math.max(numBound.bottom, options.jpBeamBottom(ch.beams));
        const inkTop = above + options.jpStackGap + d * options.jpDotRung;
        tf.y = inkTop - dotBound.top;
      }
      ent.group.add(tf);
      ent.octaveDot.push(tf);
    }
  }
  static addLyric(ch: S.Chord, options: LayoutOptions, ent: NoteEntry, it: JpNumber, lrc: number): void {
    // 叠排：这个音符底下把各段歌词一行行摞起来（原书的排法）。段序按 lyric.number。
    const stack = options.lyricStack > 0;
    const all = stack
      ? [...ch.notes[0].lyrics].sort((a, b) => a.number - b.number)
      : ch.notes[0].lyrics;
    let row = 0;
    for (const l of all) {
      if (!stack && !l.refrain) {
        if (l.number !== lrc) continue;
      }
      let text = l.text;
      if (options.ignoreVerseNumber) {
        for (let idx = 0; idx < l.text.length; idx++) {
          const _ch = l.text[idx];
          if ((_ch >= "0" && _ch <= "9") || _ch === ".") {
            // skip leading verse number/dot
          } else {
            text = l.text.substring(idx);
            break;
          }
        }
      }
      const lit = new Lyric();
      lit.font = options.lrcFont;
      lit.y = 1.0 * options.numberFont.size + (stack ? row * options.lyricStack : 0);
      row++;
      lit.compress = options.punctCompress;
      lit.text = text;
      lit.color = options.color;
      lit.update();
      lit.x = it.left - lit.left;
      ent.add(lit);
    }
  }
  static addNotations(ch: S.Chord, options: LayoutOptions, ent: NoteEntry): void {
    if (ch.fermata) {
      const t = new SmuflText(options);
      t.color = options.color;
      t.text = GlyphCodes.fermataAbove;
      // Same ladder as the octave dots / slur (musicpp render.cpp:349-355 uses
      // `y -= dot*7` plus a flat -10 over a slur; both collapse to one rung).
      t.y = ent.slurRung(options);
      const hasSlurTied = ent.beginOfSlurTied || ent.endOfSlurTied;
      if (hasSlurTied) t.y -= options.jpDotRung;
      t.x += ent.number!.x + ent.number!.cx;
      t.x -= t.bound.width / 2;
      ent.group.add(t);
      ent.notations.push(t);
    }
  }
  static fromChord(res: Entry[], ch: S.Chord, lrc: number, options: LayoutOptions): void {
    let ent = new NoteEntry();
    ent.beams = ch.beams;
    ent.chord = ch;
    ent.verse = lrc;
    let it = new JpNumber();
    it.color = options.color;
    it.text = ch.notes[0].number;
    it.font = options.numberFont;
    ent.add(it);
    NoteEntry.addAccidental(it, options, ch, ent);
    if (ch.beats <= 1) {
      for (let d = 0; d < ch.dot; d++) it.text += "·";
    }
    NoteEntry.octaveDot(ch, options, ent);
    NoteEntry.addLyric(ch, options, ent, it, lrc);
    NoteEntry.addNotations(ch, options, ent);
    NoteEntry.addHarmony(ch, options, ent, it);
    ent.update();
    res.push(ent);
    for (let i = 1; i < ch.beats; i++) {
      ent = new NoteEntry();
      ent.chord = ch;
      ent.verse = lrc;
      const num = ch.rest ? "0" : "-";
      it = new JpNumber();
      it.text = num;
      it.color = options.color;
      it.font = options.numberFont;
      ent.add(it);
      ent.update();
      res.push(ent);
    }
  }
}

/** 小节线的样子：粗细组合 + 反复点。与五线谱同一套画法（`‖:` 点在右、`:‖` 点在左）。 */
export interface BarlineSpec {
  /** MusicXML 的 bar-style。null = 普通细线。 */
  style?: S.BarStyle | null;
  /** `:‖`（反复回到前面）——两点画在左侧。 */
  repeatBackward?: boolean;
  /** `‖:`（反复段起点）——两点画在右侧。 */
  repeatForward?: boolean;
}

export class Barline extends Entry {
  /** The vertical strokes, kept so `clipBarlinesUnderSlurs` can shorten them. */
  readonly lines: GraphicLine[] = [];
  /** 是不是「一条普通细线」（没有反复点、没有粗线）——`‖:` 会把紧挨着的这种吃掉。 */
  isPlain = false;
  readonly defaultTop: number;
  private readonly bot: number;

  /** 建这条线时用的 spec（`dropDoubledBarlines` 要拿它判断能不能把两条并成一条）。 */
  readonly spec: BarlineSpec;

  constructor(final: boolean, opt: LayoutOptions, spec: BarlineSpec = {}) {
    super();
    this.spec = spec;
    this.group.data = this;
    const top = opt.jpStaffTop;
    const bot = opt.jpStaffBottom;
    this.defaultTop = top;
    this.bot = bot;
    const heavyWidth = opt.finalBarlineWidth;
    const light = opt.barlineWidth; // musicpp lineWidths.lightBarline (pptutil.cpp:139)
    const res = this.group;
    // 粗细组合按 bar-style 来（五线谱怎么画，简谱就怎么画）：
    // 终止线 `light-heavy` 细+粗、反复起点 `heavy-light` 粗+细、`light-light` 双细线。
    // repeatForward/Backward 自带隐含样式：谱上没标 bar-style 也要画成粗细组合。
    const st = spec.style ?? null;
    let widths: number[];
    // **前后反复背靠背**（`:‖:`）：上一小节收尾的 `:‖` 与本小节起头的 `‖:` 合成一条，
    // 五线谱的画法是「细 粗 细」+ 两侧各两点，而不是两根粗线并排
    // （`dropDoubledBarlines` 把它们并起来后才会走到这里）。
    if (spec.repeatBackward && spec.repeatForward) widths = [light, heavyWidth, light];
    else if (st === S.BarStyle.LIGHT_HEAVY || (final && !spec.repeatForward)) widths = [light, heavyWidth];
    else if (st === S.BarStyle.HEAVY_LIGHT || spec.repeatForward) widths = [heavyWidth, light];
    else if (st === S.BarStyle.LIGHT_LIGHT) widths = [light, light];
    else if (st === S.BarStyle.HEAVY || st === S.BarStyle.HEAVY_HEAVY) widths = [heavyWidth];
    else widths = [light];
    if (spec.repeatBackward && widths.length === 1) widths = [light, heavyWidth];
    const dist = heavyWidth;
    let xpos = 0;
    // 反复点在**细线那一侧**（`:‖` 左、`‖:` 右），先占位再画线，x 顺序才对
    const dotR = opt.repeatDotRadius > 0 ? opt.repeatDotRadius : light * 1.6;
    const dotGap = dotR * 1.6;
    if (spec.repeatBackward) {
      this.addDots(opt, xpos + dotR, dotR, top, bot);
      xpos += dotR * 2 + dotGap;
    }
    for (const w of widths) {
      const l = new GraphicLine();
      l.strokeColor = opt.color;
      l.x = xpos + w / 2;
      l.p0 = new Point(0, top);
      l.p1 = new Point(0, bot);
      l.strokeWidth = w;
      xpos += w + dist;
      res.add(l);
      this.lines.push(l);
    }
    if (spec.repeatForward) {
      xpos += dotGap - dist;
      this.addDots(opt, xpos + dotR, dotR, top, bot);
    }
    this.isPlain = widths.length === 1 && !spec.repeatBackward && !spec.repeatForward;
    res.update();
  }

  /** 小节线**墨迹**的左右缘（相对本 entry 的组原点）。
   *
   *  `group.x` 不是线的位置：`:‖` 会先画反复点再画线，两者差着 `dotR × 2 + dotGap`
   *  （实测 4.8pt）。房号横线要贴着小节线画，拿 `group.x` 当线位就会短一截
   *  （158《一件礼物》的一房终点差了 4.3pt，看着没对齐）。 */
  get inkLeft(): number {
    const f = this.lines[0];
    return f ? f.x - f.strokeWidth / 2 : 0;
  }
  get inkRight(): number {
    const l = this.lines[this.lines.length - 1];
    return l ? l.x + l.strokeWidth / 2 : 0;
  }

  /** 反复点：小节线中线上下各一个实心圆（四段三次贝塞尔近似）。 */
  private addDots(opt: LayoutOptions, cx: number, r: number, top: number, bot: number): void {
    const mid = (top + bot) / 2;
    const off = (bot - top) / 6;
    for (const cy of [mid - off, mid + off]) {
      const p = new GraphicPath();
      p.fill = true;
      p.stroke = false;
      p.fillColor = opt.color;
      const k = r * 0.5523;
      p.moveTo(cx - r, cy);
      p.cubicTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
      p.cubicTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
      p.cubicTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
      p.cubicTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
      p.close();
      this.group.add(p);
    }
  }

  /**
   * Lower the top edge so the barline stops below a slur/tie crossing it.
   * Only ever shortens; a `top` above `defaultTop` is ignored.
   *
   * Works on the post-`update()` representation: `Group.update()` has already
   * folded each line's p0 into the group's y and left the children at y=0 with
   * p1 holding the length, so trimming means moving the group down and
   * shortening p1 by the same amount. (Re-assigning p0 instead would be folded
   * in a *second* time by GraphicLine.update(), which both moves and lengthens
   * the stroke.)
   */
  /** 小节线占多宽 —— **要把整组算进去**（粗细两条线、反复点都在 group 里）。
   *  基类只看 `entryItem()`（第一条竖线），于是 `‖:` 右边那两个反复点没有占位，
   *  后面的音符直接压上来（037 第三行的 `‖:5` 里点与 5 叠在一起）。 */
  override entryWidth(): number {
    return this.group.width;
  }

  clipTop(top: number): void {
    const y = Math.max(this.defaultTop, Math.min(top, this.bot));
    const dy = y - this.group.y;
    if (dy <= 0) return;
    for (const l of this.lines) {
      l.p1 = new Point(l.p1.x, l.p1.y - dy);
      l.height = Math.abs(l.p1.y);
    }
    this.group.y += dy;
    this.group.height -= dy;
  }
  entryItem(): PageItem | null {
    return this.group.children[0];
  }
}

export class LineBreak extends Entry {
  newPage = false;
  constructor() {
    super();
    this.group.width = 0;
    this.group.height = 0;
    this.group.data = this;
  }
  entryItem(): PageItem | null {
    return null;
  }
}

export class BeamLine extends GraphicLine {
  level = 0;
  left: NoteEntry | null = null;
  right: NoteEntry | null = null;
  constructor(lev: number, l: NoteEntry, r: NoteEntry, opt: LayoutOptions) {
    super();
    this.selectable = true;
    this.level = lev;
    this.left = l;
    this.right = r;
    const grp = l.line.group;
    this.p0 = l.entryItem()!.pos(grp);
    this.p1 = r.entryItem()!.pos(grp);
    this.p1 = this.p1.offset(r.numberPos, 0);
    // `lev` is 1-based here (musicpp's is 0-based), so the first beam lands on
    // jpBeamTop and each further level steps down by jpBeamDist.
    const y = opt.jpBeamTop + opt.jpBeamDist * (lev - 1);
    this.p0 = new Point(this.p0.x, y);
    this.p1 = new Point(this.p1.x, y);
    this.strokeWidth = opt.jpBeamWidth;
    this.strokeColor = opt.color;
    this.x = this.p0.x;
    this.p1 = this.p1.offset(-this.p0.x, 0);
    this.p0 = new Point(0, this.p0.y);
  }
}

// ---------------- Line / layout ----------------

class EntryItemInfo {
  dist = 0;
  rate = 0;
  entry: Entry | null = null;
}

class Page {
  lines: Line[] = [];
}

/** 段落词落点的几何输入（一行之内，坐标以该行的 group 为原点）。 */
export interface SectionWordGeom {
  /** 锚点音符的墨迹左缘 */
  anchorX: number;
  /** 段落词的文字宽 */
  width: number;
  /** 段落词字号：让位间隙与抬升量都按它算 */
  size: number;
  /** 和弦那条基线 */
  baseY: number;
  chords: { x0: number; x1: number; y: number }[];
  /** 本小节的左右界（上一条 / 下一条小节线） */
  barLeft: number;
  barRight: number;
  /** 段落词最左能到哪儿：一般就是 `barLeft`，行首那一条是版心左缘（见下） */
  hangLeft: number;
  /** 行的右缘（版心右缘）。**段落词一个字都不许挂到版心外面**，越过小节线也不行。 */
  rightLimit: number;
  /** 行首那一条：**跨在锚点上方**（谱面为它缩进过，见 `Line.sectionWordIndent`）——
   *  左括号落到音符左边、词身压着音符，而不是整个躲到左边去。 */
  straddle?: boolean;
}

/** 段落词的落点。 */
export interface SectionWordSlot {
  x: number;
  /** 让不开，只能抬到和弦上方一层 */
  lifted: boolean;
  /** 要不抬起来，本小节右界还差多少（lifted 时 > 0） */
  shortfall: number;
}

/**
 * 段落词能往左挂多远。锚点左边还有小节线（`barLeft` 找得到）就不许越过它——越过去
 * 就成了上一小节的标记；**行首**那一条左边没有小节线，最多到**版心左缘**。
 *
 * 原来准它伸进左边距九成（原书在行尾也让段落词伸出版心），但那等于挂到离纸边 6pt 的地方
 * ——024/371/381 三首实测就挂在那儿。口径改成「一个字都不许出版心」。
 */
function sectionWordHangLeft(barLeft: number | undefined): number {
  return barLeft ?? 0;
}

/**
 * 段落词摆哪儿——**纯几何，不碰页面树**。
 *
 * 先按锚点音符摆在和弦基线上，撞上和弦就**沿 x 让**：右移到那个和弦右边（一路跳过挨着的
 * 和弦找空档，和弦密的行上第一个空档往往在两三个和弦之后），右边出了小节就左移。
 * 小节首本来只许右移，但**行首**那一条例外：可以整个挂到锚点音符**左边**、伸进左边距
 * （`hangLeft`）——原书在行尾也是这么让它伸出版心的。这一步比撑开整个小节省地方，
 * 381《进深进深入主仁爱深渊》的弱起「（副歌）」原来要把弱起小节撑宽一个词。
 * 都让不开才退到和弦**上方**一行，那样虽然多占一层，至少不叠字。
 *
 * 这个判据被两处共用，**必须是同一份代码**：`Line.spreadForSectionWords`（排版前预演，
 * 据此算要撑开多少）与 `Line.addSectionWords`（justify 之后真正摆）。各写一套就会错配——
 * 129 首《荣耀的一天》的「（副歌）」曾因此被抬到和弦上方（spread 那边只按「锚点到小节线
 * 够不够放下这几个字」算，没算跳过和弦这一段）。
 */
/**
 * 段落词的字宽——**要按标点挤压量**（全书半身式，见 common/cjkpunct.ts）。
 *
 * 「（副歌）」四个字里有两个全角括号，半身档下各压掉半格，整词窄一个字身。照全宽量的话，
 * 一是**摆的时候两侧各空半格**（与「（第一调）」那个老毛病同源），二是**冲突检测偏胖**，
 * 明明躲得开和弦却判成让不开，于是去撑小节——撑开量全堆在一两个空档上，音符右边就
 * 空出一大块（173/175/189/193 四首的「（副歌）」）。量和画共用这一份笔位，两边不会错开。
 */
function sectionWordRun(font: Font, text: string, mode: CompressMode): { width: number; xs: number[] | null } {
  if (mode === "none") return { width: font.measureText(text), xs: null };
  const { xs, width } = font.run(text, mode);
  // 首字是开括号时它的**笔位是负的**（半身档下「（」左挪半格，墨才落在半角格里）。
  // 落点是拿 `x` 当左界算的，不把这半格挪回来，段落词就整体左偏、挂出版心
  //（line-check 的 V1：106/170/189… 六首起点量到 60.x，版心左缘 62.8）。
  const lead = xs[0] ?? 0;
  return { width: width - lead, xs: xs.length > 1 ? xs.map((v) => v - lead) : null };
}

export function placeSectionWord(g: SectionWordGeom): SectionWordSlot {
  // 与和弦之间要留的净空。**半身档下末字是收口括号**，它的墨迹一直顶到 advance 的右边缘，
  // 原来那 0.3 个字身量到纸上只剩一线（173 的「（副歌）」右括号与后面的 G 描边挨着）。
  const gap = g.size * 0.6;
  // 压不压字看**全行的和弦**（段落词本来就可以伸出小节线，撞的往往是下一小节的第一个和弦）；
  // 但**让位只能在本小节内**——这两件事口径不同，别混。撞上小节外的和弦时右移左移都没用，
  // 只能靠 spreadForSectionWords 撑开本小节：小节线右边的东西整体右移，段落词留在原处，空档就出来了。
  // 「撞不撞」按**留了净空的**区间算：光看有没有重叠，落点会紧贴着和弦停下
  //（173 的「（副歌）」右括号与 G 之间只剩 0.4pt）。
  const hit = (x: number): { x0: number; x1: number } | undefined =>
    g.chords.find((c) => Math.abs(c.y - g.baseY) < g.size && x - gap < c.x1 && c.x0 < x + g.width + gap);
  // 行首那一条先试「跨在锚点上」：谱面已经为它缩进过半个词（`sectionWordIndent`），
  // 左边那点地方就是给左括号留的。整个躲到音符左边没必要，就地从锚点起排又会把
  // 音符与小节线之间豁开一道口子——摆中间，两头都只让半个词。
  if (g.straddle) {
    const mid = Math.max(g.hangLeft, g.anchorX - g.width / 2);
    const block = hit(mid);
    // 撞上了也**摆在这儿不动**，只报「后面那个和弦还得让开多少」——行首这一条不许再往右
    // 挪、更不许抬到和弦上方（那是刻意否掉的），差的量由 `Line.nudgeForSectionWords`
    // 在 justify 之后从行内其它空档里匀出来。
    return block
      ? { x: mid, lifted: true, shortfall: mid + g.width + gap - block.x0 }
      : { x: mid, lifted: false, shortfall: 0 };
  }
  const first = hit(g.anchorX);
  if (!first) return { x: g.anchorX, lifted: false, shortfall: 0 };
  // 右移找空档：**只跳过本小节内的和弦**。挡路的和弦已经在小节线右边（属下一小节）时就别再跳了，
  // 再跳落点就落到下一小节里去了——那个标记看着就成了下一小节的（405《信靠顺服》的「（副歌）」
  // 曾这样越过小节线、挤到 D7 边上）。那种情形交给 `spreadForSectionWords` 撑：撑开会把小节线
  // 右边的东西整体右移，段落词留在原处，空档就出来了，而且要撑的只是「差的那一点」。
  let cand = first.x1 + gap;
  let block = hit(cand);
  while (block && block.x0 < g.barRight) {
    cand = block.x1 + gap;
    block = hit(cand);
  }
  // 落点**起点必须留在本小节内**；尾巴可以伸过小节线（原书就有印到线右边的），只要不压字、不出版心。
  if (!block && cand < g.barRight && cand + g.width <= g.rightLimit)
    return { x: cand, lifted: false, shortfall: 0 };
  // 只差一点点就能摆下（挡路的是小节线右边那个和弦）——报「还差多少」，让撑开去补
  if (block && cand < g.barRight && cand + g.width <= g.rightLimit)
    return { x: cand, lifted: true, shortfall: cand + g.width - block.x0 };
  const left = first.x0 - g.width - gap;
  if (left >= g.hangLeft && !hit(left) && g.anchorX > g.hangLeft) return { x: left, lifted: false, shortfall: 0 };
  // 让不开就挂到锚点音符左边——行首那一条 `hangLeft` 在左边距里，够挂；
  // 行中的 `hangLeft` 就是 `barLeft`，挂不出去，照旧往下走抬升。
  const hang = g.anchorX - g.width - gap;
  if (hang >= g.hangLeft && !hit(hang)) return { x: hang, lifted: false, shortfall: 0 };
  // 抬起来那一层同样**一个字都不许出版心**（行末那一条锚点靠右时会伸出去）。
  // 先按右缘钳，再按 hangLeft 钳，**冲突时以不出版心为准**——原来外面套的那个
  // `Math.max(hangLeft, …)` 会在「词比 hangLeft 到版心右缘还宽」时把落点顶回去，
  // 于是仍旧挂出版心（120 首的「（副歌）」）。
  // 左界这里取的是**版心左缘（0）而不是 hangLeft**：hangLeft 是「不许越过上一条小节线」，
  // 那是就地摆放时的口径；抬起来这一层已经离开了和弦带，越过小节线也不会被读成
  // 上一小节的标记，而「出版心」是硬伤。
  const lifted = Math.max(0, Math.min(g.anchorX, g.rightLimit - g.width));
  return { x: lifted, lifted: true, shortfall: Math.max(0, cand + g.width - g.barRight) };
}

export class Line {
  group = new Group();
  entries: Entry[] = [];
  beams: BeamLine[] = [];
  maxBeamLevel = 0;
  chordEntry = new Map<S.Chord, NoteEntry>();
  /** Arcs drawn on this line, in line coordinates (see clipBarlinesUnderSlurs). */
  slurTies: SlurTieBase[] = [];
  /** 弧的样式，由 addTie/addSlur 从 LayoutOptions 暂存下来（addSlurTie 拿不到 opt）。 */
  private slurStyle: SlurStyle = { thickness: 6, color: 0 };

  private addEntry(e: Entry): void {
    if (e instanceof NoteEntry) {
      if (e.number?.text === "-") {
        // beat-extension dash: not a chord anchor
      } else {
        this.chordEntry.set(e.chord, e);
      }
    }
    this.entries.push(e);
    this.group.add(e.group);
    e.line = this;
  }

  private entryX(e: Entry): number {
    let res = e.group.x;
    const it = e.entryItem();
    if (it === null) return res;
    res += it.x;
    return res;
  }

  private adjust(width: number, maxHorizontalScale: number): void {
    const infos: EntryItemInfo[] = [];
    let idx = 0;
    for (const e of this.entries) {
      const next = getOrNull(this.entries, idx + 1);
      if (next === null) break;
      if (next instanceof LineBreak) break;
      const xx = this.entryX(e);
      const xxNext = this.entryX(next);
      const dist = xxNext - xx - e.entryWidth();
      if (dist < -1) throw new Error("neg dist");
      const smallDist = e instanceof NoteEntry && !(next instanceof Barline);
      const it = new EntryItemInfo();
      it.entry = e;
      it.dist = dist;
      it.rate = smallDist ? 2 : 1;
      if (next instanceof TimeSig) it.rate = 0.1;
      infos.push(it);
      idx++;
      if (idx === this.entries.length - 1) break;
    }
    infos.sort((a, b) => {
      const diff = a.dist * b.rate - b.dist * a.rate;
      if (diff < 0) return -1;
      else if (diff === 0) return a.rate < b.rate ? -1 : a.rate > b.rate ? 1 : 0;
      else return 1;
    });

    let right = 0;
    let lastVisible: Entry | null = null;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!(e instanceof LineBreak)) {
        if (lastVisible === null) lastVisible = e;
      }
      const r = e.group.x + e.group.childrenBound.right;
      if (r > right) right = r;
      if (e instanceof NoteEntry) {
        if (e.lrc !== null) break;
      }
    }
    let extra = width - right;
    const maxExtra = maxHorizontalScale * right;
    let dontMoveLastBarline = false;
    if (extra > maxExtra) {
      extra = maxExtra;
      dontMoveLastBarline = true;
      // 非致命：某行内容远窄于可用宽度（如稀疏/末行），此处已 clamp 掉多余空白照常排版。
      // 仅调试时输出，避免污染控制台（识别出的谱常有短行会触发）。
      if ((globalThis as { __omrDebug?: boolean }).__omrDebug) console.debug("[layout] space too large (clamped)");
    }

    let totalDist = 0;
    let totalRate = 0;
    let end = 0;
    let share = 0;
    for (let i = 0; i <= infos.length; i++) {
      end = i;
      if (i === infos.length) break;
      const it = infos[i];
      const curShare = it.dist / it.rate;
      share = (extra + totalDist + it.dist) / (totalRate + it.rate);
      if (share < curShare) break;
      totalDist += it.dist;
      totalRate += it.rate;
    }
    share = (extra + totalDist) / totalRate;

    const offsets = new Map<Entry, number>();
    for (let i = 0; i < end; i++) {
      const it = infos[i];
      const dist = share * it.rate;
      offsets.set(it.entry!, dist - it.dist);
    }
    let offset = 0;
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        for (const dot of e.octaveDot) {
          dot.x = e.number!.x + e.number!.cx - dot.width / 2;
        }
      }
      e.group.x += offset;
      if (offsets.has(e)) offset += offsets.get(e)!;
    }
    if (!dontMoveLastBarline) this.adjustLastBarline(lastVisible, width);
  }

  private adjustLastBarline(lastVisible: Entry | null, width: number): void {
    if (!(lastVisible instanceof Barline)) return;
    const prev = this.entries.indexOf(lastVisible) - 1;
    const prevEnt = getOrNull(this.entries, prev);
    if (!(prevEnt instanceof NoteEntry)) return;
    const dx = lastVisible.group.x - (prevEnt.group.x + prevEnt.number!.right);
    const maxDx = prevEnt.number!.font.size * 3;
    const space = width - lastVisible.group.bound.right - lastVisible.group.x;
    if (space > 0) lastVisible.group.x += Math.min(space, maxDx - dx);
  }

  /** 由 layout(opt) 注入，供 calcXPos 用（Line 自己不持有 LayoutOptions）。 */
  lyricGap = 0;

  /**
   * 相邻的两条小节线只留一条。
   *
   * `‖:`（反复段起点）画在小节**开头**，而上一小节末尾本来就有一条细线，两条挨在一起
   * 就成了「细 粗 细」三条竖线（010《愿祢崇高》第一行开头）。原书是「粗 细 + 两点」。
   * 普通的那条让位；两条都不普通就看是不是**前后反复背靠背**（`:‖` 紧接 `‖:`）：
   * 那两条要合成一条「细 粗 细」+ 两侧各两点，五线谱就是这么画的
   * （J14 原来画成两根粗线并排）。其余组合仍旧都留着。
   */
  private dropDoubledBarlines(opt: LayoutOptions): void {
    for (let i = this.entries.length - 1; i > 0; i--) {
      const cur = this.entries[i];
      const prev = this.entries[i - 1];
      if (!(cur instanceof Barline) || !(prev instanceof Barline)) continue;
      if (prev.isPlain) this.entries.splice(i - 1, 1);
      else if (cur.isPlain) this.entries.splice(i, 1);
      else if (prev.spec.repeatBackward && cur.spec.repeatForward
               && !prev.spec.repeatForward && !cur.spec.repeatBackward) {
        const merged = new Barline(false, opt, { repeatBackward: true, repeatForward: true });
        merged.update();
        this.entries.splice(i - 1, 2, merged);
      }
    }
  }

  /**
   * **每个和弦的自然横向区间**（`[x0, x1]`，未分行、未 justify）。
   *
   * 「这一行放不放得下」要拿**真实坐标**判，不能按格数估（用户口径：「不要算格数，
   * 真实坐标排一遍，放不下再补刀」）。格数是近似——同样 30 格，歌词字多的行、带八度点
   * 与附点的行都更宽；估宽了排版器就会在断点之外**又折一刀**，估窄了整首白白排稀。
   *
   * 返回的坐标与 `doLineBreak` 判折行用的是**同一把尺子**（`group.x + maxX`），
   * 所以「Σ 宽度 ≤ 版心宽」与排版器的判断一致。断点不影响这些坐标（`calcXPos` 在
   * `doLineBreak` 之前跑），所以整首量一次就够。
   */
  naturalSpans(opt: LayoutOptions): Map<S.Chord, { x0: number; x1: number }> {
    this.lyricGap = opt.lyricGap;
    this.dropDoubledBarlines(opt);
    this.calcXPos();
    // **一个和弦可能摊成好几个 entry**（`5---` 是音符 + 三根增时线各一个 NoteEntry，
    // 共用同一个 `Chord`）：照直 `set` 会被最后那根增时线覆盖掉，而**歌词挂在头一个
    // entry 上**——「详；」两个字比一根 `-` 宽得多，右缘就这么丢了。065《马槽圣婴》
    // 因此把 24 拍的一行量成 309 宽（版心 312、看着放得下），排版器照真实坐标一量
    // 却放不下，把行末那个 `7-` 连同三段歌词折成了单独一行（中间行只有一个音）。
    // 取各 entry 的**最左左缘、最右右缘**。
    const out = new Map<S.Chord, { x0: number; x1: number }>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const g = e.group;
      const x0 = g.x;
      const x1 = g.x + (g.maxX ?? 0);
      const prev = out.get(e.chord);
      out.set(e.chord, prev ? { x0: Math.min(prev.x0, x0), x1: Math.max(prev.x1, x1) } : { x0, x1 });
    }
    return out;
  }

  private calcXPos(): void {
    for (const e of this.entries) e.group.normalizeX();
    let curX = 0;
    this.entries.forEach((e, idx) => {
      const it = e.entryItem();
      let x = 0;
      let w = 0;
      if (it !== null) x = it.x;
      w = e.entryWidth();
      if (e instanceof Barline) {
        const next = getOrNull(this.entries, idx + 1);
        if (!(next instanceof TimeSig)) curX += it!.height / 5;
      }
      if (e instanceof TimeSig) curX += it!.height / 5;
      e.group.x = curX - x;
      curX += w;
    });
    curX = 0;
    let offset = 0;
    let prevBlank = 0; // 上一条歌词末字右侧的留白（见下面的「标点挤压」）
    for (const e of this.entries) {
      // **各段歌词一起算**：叠排时一个音符底下摞着好几段，只按第一段留位置的话，
      // 字更多的那几段就会互相压上去（156《百只羊有九十九》第 2 段 `主说那只亦我所有,`
      // 比第 1 段长出好几个字）。取各段里最靠左的左缘、最靠右的右缘。
      const lrcs = e instanceof NoteEntry ? e.lrcs.filter((l) => l.text) : [];
      if (!lrcs.length) {
        e.group.x += offset;
        continue;
      }
      // **前置标点悬挂**：`“凡` 这种带前引号的字，整体宽是两个字，按整体去避让上一个字
      // 就把这个音符整个往右推，一行的音符间距跟着拉开（190 首那一行）。
      // 引号只要不压到**字**上就行，压在小节线那一带没关系——所以避让只看主体（去掉左标点），
      // 让引号伸进左边的空档里。右标点仍照算，否则下一个字会压上来。
      // 悬挂**多少由墨迹说了算**（标点挤压）：引号的墨只占方框右半边，上一个字的尾标点
      //（`音:` 的冒号）右边也空着一截，两边的留白加上字距就是能挤进去的量。
      // 照整个 `leadWidth` 悬挂会把引号压在那个冒号上（376《将心给我》的 `呼召:“将心给我。”`），
      // 一律不悬挂又把音符间距白白拉开（190 首）——按墨迹算两头都占着。
      // **跨音符的那一对标点也得挤**：`召：` 的冒号与 `“将` 的引号分属两个 `<text>`，
      // OpenType 的上下文特性管不到它们，挤压由 `Lyric.update` 各自压完、这里只管避让。
      // 避让补的是一道**下限**——挤完的墨迹间距不许比「这两个字排在同一个 `<text>` 里」还紧。
      // 同 text 的墨间距 = prevBlank + headBlank（两头的留白都已经是**挤压后**的口径），
      // 跨音符的 = room − hang = prevBlank + lyricGap + headBlank − hang，
      // 两边一减，下限就是 **`hang ≤ lyricGap`**：悬挂只许吃掉字与字之间那道呼吸，
      // 不许吃到墨迹之间的距离里去。
      const room = prevBlank + this.lyricGap + Math.min(...lrcs.map((l) => l.headBlank));
      const hang = Math.max(0, Math.min(Math.min(...lrcs.map((l) => l.leadWidth)), room, this.lyricGap));
      const leftMost = Math.min(...lrcs.map((l) => l.x)) + hang;
      const rightMost = Math.max(...lrcs.map((l) => l.x + l.width));
      const xx = Math.max(curX - leftMost, e.group.x + offset);
      offset = xx - e.group.x;
      e.group.x = xx;
      curX = xx + rightMost + this.lyricGap;
      // 各段里**留白最少**的那一段说了算（有一段挤不下就是挤不下）
      prevBlank = Math.min(...lrcs.map((l) => l.tailBlank));
    }
  }

  /**
   * 在**假想的 justify 之后**跑一次 `fn`，跑完把横坐标复原。
   *
   * `adjust` 只会往空档里加距离，所以「justify 之后放得下」是比撑开更该先问的一句。
   */
  private probeJustified<T>(width: number, opt: LayoutOptions, fn: () => T): T {
    const saved = this.entries.map((e) => e.group.x);
    try {
      this.adjust(width, opt.maxHorizontalScale);
      return fn();
    } finally {
      this.entries.forEach((e, i) => { e.group.x = saved[i]; });
    }
  }

  /**
   * 为段落词（「（副歌）」）**按小节撑开**。
   *
   * 段落词印在和弦那一带、不许跨过小节线，横向地方不够时就得撑。但撑开量**不能全堆在
   * 锚点那一个音符上**——那一处的间距会突兀地大出一截。这里把需要的量**均摊到锚点所在
   * 小节里余下的每个音符间距**上，小节之后的内容整体右移同样的量。
   * 段落词本身仍可横向伸出音符的范围，撑开只为躲开**后面的和弦**。
   *
   * 撑多少**由 `placeSectionWord` 说了算**（与真正摆的 `addSectionWords` 同一个判据）：
   * 「够不够」不是「锚点到小节线放不放得下这几个字」，而是「跳过挨着的和弦之后还有没有空档」。
   * 两处各算各的会错配——129 首就是这么抬起来的：spread 按锚点算只差 2pt、撑完仍让不开。
   * 而且均摊是**整条小节一起拉伸**，末尾那个空档只分到 1/steps，所以要的是「撑多少才够」，
   * 不是「差多少」——这里按落点判据二分求最小的撑开量。
   */
  spreadForSectionWords(opt: LayoutOptions, lineWidth: number): void {
    if (opt.sectionWordSize <= 0) return;
    const size = opt.sectionWordSize;
    const font = opt.lrcFont.makeWithSize(size);
    const bars: number[] = [];
    this.entries.forEach((e, i) => { if (e instanceof Barline) bars.push(i); });
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!(e instanceof NoteEntry) || !e.chord.sectionWord) continue;
      const item = e.entryItem();
      if (!item) continue;
      const endIdx = bars.find((b) => b > i) ?? this.entries.length;
      const inBar: number[] = [];
      for (let k = i + 1; k < endIdx; k++) inBar.push(k);
      const steps = inBar.length + 1; // 锚点到小节线之间有这么多段间距
      /** 撑开量 S 里有多大一份落到第 k 个条目上（锚点不动、小节线整条右移 S）。 */
      const shiftFrac = (k: number): number => {
        if (k <= i) return 0;
        if (k >= endIdx) return 1;
        return (inBar.indexOf(k) + 1) / steps;
      };
      /** 从**当前坐标**造一个「撑开 spread 时段落词落哪儿」的函数。 */
      const placer = (): ((spread: number) => SectionWordSlot) => {
        const chordBase: { x0: number; x1: number; y: number; f: number }[] = [];
        this.entries.forEach((ent, k) => {
          if (!(ent instanceof NoteEntry)) return;
          for (const it of this.chordGroups(ent))
            chordBase.push({ x0: ent.group.x + it.x, x1: ent.group.x + it.x + it.width, y: ent.group.y + it.y, f: shiftFrac(k) });
        });
        const anchorX = e.group.x + item.x;
        const lastEnt = this.entries[this.entries.length - 1];
        const barRight0 = this.entries[endIdx]?.group.x ?? lastEnt.group.x + lastEnt.group.width;
        const barLeftAt = [...bars].reverse().map((b) => this.entries[b].group.x).find((bx) => bx <= anchorX);
        const barLeft = barLeftAt ?? 0;
        const width = sectionWordRun(font, e.chord.sectionWord!, opt.punctCompress).width;
        return (spread: number): SectionWordSlot =>
          placeSectionWord({
            anchorX,
            width,
            size,
            baseY: this.sectionWordBaseY(e, opt, chordBase),
            chords: chordBase.map((c) => ({ x0: c.x0 + spread * c.f, x1: c.x1 + spread * c.f, y: c.y })),
            barLeft,
            barRight: barRight0 + spread,
            hangLeft: sectionWordHangLeft(barLeftAt),
            rightLimit: lineWidth || this.group.width || barRight0 + spread,
            straddle: this.entries[0] === e,
          });
      };
      // **先问 justify 之后放不放得下**：本行内容窄时（副歌那种只有一个弱起音符起头的行）
      // justify 会把空档撑得很宽，段落词本来就摆得下，这时再撑一遍等于白撑——撑出来的那个
      // 大空档 justify 也收不回去（`adjust` 只加不减），音符右边就空出一大块
      //（173/175/189/193 四首的「（副歌）」）。
      if (lineWidth > 0 && !this.probeJustified(lineWidth, opt, () => placer()(0)).lifted) continue;
      const at = placer();
      // 行首那一条不在这儿撑：justify 前的间距是紧的，照它算出来的撑开量会大出一截，
      // 而 justify 随后又要把同一段空档拉开一遍——两笔叠起来就是音符右边那道大口子。
      // 它改在 justify 之后按真实坐标微调（`nudgeForSectionWords`）。
      if (this.entries[0] === e) continue;
      const now = at(0);
      if (!now.lifted) continue;
      // 上界：末尾那个空档只分到 1/steps 的撑开量（空档更靠前的话分到的更多），
      // 所以 shortfall × steps 一定够；撑到上界仍让不开就别白撑（左右都是密和弦），维持抬起。
      let hi = now.shortfall * steps + size;
      if (at(hi).lifted) continue;
      let lo = 0;
      while (hi - lo > 0.25) {
        const mid = (lo + hi) / 2;
        if (at(mid).lifted) lo = mid;
        else hi = mid;
      }
      const need = hi;
      // **撑开会把整行拉长**（小节线右边的东西整体右移 `need`），撑过头整条谱行就伸出版心去了
      //（120《耶稣是我亲爱救主》实测越出右缘 57pt——正好是这里的撑开量；段落词本身还在
      // 版心内，所以 line-check 的 L6 一直报 0，看 PDF 才发现是**整行**出去了）。
      // 撑不下就别撑：维持 `placeSectionWord` 给的抬起落点，把段落词摆到和弦上方一层
      //（用户口径：「排不下的时候就把文本放到和弦上方」）。
      const lineRight = lineWidth || this.group.width || 0;
      if (lineRight > 0) {
        const last = this.entries[this.entries.length - 1];
        if (last.group.x + last.group.width + need > lineRight) continue;
      }
      inBar.forEach((k, n) => { this.entries[k].group.x += (need * (n + 1)) / steps; });
      for (let k = endIdx; k < this.entries.length; k++) this.entries[k].group.x += need;
    }
  }

  /** 段落词的基线：本行有和弦就对到和弦那一条（原书就是并排的），一个都没有才自己算。 */
  private sectionWordBaseY(e: NoteEntry, opt: LayoutOptions, chords: { y: number }[]): number {
    if (chords.length) return chords[0].y + opt.sectionWordSize;
    const inkTop = Math.min(opt.numberBound("1").top, e.group.childrenBound.top);
    return e.group.y + inkTop - opt.chordGap;
  }

  /** 一个音符条目上挂的和弦组（`addHarmony` 打的 `chord-group` 标记）。 */
  private chordGroups(e: NoteEntry): Group[] {
    return e.group.children.filter((it): it is Group => it instanceof Group && it.classes.has("chord-group"));
  }

  /**
   * **长 slur/tie 底下的和弦与段落词让位**。
   *
   * 和弦（`NoteEntry.addHarmony`）与弧（`NoteEntry.slurRung`）都从「音符墨迹栈顶」起算、
   * 互不知情，跨度一长弧就顶进和弦那一带，把 `Gm`/`C` 从字脚上划过去（070 首副歌）。
   * 原书的排法是**和弦在弧之上**，所以让位的是和弦不是弧。
   *
   * 口径（用户定的）：弧**中间**的和弦必须抬，两端的可以不抬——两端弧低，和弦本来
   * 就够不着，这一条靠「墨迹真的相交才触发」自然满足；而一旦触发，同一条弧底下的
   * 和弦就**整排一起抬**（含头尾），不然一高一低比压着还难看。
   *
   * 段落词（`（副歌）`）不在这里动：它的基线跟着第一个和弦走（`sectionWordBaseY`），
   * 和弦抬起来它自然跟着抬；本行没有和弦时另在 `addSectionWords` 之后收尾。
   */
  liftChordsUnderSlurs(opt: LayoutOptions): void {
    if (!this.slurTies.length) return;
    const chords: { g: Group; x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      for (const it of this.chordGroups(e))
        chords.push({
          g: it,
          x0: e.group.x + it.x, x1: e.group.x + it.x + it.width,
          y0: e.group.y + it.y, y1: e.group.y + it.y + it.height,
        });
    }
    if (!chords.length) return;
    const dyOf = new Map<Group, number>();
    for (const s of this.slurTies) {
      const sx0 = s.x, sx1 = s.x + s.width, sTop = s.y, sBottom = s.y + s.height;
      const under = chords.filter((c) => c.x1 > sx0 && c.x0 < sx1);
      if (!under.length) continue;
      if (!under.some((c) => c.y1 > sTop && c.y0 < sBottom)) continue; // 没真压上就不动
      let dy = 0;
      for (const c of under) dy = Math.min(dy, sTop - opt.jpStackGap - c.y1);
      for (const c of under) dyOf.set(c.g, Math.min(dyOf.get(c.g) ?? 0, dy));
    }
    for (const [g, dy] of dyOf) g.y += dy;
  }

  /** 本行没有和弦、段落词又被弧压住时的收尾（有和弦时它跟着和弦走，见上）。 */
  liftSectionWordsUnderSlurs(opt: LayoutOptions): void {
    if (!this.slurTies.length) return;
    for (const tf of this.group.children) {
      if (!(tf instanceof TextFrame) || !tf.classes.has("section-word")) continue;
      const x0 = tf.x, x1 = tf.x + tf.width;
      const y0 = tf.y + tf.bound.top, y1 = tf.y + tf.bound.bottom;
      let dy = 0;
      for (const s of this.slurTies) {
        if (s.x + s.width <= x0 || s.x >= x1) continue;
        if (s.y >= y1 || s.y + s.height <= y0) continue;
        dy = Math.min(dy, s.y - opt.jpStackGap - y1);
      }
      tf.y += dy;
    }
  }

  /**
   * **转调标记避开和弦**（144 首）。
   *
   * `KeySig` 的文本固定摆在音符基线上方一个字号处，正是和弦那一带（`chordGap`），
   * 而它的 `entryWidth()` 是 0、左右各伸出半个词宽，撞上就直接压字。
   * 排版口径是「转调在上方」：撞了就把标记整体抬到那些和弦的墨迹顶之上一个 `jpStackGap`
   *（与八度点/圆滑线共用的那把尺子，见 docs/实现/简谱纵向栅格.md）。
   *
   * 要排在 `addEnding` **之前**：房号的高度是扫全行已画对象算的，抬起来的转调也得算进去。
   */
  liftKeySigOverChords(opt: LayoutOptions): void {
    const keys = this.entries.filter((e): e is KeySig => e instanceof KeySig);
    if (!keys.length) return;
    // 本行所有和弦组的绝对包围盒
    const chords: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      for (const it of this.chordGroups(e))
        chords.push({
          x0: e.group.x + it.x, x1: e.group.x + it.x + it.width,
          y0: e.group.y + it.y, y1: e.group.y + it.y + it.height,
        });
    }
    if (!chords.length) return;
    for (const k of keys) {
      const tf = k.label;
      const x0 = k.group.x + tf.x;
      const x1 = x0 + tf.width;
      // TextFrame 的 y 是**基线**，纵向范围要走 `bound`（top = ascent 为负、bottom = descent）
      const y0 = k.group.y + tf.y + tf.bound.top;
      const y1 = k.group.y + tf.y + tf.bound.bottom;
      let top = Infinity;
      for (const c of chords) {
        if (c.x1 <= x0 || c.x0 >= x1) continue; // 横向不重叠
        if (c.y0 >= y1 || c.y1 <= y0) continue; // 纵向不重叠
        top = Math.min(top, c.y0);
      }
      if (!Number.isFinite(top)) continue;
      // 把标记的**墨迹底**抬到那些和弦的墨迹顶之上一个 jpStackGap
      k.group.y += top - opt.jpStackGap - y1;
    }
  }

  private doLineBreak(width: number): Line[] {
    const res: Line[] = [];
    let idx = 0;
    while (idx < this.entries.length) {
      let last = idx;
      const grp = this.entries[idx].group;
      const l = grp.x;
      while (last < this.entries.length) {
        const lastGrp = this.entries[last].group;
        if (this.entries[last] instanceof LineBreak) {
          last++;
          break;
        }
        const r = lastGrp.x + (lastGrp.maxX ?? 0);
        if (r - l < width) {
          last++;
          continue;
        }
        break;
      }
      const line = new Line();
      for (let i = idx; i < last; i++) line.addEntry(this.entries[i]);
      res.push(line);
      idx = last;
    }
    // 只剩小节线（连一个音符都没有）的行**并回上一行**：谱尾的终止线常被宽度判据挤到
    // 下一行去，单独占掉一整行——那是永远不该出现的排法（024《贺祂为王》）。
    // 并回去会让上一行稍稍超出版心，但小节线本来就窄，justify 收得回来。
    for (let i = res.length - 1; i > 0; i--) {
      if (res[i].entries.some((e) => e instanceof NoteEntry)) continue;
      for (const e of res[i].entries) res[i - 1].addEntry(e);
      res.splice(i, 1);
    }
    return res;
  }

  private updateXPos(l: Line, width: number, opt: LayoutOptions): void {
    const first = l.entries[0];
    const dx = first.group.x;
    for (const e of l.entries) e.group.x -= dx;
    const last = l.entries[l.entries.length - 1];
    if (last.group.width < 0) throw new Error("");
    // 段落词的撑开要在 **justify 之前、分行之后**：分行前撑的是错的锚点（段落词落到行末时
    // 会被挪到下一行行首去，见 layout() 里那段），而 justify 只会往空档里**加**距离、不会收窄，
    // 所以这里放得下，justify 之后也放得下。
    // 行首那一条段落词要挂到音符**左边**，得先给它腾出地方：整行**左缩进**一截，
    // 排版按缩进后的宽度做，排完整行右移回来（见 sectionWordIndent）。
    const indent = l.sectionWordIndent(opt, width);
    l.spreadForSectionWords(opt, width - indent);
    l.adjust(width - indent, opt.maxHorizontalScale);
    if (indent > 0) for (const e of l.entries) e.group.x += indent;
  }

  /**
   * 行首那一条段落词要占的**左缩进**。
   *
   * 段落词挂在行首音符上时，左边一点地方都没有——那个音符自己就贴着版心左缘
   * （「一个字都不许出版心」是定死的口径，见 `sectionWordHangLeft`）。于是它只能就地
   * 摆或往右让，右让就得撑开小节，音符与小节线之间豁开一道口子
   * （173/175/189/193 的「（副歌）」）。
   *
   * 这里换个办法：**整行往右缩进半个段落词**，谱面按 `width − indent` 排、排完整体右移，
   * 段落词就能跨在行首音符上方——左括号落到音符左边，右半边压在音符上，两头各让半个词，
   * 音符与小节线之间也不用再豁开一道口子。整个词躲到音符左边是不必要的，那样缩进太深。
   * 段号（行首的「1.」「2.」）挂的是行首音符的绝对坐标（`addVerseNumbers`），跟着一起走。
   *
   * 只在**行本身还有富余**时这么做（缩进吃掉的是 justify 本来要摊掉的空白）；
   * 富余不够就返回 0，退回原来的「撑开小节」那条路。
   */
  sectionWordIndent(opt: LayoutOptions, width: number): number {
    if (!width) return 0;
    const e = this.entries[0];
    if (!(e instanceof NoteEntry)) return 0;
    let need = 0;
    if (opt.sectionWordSize > 0 && e.chord.sectionWord) {
      const font = opt.lrcFont.makeWithSize(opt.sectionWordSize);
      const w = sectionWordRun(font, e.chord.sectionWord, opt.punctCompress).width;
      // 要的地方**正好是「词的左半边探出音符墨迹的那一截」**：缩进这么多之后，词的左端
      // 贴着版心左缘、中心对着锚点音符。多要一点（比如再搭个和弦净空）词就整个往右挪，
      // 左边白空一截（189 曾在版心左缘与「（副歌）」之间空出 15pt）。
      // 对齐的是**音符墨迹的中心**而不是它的左缘——按左缘算，音符连着底下的歌词
      // 整体偏右半个数字，看着就不居中（193）。
      const it = e.entryItem();
      need = w / 2 - (it ? it.x + it.width / 2 : 0);
    }
    need = Math.max(need, this.verseNumberIndent(opt, e));
    if (need <= 0) return 0;
    let right = 0;
    for (const ent of this.entries) right = Math.max(right, ent.group.x + ent.group.childrenBound.right);
    return need <= width - right ? need : 0;
  }

  /**
   * 行首歌词的段号（「1.」「2.」…）要占的左缩进。
   *
   * 段号是**悬在首字左边**的（`addVerseNumbers` 拿行首音符的绝对坐标减去段号宽），
   * 行首音符贴着版心左缘时它就整个挂到版心外面去了。这里按「最宽的那个段号减去首字
   * 在音符里的偏移」要地方，谱面整行右移这么多，段号就落回版心内。
   */
  private verseNumberIndent(opt: LayoutOptions, e: NoteEntry): number {
    if (opt.lyricStack <= 0 || opt.verseNumbers === "never" || e.lrcs.length < 2) return 0;
    if (opt.verseNumbers === "auto") {
      let verses = 0;
      for (const ent of this.entries) if (ent instanceof NoteEntry) verses = Math.max(verses, ent.lrcs.length);
      if (verses <= opt.verseNumberAutoMin) return 0;
    }
    let need = 0;
    for (let k = 0; k < e.lrcs.length; k++) {
      const li = e.lrcs[k];
      if (!li.text) continue;
      need = Math.max(need, opt.lrcFont.measureText(`${k + 1}.`) - li.x);
    }
    return Math.max(0, need);
  }

  private layoutVertically(lines: Line[], opt: LayoutOptions, height: number): Group[] {
    const top = opt.marginTop;
    const maxDist = opt.maxLineDist;
    const dist = opt.staffDist;
    const res: Page[] = [];
    let bottomOfLastLine = 0;
    let pageBreak = false;
    for (const l of lines) {
      let newPage = res.length === 0;
      l.group.update();
      if (bottomOfLastLine + l.group.height + dist > height) newPage = true;
      if (pageBreak) {
        newPage = true;
        pageBreak = false;
      }
      if (newPage) {
        res.push(new Page());
        bottomOfLastLine = 0;
      } else {
        bottomOfLastLine += dist;
      }
      l.group.y = bottomOfLastLine;
      bottomOfLastLine += l.group.height;
      const pg = res[res.length - 1];
      pg.lines.push(l);
      const lst = l.entries[l.entries.length - 1];
      if (lst instanceof LineBreak) pageBreak = lst.newPage;
    }
    const grps: Group[] = [];
    let y = 0;
    for (const pg of res) {
      const grp = new Group();
      let totalHeight = 0;
      for (const l of pg.lines) {
        grp.add(l.group);
        totalHeight += l.group.height;
      }
      if (pg.lines.length > 1) {
        let dd = (height - totalHeight) / (pg.lines.length - 1);
        y = top;
        if (dd > maxDist) {
          y += ((dd - maxDist) * (pg.lines.length - 1)) / 2;
          dd = maxDist;
        }
        for (const ll of pg.lines) {
          const l = ll.group;
          l.y = y;
          y += l.height + dd;
        }
      } else {
        pg.lines[0].group.y = opt.marginTop;
      }
      grp.update();
      grps.push(grp);
    }
    return grps;
  }

  private addSlurTie(a: S.Note, b: S.Note, ypos: number): void {
    const ena = this.chordEntry.get(a.chord);
    const enb = this.chordEntry.get(b.chord);
    // 两端都得在**本行**里才画得出来。调用点查的是 `chord`，这里查的是 `note.chord`——
    // 两者在多声部/并音的谱里可以不是同一个和弦，查不到就只能不画（不是每一行都有两端）。
    if (!ena || !enb) {
      console.error("slur/tie 有一端不在本行，跳过");
      return;
    }
    const grp = new Tie();
    let pl = new Point(ena.cx, ypos);
    let pr = new Point(enb.cx, ypos);
    const dx = ena.number!.font.size / 14;
    if (a.tiePrev !== null || a.tupletEnd) pl = pl.offset(dx, 0);
    if (b.tieNext !== null) pr = pr.offset(-dx, 0);
    pr = pr.offset(enb.group.x - ena.group.x, 0);
    grp.init(pl, pr, this.slurStyle);
    grp.x += ena.group.x;
    grp.normalizeX();
    grp.normalizeY();
    this.group.add(grp);
    this.slurTies.push(grp);
  }

  /**
   * Stop barlines short of any slur/tie arching over them.
   *
   * Barlines now reach a full 1.0em above the baseline (musicpp's staff top),
   * which is *higher* than where an arc with no octave dots starts — so a tie
   * spanning a barline (last note of a bar tied into the next, the common case)
   * would be pierced from above. Neither musicpp nor the Kotlin original does
   * anything here; musicpp only gets away with it because its arcs are lifted
   * clear whenever there are octave dots.
   *
   * Uses the arc's whole bounding box bottom rather than solving the Bézier at
   * the barline's x: conservative, never intersects, and the barline loses at
   * most a hair more height than strictly necessary.
   */
  private clipBarlinesUnderSlurs(opt: LayoutOptions): void {
    if (this.slurTies.length === 0) return;
    const gap = opt.jpStackGap / 2;
    for (const e of this.entries) {
      if (!(e instanceof Barline)) continue;
      const x0 = e.group.x;
      const x1 = x0 + e.group.width;
      let top = e.group.y;
      for (const s of this.slurTies) {
        if (s.x + s.width < x0 || s.x > x1) continue;
        top = Math.max(top, s.y + s.height + gap);
      }
      e.clipTop(top);
    }
  }

  private addTie(opt: LayoutOptions): void {
    this.slurStyle = slurStyleOf(opt);
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const nt = e.chord.notes[0];
      if (!nt.tieStart) continue;
      const ent = this.chordEntry.get(nt.chord);
      if (!ent) {
        console.error("no entry for tied");
        continue;
      }
      const endCh = nt.tieNext?.chord;
      const endEntry = endCh ? this.chordEntry.get(endCh) : undefined;
      if (!endEntry) continue;
      const ypos = Math.min(this.tiedTop(e, opt, true), this.tiedTop(endEntry, opt, false));
      this.addSlurTie(nt, nt.tieNext!, ypos);
    }
  }
  // tiedTop/slurTop sit on the octave-dot ladder (NoteEntry.slurRung), plus one
  // more rung per element that has to pass underneath.
  private tiedTop(ent: NoteEntry, opt: LayoutOptions, left: boolean): number {
    let res = ent.slurRung(opt);
    const nt = ent.chord.notes[0];
    if (left) {
      if (nt.tupletBegin) res -= opt.jpDotRung;
    } else {
      if (nt.tupletEnd) res -= opt.jpDotRung;
    }
    return res;
  }
  private slurTop(ent: NoteEntry, opt: LayoutOptions, left: boolean): number {
    let res = ent.slurRung(opt);
    const nt = ent.chord.notes[0];
    if (left) {
      if (nt.tieStart) res -= opt.jpDotRung;
    } else {
      if (nt.tieEnd) res -= opt.jpDotRung;
    }
    if (nt.tupletEnd || nt.tupletBegin) res -= opt.jpDotRung;
    return res;
  }
  private addSlur(opt: LayoutOptions): void {
    this.slurStyle = slurStyleOf(opt);
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const nt = e.chord.notes[0];
      if (!e.chord.slurStart) continue;
      const endCh = e.chord.slurEndChord;
      const endEntry = endCh ? this.chordEntry.get(endCh) : undefined;
      if (!endEntry) continue;
      const ypos = Math.min(this.slurTop(e, opt, true), this.slurTop(endEntry, opt, false));
      const nb = endCh!.notes[0];
      this.addSlurTie(nt, nb, ypos);
    }
  }

  layout(width: number, height: number, opt: LayoutOptions): Group[] {
    this.lyricGap = opt.lyricGap;
    this.dropDoubledBarlines(opt);
    this.calcXPos();
    const lines = this.doLineBreak(width);
    // 段落词挂在**行末那个音符**上时，它标的其实是下一行的起句（「（副歌）」印在主歌
    // 最后一行的行尾没有意义，副歌是从下一行开始唱的）——挪到下一行行首那个音符上。
    // 锚点是按「第几个音符」记的，重排后的断行与原书不同，落到行末是常事（013 首）。
    for (let i = 0; i + 1 < lines.length; i++) {
      const notes = lines[i].entries.filter((e): e is NoteEntry => e instanceof NoteEntry);
      const last = notes[notes.length - 1];
      if (!last?.chord.sectionWord) continue;
      const next = lines[i + 1].entries.find((e): e is NoteEntry => e instanceof NoteEntry);
      if (!next || next.chord.sectionWord) continue;
      next.chord.sectionWord = last.chord.sectionWord;
      last.chord.sectionWord = null;
    }
    for (const l of lines) {
      this.updateXPos(l, width, opt);
      // 段落词要的那点地方**必须在画符杠/连音线/弧线之前**匀出来：那些东西的坐标
      // 是照音符位置算死的，之后再挪音符，减时线就跟音符错开了。
      l.nudgeForSectionWords(opt, width);
      l.addBeams(opt);
      l.addTuplet(opt);
      l.addTie(opt);
      l.addSlur(opt);
      // 和弦让位要排在 addSlur 之后（要弧的实际位置）、liftKeySigOverChords 与
      // addEnding 之前（转调标记按和弦位置避让、房号高度扫全行已画对象）。
      l.liftChordsUnderSlurs(opt);
      l.liftKeySigOverChords(opt);
      l.addEnding(opt);
      l.addSectionWords(opt, width);
      l.liftSectionWordsUnderSlurs(opt);
      l.clipBarlinesUnderSlurs(opt);
      l.updateLyricY(opt);
      l.group.normalizeY();
      l.group.update();
      l.addVerseNumbers(opt);
    }
    return this.layoutVertically(lines, opt, height);
  }

  private getEntry(ch: S.Chord): NoteEntry | null {
    return this.chordEntry.get(ch) ?? null;
  }

  addTuplet(opt: LayoutOptions): void {
    const tuplets = new Set<S.Tuplet>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const t = e.chord.notes[0].tuplet;
      if (!t) continue;
      tuplets.add(t);
    }
    const numberSize = opt.numberFont.size;
    for (const t of tuplets) {
      const start = this.getEntry(t.first.chord);
      if (!start) {
        console.error("no begin entry for tuplet");
        continue;
      }
      const end = this.getEntry(t.last.chord);
      if (!end) {
        console.error("no end entry for tuplet");
        continue;
      }
      const leftItem = start.entryItem() as JpNumber | null;
      const rightItem = end.entryItem() as JpNumber | null;
      // 三连音的两端得都有可画的音符项（休止/拖腔起头的那一端没有 JpNumber）
      if (!leftItem || !rightItem) {
        console.error("三连音有一端没有音符项，跳过");
        continue;
      }
      const left = leftItem.pos(this.group).x + leftItem.cx;
      let right = rightItem.pos(this.group).x + rightItem.cx;
      if (end.beginOfSlurTied) right -= opt.numberSize / 14;
      const width = right - left;
      // 括线与音符之间要留一道空（原来紧贴着音符墨迹顶，看着像长在数字上）
      const ypos = Math.min(start.entryTop(opt), end.entryTop(opt)) - opt.jpStackGap;
      // 竖脚比房号的短：房号线是整段乐句的括线，三连音只是三个音的括号
      //（原书量到的 bracketFootLen 5.3pt 主要来自房号；三连音照它画会高出一截）。
      const y = -(opt.bracketFoot > 0 ? opt.bracketFoot * 0.55 : numberSize * 0.25);
      const tupGrp = new Group();
      tupGrp.x = left;
      tupGrp.y = ypos;
      const path = new GraphicPath();
      // 线宽与「脚」长与房号括线同源（原书量的 bracket 那一类）
      path.strokeWidth = opt.bracketWidth > 0 ? opt.bracketWidth : 1;
      path.fill = false;
      path.stroke = true;
      path.strokeColor = opt.color;
      const txt = new SmuflText(opt);
      txt.color = opt.color;
      txt.text = GlyphCodes.tuplet3;
      // 数字要**按墨迹**与横线上下、左右都居中。这里自己拿 SMuFL 元数据算，
      // **不走 SmuflText.bound**：那个 bound 是从元数据直接换算的，y 轴还是 SMuFL 的
      // 「上为正」，与页面坐标反号（top/bottom 也因此对调）。拿它算墨迹中心会把数字
      // 往上推整整一倍墨迹高的一半（看着就是“飘在括线上方”）。
      // 按字号估偏移（0.28em 那种）同样不准——Bravura 的 tuplet 字形墨迹只占 em 的一小截。
      const box = opt.smuflMeta.getBBox(GlyphCodes.tuplet3);
      if (!box) throw new Error("no smufl bbox: tuplet3");
      const sp = txt.font.size / 4; // SMuFL：字号 = 4 个 staff space
      const inkCx = ((box.bBoxSW[0] + box.bBoxNE[0]) / 2) * sp;
      const inkCy = -((box.bBoxSW[1] + box.bBoxNE[1]) / 2) * sp; // 页面坐标上为负
      const inkHalfW = ((box.bBoxNE[0] - box.bBoxSW[0]) / 2) * sp;
      txt.x = width / 2 - inkCx;
      txt.y = y - inkCy;
      // 缺口按数字的**墨迹宽**开（原先写死的 numberSize/3 与字形无关，
      // 书级重排那一路的小字号下会宽出一大截空），两边各留一道约 0.15em 的气。
      const halfGap = inkHalfW + txt.font.size * 0.15;
      path.moveTo(0, 0);
      path.lineTo(0, y);
      path.lineTo(width / 2 - halfGap, y);
      path.moveTo(width, 0);
      path.lineTo(width, y);
      path.lineTo(width / 2 + halfGap, y);
      tupGrp.add(path);
      tupGrp.add(txt);
      this.group.add(tupGrp);
    }
  }

  /**
   * 房号（volta / ending）：`⌐1.` 那条横线 + 左端下垂 + 房号数字，画在音符上方。
   * 与五线谱同一套画法；行内画不完的房（跨行、或 `discontinue`）右端不封口。
   * 房的范围来自 `Measure.endingLeft/endingRight`，按**本行内**出现的那一段画。
   *
   * 高度与端点都照**文本谱那一路**的口径（`src/pu/layout.ts`，那边是按印刷原版做的）：
   *   - 横线走一条**全行统一的车道**，不按各房各自区间的墨迹顶算。原版里一房二房的横线
   *     是同一条高度（169 首曾因一房上方有和弦、二房没有而错开）；要让开下方内容时
   *     也是整行一起抬。
   *   - 端点**贴着两侧的小节线**，不贴房内首末音符。相邻两房之间隔着一条小节线的宽度，
   *     天然分得开（158 首的一房二房曾按音符各向外扩 0.35em、顶在一起）。
   */
  addEnding(opt: LayoutOptions): void {
    if (opt.endingSize <= 0) return;
    // 先把本行按小节切开（房的起止是**小节级**的）
    const segs: { m: S.Measure; notes: NoteEntry[] }[] = [];
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const m = e.chord.measure;
      const last = segs[segs.length - 1];
      if (last && last.m === m) last.notes.push(e);
      else segs.push({ m, notes: [e] });
    }
    // 本行的小节线**墨迹**左右缘（端点要贴着它们，见 Barline.inkLeft/inkRight）
    const barInk = this.entries
      .filter((e): e is Barline => e instanceof Barline)
      .map((b) => ({ left: b.group.x + b.inkLeft, right: b.group.x + b.inkRight }))
      .sort((a, b) => a.left - b.left);
    const spans: { num: string; notes: NoteEntry[]; closed: boolean; x0: number; x1: number }[] = [];
    let num: string | null = null;
    let notes: NoteEntry[] = [];
    const flush = (closed: boolean) => {
      if (num !== null && notes.length) {
        const sp = this.endingSpan(opt, num, notes, closed, barInk);
        if (sp) spans.push(sp);
      }
      num = null;
      notes = [];
    };
    for (const seg of segs) {
      if (seg.m.endingLeft) {
        flush(false);
        num = seg.m.endingNum && seg.m.endingNum.size ? [...seg.m.endingNum].sort((a, b) => a - b).join(".") + "." : "";
      }
      if (num === null) continue;
      notes.push(...seg.notes);
      // 房号线到**第一个** `<ending type=…>` 就收：`stop` 封口、`discontinue` 敞着。
      // 二房常写成「start + discontinue 在同一小节，逻辑上的 stop 在几小节之后」
      //（037《我尊崇祢》的二房 m9 就地 discontinue、m11 才 stop），
      // 线要在 m9 收住——跨过好几个小节的长横线是错的。
      if (seg.m.endingRight !== null) flush(seg.m.endingRight === S.StartStopDiscontinue.STOP);
    }
    flush(false); // 房跨到下一行：本行这一段不封口
    if (!spans.length) return;
    // **全行共用一个高度**：各房区间内所有已画对象的最高墨迹，取所有房里最高的那个。
    // 逐房各算就会错开（一房上方有和弦、二房没有）。
    let above = Infinity;
    for (const sp of spans) {
      for (const e of sp.notes) above = Math.min(above, e.group.pos(this.group).y);
      for (const it of this.group.children) {
        const l = it.pos(this.group).x;
        if (l + it.width < sp.x0 || l > sp.x1) continue;
        above = Math.min(above, it.pos(this.group).y);
      }
    }
    if (!Number.isFinite(above)) return;
    const drop = opt.bracketFoot > 0 ? opt.bracketFoot : opt.endingSize * 0.9;
    const top = above - opt.endingSize * 0.5 - drop;
    for (const sp of spans) this.drawEnding(opt, sp, top, drop);
  }

  /** 一段房的横向范围。端点贴**小节线**（找不到才退回按首末音符外扩）。 */
  private endingSpan(
    opt: LayoutOptions, num: string, notes: NoteEntry[], closed: boolean,
    barInk: { left: number; right: number }[],
  ): { num: string; notes: NoteEntry[]; closed: boolean; x0: number; x1: number } | null {
    const leftItem = notes[0].entryItem();
    const rightItem = notes[notes.length - 1].entryItem();
    if (!leftItem || !rightItem) return null;
    const noteL = leftItem.pos(this.group).x;
    const noteR = rightItem.pos(this.group).x + rightItem.width;
    // 贴小节线：起点取房内首音**之前**最近的那条，终点取末音**之后**最近的那条，各让一点气。
    // 相邻两房之间因此隔着一条小节线的宽度，不会再顶在一起（158）。
    // 起点贴前一条小节线的**右缘**、终点贴后一条的**左缘**，各让一点气。
    // 相邻两房之间因此隔着一条小节线的宽度，不会再顶在一起（158）。
    const gap = opt.endingSize * 0.12;
    const barBefore = [...barInk].reverse().find((b) => b.right <= noteL);
    const barAfter = barInk.find((b) => b.left >= noteR);
    const x0 = barBefore !== undefined ? barBefore.right + gap : noteL - opt.numberSize * 0.35;
    const x1 = barAfter !== undefined ? barAfter.left - gap : noteR + opt.numberSize * 0.35;
    if (x1 <= x0) return null;
    return { num, notes, closed, x0, x1 };
  }

  private drawEnding(
    opt: LayoutOptions,
    sp: { num: string; closed: boolean; x0: number; x1: number },
    top: number,
    drop: number,
  ): void {
    const grp = new Group();
    grp.x = sp.x0;
    grp.y = top;
    const lw = opt.bracketWidth > 0 ? opt.bracketWidth : opt.barlineWidth;
    const path = new GraphicPath();
    path.classes.add("ending-line"); // line-check 的 L10/L11 靠它认（见 browser.ts::CLS_TAGS）
    path.stroke = true;
    path.fill = false;
    path.strokeColor = opt.color;
    path.strokeWidth = lw;
    path.moveTo(0, drop);
    path.lineTo(0, 0);
    path.lineTo(sp.x1 - sp.x0, 0);
    if (sp.closed) path.lineTo(sp.x1 - sp.x0, drop);
    grp.add(path);
    if (sp.num) {
      const tf = new TextFrame();
      tf.classes.add("ending"); // 见 browser.ts::roleOfItem（归 verseNum 那一档，别当成音符）
      tf.font = opt.numberFont.makeWithSize(opt.endingSize);
      tf.color = opt.color;
      tf.text = sp.num;
      // 数字摆在竖脚**右侧**、横线**下方**，谁也不压谁（原书就是这么排的）
      tf.x = lw + opt.endingSize * 0.28;
      tf.y = lw + opt.endingSize * 0.95;
      tf.update();
      grp.add(tf);
    }
    this.group.add(grp);
  }

  /**
   * 段落词（「（副歌）」「（间奏）」）。原书印在**和弦那一带、与和弦同一条基线**，
   * 左右并排（`G（副歌）C` 这种）——落点由 `placeSectionWord` 定（与 spreadForSectionWords
   * 同一个判据、同一份代码，见那边的注释）。
   */
  addSectionWords(opt: LayoutOptions, lineWidth: number): void {
    if (opt.sectionWordSize <= 0) return;
    const size = opt.sectionWordSize;
    const font = opt.lrcFont.makeWithSize(size);
    const chords = this.chordBoxes();
    // 版心右缘：**优先用传进来的行宽**——`group.width` 只有 justify 过的行才有，
    // 末行常是 0，段落词就没人钳得住它（106 首末行那一条伸到了版心外 25pt）。
    const lineRight = lineWidth || this.group.width || Infinity;
    // 小节线的 x：段落词让位**不许跨过它们**（跨过去就成了下一小节的标记）
    const barXs = this.entries
      .filter((e): e is Barline => e instanceof Barline)
      .map((b) => b.group.x)
      .sort((a, b) => a - b);
    // 同一个 Chord 可能在一行里出现**好几个 NoteEntry**：长音的增时线各占一个，
    // 不展开叠排时（有反复房号的谱）整条谱行还会按遍数重复装载。
    // 段落词是挂在 Chord 上的，每个 Chord 只画一次，否则就叠出两三个「（副歌）」（131 首）。
    const drawn = new Set<S.Chord>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry) || !e.chord.sectionWord) continue;
      if (drawn.has(e.chord)) continue;
      drawn.add(e.chord);
      const item = e.entryItem();
      if (!item) continue;
      const tf = new TextFrame();
      tf.classes.add("section-word");
      tf.font = font;
      tf.color = opt.color;
      tf.text = e.chord.sectionWord;
      tf.update();
      // 量宽与笔位都按挤压后的来（见 sectionWordRun）；`charXs` 一路传到 `<text>` 的 `x`。
      const run = sectionWordRun(font, e.chord.sectionWord, opt.punctCompress);
      tf.width = run.width;
      tf.charXs = run.xs;
      // 段落词**可以横向伸出锚点音符的范围**（它只是个标记，原书也这么印），
      // 所以不为它撑开音符间距；能不能放下只看「本小节内有没有不撞和弦的空档」。
      const anchorX = e.group.x + item.x;
      const baseY = this.sectionWordBaseY(e, opt, chords);
      const place = (): SectionWordSlot => {
        const barLeftAt = [...barXs].reverse().find((bx) => bx <= anchorX);
        return placeSectionWord({
          anchorX,
          width: tf.width,
          size,
          baseY,
          chords,
          barLeft: barLeftAt ?? 0,
          barRight: barXs.find((bx) => bx > anchorX) ?? lineRight,
          hangLeft: sectionWordHangLeft(barLeftAt),
          rightLimit: lineRight,
          straddle: this.entries[0] === e,
        });
      };
      const slot = place();
      tf.x = slot.x;
      // 行首那一条永远不抬（口径如此）：匀不出地方也就贴着和弦，不上去占一层。
      tf.y = slot.lifted && this.entries[0] !== e ? baseY - size * 1.5 : baseY;
      this.group.children.push(tf);
      tf.parent = this.group;
    }
  }

  /** 本行已经排好的和弦盒子 {x0, x1, y}——段落词的落位与让位都照它算。 */
  private chordBoxes(): { x0: number; x1: number; y: number }[] {
    const out: { x0: number; x1: number; y: number }[] = [];
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      for (const it of this.chordGroups(e))
        out.push({ x0: e.group.x + it.x, x1: e.group.x + it.x + it.width, y: e.group.y + it.y });
    }
    return out;
  }

  /**
   * 行首段落词还差的那点地方——**从行内其它空档里匀**（justify 之后，行长不变）。
   *
   * 撑开（`spreadForSectionWords`）是在 justify 之前做的，那时的间距还是紧的，
   * 照它算出来的量偏大，而 justify 随后又把同一段空档拉开一遍，两笔叠起来就是
   * 音符右边那道大口子（173/175/189/193 的「（副歌）」，一处吃掉 16pt）。这里改在
   * **排完之后**按真实坐标补：锚点后面的东西右移「差的那一点」，位移沿行**线性衰减到 0**
   * （行末不动），于是那点量被后面二十来个空档各摊掉零点几 pt，眼睛看不出来，
   * 行也不会伸出版心。
   *
   * **必须在画符杠/连音线/弧线之前跑**：那些东西的坐标照音符位置算死，之后再挪音符，
   * 减时线就与音符错开了。
   */
  nudgeForSectionWords(opt: LayoutOptions, lineWidth: number): void {
    if (opt.sectionWordSize <= 0) return;
    const e = this.entries[0];
    if (!(e instanceof NoteEntry) || !e.chord.sectionWord) return;
    const item = e.entryItem();
    if (!item) return;
    const n = this.entries.length;
    if (n < 3) return;
    const font = opt.lrcFont.makeWithSize(opt.sectionWordSize);
    const anchorX = e.group.x + item.x;
    const chords = this.chordBoxes();
    const barXs = this.entries.filter((x): x is Barline => x instanceof Barline).map((b) => b.group.x).sort((a, b) => a - b);
    const slot = placeSectionWord({
      anchorX,
      width: sectionWordRun(font, e.chord.sectionWord, opt.punctCompress).width,
      size: opt.sectionWordSize,
      baseY: this.sectionWordBaseY(e, opt, chords),
      chords,
      barLeft: 0,
      barRight: barXs[0] ?? lineWidth,
      hangLeft: 0,
      rightLimit: lineWidth || this.group.width || Infinity,
      straddle: true,
    });
    if (!slot.lifted || slot.shortfall <= 0) return;
    const need = slot.shortfall;
    this.entries.forEach((ent, k) => { if (k > 0) ent.group.x += (need * (n - 1 - k)) / (n - 2); });
  }

  addBeams(opt: LayoutOptions): void {
    const groups = new Set<S.BeamGroup>();
    for (const e of this.entries) {
      if (!(e instanceof NoteEntry)) continue;
      const grp = e.chord.beamGroup;
      if (!grp) continue;
      groups.add(grp);
    }
    let maxLev = 0;
    for (const g of groups) {
      let level = 1;
      for (;;) {
        const pairs = new Map<NoteEntry, NoteEntry>();
        let start: NoteEntry | null = null;
        for (const ch of g.chords) {
          if (ch.beams < level) {
            start = null;
            continue;
          }
          if (start === null) start = this.getEntry(ch);
          if (start === null || this.getEntry(ch) === null) continue;
          pairs.set(start, this.getEntry(ch)!);
        }
        if (pairs.size === 0) break;
        maxLev = Math.max(maxLev, level);
        for (const [k, v] of pairs) {
          const l = new BeamLine(level, k, v, opt);
          this.beams.push(l);
          this.group.add(l);
        }
        level++;
      }
    }
    this.maxBeamLevel = maxLev;
  }

  updateLyricY(opt: LayoutOptions): void {
    let dy = opt.numberSize * 0.4;
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        const ey = e.entryBottom(opt);
        dy = Math.max(dy, ey);
      }
    }
    // 成书排版给定「歌词基线到音符基线」的定值时，按它来（减掉 addLyric 已经给的初值）：
    // 原书每一行的歌词都排在同一高度上，不管这一行有没有减时线、低音点；
    // 按自然栈高排会让带减时线的行把歌词推下去，行距忽大忽小。
    if (opt.lyricBaselineGap > 0) dy = opt.lyricBaselineGap - opt.numberFont.size;
    for (const e of this.entries) {
      if (e instanceof NoteEntry) {
        if (e.lrc === null) continue;
        // 一律**累加**：`lrc.y` 是相对 NoteEntry 组原点的偏移，组早已 update 归一过，
        // 直接赋绝对值会把歌词甩到音符行里去。叠排时各段一起挪，段间距在 addLyric 里给过了。
        for (const li of e.lrcs) li.y += dy;
      }
    }
  }

  /** 叠排时给每个视觉行的**行首**歌词挂段号（原书的「1.」「2.」…，悬在第一个字左边）。
   *  段号不能直接拼进歌词文本——那会把第一个字挤离它对位的音符。 */
  addVerseNumbers(opt: LayoutOptions): void {
    if (opt.lyricStack <= 0 || opt.verseNumbers === "never") return;
    if (opt.verseNumbers === "auto") {
      // 「自动」：段数少的时候不标——两三段的谱一眼就看得清哪行是哪段，
      // 标了反而在每行行首多出一串 1. 2. 3.。段数多了才需要它带路。
      let verses = 0;
      for (const e of this.entries) if (e instanceof NoteEntry) verses = Math.max(verses, e.lrcs.length);
      if (verses <= opt.verseNumberAutoMin) return;
    }
    let atLineStart = true;
    for (const e of this.entries) {
      if (e instanceof LineBreak) {
        atLineStart = true;
        continue;
      }
      if (!(e instanceof NoteEntry) || e.lrcs.length < 2) continue;
      if (!atLineStart) continue;
      atLineStart = false;
      // **挂在行上、用绝对坐标**：挂进 NoteEntry.group 的话，随后的 update() 会把
      // 段号那点负 x 归一掉（首字被挤走、段号压在首字上）。
      // 本方法因此排在 group.update() 之后，此时各 entry 的位置已经定稿。
      for (let k = 0; k < e.lrcs.length; k++) {
        const li = e.lrcs[k];
        if (!li.text) continue;
        const tag = new TextFrame();
        tag.font = opt.lrcFont;
        tag.color = opt.color;
        tag.text = `${k + 1}.`;
        tag.update();
        tag.x = e.group.x + li.x - tag.width;
        tag.y = e.group.y + li.y;
        this.group.children.push(tag);
        tag.parent = this.group;
      }
    }
  }

  connectTextFrames(): void {
    const lrcs: Lyric[] = [];
    const numbers: TextFrame[] = [];
    for (const it of this.entries) {
      if (it instanceof Barline) {
        const tf = it.group.children[0];
        if (tf instanceof TextFrame) numbers.push(tf);
      }
      if (!(it instanceof NoteEntry)) continue;
      if (it.lrc) lrcs.push(it.lrc);
      if (it.number) numbers.push(it.number);
    }
    lrcs.forEach((it, idx) => {
      it.previous = getOrNull(lrcs, idx - 1);
      it.next = getOrNull(lrcs, idx + 1);
    });
    numbers.forEach((it, idx) => {
      it.previous = getOrNull(numbers, idx - 1);
      it.next = getOrNull(numbers, idx + 1);
    });
  }

  /** `skip`：跳过本小节开头这么多个和弦（弱起式接入，见 PlayItem.skip）。
   *  `limit`：只装载前这么多个和弦（-1 = 整节，见 PlayItem.limit）；截断时不补小节线。 */
  load(m: S.Measure, lrc: number, options: LayoutOptions, final: boolean, skip = 0, limit = -1): void {
    if (m.timeChange && m.index !== 0) {
      const ts = TimeSig.fromTime(m.time, options);
      this.entries.push(ts);
    }
    if (m.keyChange && m.index !== 0) {
      const key = new KeySig(m.key, options);
      const first = m.entries[0];
      if (first instanceof S.Chord) {
        if (first.slurStart) key.group.y -= options.numberSize / 4;
      }
      this.entries.push(key);
    }
    // 小节**开头**的反复起点 `‖:`（MusicXML 的 `<barline location="left">`）。
    // 小节线本来只在小节末补，这里要额外插一条——五线谱怎么标，简谱就怎么标。
    if ((m.repeatForward || m.leftBarline !== null) && skip === 0) {
      const ent = new Barline(false, options, { style: m.leftBarline, repeatForward: m.repeatForward });
      ent.update();
      this.entries.push(ent);
    }
    let hasBarline = limit >= 0; // 截断的小节尾不补小节线（下一段接着唱同一小节）
    let taken = 0;
    for (const ch of m.entries) {
      if (limit >= 0 && taken >= limit) break;
      if (ch instanceof S.LineBreak) {
        const ignore = ch.pass !== null && ch.pass !== lrc;
        if (!ignore) {
          const br = new LineBreak();
          br.newPage = ch.newPage;
          this.entries.push(br);
        }
        continue;
      } else if (ch instanceof S.Chord) {
        if (skip > 0) { skip--; continue; }
        NoteEntry.fromChord(this.entries, ch, lrc, options);
        taken++;
      } else if (ch instanceof S.BarlineEntry) {
        const ent = new Barline(final, options, { style: m.barline, repeatBackward: m.repeatBackward });
        ent.update();
        this.entries.push(ent);
        hasBarline = true;
      }
    }
    if (!hasBarline) {
      const ent = new Barline(final, options, { style: m.barline, repeatBackward: m.repeatBackward });
      ent.update();
      if (this.entries[this.entries.length - 1] instanceof LineBreak) {
        this.entries.splice(this.entries.length - 1, 0, ent);
      } else {
        this.entries.push(ent);
      }
    }
  }
}

// ---------------- options / CJK util ----------------

export class LayoutOptions {
  static charBound(font: Font, ch: string): Rect {
    return font.charBound(ch);
  }

  color = Colors.black;
  lrcFont: Font;
  numberFont: Font;
  smuflFont: Font;
  smuflMeta = new MetaData();
  titleSize = 48;
  creditSize = 36;

  smuflAsPath = false;
  /** 和弦符号的字号与它到音符墨迹上缘的距离。0 = 不排和弦（默认：编辑器与 OMR 那两条路
   *  的 Score 里本来就没有 harmony，排了也不会变，但留一道闸更明确）。 */
  chordSize = 0;
  /** 段落词（「（副歌）」）的字号。0 = 不排（编辑器与 OMR 那两条路的 Score 里没有这东西）。 */
  sectionWordSize = 0;
  chordGap = 0;
  /** 歌词基线到音符基线的距离。0 = 用引擎自算的（贴着音符下方的减时线/低音点）。
   *  成书排版给原书量到的定值，让每一行的歌词都排在同一高度上；
   *  某一行的栈比它还深时仍按栈走（**只放大不缩小**，不会压到减时线上）。 */
  lyricBaselineGap = 0;
  /** 相邻歌词字之间的**最小间隙**。0 = 字紧挨着字（引擎老行为：只保证不重叠）。
   *  印刷歌本的歌词字之间是有呼吸的（原书量到的步距 ≈ 字宽 × 1.32），
   *  不留这道间隙，排版器会以为一行塞得下三十几个字、把整段挤成密不透风的一行
   *  （001《圣哉，圣哉，圣哉》曾因此排成 2 行、字距 9.1pt 小于 11.8pt 的字宽）。 */
  lyricGap = 0;
  /** 反复点的半径。0 = 按小节线宽推算。成书排版给原书量到的值（metrics.repeatDotDiam）。 */
  repeatDotRadius = 0;
  /** 房号（1./2.）的字号。0 = 不画房号。 */
  endingSize = 0;
  /** 歌词段号（行首的 `1.` `2.`）标不标：
   *  `always` 一律标（编辑器那条路的老行为）、`never` 一律不标、
   *  `auto` = 段数多于 `verseNumberAutoMin` 才标。 */
  verseNumbers: "always" | "never" | "auto" = "always";
  /** `auto` 的门槛：段数**多于**这个数才标段号。默认 3（三段以内不标）。 */
  verseNumberAutoMin = 3;
  /** 转拍号那条分数线的粗细。0 = 用引擎默认的 1.5（编辑器那条路不变）。 */
  timeSigRuleWidth = 0;
  /** 房号/三连音括线的线宽与「脚」（下垂那一小段）的长度。0 = 按字号推算。 */
  bracketWidth = 0;
  bracketFoot = 0;
  /** 多段歌词的排法：0 = **逐段重复整条谱行**（jpword/musicpp 的老行为，流行敬拜谱常见）；
   *  >0 = **一行谱下叠多行词**（传统圣诗本的排法，原书 500 首就是这样），值为段间行距。
   *  只在「无反复、纯多段」（PlayData.isSimpple）的曲子上生效——有反复房号的谱
   *  每一遍的谱面本来就不同，叠不到一起。 */
  lyricStack = 0;
  /** 歌词标点挤压的档（见 common/cjkpunct.ts::CompressMode）。
   *
   *  默认 `halfwidth`：**简谱歌词的标点不占音符格**，原书印的就是压缩形。
   *  换成 CLREQ 的上下文挤压（孤立标点占满一格）会把音符间距整排撑开——
   *  实测全书 655 → 695 页，定点断言里 459/363/355/446 的规整分行全都排不出来。
   *  中文**正文**（注解、目录、索引、前言）不受此限，那条路走 `clreq`，见 bookparts.ts。
   *
   *  **原来这里是 `halfWidthPunct = true`**：把 `。，、？！：；` 换成 U+FF61 系半角**字符**。
   *  字符替换的账很难算——印刷字库多半没有那些码位（PDF 端要换回全角、line-check 的 V2
   *  因此跳过 121 处），半角 `,` 又是西文逗号、不在中文逗号该在的位置。挤压是**排版**的事，
   *  不该改内容里的字，所以改成压 advance（字体有 `halt` 就交给字体）。 */
  punctCompress: CompressMode = "halfwidth";
  ignoreVerseNumber = true;
  slurTieThickness = 6; // musicpp render.cpp:1076 (`lw0 = 6/cos`)，按 fontSize≈28 调
  /** 弧高与弧描边宽。同样是按 fontSize≈28 调出来的绝对值，换字号排版要跟着缩。 */
  slurHeightScale = 1;
  slurOutlineWidth = 0.7;
  /** 弧高的**上限**（未乘 slurHeightScale 的原始像素口径；贝塞尔的弧顶约为它的 0.75）。
   *  对数公式没有上限，长跨度的弧会一路长到顶掉上方的和弦符号：28px 字号下实测
   *  跨度 30px 的弧顶 6.6px、跨度 218px 的弧顶 17.8px，差 2.7 倍。
   *  18 = 典型跨度（3 个音符步距、dist≈100）的弧高，也就是「长弧最多长到典型那么高」，
   *  短弧（跨度 < 100px，两三个音符）一点不受影响。<=0 = 不封顶（老行为）。 */
  slurMaxHeight = 18;
  /** 弧高的**下限**（同一口径）。公式在短跨度上塌得很快（dist=20px 时弧顶只剩 4.6px），
   *  短弧几乎成了一条直线。open-fanqie 没有短弧特例——它的弧高**恒定** 10px，短弧自然不塌；
   *  这里取 10（弧顶 7.5px，与它同量级），影响的只有跨度 < 35px 的那批。<=0 = 只用公式自带的 1.2。 */
  slurMinHeight = 10;
  /** 跨度超过它就改画**扁平长连音线**（两端小钩 + 水平细线，见 SlurTieBase.initFlat）。
   *  0 = 按字号自动取 `numberSize * 5`（28px → 140px，约 4 个音符，
   *  与 open-fanqie 的 100px 阈值同一量级）。<0 = 一律画弧。 */
  slurFlatSpan = 0;
  /** 扁平长连音线**中段**的墨迹厚度（两端收尖）。0 = `slurTieThickness * 0.45`。 */
  slurFlatWidth = 0;
  /** 小节线粗细。musicpp lineWidths.lightBarline / heavyBarline（pptutil.cpp:139），
   *  同样是按 fontSize≈28 调出来的绝对值——换字号排版时要等比缩，否则小节线相对字会变粗。 */
  barlineWidth = 2;
  finalBarlineWidth = 3.5;
  staffDist = 0;
  marginTop!: number;
  marginBottom!: number;
  marginLeft = 50;
  /** 右边距。默认与 marginLeft 相同（原来左右共用一个值）；成书排版要对开页镜像时分开给。 */
  marginRight = 50;
  /** 页面装饰：`song` = 每页底部印「曲名 + 第 i/n 页」（编辑器/单曲预览的老行为）；
   *  `none` = 什么都不印，页眉页脚由整本合成那一层统一加（见 rebuild.mjs）。 */
  pageFurniture: "song" | "none" = "song";
  maxLineDist!: number;
  maxHorizontalScale = 2.0;
  jpBeamDist!: number;

  // --- jianpu vertical grid ---------------------------------------------
  // Everything stacked above (and below) a jianpu digit — octave dots, the
  // slur/tie arc, the tuplet bracket — is separated by ONE gap, `jpStackGap`,
  // measured ink-to-ink. So digit→dot, dot→dot and dot→slur are all equal and
  // the stack reads as an even ladder.
  //
  // musicpp is *not* even here: it steps the dots by `octaveDotDist = 6` but
  // lifts the slur a further 6 per dot from a different origin
  // (render.cpp:906 vs model.cpp:2649), giving ~6.4px digit→dot against
  // ~2.3px dot→slur at this font size. Its absolute slur height is still a
  // good sanity check: with one octave dot the ladder below lands within
  // 0.1px of it.
  //
  // (Before this, the project mixed three unrelated steps —
  // `dotBound.height*1.5` ≈ 4.2px, `numberSize/8` = 3.5px and
  // `numberSize/2` = 14px.)
  jpStackGap!: number;
  /** Baseline → first beam (减时线). musicpp draws level 0 at y=35 with the
   * digit baseline at 30 (render.cpp:161, and processLevelJp's `lev >= cnt`
   * makes the level 0-based), i.e. 5 units at jianpuFont 30 = 1/6 em.
   * Without it the first beam sat at `jpBeamDist` (1/8 em) and crowded the
   * digit, more so once the stroke widened to musicpp's 1.5. */
  jpBeamTop!: number;
  jpBeamWidth = 1.5; // musicpp lineWidths.jpBeam (pptutil.cpp:138)

  /** One rung of the stack: a dot plus the gap above it. Also the amount by
   * which anything that must clear a slur (a second arc, a tuplet bracket)
   * steps up. */
  get jpDotRung(): number {
    return this.jpStackGap + this.numberBound(".").height;
  }

  /** Bottom edge of the lowest of `n` beams, or the digit baseline if n = 0.
   * Low octave dots hang one `jpStackGap` below this, mirroring the top side. */
  jpBeamBottom(n: number): number {
    if (n <= 0) return 0;
    return this.jpBeamTop + this.jpBeamDist * (n - 1) + this.jpBeamWidth / 2;
  }

  constructor(public fontSize: number) {
    // Original used 苹方-简 / Microsoft YaHei; in the webview we rely on the
    // system CJK font via a CSS stack.
    const cjk = "PingFang SC, Microsoft YaHei, sans-serif";
    this.lrcFont = new Font(cjk, fontSize);
    this.numberFont = new Font(cjk, fontSize);
    this.smuflFont = new Font("Bravura", fontSize);
    this.applyFontSize(fontSize);
  }

  /** 由字号派生的那几个间距。构造时算一次；成书排版会在之后按 BookStyle 逐项覆盖
   *  （见 src/pdflayout/browser.ts::applyBookStyle）——**默认值必须原样保持**，
   *  编辑器与 OMR 那两条路的观感不能变。 */
  applyFontSize(fontSize: number): void {
    this.fontSize = fontSize;
    this.marginTop = fontSize * 1.5;
    this.marginBottom = fontSize * 3;
    this.maxLineDist = fontSize * 0.75;
    this.jpBeamDist = fontSize / 8;
    this.jpStackGap = fontSize / 6;
    this.jpBeamTop = fontSize / 6; // musicpp 35 − baseline 30, at jianpuFont 30
  }

  get lrcSize(): number {
    return this.lrcFont.size;
  }
  set lrcSize(v: number) {
    this.lrcFont = this.lrcFont.makeWithSize(v);
  }
  get numberSize(): number {
    return this.numberFont.size;
  }
  set numberSize(v: number) {
    this.numberFont = this.numberFont.makeWithSize(v);
  }

  /** Tight glyph box of a jianpu number/dot. Was measured on `lrcFont`, which
   * is a no-op only as long as the two fonts stay identical (they do today,
   * but `lrcSize` is settable) — the numbers are drawn with `numberFont`. */
  numberBound(ch: string): Rect {
    return LayoutOptions.charBound(this.numberFont, ch);
  }

  /**
   * Vertical extent of barlines and time signatures, relative to the digit
   * baseline. musicpp spans the whole 40-unit jianpu staff at jianpuFont 30
   * (render.cpp:802, :1793): 1.0em above the baseline — which is exactly the
   * high octave-dot row — down to 0.333em below, the low octave-dot row.
   * This project used 23/28 and 5/28, a third shorter, whose lower edge did
   * not even reach the first low octave dot.
   */
  get jpStaffTop(): number {
    return -this.numberSize;
  }
  get jpStaffBottom(): number {
    return this.numberSize / 3;
  }
}

export class Layout {
  options: LayoutOptions;
  pages: Group[] = [];
  constructor(public fontSize: number) {
    this.options = new LayoutOptions(fontSize);
  }

  private parseBreakDur(s: string): Map<string, number> {
    const pgs = s.replace(/\|/g, "\n").replace(/\./g, " ").split("\n");
    const res = new Map<string, number>();
    let last = new Fraction(0);
    for (const pg of pgs) {
      if (pg.length === 0) continue;
      const lines = pg.split(" ");
      for (const it of lines) {
        if (it.trim().length === 0) continue;
        let str = it.trim();
        let v = 1;
        if (str.includes("{")) {
          v = 0;
          str = str.replace(/\{/g, "").replace(/\}/g, "");
        }
        const dur = Fraction.fromString(str);
        last = last.plus(dur);
        res.set(last.toString(), v);
      }
      res.set(last.toString(), 2);
    }
    return res;
  }

  durationInfo(s: string, total: Fraction, pass: number | null): Map<string, number> {
    const durInfo = new Map<string, number>();
    const ss = substringAfter(s, "=").trim();
    if (s.includes("LinesPerPage")) {
      const arr = ss.split("|").map((x) => parseInt(x, 10));
      const lineCnt = arr.reduce((a, b) => a + b, 0);
      const dur = total.divInt(lineCnt);
      let pos = new Fraction(0);
      for (const it of arr) {
        for (let i = 0; i < it; i++) {
          const v = i === it - 1 ? 2 : 1;
          pos = pos.plus(dur);
          durInfo.set(pos.toString(), v);
        }
      }
    } else {
      for (const [k, v] of this.parseBreakDur(ss)) durInfo.set(k, v);
    }
    if (pass !== null) {
      const keys = [...durInfo.keys()];
      for (let i = 1; i < pass; i++) {
        for (const k of keys) {
          const t = Fraction.fromString(k).plus(total.timesInt(i));
          durInfo.set(t.toString(), durInfo.get(k)!);
        }
      }
    }
    return durInfo;
  }

  breakByDur(l: Line, s: string, total: Fraction, pass: number | null): void {
    const durInfo = this.durationInfo(s, total, pass);
    let tick = new Fraction(0);
    const newEnt: Entry[] = [];
    let lineBeg = 0;
    let lastChord: S.Chord | null = null;
    let lastTick: Fraction | null = null;
    for (const e of l.entries) {
      let isNote = false;
      let end = tick;
      if (e instanceof NoteEntry) {
        const ch = e.chord;
        if (ch !== lastChord) {
          isNote = true;
          end = end.plus(ch.duration!);
          lastChord = ch;
        }
      }
      let doBreak = durInfo.has(tick.toString());
      if (!(isNote || e instanceof KeySig)) doBreak = false;
      if (lastTick !== null && lastTick.equals(tick)) doBreak = false;
      if (doBreak) {
        if (durInfo.get(tick.toString()) === 0) {
          while (newEnt.length > lineBeg) newEnt.splice(lineBeg, 1);
        } else {
          const br = new LineBreak();
          br.newPage = durInfo.get(tick.toString()) === 2;
          newEnt.push(br);
          lineBeg = newEnt.length;
        }
        lastTick = tick;
      }
      newEnt.push(e);
      tick = end;
    }
    l.entries = newEnt;
  }

  /**
   * **只量不排**：把整首装成一条 Line，返回每个和弦的自然横向区间与版心宽度。
   *
   * 给「一行放不放得下」用（`applybreaks.ts::FitMetric`）。与 `fromScore` 共用同一套
   * 装载逻辑（`buildLine`），量到的坐标就是排版器折行时用的那一套。
   */
  measureNatural(scr: S.Score, width: number): { width: number; spans: Map<S.Chord, { x0: number; x1: number }> } {
    const cw = width - this.options.marginLeft - this.options.marginRight;
    const l = this.buildLine(scr, null);
    l.connectTextFrames();
    return { width: cw, spans: l.naturalSpans(this.options) };
  }

  /** 把整首装成一条 Line（分行之前的那一条）。`fromScore` 与 `measureNatural` 共用。 */
  private buildLine(scr: S.Score, dur: string | null): Line {
    const p = scr.parts[0];
    if (dur !== null) scr.clearSystemBreak();
    const l = new Line();
    let repMeasures = scr.playData.measures;
    // 叠排 = **按原谱排一遍**：不展开任何反复。
    //
    // 反复本来就是用记号表示的（`‖:` `:‖`、房号、D.S.），原书 500 首就是印一遍谱 +
    // 记号 + 底下叠几段歌词。而 playData 是给**试听**用的展开序列：多段歌词在那里被摊成
    // 好几遍，064《啊！圣善夜》甚至摊成 10 遍——照着它排，一首歌能排出十几页。
    if (this.options.lyricStack > 0) {
      repMeasures = p.measures.map((_, i) => {
        const it = new S.PlayItem();
        it.mid = i;
        it.end = i + 1;
        it.pass = 0;
        it.skip = 0;
        it.limit = -1;
        it.endOfPass = false;
        return it;
      });
    }
    repMeasures.forEach((it, idx) => {
      for (let mid = it.mid; mid < it.end; mid++) {
        const m = p.measures[mid];
        const pass = it.pass;
        m.autoBeamGroup();
        const final = mid === it.end - 1 && idx === repMeasures.length - 1;
        l.load(
          m, pass, this.options, final,
          mid === it.mid ? it.skip : 0,
          mid === it.end - 1 ? it.limit : -1,
        );
      }
      if (it.endOfPass && dur === null) {
        const lst = l.entries[l.entries.length - 1];
        if (!(lst instanceof LineBreak)) l.entries.push(new LineBreak());
        (l.entries[l.entries.length - 1] as LineBreak).newPage = true;
      }
    });
    if (dur !== null) {
      const part = scr.parts[0];
      const mea = part.measures[part.measures.length - 1];
      const total = mea.position.plus(mea.duration);
      let pass: number | null = null;
      if (scr.playData.isSimpple) pass = scr.playData.measures.length;
      this.breakByDur(l, dur, total, pass);
    }
    return l;
  }

  fromScore(scr: S.Score, dur: string | null, width: number, height: number): void {
    this.pages = [];
    const cw = width - this.options.marginLeft - this.options.marginRight;
    const ch = height - this.options.marginTop - this.options.marginBottom;
    const l = this.buildLine(scr, dur);
    l.connectTextFrames();
    for (const g of l.layout(cw, ch, this.options)) this.pages.push(g);
    this.titleAndPageNumber(scr.title, width, height, cw);
  }

  titleAndPageNumber(title: string, width: number, height: number, cw: number): void {
    if (this.options.pageFurniture === "none") {
      // 成书：页眉页脚由整本那一层按书页码统一加，这里印「第 i/n 页」只会打架
      for (const pg of this.pages) pg.x += this.options.marginLeft;
      return;
    }
    this.pages.forEach((pg, idx) => {
      pg.x += this.options.marginLeft;
      const tf = new TextFrame();
      tf.font = this.options.lrcFont.scaled(0.8);
      tf.text = title.split("\n")[0];
      tf.color = this.options.color;
      tf.x = (cw - tf.measureText()) / 2;
      tf.y = height - this.options.marginBottom * 0.5 - pg.y;
      tf.update();
      const tf1 = new TextFrame();
      tf1.text = `${idx + 1}/${this.pages.length}`;
      tf1.color = this.options.color;
      tf1.x = 0.8 * width;
      tf1.y = tf.y;
      tf1.font = tf.font;
      tf1.update();
      pg.add(tf);
      pg.add(tf1);
    });
  }
}

function substringAfter(s: string, delim: string): string {
  const i = s.indexOf(delim);
  return i < 0 ? s : s.substring(i + delim.length);
}
