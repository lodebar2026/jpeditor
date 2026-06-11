// 混排（五线谱+简谱）排版/分页/绘制入口: formatMixedScore + MixedPainter。
// 页面尺寸/边距以 MusicXML <defaults> 为准（不固定画布），适用于所有混排乐谱。
// 从 musicpp util/pao.cpp 移植（formatScorePAO + paoSingleScore，不含 fixPaoScore 逐曲 hack）。

import { MetaData } from "../smufl/smufl";
import { Fraction } from "../common/fraction";
import { Matrix33 } from "../common/geom";
import { Font } from "../layout/font";
import { GraphicLine, GraphicPath, Group, PageItem, TextFrame } from "../layout/layout";
import { LCR, MixedOptions, MixedScore, Notation, ScoreCredit, Sys } from "./model";
import { loadMixedXml } from "./loader";
import { drawSystem } from "./render";

const SVG_NS = "http://www.w3.org/2000/svg";

// -----------------------------------------------------------------------
// formatMixedScore（formatScorePAO port, without per-song hacks）

/**
 * Post-process the loaded MixedScore to set up Mixed notation on the first part:
 * - Set staves[0].notation[0] = Mixed
 * - Run calcMixedStaffY (needs notes already in place)
 * - Move harmonies to harmonyY
 * - Scale P2 lyric font × 0.8
 */
export function formatMixedScore(score: MixedScore): void {
  if (score.parts.length === 0) return;

  const p = score.parts[0];
  if (p.staves.length === 0) return;

  // Set Mixed notation for first staff from tick 0
  p.staves[0].notation.set(new Fraction(0), Notation.Mixed);

  // Calculate mixed staff y positions (needs chords/slurs in place)
  p.calcMixedStaffY();

  // Move harmony y to harmonyY
  for (const sys of score.systems) {
    for (const st of sys.staves) {
      if (st.part() !== p) continue;
      for (const m of sys.measures) {
        const md = p.measures[m.index];
        if (!md) continue;
        for (const h of md.harmonies) {
          h.y = st.harmonyY + 3;
        }
      }
    }
  }

  // P2 lyric font × 0.8
  const lastPart = score.parts[score.parts.length - 1];
  if (lastPart !== p && lastPart.pid === "P2") {
    const refFont = score.defaults.lyricFont;
    const fnt2 = refFont.scaled(0.8);
    lastPart.setLyricFont(fnt2);
  }
}

// -----------------------------------------------------------------------
// M5: 分页+标题块（paoSingleScore 的 getFrames/flowLayout/drawFrames 移植）

// 页面高度/边距来自 MusicXML <defaults>（score.defaults）；以下仅作未提供时的回退。
const PAGE_HEIGHT_FALLBACK = 1870;
const FRAME_GAP = 20;
const TITLE_OFFSET = 170; // hh(150) + 20

interface FrameItem {
  system: Sys;
  topY: number;
  bottomY: number;
  height: number;
  musicYOffset: number;
  credits: ScoreCredit[];
}

interface LayoutFrame {
  height: number;
  ypos: number;
  newPage: boolean;
}

function getFrames(score: MixedScore): FrameItem[] {
  const items: FrameItem[] = [];
  for (const sys of score.systems) {
    // System::getYBound（model.ts）：忠实移植，topY 为上方延伸量，bottomY 为下方（负）。
    const [topY, bottomY] = sys.getYBound();
    items.push({
      system: sys,
      topY,
      bottomY,
      height: topY - bottomY,
      musicYOffset: 0,
      credits: [],
    });
  }
  return items;
}

function flowLayout(items: FrameItem[], ph: number): LayoutFrame[] {
  const result: LayoutFrame[] = [];
  let ypos = ph * 2; // force newPage on first frame
  let lastMrg = 0;
  for (const frm of items) {
    const mrg = Math.max(lastMrg, FRAME_GAP);
    const bot = ypos + frm.height;
    const np = bot + mrg > ph;
    const lf: LayoutFrame = { height: frm.height, ypos: 0, newPage: np };
    if (np) {
      lastMrg = 0;
      ypos = 0;
    } else {
      ypos += mrg;
    }
    lf.ypos = ypos;
    ypos += frm.height;
    lastMrg = FRAME_GAP;
    result.push(lf);
  }
  return result;
}

