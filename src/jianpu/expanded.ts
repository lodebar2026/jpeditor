// 「展开」档的排版器——`.jpwabc` 与文本谱共用同一个。
//
// 输入只有一份 `Score`（`.jpwabc` 经 `score/jpwimport.ts`、文本谱经 `pu/toscore.ts` 转来——
// **格式只是数据来源**）与展开档的那几项设置（`ExpandedOptions`），排成投影 / PPTX 那一套观感：
// 反复与多段歌词逐遍展开（`Layout.fromScore` 走 `playData`，换页口径在 `jianpu/expand.ts::walkPlay`）、
// 笔画常量取 `layout/pptxstyle.ts::applyPptxStyle`、第一页是独立的标题词曲页、其后每页有页脚曲名 + 「i/n」页码。
//
// 和弦符号进不了 Score、首调号拍号展开档本来就不画，所以文本谱转过来天然没有这两样，这里不写特判。

import type { MetaData } from "../smufl/smufl";
import type { Score } from "../score/score";
import { TextFrame, type Group } from "../layout/layout";
import { applyPptxStyle } from "../layout/pptxstyle";
import { ScorePainter } from "../layout/painter";

/** 展开档的设置（pt，1 排版单位 = 1pt，导出 PPTX 要的就是它）。
 *  App 只组一处（`App.expandedOptions`），两种格式、屏幕预览与导出 PPTX 都吃这一份。 */
export interface ExpandedOptions {
  /** 投影片尺寸（`PAGE_RATIOS` 那几张） */
  pageW: number;
  pageH: number;
  /** 基础字号：音符数字与歌词同大 */
  fontSize: number;
  titleSize: number;
  creditSize: number;
  color: number;
  smuflMeta?: MetaData;
}

export class ExpandedPainter extends ScorePainter {
  constructor(readonly settings: ExpandedOptions) {
    super(settings.fontSize);
    const opt = this.layout.options;
    if (settings.smuflMeta) opt.smuflMeta = settings.smuflMeta;
    opt.color = settings.color;
    opt.titleSize = settings.titleSize;
    opt.creditSize = settings.creditSize;
    // 笔画常量最后灌，覆盖在上面几项之上（契约见 applyPptxStyle）
    applyPptxStyle(opt);
    this.pageWidth = settings.pageW;
    this.pageHeight = settings.pageH;
  }

  /** 排一份 Score。`breakDesc` 是 `.jpwabc` 的 `.Layout` 分页描述（文本谱没有）。 */
  load(score: Score, breakDesc: string | null = null): void {
    const { pageW: w, pageH: h } = this.settings;
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
    const { pageW: w, pageH: h } = this.settings;
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
