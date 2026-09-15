// 只留旋律：歌本里「只印主旋律」的曲目（清单 `meta["layout.melody-only"]`）。
//
// 对应原排版程序的 `melodyOnly`：只留第一个声部（P1）、每个和弦只留简谱印的那个音（`removeNoneMelody`：
// 只留叠层 1 的音）。这里按语义层的旋律取音做——第一谱表最小 voice 那一路、和弦取最高音
// （`model/jianpu.ts::melodyChords` / `topNote`，与混排简谱层印哪个音是同一套判据）。
// 挂在被删元素上的记号（弧、延音线、连音…）一并删掉，免得端点悬空。
//
// 就地改。无 DOM 依赖。
import type { ElementId, Song } from "./doc";
import { melodyChords, topNote } from "./jianpu";

export function keepMelodyOnly(song: Song): void {
  const part = song.parts[0];
  if (!part) return;
  song.parts = [part];
  if (song.partGroups) song.partGroups = song.partGroups.filter((g) => g.parts.every((p) => p === part.id));
  const kept = new Set<ElementId>();
  const reduced = new Set<ElementId>();
  for (const m of part.measures) {
    const lane = new Set(melodyChords(m, 1));
    const laneVoice = [...lane][0]?.voice;
    m.elements = m.elements.filter((el) => (el.kind === "chord" ? lane.has(el) : el.staff === 1 && el.voice === laneVoice));
    for (const el of m.elements) {
      kept.add(el.id);
      if (el.kind === "chord" && el.notes.length > 1) {
        const top = topNote(el);
        if (top) el.notes = [top];
        reduced.add(el.id);
      }
    }
  }
  song.marks = song.marks.filter((mk) => kept.has(mk.start) && kept.has(mk.end));
  for (const mk of song.marks) {
    if (reduced.has(mk.start)) delete mk.startNote;
    if (reduced.has(mk.end)) delete mk.endNote;
  }
}
