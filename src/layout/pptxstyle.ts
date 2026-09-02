// 「PPT 版面」档：把简谱排版选项覆写回 2026-08 那次排版重构**之前**的观感。
//
// 为什么要有这一档：`editor/pptx.ts` 只是序列化器——它把排版好的页面树 1:1 翻成 OOXML
// （1 排版单位 = 1pt），本身没有任何排版参数。于是谱面观感一改，导出的 .pptx 跟着改。
// 用户要的是老 PPT 的样子，同时屏幕上的默认档保持现在的样子，所以做成一档覆写。
//
// 基准是 `2a8aa85`（「新增 MusicXML 导出」，即观感大改 `29ae9dd` 的父提交）。
// 不取更早的 `9abacb3`（PPTX 导出刚落地那次）是因为两者的**笔画与尺寸完全相同**
// （`git diff 9abacb3 2a8aa85 -- src/layout/` 只有 verse 索引、播放高亮、弱起装载、
// titleSize/creditSize 提成字段这些），而 `2a8aa85` 里已经带上了 `a6a6013` 对 pptx.ts
// 本身的三处修复（字体栈压成单个 DrawingML typeface、noAutofit、无条件给 <a:ea>）。
//
// 契约与 `pdflayout/browser.ts::applyBookStyle` 相同：**在 painter 构造之后、resize 之前调**。
// 只改常量的来源，不动 layout.ts 的算法——`jpDotRung` / `jpStaffTop` 那些都是 getter，
// 覆写字段就全局生效。
//
// **不覆写字体与页面尺寸**：字号、纸张、标题/词曲字号仍由选项面板（`editor/settings.ts`）
// 说了算，这里只固定那些本来就没有 UI 的**笔画类**常量。老的出厂默认值见 PPTX_PAGE。

import type { LayoutOptions } from "./layout";

/** 简谱的版面档。与文本谱的 `PageProfileName`（print/slide）平行，但两者管的东西不同：
 *  那个换的是整套 metrics（页面尺寸都变），这个只换笔画常量。 */
export type JpProfileName = "normal" | "pptx";

/** 老版那几个「出厂默认」。选项面板照常可改，这里只是记下当年的值。 */
export const PPTX_PAGE = { w: 960, h: 540, fontSize: 28, titleSize: 48, creditSize: 36 } as const;

/** 把 PPT 档的笔画常量灌进排版选项。painter 构造之后、resize 之前调。 */
export function applyPptxStyle(opt: LayoutOptions): void {
  const em = opt.numberSize;

  // 纵向堆叠回到旧式三套步长（数字↔点、点↔弧、三连音各走各的）。见 jpGridLegacy 的注释。
  opt.jpGridLegacy = true;

  // 小节线与拍号的上下缘：旧版是 −23/28 em 与 +5/28 em（合起来正好 1 em），
  // 今天是 −1 em 与 +1/3 em（合起来 4/3 em，高出三分之一）。
  opt.jpStaffTopOverride = (-em * 23) / 28;
  opt.jpStaffBottomOverride = (em * 5) / 28;

  // 小节线细线 1.5（今 2）；终止线的粗线 3.5 两版相同，写出来是为了这一档自洽。
  opt.barlineWidth = 1.5;
  opt.finalBarlineWidth = 3.5;

  // 减时线：线宽 1.25（今 1.5）。基准 y 取 jpBeamDist，于是
  // 今天的 `jpBeamTop + jpBeamDist*(lev−1)` 退化成旧式的 `jpBeamDist * lev`（lev 1 基）。
  opt.jpBeamWidth = 1.25;
  opt.jpBeamTop = opt.jpBeamDist;

  // 拍号：旧观感是字号 0.75 em、上数字 −0.1 em、下数字 +0.625 em、分数线长按数字实测宽。
  // jpTimeSigItems 的比例基准是小节线高度 H，这一档的 H = em（见上），所以比例即是 em 的倍数。
  // 分数线 0.375 em = PingFang 数字在 0.75 em 字号下的 advance（旧版取 measureText）。
  opt.timeSigDigitRatio = 0.75;
  opt.timeSigUpperRatio = 0.1;
  opt.timeSigLowerRatio = 0.625;
  opt.timeSigRuleLenRatio = 0.375;
  opt.timeSigRuleWidth = 1.5;

  // 弧线：旧版厚 4、无描边，且没有高度上下限、没有扁平长连音线——
  // 一律退化成 musicpp 的裸对数公式。
  opt.slurTieThickness = 4;
  opt.slurOutlineWidth = 0;
  opt.slurMaxHeight = 0;
  opt.slurMinHeight = 0;
  opt.slurFlatSpan = -1;
  opt.slurFlatNotes = 0;
  opt.slurFlatRatio = 0;
}
