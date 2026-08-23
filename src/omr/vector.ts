// 矢量 PDF 前端：直接读 PDF 的路径对象，而不是先栅格化再连通域。
//
// 为什么要这条路（见 docs/实现/矢量PDF识别.md）：印刷歌本的 PDF 常常是「文字全部转曲」——
// 没有文字层、没有嵌入字体，但**每个字/数字/点/线各自是一个独立的 path 对象**
// （`save → transform → constructPath → restore`）。于是光栅路里最费劲的那一摊
// （CCL 把八度点和数字粘一起、圆滑线跨过数字、小节线搭桥）在矢量层根本不存在：
// 对象边界就是天然的分割。速度也差两个数量级（全书 666 页抽取 ~8s，无需 OCR 推理）。
//
// **本文件及其 import 链不得触碰 canvas / OffscreenCanvas / document**——
// Node CLI（page-report.mjs / pdf-diff.mjs）要在没有浏览器的情况下 import 它。
// 需要位图时另走 decode.ts（那边是浏览器专属）。
//
// pdfjs 的路径编码（node_modules/pdfjs-dist/**/pdf.mjs 的 DrawOPS / makePathFromDrawOPS）：
//   argsArray[i] = [paintOp, [Float32Array 路径数据], minMax]
//   路径数据是扁平流：0=moveTo(2) 1=lineTo(2) 2=curveTo(6) 3=quadraticCurveTo(4) 4=closePath(0)
//   minMax = [minx, miny, maxx, maxy]，路径自身坐标系下的紧包围盒。
import type { Component, Rect } from "./types";

/** 2×3 仿射矩阵 [a,b,c,d,e,f]：x' = a·x + c·y + e，y' = b·x + d·y + f。 */
export type Mat = [number, number, number, number, number, number];

/** DrawOPS 命令码。与 pdfjs 内部枚举一致，勿改数值。 */
export const DRAW_MOVE = 0;
export const DRAW_LINE = 1;
export const DRAW_CUBIC = 2;
export const DRAW_QUAD = 3;
export const DRAW_CLOSE = 4;

/** 每个命令码后面跟几个数（坐标个数，非点数）。 */
export function drawOpArity(code: number): number {
  switch (code) {
    case DRAW_MOVE:
    case DRAW_LINE:
      return 2;
    case DRAW_CUBIC:
      return 6;
    case DRAW_QUAD:
      return 4;
    case DRAW_CLOSE:
      return 0;
    default:
      return -1; // 未知命令：调用方须停止解析（数据流已无法对齐）
  }
}

/** 绘制算子（pdfjs OPS 名）。`endPath` 表示这条路径只用于裁剪，不落墨。 */
export type PaintOp =
  | "fill"
  | "eoFill"
  | "stroke"
  | "closeStroke"
  | "fillStroke"
  | "eoFillStroke"
  | "closeFillStroke"
  | "closeEOFillStroke"
  | "endPath";

/** 一个矢量绘制对象 = PDF 里的一条路径 + 它生效时的图形状态。 */
export interface VecObj {
  id: number;
  /** 路径数据（DrawOPS 扁平流），**路径自身坐标系**，未套 ctm。 */
  data: Float32Array;
  /** 路径坐标系 → 设备坐标（y 向下，原点左上，已含页面旋转与 scale）。 */
  ctm: Mat;
  /** 设备坐标下的轴对齐包围盒（stroke 已按线宽外扩）。 */
  bbox: Rect;
  paint: PaintOp;
  /** 曲线段数（curveTo + quadTo）。0 = 纯直线，多半是减时线/小节线/分隔线。 */
  curves: number;
  /** 命令段数。 */
  segs: number;
  /** 设备尺度下的线宽（stroke 用）。 */
  lineWidth: number;
  /** 虚线参数（设备尺度）；null = 实线。花边框靠它复现。 */
  dash: number[] | null;
  dashPhase: number;
  fill: string | null;
  stroke: string | null;
  /** 生效的裁剪框（设备坐标）；null = 未裁剪。 */
  clip: Rect | null;
}

/** 页面上的非路径内容（要在版面规格里原样记下来，不能当"没有"）。 */
export interface VecExtras {
  /** 内嵌位图：paintImageXObject / paintImageMaskXObject。 */
  images: { id: string; ctm: Mat; bbox: Rect }[];
  /** 渐变填充 shadingFill。 */
  shadings: { ctm: Mat; bbox: Rect | null }[];
  /** **未转曲的真实文字**：这一页有文字层，须另走 page.getTextContent()。 */
  hasText: boolean;
}

