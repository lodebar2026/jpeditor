// 原样文档布局的构图：定位结构（`place.ts`）→ PageItem 页面树。原先 `PuPainter`（已退役）的绘制方法
// 原样搬来（`docs/实现/PuPainter退役.md` P4/P5），`this` 换成一次排版的上下文 `OriginalCtx`；
// 加载、DOM、渲染与高亮归唯一的 `layout/painter.ts::ScorePainter`，这里只产出页面与身份索引。
//
// 复用本项目的 PageItem/Group/GraphicPath/GraphicLine/TextFrame，
// 所以「导出 PPTX」那条路（collectShapes 认这几种图元）不用改就能吃这些页面。
//
// 数字用系统字体按**墨迹居中**于步进锚点（字号取样式值 digitSize），
// 圆点与线段自绘——位置逐点对齐原版，字形则是规范字形。
//
// 入口只收 `ScoreDoc`：先经 `pu/slots.ts::docView` 线性化成排版行（排版几何都按行写成），再定位、绘制。
//
// 播放逐字高亮与双向定位：绘制时把每个音符与每个歌词音节的 PageItem 按**元素 id** 记进索引，
// 由 ScorePainter 直接按 id 取用，不必反查 SVG，也不依赖对象身份（重新解析一遍 id 不变）。

import { Font } from "../font";
import { graceGeometry } from "../../common/gracenote";
import { Matrix33, Point, type Rect } from "../../common/geom";
import { GraphicLine, GraphicPath, Group, PageItem, type PathSeg, Slur, TextFrame } from "../pageitem";
import { chordTextSegs, harmonyWidth, layoutHarmonySegs } from "../harmony";
import { jpBarlineItems, jpDot, jpTimeSigItems } from "../jpglyph";
import type { BarlineSpec } from "../entry";
import { BarStyle } from "../../score/enums";
import type { Metadata, NoteElement } from "../../pu/ast";
import PU_BOOK from "../../style/books/pu-original.jpcss?raw";
import { computeStyleForPaper } from "../../style/themes";
import { parseJpcss, type Region } from "../../style/jpcss";

import { layoutRegion, songFields } from "../../style/template";
import { emptyMetadata } from "../../pu/ast";
import type { ElementId, ScoreDoc } from "../../model/doc";
import { docView, type DocView } from "../../pu/slots";
import { originalInputOf } from "./input";
import {
  layoutDocument,
  noteInkBottom,
  stackTop,
  type PlacedItem,
  type PlacedLayer,
  type PlacedGroup,
  type PlacedMark,
  type PlacedPage,
  type PlacedScore,
  type PlacedVoice,
  type LyricMeasure,
} from "./place";
import { BRACE_GLYPHS } from "./brace";
import { applyDocOptions, applyUserOptions, metricsFor, noteMarkGap, puGraceMetrics, puGraceNotes, puSlurStyle, withDigitInk, type PuMetrics, type PuUserOptions } from "./metrics";
import { ACCOMP_BRACKET, ACCIDENTAL_GLYPH, BARLINE_MARKS, BRACKET, DYNAMICS, ORNAMENTS, TERMS } from "../../pu/glyph";

/**
 * 定稿度量：按数字字体实测「1」的墨迹占比填上 `digitInkHeight`（字号来自样式值 `digitSize`）。
 * 不同字体的数字高宽比不同，但锚点按固定步进、字形按墨迹居中，位置仍与原版一致。
 */
function resolveDigitInk(m: PuMetrics): PuMetrics {
  const b = new Font(m.digitFamily, 100, m.digitBold).charBound("1");
  return withDigitInk(m, (Math.abs(b.bottom - b.top) || 71) / 100);
}

/** 文本谱的出厂墨色。歌词比谱面略黑一点，是原版量出来的。 */
const DEFAULT_INK = 0xff1b1b1b;
const DEFAULT_LYRIC_INK = 0xff101010;

/** 一次原样文档排版的上下文（原 PuPainter 的实例状态）。墨色也在这里：
 *  原先是模块级可变量、在 `load` 开头设一次，现在随上下文传，多个实例互不影响。 */
interface OriginalCtx {
  metrics: PuMetrics;
  doc: DocView;
  placed: PlacedScore | null;
  digitFont: Font;
  _accFont: Font | null;
  pageWidth: number;
  pageHeight: number;
  /** 连续长图裁紧后，整页要平移多少（把墨迹推到左侧留白处） */
  _pageShiftX: number;
  /** 播放高亮索引：元素 id → 它所在页与 PageItem。增时线有自己的 id，也收在这里（可视化编辑点选用） */
  noteItems: Map<ElementId, { page: number; item: PageItem }>;
  /** 键为 `${音符 id}:${段序}` */
  syllableItems: Map<string, { page: number; item: PageItem }>;
  /** 小节线（没有自己的 id，按「相邻音符 + 侧」认）：键为 `${音符 id}:${before|after}` */
  barlineItems: Map<string, { page: number; item: PageItem }>;
  /** 圆滑线/延音线（同样没有 id）：键为 `${起点 id}:${终点 id}` */
  slurItems: Map<string, { page: number; item: PageItem }>;
  /** 谱面墨色；用户指定前景色时与歌词同色——用户指定的是「前景色」，没道理还留着那点深浅差。 */
  ink: number;
  lyricInk: number;
}

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

/** 实心圆。谱面/混排/文本谱共用一份（`jpglyph.ts::jpDot`，四段贝塞尔的标准正圆）。
 *  这里原先是两段近似（控制点 1.34r），腰部比正圆略胖。 */
const dot = (color: number, cx: number, cy: number, r: number): GraphicPath =>
  jpDot(cx, cy, r, color);

