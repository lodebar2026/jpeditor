// 两种排版输出——`.jpwabc` 与文本谱共用的唯一档位语义。
//
// - expanded（展开）：反复与多段歌词逐遍展开，一段歌词一遍谱、逐遍成页（投影时一屏一段）；
// - original（原样）：按原谱排一遍，多段歌词叠在同一条谱行下，反复不展开（印刷歌本的排法）。
//
// 纸张、字号、配色**不属于这两档的分野**——它们是独立设置项，两档各记各的一套。
// 展开档两种格式共用一个排版器（`layout/painter.ts::ScorePainter`，吃简谱引擎输入）；
// 原样档各排各的（`.jpwabc` 同走 `ScorePainter`，文本谱走退役中的 `pu/painter.ts::PuPainter`）。

export type JianpuLayoutMode = "expanded" | "original";

/** `.jpwabc` 当前的排版输出档名（`pptx` = 展开、`normal` = 原样；名字沿用存量设置）。 */
export type JpProfileName = "normal" | "pptx";

/** 界面上的名字。 */
export const LAYOUT_MODE_LABEL: Readonly<Record<JianpuLayoutMode, string>> = {
  expanded: "展开",
  original: "原样",
};
