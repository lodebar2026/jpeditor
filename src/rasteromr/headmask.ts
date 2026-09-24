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
  /** 两类合并平均出来的那张（样本不够分类时的兜底，见 `buildHeadMasks`）。 */
  pooled?: boolean;
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
  // **两类都凑不够、合起来够**：一页只有六行单旋律的短歌（《主我敬拜你》四十来个实心头，
  // 骑线与在间各二十上下），一张模板都出不来，「头 + 干 + 尾连成一块」那一路整页空转
  // ——这本的符尾从干底弯回来贴着头，带尾的八分整批漏掉。合起来平均一张顶上（`onLine` 随多的那类），
  // 查找时本来就有「找不到同类用第一张」的回退。
  const pooled = buckets[0].n + buckets[1].n;
  if (!out.length && pooled >= MIN_POOLED) {
    const p = new Float32Array(w * h);
    for (let i = 0; i < p.length; i++) p[i] = (buckets[0].sum[i] + buckets[1].sum[i]) / pooled;
    out.push({ w, h, p, n: pooled, onLine: buckets[0].n >= buckets[1].n, pooled: true });
  }
  return out;
}

/** 两类都不够 `MIN_SAMPLES` 时，合起来至少这么多才出一张合并模板。 */
const MIN_POOLED = 12;

/**
 * **空心符头**的模板：拿本页已经认出来的二分、全音符符头平均。
 *
 * 实心那一套（`buildHeadMasks`）每类要二十个样本，空心头一页往往只有十来个，
 * 所以样本门槛放到 `minSamples`。用途很窄，都在有内腔的地方用：
 * 「空心头按模板再搜」（`recognize.ts`，不传 `lineYs`，一张不分类的）与
 * 按音高位置逐一配模板（`notehead.ts::hollowHeadsByPitch`），先验够硬，模板糙一点也够用。
 *
 * 传了 `lineYs` 就**分「骑线 / 在间」两张**。按音高位置逐一配模板时，
 * 骑线的位置要拿带着谱线的那张比，否则谱线穿过内腔的那几行全算「不该有的墨」。
 * 某一类样本不够 `minSamples` 时，拿全部样本平均的那张顶上（`onLine` 记成缺的那一类），
 * 一张也凑不出就返回空。
 */
export function buildHollowMasks(bin: Binary, heads: { box: Rect; code: SmuflName }[], unit: RasterUnit, lineYs: number[], minSamples = 3): HeadMask[] {
  const hollow = heads.filter((h) => h.code === "noteheadHalf" || h.code === "noteheadWhole");
  if (hollow.length < minSamples) return [];
  const sp = unit.space;
  const w = Math.max(3, Math.round(sp * WIN_W));
  const h = Math.max(3, Math.round(sp * WIN_H));
  const avg = (list: typeof hollow, onLine: boolean): HeadMask => {
    const sum = new Float32Array(w * h);
    for (const hd of list) {
      const x0 = Math.round(hd.box.x + hd.box.w / 2 - w / 2);
      const y0 = Math.round(hd.box.y + hd.box.h / 2 - h / 2);
      for (let y = 0; y < h; y++) {
        const sy = y0 + y;
        if (sy < 0 || sy >= bin.h) continue;
        for (let x = 0; x < w; x++) {
          const sx = x0 + x;
          if (sx >= 0 && sx < bin.w) sum[y * w + x] += bin.data[sy * bin.w + sx];
        }
      }
    }
    const p = new Float32Array(w * h);
    for (let i = 0; i < p.length; i++) p[i] = sum[i] / list.length;
    return { w, h, p, n: list.length, onLine };
  };
  if (!lineYs.length) return [avg(hollow, false)];
  const on = hollow.filter((hd) => lineYs.some((y) => Math.abs(y - (hd.box.y + hd.box.h / 2)) <= sp * ON_LINE));
  const off = hollow.filter((hd) => !on.includes(hd));
  const all = avg(hollow, false);
  return [
    on.length >= minSamples ? avg(on, true) : { ...all, onLine: true },
    off.length >= minSamples ? avg(off, false) : { ...all, onLine: false },
  ];
}

/** 比对得分：**该有墨的地方有多少墨**减去**不该有墨的地方漏出多少**。
 *  `headclass.ts` 拿它当判别器的头一维特征。 */
