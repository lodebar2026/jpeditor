// 文本谱专用排版：AST → 定位结构。
//
// 与本项目 .jpwabc 的排版引擎分开，因为规则本来就不同：文本谱**不自动断行**——
// 一行 `Q:` 就是谱面一行（这正是「原版」的意义），行内按固定步进定位、再整体拉伸
// 到版心宽度；多声部同组上下堆叠并按拍位横向对齐。
//
// 只算位置、不碰绘图，绘制在 painter.ts。这样播放高亮只需拿定位结构里的锚点，
// 不必反查 SVG。

import type {
  InlineLayerElement,
  LyricLine,
  Mark,
  LyricSyllable,
  Meter,
  MusicElement,
  NoteElement,
  PuSong,
  ScoreLine,
  SustainElement,
  VoiceGroup,
} from "./ast";
import { contentWidth, puGraceMetrics, puGraceNotes, puSlurRise, type PuMetrics } from "./metrics";
import { graceAdvance } from "../common/gracenote";
import { elementQuarters, takesLyric, tupletRatios } from "./ast";
import { paginate, type SystemBlock } from "../jianpu/vertical";

/** 一个占位的谱面符号（音符 / 增时线 / 小节线）。 */
export interface PlacedItem {
  /** 占位序号（只数音符/增时线/小节线） */
  index: number;
  /** 在 voice.elements 里的下标——记号的 start/end 用的是这个坐标系 */
  srcIndex: number;
  /** 锚点 x（行坐标系；数字按墨迹居中于此） */
  x: number;
  /** 自然宽度（拉伸前），供两端对齐用 */
  advance: number;
  element: MusicElement;
  /** 起始拍位（小节内），用于减时线分组与多声部对齐 */
  beat: number;
  /** 时值（拍） */
  beats: number;
  /** 本音符所跟的歌词音节，逐段一个（缺段为 null） */
  syllables: Array<LyricSyllable | null>;
  /** 纵向偏移：`{dsb}` 并排块里，主旋律这一段要下移半个行距 */
  dy?: number;
}

/** 一条跨若干符号的记号（弧线 / 多连音 / 跳房子 / 渐强渐弱），已换算成行内坐标。 */
export interface PlacedMark {
  /** 纵向偏移：并排块里主旋律那一段的记号也要跟着下移 */
  dy?: number;
  mark: Mark;
  x0: number;
  x1: number;
  /** 弧线/多连音的顶点 y（相对该声部的音符基线，负为上）。其余记号走固定槽位。 */
  y?: number;
  /** 嵌套层数或 `+` 抬高级别 */
  level: number;
  /** 左端续自上一行 / 右端续到下一行（弧线与跳房子支持跨行） */
  openLeft: boolean;
  openRight: boolean;
}

/**
 * 临时伴奏 `{bz…}`：画在主旋律上方的小字号行。
 * 临时多声部 `{dsb…}`：**并排块**——括起的内容与主旋律的对应片段上下并排、同字号，
 * 左（或右）侧一个大花括号；主旋律在这一段里下移半个行距，并排段外仍在原位。
 */
export interface PlacedLayer {
  layer: InlineLayerElement;
  items: PlacedItem[];
  underlines: PlacedUnderline[];
  /** `{dsb}` 的并排块信息；`{bz}` 没有 */
  split?: PlacedSplit;
}

export interface PlacedSplit {
  /** 上行（括起的内容）相对主旋律基线的偏移，负值 */
  dy: number;
  line: ScoreLine;
  marks: PlacedMark[];
  /** 花括号：并排段在行内开始就画左向的，在行内结束就画右向的 */
  braceLeftX?: number;
  braceRightX?: number;
  braceTop: number;
  braceBottom: number;
}

/** 一条减时线段：第 level 层，从 x0 到 x1。 */
export interface PlacedUnderline {
  level: number;
  x0: number;
  x1: number;
  dy?: number;
}

export interface PlacedVoice {
  voice: ScoreLine;
  /** 音符基线 y（页坐标系） */
  y: number;
  items: PlacedItem[];
  underlines: PlacedUnderline[];
  marks: PlacedMark[];
  layers: PlacedLayer[];
  /** 各段歌词的基线 y，与 voice.lyrics 平行 */
  lyricY: number[];
}

export interface PlacedGroup {
  group: VoiceGroup;
  voices: PlacedVoice[];
  /** 说明性文字（`W:`）的基线 y */
  textY: number;
  /** 连谱号：多声部时从首声部画到末声部 */
  braceTop: number;
  braceBottom: number;
  hasBrace: boolean;
  /** `&sbf` 标出的分声部起点（行内 x）；没标就从 system 左缘起 */
  braceFromX?: number;
}

export interface PlacedPage {
  groups: PlacedGroup[];
  /** 本页属于第几首（一首多唱时用来决定是否重画标题） */
  song: number;
  /** 是否是该首的首页——首页才画标题、作者、调号拍号 */
  firstOfSong: boolean;
}

export interface PlacedScore {
  pages: PlacedPage[];
  metrics: PuMetrics;
  /** 内容最下沿（连续长图模式据此定页高） */
  contentBottom: number;
  /** 内容最右沿（行内坐标；连续长图模式据此定页宽） */
  contentRight: number;
}

/** 音符/增时线的时值（拍）。实现在 ast.ts::elementQuarters（与导出侧共用同一份精确算法）。 */
export function elementBeats(el: MusicElement): number {
  return elementQuarters(el).toFloat();
}

function isBeamed(el: MusicElement): boolean {
  return el.kind === "note" && el.duration > 4;
}

/**
 * 把一行歌词的音节按顺序发给该行「跟词」的符号。
 * 空音节（源码里的 `@` / `/`）本身就代表跳过一个音符，所以照序发即可。
 */
/**
 * 一个音节画出来之后，**墨迹**在锚点左右各伸出多少（音节按**主体**居中于锚点，尾随标点挂在右边——
 * 同 painter.ts::paintSyllables）。由绘制端注入：排版这一层不碰字体。
 */
export type LyricMeasure = (syl: LyricSyllable) => { left: number; right: number };

/** 相邻两字（含尾随标点）的**墨迹**之间至少留这么多，按歌词字号计（伸出量由绘制端按墨迹注入）。
 *  量墨迹而不量字面框：汉字字面框左右自带留白，按框约束会把墨迹根本没碰到的行也撑开
 * （按框加 0.12 em 时有 62 组原本不挤的谱行被动，含对照原书 PDF 对过的《圣哉三一歌》长图）。
 *  也不能取 0：墨迹恰好相碰（「日|子」）照样是挤在一起的字。 */
const LYRIC_MIN_GAP_EM = 0.1;
/** 为给歌词让位，音符步进最多压到两端对齐算出的系数的这么多倍；再撑不下就让这一行超宽。 */
const LYRIC_MIN_SCALE_RATIO = 0.6;

