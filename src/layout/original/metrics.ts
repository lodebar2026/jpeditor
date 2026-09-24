// 原样文档布局（文本谱、MusicXML、多声部 123/ABC 的原样档）的简谱度量：出厂值、方言修正、谱内指令与面板两层叠放。
//
// 这里的数字全部来自对原版渲染输出的实测（headless 浏览器 getBBox / 逐元素坐标差分），
// 与本项目 .jpwabc 谱面那套 `jpStackGap` 栅格**不是同一把尺子**——文本谱要的是「原版」
// 观感，两种预览各用各的规则，混用只会两头不像。
//
// 横向步进（实测在未拉伸的行上逐点吻合）：
//   同一拍内、前后都带减时线      → 25
//   其余音符之间                  → 37.5
//   音符与小节线之间（两侧）      → 35
//   每个附点额外                  → +12.5
// 行内算完自然宽度后再整体拉伸/压缩到版心宽度（两端对齐）。

import type { HeaderFonts } from "../../style/header";
import { SlurTieBase, type SlurStyle } from "../pageitem";
import type { GraceMetrics, GraceNote } from "../../common/gracenote";
import type { NoteElement } from "../../pu/ast";

/**
 * 原样文档布局（文本谱、MusicXML、多声部 123/ABC 的原样档）的简谱度量，单位 pt。
 * 与简谱引擎的 `LayoutOptions`（`style/jianpu.ts`）是两把尺子；类型按谱面内容取名，适配器在 `style/original.ts`。
 *
 * **组就是缩放规则**：谱内 `FontSize: q=` 只缩 `note` 组与 `size.note`，面板字号缩 `note`、`size`、
 * `lyricSpacing`、`spacing` 四组，其余各组不缩。加字段时放进对的组，缩放就跟着对。
 * 字段名与 `.ss` 一致：`@jianpu` 已有的键沿用其名（`beamWidth` = `beam-width`），字号与字体两组以角色名为键。
 */
