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
import { TextFrame, type Group } from "../layout/pageitem";
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
    const { pageWidth: w, pageHeight: h } = this;
    this.score = score;
    this.layout.fromScore(score, breakDesc, w, h);
    // 页码不含标题页：页脚要在标题页插进来之前加
    this.addFooters(this.layout.pages);
    const title = this.titlePage(w, h);
    title.update();
    this.layout.pages.unshift(title);
    for (const p of this.layout.pages) p.update();
    this.buildChordIndex();
  }

  /**
   * 每页的页脚：曲名在版心里居中 + 「i/n」页码。页码左缘落在 `左边距 + 0.8 × 纸宽`
   * （16:9 纸上即 50 + 768 = 818），**放不下时向左收回到版心右缘以内**——4:3 纸配大字号时
   * 「24/24」会伸出纸外。
   */
  private addFooters(pages: readonly Group[]): void {
    const opt = this.layout.options;
    const { pageWidth: w, pageHeight: h } = this;
    const font = opt.lrcFont.scaled(0.8);
    const title = this.score.title.split("\n")[0] ?? "";
    const n = pages.length;
    const text = (s: string): TextFrame => {
      const tf = new TextFrame();
      tf.font = font;
      tf.text = s;
      tf.color = opt.color;
      return tf;
    };
    pages.forEach((pg, i) => {
      // 页组已由 fromScore 右移一个左边距（原点在版心左缘），且 `Group.update` 把纵向偏移收进了 pg.y
      // ——纸上坐标都要减掉这两样才落对位置
      const y = h - opt.marginBottom * 0.5 - pg.y;
      if (title) {
        const tf = text(title);
        tf.x = (w - opt.marginLeft - opt.marginRight - tf.measureText()) / 2;
        tf.y = y;
        tf.update();
        pg.add(tf);
      }
      const no = text(`${i + 1}/${n}`);
      no.x = Math.min(opt.marginLeft + 0.8 * w, w - opt.marginRight - no.measureText()) - opt.marginLeft;
      no.y = y;
      no.update();
      pg.add(no);
    });
  }
}