/**
 * 两端对齐 + 歌词防重叠，一次解出每个符号的最终 x。
 *
 * 横向步进只按拍值走（layoutVoiceLine），**不看字宽**：两个四分音符挂「荣耀，」「哈利路亚」
 * 这类长音节会叠在一起，行被压缩（超宽）时更甚。从前的做法是整行乘一个缩放系数了事。
 *
 * 这里把各声部的符号 x 归并成**共享的列**（多声部已按拍位对齐，同拍位 x 相同），
 * 列的位置取「前一列 + 系数 × 自然步进」与「同声部同一段里前一个有字的列 + 两字半宽 + 间隙」
 * 的较大者。总宽随系数单调，二分找系数让总宽落到目标宽度：
 * 两端对齐的行等于原来的目标宽；不拉伸的行（番茄）不超版心就保持原系数。
 * **不相撞的行解出来就是原来的系数**，落点一点不动（《圣哉三一歌》对照原书 PDF 对过）。
 * 音符压到 `LYRIC_MIN_SCALE_RATIO` 仍放不下（光歌词就比版心宽）时，歌词约束按比例打折守住版心。
 */
function placeColumns(
  lines: ReadonlyArray<{ items: PlacedItem[]; width: number }>,
  lyrics: ReadonlyArray<readonly LyricLine[]>,
  scale: number,
  stretchable: boolean,
  width: number,
  m: PuMetrics,
  measure: LyricMeasure | undefined,
): void {
  const natural = Math.max(...lines.map((l) => l.width), 1);
  const apply = (xs: (x: number) => number, s: number): void => {
    for (const l of lines) {
      for (const it of l.items) {
        it.x = xs(it.x);
        it.advance *= s;
      }
    }
  };
  if (!measure) {
    apply((x) => x * scale, scale);
    return;
  }
  // 共享列：各声部符号 x 的并集（自然坐标）
  const EPS = 0.01;
  const cols = [...new Set(lines.flatMap((l) => l.items.map((it) => it.x)))].sort((a, b) => a - b);
  const colsU: number[] = [];
  for (const x of cols) if (colsU.length === 0 || x - colsU[colsU.length - 1]! > EPS) colsU.push(x);
  const colOf = (x: number): number => {
    let lo = 0;
    let hi = colsU.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (colsU[mid]! <= x + EPS) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // 歌词约束：同声部同一段里相邻两个有字的符号，列距至少 D
  const gap = m.lyricSize * LYRIC_MIN_GAP_EM;
  const need = new Map<number, Array<{ from: number; d: number }>>();
  lines.forEach((l, vi) => {
    const verses = lyrics[vi]?.length ?? 0;
    for (let v = 0; v < verses; v++) {
      let prev: { col: number; right: number } | null = null;
      for (const it of l.items) {
        const syl = it.syllables[v];
        if (!syl) continue;
        const e = measure(syl);
        const col = colOf(it.x);
        if (prev && col > prev.col) {
          const d = prev.right + e.left + gap;
          const list = need.get(col) ?? [];
          list.push({ from: prev.col, d });
          need.set(col, list);
        }
        prev = { col, right: e.right };
      }
    }
  });
  // 列位置。f 是歌词约束的折扣（1 = 足额；只有整行放不进版心时才往下打）。
  const positions = (s: number, f = 1): { X: number[]; raised: boolean } => {
    const X = new Array<number>(colsU.length).fill(0);
    X[0] = s * colsU[0]!;
    let raised = false;
    for (let c = 1; c < colsU.length; c++) {
      let x = X[c - 1]! + s * (colsU[c]! - colsU[c - 1]!);
      for (const { from, d } of need.get(c) ?? []) {
        const want = X[from]! + d * f;
        if (want > x + 1e-9) {
          x = want;
          raised = true;
        }
      }
      X[c] = x;
    }
    return { X, raised };
  };
  const totalOf = (X: number[], s: number): number =>
    X[X.length - 1]! + s * (natural - colsU[colsU.length - 1]!);
  const first = positions(scale);
  // 没有哪一列被歌词撑开：照老样子整行乘系数。逐列累加与直接相乘在末位上会差 0.01，
  // 不相撞的行就该一个坐标都不动。
  if (!first.raised) {
    apply((x) => x * scale, scale);
    return;
  }
  const target = stretchable ? natural * scale : Math.min(totalOf(first.X, scale), width);
  /** total 随参数单调增：二分取总宽不超过 target 的最大参数。 */
  const largest = (lo: number, hi: number, total: (v: number) => number): number => {
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (total(mid) > target) hi = mid;
      else lo = mid;
    }
    return lo;
  };
  let s = scale;
  let f = 1;
  if (totalOf(first.X, s) > target + EPS) {
    // 压音符步进给歌词让位
    const sMin = scale * LYRIC_MIN_SCALE_RATIO;
    if (totalOf(positions(sMin).X, sMin) <= target) {
      s = largest(sMin, scale, (v) => totalOf(positions(v).X, v));
    } else {
      // 音符压到底，光歌词还是比版心宽（窄纸上一串长英文词）：歌词约束按比例打折，
      // 整行守住版心——字挨得更紧、甚至微叠，也不能伸出纸外被裁掉
      s = sMin;
      f = largest(0, 1, (v) => totalOf(positions(sMin, v).X, sMin));
    }
  }
  const X = positions(s, f).X;
  apply((x) => X[colOf(x)]!, s);
}

function assignLyrics(items: PlacedItem[], lyrics: readonly LyricLine[]): void {
  lyrics.forEach((line, verse) => {
    let cursor = 0;
    for (const item of items) {
      if (!takesLyric(item.element)) continue;
      const syl = line.syllables[cursor++] ?? null;
      item.syllables[verse] = syl && syl.text.length > 0 ? syl : null;
    }
  });
}

