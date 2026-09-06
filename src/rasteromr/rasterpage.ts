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
import { applyTrackWarp, completeStaffLines, trackCurves } from "./dewarp";
import { findStaffLines, groupStaves } from "./staffline";

/** 一页取到的位图，连同它在页面坐标里的位置（识别坐标 ↔ 页面坐标要用）。 */
export interface RasterPage {
  bin: Binary;
  /**
   * 这张图在 PDF 里是什么形态：`mask` = 1-bit ImageMask（排版软件贴进去的干净位图）、
   * `gray1` = 1-bit 灰度（Xerox 那种扫描件）、`rgb` = 彩色/JPEG（手机拍、扫描）。
   *
   * **分档要用它**，别拿「线宽/线距」当代理量：那个比值随谱线判据一动就翻
   * （实测主，差遣我 线距 11.5px、线宽 2.3px，正卡在 0.2 的门槛上，
   * 改一条谱线判据就从扫描档跳进干净档，把干净档的平均从 71% 拖到 55%）。
   */
  kind: "mask" | "gray1" | "rgb";
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
  const packed = Math.ceil(w / 8) * h;
  const kind: RasterPage["kind"] = best.data.length === packed ? (best.kind === 1 ? "gray1" : "mask") : "rgb";
  const bin = decodeImage(best, w, h);
  if (!bin) return null;

  // **极性自检**：ImageMask 里置位的是墨，`kind: 1`（GRAYSCALE_1BPP）里置位的是白，
  // 而 `/Decode` 还能把两者都翻过来——翻没翻只有量了才知道。
  // 整页乐谱的墨不可能过半（实测约一成），过半就是反的，整幅取反。
  let ink = 0;
  for (let i = 0; i < bin.data.length; i++) ink += bin.data[i];
  if (ink > w * h * INK_FLIP_RATIO) for (let i = 0; i < bin.data.length; i++) bin.data[i] ^= 1;

  // **先按逐列的黑白游程把弯的谱线推平**（`dewarp.ts`），再让 `deskew` 收拾残余的整页倾斜。
  //
  // **推平之后要自己验一道**：照 `deskew` 那条「没有明显好过不动就不动」的规矩，
  // 拿 `findStaffLines` 数一数谱线，没多出一成半就整幅还原。
  // 不验的话干净位图那一档会被推坏（实测歌词 67.7% → 59.9%）——那一档本来就是平的，
  // 逐列偏移量全是噪声。
  dewarpPage(bin);
  deskew(bin);

  const vp = page.getViewport({ scale: 1 });
  return { bin, kind, scale: vp.width / w, pageWidth: vp.width, pageHeight: vp.height };
}

/** 行投影找出来的谱行数不到逐列游程看见的这个比例，才判这一页「弯得行投影已经废了」。 */
const BROKEN_RATIO = 0.6;

/** 推平之后谱行要多出这么多倍才认（与 `SKEW_GAIN` 同一条规矩）。 */
const DEWARP_GAIN = 1.15;

/**
 * 弯曲扫描的拉直：逐列黑白游程找谱线 → 逐列位移 → 推平（判据全在 `dewarp.ts`）。
 * **推平后自检**：谱线没多出来就还原。返回有没有真的动图。
 */
/** 自检的尺子：**成组的谱行数**（五条一组），不是散线条数。
 *  下游要的是「一行谱」，散线多出来几条没有意义——实测按散线数判会采纳一批
 *  「线更多、谱行没多」的推平，扫描件那一档反而降。 */
function staffScore(bin: Binary): number {
  return groupStaves(findStaffLines(bin)).length;
}

/** 推平与不推平都要经过同一条后续去倾斜、补线流程，再比较有无丢行。 */
function completedAfterDeskew(bin: Binary): number {
  const straight = { ...bin, data: new Uint8Array(bin.data) };
  deskew(straight);
  const lines = findStaffLines(straight);
  return completeStaffLines(straight, lines, groupStaves(lines)).groups.length;
}

export function dewarpPage(bin: Binary): boolean {
  const curves = trackCurves(bin);
  if (!curves) return false;
  const before = staffScore(bin);
  // **只在行投影明显不够的时候才动图。**
  // 逐列游程那一路看得见几条谱行（`curves.length`），行投影只找出成组的 `before` 行
  // ——两者差得多，才说明这一页是**弯**的、横带被抹平了。差不多的页面（干净位图、
  // 只是整页略斜的扫描件）交给 `deskew` 就够，动它只会把别处推歪
  // （实测无条件推平：扫描件音符 29.95% → 29.67%，还把「干净/扫描」的分档搅乱了）。
  if (before >= curves.length * BROKEN_RATIO) return false;
  const keep = new Uint8Array(bin.data);
  applyTrackWarp(bin, curves);
  const after = staffScore(bin);
  // before 为 0 时也必须有实际增益，不能把 0 → 0 当成达到 1.15 倍。
  if (after > before && after >= before * DEWARP_GAIN) {
    // 不能拿原图还没去倾斜时的残缺谱行数当底线：破碎扫描 p3 原图行投影是 0 行，
    // 仅去倾斜就能找全 12 行；长轨迹推平后虽然行投影增加，最终却只剩 11 行。
    // 这一验要走两遍 deskew + 补线，只在过了上面那道闸之后才做（`keep` 里就是原图）。
    if (completedAfterDeskew(bin) >= completedAfterDeskew({ ...bin, data: keep })) return true;
  }
  bin.data.set(keep);
  return false;
}

