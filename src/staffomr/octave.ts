// 八度移位（`8va` / `8vb`）与反复房号。
// 前者移植自 musicpp `qtomr/qomr.cpp::findOctaveShift`；
// **房号 musicpp 没做**，是本仓按同样的路数（记号 + 虚线 + 竖钩）新加的。
import { SPage, Seg, Sym, overlapY } from "./model";
import { objText } from "./textanalyze";
import type { StaffNote } from "./notedata";

/** 一段八度移位。 */
export interface OctaveShift {
  /** `up` = 8va（记谱低八度、实际高八度），`down` = 8vb。 */
  dir: "up" | "down";
  left: number;
  right: number;
  /** 作用的那行谱（按记号纵向就近判）。 */
  top: number;
  bottom: number;
}

/**
 * `Page::findOctaveShift`：`8va`/`8vb` 记号 + 一条**虚线** + 末端一个竖钩。
 *
 * 三件缺一不可（照原文）：虚线左端要紧挨着记号，竖钩要落在虚线右端、底端对齐。
 * 不要求三件齐全的话，谱面上任何一条虚线都会变成八度移位。
 */
export function findOctaveShifts(pg: SPage): OctaveShift[] {
  const sp = pg.normalStaffSpace || pg.space;
  const hlines = pg.segs.filter((s) => s.isH && !s.hasAnyTag() && s.obj.path && isDashedSeg(s));
  const vlines = pg.segs.filter((s) => s.isV && !s.hasAnyTag());
  const marks = pg.symbols.filter((s) => (s.code === "ottavaAlta" || s.code === "ottavaBassaVb") && !s.hasAnyTag());
  const out: OctaveShift[] = [];
  for (const hl of hlines) {
    let mark: Sym | undefined;
    for (const m of marks) {
      if (!overlapY(hl.box, m.box)) continue;
      const dx = hl.left - m.box.right;
      if (dx < 0 || dx > sp) continue;
      mark = m;
      break;
    }
    if (!mark) continue;
    let hook: Seg | undefined;
    for (const vl of vlines) {
      if (vl.left - hl.right > sp / 2) continue;
      if (Math.abs(vl.bottom - hl.bottom) > sp / 2) continue;
      hook = vl;
      break;
    }
    if (!hook) continue;
    mark.addTag("OctaveShift");
    hl.addTag("OctaveShift");
    hook.addTag("OctaveShift");
    out.push({
      dir: mark.code === "ottavaAlta" ? "up" : "down",
      left: mark.box.left,
      right: Math.max(hl.right, hook.right),
      top: mark.box.top,
      bottom: mark.box.bottom,
    });
  }
  return out;
}

/** 段是不是虚线画出来的。`Seg` 本身不记虚线，回它的路径对象上问。 */
function isDashedSeg(s: Seg): boolean {
  const d = s.obj.path?.dash;
  return !!d && d.length > 1;
}

/**
 * 八度移位落到音符上：记号覆盖范围内、且在它下方（8va）或上方（8vb）那行谱的音符
 * 整体移一个八度。**MusicXML 的 `<pitch>` 要的是实际音高**，所以这里直接改音符的八度，
 * 另在 `<direction>` 里出 `<octave-shift>`（由 `toxml.ts` 写）。
 */
export function applyOctaveShifts(shifts: OctaveShift[], notes: StaffNote[], sp: number): void {
  for (const sh of shifts) {
    // **只作用于最近的那一行谱**：8va 印在谱表上方、作用于它下面那行；8vb 反之。
    // 不挑最近的一行、而是把窗口里的谱行全移，大谱表上会连累另一行
    // （实测逐首音符准确率因此掉 0.2 个点）。
    let best: StaffNote["staff"] | null = null;
    let bd = Infinity;
    for (const n of notes) {
      const stf = n.staff.box;
      const near = sh.dir === "up" ? stf.top - sh.bottom : sh.top - stf.bottom;
      if (near < -sp || near > sp * 4) continue;
      if (near < bd) {
        bd = near;
        best = n.staff;
      }
    }
    if (!best) continue;
    for (const n of notes) {
      if (n.rest || n.staff !== best) continue;
      if (n.x < sh.left || n.x > sh.right) continue;
      n.octave += sh.dir === "up" ? 1 : -1;
      n.diatonic += sh.dir === "up" ? 7 : -7;
      n.octaveShift = sh.dir;
    }
  }
}

