// ABC 家族（123 与标准 ABC）共用的词法产物类型。
//
// 两种方言**只有音乐体不同**（见 `docs/格式/123格式.md` §0）：头部字段、`V:`/`w:`/`P:`、
// 小节线与房号、装饰、和弦与注记、倚音、多连音全部同源。所以 token 的种类是共用的，
// 差异只落在 `note` 这一种携带什么：123 带 `degree`（调内度数），ABC 带 `step`/`alter`/`octave`
// （绝对音名）；时值 123 用 `beams`/`dots` 相对表达，ABC 用 `num`/`den` 相对 `L:`。
//
// `ScoreDoc.Note` 本来就是 `degree` 与 `pitch` 并存、可互推（`model/helpers.ts`），
// 所以这两套 token 最后汇到同一个模型里，不需要第二个模型。

import type { Accidental, SourceSpan } from "../model/doc";

export type TokenKind =
  | "note"        // 123: 1-7 / 0（休止）　ABC: A-G a-g
  | "chordGroup"  // ABC 的 [CEG]：同时发声的几个音
  | "broken"      // ABC 的 > / <：破碎节奏
  | "rest"        // ABC 的 z / Z；123 的休止走 note(degree=0)
  | "spacer"      // y（无时值占位）/ x（不可见休止）
  | "rhythm"      // X（节奏音符：有声无音高）
  | "sustain"     // 123 的 `-` 增时线
  | "tie"         // ABC 的 `-` 延音线
  | "barline"     // | || |] [| |: :| :: |:: ::| .| [|]
  | "ending"      // [1 / [1,3 / [1-3 / |1 / :|2
  | "slurStart"   // (
  | "slurEnd"     // )
  | "tuplet"      // 123: (3:　ABC: (3
  | "grace"       // {6,} / {ab}
  | "deco"        // !fermata! / !mf! / !D.S.!；ABC 还有 . ~ H-W 这类单字符装饰
  | "chord"       // "Am7"
  | "annotation"  // "^rit." / "_text"
  | "inlineField" // [K:G] / [M:3/4] / [I:style …]
  | "break"       // $ 换行 / $$ 换页
  | "space"       // 空白（符杠分组的依据，**不能丢**）
  | "unknown";

export interface Token {
  kind: TokenKind;
  /** 原文 */
  text: string;
  source: SourceSpan;
  // ── note（123）──
  /** 唱名 0..7 */
  degree?: number;
  /** 八度点：正高负低 */
  octave?: number;
  accidental?: Accidental;
  /** 减时线条数（`_` 个数） */
  beams?: number;
  /** 附点个数 */
  dots?: number;
  // ── note（ABC）──
  /** 音名 C..B */
  step?: string;
  /** 变音半音数（相对调号；未标记时 undefined） */
  alter?: number;
  /** 时值 = `L:` × num/den */
  num?: number;
  den?: number;
  /** ABC 的破碎节奏 `>` / `<`：正数表示本音符后面有 n 个 `>` */
  broken?: number;
  // ── 其它专用 ──
  /** barline：归一后的样式名；ending：房号列表；tuplet：几连音 */
  value?: string;
  numbers?: number[];
  /** 反复次数（`|::` = 3 遍） */
  repeatTimes?: number;
  /** grace：倚音的音符 token */
  notes?: Token[];
  /** grace：`{/g}` 这种带斜线的短倚音 */
  acciaccatura?: boolean;
}

export interface LexError {
  message: string;
  source: SourceSpan;
}

export interface LexResult {
  tokens: Token[];
  errors: LexError[];
}

/** 时值修饰的扫描结果。123 是 `_`/`.`，ABC 是 `2` `/2` `3/2` 这类分数。 */
export interface DurationScan {
  beams: number;
  dots: number;
  /** ABC：相对 `L:` 的倍数 */
  num?: number;
  den?: number;
  next: number;
}

export interface NoteScan extends DurationScan {
  /** 123 的调内度数 */
  degree?: number;
  /** ABC 的音名 */
  step?: string;
  alter?: number;
  /** 八度偏移（两种方言都用 `'` 与 `,`，ABC 另有大小写） */
  octave: number;
  accidental?: Accidental;
}
