// **谱内自举的符头 mask**，专治「几个符头并成一块」。
//
// 钢琴谱里二度、三度的和弦把两三个实心符头画得挨着（二度还错开在符干两侧），
// 位图上并成**一块**：实测破碎 p7 那个 2.22×1.46 格、填充 0.43 的块是两个头，
// 2.16×2.57 格的是三个。单头的尺寸闸（宽 0.85~1.85、高 0.55~1.35 格）一律判否，
// 于是钢琴两行漏得最狠（逐谱行：宁静 P4.1 漏 122、破碎 P6.1 漏 213）。
//
// 为什么这里 mask 管用、而「在符干两端比一比」那一版不管用（已撤，见文档）：
// **先验的硬度不同**。那边是拿模板去空地里找东西，什么都可能匹配；
// 这边是「**这一块墨太大，单头装不下，也没被认成别的**」——里面必然有几个头，
// 要定的只是几个、在哪。所以搜索限死在块内，还能把中心吸到线/间格上。
//
// 模板本身**谱内自举**：位图上的符头被去谱线切过、被符干啃过、栅格化又糊了一圈，
// 字体的干净轮廓与它对不上（文档里那条实测：拿 Maestro 模板当硬闸收空心符头更差）。
// 同一页几百个已认出的实心符头一平均，才是这一页真实的长相；
// 而且**分「骑线 / 在间」两类**，骑线那一类的模板里自然带着谱线，
// 粘连于是不算「差异」。
import type { Binary, Rect } from "../omr/types";
import type { RasterUnit } from "./staffline";
import type { SmuflName } from "../staffomr/glyphs";

/** 一类模板：概率图（0~1）与尺寸、样本数。 */
export interface HeadMask {
  w: number;
  h: number;
  p: Float32Array;
  n: number;
  onLine: boolean;
}

/** 模板窗口（线距的倍数）——比符头本身大一圈，把周围该空的地方也学进去。 */
const WIN_W = 1.7;
const WIN_H = 1.5;
/** 「骑线」的判据：中心离最近的谱线不到这么多格。 */
const ON_LINE = 0.25;
/** 一类至少要几个样本。 */
const MIN_SAMPLES = 20;

/** 从已经认出来的**实心**符头平均出模板。在**去谱线之前**的图上取——模板要带着谱线。 */
export function buildHeadMasks(bin: Binary, heads: { box: Rect; code: SmuflName }[], unit: RasterUnit, lineYs: number[]): HeadMask[] {
  const sp = unit.space;
  const w = Math.max(3, Math.round(sp * WIN_W));
  const h = Math.max(3, Math.round(sp * WIN_H));
  const ys = [...lineYs].sort((a, b) => a - b);
  const buckets = [
    { sum: new Float32Array(w * h), n: 0, onLine: true },
    { sum: new Float32Array(w * h), n: 0, onLine: false },
  ];
  for (const hd of heads) {
    if (hd.code !== "noteheadBlack") continue;
    const cx = hd.box.x + hd.box.w / 2;
    const cy = hd.box.y + hd.box.h / 2;
    const b = buckets[ys.some((y) => Math.abs(y - cy) <= sp * ON_LINE) ? 0 : 1];
    const x0 = Math.round(cx - w / 2);
    const y0 = Math.round(cy - h / 2);
    for (let y = 0; y < h; y++) {
      const sy = y0 + y;
      if (sy < 0 || sy >= bin.h) continue;
      for (let x = 0; x < w; x++) {
        const sx = x0 + x;
        if (sx >= 0 && sx < bin.w) b.sum[y * w + x] += bin.data[sy * bin.w + sx];
      }
    }
    b.n++;
  }
  const out: HeadMask[] = [];
  for (const b of buckets) {
    if (b.n < MIN_SAMPLES) continue;
    const p = new Float32Array(b.sum.length);
    for (let i = 0; i < p.length; i++) p[i] = b.sum[i] / b.n;
    out.push({ w, h, p, n: b.n, onLine: b.onLine });
  }
  return out;
}

