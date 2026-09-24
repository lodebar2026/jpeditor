// ABC 的音符 token：`[^ _ =]*字母[' ,]*[时值]`（`abcfamily/dialectabc.ts::scanNote`），休止 `z[时值]`。
//
// 与简谱格式不同的三处，都在这里换算，动作层看到的仍是唱名与减时线：
// - **音名 ↔ 唱名**按这个位置的调号换算，八度口径与 `model/jianpu.ts::degreeFromPitch` 同源
//   （改完读回来点数不变）。
// - **时值相对 `L:`**，没有增时线：二分音符写成 `C2`，在动作层里当作「带一条增时线」（`inlineSustains`）。
// - **升降号是绝对的**（`^F` 是 F 升，与调号无关；`abcfamily/abcpitch.ts`），动作层的却相对调号（简谱口径）：
//   按这个位置的调号折算——`K:F` 里对 4（B♭）按升号写 `=B`，按还原号写 `_B`。小节内延续两边各管各的，不在这里折算。
// 换行就是代码行末（`lineBreak` 为空串），`w:` 对紧挨在前的那条代码行；延音线写 `-`。

import type { EditorState } from "@codemirror/state";
import type { Accidental, ScoreDoc } from "../../../model/doc";
import { jpTonicOctaveShift, keyAlter, tonicStep } from "../../../score/jppitch";
import { type EditDialect, keyFifthsAt, type NoteCtx, type NoteDuration, type NoteToken } from "../dialect";
import { colonFields } from "../header";

const STEPS = "CDEFGAB";
const ACC_OF: Record<string, Accidental> = { "^^": "double-sharp", __: "double-flat", "^": "sharp", _: "flat", "=": "natural" };
const ALTER_TEXT: Record<number, string> = { 2: "^^", [-2]: "__", 1: "^", [-1]: "_", 0: "=" };
const ACC_ALTER: Record<Accidental, number> = { "double-sharp": 2, "double-flat": -2, sharp: 1, flat: -1, natural: 0 };
/** 相对调号的偏移 → 简谱记号（偏移 0 是「还原到调号」） */
const ACC_BY_OFFSET: Record<number, Accidental> = { 2: "double-sharp", [-2]: "double-flat", 1: "sharp", [-1]: "flat", 0: "natural" };

