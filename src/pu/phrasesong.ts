// 简谱形状的 `ScoreDoc`（文本谱 / 123 / ABC）→ 断句输入（`score/phraseinput.ts`）；试听输入与演唱顺序也用这份小节序列。
//
// 与 `model/phrasedoc.ts`（MusicXML 形状）分工同 `pu/slots.ts::docView` 与 `jianpuproject.ts`：
// 这里经排版行视图 `docView` 读，和原样档谱面、简谱引擎输入（`jianpuInputOfDoc`）是同一批对象。
// **口径逐条同 `jianpuinput.ts::rowsPart`**（`forExpanded` 那一份：带歌词的声部当主旋律、同号歌词顺延），
// 本轮只换输入、不动判据，靠 `scripts/phrase-dual-check.mjs --jianpu` 双跑逐项一致。
// 断点集合以这里拼出的对象为键，`idOf` 把它们换回元素 id。

import { Fraction } from "../common/fraction";
import type { ElementId, ScoreDoc } from "../model/doc";
import { BarStyle, StartStopDiscontinue } from "../score/enums";
import { applyJpPitch, type JpKeyState } from "../score/jppitch";
import type { PhraseChord, PhraseMeasure, PhrasePart } from "../score/phraseinput";
import { linesOfVoice, marksAt, nextSyllables, takesLyric, voiceNumbers } from "./ast";
import type { LyricLine, Mark, NoteElement, ScoreLine } from "./ast";
import { docView } from "./slots";

interface LyricOut { text: string; number: number; refrain: boolean }
/** `pitch`：MIDI 音高，只在 `buildMeasures` 给了调号状态时算（试听用，经 `applyJpPitch`） */
interface NoteOut {
  number: string; jpOctave: number; pitch: number; jpAlter: string; tieStart: boolean; tieEnd: boolean; lyrics: LyricOut[];
  /** 试听用：括住相邻两个同音的弧当延音线，后一个不再起音（`TimelineNote.tieStop`） */
  tieStop?: boolean;
}
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
  /** 元素 id（试听高亮用；`buildMeasures` 的回调里由调用方填） */
  id?: ElementId;
}
export interface MeasureOut {
  entries: ChordOut[];
  barline: BarStyle | null;
  repeatBackward: boolean;
  repeatForward: boolean;
  keyChange: boolean;
  endingLeft: boolean;
  /** 房号适用的遍数（演唱顺序用，同 `jianpuinput.ts::applyEndingStart`） */
  endingNum: Set<number> | null;
  endingRight: StartStopDiscontinue | null;
  sectionMark: string | null;
  /** 和弦、小节线、行末换行按原次序（`.jpwabc` 写出端要，同 `jianpuinput.ts::rowsPart` 往小节条目里放的次序） */
  seq: (ChordOut | "barline" | "break")[];
  /** 拍号（小节里没有和弦时试听按它算小节长，同引擎输入的 `JMeasure.time`） */
  time: { beats: number; beatType: number };
  /** 末和弦的终点。没有和弦时抛错（同 `layout/input.ts::measureDuration`） */
  readonly duration: Fraction;
}

/** 跳转记号（`&dc` / `&ds` / `&fine` / `&ty` / `&hs`）挂在哪一小节。 */
export interface JumpOut {
  name: string;
  measure: number;
  onBarline: boolean;
}

const JUMP_NAMES = new Set(["dc", "ds", "fine", "ty", "hs"]);

export interface PhraseSongView {
  part: PhrasePart;
  /** 断句输入的和弦 → 元素 id */
  idOf: Map<PhraseChord, ElementId>;
}

/** 断句输入（主旋律那一个声部）。这首没有曲行时返回 null（同 `jianpuInputOfDoc`）。 */
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
    const { measures } = buildMeasures(lines, (ch, el) => {
      const id = view.idOf.get(el);
      if (id !== undefined) idOf.set(ch, id);
    });
    return { part: { measures: measures as readonly PhraseMeasure[] }, idOf };
  }
  return null;
}