/** 算一行的自然布局（x 从 0 起），返回符号序列与自然总宽。 */
function layoutVoiceLine(
  voice: ScoreLine,
  m: PuMetrics,
  ctx: BeatCtx = {},
): { items: PlacedItem[]; width: number; groups: number[]; tail: number } {
  // 只有音符/增时线/小节线占位；`~`/`^` 与内联层不进步进序列。
  const flat = voice.elements.filter(
    (el) => el.kind === "note" || el.kind === "sustain" || el.kind === "barline",
  );
  const ratios = tupletRatios(voice);
  // `{dsb}` 并排块的花括号要挤在前一个符号与并排段之间，得先给它让出位置；
  // 并排段**结束**那头还有一个右括号，同样要让
  const splitAt = new Set<number>();
  const splitEnd = new Set<number>();
  voice.elements.forEach((el, i) => {
    if (el.kind !== "inline-layer" || el.role !== "voice") return;
    splitAt.add(i);
    let total = 0;
    for (const inner of el.elements) total += elementBeats(inner);
    let at = flat.findIndex((f) => voice.elements.indexOf(f) > i);
    if (at < 0) return;
    let acc = 0;
    for (; at < flat.length; at++) {
      acc += elementBeats(flat[at]!);
      if (acc >= total - 1e-6) break;
    }
    // 让位要加在**末个音符之后**（右括号就落在那儿），不是段末小节线之后
    let after = at;
    while (after + 1 < flat.length && flat[after + 1]!.kind === "barline") after += 1;
    if (after < flat.length - 1) splitEnd.add(at);
  });
  const items: PlacedItem[] = [];
  let x = 0;
  let beat = 0;

  flat.forEach((el, i) => {
    const srcIndex = voice.elements.indexOf(el);
    const r = ratios[srcIndex];
    const beats = elementBeats(el) * (r ? r.num / r.den : 1);
    items.push({
      index: i,
      srcIndex,
      x: 0,
      advance: 0,
      element: el,
      beat,
      beats,
      syllables: [],
    });
    if (el.kind === "barline") beat = 0;
    else beat += beats;
  });

  // 紧排的判据就是「同一条减时线下」，与减时线本身同一把尺子：拍组在这里算一次，
  // 连同 items 一起带出去给 computeUnderlines 用，两处不各算一遍。
  const { groups, tail } = beatGroups(items, ctx);

  flat.forEach((el, i) => {
    const srcIndex = items[i]!.srcIndex;
    items[i]!.x = x;
    const next = flat[i + 1];
    let advance: number;
    if (next === undefined) {
      advance = el.kind === "barline" ? 0 : m.stepPlain;
    } else if (el.kind === "barline" || next.kind === "barline") {
      advance = m.stepBarline;
    } else {
      advance = isBeamed(el) && isBeamed(next) && groups[i] === groups[i + 1] ? m.stepBeamed : m.stepPlain;
    }
    if (el.kind === "note") advance += m.stepPerDot * el.dots;
    // `&sbf` 的小节线后面要挤进一个连谱号（它离音符 1.41 个墨迹高），所以额外让出
    // 一个半墨迹高——按倍数加不行，行被压缩后连谱号会压到小节线上
    if (el.kind === "barline" && el.ornaments.some((o) => o.name === "sbf")) {
      advance += m.digitInkHeight * 1.5;
    }
    // 变音记号写在数字前，得给它让出位置
    if (next?.kind === "note" && next.accidental !== undefined) advance += m.accidentalWidth;
    // 前倚音也排在数字左边，同样要让位——不让的话倚音会挤在前后两个音符正中间，
    // 看起来像挂在了左边那个音符上（原版给它让出的正是这么多）
    // 宽度走公共那一份（带升降号的倚音要多占一截，不是「颗数 × 常数」）
    if (next?.kind === "note" && next.graceBefore.length > 0) {
      advance += graceAdvance(puGraceNotes(next.graceBefore), puGraceMetrics(m));
    }
    if (el.kind === "note" && el.graceAfter.length > 0) {
      advance += graceAdvance(puGraceNotes(el.graceAfter), puGraceMetrics(m));
    }
    if (splitEnd.has(i)) advance += m.digitInkHeight * 1.05;
    // 两个符号之间夹着并排块的话，中间要放得下一个花括号（原版给的间距比普通小节线宽 0.75）
    if (next !== undefined) {
      const nextAt = voice.elements.indexOf(next);
      for (const at of splitAt) {
        if (at > srcIndex && at < nextAt) {
          advance += m.digitInkHeight * 1.05;
          break;
        }
      }
    }
    items[i]!.advance = advance;
    x += advance;
  });

  return { items, width: x, groups, tail };
}

/** 一行的拍组上下文：行首拍号、上一行开口小节已用的拍数、是不是整首的头一行。
 *  三样都只给 beatGroups 用，由 layoutSong 逐行往下带。 */
interface BeatCtx {
  meter?: Meter;
  /** 跨行小节：上一行那个开口小节已经算到哪个拍位（beatGroups 的 tail） */
  carryIn?: number;
  /** 整首的头一行——首小节不满一小节就是弱起，拍位要按小节末尾对齐 */
  songStart?: boolean;
  /** 整首的末一行——末小节不满不补（musicpp: `this == measures.back()`） */
  songEnd?: boolean;
}

/**
 * 谱面拍组：一条减时线连到哪一个音符为止，只由**时值**决定——同一组内连、跨组断。
 * 移植自 musicpp `MusicData::processJpBeam`。减时线的连断与横向紧排（`stepBeamed`）
 * 共用这一份，一行只算一次（`layoutVoiceLine` 算好带出来）。
 *
 * - 组长（以四分音符为 1）：x/4、x/2 是一拍一组；**复拍子**（分母 8、分子是 3 的
 *   倍数：3/8 6/8 9/8 12/8）三个八分为一组，即 1.5 个四分拍。9/8 的一小节九个八分
 *   因此排成 3+3+3，而不是按整四分拍切出的 2+2+2+2+1。简谱那路的
 *   `score.ts::autoBeamGroup` 早有同一条，两边口径要一致。
 * - **残节**（弱起，或被反复切开的那半个小节）按小节末尾对齐：拍位整体加上
 *   `整小节时值 − 本小节时值`，组界才落在谱面该断的地方。两条例外同原文：下一小节的
 *   时值正好等于要补的那一截（首尾配对的两个残节）不补，末小节不补。
 * - 跨行的小节接着上一行算：续行以 `|/` 开头、拍位却从 0 重来（见 layoutVoiceLine），
 *   不接上就会在续行头一个音上错开一组。musicpp 的 measure 本来就是整的，没这一层。
 *
 * 拍号取行首那个，曲中的 `"p:3/4"`（`BarlineElement.temporaryMeter`）逐小节改写。
 */
function beatGroups(items: PlacedItem[], ctx: BeatCtx = {}): { groups: number[]; tail: number } {
  // 先按小节线切段：段 = 一个小节里的占位符号（小节线本身当分隔，不进段）
  const segs: { from: number; to: number; meter: Meter | undefined; carried: boolean }[] = [];
  let cur = ctx.meter;
  let from = 0;
  let carried = false; // 本段是不是上一行那个小节的后半（行首 `|/`）
  items.forEach((it, i) => {
    if (it.element.kind !== "barline") return;
    segs.push({ from, to: i, meter: cur, carried });
    if (it.element.temporaryMeter) cur = it.element.temporaryMeter;
    carried = it.element.type === "hidden";
    from = i + 1;
  });
  segs.push({ from, to: items.length, meter: cur, carried });

  const durOf = (seg: { from: number; to: number }): number => {
    let dur = 0;
    for (let i = seg.from; i < seg.to; i++) dur += items[i]!.beats;
    return dur;
  };
  // 整曲末小节 = 最后一个非空段（行以小节线收尾时末段是空的）
  let lastFilled = -1;
  segs.forEach((seg, si) => { if (seg.to > seg.from) lastFilled = si; });
  const out = new Array<number>(items.length).fill(0);
  let tail = 0; // 行末那个开口小节（跨行未收）算到哪个拍位——下一行的续段接着它
  segs.forEach((seg, si) => {
    const size =
      seg.meter !== undefined && seg.meter.denominator === 8 && seg.meter.numerator % 3 === 0
        ? 1.5
        : 1;
    let offset = seg.carried ? ctx.carryIn ?? 0 : 0;
    // 残节（弱起、被反复切开的那半个）按小节末尾对齐。两种不补：行末那个开口小节
    // （跨行未收，后半在下一行），以及整曲的末小节（musicpp: `this == measures.back()`）。
    // 曲首那个弱起例外——整行只有它一节时也得补。
    const openTail = si === segs.length - 1 && !(si === 0 && ctx.songStart === true);
    if (!seg.carried && !openTail && !(ctx.songEnd === true && si === lastFilled) &&
        seg.meter !== undefined) {
      const expect = (seg.meter.numerator * 4) / seg.meter.denominator;
      const skip = expect - durOf(seg);
      const next = segs[si + 1];
      // 例外同 musicpp：下一小节的时值正好等于要补的那一截（首尾配对的两个残节）就不补
      if (skip > 1e-9 && !(next && Math.abs(durOf(next) - skip) < 1e-9)) offset = skip;
    }
    for (let i = seg.from; i < seg.to; i++) {
      out[i] = Math.floor((offset + items[i]!.beat) / size + 1e-9);
    }
    // 末段非空就是行末的开口小节：行以小节线收尾时它是空的，tail 留 0
    if (si === segs.length - 1 && seg.to > seg.from) tail = offset + durOf(seg);
  });
  return { groups: out, tail };
}