export interface VecPage {
  page: number;
  /** 设备坐标下的页宽高。 */
  width: number;
  height: number;
  rotation: number;
  /** 设备坐标 = PDF 用户坐标 × 此缩放（1 = PDF 点）。 */
  scale: number;
  objs: VecObj[];
  extras: VecExtras;
}

// ── 矩阵 ────────────────────────────────────────────────────────────────────

/** 先套 b 再套 a（等价 pdfjs Util.transform(a, b)）。 */
export function matMul(a: Mat, b: Mat): Mat {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function matApplyX(m: Mat, x: number, y: number): number {
  return m[0] * x + m[2] * y + m[4];
}
export function matApplyY(m: Mat, x: number, y: number): number {
  return m[1] * x + m[3] * y + m[5];
}

/** 矩阵的等效均匀缩放（用于把线宽/虚线从用户单位换到设备单位）。 */
export function matScale(m: Mat): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

// ── 包围盒 ──────────────────────────────────────────────────────────────────

function emptyBox(): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

function growBox(b: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number): void {
  if (x < b.x0) b.x0 = x;
  if (x > b.x1) b.x1 = x;
  if (y < b.y0) b.y0 = y;
  if (y > b.y1) b.y1 = y;
}

function boxToRect(b: { x0: number; y0: number; x1: number; y1: number }): Rect {
  return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
}

/** 两矩形是否相交（**允许零宽/零高的退化矩形**）。
 *  裁剪可见性判定专用：lineWidth 0 的细线（PDF 里的「最细可见线」）bbox 恰好是零宽，
 *  拿 `intersectRect` 判会返回 null，整条线被当成框外内容丢掉。 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** 两矩形交集；不相交返回 null。 */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 把路径坐标系下的紧包围盒经 ctm 变换成设备坐标的轴对齐盒（四角变换后取包络）。 */
function transformBox(m: Mat, x0: number, y0: number, x1: number, y1: number): Rect {
  const b = emptyBox();
  growBox(b, matApplyX(m, x0, y0), matApplyY(m, x0, y0));
  growBox(b, matApplyX(m, x1, y0), matApplyY(m, x1, y0));
  growBox(b, matApplyX(m, x0, y1), matApplyY(m, x0, y1));
  growBox(b, matApplyX(m, x1, y1), matApplyY(m, x1, y1));
  return boxToRect(b);
}

/** 直接从 DrawOPS 流算路径坐标系下的包围盒（minMax 缺失时兜底）。
 *  控制点参与计算 → 对曲线略偏大，仅作兜底。 */
export function pathBoundsRaw(data: Float32Array): { x0: number; y0: number; x1: number; y1: number } | null {
  const b = emptyBox();
  let i = 0;
  let any = false;
  while (i < data.length) {
    const n = drawOpArity(data[i++]);
    if (n < 0) break;
    for (let k = 0; k < n; k += 2) {
      growBox(b, data[i + k], data[i + k + 1]);
      any = true;
    }
    i += n;
  }
  return any ? b : null;
}

/** 统计曲线段数与总段数。 */
export function pathStats(data: Float32Array): { curves: number; segs: number } {
  let curves = 0;
  let segs = 0;
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    const n = drawOpArity(c);
    if (n < 0) break;
    segs++;
    if (c === DRAW_CUBIC || c === DRAW_QUAD) curves++;
    i += n;
  }
  return { curves, segs };
}

// ── SVG ────────────────────────────────────────────────────────────────────

/** DrawOPS 流 → SVG path `d`（路径自身坐标系；配合 ctm 用 transform="matrix(...)"）。 */
export function toSvgPath(data: Float32Array, precision = 2): string {
  const f = (v: number) => v.toFixed(precision);
  let d = "";
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    const n = drawOpArity(c);
    if (n < 0) break;
    if (c === DRAW_MOVE) d += `M${f(data[i])} ${f(data[i + 1])}`;
    else if (c === DRAW_LINE) d += `L${f(data[i])} ${f(data[i + 1])}`;
    else if (c === DRAW_CUBIC)
      d += `C${f(data[i])} ${f(data[i + 1])} ${f(data[i + 2])} ${f(data[i + 3])} ${f(data[i + 4])} ${f(data[i + 5])}`;
    else if (c === DRAW_QUAD) d += `Q${f(data[i])} ${f(data[i + 1])} ${f(data[i + 2])} ${f(data[i + 3])}`;
    else if (c === DRAW_CLOSE) d += "Z";
    i += n;
  }
  return d;
}

