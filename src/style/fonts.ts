// 角色 → 一支字。四把尺子与模板排版共用这一份解析，别再各写各的。
//
// 取值顺序（后面的兜前面的）：
//   `font: 名` → `@font-face 名` 的 `family`（可再经 `families` 映射到页面里已注册的 CSS 族）
//   → `family: "…"` 直接给的族
//   → 调用方给的 `base`（尺子自带的出厂字体）
// 字重：角色的 `weight: bold` 或 `@font-face` 的 `bold: true`。
//
// 字号由调用方决定：各尺子的字号口径不同（简谱与成书是 pt、混排是 tenths），
// 角色的 `size` 该怎么折由适配器自己算，这里只在明确传了 `size` 时用。
//
// 无 DOM 依赖。
import { Font } from "../layout/font";
import type { StyleRole, StyleSheet } from "./sheet";

/** `@font-face` 名 → 页面里已注册的 CSS 族（Node 侧读字体文件、`FontFace` 注册后给进来）。 */
export type FamilyMap = Record<string, string>;

/** 角色给的族与字重；角色没写字体就返回 undefined（调用方保留自己的默认）。 */
export function familyOfRole(
  sheet: StyleSheet,
  role: StyleRole,
  families: FamilyMap = {},
): { family: string; bold: boolean } | undefined {
  const decl = sheet.roles[role];
  if (!decl) return undefined;
  const face = decl.font ? sheet.template?.fonts?.[decl.font] : undefined;
  const family = (decl.font ? families[decl.font] : undefined) ?? decl.family ?? face?.family;
  const bold = decl.weight === "bold" || face?.bold === true;
  if (family === undefined) return decl.weight === "bold" ? { family: "", bold } : undefined;
  return { family, bold };
}

/** 角色 → `Font`：族与字重按角色，字号用 `size`（不给就沿用 `base` 的）。 */
export function fontOfRole(
  sheet: StyleSheet,
  role: StyleRole,
  base: Font,
  opts: { size?: number; families?: FamilyMap } = {},
): Font {
  const f = familyOfRole(sheet, role, opts.families);
  const size = opts.size ?? base.size;
  if (!f) return base.size === size ? base : base.makeWithSize(size);
  return new Font(f.family || base.family, size, f.bold || base.bold, base.italic);
}
