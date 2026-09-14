// 五线谱 / 混排那把尺子的适配器：computed `StyleSheet` → `MixedOptions`（tenths）。
//
// `musicpp` 预设就是 `MixedOptions` 构造出来的那套 Engraver 常量，这里不重复写。
// MusicXML 自带的 `<scaling>` / `<defaults>` 字体是**曲内覆盖层**，照旧由 `mixed/layout.ts` 读、优先于主题。
//
// `staff.overrides` 的键是 `MixedOptions` 的数值字段，或 `lineWidths.<名>`。
// 单位只收 em / sp：em = SMuFL 字号（= 五线谱高 40 tenths），sp = 线距 10 tenths；
// pt 要等 `<scaling>` 读进来才知道折多少 tenths，选项在那之前就造好了，所以不收。
import type { MixedOptions } from "../mixed/model";
import type { StyleSheet } from "./sheet";
import { resolveLength } from "./units";

export function applyStaffStyle(o: MixedOptions, sheet: StyleSheet): void {
  const ov = sheet.staff.overrides;
  if (!ov) return;
  const em = o.musicFont.size;
  const ctx = { em, sp: em / 4, pt: NaN };
  for (const [k, v] of Object.entries(ov)) {
    const [head, sub] = k.split(".", 2);
    const target = (sub ? (o as unknown as Record<string, unknown>)[head] : o) as Record<string, unknown> | undefined;
    const key = sub ?? head;
    if (!target || typeof target[key] !== "number") {
      console.warn(`样式 staff.overrides.${k}：MixedOptions 没有这个数值字段，忽略`);
      continue;
    }
    const n = resolveLength(v, ctx);
    if (n === null) console.warn(`样式 staff.overrides.${k}：五线谱只收 em / sp，${JSON.stringify(v)} 忽略`);
    else target[key] = n;
  }
}
