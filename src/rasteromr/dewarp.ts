// **弯曲扫描的拉直**：按逐列的黑白游程比找到谱线，再按列整像素上下推平。
//
// 为什么另起一条：`rasterpage.ts::deskew` 只会给整页找**一个**斜率。真扫描件不是斜的
// 那么简单——书脊附近的页面是**弯**的，一页之内谱线的高度随 x 起伏几个像素，
// 一个斜率对付不了（实测破碎那份扫描件校正后仍有页面找不齐谱线）。
// 而后面每一步都建立在「谱线是一整行几乎全是墨的横带」上，弯一点横带就抹平了。
//
// ## 判据：**竖着看，黑白间隔的规律**
//
// 谱表在**任何一列**上都是「五段黑（线）夹着四段白（间）」，而且四段白几乎等长、
// 五段黑几乎等厚——这个规律与页面斜不斜、弯不弯**无关**，因为它是逐列量的。
// 逐列扫一遍黑游程，凡是能凑出这样一个五连的地方，就是一行谱在这一列的位置。
//
// > `staffline.ts` 开头那条「不靠白游程众数量线距」的教训在这里**不适用**：
// > 那条说的是拿**全页白游程的众数**当线距（符头内部、歌词笔画的空隙数量远超谱线间隙，
// > 众数落在 3~5 px）。这里不取众数，而是要求**五连等距**——
// > 歌词笔画凑不出五段等距的黑白相间，噪声更凑不出。
import type { Binary } from "../omr/types";

/** 逐列取样的步长（px）。谱线横跨整页，抽稀不影响；4 px 一页几十毫秒。 */
const COL_STEP = 4;
/** 线距的取值范围（px）。这批底本 200~300 dpi，线距实测 11~19。 */
const MIN_SPACE = 6;
const MAX_SPACE = 40;
/** 五连里四个间距彼此的相对偏差上限。 */
const EVEN_TOL = 0.22;
/** 一段「黑」最厚多少（相对线距）——比这更厚的是符头、符杠、黑边。 */
const MAX_THICK = 0.45;
/** 候选的线距离全页中位数超过这么多就不要（同一页可能两种谱表大小，留两成）。 */
const SPACE_TOL = 0.2;
/** 同一行谱在相邻取样列之间，中心 y 允许挪多少（相对线距）。 */
const TRACK_STEP = 0.5;
/** 一条轨迹要横跨页宽的几成才算数。 */
const TRACK_SPAN = 0.25;
/** 平滑窗口（取样列数）。 */
const SMOOTH = 9;
/** 逐列的位移超过这么多像素才真的动图。 */
const MIN_SHIFT = 1;

/** 一列上认出来的一行谱：中心 y 与线距。 */
export interface ColHit {
  x: number;
  cy: number;
  space: number;
  thick: number;
}

/** 一条轨迹：同一行谱在各取样列上的中心 y。 */
interface Track {
  xs: number[];
  ys: number[];
}

/**
 * 逐行谱各有各的弯法——所以位移是**二维**的：`shift(x, y)`。
 *
 * 一页扫歪/扫弯，越靠书脊弯得越厉害，**页面上下两端的形变并不相同**
 * （实测主，差遣我 p2 各行谱的偏移曲线峰值差着好几个像素）。
 * 只给一条逐列曲线（各行谱取中位数）等于把所有谱行按同一条曲线推，
 * 弯得多的那几行推不平、弯得少的反被推歪——实测那一版在扫描件上净亏。
 *
 * 这一版按**行谱分带**：每条轨迹（= 一行谱）自己一条偏移曲线，
 * 像素落在两行谱之间就按 y 在两条曲线之间线性插值，页面上下两头沿用最近那条。
 */
