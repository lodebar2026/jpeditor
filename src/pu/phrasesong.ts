// 简谱形状的 `ScoreDoc`（文本谱 / 123 / ABC）→ 断句输入（`score/phraseinput.ts`），`docs/待办.md` §3.1 阶段 5。
//
// 与 `model/phrasedoc.ts`（MusicXML 形状）分工同 `pu/slots.ts::docView` 与 `jianpuproject.ts`：
// 这里经排版行视图 `docView` 读，和原样档谱面、`scoreDocToScore` 是同一批对象。
// **口径逐条照 `toscore.ts::buildPart`**（`forExpanded` 那一份：带歌词的声部当主旋律、同号歌词顺延），
// 本轮只换输入、不动判据，靠 `scripts/phrase-dual-check.mjs --jianpu` 双跑逐项一致。
// 断点集合以这里拼出的对象为键，`idOf` 把它们换回元素 id。

import { Fraction } from "../common/fraction";
import type { ElementId, ScoreDoc } from "../model/doc";
import { BarStyle, StartStopDiscontinue } from "../score/enums";
import type { PhraseChord, PhraseMeasure, PhrasePart } from "../score/phraseinput";
import { linesOfVoice, marksAt, nextSyllables, takesLyric, voiceNumbers } from "./ast";
import type { LyricLine, Mark, NoteElement, ScoreLine } from "./ast";
import { docView } from "./slots";
import { distinctVerses } from "./toscore";

interface LyricOut { text: string; number: number; refrain: boolean }
interface NoteOut { number: string; jpOctave: number; tieStart: boolean; tieEnd: boolean; lyrics: LyricOut[] }
interface ChordOut {
  notes: NoteOut[];
  rest: boolean;
  beats: number;
  beams: number;
  dot: number;
  duration?: Fraction;
  position: Fraction;
  fermata: boolean;
  slurStart: boolean;
  slurEnds: number;
  /** 多连音配对（`doPairTuplet`）用 */
  tupletBegin: boolean;
  tupletEnd: boolean;
  tuplet: boolean;
}
interface MeasureOut {
  entries: ChordOut[];
  barline: BarStyle | null;
  repeatBackward: boolean;
  repeatForward: boolean;
  keyChange: boolean;
  endingLeft: boolean;
  endingRight: StartStopDiscontinue | null;
  sectionMark: string | null;
}

export interface PhraseSongView {
  part: PhrasePart;
  /** 断句输入的和弦 → 元素 id */
  idOf: Map<PhraseChord, ElementId>;
}

/** 断句输入（主旋律那一个声部）。这首没有曲行时返回 null（同 `scoreDocToScore`）。 */
export function phrasePartOfSong(doc: ScoreDoc, songIdx = 0): PhraseSongView | null {
  const view = docView(doc);
  const song = view.songs[songIdx];
  if (!song) return null;
  let voices = voiceNumbers(song);
  const lead = voices.find((v) => linesOfVoice(song, v).some((l) => l.lyrics.length > 0));
  if (lead !== undefined) voices = [lead, ...voices.filter((v) => v !== lead)];
  for (const v of voices) {
    const lines = linesOfVoice(song, v);
    if (lines.length === 0) continue;
    const idOf = new Map<PhraseChord, ElementId>();
    const measures = buildMeasures(lines, (ch, el) => {
      const id = view.idOf.get(el);
      if (id !== undefined) idOf.set(ch, id);
    });
    return { part: { measures: measures as readonly PhraseMeasure[] }, idOf };
  }
  return null;
}

/** 同 `toscore.ts::marksEdgeAt`：跨行的续接端不是真端点。 */
function edgeAt(marks: readonly Mark[], index: number, type: Mark["type"]): { starts: boolean; ends: boolean } {
  const hit = marksAt(marks, index, type);
  return {
    starts: hit.some((m) => m.start === index && !m.continuationFromPrevious),
    ends: hit.some((m) => m.end === index && !m.continuationToNext),
  };
}

function chordDuration(ch: ChordOut): Fraction {
  let dur = new Fraction(ch.beats);
  if (ch.dot > 0) dur = dur.timesInt(3).divInt(2);
  return dur.divInt(1 << ch.beams);
}

