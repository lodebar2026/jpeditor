// OMR 管线共用的几何/统计小工具。抽出来只为「同一个式子别写五遍」——
// 判据本身（阈值、取舍）仍留在各自的识别模块里，因为每条都是拿具体曲子换来的。
import type { Rect } from "./types";
import { rcy } from "./types";

/** 中位数（偏上取，长度为偶数时取右中）。空数组返回 fallback。
 *  注意是 `s[s.length >> 1]` 而非两数平均——识别里要的是「一个真实存在的代表值」。 */
export function median(xs: number[], fallback = 0): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : fallback;
}

/** 两个包围盒的并集（xywh 语义；common/geom.ts 的 Rect 是 LTRB，两者不通用）。 */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return {
    x, y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** 一组包围盒的并集。空数组返回全 0。 */
export function unionRects(rs: readonly Rect[]): Rect {
  if (!rs.length) return { x: 0, y: 0, w: 0, h: 0 };
  return rs.reduce(unionRect);
}

/** x 向重叠的**像素量**（不重叠为 0）。 */
export function overlapX(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
}

/** x 向重叠占**较窄那个**宽度的比例。用于判「是否同一列」。 */
export function overlapRatioX(a: Rect, b: Rect): number {
  return overlapX(a, b) / Math.min(a.w, b.w);
}

/** 按纵向中心贪心聚成行：升序扫过，落进「已有行中位 y 相差 < tol」的第一行，否则另起一行。
 *
 *  **tol 一律由调用方给**，不设默认值：各调用点的容差是拿具体曲子调出来的，语义也不同
 *  （主体归行 / 补收细横笔 / 补收句末标点），统一成一个值会改变识别结果。见各调用点的注释。 */
export function clusterByY<T>(items: readonly T[], keyOf: (t: T) => number, tol: number): T[][] {
  const sorted = [...items].sort((a, b) => keyOf(a) - keyOf(b));
  const lines: T[][] = [];
  for (const it of sorted) {
    const ln = lines.find((L) => Math.abs(median(L.map(keyOf)) - keyOf(it)) < tol);
    if (ln) ln.push(it); else lines.push([it]);
  }
  return lines;
}

/** clusterByY 的「补收」变体：只把 item 并入**已有**行，不新建行；未命中返回 null。 */
export function findLineByY<T>(lines: T[][], keyOf: (t: T) => number, y: number, tol: number): T[] | null {
  return lines.find((L) => Math.abs(median(L.map(keyOf)) - y) < tol) ?? null;
}

/** 按包围盒中心 y 聚行（clusterByY 的常用特化）。 */
export function clusterRectsByY<T extends { bbox: Rect }>(items: readonly T[], tol: number): T[][] {
  return clusterByY(items, (t) => rcy(t.bbox), tol);
}
