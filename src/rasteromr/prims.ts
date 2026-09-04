// 几何原语：从位图里抽出**横段 / 竖段 / 符杠**。
//
// 这三样在矢量路里是现成的（一条 path 就是一条线），位图路要自己挑出来。
// 挑出来之后交给 `adapt.ts` 包成 `Seg`，`page.ts` 的 `findStaves` / `findLegers` /
// `findStems` / `findBarlines` 就能原样跑——**那边的判据一条都不改**。
//
// ## 靠**游程**分，不靠连通域
//
// 直接对整幅图做连通域没有用：一行谱的五条线、压在上面的符头符干符杠、
// 穿过去的小节线全连成**一个**块。得先按「这个像素属于横笔画还是竖笔画」分开：
//   - 纵向游程短的像素 → 横笔画（谱线、加线、括号横杠）；
//   - 横向游程短的像素 → 竖笔画（符干、小节线）；
//   - 两个方向都粗的 → 符杠、符头、字。
// 分完再各自做连通域，笔画就散开了。
import type { Binary, Component, Rect } from "../omr/types";
import { connectedComponents } from "../omr/ccl";
import type { RasterUnit } from "./staffline";

/** 一条直线段（像素坐标）。 */
export interface LineSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 线宽（横段取厚度、竖段取宽度）。 */
  lw: number;
}

/** 一条符杠：拟合出来的中心线加包围盒。 */
export interface BeamQuad extends LineSeg {
  box: Rect;
}

export interface RasterPrims {
  hSegs: LineSeg[];
  vSegs: LineSeg[];
  beams: BeamQuad[];
}

/** 逐像素的纵向游程长度（该像素所在的那一竖条黑色游程有多长）。 */
function vRuns(bin: Binary): Uint16Array {
  const { w, h, data } = bin;
  const out = new Uint16Array(w * h);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!data[y * w + x]) {
        y++;
        continue;
      }
      let y2 = y;
      while (y2 + 1 < h && data[(y2 + 1) * w + x]) y2++;
      const len = y2 - y + 1;
      for (let k = y; k <= y2; k++) out[k * w + x] = len;
      y = y2 + 1;
    }
  }
  return out;
}

/** 逐像素的横向游程长度。 */
function hRuns(bin: Binary): Uint16Array {
  const { w, h, data } = bin;
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!data[row + x]) {
        x++;
        continue;
      }
      let x2 = x;
      while (x2 + 1 < w && data[row + x2 + 1]) x2++;
      const len = x2 - x + 1;
      for (let k = x; k <= x2; k++) out[row + k] = len;
      x = x2 + 1;
    }
  }
  return out;
}

/**
 * 沿一个方向做**闭运算**（先膨胀后腐蚀），把笔画上的小缺口补上。
 *
 * 非做不可：符干穿过谱线的那几个像素，纵向游程一下子变成整根符干的长度，
 * 于是被踢出「横笔画」——一条谱线因此被每根符干断成十几截，
 * 后面「长度 ≥ 最长横线的 35%」那道闸一截都过不去。沿 x 闭一下就接回来了。
 * 竖笔画同理（被谱线断开），沿 y 闭。
 */
function close1d(mask: Uint8Array, w: number, h: number, r: number, horizontal: boolean): Uint8Array {
  if (r < 1) return mask;
  const out = new Uint8Array(mask.length);
  const n = horizontal ? h : w;
  const m = horizontal ? w : h;
  const at = (i: number, j: number) => (horizontal ? i * w + j : j * w + i);
  const gap = new Uint8Array(m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) gap[j] = mask[at(i, j)];
    // 膨胀 r 再腐蚀 r，等价于「把不超过 2r 的缺口填上」
    let last = -1;
    for (let j = 0; j < m; j++) {
      if (!gap[j]) continue;
      if (last >= 0 && j - last <= r * 2) for (let k = last + 1; k < j; k++) out[at(i, k)] = 1;
      out[at(i, j)] = 1;
      last = j;
    }
  }
  return out;
}

/** 连通域：把 mask 当作一幅 `Binary` 跑 `ccl.ts`。 */
function comps(mask: Uint8Array, w: number, h: number, minArea: number): Component[] {
  return connectedComponents({ w, h, data: mask }, minArea);
}

/**
 * 一个连通块 → 中心线。逐列取墨迹的平均 y，两端各取四分之一段的均值当端点。
 *
 * 不用块的对角线：符杠是斜的四边形，对角线偏出中心线半个厚度；
 * 也不用最小二乘全拟合——两端各取一段更稳，末端的毛刺影响不到中间。
 */
function centerLine(mask: Uint8Array, w: number, c: Component, horizontal: boolean): LineSeg {
  const b = c.bbox;
  if (horizontal) {
    const q = Math.max(1, Math.round(b.w / 4));
    const meanY = (x0: number, x1: number) => {
      let s = 0;
      let n = 0;
      for (let x = x0; x < x1; x++)
        for (let y = b.y; y < b.y + b.h; y++)
          if (mask[y * w + x]) {
            s += y;
            n++;
          }
      return n ? s / n : b.y + b.h / 2;
    };
    return { x0: b.x, y0: meanY(b.x, b.x + q), x1: b.x + b.w - 1, y1: meanY(b.x + b.w - q, b.x + b.w), lw: c.area / Math.max(b.w, 1) };
  }
  const q = Math.max(1, Math.round(b.h / 4));
  const meanX = (y0: number, y1: number) => {
    let s = 0;
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = b.x; x < b.x + b.w; x++)
        if (mask[y * w + x]) {
          s += x;
          n++;
        }
    return n ? s / n : b.x + b.w / 2;
  };
  return { x0: meanX(b.y, b.y + q), y0: b.y, x1: meanX(b.y + b.h - q, b.y + b.h), y1: b.y + b.h - 1, lw: c.area / Math.max(b.h, 1) };
}

