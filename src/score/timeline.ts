// Shared "score model -> timed note events" flattening, honoring the expanded
// play order (repeats / voltas / D.C. / D.S. / Coda) computed by
// Score.parseRepeatInf() into playData.measures (PlayItem[]). Consumed by both
// the MIDI export (scoreToMidi) and the in-editor player (ScorePlayer), so the
// two stay in lockstep. Times are in quarter-note units.

import { Chord, Score } from "./score";

export const TEMPO = 90; // BPM, shared by MIDI export and playback

/** Mixing options shared by MIDI export and playback. */
export interface PlayOptions {
  /** Per-part linear volume in [0,1]; index = part index. Missing/undefined = 1. */
  partVolumes?: number[];
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
  chord: Chord;
}

export interface Anchor {
  t0: number;
  chord: Chord;
  pass: number; // repeat pass / lyric verse (matches NoteEntry.verse in layout)
}

export interface Timeline {
  notes: TimedNote[];
  anchors: Anchor[]; // melody (part 0) sounding chords, ascending by t0 — for cursor
  duration: number; // total length in quarter notes
}

/** Measure length in quarter notes, max across parts, with a time-signature fallback. */
function measureLen(score: Score, mid: number): number {
  let len = 0;
  for (const part of score.parts) {
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

/** Expanded play order as [mid, end) measure ranges with a start offset + pass. */
function playRanges(score: Score): { mid: number; end: number; offset: number; pass: number }[] {
  const items = score.playData.measures;
  if (items.length > 0) {
    return items.map((p) => ({ mid: p.mid, end: p.end, offset: p.offset.toFloat(), pass: p.pass }));
  }
  // No expansion computed: linear single pass over all measures.
  const n = score.parts[0]?.measures.length ?? 0;
  return n > 0 ? [{ mid: 0, end: n, offset: 0, pass: 1 }] : [];
}

export function buildTimeline(score: Score): Timeline {
  const notes: TimedNote[] = [];
  const anchors: Anchor[] = [];
  let pos = 0; // running timeline position in quarter notes

  for (const range of playRanges(score)) {
    for (let mid = range.mid; mid < range.end; mid++) {
      const startOffset = mid === range.mid ? range.offset : 0;
      for (let pi = 0; pi < score.parts.length; pi++) {
        const m = score.parts[pi].measures[mid];
        if (!m) continue;
        for (const ent of m.entries) {
          if (!(ent instanceof Chord)) continue;
          const cp = ent.position.toFloat();
          if (cp < startOffset) continue; // clipped by a mid-measure jump entry
          const t0 = pos + (cp - startOffset);
          const t1 = t0 + (ent.duration?.toFloat() ?? 0);
          if (pi === 0 && !ent.rest) anchors.push({ t0, chord: ent, pass: range.pass });
          if (ent.rest) continue;
          for (const nt of ent.notes) {
            notes.push({ t0, t1, pitch: nt.pitch, part: pi, chord: ent });
          }
        }
      }
      pos += measureLen(score, mid) - startOffset;
    }
  }

  anchors.sort((a, b) => a.t0 - b.t0);
  return { notes, anchors, duration: pos };
}
