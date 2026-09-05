// 松叶（`<wedge>`：渐强 `<` / 渐弱 `>`）——**按 contour 认**，不拼线段。
//
// 为什么不从 `hSegs` 里配对两条臂：`findPrimitives` 对横笔画有一道
// 「块高不过 `thin * 2`」的闸（约 0.8 个线距），而松叶的开口实测有 1.5~2 个线距高
// ——整条松叶连着尖端是**一团**，块高一超限就被那道闸整个滤掉，压根没进 `hSegs`。
// 它于是原样留在图上，成为一个又宽又扁的 contour（实测宁静 p2 那条 376×30 px =
// 20.7×1.66 格、团状度 0.01）。既然它本来就是完整的一团，直接按 contour 判最省事。
//
// 判据是**逐列的墨迹跨度**：松叶的两条臂从尖端往开口张开，跨度近似线性地涨；
// 弧线（slur）同样又宽又扁、团状度也低，但它逐列只有**一段**墨、跨度处处等于线宽
// ——「一列几段墨」与「跨度涨不涨」这两条一起用，两者一刀分得开。
import type { Binary } from "../omr/types";
import type { Contour, ContourMap } from "./contour";
import type { RasterUnit } from "./staffline";

export interface RasterWedge {
  /** 渐强（尖端在左）/ 渐弱（尖端在右）。 */
  type: "crescendo" | "diminuendo";
  /** 左右端的 x（像素）。 */
  x0: number;
  x1: number;
  /** 纵向中心（像素）——挂到哪行谱靠它。 */
  cy: number;
  contourId: number;
}

/** 松叶的形状闸（一律按线距）。 */
const MIN_W = 2.5;
const MAX_H = 3.0;
const MIN_H = 0.35;
/** 团状度上限：又宽又扁的东西才有资格（符头 0.7 往上、字 0.3 往上）。 */
const MAX_COMPACT = 0.2;
/** 开口那一头的跨度下限，与尖端那一头的上限。 */
const OPEN_MIN = 0.55;
const TIP_MAX = 0.42;
/** 逐列有**两段**墨的列要占多少（尖端附近只有一段，所以不能要求全部）。 */
const TWO_RUN_FRAC = 0.35;

/**
 * 从 contour 层里挑出松叶。
 *
 * @param only 只看这些 contour（一般传账本里**无主**的那些——认出来的符号不必再判）。
 */
export function findRasterWedges(map: ContourMap, unit: RasterUnit, only?: Contour[]): RasterWedge[] {
  const out: RasterWedge[] = [];
  for (const c of only ?? map.contours) {
    if (c.w < MIN_W || c.h > MAX_H || c.h < MIN_H) continue;
    if (c.compact > MAX_COMPACT) continue;
    const w = judge(map, c, unit);
    if (w) out.push(w);
  }
  return out;
}

/** 逐列量墨迹：这一团是不是松叶，是哪一种。 */
function judge(map: ContourMap, c: Contour, unit: RasterUnit): RasterWedge | null {
  const b = c.bbox;
  const spread: number[] = [];
  const runs: number[] = [];
  for (let x = b.x; x < b.x + b.w; x++) {
    let top = -1;
    let bot = -1;
    let n = 0;
    let prev = false;
    for (let y = b.y; y < b.y + b.h; y++) {
      const on = map.labels[y * map.w + x] === c.id;
      if (on) {
        if (top < 0) top = y;
        bot = y;
        if (!prev) n++;
      }
      prev = on;
    }
    if (top < 0) continue;
    spread.push(bot - top + 1);
    runs.push(n);
  }
  if (spread.length < unit.space * 2) return null;
  const twoRun = runs.filter((n) => n >= 2).length / runs.length;
  if (twoRun < TWO_RUN_FRAC) return null; // 逐列只有一段墨：那是弧线，不是松叶
  const k = Math.max(1, Math.round(spread.length * 0.15));
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const left = med(spread.slice(0, k)) / unit.space;
  const right = med(spread.slice(-k)) / unit.space;
  const open = Math.max(left, right);
  const tip = Math.min(left, right);
  if (open < OPEN_MIN || tip > TIP_MAX || open < tip * 2) return null;
  return {
    type: right > left ? "crescendo" : "diminuendo",
    x0: b.x,
    x1: b.x + b.w - 1,
    cy: b.y + b.h / 2,
    contourId: c.id,
  };
}

/** 排查用：把一团墨的逐列跨度打出来。 */
export function wedgeProfile(map: ContourMap, c: Contour, bin?: Binary): { spread: number[]; runs: number[] } {
  void bin;
  const b = c.bbox;
  const spread: number[] = [];
  const runs: number[] = [];
  for (let x = b.x; x < b.x + b.w; x++) {
    let top = -1;
    let bot = -1;
    let n = 0;
    let prev = false;
    for (let y = b.y; y < b.y + b.h; y++) {
      const on = map.labels[y * map.w + x] === c.id;
      if (on) {
        if (top < 0) top = y;
        bot = y;
        if (!prev) n++;
      }
      prev = on;
    }
    if (top < 0) continue;
    spread.push(bot - top + 1);
    runs.push(n);
  }
  return { spread, runs };
}
