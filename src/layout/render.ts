// 页面树 → SVG 的渲染出口：外壳（`renderPageSvg`）、两个 visitor（谱面 `svgVisitor` / 混排 `mixedVisitor`）
// 与页眉项查询（`headerPartsOf`）。不依赖任何排版器，排版器与导出都从这里取。

import { colorToCss } from "../common/geom";
import { Group, PageItem, TextFrame, SmuflText, findByClass } from "./pageitem";
import { walkPageItem, type ItemVisitor } from "./walk";

const SVG_NS = "http://www.w3.org/2000/svg";

/** `renderPageSvg` 的可选项。第四个参数直接给 WeakMap 是老写法，保留不动。 */
export interface PageSvgOptions {
  nodeMap?: WeakMap<PageItem, SVGGElement>;
  /** `<svg>` 的 class，默认 `score-page`。混排那一路还要加 `mixed-page`。 */
  cls?: string;
  /** 页面树怎么变成 DOM。默认谱面那一路的语义；混排传 `mixedVisitor`。 */
  visitor?: ItemVisitor<SVGGElement>;
}

/** 一页的页面树 → 独立 `<svg>`。ScorePainter 的简谱引擎与原样文档两路共用
 *  （三者的页面树是同一套 PageItem，只是排版器与 visitor 不同）。
 *  `root` 为空时给出一个空白页而不是抛错。 */
export function renderPageSvg(
  root: PageItem | undefined,
  width: number,
  height: number,
  opts?: WeakMap<PageItem, SVGGElement> | PageSvgOptions,
): SVGSVGElement {
  const o: PageSvgOptions = opts instanceof WeakMap ? { nodeMap: opts } : (opts ?? {});
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", o.cls ?? "score-page");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (root) {
    const holder = document.createElementNS(SVG_NS, "g");
    walkPageItem(root, holder, o.visitor ?? svgVisitor(o.nodeMap));
    // visitor 可能不为根产生 <g>（混排那份只给 Group 造），所以整批搬过去
    while (holder.firstChild) svg.appendChild(holder.firstChild);
  }
  return svg;
}

/** 页眉里画出来的一项：文字（标题、署名…）、调号、拍号。 */
export interface HeaderPart {
  el: SVGGElement;
  text: string;
  role: "text" | "key" | "time";
}

/** 各页里标了 `hdr`（文字）/ `hdr-keysig`（调号）/ `hdr-time`（拍号）的页眉项（两个排版器共用）。 */
export function headerPartsOf(pages: readonly PageItem[], nodeMap: WeakMap<PageItem, SVGGElement>): HeaderPart[] {
  const out: HeaderPart[] = [];
  const roles = [["hdr", "text"], ["hdr-keysig", "key"], ["hdr-time", "time"]] as const;
  for (const page of pages) {
    for (const [cls, role] of roles) {
      for (const it of findByClass(page, cls)) {
        const el = nodeMap.get(it);
        if (el?.isConnected) out.push({ el, text: it instanceof TextFrame ? it.text : "", role });
      }
    }
  }
  return out;
}

/**
 * 谱面这一路的 visitor：**每个** PageItem 都产生一个 <g>，matrix 加在它身上，
 * 自身图形与子级都放进去（所以叶子元素自己不带 transform）。
 * 与 mixed 那份的语义差别见下方 `mixedVisitor` 的注释。
 */
export function svgVisitor(nodeMap?: WeakMap<PageItem, SVGGElement>): ItemVisitor<SVGGElement> {
  const enter = (item: PageItem, parent: SVGGElement): SVGGElement => {
    const g = document.createElementNS(SVG_NS, "g");
    if (!item.matrix.isIdentity) g.setAttribute("transform", item.matrix.toSvg());
    parent.appendChild(g);
    nodeMap?.set(item, g);
    return g;
  };
  return {
    descend: enter,
    path: (item, g) => {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", item.d);
      if (item.fill) p.setAttribute("fill", colorToCss(item.fillColor));
      else p.setAttribute("fill", "none");
      if (item.stroke) {
        p.setAttribute("stroke", colorToCss(item.strokeColor));
        p.setAttribute("stroke-width", String(item.strokeWidth));
      }
      g.appendChild(p);
    },
    line: (item, g) => {
      const l = document.createElementNS(SVG_NS, "line");
      l.setAttribute("x1", String(item.p0.x));
      l.setAttribute("y1", String(item.p0.y));
      l.setAttribute("x2", String(item.p1.x));
      l.setAttribute("y2", String(item.p1.y));
      l.setAttribute("stroke", colorToCss(item.strokeColor));
      l.setAttribute("stroke-width", String(item.strokeWidth));
      l.setAttribute("stroke-linecap", "butt");
      g.appendChild(l);
    },
    text: (item, g) => {
      const t = document.createElementNS(SVG_NS, "text");
      t.setAttribute("x", "0");
      t.setAttribute("y", "0");
      const family = item instanceof SmuflText ? "Bravura" : item.font.family;
      t.setAttribute("font-family", family);
      t.setAttribute("font-size", String(item.font.size));
      if (item.font.bold) t.setAttribute("font-weight", "bold");
      if (item.font.italic) t.setAttribute("font-style", "italic");
      t.setAttribute("fill", colorToCss(item.color));
      // 逐字笔位（标点挤压后的坐标，排版期量的那一串）。给了 `x` 列表就由它定位，
      // **不再叠 font-feature-settings**——测量已经把挤压算进去了，再叠一层会挤两遍。
      if (item.charXs && item.charXs.length > 1)
        t.setAttribute("x", item.charXs.map((v) => v.toFixed(2)).join(" "));
      t.textContent = item.text;
      g.appendChild(t);
    },
    // Group / 裸 PageItem：只有子级，descend 里那个 <g> 就是全部
  };
}