export function applyTrackWarp(bin: Binary, tracks: TrackCurve[]): void {
  const { w, h, data } = bin;
  const out = new Uint8Array(w * h);
  const sorted = [...tracks].sort((a, b) => a.mid - b.mid);
  const cols = sorted[0].off.length;
  for (let y = 0; y < h; y++) {
    // 这一行落在哪两条轨迹之间
    let k = 0;
    while (k + 1 < sorted.length && sorted[k + 1].mid <= y) k++;
    const a = sorted[k];
    const b = k + 1 < sorted.length ? sorted[k + 1] : null;
    const t = b && b.mid > a.mid ? Math.min(1, Math.max(0, (y - a.mid) / (b.mid - a.mid))) : 0;
    for (let x = 0; x < w; x++) {
      const i = Math.min(cols - 1, Math.round(x / COL_STEP));
      const off = b ? a.off[i] * (1 - t) + b.off[i] * t : a.off[i];
      const sy = y + Math.round(off);
      if (sy < 0 || sy >= h) continue;
      out[y * w + x] = data[sy * w + x];
    }
  }
  data.set(out);
}

/** 一行谱的偏移曲线：中位高度 + 逐取样列的偏移量。 */
export interface TrackCurve {
  mid: number;
  off: number[];
}

/**
 * **排查用**：逐列黑白游程看得见几行谱（不管页面平不平）。
 *
 * 与行投影（`findStaffLines` + `groupStaves`）是两条独立的证据：那一路要求
 * 「一整行几乎全是墨」，页面一弯就抹平；这一路逐列量，与斜弯无关。
 * 两个数一比，就知道谱线还漏不漏——见 `scripts/chorus-report.mjs` 的「谱行」两列。
 */
export function columnStaffTracks(bin: Binary): { count: number; bands: number; space: number } {
  const hits = columnHits(bin);
  if (hits.length < 20) return { count: 0, bands: 0, space: 0 };
  const spaces = hits.map((h) => h.space).sort((a, b) => a - b);
  const space = spaces[spaces.length >> 1];
  const keep = hits.filter((h) => Math.abs(h.space - space) <= space * SPACE_TOL);
  // `count` = 串成轨迹的（推平要用的，闸严）；
  // `bands` = **只按中心 y 聚一聚**（诊断用的宽松口径：轨迹会被符号打断，
  // 干净页上 100 行谱只串得出 33 条，当不了「一页有几行谱」的标尺）。
  const cys = keep.map((h) => h.cy).sort((a, b) => a - b);
  let bands = 0;
  let i = 0;
  while (i < cys.length) {
    let j = i;
    while (j + 1 < cys.length && cys[j + 1] - cys[j] <= space * 0.5) j++;
    if (j - i + 1 >= 10) bands++; // 至少十个取样列上看得见
    i = j + 1;
  }
  return { count: buildTracks(keep, space, bin.w).length, bands, space };
}

/**
 * 逐列黑白游程 → 各行谱的偏移曲线。找不到（页面本来就是平的、或谱线找不齐）返回 null。
 */
export function trackCurves(bin: Binary): TrackCurve[] | null {
  const hits = columnHits(bin);
  if (hits.length < 20) return null;
  const spaces = hits.map((h) => h.space).sort((a, b) => a - b);
  const space = spaces[spaces.length >> 1];
  const keep = hits.filter((h) => Math.abs(h.space - space) <= space * SPACE_TOL);
  const tracks = buildTracks(keep, space, bin.w);
  if (tracks.length < 2) return null;
  const cols = Math.ceil(bin.w / COL_STEP);
  const out: TrackCurve[] = [];
  let peak = 0;
  for (const t of tracks) {
    const mid = median([...t.ys]);
    const raw = new Array<number>(cols).fill(NaN);
    for (let i = 0; i < t.xs.length; i++) raw[Math.min(cols - 1, Math.round(t.xs[i] / COL_STEP))] = t.ys[i] - mid;
    const off = smoothFill(raw);
    if (!off) continue;
    for (const v of off) peak = Math.max(peak, Math.abs(v));
    out.push({ mid, off });
  }
  if (out.length < 2 || peak < MIN_SHIFT) return null;
  return out;
}

