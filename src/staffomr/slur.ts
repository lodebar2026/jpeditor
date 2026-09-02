// 圆滑线与连音线。移植自 musicpp `qtomr/qomr.cpp::findSlurTies` 与
// `qtomr/NoteData.cpp::analyzeSlurTie` / `SlurTie::checkTie`。
//
// 坐标一律设备坐标、y 向下——原文是 y 向上，纵向判据逐处翻过来了，见每处注释。
import { type Box, PObj, SPage, Seg, overlapX, ySpace } from "./model";
import { pathPoints } from "./vecgeom";
import type { StaffNote } from "./notedata";

/** 一条弧。 */
export interface SlurArc {
  obj: PObj;
  /** 最左、最右的那个点（设备坐标）。原文 `leftMost`/`rightMost`。 */
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  /** 弧朝上（开口向下，画在音符上方）。 */
  above: boolean;
  /** 起点、终点音符（可能为 null：跨行的弧只有一头在这一页）。 */
  from?: StaffNote;
  to?: StaffNote;
  /** 是连音线（两端同音高）而不是圆滑线。 */
  tie: boolean;
}

/**
 * `Page::findWedges`：渐强渐弱记号（`<`、`>`）。**要在找弧之前跑**——
 * 它们也是又宽又扁的图形，不先挑出来就会被当成圆滑线。
 *
 * 两种画法：三点的折线（一笔画出的 `<`）；或者两条**斜的**直线（上下各一笔）
 * 左端对齐、纵向靠近。水平/垂直的直线不算（那是谱线小节线）。
 */
