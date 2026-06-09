// Ported from mp/layout/draw.kt (JinpuPainter). Renders the page tree to SVG
// (replacing Skija Canvas drawing) and provides resize/title-page/pick.

import { Point, Rect, colorToCss } from "../common/geom";
import { Font } from "./font";
import {
  GraphicLine,
  GraphicPath,
  Group,
  Layout,
  PageItem,
  TextFrame,
  SmuflText,
} from "./layout";
import { Score } from "../score/score";

const SVG_NS = "http://www.w3.org/2000/svg";

export class JinpuPainter {
  layout: Layout;
  score = new Score();
  pageWidth = 0;
  pageHeight = 0;
  /** PageItem -> rendered <g>, populated each renderPage (for DOM picking). */
  nodeMap = new WeakMap<PageItem, SVGGElement>();

  constructor(fontSize: number) {
    this.layout = new Layout(fontSize);
  }

  resize(w: number, h: number, dur: string | null): void {
    this.pageWidth = w;
    this.pageHeight = h;
    this.layout.fromScore(this.score, dur, w, h);
    this.layout.pages.unshift(this.titlePage(w, h));
    for (const p of this.layout.pages) p.update();
  }

  private multipleLineText(str: string, fnt: Font, w: number, clr: number): PageItem {
    const arr = str.split("\n");
    const grp = new Group();
    let ypos = 0;
    const fm = fnt.metrics;
    const height = fm.descent - fm.ascent;
    for (const it of arr) {
      const tf = new TextFrame();
      tf.color = clr;
      tf.font = fnt;
      tf.text = it;
      const ww = tf.measureText();
      tf.x = (w - ww) / 2;
      tf.y = ypos;
      ypos += height;
      if (arr.length === 1) return tf;
      grp.add(tf);
    }
    return grp;
  }

  titlePage(w: number, h: number): Group {
    const opt = this.layout.options;
    const fnt = opt.lrcFont;
    const pg = new Group();
    let titleCount = 0;
    const texts: string[] = [];
    const fonts: Font[] = [];
    for (const it of this.score.credit) {
      const isTitle = it.type === "title";
      const sz = isTitle ? 48 : 36;
      if (isTitle) {
        titleCount++;
        texts.unshift(it.text);
        fonts.unshift(fnt.makeWithSize(sz));
      } else {
        texts.push(it.text);
        fonts.push(fnt.makeWithSize(sz));
      }
    }
    if (titleCount === 0) {
      if (this.score.title.trim().length > 0) {
        titleCount = 1;
        texts.unshift(this.score.title);
        fonts.unshift(fnt.makeWithSize(48));
      }
    }
    if (titleCount !== 1) console.error("title count error!");
    let ypos = 0.3 * h;
    texts.forEach((text, idx) => {
      const font = fonts[idx];
      const obj = this.multipleLineText(text, font, w, opt.color);
      obj.y = ypos;
      obj.update();
      pg.add(obj);
      ypos += obj.height;
    });
    return pg;
  }

  // ---------------- SVG rendering ----------------

