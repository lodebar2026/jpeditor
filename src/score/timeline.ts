// Shared "score model -> timed note events" flattening, honoring the expanded
// play order (repeats / voltas / D.C. / D.S. / Coda) in playData.measures (PlayItem[]).
// Consumed by both the MIDI export (toMidi) and the in-editor player (ScorePlayer),
// so the two stay in lockstep. Times are in quarter-note units.
//
// 输入形状：只经下面这组接口读谱，由 `pu/playsong.ts::playSourceOfSong`（简谱形状）
// 与 `model/playdoc.ts::playSourceOfDoc`（MusicXML 形状）从 `ScoreDoc` 拼。

import type { Fraction } from "../common/fraction";
import type { ElementId } from "../model/doc";
import type { PlayData } from "./playorder";

export const TEMPO = 90; // BPM fallback when the score carries no ♩= marking

/** 力度缺省（没有力度记号时的 note-on velocity）。 */
export const DEFAULT_VELOCITY = 100;

/** 速度倍率的可选档位（试听工具条 + MIDI 导出共用）。 */
export const SPEED_STEPS = [0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2] as const;

/** Mixing options shared by MIDI export and playback. */
export interface PlayOptions {
  /** Per-part linear volume in [0,1]; index = part index. Missing/undefined = 1. */
  partVolumes?: number[];
  /** 播放速度倍率（1 = 谱面标注速度）。夹在 [0.25, 3]。 */
  speed?: number;
}

// ───────────────────────── 输入形状 ─────────────────────────

export interface TimelineNote {
  /** MIDI 音高 */
  readonly pitch: number;
}

export interface TimelineChord {
  readonly notes: readonly TimelineNote[];
  readonly rest: boolean;
  /** 小节内位置（四分音符为 1） */
  readonly position: Fraction;
  readonly duration?: Fraction;
  /** 模型里的元素 id（高亮、起播点按它认） */
  readonly id?: ElementId;
  /** note-on 力度 1..127，缺省 `DEFAULT_VELOCITY` */
  readonly velocity?: number;
  /** false = 不当光标锚点（同一声部里的副 voice）。缺省 true */
  readonly cursor?: boolean;
}

export interface TimelineMeasure {
  /** 和弦与其它条目混排；只取 `isTimelineChord` 为真的那些。 */
  readonly entries: readonly object[];
  /** 小节时值（末和弦的位置 + 时值）。**没有和弦时抛错**，与 `layout/input.ts::measureDuration` 同口径。 */
  readonly duration: Fraction;
  /** 没有和弦时按拍号算小节长 */
  readonly time: { readonly beats: number; readonly beatType: number };
}

export interface TimelinePart {
  readonly measures: readonly TimelineMeasure[];
}

/** 一份可播的谱：各声部 + 演唱顺序（含速度）。 */
export interface PlaySource {
  readonly parts: readonly TimelinePart[];
  readonly playData: PlayData;
}

export function isTimelineChord(e: object): e is TimelineChord {
  return "notes" in e && "rest" in e && "position" in e;
}

// ───────────────────────── 产物 ─────────────────────────

/** 实际播放速度 = 谱面 ♩=（无则 90）× 用户倍率。 */
export function playTempo(src: PlaySource, opts?: PlayOptions): number {
  const base = src.playData.tempo > 0 ? src.playData.tempo : TEMPO;
  const mul = opts?.speed;
  const k = mul === undefined || Number.isNaN(mul) ? 1 : Math.max(0.25, Math.min(3, mul));
  return base * k;
}

/** Per-part linear gain in [0,1], defaulting to 1 (full) when unset. */
export function partGain(opts: PlayOptions | undefined, part: number): number {
  const v = opts?.partVolumes?.[part];
  if (v === undefined || Number.isNaN(v)) return 1;
  return Math.max(0, Math.min(1, v));
}

export interface TimedNote {
  t0: number; // quarter-note units
  t1: number;
  pitch: number;
  part: number;
  velocity: number;
  chord: TimelineChord;
}

