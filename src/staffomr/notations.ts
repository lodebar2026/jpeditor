// 演奏法记号与三连音。移植自 musicpp `qtomr/qomr.cpp::findNotations` / `findTuplet`。
//
// musicpp 到「打标」为止就结束了（它的 toxml.cpp 不导出这些）；
// 「挂到音符上、写进 MusicXML」是本仓新加的。
import { SPage, Seg, Sym, type Staff } from "./model";
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

  // 每条符杠盖住的那撮音符，以及它们的**包围盒**——判「这个数字属于哪一组」要用它。
  const groupOf = new Map<BeamShape, { notes: Set<StaffNote>; top: number; bottom: number }>();
  for (const st of stems) {
    for (const b of st.beams) {
      let g = groupOf.get(b);
      if (!g) {
        g = { notes: new Set(), top: Infinity, bottom: -Infinity };
        groupOf.set(b, g);
      }
      for (const s of st.notes) {
        const n = notes.find((x) => x.sym === s);
        if (!n) continue;
        g.notes.add(n);
        g.top = Math.min(g.top, n.sym.box.top);
        g.bottom = Math.max(g.bottom, n.sym.box.bottom);
      }
    }
  }
  const sp = pg.normalStaffSpace || pg.space;

  let found = 0;
  for (const num of nums) {
    let best: BeamShape | undefined;
    let bd = Infinity;
    for (const b of beams) {
      if (num.cx < b.x0 - num.w || num.cx > b.x1 + num.w) continue;
      const g = groupOf.get(b);
      if (!g || !g.notes.size) continue;
      // **量到这一组符头的盒，不是量到符杠中心线**。
      //
      // 连音数字印在符头的**另一侧**：符干朝下时符杠在下、数字在上，
      // 中间隔着整个谱表加两截符干——实测 Opus 那本 p726 是 5.5~9.8 格，
      // 原来那道 `dy > num.h * 2`（约 2.7 格）把它们全挡掉了，
      // 一页 34 个三连音只收进 8 个，剩下的时值全按普通八分算，
      // 整小节自然凑不满（差额恰好是三连音的修正量）。
      //
      // 换成量到符头盒还顺带治好另一种误配：x 区间重叠、但在**别的谱行**上的符杠
      // （同一页上下两行的 x 范围本来就一样），那种 dy 是 39~48 格，照样出局。
      // 量到「**符头盒 ∪ 符杠盒**」这个并集，容差一格半。
      //
      // 连音数字总是贴在这一组的**外缘**，但贴哪一边看符干朝向：
      // 符干朝上时符杠在上、数字压在符杠上方；符干朝下时符杠在下、数字在符头上方。
      // 只量到符杠中心线，后一种就差着整个谱表加两截符干（实测 Opus p726 是
      // 5.5~9.8 格），34 个三连音只收进 8 个；只量到符头盒，前一种又差着一截符干
      // （实测 p132 原本收到的 7 组全丢）。取两者的**较小值**也不行——那等于把两个
      // 宽门槛并起来，假连音跟着涌进来（实测 Maestro 一下掉 60 个小节）。
      // 量到并集才既覆盖两种摆法、又不放宽：数字无论贴哪一边，离并集都只有一格半。
      // 容差扫过 1.5 / 2 / 2.5 格，**1.5 格最好**（全书 91.4% / 91.1% / 90.7%）——
      // 再放宽收到的 Opus 那十来个小节，抵不过 Maestro 涌进来的假连音。
      const top = Math.min(g.top, b.box.top);
      const bottom = Math.max(g.bottom, b.box.bottom);
      const dy = num.cy < top ? top - num.cy : num.cy > bottom ? num.cy - bottom : 0;
      if (dy > sp * 1.5) continue;
      if (dy < bd) {
        bd = dy;
        best = b;
      }
    }
    if (!best) {
      // **没有符杠的连音**：四分音符以上的连音不打符杠，改画一条**方括号**
      // （一条横线、两端各一截朝符头的短竖，中间被数字断开）。
      // 实测 p30/p31/p132/p133/p172 整页的三连音都是这一种，靠符杠一个也收不到。
      const grp = bracketGroup(pg, num, notes, sp);
      if (!grp) continue;
      found++;
      applyTuplet(grp, num.n);
      continue;
    }
    found++;
    // 该符杠盖住的那些符干上的音符，全算进这一组连音
    const marked = new Set<StaffNote>(groupOf.get(best)!.notes);
    applyTuplet(marked, num.n);
  }
  return found;
}

