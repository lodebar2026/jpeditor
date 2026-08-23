// 字形字典：把矢量字形按轮廓聚类，一个形状只认一次。
//
// 转曲 PDF 没有文字层，但同一个字在整本书里的轮廓坐标**逐位相同**（同一套字体、
// 同一个字号，排版软件转曲时输出同一串坐标）。于是：
//   全书 30 万个字形 → 约 1.7 万个形状类 → 只需给这 1.7 万类各定一次字符。
// 识别时是纯查表，**不跑任何 OCR 推理**。
//
// 两级匹配：
//   shapeKey —— 轮廓按 bbox 归一 + 量化后的精确哈希。O(1)，覆盖绝大多数。
//   shapeSig —— 归一轮廓栅格化成 32×32 位图签名，给精确键落空的长尾做最近邻。
//
// 无 DOM 依赖（栅格化是自己写的扫描线填充，不用 canvas）。
import type { VecObj } from "./vector";
import { DRAW_CLOSE, DRAW_CUBIC, DRAW_LINE, DRAW_MOVE, DRAW_QUAD, drawOpArity } from "./vector";

/** 归一量化的格数。50 是实测选出来的：再细会把同字的坐标抖动拆成不同类，
 *  再粗会把形近字（日/曰、己/已）并到一起。 */
export const QUANT = 50;

/** 32 位 hash 两条（djb2 / sdbm）拼成一个键，避免 1.7 万类里撞车。 */
function hash2(s: string): string {
  let a = 5381;
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = ((a << 5) + a + c) | 0;
    b = (c + (b << 6) + (b << 16) - b) | 0;
  }
  return ((a >>> 0).toString(36) + "-" + (b >>> 0).toString(36));
}

/** 路径的紧包围盒（路径自身坐标系）。 */
function rawBounds(data: Float32Array): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let i = 0;
  let any = false;
  while (i < data.length) {
    const n = drawOpArity(data[i++]);
    if (n < 0) break;
    for (let k = 0; k < n; k += 2) {
      const x = data[i + k];
      const y = data[i + k + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      any = true;
    }
    i += n;
  }
  return any ? { x0, y0, x1, y1 } : null;
}

/**
 * 形状键：把轮廓平移到原点、按**高度**归一到 QUANT 格、坐标取整后哈希。
 *
 * 按高度而不是按宽高各自归一——后者会把「一」和「口」压成同一形状。
 */
export function shapeKey(data: Float32Array): string {
  const b = rawBounds(data);
  if (!b) return "empty";
  const h = b.y1 - b.y0 || 1;
  const s = QUANT / h;
  const parts: (number | string)[] = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    const n = drawOpArity(c);
    if (n < 0) break;
    parts.push(c);
    for (let k = 0; k < n; k += 2) {
      parts.push(Math.round((data[i + k] - b.x0) * s), Math.round((data[i + k + 1] - b.y0) * s));
    }
    i += n;
  }
  return hash2(parts.join(","));
}

/** 签名位图边长。32×32 = 128 字节，够区分汉字，又不至于放大坐标抖动。 */
export const SIG_N = 32;

/** 把路径压平成折线轮廓（贝塞尔按固定细分），返回若干闭合环。 */
function flatten(data: Float32Array, steps = 6): number[][] {
  const rings: number[][] = [];
  let cur: number[] = [];
  let px = 0;
  let py = 0;
  let sx = 0;
  let sy = 0;
  const push = (x: number, y: number) => {
    cur.push(x, y);
    px = x;
    py = y;
  };
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    const n = drawOpArity(c);
    if (n < 0) break;
    if (c === DRAW_MOVE) {
      if (cur.length >= 6) rings.push(cur);
      cur = [];
      sx = data[i];
      sy = data[i + 1];
      push(sx, sy);
    } else if (c === DRAW_LINE) {
      push(data[i], data[i + 1]);
    } else if (c === DRAW_CUBIC) {
      const x0 = px;
      const y0 = py;
      for (let t = 1; t <= steps; t++) {
        const u = t / steps;
        const v = 1 - u;
        const x =
          v * v * v * x0 + 3 * v * v * u * data[i] + 3 * v * u * u * data[i + 2] + u * u * u * data[i + 4];
        const y =
          v * v * v * y0 + 3 * v * v * u * data[i + 1] + 3 * v * u * u * data[i + 3] + u * u * u * data[i + 5];
        push(x, y);
      }
    } else if (c === DRAW_QUAD) {
      const x0 = px;
      const y0 = py;
      for (let t = 1; t <= steps; t++) {
        const u = t / steps;
        const v = 1 - u;
        push(v * v * x0 + 2 * v * u * data[i] + u * u * data[i + 2], v * v * y0 + 2 * v * u * data[i + 1] + u * u * data[i + 3]);
      }
    } else if (c === DRAW_CLOSE) {
      if (cur.length >= 6) {
        rings.push(cur);
        cur = [];
        push(sx, sy);
        cur = [];
      }
    }
    i += n;
  }
  if (cur.length >= 6) rings.push(cur);
  return rings;
}

/**
 * 形状签名：归一轮廓栅格化成 SIG_N×SIG_N 位图（非零环绕填充）。
 * 给精确键落空的长尾做最近邻用（汉明距离）。自己写扫描线，不依赖 canvas。
 */
