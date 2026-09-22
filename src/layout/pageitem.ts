// Ported from mp/layout/layout.kt. Pure model + geometry; SVG emission lives in
// painter.ts. Skija Path/Canvas/Font replaced by GraphicPath command lists,
// the common geom types, and the Font abstraction (measurement via SVG/canvas).

import { jpDot } from "./jpglyph";
import { Point, Rect, Matrix33, newMatrix, Colors } from "../common/geom";
import { pathTightBounds } from "../common/measure";
import { LYRIC_SPLIT_PUNCT, type CompressMode } from "../common/cjkpunct";
import { Font } from "./font";
import { MetaData } from "../smufl/smufl";
import type { LayoutOptions } from "./options";

export function getOrNull<T>(arr: T[], i: number): T | null {
  return i >= 0 && i < arr.length ? arr[i] : null;
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
  /**
   * 紧包围盒，**页面坐标**（y 向下为正，`top` 在上、负值在基线之上）。
   *
   * ⚠ SMuFL 元数据的 `bBoxNE/SW` 是**乐谱坐标**：y **向上为正**，NE 是墨迹**上**缘、
   * SW 是**下**缘。这里翻过来对齐 `PageItem.bound` 的口径（`Rect(left, top, right, bottom)`），
   * 不然 `Group.update()` / `childrenBound` 会把整个记号的盒子摆到基线下方一截，
   * 凡是拿它做避让的都会多让三四个点——fermata（302）、重音（470）、Segno（064）
   * 全踩过这个坑，`addTuplet` 当年干脆绕开它自己读元数据。
   */
  override get bound(): Rect {
    const first = this.text[0];
    const box = this.meta.getBBox(first);
    if (!box) throw new Error("no smufl bbox");
    const sp = this.font.size / 4; // SMuFL：字号 = 4 个 staff space
    const l = box.bBoxSW[0] * sp;
    const r = box.bBoxNE[0] * sp;
    return new Rect(l, -box.bBoxNE[1] * sp, r, -box.bBoxSW[1] * sp);
  }
}

/**
 * 八度点 —— **一个实心矢量圆**，不是字体里的 `.` 字形。
 *
 * 三条简谱路统一走 `jpglyph.ts::jpDot`（文本谱本来就是自绘的，谱面与混排原先用
 * `.`／`·` 字形——同一个点三种画法，还得各自补一道「按墨迹而非 advance 居中」的修正）。
 * 圆没有这个问题：局部包围盒恒为 (0,0)–(2r,2r)，调用点照旧 `x − width/2` 居中即可。
 *
 * `update()` / `bound` 都按解析式给，**不走 `computeTightBounds`**——那是一次
 * `<path>`.getBBox 的 DOM 测量，全书几万个八度点经不起。
 */
export class JpOctaveDot extends GraphicPath {
  readonly radius: number;
  /** 这个圆是**附点**的话，记下它挂在哪个数字上、是第几个。
   *  只有 `editor/pptx.ts` 用得着：那边要按目标字体的数字宽把附点重新摆一遍
   *  （八度点锚在 `JpNumber.cx` 上，本来就跟着走，不需要）。 */
  aug: { num: JpNumber; index: number } | null = null;
  constructor(r: number, color: number) {
    super();
    this.selectable = true;
    this.radius = r;
    this.segs = jpDot(r, r, r, color).segs;
    this.fill = true;
    this.stroke = false;
    this.fillColor = color;
    this.width = 2 * r;
    this.height = 2 * r;
  }
  override update(): void {
    this.width = 2 * this.radius;
    this.height = 2 * this.radius;
  }
  override get bound(): Rect {
    return new Rect(0, 0, 2 * this.radius, 2 * this.radius);
  }
}

export class JpNumber extends TextFrame {
  /** 附点是画上去的矢量圆、不在文本里（见 `NoteEntry.addAugDots`），可横向间距还得
   *  照原来那样给它留出位置——这里记的就是那几个 `·` 的 advance。 */
  augDotAdvance = 0;
  constructor() {
    super();
    this.selectable = true;
  }
  override update(): void {
    super.update();
    this.width += this.augDotAdvance;
  }
  get left(): number {
    return this.measureText(0, 1) / 2;
  }
  get right(): number {
    return this.measureText(0, 1) / 2 + this.measureText(1) + this.augDotAdvance;
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
    if (this.text.endsWith("·")) end--; // 附点早已不写进文本了，留着这道兜底不碍事
    return this.measureText(0, end);
  }
  override get bound(): Rect {
    const bnd = this.font.charBound(this.text[0]);
    return new Rect(0, bnd.top, this.width, bnd.bottom);
  }
}