export function scoreAt(bin: Binary, m: HeadMask, cx: number, cy: number): number {
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
/** 够得上「一块里装着好几个头」的尺寸（线距的倍数）。
 *  **宽度下限不能按「两个头并排」定**：三度和弦的两个头是**上下贴着**的，
 *  一块才 1.3 格宽、1.9 格高——按 1.55 卡就把和弦成员整批挡在外面
 *  （GT 钢琴右手 241 个和弦附加音，我们只认出 52 个）。
 *  扫过 1.55 / 1.2 / 1.0 / 0.8 / 0.7 / 0.6：按谱行 85.36 / 85.41 / 85.54 / **85.60** / 85.60 / 85.60%。 */
const CLUSTER_W = [0.8, 6.0] as const;
/** 上限 6×4 格是**照错因分析定的**，不是拍的：`scripts/raster-gap.mjs` 量出
 *  漏掉的音里 **63.6% 焊在一团大于 4×3.2 格的墨里**（符杠 + 几根符干 + 几个头），
 *  原来的 4×3.2 够不着。与「换成符杠已擦的图打分」一起用：
 *  只换图（尺寸仍 4×3.2）扫描件音符 65.46% → 66.07%、小节自检 32.19% → 32.44%；
 *  再放宽到 6×4，干净档 85.04% → **85.18%**、扫描件小节自检 → **33.80%**。
 *  8×5 与 12×6 都不如 6×4。
 *
 *  **换图之后重扫过一遍**（条件变了，值得重试）：8×5 / 10×6 让扫描件小节自检
 *  33.80% → 34.86% / 35.00%（真音确实捞回来了），**但音符 66.06% → 65.95% / 65.93%**
 *  ——捞出来的对错各半。又试「门槛随块面积线性抬」（大团里落脚点多、假头概率也高）：
 *  8×5 配 `+0.004/头面积、封顶 0.55` 小节自检 34.32%、音符仍 66.01%。
 *  三种配置一致：**大团里「定位」本身不可靠，不是门槛的事**。
 *  `raster-gap.mjs` 量出漏音里仍有 54.9% 落在 >6×4 的团里——要吃下它们，
 *  得换块内定位的办法（比如按符干的 x 先切段再逐段找头），不是再放闸。 */
/** 上限 6×4 格是**照错因分析定的**，不是拍的：`scripts/raster-gap.mjs` 量出
 *  漏掉的音里 **63.6% 焊在一团大于 4×3.2 格的墨里**（符杠 + 几根符干 + 几个头），
 *  原来的 4×3.2 够不着。放到 6×4 之后干净档音符 84.94% → **85.09%**、
 *  小节自检 54.97% → 55.03%，扫描档持平；再放到 8×5 / 12×6 都不如它。 */
const CLUSTER_H = [0.7, 4.0] as const;
/** 填充率：太空的是别的东西（弧线、括号），太实的多半是黑块。 */
const CLUSTER_FILL = [0.35, 0.9] as const;
/** 认一个头要的得分。比在空地里找严得多——块里本来就有头，宁可少认。 */
/** 认一个头要的得分。比在空地里找严得多——块里本来就有头，宁可少认。
 *
 *  0.50 是**只看干净位图**时定的（那时扫过 0.42 / 0.50 / 0.55，按谱行
 *  85.32 / 85.36 / 85.30%，三档几乎无差）。真扫描件上这条闸卡得太紧：
 *  拆和弦这条路在破碎扫描版只出 **18** 个符头，同一首干净版出 **138** 个
 *  ——而钢琴行正是和弦最密的地方。放到 0.46 之后两档一起涨：
 *  干净档音符 84.81% → **84.98%**、小节自检 54.91% → 55.03%，
 *  扫描档音符 54.43% → **54.59%**、音级 56.43% → 56.50%、小节自检 31.00% → 31.17%。
 *  再扫 0.42 / 0.48：干净 84.63 / 84.88%，扫描 54.65 / 54.51% —— 0.46 是拐点。
 *  （歌词两档各降 0.05 / 0.11 个点：多认出的符头把音节挂法挪了一两个字，量级在噪声里。） */
const SCORE_MIN = 0.46;
/** 匹配追踪最多找几个头（一块连桁团里的头不会比这更多）。带判别器时要多留几轮，
 *  被否掉的候选也占一轮。 */
const MAX_HEADS = 8;
/** 带判别器时 mask 得分的门槛：只用来排序与止步，收不收由判别器定。 */
const VERIFY_SCORE_MIN = 0.2;
/** 减墨时椭圆取符头的几成。扫过 0.7 / 0.85 / **1.0** / 1.15 / 1.3：
 *  扫描件音符 66.17 / 66.50 / **66.52** / 66.47 / 66.30%，
 *  小节自检 34.75 / 34.88 / 35.03 / 35.32 / 35.24%。正好一个符头最好——
 *  削小了残墨还在、继续抬高邻近候选，削大了把邻居的墨也啃掉。 */
const ERASE_R = 1.0;
/** 同一个 x 上不再找第二个头的间距（线距的倍数）。
 *  **取 0**：减墨本身就防住了「同一处反复挑」，再加一条反而挡掉同 x 上真正的
 *  和弦成员——实测取 0.15 时扫描件音符 66.50% → 66.05%、小节自检 34.88% → 33.89%。 */
const SEP_X_MIN = 0;
/** 两个头的中心至少要拉开这么远（线距）。二度和弦错开画，x 差约一个符头宽。 */
const SEP_X = 0.7;
/** 两个头的纵向最小间隔：三度是**半格**，所以不能卡到 0.5 以上。 */
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
  /** 跳过尺寸闸（调用方自己把关，见 `recognize.ts` 里判别器那一遍）。 */
  anySize = false,
  /**
   * 判别器（`headclass.ts`）。给了就**接进追踪循环里**：mask 得分只用来排序、
   * 门槛放到 `VERIFY_SCORE_MIN`，收不收由判别器说了算。
   *
   * 只在事后筛不够——得分低于 `SCORE_MIN` 的候选在追踪阶段就被丢了，
   * 事后再筛也筛不出它们；而扫描件上被啃过、被粘住的真符头，得分恰恰就低。
   */
  verify?: (box: Rect, cy: number) => boolean,
  /** 拆出几个头才算数。拆和弦要两个（一个的交回单头那条路）；空心头按模板再搜时一个也算。 */
  minHeads = 2,
  /** 认一个头的得分门槛（缺省 `SCORE_MIN`；空心模板那一路另给，见调用处）。 */
  minScore = SCORE_MIN,
): Rect[] {
  const sp = unit.space;
  const w = box.w / sp;
  const h = box.h / sp;
  if (!anySize && (w < CLUSTER_W[0] || w > CLUSTER_W[1] || h < CLUSTER_H[0] || h > CLUSTER_H[1])) return [];
  if (anySize && (w < CLUSTER_W[0] || h < CLUSTER_H[0])) return [];
  const fill = area / Math.max(1, box.w * box.h);
  if (fill < CLUSTER_FILL[0] || fill > CLUSTER_FILL[1]) return [];
  // ── **匹配追踪**：找到一个头就把它的墨从块里减掉，再重新打分找下一个 ────────
  //
  // 原来是「一次打分、按得分贪心挑、只用间距去重」。那么做有个毛病：
  // **已经被解释掉的墨还在图里，继续抬高邻近候选的得分**——连桁团里符头挨着符头，
  // 一个头的墨能把它左右各半格的位置也顶过门槛，于是要么多挑、要么靠间距硬压掉真头。
  // 减掉再找就没这回事：第二轮的得分只看**还没解释的墨**。
  //
  // 在块的局部副本上做（外扩一个模板窗，免得减墨越界），不动原图。
  const pad = Math.max(...masks.map((m) => Math.max(m.w, m.h)));
  const wx = box.w + pad * 2;
  const wy = box.h + pad * 2;
  const ox = box.x - pad;
  const oy = box.y - pad;
  const work: Binary = { w: wx, h: wy, data: new Uint8Array(wx * wy) };
  for (let y = 0; y < wy; y++) {
    const sy = oy + y;
    if (sy < 0 || sy >= bin.h) continue;
    for (let x = 0; x < wx; x++) {
      const sx = ox + x;
      if (sx >= 0 && sx < bin.w) work.data[y * wx + x] = bin.data[sy * bin.w + sx];
    }
  }
  const ys = new Set<number>();
  for (let y = box.y - sp * 0.3; y <= box.y + box.h + sp * 0.3; y += sp * 0.25) {
    const g = grid(y);
    if (g !== null) ys.add(g);
  }
  const step = Math.max(1, Math.round(sp * 0.15));
  const picked: { x: number; y: number }[] = [];
  const hw0 = sp * 1.25;
  const hh0 = sp * 0.95;
  for (let round = 0; round < MAX_HEADS; round++) {
    let best: { x: number; y: number; s: number } | null = null;
    for (let x = box.x; x <= box.x + box.w; x += step) {
      if (picked.some((p) => Math.abs(p.x - x) < sp * SEP_X_MIN)) continue;
      for (const y of ys) {
        if (picked.some((p) => Math.abs(p.x - x) < sp * SEP_X && Math.abs(p.y - y) < sp * SEP_Y)) continue;
        const m = masks.find((k) => k.onLine === onLine(y)) ?? masks[0];
        const sc = scoreAt(work, m, x - ox, y - oy);
        if (sc < (verify ? VERIFY_SCORE_MIN : minScore)) continue;
        if (!best || sc > best.s) best = { x, y, s: sc };
      }
    }
    if (!best) break;
    if (verify) {
      const bx = { x: Math.round(best.x - hw0 / 2), y: Math.round(best.y - hh0 / 2), w: Math.round(hw0), h: Math.round(hh0) };
      if (!verify(bx, best.y)) {
        // 判别器否了：把这一处的墨也减掉，免得下一轮又挑中它
        const cx0 = best.x - ox;
        const cy0 = best.y - oy;
        const rx0 = (hw0 * ERASE_R) / 2;
        const ry0 = (hh0 * ERASE_R) / 2;
        for (let y = Math.max(0, Math.round(cy0 - ry0)); y <= Math.min(wy - 1, Math.round(cy0 + ry0)); y++)
          for (let x = Math.max(0, Math.round(cx0 - rx0)); x <= Math.min(wx - 1, Math.round(cx0 + rx0)); x++)
            if (((x - cx0) / rx0) ** 2 + ((y - cy0) / ry0) ** 2 <= 1) work.data[y * wx + x] = 0;
        continue;
      }
    }
    picked.push({ x: best.x, y: best.y });
    // 把这个头的墨减掉（椭圆，比符头本身略小一圈，免得连邻居一起削）
    const cx = best.x - ox;
    const cy = best.y - oy;
    const rx = hw0 * ERASE_R / 2;
    const ry = hh0 * ERASE_R / 2;
    for (let y = Math.max(0, Math.round(cy - ry)); y <= Math.min(wy - 1, Math.round(cy + ry)); y++)
      for (let x = Math.max(0, Math.round(cx - rx)); x <= Math.min(wx - 1, Math.round(cx + rx)); x++)
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) work.data[y * wx + x] = 0;
  }
  // 只拆得出一个头的，交回原来那条路（尺寸闸自己会判）
  if (picked.length < minHeads) return [];
  const hw = Math.round(sp * 1.25);
  const hh = Math.round(sp * 0.95);
  return picked.map((p) => ({ x: Math.round(p.x - hw / 2), y: Math.round(p.y - hh / 2), w: hw, h: hh }));
}