/** 去倾斜时试的最大斜率（dy/dx）。1900 px 宽的页面上相当于两端差 ±19 px。 */
const MAX_SLOPE = 0.01;
/** 斜率的步长。1900 px 宽上相当于两端差 1 px——比谱线本身还细，够用了。 */
const SLOPE_STEP = 0.0005;
/** 候选斜率的档数（`±STEPS × SLOPE_STEP`）。 */
const STEPS = Math.round(MAX_SLOPE / SLOPE_STEP);
/**
 * 判「这一行像不像谱线」的墨占比（分母是抽稀后的列数）。
 *
 * **必须取高**（0.75），不能照搬 `staffline.ts` 那边的 0.3：门槛一低，
 * 曲线是**反的**——谱线越糊、过闸的行反而越多。实测宁静 p2 在 0.3 门槛下
 * s=0 处只有 145 行过闸，而歪到 ±0.004 时有 341/349 行过闸（歌词行被算进来了），
 * 于是「最优角度」指向了歪的那一边。0.75 门槛下只有真谱线过得了闸，
 * s=0 处 145、歪一点就掉到个位数，峰又尖又正。
 */
const LINE_INK_RATIO_SKEW = 0.75;
/** 比「不动」好这么多倍才真的切。防止在谱线本来就找不齐的页面上被噪声牵着走。 */
const SKEW_GAIN = 1.15;
/** 小于这个斜率就不动图（免得为半个像素重排一遍所有像素）。 */
const MIN_SLOPE = 0.0004;

/**
 * **去倾斜**：逐斜率看行投影有多陡，取最陡的那个，再按列错切回来。
 *
 * 后面每一步都建立在「谱线是一整行几乎全是墨的横带」上（`staffline.ts`），
 * 页面一斜，横带就抹平了：实测真扫描件倾斜 3~4 px，`findStaffLines` 找不齐谱线，
 * 整条链跟着废（音符准确率只有干净档的三成）。
 *
 * 判据是 OMR 里的老办法（也是文献与 Audiveris 的做法）：谱线与扫描行平行时，
 * 行投影在谱线处形成又高又窄的尖峰；拿**平方和**当陡峭度，最大的那个角度就是正的。
 *
 * 做法上只对**墨点**做直方图，不对每个候选角度重排整幅图：
 * 一页的墨约一成，逐斜率算一遍直方图是几十万次加法，几十个候选也就千万级。
 * 列再抽稀一半（谱线横跨整页，抽稀不影响峰形），实测一页几十毫秒。
 *
 * **按列整像素错切**，不做旋转也不插值：位图是 1-bit 的，插值只会把谱线糊宽；
 * 而错切与旋转在这个角度上（正切值 0.01 以内）差别不到一个像素。
 */
