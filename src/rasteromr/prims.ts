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
import { SIG_N } from "../omr/glyphdict";
import { connectedComponents } from "../omr/ccl";
import type { RasterUnit } from "./staffline";

/** 一条直线段（像素坐标）。 */
export interface LineSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 线宽（横段取厚度、竖段取宽度），**取平均**——几何判据要的是视觉线宽。 */
  lw: number;
  /** 连通块的**最大**厚度。抹笔画时用它，不能用平均：
   *  符干的两头常常粗一点（与符头相接处），照平均抹会在符头边上留一条 0.17 格的残渣
   *  ——实测宁静一首里这种残渣有五百多个，全都混进了符号块。 */
  maxLw: number;
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
    return { x0: b.x, y0: meanY(b.x, b.x + q), x1: b.x + b.w - 1, y1: meanY(b.x + b.w - q, b.x + b.w), lw: c.area / Math.max(b.w, 1), maxLw: b.h };
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
  return { x0: meanX(b.y, b.y + q), y0: b.y, x1: meanX(b.y + b.h - q, b.y + b.h), y1: b.y + b.h - 1, lw: c.area / Math.max(b.h, 1), maxLw: b.w };
}

/**
 * 这条笔画是不是**孤立**的——两侧（横段则上下）**都**空着。
 *
 * 非有这一条不可：谱号的中央竖笔、升号的两道竖笔、拍号「4」的竖笔，
 * 横向游程都很短，一律被当成竖笔画抽走，于是**符号被自己的笔画切开**
 * （实测高音谱号被切成上下两半，`bootstrapClefs` 取到的「谱号」一多半是它的上半截，
 * 高度不到 3.8 格，整批误判成低音谱号：你要等候 76 行谱认出 69 个「低音谱号」）。
 *
 * 沿笔画取样，两侧合计的邻墨超过取样行数就判它属于某个符号。
 * 真符干、真小节线两侧是空的，只在符头、符杠那一小截有邻墨。
 *
 * **试过分左右两侧、两侧都被挨着才算「属于符号」**（想放行被花括号贴着的系统线），
 * 更差：这么一放，谱号的中央竖笔也过了闸，低音谱号又被切开
 * （破碎 p7/p8 整页的谱号变成未知）。系统线另走**位置豁免**，见 `sysLeft`。
 */
function isolated(bin: Binary, s: LineSeg, vertical: boolean): boolean {
  const { w, h, data } = bin;
  const half = Math.max(1, Math.ceil(s.maxLw / 2));
  const near = half + 1;
  const far = half + Math.max(2, Math.round(s.maxLw * 2));
  let n = 0;
  let a = 0; // 两侧任一侧有邻墨的行数
  if (vertical) {
    const cx = Math.round((s.x0 + s.x1) / 2);
    for (let y = Math.round(Math.min(s.y0, s.y1)); y <= Math.round(Math.max(s.y0, s.y1)); y++) {
      if (y < 0 || y >= h) continue;
      n++;
      let hit = 0;
      for (let d = near; d <= far && !hit; d++) {
        if (cx - d >= 0) hit |= data[y * w + cx - d];
        if (cx + d < w) hit |= data[y * w + cx + d];
      }
      a += hit;
    }
  } else {
    const cy = Math.round((s.y0 + s.y1) / 2);
    for (let x = Math.round(Math.min(s.x0, s.x1)); x <= Math.round(Math.max(s.x0, s.x1)); x++) {
      if (x < 0 || x >= w) continue;
      n++;
      let hit = 0;
      for (let d = near; d <= far && !hit; d++) {
        if (cy - d >= 0) hit |= data[(cy - d) * w + x];
        if (cy + d < h) hit |= data[(cy + d) * w + x];
      }
      a += hit;
    }
  }
  return n === 0 || a < n * 0.5;
}

/**
 * 「这个 y 落在谱线网格的延长线上吗」——判加线用。
 *
 * 加线是谱表的延长：只可能出现在第一线**上方**或第五线**下方**整数个线距处。
 * 容差取四分之一线距（谱线本身实测偏差不到 0.2px，位图上加线也贴着网格画）。
 */