// ── 反复房号 ────────────────────────────────────────────────────────────────

/** 一个房号（`1.` / `2.` 那一档）。 */
export interface Volta {
  /** `1` / `1,2` 之类的原文。 */
  number: string;
  left: number;
  right: number;
  /** 这一档在哪行谱上方。 */
  staffTop: number;
}

/**
 * 房号：谱表**上方**一条水平线，左端有个下垂的竖钩，钩右边写着数字。
 *
 * musicpp 没有这一档（它的 `findNotations` 只认演奏法记号）。判据照八度移位那一路的路数：
 * 三件齐全才认——横线、**左端**的竖钩、贴着钩的数字文本。
 * 只认横线的话，渐强线与歌词的延长线都会变成房号。
 */
export function findVoltas(pg: SPage): Volta[] {
  const sp = pg.normalStaffSpace || pg.space;
  const out: Volta[] = [];
  const hlines = pg.segs.filter((s) => s.isH && !s.hasAnyTag() && s.len > sp * 3);
  // 竖钩**不限长**：书上的钩有长有短（实测 p172 那条从横线一直垂到谱表顶，7.9 格），
  // 原先卡在三格以内，那几首的房号一个都认不出来。上限只用来挡掉小节线之类的长竖线。
  const vlines = pg.segs.filter((s) => s.isV && !s.hasAnyTag() && s.len > sp * 0.8 && s.len < sp * 10);
  for (const hl of hlines) {
    // 左端下垂的竖钩：与横线左端同 x、从横线往下伸
    const hook = vlines.find((v) => Math.abs(v.cx - hl.left) < sp * 0.6 && Math.abs(v.top - hl.cy) < sp * 0.6);
    if (!hook) continue;
    // 这一房罩着的那行谱：**钩底贴着谱表顶**——这比「横线离谱表多远」结实得多
    // （横线的高度取决于这一行上方还有没有歌词/和弦，能差出两倍谱表高）。
    const stf = pg.staves.find((st) => hook.bottom <= st.box.top + sp && st.box.top - hook.bottom < sp * 2);
    if (!stf) continue;
    // 钩右边、横线下方紧挨着的数字
    const num = pg.objs.find((o) => {
      if (!o.run || o.hasAnyTag()) return false;
      const t = objText(o).trim();
      if (!/^\d[\d.,\s]*$/.test(t)) return false;
      return o.box.left >= hl.left - sp && o.box.left < hl.left + sp * 4 && o.box.top >= hl.cy - sp * 0.5 && o.box.top < hl.cy + sp * 3;
    });
    if (!num) continue;
    hl.addTag("Notation");
    hook.addTag("Notation");
    num.addTag("Notation");
    out.push({ number: objText(num).trim().replace(/[.\s]+$/, ""), left: hl.left, right: hl.right, staffTop: stf.box.top });
  }
  return out;
}

/**
 * 房号挂到小节上：横线横跨的那几个小节属于这一房，头一个记 start、末一个记 stop。
 *
 * MusicXML 的 `<ending>` 挂在小节线上（左端 start、右端 stop），所以要落到 `Bar` 上。
 */
export function attachVoltas(pg: SPage, voltas: Volta[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  for (const v of voltas) {
    const stf = pg.staves.find((st) => Math.abs(st.box.top - v.staffTop) < 1);
    if (!stf) continue;
    const covered = stf.bars.filter((b) => b.right > v.left + sp && b.left < v.right - sp);
    if (!covered.length) continue;
    covered.forEach((b, i) => {
      b.endingNumber = v.number;
      if (i === 0) b.endingStart = true;
      if (i === covered.length - 1) b.endingStop = true;
    });
  }
}
