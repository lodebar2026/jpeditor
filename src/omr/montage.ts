// 把若干数字 bbox 裁剪、按网格(多行多列)拼成 PNG（白底黑字、每格居中、带分隔线），
// 供一次性 OCR。网格(而非单行长条)保证每个数字够大可读，且整图尺寸可控
// （修复初版把上百个数字塞进一条 ~2 万像素长条 → Gemini 读不动/超时 → 整列读成 0 的 bug）。
// 读取顺序：从左到右、从上到下。
import type { Binary, Rect } from "./types";
import { rright, rbottom } from "./types";

export interface Montage {
  png: Uint8Array;
  count: number;
  cols: number;
  cell: number;
}

/** 生成网格 montage PNG。cols=每行格数，cell=单格边长，pad=格内留白。无 rects 返回 null。 */
export async function buildMontage(bin: Binary, rects: Rect[], cols = 12, cell = 56, pad = 8): Promise<Montage | null> {
  if (!rects.length) return null;
  const n = rects.length;
  const ncols = Math.min(cols, n);
  const nrows = Math.ceil(n / ncols);
  const sep = 2; // 格间分隔线宽
  const W = ncols * cell + (ncols - 1) * sep;
  const H = nrows * cell + (nrows - 1) * sep;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);

  // 整幅二值图先转 RGBA 一次，便于逐格采样。
  const full = new ImageData(bin.w, bin.h);
  for (let i = 0; i < bin.data.length; i++) {
    const v = bin.data[i] ? 0 : 255; // 前景(1)→黑(0)，背景→白
    const p = i * 4;
    full.data[p] = full.data[p + 1] = full.data[p + 2] = v;
    full.data[p + 3] = 255;
  }
  const srcCanvas = new OffscreenCanvas(bin.w, bin.h);
  const srcCtx = srcCanvas.getContext("2d");
  if (!srcCtx) throw new Error("无法创建源画布上下文");
  srcCtx.putImageData(full, 0, 0);

  const inner = cell - pad * 2;
  // 网格分隔线
  ctx.fillStyle = "#ccc";
  for (let cx = 1; cx < ncols; cx++) ctx.fillRect(cx * (cell + sep) - sep, 0, sep, H);
  for (let cy = 1; cy < nrows; cy++) ctx.fillRect(0, cy * (cell + sep) - sep, W, sep);

  for (let i = 0; i < n; i++) {
    const r = rects[i];
    const sx = Math.max(0, r.x), sy = Math.max(0, r.y);
    const sw = Math.min(bin.w, rright(r)) - sx;
    const sh = Math.min(bin.h, rbottom(r)) - sy;
    if (sw <= 0 || sh <= 0) continue;
    const col = i % ncols, row = (i / ncols) | 0;
    // 等比缩放到 inner×inner 内并居中
    const scale = Math.min(inner / sw, inner / sh);
    const dw = sw * scale, dh = sh * scale;
    const dx = col * (cell + sep) + (cell - dw) / 2;
    const dy = row * (cell + sep) + (cell - dh) / 2;
    ctx.drawImage(srcCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const png = new Uint8Array(await blob.arrayBuffer());
  return { png, count: n, cols: ncols, cell };
}
