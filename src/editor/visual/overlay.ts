// 可视化编辑在**谱面**的那一半：叠在页面 SVG 上的一层（插入光标、编辑方块、换行符号）。
//
// **不重排版**：只在已渲染好的页面上按元素 `<g>` 的包围盒另画一层，高亮沿用 `.cursor-at` 的 CSS 类。
// 每次重排页面节点全换，叠加层跟着 `VisualEditController.refresh()` 重画。

const SVG_NS = "http://www.w3.org/2000/svg";
const LAYER_CLASS = "vis-overlay";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 元素在它所在页面 SVG 用户坐标里的包围盒（含各级 transform）。没挂在页面上时为 null。 */
export function boxInPage(el: SVGGraphicsElement): { svg: SVGSVGElement; box: Box } | null {
  const svg = el.ownerSVGElement;
  if (!svg) return null;
  let bb: DOMRect;
  try {
    bb = el.getBBox();
  } catch {
    return null; // 没进文档（display:none 的页）
  }
  const m = svg.getScreenCTM()?.inverse().multiply(el.getScreenCTM() ?? new DOMMatrix());
  if (!m) return null;
  const pts = [
    new DOMPoint(bb.x, bb.y), new DOMPoint(bb.x + bb.width, bb.y),
    new DOMPoint(bb.x, bb.y + bb.height), new DOMPoint(bb.x + bb.width, bb.y + bb.height),
  ].map((p) => p.matrixTransform(m));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { svg, box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } };
}

/** 音符 `<g>` 里**音乐那一部分**的包围盒：简谱引擎的音符格把各段歌词也收在同一个 `<g>` 里
 *  （第一个子节点是数字，后面是逐段歌词），整格的包围盒会一直拖到最后一段词。
 *  这里以第一个子节点（数字）为准，只并进顶端落在数字框之内的子节点（八度点、增时线、减时线）；
 *  文字框本身带行距，第一段歌词的顶恰好贴着数字框的底（实测差 0.4），所以界线取在框底往上 5%。
 *  没有子节点时就是整个 `<g>`。 */
export function musicBox(el: SVGGraphicsElement): { svg: SVGSVGElement; box: Box } | null {
  const kids = [...el.children].filter((c): c is SVGGraphicsElement => c instanceof SVGGraphicsElement);
  const whole = boxInPage(el);
  if (kids.length < 2 || !whole) return whole;
  const anchor = boxInPage(kids[0]!);
  if (!anchor || anchor.box.h <= 0) return whole;
  const limit = anchor.box.y + anchor.box.h * 0.95;
  let box = anchor.box;
  for (const k of kids.slice(1)) {
    const b = boxInPage(k);
    if (!b || b.box.h <= 0 || b.box.y > limit) continue;
    const x = Math.min(box.x, b.box.x);
    const y = Math.min(box.y, b.box.y);
    box = { x, y, w: Math.max(box.x + box.w, b.box.x + b.box.w) - x, h: Math.max(box.y + box.h, b.box.y + b.box.h) - y };
  }
  return { svg: anchor.svg, box };
}

/** 页面上一带（纵向区间）里实际画出的东西最右到哪。换行符要画在整行最后一个符号后面，
 *  而行末的增时线、小节线不一定收在宿主音符的 `<g>` 里，只好按页面上的叶子图元量。
 *  `cache` 由调用方按页复用（一次刷新里同一页只量一遍）。 */
