// 文本谱排版的度量常量与版面 profile。
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

import type { Dialect } from "./dialect";
import { SlurTieBase, type SlurStyle } from "../layout/layout";
import type { GraceMetrics, GraceNote } from "../common/gracenote";
import type { NoteElement } from "./ast";

/** 版面预设：print 忠实原版 A4；slide 是投影用的 16:9。 */
export type PageProfileName = "print" | "slide";

export interface PuMetrics {
  profile: PageProfileName;

  pageWidth: number;
  pageHeight: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;

  // ---- 横向步进 ----
  stepPlain: number;
  stepBeamed: number;
  stepBarline: number;
  stepPerDot: number;
  /** 变音记号给后一个音符额外让出的宽度 */
  accidentalWidth: number;
  /** 行超宽时允许压缩到的下限倍数 */
  minSqueeze: number;
  /** 是否两端对齐（把每个 system 拉伸到版心宽）。番茄不拉伸，诗歌本拉伸 */
  justify: boolean;
  /** 连续长图：不按纸张分页，整份谱排成一张，页高随内容增长 */
  continuous: boolean;
  /** 连续长图左右两侧留白（比打印边距小得多——它是给屏幕看的） */
  continuousSideMargin: number;
  /** 拉伸倍数上限，防止极短的行被拉散 */
  maxStretch: number;
  /** 末行自然宽度不足版心的这个比例时就不拉伸（留它短着） */
  justifyMinFill: number;
  /** 版心左边距之后再让出的一点内边距（实测原版首音锚点 = 左边距 + 3） */
  bodyLeftPad: number;

  // ---- 音符字形 ----
  /** 数字墨迹高度：据此反推字号，保证与原版等大 */
  digitInkHeight: number;
  /** 高音点中心相对数字锚点的 y（负为上） */
  octaveUpY: number;
  /** 低音点中心相对数字锚点的 y */
  octaveDownY: number;
  /** 同侧多个八度点之间的间距 */
  octaveDotGap: number;
  octaveDotRadius: number;
  /** 附点圆心相对锚点的 x 偏移。附点与八度点**同样大小**（共用 dotRadius） */
  dotOffsetX: number;
  dotRadius: number;

  // ---- 线条 ----
  /** 增时线的线宽与半长 */
  sustainWidth: number;
  sustainHalfLength: number;
  /** 减时线（第一条）相对数字锚点的 y */
  underlineY: number;
  /** 相邻两层减时线的间距 */
  underlineGap: number;
  underlineWidth: number;
  /** 减时线左右各伸出锚点多少 */
  underlineHalfSpan: number;
  barlineHeight: number;
  barlineWidth: number;
  /** 双线/反复线里两根竖线的间距 */
  barlineDoubleGap: number;
  /** 反复点的半径与横向偏移 */
  repeatDotRadius: number;

  // ---- 纵向 ----
  /** 版心第一行音符基线相对上边距的偏移 */
  bodyTop: number;
  /** 曲行基线 → 其下第一行歌词基线 */
  gapMusicLyric: number;
  /** 相邻两行歌词基线之间 */
  gapLyricLyric: number;
  /** 一组（含歌词）之后到下一组曲行基线 */
  gapGroup: number;
  /** 同组内相邻声部之间（两者都没有歌词时） */
  gapVoice: number;
  /** 歌词块末行 → 其下一个声部。与 gapVoice 不同：字块底比数字底更低 */
  gapLyricMusic: number;

  // ---- 文字 ----
  titleSize: number;
  subtitleSize: number;
  authorSize: number;
  headerSize: number;
  lyricSize: number;
  /** 标题基线 */
  titleY: number;
  /** 首个作者行基线，其后每行下移 authorStep */
  authorY: number;
  authorStep: number;
  /** 调号拍号行基线 */
  keyMeterY: number;
  /** 音符注释 / 和弦相对音符锚点的 y */
  annotationY: number;
  annotationSize: number;
  /** 页眉 `TL:`/`TR:` 文字的字号 */
  topTextSize: number;
  /** 歌词前的段号/说明（`<1.>`）字号 */
  lyricLabelSize: number;
  /** 说明性文字行（`W:`）相对该组首行音符基线的 y */
  textLineY: number;
  textLineSize: number;

