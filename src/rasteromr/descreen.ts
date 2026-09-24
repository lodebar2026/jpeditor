// **半调网点**（dither）印刷页的去网与实化。
//
// 这类底本（心领《坚固保障》那种简谱本式的独唱谱）整页是 1-bit 抖动印刷：
// 符头不是实心块，而是打散的网点；右半页还压着一层点阵阴影底纹。
// 照直送进识别，`findRasterHeads` 的填充率那一档全不过——实测整页 83 个音符只认出 20 个。
//
// **不是每张图都要做**：干净位图（排版软件贴进去的）与普通扫描件的笔画本来就是实心的，
// 做一遍只会把细节磨掉。所以先量 `halftoneRatio` 再决定，判据见 `HALFTONE_RATIO`。
import type { Binary } from "../omr/types";

/** 积分图：`sum(x0,y0,x1,y1)`（半开区间）。0/1 图逐点求和，整型精确。 */
class Integral {
  private readonly s: Int32Array;
  constructor(private readonly bin: Binary) {
    const { w, h, data } = bin;
    const s = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let run = 0;
      const src = y * w;
      const cur = (y + 1) * (w + 1);
      const up = y * (w + 1);
      for (let x = 0; x < w; x++) {
        run += data[src + x];
        s[cur + x + 1] = s[up + x + 1] + run;
      }
    }
    this.s = s;
  }
  /** 以 (x,y) 为中心、kw×kh 窗口的墨点数（越界按 0 计）。 */
  box(x: number, y: number, kw: number, kh: number): number {
    const { w, h } = this.bin;
    const x0 = Math.max(0, x - (kw >> 1));
    const y0 = Math.max(0, y - (kh >> 1));
    const x1 = Math.min(w, x + (kw >> 1) + 1);
    const y1 = Math.min(h, y + (kh >> 1) + 1);
    const s = this.s;
    const W = w + 1;
    return s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0];
  }
}

/**
 * 墨点里「孤立点」的占比：3×3 窗口内墨不过 3 个（含自己）算孤立。
 *
 * **只量谱表带之内**（`rows` 给出要量的行）。整页量会被空白页毁掉：
 * 实测封面那种几乎没墨的页面，几十个尘点个个孤立，量出来是 1.000；
 * 而谱表带里有谱线、符干这些必然成片的墨，空页与真网点页就分得开了。
 */
export function halftoneRatio(bin: Binary, rows?: (y: number) => boolean): number {
  const it = new Integral(bin);
  const { w, h, data } = bin;
  let ink = 0;
  let lone = 0;
  for (let y = 0; y < h; y++) {
    if (rows && !rows(y)) continue;
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      ink++;
      if (it.box(x, y, 3, 3) <= 3) lone++;
    }
  }
  return ink ? lone / ink : 0;
}

/**
 * 墨里的**针孔**占比：八邻域里至少六个是墨的白点，与墨点数之比（只量谱表带内）。
 *
 * 网纹填充（齐来称颂伟大之神那本：符头、谱号内部是斜交叉的细网纹）量不出孤立点
 * ——网纹里每个墨点斜对角都挨着墨，`halftoneRatio` 只有 0.069；可符头里满是
 * 被墨围住的白点，照直送识别，填充率那一档全不过（实测 151 个音只认出 17 个）。
 */
export function pinholeRatio(bin: Binary, rows?: (y: number) => boolean): number {
  const { w, h, data } = bin;
  let ink = 0;
  let holes = 0;
  for (let y = 1; y < h - 1; y++) {
    if (rows && !rows(y)) continue;
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (data[i]) {
        ink++;
        continue;
      }
      const n =
        data[i - w - 1] + data[i - w] + data[i - w + 1] + data[i - 1] + data[i + 1] + data[i + w - 1] + data[i + w] + data[i + w + 1];
      if (n >= 6) holes++;
    }
  }
  return ink ? holes / ink : 0;
}

