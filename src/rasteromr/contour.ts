// contour 层：把去谱线图上的**每一团墨**当作一个对象单位，连同它的形状特征记下来。
//
// 与 `prims.ts::findBlobs` 的分工——那一路是**减掉笔画之后**的连通块（符头、谱号、
// 字），是识别的输入；这一路在**减笔画之前**取轮廓，一团墨就是一个 contour
// （符头 + 符干 + 符尾连在一起是**一个** contour，松叶的一条臂也是一个）。
//
// 为什么要它：现有的每一个数量的都是「认出来的对不对」（音符 68.1%、符头认领率
// 97.4%），**没有一个数量得出「印在纸上而我们从没看见的那些」**——松叶、力度、
// 表情文字至今一个不认，报表上不留任何痕迹。给每团墨编上号、记下谁认领了它，
// 剩下的那些就是「无主 contour」，那才是往后取舍的证据。
//
// **本文件不参与任何识别判据**：只描述，不裁决。
import type { Binary, Component, Rect } from "../omr/types";
import { connectedComponents } from "../omr/ccl";
import type { RasterUnit } from "./staffline";

/** 一团墨的描述。尺寸一律**归一到线距**（同一页可能有两种谱表大小）。 */
export interface Contour {
  /** 与 `comp.id` 同一个号（`connectedComponents` 给的）。 */
  id: number;
  bbox: Rect;
  /** 前景像素数。 */
  area: number;
  /** 墨心（像素坐标）。 */
  cx: number;
  cy: number;
  /** 归一到线距的宽高。 */
  w: number;
  h: number;
  /** 填充率：墨 / 包围盒。 */
  fill: number;
  /** 孔洞数（盒内够不着边界的背景团）。空心符头 1、实心 0、降号 1、字母 a/b/e/o 1。 */
  holes: number;
  /** 最大孔洞的面积占盒的比例。 */
  holeFill: number;
  /** 边界像素数（八邻域里有背景或出界的前景像素）。 */
  perim: number;
  /** 团状度 `4π·area / perim²`：圆是 1、细长条趋近 0。松叶的臂、连音线极小。 */
  compact: number;
  /** 相对谱表的位置。 */
  place: ContourPlace;
}

/** 一团墨落在哪儿。判位置用的档，不是判身份。 */
export interface ContourPlace {
  /** 最近的那行谱（`staves` 的下标）；一行谱都没有时 -1。 */
  staff: number;
  /** 与那行谱的关系：带内 / 上方 / 下方。 */
  zone: "in" | "above" | "below";
  /** 离那行谱的带（第一线~第五线）有几个线距；带内为 0。 */
  gap: number;
}

/** 谱行的纵向范围（定位置用）。 */
export interface ContourStaff {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 一页的 contour 层：轮廓表 + 像素→id 查表。 */
export interface ContourMap {
  contours: Contour[];
  /** 逐像素的 contour id（0 = 背景）。认领时按盒查这张表。 */
  labels: Int32Array;
  w: number;
  h: number;
  /** 全页墨迹像素数（覆盖率的分母）。 */
  ink: number;
  byId: Map<number, Contour>;
}

/**
 * 抽出一页的 contour 层。
 *
 * @param bin **去谱线之后**的图（`removeStaffLines` 的产物）。不能拿原图：
 *            五条谱线把整行谱的符头符干小节线全连成一团，一页就剩十几个 contour。
 * @param staves 谱行的纵向范围，用来给每团墨定位置；没有也能跑（`place.staff = -1`）。
 */
export function traceContours(bin: Binary, unit: RasterUnit, staves: ContourStaff[] = []): ContourMap {
  const { w, h, data } = bin;
  let ink = 0;
  for (let i = 0; i < data.length; i++) if (data[i]) ink++;
  // 面积下限取得很低（4 px）：无主统计要的是**全部**没被解释的墨，
  // 识别那边的尺寸闸不该在这里预先滤掉——滤掉就看不见了。
  const labels = new Int32Array(w * h);
  // 标号图由 `connectedComponents` 顺手落下来（`out` 参数）。**不能自己再 flood 一遍**：
  // 面积不到下限的小块在那边被丢掉、却仍占着像素，照「盒里第一个没标号的前景像素」
  // 找种子会种到那种小块上，整团墨的标号就空了（实测有 35 个块的周长因此掉到个位数、
  // 团状度算出 480）。
  const comps = connectedComponents(bin, 4, labels);
  const contours = comps.map((c) => describe(bin, labels, c, unit, staves));
  const byId = new Map(contours.map((c) => [c.id, c]));
  return { contours, labels, w, h, ink, byId };
}

/** 逐块量特征。 */
function describe(bin: Binary, labels: Int32Array, c: Component, unit: RasterUnit, staves: ContourStaff[]): Contour {
  const b = c.bbox;
  const { holes, holeFill } = countHoles(labels, bin.w, c);
  const perim = countPerim(labels, bin.w, bin.h, c);
  return {
    id: c.id,
    bbox: b,
    area: c.area,
    cx: c.cx,
    cy: c.cy,
    w: b.w / unit.space,
    h: b.h / unit.space,
    fill: c.area / Math.max(1, b.w * b.h),
    holes,
    holeFill,
    perim,
    compact: perim > 0 ? (4 * Math.PI * c.area) / (perim * perim) : 0,
    place: placeOf(c, staves, unit),
  };
}

/**
 * 孔洞：在块的**包围盒 + 一圈留白**里对背景做一次 CCL，从盒边界够不着的背景团就是孔。
 *
 * 只数本块自己的孔：盒里可能还压着别的块的像素（相邻符号的盒互相重叠），
 * 那些在这里当**背景**处理——它们连着盒外，够得着边界，不会被误当成孔。
 */
function countHoles(labels: Int32Array, w: number, c: Component): { holes: number; holeFill: number } {
  const b = c.bbox;
  const bw = b.w + 2;
  const bh = b.h + 2;
  const seen = new Uint8Array(bw * bh);
  const isInk = (x: number, y: number) => {
    const gx = b.x + x - 1;
    const gy = b.y + y - 1;
    if (x <= 0 || y <= 0 || x >= bw - 1 || y >= bh - 1) return false;
    return labels[gy * w + gx] === c.id;
  };
  // 先从留白那一圈往里 flood，够得着的背景全标上
  const stack = [0];
  seen[0] = 1;
  while (stack.length) {
    const cur = stack.pop()!;
    const y = (cur / bw) | 0;
    const x = cur - y * bw;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const ni = ny * bw + nx;
      if (seen[ni] || isInk(nx, ny)) continue;
      seen[ni] = 1;
      stack.push(ni);
    }
  }
  // 剩下的背景团 = 孔
  let holes = 0;
  let biggest = 0;
  for (let y = 1; y < bh - 1; y++)
    for (let x = 1; x < bw - 1; x++) {
      const i = y * bw + x;
      if (seen[i] || isInk(x, y)) continue;
      let size = 0;
      const st = [i];
      seen[i] = 1;
      while (st.length) {
        const cur = st.pop()!;
        size++;
        const cy = (cur / bw) | 0;
        const cx = cur - cy * bw;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          const ni = ny * bw + nx;
          if (seen[ni] || isInk(nx, ny)) continue;
          seen[ni] = 1;
          st.push(ni);
        }
      }
      // 一两个像素的洞是栅格化的毛刺，不算
      if (size < 3) continue;
      holes++;
      if (size > biggest) biggest = size;
    }
  return { holes, holeFill: biggest / Math.max(1, b.w * b.h) };
}