  // ---- 音符上方的记号槽位（相对音符基线，负为上；同槽内按 level 继续上移）----
  /** `&xx` 装饰与力度 */
  laneOrnament: number;
  /** 弧线 / 多连音：坐在音符堆叠顶端再上一个 slurStackGap（与 .jpwabc 谱面同一规则），
   *  laneSlur 只作没有音符可依据时的兜底 */
  laneSlur: number;
  laneSlurStep: number;
  /** 音符堆叠顶端 → 弧线的间隙。对应 .jpwabc 的 jpStackGap（= 字号/6） */
  slurStackGap: number;
  /** 渐强渐弱 */
  laneWedge: number;
  /** 跳房子 */
  laneVolta: number;
  /** 同一槽内每级 `+` 上移多少 */
  laneLevelStep: number;
  /** 弧线弧高（**弧顶**离端点多高）。既是纵向预留的高度，也反算成绘制时的弧高上限
   *  ——见 puSlurStyle / puSlurRise，两处同一个数。 */
  slurHeight: number;
  /** 跨度超过它改画扁平长连音线（见 layout.ts 的 SlurTieBase.initFlat）。
   *  取 12 × 数字墨迹高，与 .jpwabc 谱面那边的 `numberSize * 8` 同一量级。 */
  slurFlatSpan: number;
  /** 弧线厚度。与 .jpwabc 谱面同值（layout.ts 的 slurTieThickness = 6） */
  slurThickness: number;
  /** 渐强渐弱楔形的开口高度与线宽 */
  wedgeMouth: number;
  wedgeWidth: number;
  /** 倚音相对主音符字号的缩放 */
  graceScale: number;
  /** 内联层（临时伴奏）相对主旋律的缩放与上移量 */
  layerScale: number;
  layerY: number;

  fontFamily: string;
  /** 音符数字用的字体族与字重。数字比歌词粗，两支要分开配；PPT 档不加粗 */
  digitFamily: string;
  digitBold: boolean;
}

const PRINT: PuMetrics = {
  profile: "print",
  pageWidth: 1000,
  pageHeight: 1415,
  marginLeft: 80,
  marginRight: 80,
  marginTop: 80,
  marginBottom: 80,

  stepPlain: 37.5,
  stepBeamed: 25,
  stepBarline: 35,
  stepPerDot: 12.5,
  accidentalWidth: 9,
  minSqueeze: 0.55,
  // 两端对齐：番茄**原版**其实短行就是短的，这里刻意背离——短行留一大截白比排得散更难看，
  // 且本应用的 OMR 识别结果常出短行。末行仍按 justifyMinFill 保护（太短就不拉）。
  justify: true,
  continuous: true, // 「原版」是一张连续长图，不是 A4 分页
  continuousSideMargin: 96,
  maxStretch: 3,
  justifyMinFill: 0.7,
  bodyLeftPad: 3,

  digitInkHeight: 17.9,
  octaveUpY: -14,
  octaveDownY: 13,
  octaveDotGap: 5.5,
  octaveDotRadius: 2.2,
  dotOffsetX: 12.35,
  dotRadius: 2.2,

  sustainWidth: 2,
  sustainHalfLength: 5.5,
  underlineY: 13,
  underlineGap: 4.5,
  underlineWidth: 2,
  underlineHalfSpan: 6,
  barlineHeight: 29,
  barlineWidth: 1.5,
  barlineDoubleGap: 5,
  repeatDotRadius: 2,

  bodyTop: 156, // 首行音符基线 y = 236（= marginTop 80 + 156）
  gapMusicLyric: 38,
  gapLyricLyric: 27,
  gapGroup: 67, // 末行歌词基线 → 下一组音符基线（105 = 38 + 67）
  gapVoice: 46,
  gapLyricMusic: 46,

  titleSize: 36,
  subtitleSize: 20,
  authorSize: 16,
  headerSize: 16,
  lyricSize: 17,
  topTextSize: 16,
  lyricLabelSize: 17,
  titleY: 110,
  authorY: 175,
  authorStep: 21,
  keyMeterY: 176,
  annotationY: -26,
  annotationSize: 14,
  textLineY: -34,
  textLineSize: 16,

  laneOrnament: -17,
  laneSlur: -25,
  laneSlurStep: 5,
  slurStackGap: 4.3, // 17.9/0.70/6
  laneWedge: -44,
  laneVolta: -53,
  laneLevelStep: 6,
  slurHeight: 7,
  slurFlatSpan: 215, // 17.9 × 12
  slurThickness: 6,
  wedgeMouth: 7,
  wedgeWidth: 1.3,
  graceScale: 0.5,
  layerScale: 0.72,
  layerY: -40,

  fontFamily: "PingFang SC, Microsoft YaHei, sans-serif",
  digitFamily: "PingFang SC, Microsoft YaHei, sans-serif",
  digitBold: true,
};

