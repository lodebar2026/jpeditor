// 五线谱识别的数据模型。逐条对应 musicpp `qtomr/qomr.h` 的结构体，改之前先核对那边。
//
// ## 坐标系：**设备坐标、y 向下**（与 `src/omr/vector.ts` 一致）
//
// musicpp 全程用 PDF 用户坐标（y 向上），`CFX_FloatRect` 里 `top > bottom`。
// 本仓反过来：`top < bottom`（top 是视觉上方 = 较小的 y）。移植时凡纵向比较逐处翻——
// 这是本次移植最容易出错的一处，`overlapY` / `ySpace` / `middleStep` / `findLegers`
// 全都碰得到。**语义名保持不变**（`top` 仍指视觉上方），只是数值大小关系反了。
//
// 无 DOM 依赖（要进 `src/cli/index.ts` 那条 Node 链）。
import type { VecObj } from "../omr/vector";
import type { VecTextRun, VecGlyph } from "../omr/vectext";
import type { Rect } from "../omr/types";
import type { SmuflName } from "./glyphs";

// ── 盒 ──────────────────────────────────────────────────────────────────────

/** 轴对齐盒。**y 向下**：`top < bottom`。 */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const boxOf = (r: Rect): Box => ({ left: r.x, right: r.x + r.w, top: r.y, bottom: r.y + r.h });
export const boxW = (b: Box): number => b.right - b.left;
export const boxH = (b: Box): number => b.bottom - b.top;
export const boxCx = (b: Box): number => (b.left + b.right) / 2;
export const boxCy = (b: Box): number => (b.top + b.bottom) / 2;

