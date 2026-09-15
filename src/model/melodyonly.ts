// 只留旋律：歌本里「只印主旋律」的曲目（清单 `meta["layout.melody-only"]`）。
//
// 对应原排版程序的 `melodyOnly`，分两步、**次序与原程序一致**：
//
// 1. 这里（读谱前，util/pao.cpp:1019 `mscr->part.resize(1)` + 只留 P1）：只把声部裁到第一个，
//    P1 内部的多声部、和弦音一个不动。
// 2. 混排引擎读完整条（含弧/延音线配对与方向推断）之后，由 `mixed/layout.ts::removeNoneMelody`
//    删掉非旋律音（`MixedOptions.melodyOnly`）。删早了 tie 的方向与高度就按单音谱推断，与成品不符。
//
// 就地改。无 DOM 依赖。
import type { ElementId, Song } from "./doc";

/** 只留第一个声部（P1）。挂在被删声部元素上的记号一并删掉，免得端点悬空。 */
export function keepFirstPart(song: Song): void {
  const part = song.parts[0];
  if (!part) return;
  song.parts = [part];
  if (song.partGroups) song.partGroups = song.partGroups.filter((g) => g.parts.every((p) => p === part.id));
  const kept = new Set<ElementId>();
  for (const m of part.measures) for (const el of m.elements) kept.add(el.id);
  song.marks = song.marks.filter((mk) => kept.has(mk.start) && kept.has(mk.end));
}