export function shapeSig(data: Float32Array): Uint8Array {
  const sig = new Uint8Array(SIG_N * SIG_N);
  const b = rawBounds(data);
  if (!b) return sig;
  const w = b.x1 - b.x0 || 1;
  const h = b.y1 - b.y0 || 1;
  const sc = (SIG_N - 2) / Math.max(w, h);
  const ox = (SIG_N - w * sc) / 2;
  const oy = (SIG_N - h * sc) / 2;
  const rings = flatten(data).map((r) => {
    const o: number[] = [];
    for (let i = 0; i < r.length; i += 2) o.push((r[i] - b.x0) * sc + ox, (r[i + 1] - b.y0) * sc + oy);
    return o;
  });
  for (let py = 0; py < SIG_N; py++) {
    const y = py + 0.5;
    // 非零环绕：收集交点及其方向
    const xs: { x: number; dir: number }[] = [];
    for (const r of rings) {
      for (let i = 0; i < r.length; i += 2) {
        const x1 = r[i];
        const y1 = r[i + 1];
        const x2 = r[(i + 2) % r.length];
        const y2 = r[(i + 3) % r.length];
        if (y1 === y2) continue;
        if (y >= Math.min(y1, y2) && y < Math.max(y1, y2)) {
          xs.push({ x: x1 + ((y - y1) / (y2 - y1)) * (x2 - x1), dir: y2 > y1 ? 1 : -1 });
        }
      }
    }
    if (!xs.length) continue;
    xs.sort((a, c) => a.x - c.x);
    let wind = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      wind += xs[k].dir;
      if (wind === 0) continue;
      const from = Math.max(0, Math.ceil(xs[k].x - 0.5));
      const to = Math.min(SIG_N - 1, Math.floor(xs[k + 1].x - 0.5));
      for (let px = from; px <= to; px++) sig[py * SIG_N + px] = 1;
    }
  }
  return sig;
}

export function sigDistance(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** 一个形状类。 */
export interface GlyphClass {
  key: string;
  /** 指派的字符（未定为 null）。 */
  char: string | null;
  /** 标注来源，可信度依次递减。 */
  source: "font" | "gt" | "ocr" | "manual" | null;
  /** 实例数。 */
  count: number;
  /** 轮廓高度中位数（用来分族）。 */
  h: number;
  w: number;
  /** 代表实例的 SVG path（路径自身坐标系），供渲染核对与重排取原字形。 */
  d: string;
  /** 32×32 签名，base64。 */
  sig?: string;
}

export interface GlyphDict {
  book: string;
  quant: number;
  classes: Record<string, GlyphClass>;
}

export function encodeSig(sig: Uint8Array): string {
  let s = "";
  for (let i = 0; i < sig.length; i += 8) {
    let byte = 0;
    for (let k = 0; k < 8; k++) if (sig[i + k]) byte |= 1 << k;
    s += String.fromCharCode(byte);
  }
  // 纯 ASCII base64（Node 与浏览器都有 btoa/Buffer，这里手写避免环境差异）
  return toBase64(s);
}

export function decodeSig(b64: string): Uint8Array {
  const s = fromBase64(b64);
  const sig = new Uint8Array(SIG_N * SIG_N);
  for (let i = 0; i < s.length; i++) {
    const byte = s.charCodeAt(i);
    for (let k = 0; k < 8; k++) sig[i * 8 + k] = (byte >> k) & 1;
  }
  return sig;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i);
    const b = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    const c = i + 2 < s.length ? s.charCodeAt(i + 2) : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < s.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < s.length ? B64[c & 63] : "=";
  }
  return out;
}
function fromBase64(s: string): string {
  let out = "";
  const clean = s.replace(/=+$/, "");
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0) << 6) |
      (i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0);
    out += String.fromCharCode((n >> 16) & 255);
    if (i + 2 < clean.length) out += String.fromCharCode((n >> 8) & 255);
    if (i + 3 < clean.length) out += String.fromCharCode(n & 255);
  }
  return out;
}

/** 建字典：把一批对象聚成形状类（不做标注）。 */
export function buildClasses(objs: Iterable<VecObj>, dict?: GlyphDict): GlyphDict {
  const d: GlyphDict = dict ?? { book: "unknown", quant: QUANT, classes: {} };
  for (const o of objs) {
    const key = shapeKey(o.data);
    const c = d.classes[key];
    if (c) {
      c.count++;
      continue;
    }
    d.classes[key] = {
      key,
      char: null,
      source: null,
      count: 1,
      h: o.bbox.h,
      w: o.bbox.w,
      d: "",
    };
  }
  return d;
}

/** 查表：形状 → 字符。精确键优先，落空再用签名找最近邻。 */
export class GlyphIndex {
  private byKey = new Map<string, GlyphClass>();
  private sigs: { cls: GlyphClass; sig: Uint8Array }[] = [];

  constructor(dict?: GlyphDict) {
    if (dict) this.load(dict);
  }

  load(dict: GlyphDict): void {
    for (const c of Object.values(dict.classes)) {
      this.byKey.set(c.key, c);
      if (c.sig && c.char) this.sigs.push({ cls: c, sig: decodeSig(c.sig) });
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  /** 精确查。 */
  lookup(data: Float32Array): GlyphClass | null {
    return this.byKey.get(shapeKey(data)) ?? null;
  }

  /** 模糊查：签名最近邻，超过 maxDist 返回 null。 */
  lookupFuzzy(data: Float32Array, maxDist = SIG_N * SIG_N * 0.06): { cls: GlyphClass; dist: number } | null {
    const exact = this.lookup(data);
    if (exact?.char) return { cls: exact, dist: 0 };
    if (!this.sigs.length) return null;
    const sig = shapeSig(data);
    let best: { cls: GlyphClass; dist: number } | null = null;
    for (const s of this.sigs) {
      const dist = sigDistance(sig, s.sig);
      if (!best || dist < best.dist) best = { cls: s.cls, dist };
    }
    return best && best.dist <= maxDist ? best : null;
  }

  /** 读出一个对象的字符（读不出返回 null）。 */
  charOf(o: VecObj): string | null {
    return this.lookup(o.data)?.char ?? null;
  }
}
