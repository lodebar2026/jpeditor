// 123 的音符 token：`[#b n ## bb]数字[',]*[_.]*`（`abcfamily/dialect123.ts::scanNote` 的写法），
// 增时线 `-`、小节线 `|`、换行 `$` / `$$`、圆滑线 `( )` 都是独立 token。

import type { Accidental } from "../../../model/doc";
import { dotsRange, type EditDialect, type NoteDuration, type NoteToken } from "../dialect";
import { colonFields } from "../header";

const ACC_OF: Record<string, Accidental> = {
  "#": "sharp", b: "flat", n: "natural", "##": "double-sharp", bb: "double-flat",
};
const ACC_TEXT: Partial<Record<Accidental, string>> = {
  sharp: "#", flat: "b", natural: "n", "double-sharp": "##", "double-flat": "bb",
};

const NOTE_RE = /^(##|bb|#|b|n)?([0-7])([',]*)([_.]*)$/;

export const DIALECT_123: EditDialect = {
  parseNote(src) {
    const m = NOTE_RE.exec(src);
    if (!m) return null;
    const oct = m[3] ?? "";
    const dur = m[4] ?? "";
    // 减时线与附点可以交替写（`_._`），规范写法是先 `_` 后 `.`，写回时按规范写
    return {
      acc: m[1] ? ACC_OF[m[1]]! : null,
      degree: Number(m[2]),
      octave: [...oct].reduce((n, c) => n + (c === "'" ? 1 : -1), 0),
      halvings: [...dur].filter((c) => c === "_").length,
      dots: [...dur].filter((c) => c === ".").length,
      pre: "",
      post: "",
      inlineSustains: 0,
    };
  },
  printNote(t: NoteToken) {
    const acc = t.acc && t.degree !== 0 ? ACC_TEXT[t.acc] ?? "" : "";
    const oct = t.octave > 0 ? "'".repeat(t.octave) : ",".repeat(-t.octave);
    return `${t.pre}${acc}${t.degree}${oct}${"_".repeat(t.halvings)}${".".repeat(t.dots)}${t.post}`;
  },
  noteParts(src) {
    const m = NOTE_RE.exec(src);
    if (!m) return null;
    const end = (m[1] ?? "").length + 1 + (m[3] ?? "").length;
    return { head: [0, end], dots: dotsRange(m[4] ?? "", end) };
  },
  newNote(degree: number, dur: NoteDuration) {
    return `${degree}${"_".repeat(dur.halvings)}${".".repeat(dur.dots)}`;
  },
  headerFields: (text) => colonFields(text, { T: "text", C: "text", Q: "text", K: "key", M: "time" }),
  sustain: "token",
  sep: " ",
  barline: "|",
  lineBreak: "$",
  pageBreak: "$$",
  slurOpen: "(",
  slurClose: ")",
  slurInToken: false,
  slurNesting: true,
  lyricsFollowBreaks: true,
  deco: { names: { fermata: "fermata", accent: "accent" }, text: (n) => `!${n}!`, place: "before" },
};