function drawFrames(
  score: MixedScore,
  items: FrameItem[],
  lf: LayoutFrame[],
  leftMargin: number,
  topMargin: number,
  pageHeight: number,
  pageWidthTenths: number,
): Group[] {
  const pages: Group[] = [];
  let page: Group | null = null;

  for (let i = 0; i < items.length; i++) {
    const data = items[i];
    const it = lf[i];
    const sys = data.system;

    if (it.newPage || !page) {
      page = new Group();
      pages.push(page);
    }

    // Credits (title block text) for this frame. credit-words 可含换行 → 逐行排版。
    const pg = page; // non-null here (ensured above); capture for closure
    for (const cr of data.credits) {
      const fntSz = cr.fontSize > 0 ? cr.fontSize / score.scaling : 20;
      const family = cr.fontSize > 0 ? score.defaults.lyricFont.family : "PingFang SC";
      const font = new Font(family, fntSz);
      const anchorX = cr.x > 0 ? cr.x : pageWidthTenths / 2;
      const baseY = pageHeight - cr.y; // MusicXML y from page bottom → SVG top-down
      const lineH = fntSz * 1.2;
      const lines = cr.text.split(/\r?\n/);
      lines.forEach((line, li) => {
        const tf = new TextFrame();
        tf.text = line;
        tf.font = font;
        let x = anchorX;
        const w = font.measureText(line);
        if (cr.justify === LCR.Center) x -= w / 2;
        else if (cr.justify === LCR.Right) x -= w;
        const m = new Matrix33();
        m.setAffine([1, 0, 0, 1, x, baseY + li * lineH]);
        tf.matrix = m;
        pg.add(tf);
      });
    }

    // System group positioned at (leftMargin+sys.leftMargin, topMargin+ypos+topY+musicYOffset)
    const sysGrp = drawSystem(page, sys);
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1,
      leftMargin + sys.leftMargin,
      topMargin + it.ypos + data.topY + data.musicYOffset,
    ]);
    sysGrp.matrix = m;
  }

  return pages;
}

// -----------------------------------------------------------------------
// MixedPainter（接口对齐 JinpuPainter：load/pageCount/renderPage/pageWidthPt/pageHeightPt）

export class MixedPainter {
  private score: MixedScore | null = null;
  private meta: MetaData | null = null;
  private _pages: Group[] = [];

  /** Width of one page in tenths. */
  get pageWidthTenths(): number {
    return this.score?.defaults.pageWidth ?? 1200;
  }
  /** Height of one page in tenths (from MusicXML <page-layout>). */
  get pageHeightTenths(): number {
    return this.score?.defaults.pageHeight ?? PAGE_HEIGHT_FALLBACK;
  }

  /** Width in PDF points (A4 ≈ 595 pt). */
  get pageWidthPt(): number {
    return this.score ? this.pageWidthTenths * this.score.scaling : 595;
  }
  /** Height in PDF points (A4 ≈ 842 pt). */
  get pageHeightPt(): number {
    return this.pageHeightTenths * (this.score?.scaling ?? 0.4505);
  }

  get pageCount(): number {
    return this._pages.length;
  }

  /** Score title (first line), for export filenames. */
  get title(): string {
    return this.score?.title.split("\n")[0] ?? "";
  }