export interface Anchor {
  t0: number;
  chord: TimelineChord;
  pass: number; // repeat pass / lyric verse (matches NoteEntry.verse in layout)
}

export interface Timeline {
  notes: TimedNote[];
  anchors: Anchor[]; // melody (part 0) sounding chords, ascending by t0 — for cursor
  duration: number; // total length in quarter notes
}

/** Measure length in quarter notes, max across parts, with a time-signature fallback. */
function measureLen(src: PlaySource, mid: number): number {
  let len = 0;
  for (const part of src.parts) {
    const m = part.measures[mid];
    if (!m) continue;
    try {
      len = Math.max(len, m.duration.toFloat());
    } catch {
      // no chord in this measure: fall back to the time signature
      len = Math.max(len, (m.time.beats * 4) / m.time.beatType);
    }
  }
  return len;
}

/** Expanded play order as [mid, end) measure ranges with a start offset + pass.
 *  `until` clips the last measure (PlayItem.limit：只唱到该小节第 n 个音符为止)。 */
function playRanges(
  src: PlaySource,
): { mid: number; end: number; offset: number; pass: number; until: number }[] {
  const items = src.playData.measures;
  if (items.length > 0) {
    return items.map((p) => ({
      mid: p.mid,
      end: p.end,
      offset: p.offset.toFloat(),
      pass: p.pass,
      until: p.limit >= 0 ? chordEnd(src, p.end - 1, p.limit) : Number.POSITIVE_INFINITY,
    }));
  }
  // No expansion computed: linear single pass over all measures.
  const n = src.parts[0]?.measures.length ?? 0;
  return n > 0 ? [{ mid: 0, end: n, offset: 0, pass: 1, until: Number.POSITIVE_INFINITY }] : [];
}

/** 第 `limit` 个和弦唱完时的小节内位置（四分音符为单位）。 */
function chordEnd(src: PlaySource, mid: number, limit: number): number {
  const m = src.parts[0]?.measures[mid];
  if (!m) return Number.POSITIVE_INFINITY;
  let n = 0;
  for (const ent of m.entries) {
    if (!isTimelineChord(ent)) continue;
    n++;
    if (n === limit) return ent.position.toFloat() + (ent.duration?.toFloat() ?? 0);
  }
  return Number.POSITIVE_INFINITY;
}

export function buildTimeline(src: PlaySource): Timeline {
  const notes: TimedNote[] = [];
  const anchors: Anchor[] = [];
  let pos = 0; // running timeline position in quarter notes

  for (const range of playRanges(src)) {
    for (let mid = range.mid; mid < range.end; mid++) {
      const startOffset = mid === range.mid ? range.offset : 0;
      const endOffset = mid === range.end - 1 ? range.until : Number.POSITIVE_INFINITY;
      for (let pi = 0; pi < src.parts.length; pi++) {
        const m = src.parts[pi]!.measures[mid];
        if (!m) continue;
        for (const ent of m.entries) {
          if (!isTimelineChord(ent)) continue;
          const cp = ent.position.toFloat();
          if (cp < startOffset) continue; // clipped by a mid-measure jump entry
          if (cp >= endOffset) continue; // clipped by PlayItem.limit
          const t0 = pos + (cp - startOffset);
          const t1 = t0 + (ent.duration?.toFloat() ?? 0);
          if (pi === 0 && !ent.rest && ent.cursor !== false) anchors.push({ t0, chord: ent, pass: range.pass });
          if (ent.rest) continue;
          const velocity = ent.velocity ?? DEFAULT_VELOCITY;
          for (const nt of ent.notes) {
            notes.push({ t0, t1, pitch: nt.pitch, part: pi, velocity, chord: ent });
          }
        }
      }
      pos += Math.min(measureLen(src, mid), endOffset) - startOffset;
    }
  }

  anchors.sort((a, b) => a.t0 - b.t0);
  return { notes, anchors, duration: pos };
}
