// 可视化编辑里**因格式而异**的那一层：音符 token 怎么读写、增时线/小节线/换行/圆滑线怎么写。
//
// 动作层（`ops.ts`）与格式无关，只跟这张接口打交道；每种有代码区的格式各给一份实现（`dialects/`），
// 挂在 `FormatAdapter.editDialect` 上。**别在动作层里按格式分叉**——差异加到这里。

import type { Accidental } from "../../model/doc";
import type { EditorState } from "@codemirror/state";
import type { ScoreDoc } from "../../model/doc";
import type { HeaderField } from "./header";

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

/** 音符 token 里各部分的位置（相对 token 开头，左闭右开）。
 *  谱面上点音符只选中 `head`——升降号、唱名、八度点，不带减时线、附点、增时线与括号；
 *  附点可以单独点选（`dots`，写不出单独符号的格式如 ABC 为 null）。 */
export interface NoteParts {
  head: [number, number];
  dots: [number, number] | null;
  /** 减时线那一串（123 / `.jpwabc` 是 `_`，文本谱是 `/`）。ABC 的时值是数字、没有单独符号可选，为 null */
  beams?: [number, number] | null;
  /** **写在 token 里**的增时线那一串（`.jpwabc` 的 `5---`）。123 / 文本谱的增时线是独立符号、
   *  在索引里另有条目（`SyncEntry.kind === "sustain"`），不走这里，为 null */
  sustains?: [number, number] | null;
}

/** `s` 里 `ch` 从第一个到最后一个的范围（加上 `base` 偏移）；一个都没有为 null。 */
export function runRange(s: string, ch: string, base: number): [number, number] | null {
  const a = s.indexOf(ch);
  return a < 0 ? null : [base + a, base + s.lastIndexOf(ch) + 1];
}

/** `s` 里 `.` 从第一个到最后一个的范围（加上 `base` 偏移）；没有 `.` 为 null。 */
export function dotsRange(s: string, base: number): [number, number] | null {
  return runRange(s, ".", base);
}

/** 读写音符 token 要的上下文：ABC 的音名要按调号换算成唱名、时值相对 `L:`。其余格式用不到。 */
export interface NoteCtx {
  /** 这个位置上的调号（升号个数为正） */
  fifths: number;
  /** ABC 的默认音长 `L:`，以四分音符为 1 */
  unitQuarters: number;
  /** 文本谱的方言（番茄 / 诗歌本：八度点、升降号写法不同） */
  puDialect?: "tomato" | "shige";
}

/** 面板与快捷键给的常用装饰 */
export type DecoKind = "fermata" | "accent";

/** 新音符的时值（插入模式的「当前时值」）。 */
export interface NoteDuration {
  halvings: number;
  dots: number;
}

export interface EditDialect {
  /** 读一个音符 token（`SyncIndex` 里 `note` 条目的原文）。读不了（夹着别的东西、不是这几样能描述的）返回 null。 */
  parseNote(src: string, nc: NoteCtx): NoteToken | null;
  /** 写回。与 `parseNote` 对称：`printNote(parseNote(s))` 必须还原 `s`（规范写法下）。 */
  printNote(t: NoteToken, nc: NoteCtx): string;
  /** token 里音头与附点的位置（`parseNote` 读得懂的 token 才给；缺省整个 token 算音头）。 */
  noteParts?(src: string, nc: NoteCtx): NoteParts | null;
  /** 新写一个音符。 */
  newNote(degree: number, dur: NoteDuration, nc: NoteCtx): string;
  /** 改完的 token 这种格式写不写得出；写不出返回说明（`.jpwabc` 的 `-` 不能与 `_`、`.` 连写） */
  validate?(t: NoteToken): string | null;
  /** 常用装饰怎么写：`names` 是原文里的记号名（模型 `AttachedSource.name` 也是它），
   *  `text` 把名字写成原文，`place` 写在音符前（123/ABC 的 `!fermata!3`）、后（文本谱 `3&yc`）
   *  或音符 token 里的 `{…}`（`.jpwabc` 的 `{YanYin}3`）。 */
  deco?: { names: Record<DecoKind, string>; text(name: string): string; place: "before" | "after" | "inToken" };
  /** 延音线另有写法（ABC 的 `-` 紧跟前一个音）；缺省 = 与圆滑线同形（括号） */
  tie?: string;
  /** 圆滑线能不能嵌套、交叠。文本谱的 `)` 按队列配对（先开的先闭），加一条与已有的交叠的弧会把配对全打乱 */
  slurNesting: boolean;
  /** 歌词行跟着换行走（123、ABC：`w:` 紧跟在一行曲后面），换行一增删歌词行就要拆、并（`breaks.ts`）。
   *  `.jpwabc` 的歌词按锚点对齐、不跟换行，为 false */
  lyricsFollowBreaks: boolean;
  /** 歌词按**代码行**分块（ABC：`w:` 对紧挨在前的那条代码行；代码行末就是换行）；缺省按 `$` 分（123） */
  lyricBlockByCodeLine?: boolean;
  /** 这个位置上读写音符要的上下文（缺省 C 调、`L:1/4`） */
  contextAt?(state: EditorState, doc: ScoreDoc | null, pos: number): NoteCtx;
  /** 改完原文之后的连带修正（`.jpwabc` 的 `.Words` 锚点按音符数，音符一增删后面各段就错位）。
   *  `mapPos` 把原文偏移映射到新原文。返回修正后的新原文（不用改时原样返回）。 */
  postEdit?(oldText: string, newText: string, mapPos: (pos: number) => number): string;
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
  /** 页眉字段（标题、署名、调号拍号…）在原文里的位置（`header.ts`）：谱面上点页眉跳到原文、原文光标点亮页眉 */
  headerFields?(text: string): HeaderField[];
  /** 换行不是符号的格式：给出「在 `afterId` 之后加 / 去掉一处换行」后的整份新原文。 */
  relayoutBreaks?(state: EditorState, doc: ScoreDoc, afterId: number, add: boolean, page: boolean): string | null;
}

/** 模型里这个原文位置上生效的调号（升号个数）：按元素顺序走，取最后一个不晚于 `pos` 的元素所在处的调号。 */
export function keyFifthsAt(doc: ScoreDoc | null, pos: number): number {
  let best = 0;
  let bestOff = -1;
  for (const song of doc?.songs ?? []) {
    for (const part of song.parts) {
      let cur = song.key?.fifths ?? 0;
      for (const m of part.measures) {
        if (m.attrs?.key) cur = m.attrs.key.fifths;
        for (const el of m.elements) {
          const off = el.source?.offset;
          if (off === undefined || off > pos) continue;
          if (off > bestOff) {
            bestOff = off;
            best = cur;
          }
        }
      }
    }
  }
  return best;
}