  /** Load and format a MusicXML string. Must be called before renderPage. */
  async load(xmlText: string): Promise<void> {
    if (!this.meta) {
      this.meta = await MetaData.load();
    }
    const options = new MixedOptions(this.meta);
    const score = loadMixedXml(xmlText, options);
    formatMixedScore(score);
    this.score = score;

    // M5: flow layout
    const items = getFrames(score);
    if (items.length > 0) {
      // Add title block (credits) to first frame
      items[0].credits = score.credits.filter(c => c.page === 0);
      items[0].musicYOffset = TITLE_OFFSET;
      items[0].height += TITLE_OFFSET;
    }
    const d = score.defaults;
    const pageHeight = this.pageHeightTenths;
    const ph = pageHeight - d.topMargin - d.bottomMargin;
    const layout = flowLayout(items, ph);
    this._pages = drawFrames(
      score, items, layout, d.leftMargin, d.topMargin, pageHeight, this.pageWidthTenths,
    );
  }

  /**
   * Render one page as an SVG element.
   * viewBox is in tenths; consumer can scale via CSS or SVG width/height attrs.
   */
  renderPage(pageIndex: number): SVGSVGElement {
    if (!this.score || pageIndex >= this._pages.length) throw new Error("MixedPainter: not loaded");

    const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    const w = this.pageWidthTenths;
    const h = this.pageHeightTenths;
    svg.setAttribute("class", "score-page mixed-page");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    svg.appendChild(renderGroup(this._pages[pageIndex]));
    return svg;
  }
}

// -----------------------------------------------------------------------
// PageItem → SVGElement (mirrors painter.ts renderPageItem but for mixed-only types)

function renderGroup(grp: Group): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
  if (!grp.matrix.isIdentity) g.setAttribute("transform", grp.matrix.toSvg());
  for (const child of grp.children) {
    const el = renderItem(child);
    if (el) g.appendChild(el);
  }
  return g;
}

function renderItem(item: PageItem): SVGElement | null {
  if (item instanceof Group) {
    return renderGroup(item);
  }
  if (item instanceof GraphicLine) {
    const el = document.createElementNS(SVG_NS, "line") as SVGLineElement;
    el.setAttribute("x1", String(item.p0.x));
    el.setAttribute("y1", String(item.p0.y));
    el.setAttribute("x2", String(item.p1.x));
    el.setAttribute("y2", String(item.p1.y));
    el.setAttribute("stroke", "black");
    el.setAttribute("stroke-width", String(item.strokeWidth));
    el.setAttribute("stroke-linecap", "butt");
    if (!item.matrix.isIdentity) el.setAttribute("transform", item.matrix.toSvg());
    return el;
  }
  if (item instanceof TextFrame) {
    const el = document.createElementNS(SVG_NS, "text") as SVGTextElement;
    el.setAttribute("x", "0");
    el.setAttribute("y", "0");
    el.setAttribute("font-family", item.font.family);
    el.setAttribute("font-size", String(item.font.size));
    if (item.font.bold) el.setAttribute("font-weight", "bold");
    el.setAttribute("fill", "black");
    el.textContent = item.text;
    el.setAttribute("transform", item.matrix.toSvg()); // matrix contains x,y translation
    return el;
  }
  if (item instanceof GraphicPath) {
    const el = document.createElementNS(SVG_NS, "path") as SVGPathElement;
    el.setAttribute("d", item.d);
    if (item.fill) {
      const c = item.fillColor;
      el.setAttribute("fill", argbToCss(c));
    } else {
      el.setAttribute("fill", "none");
    }
    if (item.stroke) {
      const c = item.strokeColor;
      el.setAttribute("stroke", argbToCss(c));
      el.setAttribute("stroke-width", String(item.strokeWidth));
    } else {
      el.setAttribute("stroke", "none");
    }
    if (!item.matrix.isIdentity) el.setAttribute("transform", item.matrix.toSvg());
    return el;
  }
  return null;
}

function argbToCss(argb: number): string {
  const r = (argb >> 16) & 0xff;
  const g = (argb >> 8) & 0xff;
  const b = argb & 0xff;
  const a = ((argb >>> 24) & 0xff) / 255;
  if (a >= 1) return `rgb(${r},${g},${b})`;
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}
