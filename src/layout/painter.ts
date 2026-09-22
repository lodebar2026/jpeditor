// Ported from mp/layout/draw.kt (JinpuPainter). Renders the page tree to SVG
// (replacing Skija Canvas drawing) and provides resize/title-page/pick.
//
// `ScorePainter` 是 Layout 这一路排版器共有的那一半（页面、标题页、点选、播放高亮索引）；
// 两个子类：`JinpuPainter`（原样档 / 成书 / 帮助示例）与 `jianpu/expanded.ts::ExpandedPainter`（展开档，两种格式共用）。

import { Point, Rect } from "../common/geom";
import { Lyric, PageItem, findByClass } from "./pageitem";
import { NoteEntry } from "./entry";
import { Layout } from "./layout";
import { emptyScore, type JScore } from "./input";
import type { ElementId } from "../model/doc";
import type { PagePainter } from "./pagepainter";
import { headerPartsOf, renderPageSvg, type HeaderPart } from "./render";
import { layoutOriginalPages } from "./jianpupages";

/** 「原样」档多段歌词叠排时的段间行距 ÷ 歌词字号。原书量到的是 1.3 上下。 */
export const LYRIC_STACK_RATIO = 1.35;

export abstract class ScorePainter implements PagePainter {
  layout: Layout;
  score: JScore = emptyScore();
  pageWidth = 0;
  pageHeight = 0;
  /** PageItem -> rendered <g>, populated each renderPage (for DOM picking). */
  nodeMap = new WeakMap<PageItem, SVGGElement>();
  /** 元素 id → 它的音符格（每遍/每段各一个），试听高亮与起播点用。 */
  private chordItem = new Map<ElementId, { page: number; item: PageItem; verse: number }[]>();
  private highlighted: PageItem | null = null;
  /** 逐页高度。空 = 各页同高（`pageHeight`）；连续长纸那一档按内容逐页给。 */
  protected pageHeights: number[] = [];

  constructor(fontSize: number) {
    this.layout = new Layout(fontSize);
  }

  /** 逐页走一遍页面树，把每个和弦的元素 id 对到它的音符格上。 */
  protected buildChordIndex(): void {
    this.chordItem.clear();
    this.highlighted = null;
    const walk = (item: PageItem, page: number): void => {
      if (item.data instanceof NoteEntry) {
        const id = item.data.chord?.id;
        if (id !== null && id !== undefined) {
          const list = this.chordItem.get(id) ?? [];
          list.push({ page, item, verse: item.data.verse });
          this.chordItem.set(id, list);
        }
      }
      for (const c of item.children) walk(c, page);
    };
    this.layout.pages.forEach((pg, i) => walk(pg, i));
  }

  /** 某个和弦在第几遍的音符格（找不到那一遍就取第一个）。 */
  private hitFor(id: ElementId, pass: number): { page: number; item: PageItem } | null {
    const list = this.chordItem.get(id);
    if (!list || list.length === 0) return null;
    return list.find((h) => h.verse === pass) ?? list[0];
  }

  /** 高亮元素 `id` 第 `pass` 遍的音（先清掉上一个）。返回所在页。 */
  highlightChord(id: ElementId | null, pass = 0): number | null {
    if (this.highlighted) {
      this.nodeMap.get(this.highlighted)?.classList.remove("playing");
      this.highlighted = null;
    }
    if (id === null) return null;
    const hit = this.hitFor(id, pass);
    if (!hit) return null;
    this.nodeMap.get(hit.item)?.classList.add("playing");
    this.highlighted = hit.item;
    return hit.page;
  }

  /** 元素 `id` 第一次出现在第几页（光标同步翻页用）；没画出来为 null。 */
  pageOfChord(id: ElementId): number | null {
    return this.hitFor(id, 0)?.page ?? null;
  }

  /** 元素 `id` 第 `pass` 遍那个音的 `<g>`（滚动到可见用）；没画出来为 null。 */
  chordGroupEl(id: ElementId, pass = 0): SVGGElement | null {
    const hit = this.hitFor(id, pass);
    return hit ? this.nodeMap.get(hit.item) ?? null : null;
  }

  /** 元素 `id` 第 `pass` 遍那个音符格里带类 `cls` 的子项的 `<g>`，按页面树顺序
   *  （可视化编辑选中挂在音符上的记号：和弦名 `chord-group`、装饰 `artic`）。 */
  chordPartEls(id: ElementId, cls: string, pass = 0): SVGGElement[] {
    const hit = this.hitFor(id, pass);
    if (!hit) return [];
    return findByClass(hit.item, cls).flatMap((it) => {
      const el = this.nodeMap.get(it);
      return el ? [el] : [];
    });
  }

  /** 页眉里画出来的东西（标题、署名、调号拍号）：`<g>`、所画的字、是不是调号拍号。可视化编辑按字对回原文字段。 */
  headerParts(): HeaderPart[] {
    return headerPartsOf(this.layout.pages, this.nodeMap);
  }

  /** 元素 `id` 第 `pass` 遍那个音符格里各段歌词的 `<g>` 与段号（`Lyric.verse`）。
   *  展开档的音符格把各段歌词收在同一个 `<g>` 里，点选、高亮要按这个拆开。 */
  lyricEls(id: ElementId, pass = 0): { el: SVGGElement; verse: number }[] {
    const hit = this.hitFor(id, pass);
    if (!hit) return [];
    return findByClass(hit.item, "lyric").flatMap((it) => {
      const el = this.nodeMap.get(it);
      return el ? [{ el, verse: it instanceof Lyric ? it.verse : 0 }] : [];
    });
  }

  // ---------------- SVG rendering ----------------

  /** Render one page group into a standalone <svg> of pageWidth x pageHeight. */
  renderPage(pageIndex: number): SVGSVGElement {
    const { w, h } = this.pageSize(pageIndex);
    return renderPageSvg(this.layout.pages[pageIndex], w, h, this.nodeMap);
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

  /** PagePainter：一般各页同尺寸（resize 给定的纸张）；连续长纸那一档按内容逐页给高。 */
  pageSize(index: number): { w: number; h: number } {
    return { w: this.pageWidth, h: this.pageHeights[index] ?? this.pageHeight };
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

/**
 * `.jpwabc` 的「原样」档与成书（`pdflayout`）、帮助示例、分行度量用的排版器。
 * 排页见 `jianpupages.ts::layoutOriginalPages`；「展开」档另见 `jianpu/expanded.ts::ExpandedPainter`。
 */
export class JinpuPainter extends ScorePainter {
  resize(w: number, h: number, dur: string | null): void {
    this.pageWidth = w;
    this.pageHeight = h;
    this.pageHeights = layoutOriginalPages(this.layout, this.score, w, h, dur);
    this.buildChordIndex();
  }
}