/** 同一拍组内连续的减时线音符连成一条线，跨组断开（`~`/`^` 可强制连断）。 */
function computeUnderlines(
  voice: ScoreLine,
  items: PlacedItem[],
  m: PuMetrics,
  groupAt: number[],
): PlacedUnderline[] {
  // 源码里的 `~`（强制连）/`^`（强制断）按它在元素序列里的位置生效
  const forceJoin = new Set<number>();
  const forceSplit = new Set<number>();
  let seen = 0;
  for (const el of voice.elements) {
    if (el.kind === "note" || el.kind === "sustain" || el.kind === "barline") {
      seen += 1;
      continue;
    }
    if (el.kind === "beat-boundary") {
      (el.behavior === "join" ? forceJoin : forceSplit).add(seen - 1);
    }
  }

  const out: PlacedUnderline[] = [];
  const levelOf = (it: PlacedItem): number =>
    it.element.kind === "note" ? Math.max(0, Math.log2(it.element.duration / 4)) : 0;

  const maxLevel = Math.max(0, ...items.map(levelOf));
  for (let level = 1; level <= maxLevel; level++) {
    let runStart: PlacedItem | null = null;
    let runEnd: PlacedItem | null = null;
    const flush = (): void => {
      if (!runStart || !runEnd) return;
      out.push({
        level,
        x0: runStart.x - m.underlineHalfSpan,
        x1: runEnd.x + m.underlineHalfSpan,
      });
      runStart = null;
      runEnd = null;
    };
    items.forEach((it, i) => {
      if (levelOf(it) < level) {
        flush();
        return;
      }
      const prev = items[i - 1];
      const breaks =
        prev === undefined ||
        forceSplit.has(i - 1) ||
        (!forceJoin.has(i - 1) && groupAt[i - 1] !== groupAt[i]);
      if (runStart !== null && breaks) flush();
      if (runStart === null) runStart = it;
      runEnd = it;
    });
    flush();
  }
  return out;
}

/** 和弦/注释那一行**墨迹顶**（相对音符基线，负为上）：基线在 annotationY，字往上长。 */
function annotationTop(m: PuMetrics): number {
  return m.annotationY - m.annotationSize * 0.9;
}

/**
 * 一组曲行头顶需要留多少空间——记号是往上画的（弧线、跳房子、渐强渐弱、装饰音、
 * 临时伴奏），不预留就会压到上一组的歌词。
 */
function groupHeadroom(group: VoiceGroup, m: PuMetrics): number {
  let top = m.annotationY; // 注释/和弦这一槽是常备的
  const consider = (v: number): void => {
    if (v < top) top = v;
  };
  for (const voice of group.voices) {
    for (const mark of voice.marks) {
      const level = Math.max(1, mark.level);
      if (mark.type === "volta") consider(m.laneVolta - (level - 1) * m.laneLevelStep);
      else if (mark.type === "crescendo" || mark.type === "decrescendo") {
        consider(m.laneWedge - (level - 1) * m.laneLevelStep - m.wedgeMouth / 2);
      } else {
        consider(-m.digitInkHeight / 2 - m.slurStackGap - (level - 1) * m.laneSlurStep - puSlurRise(m));
      }
    }
    for (const el of voice.elements) {
      if (el.kind === "inline-layer") consider(m.layerY - m.digitInkHeight * 0.6);
      // 和弦/注释画在 annotationY 那条**基线**上，字还要往上长一截——只留 annotationY
      // 的话，system 间距一收紧（gapGroup 按无和弦的底本量得）和弦就顶进上一组的低音点。
      // 再往上让一个数字高：只让到墨迹顶是「不打架」，两组之间还得看得出是两组。
      if (el.kind === "note" && (el.chord || el.annotation)) {
        consider(annotationTop(m) - m.digitInkHeight);
      }
      if (el.kind === "sustain" && el.chord) consider(annotationTop(m) - m.digitInkHeight);
      if (el.kind === "note" || el.kind === "sustain" || el.kind === "barline") {
        for (const orn of el.ornaments) {
          // 换气的 V 有自己的高度（照原版放在基线上方两个墨迹高），不走记号槽
          if (orn.name === "hx") consider(-m.digitInkHeight * 1.05);
          else consider(m.laneOrnament - orn.level * m.laneLevelStep - m.digitInkHeight * 0.7);
        }
      }
    }
  }
  if (group.texts.length > 0) consider(m.textLineY);
  return -top;
}

/**
 * 一个声部**自己头顶**需要多少空间（弧线、和弦注释、装饰记号都画在音符上方）。
 * 组间用 groupHeadroom，组内声部之间用这个——否则四声部谱里第 3 声部的弧线
 * 会画进它上方的歌词块。
 */
function voiceHeadroom(voice: ScoreLine, m: PuMetrics): number {
  let top = 0;
  const consider = (v: number): void => {
    if (v < top) top = v;
  };
  for (const mark of voice.marks) {
    const level = Math.max(1, mark.level);
    if (mark.type === "volta") consider(m.laneVolta - (level - 1) * m.laneLevelStep);
    else if (mark.type === "crescendo" || mark.type === "decrescendo") {
      consider(m.laneWedge - (level - 1) * m.laneLevelStep - m.wedgeMouth / 2);
    } else {
      // 弧线现在贴着音符堆叠顶（见 placeMarks），头顶只需留这么高
      // （puSlurRise 与 painter 实际画的弧同源，见 metrics.ts::puSlurStyle）
      consider(-m.digitInkHeight / 2 - m.slurStackGap - (level - 1) * m.laneSlurStep - puSlurRise(m));
    }
  }
  for (const el of voice.elements) {
    if (el.kind === "note" && (el.chord || el.annotation)) consider(annotationTop(m));
    if (el.kind === "sustain" && el.chord) consider(annotationTop(m)); // 增时线上的和弦同样要留头顶
    if (el.kind === "note" || el.kind === "sustain" || el.kind === "barline") {
      for (const orn of el.ornaments) {
        if (orn.name === "hx") consider(-m.digitInkHeight * 1.05);
        else consider(m.laneOrnament - orn.level * m.laneLevelStep - m.digitInkHeight * 0.7);
      }
    }
  }
  return -top;
}