/** 「符头 + 符干（+ 符尾）并成一块」的尺寸闸（线距的倍数）。
 *  单个八分音符的块实测 1.99×3.91 格（带符尾）、1.11×3.85 与 1.11×5.31 格（只有符干）。
 *  宽度上限 2.8：和弦块粘上一截圆滑线尾巴会宽到 2.7 格（向主唱新歌第 9 小节）。 */
const STEM_W = [0.85, 2.8] as const;
const STEM_H = [1.6, 6.5] as const;
/** 两头各一个头的长干块的高度上限。 */
const STEM_H_LONG = 9;
/** 长干块两个头都要过的得分（比单头那一档严：这里没有「头在端上」的先验）。 */
const LONG_SCORE_MIN = 0.5;
/** 长干块里第三个头离已有两头的最小间隔（格）。 */
const LONG_THIRD_GAP = 0.9;
/** 填充率：一根符干加一个头，墨占不到包围盒的一半；太实的是黑块、太空的是弧线。 */
const STEM_FILL = [0.18, 0.72] as const;
/** 头只可能在符干的**某一端**，从端点往里找这么多格。 */
const END_BAND = 1.3;
/** 单头要的得分。比拆和弦那条严（那边块里必然有头，这边还要先确认「有没有」）。
 *
 *  0.45 同样是**只看干净位图**时定的。扫描件上这条路是出符头最多的一路
 *  （破碎扫描版 338 个，干净版才 105 个——扫描件的符干更粘、更多块落到这儿），
 *  闸松一点收益就明显。扫过 0.34 / **0.40** / 0.43 / 0.45 / 0.52：
 *  扫描件音符 54.62 / **54.90** / 54.76 / 54.59 / 53.20%，
 *  干净档音符 84.82 / 84.94 / 84.93 / 84.98 / 84.88%
 *  ——扫描档在 0.40 见顶，干净档在 0.45 见顶但两者只差 0.04（噪声量级），取 0.40。 */
