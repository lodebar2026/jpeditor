// 可视化编辑里**因格式而异**的那一层：音符 token 怎么读写、增时线/小节线/换行/圆滑线怎么写。
//
// 动作层（`ops.ts`）与格式无关，只跟这张接口打交道；每种有代码区的格式各给一份实现（`dialects/`），
// 挂在 `FormatAdapter.editDialect` 上。**别在动作层里按格式分叉**——差异加到这里。

import type { Accidental } from "../../model/doc";
import type { EditorState } from "@codemirror/state";
import type { ScoreDoc } from "../../model/doc";

/** 与格式无关的音符 token。只描述可视化编辑要改的那几样，其余原样保留在 `pre` / `post`。 */
export interface NoteToken {
  /** 升降号（面上印的） */
  acc: Accidental | null;
  /** 0 = 休止，1–7 = 唱名 */
  degree: number;
  /** 高八度点为正、低八度点为负 */
  octave: number;
  /** 减时线条数（八分 1、十六分 2…） */
  halvings: number;
  dots: number;
  /** token 里写在音符前、原样保留的部分（`.jpwabc` 的 `(`、`{(3}`、倚音 `{…}`） */
  pre: string;
  /** token 里写在音符后、原样保留的部分（`.jpwabc` 的 `)`） */
  post: string;
  /** token 里紧贴的增时线条数（只有 `.jpwabc` 把 `-` 写进音符 token） */
  inlineSustains: number;
}

/** 新音符的时值（插入模式的「当前时值」）。 */
export interface NoteDuration {
  halvings: number;
  dots: number;
}

export interface EditDialect {
  /** 读一个音符 token（`SyncIndex` 里 `note` 条目的原文）。读不了（夹着别的东西、不是这几样能描述的）返回 null。 */
  parseNote(src: string): NoteToken | null;
  /** 写回。与 `parseNote` 对称：`printNote(parseNote(s))` 必须还原 `s`（规范写法下）。 */
  printNote(t: NoteToken): string;
  /** 新写一个音符。 */
  newNote(degree: number, dur: NoteDuration): string;
  /** 增时线：`token` = 独立的一个 token（123 的 ` -`）；`inline` = 写进音符 token（`.jpwabc` 的 `5--`） */
  sustain: "token" | "inline";
  /** 独立 token 之间的分隔 */
  sep: string;
  /** 普通小节线 */
  barline: string;
  /** 换行 / 换页符号；null = 这种格式的换行不是一个符号（文本谱另起一行 `Q:`），走 `relayoutBreaks` */
  lineBreak: string | null;
  pageBreak: string | null;
  /** 圆滑线的起止符号 */
  slurOpen: string;
  slurClose: string;
  /** 圆滑线的括号写在音符 token 里面（`.jpwabc`），而不是 token 之间 */
  slurInToken: boolean;
  /** 换行不是符号的格式：给出「在 `afterId` 之后加 / 去掉一处换行」后的整份新原文。 */
  relayoutBreaks?(state: EditorState, doc: ScoreDoc, afterId: number, add: boolean, page: boolean): string | null;
}
