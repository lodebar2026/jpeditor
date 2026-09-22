// 简谱识别核对的点选映射：识别产物写成文本后，「第 i 个识别音符 → 代码区间」。
//
// 识别结果的音符序是 `flatten(rows[].nums)`（`omr/emit.ts` 的约定），`omr/todoc.ts` 按这个序
// 一个 num 建一个 `Chord`（倚音另建、长休止拆成几个 0），各写出端（`emit123` / `emitPu`）也保持这个序。
// 所以这里**重解析写出的文本**，按元素序（倚音、无时值占位除外）取各元素的源区间，歌词取音节的源区间，
// 就与识别序逐位对齐——映射从读入端的源区间来，不在写出端边写边记，两种格式同一个做法。
import type { JpwMeta, JpwRange } from "./types";
import type { ScoreDoc, SourceSpan } from "../model/doc";
import { parse123 } from "../j123/parse";
import { parsePu } from "../pu/parse";
import type { Dialect } from "../pu/dialect";

const rangeOf = (s: SourceSpan | undefined): JpwRange | null =>
  s && s.length > 0 ? { from: s.offset, to: s.offset + s.length } : null;

/** 元素与歌词的区间（按识别音序）。 */
function elementMeta(doc: ScoreDoc): JpwMeta {
  const meta: JpwMeta = { noteRanges: [], lyricRanges: [], authorRanges: [] };
  const song = doc.songs[0];
  if (!song) return meta;
  let i = 0;
  for (const part of song.parts) {
    for (const m of part.measures) {
      for (const el of m.elements) {
        if (el.kind === "chord" && el.grace) continue;
        if (el.kind === "space" && el.spacer === "y") continue;
        meta.noteRanges[i] = rangeOf(el.source) ?? { from: 0, to: 0 };
        const slot = new Map<number, JpwRange>();
        for (const l of el.lyrics ?? []) {
          const r = rangeOf(l.source);
          if (!r) continue;
          for (let v = l.number; v <= (l.numberTo ?? l.number); v++) slot.set(v - 1, r);
        }
        meta.lyricRanges[i] = slot;
        i++;
      }
    }
  }
  return meta;
}

/** 页眉：标题字段第一条是标题，著作者字段每条一个作者。 */
function headerMeta(meta: JpwMeta, text: string, titleField: string, authorField: string): void {
  const header = new RegExp(`^(${titleField}|${authorField})\\s*[:：]\\s*(.*?)\\s*$`, "gm");
  for (let m = header.exec(text); m; m = header.exec(text)) {
    const value = m[2] ?? "";
    if (!value) continue;
    const from = m.index + m[0].indexOf(value, m[1]!.length);
    const range = { from, to: from + value.length };
    if (m[1] === authorField) meta.authorRanges.push({ text: value, range });
    else meta.titleRange ??= range;
  }
}

/** 123 核对文本的点选映射。 */
export function metaFrom123(text: string): JpwMeta {
  const meta = elementMeta(parse123(text));
  headerMeta(meta, text, "T", "C");
  return meta;
}

/** 文本谱的点选映射（番茄的标题字段是 `B:`、诗歌本是 `T:`，著作者都是 `Z:`）。 */
export function metaFromPu(text: string, dialect: Dialect): JpwMeta {
  const meta = elementMeta(parsePu(text, { dialect }));
  headerMeta(meta, text, "B|T", "Z");
  return meta;
}
