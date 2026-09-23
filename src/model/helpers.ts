// `ScoreDoc` 的遍历、查询与构造。
//
// 音高 ↔ 度数、临时记号延续这些**简谱语义**在 `jianpu.ts`（简谱语义层），不在这里。
//
// 无 DOM 依赖（Node CLI 要 import）。

import type {
  Chord,
  Element,
  ElementId,
  Lyric,
  Measure,
  Note,
  Part,
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

/** 取某一段的歌词。副歌（`refrain`）对所有段都算命中——与引擎取歌词（`layout/entry.ts::addLyric`）同口径。 */
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

// ───────────────────────── 换行口径 ─────────────────────────

/** 换行种类。 */
export type BreakKind = "system" | "page";

/** 源码里「这一小节**之后**换行」→ 模型口径「下一小节**起**新系统」（见 `doc.ts::Print`）。
 *
 *  解析时按源码顺序只知道「之后」（`$` 写在小节线后面，下一小节还没建出来），
 *  所以各解析器先把换行记进 `after`，整个声部建完后调这里一次性翻过去。
 *  同一小节既有换行又有换页时换页为准。 */
export function breaksAfterToStart(part: Part, after: ReadonlyMap<Measure, BreakKind>): void {
  const ms = part.measures;
  for (let i = 0; i < ms.length; i++) {
    const kind = after.get(ms[i]!);
    if (!kind) continue;
    const next = ms[i + 1];
    if (!next) {
      if (part.endBreak !== "page") part.endBreak = kind;
      continue;
    }
    const p = { ...(next.print ?? {}) };
    if (kind === "page") {
      p.newPage = true;
      delete p.newSystem;
    } else if (!p.newPage) {
      p.newSystem = true;
    }
    next.print = p;
  }
}

/** `breaksAfterToStart` 的反向：第 `i` 小节**之后**要不要换行（写出端用）。 */
export function breakAfter(part: Part, i: number): BreakKind | null {
  const next = part.measures[i + 1];
  if (!next) return part.endBreak ?? null;
  if (next.print?.newPage) return "page";
  if (next.print?.newSystem) return "system";
  return null;
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

/** 派生五线谱时 `<note>` 上的源 id 前缀（`toxml.ts::ToXmlOptions.sourceIds` 写、`fromxml.ts` 认）。 */
export const SOURCE_ID_PREFIX = "jp";
