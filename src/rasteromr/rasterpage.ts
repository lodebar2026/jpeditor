// 位图五线谱识别的**取图层**：PDF 页 → `Binary`（1 = 墨）。
//
// ## 为什么不用 `src/omr/decode.ts`
//
// 那条路是给简谱的光栅路写的，两点不合用：
//   1. 它靠 `OffscreenCanvas`，**浏览器专属**；本模块要能进 `src/cli/index.ts`
//      那条纯 Node 链（回归循环全书几秒钟，起浏览器就没这个速度了）。
//   2. 它把整页缩到 `PDF_W = 2000` 宽。合唱谱这批底本原始就是 1917 px 宽、
//      线距 18.2 px——再缩一道线距掉到个位数，符头与谱线就分不开了。
//      位图路**按原始像素识别**，一格都不缩。
//
// ## pdf.js 在 Node 下给的是什么
//
// 这批 PDF 把整页乐谱当一张 1-bit CCITT 的 ImageMask 贴进内容流。
// Node 下 `page.objs.get(id)` 直接返回 `{ data, width, height }`——
// `data` 是**逐行 1-bit 打包**的字节（每行 `ceil(w/8)` 字节，行首字节对齐），
// 不是 `ImageBitmap`。于是解包一遍就完事，**不需要 canvas、不需要 wasm 之外的任何东西**。
//
// **极性**：ImageMask 里置位的是「盖住的地方」= 墨；`Binary` 的约定也是 1 = 墨，
// 正好对上。但 pdf.js 会照 `/Decode` 数组翻转，翻没翻只有量了才知道——
// 所以取完图按「墨迹占比」自检一次：整页乐谱的墨不可能过半（实测约一成），
// 过半就是翻了，整幅取反。
import type { Binary } from "../omr/types";
import { otsuThreshold } from "../omr/preprocess";

/** 一页取到的位图，连同它在页面坐标里的位置（识别坐标 ↔ 页面坐标要用）。 */
export interface RasterPage {
  bin: Binary;
  /** 位图像素 → PDF 页面点的缩放（页宽 / 位图宽）。 */
  scale: number;
  /** 页面尺寸（PDF 点）。 */
  pageWidth: number;
  pageHeight: number;
}

/** 墨迹占比超过这个数就判定极性反了。整页乐谱实测约一成，留足余量。 */
const INK_FLIP_RATIO = 0.5;

/**
 * 取这一页最大的那张内嵌位图。多为整页乐谱图；一张都没有（纯矢量页）返回 null
 * ——那种页面该走 `src/staffomr/` 的矢量路，不该到这儿来。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function rasterizePage(page: any, OPS: any): Promise<RasterPage | null> {
  const list = await page.getOperatorList();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let best: any = null;
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    if (fn !== OPS.paintImageXObject && fn !== OPS.paintImageMaskXObject) continue;
    const arg = list.argsArray[i][0];
    // ImageMask 的参数是 `{ data: <objId>, … }`；普通图 XObject 的参数是对象名字符串
    const id: string = arg && typeof arg === "object" ? arg.data : arg;
    if (typeof id !== "string") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj: any = await new Promise((r) => page.objs.get(id, r)).catch(() => null);
    if (!obj?.data || !obj.width || !obj.height) continue;
    if (!best || obj.width * obj.height > best.width * best.height) best = obj;
  }
  if (!best) return null;

  const w: number = best.width;
  const h: number = best.height;
  const bin = decodeImage(best, w, h);
  if (!bin) return null;

  // **极性自检**：ImageMask 里置位的是墨，`kind: 1`（GRAYSCALE_1BPP）里置位的是白，
  // 而 `/Decode` 还能把两者都翻过来——翻没翻只有量了才知道。
  // 整页乐谱的墨不可能过半（实测约一成），过半就是反的，整幅取反。
  let ink = 0;
  for (let i = 0; i < bin.data.length; i++) ink += bin.data[i];
  if (ink > w * h * INK_FLIP_RATIO) for (let i = 0; i < bin.data.length; i++) bin.data[i] ^= 1;

  const vp = page.getViewport({ scale: 1 });
  return { bin, scale: vp.width / w, pageWidth: vp.width, pageHeight: vp.height };
}

/**
 * pdf.js 给的原始像素 → `Binary`。**三种形态都要认**，认错就是一幅噪声，
 * 而且不报错——这正是要防的那种静默失败。
 *
 *   - **ImageMask**（无 `kind`）：逐行 1-bit 打包，置位 = 盖住 = 墨。合唱谱这批就是它。
 *   - **`kind: 1`（GRAYSCALE_1BPP）**：同样是逐行 1-bit 打包，但置位 = 白。
 *     Fuji Xerox 扫出来的那份是它。极性交给调用方的自检翻。
 *   - **`kind: 2` / `3`（RGB_24BPP / RGBA_32BPP）**：每像素 3 / 4 字节，
 *     要先算亮度再 Otsu。手机拍/JPEG 扫的那份是它。
 *
 * 靠**数据长度**认，不靠 `kind`：ImageMask 根本没有 `kind`，
 * 而长度是三者唯一都给得出、且互不相同的量。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function decodeImage(obj: any, w: number, h: number): Binary | null {
  const src: Uint8Array | Uint8ClampedArray = obj.data;
  const data = new Uint8Array(w * h);
  const packed = Math.ceil(w / 8) * h;
  if (src.length === packed) {
    // 逐行 1-bit 打包。**行首字节对齐**：行末不足 8 位的那几位是填充，不能顺着读下去。
    const stride = Math.ceil(w / 8);
    for (let y = 0; y < h; y++) {
      const row = y * stride;
      const out = y * w;
      for (let x = 0; x < w; x++) data[out + x] = (src[row + (x >> 3)] >> (7 - (x & 7))) & 1;
    }
    return { w, h, data };
  }
  const step = src.length === w * h * 4 ? 4 : src.length === w * h * 3 ? 3 : src.length === w * h ? 1 : 0;
  if (!step) return null;
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += step) {
    // Rec.601 luma（与 `src/omr/preprocess.ts::toGray` 同一口径）
    gray[i] = step === 1 ? src[p] : (src[p] * 0.299 + src[p + 1] * 0.587 + src[p + 2] * 0.114) | 0;
  }
  const t = otsuThreshold(gray);
  for (let i = 0; i < gray.length; i++) data[i] = gray[i] <= t ? 1 : 0; // 暗 = 墨
  return { w, h, data };
}

/** 墨迹占比。取完图自检、判「这一页是不是空页」都用它。 */
export function inkRatio(bin: Binary): number {
  let n = 0;
  for (let i = 0; i < bin.data.length; i++) n += bin.data[i];
  return n / (bin.w * bin.h);
}

/** 把 `Binary` 存成 PGM（P5，1 字节灰度）。排查用——PGM 谁都打得开，不引图像库。 */
export function binToPgm(bin: Binary): Uint8Array {
  const head = new TextEncoder().encode(`P5\n${bin.w} ${bin.h}\n255\n`);
  const out = new Uint8Array(head.length + bin.w * bin.h);
  out.set(head, 0);
  for (let i = 0; i < bin.data.length; i++) out[head.length + i] = bin.data[i] ? 0 : 255;
  return out;
}