/** 投影用：16:9、字号放大、行距拉开，页眉页脚从简。 */
const SLIDE: PuMetrics = {
  ...PRINT,
  profile: "slide",
  pageWidth: 1600,
  pageHeight: 900,
  marginLeft: 90,
  marginRight: 90,
  marginTop: 70,
  marginBottom: 70,
  continuous: false, // 投影按幻灯片分页
  digitBold: false, // PPT 档的观感是既有的，不跟简谱档加粗
  continuousSideMargin: 130,

  // 投影距离远，整体放大约 1.55 倍
  stepPlain: 58,
  stepBeamed: 39,
  stepBarline: 54,
  stepPerDot: 19,
  accidentalWidth: 14,

  digitInkHeight: 27.5,
  octaveUpY: -21.5,
  octaveDownY: 20,
  octaveDotGap: 8.5,
  octaveDotRadius: 3.4,
  dotOffsetX: 19,
  dotRadius: 3.4,

  sustainWidth: 3,
  sustainHalfLength: 8.5,
  underlineY: 20,
  underlineGap: 7,
  underlineWidth: 3,
  underlineHalfSpan: 9.5,
  barlineHeight: 45,
  barlineWidth: 2.3,
  barlineDoubleGap: 7.5,
  repeatDotRadius: 3,

  bodyLeftPad: 4.5,
  bodyTop: 120,
  gapMusicLyric: 56,
  gapLyricLyric: 40,
  gapGroup: 84,
  gapVoice: 66,
  gapLyricMusic: 66,

  titleSize: 46,
  subtitleSize: 26,
  authorSize: 22,
  headerSize: 22,
  lyricSize: 26,
  topTextSize: 22,
  lyricLabelSize: 26,
  titleY: 78,
  authorY: 130,
  authorStep: 28,
  keyMeterY: 132,
  annotationY: -38,
  annotationSize: 20,
  textLineY: -48,
  textLineSize: 22,

  laneOrnament: -26,
  laneSlur: -38,
  laneSlurStep: 8,
  slurStackGap: 6.6,
  laneWedge: -66,
  laneVolta: -86,
  laneLevelStep: 9,
  slurHeight: 11,
  slurFlatSpan: 330, // 27.5 × 12
  slurThickness: 9.2,
  wedgeMouth: 11,
  wedgeWidth: 2,
  graceScale: 0.5,
  layerScale: 0.72,
  layerY: -60,
};