const STEM_SCORE_MIN = 0.40;
/** 合并模板（`pooled`）糊一些，同一个头得分低一截：《主我敬拜你》带尾八分的头 0.37，别处最高 0.30。 */
const STEM_SCORE_MIN_POOLED = 0.34;
/** 同一根符干上再找和弦头：从端上那个头往里找多远（格）、最多几个头、得分闸。 */
const CHORD_REACH = 2.5;
const CHORD_MAX = 3;
const CHORD_SCORE_MIN = 0.45;
/** 上下贴成一串的三度和弦头的得分闸（见用处）。 */
const CHORD_SCORE_STACKED = 0.35;

/**
 * 从「**符头 + 符干（+ 符尾）并成一块**」的块里把符头摘出来。
 *
 * 病因在 `prims.ts::isolated`：符尾贴着符干走了大半程，两侧邻墨过半，
 * 那条符干于是**判不成原语**、`blobImage` 也就没照它抹墨——头、干、尾连成一块，
 * 宽 2.0 高 3.9 格，单头的尺寸闸一律判否。实测破碎 p2 第一系统钢琴右手
 * 六个带符尾的八分音符**一个都没认出来**（那一段 GT 42 音只出 30）。
 *
 * 与 `splitHeadCluster` 的分别：那边是「块太大、装着好几个头」，拆得出两个才算数；
 * 这边是「块细长、一端有个头」，只摘**一个**。所以判据要严一档
 * （得分闸更高、只在两端找），而且**只吃谁都没认领的块**——
 * 谱号、休止、升降号的块都已经被字典/自举那几路收走了。
 *
 * @returns 摘出来的符头盒与符干那一段（都没有就是 null）。
 */