/** 三连音是「n 个音占 n-1 个音的时值」（3:2、6:4），按 musicxml 的惯例取最近的二次幂。 */
function applyTuplet(marked: Iterable<StaffNote>, n: number): void {
  const normal = n === 3 ? 2 : n === 6 ? 4 : n === 5 ? 4 : n === 7 ? 4 : n - 1;
  for (const x of marked) {
    x.tuplet = { actual: n, normal };
    x.duration = (x.duration * normal) / n;
  }
}

/**
 * 连音**方括号**那一路：数字左右各有一截横线，两截同高、在数字两侧。
 *
 * 判据（都按线距 `sp` 量，别写绝对点值）：
 *   - 两截横线的 y 差不到半格（同一条括号被数字断成两截）；
 *   - 它们的 y 与数字中心差不到一格半（数字是嵌在括号里的）；
 *   - 一截在数字左、一截在数字右，间隙都不超过两格。
 *
 * 括号跨度定出音符范围之后，取**跨度内、离数字最近的那一行谱**上的音符。
 * 只有正好 `n` 个才认——多了少了都说明括号找错了，宁可不认（不认只是这一组
 * 时值偏长，认错会把邻组的时值一起改坏）。
 */
function bracketGroup(pg: SPage, num: { n: number; cx: number; cy: number; w: number; h: number }, notes: StaffNote[], sp: number): StaffNote[] | null {
  let left: Seg | null = null;
  let right: Seg | null = null;
  for (const g of pg.segs) {
    if (g.hasAnyTag() || !g.isH) continue;
    if (Math.abs(g.cy - num.cy) > sp * 1.5) continue;
    if (g.right <= num.cx && num.cx - g.right < sp * 2) {
      if (!left || g.right > left.right) left = g;
    } else if (g.left >= num.cx && g.left - num.cx < sp * 2) {
      if (!right || g.left < right.left) right = g;
    }
  }
  if (!left || !right) return null;
  if (Math.abs(left.cy - right.cy) > sp * 0.5) return null;
  const x0 = left.left;
  const x1 = right.right;
  // 括号下（或上）方那一行谱：取跨度内音符最多的那行
  const inSpan = notes.filter((n) => n.x >= x0 - sp && n.x <= x1 + sp);
  if (!inSpan.length) return null;
  const cnt = new Map<StaffNote["staff"], StaffNote[]>();
  for (const n of inSpan) {
    const a = cnt.get(n.staff) ?? [];
    a.push(n);
    cnt.set(n.staff, a);
  }
  let best: StaffNote[] | null = null;
  for (const [stf, arr] of cnt) {
    if (arr.length !== num.n) continue;
    // 数字要在这行谱的上下一个谱表高之内（跨行的同 x 括号不能算）
    const h = stf.box.bottom - stf.box.top;
    if (num.cy < stf.box.top - h || num.cy > stf.box.bottom + h) continue;
    if (!best || arr.length < best.length) best = arr;
  }
  return best;
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
  attachDynamicTexts(
    pg,
    notes,
    dynamics.flatMap((d) => {
      const text = DYNAMIC_NAME[d.code];
      return text ? [{ px: d.px, py: d.py, text }] : [];
    }),
  );
}

/**
 * 同上，只是力度**已经拼成字符串**了（`mp`/`mf`/`sfz`…）。
 *
 * 位图路认出来的是一个个字母块（`p`、`m`、`f` 各一个 contour），拼完才是一个力度记号，
 * 给不出单个 SMuFL 名——判据只留这一份，`attachDynamics` 查完表委托过来。
 */