/** DrawOPS 流 → SVG path `d`，坐标**已套上 ctm**（即设备坐标）。
 *  给那些不支持 transform 属性的消费方用（如 pdf-lib 的 drawSvgPath）。 */
export function toSvgPathTransformed(data: Float32Array, ctm: Mat, precision = 2): string {
  const f = (v: number) => v.toFixed(precision);
  const X = (x: number, y: number) => f(matApplyX(ctm, x, y));
  const Y = (x: number, y: number) => f(matApplyY(ctm, x, y));
  let d = "";
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    const n = drawOpArity(c);
    if (n < 0) break;
    if (c === DRAW_MOVE) d += `M${X(data[i], data[i + 1])} ${Y(data[i], data[i + 1])}`;
    else if (c === DRAW_LINE) d += `L${X(data[i], data[i + 1])} ${Y(data[i], data[i + 1])}`;
    else if (c === DRAW_CUBIC)
      d +=
        `C${X(data[i], data[i + 1])} ${Y(data[i], data[i + 1])} ` +
        `${X(data[i + 2], data[i + 3])} ${Y(data[i + 2], data[i + 3])} ` +
        `${X(data[i + 4], data[i + 5])} ${Y(data[i + 4], data[i + 5])}`;
    else if (c === DRAW_QUAD)
      d += `Q${X(data[i], data[i + 1])} ${Y(data[i], data[i + 1])} ${X(data[i + 2], data[i + 3])} ${Y(data[i + 2], data[i + 3])}`;
    else if (c === DRAW_CLOSE) d += "Z";
    i += n;
  }
  return d;
}

/** 一个对象渲染成 SVG `<path>`（设备坐标系下）。核对与报告页共用。 */
export function objToSvg(o: VecObj, extraAttrs = ""): string {
  const d = toSvgPath(o.data);
  const m = `matrix(${o.ctm.join(",")})`;
  const stroked = o.paint.toLowerCase().includes("stroke");
  const filled = o.paint.toLowerCase().includes("fill");
  const parts = [`transform="${m}"`, `d="${d}"`];
  if (o.paint === "eoFill" || o.paint === "eoFillStroke" || o.paint === "closeEOFillStroke")
    parts.push(`fill-rule="evenodd"`);
  parts.push(filled ? `fill="${o.fill ?? "#000"}"` : `fill="none"`);
  if (stroked) {
    const s = matScale(o.ctm);
    parts.push(`stroke="${o.stroke ?? "#000"}"`);
    // 线宽在路径坐标系里解释，故除掉 ctm 的缩放。
    // PDF 的 lineWidth 0 是「最细可见线」（1 设备像素），直接写成 SVG stroke-width:0 会整条不画——
    // 减时线/小节线大量用 0 线宽，漏了就整页少一成墨。
    parts.push(`stroke-width="${(Math.max(o.lineWidth, 1) / s).toFixed(3)}"`);
    if (o.dash && o.dash.length) parts.push(`stroke-dasharray="${o.dash.map((v) => v / s).join(",")}"`);
    if (o.dashPhase) parts.push(`stroke-dashoffset="${(o.dashPhase / s).toFixed(3)}"`);
  }
  if (extraAttrs) parts.push(extraAttrs);
  return `<path ${parts.join(" ")}/>`;
}

// ── 抽取 ────────────────────────────────────────────────────────────────────

/** pdfjs 的 OPS 枚举（名 → 数值）。调用方从 `pdfjs.OPS` 传入，本文件不 import pdfjs。 */
export type OpsEnum = Record<string, number>;

interface GState {
  ctm: Mat;
  lineWidth: number;
  dash: number[] | null;
  dashPhase: number;
  fill: string | null;
  stroke: string | null;
  clip: Rect | null;
}

function cloneGState(s: GState): GState {
  return { ...s, ctm: [...s.ctm] as Mat, dash: s.dash ? [...s.dash] : null };
}

