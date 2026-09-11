// 两种排版输出——`.jpwabc` 与文本谱共用的唯一档位语义。
//
// - expanded（展开）：反复与多段歌词逐遍展开，一段歌词一遍谱、逐遍成页（投影时一屏一段）；
// - original（原样）：按原谱排一遍，多段歌词叠在同一条谱行下，反复不展开（印刷歌本的排法）。
//
// 纸张、字号、配色**不属于这两档的分野**——它们是独立设置项，两档各记各的一套。
// 展开档两种格式共用一个排版器（`jianpu/expanded.ts::ExpandedPainter`，吃 Score）；
// 原样档各排各的（`.jpwabc` 走 `layout/painter.ts::JinpuPainter`，文本谱走 `pu/painter.ts::PuPainter`）。

export type JianpuLayoutMode = "expanded" | "original";

/** 界面上的名字。 */
export const LAYOUT_MODE_LABEL: Readonly<Record<JianpuLayoutMode, string>> = {
  expanded: "展开",
  original: "原样",
};
