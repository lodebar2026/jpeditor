// 小节线的样式与反复记号。移植自 musicpp `qtomr/system.cpp::System::analyzeMeasures`
// 里定 `BarLineStyle` 的那一段，另加**反复点**的判定（musicpp 没做这一档）。
//
// 坐标一律设备坐标、y 向下。
import { SPage, Staff, Sym } from "./model";

/** 一处小节线（可能由好几笔组成：细+粗、反复点+细+粗）。 */
export interface BarlineMark {
  /** 这一处的 x（取最右一笔，音符按它归小节）。 */
  x: number;
  /** 最左一笔的 x（判反复点在哪一侧用）。 */
  left: number;
  /** MusicXML 的 `<bar-style>`；普通细线返回 null（不必写）。 */
  style: string | null;
  /** 反复方向：`forward` = `|:`、`backward` = `:|`、`both` = `:|:`。 */
  repeat: "forward" | "backward" | "both" | null;
}

/**
 * 把一行谱上的小节线笔画归成「处」，并定样式。
 *
 * 三条判据：
 *   1. **挨得比两个线距还近的几笔是同一处**（细+粗的终止线、反复线的两笔）。
 *      同一笔常常被重描好几遍（实测 p205 的终止线画了 8 遍），先按 x 去重。
 *   2. 一处里有**粗**笔（线宽超过三分之一线距）就是 `light-heavy`（终止/反复），
 *      否则两笔就是 `light-light`（复纵线），单笔是普通线。
 *   3. **反复点**：谱表第二、三间里上下两枚圆点。点在这一处**左边**是 `:|`（收）、
 *      右边是 `|:`（起）、两边都有是 `:|:`。本书的反复点用的是 `augmentationDot` 字形
 *      （Maestro 一路）或 `repeatDots`（Anastasia 一路），两种都要认。
 */
export function classifyBarlines(pg: SPage, stf: Staff): BarlineMark[] {
  const sp = pg.normalStaffSpace || pg.space;
  // 这一行谱上的所有小节线笔画（路径段 + 字形）
  const xs: { x: number; lw: number }[] = [];
  for (const s of pg.segsWithTag("BarLine")) {
    if (s.box.top > stf.box.bottom || s.box.bottom < stf.box.top) continue;
    xs.push({ x: s.cx, lw: s.lw });
  }
  for (const s of pg.symbols) {
    if (!s.hasTag("BarLine")) continue;
    if (s.box.top > stf.box.bottom || s.box.bottom < stf.box.top) continue;
    // Anastasia 的 `barlineFinal` 一个字形就是「细+粗」，按粗笔算
    xs.push({ x: (s.box.left + s.box.right) / 2, lw: s.code === "barlineSingle" ? 0 : sp });
  }
  xs.sort((a, b) => a.x - b.x);

  // 去重 + 归组
  const groups: { xs: number[]; lw: number }[] = [];
  for (const it of xs) {
    const g = groups[groups.length - 1];
    if (g && it.x - g.xs[g.xs.length - 1] < sp * 2) {
      if (it.x - g.xs[g.xs.length - 1] > 0.3) g.xs.push(it.x); // 同一笔的重描不算新笔
      g.lw = Math.max(g.lw, it.lw);
    } else {
      groups.push({ xs: [it.x], lw: it.lw });
    }
  }

  // 反复点：落在谱表内、上下成对的圆点
  const dots = pg.symbols.filter(
    (s) =>
      (s.code === "augmentationDot" || s.code === "repeatDots") &&
      !s.hasTag("Augmentation") &&
      s.py > stf.box.top &&
      s.py < stf.box.bottom,
  );

  const out: BarlineMark[] = [];
  for (const g of groups) {
    const left = g.xs[0];
    const x = g.xs[g.xs.length - 1];
    const style = g.lw > sp / 3 ? "light-heavy" : g.xs.length > 1 ? "light-light" : null;
    let before = false;
    let after = false;
    for (const d of dots) {
      const dx = d.px - (left + x) / 2;
      if (Math.abs(dx) > sp * 2) continue;
      // `repeatDots` 一个字形就是上下两点；`augmentationDot` 要两枚才算
      const pair = d.code === "repeatDots" || dots.some((o) => o !== d && Math.abs(o.px - d.px) < sp * 0.4 && Math.abs(o.py - d.py) > sp * 0.5);
      if (!pair) continue;
      if (dx < 0) before = true;
      else after = true;
    }
    const repeat = before && after ? "both" : before ? "backward" : after ? "forward" : null;
    out.push({ x, left, style: repeat && !style ? "light-heavy" : style, repeat });
  }
  return out;
}

/** 反复点用掉之后打个标，免得被别处（附点、演奏法）再认一遍。 */
export function tagRepeatDots(pg: SPage, stf: Staff, marks: BarlineMark[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  const xs = marks.filter((m) => m.repeat).map((m) => (m.left + m.x) / 2);
  if (!xs.length) return;
  for (const s of pg.symbols) {
    if (s.code !== "augmentationDot" && s.code !== "repeatDots") continue;
    if (s.hasAnyTag()) continue;
    if (s.py < stf.box.top || s.py > stf.box.bottom) continue;
    if (!xs.some((x) => Math.abs(s.px - x) < sp * 2)) continue;
    (s as Sym).addTag("BarLine");
  }
}