export function ledgerGrid(lineYs: number[], unit: RasterUnit): (y: number) => boolean {
  if (lineYs.length < 5) return () => false;
  // 逐行谱取它的第一线与第五线（`lineYs` 是全页的线，五条一组）
  const anchors: number[] = [];
  const sorted = [...lineYs].sort((a, b) => a - b);
  for (let i = 0; i + 4 < sorted.length; i += 5) {
    anchors.push(sorted[i], sorted[i + 4]);
  }
  const tol = unit.space * 0.25;
  return (y: number) => {
    for (let i = 0; i < anchors.length; i += 2) {
      const top = anchors[i];
      const bottom = anchors[i + 1];
      if (y < top) {
        const k = Math.round((top - y) / unit.space);
        if (k >= 1 && k <= 6 && Math.abs(top - k * unit.space - y) <= tol) return true;
      } else if (y > bottom) {
        const k = Math.round((y - bottom) / unit.space);
        if (k >= 1 && k <= 6 && Math.abs(bottom + k * unit.space - y) <= tol) return true;
      }
    }
    return false;
  };
}

/**
 * 竖段的端点**沿着墨往里续**，至多 `cap` 个像素。返回续过的副本。
 *
 * 为什么要续：符干在与符头相接处横向游程一下子变成整个符头的宽度，出了「细」的那道闸，
 * 竖笔画就在符头**边界前一两个像素**断掉（实测缺口中位数只有 0.06 格）。
 * 而 `findStems` / `buildStems` 要的是符干与符头**纵向相交**，差一个像素就不成立
 * ——实测破碎 2218 个符头里只有 642 个（28.9%）配得上符干，其余全读成四分音符，
 * 符杠也因此接不上符干（层号 0 的占 304/1042）。
 *
 * 为什么只对竖段做：横段（谱线、加线）本来就该在符号处断开——那正是
 * 「上下都没墨才抹」判据的依据；竖段断在符头边上则是纯粹的**假边界**。
 *
 * **只给 `adapt.ts` 用，不回写 `prims`**：`blobImage` 按段的包围盒抹墨，
 * 续进符头的段会把符头啃掉一条，符头就认不出来了
 * （实测直接在 `findPrimitives` 里续，小节自检 27.4% → 31.4% 但音符 65.1% → 62.5%）。
 *
 * 续的时候看中心线左右各一列（符干只有一两个像素宽，中心线是拟合出来的，
 * 只看一列会被半像素的偏差卡住）。碰到白就停——不跨空隙，所以续不出别的符号。
 */
export function extendVSegs(bin: Binary, segs: LineSeg[], cap: number): LineSeg[] {
  return segs.map((s) => {
    const out = { ...s };
    extendIntoInk(bin, out, cap);
    return out;
  });
}