const NOTE_RE = /^(\^\^|__|\^|_|=)?([A-Ga-g])([',]*)(\d*)(\/*)(\d*)$/;
const REST_RE = /^z(\d*)(\/*)(\d*)$/;

/** `2` / `/` / `/4` / `3/2` → 相对 `L:` 的倍数 */
function lenOf(num: string, slashes: string, den: string): number {
  const n = num ? Number(num) : 1;
  const d = slashes ? (den ? Number(den) : 1 << slashes.length) : 1;
  return d === 0 ? n : n / d;
}

/** 以四分音符为 1 的时值 → 增时线 / 减时线 / 附点（写不成的返回 null） */
function split(q: number): { s: number; h: number; d: number } | null {
  for (const d of [0, 1]) {
    for (let h = 0; h <= 4; h++) {
      const beats = (q * (1 << h)) / (d ? 1.5 : 1);
      const s = Math.round(beats) - 1;
      if (s < 0 || Math.abs(beats - (s + 1)) > 1e-9) continue;
      if (h > 0 && s > 0) continue; // 减时线与增时线不同时用
      return { s, h, d };
    }
  }
  return null;
}

/** 相对 `L:` 的倍数 → ABC 时值写法 */
function lenText(r: number): string {
  for (const d of [1, 2, 4, 8, 16, 32, 64]) {
    const n = r * d;
    if (Math.abs(n - Math.round(n)) > 1e-9) continue;
    const ni = Math.round(n);
    if (ni === d) return "";
    if (d === 1) return String(ni);
    if (ni === 1) return d === 2 ? "/" : `/${d}`;
    return `${ni}/${d}`;
  }
  return "";
}

function quartersOf(t: NoteToken): number {
  return ((1 + t.inlineSustains) / (1 << t.halvings)) * (t.dots ? 1.5 : 1);
}

/** 唱名 + 八度点 → 音名的「全局音级」（C4 = 28） */
function wrOf(degree: number, octave: number, fifths: number): number {
  return tonicStep(fifths) + (degree - 1) + 7 * (octave + 4 - jpTonicOctaveShift(fifths));
}

function letterOf(wr: number): string {
  const step = STEPS[((wr % 7) + 7) % 7]!;
  const oct = Math.floor(wr / 7);
  return oct >= 5 ? step.toLowerCase() + "'".repeat(oct - 5) : step + ",".repeat(4 - oct);
}

/** 这个位置上的默认音长：最近一条 `L:`；没写就按 `M:` 推（ABC §3.1.7：拍号小于 3/4 取 1/16，否则 1/8）。 */
function unitAt(state: EditorState, pos: number): number {
  const text = state.doc.sliceString(0, pos);
  let unit: number | null = null;
  let meter: number | null = null;
  for (const line of text.split("\n")) {
    const l = /^\s*L\s*:\s*(\d+)\s*\/\s*(\d+)/.exec(line);
    if (l) unit = (4 * Number(l[1])) / Number(l[2]);
    const m = /^\s*M\s*:\s*(?:(\d+)\s*\/\s*(\d+)|(C\|?))/.exec(line);
    if (m) meter = m[3] ? 1 : Number(m[1]) / Number(m[2]);
    if (/^\s*X\s*:/.test(line)) {
      unit = null;
      meter = null;
    }
  }
  if (unit !== null) return unit;
  return meter !== null && meter < 0.75 ? 0.25 : 0.5;
}

export const DIALECT_ABC: EditDialect = {
  parseNote(src: string, nc: NoteCtx) {
    const rest = REST_RE.exec(src);
    const m = rest ? null : NOTE_RE.exec(src);
    if (!rest && !m) return null;
    const q = (rest ? lenOf(rest[1]!, rest[2]!, rest[3]!) : lenOf(m![4]!, m![5]!, m![6]!)) * nc.unitQuarters;
    const dur = split(q);
    if (!dur) return null;
    const base = { halvings: dur.h, dots: dur.d, inlineSustains: dur.s, pre: "", post: "" };
    if (rest) return { acc: null, degree: 0, octave: 0, ...base };
    const letter = m![2]!;
    const marks = m![3]!;
    const oct = (/[a-g]/.test(letter) ? 5 : 4) + [...marks].reduce((n, c) => n + (c === "'" ? 1 : -1), 0);
    const wr = STEPS.indexOf(letter.toUpperCase()) + oct * 7;
    const b = tonicStep(nc.fifths);
    let acc: Accidental | null = null;
    if (m![1]) {
      acc = ACC_BY_OFFSET[ACC_ALTER[ACC_OF[m![1]]!] - keyAlter(((wr % 7) + 7) % 7, nc.fifths)] ?? null;
      if (!acc) return null; // 偏出调号两个半音以上（`K:D` 里的 `__F`），简谱记号写不出
    }
    return {
      acc,
      degree: ((((wr - b) % 7) + 7) % 7) + 1,
      octave: Math.floor((wr - b) / 7) - 4 + jpTonicOctaveShift(nc.fifths),
      ...base,
    };
  },
  printNote(t: NoteToken, nc: NoteCtx) {
    const len = lenText(quartersOf(t) / nc.unitQuarters);
    if (t.degree === 0) return `${t.pre}z${len}${t.post}`;
    const wr = wrOf(t.degree, t.octave, nc.fifths);
    const acc = t.acc ? ALTER_TEXT[keyAlter(((wr % 7) + 7) % 7, nc.fifths) + ACC_ALTER[t.acc]] ?? "" : "";
    return `${t.pre}${acc}${letterOf(wr)}${len}${t.post}`;
  },
  noteParts(src: string) {
    // 附点在 ABC 里是时值数字（`3/2`），没有单独的符号可选
    if (REST_RE.test(src)) return { head: [0, 1], dots: null };
    const m = NOTE_RE.exec(src);
    if (!m) return null;
    return { head: [0, (m[1] ?? "").length + 1 + m[3]!.length], dots: null };
  },
  newNote(degree: number, dur: NoteDuration, nc: NoteCtx) {
    return this.printNote({ acc: null, degree, octave: 0, halvings: dur.halvings, dots: dur.dots, inlineSustains: 0, pre: "", post: "" }, nc);
  },
  contextAt(state: EditorState, doc: ScoreDoc | null, pos: number): NoteCtx {
    return { fifths: keyFifthsAt(doc, pos), unitQuarters: unitAt(state, pos) };
  },
  headerFields: (text) => colonFields(text, { T: "text", C: "text", Q: "text", K: "key", M: "time" }),
  sustain: "inline",
  sep: " ",
  barline: "|",
  lineBreak: "",
  pageBreak: null,
  slurOpen: "(",
  slurClose: ")",
  slurInToken: false,
  slurNesting: true,
  tie: "-",
  lyricBlockByCodeLine: true,
  lyricsFollowBreaks: true,
  deco: { names: { fermata: "fermata", accent: "accent" }, text: (n) => `!${n}!`, place: "before" },
};
