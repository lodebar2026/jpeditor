// 文本写出端**共用**的助手：`ScoreDoc` → 123 / ABC（`abcfamily/emit.ts`）与 → 文本谱（`model/topu.ts`）。
//
// 这几样与目标语法无关、只与模型结构有关：怎么按换行切系统、哪些弧两端都落在本声部、
// 拉丁词挨着写会不会粘成一个音节。以前只在 ABC 家族的基类里，文本谱写出端要同一套判据，
// 所以搬到这里——两边口径一旦不一，同一份模型转成两种格式行结构就对不上。

import type { Element, ElementId, Mark, Part, Song } from "./doc";
import { breakAfter, type BreakKind } from "./helpers";
import { isLyricCjk, isLyricOpenQuote, isLyricTrailingPunct } from "../common/cjkpunct";

/** 一个系统：第 `from`–`to` 小节（闭区间）。切在小节中间时，首小节从第 `fromEl` 个元素起、末小节到第 `toEl` 个止（不含）。 */
export interface SystemRange {
  from: number;
  to: number;
  fromEl: number;
  toEl: number;
  /** 系统末是**小节中间**的换行（`Chord.lineBreakAfter`）：`$` 写在 `toEl` 那个元素之前 */
  inline?: BreakKind;
}

/** 这个元素之后原位换行（和弦或它的增时线带 `lineBreakAfter`）。 */
export function inlineBreakOf(el: Element): BreakKind | null {
  if (el.kind !== "chord") return null;
  if (el.lineBreakAfter) return el.lineBreakAfter;
  for (const su of el.sustains ?? []) if (su.lineBreakAfter) return su.lineBreakAfter;
  return null;
}

/**
 * 按声部的换行切出系统。最后一段开到无穷，别的声部小节多出来的也归它。
 * **小节中间换行**照原位切（同 `.jpwabc`，读入端 `j123/parse.ts` 记在 `Chord.lineBreakAfter`）；
 * 同一处换行在下一小节上还有一份小节级的 `print`（「这一小节之后」），那一份就不再切第二次。
 * 原位切只对这个声部（第一声部）有意义，别的声部照小节归系统。
 */
export function systemRanges(part: Part | undefined): SystemRange[] {
  const out: SystemRange[] = [];
  if (!part) return out;
  let from = 0;
  let fromEl = 0;
  for (let i = 0; i < part.measures.length; i++) {
    const els = part.measures[i]!.elements;
    let inlineHere = false;
    for (let j = 0; j < els.length - 1; j++) {
      const kind = inlineBreakOf(els[j]!);
      if (!kind) continue;
      out.push({ from, to: i, fromEl, toEl: j + 1, inline: kind });
      from = i;
      fromEl = j + 1;
      inlineHere = true;
    }
    if (i < part.measures.length - 1 && !inlineHere && breakAfter(part, i)) {
      out.push({ from, to: i, fromEl, toEl: Infinity });
      from = i + 1;
      fromEl = 0;
    }
  }
  out.push({ from, to: Number.MAX_SAFE_INTEGER, fromEl, toEl: Infinity });
  return out;
}

/** 本声部里写得出来的元素 id（含增时线）。`emits` 判哪些元素写（123 只写简谱印的那一路）。 */
export function ownIds(part: Part, emits: (el: Element, mi: number) => boolean): Set<ElementId> {
  const own = new Set<ElementId>();
  part.measures.forEach((mea, mi) => {
    for (const el of mea.elements) {
      if (!emits(el, mi)) continue;
      own.add(el.id);
      if (el.kind === "chord") for (const su of el.sustains ?? []) own.add(su.id);
    }
  });
  return own;
}

/** **只收两端都在本声部里的 Mark**：`song.marks` 是全曲共用的，而一条弧的两端
 *  必须落在同一个声部才画得出来。不校验就会输出**不配对的括号**——那不只是往返不幂等，
 *  是写出了非法的文本（解析回来会报「圆滑线里没有音符」）。 */
export function ownMarks(song: Song, own: ReadonlySet<ElementId>): Mark[] {
  return song.marks.filter((m) => own.has(m.start) && own.has(m.end));
}