/**
 * 诗歌本的尺寸按**诗歌本 App 自己导出的《圣哉三一歌》长图**逐项量得
 * （四声部、四段歌词、四个 system；底本在本地 `testdata/pu/ref/圣哉三一歌.pdf`）。
 * 量法：抽出内嵌位图 → 二值化 → 连通域；以数字「1」的墨迹高为 1 个 digitInkHeight
 * （底本上 119px），曲行锚点取数字墨迹的竖直中心（= painter 画数字的锚点），
 * 歌词基线取汉字墨迹反推（**字号不等于墨迹**，PingFang SC 的「圣/哉/清」墨迹分别是
 * 字号的 0.829 / 0.905 / 0.917，三条路都指向字号 24.6）。
 *
 * 以数字墨迹高为 1，与番茄的对照：
 *   歌词墨迹  番茄 0.82 / 诗歌本 1.15（底本实测；实际落值见 lyricSize 那行）
 *   小节线高  番茄 1.62 / 诗歌本 1.90
 *   词行间距  番茄 1.51 / 诗歌本 1.68（同上）
 *   声部间距  番茄 2.57 / 诗歌本 2.07
 * 「原版」既然是各复刻各的，尺寸就按方言分开，不取折中。
 *
 * 落值一律取整、取不了整就落到 .5——这些数是拿一首曲子量的，多余的小数位是假精度。
 * **有意不跟底本**的几处（别照实测「改回去」，缘由见 docs/实现/文本谱.md）：
 * 整体版面缩放、歌词字号与行距、增时线与附点的 y、八度点位置、附点的横向距离、
 * 弧线的粗细与弧高。
 */
function applyShige(m: PuMetrics): PuMetrics {
  const k = m.digitInkHeight / 17.9; // 相对 print profile 的整体缩放
  return {
    ...m,
    justify: true, // 诗歌本/印刷原版各 system 都对齐到版心右缘
    // 底本的数字是**粗**的：中部笔画 / 墨迹高 = 0.227，苹方常规只有 0.126、黑体更细（0.111）。
    // 各系统字体里最接近的是 Helvetica/Arial Bold（0.21）。
    digitFamily: "Helvetica Neue, Helvetica, Arial, PingFang SC, sans-serif",
    // 底本量得字号 24.5（汉字墨迹 ≈ 0.846 字号 → 1.15 × 数字墨迹）、行距 29.6，
    // 这里**有意都往上放**：实际渲染下 24.5 的歌词偏小，字号回 27 之后行距也得跟着回 35，
    // 否则四段歌词叠起来会挤。字号与行距是一对，改一个必须改另一个。
    lyricSize: 27 * k,
    lyricLabelSize: 27 * k, // 底本上段号比歌词小 2.5%，差得太少，不单列
    annotationSize: 19 * k, // 底本的和弦全隐藏，量不到，沿用旧值
    barlineHeight: 34 * k,
    barlineDoubleGap: 3.5 * k,
    underlineY: 11.5 * k, // 减时线更贴近数字
    underlineWidth: 1.5 * k, // 也更细
    sustainWidth: 3 * k, // 增时线反过来更粗更长
    sustainHalfLength: 4 * k,
    // 纵向：由「小节线段的竖直中心」反推——比按墨迹带估行距可靠得多
    gapMusicLyric: 44 * k, // 歌词字块比数字高，不多让就会顶到低八度点
    gapLyricLyric: 35 * k, // 与 lyricSize 是一对（底本 29.6，配 24.5 的字号）
    gapLyricMusic: 37 * k, // 歌词块之后 → 下一声部
    gapVoice: 37 * k, // 声部 → 声部
    gapGroup: 65 * k, // system 之间
  };
}

/** 各方言对基础度量的修正。番茄用原值，故是恒等；加方言在这张表里补一项，不要写 if。 */
const DIALECT_TWEAK: Record<Dialect, (m: PuMetrics) => PuMetrics> = {
  tomato: (m) => m,
  shige: applyShige,
};

export function metricsFor(profile: PageProfileName, dialect: Dialect = "tomato"): PuMetrics {
  const base = profile === "slide" ? { ...SLIDE } : { ...PRINT };
  return DIALECT_TWEAK[dialect](base);
}

/** 版心宽度。 */
export function contentWidth(m: PuMetrics): number {
  return m.pageWidth - m.marginLeft - m.marginRight;
}