export function findWedges(pg: SPage): PObj[] {
  const sp = pg.normalStaffSpace || pg.space;
  const out: PObj[] = [];
  const lines: PObj[] = [];
  for (const o of pg.objs) {
    if (o.hasAnyTag() || !o.path) continue;
    const pts = pathPoints(o.path);
    if (pts.length === 2) {
      const dy = Math.abs(pts[0].y - pts[1].y);
      const dx = Math.abs(pts[0].x - pts[1].x);
      if (dy < 0.02 || dx < 0.02) continue; // 水平/垂直的不是渐强线
      if (dy > 0.2 * dx) continue; // 太陡的不是（渐强线很扁）
      lines.push(o);
      continue;
    }
    if (pts.length !== 3) continue;
    o.addTag("Wedge");
    out.push(o);
  }
  const done = new Set<PObj>();
  for (let i = 0; i < lines.length; i++) {
    if (done.has(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (done.has(lines[j])) continue;
      if (!overlapX(lines[i].box, lines[j].box)) continue;
      if (ySpace(lines[i].box, lines[j].box) > sp * 2) continue;
      if (Math.abs(lines[i].box.left - lines[j].box.left) > sp / 2) continue;
      lines[i].addTag("Wedge");
      lines[j].addTag("Wedge");
      done.add(lines[i]);
      done.add(lines[j]);
      out.push(lines[i], lines[j]);
      break;
    }
  }
  return out;
}

/**
 * `Page::findSlurTies`：填充的曲线路径就是弧。
 *
 * 一处要害照原文：**落在系统线左边**、且与它纵向相交的曲线不是弧，是**谱表括号**
 * （钢琴谱的花括号）。不挡掉的话每个系统都会多出一条横跨整行的「圆滑线」。
 */
export function findSlurs(pg: SPage): SlurArc[] {
  const syslines: Seg[] = pg.segsWithTag("SysLine");
  const sp = pg.normalStaffSpace || pg.space;
  const out: SlurArc[] = [];
  for (const o of pg.objs) {
    if (o.hasAnyTag()) continue;
    const p = o.path;
    if (!p) continue;
    // 弧的三种画法都要认：
    //   ① 贝塞尔曲线（Finale 原生，`curves > 0`）；
    //   ② 描边的曲线（Sibelius/Anastasia，见下）；
    //   ③ **压平成多段折线的多边形**（这一批经 Distiller 的 PDF，实测 p205 一条弧
    //      是 60 段直线围出来的月牙、`curves` 恰好是 0）——只认 `curves > 0` 的话
    //      那些页一条弧都找不到。折线段数取 12 作门槛：符杠是 4 点、矩形 4~5 点。
    if (!p.curves && p.segs < 12) continue;
    // **描边的曲线也要收**：musicpp 只认填充（`path->fill()`），那是因为它只见过
    // Finale 那一路把弧画成实心月牙；Sibelius 的 Anastasia 页把弧画成描边曲线，
    // 只认填充的话那 115 页一条弧都找不到。
    const w = o.box.right - o.box.left;
    const h = o.box.bottom - o.box.top;
    // 形状判据：弧**又宽又扁**。不加这条，吉他和弦图里的小圆点（2.3×2.3 的填充曲线，
    // 每页上百个）会全被当成弧——实测 p185 因此多出 177 条「圆滑线」。
    if (w < sp * 1.2 || w < h * 1.5) continue;
    let isBracket = false;
    for (const l of syslines) {
      // y 向下：纵向相交 = 不在彼此的上下之外
      if (o.box.bottom < l.box.top || l.box.bottom < o.box.top) continue;
      if (o.box.left < l.box.left) {
        isBracket = true;
        break;
      }
    }
    if (isBracket) {
      o.addTag("Bracket");
      continue;
    }
    const arc = arcOf(o);
    if (!arc) continue;
    o.addTag("Slur");
    out.push(arc);
  }
  return out;
}

/** 从路径点算出弧的两端与朝向（`SlurTie::SlurTie`）。 */
function arcOf(o: PObj): SlurArc | null {
  const pts = pathPoints(o.path!);
  if (pts.length < 4) return null;
  let li = 0;
  let ri = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x < pts[li].x) li = i;
    if (pts[i].x > pts[ri].x) ri = i;
  }
  // 朝向：拿弧的第一段贝塞尔判——控制点在两端连线的哪一侧。
  // 原文只处理 8 个点的情形（两条三次贝塞尔围出的月牙）；本仓退一步：
  // 取**离两端连线最远**的那个点来判，点数多少都成立。
  let above = true;
  const x0 = pts[li].x;
  const y0 = pts[li].y;
  const x1 = pts[ri].x;
  const y1 = pts[ri].y;
  if (x1 > x0) {
    let far = 0;
    for (const p of pts) {
      const yLine = y0 + ((y1 - y0) * (p.x - x0)) / (x1 - x0);
      const d = p.y - yLine;
      if (Math.abs(d) > Math.abs(far)) far = d;
    }
    // y 向下：最远点在连线**上方**（y 更小）说明弧朝上
    above = far < 0;
  }
  return { obj: o, lx: pts[li].x, ly: pts[li].y, rx: pts[ri].x, ry: pts[ri].y, above, tie: false };
}

/**
 * `validateSlurNote`：弧的某一端能不能挂到这个音符上，返回距离的平方（越小越好）。
 *
 * @param isEnd 这一端是弧的**终点**（挂到音符左缘）；否则是起点（挂到右缘）
 */
function validateSlurNote(isEnd: boolean, nt: Box, px: number, py: number, sp: number, above: boolean): number | null {
  // y 向下：`nt.top` 是视觉上沿。原文比的是 y 向上的 top/bottom，这里整段翻过来。
  if (py < nt.top - sp) return null;
  if (py > nt.bottom + sp) return null;
  let dy: number;
  if (py < nt.top) {
    dy = nt.top - py;
    if (!above) return null;
  } else if (py > nt.bottom) {
    dy = py - nt.bottom;
    if (above) return null;
  } else {
    dy = 0;
  }
  let dx: number;
  if (isEnd) {
    if (px > nt.right) return null;
    if (px < nt.left - 4 * sp) return null;
    dx = px - nt.left;
  } else {
    if (px < nt.left) return null;
    if (px > nt.right + 4 * sp) return null;
    dx = px - nt.right;
  }
  return dx * dx + dy * dy;
}

