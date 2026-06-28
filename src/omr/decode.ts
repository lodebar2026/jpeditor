// 浏览器侧图片解码：图片字节 → 灰度二值图（Binary）。
// 用 createImageBitmap + OffscreenCanvas（与 SVG 渲染同属浏览器引擎，无需原生依赖）。
import { rgbaToBinary } from "./preprocess";
import type { Binary } from "./types";

const MAX_W = 2200; // 过大图先缩小，兼顾速度与连通域稳定性

/** 图片字节 → ImageData（缩放到 MAX_W 以内）。 */
async function decodeToImageData(bytes: Uint8Array, mime?: string): Promise<ImageData> {
  const blob = new Blob([bytes as BlobPart], mime ? { type: mime } : undefined);
  const bmp = await createImageBitmap(blob);
  const scale = bmp.width > MAX_W ? MAX_W / bmp.width : 1;
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

/** 图片字节 → 二值图（前景=墨迹=1）。 */
export async function decodeToBinary(bytes: Uint8Array, mime?: string): Promise<Binary> {
  const img = await decodeToImageData(bytes, mime);
  return rgbaToBinary(img.data, img.width, img.height);
}