/** 弧（`isArc`）与多连音**只许嵌套**的写法（123：两者共用括号、`)` 收最近开的那个，规范 §4「多连音」）
 *  要的整理结果：
 *  - `marks`：跨出组的弧截进组内——组外起、组内收的弧起点挪到组首，组内起、组外收的弧终点挪到组尾；
 *    截完只剩一个音的弧丢掉（`(2)` 在 123 里另有「首尾相接」的读法，写不得）；
 *  - `crossed`：截了几条（丢失清单 `slurCrossTuplet` 用）；
 *  - `outerOpen`：组首那个音上起头、却在组外收的弧数——`(` 要写在 `(n:` **之前**；
 *  - `outerClose`：组外起头、在组尾那个音上收的弧数——`)` 要写在多连音的 `)` **之后**。
 *  位置按元素先后数，增时线各占一位；收在和弦上的弧与多连音的 `)` 都写在它的增时线之后，所以终点按和弦的最后一条增时线算。 */
export function nestArcsInTuplets(
  part: Part,
  marks: readonly Mark[],
  isArc: (m: Mark) => boolean,
): { marks: Mark[]; crossed: number; outerOpen: Map<ElementId, number>; outerClose: Map<ElementId, number> } {
  const pos = new Map<ElementId, number>();
  const tail = new Map<ElementId, number>();
  let n = 0;
  for (const mea of part.measures) {
    for (const el of mea.elements) {
      pos.set(el.id, n++);
      if (el.kind === "chord") for (const su of el.sustains ?? []) pos.set(su.id, n++);
      tail.set(el.id, n - 1);
    }
  }
  const endPos = (id: ElementId): number | undefined => tail.get(id) ?? pos.get(id);
  const tuplets: { m: Mark; s: number; e: number }[] = [];
  for (const m of marks) {
    if (m.type !== "tuplet") continue;
    const s = pos.get(m.start);
    const e = endPos(m.end);
    if (s !== undefined && e !== undefined) tuplets.push({ m, s, e });
  }
  const outermostFrom = new Map<ElementId, { s: number; e: number }>();
  const outermostTo = new Map<ElementId, { s: number; e: number }>();
  for (const t of tuplets) {
    const f = outermostFrom.get(t.m.start);
    if (!f || t.e > f.e) outermostFrom.set(t.m.start, t);
    const l = outermostTo.get(t.m.end);
    if (!l || t.s < l.s) outermostTo.set(t.m.end, t);
  }
  const out: Mark[] = [];
  const outerOpen = new Map<ElementId, number>();
  const outerClose = new Map<ElementId, number>();
  let crossed = 0;
  for (const m of marks) {
    let s = isArc(m) ? pos.get(m.start) : undefined;
    let e = isArc(m) ? endPos(m.end) : undefined;
    if (s === undefined || e === undefined || !tuplets.length) {
      out.push(m);
      continue;
    }
    let mm = m;
    for (const t of tuplets) {
      if (s < t.s && e >= t.s && e < t.e) {
        mm = { ...mm, start: t.m.start };
        s = t.s;
        crossed++;
      } else if (s > t.s && s <= t.e && e > t.e) {
        mm = { ...mm, end: t.m.end };
        e = t.e;
        crossed++;
      }
    }
    if (mm !== m && mm.start === mm.end) continue;
    out.push(mm);
    // 同一个音上起（收）几个多连音时只和最外层比：写出端把这些多连音的括号连在一起写
    const first = outermostFrom.get(mm.start);
    if (first && e > first.e) outerOpen.set(mm.start, (outerOpen.get(mm.start) ?? 0) + 1);
    const last = outermostTo.get(mm.end);
    if (last && s < last.s) outerClose.set(mm.end, (outerClose.get(mm.end) ?? 0) + 1);
  }
  return { marks: out, crossed, outerOpen, outerClose };
}

const LATIN_CH = /[\p{L}\p{N}']/u;
/** 拉丁音节（非 CJK 的字母/数字）起头——歌词读入端的拉丁分支会把它和前面的拉丁词粘在一起 */
export function isLatinStart(text: string): boolean {
  const c = [...text][0] ?? "";
  return LATIN_CH.test(c) && !isLyricCjk(c);
}
export function isLatinEnd(text: string): boolean {
  const cs = [...text];
  const c = cs[cs.length - 1] ?? "";
  return LATIN_CH.test(c) && !isLyricCjk(c);
}

/** 「至多一个左引号 + 一个 CJK 字 + 若干收尾标点」——`parseLyricLine` 不包 `{}` 也读成**一个**音节的形状。
 *  口径与读入端同一份（`common/cjkpunct.ts`），改一边就要看另一边。 */
export function isOneCjkWithPunct(text: string): boolean {
  const cs = [...text];
  let k = 0;
  if (cs.length > 1 && isLyricOpenQuote(cs[0]!)) k = 1;
  if (!isLyricCjk(cs[k] ?? "")) return false;
  return cs.slice(k + 1).every(isLyricTrailingPunct);
}
