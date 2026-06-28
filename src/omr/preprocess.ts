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

/** 便捷：RGBA → Binary。 */
export function rgbaToBinary(rgba: Uint8ClampedArray, w: number, h: number): Binary {
  return binarize(toGray(rgba, w, h), w, h);
}