export function headFromStemBlock(
  bin: Binary,
  box: Rect,
  area: number,
  masks: HeadMask[],
  unit: RasterUnit,
  grid: (y: number) => number | null,
  onLine: (y: number) => boolean,
): { head: Rect; extra: Rect[]; stemX: number; stemY0: number; stemY1: number } | null {
  const sp = unit.space;
  const w = box.w / sp;
  const h = box.h / sp;
  // **一根长干两头各一个头**（6.5~9 格）：闭合谱低音 A3/F2、A3/D2 一根干穿过整个谱表，
  // 超过单头那一档的高度上限。这一档要**两头都摘得出头**才收，原来那一档的行为一点不变。
  const long = h > STEM_H[1] && h <= STEM_H_LONG;
  if (w < STEM_W[0] || w > STEM_W[1] || h < STEM_H[0] || (h > STEM_H[1] && !long)) return null;
  const fill = area / Math.max(1, box.w * box.h);
  if (fill < STEM_FILL[0] || fill > STEM_FILL[1]) return null;
  // 两端各留一条带，头只在里面找
  const bands: [number, number][] = [
    [box.y - sp * 0.2, box.y + sp * END_BAND],
    [box.y + box.h - sp * END_BAND, box.y + box.h + sp * 0.2],
  ];
  let best: { x: number; y: number; s: number } | null = null;
  const step = Math.max(1, Math.round(sp * 0.15));
  for (const [ya, yb] of bands)
    for (let x = box.x; x <= box.x + box.w; x += step) {
      const ys = new Set<number>();
      for (let y = ya; y <= yb; y += sp * 0.25) {
        const g = grid(y);
        if (g !== null && g >= ya - sp * 0.3 && g <= yb + sp * 0.3) ys.add(g);
      }
      for (const y of ys) {
        const m = masks.find((k) => k.onLine === onLine(y)) ?? masks[0];
        const s = scoreAt(bin, m, x, y);
        if (s >= (m.pooled ? STEM_SCORE_MIN_POOLED : STEM_SCORE_MIN) && (!best || s > best.s)) best = { x, y, s };
      }
    }
  if (!best) return null;
  if (long) {
    // 头不一定在端上：两个声部共用一根竖线（上声部的干往上、下声部的往下），头都在中段。
    // 整根干上找两个：得分最高的一个，再在隔开 1.5 格以外找第二个；那一行的墨都要够一个头宽。
    const hwL = Math.round(sp * 1.25);
    const one = bandTop(bin, masks, box, sp, step, grid, onLine, [box.y, box.y + box.h], () => true, (y) => rowSpan(bin, box, y) >= hwL * 0.7);
    if (!one) return null;
    const two = bandTop(bin, masks, box, sp, step, grid, onLine, [box.y, box.y + box.h], (y) => Math.abs(y - one.y) >= sp * 1.5, (y) => rowSpan(bin, box, y) >= hwL * 0.7);
    if (!two || two.s < LONG_SCORE_MIN) return null;
    // **三音和弦**：两头之外，同一根干上还夹着一个（《向主唱新歌》低音 G3/D3/G2 一根带尾的干，
    // 只摘得出两个）。离已有的头都隔开 0.9 格以上，得分同第二个头那一档
    const got = [one, two];
    for (let k = got.length; k < CHORD_MAX; k++) {
      const more = bandTop(bin, masks, box, sp, step, grid, onLine, [box.y, box.y + box.h], (y) => got.every((g) => Math.abs(y - g.y) >= sp * LONG_THIRD_GAP), (y) => rowSpan(bin, box, y) >= hwL * 0.7);
      if (!more || more.s < LONG_SCORE_MIN) break;
      got.push(more);
    }
    got.sort((a, b) => a.y - b.y);
    const top = got[0];
    const bot = got[got.length - 1];
    const hw0 = Math.round(sp * 1.25);
    const hh0 = Math.round(sp * 0.95);
    return {
      head: { x: Math.round(top.x - hw0 / 2), y: Math.round(top.y - hh0 / 2), w: hw0, h: hh0 },
      extra: got.slice(1).map((g) => ({ x: Math.round(g.x - hw0 / 2), y: Math.round(g.y - hh0 / 2), w: hw0, h: hh0 })),
      // 干画满整块（两头各伸出去的那截也算）：符尾挂在端上，只画两头之间的话 `bootstrapFlags`
      // 找不到挂符尾的干，十六分、八分整批读成四分，小节跟着错位（万古磐石歌 −2.3）
      stemX: stemColumn(bin, box, top.y, bot.y),
      stemY0: box.y,
      stemY1: box.y + box.h,
    };
  }
  const hw = Math.round(sp * 1.25);
  const hh = Math.round(sp * 0.95);
  const head = { x: Math.round(best.x - hw / 2), y: Math.round(best.y - hh / 2), w: hw, h: hh };
  // **同一根符干上的和弦**：头在哪一端，就从那一端再往里找别的头（万古磐石歌放大后，
  // 三度、五度的两个头共用一根带符尾的干，连成 2.2×5.1 格的一块，只摘得出端上那个，
  // 上面的 B♭4、下面的 F3 整批漏掉）。只找「贴着第一个头的 x、纵向隔开至少 0.8 格」的，
  // 得分闸更严——这里已经不是端点，符尾、弧线蹭过的地方也在范围里。
  const atTop = best.y - box.y < box.y + box.h - best.y;
  const extra: Rect[] = [];
  const taken = [best.y];
  for (let k = 0; k < CHORD_MAX - 1; k++) {
    let more: { x: number; y: number; s: number } | null = null;
    const ya = atTop ? best.y : best.y - sp * CHORD_REACH;
    const yb = atTop ? best.y + sp * CHORD_REACH : best.y;
    for (let x = Math.round(best.x - sp * 0.4); x <= best.x + sp * 0.4; x += step)
      for (let y = ya; y <= yb; y += sp * 0.25) {
        const g = grid(y);
        if (g === null || g < ya || g > yb || taken.some((t) => Math.abs(t - g) < sp * 0.8)) continue;
        const m = masks.find((q) => q.onLine === onLine(g)) ?? masks[0];
        const sc = scoreAt(bin, m, x, g);
        // 那一行的墨要有一个头宽：光有符干的地方（线宽那么窄）不收
        // 紧挨着已收的头一个三度、那一行墨满一个头宽的：三个头上下贴成一串，模板要头的上下是白的，
        // 各扣一截，只有 0.38 上下（《向主唱新歌》A4/F♯4/D4）。这一档放到 `CHORD_SCORE_STACKED`
        const stacked = taken.some((t) => Math.abs(t - g) >= sp * 0.8 && Math.abs(t - g) <= sp * 1.2) && rowSpan(bin, box, g) >= hw * 0.95;
        if (sc >= (stacked ? CHORD_SCORE_STACKED : CHORD_SCORE_MIN) && (!more || sc > more.s) && rowSpan(bin, box, g) >= hw * 0.7) more = { x, y: g, s: sc };
      }
    if (!more) break;
    taken.push(more.y);
    extra.push({ x: Math.round(more.x - hw / 2), y: Math.round(more.y - hh / 2), w: hw, h: hh });
  }
  // 符干：头在上端就往下走，在下端就往上走。
  // **要续到符头中心**——`findStems` 的硬判据是「符干与符头纵向相交」，
  // 停在符头边缘上，`extendVSegs` 那 0.35 格续不进去，段就挂不上 `Stem` 标记，
  // `bootstrapFlags` 只看挂上标记的段，符尾于是一个都补不出来（八分整批读成四分）。
  const up = atTop; // 头在上端
  const stemX = stemColumn(bin, box, up ? head.y + head.h : box.y, up ? box.y + box.h : head.y);
  const stemY0 = up ? best.y : box.y;
  const stemY1 = up ? box.y + box.h : best.y;
  return { head, extra, stemX, stemY0, stemY1 };
}

