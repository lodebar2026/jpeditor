// `ScoreDoc` 的遍历、查询、构造与音高互推。
//
// **音高换算一律复用 `score/jppitch.ts`**——那个文件的开头就立了规矩：
// 「两份实现一旦漂移，导出→导入的往返数字就会错，故只留这一处」。本文件不另写一份正向换算。
// 反向换算（绝对音高 → 简谱度数）目前在 `score.ts::Note.init` 里，与本文件的
// `degreeFromPitch` 同构——见那个函数的注释。
//
// 无 DOM 依赖（Node CLI 要 import）。

import { jpPitch, jpTonicOctaveShift, tonicStep } from "../score/jppitch";
import type {
  Accidental,
  Chord,
  Degree,
  Element,
  ElementId,
  Key,
  Lyric,
  Measure,
  Note,
  Part,
  Pitch,
  ScoreDoc,
  Song,
  SourceSpan,
} from "./doc";

// ───────────────────────── id 分配 ─────────────────────────

/** 元素 id 分配器。**全文档唯一、不随数组增删变化**——`Mark`、歌词锚点、`playOrder`
 *  都引用 id，用数组下标的话插一个元素就全错（`PuDoc` 就是那样）。 */
export class IdGen {
  private _next = 1;
  next(): ElementId {
    return this._next++;
  }
  /** 已分配到哪（序列化/合并文档时要接着往下发） */
  get watermark(): number {
    return this._next;
  }
  /** 合并两份文档时把分配器推到安全位置 */
  bump(to: number): void {
    if (to >= this._next) this._next = to + 1;
  }
}

// ───────────────────────── 音高互推 ─────────────────────────

/** 简谱度数 → 绝对音高。**直接转调 `jppitch.ts::jpPitch`**，不重写。
 *  `accidental` 是面上的临时记号，叠在调号算出的 `alter` 之上。 */
export function pitchFromDegree(degree: Degree, key: Key): Pitch | null {
  if (degree.number === 0) return null; // 休止
  const p = jpPitch(degree.number, degree.octaveShift, key.fifths);
  let alter = p.alter;
  switch (degree.accidental) {
    case "sharp": alter = 1; break;
    case "flat": alter = -1; break;
    case "natural": alter = 0; break;
    case "double-sharp": alter = 2; break;
    case "double-flat": alter = -2; break;
    default: break;
  }
  return { step: p.step as Pitch["step"], alter, octave: p.octave };
}

/** 绝对音高 → 简谱度数。
 *
 *  **与 `score.ts::Note.init` 同构**（算式逐行照搬：`b=(4f+28)%7`、
 *  `jpOctave=floor((wr-b)/7)-4`，再加 `jpTonicOctaveShift`）。那一份绑在 `Score` 的
 *  `Note` 类上、还夹着 `AccidentalStat` 状态机，没法直接复用。
 *  **R2 收尾时应把 `Note.init` 改为调用本函数，消掉这一份重复**——在此之前两处必须同源。
 *
 *  临时记号不在这里判（那要小节内的延续状态），由调用方给 `accidental`。 */
export function degreeFromPitch(pitch: Pitch, key: Key, accidental?: Accidental): Degree {
  const steps = "CDEFGAB";
  const idx = steps.indexOf(pitch.step);
  const wr = idx + pitch.octave * 7;
  const b = tonicStep(key.fifths);
  const p = idx + pitch.octave * 7 - b;
  const number = (((p % 7) + 7) % 7) + 1;
  let octaveShift = Math.floor((wr - b) / 7) - 4;
  octaveShift += jpTonicOctaveShift(key.fifths);
  const d: Degree = { number, octaveShift };
  if (accidental) d.accidental = accidental;
  return d;
}

// ───────────────────────── 遍历 ─────────────────────────

export function* eachPart(song: Song): Generator<Part> {
  for (const p of song.parts) yield p;
}

export function* eachMeasure(song: Song): Generator<{ part: Part; measure: Measure; index: number }> {
  for (const part of song.parts) {
    for (let i = 0; i < part.measures.length; i++) {
      yield { part, measure: part.measures[i]!, index: i };
    }
  }
}

