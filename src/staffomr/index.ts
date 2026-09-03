// 五线谱识别入口。全链不碰 DOM（要进 `src/cli/index.ts` 那条 Node 链）。
export * from "./glyphs";
export * from "./symbolmap";
export * from "./staffglyphs";
export * from "./model";
export * from "./vecgeom";
export * from "./page";
export * from "./notedata";
export * from "./toxml";
export * from "./textanalyze";
export * from "./textglyphs";
export * from "./slur";
export * from "./notations";
export * from "./score";
export * from "./octave";

import { extractVectorPage } from "../omr/vector";
import type { OpsEnum } from "../omr/vector";
import { extractTextPage } from "../omr/vectext";
import { StaffGlyphLookup, type StaffGlyphDict } from "./staffglyphs";
import { buildPage, findBarlines, findNoteheads, findStaves, findStems, findSymbols, findTails, makeBars, makeSystems, removeWhite, unknownObjs } from "./page";
import type { SPage, Staff } from "./model";
import { buildNotes, checkBars, findBeams, findClefKeyTime, lastTimeSignature, staffOmrOptions, type BarCheck, type BeamShape, type StaffContext, type StaffNote, type StemInfo } from "./notedata";
import { analyzeText, attachHarmonies, attachLyrics, buildLyricLines, type LyricLine, type TextAnalysis } from "./textanalyze";
import type { TextGlyphLookup } from "./textglyphs";
import { attachSlurs, findSlurs, mergeArcHalves, findWedges, markSlurNotes, reconnectSlurs, type SlurArc } from "./slur";
import { attachDynamics, attachNotations, findNotations, findTuplets } from "./notations";
import { applyOctaveShifts, attachVoltas, findOctaveShifts, findVoltas, type OctaveShift, type Volta } from "./octave";

export interface StaffPageResult {
  page: SPage;
  /** 这一页有没有谱表。没有的（封面/目录/歌词页）后续一律跳过，照 musicpp `Score::process`。 */
  hasStaff: boolean;
  /** 还没有归属的对象数——识别覆盖率的硬指标。 */
  unknown: number;
  /** 逐谱行的谱号/调号/拍号。 */
  ctx: Map<Staff, StaffContext>;
  beams: BeamShape[];
  /** 认出来的音符（按 x 排）。 */
  notes: StaffNote[];
  /** 文本层的分类结果。 */
  text: TextAnalysis;
  lyricLines: LyricLine[];
  /** 圆滑线与连音线。 */
  slurs: SlurArc[];
  /** 八度移位段与反复房号。 */
  octaves: OctaveShift[];
  voltas: Volta[];
  /** 逐小节的时值自检（不靠 GT，见 `checkBars`）。 */
  bars: BarCheck[];
  /** 这一页最后生效的拍号——下一页要拿它当 `opts.carryTime`（续页不再印拍号）。 */
  carryTime?: { beats: number; beatType: number };
}

/**
 * 认一页。顺序照 musicpp `Score::process`，**别调**。
 *
 * @param look 字形字典（`glyphmap.json` → `new StaffGlyphLookup(dict)`）。
 *             一份字典跑全书，别每页重建（构造要解 176 条签名）。
 */
export async function recognizeStaffPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfPage: any,
  OPS: OpsEnum,
  look: StaffGlyphLookup,
  index: number,
  opts: { textLookup?: TextGlyphLookup; carryTime?: { beats: number; beatType: number } } = {},
): Promise<StaffPageResult> {
  const vec = await extractVectorPage(pdfPage, OPS, { scale: 1 });
  const runs = await extractTextPage(pdfPage, OPS, { scale: 1 });
  const pg = buildPage(index, vec.width, vec.height, vec.objs, runs);

  findSymbols(pg, look);
  if (!findStaves(pg)) {
    removeWhite(pg);
    return { page: pg, hasStaff: false, unknown: unknownObjs(pg).length, ctx: new Map(), beams: [], notes: [], text: emptyText(), lyricLines: [], slurs: [], octaves: [], voltas: [], bars: [], carryTime: opts.carryTime };
  }
  findNoteheads(pg);
  findStems(pg);
  findTails(pg);
  findBarlines(pg);
  const ctx = findClefKeyTime(pg);
  makeSystems(pg);
  makeBars(pg);
  const beams = findBeams(pg);
  const stems: StemInfo[] = [];
  const notes = buildNotes(pg, ctx, beams, stems);
  // 三连音要在时值算完之后改（它按比例缩短已算好的时值）
  findTuplets(pg, beams, stems, notes);
  // 弧要在音符之后找：判断「哪条曲线是谱表括号」要用到系统线，挂两端要用到音符。
  // 渐强渐弱要**先于**弧挑出来——它们也是又宽又扁的图形。
  findWedges(pg);
  // 一条弧在这批 PDF 里画成左右两半两个对象，挂音符之前先并回一条
  const slurs = mergeArcHalves(findSlurs(pg), pg.normalStaffSpace || pg.space);
  attachSlurs(slurs, notes, pg.normalStaffSpace || pg.space);
  reconnectSlurs(pg, slurs);
  markSlurNotes(slurs);
  // 八度移位要在音高算完之后、文本层之前：它直接改音符的八度
  const octaves = findOctaveShifts(pg);
  if (staffOmrOptions.octaveShift) applyOctaveShifts(octaves, notes, pg.normalStaffSpace || pg.space);
  const voltas = findVoltas(pg);
  attachVoltas(pg, voltas);
  // 演奏法记号要在文本层**之前**挑（它们是乐谱字形，与文本无关，但要先占住位置）
  const marks = findNotations(pg);
  attachNotations(pg, notes, marks.marks);
  attachDynamics(pg, notes, marks.dynamics);
  const text = analyzeText(pg);
  const lyricLines = buildLyricLines(pg, text.lyric, opts.textLookup);
  attachLyrics(notes, lyricLines);
  attachHarmonies(pg, notes, text.harmony);
  removeWhite(pg);
  return { page: pg, hasStaff: true, unknown: unknownObjs(pg).length, ctx, beams, notes, text, lyricLines, slurs, octaves, voltas, bars: checkBars(pg, ctx, notes, opts.carryTime), carryTime: lastTimeSignature(pg, ctx, opts.carryTime) };
}

function emptyText(): TextAnalysis {
  return { lyric: [], harmony: [], tempo: [], expression: [], instrument: [], measureNumber: [], boxed: [], textFrame: [] };
}

/** 从 `glyphmap.json` 的内容造查表器。 */
export function makeLookup(dict: StaffGlyphDict): StaffGlyphLookup {
  return new StaffGlyphLookup(dict);
}