// -----------------------------------------------------------------------
// PageItem → SVGElement。
//
// 遍历骨架与 svgVisitor 共用（layout/walk.ts），但**坐标与颜色语义不同**，
// 这些差别就是这个 visitor 存在的理由，别把它并回 svgVisitor 去：
//   - 那边**每个** PageItem 都产生一个 <g>、matrix 加在 <g> 上；这边只有 Group 产生 <g>，
//     matrix 加在**叶子元素**上（TextFrame 更是无条件加，matrix 里就含 x/y 平移）。
//   - 那边用 item 自己的 fillColor/strokeColor/color；这边线与文字一律写死 black
//     （musicpp 的五线谱层本就是纯黑）。GraphicPath 例外，它照 item 的颜色走。
//   - 那边无条件递归子级；这边只递归 Group（叶子的子级会被丢掉）。
// 真正共用的是 renderPageSvg（外壳）与 walkPageItem（骨架）。

/** `nodeMap` 给了就记下每个 Group 造出的 `<g>`（编辑器按和弦组放播放线、认点选，见 `mixed/prims.ts::STAFF_CHORD`）。 */
export function mixedVisitor(nodeMap?: WeakMap<PageItem, SVGGElement>): ItemVisitor<SVGGElement> {
  return {
    descend: (item, parent) => {
      // 只有 Group 产生新的 <g>；叶子直接落在父级的 <g> 里，自带 transform
      if (!(item instanceof Group)) return parent;
      const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
      if (!item.matrix.isIdentity) g.setAttribute("transform", item.matrix.toSvg());
      if (item.classes.size > 0) g.setAttribute("class", [...item.classes].join(" ")); // staff-chord / staff-system
      parent.appendChild(g);
      nodeMap?.set(item, g);
      return g;
    },
    descendChildren: (item) => item instanceof Group,
    line: (item, g) => {
      const el = document.createElementNS(SVG_NS, "line") as SVGLineElement;
      el.setAttribute("x1", String(item.p0.x));
      el.setAttribute("y1", String(item.p0.y));
      el.setAttribute("x2", String(item.p1.x));
      el.setAttribute("y2", String(item.p1.y));
      el.setAttribute("stroke", "black");
      el.setAttribute("stroke-width", String(item.strokeWidth));
      el.setAttribute("stroke-linecap", "butt");
      if (!item.matrix.isIdentity) el.setAttribute("transform", item.matrix.toSvg());
      g.appendChild(el);
    },
    text: (item, g) => {
      const el = document.createElementNS(SVG_NS, "text") as SVGTextElement;
      el.setAttribute("x", "0");
      el.setAttribute("y", "0");
      el.setAttribute("font-family", item.font.family);
      el.setAttribute("font-size", String(item.font.size));
      if (item.font.bold) el.setAttribute("font-weight", "bold");
      if (item.font.italic) el.setAttribute("font-style", "italic");
      el.setAttribute("fill", "black");
      // 逐字笔位（标点挤压后的坐标，排版期量的那一串）——同 layout/painter.ts 的那一处。
      if (item.charXs && item.charXs.length > 1)
        el.setAttribute("x", item.charXs.map((v) => v.toFixed(2)).join(" "));
      el.textContent = item.text;
      el.setAttribute("transform", item.matrix.toSvg()); // matrix contains x,y translation
      g.appendChild(el);
    },
    path: (item, g) => {
      const el = document.createElementNS(SVG_NS, "path") as SVGPathElement;
      el.setAttribute("d", item.d);
      if (item.fill) el.setAttribute("fill", colorToCss(item.fillColor));
      else el.setAttribute("fill", "none");
      if (item.stroke) {
        el.setAttribute("stroke", colorToCss(item.strokeColor));
        el.setAttribute("stroke-width", String(item.strokeWidth));
      } else {
        el.setAttribute("stroke", "none");
      }
      if (!item.matrix.isIdentity) el.setAttribute("transform", item.matrix.toSvg());
      g.appendChild(el);
    },
  };
}
