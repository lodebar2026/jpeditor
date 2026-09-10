// 两种格式（`.jpwabc` / 文本谱）排版器的公共基类。
//
// 两边的**行内**排版规则不同（`.jpwabc` 自动断行、文本谱一行 `Q:` 一行，各有各的引擎），
// 但「排版输出」这一层是同一件事：同一对档位（展开 / 原样，见 profile.ts）、同一个纵向分页器
// （vertical.ts）、同一套版面家具——展开档独占第一页的标题页、每页的页脚曲名与「i/n」页码。
// 这些只在这里写一次。
//
// **高亮与标题页的内容不进基类**：高亮语义两边不同（Chord + 遍次 / AST 音符 + 段），
// 标题页的来源也不同（`Score.credit` / `Metadata`）——基类只管「有没有、放哪」。

import { Group, TextFrame } from "../layout/layout";
import type { Font } from "../layout/font";
import type { PagePainter } from "../layout/pagepainter";
import type { JianpuLayoutMode } from "./profile";

/** 页脚要的几何。坐标都是**纸上的绝对坐标**，由基类换算回页组自己的坐标系。 */
export interface FooterSpec {
  title: string;
  font: Font;
  color: number;
  pageWidth: number;
  pageHeight: number;
  marginBottom: number;
  marginRight: number;
  /** 页组坐标原点在纸上的 x（`.jpwabc` 是左边距；文本谱是整页平移量） */
  originX: number;
  /** 曲名在 [titleLeft, titleLeft + titleWidth] 这一段里居中 */
  titleLeft: number;
  titleWidth: number;
  /**
   * 页码左缘的锚点：`页组原点 + 0.8 × 纸宽`（两条路一贯的落点；`.jpwabc` 那一路的原点在左边距上，
   * 16:9 纸上即 50 + 768 = 818）。**放不下时向左收回到版心右缘以内**——4:3 纸配大字号时
   * 「24/24」会伸出纸外。
   */
  pageNoAnchor: number;
  /** 多字文本按 CLREQ 挤压标点（文本谱的 `text()` 一贯如此；`.jpwabc` 的页脚从来不挤，保持原样） */
  compress?: boolean;
}

export abstract class JianpuPainter implements PagePainter {
  protected mode: JianpuLayoutMode;

  constructor(mode: JianpuLayoutMode) {
    this.mode = mode;
  }

  /** 当前的排版输出。 */
  get layoutMode(): JianpuLayoutMode {
    return this.mode;
  }

  /** 展开档：逐遍成页、另起标题页、每页有页脚。 */
  get expanded(): boolean {
    return this.mode === "expanded";
  }

  abstract readonly pageCount: number;
  abstract pageSize(index: number): { w: number; h: number };
  abstract renderPage(index: number): SVGSVGElement;

  /**
   * 展开档的页脚：曲名居中 + 「i/n」页码。原样档是印刷歌本的排法，没有页眉页脚，调用方不调。
   * **页码不含标题页**——要在 `prependTitlePage` 之前调。
   */
  protected addFooters(pages: readonly Group[], spec: FooterSpec): void {
    const n = pages.length;
    const title = spec.title.split("\n")[0] ?? "";
    pages.forEach((pg, i) => {
      // 页脚是纸上坐标，而 `Group.update` 会把子项归一化、把偏移收进 pg.y——减掉它才落对位置
      const y = spec.pageHeight - spec.marginBottom * 0.5 - pg.y;
      if (title) {
        const tf = footerText(title, spec);
        tf.x = spec.titleLeft + (spec.titleWidth - tf.measureText()) / 2 - spec.originX;
        tf.y = y;
        tf.update();
        pg.add(tf);
      }
      const no = footerText(`${i + 1}/${n}`, spec);
      const w = no.measureText();
      no.x = Math.min(spec.pageNoAnchor, spec.pageWidth - spec.marginRight - w) - spec.originX;
      no.y = y;
      no.update();
      pg.add(no);
    });
  }

  /** 展开档：标题与词曲独占第一页（同 PPT 投影的习惯，第一屏是歌名）。 */
  protected prependTitlePage(pages: Group[], titlePage: Group): void {
    titlePage.update();
    pages.unshift(titlePage);
  }
}

function footerText(text: string, spec: FooterSpec): TextFrame {
  const tf = new TextFrame();
  tf.font = spec.font;
  tf.text = text;
  tf.color = spec.color;
  if (spec.compress && [...text].length > 1) tf.charXs = spec.font.run(text).xs;
  return tf;
}