export function rightEdgeInBand(svg: SVGSVGElement, band: Box, cache: Map<SVGSVGElement, Box[]>): number {
  let leaves = cache.get(svg);
  if (!leaves) {
    leaves = [];
    const inv = svg.getScreenCTM()?.inverse();
    if (inv) {
      for (const n of svg.querySelectorAll<SVGGraphicsElement>("text, line, path, polyline, polygon, use, rect")) {
        if (n.closest(`.${LAYER_CLASS}`)) continue;
        const r = n.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const a = new DOMPoint(r.left, r.top).matrixTransform(inv);
        const b = new DOMPoint(r.right, r.bottom).matrixTransform(inv);
        leaves.push({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
      }
    }
    cache.set(svg, leaves);
  }
  let right = band.x + band.w;
  const top = band.y;
  const bottom = band.y + band.h;
  for (const l of leaves) {
    // 整页大的（背景、页框）不算；只看与这一带纵向重叠过半的
    if (l.h > band.h * 3) continue;
    const overlap = Math.min(bottom, l.y + l.h) - Math.max(top, l.y);
    if (overlap < Math.min(l.h, band.h) * 0.5) continue;
    right = Math.max(right, l.x + l.w);
  }
  return right;
}

/** 两个盒子是不是同一行谱（纵向重叠过半）。 */
export function sameRow(a: Box, b: Box): boolean {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap > Math.min(a.h, b.h) * 0.5;
}

/** 某页的叠加层（没有就建一个，放在最上面）。 */
function layerOf(svg: SVGSVGElement): SVGGElement {
  let g = svg.querySelector<SVGGElement>(`:scope > g.${LAYER_CLASS}`);
  if (!g) {
    g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", LAYER_CLASS);
    svg.appendChild(g);
  }
  return g;
}

/** 清掉这些页上叠加层里某一类的东西（`kind` 缺省 = 全清）；`keep` 这一类留着不动。 */
export function clearOverlay(svgs: Iterable<SVGSVGElement>, kind?: string, keep?: string): void {
  for (const svg of svgs) {
    const g = svg.querySelector<SVGGElement>(`:scope > g.${LAYER_CLASS}`);
    if (!g) continue;
    if (kind === undefined && keep === undefined) {
      g.replaceChildren();
      delete g.dataset.beats;
    } else {
      for (const el of [...g.children]) {
        if (kind !== undefined && !el.classList.contains(kind)) continue;
        if (keep !== undefined && el.classList.contains(keep)) continue;
        el.remove();
      }
    }
  }
}

/** 一页上拍数不对的红框整组换新。与上次画的一样就不动——焦点一进谱面就会重画叠加层，
 *  若把按下鼠标时点中的红框换掉，这一下点击就丢了（`click` 要求按下与抬起落在同一节点上）。 */
export function setBeatIssues(svg: SVGSVGElement, items: readonly { box: Box; title: string }[]): void {
  const layer = layerOf(svg);
  const sig = JSON.stringify(items.map((i) => [i.box.x, i.box.y, i.box.w, i.box.h, i.title].map((v) => (typeof v === "number" ? Math.round(v * 10) : v))));
  if (layer.dataset.beats === sig) return;
  layer.dataset.beats = sig;
  for (const el of [...layer.querySelectorAll(".vis-beat")]) el.remove();
  for (const i of items) drawBeatIssue(svg, i.box, i.title);
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** 插入光标：一条竖线。 */
export function drawCaret(svg: SVGSVGElement, x: number, box: Box): void {
  const pad = box.h * 0.15;
  layerOf(svg).appendChild(el("line", {
    class: "vis-caret",
    x1: x, x2: x, y1: box.y - pad, y2: box.y + box.h + pad,
    "stroke-width": Math.max(1, box.h * 0.06),
  }));
}

/** 编辑方块：罩住选中的元素。 */
export function drawBlock(svg: SVGSVGElement, box: Box): void {
  const pad = box.h * 0.12;
  layerOf(svg).appendChild(el("rect", {
    class: "vis-block",
    x: box.x - pad, y: box.y - pad, width: box.w + pad * 2, height: box.h + pad * 2,
    rx: pad, "stroke-width": Math.max(1, box.h * 0.04),
  }));
}

/** 拍数对不上的小节：淡红底，悬停显示说明。 */
function drawBeatIssue(svg: SVGSVGElement, box: Box, title: string): void {
  const pad = box.h * 0.2;
  const r = el("rect", {
    class: "vis-beat",
    x: box.x - pad, y: box.y - pad, width: box.w + pad * 2, height: box.h + pad * 2, rx: pad,
  });
  const t = document.createElementNS(SVG_NS, "title");
  t.textContent = title;
  r.appendChild(t);
  // 垫在叠加层最底下，不挡光标与方块；点击由 `hitThroughOverlay` 透过它落到音符上
  const layer = layerOf(svg);
  layer.insertBefore(r, layer.firstChild);
}

/** 事件点中的谱面元素，透过拍数不对的红框（红框要接 hover 显示说明，点击却该落到框里的音符上）。 */
export function hitThroughOverlay(ev: MouseEvent): EventTarget | null {
  const t = ev.target;
  if (!(t instanceof Element) || !t.closest(".vis-beat")) return t;
  return document.elementsFromPoint(ev.clientX, ev.clientY).find((e) => !e.closest(`.${LAYER_CLASS}`)) ?? t;
}

/** 换行 `↵` / 换页 `⤓` 符号，画在 `x` 处、`after`（行末元素）那一带的中线上。返回画出的节点（供挂点击）。 */
export function drawBreak(svg: SVGSVGElement, x0: number, after: Box, page: boolean, selected: boolean): SVGGElement {
  const size = Math.max(8, after.h * 0.6);
  const g = el("g", { class: `vis-break${selected ? " vis-break-selected" : ""}` });
  const x = x0 + size * 0.3;
  const y = after.y + after.h / 2;
  // 点击区比字形大一圈，好点中
  g.appendChild(el("rect", { class: "vis-break-hit", x: x - size * 0.1, y: y - size * 0.6, width: size * 1.2, height: size * 1.2, rx: size * 0.15 }));
  const t = el("text", { x, y: y + size * 0.35, "font-size": size });
  t.textContent = page ? "⤓" : "↵";
  g.appendChild(t);
  layerOf(svg).appendChild(g);
  return g;
}
