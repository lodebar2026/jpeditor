// `.jpwabc` 的音符 token（`jpword/Jpwabc.g4` 的 `Note`）：
// `[( {…}]* [# b #b] 数字 [' ,]* [- 或 _ .] [{C:…}] [)]*`
//
// 与 123 不同的三处：
// - **增时线写在音符 token 里**（`5--`），而且文法里 `-` 与 `_`、`.` 不能连写（`validate` 挡住）；
// - **圆滑线的括号也在 token 里**：`(` 在开头、`)` 在末尾（`slurInToken`），与倚音 `{6,}`、`{YanYin}` 等一起原样保留在 `pre`/`post`；
// - **歌词按 `.Words` 段头的 `@小节,音符` 锚定**，而且连小节中间的 `$` 都算新小节（`model/relayout.ts::anchorTable` 的口径）。
//   增删音符、小节线、换行之后后面各段就错位，所以改完要重算锚点（`postEdit`）：
//   旧锚点 → 它锚住的那个音符在原文里的位置 → 经补丁映射到新原文 → 按新原文重数坐标。

import { JpwFile, WordsSection } from "../../../jpword/jpwfile";
import type { Accidental } from "../../../model/doc";
import { readJpwSource } from "../../../model/fromjpw";
import { dotsRange, type EditDialect, type NoteDuration, type NoteToken, runRange } from "../dialect";
import { jpwTitleFields } from "../header";

const ACC_OF: Record<string, Accidental> = { "#b": "natural", "#": "sharp", b: "flat" };
const ACC_TEXT: Partial<Record<Accidental, string>> = { natural: "#b", sharp: "#", flat: "b" };

const NOTE_RE = /^((?:\(|\{[^}]*\})*)(#b|#|b)?([0-7])([',]*)([-_.]*)((?:\{C:[^}]*\})?\)*)$/;

/** 每个音符在锚点坐标里的 `(小节, 音符)` 与原文位置（小节中间的 `$` 也开新小节，同 `relayout.ts::anchorTable`）。 */
function anchorTable(f: JpwFile): Array<{ mid: number; nid: number; off: number }> {
  const out: Array<{ mid: number; nid: number; off: number }> = [];
  let mid = 0;
  for (const m of readJpwSource(f).measures) {
    mid++;
    let nid = 0;
    for (const ent of m.entries) {
      if (ent.kind === "break") {
        if (ent !== m.entries[m.entries.length - 1]) {
          mid++;
          nid = 0;
        }
        continue;
      }
      if (ent.kind !== "note") continue;
      nid++;
      out.push({ mid, nid, off: ent.source?.offset ?? -1 });
    }
  }
  return out;
}

const WORDS_SPEC_RE = /^W(\d+)(-\d+)?(\([0-9a-zA-Z.,]+\))?@(\d+),(\d+)/;

/** 改完 `.Voice` 之后重算 `.Words` 各段的锚点。读不动（解析失败）就原样返回。 */
function retargetWords(oldText: string, newText: string, mapPos: (pos: number) => number): string {
  let before: ReturnType<typeof anchorTable>;
  let after: ReturnType<typeof anchorTable>;
  let words: WordsSection | undefined;
  try {
    const oldF = JpwFile.fromString(oldText);
    const newF = JpwFile.fromString(newText);
    if (!oldF || !newF) return newText;
    words = newF.getSection(WordsSection) ?? undefined;
    before = anchorTable(oldF);
    after = anchorTable(newF);
  } catch {
    return newText;
  }
  if (!words || before.length === 0) return newText;
  const raws = newText.split("\n");
  let changed = false;
  for (const no of words.lineNos) {
    const raw = raws[no];
    if (raw === undefined) continue;
    const m = WORDS_SPEC_RE.exec(raw);
    if (!m) continue;
    const mid = parseInt(m[4]!, 10);
    const nid = parseInt(m[5]!, 10);
    // 锚点取第一个「不早于它」的音符（`assignLyrics` 的口径）
    const was = before.find((p) => p.mid > mid || (p.mid === mid && p.nid >= nid));
    if (!was || was.off < 0) continue;
    const at = mapPos(was.off);
    const now = after.find((p) => p.off >= at);
    if (!now || (now.mid === mid && now.nid === nid)) continue;
    const head = m[0].slice(0, m[0].length - `@${m[4]},${m[5]}`.length);
    raws[no] = `${head}@${now.mid},${now.nid}${raw.slice(m[0].length)}`;
    changed = true;
  }
  return changed ? raws.join("\n") : newText;
}

export const DIALECT_JPW: EditDialect = {
  parseNote(src: string) {
    const m = NOTE_RE.exec(src);
    if (!m) return null;
    const dur = m[5] ?? "";
    const oct = m[4] ?? "";
    return {
      acc: m[2] ? ACC_OF[m[2]]! : null,
      degree: Number(m[3]),
      octave: [...oct].reduce((n, c) => n + (c === "'" ? 1 : -1), 0),
      halvings: [...dur].filter((c) => c === "_").length,
      dots: [...dur].filter((c) => c === ".").length,
      inlineSustains: [...dur].filter((c) => c === "-").length,
      pre: m[1] ?? "",
      post: m[6] ?? "",
    };
  },
  printNote(t: NoteToken) {
    const acc = t.acc && t.degree !== 0 ? ACC_TEXT[t.acc] ?? "" : "";
    const oct = t.octave > 0 ? "'".repeat(t.octave) : ",".repeat(-t.octave);
    const dur = t.inlineSustains > 0 ? "-".repeat(t.inlineSustains) : "_".repeat(t.halvings) + ".".repeat(t.dots);
    return `${t.pre}${acc}${t.degree}${oct}${dur}${t.post}`;
  },
  noteParts(src: string) {
    const m = NOTE_RE.exec(src);
    if (!m) return null;
    const from = (m[1] ?? "").length;
    const end = from + (m[2] ?? "").length + 1 + (m[4] ?? "").length;
    const tail = m[5] ?? "";
    return { head: [from, end], dots: dotsRange(tail, end), beams: runRange(tail, "_", end), sustains: runRange(tail, "-", end) };
  },
  newNote(degree: number, dur: NoteDuration) {
    return `${degree}${"_".repeat(dur.halvings)}${".".repeat(dur.dots)}`;
  },
  validate(t: NoteToken) {
    if (t.inlineSustains > 0 && (t.halvings > 0 || t.dots > 0)) return "JP-Word 的增时线不能与减时线、附点连写";
    if (t.dots > 1) return "JP-Word 不支持双附点";
    if (t.acc === "double-sharp" || t.acc === "double-flat") return "JP-Word 没有重升重降";
    return null;
  },
  postEdit: retargetWords,
  headerFields: jpwTitleFields,
  sustain: "inline",
  sep: " ",
  barline: "|",
  lineBreak: "$(true)",
  pageBreak: "$(true,0,0,true)",
  slurOpen: "(",
  slurClose: ")",
  slurInToken: true,
  slurNesting: true,
  lyricsFollowBreaks: false,
  deco: { names: { fermata: "YanYin", accent: "ZhongYin" }, text: (n) => n, place: "inToken" },
};
