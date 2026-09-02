// 路径对象的几何判定。对应 musicpp `qtomr/pdfpp.cpp` 里 `fpdf::PathObj` 那几个谓词
// （`isLine` / `isHLine` / `isVLine` / `isRect` / `isPolyline` / `allHLine` / `getPoint`）。
//
// pdfium 的路径模型是「点 + 类型」的数组，本仓是 DrawOPS 扁平流（`vector.ts`），
// 表达力一样，只是要先摊平成点。**摊平后一律是设备坐标**（套过 ctm），
// 与 musicpp 的 `getPoint(i, true)` 对齐。
//
// 一处刻意的背离：musicpp 判水平/垂直用的是**严格相等**（`pts[0].y == pts[1].y`）。
// 那是因为 pdfium 的点已经是原始坐标；本仓的点经过 ctm 乘法，浮点误差躲不掉，
// 故改成 `EPS` 容差。EPS 取 0.02pt——比一切真实的斜线都小，比浮点误差大两个数量级。
import { type Mat, DRAW_CLOSE, DRAW_CUBIC, DRAW_MOVE, DRAW_QUAD, drawOpArity, matApplyX, matApplyY } from "../omr/vector";
import type { VecObj } from "../omr/vector";

const EPS = 0.02;

/** 一条**子路径**（一次 moveTo 起头的那一段）。设备坐标。 */
export interface SubPath {
  pts: Pt[];
  closed: boolean;
}

export interface Pt {
  x: number;
  y: number;
  /** 该点是不是曲线控制点/终点（`CFX_Path::Point::Type::kBezier`）。 */
  curve: boolean;
}

/** 摊平成设备坐标的点列（曲线控制点也在内，与 pdfium 的 GetPoints 一致）。 */
export function pathPoints(o: VecObj): Pt[] {
  const m: Mat = o.ctm;
  const d = o.data;
  const out: Pt[] = [];
  let i = 0;
  while (i < d.length) {
    const c = d[i++];
    const n = drawOpArity(c);
    if (n < 0) break;
    if (c === DRAW_CLOSE) continue;
    const curve = c === DRAW_CUBIC || c === DRAW_QUAD;
    for (let k = 0; k < n; k += 2) {
      out.push({ x: matApplyX(m, d[i + k], d[i + k + 1]), y: matApplyY(m, d[i + k], d[i + k + 1]), curve });
    }
    i += n;
  }
  return out;
}

/**
 * 拆成子路径。**这一步不能省**：本书有一批 PDF（Finale 经 Distiller 那一路）
 * 把**整行谱的五条线加小节线全画进一个 path 对象**——实测 p185 一个对象 400 个点、
 * 里面是几十条各自独立的两点直线。按整个对象判 `isLine` 永远是 false，
 * 谱行就一行都找不到（全书 266 页因此漏掉）。
 */
export function subPaths(o: VecObj): SubPath[] {
  const m: Mat = o.ctm;
  const d = o.data;
  const out: SubPath[] = [];
  let cur: SubPath | null = null;
  let i = 0;
  while (i < d.length) {
    const c = d[i++];
    const n = drawOpArity(c);
    if (n < 0) break;
    if (c === DRAW_CLOSE) {
      if (cur) cur.closed = true;
      i += n;
      continue;
    }
    if (c === DRAW_MOVE) {
      cur = { pts: [], closed: false };
      out.push(cur);
    }
    if (!cur) {
      cur = { pts: [], closed: false };
      out.push(cur);
    }
    const curve = c === DRAW_CUBIC || c === DRAW_QUAD;
    for (let k = 0; k < n; k += 2) {
      cur.pts.push({ x: matApplyX(m, d[i + k], d[i + k + 1]), y: matApplyY(m, d[i + k], d[i + k + 1]), curve });
    }
    i += n;
  }
  return out.filter((s) => s.pts.length > 0);
}

/** 第 idx 个点（设备坐标）。越界返回 null。 */
export function pathPoint(o: VecObj, idx: number): Pt | null {
  const p = pathPoints(o);
  return p[idx] ?? null;
}

export function hasCurve(o: VecObj): boolean {
  return o.curves > 0;
}

