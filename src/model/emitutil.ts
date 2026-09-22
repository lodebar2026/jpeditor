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