/**
 * `Page::analyzeSlurTie`：给每条弧找两端的音符，再判是不是连音线。
 *
 * 连音线的判据照 `SlurTie::checkTie`：两端**在谱表上的音级相同**。
 */
export function attachSlurs(arcs: SlurArc[], notes: StaffNote[], sp: number): void {
  const pitched = notes.filter((n) => !n.rest);
  for (const sl of arcs) {
    let bestL: StaffNote | undefined;
    let bestR: StaffNote | undefined;
    let dl = Infinity;
    let dr = Infinity;
    for (const nt of pitched) {
      const b = nt.sym.box;
      const vl = validateSlurNote(false, b, sl.lx, sl.ly, sp, sl.above);
      const vr = validateSlurNote(true, b, sl.rx, sl.ry, sp, sl.above);
      if (vl !== null && vl < dl) {
        dl = vl;
        bestL = nt;
      }
      if (vr !== null && vr < dr) {
        dr = vr;
        bestR = nt;
      }
    }
    if (bestL && bestL === bestR) {
      // 两端落到同一个音符上：按 x 判掉不合理的那一端（照原文）
      if (bestL.sym.box.left > sl.rx) bestL = undefined;
      if (bestR && bestR.sym.box.right < sl.lx) bestR = undefined;
    }
    sl.from = bestL;
    sl.to = bestR;
    if (bestL && bestR && bestL.staff === bestR.staff && bestL.diatonic === bestR.diatonic) sl.tie = true;
  }
}

/**
 * `System::updateSlurTied` 的要点：**跨行的弧要接回一条**。
 *
 * 谱面上一条跨行的圆滑线画成两段（上一行末一段、下一行头一段），
 * 而 GT 里它是**一对** start/stop。不接的话我们会多出一个起点与一个终点
 * ——实测全书多认出三分之一的弧就是这么来的。
 *
 * 判据：上一行有条弧只有起点没终点（右端悬空），下一行紧接着有条弧只有终点没起点。
 * 按谱行顺序两两配。
 */
export function reconnectSlurs(pg: SPage, arcs: SlurArc[]): void {
  const order = new Map(pg.staves.map((s, i) => [s, i]));
  const staffOf = (a: SlurArc) => (a.from ?? a.to)?.staff;
  const dangRight = arcs.filter((a) => a.from && !a.to);
  const dangLeft = arcs.filter((a) => !a.from && a.to);
  const used = new Set<SlurArc>();
  for (const a of dangRight) {
    const sa = staffOf(a);
    if (sa === undefined) continue;
    const ia = order.get(sa) ?? -1;
    let best: SlurArc | undefined;
    for (const b of dangLeft) {
      if (used.has(b)) continue;
      const sb = staffOf(b);
      if (sb === undefined) continue;
      if ((order.get(sb) ?? -1) !== ia + 1) continue;
      best = b;
      break;
    }
    if (!best) continue;
    a.to = best.to;
    best.from = undefined;
    best.to = undefined;
    used.add(best);
    // 接回来之后再判一次连音线
    if (a.from && a.to && a.from.diatonic === a.to.diatonic) a.tie = true;
  }
}

/** 弧 → 挂到音符上的标记。一个音符可以同时是上一条的收尾与下一条的起头。 */
export function markSlurNotes(arcs: SlurArc[]): void {
  for (const sl of arcs) {
    if (sl.from) {
      if (sl.tie) sl.from.tieStart = true;
      else sl.from.slurStart = true;
    }
    if (sl.to) {
      if (sl.tie) sl.to.tieStop = true;
      else sl.to.slurStop = true;
    }
  }
}