export interface JianpuMetrics {
  page: {
    width: number;
    height: number;
    margin: { top: number; right: number; bottom: number; left: number };
    /** 连续长图：不按纸张分页，整份谱排成一张，页高随内容增长 */
    longImage: boolean;
    /** 长图左右两侧留白（比打印边距小得多——它是给屏幕看的） */
    longImageMargin: number;
    /** 版心第一行音符基线相对上边距的偏移 */
    firstSystemTop: number;
    /** 版心左边距之后再让出的一点内边距（实测原版首音锚点 = 左边距 + 3） */
    systemIndent: number;
  };
  justify: {
    /** 是否两端对齐（把每个 system 拉伸到版心宽） */
    enable: boolean;
    /** 拉伸倍数上限，防止极短的行被拉散 */
    maxHorizontalScale: number;
    /** 末行自然宽度不足版心的这个比例时就不拉伸（留它短着） */
    lastLineMinFill: number;
  };
  /** 音符栅格：贴着音符画的尺寸，随音符字号等比。 */
  note: {
    /** 横向步进：其余音符之间 / 同一拍内前后都带减时线 / 音符与小节线之间（两侧）/ 每个附点额外 */
    noteStep: number;
    beamedNoteStep: number;
    barlineSpace: number;
    augDotStep: number;
    /** 同侧多个八度点之间的间距 */
    octaveDotDist: number;
    /** 附点圆心相对锚点的 x 偏移 */
    dotDx: number;
    /** 附点与八度点**同样大小** */
    dotRadius: number;
    /** 相邻两层减时线的间距、线宽，及左右各伸出锚点多少 */
    beamDist: number;
    beamWidth: number;
    beamHalfSpan: number;
    /** 增时线的线宽与半长 */
    dashWidth: number;
    dashHalfLength: number;
    barlineHeight: number;
    /** 弧线弧高（**弧顶**离端点多高）。既是纵向预留的高度，也反算成绘制时的弧高上限
     *  ——见 jianpuSlurStyle / jianpuSlurRise，两处同一个数。 */
    slurArc: number;
    /** 跨度超过它改画扁平长连音线（见 layout.ts 的 SlurTieBase.initFlat）。
     *  约 8.6 个数字字号，与 .jpwabc 谱面那边的 `numberSize * 8` 同一量级。 */
    slurFlatSpan: number;
    /** 音符堆叠顶端 → 弧线的间隙。对应 .jpwabc 的 jpStackGap（= 字号/6） */
    slurGap: number;
    /** 音符上方的记号槽位（相对音符基线，负为上；同槽内按 level 继续上移）：
     *  `&xx` 装饰与力度 / 弧线与多连音的兜底（有音符可依据时坐在堆叠顶端再上一个 slurGap）/ 渐强渐弱 / 跳房子 */
    ornamentY: number;
    slurY: number;
    slurLevelStep: number;
    hairpinY: number;
    voltaY: number;
    /** 同一槽内每级 `+` 上移多少 */
    levelStep: number;
    /** 渐强渐弱楔形的开口高度 */
    hairpinOpening: number;
    /** 内联层（临时伴奏）相对主旋律的上移量 */
    cueY: number;
    /** 音符注释 / 和弦相对音符锚点的 y */
    chordY: number;
    /** 说明性文字行（`W:`）相对该组首行音符基线的 y */
    wordsY: number;
  };
  /** 线宽类：不随字号缩。 */
  stroke: {
    barline: number;
    /** 双线/反复线里两根竖线的间距 */
    doubleBarlineGap: number;
    repeatDotRadius: number;
    /** 变音记号给后一个音符额外让出的宽度 */
    accidentalSpace: number;
    /** 与 .jpwabc 谱面同值（layout.ts 的 slurTieThickness = 6） */
    slurThickness: number;
    hairpinThickness: number;
  };
  ratio: {
    /** 倚音相对主音符字号的缩放 */
    graceScale: number;
    /** 内联层（临时伴奏）相对主旋律的缩放 */
    cueScale: number;
  };
  /** 字号（pt），键是角色名。`note` 只收字号——原版量到的数字墨迹高 17.9，按量版时的字体折成字号落值。 */
  size: {
    note: number;
    title: number;
    subtitle: number;
    credit: number;
    /** 调号拍号行与速度文字 */
    keyMeter: number;
    /** 页眉 `TL:`/`TR:` 与页脚 */
    header: number;
    chord: number;
    /** 歌词前的段号/说明（`<1.>`） */
    verseNum: number;
    /** 说明性文字行 `W:` */
    words: number;
    lyric: number;
    /** 题下经文；不给 = `subtitle`。 */
    scripture?: number;
  };
  /** 跟歌词字号走的两个行距：曲行基线 → 其下第一行歌词基线 / 相邻两行歌词基线之间。 */
  lyricSpacing: {
    lyricGap: number;
    lyricStack: number;
  };
  spacing: {
    /** 一组（含歌词）之后到下一组曲行基线 */
    systemGap: number;
    /** 同组内相邻声部之间（歌词块末行 → 下一声部同值） */
    voiceGap: number;
  };
  /** 页头逐项落位（基线 y），不缩。 */
  head: {
    titleBaseline: number;
    /** 首个署名行基线，其后每行下移 creditLineHeight */
    creditBaseline: number;
    creditLineHeight: number;
    keyMeterBaseline: number;
  };
  /** 字体族，键是角色名；`text` 是各类文字的底。页眉各项（设置面板「页眉」一组）不给 = `text`。 */
  font: {
    text: string;
    note: string;
    /** 数字比歌词粗，两支要分开配 */
    noteBold: boolean;
    title?: string;
    subtitle?: string;
    credit?: string;
    scripture?: string;
  };
}

/** 定稿度量：`withDigitInk` 按数字字体实测补上的派生量。**不是样式值**。 */
export interface JianpuGrid extends JianpuMetrics {
  ink: {
    /** 数字「1」的**墨迹高**：纵向栅格（减时线、八度点、记号槽位）是贴着墨迹排的，拿它当内部单位。 */
    noteHeight: number;
    /** 第一条减时线（rect 上缘）相对数字锚点的 y */
    beamTopY: number;
    /** 高音点 / 低音点中心相对数字锚点的 y（负为上） */
    octaveUpY: number;
    octaveDownY: number;
  };
}

