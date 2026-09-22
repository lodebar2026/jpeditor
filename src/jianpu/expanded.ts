// 「展开」档的排版器——`.jpwabc` 与文本谱共用同一个。
//
// 输入只有一份引擎输入（`layout/input.ts`，由 `model/jianpuinput.ts` 从 `ScoreDoc` 投影——
// **格式只是数据来源**）与展开档的那几项设置（`ExpandedOptions`），排成投影 / PPTX 那一套观感：
// 反复与多段歌词逐遍展开（`Layout.fromScore` 走 `playData`，换页口径在 `jianpu/expand.ts::walkPlay`）、
// 字号、纸与笔画常量取样式表（`style/jianpu.ts` 的 `pptx` 预设，主题 `projection`）、第一页是独立的标题词曲页、其后每页有页脚曲名 + 「i/n」页码。
//
// 简谱形状的投影不带和弦符号、首调号拍号展开档本来就不画，所以文本谱转过来天然没有这两样，这里不写特判。

import type { MetaData } from "../smufl/smufl";
import type { JScore } from "../layout/input";
import { layoutExpandedPages } from "../layout/jianpupages";
import { applyJianpuStyle, jianpuFontSize } from "../style/jianpu";
import type { StyleSheet } from "../style/sheet";
import { ScorePainter } from "../layout/painter";

/** 展开档的设置。App 只组一处（`App.expandedOptions`），两种格式、屏幕预览与导出 PPTX 都吃这一份。 */
export interface ExpandedOptions {
  /** computed 样式表（主题 `projection` + 用户层）。投影片尺寸在 `page.w/h`（pt，1 排版单位 = 1pt）。 */
  style: StyleSheet;
  smuflMeta?: MetaData;
}

export class ExpandedPainter extends ScorePainter {
  constructor(readonly settings: ExpandedOptions) {
    super(jianpuFontSize(settings.style));
    const opt = this.layout.options;
    if (settings.smuflMeta) opt.smuflMeta = settings.smuflMeta;
    applyJianpuStyle(opt, settings.style);
    this.pageWidth = settings.style.page.w ?? 960;
    this.pageHeight = settings.style.page.h ?? 540;
  }

  /** 排一份引擎输入。`breakDesc` 是 `.jpwabc` 的 `.Layout` 分页描述（文本谱没有）。 */
  load(score: JScore, breakDesc: string | null = null): void {
    this.score = score;
    layoutExpandedPages(this.layout, score, this.pageWidth, this.pageHeight, breakDesc);
    this.buildChordIndex();
  }
}