export function deskew(bin: Binary): number {
  const { w, h, data } = bin;
  // 墨点坐标（列抽稀一半）
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x += 2)
      if (data[row + x]) {
        xs.push(x - (w >> 1));
        ys.push(y);
      }
  }
  if (xs.length < 1000) return 0;
  const hist = new Int32Array(h + 2 * Math.ceil(MAX_SLOPE * w) + 4);
  const off = Math.ceil(MAX_SLOPE * w) + 2;
  // **判据就是「这个角度下能看到几条谱线」**，与 `findStaffLines` 同一条墨占比闸。
  //
  // 一度用行投影的**平方和**当陡峭度（文献与 Audiveris 的老办法），在这批扫描件上
  // 会被**歌词行**带偏：歌词的行数远多于谱线，把它们对齐也能把平方和顶上去
  // ——实测破碎那份扫描件的两页直接顶到量程 ±0.01，谱线从 60 条掉到 4 条、14 条。
  // 数「过闸的行数」就不会：歌词行再多也过不了「一整行三成以上是墨」那道闸。
  const need = (w / 2) * LINE_INK_RATIO_SKEW;
  let best = 0;
  let bestLines = -1;
  let bestSharp = -1;
  let zeroLines = 0;
  for (let k = -STEPS; k <= STEPS; k++) {
    const s = k * SLOPE_STEP;
    hist.fill(0);
    for (let i = 0; i < xs.length; i++) hist[(ys[i] + Math.round(s * xs[i]) + off) | 0]++;
    let lines = 0;
    let sharp = 0;
    for (let i = 0; i < hist.length; i++) {
      if (hist[i] >= need) lines++;
      sharp += hist[i] * hist[i];
    }
    // 谱线条数优先，同数再比陡峭度；再平局取**最小的斜率**（别为半个像素动图）
    if (k === 0) zeroLines = lines;
    if (lines > bestLines || (lines === bestLines && (sharp > bestSharp || (sharp === bestSharp && Math.abs(s) < Math.abs(best))))) {
      bestLines = lines;
      bestSharp = sharp;
      best = s;
    }
  }
  if (Math.abs(best) < MIN_SLOPE) return 0;
  // 没有明显好过「不动」就不动：谱线本来就找不齐的页面（封面、纯文字页）上，
  // 这条曲线全是噪声，跟着它切只会把图切坏。
  if (bestLines < zeroLines * SKEW_GAIN) return 0;
  // 按列错切。**方向别弄反**：估计器里像素 (x, y) 记在直方图的 `y + s·x` 行，
  // 所以校正后的图应当满足 `out[y] = data[y − s·x]`——反过来写是把倾斜加倍
  // （实测那样扫描件的谱行从 63 掉到 40）。
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    const dy = Math.round(best * (x - (w >> 1)));
    for (let y = 0; y < h; y++) {
      const sy = y - dy;
      if (sy < 0 || sy >= h) continue;
      out[y * w + x] = data[sy * w + x];
    }
  }
  data.set(out);
  return best;
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
  sauvola(gray, w, h, data);
  return { w, h, data };
}

/** Sauvola 局部阈值的窗口半径（占页宽的比例）与参数。
 *  `k` 越大收得越紧（墨越细）。`R` 是标准差的量程，灰度图取 128。 */
const SAUVOLA_WIN = 1 / 40;
const SAUVOLA_K = 0.5;
const SAUVOLA_R = 128;

/**
 * **Sauvola 局部阈值**（`T = m · (1 + k · (s/R − 1))`），用积分图 O(n) 算。
 *
 * 全局 Otsu 在这批扫描件上不够：一页里墨色深浅不匀（装订侧偏暗、页心偏淡），
 * 一个阈值要么把淡处的细线切断、要么把暗处的笔画糊粗。望十架那份线距只有 11.5px，
 * 符头才 8px 宽，粗一两个像素就并进谱线里。
 *
 * 只走 RGB / 灰度那一档——**位图路的干净底本是 1-bit 的 `mask` / `gray1`**，
 * 那两档本来就没有灰度可分（`rasterizePage` 上面那两个分支直接取位）。
 */
function sauvola(gray: Uint8Array, w: number, h: number, out: Uint8Array): void {
  const r = Math.max(8, Math.round(w * SAUVOLA_WIN));
  // 积分图（多一行一列的零边，省去边界判断）
  const S1 = new Float64Array((w + 1) * (h + 1));
  const S2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let r1 = 0;
    let r2 = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      r1 += v;
      r2 += v * v;
      S1[(y + 1) * (w + 1) + x + 1] = S1[y * (w + 1) + x + 1] + r1;
      S2[(y + 1) * (w + 1) + x + 1] = S2[y * (w + 1) + x + 1] + r2;
    }
  }
  const box = (S: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const m = box(S1, x0, y0, x1, y1) / n;
      const v = Math.max(0, box(S2, x0, y0, x1, y1) / n - m * m);
      const t = m * (1 + SAUVOLA_K * (Math.sqrt(v) / SAUVOLA_R - 1));
      out[y * w + x] = gray[y * w + x] <= t ? 1 : 0; // 暗 = 墨
    }
  }
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

// **试过「把烧粗的笔画收一圈」，净负，已撤。**
//
// `gray1` / `mask` 那两档是 1-bit 打包的，没有灰度可分，扫描时吃开的墨改不了阈值
// ——破碎那份线宽 4.4px、线距 18.8px（比值 0.23，干净底本是 0.145）。
// 试了一圈**条件腐蚀**（四邻有白就去掉，但留下「去掉会把八邻域断成两块」的独木桥，
// 免得把休止的钩、谱号的弯抹断），线宽比超 0.22 才动、动完重估线距线宽。
// 重跑歌词与标签缓存之后实测：扫描件音符 54.43% → **53.35%**、音级 56.43% → 55.35%、
// 歌词 42.91% → 39.01%，只有小节自检 31.00% → 31.58% 略涨。笔画收细了，
// 但符头也跟着缩，尺寸闸那一头丢的比擦线那一头赚的多。
