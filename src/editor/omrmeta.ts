// 简谱识别核对的点选映射：识别产物转成 123 文本后，「第 i 个识别音符 → 代码区间」。
//
// 识别结果的音符序是 `flatten(rows[].nums)`（`omr/emit.ts` 的约定），`omr/musicxml.ts` 按这个序
// 一个 num 写一个 `<note>`，读回 `ScoreDoc` 再 `emit123` 也保持这个序。所以这里重解析 123 文本，
// 按元素序（倚音除外）取各元素的源区间，歌词取音节的源区间，就与识别序逐位对齐。
import type { JpwMeta, JpwRange } from "../omr/types";
import type { SourceSpan } from "../model/doc";
import { parse123 } from "../j123/parse";

const rangeOf = (s: SourceSpan | undefined): JpwRange | null =>
  s && s.length > 0 ? { from: s.offset, to: s.offset + s.length } : null;

export function metaFrom123(text: string): JpwMeta {
  const meta: JpwMeta = { noteRanges: [], lyricRanges: [], authorRanges: [] };
  const song = parse123(text).songs[0];
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
  // 页眉：T: 第一条是标题，C: 每条一个作者
  const header = /^(T|C)\s*[:：]\s*(.*?)\s*$/gm;
  for (let m = header.exec(text); m; m = header.exec(text)) {
    const value = m[2] ?? "";
    if (!value) continue;
    const from = m.index + m[0].indexOf(value, m[1]!.length);
    const range = { from, to: from + value.length };
    if (m[1] === "T") meta.titleRange ??= range;
    else meta.authorRanges.push({ text: value, range });
  }
  return meta;
}