export function boxUnion(a: Box, b: Box): Box {
  return {
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/** `omr::overlapX`。 */
export function overlapX(a: Box, b: Box): boolean {
  return !(a.left > b.right || b.left > a.right);
}

/** `omr::overlapY`（原文比的是 y 向上的 top/bottom，这里翻过来）。 */
export function overlapY(a: Box, b: Box): boolean {
  return !(a.bottom < b.top || b.bottom < a.top);
}

/** `omr::xSpace`：两盒之间的水平间隙（重叠时为负）。 */
export function xSpace(a: Box, b: Box): number {
  return a.left < b.left ? b.left - a.right : a.left - b.right;
}

/** `omr::ySpace`：两盒之间的垂直间隙（重叠时为负）。 */
export function ySpace(a: Box, b: Box): number {
  return a.top < b.top ? b.top - a.bottom : a.top - b.bottom;
}

/** `omr::between`：c 是否落在 a、b 之间（含端点）。 */
export function between(a: number, b: number, c: number): boolean {
  return (b - a) * (c - a) <= 0;
}

/** `omr::pointOnLine`：过两点的直线在 x 处的 y。 */
export function pointOnLine(x0: number, y0: number, x1: number, y1: number, x: number): number {
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** `omr::diffRate`：两数的相对差（百分比）。 */
export function diffRate(a: number, b: number): number {
  return (Math.abs(a - b) * 100) / (a + b);
}

// ── 标记 ────────────────────────────────────────────────────────────────────

/** `omr::Tag`。一个对象认出来是什么就打一个标，打过标的后续步骤不再碰
 *  （musicpp 的 `hasTag()` 就是「这个对象已经有主了」）。 */
export type Tag =
  | "Symbol"
  | "SysLine"
  | "Staff"
  | "Bracket"
  | "BarLine"
  | "Clef"
  | "Key"
  | "Time"
  | "Note"
  | "Accidental"
  | "Notation"
  | "Augmentation"
  | "Stem"
  | "Beam"
  | "Leger"
  | "Tail"
  | "Slur"
  | "Tied"
  | "Wedge"
  | "OctaveShift"
  | "Tuplet"
  | "Lyric"
  | "Harmony"
  | "Tempo"
  | "Expression"
  | "Instrument"
  | "TextFrame"
  | "Boxed"
  | "MeasureNumber";

// ── 页面对象 ────────────────────────────────────────────────────────────────

/** 一个页面对象 = 一条路径，或一次 showText。musicpp 的 `omr::Object`。 */
export class PObj {
  readonly id: number;
  readonly box: Box;
  readonly path: VecObj | null;
  readonly run: VecTextRun | null;
  /** 文字对象拆出来的符号（`initSymbols`）。 */
  symbols: Sym[] = [];
  private tags = new Set<Tag>();

  constructor(id: number, path: VecObj | null, run: VecTextRun | null) {
    this.id = id;
    this.path = path;
    this.run = run;
    this.box = boxOf((path ?? run!).bbox);
  }

  hasAnyTag(): boolean {
    return this.tags.size > 0;
  }
  hasTag(t: Tag): boolean {
    return this.tags.has(t);
  }
  addTag(t: Tag): void {
    this.tags.add(t);
  }
  get tagList(): Tag[] {
    return [...this.tags];
  }
  /** 文字对象的字体家族名（已去子集前缀）；路径对象为 null。 */
  get font(): string | null {
    return this.run?.font ?? null;
  }
}

/**
 * 一条**直线段**：从某个路径对象的某条子路径里抽出来的两点直线（或细矩形的中心线）。
 *
 * musicpp 那边不需要这一层——pdfium 的一个 PageObject 就是一条线。本书不然：
 * 有一批 PDF 把整行谱的五条线加小节线**全画进一个 path 对象**（实测 p185 一个对象
 * 400 个点、几十条独立直线），按对象判 `isLine` 全是 false。**标记也因此挂在段上**，
 * 不能挂在对象上——一个对象里既有谱线又有小节线。
 */
export class Seg {
  readonly obj: PObj;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** 线宽（设备尺度）。 */
  readonly lw: number;
  readonly box: Box;
  private tags = new Set<Tag>();

  constructor(obj: PObj, x0: number, y0: number, x1: number, y1: number, lw: number) {
    this.obj = obj;
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
    this.lw = lw;
    const half = lw / 2;
    this.box = {
      left: Math.min(x0, x1) - (this.isV ? half : 0),
      right: Math.max(x0, x1) + (this.isV ? half : 0),
      top: Math.min(y0, y1) - (this.isH ? half : 0),
      bottom: Math.max(y0, y1) + (this.isH ? half : 0),
    };
  }

  get isH(): boolean {
    return Math.abs(this.y0 - this.y1) < 0.02;
  }
  get isV(): boolean {
    return Math.abs(this.x0 - this.x1) < 0.02;
  }
  /** 沿线方向的长度。 */
  get len(): number {
    return Math.hypot(this.x1 - this.x0, this.y1 - this.y0);
  }
  /** 左端 x（水平段）／中心 x（垂直段）。 */
  get left(): number {
    return Math.min(this.x0, this.x1);
  }
  get right(): number {
    return Math.max(this.x0, this.x1);
  }
  get top(): number {
    return Math.min(this.y0, this.y1);
  }
  get bottom(): number {
    return Math.max(this.y0, this.y1);
  }
  get cy(): number {
    return (this.y0 + this.y1) / 2;
  }
  get cx(): number {
    return (this.x0 + this.x1) / 2;
  }

  hasAnyTag(): boolean {
    return this.tags.size > 0;
  }
  hasTag(t: Tag): boolean {
    return this.tags.has(t);
  }
  addTag(t: Tag): void {
    this.tags.add(t);
  }
}

/** 一个音乐符号 = 文字对象里的一个字形 + 认出来的 SMuFL 语义。musicpp 的 `omr::Symbol`。 */
export class Sym {
  readonly parent: PObj;
  readonly index: number;
  readonly glyph: VecGlyph;
  readonly box: Box;
  /** SMuFL 语义名。 */
  code: SmuflName;
  /** 基线原点的 x（musicpp 的 `Symbol::pos.x`）。 */
  readonly px: number;
  /**
   * **判音高用的纵坐标 = 墨迹中心**，不是基线。
   *
   * musicpp 用的是基线（`Symbol::pos.y`），那是因为它只认 Maestro 一系
   * ——那一系符头的基线正落在符头中心高度上。本书还有 Anastasia（Sibelius 手写体），
   * 它的字形原点约定不同：实测 p154 的 gClef 基线落在**第一线**（-4 级）而不是 G 线（-2 级），
   * 符头也整体偏一个 em，照基线算音高会整首低八度。
   * 墨迹中心不依赖任何字体的原点约定——符头是个椭圆，中心就是它骑的那条线/间。
   */
  readonly py: number;
  /** 基线原点的 y（musicpp 的 `Symbol::pos.y`）。留着排查用。 */
  readonly baseY: number;
  ownerStaff: Staff | null = null;
  private tags = new Set<Tag>();

  constructor(parent: PObj, index: number, glyph: VecGlyph, code: SmuflName) {
    this.parent = parent;
    this.index = index;
    this.glyph = glyph;
    this.code = code;
    this.box = boxOf(glyph.bbox);
    this.px = glyph.ox;
    this.baseY = glyph.oy;
    this.py = (this.box.top + this.box.bottom) / 2;
  }

  hasTag(t: Tag): boolean {
    return this.tags.has(t);
  }
  addTag(t: Tag): void {
    this.tags.add(t);
  }
  hasAnyTag(): boolean {
    return this.tags.size > 0;
  }
}

// ── 谱表 ────────────────────────────────────────────────────────────────────

/** 一行谱表（五条线，或打击谱的一条线）。musicpp 的 `omr::Staff`。 */
export class Staff {
  /** 组成它的谱线段。**Anastasia 那种「谱线是字形」的页面这里是空的**——
   *  那边一条长横路径都没有，谱行由平铺的 `staff5Lines` 字形拼出来（见 `page.ts::findStaves`）。
   *  真正定音高的是 `lineYs`，不是这个数组。 */
  lines: Seg[] = [];
  /** 五条线的 y（从上到下）。打击谱只有一条。 */
  lineYs: number[] = [];
  box: Box = { left: 0, right: 0, top: 0, bottom: 0 };
  index = -1;
  page: SPage | null = null;
  bars: Bar[] = [];

  /** `Staff::init`：包围盒纵向取首尾两条线，横向取所有线的并集。 */
  init(left?: number, right?: number): void {
    if (!this.lineYs.length && this.lines.length) this.lineYs = this.lines.map((l) => l.cy);
    let l = left ?? Infinity;
    let r = right ?? -Infinity;
    for (const o of this.lines) {
      l = Math.min(l, o.left);
      r = Math.max(r, o.right);
    }
    this.box = {
      left: l,
      right: r,
      top: Math.min(...this.lineYs),
      bottom: Math.max(...this.lineYs),
    };
  }

  get cy(): number {
    return boxCy(this.box);
  }

  /** `Staff::stepDistance`：**半个线距**（相邻两个音级的纵向间隔）。 */
  stepDistance(): number {
    if (this.lineYs.length <= 1) return 0;
    return boxH(this.box) / (this.lineYs.length - 1) / 2;
  }

  /** `Staff::middleStep`：某个 y 相对中线（第三线）的音级数。
   *  **y 向下**，所以往上（y 小）是正数——与 musicpp 的符号相反那一半在这里已经调好：
   *  中线上方 +、下方 −，与「音越高数越大」一致。 */
  middleStep(y: number): number {
    const d = this.stepDistance();
    if (!d) return 0;
    return Math.round((this.cy - y) / d);
  }

  contains(x: number, y: number): boolean {
    return x >= this.box.left && x <= this.box.right && y >= this.box.top && y <= this.box.bottom;
  }
}

// ── 音符相关（`NoteData.cpp` 用得上，先把壳立起来） ──────────────────────────

export class Stem {
  seg: Seg;
  notes: Sym[] = [];
  beams: Beam[] = [];
  constructor(seg: Seg) {
    this.seg = seg;
  }
  get box(): Box {
    return this.seg.box;
  }
}

export class Beam {
  obj: PObj;
  stems: Stem[] = [];
  level = 0;
  constructor(obj: PObj) {
    this.obj = obj;
  }
  get box(): Box {
    return this.obj.box;
  }
}

export class SlurTie {
  obj: PObj;
  /** 弧朝上（开口向下）。 */
  isAbove = false;
  isTie = false;
  constructor(obj: PObj) {
    this.obj = obj;
  }
  get box(): Box {
    return this.obj.box;
  }
}

export class Bar {
  staff: Staff;
  /** 本小节里的符头/休止（含 tag Note 的 Sym）。 */
  notes: Sym[] = [];
  left = 0;
  right = 0;
  /** 右端小节线的样式与反复（见 `barlines.ts`）。 */
  rightStyle: string | null = null;
  rightRepeat: boolean = false;
  /** 左端是不是正向反复（`|:`）。 */
  leftRepeat: boolean = false;
  /** 反复房号（`1.`/`2.`）：号码，以及这一小节是不是这一房的起头/结尾。 */
  endingNumber: string | null = null;
  endingStart = false;
  endingStop = false;
  constructor(staff: Staff) {
    this.staff = staff;
  }
}

/** 一个**乐段系统**：同时演奏的若干行谱（独唱谱 1 行、SATB/钢琴谱 2 行以上）。
 *  musicpp 的 `omr::System`。 */
export class SSystem {
  staves: Staff[] = [];
  box: Box = { left: 0, right: 0, top: 0, bottom: 0 };
  index = -1;
  init(): void {
    this.box = this.staves.map((s) => s.box).reduce(boxUnion);
  }
  /** 主旋律所在的那行：**最上面那行**（SATB 的女高、钢琴谱的人声都在顶上）。 */
  get top(): Staff {
    return this.staves[0];
  }
}

/**
 * **跨系统**的同一行谱：一首曲子里「第 n 行」在每个系统里的那一条。
 * musicpp 的 `omr::ScoreStaff`。
 */
export class ScoreStaff {
  index = -1;
  /** 每个系统里对应的那行谱；系统里没有这行（隐藏声部）时为 null。 */
  staves: (Staff | null)[] = [];
}

/** 一个声部：花括号/连谱号括在一起的若干行谱（钢琴谱两行、独唱一行）。
 *  musicpp 的 `omr::Part`。 */
export class Part {
  index = -1;
  scoreStaves: ScoreStaff[] = [];
}

/** 一页。musicpp 的 `omr::Page`。 */
export class SPage {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  objs: PObj[] = [];
  /** 全页从路径里抽出来的直线段（谱线/符干/小节线/加线都在里面）。 */
  segs: Seg[] = [];
  symbols: Sym[] = [];
  staves: Staff[] = [];
  systems: SSystem[] = [];
  /** 全页谱表线距的中位数×2（`normalStaffSpace`）与最大值×2（`largestSP`）。 */
  normalStaffSpace = 0;
  largestSP = 0;
  /**
   * **页面的长度基准：小节线高度 H**（= 谱表高度 = 四个线距）。
   *
   * 与简谱那条路同一个口径（`layout/jpglyph.ts`：「一切长度都是小节线高度 H 的比例」）。
   * 几何门槛一律写成 `H` 的比例，**不写绝对点值**——同一本书里谱表大小差一倍
   * （正谱一格 5.4pt、小谱一格 2.7pt），写死的点值在小谱上就是半格。
   *
   * 怎么量：取**音乐字体的字号中位数**。Maestro/Opus/Anastasia 与 SMuFL 同源，
   * 都约定 em = 谱表高度 = 小节线高度，所以字号直接就是 H，不必等谱线找出来
   * ——而「多短的段算段」「重描合并的容差」这些门槛在找谱线**之前**就要用。
   * 谱线找到之后 `normalStaffSpace`（实测的一个线距）是更准的那个，优先用它。
   */
  barlineHeight = 0;

  /** 一个线距 = H/4。 */
  get space(): number {
    return this.barlineHeight / 4;
  }

  constructor(index: number, width: number, height: number) {
    this.index = index;
    this.width = width;
    this.height = height;
  }

  objsWithTag(t: Tag): PObj[] {
    return this.objs.filter((o) => o.hasTag(t));
  }

  segsWithTag(t: Tag): Seg[] {
    return this.segs.filter((s) => s.hasTag(t));
  }
}

/** 按视觉上方优先排序（musicpp 的 `sortByTop(topDown=true)`）。 */
export function sortByTop<T extends { box: Box }>(a: T[]): T[] {
  return a.sort((p, q) => p.box.top - q.box.top);
}

/** 按左优先排序（musicpp 的 `sortByLeft`）。 */
export function sortByLeft<T extends { box: Box }>(a: T[]): T[] {
  return a.sort((p, q) => p.box.left - q.box.left);
}
