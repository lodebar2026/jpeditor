// 歌本 profile：从矢量对象统计出「这本书用了哪几套字号/字体族、版心在哪、页眉页脚带在哪」。
//
// 为什么要它：光栅路的判据全靠 `numH`（音符数字高度中位数）这一个从像素统计来的尺度，
// 跨图不稳、每条阈值都得留余量（见 docs/实现/OMR-简谱识别.md）。矢量路能直接量到
// 精确字号，而印刷歌本**整本共用同一套字号**——把它固化成 profile，下游判据就从
// 「统计推断」变成「查表」。
//
// 本文件只产出**客观统计**（尺寸族、版心、带位）。族的**角色**（标题/歌词/音符/和弦…）
// 要靠谱行结构才能判，那是 inventory.ts 的事，判完回填 `family.role`。
//
// 无 DOM 依赖（Node CLI 要用）。
import type { Rect } from "./types";
import type { VecObj, VecPage } from "./vector";

/** 字形族的角色。由 inventory.ts 判定后回填。 */
export type FamilyRole =
  | "title" // 歌曲标题（本书是魏碑类，与歌词的宋体不是一套）
  | "songNumber" // 曲号 028 / J07
  | "note" // 音符数字
  | "tuplet" // 三连音数字、上标小字
  | "lyric" // 主歌词
  | "lyric2" // 次号歌词
  | "chord" // 和弦符号
  | "credit" // 词曲署名
  | "section" // 段落词（副歌…）
  | "header" // 页眉分类词
  | "footer" // 页码
  | "story" // 花边框内的注解正文
  | "unknown";

/** 一个字号族：轮廓高度落在同一档的字形。 */
export interface FamilySpec {
  id: string; // 形如 "h8.1"
  role: FamilyRole;
  /** 轮廓高度：中位数与区间。 */
  h: number;
  hMin: number;
  hMax: number;
  /** 轮廓宽度中位数（汉字近方，宽≈字号；拉丁窄）。 */
  w: number;
  /** 实例数与形状类数（形状类数 ≈ 这一族用到的不同字符数）。 */
  count: number;
  /** 出现位置的页内相对 y（0=页顶）分位，用来看它固定在哪一带。 */
  yP10: number;
  yP50: number;
  yP90: number;
}

export interface BookProfile {
  id: string;
  pageW: number;
  pageH: number;
  /** 版心：全书内容包络（去掉离群的裁切标记后）。 */
  contentBox: Rect;
  /** 字号族，按实例数降序。 */
  families: FamilySpec[];
  /** 八度点/附点的直径中位数。 */
  dotDiam: number;
  /** 页眉带 / 页脚带的 y 区间（页内绝对坐标）。 */
  headerBand: [number, number] | null;
  footerBand: [number, number] | null;
  /** 采样了多少页、多少对象。 */
  sampledPages: number;
  sampledObjs: number;
}

/** 统计原料。 */
export interface GlyphStat {
  page: number;
  h: number;
  w: number;
  x: number;
  y: number;
  cy: number;
  curves: number;
  pageH: number;
  pageW: number;
}

/** 只收「字形状」的对象：带曲线、尺寸在合理字号范围内。
 *  纯直线对象（减时线/小节线/分隔线）不是字，另行处理。 */
export function isGlyphLike(o: VecObj): boolean {
  return o.curves >= 1 && o.bbox.w > 0.5 && o.bbox.h > 0.5;
}