export interface ExtractOptions {
  /** 设备坐标缩放（1 = PDF 点）。识别时可给 2000/pageWidth 之类对齐光栅路。 */
  scale?: number;
  /** 是否丢弃完全落在裁剪框外的对象（默认 true）。
   *  关掉会凭空多出原件上不可见的内容——重排核对的 `spurious` 就是这么来的。 */
  applyClip?: boolean;
}

/**
 * 抽取一页的矢量对象。
 *
 * @param page pdfjs 的 PDFPageProxy（本文件不 import pdfjs，避免把 worker/DOM 依赖带进 Node）
 * @param OPS  pdfjs.OPS
 */
export async function extractVectorPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: any,
  OPS: OpsEnum,
  opts: ExtractOptions = {},
): Promise<VecPage> {
  const scale = opts.scale ?? 1;
  const applyClip = opts.applyClip ?? true;
  const viewport = page.getViewport({ scale });
  const base = [...viewport.transform] as Mat; // PDF 用户坐标 → 设备坐标（y 向下）
  const list = await page.getOperatorList();
  const names = opsNames(OPS);

  const pageRect: Rect = { x: 0, y: 0, w: viewport.width, h: viewport.height };
  const objs: VecObj[] = [];
  const extras: VecExtras = { images: [], shadings: [], hasText: false };

  let gs: GState = { ctm: base, lineWidth: 1, dash: null, dashPhase: 0, fill: "#000000", stroke: "#000000", clip: null };
  const stack: GState[] = [];
  let pendingClip = false;
  let id = 0;

  for (let i = 0; i < list.fnArray.length; i++) {
    const name = names[list.fnArray[i]];
    const args = list.argsArray[i];
    switch (name) {
      case "save":
        stack.push(cloneGState(gs));
        break;
      case "restore": {
        const prev = stack.pop();
        if (prev) gs = prev;
        break;
      }
      case "transform":
        gs.ctm = matMul(gs.ctm, args as Mat);
        break;
      case "setLineWidth":
        gs.lineWidth = args[0];
        break;
      case "setDash":
        gs.dash = Array.isArray(args[0]) && args[0].length ? (args[0] as number[]) : null;
        gs.dashPhase = args[1] ?? 0;
        break;
      case "setGState":
        // 线宽/虚线也可以经 ExtGState 设（pdfjs canvas 的 setGState 就是这么派发的）。
        // 只认这两项——其余（透明度、混合模式、字体）与几何无关。
        for (const kv of (args[0] as [string, unknown][]) ?? []) {
          if (kv?.[0] === "LW") gs.lineWidth = kv[1] as number;
          else if (kv?.[0] === "D") {
            const d = kv[1] as [number[], number] | undefined;
            gs.dash = Array.isArray(d?.[0]) && d[0].length ? (d[0] as number[]) : null;
            gs.dashPhase = d?.[1] ?? 0;
          }
        }
        break;
      // Form XObject：pdfjs canvas 在 Begin 处 save + transform + 按 bbox 裁剪，
      // 在 End 处 restore。不跟着做的话，表单里的路径会少套一层矩阵——
      // 整块内容原样落在错误的位置上，且不会报任何错。
      case "paintFormXObjectBegin": {
        stack.push(cloneGState(gs));
        const m = args[0] as Mat | null | undefined;
        if (m && m.length >= 6) gs.ctm = matMul(gs.ctm, m);
        const bb = args[1] as ArrayLike<number> | null | undefined;
        if (bb && bb.length >= 4) {
          const r = transformBox(gs.ctm, bb[0], bb[1], bb[2], bb[3]);
          gs.clip = gs.clip ? intersectRect(gs.clip, r) : r;
        }
        break;
      }
      case "paintFormXObjectEnd": {
        const prev = stack.pop();
        if (prev) gs = prev;
        break;
      }
      case "setFillRGBColor":
        gs.fill = args[0];
        break;
      case "setStrokeRGBColor":
        gs.stroke = args[0];
        break;
      case "clip":
      case "eoClip":
        // pdfjs 的顺序是 clip 先来，随后那条 constructPath 的 paint 为 endPath，其路径即裁剪路径。
        pendingClip = true;
        break;
      case "paintImageXObject":
      case "paintImageMaskXObject": {
        const arg = args[0];
        const oid: string = arg && typeof arg === "object" ? arg.data : arg;
        // 图像 XObject 画在单位方内，经 ctm 铺开
        extras.images.push({ id: String(oid), ctm: [...gs.ctm] as Mat, bbox: transformBox(gs.ctm, 0, 0, 1, 1) });
        break;
      }
      case "shadingFill":
        extras.shadings.push({ ctm: [...gs.ctm] as Mat, bbox: gs.clip });
        break;
      case "showText":
      case "beginText":
        extras.hasText = true;
        break;
      case "constructPath": {
        const paint = (names[args[0]] ?? "endPath") as PaintOp;
        const data: Float32Array | undefined = args[1]?.[0];
        const minMax = args[2] as ArrayLike<number> | undefined;
        if (!data || !data.length) {
          if (paint === "endPath") pendingClip = false;
          break;
        }
        let x0: number, y0: number, x1: number, y1: number;
        if (minMax && minMax.length >= 4) {
          x0 = minMax[0];
          y0 = minMax[1];
          x1 = minMax[2];
          y1 = minMax[3];
        } else {
          const raw = pathBoundsRaw(data);
          if (!raw) break;
          x0 = raw.x0;
          y0 = raw.y0;
          x1 = raw.x1;
          y1 = raw.y1;
        }
        let bbox = transformBox(gs.ctm, x0, y0, x1, y1);

        if (paint === "endPath") {
          // 裁剪路径：只更新裁剪状态，不落墨
          if (pendingClip) {
            gs.clip = gs.clip ? intersectRect(gs.clip, bbox) : bbox;
            pendingClip = false;
          }
          break;
        }

        const dev = matScale(gs.ctm);
        const stroked = paint.toLowerCase().includes("stroke");
        const lw = gs.lineWidth * dev;
        if (stroked) {
          const half = lw / 2;
          bbox = { x: bbox.x - half, y: bbox.y - half, w: bbox.w + lw, h: bbox.h + lw };
        }

        // 裁剪：完全在框外的对象在原件上不可见，收进来就成了凭空多出的墨迹
        const clip = gs.clip ? intersectRect(gs.clip, pageRect) : null;
        if (applyClip && clip && !rectsOverlap(bbox, clip)) break;

        const st = pathStats(data);
        objs.push({
          id: id++,
          data,
          ctm: [...gs.ctm] as Mat,
          bbox,
          paint,
          curves: st.curves,
          segs: st.segs,
          lineWidth: lw,
          dash: gs.dash ? gs.dash.map((v) => v * dev) : null,
          dashPhase: gs.dashPhase * dev,
          fill: gs.fill,
          stroke: gs.stroke,
          clip,
        });
        break;
      }
      default:
        break;
    }
  }

  return {
    page: page.pageNumber ?? 0,
    width: viewport.width,
    height: viewport.height,
    rotation: viewport.rotation ?? 0,
    scale,
    objs,
    extras,
  };
}