function extendIntoInk(bin: Binary, seg: LineSeg, cap: number): void {
  const { w, h, data } = bin;
  const ink = (x: number, y: number) => {
    if (y < 0 || y >= h) return false;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.round(x) + dx;
      if (xx >= 0 && xx < w && data[y * w + xx]) return true;
    }
    return false;
  };
  let up = 0;
  while (up < cap && ink(seg.x0, Math.round(seg.y0) - up - 1)) up++;
  let down = 0;
  while (down < cap && ink(seg.x1, Math.round(seg.y1) + down + 1)) down++;
  seg.y0 -= up;
  seg.y1 += down;
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
export function findPrimitives(
  bin: Binary,
  unit: RasterUnit,
  staffLineYs: number[] = [],
  /** 各谱行的左缘 x。**系统线按位置豁免孤立性判据**——它就画在谱行左缘，
   *  紧贴它的花括号会让「两侧有没有邻墨」判它属于某个符号，
   *  于是整页的系统线一条都抽不出来，十行谱碎成十个系统
   *  （实测破碎 p5 起就是这样，`buildScore` 随之把一个声部拆成好几条）。 */
  staffLefts: number[] = [],
): RasterPrims {
  const { w, h } = bin;
  const onGrid = ledgerGrid(staffLineYs, unit);
  const atStaffLeft = (x: number) => staffLefts.some((l) => Math.abs(x - l) <= Math.max(3, unit.lineThick * 2));
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
    // 长度下限：一个线距。**落在谱线网格上的放宽到三分之一格**——
    // 加线被压在它上面的符头从中间切断（符头的纵向游程粗，不在横笔画的掩模里），
    // 剩下左右两截各只有 0.4 格，照一个线距的闸两截都被滤掉，
    // 于是「谱表外一条加线」的音符（高音谱表下面的 C4）整批收不进来
    // ——实测宁静一首的人声行开头 `C4 C4 B3 C4` 只认出 B3。
    // 试过把水平闭运算的半径从 0.6 格放到 1.0/1.5 格把两截接起来，**更差**
    //（音符 28.5% → 25.2% / 21.8%）：半径一大，别处不相干的横笔画也被连成一条。
    const cy = c.bbox.y + c.bbox.h / 2;
    if (c.bbox.w < (onGrid(cy) ? unit.space / 3 : unit.space)) continue;
    if (c.bbox.h > thin * 2) continue; // 太厚：不是单条横线（是几条粘在一起或别的东西）
    const seg = centerLine(hMask, w, c, true);
    // **加线免检**：加线总有个符头压在上面，孤立性判据一律判它「属于某个符号」，
    // 于是既抽不出来（`findLegers` 没得用）、也抹不掉（符头连着加线，
    // 宽度从 1.3 格涨到 1.77 格，字典里凭空多出两个三百多实例的「符头」大类）。
    // 加线有一条更硬的判据：它只出现在**谱线网格的延长线**上。
    if (!onGrid((seg.y0 + seg.y1) / 2) && !isolated(bin, seg, false)) continue;
    hSegs.push(seg);
  }

  // ── 竖笔画 ──
  const vMask0 = new Uint8Array(w * h);
  for (let i = 0; i < vMask0.length; i++) if (hr[i] && hr[i] <= thin) vMask0[i] = 1;
  const vMask = close1d(vMask0, w, h, Math.round(unit.lineThick * 2), false);
  const vSegs: LineSeg[] = [];
  for (const c of comps(vMask, w, h, Math.max(3, unit.lineThick * 2))) {
    if (c.bbox.h < unit.space) continue;
    if (c.bbox.w > thin * 2) continue;
    const seg = centerLine(vMask, w, c, false);
    // 谱行左缘那条（系统线）免检，其余要判孤立性——谱号的中央竖笔、升号的竖笔不是原语
    if (!atStaffLeft((seg.x0 + seg.x1) / 2) && !isolated(bin, seg, true)) continue;
    vSegs.push(seg);
  }

  // ── 符杠 ──
  const bMask = new Uint8Array(w * h);
  const bLo = unit.space * 0.25;
  const bHi = unit.space * 1.1;
  for (let i = 0; i < bMask.length; i++) if (vr[i] >= bLo && vr[i] <= bHi && hr[i] >= unit.space) bMask[i] = 1;
  // **沿 x 闭一道**，与横笔画同一个道理：符干穿过符杠的那几列横向游程很短，
  // 出了「横向游程 ≥ 一个线距」这道闸，符杠于是被每根符干切成小段
  //（实测你要等候 p2 一条符杠碎成 1.33~1.65 格的六截，`w ≥ 1.5 格` 那道闸挡掉大半，
  // 整页 199 个符头只认出 44 条符杠——音符排得密的谱子尤其吃亏）。
  // 半径取两个线宽：符干就这么粗，再大会把相邻两组的符杠连成一条。
  const bMaskC = close1d(bMask, w, h, Math.round(unit.lineThick * 2), true);
  const beams: BeamQuad[] = [];
  for (const c of comps(bMaskC, w, h, Math.round(unit.space * unit.space * 0.2))) {
    if (c.bbox.w < unit.space * 1.5) continue; // 太短的不是符杠（照矢量路 findBeams 的 0.8 格，位图放宽到 1.5）
    if (c.bbox.h > unit.space * 3) continue; // 太高：是实心块、方框
    // **要够扁**。光靠上面两条拦不住符头：实心符头约 1.3×1.0 个线距，
    // 纵向游程（18px）落在符杠区间里、横向游程也过线，宽度还差一点点就够。
    // 符杠是 3:1 往上的长条，符头是 1.3:1 的椭圆，长宽比一刀分得开。
    if (c.bbox.w < c.bbox.h * 2.5) continue;
    const line = centerLine(bMaskC, w, c, true);
    beams.push({ ...line, box: c.bbox });
  }
  return { hSegs, vSegs, beams };
}

/**
 * 去谱线：把属于谱线的像素抹掉，留下符头/符干/符杠/字。
 *
 * 判据是**上下都没有墨才抹**（经典的「保符号去线」做法）：
 * 谱线那一带的某一列，如果紧邻的上方与下方都是白的，那这一段就是**孤立的谱线**，
 * 抹掉；只要有一侧连着墨，它就是某个符号穿过谱线的那一截，留着。
 *
 * 一度只判「纵向游程短」，那会把**骑在谱线上的细笔画一起抹断**：
 * 拍号数字、休止符、谱号都压在谱线上，笔画细的地方游程正好短，一抹就断成两截，
 * 于是同一个符号按断法不同散成好几个形状类（实测四分休止散成四类、
 * 拍号数字散成一堆认不出的碎块）。上下有没有墨这一条不看粗细，只看连不连着。
 */