/** `isLine`：恰好两个点（一个 moveTo + 一个 lineTo）。 */
export function isLine(o: VecObj): boolean {
  if (o.curves) return false;
  return pathPoints(o).length === 2;
}

export function isHLine(o: VecObj): boolean {
  if (!isLine(o)) return false;
  const p = pathPoints(o);
  return Math.abs(p[0].y - p[1].y) < EPS;
}

export function isVLine(o: VecObj): boolean {
  if (!isLine(o)) return false;
  const p = pathPoints(o);
  return Math.abs(p[0].x - p[1].x) < EPS;
}

/** 子路径是不是轴对齐的细长矩形（四点或五点闭合）。
 *  Finale 有时把符干/小节线/谱线画成填充细矩形而不是描边直线。
 *  返回沿长轴的中心线段；不是细长矩形返回 null。 */
export function thinRectAxis(sp: SubPath): { x0: number; y0: number; x1: number; y1: number; w: number } | null {
  const p = sp.pts;
  const n =
    p.length === 5 && Math.abs(p[0].x - p[4].x) < EPS && Math.abs(p[0].y - p[4].y) < EPS ? 4 : p.length;
  if (n !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    if (Math.abs(a.x - b.x) >= EPS && Math.abs(a.y - b.y) >= EPS) return null;
  }
  const xs = p.slice(0, 4).map((q) => q.x);
  const ys = p.slice(0, 4).map((q) => q.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const w = x1 - x0;
  const h = y1 - y0;
  // 细长判据：短边不到长边的三成。符杠是斜的平行四边形，走不到这里。
  if (w < h * 0.3) return { x0: (x0 + x1) / 2, y0, x1: (x0 + x1) / 2, y1, w };
  if (h < w * 0.3) return { x0, y0: (y0 + y1) / 2, x1, y1: (y0 + y1) / 2, w: h };
  return null;
}

/** `isRect`：闭合的轴对齐矩形（四点或五点，边都平行于轴）。
 *  Finale 把符杠、粗小节线、休止方块都画成填充矩形，全靠它认出来。 */
export function isRect(o: VecObj): boolean {
  if (o.curves) return false;
  const p = pathPoints(o);
  const n = p.length === 5 && Math.abs(p[0].x - p[4].x) < EPS && Math.abs(p[0].y - p[4].y) < EPS ? 4 : p.length;
  if (n !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    if (Math.abs(a.x - b.x) >= EPS && Math.abs(a.y - b.y) >= EPS) return false;
  }
  return true;
}

export function isPolyline(o: VecObj): boolean {
  if (o.curves) return false;
  return pathPoints(o).length > 2;
}

/** `allHLine`：折线的每一段都平行于某个轴（水平或垂直）。
 *  Finale 有时把一整行谱线连成一条折线，靠它挑出来。 */
export function allAxisAligned(o: VecObj): boolean {
  if (!isPolyline(o)) return false;
  const p = pathPoints(o);
  for (let i = 1; i < p.length; i++) {
    if (Math.abs(p[i - 1].y - p[i].y) < EPS) continue;
    if (Math.abs(p[i - 1].x - p[i].x) < EPS) continue;
    return false;
  }
  return true;
}

/** `strokeWidth`：设备尺度的线宽。`vector.ts` 抽取时已经乘过 ctm 的缩放。
 *  PDF 的 0 线宽是「最细可见线」，按 1 设备像素算——照 `objToSvg` 那条注释。 */
export function strokeWidth(o: VecObj): number {
  return Math.max(o.lineWidth, 1);
}

export function isStroke(o: VecObj): boolean {
  return o.paint.toLowerCase().includes("stroke");
}

export function isFill(o: VecObj): boolean {
  return o.paint.toLowerCase().includes("fill");
}

export function isDashed(o: VecObj): boolean {
  return !!o.dash && o.dash.length > 1;
}

/** 纯白填充（原件上看不见的底衬）。musicpp 的 `removeWhite` 靠它。 */
export function isWhite(o: VecObj): boolean {
  const c = (isFill(o) ? o.fill : o.stroke) ?? "";
  return c === "#ffffff" || c === "#fff";
}