  /** Render one page group into a standalone <svg> of pageWidth x pageHeight. */
  renderPage(pageIndex: number): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "score-page");
    svg.setAttribute("viewBox", `0 0 ${this.pageWidth} ${this.pageHeight}`);
    const pg = this.layout.pages[pageIndex];
    svg.appendChild(renderPageItem(pg, this.nodeMap));
    return svg;
  }

  /** Walk up from a picked item to its enclosing "entry" group (else the item). */
  entryGroupOf(item: PageItem): PageItem {
    let cur: PageItem | null = item;
    while (cur) {
      if (cur.classes.has("entry")) return cur;
      cur = cur.parent;
    }
    return item;
  }

  get pageCount(): number {
    return this.layout.pages.length;
  }

  // ---------------- picking (Phase 3) ----------------

  private calcDist(x: number, y: number, inn: Rect): number {
    let dx = 0;
    if (x < inn.left) dx = inn.left - x;
    else if (x > inn.right) dx = x - inn.right;
    let dy = 0;
    if (y < inn.top) dy = inn.top - y;
    else if (y > inn.bottom) dy = y - inn.bottom;
    return dx + dy;
  }

  pick(root: PageItem, x: number, y: number): [PageItem | null, number] {
    let bnd = root.bound;
    bnd = bnd.offset(root.x, root.y);
    const edge = 5;
    const dist = this.calcDist(x, y, bnd);
    if (root.children.length === 0) {
      let outer = new Rect(bnd.left, bnd.top, bnd.right, bnd.bottom);
      const dx = Math.min(bnd.width - edge * 2, 0) / 2;
      const dy = Math.min(bnd.height - edge * 2, 0) / 2;
      outer = outer.inset(dx, dy);
      return outer.contains(x, y) ? [root, dist] : [null, dist];
    }
    let outer = new Rect(bnd.left, bnd.top, bnd.right, bnd.bottom);
    outer = outer.inset(-edge, -edge);
    if (outer.contains(x, y)) {
      const xx = x - bnd.left;
      const yy = y - bnd.top;
      const items: PageItem[] = [];
      let minDist = Number.MAX_VALUE;
      let best: PageItem | null = null;
      let small: PageItem | null = null;
      for (const ch of root.children) {
        const [p, pd] = this.pick(ch, xx, yy);
        if (p !== null) {
          if (pd < minDist) {
            best = p;
            minDist = pd;
            items.length = 0;
            items.push(p);
          }
          if (pd === minDist) items.push(p);
          if (ch.bound.width < edge || ch.bound.height < edge) small = ch;
        }
      }
      if (small !== null) return [small, 0];
      let area = Number.MAX_VALUE;
      for (const it of items) {
        const a = it.bound.width * it.bound.height;
        if (a < area) {
          best = it;
          area = a;
        }
      }
      return [best, minDist];
    }
    return [null, Number.MAX_VALUE];
  }

  pickPage(page: number, pos: Point): PageItem | null {
    const pg = this.layout.pages[page];
    const [p] = this.pick(pg, pos.x, pos.y);
    return p;
  }
}

// Recursively build an SVG <g> for a PageItem (matrix transform + self shape +
// children), mirroring draw.kt's drawPageItem (save/concat/drawTo/recurse).
export function renderPageItem(
  item: PageItem,
  nodeMap?: WeakMap<PageItem, SVGGElement>,
): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  if (!item.matrix.isIdentity) g.setAttribute("transform", item.matrix.toSvg());
  const self = renderSelf(item);
  if (self) g.appendChild(self);
  for (const ch of item.children) g.appendChild(renderPageItem(ch, nodeMap));
  nodeMap?.set(item, g);
  return g;
}

function renderSelf(item: PageItem): SVGElement | null {
  if (item instanceof GraphicPath) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", item.d);
    if (item.fill) p.setAttribute("fill", colorToCss(item.fillColor));
    else p.setAttribute("fill", "none");
    if (item.stroke) {
      p.setAttribute("stroke", colorToCss(item.strokeColor));
      p.setAttribute("stroke-width", String(item.strokeWidth));
    }
    return p;
  }
  if (item instanceof GraphicLine) {
    const l = document.createElementNS(SVG_NS, "line");
    l.setAttribute("x1", String(item.p0.x));
    l.setAttribute("y1", String(item.p0.y));
    l.setAttribute("x2", String(item.p1.x));
    l.setAttribute("y2", String(item.p1.y));
    l.setAttribute("stroke", colorToCss(item.strokeColor));
    l.setAttribute("stroke-width", String(item.strokeWidth));
    l.setAttribute("stroke-linecap", "butt");
    return l;
  }
  if (item instanceof TextFrame) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", "0");
    t.setAttribute("y", "0");
    const family = item instanceof SmuflText ? "Bravura" : item.font.family;
    t.setAttribute("font-family", family);
    t.setAttribute("font-size", String(item.font.size));
    if (item.font.bold) t.setAttribute("font-weight", "bold");
    t.setAttribute("fill", colorToCss(item.color));
    t.textContent = item.text;
    return t;
  }
  return null; // Group / bare PageItem: children only
}