function rect(color: number, x: number, y: number, w: number, h: number): GraphicPath {
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

function stroke(color: number, width = 1.4): GraphicPath {
  const p = new GraphicPath();
  p.stroke = true;
  p.strokeColor = color;
  p.strokeWidth = width;
  return p;
}

function line(color: number, x0: number, y0: number, x1: number, y1: number, width = 1.4): GraphicLine {
  const l = new GraphicLine();
  l.p0.x = x0;
  l.p0.y = y0;
  l.p1.x = x1;
  l.p1.y = y1;
  l.strokeColor = color;
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
  color: number,
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
  path.fillColor = color;
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
  // 标点挤压（CLREQ，见 common/cjkpunct.ts）：一个音节 = 一个 `<text>`，
  // 字 + 尾随标点、或前引号 + 字都在同一串里，挤压在这里就压掉了。
  // **横向步进不看歌词宽度**（place.ts 只按拍值走），所以这条路只挤字符、不做避让。
  if ([...str].length > 1) t.charXs = font.run(str).xs;
  return t;
}

/** 文本谱的小节线类型 → 谱面那一路的 `BarlineSpec`（两边的表达力一一对上）。 */
const PU_BARLINE_SPEC: Record<string, BarlineSpec | undefined> = {
  normal: {},
  double: { style: BarStyle.LIGHT_LIGHT },
  end: { style: BarStyle.LIGHT_HEAVY },
  "repeat-start": { repeatForward: true },
  "repeat-end": { repeatBackward: true },
  "repeat-both": { repeatBackward: true, repeatForward: true },
};

/** 方言版式 → 谱面自带的 `FontSize:` / `Margin:`（手动字号那层之前的全部）。 */
function docMetricsOf(view: DocView): PuMetrics {
  const meta0 = view.songs[0]?.metadata;
  const m = metricsFor(view.dialect);
  return applyDocOptions(m, meta0?.fontSizes ?? [], meta0?.margins ?? []);
}

/** 面板给的是**字号（pt）**，metrics 那层认的是缩放——在这里换算：
 *  拿「这套版式（含谱面自带的 FontSize 指令）原本多少 pt」当分母。 */
function resolveScale(o: PuUserOptions | null, docMetrics: PuMetrics): PuUserOptions | null {
  if (!o?.digitFontSize) return o;
  const base = docMetrics.digitSize;
  return base > 0 ? { ...o, scale: o.digitFontSize / base } : o;
}

/** 数字按墨迹居中于锚点：返回该把文字画在哪个 x/y，并附带墨迹盒。 */
function digitOrigin(c: OriginalCtx, ch: string): { dx: number; dy: number; b: Rect } {
  const b = c.digitFont.charBound(ch);
  return {
    dx: -(b.left + b.right) / 2,
    dy: -(b.top + b.bottom) / 2,
    b,
  };
}

/** 升降号用的 Bravura 字号：让 ♯ 的墨迹高与数字墨迹高相当。 */
function accidentalFont(c: OriginalCtx): Font {
  if (!c._accFont) {
    const probe = new Font("Bravura", 100);
    const pb = probe.charBound(ACCIDENTAL_GLYPH.sharp!);
    const inkAt100 = Math.abs(pb.bottom - pb.top) || 68;
    // jpwabc 那边升降号字号 = 数字字号×0.8，换算成墨迹约为数字墨迹的 0.75
    c._accFont = new Font("Bravura", (c.metrics.digitInkHeight * 0.78 * 100) / inkAt100);
  }
  return c._accFont;
}

/**
 * 一组（system）的左缘布局：段号占位 → 细竖线 → 连谱号。
 * 页眉的 `TL:`/`XL:` 要对齐到 system 左缘，所以这段得能单独取用。
 */
function systemMetrics(c: OriginalCtx, group: PlacedGroup): {
  notesLeft: number;
  thinX: number;
  braceX: number;
  /** 段号文字的左缘（没有段号时等于 notesLeft） */
  labelLeft: number;
  labelFont: Font;
} {
  const m = c.metrics;
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
function systemLeft(c: OriginalCtx, page: PlacedPage): number {
  const m = c.metrics;
  let left = m.marginLeft;
  for (const group of page.groups) {
    // 单声部没有连谱号也没有起始细线，左缘取音符起点；但歌词说明（`<狼:1.>`）
    // 会伸到音符左边，也得算进去，否则会贴到页面边缘上。
    const g = systemMetrics(c, group);
    left = Math.min(left, group.hasBrace ? g.braceX : Math.min(g.notesLeft, g.labelLeft));
  }
  return left;
}

function paintPage(c: OriginalCtx, page: PlacedPage, pageIndex: number): Group {
  const m = c.metrics;
  const root = new Group();
  if (page.firstOfSong) {
    paintHeader(c, root, page.song, systemLeft(c, page));
  }
  for (const group of page.groups) {
    // 每个谱组单独成一个 Group（`system`）：页面检查按它量相邻谱行的墨迹盒，绝对坐标不受影响
    const sys = new Group();
    sys.classes.add("system");
    const texts = group.group.texts;
    if (texts.length > 0) {
      const font = new Font(m.fontFamily, m.textLineSize);
      sys.add(text(texts.map((t) => t.text).join("  "), m.marginLeft, group.textY, font, c.ink));
    }
    const { braceX, notesLeft } = systemMetrics(c, group);
    // `&sbf` 标了分声部位置就从那里起（前半段仍是单声部），否则从 system 左缘
    const braceAt =
      group.braceFromX !== undefined
        ? notesLeft + group.braceFromX - m.digitInkHeight * 1.41
        : braceX;
    if (group.hasBrace) {
      paintBrace(c, sys, braceAt, group.braceTop, group.braceBottom);
      // 声部名（`Q1"女高"` / `Q1<女高>`）排在连谱号**左侧**，与各自的声部行对齐
      const nameFont = new Font(m.fontFamily, m.annotationSize);
      for (const v of group.voices) {
        const caption = v.voice.caption;
        if (!caption) continue;
        const w = nameFont.measureText(caption);
        sys.add(text(caption, braceAt - 6 - w, v.y + m.digitInkHeight * 0.35, nameFont, c.ink));
      }
    }
    // 多声部：小节线贯穿相邻的声部，但**在歌词块处断开**——四声部谱因此分成
    // 「声部1+2」与「声部3+4」两段（对照印刷原版）。连谱号才是整组一根到底。
    const spanBarlines = group.voices.length > 1;
    for (const voice of group.voices) {
      paintVoice(c, sys, voice, pageIndex, spanBarlines);
    }
    if (spanBarlines) {
      for (const block of barlineBlocks(group.voices)) {
        const first = block[0]!;
        const last = block[block.length - 1]!;
        // 贯穿多声部的小节线画在这里（`paintVoice` 那边被 skipBarlines 跳过了），索引同样要建，
        // 否则多声部谱上点不中小节线。**各声部在这一处的小节线共用这一条线**，所以按横坐标
        // 把同一处的都指到它上面（模型里每个声部各有一条小节线，画出来只有一根）
        const drawn = new Map<number, Group>();
        for (const it of first.items) {
          if (it.element.kind !== "barline") continue;
          const g = paintBarline(c,
            sys,
            m.marginLeft + m.bodyLeftPad + it.x,
            first.y,
            it,
            last.y - first.y,
          );
          if (g) drawn.set(it.x, g);
        }
        for (const voice of block) {
          let prevNoteId: ElementId | undefined;
          for (const it of voice.items) {
            if (it.element.kind === "barline") {
              const g = drawn.get(it.x);
              if (g && prevNoteId !== undefined) c.barlineItems.set(`${prevNoteId}:after`, { page: pageIndex, item: g });
            } else if (it.element.kind !== "sustain") {
              prevNoteId = c.doc?.idOf.get(it.element) ?? prevNoteId;
            }
          }
        }
      }
    }
    root.add(sys);
  }
  return root;
}

/** 页脚区域（`pu-original.jpcss` 的 `song-foot`）。按页宽算右缘，所以 `shiftX` 与 paintHeader 同口径。 */
function layoutFooters(c: OriginalCtx, shiftX: number): { page: number; bottom: number; items: TextFrame[] }[] {
  const region = PU_FOOT();
  const placed = c.placed;
  if (!region || !c.doc || !placed) return [];
  const m = c.metrics;
  const out: { page: number; bottom: number; items: TextFrame[] }[] = [];
  placed.pages.forEach((pg, i) => {
    const next = placed.pages[i + 1];
    if (next && next.song === pg.song) return; // 不是本曲末页
    const meta = c.doc!.songs[pg.song]?.metadata;
    if (!meta || ![...meta.bottomLeft, ...meta.bottomCenter, ...meta.bottomRight].some((t) => t.trim() && t.trim() !== "-")) return;
    let low = 0;
    for (const g of pg.groups) for (const v of g.voices) low = Math.max(low, v.y, ...v.lyricY);
    const font = (size: number): Font => new Font(m.fontFamily, size);
    const res = layoutRegion(region, {
      field: songFields(undefined, {
        "pageText.bottomLeft": meta.bottomLeft.map((text) => ({ text })),
        "pageText.bottomCenter": meta.bottomCenter.map((text) => ({ text })),
        "pageText.bottomRight": meta.bottomRight.map((text) => ({ text })),
      }),
      pageNo: 1,
      content: { left: m.marginLeft, right: c.pageWidth - m.continuousSideMargin - shiftX },
      dy: low + m.lyricSize,
      sizeOf: () => m.topTextSize,
      measure: (_r, t, size) => font(size).measureText(t),
      fontMetrics: (_r, size) => ({ ascent: -font(size).metrics.ascent, height: size }),
    });
    const items = res.items.flatMap((p) => {
      if (p.kind !== "text") return [];
      const f = font(p.size);
      const w = f.measureText(p.text);
      const x = p.align === "center" ? p.x - w / 2 : p.align === "right" ? p.x - w : p.x;
      return [text(p.text, x, p.y, f, c.ink)];
    });
    out.push({ page: i, bottom: low + m.lyricSize + res.span, items });
  });
  return out;
}

/** 头部文字需要的最小页宽（标题居中、词曲右对齐，页面太窄会挤在一起）。 */
function headerWidth(c: OriginalCtx, meta: Metadata | undefined): number {
  if (!meta) return 0;
  const m = c.metrics;
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

/** 标题（含副标题）最后一行的**墨迹**底。落位同 paintHeader 画标题那段。 */
/** 标题、副标题、题下经文各行：字、基线、字体。画（`paintHeaderItems`）与避让（`titleInkBottom`）共用这一份落位。
 *  经文接在最后一行标题下面，行距同副标题（没有标题就从标题那一行起）。 */
function titleLines(c: OriginalCtx, meta: Metadata): { text: string; y: number; font: Font }[] {
  const m = c.metrics;
  const out: { text: string; y: number; font: Font }[] = [];
  meta.titles.forEach((title, i) => {
    const font = i === 0
      ? new Font(m.titleFamily ?? m.fontFamily, m.titleSize, true)
      : new Font(m.subtitleFamily ?? m.fontFamily, m.subtitleSize, false);
    const y = m.titleY + (i === 0 ? 0 : m.titleSize * 0.2 + i * (m.subtitleSize * 1.35));
    out.push({ text: title, y, font });
  });
  const size = m.scriptureSize ?? m.subtitleSize;
  const scrFont = new Font(m.scriptureFamily ?? m.fontFamily, size, false);
  let y = out.length ? out[out.length - 1]!.y + (out.length === 1 ? m.titleSize * 0.2 : 0) : m.titleY - size * 1.35;
  for (const t of meta.scripture ?? []) {
    y += size * 1.35;
    out.push({ text: t, y, font: scrFont });
  }
  return out;
}

function titleInkBottom(c: OriginalCtx, meta: Metadata): number {
  let bottom = 0;
  for (const l of titleLines(c, meta)) bottom = Math.max(bottom, l.y + l.font.charBound(l.text).bottom);
  return bottom;
}

/**
 * 调号拍号行相对其基线 keyY 的**墨迹**上下缘（拍号取分子墨迹顶、分母墨迹底；分数线对准「=」，
 * 与 paintHeader 同一套落位）。没有拍号就只看调号字母。
 */
function keyLineInk(c: OriginalCtx, meta: Metadata): { top: number; bottom: number } {
  const m = c.metrics;
  const headFont = new Font(m.fontFamily, m.headerSize);
  const f = headFont.charBound("F");
  let top = f.top, bottom = f.bottom;
  const mt = meta.meters[0];
  if (mt) {
    const eq = headFont.charBound("=");
    const meterY = (eq.top + eq.bottom) / 2 + m.underlineWidth / 2;
    const r = jpTimeSigItems(mt.numerator, mt.denominator, {
      height: m.barlineHeight, centerY: 0, ruleWidth: m.underlineWidth, color: c.ink, font: headFont,
    });
    const up = r.items[0] as TextFrame;
    const lo = r.items[1] as TextFrame;
    top = Math.min(top, meterY + up.y + up.font.charBound(up.text).top);
    bottom = Math.max(bottom, meterY + lo.y + lo.font.charBound(lo.text).bottom);
  }
  return { top, bottom };
}

/**
 * 调号拍号行的基线。左侧有 `TL:`/词曲块时排在那块**下方**（否则多行会叠在一起）；
 * 没有时贴着标题：标题墨迹底 → 调号拍号墨迹顶只空**一行**（歌词字高），与首行、system 间距同口径
 * （用户口径：离标题近一点）。原先固定在 keyMeterY（176），离标题两行多。
 */
function keyLineY(c: OriginalCtx, meta: Metadata): number {
  const m = c.metrics;
  const leftLines = Math.max(meta.topLeft.length, meta.authors.length);
  if (leftLines > 0) return m.authorY + leftLines * m.authorStep + m.headerSize * 0.6;
  if (meta.titles.length === 0) return m.keyMeterY;
  return titleInkBottom(c, meta) + m.lyricSize - keyLineInk(c, meta).top;
}

/** 头部（标题/副标题/词曲/TL/TR/调号拍号）占到哪个 y——正文首行据此避让。 */
function headerBottom(c: OriginalCtx, meta: Metadata): number {
  const m = c.metrics;
  const leftLines = Math.max(meta.topLeft.length, meta.authors.length);
  const rightLines = meta.topRight.length;
  // 只有真有左右文字块时才算它的底；没有时不能拿 authorY 一行兜底，否则调号贴上标题也白贴
  const lines = Math.max(leftLines, rightLines);
  const blockBottom = lines > 0 ? m.authorY + (lines - 1) * m.authorStep + m.authorSize * 0.2 : 0;
  const hasTempoWords = meta.tempos.some((t) => typeof t === "string" && t !== "");
  const keyY = keyLineY(c, meta);
  let keyBottom = keyY + keyLineInk(c, meta).bottom;
  if (hasTempoWords) keyBottom = keyY + m.headerSize * 1.55 + m.headerSize * 0.85 * 0.15;
  // 只报页首的**墨迹底**；「空一行」由 layout 量到首组真正的墨迹顶（和弦、W: 文字行、弧线都算），
  // 见 place.ts::layoutSong 的 firstTop。在这里按数字顶加一行，首组头顶有文字行时就被吃掉了
  //（小兔子乖乖的「引子」贴上了拍号）。
  return Math.max(titleInkBottom(c, meta), blockBottom, keyBottom);
}

function paintHeader(c: OriginalCtx, root: Group, songIndex: number, systemLeft: number): void {
  const before = root.children.length;
  paintHeaderItems(c, root, songIndex, systemLeft);
  // 可视化编辑认页眉：文字标 `hdr`（按字对回原文的字段），调号、拍号另标 `hdr-keysig` / `hdr-time`（`headerParts`）
  for (const it of root.children.slice(before)) {
    if (!it.classes.has("hdr-keysig") && !it.classes.has("hdr-time")) it.classes.add("hdr");
  }
}

function paintHeaderItems(c: OriginalCtx, root: Group, songIndex: number, systemLeft: number): void {
  const m = c.metrics;
  const meta = c.doc?.songs[songIndex]?.metadata ?? c.doc?.songs[0]?.metadata ?? emptyMetadata();
  // 连续长图会按内容收窄页宽，所以居中/右对齐都要用**实际**页宽，不能用 metrics 里的纸张宽
  const centre = c.pageWidth / 2 - c._pageShiftX;

  for (const l of titleLines(c, meta)) {
    const w = l.font.measureText(l.text);
    root.add(text(l.text, centre - w / 2, l.y, l.font, c.ink));
  }

  const right = c.pageWidth - m.continuousSideMargin - c._pageShiftX;
  const authorFont = new Font(m.authorFamily ?? m.fontFamily, m.authorSize);
  // `Z:` 词曲作者靠右；`TL:`/`TR:` 是与标题同高的左右文字块（多行，允许空行占位）
  meta.authors.forEach((a, i) => {
    const w = authorFont.measureText(a);
    root.add(text(a, right - w, m.authorY + i * m.authorStep, authorFont, c.ink));
  });
  const topFont = new Font(m.fontFamily, m.topTextSize);
  meta.topLeft.forEach((t, i) => {
    if (!t) return;
    // `TL:` 与 system 左缘对齐（它不是跟着音符走的）
    root.add(text(t, systemLeft, m.authorY + i * m.authorStep, topFont, c.ink));
  });
  meta.topRight.forEach((t, i) => {
    if (!t) return;
    const w = topFont.measureText(t);
    root.add(text(t, right - w, m.authorY + i * m.authorStep, topFont, c.ink));
  });

  // 调号拍号行的基线（左侧文字块之下，或贴着标题空一行，见 keyLineY）
  const keyY = keyLineY(c, meta);

  const headFont = new Font(m.fontFamily, m.headerSize);
  const tonic = meta.tonic ?? "1";
  // 调号里的升降号用真符号，且按惯例写在字母**前**（`bE` → `1=♭E`）
  const modeText = meta.mode
    ? meta.mode.replace(/^([A-G])([b#$♭♯])$/, "$2$1").replace(/b/g, "\u266D").replace(/#/g, "\u266F")
    : "";
  let x = systemLeft;
  const keyFrom = root.children.length;
  if (modeText) {
    // `=` 两侧各让一点（连写「1=F」挤成一团，用户口径），三段分开画
    const eqPad = m.headerSize * 0.2;
    const eqX = x + headFont.measureText(tonic) + eqPad;
    const modeX = eqX + headFont.measureText("=") + eqPad;
    root.add(text(tonic, x, keyY, headFont, c.ink));
    root.add(text("=", eqX, keyY, headFont, c.ink));
    root.add(text(modeText, modeX, keyY, headFont, c.ink));
    for (const it of root.children.slice(keyFrom)) it.classes.add("hdr-keysig");
    // 调号 → 拍号的**墨迹**间距 = 「=」→ 调号的墨迹间距（用户口径）；分数线左端就是拍号墨迹左缘
    const eqInk = headFont.charBound("=");
    const modeInk = headFont.charBound(modeText);
    const inkGap = modeX + modeInk.left - (eqX + eqInk.right);
    x = modeX + modeInk.right + inkGap;
  }
  // 拍号的分数线与调号的「=」**视觉居中**：按「=」墨迹的竖直中心定分数线（用户口径）。
  // jpTimeSigItems 把分数线描边中心放在 centerY − ruleWidth/2，这里补回那半个线宽。
  const eq = headFont.charBound("=");
  const meterY = keyY + (eq.top + eq.bottom) / 2 + m.underlineWidth / 2;
  const meterFrom = root.children.length;
  for (const meter of meta.meters) {
    x += paintMeter(c, root, x, meterY, meter, headFont) + 14;
  }
  for (const it of root.children.slice(meterFrom)) it.classes.add("hdr-time");
  // `J:` 里的文字部分（「深情地」「高亢、自由地」）排在调号拍号**下一行**，左对齐。
  // 数字部分是速度值，不显示在这里。
  const tempoWords = meta.tempos.filter((t): t is string => typeof t === "string" && t !== "");
  if (tempoWords.length > 0) {
    const wordFont = new Font(m.fontFamily, m.headerSize * 0.85);
    root.add(
      text(tempoWords.join(" "), systemLeft, keyY + m.headerSize * 1.55, wordFont, c.ink),
    );
  }

  // 序号：左上 / 右上
  const indexFont = new Font(m.fontFamily, m.titleSize * 0.62);
  // `XL:` 序号同样对齐 system 左缘
  if (meta.indexLeft) root.add(text(meta.indexLeft, systemLeft, m.titleY, indexFont, c.ink));
  if (meta.indexRight) {
    const w = indexFont.measureText(meta.indexRight);
    root.add(text(meta.indexRight, right - w, m.titleY, indexFont, c.ink));
  }
}

/**
 * 分数式拍号（分子在上、分母在下、中间一横）。返回占用的宽度。
 * 头部的调号拍号与小节线上的临时拍号共用。
 */
function paintMeter(c: OriginalCtx,
  root: Group,
  x: number,
  y: number,
  meter: { numerator: number; denominator: number },
  font: Font,
): number {
  // 尺寸走公共那一份：**一切长度都是小节线高度的比例**（jpglyph.ts::jpTimeSigItems），
  // 两个数字横向居中于分数线。原先这里各按 `font.size` 的 0.42/0.62/0.1 给，
  // 与谱面、混排三处口径各不相同。
  const r = jpTimeSigItems(meter.numerator, meter.denominator, {
    height: c.metrics.barlineHeight,
    centerY: 0,
    ruleWidth: c.metrics.underlineWidth, // 分数线与减时线同粗（用户口径）
    color: c.ink,
    font,
  });
  for (const item of r.items) {
    item.x += x;
    item.y += y;
    root.add(item);
  }
  return r.width;
}

/**
 * 连谱号：SMuFL 的 bracketTop / bracketBottom 两截花头，中间用一根竖线接上。
 * 竖线长度随声部数变化，花头尺寸固定，所以不能整体缩放一个字形了事。
 */
/**
 * 连谱号。番茄原版是**一粗一细两条竖线**（粗 0.22、细 0.11 个墨迹高，中心距 0.25，
 * 粗线两端各探出 0.36、细线 0.44）；诗歌本印刷版才是带花头的括号。
 */
function paintBrace(c: OriginalCtx, root: Group, x: number, top: number, bottom: number): void {
  const m = c.metrics;
  const ink = m.digitInkHeight;
  const size = ink * 2.2;
  const font = new Font("Bravura", size);
  const thick = size * 0.115;
  const thin = m.barlineWidth;
  // 粗线与细线的中心距
  const gap = ink * 0.55;
  const y0 = top - ink * 0.85;
  const y1 = bottom + ink * 0.85;
  root.add(rect(c.ink, x - thick / 2, y0, thick, y1 - y0));
  // 右侧的细竖线：整组一根到底，**不像小节线那样在歌词处断开**；
  // 比粗线短一截，两端给花头留空隙
  const inset = ink * 0.42;
  root.add(rect(c.ink, x + gap - thin / 2, top - inset, thin, bottom - top + inset * 2));
  // 上下花头：字形基线分别落在粗线两端
  root.add(text(BRACKET.top, x - thick / 2, y0, font, c.ink));
  root.add(text(BRACKET.bottom, x - thick / 2, y1, font, c.ink));
}

function paintVoice(c: OriginalCtx,
  root: Group,
  voice: PlacedVoice,
  pageIndex: number,
  skipBarlines = false,
): void {
  const m = c.metrics;
  const left = m.marginLeft + m.bodyLeftPad;
  const baseline = voice.y;
  /** 各段歌词墨迹的最右缘，联合括号据此定位 */
  const lyricRight: number[] = [];
  /** 前面那个音符的元素 id：小节线没有自己的 id，借它认（口径同 `editor/sync.ts::addPartExtras`）。
   *  增时线不改它——模型里「小节线前面那个元素」指的是和弦，不是挂在它上面的增时线。 */
  let prevNoteId: ElementId | undefined;

  for (const it of voice.items) {
    const x = left + it.x;
    // `{dsb}` 并排块里，主旋律这一段整体下移（it.dy）
    const base = baseline + (it.dy ?? 0);
    if (it.element.kind === "barline") {
      if (!skipBarlines || it.dy !== undefined) {
        const g = paintBarline(c, root, x, base, it);
        // 行视图只出「右线」（`pu/slots.ts`），所以一律是画在前一个音符之后的那一侧
        if (g && prevNoteId !== undefined) c.barlineItems.set(`${prevNoteId}:after`, { page: pageIndex, item: g });
      }
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
      line.strokeColor = c.ink;
      line.strokeWidth = m.sustainWidth;
      root.add(line);
      // 增时线有自己的 id（`Chord.sustains[]` 各带一个），可视化编辑按它点选这一条
      const sid = c.doc?.idOf.get(it.element);
      if (sid !== undefined) c.noteItems.set(sid, { page: pageIndex, item: line });
      // 长音里换的和弦印在增时线上方（`- "hx:C/G"`），画法与音符上方那个一样
      if (it.element.chord) paintChord(c, root, it.element.chord, x, base);
      paintSyllables(c, root, it, x, voice, pageIndex, lyricRight);
      continue;
    }
    paintNote(c, root, it, x, base, pageIndex);
    prevNoteId = c.doc?.idOf.get(it.element) ?? prevNoteId;
    paintSyllables(c, root, it, x, voice, pageIndex, lyricRight);
  }

  // 减时线
  for (const u of voice.underlines) {
    root.add(
      rect(c.ink,
        left + u.x0,
        baseline + (u.dy ?? 0) + m.underlineY + (u.level - 1) * m.underlineGap,
        u.x1 - u.x0,
        m.underlineWidth,
      ),
    );
  }

  paintLyricAnnotations(c, root, voice, left);
  paintJoinBrace(c, root, voice, lyricRight);

  // 跨若干符号的记号（弧线 / 多连音 / 跳房子 / 渐强渐弱）
  for (const mk of voice.marks) paintMark(c, root, mk, left, baseline + (mk.dy ?? 0), pageIndex);
  // 临时伴奏 / 临时多声部：主旋律上方的小字号行
  for (const layer of voice.layers) paintLayer(c, root, layer, left, baseline, pageIndex);
}

/** 弧线：直接用简谱谱面那套 SlurTieBase（月牙形，中间厚两端尖），两处观感一致。
 *  弧高（含超长跨度改扁平的阈值）由 puSlurStyle 定，与 layout 的纵向预留同源。 */
function paintArc(c: OriginalCtx, root: Group, x0: number, x1: number, y: number): Slur {
  const arc = new Slur();
  arc.init(new Point(x0, y), new Point(x1, y), puSlurStyle(c.metrics, c.ink));
  arc.update();
  root.add(arc);
  return arc;
}

/** 多连音弧线的半段：从端点 (x, y) 弯到中间断口 (xMid, apex)。 */
function paintTupletHalf(c: OriginalCtx, root: Group, x: number, y: number, xMid: number, apex: number): void {
  const p = stroke(c.ink, 1.3);
  p.moveTo(x, y);
  const c1x = x + (xMid - x) * 0.45;
  p.cubicTo(c1x, apex + (y - apex) * 0.15, xMid - (xMid - x) * 0.18, apex, xMid, apex);
  root.add(p);
}

function paintMark(c: OriginalCtx, root: Group, mk: PlacedMark, left: number, baseline: number, pageIndex: number): void {
  const m = c.metrics;
  const x0 = left + mk.x0;
  const x1 = Math.max(left + mk.x1, x0 + 6);
  switch (mk.mark.type) {
    case "slur": {
      const y = baseline + (mk.y ?? m.laneSlur - (mk.level - 1) * m.laneSlurStep);
      const arc = paintArc(c, root, x0, x1, y);
      // 弧没有自己的 id，可视化编辑按「起点:终点」认它（同 `Tie.startId`）。
      // **不能用 `mk.mark.start/end`**——那是行内下标，元素 id 要从两端实际落在的符号上取
      const sid = mk.startEl && c.doc?.idOf.get(mk.startEl);
      const eid = mk.endEl && c.doc?.idOf.get(mk.endEl);
      if (sid !== undefined && eid !== undefined) c.slurItems.set(`${sid}:${eid}`, { page: pageIndex, item: arc });
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
      paintTupletHalf(c, root, x0, y, cx - half, apex);
      paintTupletHalf(c, root, x1, y, cx + half, apex);
      root.add(text(label, cx - w / 2, apex + m.annotationSize * 0.36, font, c.ink));
      break;
    }
    case "crescendo":
    case "decrescendo": {
      const y = baseline + m.laneWedge - (mk.level - 1) * m.laneLevelStep;
      const half = m.wedgeMouth / 2;
      const open = mk.mark.type === "crescendo";
      const tipX = open ? x0 : x1;
      const mouthX = open ? x1 : x0;
      root.add(line(c.ink, tipX, y, mouthX, y - half, m.wedgeWidth));
      root.add(line(c.ink, tipX, y, mouthX, y + half, m.wedgeWidth));
      break;
    }
    case "volta": {
      const y = baseline + m.laneVolta - (mk.level - 1) * m.laneLevelStep;
      const drop = m.digitInkHeight * 0.59;
      root.add(line(c.ink, x0, y, x1, y, 1.4));
      if (!mk.openLeft) root.add(line(c.ink, x0, y, x0, y + drop, 1.4));
      // `]/`（诗歌本）与 `[…/`（番茄）表示右端不封口
      if (!mk.openRight && mk.mark.openEnd !== true) root.add(line(c.ink, x1, y, x1, y + drop, 1.4));
      // 跨行续过来的房子不再重复房号
      if (mk.mark.caption && !mk.openLeft) {
        // 房号在钩的**下方**（原版基线落在钩底再往下 4/1000 版面），压在线上会糊成一团
        const font = new Font(m.fontFamily, m.annotationSize * 0.9);
        root.add(
          text(mk.mark.caption, x0 + m.digitInkHeight * 0.18, y + drop + m.digitInkHeight * 0.24, font, c.ink),
        );
      }
      break;
    }
  }
}

function paintLayer(c: OriginalCtx,
  root: Group,
  layer: PlacedLayer,
  left: number,
  baseline: number,
  pageIndex = 0,
): void {
  const m = c.metrics;
  const split = layer.split;
  if (split) {
    // `{dsb}` 并排块：上行与主旋律**同字号同画法**，所以直接借主行那套绘制
    paintVoice(c,
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
      root.add(braceItem(c.ink, left + split.braceLeftX, y0, y1, -1, "split"));
    }
    if (split.braceRightX !== undefined) {
      root.add(braceItem(c.ink, left + split.braceRightX, y0, y1, 1, "split"));
    }
    return;
  }
  const y = baseline + m.layerY;
  const font = new Font(m.fontFamily, c.digitFont.size * m.layerScale);
  for (const it of layer.items) {
    const x = left + it.x;
    if (it.element.kind === "barline") {
      root.add(rect(c.ink, x - 0.6, y - 10, 1.2, 20));
      continue;
    }
    if (it.element.kind === "sustain") {
      root.add(line(c.ink, x - 8, y - 5, x + 8, y - 5, 1.6));
      continue;
    }
    if (it.element.kind !== "note" || it.element.hidden) continue;
    const ch = String(it.element.pitch);
    const b = font.charBound(ch);
    root.add(
      text(ch, x - (b.left + b.right) / 2, y - (b.top + b.bottom) / 2, font, c.ink),
    );
    const oct = it.element.octave;
    for (let i = 0; i < oct; i++) {
      root.add(dot(c.ink, x, y + m.octaveUpY * m.layerScale - i * m.octaveDotGap, m.octaveDotRadius * 0.8));
    }
    for (let i = 0; i < -oct; i++) {
      root.add(dot(c.ink, x, y + m.octaveDownY * m.layerScale + i * m.octaveDotGap, m.octaveDotRadius * 0.8));
    }
  }
  for (const u of layer.underlines) {
    root.add(
      rect(c.ink,
        left + u.x0,
        y + m.underlineY * m.layerScale + (u.level - 1) * m.underlineGap,
        u.x1 - u.x0,
        m.underlineWidth * 0.8,
      ),
    );
  }
}

/** 音符/增时线上方的和弦：与五线谱共用富文本分段（根音升降号用 SMuFL csym 字形、后缀上标）。 */
function paintChord(c: OriginalCtx, g: Group, chord: string, x: number, baseline: number): void {
  const m = c.metrics;
  const wordFont = new Font(m.fontFamily, m.annotationSize);
  const musicFont = new Font("Bravura", m.annotationSize);
  const segs = chordTextSegs(chord);
  const grp = layoutHarmonySegs(segs, wordFont, musicFont, c.ink);
  grp.x = x - harmonyWidth(segs, wordFont, musicFont) / 2;
  grp.y = baseline + m.annotationY;
  g.add(grp);
}

function paintNote(c: OriginalCtx,
  root: Group,
  it: PlacedItem,
  x: number,
  baseline: number,
  pageIndex: number,
): void {
  const note = it.element as NoteElement;
  const m = c.metrics;
  const g = new Group();
  g.classes.add("entry");
  g.data = note;

  if (!note.hidden) {
    const ch = note.sound === "rhythm" ? "X" : String(note.pitch);
    const { dx, dy, b } = digitOrigin(c, ch);
    g.add(text(ch, x + dx, baseline + dy, c.digitFont, c.ink));

    // 变音记号：用 Bravura 的 SMuFL 字形，按**墨迹**定位——字号取到墨迹高与数字相当，
    // 再把墨迹右缘贴到数字墨迹左缘、墨迹竖向中心对齐数字中心（降号略下移）。
    // 靠固定偏移放会随字体不同而漂，测量最可靠。
    const acc = note.accidental ? ACCIDENTAL_GLYPH[note.accidental] : undefined;
    if (acc) {
      const accFont = accidentalFont(c);
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
      g.add(text(acc, cx - inkCx, cy - inkCy, accFont, c.ink));
    }

    // 八度点：高音在上、低音在下，同侧多点向外叠。
    // 低音点必须挂在**减时线最下一层之下**（.jpwabc 的 entryBottom 规则：
    // above = max(数字墨迹底, 最低那条减时线的下缘)，再让开一个 stackGap），
    // 否则十六分音符的两条减时线会和低音点叠在一起。
    for (let i = 0; i < note.octave; i++) {
      g.add(dot(c.ink, x, baseline + m.octaveUpY - i * m.octaveDotGap, m.octaveDotRadius));
    }
    if (note.octave < 0) {
      const firstDot =
        noteInkBottom(note, m) - (-note.octave - 1) * m.octaveDotGap - m.octaveDotRadius;
      for (let i = 0; i < -note.octave; i++) {
        g.add(dot(c.ink, x, baseline + firstDot + i * m.octaveDotGap, m.octaveDotRadius));
      }
    }
  }

  // 附点
  for (let i = 0; i < note.dots; i++) {
    const d = dot(c.ink, x + m.dotOffsetX + i * (m.dotRadius * 2 + 2), baseline, m.dotRadius);
    d.classes.add("aug-dot"); // 可视化编辑单独点选附点（`notePartEls`）
    g.add(d);
  }

  // 和弦：与五线谱共用富文本分段（根音升降号用 SMuFL csym 字形、后缀上标）
  if (note.chord) {
    paintChord(c, g, note.chord, x, baseline);
  } else if (note.annotation) {
    const font = new Font(m.fontFamily, m.annotationSize);
    const a = note.annotation;
    const t = text(a, x - font.measureText(a) / 2, baseline + m.annotationY, font, c.ink);
    t.classes.add("annotation"); // 可视化编辑认挂载记号用（`notePartEls`）
    g.add(t);
  }

  // 倚音：主音左/右侧的小号数字（默认八分，故带一条减时线）
  paintGrace(c, g, note.graceBefore, x, baseline, -1);
  paintGrace(c, g, note.graceAfter, x, baseline, 1);

  // `&xx` 记号
  const before = g.children.length;
  paintOrnaments(c, g, note.ornaments, x, baseline, stackTop(note, c.metrics));
  for (const it of g.children.slice(before)) it.classes.add("ornament"); // 同上

  root.add(g);
  const id = c.doc?.idOf.get(note);
  if (id !== undefined) c.noteItems.set(id, { page: pageIndex, item: g });
}

/**
 * 倚音：dir=-1 前倚音（画在左），dir=1 后倚音（画在右）。
 *
 * **几何走公共那一份**（`src/common/gracenote.ts`），简谱排版引擎那条路
 * （`layout.ts::addGraceNotes`）用的是同一套比例——两边各自落笔，坐标只算一次。
 */
function paintGrace(c: OriginalCtx,
  g: Group,
  notes: readonly NoteElement[],
  x: number,
  baseline: number,
  dir: -1 | 1,
): void {
  if (notes.length === 0) return;
  const m = c.metrics;
  const font = new Font(m.fontFamily, c.digitFont.size * m.graceScale);
  const geom = graceGeometry(
    puGraceNotes(notes),
    puGraceMetrics(m),
    x, baseline, dir, c.digitFont.size,
  );
  for (const d of geom.digits) {
    // 数字按**墨迹中心**定位（公共几何给的是中心，这里换算成落笔点）
    const b = font.charBound(d.text);
    g.add(text(d.text, d.cx - (b.left + b.right) / 2, d.cy - (b.top + b.bottom) / 2, font, c.ink));
  }
  for (const o of geom.dots) g.add(dot(c.ink, o.cx, o.cy, o.r));
  // 升降号：与主音同一套画法（Bravura 的 SMuFL 字形、按墨迹定位），只是所有量
  // 都由公共几何按倚音的墨迹给好——字号也是反推出来的，不能照主音那个字号缩。
  for (const acc of geom.accidentals) {
    const glyph = ACCIDENTAL_GLYPH[acc.alter];
    if (!glyph) continue;
    const probe = new Font("Bravura", 100);
    const pb = probe.charBound(glyph);
    const inkAt100 = Math.abs(pb.bottom - pb.top) || 68;
    const accFont = new Font("Bravura", (acc.inkHeight * 100) / inkAt100);
    const ab = accFont.charBound(glyph);
    g.add(text(glyph, acc.inkRight - ab.right, acc.inkCy - (ab.top + ab.bottom) / 2, accFont, c.ink));
  }
  for (const bm of geom.beams) g.add(rect(c.ink, bm.x, bm.y, bm.w, bm.h));
  if (geom.hook) {
    const p = stroke(c.ink, geom.hook.width);
    p.moveTo(geom.hook.m[0], geom.hook.m[1]);
    p.cubicTo(...geom.hook.c);
    g.add(p);
  }
}

function paintOrnaments(c: OriginalCtx,
  g: Group,
  ornaments: readonly { name: string; level: number }[],
  x: number,
  baseline: number,
  /** 音符上方堆叠顶（相对基线，含高八度点，见 layout.ts::stackTop）；小节线/增时线上的记号不传 */
  top = -c.metrics.digitInkHeight / 2,
): void {
  if (ornaments.length === 0) return;
  const m = c.metrics;
  let slot = 0;
  for (const orn of ornaments) {
    const y = baseline + m.laneOrnament - orn.level * m.laneLevelStep - slot * 11;

    if (ACCOMP_BRACKET.has(orn.name)) {
      // 伴奏括弧：音符外侧的一个大圆括号
      const isLeft = orn.name === "zkh";
      const h = m.digitInkHeight * 1.5;
      const bx = x + (isLeft ? -m.digitInkHeight * 0.62 : m.digitInkHeight * 0.62);
      const p = stroke(c.ink, 1.4);
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
      const p = stroke(c.ink, 1.1);
      p.moveTo(cx - w / 2, vy - m.digitInkHeight * 0.477);
      p.lineTo(cx, vy);
      p.lineTo(cx + w / 2, vy - m.digitInkHeight * 0.477);
      g.add(p);
      continue;
    }

    const glyph = ORNAMENTS[orn.name];
    if (glyph) {
      const font = new Font("Bravura", c.digitFont.size * glyph.scale);
      const w = font.measureText(glyph.glyph);
      if (orn.name === "yc" || orn.name === "ycy") {
        // 延长记号按**墨迹**贴着音符堆叠顶（含高八度点）放，净距与减时线、八度点同一个值
        // （metrics.ts::alignNoteMarks）；走 laneOrnament 固定槽位离音符太远（用户口径）。
        const ab = font.charBound(glyph.glyph);
        g.add(text(glyph.glyph, x - w / 2, baseline + top - noteMarkGap(m) - ab.bottom, font, c.ink));
      } else {
        g.add(text(glyph.glyph, x - w / 2, y, font, c.ink));
      }
      slot += 1;
      continue;
    }

    const dyn = DYNAMICS[orn.name];
    if (dyn) {
      const font = new Font("Bravura", c.digitFont.size * 0.95);
      const w = font.measureText(dyn);
      g.add(text(dyn, x - w / 2, y, font, c.ink));
      slot += 1;
      continue;
    }

    const term = TERMS[orn.name];
    if (term) {
      const font = new Font(m.fontFamily, m.annotationSize);
      g.add(text(term, x - font.measureText(term) / 2, y, font, c.ink));
      slot += 1;
      continue;
    }

    const bar = BARLINE_MARKS[orn.name];
    if (bar?.text) {
      const font = new Font(m.fontFamily, m.annotationSize);
      g.add(text(bar.text, x - font.measureText(bar.text) / 2, y, font, c.ink));
      slot += 1;
    } else if (bar?.glyph) {
      const font = new Font("Bravura", c.digitFont.size * 0.95);
      const w = font.measureText(bar.glyph);
      g.add(text(bar.glyph, x - w / 2, y, font, c.ink));
      slot += 1;
    }
  }
}

/** `spanHeight` > 0 时，这条小节线从 baseline 一直画到 baseline+spanHeight（贯穿多声部）。
 *
 *  **线本身收在一个 `Group` 里**并作为返回值交出去：几条竖线加反复点是好几个图元，散着放
 *  就是几个互不相干的 `<g>`，可视化编辑罩不出一个框、也点不中整条线。挂在线上的记号与
 *  临时拍号不进这个组（它们各自是独立对象）。线不画时返回 null。 */
function paintBarline(c: OriginalCtx,
  root: Group,
  x: number,
  baseline: number,
  it: PlacedItem,
  spanHeight = 0,
): Group | null {
  const m = c.metrics;
  const el = it.element;
  if (el.kind !== "barline") return null;
  if (el.type === "hidden" || el.type === "invisible") {
    // 线本身不画，但挂在它上面的记号与临时拍号仍要画
    if (el.ornaments.length > 0) {
      const g = new Group();
      paintOrnaments(c, g, el.ornaments, x, baseline);
      root.add(g);
    }
    if (el.temporaryMeter) {
      const font = new Font(m.fontFamily, m.headerSize * 0.85);
      paintMeter(c, root, x, baseline, el.temporaryMeter, font);
    }
    return null;
  }

  if (el.ornaments.length > 0) {
    const g = new Group();
    paintOrnaments(c, g, el.ornaments, x, baseline);
    root.add(g);
  }
  // 临时拍号：`|"p:2/4"`，画在这条小节线右侧
  if (el.temporaryMeter) {
    const font = new Font(m.fontFamily, m.headerSize * 0.85);
    paintMeter(c, root, x + m.barlineDoubleGap, baseline, el.temporaryMeter, font);
  }

  // 粗细组合、反复点、线间距**全部走谱面那一路的画法**（jpglyph.ts::jpBarlineItems）。
  // 原先这里是自成一套：填充 rect 而不是 GraphicLine、粗线 ×2.6、线距 barlineDoubleGap、
  // 反复点在 ±0.18H 且离线 6px——同一件事两种写法，改一处忘一处。
  // 纵向范围仍是文本谱自己的（`barlineHeight` 居中于基线、再加 spanHeight），
  // 那是照原版量的，不是谱面那套 jpStaffTop/Bottom。
  const half = m.barlineHeight * 0.5;
  const spec = PU_BARLINE_SPEC[el.type];
  if (!spec) return null;
  const r = jpBarlineItems(spec, el.type === "end", {
    top: -half,
    bot: half + spanHeight,
    light: m.barlineWidth,
    heavy: m.barlineWidth * 2.6,
    dotRadius: m.repeatDotRadius,
    color: c.ink,
  });
  // jpBarlineItems 的 x 从 0 起；文本谱的小节线是**居中于锚点**的
  const ox = x - r.width / 2;
  const g = new Group();
  for (const item of r.items) {
    item.x += ox;
    item.y += baseline;
    g.add(item);
  }
  root.add(g);
  return g;
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
function paintJoinBrace(c: OriginalCtx, root: Group, voice: PlacedVoice, lyricRight: number[]): void {
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
  for (const [first, last] of spans) paintOneJoinBrace(c, root, voice, lyricRight, first, last);
}

function paintOneJoinBrace(c: OriginalCtx,
  root: Group,
  voice: PlacedVoice,
  lyricRight: number[],
  first: number,
  last: number,
): void {
  const m = c.metrics;
  let right = 0;
  for (let i = first; i <= last; i++) right = Math.max(right, lyricRight[i] ?? 0);
  if (!Number.isFinite(right) || right <= 0) return;
  // 紧贴最长那行的末字右缘（原版留约 0.2 个歌词墨迹高的缝）
  const x = right + m.lyricSize * BRACE_GAP;
  const y0 = voice.lyricY[first]! - m.lyricSize * BRACE_TOP;
  const y1 = voice.lyricY[last]! - m.lyricSize * BRACE_BOTTOM_UP;
  if (y1 - y0 <= 0) return;
  // 右向 `}`：上下两端贴着歌词，尖端朝右
  root.add(braceItem(c.ink, x, y0, y1, 1, "lyric"));
}

/** 歌词行的前置说明（段号 `1.`、角色名「狼:」等）。 */
function paintLyricAnnotations(c: OriginalCtx, root: Group, voice: PlacedVoice, left: number): void {
  const m = c.metrics;
  const font = new Font(m.fontFamily, m.lyricLabelSize);
  voice.voice.lyrics.forEach((line, verse) => {
    if (!line.annotation) return;
    // 右对齐到歌词首字的左缘（首字是居中于第一个音符锚点的）。
    // `%NN` 可以调这个间隙，默认 20% 字宽。
    const gapPx = Math.max(line.annotationGap / 100, 0.1) * m.lyricSize;
    const w = font.measureText(line.annotation);
    root.add(
      text(line.annotation, left - m.lyricSize * 0.5 - gapPx - w, voice.lyricY[verse]!, font, c.lyricInk),
    );
  });
}

function paintSyllables(c: OriginalCtx,
  root: Group,
  it: PlacedItem,
  x: number,
  voice: PlacedVoice,
  pageIndex: number,
  rightEdge?: number[],
): void {
  const m = c.metrics;
  const font = new Font(m.fontFamily, m.lyricSize);
  it.syllables.forEach((syl, verse) => {
    if (!syl) return;
    const str = syl.text + (syl.trailingPunctuation ?? "");
    const g = new Group();
    g.classes.add("lyric");
    g.data = syl;
    // 音节按其**主体**（不含尾随标点）居中于音符锚点，标点自然挂在右边
    const bodyWidth = font.measureText(syl.text);
    g.add(text(str, x - bodyWidth / 2, voice.lyricY[verse]!, font, c.lyricInk));
    if (rightEdge) {
      rightEdge[verse] = Math.max(rightEdge[verse] ?? 0, x - bodyWidth / 2 + font.run(str).width);
    }
    root.add(g);
    const owner = c.doc?.syllableOwner.get(syl);
    if (owner !== undefined) c.syllableItems.set(`${owner}:${verse}`, { page: pageIndex, item: g });
  });
}


/** 原样文档排版的外部配置：面板那一层（字号 / 纸 / 长图，见 `style/pu.ts`）与前景色（null = 出厂墨色）。 */
export interface OriginalDocumentConfig {
  readonly user: PuUserOptions | null;
  readonly ink: number | null;
}

/** 一份文档排好的原样页面与身份索引。 */
export interface OriginalDocumentLayout {
  readonly pages: Group[];
  /** 页宽高（排版坐标，即 pt）。连续长图时随内容而定。 */
  readonly width: number;
  readonly height: number;
  readonly metrics: PuMetrics;
  /** 当前音符数字的字号（pt）。面板上的「基础字号」显示的就是它。 */
  readonly digitFontSize: number;
  readonly view: DocView;
  readonly placed: PlacedScore;
  readonly noteItems: ReadonlyMap<ElementId, { page: number; item: PageItem }>;
  readonly syllableItems: ReadonlyMap<string, { page: number; item: PageItem }>;
  readonly barlineItems: ReadonlyMap<string, { page: number; item: PageItem }>;
  readonly slurItems: ReadonlyMap<string, { page: number; item: PageItem }>;
}

/** 这份文档在**不加手动字号**时的数字字号（pt）——面板拿它当「跟随版式」的默认值。 */
export function baseDigitFontSize(doc: ScoreDoc): number {
  return docMetricsOf(docView(doc)).digitSize;
}

/** 排一份文档并生成全部页面（原 `PuPainter.load`）。 */
export function layoutOriginalDocument(source: ScoreDoc, cfg: OriginalDocumentConfig): OriginalDocumentLayout {
  const doc = originalInputOf(source);
  // 谱面自带的 `FontSize:` / `Margin:` 也要生效（真实语料里 `all=` 用得最多）；
  // 谱面自带的指令先生效，面板上的手动设置叠在最外层（用户说了算）
  const docMetrics = docMetricsOf(doc);
  const m = resolveDigitInk(applyUserOptions(docMetrics, resolveScale(cfg.user, docMetrics)));
  const c: OriginalCtx = {
    metrics: m,
    doc,
    placed: null,
    digitFont: new Font(m.digitFamily, m.digitSize, m.digitBold),
    _accFont: null,
    pageWidth: m.pageWidth,
    pageHeight: m.pageHeight,
    _pageShiftX: 0,
    noteItems: new Map(),
    syllableItems: new Map(),
    barlineItems: new Map(),
    slurItems: new Map(),
    ink: cfg.ink ?? DEFAULT_INK,
    lyricInk: cfg.ink ?? DEFAULT_LYRIC_INK,
  };
  const headerBottoms = doc.songs.map((song) => headerBottom(c, song.metadata));
  // 歌词的**墨迹**伸出注入给排版（它不碰字体）：落位口径同 paintSyllables——主体居中于锚点、
  // 尾随标点挂右边。量墨迹而不是字面框：「声，」的全角逗号字面框右半边是空的，
  // 按字面框约束会把墨迹根本没碰到的行也撑开（《圣哉三一歌》长图就是这样被误伤的）。
  const lyricFont = new Font(m.fontFamily, m.lyricSize);
  const measure: LyricMeasure = (syl) => {
    const half = lyricFont.measureText(syl.text) / 2;
    const ink = lyricFont.charBound(syl.text + (syl.trailingPunctuation ?? ""));
    return { left: half - ink.left, right: ink.right - half };
  };
  const placed = layoutDocument(doc.songs, m, headerBottoms, measure);
  c.placed = placed;
  // 页脚（BL/BC/BR）：每首末页、最低一行之下。先排一遍拿到占高，连续长图的页高要把它算进去
  const footers = layoutFooters(c, 0);
  const footerBottom = Math.max(0, ...footers.map((f) => f.bottom));
  // 连续长图：页面尺寸随内容走，不受纸张尺寸约束（短曲子不该拖着一大片空白）
  if (m.continuous) {
    c.pageHeight = Math.max(
      m.marginTop + m.bodyTop,
      placed.contentBottom + m.digitInkHeight + m.marginBottom,
      footerBottom > 0 ? footerBottom + m.marginBottom : 0,
    );
    // 页宽按**实际墨迹**裁紧并左右等距留白：连谱号会探进左边距，
    // 直接用 marginLeft 会左右不对称（实测 14 / 81）。
    const inkLeft = Math.min(...placed.pages.map((p) => systemLeft(c, p)));
    const inkRight =
      m.marginLeft + m.bodyLeftPad + placed.contentRight + m.digitInkHeight * 0.6;
    const side = m.continuousSideMargin;
    const titleNeed = headerWidth(c, doc.songs[0]?.metadata);
    c.pageWidth = Math.max(inkRight - inkLeft + side * 2, titleNeed);
    c._pageShiftX = side - inkLeft;
  }
  const footerItems = layoutFooters(c, c._pageShiftX);
  const pages = placed.pages.map((pg, i) => {
    const g = paintPage(c, pg, i);
    for (const f of footerItems) if (f.page === i) for (const it of f.items) g.add(it);
    g.x += c._pageShiftX;
    return g;
  });
  for (const p of pages) p.update();
  return {
    pages,
    width: c.pageWidth,
    height: c.pageHeight,
    metrics: m,
    digitFontSize: c.digitFont.size,
    view: doc,
    placed,
    noteItems: c.noteItems,
    syllableItems: c.syllableItems,
    barlineItems: c.barlineItems,
    slurItems: c.slurItems,
  };
}

/** 内置的文本谱页脚模板（解析一次）。 */
let puFoot: Region | null | undefined;
function PU_FOOT(): Region | null {
  if (puFoot === undefined) {
    const sheet = computeStyleForPaper([parseJpcss(PU_BOOK).rules], { engine: "pu" });
    puFoot = (sheet.template?.regions?.["song-foot"] as Region | undefined) ?? null;
  }
  return puFoot;
}
