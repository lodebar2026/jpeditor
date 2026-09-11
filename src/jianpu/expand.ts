// 反复展开的公共那一半：按 `PlayItem[]`（`Score.playData.measures`）逐遍走小节。
//
// 「这首歌该唱成什么样」由 Score 那一层推（`Score.parseRepeatInf` / `.Repeat` 段），
// 两种格式都拿到同一种 `PlayItem[]`；这里只负责**怎么走**——逐遍、逐小节、首尾小节的裁切、
// 遍末换页。「怎么放一个小节」由 sink 决定：排版往 Line 里装小节（layout.ts::buildLine）。
// 文本谱也先转成 Score（pu/toscore.ts），展开档两种格式走的是同一条路（jianpu/expanded.ts）。

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

/**
 * 逐遍逐小节回调。换页（`passEnd`）有两处：`endOfPass`，以及**往回跳**（反复、D.C./D.S.）——
 * 那是新的一遍。遍号变了但往前接着唱的（二房之后 pass 归 1 的尾段、跳过一房）不换页，
 * 否则前一页常只剩一行半（同一首歌）。同一小节被 limit/skip 切成前后两截的，后一截也是接着唱。
 */
export function walkPlay(items: readonly PlayItem[], sink: PlaySink): void {
  let lastMid = -1;
  let broke = true; // 刚换过页，不必再换
  items.forEach((it, idx) => {
    if (lastMid >= 0 && !broke && (it.mid < lastMid || (it.mid === lastMid && it.skip === 0))) {
      sink.passEnd();
    }
    broke = false;
    for (let mid = it.mid; mid < it.end; mid++) {
      lastMid = mid;
      sink.measure(mid, it.pass, {
        skip: mid === it.mid ? it.skip : 0,
        limit: mid === it.end - 1 ? it.limit : -1,
        final: mid === it.end - 1 && idx === items.length - 1,
      });
    }
    if (it.endOfPass) {
      sink.passEnd();
      broke = true;
    }
  });
}

/** 展开档应有几遍——按 walkPlay 的换页切出来、确有小节的段数。page-check 的 P5 拿它对页面结构。 */
export function countPasses(items: readonly PlayItem[]): number {
  let n = 0;
  let open = false;
  walkPlay(items, {
    measure: () => {
      if (!open) n++;
      open = true;
    },
    passEnd: () => {
      open = false;
    },
  });
  return n;
}