/** 块里第 `y` 行最左到最右的墨的跨度（像素）。光有符干的行只有线宽那么宽，有头的行一整个头宽。 */
function rowSpan(bin: Binary, box: Rect, y: number): number {
  const yy = Math.round(y);
  if (yy < 0 || yy >= bin.h) return 0;
  let a = -1;
  let b = -1;
  for (let x = Math.max(0, box.x); x < Math.min(bin.w, box.x + box.w); x++)
    if (bin.data[yy * bin.w + x]) {
      if (a < 0) a = x;
      b = x;
    }
  return a < 0 ? 0 : b - a + 1;
}

/** 块里 `[y0,y1)` 那一段最密的那一列（符干的 x）。 */
function stemColumn(bin: Binary, box: Rect, y0: number, y1: number): number {
  let bx = box.x + box.w / 2;
  let bn = -1;
  for (let x = box.x; x < box.x + box.w; x++) {
    let n = 0;
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(bin.h, Math.round(y1)); y++)
      if (x >= 0 && x < bin.w && bin.data[y * bin.w + x]) n++;
    if (n > bn) {
      bn = n;
      bx = x;
    }
  }
  return bx;
}

/** 一条带里得分最高的头（门槛同单头那一档）。 */
function bandTop(
  bin: Binary, masks: HeadMask[], box: Rect, sp: number, step: number,
  grid: (y: number) => number | null, onLine: (y: number) => boolean, [ya, yb]: [number, number],
  allowY: (y: number) => boolean = () => true, rowOk: (y: number) => boolean = () => true,
): { x: number; y: number; s: number } | null {
  let bb: { x: number; y: number; s: number } | null = null;
  for (let x = box.x; x <= box.x + box.w; x += step) {
    const ys = new Set<number>();
    for (let y = ya; y <= yb; y += sp * 0.25) {
      const g = grid(y);
      if (g !== null && g >= ya - sp * 0.3 && g <= yb + sp * 0.3 && allowY(g) && rowOk(g)) ys.add(g);
    }
    for (const y of ys) {
      const m = masks.find((k) => k.onLine === onLine(y)) ?? masks[0];
      const s = scoreAt(bin, m, x, y);
      if (s >= (m.pooled ? STEM_SCORE_MIN_POOLED : STEM_SCORE_MIN) && (!bb || s > bb.s)) bb = { x, y, s };
    }
  }
  return bb;
}
