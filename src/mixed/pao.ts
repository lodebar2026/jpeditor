// PAO（Praise as One）混排 pipeline: formatScorePao + MixedPainter。
// 从 musicpp util/pao.cpp 移植（formatScorePAO + paoSingleScore，不含 fixPaoScore 逐曲 hack）。

import { MetaData } from "../smufl/smufl";
import { Fraction } from "../common/fraction";
import { Matrix33 } from "../common/geom";
import { Font } from "../layout/font";
import { GraphicLine, GraphicPath, Group, PageItem, TextFrame } from "../layout/layout";
import { MixedOptions, MixedScore, Notation, ScoreCredit, Sys } from "./model";
import { loadMixedXml } from "./loader";
import { drawSystem } from "./render";

const SVG_NS = "http://www.w3.org/2000/svg";

// -----------------------------------------------------------------------
// formatScorePao（formatScorePAO port, without per-song hacks）

/**
 * Post-process the loaded MixedScore to set up Mixed notation on the first part:
 * - Set staves[0].notation[0] = Mixed
 * - Run calcMixedStaffY (needs notes already in place)
 * - Move harmonies to harmonyY
 * - Scale P2 lyric font × 0.8
 */
export function formatScorePao(score: MixedScore): void {
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

const PAO_PAGE_HEIGHT = 1870;
const PAO_MARGIN = 75;
const PAO_FRAME_GAP = 20;
const PAO_TITLE_OFFSET = 170; // hh(150) + 20

interface PaoFrameItem {
  system: Sys;
  topY: number;
  bottomY: number;
  height: number;
  musicYOffset: number;
  credits: ScoreCredit[];
}

interface PaoLayoutFrame {
  height: number;
  ypos: number;
  newPage: boolean;
}

/** 计算 system 内容的上下边界（相对于 system group y=0 = 第一谱表顶线）。 */
function sysGetYBound(sys: Sys, _eng: MixedOptions): [number, number] {
  let firstStIdx = -1, lastStIdx = -1;
  for (let i = 0; i < sys.staves.length; i++) {
    if (sys.staves[i].staffVisible) {
      if (firstStIdx < 0) firstStIdx = i;
      lastStIdx = i;
    }
  }
  if (firstStIdx < 0) return [60, -100];

  const firstSt = sys.staves[firstStIdx];
  const lastSt = sys.staves[lastStIdx];
  const t0 = sys.measures[0].offset;

  // Top: extent above first staff y=0 (positive = above)
  let topY = 60;
  const nota = firstSt.partStaff.getNotation(t0);
  if (nota === Notation.Mixed) {
    // JP layer top = minY - mixStaffDist - mixStaffHeight; topY = -(that)
    topY = Math.max(topY, -firstSt.minY + 35);
  }
  const firstPart = firstSt.part();
  for (const m of sys.measures) {
    const md = firstPart.measures[m.index];
    if (!md) continue;
    for (const h of md.harmonies) {
      topY = Math.max(topY, h.y + 10);
    }
  }

  // Bottom: extent below last staff (negative, relative to system y=0)
  let botFromLastStaff = -60; // default: 60 below last staff top
  const lastPart = lastSt.part();
  for (const m of sys.measures) {
    const md = lastPart.measures[m.index];
    if (!md) continue;
    for (const lrc of md.lyrics) {
      const y = lrc.y - 10;
      if (y < botFromLastStaff) botFromLastStaff = y;
    }
  }
  const lastStYpos = sys.ypos(lastStIdx);
  const bottomY = botFromLastStaff - lastStYpos;

  return [topY, bottomY];
}

function paoGetFrames(score: MixedScore): PaoFrameItem[] {
  const eng = score.options;
  const items: PaoFrameItem[] = [];
  for (const sys of score.systems) {
    const [topY, bottomY] = sysGetYBound(sys, eng);
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

function paoFlowLayout(items: PaoFrameItem[], ph: number): PaoLayoutFrame[] {
  const result: PaoLayoutFrame[] = [];
  let ypos = ph * 2; // force newPage on first frame
  let lastMrg = 0;
  for (const frm of items) {
    const mrg = Math.max(lastMrg, PAO_FRAME_GAP);
    const bot = ypos + frm.height;
    const np = bot + mrg > ph;
    const lf: PaoLayoutFrame = { height: frm.height, ypos: 0, newPage: np };
    if (np) {
      lastMrg = 0;
      ypos = 0;
    } else {
      ypos += mrg;
    }
    lf.ypos = ypos;
    ypos += frm.height;
    lastMrg = PAO_FRAME_GAP;
    result.push(lf);
  }
  return result;
}

function drawPaoFrames(
  score: MixedScore,
  items: PaoFrameItem[],
  lf: PaoLayoutFrame[],
  margin: number,
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

    // Credits (title block text) for this frame
    for (const cr of data.credits) {
      const tf = new TextFrame();
      tf.text = cr.text;
      const fntSz = cr.fontSize > 0 ? cr.fontSize / score.scaling : 20;
      tf.font = new Font(cr.fontSize > 0 ? score.defaults.lyricFont.family : "PingFang SC", fntSz);
      // MusicXML y from page bottom → SVG top-down: y = pageHeight - cr.y
      const m = new Matrix33();
      m.setAffine([1, 0, 0, 1, cr.x > 0 ? cr.x : pageWidthTenths / 2, PAO_PAGE_HEIGHT - cr.y]);
      tf.matrix = m;
      page.add(tf);
    }

    // System group positioned at (margin+leftMargin, margin+ypos+topY+musicYOffset)
    const sysGrp = drawSystem(page, sys);
    const m = new Matrix33();
    m.setAffine([1, 0, 0, 1,
      margin + sys.leftMargin,
      margin + it.ypos + data.topY + data.musicYOffset,
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
  /** Height of one page in tenths. */
  get pageHeightTenths(): number {
    return PAO_PAGE_HEIGHT;
  }

  /** Width in PDF points (A4 ≈ 595 pt). */
  get pageWidthPt(): number {
    return this.score ? this.pageWidthTenths * this.score.scaling : 595;
  }
  /** Height in PDF points (A4 ≈ 842 pt). */
  get pageHeightPt(): number {
    return PAO_PAGE_HEIGHT * (this.score?.scaling ?? 0.4505);
  }

  get pageCount(): number {
    return this._pages.length;
  }

  /** Load and format a MusicXML string. Must be called before renderPage. */
  async load(xmlText: string): Promise<void> {
    if (!this.meta) {
      this.meta = await MetaData.load();
    }
    const options = new MixedOptions(this.meta);
    const score = loadMixedXml(xmlText, options);
    formatScorePao(score);
    this.score = score;

    // M5: flow layout
    const items = paoGetFrames(score);
    if (items.length > 0) {
      // Add title block (credits) to first frame
      items[0].credits = score.credits.filter(c => c.page === 0);
      items[0].musicYOffset = PAO_TITLE_OFFSET;
      items[0].height += PAO_TITLE_OFFSET;
    }
    const ph = PAO_PAGE_HEIGHT - PAO_MARGIN * 2;
    const layout = paoFlowLayout(items, ph);
    this._pages = drawPaoFrames(score, items, layout, PAO_MARGIN, this.pageWidthTenths);
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
