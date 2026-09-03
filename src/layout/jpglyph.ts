// 简谱字形的共用绘制原语。
//
// 三条简谱路（编辑器/成书重排的 layout.ts、文本谱的 pu/painter.ts、混排的 mixed/render.ts）
// 原先各画各的八度点、小节线、拍号——同一样东西三套写法，连**画的是什么**都不一样
//（八度点：前两者用字体的 `.` 字形，pu 手绘矢量圆；小节线：layout 用 GraphicLine，
//  pu 用填充 rect）。这里收一份，差异走 style 参数。
//
// 原语一律是**纯函数**：只认坐标与 style，不认 Entry / MChord / PlacedItem 那些模型类型，
// 各路的坐标换算留在自己的调用点（musicpp 的 `sc = staffHeight/40` 之类别漏进来）。

import { Point, Rect } from "../common/geom";
import { GraphicLine, GraphicPath, PageItem, TextFrame } from "./layout";
import type { BarlineSpec } from "./layout";
import * as S from "../score/score";
import type { Font } from "./font";

/**
 * 实心圆（八度点 / 附点 / 反复点共用）。
 *
 * 四段三次贝塞尔的标准正圆近似（k = 0.5523 = 4/3·(√2−1)）。
 * pu 原先用的是两段近似（控制点 1.34r），腰部比正圆胖出约 3%——小到看不出来，
 * 但没有理由留两套。
 */
export function jpDot(cx: number, cy: number, r: number, color: number): GraphicPath {
  const p = new GraphicPath();
  p.fill = true;
  p.stroke = false;
  p.fillColor = color;
  const k = r * 0.5523;
  p.moveTo(cx - r, cy);
  p.cubicTo(cx - r, cy - k, cx - k, cy - r, cx, cy - r);
  p.cubicTo(cx + k, cy - r, cx + r, cy - k, cx + r, cy);
  p.cubicTo(cx + r, cy + k, cx + k, cy + r, cx, cy + r);
  p.cubicTo(cx - k, cy + r, cx - r, cy + k, cx - r, cy);
  p.close();
  return p;
}

// ─────────────────────────────────────────────────────────── 小节线

/** 小节线的画法参数。上下缘各路自己给（layout 是 jpStaffTop/Bottom、pu 是 barlineHeight
 *  居中于基线），**粗细组合与反复点的排布则一律照 layout 这一份**。 */
export interface BarlineStyle {
  /** 上下缘，相对基线（y 向下为正，所以 top 通常是负的）。 */
  top: number;
  bot: number;
  /** 细线宽 / 粗线宽。相邻两条线的间距也取 heavy（与五线谱同一口径）。 */
  light: number;
  heavy: number;
  /** 反复点半径。<=0 = 按细线宽推算（`light * 1.6`）。 */
  dotRadius?: number;
  color: number;
}

/** 一条小节线的粗细组合（左→右）。分出来单独可测，也给 `isPlain` 用。 */
export function jpBarlineWidths(spec: BarlineSpec, final: boolean, light: number, heavy: number): number[] {
  const st = spec.style ?? null;
  // **不画线的小节线**（MusicXML `<bar-style>none</bar-style>`）：出版社把一个小节拆到
  // 两行/两页时用它分隔，谱面上什么也不印。原先没有这一支，落到最后的 `else` 里当普通
  // 细线画了出来——正因为「画出来会多一条线」，`jpscore.ts` 干脆不把它写进 `.jpwabc`，
  // 于是重新解析时两个小节并成一个，`.Repeat` 里按原编号写的段落就越界
  // （094《哈利路亚，祂已复活》等 4 首整份 .pptx 排不出来）。认了它，两头都对得上。
  if (st === S.BarStyle.NONE && !spec.repeatBackward && !spec.repeatForward) return [];
  let widths: number[];
  // **前后反复背靠背**（`:‖:`）：上一小节收尾的 `:‖` 与本小节起头的 `‖:` 合成一条，
  // 五线谱的画法是「细 粗 细」+ 两侧各两点，而不是两根粗线并排。
  if (spec.repeatBackward && spec.repeatForward) widths = [light, heavy, light];
  else if (st === S.BarStyle.LIGHT_HEAVY || (final && !spec.repeatForward)) widths = [light, heavy];
  else if (st === S.BarStyle.HEAVY_LIGHT || spec.repeatForward) widths = [heavy, light];
  else if (st === S.BarStyle.LIGHT_LIGHT) widths = [light, light];
  else if (st === S.BarStyle.HEAVY || st === S.BarStyle.HEAVY_HEAVY) widths = [heavy];
  else widths = [light];
  if (spec.repeatBackward && widths.length === 1) widths = [light, heavy];
  return widths;
}