/** 逐列找「五段黑、四段白等距」的地方。**排查也用它**（见 `columnStaffTracks`）。 */
export function columnHits(bin: Binary): ColHit[] {
  const { w, h, data } = bin;
  const out: ColHit[] = [];
  const starts: number[] = [];
  const lens: number[] = [];
  for (let x = 0; x < w; x += COL_STEP) {
    starts.length = 0;
    lens.length = 0;
    let y = 0;
    while (y < h) {
      if (!data[y * w + x]) {
        y++;
        continue;
      }
      const s = y;
      while (y < h && data[y * w + x]) y++;
      starts.push(s);
      lens.push(y - s);
    }
    // 五连窗口
    for (let i = 0; i + 4 < starts.length; i++) {
      const c: number[] = [];
      let thick = 0;
      let ok = true;
      for (let k = 0; k < 5; k++) {
        c.push(starts[i + k] + lens[i + k] / 2);
        thick += lens[i + k];
      }
      const ds = [1, 2, 3, 4].map((k) => c[k] - c[k - 1]);
      const avg = (ds[0] + ds[1] + ds[2] + ds[3]) / 4;
      if (avg < MIN_SPACE || avg > MAX_SPACE) continue;
      for (const d of ds) if (Math.abs(d - avg) > avg * EVEN_TOL) ok = false;
      // 「黑」要够薄：谱线约 0.1~0.3 个线距厚，符头、符杠厚得多
      for (let k = 0; k < 5 && ok; k++) if (lens[i + k] > avg * MAX_THICK) ok = false;
      if (!ok) continue;
      out.push({ x, cy: (c[0] + c[4]) / 2, space: avg, thick: thick / 5 });
      i += 4; // 一列上认出一行谱就跳过它这五段（免得错位再凑一个）
    }
  }
  return out;
}

/** 把逐列的命中串成轨迹：x 相邻、中心 y 挨着的算同一行谱。 */
function buildTracks(hits: ColHit[], space: number, width: number): Track[] {
  const byX = new Map<number, ColHit[]>();
  for (const h of hits) {
    const a = byX.get(h.x) ?? [];
    a.push(h);
    byX.set(h.x, a);
  }
  const xs = [...byX.keys()].sort((a, b) => a - b);
  const open: { t: Track; lastX: number; lastY: number }[] = [];
  const done: Track[] = [];
  const maxJump = COL_STEP * 6;
  for (const x of xs) {
    const used = new Set<ColHit>();
    for (const o of open) {
      if (x - o.lastX > maxJump) continue;
      let best: ColHit | null = null;
      let bd = space * TRACK_STEP;
      for (const h of byX.get(x)!) {
        if (used.has(h)) continue;
        const d = Math.abs(h.cy - o.lastY);
        if (d < bd) {
          bd = d;
          best = h;
        }
      }
      if (!best) continue;
      used.add(best);
      o.t.xs.push(x);
      o.t.ys.push(best.cy);
      o.lastX = x;
      o.lastY = best.cy;
    }
    for (const h of byX.get(x)!) {
      if (used.has(h)) continue;
      open.push({ t: { xs: [x], ys: [h.cy] }, lastX: x, lastY: h.cy });
    }
    // 断掉太久的收工
    for (let i = open.length - 1; i >= 0; i--)
      if (x - open[i].lastX > maxJump) {
        done.push(open[i].t);
        open.splice(i, 1);
      }
  }
  for (const o of open) done.push(o.t);
  return done.filter((t) => t.xs.length >= 8 && t.xs[t.xs.length - 1] - t.xs[0] >= width * TRACK_SPAN);
}

/** 缺口按最近的有效值补上，再做一遍滑动中位数。 */
function smoothFill(raw: number[]): number[] | null {
  const n = raw.length;
  const filled = new Array<number>(n).fill(NaN);
  let last = NaN;
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(raw[i])) last = raw[i];
    filled[i] = last;
  }
  let next = NaN;
  for (let i = n - 1; i >= 0; i--) {
    if (!Number.isNaN(raw[i])) next = raw[i];
    if (Number.isNaN(filled[i])) filled[i] = next;
  }
  if (filled.some((v) => Number.isNaN(v))) return null;
  const out = new Array<number>(n);
  const half = SMOOTH >> 1;
  for (let i = 0; i < n; i++) {
    const a: number[] = [];
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n) a.push(filled[j]);
    }
    out[i] = median(a);
  }
  return out;
}

function median(a: number[]): number {
  a.sort((x, y) => x - y);
  return a.length ? a[a.length >> 1] : 0;
}