export const JIANPU_DEFAULTS: JianpuMetrics = {
  page: {
    width: 1000,
    height: 1415,
    margin: { top: 80, right: 80, bottom: 80, left: 80 },
    longImage: true, // 「原版」是一张连续长图，不是 A4 分页
    longImageMargin: 96,
    firstSystemTop: 156, // 首行音符基线 y = 236（= 上边距 80 + 156）
    systemIndent: 3,
  },
  // 两端对齐：番茄**原版**其实短行就是短的，这里刻意背离——短行留一大截白比排得散更难看，
  // 且本应用的 OMR 识别结果常出短行。末行仍按 lastLineMinFill 保护（太短就不拉）。
  justify: { enable: true, maxHorizontalScale: 3, lastLineMinFill: 0.7 },
  note: {
    noteStep: 37.5,
    beamedNoteStep: 25,
    barlineSpace: 35,
    augDotStep: 12.5,
    octaveDotDist: 5.5,
    dotDx: 12.35,
    dotRadius: 2.2,
    beamDist: 4.5,
    beamWidth: 2,
    beamHalfSpan: 6,
    dashWidth: 2,
    dashHalfLength: 5.5,
    barlineHeight: 29,
    slurArc: 7,
    slurFlatSpan: 215, // ≈ 数字字号 25 × 8.6
    slurGap: 4.3, // ≈ 数字字号 25 / 6
    ornamentY: -17,
    slurY: -25,
    slurLevelStep: 5,
    hairpinY: -44,
    voltaY: -53,
    levelStep: 6,
    hairpinOpening: 7,
    cueY: -40,
    chordY: -26,
    wordsY: -34,
  },
  stroke: {
    barline: 1.5,
    doubleBarlineGap: 5,
    repeatDotRadius: 2,
    accidentalSpace: 9,
    slurThickness: 6,
    hairpinThickness: 1.3,
  },
  ratio: { graceScale: 0.5, cueScale: 0.72 },
  size: {
    // 原版量到数字墨迹高 17.9；苹方粗体「1」墨迹占字号 0.714，折成字号 25.07，落整数
    note: 25,
    title: 36,
    subtitle: 20,
    credit: 16,
    keyMeter: 16,
    header: 16,
    chord: 14,
    verseNum: 17,
    words: 16,
    lyric: 17,
  },
  lyricSpacing: { lyricGap: 38, lyricStack: 27 },
  spacing: {
    systemGap: 67, // 末行歌词基线 → 下一组音符基线（105 = 38 + 67）
    voiceGap: 46,
  },
  head: { titleBaseline: 110, creditBaseline: 175, creditLineHeight: 21, keyMeterBaseline: 176 },
  font: {
    text: "PingFang SC, Microsoft YaHei, sans-serif",
    note: "PingFang SC, Microsoft YaHei, sans-serif",
    noteBold: true,
  },
};

/** 逐组浅拷贝（各组都是纯数据），供各叠放步骤产出新对象、不改入参。 */
export function cloneMetrics<T extends JianpuMetrics>(m: T): T {
  const out = { ...m } as Record<string, unknown>;
  for (const [k, v] of Object.entries(m)) if (v && typeof v === "object") out[k] = { ...v };
  out.page = { ...m.page, margin: { ...m.page.margin } };
  return out as T;
}

/** 把一组里的数都乘上 k（没给的可选项跳过）。 */
function scaleGroup(g: Record<string, number | undefined>, k: number): void {
  for (const key of Object.keys(g)) if (g[key] !== undefined) g[key] = g[key]! * k;
}

/** 定稿：按数字字体实测的「墨迹高 ÷ 字号」算出数字墨迹高，再把减时线、八度点贴上去。
 *  放在所有缩放（谱面 `FontSize:`、面板字号）之后做——那些只动字号，墨迹高跟着字号走。
 *
 * 数字墨迹 ↔ 第一条减时线、数字墨迹 ↔ 高/低音点，净距取**同一个值**：两条减时线的距离
 * （`noteMarkGap`，即减时线行距 `beamDist`）。用户口径：第一条减时线离音符太近，
 * 应与两条减时线的距离一样，八度点离音符也该是这个距离。故这三个 y 不单独落值，由它派生；
 * 低音点挂在减时线下时（`place.ts::noteInkBottom`）、延长记号离音符堆叠顶（painter）让的也是这一截。
 * 数字按墨迹竖直居中于基线画（墨迹底 = +noteHeight/2），减时线 rect 的上缘就是 beamTopY。 */
export function withDigitInk(m: JianpuMetrics, inkPerPt: number): JianpuGrid {
  const noteHeight = m.size.note * inkPerPt;
  const gap = noteMarkGap(m);
  const inkHalf = noteHeight / 2;
  return {
    ...cloneMetrics(m),
    ink: {
      noteHeight,
      beamTopY: inkHalf + gap,
      octaveUpY: -(inkHalf + gap + m.note.dotRadius),
      octaveDownY: inkHalf + gap + m.note.dotRadius,
    },
  };
}

