// 演奏法记号与三连音。移植自 musicpp `qtomr/qomr.cpp::findNotations` / `findTuplet`。
//
// musicpp 到「打标」为止就结束了（它的 toxml.cpp 不导出这些）；
// 「挂到音符上、写进 MusicXML」是本仓新加的。
import { SPage, Sym } from "./model";
import type { BeamShape, StaffNote, StemInfo } from "./notedata";
import { objText } from "./textanalyze";

/** 会挂到音符上的记号（SMuFL 名）。力度记号另走 `<direction>`，见 `toxml.ts`。 */
const NOTATION_CODES = new Set([
  "articAccentAbove", "articAccentBelow",
  "articStaccatoAbove", "articStaccatoBelow",
  "articTenutoAbove", "articTenutoBelow",
  "articStaccatissimoAbove", "articStaccatissimoBelow",
  "articMarcatoAbove", "articMarcatoBelow",
  "articAccentStaccatoAbove", "articAccentStaccatoBelow",
  "articTenutoStaccatoAbove", "articTenutoStaccatoBelow",
  "fermataAbove", "fermataBelow",
  "ornamentTrill", "wiggleTrill", "wiggleTrillSlow",
  "breathMarkComma", "caesura",
  "graceNoteSlashStemUp", "graceNoteSlashStemDown",
]);

/** 力度记号：挂到小节上，出 `<direction>`。 */
const DYNAMIC_CODES = new Set([
  "dynamicPiano", "dynamicMezzo", "dynamicForte", "dynamicRinforzando",
  "dynamicSforzando", "dynamicZ", "dynamicNiente",
  "dynamicPP", "dynamicPPP", "dynamicMP", "dynamicMF", "dynamicFF", "dynamicFFF",
]);

/**
 * `Page::findNotations`：把还没归属的乐谱符号里属于「演奏法」的挑出来打标。
 *
 * 原文是一张 switch 白名单，这里换成两张集合（`NOTATION_CODES` / `DYNAMIC_CODES`）
 * ——判据一样，只是加新记号时不必再动控制流。
 */
export function findNotations(pg: SPage): { marks: Sym[]; dynamics: Sym[] } {
  const marks: Sym[] = [];
  const dynamics: Sym[] = [];
  for (const s of pg.symbols) {
    if (s.hasAnyTag()) continue;
    if (NOTATION_CODES.has(s.code)) {
      s.addTag("Notation");
      marks.push(s);
    } else if (DYNAMIC_CODES.has(s.code)) {
      s.addTag("Notation");
      dynamics.push(s);
    }
  }
  return { marks, dynamics };
}

/**
 * 演奏法记号挂到音符上：同一行谱里 **x 最近**的那个音符。
 *
 * 记号印在符头的正上方或正下方，横向偏差极小；纵向差多少都可能（要绕开符干符杠），
 * 所以只按 x 找，再要求它落在该谱行的上下一格半以内。
 */