/**
 * 音符「上方堆叠」的顶端（相对基线，负为上）：没有高八度点时就是数字墨迹顶，
 * 有几个高八度点就抬到最上面那个点的上缘。弧线据此定位——与 .jpwabc 谱面同一规则
 * （见 layout.ts 的 NoteEntry.entryTop / slurRung），固定槽位会离音符太远。
 */
function stackTop(el: MusicElement | undefined, m: PuMetrics): number {
  const inkTop = -m.digitInkHeight / 2;
  if (el?.kind !== "note" || el.octave <= 0) return inkTop;
  return m.octaveUpY - (el.octave - 1) * m.octaveDotGap - m.octaveDotRadius;
}


/**
 * 一个音符**最低的墨迹**（相对基线）：数字墨迹底、减时线最下一层、低音点，取最低的那个。
 * 低音点的落点与 `painter` 里画点用的是同一个公式（`.jpwabc` 的 entryBottom 规则），
 * 两处必须一致，否则歌词避让会按错的底算。
 */
export function noteInkBottom(note: NoteElement, m: PuMetrics): number {
  const beams = Math.max(0, Math.round(Math.log2(note.duration / 4)));
  const beamBottom =
    beams > 0
      ? m.underlineY + (beams - 1) * m.underlineGap + m.underlineWidth
      : m.digitInkHeight / 2;
  if (note.octave >= 0) return Math.max(m.digitInkHeight / 2, beamBottom);
  const firstDot = Math.max(m.octaveDownY, beamBottom + m.slurStackGap + m.octaveDotRadius);
  return firstDot + (-note.octave - 1) * m.octaveDotGap + m.octaveDotRadius;
}

/**
 * `&sbf`（声部符）标出的分声部位置：取标着它的那条小节线**之后**第一个符号的 x。
 * 组内任一声部标了都算，取最早的一处。
 */
function braceStartX(voices: readonly PlacedVoice[]): number | null {
  let best: number | null = null;
  for (const v of voices) {
    const items = v.items;
    for (let i = 0; i < items.length; i++) {
      const el = items[i]!.element;
      if (el.kind !== "barline") continue;
      if (!el.ornaments.some((o) => o.name === "sbf")) continue;
      const next = items[i + 1];
      const x = next ? next.x : items[i]!.x;
      if (best === null || x < best) best = x;
    }
  }
  return best;
}

/** 一行里最低的墨迹（歌词要据此下推，免得贴到低音点上）。 */
function lineInkBottom(items: readonly PlacedItem[], m: PuMetrics): number {
  let bottom = m.digitInkHeight / 2;
  for (const it of items) {
    if (it.element.kind !== "note" || it.element.hidden) continue;
    const b = noteInkBottom(it.element, m);
    if (b > bottom) bottom = b;
  }
  return bottom;
}

/** 把记号的元素下标区间换算成行内 x 区间。 */
function placeMarks(voice: ScoreLine, items: PlacedItem[], m: PuMetrics): PlacedMark[] {
  if (items.length === 0) return [];
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const at = (srcIndex: number, side: "start" | "end"): PlacedItem => {
    // 记号端点未必正落在占位符号上（例如 `(` 紧跟在 `~` 后），取最近的一个
    let best = side === "start" ? last : first;
    for (const it of items) {
      if (side === "start") {
        if (it.srcIndex >= srcIndex && it.srcIndex < best.srcIndex) best = it;
      } else if (it.srcIndex <= srcIndex && it.srcIndex > best.srcIndex) best = it;
    }
    if (side === "start" && best.srcIndex < srcIndex) best = first;
    return best;
  };
  const out: PlacedMark[] = [];
  for (const mark of voice.marks) {
    const openLeft = mark.continuationFromPrevious === true;
    const openRight = mark.continuationToNext === true;
    // 跨行的弧线/多连音**只画后半条**：印刷原版里行末那截敞口的弧不画，下一行才从行首
    // 起弧画到 `)`（《太阳出来喜洋洋》第 1→2 行的 `(6, - | 6,) (-` 就是这样）。
    // 跳房子相反，行末那截要接着画（房号不重复），所以只挡弧线。
    if (openRight && (mark.type === "slur" || mark.type === "tuplet")) continue;
    const a = openLeft ? first : at(mark.start, "start");
    const b = openRight ? last : at(mark.end, "end");
    const level = Math.max(1, mark.level);
    // 弧线/多连音的两端就落在音符的**墨迹中心**上（数字本来就是按墨迹居中排的），
    // 与 .jpwabc 的 addSlurTie 一致——不再往外扩半个音符宽。
    // 端点还挂着别的弧线时各自内缩 dx（= 字号/14），免得两条弧首尾顶在一起。
    const isArc = mark.type === "slur" || mark.type === "tuplet";
    const dx = isArc ? m.digitInkHeight / 0.7 / 14 : 0;
    const chainedLeft = voice.marks.some((o) => o !== mark && o.end === mark.start);
    const chainedRight = voice.marks.some((o) => o !== mark && o.start === mark.end);
    // 渐强渐弱要**包住**起止音符（原版里楔尖就落在音符下方），所以往外扩半个字宽；
    // 跳房子同样往外扩；弧线相反，端点落在墨迹中心。
    const isWedge = mark.type === "crescendo" || mark.type === "decrescendo";
    const spread = isWedge ? m.digitInkHeight * 0.55 : m.underlineHalfSpan;
    const padLeft = isArc ? (chainedLeft ? dx : 0) : -spread;
    const padRight = isArc ? (chainedRight ? dx : 0) : -spread;
    // 跳房子的横线**贴着两侧的小节线**（原版：起点 = 前一条小节线 +2、终点 = 后一条
    // 小节线 -2，都按 1000 宽的版面量的），而不是贴房内首末音符。
    let vx0: number | null = null;
    let vx1: number | null = null;
    if (mark.type === "volta") {
      const gap = m.digitInkHeight * 0.12;
      for (const it of items) {
        if (it.element.kind !== "barline") continue;
        if (it.x <= a.x) vx0 = it.x + gap;
        if (it.x >= b.x && vx1 === null) vx1 = it.x - gap;
      }
    }
    const placed: PlacedMark = {
      mark,
      x0: openLeft ? a.x - m.stepPlain * 0.5 : (vx0 ?? a.x + padLeft),
      x1: openRight ? b.x + m.stepPlain * 0.5 : (vx1 ?? b.x - padRight),
      level,
      openLeft,
      openRight,
    };
    if (mark.type === "slur" || mark.type === "tuplet") {
      // 取两端里更高的那个堆叠顶，再让开一个 stackGap；嵌套层按 level 继续上移
      const top = Math.min(stackTop(a.element, m), stackTop(b.element, m));
      placed.y = top - m.slurStackGap - (level - 1) * m.laneSlurStep;
    }
    // 只有**两端都**落在并排块的下行里，这个记号才跟着下移；跨过并排块的（比如
    // 从块前一直画到块后的跳房子）另行处理，见下面的「抬到上行之上」
    if (a.dy !== undefined && b.dy !== undefined) placed.dy = a.dy;
    out.push(placed);
  }
  return out;
}

