// 只留旋律：歌本里「只印主旋律」的曲目（清单 `meta["layout.melody-only"]`）。
//
// 对应原排版程序的 `melodyOnly`：只留第一个声部（P1）、每个和弦只留简谱印的那个音（`removeNoneMelody`：
// 只留叠层 1 的音）。这里按语义层的旋律取音做——第一谱表最小 voice 那一路、和弦取最高音
// （`model/jianpu.ts::melodyChords` / `topNote`，与混排简谱层印哪个音是同一套判据）。
// 挂在被删元素上的记号（弧、延音线、连音…）一并删掉，免得端点悬空。
// 和弦符号不删：原程序的和弦在小节表里、不挂音符，删音不连带它。`<harmony>` 写在 `<backup>` 前时读谱会把它
// 挂到后面第二声部的音上（《基督是锚》第 16 小节末的 D），这里改挂到无时值的 `y` 占位上，起点照旧。
//
// 就地改。无 DOM 依赖。
import type { Element, ElementId, Harmony, Song, Space } from "./doc";
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
    const keep = (el: Element): boolean => (el.kind === "chord" ? lane.has(el) : el.staff === 1 && el.voice === laneVoice);
    // 被删元素上的和弦：起点按 fromxml 的口径（缺省 = 前一个元素的终点）先算好
    const orphans: Space[] = [];
    let prevEnd = 0;
    for (const el of m.elements) {
      const on = el.onset ?? prevEnd;
      if (el.kind === "chord") prevEnd = on + el.duration.divisions;
      if (keep(el)) continue;
      const hs: Harmony[] = [el.harmony, ...(el.kind === "chord" ? el.laterHarmonies ?? [] : [])].filter((h): h is Harmony => !!h);
      for (const h of hs) {
        orphans.push({ kind: "space", id: el.id, spacer: "y", voice: laneVoice ?? 1, staff: 1, harmony: h, onset: h.onset ?? on });
      }
    }
    m.elements = m.elements.filter(keep);
    for (const el of m.elements) {
      kept.add(el.id);
      if (el.kind === "chord" && el.notes.length > 1) {
        const top = topNote(el);
        if (top) el.notes = [top];
        reduced.add(el.id);
      }
    }
    // 占位放在末尾且带明确起点，不改动其余元素的起点；id 借被删元素的（不进 kept，挂在它上的记号照删）
    m.elements.push(...orphans);
  }
  song.marks = song.marks.filter((mk) => kept.has(mk.start) && kept.has(mk.end));
  for (const mk of song.marks) {
    if (reduced.has(mk.start)) delete mk.startNote;
    if (reduced.has(mk.end)) delete mk.endNote;
  }
}