/** OPS 数值 → 名字。pdfjs 的 fnArray 存的是数值。 */
export function opsNames(OPS: OpsEnum): Record<number, string> {
  const out: Record<number, string> = {};
  for (const k of Object.keys(OPS)) out[OPS[k]] = k;
  return out;
}

/**
 * 把多个对象的路径拼成**一条设备坐标下的路径**，用来把拆成偏旁的字合回一个字形。
 *
 * 转曲时左右结构的字有时会拆成两个 path（实测标题里的「祂」= 礻 + 也、歌词里的
 * 「像」= 亻 + 象）。拆着查字典只能查到右半边，于是「祂」读成「也」、「像」读成「象」。
 * 合并后各自的 ctm 已经烤进坐标，返回的对象 ctm 是单位阵。
 */
export function concatObjects(objs: VecObj[], id = -1): VecObj {
  const parts: number[] = [];
  for (const o of objs) {
    const d = o.data;
    let i = 0;
    while (i < d.length) {
      const c = d[i++];
      const n = drawOpArity(c);
      if (n < 0) break;
      parts.push(c);
      for (let k = 0; k < n; k += 2) {
        parts.push(matApplyX(o.ctm, d[i + k], d[i + k + 1]), matApplyY(o.ctm, d[i + k], d[i + k + 1]));
      }
      i += n;
    }
  }
  const b = emptyBox();
  for (const o of objs) {
    growBox(b, o.bbox.x, o.bbox.y);
    growBox(b, o.bbox.x + o.bbox.w, o.bbox.y + o.bbox.h);
  }
  const first = objs[0];
  return {
    ...first,
    id: id >= 0 ? id : first.id,
    data: new Float32Array(parts),
    ctm: [1, 0, 0, 1, 0, 0],
    bbox: boxToRect(b),
    curves: objs.reduce((a, o) => a + o.curves, 0),
    segs: objs.reduce((a, o) => a + o.segs, 0),
  };
}