/**
 * 一条小节线的全部图元（相对自身原点，x 从 0 起）。
 *
 * 反复点在**细线那一侧**（`:‖` 左、`‖:` 右），先占位再画线，x 顺序才对。
 * 返回的 `lines` 是那几条竖线的引用——`clipBarlinesUnderSlurs` 要按它们缩短上缘。
 */
export function jpBarlineItems(
  spec: BarlineSpec,
  final: boolean,
  style: BarlineStyle,
): { items: PageItem[]; lines: GraphicLine[]; width: number; isPlain: boolean } {
  const { top, bot, light, heavy, color } = style;
  const widths = jpBarlineWidths(spec, final, light, heavy);
  const items: PageItem[] = [];
  const lines: GraphicLine[] = [];
  const dotR = style.dotRadius !== undefined && style.dotRadius > 0 ? style.dotRadius : light * 1.6;
  const dotGap = dotR * 1.6;
  const dist = heavy;
  let xpos = 0;

  const addDots = (cx: number): void => {
    const mid = (top + bot) / 2;
    const off = (bot - top) / 6;
    for (const cy of [mid - off, mid + off]) items.push(jpDot(cx, cy, dotR, color));
  };

  if (spec.repeatBackward) {
    addDots(xpos + dotR);
    xpos += dotR * 2 + dotGap;
  }
  for (const w of widths) {
    const l = new GraphicLine();
    l.strokeColor = color;
    l.x = xpos + w / 2;
    l.p0 = new Point(0, top);
    l.p1 = new Point(0, bot);
    l.strokeWidth = w;
    xpos += w + dist;
    items.push(l);
    lines.push(l);
  }
  if (spec.repeatForward) {
    xpos += dotGap - dist;
    addDots(xpos + dotR);
  }
  return {
    items,
    lines,
    width: xpos,
    isPlain: widths.length <= 1 && !spec.repeatBackward && !spec.repeatForward,
  };
}

// ─────────────────────────────────────────────────────────── 拍号

/**
 * 分数式拍号的取尺。**一切长度都是小节线高度 H 的比例**——原先三条路各按自己的字号
 * 或 musicpp 的 staff space 常量给（layout `numberSize*0.625`、mixed `sc*(40+dy)`、
 * pu `font.size*0.62`），换个字号三处就各走各的。以 H 为基准，拍号与小节线自然等高对齐。
 *
 * 默认比例照 layout 原来的观感反算（H = numberSize·4/3，故 `numberSize = H·0.75`）：
 *   字号 numberSize·0.75 = H·0.5625、上数字 −numberSize·0.1 = −H·0.075、
 *   下数字 +numberSize·0.625 = +H·0.46875。
 */
export interface TimeSigStyle {
  /** 小节线高度 H —— 所有比例的基准。 */
  height: number;
  /** 分数线的 y（相对基线）。通常取小节线上下缘的中点。 */
  centerY: number;
  /** 分数线粗细。 */
  ruleWidth: number;
  color: number;
  /** 数字字体（字号由 `digitRatio × H` 定，传进来的 size 会被覆盖）。 */
  font: Font;
  /** 数字字号 ÷ H。**竖向排布只认这一个参数**（见 `TIME_SIG_GAP_EM`）。 */
  digitRatio?: number;
  /** 分数线长度 ÷ H，**按每一位数字算**（长度 = ratio × H × 位数）。 */
  ruleLengthRatio?: number;
}