export function removeStaffLines(bin: Binary, lineYs: number[], unit: RasterUnit): Binary {
  const { w, h, data } = bin;
  const out: Binary = { w, h, data: new Uint8Array(data) };
  const half = unit.lineThick / 2 + 1;
  // 往外看多远算「紧邻」：一个线宽足矣。看太远会把间距里的符头也算成「连着」，
  // 谱线就抹不掉了。
  const look = Math.max(1, Math.round(unit.lineThick));
  for (const cy of lineYs) {
    const y0 = Math.max(0, Math.floor(cy - half));
    const y1 = Math.min(h - 1, Math.ceil(cy + half));
    for (let x = 0; x < w; x++) {
      let up = 0;
      for (let y = Math.max(0, y0 - look); y < y0; y++) up |= data[y * w + x];
      if (up) continue;
      let down = 0;
      for (let y = y1 + 1; y <= Math.min(h - 1, y1 + look); y++) down |= data[y * w + x];
      if (down) continue;
      for (let y = y0; y <= y1; y++) out.data[y * w + x] = 0;
    }
  }
  return out;
}

/**
 * 符号块：去掉谱线、竖笔画、符杠、横段之后剩下的连通块。
 *
 * 剩下的就是**要查字典的那些**：符头、谱号、调号、拍号数字、休止符、
 * 升降号、附点、演奏法记号、力度字母、歌词字。
 *
 * 为什么先减笔画再连通：符头与符干是连着的，符干又骑在谱线上，
 * 不减的话半页连成一块。减完之后符头是个孤立的椭圆，谱号是个孤立的字形。
 *
 * 减的时候要**按线宽外扩一点**（`lw / 2 + 1`）：中心线是拟合出来的，
 * 直接照中心线抹只抹掉一像素宽，笔画的两侧还留着，连通关系照旧。
 */
export function findBlobs(bin: Binary, prims: RasterPrims, unit: RasterUnit): Component[] {
  const rest = blobImage(bin, prims, unit);
  // 宽高**分别**设限，不能共用一个数：高音谱号窄而高，实测 2.8 × **7.5** 个线距
  //（连着尾巴那一圈），共用「六个线距」的上限会把整页的谱号挡在外面
  // ——`bootstrapClefs` 因此在宁静一首上一个高音谱号都取不到。
  // 花括号（18×283px = 1 × 15.6 格）与页边框仍然被高度那一档挡住，
  // 另由 `findBraces` 收（`StaffToken` 要靠它分开人声行与钢琴行）。
  const minSide = unit.space * 0.25;
  const maxW = unit.space * 6;
  const maxH = unit.space * 9;
  return connectedComponents(rest, Math.round(minSide * minSide)).filter((c) => {
    const b = c.bbox;
    if (b.w > maxW || b.h > maxH) return false;
    if (b.w < minSide && b.h < minSide) return false;
    return true;
  });
}

/**
 * **花括号 / 系统括号**：页面左端那个又高又窄的东西。
 *
 * `StaffToken`（`score.ts`）靠 `topOfBrace`/`bottomOfBrace` 分开「钢琴的上下两行」
 * 与「人声行」——不认花括号的话，同一个系统里所有 G 谱号行的签名完全相同，
 * `buildScore` 的 LCS 只能靠顺序分；系统行数一变（这本合唱谱从 2 行长到 7 行）
 * 就会把声部接错，一个声部碎成好几条。
 *
 * 判据：
 *   - 在**所有谱行左缘之左**（系统线正在左缘上，不算）；
 *   - 高度至少一个半谱表高（只盖住一行的不构成「把两行括起来」）；
 *   - 宽度不到两个线距（再宽的是别的东西）。
 */
