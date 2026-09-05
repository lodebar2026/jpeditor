// 适配层：位图抽出来的谱线/线段/符号 → `SPage`（`src/staffomr/model.ts` 的那个）。
//
// **这是位图路与矢量路唯一的接缝。** 装完之后 `page.ts` 往下那一整条
// （`findStaves` → `findNoteheads` → `findStems` → `findBarlines` → `findClefKeyTime`
// → `makeSystems` → `makeBars` → `buildNotes` → 和弦层 → `toxml`）一行不改。
//
// ## 坐标系：**像素**，不换算成 PDF 点
//
// `staffomr` 全程按「小节线高度 H 的比例」写判据，与绝对尺度无关
// （`SPage.barlineHeight` 就是那个 H）。所以位图路直接用像素当设备坐标，
// 少一道换算、也少一次精度损失。要回到页面坐标时乘 `RasterPage.scale`。
import { PObj, SPage, Seg, Sym } from "../staffomr/model";
import type { VecObj } from "../omr/vector";
import type { VecGlyph, VecTextRun } from "../omr/vectext";
import type { SmuflName } from "../staffomr/glyphs";
import type { Rect } from "../omr/types";
import type { LineSeg } from "./prims";
import type { RasterUnit, StaffLineRun } from "./staffline";

/**
 * 造一个占位的路径对象。
 *
 * `Seg` 的构造要一个 `PObj`，`PObj` 又要一个 `VecObj` 或 `VecTextRun` 取包围盒。
 * 位图这边没有真的路径对象，就按段的包围盒造一个最小的——
 * 下游只用到 `PObj.box`、`PObj.path`（判「这是路径不是文字」）与标记，
 * `data` / `ctm` 那些字段没人读。
 */
function fakePath(id: number, x: number, y: number, w: number, h: number, lw: number): VecObj {
  return {
    id,
    data: new Float32Array(0),
    ctm: [1, 0, 0, 1, 0, 0],
    bbox: { x, y, w, h },
    paint: "stroke",
    curves: 0,
    segs: 1,
    lineWidth: lw,
    dash: null,
    dashPhase: 0,
    fill: null,
    stroke: "#000",
    clip: null,
  };
}

/** 一条线段 → 一个 `PObj` 加一个 `Seg`（一段一个对象，位图这边没有「一个对象里好几条线」的事）。 */
function pushSeg(pg: SPage, id: number, s: LineSeg): Seg {
  const left = Math.min(s.x0, s.x1);
  const right = Math.max(s.x0, s.x1);
  const top = Math.min(s.y0, s.y1);
  const bottom = Math.max(s.y0, s.y1);
  const o = new PObj(id, fakePath(id, left, top, right - left, bottom - top, s.lw), null);
  pg.objs.push(o);
  const seg = new Seg(o, s.x0, s.y0, s.x1, s.y1, s.lw);
  pg.segs.push(seg);
  return seg;
}

/**
 * 造一个占位的字形与文字对象，好把位图认出来的符号包成 `Sym`。
 *
 * `Sym` 的构造要 `(parent: PObj, index, glyph: VecGlyph, code)`，`PObj` 又要一个
 * `VecTextRun`。位图这边没有文字层，就按块的包围盒造一个最小的。
 * 下游真正读的只有 `Sym.box` / `Sym.px` / `Sym.py` / `Sym.code`
 * （`page.ts:467` 的 `compositeStemUp` 会读 `glyph`，但那是 Anastasia 的复合音符字形，
 * 位图路没有，走不到）。
 *
 * `font` 用 `#raster`：`musicFamily` 认不出它，于是 `findSymbols` 与
 * `estimateBarlineHeight` 都不会去碰这些对象——那两处是给矢量路的文字层用的。
 */
export const RASTER_FONT = "#raster";

function fakeGlyph(box: Rect): VecGlyph {
  return {
    code: 0,
    fontChar: "",
    unicode: "",
    bbox: box,
    bboxEstimated: false,
    ox: box.x,
    oy: box.y + box.h,
    ctm: [1, 0, 0, 1, 0, 0],
    advance: box.w,
    outline: null,
  };
}

function fakeRun(id: number, box: Rect, sizeDev: number, font = RASTER_FONT): VecTextRun {
  return {
    id,
    font,
    fontRaw: font,
    loadedName: font,
    size: sizeDev,
    sizeDev,
    glyphs: [],
    bbox: box,
    renderMode: 0,
    fill: "#000",
    clip: null,
  };
}

/** 位图认出来的一个符号：包围盒 + SMuFL 名。 */
export interface RasterSym {
  box: Rect;
  code: SmuflName;
}

/** 位图 OCR 出来的一行文本（歌词）：逐字格的盒 + 字符。 */
export interface RasterText {
  cells: { box: Rect; ch: string }[];
  /** 字号（字格高的中位数）。`analyzeText` 与 `splitSyllables` 都读它。 */
  sizeDev: number;
}

/**
 * 合成一个文本对象。字体名用 `RASTER_TEXT_FONT`（`musicFamily` 认不出它，
 * `findSymbols` 不会来碰），`unicode` 就是 OCR 出来的字。
 *
 * 查不到字的格**留空**（`unicode: ""`），不编造——与矢量路那条同一个规矩
 * （`splitSyllables` 会把空音节丢掉）。
 */