/**
 * 同一条曲行下**段号重复**的歌词行，依次顺延到下一个空闲段号（展开档用，见 `ToScoreOptions.forExpanded`）。
 * 《同一首歌》同一段曲下写了两行 `C1:`，内容其实是第 1、2 段：展开档一遍只挂一行词，
 * 两行同号就会画在同一位置相压，顺延之后各成一遍。段号不重复的行原样返回。
 */
export function distinctVerses(lyrics: readonly LyricLine[]): readonly LyricLine[] {
  let maxUsed = 0;
  const used = new Set<number>();
  return lyrics.map((l) => {
    let shift = 0;
    for (let v = l.verseFrom; v <= l.verseTo; v++) {
      if (used.has(v)) shift = Math.max(shift, maxUsed + 1 - l.verseFrom);
    }
    const from = l.verseFrom + shift;
    const to = l.verseTo + shift;
    for (let v = from; v <= to; v++) used.add(v);
    maxUsed = Math.max(maxUsed, to);
    return shift === 0 ? l : { ...l, verseFrom: from, verseTo: to };
  });
}

/** 临时记号 → `applyJpPitch` 的 `jpAlter`（`jianpuinput.ts` 同用这一份）。 */
export function jpAlterOf(el: NoteElement): string {
  switch (el.accidental) {
    case "sharp":
    case "double-sharp":
      return "#";
    case "flat":
    case "double-flat":
      return "b";
    case "natural":
      return "n";
    default:
      return " ";
  }
}

/** 同 `jianpuinput.ts::marksEdgeAt`：跨行的续接端不是真端点。 */
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

