// 「PPT 版面」档：投影/导出 .pptx 用的那一档，编辑器的**默认档**。
//
// 底子是 2026-08 那次排版重构**之前**的观感（下面 `2a8aa85` 那一段），
// 但已有几处**刻意背离**，都写在各自的赋值旁边：小节线的上下缘改用简谱档那一份
// （老档矮三分之一，投影上看不出是小节线）、拍号比例跟着回默认、
// 附点/高音点/低音点三种点统一成同一个半径。回归在 `pptx-check.mjs`。
//
// 为什么要有这一档：`editor/pptx.ts` 只是序列化器——它把排版好的页面树 1:1 翻成 OOXML
// （1 排版单位 = 1pt），本身没有任何排版参数。于是谱面观感一改，导出的 .pptx 跟着改。
//
// 与「简谱」档的另一处分工不在这里，而在 `editor/app.ts::_rebuildPainter`：
// **PPT 档逐段展开**（一段歌词一遍谱、一屏一段），简谱档 `lyricStack > 0`
// **按原谱排一遍**、多段歌词叠在同一条谱行下。
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

  // **小节线的上下缘不再覆写**（用户口径：「PPT 模式的小节线有点短，用简谱模式的高度」）。
  // 老 PPT 档是 −23/28 em 与 +5/28 em（合起来正好 1 em），比今天的 −1 em / +1/3 em
  // （合起来 4/3 em）矮三分之一；投影上那截线短得不像小节线。于是 H 回到 4/3 em，
  // 下面的拍号比例也跟着**回默认**——`TIME_SIG_DEFAULTS` 正好是老那四个数的 3/4
  // （0.75/0.1/0.625/0.375 × 3/4 = 0.5625/0.075/0.46875/0.28125），
  // 拍号画出来与老档一模一样，只有小节线变高了。

  // 小节线细线 1.5（今 2）；终止线的粗线 3.5 两版相同，写出来是为了这一档自洽。
  opt.barlineWidth = 1.5;
  opt.finalBarlineWidth = 3.5;

  // 减时线：线宽 1.25（今 1.5）。基准 y 取 jpBeamDist，于是
  // 今天的 `jpBeamTop + jpBeamDist*(lev−1)` 退化成旧式的 `jpBeamDist * lev`（lev 1 基）。
  opt.jpBeamWidth = 1.25;
  opt.jpBeamTop = opt.jpBeamDist;

  // 拍号只留分数线粗细（比例走默认，见上面小节线那一段）。
  opt.timeSigRuleWidth = 1.5;

  // **附点 / 高音点 / 低音点三者同大**（用户口径）。默认两者各按自己那个字形的墨迹高折半
  // （附点照 `·` 是 ⌀4.06 @28pt、八度点照 `.` 是 ⌀3.44），附点明显更胖。
  // 这一档取两者之间的一个整数比例：⌀2r = em/7.5，附点缩一点、八度点放一点。
  opt.octaveDotRadius = em / 15;
  opt.augDotRadius = em / 15;

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