/**
 * 数字墨迹与分数线墨迹之间的净距 ÷ 拍值字号 —— 就是**减时线与音符**那一格
 * （`LayoutOptions.jpBelowGap` = 1/9 em，按 PPT 档实测的距离定）。
 *
 * 竖向排布因此**只由拍值字号一个参数决定**：上数字的墨迹底离分数线上缘一格、
 * 下数字的墨迹顶离分数线下缘一格，上下对称。原先是两个「基线 ÷ H」的比例常量
 * （`upperRatio` / `lowerRatio`），那两个数是按谱面档的数字（0.5625 H）反算的，
 * 换个字号就散架：混排的数字是 0.75 H，照搬会让两个数字挤到一处、
 * 分数线还压在下数字的墨迹上。
 *
 * 两处口径都按**墨迹**算（数字的墨迹底≈基线、墨迹顶要减去数字高），
 * 与「数字 ↓ 减时线 ↓ 低音点」那一摞同一把尺子。
 */
export const TIME_SIG_GAP_EM = 1 / 9;

export const TIME_SIG_DEFAULTS = {
  digitRatio: 0.5625,
  /**
   * **每一位数字**占的分数线长度 ÷ H。
   *
   * 为什么不是一个定长比例：全书 592 处拍号里 579 处是一位数、13 处是 `12/8`。
   * 实测（Times，数字等宽）一位数 = 0.2813 H、两位数 = 0.5627 H——单给一个常数，
   * 取小的那 13 处分数线比数字还窄，取大的那 579 处分数线比数字宽出一倍。
   * 按位数算两边都对得上，而长度**仍然只由 H 与位数决定**，
   * 不再跟着字体的 advance 走（0.28125 = digitRatio × 0.5，即数字 advance 半个 em）。
   */
  ruleLengthRatio: 0.28125,
} as const;

/**
 * 分数式拍号（分子在上、分母在下、中间一横），**两个数字都横向居中于分数线**。
 * 返回的图元相对自身原点，x 从 0 起，宽度即分数线长度。
 */
export function jpTimeSigItems(
  beats: number,
  beatType: number,
  style: TimeSigStyle,
): { items: PageItem[]; rule: GraphicLine; width: number } {
  const H = style.height;
  const d = TIME_SIG_DEFAULTS;
  const font = style.font.makeWithSize(H * (style.digitRatio ?? d.digitRatio));
  const y = style.centerY - style.ruleWidth / 2;

  const mk = (s: string): { tf: TextFrame; w: number; ink: Rect } => {
    const tf = new TextFrame();
    tf.font = font;
    tf.color = style.color;
    tf.text = s;
    return { tf, w: tf.measureText(), ink: font.charBound(s) };
  };
  const up = mk(String(beats));
  const lo = mk(String(beatType));

  // **长度按位数算**，不跟着字体量出来的数字宽度走：给了 `ruleLengthRatio` 就按 H 的比例，
  // 没给就按**拍值字号的半个 em**（数字 advance）——那正是默认比例 0.28125 的来历
  //（0.5 × 默认 digitRatio 0.5625），字号一改自己跟着走，不必再算一遍比例。
  const digits = Math.max(String(beats).length, String(beatType).length);
  const width = digits * (style.ruleLengthRatio !== undefined ? H * style.ruleLengthRatio : font.size * 0.5);

  // 竖向：两个数字各离分数线**一格**（TIME_SIG_GAP_EM × 拍值字号，墨迹到墨迹），
  // `TextFrame.y` 是基线，故上数字要减去墨迹底（数字一般 ≈ 0）、下数字要减去墨迹顶
  //（负值，即数字高）。`y` 是分数线的**描边中心**。
  const gap = font.size * TIME_SIG_GAP_EM;
  up.tf.y = y - style.ruleWidth / 2 - gap - up.ink.bottom;
  up.tf.x = (width - up.w) / 2;
  lo.tf.y = y + style.ruleWidth / 2 + gap - lo.ink.top;
  lo.tf.x = (width - lo.w) / 2;

  const rule = new GraphicLine();
  rule.strokeWidth = style.ruleWidth;
  rule.strokeColor = style.color;
  rule.p0 = new Point(0, y);
  rule.p1 = new Point(width, y);

  return { items: [up.tf, lo.tf, rule], rule, width };
}
