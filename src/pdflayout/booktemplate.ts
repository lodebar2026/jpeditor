// 成书那一路的模板件：模板排版结果 → DrawList 图元，外加 `key-meter()` 组件（调号 + 叠排拍号 + 避让首行）。
// 模板本身是一份 `.ss` 歌本样式（样例不在本仓库），排版在 `style/template.ts`；这里只是成书特有的实现。
//
// 无 DOM 依赖（`scripts/rebuild.mjs` 在 Node 侧用）。
import type { StyleRole } from "../style/sheet";
import type { ComponentFn, Placed } from "../style/template";
import type { Expr } from "../style/ss";
import type { BookStyle } from "./bookstyle";
import type { DrawItem } from "./drawlist";
import { keyMeterItems, textItem, type KeyMeterSpec, type Measure } from "./bookparts";

/** 模板排出来的东西 → DrawList 图元（文字走 `textItem`，与原先手写的 `put()` 字段顺序一致）。 */
export function placedToDrawItems(placed: readonly Placed[]): DrawItem[] {
  return placed.map((p) => (p.kind === "raw" ? (p.item as DrawItem) : textItem(p.text, p.role as StyleRole, p.size, p.x, p.y, p.align)));
}

/** `avoid: chord note gap 1.5 scan 60` → 要让开的角色、净距、只看基线下方多高。 */
function avoidSpec(e: Expr | undefined): { roles: Set<string>; gap: number; scan: number } | null {
  if (!e) return null;
  const items = e.k === "seq" ? e.items : [e];
  const roles = new Set<string>();
  let gap = 0;
  let scan = Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.k !== "id") continue;
    const nxt = items[i + 1];
    if ((it.v === "gap" || it.v === "scan") && nxt?.k === "num") {
      if (it.v === "gap") gap = nxt.v;
      else scan = nxt.v;
      i++;
    } else roles.add(it.v);
  }
  return { roles, gap, scan };
}

/**
 * `key-meter()`：原书写作「1=♭B  4/4  (1=A)」。
 *
 * **避让**（`avoid`）：原书实测的 `keyMeterBaseline` 下面紧接着就是第一条谱行，而拍号上下叠排
 * （分母还在基线下方 0.98 个墨迹高），首行音符上方又挂着和弦——271《切慕见祢》的分母 `4`
 * 就压在和弦 `Bm` 上（实测 2.9pt）。模板先按 `dy` 抬一个常量，这里再按**这一首**首行的
 * 和弦/音符墨迹顶兜底：抬完仍压着就继续抬到让开为止。
 * **只看本曲首行那一带**（基线下方 `scan`）：半页起排时一页两首，照直扫整页会被上一首的谱面
 * 一路顶到页顶（500/D03、D09/D13、J22/J26 三对）。
 */
export function keyMeterComponent(style: BookStyle, measure: Measure, km: KeyMeterSpec | null | undefined, pageItems: readonly DrawItem[], size?: number): ComponentFn {
  return ({ x, y, cell }) => {
    if (!km) return [];
    const items = keyMeterItems(style, km, x, y, measure, size);
    const av = avoidSpec(cell.props.avoid);
    if (!av) return items;
    const boxOf = (it: DrawItem): { x0: number; x1: number; top: number; bot: number } => {
      const x0 = it.t === "rect" ? it.x : it.t === "text" ? (it.xs?.[0] ?? it.box?.x ?? 0) : 0;
      const w = it.t === "rect" ? it.w : it.t === "text" ? measure(it.role, it.text, it.size) : 0;
      const top = it.t === "rect" ? it.y : it.t === "text" ? it.y - it.size * 0.72 : 0;
      const bot = it.t === "rect" ? it.y + it.h : it.t === "text" ? it.y : 0;
      return { x0, x1: x0 + w, top, bot };
    };
    const kmBoxes = items.map(boxOf);
    const kmBot = Math.max(...kmBoxes.map((b) => b.bot));
    let need = 0;
    for (const it of pageItems) {
      if (it.t !== "text" || !av.roles.has(it.role)) continue;
      const x0 = it.xs?.[0] ?? 0;
      const x1 = x0 + measure(it.role, it.text, it.size);
      const top = it.y - it.size * 0.72;
      if (top < y || top > y + av.scan) continue;
      if (top > kmBot || !kmBoxes.some((b) => b.x1 > x0 && b.x0 < x1 && b.bot > top)) continue;
      need = Math.max(need, kmBot - top + av.gap);
    }
    for (const it of items) if ("y" in it) (it as { y: number }).y -= need;
    return items;
  };
}