/** 边界像素数：八邻域里有一个不是本块的，就算边界。 */
function countPerim(labels: Int32Array, w: number, h: number, c: Component): number {
  const b = c.bbox;
  let n = 0;
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) {
      if (labels[y * w + x] !== c.id) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || labels[ny * w + nx] !== c.id) {
            edge = true;
            break;
          }
        }
      if (edge) n++;
    }
  return n;
}

/** 这团墨落在哪行谱的哪一侧。 */
function placeOf(c: Component, staves: ContourStaff[], unit: RasterUnit): ContourPlace {
  if (!staves.length) return { staff: -1, zone: "below", gap: 0 };
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < staves.length; i++) {
    const st = staves[i];
    const d = c.cy < st.top ? st.top - c.cy : c.cy > st.bottom ? c.cy - st.bottom : 0;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  const st = staves[best];
  const zone = c.cy < st.top ? "above" : c.cy > st.bottom ? "below" : "in";
  return { staff: best, zone, gap: bd / unit.space };
}


/**
 * **全页的孔**：背景里够不着页边的连通团。空心符头的内腔就是它。
 *
 * 为什么值得单独跑一趟：空心符头在位图上最不稳——去谱线会把它的圈切断、
 * 符干残根粘在旁边、叠置的和弦还会碎成四五片（实测宁静 p2 钢琴右手那个二分和弦
 * 碎成 0.66×0.50 / 0.77×1.10 / 0.99×0.39 / 0.83×0.33 四块，一块都判不成符头）。
 * 但**内腔一直在**：外圈再破，只要没破到透，中间那团白就还是围着的。
 * 拿洞去找符头，比拿破碎的外圈去找稳得多。
 *
 * 在**去谱线之前**的图上跑：去谱线会把骑线符头的内腔豁开一道口子，洞就漏了。
 */
export function findHoles(bin: Binary, minArea = 4): Rect[] {
  const { w, h, data } = bin;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  // 先从四边把「通到页外」的背景全标掉
  const push = (i: number) => {
    if (!seen[i] && !data[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const cur = stack.pop()!;
    const y = (cur / w) | 0;
    const x = cur - y * w;
    if (x > 0) push(cur - 1);
    if (x + 1 < w) push(cur + 1);
    if (y > 0) push(cur - w);
    if (y + 1 < h) push(cur + w);
  }
  // 剩下的背景团就是孔
  const out: Rect[] = [];
  for (let y0 = 0; y0 < h; y0++)
    for (let x0 = 0; x0 < w; x0++) {
      const i = y0 * w + x0;
      if (seen[i] || data[i]) continue;
      let minX = x0;
      let maxX = x0;
      let minY = y0;
      let maxY = y0;
      let area = 0;
      stack.length = 0;
      seen[i] = 1;
      stack.push(i);
      while (stack.length) {
        const cur = stack.pop()!;
        const y = (cur / w) | 0;
        const x = cur - y * w;
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0) push(cur - 1);
        if (x + 1 < w) push(cur + 1);
        if (y > 0) push(cur - w);
        if (y + 1 < h) push(cur + w);
      }
      if (area >= minArea) out.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
  return out;
}