/** 版心高度。 */
export function contentHeight(m: PuMetrics): number {
  return m.pageHeight - m.marginTop - m.marginBottom;
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
  base: PuMetrics,
  fontSizes: readonly string[],
  margins: readonly string[],
): PuMetrics {
  const fs = parseFontSizes(fontSizes);
  const mg = parseMargins(margins);
  if (Object.keys(fs).length === 0 && Object.keys(mg).length === 0) return base;
  const m = { ...base };
  const all = fs.all ?? 1;
  const k = (key: string): number => (fs[key] ?? 1) * all;

  m.titleSize = base.titleSize * k("t");
  m.subtitleSize = base.subtitleSize * k("t2");
  m.authorSize = base.authorSize * k("z");
  m.topTextSize = base.topTextSize * (fs.tl ?? fs.tr ?? 1) * all;
  m.headerSize = base.headerSize * all;
  m.annotationSize = base.annotationSize * all;
  m.lyricLabelSize = base.lyricLabelSize * k("zs");

  const lyricK = k("c");
  m.lyricSize = base.lyricSize * lyricK;
  m.gapMusicLyric = base.gapMusicLyric * lyricK;
  m.gapLyricLyric = base.gapLyricLyric * lyricK;

  // `q` 改的是音符数字，整个音符栅格（步进、八度点、减时线）都得等比跟随
  const noteK = fs.q ?? 1;
  if (noteK !== 1) {
    for (const key of [
      "digitInkHeight", "octaveUpY", "octaveDownY", "octaveDotGap", "octaveDotRadius",
      "dotOffsetX", "dotRadius", "underlineY", "underlineGap", "underlineWidth",
      "underlineHalfSpan", "barlineHeight", "sustainWidth", "sustainHalfLength",
      "stepPlain", "stepBeamed", "stepBarline", "stepPerDot", "slurStackGap", "slurFlatSpan",
    ] as const) {
      m[key] = base[key] * noteK;
    }
  }

  if (mg.left !== undefined) m.marginLeft = mg.left;
  if (mg.right !== undefined) m.marginRight = mg.right;
  if (mg.top !== undefined) m.marginTop = mg.top;
  if (mg.bottom !== undefined) m.marginBottom = mg.bottom;
  return m;
}

/**
 * 文本谱的弧线样式。绘制与纵向预留**共用这一个来源**：
 * `slurHeight` 是想要的弧顶高度，贝塞尔的弧顶约为控制点高的 0.75，所以上限按 /0.75 反算。
 * 在此之前 painter 把 `slurHeight` 直接丢掉、按 musicpp 的对数公式画（跨度大时高出一倍多），
 * 而 layout 又按 `slurHeight` 预留——两套数对不上。
 */
export function puSlurStyle(m: PuMetrics, color: number): SlurStyle {
  return {
    thickness: m.slurThickness,
    color,
    maxHeight: m.slurHeight / 0.75,
    // 文本谱的参考实现（番茄原版渲染）弧高是**恒定**的（控制点固定在 top-10，与跨度无关），
    // 所以这里上下限同值：长弧不长高、短弧也不塌成直线。
    minHeight: m.slurHeight / 0.75,
    flatSpan: m.slurFlatSpan,
  };
}

/** 弧线实际占的头顶高度（纵向预留用），与 puSlurStyle 同源。 */
export function puSlurRise(m: PuMetrics): number {
  return SlurTieBase.arcHeight(Infinity, puSlurStyle(m, 0)) * 0.75;
}

/** 文本谱这一路折算给公共倚音几何的度量（见 `src/common/gracenote.ts`）。
 *  painter 画倚音、layout 给倚音留位，用的必须是同一份。 */
export function puGraceMetrics(m: PuMetrics): GraceMetrics {
  return {
    ink: m.digitInkHeight,
    scale: m.graceScale,
    octaveUpY: m.octaveUpY,
    octaveDownY: m.octaveDownY,
    octaveDotGap: m.octaveDotGap,
    octaveDotRadius: m.octaveDotRadius,
    underlineGap: m.underlineGap,
  };
}

/** pu 的音符元素 → 公共倚音几何要的那几个字段。 */
export function puGraceNotes(els: readonly NoteElement[]): GraceNote[] {
  return els.map((gn) => ({
    digit: String(gn.pitch),
    octave: gn.octave,
    duration: gn.duration,
    ...(gn.accidental ? { alter: gn.accidental } : {}),
  }));
}
