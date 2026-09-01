// 文本谱绘制：定位结构 → PageItem 树 → SVG。
//
// 复用本项目的 PageItem/Group/GraphicPath/GraphicLine/TextFrame 与 renderPageItem，
// 所以「导出 PPTX」那条路（collectShapes 认这几种图元）不用改就能吃文本谱的页面。
//
// 数字用系统字体按**墨迹居中**于步进锚点（字号由 digitInkHeight 反推），
// 圆点与线段自绘——位置逐点对齐原版，字形则是规范字形。
//
// 播放逐字高亮：绘制时把每个音符与每个歌词音节的 PageItem 记进索引，
// highlight() 直接按 AST 节点取用，不必反查 SVG。

import { Font } from "../layout/font";
import { Matrix33, Point, type Rect } from "../common/geom";
import { GraphicLine, GraphicPath, Group, PageItem, type PathSeg, Slur, TextFrame } from "../layout/layout";
import { chordTextSegs, harmonyWidth, layoutHarmonySegs } from "../layout/harmony";
import { renderPageSvg } from "../layout/painter";
import type { LyricSyllable, Metadata, NoteElement, PuDoc } from "./ast";
import { primaryMetadata } from "./ast";
import type { Dialect } from "./dialect";
import {
  layoutDocument,
  noteInkBottom,
  type PlacedItem,
  type PlacedLayer,
  type PlacedGroup,
  type PlacedMark,
  type PlacedPage,
  type PlacedScore,
  type PlacedVoice,
} from "./layout";
import { BRACE_GLYPHS } from "./brace";
import { applyDocOptions, contentWidth, metricsFor, type PageProfileName, type PuMetrics } from "./metrics";
import { ACCOMP_BRACKET, ACCIDENTAL_GLYPH, BARLINE_MARKS, BRACKET, DYNAMICS, ORNAMENTS, TERMS } from "./glyph";

const BLACK = 0xff1b1b1b;
const LYRIC_COLOR = 0xff101010;
// 歌词联合括号：尺寸对照印刷原版量得（单位 = 歌词字号）
// 换气记号 V 的**尖底**离基线多远（单位 = 数字墨迹高，照原版矢量量的）
const BREATH_Y = 0.522;
const BRACE_GAP = 0.09;        // 末字右缘（含右边距）到括号左缘
const BRACE_TOP = 0.78;        // 首行基线往上
const BRACE_BOTTOM_UP = 0.16;  // 末行基线往上（括号底不到基线）

/**
 * 把一组声部切成若干「小节线贯穿块」：歌词行会把竖线截断，所以带歌词的声部就是
 * 一个块的末尾。四声部谱（S/A + 歌词 + T/B）因此得到 [1,2] 与 [3,4] 两块。
 */
