// 五线谱 / 混排的排版器：读谱（`layoutStaff`）→ 排页（`staffpages.ts::layoutStaffPages`）→ 渲染（`mixedVisitor`）。

import { MetaData } from "../smufl/smufl";
import { Group } from "../layout/pageitem";
import { mixedVisitor, renderPageSvg } from "../layout/render";
import type { PagePainter } from "../layout/pagepainter";
import { MixedOptions, StaffLayout, Sys } from "./model";
import { layoutStaff } from "./layout";
import type { ScoreDoc } from "../model/doc";
import { layoutStaffPages, PAGE_HEIGHT_FALLBACK } from "./staffpages";

import type { StyleSheet } from "../style/sheet";
import { applyStaffStyle } from "../style/staff";
import { computeStyleForPaper, THEMES } from "../style/themes";

// -----------------------------------------------------------------------
// MixedPainter。对外契约见 layout/pagepainter.ts::PagePainter（以前只写在这行注释里）。

export class MixedPainter implements PagePainter {
  private score: StaffLayout | null = null;
  private meta: MetaData | null = null;
  private _pages: Group[] = [];
  private _placed: { sys: Sys; page: number; top: number }[] = [];
  /** 隐藏小节号（用户选项）。下次 load 生效。 */
  hideBarNumber = false;
  /** false renders the original staff notation only; true adds the legacy jianpu layer. */
  showJianpuLayer = true;
  /** computed 样式表（主题 `staff`）。下次 load 生效，见 `style/staff.ts`。 */
  style: StyleSheet = computeStyleForPaper([THEMES.staff], { engine: "staff" });
  /** 谱里没写纸时用的那张（pt，编辑器设置；`heightPt` null = 长图）。下次 load 生效，见 `MixedOptions.page`。 */
  page: MixedOptions["page"] = null;

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

  /** PagePainter：用 tenths（MusicXML 的版面单位），调用方只拿它定宽高比。 */
  pageSize(_index: number): { w: number; h: number } {
    return { w: this.pageWidthTenths, h: this.pageHeightTenths };
  }

  /** 排好的版面，连同各系统落在第几页（0 基）、首谱表顶线离页顶多远（tenths）。导出 MusicXML 写版面坐标用（`engrave.ts`）。 */
  get placed(): { score: StaffLayout; systems: readonly { sys: Sys; page: number; top: number }[] } | null {
    return this.score ? { score: this.score, systems: this._placed } : null;
  }

  /** 曲名（首行），导出文件名用。 */
  get title(): string {
    return this.score?.title.split("\n")[0] ?? "";
  }

  /** 读谱并排版（`ScoreDoc` 须是 MusicXML 形状，见 `layout.ts`）。Must be called before renderPage. */
  async load(doc: ScoreDoc): Promise<void> {
    const options = await this._options();
    this._layout(layoutStaff(doc, options));
  }

  private async _options(): Promise<MixedOptions> {
    if (!this.meta) {
      this.meta = await MetaData.shared();
    }
    const options = new MixedOptions(this.meta);
    applyStaffStyle(options, this.style);
    options.hideBarNumber = this.hideBarNumber;
    options.page = this.page;
    return options;
  }

  private _layout(score: StaffLayout): void {
    const r = layoutStaffPages(score, this.showJianpuLayer);
    this.score = score;
    this._placed = r.placed;
    this._pages = r.pages;
  }

  /**
   * Render one page as an SVG element.
   * viewBox is in tenths; consumer can scale via CSS or SVG width/height attrs.
   */
  renderPage(pageIndex: number): SVGSVGElement {
    if (!this.score || pageIndex >= this._pages.length) throw new Error("MixedPainter: not loaded");

    return renderPageSvg(this._pages[pageIndex], this.pageWidthTenths, this.pageHeightTenths, {
      cls: "score-page mixed-page",
      visitor: mixedVisitor,
    });
  }
}