/**
 * **补针孔**（就地改 `bin`）：八邻域里至少六个是墨、**或上下左右四邻全是墨**的白点补成墨，补两遍。
 *
 * 四邻那一条是给**棋盘格抖动**的网纹（父恩广大、晨曦破晓那本：符头里一像素一格黑白相间）：
 * 那里的白点上下左右都是墨、四个斜角却是白的，八邻域只凑得到四五个，六个那道闸补不上。
 *
 * 网纹填充的页面不能走 `descreen`：那边的密度窗口按线距取（线距 17.5px 时 11px 见方），
 * 汉字笔画、升号糊成一团，空心符头也被填实（实测齐来称颂 151 个音认出 154 个、
 * 对上的只有 14.6%）。网纹的空隙只有一两个像素，逐点补就够，别的笔画分毫不动。
 */
export function fillPinholes(bin: Binary): void {
  const { w, h, data } = bin;
  for (let pass = 0; pass < 2; pass++) {
    const add: number[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (data[i]) continue;
        const n4 = data[i - w] + data[i - 1] + data[i + 1] + data[i + w];
        const n = n4 + data[i - w - 1] + data[i - w + 1] + data[i + w - 1] + data[i + w + 1];
        if (n >= 6 || n4 === 4) add.push(i);
      }
    }
    if (!add.length) break;
    for (const i of add) data[i] = 1;
  }
}

/**
 * **判网纹填充的门槛**。谱表带内实测，要补的三份：齐来称颂 0.066、赞美三一真神 0.035、
 * 颂赞与尊贵 0.017（后两份网纹淡，取 0.04 时整页认不出东西）；不该补的：合唱谱全书全页
 * 最大 0.0076，其余图片语料 0.001 以下（坚固保障 0.0096 走的是去网那一档）。取 0.012。
 */
export const PINHOLE_RATIO = 0.012;

/**
 * **判半调网点的门槛**。谱表带内实测：心领那本（抖动印刷）0.359；
 * 合唱谱那批（干净位图 + 真扫描件）全书全页最大 0.157（你要等候 p3），
 * 其余多在 0.1 以下。两档之间是空的，取 0.25——离两边都有余量，
 * 且**合唱谱那批没有一页会触发**，旧基线按构造不动。
 */
export const HALFTONE_RATIO = 0.25;

/** 实心块的密度门槛（符头/符杠打散成网点之后，局部密度仍在半数以上）。 */
const FILL_DENSITY = 0.42;
/** 横/纵向连续的门槛：谱线、符干这类笔画本身是实的，网点底纹不可能连成这样。 */
const RUN_LONG = 0.72;
const RUN_SHORT = 0.85;

/**
 * 去网并实化，**就地改 `bin`**。
 *
 * 三条一起用：
 *   1. 局部密度（`k` 窗口）过半的填成实心——散成网点的符头、符杠回到实心块；
 *   2. 横向/纵向连续的留下——谱线、符干、小节线本来就是实的；
 *   3. 其余的墨只在「贴着上面两者」时才留——把阴影底纹那层孤立网点整层抹掉。
 *
 * @param space 线距（像素）。窗口尺寸按它缩放：整页乐谱唯一的天然尺子。
 */
export function descreen(bin: Binary, space: number): void {
  const odd = (n: number) => Math.max(3, Math.round(n) | 1);
  const k = odd(space * 0.6);
  const k5 = odd(space * 0.33);
  const it = new Integral(bin);
  const { w, h, data } = bin;
  const solid = new Uint8Array(w * h);
  const struct = new Uint8Array(w * h);
  const kk = k * k;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const fill = it.box(x, y, k, k) >= kk * FILL_DENSITY;
      if (fill) solid[i] = 1;
      struct[i] =
        fill ||
        it.box(x, y, k, 1) >= k * RUN_LONG ||
        it.box(x, y, 1, k) >= k * RUN_LONG ||
        it.box(x, y, k5, 1) >= k5 * RUN_SHORT ||
        it.box(x, y, 1, k5) >= k5 * RUN_SHORT
          ? 1
          : 0;
    }
  }
  // 结构掩膜往外放一圈（`k5` 窗口），把属于结构的墨——斜的符杠端、弧线的梢——连带留下
  const sit = new Integral({ w, h, data: struct });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      data[i] = solid[i] || (data[i] && sit.box(x, y, k5, k5) > 0) ? 1 : 0;
    }
  }
}

/** 量网点率时谱表上下各带出这么多个线距（歌词/和弦字母不进来，符干与弧线进得来）。 */
export const HALFTONE_BAND = 2;