export function attachNotations(pg: SPage, notes: StaffNote[], marks: Sym[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  for (const m of marks) {
    let best: StaffNote | undefined;
    let bd = Infinity;
    for (const n of notes) {
      const st = n.staff;
      if (m.py < st.box.top - sp * 3 || m.py > st.box.bottom + sp * 3) continue;
      const d = Math.abs(n.sym.px - m.px);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    if (best && bd < sp * 1.5) (best.marks ??= []).push(m.code);
  }
}

/**
 * `Page::findTuplet`：符杠上方（或下方）的一个数字就是连音记号。
 *
 * 两种画法都认：乐谱字体的 `tuplet3` 字形（Anastasia 那一路），
 * 与**普通文本的单个数字**（Finale 那一路，musicpp 靠字体名 `Times-BoldItalic` 认，
 * 本仓不认字体名——同一本书里那个数字换过好几种字体——改按「单个数字 + 贴着符杠」判）。
 *
 * 找到之后把该符杠所在**符杠组**的音符全标成 n 连音。
 */
export function findTuplets(pg: SPage, beams: BeamShape[], stems: StemInfo[], notes: StaffNote[]): number {
  const nums: { n: number; cx: number; cy: number; w: number; h: number }[] = [];
  for (const s of pg.symbols) {
    if (s.hasAnyTag()) continue;
    if (s.code === "tuplet3") nums.push({ n: 3, cx: s.px, cy: s.py, w: s.box.right - s.box.left, h: s.box.bottom - s.box.top });
    else if (s.code === "tuplet0") nums.push({ n: 0, cx: s.px, cy: s.py, w: s.box.right - s.box.left, h: s.box.bottom - s.box.top });
  }
  for (const o of pg.objs) {
    if (o.hasAnyTag() || !o.run) continue;
    const t = objText(o).trim();
    if (!/^[2-9]$/.test(t)) continue;
    nums.push({
      n: Number(t),
      cx: (o.box.left + o.box.right) / 2,
      cy: (o.box.top + o.box.bottom) / 2,
      w: o.box.right - o.box.left,
      h: o.box.bottom - o.box.top,
    });
  }
  if (!nums.length) return 0;

  let found = 0;
  for (const num of nums) {
    let best: BeamShape | undefined;
    let bd = Infinity;
    for (const b of beams) {
      if (num.cx < b.x0 - num.w || num.cx > b.x1 + num.w) continue;
      const cy = (b.box.top + b.box.bottom) / 2;
      const dy = Math.abs(num.cy - cy);
      if (dy > num.h * 2) continue;
      if (dy < bd) {
        bd = dy;
        best = b;
      }
    }
    if (!best) continue;
    found++;
    // 该符杠盖住的那些符干上的音符，全算进这一组连音
    const marked = new Set<StaffNote>();
    for (const st of stems) {
      if (!st.beams.includes(best)) continue;
      for (const s of st.notes) {
        const n = notes.find((x) => x.sym === s);
        if (n) marked.add(n);
      }
    }
    // 三连音是「n 个音占 n-1 个音的时值」（3:2、6:4），按 musicxml 的惯例取最近的二次幂
    const normal = num.n === 3 ? 2 : num.n === 6 ? 4 : num.n === 5 ? 4 : num.n === 7 ? 4 : num.n - 1;
    for (const n of marked) {
      n.tuplet = { actual: num.n, normal };
      n.duration = (n.duration * normal) / num.n;
    }
  }
  return found;
}

/** SMuFL 力度名 → MusicXML `<dynamics>` 的子元素名。 */
export const DYNAMIC_NAME: Record<string, string> = {
  dynamicPiano: "p",
  dynamicPP: "pp",
  dynamicPPP: "ppp",
  dynamicMezzo: "m",
  dynamicMP: "mp",
  dynamicMF: "mf",
  dynamicForte: "f",
  dynamicFF: "ff",
  dynamicFFF: "fff",
  dynamicSforzando: "sf",
  dynamicRinforzando: "rf",
  dynamicZ: "z",
  dynamicNiente: "n",
};

/**
 * 力度记号挂到音符上（MusicXML 里它是 `<direction>`，挂在小节上、排在音符之前）。
 *
 * 与演奏法的区别：力度印在谱表**下方**（人声谱有时在上方）且不必对准某个符头，
 * 所以只按 x 找最近的音符，容差放到三格。
 */
export function attachDynamics(pg: SPage, notes: StaffNote[], dynamics: Sym[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  for (const d of dynamics) {
    const name = DYNAMIC_NAME[d.code];
    if (!name) continue;
    let best: StaffNote | undefined;
    let bd = Infinity;
    for (const n of notes) {
      const st = n.staff;
      if (d.py < st.box.top - sp * 4 || d.py > st.box.bottom + sp * 4) continue;
      const dx = Math.abs(n.sym.px - d.px);
      if (dx < bd) {
        bd = dx;
        best = n;
      }
    }
    if (best && bd < sp * 3) best.dynamic ??= name;
  }
}
