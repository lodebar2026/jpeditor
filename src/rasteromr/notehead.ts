// 符头：**不走形状字典，单独判**。
//
// 为什么单独判：符头是全页最多的符号（一首歌几千个），而位图上它的形状最不稳定
// ——去谱线会在骑线的符头上切一道、符干相接处会留个缺口、加线会粘上来。
// 拿 32×32 签名聚类，实测一首歌的符头被切成十几个类（宁静一首里前八个大类全是符头
// 的残缺变体），字典越滚越大而语义还是那三个。
//
// 换成按**性质**判，三档一刀分得开：
//   - **填充率**分实心与空心：实心符头是个实椭圆，墨占包围盒的四分之三；
//     空心符头只有一圈，占不到一半。
//   - **有没有符干**分二分与全音符：空心且**没有符干**的是全音符
//     （全音符本来就不带符干），空心且有符干的是二分音符。
//
// 这三条与字体无关，换一本书也成立——而形状签名是跟着字体走的。
import type { Component } from "../omr/types";
import type { SmuflName } from "../staffomr/glyphs";
import type { LineSeg } from "./prims";
import type { RasterUnit } from "./staffline";

/** 认出来的符头。 */
export interface RasterHead {
  comp: Component;
  code: SmuflName;
  /** 墨迹占包围盒的比例，排查用。 */
  fill: number;
  /** 挂在它左右缘的符干（没有为 null）。 */
  stem: LineSeg | null;
}

/** 符头宽度的上下限（线距的倍数）。实心符头约 1.3 格宽、1.0 格高。 */
const W_MIN = 0.85;
/** 上限 1.7。**试过放到 1.95、更差**：字典里 1.77×1.0 那两个大类（共三百多个）
 *  看着像「符头带一截符干残根」，收进来之后四首一共多检出两百多个块，
 *  但接进 `findNoteheads` 之后归属数只涨了个位数——它们落不到任何谱行上，
 *  是噪声不是漏检。宽度这一档就卡在这里。 */
const W_MAX = 1.7;
/** 高度下限放得低：骑在谱线上的符头被去线切掉一道，实测能矮到 0.6 格。 */
const H_MIN = 0.55;
const H_MAX = 1.35;

/** 填充率的分界。实心椭圆理论值 π/4 ≈ 0.785，空心的一圈实测在 0.45 上下。 */
const FILL_SOLID = 0.62;

/**
 * 从连通块里挑出符头并定它的 SMuFL 名。
 *
 * 名字与矢量路的 `page.ts::findNoteheads` 岔开（那边是「给符头找它属于哪一行谱」，
 * 这边是「哪些块是符头、是哪一种」），两边都从 `src/cli/index.ts` 导出，不能重名。
 *
 * `stems` 传竖段（`findPrimitives` 的 `vSegs`）——判「有没有符干」要用。
 * 符干贴在符头的**一侧**，不穿过中心，所以比的是符头的左缘或右缘
 * （与矢量路 `page.ts::findStems` 同一条判据）。
 */
export function findRasterHeads(blobs: Component[], stems: LineSeg[], unit: RasterUnit): RasterHead[] {
  const sp = unit.space;
  const out: RasterHead[] = [];
  for (const c of blobs) {
    const b = c.bbox;
    const w = b.w / sp;
    const h = b.h / sp;
    if (w < W_MIN || w > W_MAX || h < H_MIN || h > H_MAX) continue;
    // 太扁太长的不是符头（是横段残渣、连线）
    if (b.w > b.h * 2.2) continue;
    const fill = c.area / Math.max(1, b.w * b.h);
    if (fill < 0.3) continue; // 太空：是弧线的一段、方框
    const stem = stemOf(c, stems, unit);
    let code: SmuflName;
    if (fill >= FILL_SOLID) code = "noteheadBlack";
    else code = stem ? "noteheadHalf" : "noteheadWhole";
    out.push({ comp: c, code, fill, stem });
  }
  return out;
}

/** 贴在这个符头左缘或右缘、且纵向相交的竖段。 */
function stemOf(c: Component, stems: LineSeg[], unit: RasterUnit): LineSeg | null {
  const b = c.bbox;
  const tol = Math.max(unit.lineThick * 2, unit.space * 0.25);
  for (const s of stems) {
    const x = (s.x0 + s.x1) / 2;
    if (Math.abs(x - b.x) > tol && Math.abs(x - (b.x + b.w)) > tol) continue;
    const top = Math.min(s.y0, s.y1);
    const bottom = Math.max(s.y0, s.y1);
    if (bottom < b.y || top > b.y + b.h) continue;
    // **符头要在符干的某一端**，不能在中间——小节线也常擦着符头过
    // （与矢量路 `page.ts::findStems` 同一条闸）。
    const cy = b.y + b.h / 2;
    if (Math.abs(cy - top) > unit.space && Math.abs(cy - bottom) > unit.space) continue;
    return s;
  }
  return null;
}
