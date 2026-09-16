// 文本谱原样档那把尺子的适配器：computed `StyleSheet` → `PuMetrics` 的覆盖层。
//
// 文本谱的尺寸是对原版渲染逐项实测的一整套，**不由一个基础字号派生**，所以：
//   - `roles.note.size`（pt）不直接落值，由 `PuPainter.resolveScale` 换成整体缩放
//     （分母是「这套版式含谱面指令时原本多少 pt」）；缺省 = 跟随版式量到的原尺寸；
//   - 谱面自带的 `FontSize:` / `Margin:` 是**乘法**（百分比），不走深合并，仍由 `pu/metrics.ts::applyDocOptions` 叠。
//
// 叠放顺序：metricsFor(方言) → applyDocOptions → applyUserOptions(本文件给的那层)。
// **没有逐字段覆盖层**：原样档照原版实测，`@pu` 块连同 `applyPuOverrides` 已删（零使用者）。
import type { PuUserOptions } from "../pu/metrics";
import type { StyleSheet } from "./sheet";
import { PAPER_SIZES } from "./themes";
import { resolveLength } from "./units";

/** 面板那一层：字号（pt）+ 纸 / 长图。 */
export function puUserOptionsOf(sheet: StyleSheet): PuUserOptions {
  const size = sheet.roles.note?.size;
  const pt = size === undefined ? null : resolveLength(size, { em: NaN, sp: NaN });
  const digitFontSize = pt !== null && Number.isFinite(pt) && pt > 0 ? pt : undefined;
  const paperName = sheet.page.paper;
  const paper = paperName === undefined ? undefined : PAPER_SIZES[paperName];
  if (paper === undefined) return { digitFontSize }; // 没选纸：纸与长图都跟档位自带的
  if (paper === null) return { digitFontSize, continuous: true }; // 长图：纸交给内容定
  return { digitFontSize, pageWidth: paper[0], pageHeight: paper[1], continuous: false };
}