/**
 * 抽出全部几何原语。
 *
 * 三道门槛都按线距 `space` 写（与矢量路同口径，不写绝对像素）：
 *   - 横笔画：纵向游程 ≤ 线宽的三倍。谱线、加线是它；符杠的厚度约半个线距，出局。
 *   - 竖笔画：横向游程 ≤ 线宽的三倍。符干、小节线是它。
 *   - 符杠：纵向游程在 0.25~1.1 个线距之间、且横向游程超过一个线距。
 *     下限把谱线滤掉，上限把符头（约一个线距高、但横向游程只有一个符头宽）与
 *     实心块滤掉；横向那道再滤掉竖直的粗笔画。
 */
export function findPrimitives(bin: Binary, unit: RasterUnit): RasterPrims {
  const { w, h } = bin;
  const vr = vRuns(bin);
  const hr = hRuns(bin);
  // 「细」的上限**要卡在谱线与符杠之间**：谱线约 0.15 个线距厚，符杠约 0.5 个。
  // 一度写成 `lineThick * 3`，那正好撞上符杠的厚度——符杠混进横笔画，
  // 与它压着的谱线连成一块，块高一超限整条谱线跟着被剔掉
  // （实测宁静 p1 五十条谱线只剩十一条，且都不是谱线）。
  // 改成按线距取比例、再用线宽兜个下限。
  const thin = Math.max(3, Math.min(unit.lineThick * 2, unit.space * 0.4));

  // ── 横笔画 ──
  const hMask0 = new Uint8Array(w * h);
  for (let i = 0; i < hMask0.length; i++) if (vr[i] && vr[i] <= thin) hMask0[i] = 1;
  const hMask = close1d(hMask0, w, h, Math.round(unit.space * 0.6), true);
  const hSegs: LineSeg[] = [];
  for (const c of comps(hMask, w, h, Math.max(3, unit.lineThick * 2))) {
    if (c.bbox.w < unit.space) continue; // 比一个线距还短的横笔画：噪点、点、标点
    if (c.bbox.h > thin * 2) continue; // 太厚：不是单条横线（是几条粘在一起或别的东西）
    hSegs.push(centerLine(hMask, w, c, true));
  }

  // ── 竖笔画 ──
  const vMask0 = new Uint8Array(w * h);
  for (let i = 0; i < vMask0.length; i++) if (hr[i] && hr[i] <= thin) vMask0[i] = 1;
  const vMask = close1d(vMask0, w, h, Math.round(unit.lineThick * 2), false);
  const vSegs: LineSeg[] = [];
  for (const c of comps(vMask, w, h, Math.max(3, unit.lineThick * 2))) {
    if (c.bbox.h < unit.space) continue;
    if (c.bbox.w > thin * 2) continue;
    vSegs.push(centerLine(vMask, w, c, false));
  }

  // ── 符杠 ──
  const bMask = new Uint8Array(w * h);
  const bLo = unit.space * 0.25;
  const bHi = unit.space * 1.1;
  for (let i = 0; i < bMask.length; i++) if (vr[i] >= bLo && vr[i] <= bHi && hr[i] >= unit.space) bMask[i] = 1;
  const beams: BeamQuad[] = [];
  for (const c of comps(bMask, w, h, Math.round(unit.space * unit.space * 0.2))) {
    if (c.bbox.w < unit.space * 1.5) continue; // 太短的不是符杠（照矢量路 findBeams 的 0.8 格，位图放宽到 1.5）
    if (c.bbox.h > unit.space * 3) continue; // 太高：是实心块、方框
    const line = centerLine(bMask, w, c, true);
    beams.push({ ...line, box: c.bbox });
  }
  return { hSegs, vSegs, beams };
}

/**
 * 去谱线：把属于谱线的像素抹掉，留下符头/符干/符杠/字。
 *
 * 判据照经典做法：**只抹「纵向游程短、且正压在某条谱线上」的像素**。
 * 光看游程短会把符杠的上下边缘、字的横笔画一起抹掉；光看压在谱线上会把
 * 穿过谱线的符干、盖在谱线上的符头一起抹掉。两条一起才对。
 */
export function removeStaffLines(bin: Binary, lineYs: number[], unit: RasterUnit): Binary {
  const { w, h, data } = bin;
  const vr = vRuns(bin);
  const out: Binary = { w, h, data: new Uint8Array(data) };
  const thin = Math.max(unit.lineThick * 2, 2);
  const half = unit.lineThick / 2 + 1;
  for (const cy of lineYs) {
    const y0 = Math.max(0, Math.floor(cy - half));
    const y1 = Math.min(h - 1, Math.ceil(cy + half));
    for (let y = y0; y <= y1; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (data[i] && vr[i] <= thin) out.data[i] = 0;
      }
  }
  return out;
}