// 数字墨迹底 → 第一条减时线**中心** = 两条减时线的中心距（beamDist）。用户两次复核：
// 取两线净空（3.0）挨着粗体数字嫌近，取整个行距当净空（4.5）又嫌宽，中心对中心看着才一样。
export function noteMarkGap(m: JianpuMetrics): number {
  return m.note.beamDist - m.note.beamWidth / 2;
}

/** 版心宽度。 */
export function contentWidth(m: JianpuMetrics): number {
  return m.page.width - m.page.margin.left - m.page.margin.right;
}


// ---------------- 谱面自带的版面指令 ----------------

/**
 * `FontSize: T2=65%;TL=80%;TR=80%` —— 各类文字相对默认字号的百分比。
 * 真实谱里分隔符并不规范（`TR=80%T2=90%` 可以不带分号），所以按「键=数字%」全局匹配，
 * 不依赖分隔符。键不区分大小写。
 */
export function parseFontSizes(lines: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of lines) {
    for (const m of line.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*=\s*(\d+(?:\.\d+)?)\s*%/g)) {
      const pct = Number(m[2]);
      if (pct > 0 && pct < 1000) out[m[1]!.toLowerCase()] = pct / 100;
    }
  }
  return out;
}

/** `Margin: left=100;top=30;right=100` —— 与页面同一套单位。 */
export function parseMargins(lines: readonly string[]): Partial<Record<"left" | "right" | "top" | "bottom", number>> {
  const out: Partial<Record<"left" | "right" | "top" | "bottom", number>> = {};
  for (const line of lines) {
    for (const m of line.matchAll(/\b(left|right|top|bottom)\s*=\s*(-?\d+(?:\.\d+)?)/gi)) {
      const v = Number(m[2]);
      if (Number.isFinite(v) && v >= 0 && v <= 400) {
        out[m[1]!.toLowerCase() as "left"] = v;
      }
    }
  }
  return out;
}

/**
 * 把谱面自带的 `FontSize:` / `Margin:` 应用到度量上。
 *
 * `all` 是全局系数（真实语料里用得最多）。歌词字号变了，曲词/词词间距要跟着变，
 * 否则放大后会互相压住——所以按同一系数缩放相关间距，而不是只改字号。
 */
export function applyDocOptions(
  base: JianpuMetrics,
  fontSizes: readonly string[],
  margins: readonly string[],
): JianpuMetrics {
  const fs = parseFontSizes(fontSizes);
  const mg = parseMargins(margins);
  if (Object.keys(fs).length === 0 && Object.keys(mg).length === 0) return base;
  const m = cloneMetrics(base);
  const all = fs.all ?? 1;
  const k = (key: string): number => (fs[key] ?? 1) * all;

  m.size.title = base.size.title * k("t");
  m.size.subtitle = base.size.subtitle * k("t2");
  m.size.credit = base.size.credit * k("z");
  m.size.header = base.size.header * (fs.tl ?? fs.tr ?? 1) * all;
  m.size.keyMeter = base.size.keyMeter * all;
  m.size.chord = base.size.chord * all;
  m.size.verseNum = base.size.verseNum * k("zs");

  const lyricK = k("c");
  m.size.lyric = base.size.lyric * lyricK;
  scaleGroup(m.lyricSpacing, lyricK);

  // `q` 改的是音符数字，整个音符栅格（步进、八度点、减时线、头顶槽位）都得等比跟随
  const noteK = fs.q ?? 1;
  if (noteK !== 1) {
    m.size.note = base.size.note * noteK;
    scaleGroup(m.note, noteK);
  }

  if (mg.left !== undefined) m.page.margin.left = mg.left;
  if (mg.right !== undefined) m.page.margin.right = mg.right;
  if (mg.top !== undefined) m.page.margin.top = mg.top;
  if (mg.bottom !== undefined) m.page.margin.bottom = mg.bottom;
  return m;
}