export const RASTER_TEXT_FONT = "#ocr";

export function makeTextObj(id: number, t: RasterText): PObj {
  const left = Math.min(...t.cells.map((c) => c.box.x));
  const right = Math.max(...t.cells.map((c) => c.box.x + c.box.w));
  const top = Math.min(...t.cells.map((c) => c.box.y));
  const bottom = Math.max(...t.cells.map((c) => c.box.y + c.box.h));
  const run = fakeRun(id, { x: left, y: top, w: right - left, h: bottom - top }, t.sizeDev, RASTER_TEXT_FONT);
  for (const c of t.cells) {
    const g = fakeGlyph(c.box);
    g.unicode = c.ch;
    run.glyphs.push(g);
  }
  return new PObj(id, null, run);
}

export interface AdaptInput {
  index: number;
  width: number;
  height: number;
  unit: RasterUnit;
  /** 行投影找出来的谱线。**单独给**，不混在 `hSegs` 里——那是全页最长的横线，
   *  `findStaves` 的「长度 ≥ 最长横线的 35%」那道闸靠它定分母。 */
  staffLines: StaffLineRun[];
  /** 去谱线之后抽出来的横段（加线、括号横杠、渐强线）。 */
  hSegs: LineSeg[];
  /** 竖段（符干、小节线、系统线）。 */
  vSegs: LineSeg[];
  /** 认出来的音乐符号（符头、谱号、休止、升降、拍号数字、符尾…）。 */
  syms?: RasterSym[];
  /** 花括号 / 系统括号的包围盒。`score.ts::tokenOf` 靠它分开钢琴行与人声行。 */
  braces?: Rect[];
  /** 系统括号（罩住整个系统的那个），打 `SysBracket`——`makeSystems` 分系统用。 */
  sysBrackets?: Rect[];
}

/**
 * 一个认出来的符号 → `PObj` + `Sym`（造一个假字形与假文本串装着它）。
 *
 * `buildRasterPage` 装配时用，识别过程中**补认**出来的符号也走这里
 * （`recognize.ts::bootstrapFlags` 的符尾就是），两条路造出来的对象要一模一样。
 */
export function makeSymObj(id: number, s: RasterSym, staffHeight: number): { obj: PObj; sym: Sym } {
  const glyph = fakeGlyph(s.box);
  const run = fakeRun(id, s.box, staffHeight);
  run.glyphs.push(glyph);
  const obj = new PObj(id, null, run);
  const sym = new Sym(obj, 0, glyph, s.code);
  obj.symbols.push(sym);
  obj.addTag("Symbol");
  return { obj, sym };
}

/**
 * 装配 `SPage`。
 *
 * `barlineHeight` 取**四个线距**——矢量路那边是「音乐字体的字号中位数」
 * （Maestro/Opus 与 SMuFL 同源，em = 谱表高度），位图没有字号可取，
 * 但两者本来就是同一个量：谱表高度。
 *
 * **谱线段一律水平**（`y0 === y1`）：`Seg.isH` 判的是两端 y 差小于 0.02，
 * 像素坐标下量出来的中心 y 带小数，直接拿两端的实测值会两头不沾
 * （既不是 `isH` 也不是 `isV`），整页的段全被后面每一步跳过。
 * 倾斜校正是取图那一层的事，到这里应当已经摆平（合唱谱这批实测倾斜 ≤1.23px）。
 */
export function buildRasterPage(inp: AdaptInput): SPage {
  const pg = new SPage(inp.index, inp.width, inp.height);
  pg.barlineHeight = inp.unit.height;
  let id = 0;
  for (const l of inp.staffLines) {
    pushSeg(pg, id++, { x0: l.left, y0: l.y, x1: l.right, y1: l.y, lw: l.y1 - l.y0 + 1, maxLw: l.y1 - l.y0 + 1 });
  }
  for (const s of inp.hSegs) {
    const y = (s.y0 + s.y1) / 2;
    pushSeg(pg, id++, { ...s, y0: y, y1: y });
  }
  for (const s of inp.vSegs) {
    const x = (s.x0 + s.x1) / 2;
    pushSeg(pg, id++, { ...s, x0: x, x1: x });
  }
  for (const b of inp.braces ?? []) {
    // 造一个占位的路径对象打上 `Bracket`——`tokenOf` 只读它的盒
    const o = new PObj(id, fakePath(id, b.x, b.y, b.w, b.h, 1), null);
    id++;
    o.addTag("Bracket");
    pg.objs.push(o);
  }
  for (const b of inp.sysBrackets ?? []) {
    const o = new PObj(id, fakePath(id, b.x, b.y, b.w, b.h, 1), null);
    id++;
    o.addTag("SysBracket");
    pg.objs.push(o);
  }
  for (const s of inp.syms ?? []) {
    const { obj, sym } = makeSymObj(id++, s, inp.unit.height);
    pg.objs.push(obj);
    pg.symbols.push(sym);
  }
  return pg;
}