/** 内联层：`{bz}` 是上方小字号行，`{dsb}` 是与主旋律并排的一块（见 PlacedLayer）。 */
function placeLayers(
  voice: ScoreLine,
  items: PlacedItem[],
  m: PuMetrics,
  ctx: BeatCtx = {},
): PlacedLayer[] {
  const out: PlacedLayer[] = [];
  voice.elements.forEach((el, srcIndex) => {
    if (el.kind !== "inline-layer") return;
    // 起点对齐主旋律里紧随其后的那个符号
    const hostAt = items.findIndex((it) => it.srcIndex >= srcIndex);
    const host = hostAt >= 0 ? items[hostAt] : items[items.length - 1];
    const originX = host ? host.x : 0;
    const inner: ScoreLine = {
      voice: voice.voice,
      elements: el.elements,
      marks: el.marks,
      lyrics: [],
      raw: el.code,
      source: el.source,
    };
    const laid = layoutVoiceLine(inner, m, { meter: ctx.meter });

    if (el.role !== "voice" || hostAt < 0) {
      // `{bz}`：上方另排一小行，按 layerScale 缩小
      for (const it of laid.items) {
        it.x = originX + it.x * m.layerScale;
        it.advance *= m.layerScale;
        it.syllables = [];
      }
      out.push({ layer: el, items: laid.items, underlines: computeUnderlines(inner, laid.items, m, laid.groups) });
      return;
    }

    // `{dsb}`：并排块。括起的内容排在上行，主旋律从 host 起**等时长**的一段排在下行，
    // 两行同字号、按拍位对齐（原版里两行结构本就一致）。
    const split = m.digitInkHeight * 1.552;
    let total = 0;
    for (const it of laid.items) total += it.beats;
    let acc = 0;
    let lastAt = hostAt;
    for (let i = hostAt; i < items.length; i++) {
      lastAt = i;
      acc += items[i]!.beats;
      if (acc >= total - 1e-6) break;
    }
    // 段末紧跟的小节线也算这一段的（`{dsb … |}` 多半以小节线收尾，两行要对到同一条上）
    while (lastAt + 1 < items.length && items[lastAt + 1]!.element.kind === "barline") {
      lastAt += 1;
    }
    // 主旋律这一段的拍位 → x
    const cols: Array<{ beat: number; bar: boolean; x: number }> = [];
    let at = 0;
    for (let i = hostAt; i <= lastAt; i++) {
      const it = items[i]!;
      cols.push({ beat: at, bar: it.element.kind === "barline", x: it.x });
      at += it.beats;
    }
    let beatAt = 0;
    laid.items.forEach((it) => {
      const bar = it.element.kind === "barline";
      const hit =
        cols.find((c) => c.bar === bar && Math.abs(c.beat - beatAt) < 1e-6) ??
        cols.find((c) => Math.abs(c.beat - beatAt) < 1e-6);
      if (hit) it.x = hit.x;
      else {
        // 拍位对不上（两行写法不同）就按比例落在区间里
        const span = cols[cols.length - 1]!.x - cols[0]!.x;
        it.x = cols[0]!.x + (total > 0 ? (beatAt / total) * span : 0);
      }
      it.syllables = [];
      beatAt += it.beats;
    });
    // 并排段之后只剩小节线的话，那就是一直排到行末：末尾那几条线也跟着下行走
    let tailHasNote = false;
    for (let i = lastAt + 1; i < items.length; i++) {
      if (items[i]!.element.kind !== "barline") {
        tailHasNote = true;
        break;
      }
    }
    const endAt = tailHasNote ? lastAt : items.length - 1;
    // 主旋律这一段下移
    for (let i = hostAt; i <= endAt; i++) items[i]!.dy = split;
    const underlines = computeUnderlines(inner, laid.items, m, laid.groups);
    for (const u of underlines) u.dy = -split;
    const marks = placeMarks(inner, laid.items, m);
    const placed: PlacedSplit = {
      dy: -split,
      line: inner,
      marks,
      braceTop: -split - m.digitInkHeight * 0.64,
      braceBottom: split + m.digitInkHeight * 0.64,
    };
    // 花括号画在并排段与单行段的交界上，开口朝着并排的两行；一直排到行末就只有左边那个
    if (hostAt > 0) placed.braceLeftX = items[hostAt]!.x - m.digitInkHeight * 1.55;
    if (tailHasNote) {
      // 右花括号收在并排段最后一个音符之后、那条小节线**之前**。间距与左括号对称：
      // 离相邻音符 1.07、离小节线 0.48 个墨迹高（《太阳出来喜洋洋》里多处一致）
      let noteEnd = lastAt;
      while (noteEnd > hostAt && items[noteEnd]!.element.kind === "barline") noteEnd -= 1;
      placed.braceRightX = items[noteEnd]!.x + m.digitInkHeight * 1.07;
    }
    out.push({ layer: el, items: laid.items, underlines, split: placed });
  });
  return out;
}

/**
 * 把一首曲子排成若干页。文本谱自己管分页（`[fenye]`），我们只在一页塞不下时再补断。
 */
