// 五线谱 / 混排那把尺子的适配器：computed `StyleSheet` → `MixedOptions`（tenths）。
//
// `musicpp` 预设就是 `MixedOptions` 构造出来的那套 Engraver 常量，这里不重复写。
// MusicXML 自带的 `<scaling>` / `<defaults>` 字体是**曲内覆盖层**，照旧由 `mixed/layout.ts` 读、优先于主题。
//
// 吃两个块：`@staff`（五线谱内容）与 `@jianpu`（简谱内容——混排的简谱层也在这把尺子上），
// 键是 `style/keys.ts` 的逻辑键，内部字段名不外露。字体走角色（`ROLE_FONTS`）。
//
// 顺序要紧：**先落字体，再取 em**——`em` 就是 `musicFont` 的字号，换了字号基准跟着变。
// 单位只收 em / sp：em = SMuFL 字号（= 五线谱高 40 tenths），sp = 线距 10 tenths；
// pt 要等 `<scaling>` 读进来才知道折多少 tenths，选项在那之前就造好了，所以不收。
import type { MixedOptions } from "../mixed/model";
import { fontOfRole, familyOfRole } from "./fonts";
import { JIANPU_KEYS, ROLE_FONTS, STAFF_KEYS, type KeyDef } from "./keys";
import type { StyleSheet } from "./sheet";
import { resolveLength } from "./units";
import { headerFontsOf } from "./header";

export function applyStaffStyle(o: MixedOptions, sheet: StyleSheet): void {
  applyFonts(o, sheet);
  o.headerFonts = headerFontsOf(sheet);
  const em = o.musicFont.size;
  const ctx = { em, sp: em / 4, pt: NaN };
  applyOverrides(o, sheet.staff.overrides, STAFF_KEYS, "staff", ctx);
  applyOverrides(o, sheet.jianpu.overrides, JIANPU_KEYS, "jianpu", ctx);
}

/** 角色 → 字体字段：`smufl` → `musicFont`、`note` → `jianpuFont`、`chord` → `wordFont`（只要族名）。
 *  `mixFont` 是 `jianpuFont` 与 `mixStaffHeight` 的派生量（见 `mixed/model.ts`），不单独设。 */
function applyFonts(o: MixedOptions, sheet: StyleSheet): void {
  const rec = o as unknown as Record<string, unknown>;
  for (const [role, def] of Object.entries(ROLE_FONTS)) {
    const field = def.mixed;
    if (!field || !sheet.roles[role as keyof StyleSheet["roles"]]) continue;
    if (def.mixedFamilyOnly) {
      const f = familyOfRole(sheet, role as keyof StyleSheet["roles"]);
      if (f?.family) rec[field] = f.family;
      continue;
    }
    const base = rec[field];
    if (base instanceof Object && "family" in base) {
      rec[field] = fontOfRole(sheet, role as keyof StyleSheet["roles"], base as never, {
        size: sizeOf(sheet, role as keyof StyleSheet["roles"]),
      });
    }
  }
}

/** 角色字号。五线谱这一路的字号是 tenths，只收裸数字与 em/sp（em 相对角色自己没有意义，故按 40 的出厂基准折）。 */
function sizeOf(sheet: StyleSheet, role: keyof StyleSheet["roles"]): number | undefined {
  const v = sheet.roles[role]?.size;
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : resolveLength(v, { em: 40, sp: 10, pt: NaN });
  return n !== null && Number.isFinite(n) && n > 0 ? n : undefined;
}

function applyOverrides(
  o: MixedOptions,
  ov: Record<string, unknown> | undefined,
  table: Record<string, KeyDef>,
  block: string,
  ctx: { em: number; sp: number; pt: number },
): void {
  if (!ov) return;
  for (const [k, v] of Object.entries(ov)) {
    const def = table[k];
    if (!def) {
      console.warn(`样式 @${block} 的 ${k}：认不出的键，忽略`);
      continue;
    }
    if (!def.mixed) {
      console.warn(`样式 @${block} 的 ${k}：混排/五线谱不支持${def.note ? `（${def.note}）` : ""}，忽略`);
      continue;
    }
    const [head, sub] = def.mixed.split(".", 2);
    const target = (sub ? (o as unknown as Record<string, unknown>)[head!] : o) as Record<string, unknown>;
    const key = sub ?? head!;
    if (def.kind === "bool" || def.kind === "word") {
      if (typeof v === (def.kind === "bool" ? "boolean" : "string")) target[key] = v;
      else console.warn(`样式 @${block} 的 ${k}：值 ${JSON.stringify(v)} 不对，忽略`);
      continue;
    }
    // 裸数字就是 tenths（原样落值，出厂常量逐位不变）；带单位只收 em / sp
    const n = typeof v === "number" ? v : resolveLength(v as never, ctx);
    if (n === null) console.warn(`样式 @${block} 的 ${k}：五线谱只收 em / sp 或裸数字，${JSON.stringify(v)} 忽略`);
    else target[key] = n;
  }
}
