// 谱线：量出**基本单位**（线宽与线距），再把五条一组的谱线找出来。
//
// 这是位图路的第一块判据，后面所有几何门槛都按这里量出来的线距写
// ——与矢量路同一个口径（`page.ts`：「一切长度都是小节线高度 H 的比例」）。
import type { Binary } from "../omr/types";

/** 页面的基本单位。musicpp `omr/pixel.cpp::findUnit` 量的就是这两个。 */
export interface RasterUnit {
  /** 谱线线宽（px）。 */
  lineThick: number;
  /** 一个线距（px，两条相邻谱线的中心距）。 */
  space: number;
  /** 谱表高度 = 小节线高度 H = 四个线距。矢量路的 `SPage.barlineHeight` 就是它。 */
  height: number;
}

/**
 * 量线宽与线距：**先找谱线，再从五条一组反推**。
 *
 * 试过先量单位再找线，不行：musicpp `pixel.cpp::findUnit` 的办法是取逐列黑白游程的
 * 众数，一页乐谱里最多的白色纵向游程「应该」是两条谱线之间那一段——
 * 这本书上不成立。符头内部、歌词笔画之间、和弦图格线的小空隙数量远超谱线间隙，
 * 白游程众数实测落在 3~5 px，而真线距是 17~19 px（差了四倍，后面所有门槛全废）。
 *
 * 反过来做就没这个问题：谱线是「一整行几乎全是墨」的横带，行投影一次就找齐
 * （实测宁静的伯利恒 p1 一次找出 50 条 = 10 行谱，分毫不差）；
 * 五条一组分出来之后，组内相邻线的间距就是线距，取全页中位数。
 * **线宽**取这些谱线横带的中位厚度——那是真谱线的厚度，不掺别的。
 */
export function estimateUnit(bin: Binary): RasterUnit | null {
  const lines = findStaffLines(bin);
  const groups = groupStaves(lines);
  if (!groups.length) return null;
  const spaces = groups.map((g) => g.space).sort((a, b) => a - b);
  const thicks = groups.flatMap((g) => g.lines.map((l) => l.y1 - l.y0 + 1)).sort((a, b) => a - b);
  const space = spaces[spaces.length >> 1];
  const lineThick = thicks[thicks.length >> 1];
  return { lineThick, space, height: space * 4 };
}

/** 一条谱线：中心 y、上下沿、左右端。 */
export interface StaffLineRun {
  y: number;
  y0: number;
  y1: number;
  left: number;
  right: number;
}

/** 谱线候选的墨迹占比门槛：一行里至少这么多列有墨。比这更短的横线是符杠、加线、渐强线。 */
const LINE_INK_RATIO = 0.3;

/**
 * 找谱线：行投影取出「几乎整行都是墨」的横带，再逐条量它的左右端。
 *
 * **不依赖线距**——线距要靠它反推出来（见 `estimateUnit`）。所以两道门槛都写成
 * 页面尺寸的比例：厚度不超过页高的 1%（比这更厚的是黑边、粗横线、整块反白），
 * 左右端允许中断，连续空白不超过页宽的 5%。
 *
 * 左右端**必须允许中断**：谱线被小节线、符干、歌词框断开是常态，
 * 不允许的话一行谱会碎成十几截，后面「长度 ≥ 最长横线的 35%」那道闸全过不去。
 *
 * 这一版**不处理倾斜**（合唱谱这批底本实测倾斜 ≤1.23px，行投影一次就找齐）。
 * 真扫描件（倾斜 3~4px）要改成按纵向分带各投影一次再连起来，那时再说。
 */
export function findStaffLines(bin: Binary): StaffLineRun[] {
  const { w, h, data } = bin;
  const th = w * LINE_INK_RATIO;
  const maxThick = Math.max(6, h * 0.01);
  const maxGap = w * 0.05;
  const bands: [number, number][] = [];
  let start = -1;
  for (let y = 0; y < h; y++) {
    let n = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) n += data[row + x];
    if (n > th) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      bands.push([start, y - 1]);
      start = -1;
    }
  }
  if (start >= 0) bands.push([start, h - 1]);

  const out: StaffLineRun[] = [];
  for (const [y0, y1] of bands) {
    if (y1 - y0 + 1 > maxThick) continue;
    // 逐列有没有墨
    const ink = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let y = y0; y <= y1; y++) v |= data[y * w + x];
      ink[x] = v;
    }
    // 端点要**连续有墨**才算，不能见到一个墨点就算起点：
    // 系统的花括号、乐器名的笔画常常擦到谱线这一带，一擦谱行的左缘就跑到页边
    // （实测宁静 p1 十行谱里六行的左缘被拉到 x=2，`makeSystems` 判系统线、
    // `makeBars` 切小节全跟着偏）。要求连着 `runMin` 列有墨。
    const runMin = Math.max(4, Math.round(maxGap / 4));
    let left = -1;
    for (let x = 0; x + runMin <= w; x++) {
      let ok = true;
      for (let k = 0; k < runMin; k++)
        if (!ink[x + k]) {
          ok = false;
          x += k;
          break;
        }
      if (ok) {
        left = x;
        break;
      }
    }
    if (left < 0) continue;
    let right = left;
    let gap = 0;
    for (let x = left; x < w; x++) {
      if (ink[x]) {
        right = x;
        gap = 0;
      } else if (++gap > maxGap) break; // 断得太开：右边那截多半是另一件东西
    }
    out.push({ y: (y0 + y1) / 2, y0, y1, left, right });
  }
  return out;
}

/** 一行谱：五条线加它们定出来的线距。 */
export interface StaffGroup {
  lines: StaffLineRun[];
  /** 组内相邻线的平均间距。 */
  space: number;
}

/**
 * 五条一组。判据两道：
 *   - 组内四个间距彼此相差不超过两成（等距）；
 *   - 五条线的 x 区间交集不短于最短那条的八成（同一行谱的五条线跨度几乎相同）。
 *
 * 第二道不能省：一页上下两行谱的 y 序列首尾相接，光靠等距会把上一行的末两条
 * 与下一行的头三条凑成一「行」。
 */
export function groupStaves(lines: StaffLineRun[]): StaffGroup[] {
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  const out: StaffGroup[] = [];
  for (let i = 0; i + 4 < sorted.length; ) {
    const five = sorted.slice(i, i + 5);
    const ds = [1, 2, 3, 4].map((k) => five[k].y - five[k - 1].y);
    const avg = ds.reduce((a, b) => a + b, 0) / 4;
    const even = avg > 0 && ds.every((d) => Math.abs(d - avg) <= avg * 0.2);
    const left = Math.max(...five.map((l) => l.left));
    const right = Math.min(...five.map((l) => l.right));
    const shortest = Math.min(...five.map((l) => l.right - l.left));
    if (even && right - left >= shortest * 0.8) {
      out.push({ lines: five, space: avg });
      i += 5;
    } else i++;
  }
  return out;
}
