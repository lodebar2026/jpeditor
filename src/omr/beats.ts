// 识别结果的小节时值自检：识别结果转成 `ScoreDoc`（`todoc.ts`）后交给编辑器同一份检查（`model/beatcheck.ts`），
// 再把问题小节对回源图坐标——核对视图按它标红，CLI（私有仓库 `beat-check.mjs`）按它出报告。
//
// 增时线、减时线读错时小节就凑不满，这是**不需要 GT** 就能自动找出识别错的手段（迦南诗选那批实测：报出来的全是真错）。

import type { ElementId } from "../model/doc";
import { type BeatIssue, checkMeasureDurations, describeBeatIssue } from "../model/beatcheck";
import { recognizedToDoc } from "./todoc";
import type { JpNum, Rect, RecognizedScore } from "./types";

export interface RecognizedBeatIssue {
  issue: BeatIssue;
  /** 「第 3 小节差 1/2 拍（…）」 */
  text: string;
  /** 这一小节的音符在源图上的外包框，按谱行各一个（跨行的小节有两个） */
  boxes: Rect[];
  /** 起头那一行（0 基） */
  row: number;
  /** 这一小节的音符写法（报告里一眼看出是哪几个音：`5/ 6. 1-`） */
  toks: string[];
}

export function recognizedBeatIssues(score: RecognizedScore): RecognizedBeatIssue[] {
  const numOf = new Map<ElementId, JpNum>();
  const doc = recognizedToDoc(score, numOf);
  const rowOf = new Map<JpNum, number>();
  score.rows.forEach((row, ri) => row.nums.forEach((n) => rowOf.set(n, ri)));
  const opts = score.meters?.length ? { meters: score.meters } : {};
  return checkMeasureDurations(doc, opts).map((issue) => {
    const nums = issue.ids.map((id) => numOf.get(id)).filter((n): n is JpNum => !!n);
    const byRow = new Map<number, Rect>();
    for (const n of nums) {
      const ri = rowOf.get(n) ?? -1;
      const b = n.bbox;
      const cur = byRow.get(ri);
      if (!cur) byRow.set(ri, { ...b });
      else {
        const x = Math.min(cur.x, b.x);
        const y = Math.min(cur.y, b.y);
        byRow.set(ri, { x, y, w: Math.max(cur.x + cur.w, b.x + b.w) - x, h: Math.max(cur.y + cur.h, b.y + b.h) - y });
      }
    }
    return {
      issue,
      text: `第 ${issue.measureIndex + 1} 小节${describeBeatIssue(issue)}`,
      boxes: [...byRow.values()],
      row: nums.length ? rowOf.get(nums[0]!) ?? 0 : 0,
      toks: nums.map((n) => `${n.digit}${"/".repeat(n.div)}${".".repeat(n.dot)}${"-".repeat(n.augment)}`),
    };
  });
}