export function layoutSong(
  song: PuSong,
  m: PuMetrics,
  songIndex = 0,
  headerBottom = 0,
  measure?: LyricMeasure,
): PlacedPage[] {
  // 可用宽度要扣掉左内边距和末个音符的字形半宽，这样两端对齐后
  // 最后一个音符的墨迹右缘正好落在版心右缘上
  const width = contentWidth(m) - m.bodyLeftPad - m.digitInkHeight * 0.6;

  const bottomLimit = m.pageHeight - m.marginBottom;
  // 拍号一路带过来：头部 `1=D4/4 3/4 5/4` 这类混合拍只有首个是起头拍号，其余由曲中
  // 的 `"p:3/4"` 逐小节改写（`BarlineElement.temporaryMeter`），故要跨行延续。
  // 只有减时线分组用得着（见 beatGroups）。
  let meterCursor: Meter | undefined = song.metadata.meters[0];
  // 跨行小节：上一行行末那个开口小节已用掉的拍数（见 openTailBeats）
  let carryCursor = 0;
  let atSongStart = true; // 整首的头一组——首小节不满就是弱起
  // 末组（整首的最后一个 system）单独判断：太短就不拉伸，留它短着
  const lastPage = song.pages[song.pages.length - 1];
  const lastGroup = lastPage?.groups[lastPage.groups.length - 1];
  // 每组先按**自己的原点**排（光标从 0 起），占位 = 光标推进的那一段（头顶让位 + 声部 + 歌词
  // + 组间距都在里面）；排完交给公共分页器定页与 y（`jianpu/vertical.ts::paginate`，`.jpwabc` 也走它）。
  // 从前这里自己分页：整组挪下页时先把光标重置到页顶、再减位移，下一组被排到页顶之上
  //（日光之下展开档第 2 页第二组 y = −515），挪过去的那组也丢了头顶的让位。
  const blocks: Array<SystemBlock & { group: PlacedGroup }> = [];
  for (const [pageIdx, srcPage] of song.pages.entries()) {
    for (const [groupIdx, group] of srcPage.groups.entries()) {
      let y = 0;
      // 记号往上画，先给这一组留够头顶空间
      const head = groupHeadroom(group, m);
      const baseHead = -m.annotationY;
      if (head > baseHead) y += head - baseHead;
      if (group.texts.length > 0) y += Math.max(0, -m.textLineY - head);

      const beatCtx: BeatCtx = {
        meter: meterCursor,
        carryIn: carryCursor,
        songStart: atSongStart,
        songEnd: group === lastGroup,
      };
      atSongStart = false;
      // 本组之后生效的拍号：以主声部为准（各声部拍号相同）
      for (const el of group.voices[0]?.elements ?? []) {
        if (el.kind === "barline" && el.temporaryMeter) meterCursor = el.temporaryMeter;
      }
      const laidOut = group.voices.map((voice) => layoutVoiceLine(voice, m, beatCtx));
      carryCursor = laidOut[0]?.tail ?? 0;
      // 多声部：同组各行按**拍位**对齐——逐个拍位取各声部里最靠右的 x，统一推齐。
      if (laidOut.length > 1) alignVoices(laidOut);
      // 两端对齐：诗歌本/印刷原版把每个 system 拉到版心右缘；番茄不拉伸，短行就是短的。
      // 无论哪种方言，超宽都要压缩。末组太短则不拉，免得几个音符被扯得满行都是。
      const natural = Math.max(...laidOut.map((l) => l.width), 1);
      const fill = natural / width;
      const stretchable =
        m.justify && !(group === lastGroup && fill < m.justifyMinFill);
      const scale = stretchable
        ? Math.min(width / natural, m.maxStretch)
        : Math.min(1, width / natural);

      // 音节先挂上（只按序号对到跟词的符号上），列位置要看字宽
      laidOut.forEach((l, vi) => {
        const voice = group.voices[vi]!;
        for (const it of l.items) it.syllables = new Array(voice.lyrics.length).fill(null);
        assignLyrics(l.items, voice.lyrics);
      });
      placeColumns(laidOut, group.voices.map((v) => v.lyrics), scale, stretchable, width, m, measure);

      const voices: PlacedVoice[] = [];
      let textY = y + m.textLineY;
      laidOut.forEach((l, vi) => {
        const voice = group.voices[vi]!;
        const underlines = computeUnderlines(voice, l.items, m, l.groups);
        // 第一行歌词的位置是**动态**的：常规按 gapMusicLyric，但一行里若有十六分音符
        // 这样「减时线 + 低音点」叠下来的音，就按最低墨迹再让开一个 stackGap，
        // 免得歌词字顶贴到低音点上。
        const inkBottom = lineInkBottom(l.items, m);
        const firstLyric = Math.max(
          m.gapMusicLyric,
          inkBottom + m.slurStackGap + m.lyricSize * 0.8,
        );
        const lyricY0 = firstLyric;
        // 内联层要先排：`{dsb}` 会给主旋律那一段打上 dy，减时线与记号都得跟着走
        const layers = placeLayers(voice, l.items, m, beatCtx);
        // 并排块里主旋律下移了半个行距，歌词要跟着让开，否则会和下行音符叠在一起
        let splitDrop = 0;
        for (const lay of layers) {
          if (lay.split) splitDrop = Math.max(splitDrop, -lay.split.dy);
        }
        for (const u of underlines) {
          const at = l.items.find((it) => it.x >= u.x0 - 0.01 && it.x <= u.x1 + 0.01);
          if (at?.dy !== undefined) u.dy = at.dy;
        }
        const lyricY = voice.lyrics.map(
          (_, li) => y + lyricY0 + splitDrop + li * m.gapLyricLyric,
        );
        const marks = placeMarks(voice, l.items, m);
        // 并排块的上行会顶到跳房子/记号的高度，跨过它的记号要整体抬到上行之上。
        // 跳房子还得**整行一起抬**——原版里一房二房的横线是同一条高度。
        let voltaLift = 0;
        for (const lay of layers) {
          const sp = lay.split;
          if (!sp || lay.items.length === 0) continue;
          const lx0 = Math.min(...lay.items.map((it) => it.x));
          const lx1 = Math.max(...lay.items.map((it) => it.x));
          // 只抬到**刚好让开上行**为止：原版里跳房子的线就贴在上行弧线上方一点点，
          // 整块抬一个行距会高得离谱
          const innerTop = sp.dy - voiceHeadroom(sp.line, m);
          const need = innerTop - m.digitInkHeight * 0.15;
          for (const mk of marks) {
            if (mk.dy !== undefined || mk.x1 < lx0 || mk.x0 > lx1) continue;
            const lane = mk.mark.type === "volta" ? m.laneVolta : (mk.y ?? m.laneSlur);
            const d = Math.min(0, need - lane);
            if (mk.mark.type === "volta") voltaLift = Math.min(voltaLift, d);
            else if (d < 0) mk.dy = d;
          }
        }
        if (voltaLift < 0) {
          for (const mk of marks) {
            if (mk.mark.type === "volta" && mk.dy === undefined) mk.dy = voltaLift;
          }
        }
        voices.push({
          voice,
          y,
          items: l.items,
          underlines,
          layers,
          marks,
          lyricY,
        });
        // 下一声部：先让过本声部的歌词块，再按「有没有歌词」取不同的间距
        //（歌词字块的下缘比数字低，所以它之后要多让一点）
        const isLast = vi === laidOut.length - 1;
        const hasLyrics = voice.lyrics.length > 0;
        // 并排块把主旋律压低了半个行距，下一声部要连这一段一起让开
        const consumed = hasLyrics
          ? lyricY0 + splitDrop + (voice.lyrics.length - 1) * m.gapLyricLyric
          : splitDrop;
        let after = isLast ? m.gapGroup : hasLyrics ? m.gapLyricMusic : m.gapVoice;
        // 下一声部头顶的弧线/记号也要让开，否则会画进上面的歌词或音符里
        const next = group.voices[vi + 1];
        if (next) {
          after = Math.max(after, voiceHeadroom(next, m) + m.digitInkHeight * 0.6);
        }
        y += consumed + after;
      });

      const hasBrace = voices.length > 1;
      const placedGroup: PlacedGroup = {
        group,
        voices,
        textY,
        braceTop: voices[0]!.y,
        braceBottom: voices[voices.length - 1]!.y,
        hasBrace,
      };
      // `&sbf`（声部符）标在哪条小节线上，连谱号就从那里起——前半段还是单声部，
      // 不该被括进来（原版《同一首歌》第 3 个 system 就是这样：前 4 小节 `8` 占位）。
      const sbf = braceStartX(voices);
      if (sbf !== null) placedGroup.braceFromX = sbf;
      // 源里的 `[fenye]`：新的一页从这组起（长图里也分开，由 layoutDocument 接成一张时多留一段白）
      blocks.push({ group: placedGroup, top: 0, bottom: y, breakBefore: groupIdx === 0 && pageIdx > 0 });
    }
  }
  // 连谱号的上下花头各伸出首/末声部 ≈1.5 个墨迹高（粗线探出 0.85，花头字形高 1.18 线距 =
  // 1.18/4 em × 字号 2.2 墨迹高，见 painter.ts::paintBrace）。末声部底下有歌词时歌词块早把它盖住；
  // 展开档里末声部这一遍没词（同一首歌的 Q2）时，上一组的下花头会压到下一组的上花头。
  // 只在真会相压时把上一块往下撑——不压的一点不动，原样档的行距是对过原书的。
  const braceReach = m.digitInkHeight * (0.85 + (1.18 / 4) * 2.2);
  for (let i = 0; i + 1 < blocks.length; i++) {
    const a = blocks[i]!;
    const b = blocks[i + 1]!.group;
    if (!a.group.hasBrace || !b.hasBrace) continue;
    const need = a.group.braceBottom + 2 * braceReach - b.braceTop + m.digitInkHeight * 0.3;
    if (a.bottom < need) a.bottom = need;
  }
  // 首页要让过标题/词曲/调号那一整块——头部行数因谱而异，写死会压到正文
  const firstTop = Math.max(m.marginTop + m.bodyTop, headerBottom);
  const otherTop = m.marginTop + m.bodyTop * 0.35;
  const laid = paginate(blocks, {
    pageTop: (i) => (i === 0 ? firstTop : otherTop),
    // 连续长图不按高度分页，页高随内容长
    bottom: m.continuous ? Infinity : bottomLimit,
    gap: 0,
  });
  if (laid.length === 0) return [{ groups: [], song: songIndex, firstOfSong: true }];
  return laid.map((pg, i) => ({
    song: songIndex,
    firstOfSong: i === 0,
    groups: pg.map(({ block, y }) => {
      shiftGroup(block.group, y);
      return block.group;
    }),
  }));
}

