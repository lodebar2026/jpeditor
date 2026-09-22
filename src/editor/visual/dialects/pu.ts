// 文本谱（番茄 / 诗歌本）的音符 token：`数字` 后面跟任意顺序的修饰符——八度点、`/` 减时线、`.` 附点、
// **后置**升降号、`@` 跟词；番茄的倚音 `1[2]` 也写在 token 里（原样保留）。两种方言的八度点与升降号写法不同，
// 按文档的方言取 `pu/dialect.ts` 的差异表。
//
// 与 123 不同的两处：
// - **换行不是符号**：一行 `Q:` 就是谱面一行，增删换行 = 重切 `Q:`/`C:` 行（`pu/relayout.ts::relayoutPuBreak`，
//   与「按乐句重排」同一套原文搬运）；
// - **弧的 `)` 按队列配对**（先开的先闭），嵌套或交叠会把配对全打乱，所以不许（`slurNesting: false`）。

import type { EditorState } from "@codemirror/state";
import type { Accidental, ScoreDoc } from "../../../model/doc";
import { dialectSpec } from "../../../pu/dialect";
import { relayoutPuBreak } from "../../../pu/relayout";
import { colonFields } from "../header";
import { dotsRange, type EditDialect, keyFifthsAt, type NoteCtx, type NoteDuration, type NoteToken , runRange } from "../dialect";

/** 写出时用的升降号（`pu/dialect.ts` 的表里一个语义可能有几种写法，取规范那个） */
const ACC_TEXT: Record<"tomato" | "shige", Partial<Record<Accidental, string>>> = {
  tomato: { sharp: "#", flat: "$", natural: "=" },
  shige: { sharp: "#", flat: "b", natural: "♮", "double-sharp": "\u{1D12A}", "double-flat": "\u{1D12B}" },
};

const specOf = (nc: NoteCtx) => dialectSpec(nc.puDialect ?? "shige");

export const DIALECT_PU: EditDialect = {
  parseNote(src: string, nc: NoteCtx) {
    const spec = specOf(nc);
    const m = /^([0-7])(.*)$/u.exec(src);
    if (!m) return null;
    const t: NoteToken = { acc: null, degree: Number(m[1]), octave: 0, halvings: 0, dots: 0, pre: "", post: "", inlineSustains: 0 };
    const rest = [...m[2]!];
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]!;
      if (c === spec.octaveUp) t.octave++;
      else if (c === spec.octaveDown) t.octave--;
      else if (c === "/") t.halvings++;
      else if (c === ".") t.dots++;
      else if (spec.accidentals[c]) t.acc = spec.accidentals[c]!;
      else if (c === "@") t.post += c;
      else if (c === "[") {
        // 番茄的倚音 `1[2]`：到 `]` 为止原样保留
        const tail = rest.slice(i).join("");
        if (!tail.endsWith("]")) return null;
        t.post += tail;
        break;
      } else return null; // 夹着别的东西（`5&rit/` 这类），不硬改
    }
    return t;
  },
  printNote(t: NoteToken, nc: NoteCtx) {
    const spec = specOf(nc);
    const acc = t.acc && t.degree !== 0 ? ACC_TEXT[nc.puDialect ?? "shige"][t.acc] ?? "" : "";
    const oct = t.octave > 0 ? spec.octaveUp.repeat(t.octave) : spec.octaveDown.repeat(-t.octave);
    return `${t.pre}${t.degree}${acc}${oct}${"/".repeat(t.halvings)}${".".repeat(t.dots)}${t.post}`;
  },
  noteParts(src: string, nc: NoteCtx) {
    if (!this.parseNote(src, nc)) return null;
    // 修饰符次序不定：音头 = 数字连同紧跟的升降号、八度点
    const spec = specOf(nc);
    const cs = [...src];
    let end = 1;
    while (end < cs.length && (cs[end] === spec.octaveUp || cs[end] === spec.octaveDown || spec.accidentals[cs[end]!])) end++;
    const head = cs.slice(0, end).join("").length;
    // 倚音 `[…]` 里的 `.` 不算
    const tail = src.slice(head).split("[")[0]!;
    // 文本谱的减时线是 `/`
    return { head: [0, head], dots: dotsRange(tail, head), beams: runRange(tail, "/", head) };
  },
  newNote(degree: number, dur: NoteDuration) {
    return `${degree}${"/".repeat(dur.halvings)}${".".repeat(dur.dots)}`;
  },
  contextAt(_state: EditorState, doc: ScoreDoc | null, pos: number): NoteCtx {
    return { fifths: keyFifthsAt(doc, pos), unitQuarters: 1, puDialect: doc?.puDialect === "tomato" ? "tomato" : "shige" };
  },
  relayoutBreaks(state: EditorState, doc: ScoreDoc, afterId: number, add: boolean, page: boolean): string | null {
    return relayoutPuBreak(state.doc.toString(), doc, { afterId, add, page });
  },
  // `C:` 是歌词、`Q:` 是曲谱，不在这里；有谱把调号拍号写成一行 `1=C4/4`
  headerFields: (text) => colonFields(text, {
    T: "text", B: "text", Z: "text", V: "text", J: "text", XL: "text", XR: "text",
    TL: "text", TR: "text", BL: "text", BC: "text", BR: "text", D: "key", P: "time",
  }, /^\s*[1-7]\s*=\s*\S/),
  sustain: "token",
  sep: " ",
  barline: "|",
  lineBreak: null,
  pageBreak: null,
  slurOpen: "(",
  slurClose: ")",
  slurInToken: false,
  slurNesting: false,
  lyricsFollowBreaks: false,
  deco: { names: { fermata: "yc", accent: "zy" }, text: (n) => `&${n}`, place: "after" },
};