export class Lyric extends TextFrame {
  _widths = [0, 0, 0];
  /** 标点挤压的档（`LayoutOptions.punctCompress`）。 */
  compress: CompressMode = "halfwidth";
  /** 段号（`JLyric.number`）。可视化编辑按它认出点中的是哪一段（叠排时各段同在一个音符格里） */
  verse = 0;
  constructor() {
    super();
    this.selectable = true;
    this.classes.add("lyric"); // 页面检查（scripts/page-check.mjs）靠它认歌词——构建会压缩类名，instanceof 用不上
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
    return Math.max(0, this.width - (upto + this.font.charBound(last).right));
  }
  /** 首字左侧的留白（墨迹离本条歌词的落笔点多远）。`“` 这种标点的墨只占方框右半边。
   *  **要从挤压后的笔位起算**：半角档下前引号的笔位已经左挪了半格（墨正好落在格内左半），
   *  照字形的 inkLeft 算就把这半格又算了一遍，避让时凭空多出半格空档，
   *  上一个字的尾标点就被压住了（076「说：」压「“忠」、159 两处、376「召：」压「“将」）。 */
  get headBlank(): number {
    const t = this.text;
    if (!t) return 0;
    const pen = this.charXs?.[0] ?? 0;
    return Math.max(0, pen + this.font.charBound([...t][0]).left);
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
  /** **这一条**强制走扁平式（按弧覆盖的音符个数判，见 `Line.addSlurTie`）。 */
  forceFlat?: boolean;
  /** 弧的**宽高比**（跨度 ÷ 弧顶高）超过它就改画扁平式。<=0 或省略 = 不看这一条。
   *  跨度阈值是绝对宽度，跟不上字号与弧高上限的变化；宽高比才是「这条弧看着扁不扁」。 */
  flatRatio?: number;
  /** 扁平式**中段**的墨迹厚度（两端一样收尖）。省略 = `thickness * 0.45`。 */
  flatLineWidth?: number;
  /**
   * 弧的开口朝向。默认 `"up"`——**简谱的弧一律在音符上方、开口朝下**，
   * 三条简谱路（编辑器 / 成书重排 / 文本谱）都不设它。
   * `"down"` 只给混排的五线谱层用：那里 slur/tie 跟着符干走，符干朝上时弧在音符下方。
   */
  side?: "up" | "down";
  /**
   * 中间挖掉 `[x0, x1]` 这一截（页面 x），只画两头——三连音的「两段弧」风格（数字坐在断口里，
   * 见 `Line.addTuplet`）。切的是**同一条月牙**，所以音符那一端照样收尖、断口处是弧中段的厚度，
   * 与同页的 slur 同一套形状语言，不另画等宽线。有 gap 时一律画弧，不走扁平式。
   */
  gap?: { x0: number; x1: number };
}

/** 三次贝塞尔在 `[a, b]` 这一段（de Casteljau 切两刀）。 */
function bezierSeg(p: readonly [Point, Point, Point, Point], a: number, b: number): [Point, Point, Point, Point] {
  const lerp = (u: Point, v: Point, t: number): Point => new Point(u.x + (v.x - u.x) * t, u.y + (v.y - u.y) * t);
  const split = (q: readonly [Point, Point, Point, Point], t: number): [[Point, Point, Point, Point], [Point, Point, Point, Point]] => {
    const p01 = lerp(q[0], q[1], t), p12 = lerp(q[1], q[2], t), p23 = lerp(q[2], q[3], t);
    const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
    const m = lerp(p012, p123, t);
    return [[q[0], p01, p012, m], [m, p123, p23, q[3]]];
  };
  const head = b >= 1 ? [p[0], p[1], p[2], p[3]] as [Point, Point, Point, Point] : split(p, b)[0];
  return a <= 0 ? head : split(head, a / b)[1];
}

/** 三次贝塞尔上 x 取 `x` 的参数 t（x(t) 单调时二分；弧线两端同高，天然单调）。 */
function bezierTAtX(p: readonly [Point, Point, Point, Point], x: number): number {
  const xAt = (t: number): number => {
    const u = 1 - t;
    return u * u * u * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t * t * t * p[3].x;
  };
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (xAt(mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export abstract class SlurTieBase extends Group {
  /**
   * 走了**扁平长连音线**那条路时，两端那个钩的水平长度（`initFlat` 的 `hx`）；画成弧的是 0。
   *
   * 上方带堆叠要拿它算「这一段 x 上墨迹到底多高」（`Line.collectBandItems` 的 `topAt`）：
   * 弧的墨迹按抛物线两头低、中间高，扁平式却是**中段一路平着、只有两端 hx 那截往下收**
   * ——照抛物线算，落在末端附近的 fermata 会被判成「那儿的弧几乎贴着音符」而不让位，
   * 于是压在扁平线上（171《回家吧》末行的延长号）。
   */
  flatHx = 0;
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

  static calcSlurPoints(pl: Point, pr: Point, o: Pick<SlurStyle, "heightScale" | "maxHeight" | "minHeight" | "side"> = {}): [Point, Point, number] {
    const xr = pr.x, xl = pl.x, yr = pr.y, yl = pl.y;
    const dx = xr - xl, dy = yr - yl;
    const square = dx * dx + dy * dy;
    const dist = Math.sqrt(square);
    const theta = Math.atan2(dy, dx);
    const cos = Math.cos(-theta);
    const sin = Math.sin(-theta);
    const xlen = Math.min(dist * 0.04 + 10, dist * 0.25);
    // 页面坐标 y 向下为正，所以「弧在上方」= 控制点 y 取负。
    const h = SlurTieBase.arcHeight(dist, o) * (o.side === "down" ? 1 : -1);
    let p1 = new Point(xlen, h).rotate(cos, sin);
    let p2 = new Point(dist - xlen, h).rotate(cos, sin);
    p1 = p1.offset(xl, yl);
    p2 = p2.offset(xl, yl);
    return [p1, p2, cos];
  }

  init(pl: Point, pr: Point, style: SlurStyle): void {
    const dx = pr.x - pl.x, dy = pr.y - pl.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // 「看着扁不扁」按**宽高比**判：弧高是对数公式加上下限算的，长跨度那头封了顶，
    // 所以跨度一长比值就迅速变大。绝对跨度那条阈值留着（两者取先满足的）。
    const arcH = SlurTieBase.arcHeight(dist, style) * 0.75;
    const flatByRatio = style.flatRatio !== undefined && style.flatRatio > 0
      && arcH > 0 && dist / arcH > style.flatRatio;
    if (style.gap) {
      this.initArc(pl, pr, style);
      return;
    }
    if (style.forceFlat || flatByRatio
        || (style.flatSpan !== undefined && style.flatSpan > 0 && dist > style.flatSpan)) {
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
    const upper: [Point, Point, Point, Point] = [pl, pt0, pt1, pr];
    const lower: [Point, Point, Point, Point] = [pl, pt0.offset(0, lw0 / 2), pt1.offset(0, lw0 / 2), pr];
    const mid: [Point, Point, Point, Point] = [pl, pt0.offset(0, lw0 / 4), pt1.offset(0, lw0 / 4), pr];
    // 要画的参数区间：整条是 [0,1]；挖了中段就是两头两截（三条曲线的控制点只差 y，x(t) 相同，共用一个 t）
    const spans: [number, number][] = [];
    if (style.gap) {
      const tl = bezierTAtX(upper, style.gap.x0);
      const tr = bezierTAtX(upper, style.gap.x1);
      spans.push([0, tl], [tr, 1]);
    } else {
      spans.push([0, 1]);
    }
    const paths: GraphicPath[] = [];
    for (const [a, b] of spans) {
      const up = bezierSeg(upper, a, b);
      const lo = bezierSeg(lower, a, b);
      const obj = new GraphicPath();
      obj.fill = true;
      obj.stroke = false;
      obj.fillColor = clr;
      obj.moveTo(up[0]);
      obj.cubicTo(up[1], up[2], up[3]);
      if (lo[3].x !== up[3].x || lo[3].y !== up[3].y) obj.lineTo(lo[3]); // 断口那一端是平头
      obj.cubicTo(lo[2], lo[1], lo[0]);
      obj.close();
      paths.push(obj);
    }
    for (const [a, b] of spans) {
      const md = bezierSeg(mid, a, b);
      const outline = new GraphicPath();
      outline.fill = false;
      outline.stroke = true;
      outline.strokeWidth = style.outlineWidth ?? 0.7;
      outline.strokeColor = clr;
      outline.moveTo(md[0]);
      outline.cubicTo(md[1], md[2], md[3]);
      paths.push(outline);
    }

    this.finish(paths);
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
    // 高度按阈值那条弧算；没设阈值（纯按音符个数强制扁平）就拿这一条自己的跨度算
    const h = SlurTieBase.arcHeight(
      style.flatSpan !== undefined && style.flatSpan > 0 ? style.flatSpan : dist, style) * 0.75;
    // 钩的水平长度：短了会显得两端急折，长了中段的直线就没了。h 的 2.5 倍最耐看。
    const hx = Math.min(dist * 0.12, h * 2.5);
    const t = style.flatLineWidth !== undefined && style.flatLineWidth > 0
      ? style.flatLineWidth
      : style.thickness * 0.45;
    const clr = style.color;

    // 与弧形同一套形状语言：**填充的月牙**，中段厚 t、两端收到端点上成尖角
    // （去程画上缘、回程沿同一条形状下压 t 画回来，两端共用 pl/pr 所以天然是尖的）。
    // 早先这里是一条等宽描边线，两端齐头齐脑，跟满页的月牙弧摆在一起很扎眼。
    this.flatHx = hx;
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
export class Tie extends SlurTieBase {
  /** 这条弧连的是哪两个和弦（`ScoreDoc` 元素 id）。可视化编辑按 `起点:终点` 认出弧本身好点选；
   *  多连音那种没有起止音符的弧不填。**排版不读它**。 */
  startId: number | null = null;
  endId: number | null = null;
}
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
    flatRatio: opt.slurFlatRatio,
    flatLineWidth: opt.slurFlatWidth,
  };
}

/** 子树里带类 `cls` 的项，按页面树顺序；命中的项不再往下找。
 *  可视化编辑按它从音符格里认出挂在音符上的记号（和弦名 `chord-group`、装饰 `artic`…）。 */
export function findByClass(root: PageItem, cls: string): PageItem[] {
  const out: PageItem[] = [];
  const walk = (it: PageItem): void => {
    if (it !== root && it.classes.has(cls)) {
      out.push(it);
      return;
    }
    for (const c of it.children) walk(c);
  };
  walk(root);
  return out;
}