/** 一个声部的曲行 → 小节序列。`renumberVerses` 同 `jianpuinput.ts::rowsPart`（展开档那一份才顺延同号歌词）。 */
export function buildMeasures(
  lines: readonly ScoreLine[],
  onChord: (ch: ChordOut, el: NoteElement) => void,
  renumberVerses = true,
  pitch?: { key: JpKeyState; time: { beats: number; beatType: number } },
): { measures: MeasureOut[]; jumps: JumpOut[] } {
  const measures: MeasureOut[] = [];
  const jumps: JumpOut[] = [];
  let measure: MeasureOut | null = null;
  let newMeasureNeeded = true;
  let lastChord: ChordOut | null = null;
  /** `lastChord` 上起头的弧（同行的按下标认，跨行的看 `continuationToNext`） */
  let lastSlurOpens: readonly Mark[] = [];
  let lastChordAt: { line: ScoreLine; index: number } | null = null;
  let pendingRepeatForward = false;
  let pendingEnding: Mark | null = null;
  const tupletNotes: ChordOut[] = [];
  const open = (): MeasureOut => {
    const m: MeasureOut = {
      entries: [], barline: null, repeatBackward: false, repeatForward: false, keyChange: false,
      endingLeft: false, endingNum: null, endingRight: null, sectionMark: null,
      seq: [],
      time: pitch?.time ?? { beats: 4, beatType: 4 },
      get duration(): Fraction {
        const last = this.entries[this.entries.length - 1];
        if (!last?.duration) throw new Error("measure has no chord");
        return last.position.plus(last.duration);
      },
    };
    measure = m;
    measures.push(m);
    return m;
  };

  for (const line of lines) {
    const lyrics: readonly LyricLine[] = renumberVerses ? distinctVerses(line.lyrics) : line.lyrics;
    const cursors = lyrics.map(() => 0);
    const voltas = line.marks.filter((mk) => mk.type === "volta");
    line.elements.forEach((el, index) => {
      for (const mk of voltas) if (mk.start === index && !mk.continuationFromPrevious) pendingEnding = mk;
      const endsVolta = voltas.filter((mk) => mk.end === index && !mk.continuationToNext);
      const closeVolta = (mea: MeasureOut | null): void => {
        if (!mea) return;
        for (const mk of endsVolta) mea.endingRight = mk.openEnd ? StartStopDiscontinue.DISCONTINUE : StartStopDiscontinue.STOP;
      };
      const noteJumps = (mea: MeasureOut, onBarline: boolean): void => {
        if (!("ornaments" in el)) return;
        for (const orn of el.ornaments) {
          if (JUMP_NAMES.has(orn.name)) jumps.push({ name: orn.name, measure: measures.indexOf(mea), onBarline });
        }
      };
      const attach = (ch: ChordOut): void => {
        for (const { verse, text } of nextSyllables(lyrics, cursors)) ch.notes[0]!.lyrics.push({ text, number: verse, refrain: false });
      };

      if (el.kind === "beat-boundary" || el.kind === "inline-layer") return;
      if (el.kind === "sustain") {
        closeVolta(measure);
        if (measure) noteJumps(measure, false);
        if (lastChord) {
          lastChord.beats += 1;
          lastChord.duration = chordDuration(lastChord);
        }
        if (el.lyricAnchor && lastChord) attach(lastChord);
        return;
      }
      if (el.kind === "barline") {
        const mea: MeasureOut = measure ?? open();
        mea.seq.push("barline");
        closeVolta(mea);
        noteJumps(mea, true);
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
        if (pitch) pitch.key.alter = {}; // 临时记号到小节线为止
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
        const digits = (pendingEnding.caption ?? "").trim().match(/\d+/g);
        mea.endingNum = digits ? new Set(digits.map((d) => parseInt(d, 10))) : null;
        pendingEnding = null;
      }
      closeVolta(mea);
      noteJumps(mea, false);

      const number = el.sound === "rhythm" ? "0" : String(el.pitch);
      const ch: ChordOut = {
        notes: [{ number, jpOctave: el.octave, pitch: 0, jpAlter: jpAlterOf(el), tieStart: false, tieEnd: false, lyrics: [] }],
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
      if (pitch) {
        const nt = { number, jpOctave: el.octave, jpAlter: jpAlterOf(el), pitch: 0, step: " ", rest: false, chord: { rest: false } };
        applyJpPitch(pitch.key, nt);
        ch.notes[0]!.pitch = nt.pitch;
      }
      const tup = edgeAt(line.marks, index, "tuplet");
      if (tup.starts) ch.tupletBegin = true;
      if (tup.ends) ch.tupletEnd = true;
      if (ch.tupletBegin || ch.tupletEnd) tupletNotes.push(ch);
      const slur = edgeAt(line.marks, index, "slur");
      if (slur.starts) ch.slurStart = true;
      if (slur.ends) ch.slurEnds++;
      // 相邻两个同音被一条弧括住 = 延音线（简谱里两者同形）：试听只延长、不再起音
      if (pitch && !ch.rest && lastChord && !lastChord.rest && lastChord.notes[0]!.pitch === ch.notes[0]!.pitch) {
        const prevAt = lastChordAt;
        const tied = marksAt(line.marks, index, "slur").some((m) => {
          if (m.end !== index || m.continuationToNext) return false;
          if (m.continuationFromPrevious) return prevAt?.line !== line && lastSlurOpens.some((o) => o.continuationToNext);
          return prevAt?.line === line && m.start === prevAt.index;
        });
        if (tied) ch.notes[0]!.tieStop = true;
      }
      ch.duration = chordDuration(ch);
      mea.entries.push(ch);
      mea.seq.push(ch);
      onChord(ch, el);
      lastChord = ch;
      lastChordAt = { line, index };
      lastSlurOpens = line.marks.filter((m) => m.type === "slur" && m.start === index && !m.continuationFromPrevious);
      if (takesLyric(el)) attach(ch);
    });
    // 行末换行（末行不加），同 `jianpuinput.ts::breakAtMeasureEnd`
    const cur = measure as MeasureOut | null;
    if (line !== lines[lines.length - 1] && cur) cur.seq.push("break");
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
  return { measures, jumps };
}
