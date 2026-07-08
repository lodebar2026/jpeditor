// 浏览器侧图片解码：图片字节 → 灰度二值图（Binary）。
// 用 createImageBitmap + OffscreenCanvas（与 SVG 渲染同属浏览器引擎，无需原生依赖）。
// PDF（矢量乐谱，如 Sibelius/MuseScore 导出）经 pdf.js 光栅化为高分辨率位图再走同一路径。
import { rgbaToBinary } from "./preprocess";
import type { Binary } from "./types";

const MAX_W = 2200; // 过大图先缩小，兼顾速度与连通域稳定性
const PDF_W = 2000; // PDF 光栅化目标宽度（矢量图放大到此宽度取墨迹）

/** 是否 PDF 字节（mime 或 %PDF- 魔数）。 */
function isPdf(bytes: Uint8Array, mime?: string): boolean {
  if (mime === "application/pdf") return true;
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // "%PDF"
}

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

function newCanvas(w: number, h: number): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
  const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 画布上下文");
  return { canvas, ctx };
}

/** 取本页最大的一张内嵌位图（其解码后的 ImageBitmap）。多为扫描版乐谱整页图；无则返回 null。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function largestPageBitmap(page: any, OPS: any): Promise<ImageBitmap | null> {
  const list = await page.getOperatorList();
  let best: { bmp: ImageBitmap; area: number } | null = null;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    if (fn !== OPS.paintImageXObject && fn !== OPS.paintImageMaskXObject) continue;
    const arg = list.argsArray[i][0];
    // ImageMask 的参数是 { data: <objId>, ... }；普通图 XObject 的参数是字符串对象名。
    const id: string = arg && typeof arg === "object" ? arg.data : arg;
    if (typeof id !== "string") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = await new Promise((r) => page.objs.get(id, r)).catch(() => null);
    const bmp: ImageBitmap | undefined = obj?.bitmap;
    if (!bmp) continue; // 非位图（少见的按 kind 打包的数据）留给整页渲染兜底
    const area = bmp.width * bmp.height;
    if (!best || area > best.area) best = { bmp, area };
  }
  return best?.bmp ?? null;
}

/** 单页 → 白底画布：优先直接抽取内嵌位图（源本就是 1-bit 扫描图，避免整页矢量合成重画、
 *  并顺带甩掉赞美诗页码/栏目标题等叠加文字）；页面纯矢量（无内嵌图）时退回整页渲染。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pdfPageToCanvas(page: any, OPS: any): Promise<OffscreenCanvas> {
  const bmp = await largestPageBitmap(page, OPS);
  if (bmp) {
    const scale = bmp.width > PDF_W ? PDF_W / bmp.width : 1;
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const { canvas, ctx } = newCanvas(w, h);
    ctx.fillStyle = "#fff"; // ImageMask 只有墨迹为不透明黑、其余透明 → 铺白底
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    return canvas;
  }
  const viewport = page.getViewport({ scale: PDF_W / page.getViewport({ scale: 1 }).width });
  const w = Math.round(viewport.width);
  const h = Math.round(viewport.height);
  const { canvas, ctx } = newCanvas(w, h);
  ctx.fillStyle = "#fff"; // PDF 背景透明 → 铺白底，二值化才认得墨迹
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** PDF 字节 → ImageData：逐页取图后竖向拼接为一张白底长图。 */
async function pdfToImageData(bytes: Uint8Array): Promise<ImageData> {
  const pdfjs = await import("pdfjs-dist");
  // worker 由 Vite `?url` 解析为同源资源 URL（离线自包含，dev/build 一致）。
  const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  // pdf.js v6 的位图解码器（jbig2.wasm 兼管 CCITTFax G4、openjpeg 管 JPEG2000）需显式指明
  // wasm 目录，否则内嵌位图（如扫描版乐谱的 1-bit ImageMask）会被静默丢弃、页面只剩矢量文字。
  // 目录随 public/redist/ 一起部署，离线自包含。
  const wasmUrl = `${import.meta.env.BASE_URL}redist/pdfjs/`;

  // getDocument 会 detach 传入的 buffer，复制一份避免污染调用方字节。
  const data = bytes.slice();
  const pdf = await pdfjs.getDocument({ data, wasmUrl }).promise;

  const pages: OffscreenCanvas[] = [];
  let totalH = 0;
  let maxW = 1;
  for (let i = 1; i <= pdf.numPages; i++) {
    const canvas = await pdfPageToCanvas(await pdf.getPage(i), pdfjs.OPS);
    pages.push(canvas);
    totalH += canvas.height;
    maxW = Math.max(maxW, canvas.width);
  }

  const { ctx: octx } = newCanvas(maxW, totalH);
  octx.fillStyle = "#fff";
  octx.fillRect(0, 0, maxW, totalH);
  let y = 0;
  for (const c of pages) {
    octx.drawImage(c, 0, y);
    y += c.height;
  }
  return octx.getImageData(0, 0, maxW, Math.max(1, totalH));
}

/** 图片/ PDF 字节 → 二值图（前景=墨迹=1）。 */
export async function decodeToBinary(bytes: Uint8Array, mime?: string): Promise<Binary> {
  const img = isPdf(bytes, mime) ? await pdfToImageData(bytes) : await decodeToImageData(bytes, mime);
  return rgbaToBinary(img.data, img.width, img.height);
}
