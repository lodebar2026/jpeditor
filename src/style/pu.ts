// 文本谱原样档那把尺子的适配器：computed `StyleSheet` → `PuMetrics` 的覆盖层。
//
// 文本谱的尺寸是对原版渲染逐项实测的一整套，**不由一个基础字号派生**，所以：
//   - `roles.note.size`（pt）不直接落值，由 `PuPainter.resolveScale` 换成整体缩放
//     （分母是「这套版式含谱面指令时原本多少 pt」）；缺省 = 跟随版式量到的原尺寸；
//   - 谱面自带的 `FontSize:` / `Margin:` 是**乘法**（百分比），不走深合并，仍由 `pu/metrics.ts::applyDocOptions` 叠；
//   - `pu.overrides` 叠在方言修正之后、谱面指令之前（谱面说了算的仍说了算）。
//
// 叠放顺序：metricsFor(方言) → pu.overrides → applyDocOptions → applyUserOptions(本文件给的那层)。
import type { PuMetrics, PuUserOptions } from "../pu/metrics";
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

/** `pu.overrides`：键是 `PuMetrics` 的数值字段。em = 音符数字字号（`emOf` 给，要量字体），
 *  sp = 名义谱高 / 4（文本谱的名义谱高取方言量到的小节线高）。无覆盖时原样返回入参。 */
export function applyPuOverrides(m: PuMetrics, sheet: StyleSheet, emOf: (m: PuMetrics) => number): PuMetrics {
  const ov = sheet.pu.overrides;
  if (!ov || Object.keys(ov).length === 0) return m;
  const ctx = { em: emOf(m), sp: m.barlineHeight / 4 };
  const out = { ...m };
  const rec = out as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(ov)) {
    if (typeof rec[k] !== "number") {
      console.warn(`样式 pu.overrides.${k}：PuMetrics 没有这个数值字段，忽略`);
      continue;
    }
    const n = resolveLength(v, ctx);
    if (n === null) console.warn(`样式 pu.overrides.${k}：认不出的长度 ${JSON.stringify(v)}，忽略`);
    else rec[k] = n;
  }
  return out;
}