function barlineBlocks(voices: readonly PlacedVoice[]): PlacedVoice[][] {
  const blocks: PlacedVoice[][] = [];
  let current: PlacedVoice[] = [];
  for (const voice of voices) {
    current.push(voice);
    if (voice.voice.lyrics.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks.filter((b) => b.length > 0);
}

function dot(cx: number, cy: number, r: number, color = BLACK): GraphicPath {
  const p = new GraphicPath();
  // 两段半圆弧拼一个整圆
  p.moveTo(cx - r, cy);
  p.cubicTo(cx - r, cy - r * 1.34, cx + r, cy - r * 1.34, cx + r, cy);
  p.cubicTo(cx + r, cy + r * 1.34, cx - r, cy + r * 1.34, cx - r, cy);
  p.close();
  p.fill = true;
  p.fillColor = color;
  return p;
}

function rect(x: number, y: number, w: number, h: number, color = BLACK): GraphicPath {
  const p = new GraphicPath();
  p.moveTo(x, y);
  p.lineTo(x + w, y);
  p.lineTo(x + w, y + h);
  p.lineTo(x, y + h);
  p.close();
  p.fill = true;
  p.fillColor = color;
  return p;
}

function stroke(color = BLACK, width = 1.4): GraphicPath {
  const p = new GraphicPath();
  p.stroke = true;
  p.strokeColor = color;
  p.strokeWidth = width;
  return p;
}

function line(x0: number, y0: number, x1: number, y1: number, width = 1.4): GraphicLine {
  const l = new GraphicLine();
  l.p0.x = x0;
  l.p0.y = y0;
  l.p1.x = x1;
  l.p1.y = y1;
  l.strokeColor = BLACK;
  l.strokeWidth = width;
  return l;
}

/** SVG path 的 `d` → 我们的 PathSeg（只需要 m/l/h/v/c/s/z，字形里没有别的命令）。 */
function parsePathD(d: string): PathSeg[] {
  const segs: PathSeg[] = [];
  const tokens = d.match(/[MmLlHhVvCcSsZz]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let prevC2x = 0;
  let prevC2y = 0;
  let lastCmd = "";
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    let cmd = tokens[i]!;
    if (/[A-Za-z]/.test(cmd)) i += 1;
    else cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd; // 省略的重复命令
    lastCmd = cmd;
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case "M": {
        cx = num() + ox;
        cy = num() + oy;
        startX = cx;
        startY = cy;
        segs.push({ op: "M", pts: [cx, cy] });
        break;
      }
      case "L": {
        cx = num() + ox;
        cy = num() + oy;
        segs.push({ op: "L", pts: [cx, cy] });
        break;
      }
      case "H": {
        cx = num() + ox;
        segs.push({ op: "L", pts: [cx, cy] });
        break;
      }
      case "V": {
        cy = num() + oy;
        segs.push({ op: "L", pts: [cx, cy] });
        break;
      }
      case "C": {
        const c1x = num() + ox;
        const c1y = num() + oy;
        const c2x = num() + ox;
        const c2y = num() + oy;
        cx = num() + ox;
        cy = num() + oy;
        segs.push({ op: "C", pts: [c1x, c1y, c2x, c2y, cx, cy] });
        prevC2x = c2x;
        prevC2y = c2y;
        break;
      }
      case "S": {
        // 平滑三次：第一个控制点是上一段第二控制点的映射
        const c1x = 2 * cx - prevC2x;
        const c1y = 2 * cy - prevC2y;
        const c2x = num() + ox;
        const c2y = num() + oy;
        cx = num() + ox;
        cy = num() + oy;
        segs.push({ op: "C", pts: [c1x, c1y, c2x, c2y, cx, cy] });
        prevC2x = c2x;
        prevC2y = c2y;
        break;
      }
      case "Z": {
        segs.push({ op: "Z", pts: [] });
        cx = startX;
        cy = startY;
        break;
      }
      default:
        i += 1;
    }
    if (cmd.toUpperCase() !== "C" && cmd.toUpperCase() !== "S") {
      prevC2x = cx;
      prevC2y = cy;
    }
  }
  return segs;
}

/**
 * 花括号（`{` / `}`）：直接用番茄简谱的字形轮廓（见 `brace.ts`），
 * **横向轮廓固定、纵向按跨度拉伸**——这正是原版给词括号配 `scale(1, k)` 的做法，
 * 笔画的横向粗细因此不随跨度变化。
 *
 * `xLeft` 是墨迹左缘，`kind` 选并排块用的大括号还是歌词用的词括号。
 */
function braceItem(
  xLeft: number,
  y0: number,
  y1: number,
  dir: -1 | 1,
  kind: "split" | "lyric",
): PageItem {
  const g =
    kind === "split"
      ? dir < 0
        ? BRACE_GLYPHS.splitLeft
        : BRACE_GLYPHS.splitRight
      : dir < 0
        ? BRACE_GLYPHS.lyricLeft
        : BRACE_GLYPHS.lyricRight;
  const [bx, by, , bh] = g.box;
  const sy = (y1 - y0) / bh;
  const path = new GraphicPath();
  path.segs = parsePathD(g.d);
  path.offset(g.shift, g.shift); // 字形自带的 translate
  path.fill = true;
  path.fillColor = BLACK;
  // 承载缩放的那层必须是裸 PageItem：Group.update() 会把子项归一到组包围盒原点，
  // 带非等比缩放时补偿量对不上，图形会被挪走
  const holder = new PageItem();
  const mat = new Matrix33();
  mat.setAffine([1, 0, 0, sy, xLeft - bx, y0 - by * sy]);
  holder.matrix = mat;
  holder.add(path);
  return holder;
}

function text(str: string, x: number, y: number, font: Font, color: number): TextFrame {
  const t = new TextFrame();
  t.text = str;
  t.font = font;
  t.color = color;
  t.x = x;
  t.y = y;
  return t;
}

export class PuPainter {
  metrics: PuMetrics;
  /** 与 JinpuPainter 同名，便于 buildPptx 等直接取用 */
  layout: { pages: Group[] } = { pages: [] };
  pageWidth = 0;
  pageHeight = 0;
  nodeMap = new WeakMap<PageItem, SVGGElement>();

  private doc: PuDoc | null = null;
  private placed: PlacedScore | null = null;
  private digitFont!: Font;
  private _accFont: Font | null = null;
  /** 连续长图裁紧后，整页要平移多少（把墨迹推到左侧留白处） */
  private _pageShiftX = 0;
  /** 播放高亮索引：AST 节点 → 它所在页与 PageItem */
  private noteItems = new Map<NoteElement, { page: number; item: PageItem }>();
  private syllableItems = new Map<LyricSyllable, { page: number; item: PageItem }>();
  private highlighted: PageItem[] = [];
  private editingEl: SVGGElement | null = null;
  private editingCaret: SVGLineElement | null = null;

  private profile: PageProfileName;
  private dialect: Dialect = "tomato";

  constructor(profile: PageProfileName = "print") {
    this.profile = profile;
    this.metrics = metricsFor(profile);
  }

  /** PagePainter：连续长图模式下宽高随谱而变，故不是常数。 */
  pageSize(_index: number): { w: number; h: number } {
    return { w: this.pageWidth, h: this.pageHeight };
  }

  get pageCount(): number {
    return this.layout.pages.length;
  }

  setProfile(profile: PageProfileName): void {
    this.profile = profile;
    this.metrics = metricsFor(profile, this.dialect);
    if (this.doc) this.load(this.doc);
  }

  /** 排一份文档并生成全部页面。 */
  load(doc: PuDoc): void {
    this.doc = doc;
    // 「原版」各复刻各的：两种方言的字号比例不同，排版前先按方言取尺寸
    this.dialect = doc.dialect;
    // 谱面自带的 `FontSize:` / `Margin:` 也要生效（真实语料里 `all=` 用得最多）
    const meta0 = doc.songs[0]?.metadata;
    this.metrics = applyDocOptions(
      metricsFor(this.profile, doc.dialect),
      meta0?.fontSizes ?? [],
      meta0?.margins ?? [],
    );
    const m = this.metrics;
    this.pageWidth = m.pageWidth;
    this.pageHeight = m.pageHeight;
    this.digitFont = this.makeDigitFont();
    this._accFont = null;
    this._pageShiftX = 0;
    const headerBottoms = doc.songs.map((song) => this.headerBottom(song.metadata));
    this.placed = layoutDocument(doc.songs, m, headerBottoms);
    // 连续长图：页面尺寸随内容走，不受纸张尺寸约束（短曲子不该拖着一大片空白）
    if (m.continuous) {
      this.pageHeight = Math.max(
        m.marginTop + m.bodyTop,
        this.placed.contentBottom + m.digitInkHeight + m.marginBottom,
      );
      // 页宽按**实际墨迹**裁紧并左右等距留白：连谱号会探进左边距，
      // 直接用 marginLeft 会左右不对称（实测 14 / 81）。
      const inkLeft = Math.min(...this.placed.pages.map((p) => this.systemLeft(p)));
      const inkRight =
        m.marginLeft + m.bodyLeftPad + this.placed.contentRight + m.digitInkHeight * 0.6;
      const side = m.continuousSideMargin;
      const titleNeed = this.headerWidth(this.doc.songs[0]?.metadata);
      this.pageWidth = Math.max(inkRight - inkLeft + side * 2, titleNeed);
      this._pageShiftX = side - inkLeft;
    }
    this.noteItems.clear();
    this.syllableItems.clear();
    this.highlighted = [];
    this.editingEl = null;
    this.editingCaret = null;
    this.layout.pages = this.placed.pages.map((pg, i) => {
      const g = this.paintPage(pg, i);
      g.x += this._pageShiftX;
      return g;
    });
    for (const p of this.layout.pages) p.update();
  }

  /**
   * 反推数字字号：让数字墨迹高度等于原版的 digitInkHeight。
   * 不同字体的数字高宽比不同，但因为锚点按固定步进、字形按墨迹居中，
   * 位置仍与原版逐点一致。
   */
  private makeDigitFont(): Font {
    const family = this.metrics.fontFamily;
    const probe = new Font(family, 100);
    const b = probe.charBound("1");
    const inkAt100 = Math.abs(b.bottom - b.top) || 71;
    const size = (this.metrics.digitInkHeight * 100) / inkAt100;
    return new Font(family, size);
  }

  /** 数字按墨迹居中于锚点：返回该把文字画在哪个 x/y，并附带墨迹盒。 */
  private digitOrigin(ch: string): { dx: number; dy: number; b: Rect } {
    const b = this.digitFont.charBound(ch);
    return {
      dx: -(b.left + b.right) / 2,
      dy: -(b.top + b.bottom) / 2,
      b,
    };
  }

  /** 升降号用的 Bravura 字号：让 ♯ 的墨迹高与数字墨迹高相当。 */
  private accidentalFont(): Font {
    if (!this._accFont) {
      const probe = new Font("Bravura", 100);
      const pb = probe.charBound(ACCIDENTAL_GLYPH.sharp!);
      const inkAt100 = Math.abs(pb.bottom - pb.top) || 68;
      // jpwabc 那边升降号字号 = 数字字号×0.8，换算成墨迹约为数字墨迹的 0.75
      this._accFont = new Font("Bravura", (this.metrics.digitInkHeight * 0.78 * 100) / inkAt100);
    }
    return this._accFont;
  }

  /**
   * 一组（system）的左缘布局：段号占位 → 细竖线 → 连谱号。
   * 页眉的 `TL:`/`XL:` 要对齐到 system 左缘，所以这段得能单独取用。
   */
  private systemMetrics(group: PlacedGroup): {
    notesLeft: number;
    thinX: number;
    braceX: number;
    /** 段号文字的左缘（没有段号时等于 notesLeft） */
    labelLeft: number;
    labelFont: Font;
  } {
    const m = this.metrics;
    const labelFont = new Font(m.fontFamily, m.lyricLabelSize);
    let labelWidth = 0;
    for (const v of group.voices) {
      for (const line of v.voice.lyrics) {
        if (line.annotation) {
          labelWidth = Math.max(labelWidth, labelFont.measureText(line.annotation));
        }
      }
    }
    const notesLeft = m.marginLeft + m.bodyLeftPad;
    // 段号排在 [细竖线] ← 间隙 → [段号] ← 间隙 → [歌词首字] 之间
    const labelToLyric = m.lyricLabelSize * 0.2;
    const lineToLabel = m.lyricLabelSize * 0.55;
    const firstCharHalf = m.lyricSize * 0.5;
    const labelSlot =
      labelWidth > 0 ? firstCharHalf + labelToLyric + labelWidth + lineToLabel : 0;
    const thinX = notesLeft - Math.max(labelSlot, m.stepBarline * 0.55);
    const braceX = thinX - m.digitInkHeight * 0.55;
    const labelLeft =
      labelWidth > 0 ? notesLeft - (firstCharHalf + labelToLyric + labelWidth) : notesLeft;
    return { notesLeft, thinX, braceX, labelLeft, labelFont };
  }

  /** 整页的 system 左缘（多声部时是连谱号，单声部时是细线/音符起点）。 */
  private systemLeft(page: PlacedPage): number {
    const m = this.metrics;
    let left = m.marginLeft;
    for (const group of page.groups) {
      // 单声部没有连谱号也没有起始细线，左缘取音符起点；但歌词说明（`<狼:1.>`）
      // 会伸到音符左边，也得算进去，否则会贴到页面边缘上。
      const g = this.systemMetrics(group);
      left = Math.min(left, group.hasBrace ? g.braceX : Math.min(g.notesLeft, g.labelLeft));
    }
    return left;
  }

  private paintPage(page: PlacedPage, pageIndex: number): Group {
    const m = this.metrics;
    const root = new Group();
    if (page.firstOfSong) this.paintHeader(root, page.song, this.systemLeft(page));
    for (const group of page.groups) {
      const texts = group.group.texts;
      if (texts.length > 0) {
        const font = new Font(m.fontFamily, m.textLineSize);
        root.add(text(texts.map((t) => t.text).join("  "), m.marginLeft, group.textY, font, BLACK));
      }
      const { braceX, notesLeft } = this.systemMetrics(group);
      // `&sbf` 标了分声部位置就从那里起（前半段仍是单声部），否则从 system 左缘
      const braceAt =
        group.braceFromX !== undefined
          ? notesLeft + group.braceFromX - m.digitInkHeight * 1.41
          : braceX;
      if (group.hasBrace) {
        this.paintBrace(root, braceAt, group.braceTop, group.braceBottom);
        // 声部名（`Q1"女高"` / `Q1<女高>`）排在连谱号**左侧**，与各自的声部行对齐
        const nameFont = new Font(m.fontFamily, m.annotationSize);
        for (const v of group.voices) {
          const caption = v.voice.caption;
          if (!caption) continue;
          const w = nameFont.measureText(caption);
          root.add(text(caption, braceAt - 6 - w, v.y + m.digitInkHeight * 0.35, nameFont, BLACK));
        }
      }
      // 多声部：小节线贯穿相邻的声部，但**在歌词块处断开**——四声部谱因此分成
      // 「声部1+2」与「声部3+4」两段（对照印刷原版）。连谱号才是整组一根到底。
      const spanBarlines = group.voices.length > 1;
      for (const voice of group.voices) {
        this.paintVoice(root, voice, pageIndex, spanBarlines);
      }
      if (spanBarlines) {
        for (const block of barlineBlocks(group.voices)) {
          const first = block[0]!;
          const last = block[block.length - 1]!;
          for (const it of first.items) {
            if (it.element.kind !== "barline") continue;
            this.paintBarline(
              root,
              m.marginLeft + m.bodyLeftPad + it.x,
              first.y,
              it,
              last.y - first.y,
            );
          }
        }
      }
    }
    return root;
  }

  /** 头部文字需要的最小页宽（标题居中、词曲右对齐，页面太窄会挤在一起）。 */
  private headerWidth(meta: import("./ast").Metadata | undefined): number {
    if (!meta) return 0;
    const m = this.metrics;
    let need = 0;
    meta.titles.forEach((t, i) => {
      const f = new Font(m.fontFamily, i === 0 ? m.titleSize : m.subtitleSize, i === 0);
      need = Math.max(need, f.measureText(t) + m.marginLeft + m.marginRight);
    });
    const side = new Font(m.fontFamily, m.topTextSize);
    const leftW = Math.max(0, ...meta.topLeft.map((t) => side.measureText(t)));
    const rightW = Math.max(
      0,
      ...meta.topRight.map((t) => side.measureText(t)),
      ...meta.authors.map((t) => side.measureText(t)),
    );
    return Math.max(need, leftW + rightW + m.marginLeft + m.marginRight + m.digitInkHeight);
  }

  /** 头部（标题/副标题/词曲/TL/TR/调号拍号）占到哪个 y——正文首行据此避让。 */
  private headerBottom(meta: Metadata): number {
    const m = this.metrics;
    const titleBottom =
      m.titleY +
      (meta.titles.length > 1
        ? m.titleSize * 0.2 + (meta.titles.length - 1) * m.subtitleSize * 1.35
        : 0);
    const leftLines = Math.max(meta.topLeft.length, meta.authors.length);
    const rightLines = meta.topRight.length;
    const blockBottom = m.authorY + Math.max(leftLines, rightLines, 1) * m.authorStep;
    const hasTempoWords = meta.tempos.some((t) => typeof t === "string" && t !== "");
    const keyBottom =
      (leftLines > 0 ? m.authorY + leftLines * m.authorStep + m.headerSize * 0.6 : m.keyMeterY) +
      (hasTempoWords ? m.headerSize * 2.2 : m.headerSize * 0.8);
    // 还要让过第一组头顶的和弦/注释行（它画在首行音符基线之上 annotationY 处）
    const clearance = Math.max(m.digitInkHeight * 1.4, -m.annotationY + m.annotationSize * 0.9);
    return Math.max(titleBottom, blockBottom, keyBottom) + clearance;
  }

  private paintHeader(root: Group, songIndex: number, systemLeft: number): void {
    const m = this.metrics;
    const meta = this.doc?.songs[songIndex]?.metadata ?? primaryMetadata(this.doc!);
    // 连续长图会按内容收窄页宽，所以居中/右对齐都要用**实际**页宽，不能用 metrics 里的纸张宽
    const centre = this.pageWidth / 2 - this._pageShiftX;

    meta.titles.forEach((title, i) => {
      const size = i === 0 ? m.titleSize : m.subtitleSize;
      const font = new Font(m.fontFamily, size, i === 0);
      const w = font.measureText(title);
      const y = m.titleY + (i === 0 ? 0 : m.titleSize * 0.2 + i * (m.subtitleSize * 1.35));
      root.add(text(title, centre - w / 2, y, font, BLACK));
    });

    const right = this.pageWidth - m.continuousSideMargin - this._pageShiftX;
    const authorFont = new Font(m.fontFamily, m.authorSize);
    // `Z:` 词曲作者靠右；`TL:`/`TR:` 是与标题同高的左右文字块（多行，允许空行占位）
    meta.authors.forEach((a, i) => {
      const w = authorFont.measureText(a);
      root.add(text(a, right - w, m.authorY + i * m.authorStep, authorFont, BLACK));
    });
    const topFont = new Font(m.fontFamily, m.topTextSize);
    meta.topLeft.forEach((t, i) => {
      if (!t) return;
      // `TL:` 与 system 左缘对齐（它不是跟着音符走的）
      root.add(text(t, systemLeft, m.authorY + i * m.authorStep, topFont, BLACK));
    });
    meta.topRight.forEach((t, i) => {
      if (!t) return;
      const w = topFont.measureText(t);
      root.add(text(t, right - w, m.authorY + i * m.authorStep, topFont, BLACK));
    });

    // 调号拍号排在左侧文字块**下方**，否则会和 TL 的多行叠在一起
    const leftLines = Math.max(meta.topLeft.length, meta.authors.length);
    const keyY =
      leftLines > 0
        ? m.authorY + leftLines * m.authorStep + m.headerSize * 0.6
        : m.keyMeterY;

    const headFont = new Font(m.fontFamily, m.headerSize);
    const tonic = meta.tonic ?? "1";
    // 调号里的升降号用真符号，且按惯例写在字母**前**（`bE` → `1=♭E`）
    const modeText = meta.mode
      ? meta.mode.replace(/^([A-G])([b#$♭♯])$/, "$2$1").replace(/b/g, "\u266D").replace(/#/g, "\u266F")
      : "";
    const keyText = modeText ? `${tonic}=${modeText}` : "";
    let x = systemLeft;
    if (keyText) {
      root.add(text(keyText, x, keyY, headFont, BLACK));
      x += headFont.measureText(keyText) + 8;
    }
    for (const meter of meta.meters) {
      x += this.paintMeter(root, x, keyY, meter, headFont) + 14;
    }
    // `J:` 里的文字部分（「深情地」「高亢、自由地」）排在调号拍号**下一行**，左对齐。
    // 数字部分是速度值，不显示在这里。
    const tempoWords = meta.tempos.filter((t): t is string => typeof t === "string" && t !== "");
    if (tempoWords.length > 0) {
      const wordFont = new Font(m.fontFamily, m.headerSize * 0.85);
      root.add(
        text(tempoWords.join(" "), systemLeft, keyY + m.headerSize * 1.55, wordFont, BLACK),
      );
    }

    // 序号：左上 / 右上
    const indexFont = new Font(m.fontFamily, m.titleSize * 0.62);
    // `XL:` 序号同样对齐 system 左缘
    if (meta.indexLeft) root.add(text(meta.indexLeft, systemLeft, m.titleY, indexFont, BLACK));
    if (meta.indexRight) {
      const w = indexFont.measureText(meta.indexRight);
      root.add(text(meta.indexRight, right - w, m.titleY, indexFont, BLACK));
    }
  }

  /**
   * 分数式拍号（分子在上、分母在下、中间一横）。返回占用的宽度。
   * 头部的调号拍号与小节线上的临时拍号共用。
   */
  private paintMeter(
    root: Group,
    x: number,
    y: number,
    meter: { numerator: number; denominator: number },
    font: Font,
  ): number {
    const top = String(meter.numerator);
    const bottom = String(meter.denominator);
    const wt = font.measureText(top);
    const wb = font.measureText(bottom);
    const w = Math.max(wt, wb);
    root.add(text(top, x + (w - wt) / 2, y - font.size * 0.42, font, BLACK));
    root.add(text(bottom, x + (w - wb) / 2, y + font.size * 0.62, font, BLACK));
    const bar = new GraphicLine();
    bar.p0.x = x - 1;
    bar.p0.y = y - font.size * 0.1;
    bar.p1.x = x + w + 1;
    bar.p1.y = bar.p0.y;
    bar.strokeColor = BLACK;
    bar.strokeWidth = 1.4;
    root.add(bar);
    return w;
  }

  /**
   * 连谱号：SMuFL 的 bracketTop / bracketBottom 两截花头，中间用一根竖线接上。
   * 竖线长度随声部数变化，花头尺寸固定，所以不能整体缩放一个字形了事。
   */
  /**
   * 连谱号。番茄原版是**一粗一细两条竖线**（粗 0.22、细 0.11 个墨迹高，中心距 0.25，
   * 粗线两端各探出 0.36、细线 0.44）；诗歌本印刷版才是带花头的括号。
   */
  private paintBrace(root: Group, x: number, top: number, bottom: number): void {
    const m = this.metrics;
    const ink = m.digitInkHeight;
    const size = ink * 2.2;
    const font = new Font("Bravura", size);
    const thick = size * 0.115;
    const thin = m.barlineWidth;
    // 粗线与细线的中心距
    const gap = ink * 0.55;
    const y0 = top - ink * 0.85;
    const y1 = bottom + ink * 0.85;
    root.add(rect(x - thick / 2, y0, thick, y1 - y0));
    // 右侧的细竖线：整组一根到底，**不像小节线那样在歌词处断开**；
    // 比粗线短一截，两端给花头留空隙
    const inset = ink * 0.42;
    root.add(rect(x + gap - thin / 2, top - inset, thin, bottom - top + inset * 2));
    // 上下花头：字形基线分别落在粗线两端
    root.add(text(BRACKET.top, x - thick / 2, y0, font, BLACK));
    root.add(text(BRACKET.bottom, x - thick / 2, y1, font, BLACK));
  }

  private paintVoice(
    root: Group,
    voice: PlacedVoice,
    pageIndex: number,
    skipBarlines = false,
  ): void {
    const m = this.metrics;
    const left = m.marginLeft + m.bodyLeftPad;
    const baseline = voice.y;
    /** 各段歌词墨迹的最右缘，联合括号据此定位 */
    const lyricRight: number[] = [];

    for (const it of voice.items) {
      const x = left + it.x;
      // `{dsb}` 并排块里，主旋律这一段整体下移（it.dy）
      const base = baseline + (it.dy ?? 0);
      if (it.element.kind === "barline") {
        if (!skipBarlines || it.dy !== undefined) this.paintBarline(root, x, base, it);
        continue;
      }
      if (it.element.kind === "sustain") {
        // 增时线：与数字等高处的一条横线
        const line = new GraphicLine();
        // 数字是按墨迹居中于 baseline 画的，增时线也要落在同一条中线上
        line.p0.x = x - m.sustainHalfLength;
        line.p0.y = base;
        line.p1.x = x + m.sustainHalfLength;
        line.p1.y = base;
        line.strokeColor = BLACK;
        line.strokeWidth = m.sustainWidth;
        root.add(line);
        // 长音里换的和弦印在增时线上方（`- "hx:C/G"`），画法与音符上方那个一样
        if (it.element.chord) this.paintChord(root, it.element.chord, x, base);
        this.paintSyllables(root, it, x, voice, pageIndex, lyricRight);
        continue;
      }
      this.paintNote(root, it, x, base, pageIndex);
      this.paintSyllables(root, it, x, voice, pageIndex, lyricRight);
    }

    // 减时线
    for (const u of voice.underlines) {
      root.add(
        rect(
          left + u.x0,
          baseline + (u.dy ?? 0) + m.underlineY + (u.level - 1) * m.underlineGap,
          u.x1 - u.x0,
          m.underlineWidth,
        ),
      );
    }

    this.paintLyricAnnotations(root, voice, left);
    this.paintJoinBrace(root, voice, lyricRight);

    // 跨若干符号的记号（弧线 / 多连音 / 跳房子 / 渐强渐弱）
    for (const mk of voice.marks) this.paintMark(root, mk, left, baseline + (mk.dy ?? 0));
    // 临时伴奏 / 临时多声部：主旋律上方的小字号行
    for (const layer of voice.layers) this.paintLayer(root, layer, left, baseline, pageIndex);
  }

  /** 弧线：直接用简谱谱面那套 SlurTieBase（月牙形，中间厚两端尖），两处观感一致。 */
  private paintArc(root: Group, x0: number, x1: number, y: number, height: number): void {
    const m = this.metrics;
    const arc = new Slur();
    void height;
    arc.init(new Point(x0, y), new Point(x1, y), m.slurThickness, BLACK);
    arc.update();
    root.add(arc);
  }

  /** 多连音弧线的半段：从端点 (x, y) 弯到中间断口 (xMid, apex)。 */
  private paintTupletHalf(root: Group, x: number, y: number, xMid: number, apex: number): void {
    const p = stroke(BLACK, 1.3);
    p.moveTo(x, y);
    const c1x = x + (xMid - x) * 0.45;
    p.cubicTo(c1x, apex + (y - apex) * 0.15, xMid - (xMid - x) * 0.18, apex, xMid, apex);
    root.add(p);
  }

  private paintMark(root: Group, mk: PlacedMark, left: number, baseline: number): void {
    const m = this.metrics;
    const x0 = left + mk.x0;
    const x1 = Math.max(left + mk.x1, x0 + 6);
    switch (mk.mark.type) {
      case "slur": {
        const y = baseline + (mk.y ?? m.laneSlur - (mk.level - 1) * m.laneSlurStep);
        this.paintArc(root, x0, x1, y, m.slurHeight);
        break;
      }
      case "tuplet": {
        // 多连音：弧线在正中**被连音数字断开**（原版如此），左右各画半段
        const y = baseline + (mk.y ?? m.laneSlur - (mk.level - 1) * m.laneSlurStep);
        const n = mk.mark.end - mk.mark.start + 1;
        const font = new Font(m.fontFamily, m.annotationSize);
        const label = String(n);
        const w = font.measureText(label);
        const cx = (x0 + x1) / 2;
        const half = w / 2 + m.digitInkHeight * 0.16; // 数字两侧的留白
        const apex = y - m.slurHeight;
        this.paintTupletHalf(root, x0, y, cx - half, apex);
        this.paintTupletHalf(root, x1, y, cx + half, apex);
        root.add(text(label, cx - w / 2, apex + m.annotationSize * 0.36, font, BLACK));
        break;
      }
      case "crescendo":
      case "decrescendo": {
        const y = baseline + m.laneWedge - (mk.level - 1) * m.laneLevelStep;
        const half = m.wedgeMouth / 2;
        const open = mk.mark.type === "crescendo";
        const tipX = open ? x0 : x1;
        const mouthX = open ? x1 : x0;
        root.add(line(tipX, y, mouthX, y - half, m.wedgeWidth));
        root.add(line(tipX, y, mouthX, y + half, m.wedgeWidth));
        break;
      }
      case "volta": {
        const y = baseline + m.laneVolta - (mk.level - 1) * m.laneLevelStep;
        const drop = m.digitInkHeight * 0.59;
        root.add(line(x0, y, x1, y, 1.4));
        if (!mk.openLeft) root.add(line(x0, y, x0, y + drop, 1.4));
        // `]/`（诗歌本）与 `[…/`（番茄）表示右端不封口
        if (!mk.openRight && mk.mark.openEnd !== true) root.add(line(x1, y, x1, y + drop, 1.4));
        // 跨行续过来的房子不再重复房号
        if (mk.mark.caption && !mk.openLeft) {
          // 房号在钩的**下方**（原版基线落在钩底再往下 4/1000 版面），压在线上会糊成一团
          const font = new Font(m.fontFamily, m.annotationSize * 0.9);
          root.add(
            text(mk.mark.caption, x0 + m.digitInkHeight * 0.18, y + drop + m.digitInkHeight * 0.24, font, BLACK),
          );
        }
        break;
      }
    }
  }

  private paintLayer(
    root: Group,
    layer: PlacedLayer,
    left: number,
    baseline: number,
    pageIndex = 0,
  ): void {
    const m = this.metrics;
    const split = layer.split;
    if (split) {
      // `{dsb}` 并排块：上行与主旋律**同字号同画法**，所以直接借主行那套绘制
      this.paintVoice(
        root,
        {
          voice: split.line,
          y: baseline + split.dy,
          items: layer.items,
          underlines: layer.underlines.map((u) => ({ ...u, dy: 0 })),
          marks: split.marks,
          layers: [],
          lyricY: [],
        },
        pageIndex,
        false,
      );
      // 花括号：细线描边的自绘路径，尖端朝并排的两行
      const y0 = baseline + split.braceTop;
      const y1 = baseline + split.braceBottom;
      if (split.braceLeftX !== undefined) {
        root.add(braceItem(left + split.braceLeftX, y0, y1, -1, "split"));
      }
      if (split.braceRightX !== undefined) {
        root.add(braceItem(left + split.braceRightX, y0, y1, 1, "split"));
      }
      return;
    }
    const y = baseline + m.layerY;
    const font = new Font(m.fontFamily, this.digitFont.size * m.layerScale);
    for (const it of layer.items) {
      const x = left + it.x;
      if (it.element.kind === "barline") {
        root.add(rect(x - 0.6, y - 10, 1.2, 20));
        continue;
      }
      if (it.element.kind === "sustain") {
        root.add(line(x - 8, y - 5, x + 8, y - 5, 1.6));
        continue;
      }
      if (it.element.kind !== "note" || it.element.hidden) continue;
      const ch = String(it.element.pitch);
      const b = font.charBound(ch);
      root.add(
        text(ch, x - (b.left + b.right) / 2, y - (b.top + b.bottom) / 2, font, BLACK),
      );
      const oct = it.element.octave;
      for (let i = 0; i < oct; i++) {
        root.add(dot(x, y + m.octaveUpY * m.layerScale - i * m.octaveDotGap, m.octaveDotRadius * 0.8));
      }
      for (let i = 0; i < -oct; i++) {
        root.add(dot(x, y + m.octaveDownY * m.layerScale + i * m.octaveDotGap, m.octaveDotRadius * 0.8));
      }
    }
    for (const u of layer.underlines) {
      root.add(
        rect(
          left + u.x0,
          y + m.underlineY * m.layerScale + (u.level - 1) * m.underlineGap,
          u.x1 - u.x0,
          m.underlineWidth * 0.8,
        ),
      );
    }
  }

  /** 音符/增时线上方的和弦：与五线谱共用富文本分段（根音升降号用 SMuFL csym 字形、后缀上标）。 */
  private paintChord(g: Group, chord: string, x: number, baseline: number): void {
    const m = this.metrics;
    const wordFont = new Font(m.fontFamily, m.annotationSize);
    const musicFont = new Font("Bravura", m.annotationSize);
    const segs = chordTextSegs(chord);
    const grp = layoutHarmonySegs(segs, wordFont, musicFont, BLACK);
    grp.x = x - harmonyWidth(segs, wordFont, musicFont) / 2;
    grp.y = baseline + m.annotationY;
    g.add(grp);
  }

  private paintNote(
    root: Group,
    it: PlacedItem,
    x: number,
    baseline: number,
    pageIndex: number,
  ): void {
    const note = it.element as NoteElement;
    const m = this.metrics;
    const g = new Group();
    g.classes.add("entry");
    g.data = note;

    if (!note.hidden) {
      const ch = note.sound === "rhythm" ? "X" : String(note.pitch);
      const { dx, dy, b } = this.digitOrigin(ch);
      g.add(text(ch, x + dx, baseline + dy, this.digitFont, BLACK));

      // 变音记号：用 Bravura 的 SMuFL 字形，按**墨迹**定位——字号取到墨迹高与数字相当，
      // 再把墨迹右缘贴到数字墨迹左缘、墨迹竖向中心对齐数字中心（降号略下移）。
      // 靠固定偏移放会随字体不同而漂，测量最可靠。
      const acc = note.accidental ? ACCIDENTAL_GLYPH[note.accidental] : undefined;
      if (acc) {
        const accFont = this.accidentalFont();
        const ab = accFont.charBound(acc);
        const inkW = ab.right - ab.left;
        const inkCx = (ab.left + ab.right) / 2;
        const inkCy = (ab.top + ab.bottom) / 2;
        const digitInkLeft = x + dx + b.left;
        const gap = m.digitInkHeight * 0.1;
        const cx = digitInkLeft - gap - inkW / 2;
        // 竖向：墨迹中心落在数字墨迹顶稍下（照 jpwabc 的 numBnd.top 口径），降号再低一点
        const cy =
          baseline -
          m.digitInkHeight * 0.34 +
          (note.accidental!.includes("flat") ? m.digitInkHeight * 0.08 : 0);
        g.add(text(acc, cx - inkCx, cy - inkCy, accFont, BLACK));
      }

      // 八度点：高音在上、低音在下，同侧多点向外叠。
      // 低音点必须挂在**减时线最下一层之下**（.jpwabc 的 entryBottom 规则：
      // above = max(数字墨迹底, 最低那条减时线的下缘)，再让开一个 stackGap），
      // 否则十六分音符的两条减时线会和低音点叠在一起。
      for (let i = 0; i < note.octave; i++) {
        g.add(dot(x, baseline + m.octaveUpY - i * m.octaveDotGap, m.octaveDotRadius));
      }
      if (note.octave < 0) {
        const firstDot =
          noteInkBottom(note, m) - (-note.octave - 1) * m.octaveDotGap - m.octaveDotRadius;
        for (let i = 0; i < -note.octave; i++) {
          g.add(dot(x, baseline + firstDot + i * m.octaveDotGap, m.octaveDotRadius));
        }
      }
    }

    // 附点
    for (let i = 0; i < note.dots; i++) {
      g.add(dot(x + m.dotOffsetX + i * (m.dotRadius * 2 + 2), baseline, m.dotRadius));
    }

    // 和弦：与五线谱共用富文本分段（根音升降号用 SMuFL csym 字形、后缀上标）
    if (note.chord) {
      this.paintChord(g, note.chord, x, baseline);
    } else if (note.annotation) {
      const font = new Font(m.fontFamily, m.annotationSize);
      const a = note.annotation;
      g.add(text(a, x - font.measureText(a) / 2, baseline + m.annotationY, font, BLACK));
    }

    // 倚音：主音左/右侧的小号数字（默认八分，故带一条减时线）
    this.paintGrace(g, note.graceBefore, x, baseline, -1);
    this.paintGrace(g, note.graceAfter, x, baseline, 1);

    // `&xx` 记号
    this.paintOrnaments(g, note.ornaments, x, baseline);

    root.add(g);
    this.noteItems.set(note, { page: pageIndex, item: g });
  }

  /**
   * 倚音：dir=-1 前倚音（画在左），dir=1 后倚音（画在右）。
   *
   * 所有比例都照原版矢量量的（单位 = 主音数字墨迹高）：倚音墨迹高 0.50、
   * 中心在主音墨迹中心上方 0.94、离主音中心 0.665；减时线长 0.388、线宽 0.055、
   * 落在倚音中心下方 0.36；连接钩从减时线中点垂下再朝主音弯（水平 0.249、垂直 0.304）。
   */
  private paintGrace(
    g: Group,
    notes: readonly NoteElement[],
    x: number,
    baseline: number,
    dir: -1 | 1,
  ): void {
    if (notes.length === 0) return;
    const m = this.metrics;
    const ink = m.digitInkHeight;
    const font = new Font(m.fontFamily, this.digitFont.size * m.graceScale);
    const step = ink * 0.45; // 多个倚音之间的中心距
    const nearest = x + dir * ink * 0.665; // 最靠近主音的那个（dir=-1 在左）
    const gy = baseline - ink * 0.94;
    const halfBeam = ink * 0.194;
    // 靠近主音的那个倚音挂连接钩
    let hook: { mid: number; y: number } | null = null;
    notes.forEach((gn, i) => {
      // 前倚音：最后一个贴着主音，往左依次排开；后倚音镜像
      const order = dir < 0 ? notes.length - 1 - i : i;
      const gx = nearest + dir * order * step;
      const ch = String(gn.pitch);
      const b = font.charBound(ch);
      g.add(text(ch, gx - (b.left + b.right) / 2, gy - (b.top + b.bottom) / 2, font, BLACK));
      for (let k = 0; k < gn.octave; k++) {
        g.add(dot(gx, gy + m.octaveUpY * m.graceScale - k * m.octaveDotGap * 0.7, m.octaveDotRadius * 0.75));
      }
      for (let k = 0; k < -gn.octave; k++) {
        g.add(dot(gx, gy + m.octaveDownY * m.graceScale + k * m.octaveDotGap * 0.7, m.octaveDotRadius * 0.75));
      }
      // 倚音默认八分：一条减时线；多一条 `/` 再加一层。比主音的细得多。
      const levels = Math.max(1, Math.log2(gn.duration / 4));
      let lastY = gy + ink * 0.36;
      for (let lv = 0; lv < levels; lv++) {
        lastY = gy + ink * 0.36 + lv * m.underlineGap * 0.8;
        g.add(rect(gx - halfBeam, lastY, halfBeam * 2, ink * 0.055));
      }
      if (order === 0) hook = { mid: gx, y: lastY };
    });
    if (hook === null) return;
    const { mid, y: uy } = hook as { mid: number; y: number };
    const toward = -dir; // 前倚音（画在左）朝右弯，后倚音朝左弯
    const drop = ink * 0.304;
    const reach = ink * 0.249 * toward;
    const p = stroke(BLACK, ink * 0.055);
    p.moveTo(mid, uy + ink * 0.033);
    p.cubicTo(mid, uy + drop * 0.6, mid - reach * 0.15, uy + drop * 0.87, mid + reach, uy + drop);
    g.add(p);
  }

  /** `&xx`：装饰、力度、术语、伴奏括弧、小节线上的反复记号。 */
  private paintOrnaments(
    g: Group,
    ornaments: readonly { name: string; level: number }[],
    x: number,
    baseline: number,
  ): void {
    if (ornaments.length === 0) return;
    const m = this.metrics;
    let slot = 0;
    for (const orn of ornaments) {
      const y = baseline + m.laneOrnament - orn.level * m.laneLevelStep - slot * 11;

      if (ACCOMP_BRACKET.has(orn.name)) {
        // 伴奏括弧：音符外侧的一个大圆括号
        const isLeft = orn.name === "zkh";
        const h = m.digitInkHeight * 1.5;
        const bx = x + (isLeft ? -m.digitInkHeight * 0.62 : m.digitInkHeight * 0.62);
        const p = stroke(BLACK, 1.4);
        const bend = isLeft ? -4.5 : 4.5;
        p.moveTo(bx, baseline - h / 2);
        p.cubicTo(bx + bend, baseline - h / 4, bx + bend, baseline + h / 4, bx, baseline + h / 2);
        g.add(p);
        continue;
      }

      if (orn.name === "hx") {
        // 换气：原版是一个细笔画的 **V**，挂在音符的**右上角**——锚点在音符右 0.75、
        // 尖底只在基线上方 0.52（都是墨迹高的倍数，照原版矢量量的），不是 SMuFL 的逗号。
        const cx = x + m.digitInkHeight * 0.75;
        const w = m.digitInkHeight * 0.383;
        const vy = baseline - m.digitInkHeight * BREATH_Y;
        const p = stroke(BLACK, 1.1);
        p.moveTo(cx - w / 2, vy - m.digitInkHeight * 0.477);
        p.lineTo(cx, vy);
        p.lineTo(cx + w / 2, vy - m.digitInkHeight * 0.477);
        g.add(p);
        continue;
      }

      const glyph = ORNAMENTS[orn.name];
      if (glyph) {
        const font = new Font("Bravura", this.digitFont.size * glyph.scale);
        const w = font.measureText(glyph.glyph);
        g.add(text(glyph.glyph, x - w / 2, y, font, BLACK));
        slot += 1;
        continue;
      }

      const dyn = DYNAMICS[orn.name];
      if (dyn) {
        const font = new Font("Bravura", this.digitFont.size * 0.95);
        const w = font.measureText(dyn);
        g.add(text(dyn, x - w / 2, y, font, BLACK));
        slot += 1;
        continue;
      }

      const term = TERMS[orn.name];
      if (term) {
        const font = new Font(m.fontFamily, m.annotationSize);
        g.add(text(term, x - font.measureText(term) / 2, y, font, BLACK));
        slot += 1;
        continue;
      }

      const bar = BARLINE_MARKS[orn.name];
      if (bar?.text) {
        const font = new Font(m.fontFamily, m.annotationSize);
        g.add(text(bar.text, x - font.measureText(bar.text) / 2, y, font, BLACK));
        slot += 1;
      } else if (bar?.glyph) {
        const font = new Font("Bravura", this.digitFont.size * 0.95);
        const w = font.measureText(bar.glyph);
        g.add(text(bar.glyph, x - w / 2, y, font, BLACK));
        slot += 1;
      }
    }
  }

  /** `spanHeight` > 0 时，这条小节线从 baseline 一直画到 baseline+spanHeight（贯穿多声部）。 */
  private paintBarline(
    root: Group,
    x: number,
    baseline: number,
    it: PlacedItem,
    spanHeight = 0,
  ): void {
    const m = this.metrics;
    const el = it.element;
    if (el.kind !== "barline") return;
    if (el.type === "hidden" || el.type === "invisible") {
      // 线本身不画，但挂在它上面的记号与临时拍号仍要画
      if (el.ornaments.length > 0) {
        const g = new Group();
        this.paintOrnaments(g, el.ornaments, x, baseline);
        root.add(g);
      }
      if (el.temporaryMeter) {
        const font = new Font(m.fontFamily, m.headerSize * 0.85);
        this.paintMeter(root, x, baseline, el.temporaryMeter, font);
      }
      return;
    }

    const top = baseline - m.barlineHeight * 0.5;
    const height = m.barlineHeight + spanHeight;
    const mid = top + height / 2;
    const thin = (cx: number): void => {
      root.add(rect(cx - m.barlineWidth / 2, top, m.barlineWidth, height));
    };
    const thick = (cx: number): void => {
      root.add(rect(cx - m.barlineWidth, top, m.barlineWidth * 2.6, height));
    };
    const dots = (cx: number): void => {
      root.add(dot(cx, mid - m.barlineHeight * 0.18, m.repeatDotRadius));
      root.add(dot(cx, mid + m.barlineHeight * 0.18, m.repeatDotRadius));
    };
    if (el.ornaments.length > 0) {
      const g = new Group();
      this.paintOrnaments(g, el.ornaments, x, baseline);
      root.add(g);
    }
    // 临时拍号：`|"p:2/4"`，画在这条小节线右侧
    if (el.temporaryMeter) {
      const font = new Font(m.fontFamily, m.headerSize * 0.85);
      this.paintMeter(root, x + m.barlineDoubleGap, baseline, el.temporaryMeter, font);
    }
    const gap = m.barlineDoubleGap;
    switch (el.type) {
      case "normal":
        thin(x);
        break;
      case "double":
        thin(x - gap / 2);
        thin(x + gap / 2);
        break;
      case "end":
        thin(x - gap / 2);
        thick(x + gap / 2);
        break;
      case "repeat-start":
        thick(x - gap / 2);
        thin(x + gap / 2);
        dots(x + gap / 2 + 6);
        break;
      case "repeat-end":
        dots(x - gap / 2 - 6);
        thin(x - gap / 2);
        thick(x + gap / 2);
        break;
      case "repeat-both":
        dots(x - gap - 6);
        thin(x - gap);
        thick(x);
        thin(x + gap);
        dots(x + gap + 6);
        break;
    }
  }

  /**
   * 歌词的联合括号：行末写 `}` 的那几段用一个右向花括号括起来（`(阿们)` 之类的
   * 共用结尾）。紧贴最长那段的末字右缘，纵向跨这几段。
   */
  /**
   * 歌词联合括号的取尺（对照印刷原版量的，单位 = 歌词字号）：
   * 括号墨迹宽 0.37、与末字右缘留 0.16 的缝；纵向从首行基线上方 0.78 到末行基线**上方** 0.16。
   * Bravura 的 brace（E000）在字号 40 时墨迹为 3.375 × 160、纵向以基线为中心。
   */
  private paintJoinBrace(root: Group, voice: PlacedVoice, lyricRight: number[]): void {
    // `}` 只写在**领起**的那几行上：印刷原版里 `落}` 一行带号、下一行 `说` 不带，
    // 括号却把两行都括进去——所以一段连续的带号行 + 其后紧跟的一行才是一个括号的跨度。
    const lyrics = voice.voice.lyrics;
    const spans: Array<[number, number]> = [];
    for (let i = 0; i < lyrics.length; i++) {
      if (!lyrics[i]!.joinBrace) continue;
      let j = i;
      while (j + 1 < lyrics.length && lyrics[j + 1]!.joinBrace) j += 1;
      const last = Math.min(j + 1, lyrics.length - 1);
      if (last > i) spans.push([i, last]);
      i = j;
    }
    for (const [first, last] of spans) this.paintOneJoinBrace(root, voice, lyricRight, first, last);
  }

  private paintOneJoinBrace(
    root: Group,
    voice: PlacedVoice,
    lyricRight: number[],
    first: number,
    last: number,
  ): void {
    const m = this.metrics;
    let right = 0;
    for (let i = first; i <= last; i++) right = Math.max(right, lyricRight[i] ?? 0);
    if (!Number.isFinite(right) || right <= 0) return;
    // 紧贴最长那行的末字右缘（原版留约 0.2 个歌词墨迹高的缝）
    const x = right + m.lyricSize * BRACE_GAP;
    const y0 = voice.lyricY[first]! - m.lyricSize * BRACE_TOP;
    const y1 = voice.lyricY[last]! - m.lyricSize * BRACE_BOTTOM_UP;
    if (y1 - y0 <= 0) return;
    // 右向 `}`：上下两端贴着歌词，尖端朝右
    root.add(braceItem(x, y0, y1, 1, "lyric"));
  }

  /** 歌词行的前置说明（段号 `1.`、角色名「狼:」等）。 */
  private paintLyricAnnotations(root: Group, voice: PlacedVoice, left: number): void {
    const m = this.metrics;
    const font = new Font(m.fontFamily, m.lyricLabelSize);
    voice.voice.lyrics.forEach((line, verse) => {
      if (!line.annotation) return;
      // 右对齐到歌词首字的左缘（首字是居中于第一个音符锚点的）。
      // `%NN` 可以调这个间隙，默认 20% 字宽。
      const gapPx = Math.max(line.annotationGap / 100, 0.1) * m.lyricSize;
      const w = font.measureText(line.annotation);
      root.add(
        text(line.annotation, left - m.lyricSize * 0.5 - gapPx - w, voice.lyricY[verse]!, font, LYRIC_COLOR),
      );
    });
  }

  private paintSyllables(
    root: Group,
    it: PlacedItem,
    x: number,
    voice: PlacedVoice,
    pageIndex: number,
    rightEdge?: number[],
  ): void {
    const m = this.metrics;
    const font = new Font(m.fontFamily, m.lyricSize);
    it.syllables.forEach((syl, verse) => {
      if (!syl) return;
      const str = syl.text + (syl.trailingPunctuation ?? "");
      const g = new Group();
      g.classes.add("lyric");
      g.data = syl;
      // 音节按其**主体**（不含尾随标点）居中于音符锚点，标点自然挂在右边
      const bodyWidth = font.measureText(syl.text);
      g.add(text(str, x - bodyWidth / 2, voice.lyricY[verse]!, font, LYRIC_COLOR));
      if (rightEdge) {
        rightEdge[verse] = Math.max(rightEdge[verse] ?? 0, x - bodyWidth / 2 + font.measureText(str));
      }
      root.add(g);
      this.syllableItems.set(syl, { page: pageIndex, item: g });
    });
  }

  /** 渲染某一页为独立的 <svg>。 */
  renderPage(pageIndex: number): SVGSVGElement {
    return renderPageSvg(this.layout.pages[pageIndex], this.pageWidth, this.pageHeight, this.nodeMap);
  }

  // ---------------- 播放逐字高亮 ----------------

  /**
   * 高亮一个音符及其歌词音节（「动态谱」）。传 null 清除。
   * 返回它所在页号，便于调用方翻页。
   */
  highlight(note: NoteElement | null, verse = 0): number | null {
    for (const item of this.highlighted) {
      this.nodeMap.get(item)?.classList.remove("playing");
    }
    this.highlighted = [];
    if (!note) return null;
    const hit = this.noteItems.get(note);
    if (!hit) return null;
    const targets: PageItem[] = [hit.item];
    const syl = this.syllableOf(note, verse);
    if (syl) {
      const sh = this.syllableItems.get(syl);
      if (sh) targets.push(sh.item);
    }
    for (const item of targets) {
      this.nodeMap.get(item)?.classList.add("playing");
      this.highlighted.push(item);
    }
    return hit.page;
  }

  /** 某音符在第 verse 段的歌词音节。 */
  syllableOf(note: NoteElement, verse = 0): LyricSyllable | null {
    for (const page of this.placed?.pages ?? []) {
      for (const group of page.groups) {
        for (const voice of group.voices) {
          for (const it of voice.items) {
            if (it.element === note) return it.syllables[verse] ?? null;
          }
        }
      }
    }
    return null;
  }

  /** 按播放顺序列出全部音符（供播放器驱动高亮）。 */
  playbackNotes(): NoteElement[] {
    const out: NoteElement[] = [];
    for (const page of this.placed?.pages ?? []) {
      for (const group of page.groups) {
        // 多声部时以第一声部为主旋律
        const voice = group.voices[0];
        if (!voice) continue;
        for (const it of voice.items) {
          if (it.element.kind === "note") out.push(it.element);
        }
      }
    }
    return out;
  }

  /** 某音符的 SVG 节点（滚动到可视区用）。 */
  noteGroupEl(note: NoteElement): SVGGElement | null {
    const hit = this.noteItems.get(note);
    return hit ? (this.nodeMap.get(hit.item) ?? null) : null;
  }

  /** 按源码偏移显示编辑光标。优先命中 token；在 token 间空白时取同一行最近的音符/歌词。 */
  highlightEditingAt(offset: number, line: number): { page: number; el: SVGGElement } | null {
    this.editingEl?.classList.remove("editing");
    this.editingCaret?.remove();
    this.editingEl = null;
    this.editingCaret = null;

    const candidates: Array<{ from: number; to: number; line: number; page: number; item: PageItem }> = [];
    for (const [note, hit] of this.noteItems) {
      candidates.push({
        from: note.source.offset,
        to: note.source.offset + Math.max(1, note.source.length),
        line: note.source.line,
        ...hit,
      });
    }
    for (const [syllable, hit] of this.syllableItems) {
      candidates.push({
        from: syllable.source.offset,
        to: syllable.source.offset + Math.max(1, syllable.source.length),
        line: syllable.source.line,
        ...hit,
      });
    }
    const sameLine = candidates.filter((c) => c.line === line);
    const hit = sameLine.find((c) => c.from <= offset && offset <= c.to)
      ?? sameLine.sort((a, b) => spanDistance(a, offset) - spanDistance(b, offset))[0];
    if (!hit) return null;
    const el = this.nodeMap.get(hit.item);
    if (!el) return null;
    this.editingEl = el;
    el.classList.add("editing");
    this.editingCaret = appendEditingCaret(el);
    return { page: hit.page, el };
  }

  /** 定位结构（回归脚本核对几何用）。 */
  placedPages(): PlacedPage[] {
    return this.placed?.pages ?? [];
  }

  get availableWidth(): number {
    return contentWidth(this.metrics);
  }
}

function spanDistance(span: { from: number; to: number }, offset: number): number {
  return offset < span.from ? span.from - offset : offset > span.to ? offset - span.to : 0;
}

function appendEditingCaret(el: SVGGElement): SVGLineElement | null {
  try {
    const b = el.getBBox();
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
    const caret = document.createElementNS("http://www.w3.org/2000/svg", "line");
    caret.setAttribute("class", "editing-caret");
    const x = b.x - Math.max(3, b.width * 0.08);
    caret.setAttribute("x1", String(x));
    caret.setAttribute("x2", String(x));
    caret.setAttribute("y1", String(b.y - 2));
    caret.setAttribute("y2", String(b.y + Math.max(b.height, 16) + 2));
    el.appendChild(caret);
    return caret;
  } catch {
    return null;
  }
}
