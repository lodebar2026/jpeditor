// 反复展开的公共那一半：按 `PlayItem[]`（`Score.playData.measures`）逐遍走小节。
//
// 「这首歌该唱成什么样」由 Score 那一层推（`Score.parseRepeatInf` / `.Repeat` 段），
// 两种格式都拿到同一种 `PlayItem[]`；这里只负责**怎么走**——逐遍、逐小节、首尾小节的裁切、
// 遍末换页，以及「这一遍唱哪几段词」。「怎么放一个小节」各格式自己写（sink）：
// `.jpwabc` 往 Line 里装小节（layout.ts::buildLine），文本谱往展开后的 AST 里拼元素（pu/expand.ts）。

import { PlayItem } from "../score/score";

/** 原样档：按原谱排一遍——一小节一项、pass = 0（多段歌词叠排、不展开任何反复）。 */
export function identityPlan(measureCount: number): PlayItem[] {
  const out: PlayItem[] = [];
  for (let i = 0; i < measureCount; i++) {
    const it = new PlayItem();
    it.mid = i;
    it.end = i + 1;
    it.pass = 0;
    it.skip = 0;
    it.limit = -1;
    it.endOfPass = false;
    out.push(it);
  }
  return out;
}

/** 一个小节在这一遍里的裁切。 */
export interface MeasureCut {
  /** 首小节跳过前几个和弦（弱起式接入，`.Repeat` 写作 `11.2-20V4`） */
  skip: number;
  /** 末小节只取前几个和弦（-1 = 整节） */
  limit: number;
  /** 整首最后一小节 */
  final: boolean;
}

export interface PlaySink {
  measure(mid: number, pass: number, cut: MeasureCut): void;
  /** 一遍唱完（`endOfPass`）：展开档据此换页 */
  passEnd(): void;
}

/** 逐遍逐小节回调。 */
export function walkPlay(items: readonly PlayItem[], sink: PlaySink): void {
  items.forEach((it, idx) => {
    for (let mid = it.mid; mid < it.end; mid++) {
      sink.measure(mid, it.pass, {
        skip: mid === it.mid ? it.skip : 0,
        limit: mid === it.end - 1 ? it.limit : -1,
        final: mid === it.end - 1 && idx === items.length - 1,
      });
    }
    if (it.endOfPass) sink.passEnd();
  });
}

/**
 * 这一遍唱哪几段词：段号区间含 `pass` 的那几行。一行都不含时，只有**整行只写了一段**
 *（副歌只写一段、各遍共用）才照用；写了好几段却没有这一段的，这一遍就不挂词。
 */
export function versesForPass<T extends { verseFrom: number; verseTo: number }>(
  lines: readonly T[],
  pass: number,
): T[] {
  const hit = lines.filter((l) => l.verseFrom <= pass && pass <= l.verseTo);
  if (hit.length > 0) return hit;
  return lines.length === 1 ? [lines[0]!] : [];
}