// ── 接入现有识别管线 ────────────────────────────────────────────────────────

/** 粗略估算一条路径覆盖的墨迹面积（设备平方像素）。
 *  填充路径用多边形面积（贝塞尔按控制点折线近似，足够当 Component.area 用）；
 *  描边路径用周长 × 线宽。 */
function inkArea(o: VecObj): number {
  const m = o.ctm;
  const d = o.data;
  const filled = o.paint.toLowerCase().includes("fill");
  let i = 0;
  let sx = 0;
  let sy = 0;
  let px = 0;
  let py = 0;
  let started = false;
  let twice = 0; // 2× 有符号面积
  let perim = 0;
  const step = (x: number, y: number) => {
    const dx = matApplyX(m, x, y);
    const dy = matApplyY(m, x, y);
    if (started) {
      twice += px * dy - dx * py;
      perim += Math.hypot(dx - px, dy - py);
    }
    px = dx;
    py = dy;
    started = true;
  };
  while (i < d.length) {
    const c = d[i++];
    const n = drawOpArity(c);
    if (n < 0) break;
    if (c === DRAW_MOVE) {
      const x = d[i];
      const y = d[i + 1];
      started = false;
      step(x, y);
      sx = px;
      sy = py;
    } else if (c === DRAW_CLOSE) {
      if (started) {
        twice += px * sy - sx * py;
        perim += Math.hypot(sx - px, sy - py);
        px = sx;
        py = sy;
      }
    } else {
      for (let k = 0; k < n; k += 2) step(d[i + k], d[i + k + 1]);
    }
    i += n;
  }
  if (filled) return Math.abs(twice) / 2;
  return perim * Math.max(o.lineWidth, 0.5);
}

/** 矢量对象 → 现有识别管线吃的 `Component[]`。
 *
 * 这是矢量路接进 `jianpu.ts` 的关键接口：对象边界替代连通域，于是
 * `splitMergedOctaveDot` / `untangleBridged` / `mergedArcSplit` / `splitBlock`
 * 那几处拆粘连启发式在这条路上全部不需要。
 *
 * `minArea` 与 `connectedComponents` 的语义一致（前景像素数下限）。
 */
export function componentsFromVector(objs: VecObj[], minArea = 4): Component[] {
  const out: Component[] = [];
  for (const o of objs) {
    const area = inkArea(o);
    if (area < minArea) continue;
    const b = o.bbox;
    out.push({
      id: o.id,
      bbox: { x: Math.round(b.x), y: Math.round(b.y), w: Math.max(1, Math.round(b.w)), h: Math.max(1, Math.round(b.h)) },
      area: Math.round(area),
      cx: b.x + b.w / 2,
      cy: b.y + b.h / 2,
    });
  }
  return out;
}

// ── 判定 ────────────────────────────────────────────────────────────────────

/** 这份 PDF 是不是「文字转曲」的矢量谱：几乎没有文字层，且绝大多数算子是 constructPath。
 *  取样几页判断，不扫全书。 */
export async function isVectorPdf(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  OPS: OpsEnum,
  sampleCount = 5,
): Promise<boolean> {
  const names = opsNames(OPS);
  const n = doc.numPages as number;
  // 跳过封面/前言，从中段取样
  const picks: number[] = [];
  for (let k = 1; k <= sampleCount; k++) picks.push(Math.max(1, Math.min(n, Math.round((n * k) / (sampleCount + 1)))));
  let paths = 0;
  let ops = 0;
  let textItems = 0;
  for (const pn of picks) {
    const page = await doc.getPage(pn);
    const tc = await page.getTextContent();
    textItems += tc.items.length;
    const list = await page.getOperatorList();
    for (const fn of list.fnArray) {
      ops++;
      if (names[fn] === "constructPath") paths++;
    }
    page.cleanup?.();
  }
  if (ops === 0) return false;
  // 转曲页：文字层为空，且路径占比高（save/restore/transform 各占一份，故 ~1/4 起）
  return textItems === 0 && paths / ops > 0.15 && paths > 50 * picks.length;
}
