// PAO（Praise as One）混排 pipeline: formatScorePao + MixedPainter。
// 从 musicpp util/pao.cpp 移植（formatScorePAO + paoSingleScore，不含 fixPaoScore 逐曲 hack）。

import { MetaData } from "../smufl/smufl";
import { Fraction } from "../common/fraction";
import { GraphicLine, GraphicPath, Group, PageItem, TextFrame } from "../layout/layout";
import { MixedOptions, MixedScore, Notation } from "./model";
import { loadMixedXml } from "./loader";
import { drawPage } from "./render";

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
// MixedPainter（接口对齐 JinpuPainter：load/pageCount/renderPage/pageWidthPt/pageHeightPt）

export class MixedPainter {
  private score: MixedScore | null = null;
  private meta: MetaData | null = null;

  /** Width of one page in tenths. */
  get pageWidthTenths(): number {
    return this.score?.defaults.pageWidth ?? 1200;
  }
  /** Height of one page in tenths. */
  get pageHeightTenths(): number {
    return this.score?.defaults.pageHeight ?? 1697;
  }

  /** Width in PDF points (A4 ≈ 595 pt). */
  get pageWidthPt(): number {
    return this.score ? this.pageWidthTenths * this.score.scaling : 595;
  }
  /** Height in PDF points (A4 ≈ 842 pt). */
  get pageHeightPt(): number {
    return this.score ? this.pageHeightTenths * this.score.scaling : 842;
  }

  get pageCount(): number {
    return this.score?.pages.length ?? 0;
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
  }

  /**
   * Render one page as an SVG element.
   * viewBox is in tenths; consumer can scale via CSS or SVG width/height attrs.
   */
  renderPage(pageIndex: number): SVGSVGElement {
    if (!this.score) throw new Error("MixedPainter: not loaded");

    const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    const w = this.pageWidthTenths;
    const h = this.pageHeightTenths;
    svg.setAttribute("class", "score-page mixed-page");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    const pageGroup = drawPage(this.score, pageIndex);
    svg.appendChild(renderGroup(pageGroup));
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