export function attachDynamicTexts(pg: SPage, notes: StaffNote[], items: { px: number; py: number; text: string }[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  for (const d of items) {
    // 与松叶同一条：先定谱行（力度也印在它那行谱的下方），再在行内按 x 找最近的音符
    const owner = ownerStaff(pg, d.py, sp);
    for (const only of [true, false]) {
      let best: StaffNote | undefined;
      let bd = Infinity;
      for (const n of notes) {
        const st = n.staff;
        if (only ? st !== owner : d.py < st.box.top - sp * 4 || d.py > st.box.bottom + sp * 4) continue;
        const dx = Math.abs(n.sym.px - d.px);
        if (dx < bd) {
          bd = dx;
          best = n;
        }
      }
      if (best && bd < sp * 3) {
        best.dynamic ??= d.text;
        break;
      }
    }
  }
}

/**
 * 记号（松叶、力度）印在谱表下方时**属于上面那行谱**。
 *
 * 取「下缘在它上方、且最近」的那一行；上方没有（页面第一行谱之上）才退回下方最近的一行。
 * 容差各五格与三格——谱表之间隔着歌词带，记号常印在带里。
 */
function ownerStaff(pg: SPage, cy: number, sp: number): Staff | null {
  let best: Staff | null = null;
  let bd = Infinity;
  for (const st of pg.staves) {
    const d = cy - st.box.bottom;
    if (d < 0 || d > sp * 5) continue;
    if (d < bd) {
      bd = d;
      best = st;
    }
  }
  if (best) return best;
  for (const st of pg.staves) {
    const d = st.box.top - cy;
    if (d < 0 || d > sp * 3) continue;
    if (d < bd) {
      bd = d;
      best = st;
    }
  }
  return best;
}

/** 一条松叶：两端的 x 与纵向位置（谁挂给谁由 `attachWedges` 定）。 */
export interface WedgeSpan {
  type: "crescendo" | "diminuendo";
  x0: number;
  x1: number;
  cy: number;
}

/**
 * 松叶挂到音符上：起点挂给左端最近的音符、终点挂给右端最近的。
 *
 * 与力度同一套「按 x 找最近、纵向在谱表带外四格以内」的判据（那一条已经调过）。
 * 两端落到同一个音符时**只留起点**——MusicXML 里同一处既起又止没有意义。
 */
export function attachWedges(pg: SPage, notes: StaffNote[], wedges: WedgeSpan[]): void {
  const sp = pg.normalStaffSpace || pg.space;
  for (const wg of wedges) {
    // **先定是哪一行谱，再在那一行里找音符。** 松叶印在它那行谱的**下方**
    // （歌词带那一条里也常见），而下面一行谱的上缘往往比它自己那行的下缘还近
    // ——不先定谱行，一条松叶会挂到下一行去，逐声部比出来的次序全乱。
    const owner = ownerStaff(pg, wg.cy, sp);
    const near = (x: number): StaffNote | undefined => {
      // 先在**它那行谱**里找；那一行在这个位置没有音符（人声休止、钢琴前奏一类）
      // 才退回「所有纵向够得着的谱行里 x 最近的那个」。
      // 只按 y 定谱行、找不到就丢，实测松叶从 38 掉到 14——那一行常常正好在休止。
      for (const only of [true, false]) {
        let best: StaffNote | undefined;
        let bd = Infinity;
        for (const n of notes) {
          const st = n.staff;
          if (only ? st !== owner : wg.cy < st.box.top - sp * 5 || wg.cy > st.box.bottom + sp * 5) continue;
          const dx = Math.abs(n.sym.px - x);
          if (dx < bd) {
            bd = dx;
            best = n;
          }
        }
        if (best && bd < sp * 4) return best;
        if (only && !owner) continue;
      }
      return undefined;
    };
    const a = near(wg.x0);
    const b = near(wg.x1);
    if (!a) continue;
    a.wedgeStart ??= wg.type;
    if (b && b !== a) b.wedgeStop = true;
  }
}
