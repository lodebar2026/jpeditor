// 字节 → 灰度二值图（Binary）。**本文件不碰浏览器 API**：真正的解码交给注入的解码器
// （浏览器=`decode.browser.ts` 的 createImageBitmap/pdf.js；Node=`cli/omr.ts` 装的纯 JS 解码），
// 这里只管「超宽缩图 + 二值化」这两件与后端无关的事。
import { rgbaToBinary } from "./preprocess";
import { blit, createSurface } from "./surface";
import type { Binary } from "./types";

const MAX_W = 2200; // 过大图先缩小，兼顾速度与连通域稳定性

/** 解码结果：RGBA 像素（与 ImageData 同布局）。 */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type ImageDecoder = (bytes: Uint8Array, mime?: string) => Promise<RgbaImage>;
/** PDF → 整册竖向拼接的一张白底长图。Node 侧不提供（CLI 只吃位图）。 */
export type PdfRasterizer = (bytes: Uint8Array) => Promise<RgbaImage>;

let _decodeImage: ImageDecoder | null = null;
let _rasterizePdf: PdfRasterizer | null = null;

export function setImageDecoder(decode: ImageDecoder, pdf?: PdfRasterizer): void {
  _decodeImage = decode;
  _rasterizePdf = pdf ?? null;
}

/** 是否 PDF 字节（mime 或 %PDF- 魔数）。 */
export function isPdf(bytes: Uint8Array, mime?: string): boolean {
  if (mime === "application/pdf") return true;
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // "%PDF"
}

/** 超过 MAX_W 就等比缩小（面积平均，见 surface.ts）。 */
function fitWidth(img: RgbaImage): RgbaImage {
  if (img.width <= MAX_W) return img;
  const scale = MAX_W / img.width;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = createSurface(w, h);
  blit(out, { width: img.width, height: img.height, data: img.data },
    { x: 0, y: 0, w: img.width, h: img.height }, { x: 0, y: 0, w, h });
  return { data: out.data, width: w, height: h };
}

/** 图片 / PDF 字节 → 二值图（前景=墨迹=1）。 */
export async function decodeToBinary(bytes: Uint8Array, mime?: string): Promise<Binary> {
  if (isPdf(bytes, mime)) {
    if (!_rasterizePdf) throw new Error("此环境不支持 PDF 输入（只装了位图解码器）");
    const img = await _rasterizePdf(bytes);
    return rgbaToBinary(img.data, img.width, img.height);
  }
  if (!_decodeImage) throw new Error("未装配图片解码器：浏览器侧应 import omr/index，Node 侧见 cli/omr.ts");
  const img = fitWidth(await _decodeImage(bytes, mime));
  return rgbaToBinary(img.data, img.width, img.height);
}