function buildMeasures(lines: readonly ScoreLine[], onChord: (ch: ChordOut, el: NoteElement) => void): MeasureOut[] {
  const measures: MeasureOut[] = [];
  let measure: MeasureOut | null = null;
  let newMeasureNeeded = true;
  let lastChord: ChordOut | null = null;
  let pendingRepeatForward = false;
  let pendingEnding = false;
  const tupletNotes: ChordOut[] = [];
  const open = (): MeasureOut => {
    measure = {
      entries: [], barline: null, repeatBackward: false, repeatForward: false, keyChange: false,
      endingLeft: false, endingRight: null, sectionMark: null,
    };
    measures.push(measure);
    return measure;
  };

  for (const line of lines) {
    const lyrics: readonly LyricLine[] = distinctVerses(line.lyrics);
    const cursors = lyrics.map(() => 0);
    const voltas = line.marks.filter((mk) => mk.type === "volta");
    line.elements.forEach((el, index) => {
      for (const mk of voltas) if (mk.start === index && !mk.continuationFromPrevious) pendingEnding = true;
      const endsVolta = voltas.filter((mk) => mk.end === index && !mk.continuationToNext);
      const closeVolta = (mea: MeasureOut | null): void => {
        if (!mea) return;
        for (const mk of endsVolta) mea.endingRight = mk.openEnd ? StartStopDiscontinue.DISCONTINUE : StartStopDiscontinue.STOP;
      };
      const attach = (ch: ChordOut): void => {
        for (const { verse, text } of nextSyllables(lyrics, cursors)) ch.notes[0]!.lyrics.push({ text, number: verse, refrain: false });
      };

      if (el.kind === "beat-boundary" || el.kind === "inline-layer") return;
      if (el.kind === "sustain") {
        closeVolta(measure);
        if (lastChord) {
          lastChord.beats += 1;
          lastChord.duration = chordDuration(lastChord);
        }
        if (el.lyricAnchor && lastChord) attach(lastChord);
        return;
      }
      if (el.kind === "barline") {
        const mea: MeasureOut = measure ?? open();
        closeVolta(mea);
        switch (el.type) {
          case "normal": mea.barline = BarStyle.REGULAR; break;
          case "double": mea.barline = BarStyle.LIGHT_LIGHT; break;
          case "end": mea.barline = BarStyle.LIGHT_HEAVY; break;
          case "repeat-start": pendingRepeatForward = true; break;
          case "repeat-end":
            mea.repeatBackward = true;
            mea.barline = BarStyle.LIGHT_HEAVY;
            break;
          case "repeat-both":
            mea.repeatBackward = true;
            mea.barline = BarStyle.LIGHT_HEAVY;
            pendingRepeatForward = true;
            break;
          default: mea.barline = BarStyle.NONE;
        }
        newMeasureNeeded = true;
        return;
      }

      const mea: MeasureOut = newMeasureNeeded || measure === null ? open() : measure;
      newMeasureNeeded = false;
      if (pendingRepeatForward) {
        mea.repeatForward = true;
        pendingRepeatForward = false;
      }
      if (pendingEnding) {
        mea.endingLeft = true;
        pendingEnding = false;
      }
      closeVolta(mea);

      const number = el.sound === "rhythm" ? "0" : String(el.pitch);
      const ch: ChordOut = {
        notes: [{ number, jpOctave: el.octave, tieStart: false, tieEnd: false, lyrics: [] }],
        rest: el.hidden || el.sound === "rest" || el.sound === "rhythm" || number === "0",
        beats: 1,
        beams: Math.max(0, Math.round(Math.log2(el.duration / 4))),
        dot: el.dots,
        position: new Fraction(0),
        fermata: el.ornaments.some((o) => o.name === "yc" || o.name === "ycy"),
        slurStart: false,
        slurEnds: 0,
        tupletBegin: false,
        tupletEnd: false,
        tuplet: false,
      };
      const tup = edgeAt(line.marks, index, "tuplet");
      if (tup.starts) ch.tupletBegin = true;
      if (tup.ends) ch.tupletEnd = true;
      if (ch.tupletBegin || ch.tupletEnd) tupletNotes.push(ch);
      const slur = edgeAt(line.marks, index, "slur");
      if (slur.starts) ch.slurStart = true;
      if (slur.ends) ch.slurEnds++;
      ch.duration = chordDuration(ch);
      mea.entries.push(ch);
      onChord(ch, el);
      lastChord = ch;
      if (takesLyric(el)) attach(ch);
    });
  }

  // doPairTuplet + applyTupletDurations
  for (let i = 0; i < Math.floor(tupletNotes.length / 2); i++) {
    tupletNotes[2 * i]!.tuplet = true;
    tupletNotes[2 * i + 1]!.tuplet = true;
  }
  let inTuplet = false;
  for (const m of measures) {
    let pos = new Fraction(0);
    for (const ch of m.entries) {
      let dur = chordDuration(ch);
      if (ch.tuplet && ch.tupletBegin) inTuplet = true;
      if (inTuplet || ch.tuplet) dur = dur.timesInt(2).divInt(3);
      if (ch.tuplet && ch.tupletEnd) inTuplet = false;
      ch.duration = dur;
      ch.position = pos;
      pos = pos.plus(dur);
    }
  }
  return measures;
}
