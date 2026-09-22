// 文本谱「原样」档的旧排版器外壳（退役中，`docs/实现/PuPainter退役.md`）。
// 排版与构图已搬到 `layout/original/compose.ts::layoutOriginalDocument`，这里只剩页面、DOM 与高亮索引，
// 待 App 改走唯一的 `layout/painter.ts::ScorePainter` 后删除。

import { puUserOptionsOf } from "../style/pu";
import type { StyleSheet } from "../style/sheet";
import { PageItem, findByClass } from "../layout/pageitem";
import { type HeaderPart, headerPartsOf, renderPageSvg } from "../layout/render";
import type { PagePainter } from "../layout/pagepainter";
import type { ElementId, ScoreDoc } from "../model/doc";
import type { Group } from "../layout/pageitem";
import type { PlacedPage } from "../layout/original/place";
import { contentWidth, type PuMetrics, type PuUserOptions } from "../layout/original/metrics";
import { baseDigitFontSize, layoutOriginalDocument, type OriginalDocumentLayout } from "../layout/original/compose";

export class PuPainter implements PagePainter {
  /** 与 ScorePainter 同名，便于 buildPptx 等直接取用 */
  layout: { pages: Group[] } = { pages: [] };
  pageWidth = 0;
  pageHeight = 0;
  nodeMap = new WeakMap<PageItem, SVGGElement>();

  private result: OriginalDocumentLayout | null = null;
  private highlighted: PageItem[] = [];
  /** 样式表折出的面板那一层（字号 / 换纸 / 长图），见 `style/pu.ts`。 */
  private userOptions: PuUserOptions | null = null;
  /** 前景色。null = 出厂墨色。 */
  private ink: number | null = null;

  /** 样式表。改完要重排才看得见——调用方通常紧接着 `load`。 */
  setStyle(sheet: StyleSheet | null): void {
    this.userOptions = sheet ? puUserOptionsOf(sheet) : null;
    this.ink = sheet?.page.ink ?? null;
  }

  get metrics(): PuMetrics | null {
    return this.result?.metrics ?? null;
  }

  baseDigitFontSize(doc: ScoreDoc): number {
    return baseDigitFontSize(doc);
  }

  /** PagePainter：连续长图模式下宽高随谱而变，故不是常数。 */
  pageSize(_index: number): { w: number; h: number } {
    return { w: this.pageWidth, h: this.pageHeight };
  }

  get pageCount(): number {
    return this.layout.pages.length;
  }

  /** 排一份文档并生成全部页面。 */
  load(source: ScoreDoc): void {
    const r = layoutOriginalDocument(source, { user: this.userOptions, ink: this.ink });
    this.result = r;
    this.pageWidth = r.width;
    this.pageHeight = r.height;
    this.highlighted = [];
    this.layout.pages = r.pages;
  }

  /** 当前音符数字的字号（pt）。面板上的「基础字号」显示的就是它。 */
  get digitFontSize(): number {
    return this.result?.digitFontSize ?? 0;
  }

  /** 页眉里画出来的东西（标题、署名、调号拍号…）：`<g>`、所画的字、是不是调号拍号。可视化编辑按字对回原文字段。 */
  headerParts(): HeaderPart[] {
    return headerPartsOf(this.layout.pages, this.nodeMap);
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
  highlight(id: ElementId | null, verse = 0): number | null {
    for (const item of this.highlighted) {
      this.nodeMap.get(item)?.classList.remove("playing");
    }
    this.highlighted = [];
    if (id === null) return null;
    const hit = this.result?.noteItems.get(id);
    if (!hit) return null;
    const targets: PageItem[] = [hit.item];
    const sh = this.result?.syllableItems.get(`${id}:${verse}`);
    if (sh) targets.push(sh.item);
    for (const item of targets) {
      this.nodeMap.get(item)?.classList.add("playing");
      this.highlighted.push(item);
    }
    return hit.page;
  }

  /** 按播放顺序列出全部音符的 id（第一声部为主旋律）。 */
  playbackNotes(): ElementId[] {
    const out: ElementId[] = [];
    for (const page of this.result?.placed.pages ?? []) {
      for (const group of page.groups) {
        const voice = group.voices[0];
        if (!voice) continue;
        for (const it of voice.items) {
          const id = it.element.kind === "note" ? this.result?.view.idOf.get(it.element) : undefined;
          if (id !== undefined) out.push(id);
        }
      }
    }
    return out;
  }

  /** 某音符的 SVG 节点（滚动到可视区用）。 */
  noteGroupEl(id: ElementId): SVGGElement | null {
    const hit = this.result?.noteItems.get(id);
    return hit ? (this.nodeMap.get(hit.item) ?? null) : null;
  }

  /** 某音符格里带类 `cls` 的子项的 SVG 节点，按页面树顺序（可视化编辑选中挂载记号：
   *  和弦名 `chord`、注记 `annotation`、`&xx` 记号 `ornament`）。 */
  notePartEls(id: ElementId, cls: string): SVGGElement[] {
    const hit = this.result?.noteItems.get(id);
    if (!hit) return [];
    return findByClass(hit.item, cls).flatMap((it) => {
      const el = this.nodeMap.get(it);
      return el ? [el] : [];
    });
  }

  /** 某音符第 verse 段歌词音节的 SVG 节点（编辑器的双向定位用，见 `editor/sync.ts`）。 */
  syllableGroupEl(id: ElementId, verse = 0): SVGGElement | null {
    const hit = this.result?.syllableItems.get(`${id}:${verse}`);
    return hit ? (this.nodeMap.get(hit.item) ?? null) : null;
  }

  /** 某音符在第几页（双向定位要翻页）。 */
  pageOfNote(id: ElementId): number | null {
    return this.result?.noteItems.get(id)?.page ?? null;
  }

  /** 定位结构（回归脚本核对几何用）。 */
  placedPages(): PlacedPage[] {
    return this.result?.placed.pages ?? [];
  }

  get availableWidth(): number {
    return this.result ? contentWidth(this.result.metrics) : 0;
  }
}