/** 编辑器面板上能手动改的那几项。谱面自带的 `FontSize:`/`Margin:` 先生效，再叠这一层。 */
export interface JianpuUserOptions {
  /** 整体字号缩放（1 = 原尺寸）。纸与边距不跟着缩——版心不变，字大了每行就放得少。
   *  面板不直接给它：那边给的是**字号 pt**（`digitFontSize`），由 `compose.ts::resolveScale` 换算过来。 */
  scale?: number;
  /** 音符数字的字号（pt）。0/缺省 = 跟随版式的 `size.note`。 */
  digitFontSize?: number;
  /** 换纸：实际纸张尺寸（pt）。两个一起给才算数——只给一个等于把纸拉长/压扁。 */
  pageWidth?: number;
  pageHeight?: number;
  /** 长图（一张连续长纸）还是按纸分页。覆盖档位自带的 `page.longImage`。 */
  continuous?: boolean;
  /** 页边距 `[上, 右, 下, 左]`（pt）。盖过谱面自带的 `Margin:`（面板那层在最上面）。 */
  margins?: [number, number, number, number];
  /** 页眉四项的字体（pt）。字号盖过整体缩放后的值——那是用户直接给的 pt。 */
  header?: HeaderFonts;
}

/** 把面板上的手动设置叠到量好的度量上。整体缩放动 `note`、`size`、`lyricSpacing`、`spacing` 四组。 */
export function applyUserOptions(base: JianpuMetrics, o: JianpuUserOptions | null): JianpuMetrics {
  if (!o) return base;
  const m = cloneMetrics(base);
  const k = o.scale ?? 1;
  if (k !== 1) {
    scaleGroup(m.note, k);
    scaleGroup(m.size, k);
    scaleGroup(m.lyricSpacing, k);
    scaleGroup(m.spacing, k);
  }
  if (o.pageWidth && o.pageHeight) {
    m.page.width = o.pageWidth;
    m.page.height = o.pageHeight;
  }
  if (o.continuous !== undefined) m.page.longImage = o.continuous;
  if (o.margins) {
    const [top, right, bottom, left] = o.margins;
    m.page.margin = { top, right, bottom, left };
  }
  const h = o.header ?? {};
  if (h.title?.family) m.font.title = h.title.family;
  if (h.subtitle?.family) m.font.subtitle = h.subtitle.family;
  if (h.credit?.family) m.font.credit = h.credit.family;
  if (h.scripture?.family) m.font.scripture = h.scripture.family;
  if (h.title?.size) m.size.title = h.title.size;
  if (h.subtitle?.size) m.size.subtitle = h.subtitle.size;
  if (h.credit?.size) m.size.credit = h.credit.size;
  if (h.scripture?.size) m.size.scripture = h.scripture.size;
  return m;
}

/**
 * 原样文档布局的弧线样式。绘制与纵向预留**共用这一个来源**：
 * `slurArc` 是想要的弧顶高度，贝塞尔的弧顶约为控制点高的 0.75，所以上限按 /0.75 反算。
 * 在此之前 painter 把弧高直接丢掉、按 musicpp 的对数公式画（跨度大时高出一倍多），
 * 而 layout 又按弧高预留——两套数对不上。
 */
export function jianpuSlurStyle(m: JianpuMetrics, color: number): SlurStyle {
  return {
    thickness: m.stroke.slurThickness,
    color,
    maxHeight: m.note.slurArc / 0.75,
    // 文本谱的参考实现（番茄原版渲染）弧高是**恒定**的（控制点固定在 top-10，与跨度无关），
    // 所以这里上下限同值：长弧不长高、短弧也不塌成直线。
    minHeight: m.note.slurArc / 0.75,
    flatSpan: m.note.slurFlatSpan,
  };
}

/** 弧线实际占的头顶高度（纵向预留用），与 jianpuSlurStyle 同源。 */
export function jianpuSlurRise(m: JianpuMetrics): number {
  return SlurTieBase.arcHeight(Infinity, jianpuSlurStyle(m, 0)) * 0.75;
}

/** 原样文档布局折算给公共倚音几何的度量（见 `src/common/gracenote.ts`）。
 *  painter 画倚音、layout 给倚音留位，用的必须是同一份。 */
export function jianpuGraceMetrics(m: JianpuGrid): GraceMetrics {
  return {
    ink: m.ink.noteHeight,
    scale: m.ratio.graceScale,
    octaveUpY: m.ink.octaveUpY,
    octaveDownY: m.ink.octaveDownY,
    octaveDotGap: m.note.octaveDotDist,
    octaveDotRadius: m.note.dotRadius,
    underlineGap: m.note.beamDist,
  };
}

/** pu 的音符元素 → 公共倚音几何要的那几个字段。 */
export function jianpuGraceNotes(els: readonly NoteElement[]): GraceNote[] {
  return els.map((gn) => ({
    digit: String(gn.pitch),
    octave: gn.octave,
    duration: gn.duration,
    ...(gn.accidental ? { alter: gn.accidental } : {}),
  }));
}
