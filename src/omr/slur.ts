// 圆滑线 / 连音线识别（音符上方的弧形 ⌒）。
// 简谱里弧线画在数字**正上方**、横跨 2~3 个相邻音符：圆滑线(slur，跨不同音高)用于一字多音/乐句，
// 连音线(tie，跨相邻同音高)用于延音。两者视觉相同，唯一可分的判据是端点音高是否相等。
//
// 几何特征（与八度点/增时线/减时线区分）：
//   - 弧线是「宽而薄」的连通块：w ≳ 0.8×字号、w/h ≥ 2，落在数字行**上方**（底边贴近数字顶）。
//   - 八度上点很小(w,h ≤ 0.45×字号)；增时线 '-' 在数字**中线**、减时线在数字**下方** → 都不在上方，天然不混。
//   - 数字块 h ≥ 0.55×字号 才算，弧线更矮 → 不会被当成假音符（classify 里已落到 hlines 或被丢弃）。
import type { Component, StaffRow } from "./types";
import { rright, rbottom, rcx } from "./types";

const between = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };

/** 在 comps 里为每个 staff 行检测上方弧线，置位音符的 slurStart/Stop 或 tieStart/Stop。 */
export function detectSlurs(comps: Component[], rows: StaffRow[], numH: number): void {
  for (const row of rows) {
    if (row.nums.length < 2) continue;
    // 用数字顶边的**中位数**（而非 min）作行顶基准：个别音符 bbox 顶边偏高（拆块/噪声）
    // 会把 min 拉到弧线高度，导致「弧底贴行顶」的判据误杀真弧（实测行4 三条弧全漏即此因）。
    const rowTop = median(row.nums.map((n) => n.bbox.y));

    // 候选弧线：宽而薄、底边贴近数字顶且不深入数字行。
    const arcs = comps.filter((c) => {
      const b = c.bbox;
      if (b.w < numH * 0.8 || b.h < 2 || b.h > numH * 0.8) return false;
      if (b.w / b.h < 2) return false;
      // 底边落在 [数字顶 - 1.2字号, 数字顶 + 0.25字号]：即整体在数字上方、最多略压数字顶缘。
      return between(rbottom(b), rowTop - numH * 1.2, rowTop + numH * 0.25);
    });

    for (const arc of arcs) {
      const a = arc.bbox;
      // 找弧线横向覆盖的音符（质心落在弧线 x 跨度内，左右各放宽 0.5 字号容端点偏移）。
      // 弧线常画在两音"符头之间"而非正压音符质心，左缘可比首音质心偏右半个字号
      //（实测基督更美行5 `(3_5_)`：弧 x129、首音 3 质心 114，差 15px≈0.3字号，0.3 容差差 0.6px 漏掉）。
      const covered = row.nums.filter((n) => between(rcx(n.bbox), a.x - numH * 0.5, rright(a) + numH * 0.5));
      if (covered.length < 2) continue;
      const start = covered[0], stop = covered[covered.length - 1];
      // tie：恰好相邻两音、且同音高(数字+八度相同)；否则按 slur。
      const sameIdx = row.nums.indexOf(start) + 1 === row.nums.indexOf(stop);
      const samePitch = start.digit === stop.digit && start.octave === stop.octave && start.digit !== 0;
      if (covered.length === 2 && sameIdx && samePitch) {
        start.tieStart = true; stop.tieStop = true;
      } else {
        start.slurStart = true; stop.slurStop = true;
      }
    }
  }
}