/** 比对得分：**该有墨的地方有多少墨**减去**不该有墨的地方漏出多少**。 */
function scoreAt(bin: Binary, m: HeadMask, cx: number, cy: number): number {
  const x0 = Math.round(cx - m.w / 2);
  const y0 = Math.round(cy - m.h / 2);
  let hit = 0;
  let hitW = 0;
  let spill = 0;
  let spillW = 0;
  for (let y = 0; y < m.h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= bin.h) continue;
    for (let x = 0; x < m.w; x++) {
      const sx = x0 + x;
      if (sx < 0 || sx >= bin.w) continue;
      const p = m.p[y * m.w + x];
      const v = bin.data[sy * bin.w + sx];
      hit += p * v;
      hitW += p;
      spill += (1 - p) * v;
      spillW += 1 - p;
    }
  }
  return (hitW ? hit / hitW : 0) - (spillW ? spill / spillW : 0);
}

/** 够得上「一块里装着好几个头」的尺寸（线距的倍数）。 */
const CLUSTER_W = [1.55, 4.0] as const;
const CLUSTER_H = [0.7, 3.2] as const;
/** 填充率：太空的是别的东西（弧线、括号），太实的多半是黑块。 */
const CLUSTER_FILL = [0.35, 0.9] as const;
/** 认一个头要的得分。比在空地里找严得多——块里本来就有头，宁可少认。 */
/** 认一个头要的得分。比在空地里找严得多——块里本来就有头，宁可少认。
 *  扫过 0.42 / 0.50 / 0.55：按谱行 85.32 / **85.36** / 85.30%。 */
const SCORE_MIN = 0.5;
/** 两个头的中心至少要拉开这么远（线距）。二度和弦错开画，x 差约一个符头宽。 */
const SEP_X = 0.7;
const SEP_Y = 0.4;

/**
 * 把「几个符头并成的块」拆成符头。**只拆已经认不出来的块**，认得出的不碰。
 *
 * @param bin  去谱线之前的图（模板带着谱线，所以要在原图上比）。
 * @param grid 音高格：候选中心吸到最近的线/间中心（差半格音高就错一级）。
 */
export function splitHeadCluster(
  bin: Binary,
  box: Rect,
  area: number,
  masks: HeadMask[],
  unit: RasterUnit,
  grid: (y: number) => number | null,
  onLine: (y: number) => boolean,
): Rect[] {
  const sp = unit.space;
  const w = box.w / sp;
  const h = box.h / sp;
  if (w < CLUSTER_W[0] || w > CLUSTER_W[1] || h < CLUSTER_H[0] || h > CLUSTER_H[1]) return [];
  const fill = area / Math.max(1, box.w * box.h);
  if (fill < CLUSTER_FILL[0] || fill > CLUSTER_FILL[1]) return [];
  const cands: { x: number; y: number; s: number }[] = [];
  const step = Math.max(1, Math.round(sp * 0.15));
  for (let x = box.x; x <= box.x + box.w; x += step) {
    const ys = new Set<number>();
    for (let y = box.y - sp * 0.3; y <= box.y + box.h + sp * 0.3; y += sp * 0.25) {
      const g = grid(y);
      if (g !== null) ys.add(g);
    }
    for (const y of ys) {
      const m = masks.find((k) => k.onLine === onLine(y)) ?? masks[0];
      const s = scoreAt(bin, m, x, y);
      if (s >= SCORE_MIN) cands.push({ x, y, s });
    }
  }
  cands.sort((a, b) => b.s - a.s);
  const picked: { x: number; y: number }[] = [];
  for (const c of cands) {
    if (picked.some((p) => Math.abs(p.x - c.x) < sp * SEP_X && Math.abs(p.y - c.y) < sp * SEP_Y)) continue;
    picked.push(c);
  }
  // 只拆得出一个头的，交回原来那条路（尺寸闸自己会判）
  if (picked.length < 2) return [];
  const hw = Math.round(sp * 1.25);
  const hh = Math.round(sp * 0.95);
  return picked.map((p) => ({ x: Math.round(p.x - hw / 2), y: Math.round(p.y - hh / 2), w: hw, h: hh }));
}