export function* eachElement(song: Song): Generator<{ part: Part; measure: Measure; element: Element }> {
  for (const { part, measure } of eachMeasure(song)) {
    for (const element of measure.elements) yield { part, measure, element };
  }
}

/** 只过和弦（含休止），跳过占位符。 */
export function* eachChord(song: Song): Generator<{ part: Part; measure: Measure; chord: Chord }> {
  for (const { part, measure, element } of eachElement(song)) {
    if (element.kind === "chord") yield { part, measure, chord: element };
  }
}

/** 逐音符。休止没有 `notes`，自然跳过。 */
export function* eachNote(song: Song): Generator<{ part: Part; measure: Measure; chord: Chord; note: Note }> {
  for (const { part, measure, chord } of eachChord(song)) {
    for (const note of chord.notes) yield { part, measure, chord, note };
  }
}

// ───────────────────────── 查询 ─────────────────────────

/** 按 id 找元素。线性扫——文档规模下够用，需要时再加索引。 */
export function findElement(song: Song, id: ElementId): Element | null {
  for (const { element } of eachElement(song)) {
    if (element.id === id) return element;
  }
  return null;
}

/** 建 id → 元素的索引。批量查（`Mark` 配对、转换器）时用，别反复调 `findElement`。 */
export function elementIndex(song: Song): Map<ElementId, { part: Part; measure: Measure; element: Element }> {
  const m = new Map<ElementId, { part: Part; measure: Measure; element: Element }>();
  for (const hit of eachElement(song)) m.set(hit.element.id, hit);
  // 增时线也有 id，且和弦可以挂在它上面（规范 §8.1），所以一并收进来
  for (const { part, measure, chord } of eachChord(song)) {
    for (const s of chord.sustains ?? []) {
      m.set(s.id, { part, measure, element: chord });
    }
  }
  return m;
}

/** 这首歌有几段歌词。取所有 `Lyric.number` 与 `numberTo` 的最大值。 */
export function verseCount(song: Song): number {
  let max = 0;
  for (const { chord } of eachChord(song)) {
    for (const l of chord.lyrics ?? []) {
      max = Math.max(max, l.numberTo ?? l.number);
    }
  }
  return max;
}

/** 取某一段的歌词。副歌（`refrain`）对所有段都算命中——与 `Score.Note.getLyric` 同口径。 */
export function lyricOfVerse(lyrics: readonly Lyric[] | undefined, verse: number): Lyric | null {
  for (const l of lyrics ?? []) {
    if (l.refrain) return l;
    const from = l.number;
    const to = l.numberTo ?? l.number;
    if (verse >= from && verse <= to) return l;
  }
  return null;
}

/** 小节的总时值（divisions）。取各 voice 的最大值——和弦音与多声部不能累加。 */
export function measureDuration(measure: Measure): number {
  const perVoice = new Map<number, number>();
  for (const el of measure.elements) {
    const d = el.kind === "chord" ? el.duration.divisions : (el.duration?.divisions ?? 0);
    perVoice.set(el.voice, (perVoice.get(el.voice) ?? 0) + d);
  }
  let max = 0;
  for (const v of perVoice.values()) max = Math.max(max, v);
  return max;
}

// ───────────────────────── 构造 ─────────────────────────

export const ZERO_SPAN: SourceSpan = { line: 0, column: 0, offset: 0, length: 0 };

export function emptySong(): Song {
  return { work: { subtitles: [] }, parts: [], marks: [] };
}

export function emptyDoc(sourceFormat: ScoreDoc["sourceFormat"]): ScoreDoc {
  return { sourceFormat, songs: [], diagnostics: [] };
}

/** 第一首。多曲文件里绝大多数调用方只关心它（对应 `pu/ast.ts::primaryMetadata` 的用法）。 */
export function primarySong(doc: ScoreDoc): Song | null {
  return doc.songs[0] ?? null;
}