export function findBraces(
  bin: Binary,
  prims: RasterPrims,
  unit: RasterUnit,
  staffLefts: number[],
  /** 各谱行的纵向范围。**只留恰好罩住两行的**，见下。 */
  staffSpans: { top: number; bottom: number }[] = [],
): Component[] {
  if (!staffLefts.length) return [];
  const rest = blobImage(bin, prims, unit);
  const leftMost = Math.min(...staffLefts);
  const staffH = unit.space * 4;
  return connectedComponents(rest, Math.round(unit.space * unit.space * 0.5)).filter((c) => {
    const b = c.bbox;
    if (b.x + b.w > leftMost) return false;
    if (b.h < staffH * 1.5) return false;
    if (b.w > unit.space * 2) return false;
    // **只留恰好罩住两行谱的**。页面左端还有一个把整个系统括起来的大括号，
    // 收进来的话这个系统里每一行都「在括号里」，`topOfBrace`/`bottomOfBrace`
    // 就分不开人声行与钢琴行了（实测破碎 p7 五行谱全被标成在括号里）。
    // 钢琴大谱表的花括号恰好罩两行——那正是这两个字段的本意。
    if (staffSpans.length) {
      const n = staffSpans.filter((s) => s.top < b.y + b.h && b.y < s.bottom).length;
      if (n !== 2) return false;
    }
    return true;
  });
}

/** 抹掉笔画之后剩下的墨——`findBlobs` 与 `findBraces` 都从它出发。 */
function blobImage(bin: Binary, prims: RasterPrims, unit: RasterUnit): Binary {
  const { w, h } = bin;
  const rest = new Uint8Array(bin.data);
  const clear = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = Math.max(0, Math.round(y0)); y <= Math.min(h - 1, Math.round(y1)); y++)
      for (let x = Math.max(0, Math.round(x0)); x <= Math.min(w - 1, Math.round(x1)); x++) rest[y * w + x] = 0;
  };
  for (const s of [...prims.vSegs, ...prims.hSegs]) {
    // **短横段只抽不抹**：那是被符头切断的加线残段（见 `findPrimitives` 里的说明），
    // 它就压在符头边上，照抹会把符头啃掉一块——填充率与尺寸一变，
    // `findRasterHeads` 就认不出它了（实测这么抹音符从 28.5% 掉到 27.0%）。
    // 抽出来交给 `findLegers` 判「谱表外的音符有没有加线撑着」，别动像素。
    if (Math.abs(s.x1 - s.x0) >= Math.abs(s.y1 - s.y0) && Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < unit.space) continue;
    const pad = s.maxLw / 2 + 1;
    // 段是直的（`adapt.ts` 会把它们摆正），照包围盒抹即可
    clear(Math.min(s.x0, s.x1) - pad, Math.min(s.y0, s.y1) - pad, Math.max(s.x0, s.x1) + pad, Math.max(s.y0, s.y1) + pad);
  }
  for (const b of prims.beams) clear(b.box.x, b.box.y, b.box.x + b.box.w - 1, b.box.y + b.box.h - 1);
  return { w, h, data: rest };
}

/**
 * 位图块 → 32×32 形状签名。**与 `glyphdict.ts::shapeSig` 同一套归一**
 * （长边缩到 30、居中摆进 32×32），两边算出来的签名才比得了距离。
 *
 * **必须反向映射**：符头只有 23×18 px，缩到 30 px 是**放大**，
 * 正向遍历源像素时大半目标格一个源像素都摊不到，签名会变成棋盘格
 * （实测符头的签名一半是洞，聚类全散）。逐个目标格去源图取那一小片、
 * 按面积平均再过半，放大缩小都对。
 */
export function binSig(bin: Binary, box: Rect): Uint8Array {
  const sig = new Uint8Array(SIG_N * SIG_N);
  const sc = (SIG_N - 2) / Math.max(box.w, box.h);
  const ox = (SIG_N - box.w * sc) / 2;
  const oy = (SIG_N - box.h * sc) / 2;
  for (let sy = 0; sy < SIG_N; sy++) {
    // 这一格对应源图的 y 区间（反解 `y * sc + oy`）
    const y0 = (sy - oy) / sc;
    const y1 = (sy + 1 - oy) / sc;
    const ya = Math.max(0, Math.floor(y0));
    const yb = Math.min(box.h - 1, Math.ceil(y1) - 1);
    if (ya > yb) continue;
    for (let sx = 0; sx < SIG_N; sx++) {
      const x0 = (sx - ox) / sc;
      const x1 = (sx + 1 - ox) / sc;
      const xa = Math.max(0, Math.floor(x0));
      const xb = Math.min(box.w - 1, Math.ceil(x1) - 1);
      if (xa > xb) continue;
      let hit = 0;
      let tot = 0;
      for (let y = ya; y <= yb; y++) {
        const row = (box.y + y) * bin.w + box.x;
        for (let x = xa; x <= xb; x++) {
          tot++;
          hit += bin.data[row + x];
        }
      }
      if (tot > 0 && hit * 2 >= tot) sig[sy * SIG_N + sx] = 1;
    }
  }
  return sig;
}
