// OMR 用的极简像素表面：替掉 OffscreenCanvas，让整条识别管线能脱离浏览器跑（Node CLI）。
//
// 管线里 OffscreenCanvas 只被当成五件事用：建一块 w×h 缓冲、铺白底、按矩形缩放贴图、
// 读回 RGBA、量宽高。这里就只提供这五件事——**不是 canvas 的替代品**，别往里加绘图 API。
//
// ## 为什么自己写重采样，而不是留给 drawImage
// 缩放结果直接就是 rec/det 的输入张量，浏览器与 Node 若用不同的重采样，两端识别结果会分叉，
// 精度基线也得各维护一套。故两端统一走本文件：**缩小用面积平均(box)、放大用双线性**。
// 缩小必须是面积平均而非朴素双线性——朴素双线性在缩小时只采样两个点，细笔画会整根丢失
// （歌词条常缩到原高的 1/3 以下），box 才是浏览器 drawImage 下采样的等价物。
//
// 数据一律 RGBA（与 ImageData 同布局），虽然 OMR 全程是灰度图——保持同布局才能让浏览器侧
// 与 ImageData 零拷贝互转。
import type { Binary, Rect } from "./types";

export interface Surface {
  readonly width: number;
  readonly height: number;
  /** RGBA，长度 width*height*4。与 ImageData.data 同布局。 */
  readonly data: Uint8ClampedArray;
}

/** 建一块表面。`fill` 是灰度值（默认 255=白底），alpha 恒为 255。 */
export function createSurface(w: number, h: number, fill = 255): Surface {
  const width = Math.max(1, Math.round(w)), height = Math.max(1, Math.round(h));
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255); // 含 alpha
  if (fill !== 255) for (let p = 0; p < data.length; p += 4) { data[p] = data[p + 1] = data[p + 2] = fill; }
  return { width, height, data };
}

/** 整幅二值图 → 黑字白底表面（前景 1 → 黑）。供逐格/逐条裁剪。 */
export function surfaceFromBinary(bin: Binary): Surface {
  const s = createSurface(bin.w, bin.h);
  const d = s.data;
  for (let i = 0; i < bin.data.length; i++) {
    const v = bin.data[i] ? 0 : 255;
    const p = i * 4;
    d[p] = d[p + 1] = d[p + 2] = v;
  }
  return s;
}

/** 一趟一维重采样的权重表：目标像素 i ← 源区间 [start, start+w.length) 的加权和。 */
interface Taps { start: Int32Array; wts: Float32Array; n: number }

/** 建一维权重表。srcLen→dstLen，源起点 s0（可为小数）、源跨度 span。
 *  缩小（span/dstLen > 1）用面积平均：每个目标像素覆盖源上一段区间，按覆盖长度加权；
 *  放大用双线性：取相邻两源像素按小数位加权。两者都 clamp 到 [0, lim-1]。 */
function buildTaps(dstLen: number, s0: number, span: number, lim: number): Taps {
  const scale = span / dstLen;
  if (scale > 1) {
    const n = Math.ceil(scale) + 1; // 每个目标像素最多覆盖 ceil(scale)+1 个源像素
    const start = new Int32Array(dstLen);
    const wts = new Float32Array(dstLen * n);
    for (let i = 0; i < dstLen; i++) {
      const a = s0 + i * scale, b = a + scale;
      const i0 = Math.floor(a);
      start[i] = i0;
      let sum = 0;
      for (let k = 0; k < n; k++) {
        const x = i0 + k;
        const w = Math.max(0, Math.min(b, x + 1) - Math.max(a, x)); // 与源像素 [x,x+1) 的重叠长度
        wts[i * n + k] = w; sum += w;
      }
      if (sum > 0) for (let k = 0; k < n; k++) wts[i * n + k] /= sum;
    }
    clampStarts(start, n, lim);
    return { start, wts, n };
  }
  const n = 2;
  const start = new Int32Array(dstLen);
  const wts = new Float32Array(dstLen * n);
  for (let i = 0; i < dstLen; i++) {
    const c = s0 + (i + 0.5) * scale - 0.5; // 目标像素中心映回源坐标
    const i0 = Math.floor(c), f = c - i0;
    start[i] = i0;
    wts[i * n] = 1 - f; wts[i * n + 1] = f;
  }
  clampStarts(start, n, lim);
  return { start, wts, n };
}

/** 把 tap 起点夹进 [0, lim-n]，越界处退化为重复边缘像素（等价 clamp 采样）。 */
function clampStarts(start: Int32Array, n: number, lim: number): void {
  for (let i = 0; i < start.length; i++) {
    if (start[i] < 0) start[i] = 0;
    else if (start[i] + n > lim) start[i] = Math.max(0, lim - n);
  }
}

/**
 * 把 src 的源矩形缩放画到 dst 的目标矩形（等价 `ctx.drawImage(src, sx,sy,sw,sh, dx,dy,dw,dh)`）。
 * 分离式两趟（先横后纵），源矩形越界自动裁到图内。
 */
export function blit(dst: Surface, src: Surface, s: Rect, d: Rect): void {
  const sx = Math.max(0, s.x), sy = Math.max(0, s.y);
  const sw = Math.min(src.width - sx, s.w), sh = Math.min(src.height - sy, s.h);
  const dx = Math.round(d.x), dy = Math.round(d.y);
  const dw = Math.max(1, Math.round(d.w)), dh = Math.max(1, Math.round(d.h));
  if (sw <= 0 || sh <= 0) return;

  const tx = buildTaps(dw, sx, sw, src.width);
  const ty = buildTaps(dh, sy, sh, src.height);

  // 第一趟：横向重采样到 [dw × sh 覆盖的源行范围]，只算目标需要的源行（ty 涉及的行）。
  const row0 = ty.start[0];
  const rowN = ty.start[dh - 1] + ty.n - row0;
  const mid = new Float32Array(dw * rowN * 3); // 中间缓冲只留 RGB（alpha 恒 255）
  for (let y = 0; y < rowN; y++) {
    const sRow = (row0 + y) * src.width * 4;
    const mRow = y * dw * 3;
    for (let i = 0; i < dw; i++) {
      const st = tx.start[i];
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < tx.n; k++) {
        const w = tx.wts[i * tx.n + k];
        if (!w) continue;
        const p = sRow + (st + k) * 4;
        r += src.data[p] * w; g += src.data[p + 1] * w; b += src.data[p + 2] * w;
      }
      mid[mRow + i * 3] = r; mid[mRow + i * 3 + 1] = g; mid[mRow + i * 3 + 2] = b;
    }
  }

  // 第二趟：纵向重采样并写入 dst。
  for (let j = 0; j < dh; j++) {
    const oy = dy + j;
    if (oy < 0 || oy >= dst.height) continue;
    const st = ty.start[j] - row0;
    for (let i = 0; i < dw; i++) {
      const ox = dx + i;
      if (ox < 0 || ox >= dst.width) continue;
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < ty.n; k++) {
        const w = ty.wts[j * ty.n + k];
        if (!w) continue;
        const m = ((st + k) * dw + i) * 3;
        r += mid[m] * w; g += mid[m + 1] * w; b += mid[m + 2] * w;
      }
      const p = (oy * dst.width + ox) * 4;
      dst.data[p] = r; dst.data[p + 1] = g; dst.data[p + 2] = b; dst.data[p + 3] = 255;
    }
  }
}