/**
 * 多声部横向对齐：同一拍位的符号推到同一个 x。
 *
 * 各声部时值往往不同（长音对切分音），所以按「小节序号 + 小节内累计拍数」做键，
 * 而不是按序号。做法是**按拍位归并扫描**：键从早到晚处理，每个键的列 x 取各声部
 * 当前位置的最大值，然后把落后的声部整体右推。
 *
 * （早先的写法用「位移前」的 x 预先算好目标，一行被推右之后后续列不会再跟进，
 * 于是越往后越对不齐——必须边扫边更新。）
 */
function alignVoices(lines: Array<{ items: PlacedItem[]; width: number }>): void {
  // 小节线用 `bar:∞` 作键——它是各声部**共享**的结构，第 n 条就该对齐到同一个 x，
  // 哪怕各声部这一小节的拍数对不上（源里写岔了也该看得出来是同一条线）。
  const keysOf = (items: PlacedItem[]): string[] => {
    let bar = 0;
    return items.map((it) => {
      if (it.element.kind === "barline") {
        const key = `${bar}:Infinity`;
        bar += 1;
        return key;
      }
      return `${bar}:${it.beat.toFixed(4)}`;
    });
  };
  const keys = lines.map((l) => keysOf(l.items));
  // 每行每个键取**首次**出现的位置（同拍位的重复项跟着走即可）
  const indexByKey = keys.map((ks) => {
    const m = new Map<string, number>();
    ks.forEach((k, i) => {
      if (!m.has(k)) m.set(k, i);
    });
    return m;
  });
  const allKeys = [...new Set(keys.flat())].sort((a, b) => {
    const [ba, pa] = a.split(":").map(Number) as [number, number];
    const [bb, pb] = b.split(":").map(Number) as [number, number];
    return ba - bb || pa - pb;
  });

  const delta = lines.map(() => 0);
  const cursor = lines.map(() => 0);
  for (const key of allKeys) {
    // 把各行落在本键之前的符号先按当前位移定位
    lines.forEach((l, li) => {
      const at = indexByKey[li]!.get(key);
      if (at === undefined) return;
      for (; cursor[li]! < at; cursor[li]!++) l.items[cursor[li]!]!.x += delta[li]!;
    });
    let colX = -Infinity;
    lines.forEach((l, li) => {
      const at = indexByKey[li]!.get(key);
      if (at !== undefined) colX = Math.max(colX, l.items[at]!.x + delta[li]!);
    });
    if (colX === -Infinity) continue;
    lines.forEach((l, li) => {
      const at = indexByKey[li]!.get(key);
      if (at === undefined) return;
      delta[li] = colX - l.items[at]!.x;
      l.items[at]!.x = colX;
      cursor[li] = at + 1;
    });
  }
  lines.forEach((l, li) => {
    for (; cursor[li]! < l.items.length; cursor[li]!++) l.items[cursor[li]!]!.x += delta[li]!;
    l.width += delta[li]!;
  });
  const w = Math.max(...lines.map((l) => l.width));
  for (const l of lines) l.width = w;
}

/** 排一整份文档（可含多首「一首多唱」）。 */
export function layoutDocument(
  songs: readonly PuSong[],
  m: PuMetrics,
  headerBottoms: readonly number[] = [],
  measure?: LyricMeasure,
): PlacedScore {
  let pages: PlacedPage[] = [];
  songs.forEach((song, i) => pages.push(...layoutSong(song, m, i, headerBottoms[i] ?? 0, measure)));

  // 连续长图：所有页面首尾相接成一张，源里的 `[fenye]` 只当作一段额外留白
  if (m.continuous && pages.length > 1) {
    const merged: PlacedPage = { groups: [], song: 0, firstOfSong: true };
    let offset = 0;
    for (const [i, pg] of pages.entries()) {
      if (i > 0) {
        const top = pg.groups[0]?.voices[0]?.y ?? 0;
        offset = lowestOf(merged) + m.gapGroup * 1.4 - top;
        for (const g of pg.groups) shiftGroup(g, offset);
      }
      merged.groups.push(...pg.groups);
    }
    pages = [merged];
  }

  return {
    pages,
    metrics: m,
    contentBottom: pages.reduce((b, p) => Math.max(b, lowestOf(p)), 0),
    contentRight: pages.reduce((r, p) => Math.max(r, rightmostOf(p)), 0),
  };
}

/** 一页里最右沿的 x（行内坐标）。 */
function rightmostOf(page: PlacedPage): number {
  let right = 0;
  for (const g of page.groups) {
    for (const v of g.voices) {
      const last = v.items[v.items.length - 1];
      if (last) right = Math.max(right, last.x);
      for (const layer of v.layers) {
        const lastLayer = layer.items[layer.items.length - 1];
        if (lastLayer) right = Math.max(right, lastLayer.x);
      }
    }
  }
  return right;
}

/** 一页里最下沿的 y（末行歌词或末个声部）。 */
function lowestOf(page: PlacedPage): number {
  let bottom = 0;
  for (const g of page.groups) {
    for (const v of g.voices) {
      bottom = Math.max(bottom, v.y, ...v.lyricY);
    }
  }
  return bottom;
}

function shiftGroup(g: PlacedGroup, dy: number): void {
  g.textY += dy;
  g.braceTop += dy;
  g.braceBottom += dy;
  for (const v of g.voices) {
    v.y += dy;
    for (let i = 0; i < v.lyricY.length; i++) v.lyricY[i]! += dy;
  }
}

export type { NoteElement, SustainElement };
