// 歌词对位格的判据——**读写两端共用这一份**（`j123/parse.ts::attachLyrics` 与 `abcfamily/emit.ts::lyricLines`）。
// 两边口径一旦不一，交错写法下每行起点就差一格，后面整行错位。

import type { Element, Part } from "../model/doc";

/** 这个元素占不占歌词对位格：倚音不占；承接前音的延长（`Chord.continued`）123 不表达、不占；
 *  `y` 无时值占位不占，`x` 不可见休止占（规范 §8.1）。
 *  ABC `&` 的临时声部（`voice > 1`，§7.4）不占：`w:` 按声部对位，词只跟主分支走，
 *  否则一小节里两条并行旋律会把词挤成两份、后面整行错位。 */
export function isLyricSlot(el: Element): boolean {
  if (el.voice > 1) return false;
  if (el.kind === "chord") return !el.grace && !el.continued;
  return el.spacer === "x";
}

/** 声部里所有对位格，按元素顺序；`measureOf[k]` 是第 k 格所在小节的下标。
 *  `fromEl` / `toEl`：首小节从第几个元素起、末小节到第几个元素止（不含）——系统切在小节中间时用（`Chord.lineBreakAfter`）。 */
export function lyricSlots(
  part: Part, from = 0, to = part.measures.length - 1, fromEl = 0, toEl = Infinity,
): { slots: Element[]; measureOf: number[] } {
  const slots: Element[] = [];
  const measureOf: number[] = [];
  for (let mi = from; mi <= to && mi < part.measures.length; mi++) {
    const els = part.measures[mi]!.elements;
    for (let j = mi === from ? fromEl : 0; j < (mi === to ? Math.min(toEl, els.length) : els.length); j++) {
      const el = els[j]!;
      if (!isLyricSlot(el)) continue;
      slots.push(el);
      measureOf.push(mi);
    }
  }
  return { slots, measureOf };
}
