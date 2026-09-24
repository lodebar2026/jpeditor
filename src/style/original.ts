// 原样文档布局（`layout/original/`：文本谱、MusicXML、多声部 123/ABC 的原样档）那把尺子的适配器：
// computed `StyleSheet` → `JianpuMetrics`。简谱引擎（`.jpwabc`、单声部 123/ABC）的适配器是 `style/jianpu.ts`，两把尺子不合并。
//
// 这套尺寸是对原版渲染逐项实测的一整套，**不由一个基础字号派生**，所以：
//   - 面板的 `roles.note.size`（pt）不直接落值，由 `layout/original/compose.ts::resolveScale` 换成整体缩放
//     （分母是这套版式含谱面指令时的音符字号 `size.note`）；缺省 = 跟随版式；
//   - 谱面自带的 `FontSize:` / `Margin:` 是**乘法**（百分比），不走深合并，仍由 `layout/original/metrics.ts::applyDocOptions` 叠。
//
// 叠放顺序：出厂 `JIANPU_DEFAULTS` → 内置方言表（`jianpuMetricsOf`）→ applyDocOptions → applyUserOptions（`jianpuUserOptionsOf`）。
import { cloneMetrics, JIANPU_DEFAULTS, type JianpuMetrics, type JianpuUserOptions } from "../layout/original/metrics";
import type { StyleSheet } from "./sheet";
import { familyOfRole } from "./fonts";
import { JIANPU_KEYS } from "./keys";
import { pageMargins, resolvePaper } from "./paper";
import { headerFontsOf } from "./header";
import { resolveLength } from "./units";

/** 面板那一层：字号（pt）+ 纸 / 长图 + 边距。 */
export function jianpuUserOptionsOf(sheet: StyleSheet): JianpuUserOptions {
  const size = sheet.roles.note?.size;
  const pt = size === undefined ? null : resolveLength(size, { em: NaN, sp: NaN });
  const digitFontSize = pt !== null && Number.isFinite(pt) && pt > 0 ? pt : undefined;
  const margins = pageMargins(sheet.page);
  const header = headerFontsOf(sheet);
  const paper = resolvePaper(sheet.page);
  if (paper === undefined) return { digitFontSize, margins, header }; // 没选纸：纸与长图都跟档位自带的
  if (paper === null) return { digitFontSize, margins, header, continuous: true }; // 长图：纸交给内容定
  return { digitFontSize, margins, header, pageWidth: paper.w, pageHeight: paper.h, continuous: false };
}

/**
 * 内置方言表那一层：出厂值之上叠样式表写了的项，没写的保持出厂。
 *   - 字号 `角色 { size }` → `size.<角色>`，字体族 `角色 { family / font }` → `font.<角色>`（键就是角色名）；
 *   - `@jianpu` 里配了 `original` 列的键（`style/keys.ts`）→ 那个路径。长度裸数是 pt，`em` = 音符字号。
 */
export function jianpuMetricsOf(sheet: StyleSheet): JianpuMetrics {
  const m = cloneMetrics(JIANPU_DEFAULTS);
  const sizes = m.size as unknown as Record<string, number | undefined>;
  const fonts = m.font as unknown as Record<string, unknown>;
  for (const [role, decl] of Object.entries(sheet.roles)) {
    if (!decl) continue;
    if (role in sizes && decl.size !== undefined) {
      const pt = resolveLength(decl.size, { em: NaN, sp: NaN });
      if (pt !== null && Number.isFinite(pt)) sizes[role] = pt;
    }
    const f = role in fonts && role !== "noteBold" ? familyOfRole(sheet, role as never) : undefined;
    if (f?.family) fonts[role] = f.family;
  }
  const em = m.size.note;
  for (const [key, v] of Object.entries(sheet.jianpu.overrides ?? {})) {
    const path = JIANPU_KEYS[key]?.original;
    if (!path) continue; // 别的排版器才读的键
    const [group, field] = path.split(".") as [keyof JianpuMetrics, string];
    const val = typeof v === "boolean" ? v : resolveLength(v, { em, sp: em / 3 });
    if (val === null) continue;
    (m[group] as unknown as Record<string, unknown>)[field] = val;
  }
  return m;
}