/** 从若干页收集字形尺寸样本。 */
export function collectGlyphStats(pages: VecPage[]): GlyphStat[] {
  const out: GlyphStat[] = [];
  for (const p of pages) {
    for (const o of p.objs) {
      if (!isGlyphLike(o)) continue;
      out.push({
        page: p.page,
        h: o.bbox.h,
        w: o.bbox.w,
        x: o.bbox.x,
        y: o.bbox.y,
        cy: o.bbox.y + o.bbox.h / 2,
        curves: o.curves,
        pageH: p.height,
        pageW: p.width,
      });
    }
  }
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

/**
 * 一维聚类：把高度按**相对容差**合起来（字号是乘性的，绝对容差在小字号上会过粗）。
 * `relTol` 是同族内允许的高度相对偏差；实测这本书各族界限很干净，0.06 足够分开
 * 8.1 / 8.3 / 8.4 这种相邻档，又不会把同一族的抖动拆散。
 */
export function clusterBySize(values: number[], relTol = 0.06): { center: number; min: number; max: number; n: number }[] {
  if (!values.length) return [];
  const v = [...values].sort((a, b) => a - b);
  const groups: { vals: number[] }[] = [];
  let cur: number[] = [v[0]];
  for (let i = 1; i < v.length; i++) {
    // 与当前组的中位比：超过 relTol 就另起一组
    const med = cur[Math.floor(cur.length / 2)];
    if (Math.abs(v[i] - med) / Math.max(med, 0.01) > relTol) {
      groups.push({ vals: cur });
      cur = [];
    }
    cur.push(v[i]);
  }
  groups.push({ vals: cur });
  return groups.map((g) => ({
    center: g.vals[Math.floor(g.vals.length / 2)],
    min: g.vals[0],
    max: g.vals[g.vals.length - 1],
    n: g.vals.length,
  }));
}

/** 圆点（八度点/附点）：近圆、很小、单一闭合轮廓。 */
function isDot(o: VecObj): boolean {
  const { w, h } = o.bbox;
  return o.curves >= 1 && w > 0.4 && w < 4 && h > 0.4 && h < 4 && Math.abs(w - h) / Math.max(w, h) < 0.25;
}

/**
 * 从采样页推出 profile。
 * `pages` 建议取乐谱正文页（跳开封面/目录），页数不必多——整本共用一套字号。
 */
export function detectProfile(pages: VecPage[], id = "unknown"): BookProfile {
  const stats = collectGlyphStats(pages);
  const pageW = pages[0]?.width ?? 0;
  const pageH = pages[0]?.height ?? 0;

  // ── 字号族
  const clusters = clusterBySize(stats.map((s) => s.h));
  const families: FamilySpec[] = [];
  for (const c of clusters) {
    if (c.n < Math.max(8, stats.length * 0.001)) continue; // 噪声档丢掉
    const members = stats.filter((s) => s.h >= c.min && s.h <= c.max);
    const ws = members.map((m) => m.w).sort((a, b) => a - b);
    const ys = members.map((m) => (m.pageH ? m.cy / m.pageH : 0)).sort((a, b) => a - b);
    families.push({
      id: `h${c.center.toFixed(1)}`,
      role: "unknown",
      h: c.center,
      hMin: c.min,
      hMax: c.max,
      w: quantile(ws, 0.5),
      count: c.n,
      yP10: quantile(ys, 0.1),
      yP50: quantile(ys, 0.5),
      yP90: quantile(ys, 0.9),
    });
  }
  families.sort((a, b) => b.count - a.count);

  // ── 圆点直径
  const dots: number[] = [];
  for (const p of pages) for (const o of p.objs) if (isDot(o)) dots.push((o.bbox.w + o.bbox.h) / 2);
  dots.sort((a, b) => a - b);

  // ── 版心：所有对象包络的 2%/98% 分位（甩掉页角裁切标记）
  const xs: number[] = [];
  const ys: number[] = [];
  const xe: number[] = [];
  const ye: number[] = [];
  for (const p of pages) {
    for (const o of p.objs) {
      xs.push(o.bbox.x);
      ys.push(o.bbox.y);
      xe.push(o.bbox.x + o.bbox.w);
      ye.push(o.bbox.y + o.bbox.h);
    }
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  xe.sort((a, b) => a - b);
  ye.sort((a, b) => a - b);
  const cx0 = quantile(xs, 0.02);
  const cy0 = quantile(ys, 0.02);
  const cx1 = quantile(xe, 0.98);
  const cy1 = quantile(ye, 0.98);

  // ── 页脚带：版心下沿以下、离群在底部的那一小撮（页码）
  const footerYs = ys.filter((y) => y > cy1);
  const headerYs = ys.filter((y) => y < cy0);

  return {
    id,
    pageW,
    pageH,
    contentBox: { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 },
    families,
    dotDiam: dots.length ? dots[Math.floor(dots.length / 2)] : 0,
    headerBand: headerYs.length ? [quantile(headerYs, 0.05), cy0] : null,
    footerBand: footerYs.length ? [cy1, quantile(footerYs, 0.95)] : null,
    sampledPages: pages.length,
    sampledObjs: stats.length,
  };
}
