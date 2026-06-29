// 灰度 + Otsu 二值化（移植 preprocess.cpp 思路：自适应阈值得到墨迹前景）。
import type { Binary } from "./types";

/** 从 RGBA 像素（ImageData.data）灰度化。 */
export function toGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    // Rec.601 luma
    g[i] = (rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114) | 0;
  }
  return g;
}

/** Otsu 全局阈值。 */
export function otsuThreshold(gray: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, max = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) { max = between; thr = t; }
  }
  return thr;
}

/** 灰度 → 二值（前景=暗像素=1）。 */
export function binarize(gray: Uint8Array, w: number, h: number, thr?: number): Binary {
  const t = thr ?? otsuThreshold(gray);
  const data = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = gray[i] <= t ? 1 : 0;
  return { w, h, data };
}

/** 取某通道（0=R,1=G,2=B）为灰度。 */
function channel(rgba: Uint8ClampedArray, n: number, c: number): Uint8Array {
  const g = new Uint8Array(n);
  for (let i = 0, p = c; i < n; i++, p += 4) g[i] = rgba[p];
  return g;
}

/** Otsu 的类间方差（越大说明该灰度图前景/背景分得越开），用于挑通道。 */
function otsuSeparation(gray: Uint8Array): number {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, max = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) max = between;
  }
  return max;
}

/**
 * Sauvola 局部自适应二值化：阈值随窗口内均值 m、标准差 sd 变化
 * `thr = m·(1 + k·(sd/R − 1))`。墨迹边缘 sd 大→阈值压低保细笔；
 * 平滑的水印/渐变底 sd 小→阈值贴近均值→被判背景。比全局 Otsu 抗低对比/底纹。
 */
function sauvola(gray: Uint8Array, w: number, h: number, win: number, k: number): Binary {
  const n = w * h;
  const sw = w + 1;
  const ii = new Float64Array(sw * (h + 1));
  const ii2 = new Float64Array(sw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      rs += v; rs2 += v * v;
      ii[(y + 1) * sw + (x + 1)] = ii[y * sw + (x + 1)] + rs;
      ii2[(y + 1) * sw + (x + 1)] = ii2[y * sw + (x + 1)] + rs2;
    }
  }
  const r = win >> 1;
  const R = 128; // 8 位灰度动态范围的一半
  const data = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s = ii[(y1 + 1) * sw + (x1 + 1)] - ii[y0 * sw + (x1 + 1)] - ii[(y1 + 1) * sw + x0] + ii[y0 * sw + x0];
      const s2 = ii2[(y1 + 1) * sw + (x1 + 1)] - ii2[y0 * sw + (x1 + 1)] - ii2[(y1 + 1) * sw + x0] + ii2[y0 * sw + x0];
      const m = s / cnt;
      const sd = Math.sqrt(Math.max(0, s2 / cnt - m * m));
      const thr = m * (1 + k * (sd / R - 1));
      data[y * w + x] = gray[y * w + x] <= thr ? 1 : 0;
    }
  }
  return { w, h, data };
}

/**
 * 便捷：RGBA → Binary。
 * 先按「类间方差」从 R/G/B/luma 中挑分得最开的通道（暖色/泛黄扫描里墨迹吸蓝，
 * 蓝通道对比最高；纯黑白稿四通道一致退化为 luma），再走 Sauvola 局部阈值。
 */
export function rgbaToBinary(rgba: Uint8ClampedArray, w: number, h: number): Binary {
  const n = w * h;
  const cands: Uint8Array[] = [
    toGray(rgba, w, h),
    channel(rgba, n, 0),
    channel(rgba, n, 1),
    channel(rgba, n, 2),
  ];
  let best = cands[0], bestSep = -1;
  for (const g of cands) {
    const sep = otsuSeparation(g);
    if (sep > bestSep) { bestSep = sep; best = g; }
  }
  // 窗口约取图像短边的 1/30（取奇数），覆盖一个字号又不至于退化成全局阈值。
  const win = Math.max(15, (Math.round(Math.min(w, h) / 30) | 1));
  return sauvola(best, w, h, win, 0.2);
}
