// `ScoreDoc`（MusicXML 形状）→ 断句输入（`score/phraseinput.ts`）；试听旋律档与演唱顺序也用这一份。
//
// **口径逐条同简谱引擎输入 `model/jianpuinput.ts::jianpuInputOfXml`**（断点写回引擎输入要按 id 对上，`phrase-dual-check` 对拍）：
//   - 只留 voice ≤ 1 的非倚音和弦；和弦内取最高音（`jianpu.ts::topNote`，同样是先到者胜）
//   - 位置/时值按**首小节**的 divisions 折算
//   - `beats`/`beams`/`dot` 按 `<type>` 与附点；唱名、八度点取语义层 `assignDegrees` 的度数
//   - 小节线、反复、房号、调号变更同引擎输入；另读段落标记（段首硬换行）
//   - 副歌判定同 `findRefrain`
// 断点集合以这里拼出的对象为键，`idOf` 把它们换回元素 id。

import { Fraction } from "../common/fraction";
import type { BarStyle, StartStopDiscontinue } from "../score/enums";
import { SECTION_WORD_RE, type PhraseChord, type PhraseMeasure } from "../score/phraseinput";
import type { PlayMeasure } from "../score/playorder";
import type { TimelineMeasure } from "../score/timeline";
import type { Chord, ElementId, Measure, Song } from "./doc";
import { midiPitch, topNote } from "./jianpu";

interface LyricOut { text: string; number: number; refrain: boolean }
/** `pitch`：MIDI 音高（试听用；休止与无音高为 0） */
interface NoteOut { number: string; jpOctave: number; pitch: number; tieStart: boolean; tieEnd: boolean; lyrics: LyricOut[] }
interface ChordOut {
  notes: NoteOut[];
  rest: boolean;
  beats: number;
  beams: number;
  dot: number;
  duration: Fraction;
  position: Fraction;
  fermata: boolean;
  slurStart: boolean;
  slurEnds: number;
  /** 元素 id（试听高亮用） */
  id: ElementId;
}
interface MeasureOut {
  entries: ChordOut[];
  barline: BarStyle | null;
  repeatBackward: boolean;
  repeatForward: boolean;
  keyChange: boolean;
  endingLeft: boolean;
  /** 房号适用的遍数（演唱顺序用，`score/playorder.ts::PlayMeasure`） */
  endingNum: Set<number> | null;
  endingRight: StartStopDiscontinue | null;
  sectionMark: string | null;
  /** 拍号（前面小节的延续；小节里没有和弦时试听按它算小节长，同引擎输入的 `JMeasure.time`） */
  time: { beats: number; beatType: number };
  /** 小节起点（findRefrain 用） */
  position: Fraction;
  /** 末和弦的终点。没有和弦时抛错（同 `layout/input.ts::measureDuration`） */
  readonly duration: Fraction;
}

export interface PhraseDocView {
  /** 同时满足演唱顺序的输入（`score/playorder.ts::PlayPart`） */
  part: { readonly measures: readonly (PhraseMeasure & PlayMeasure & TimelineMeasure)[] };
  /** 断句输入的和弦 → 元素 id */
  idOf: Map<PhraseChord, ElementId>;
}

const TYPE_BEATS: Readonly<Record<string, [number, number]>> = {
  whole: [4, 0], half: [2, 0], quarter: [1, 0], eighth: [1, 1], "16th": [1, 2], "32nd": [1, 3], "64th": [1, 4],
};

/** 断句输入。`partIndex` 缺省取第一声部（与引擎输入只读 `parts[0]` 一致）。 */
export function phrasePartOfDoc(song: Song, partIndex = 0): PhraseDocView {
  const part = song.parts[partIndex];
  const idOf = new Map<PhraseChord, ElementId>();
  if (!part) return { part: { measures: [] }, idOf };
  const div = part.measures[0]?.attrs?.divisions ?? 1;
  const slurStarts = new Set<ElementId>();
  const slurEnds = new Map<ElementId, number>();
  for (const mk of song.marks) {
    if (mk.type !== "slur") continue;
    slurStarts.add(mk.start);
    slurEnds.set(mk.end, (slurEnds.get(mk.end) ?? 0) + 1);
  }

  const measures: MeasureOut[] = [];
  let at = new Fraction(0);
  let time = { beats: 4, beatType: 4 };
  for (const m of part.measures) {
    if (m.attrs?.time) time = { beats: m.attrs.time.beats, beatType: m.attrs.time.beatType };
    const out = measureOf(m, at, div, slurStarts, slurEnds, idOf, time);
    measures.push(out);
    at = at.plus(measureEnd(m, div));
  }
  findRefrain(measures);
  return { part: { measures }, idOf };
}

/** 跳转记号（Fine / D.C. / D.S. / To Coda）所在的小节下标（0 基）。**只取记号本身**，
 *  `segno` / `coda` 是跳转的目标、不算（口径同引擎输入的 `playData.jumpTo`）。 */
export function phraseJumpMeasures(song: Song, partIndex = 0): Set<number> {
  const out = new Set<number>();
  song.parts[partIndex]?.measures.forEach((m, i) => {
    for (const d of m.directions ?? []) {
      const s = d.sound;
      if (s && (s.dacapo || s.dalsegno || s.fine || s.tocoda)) out.add(i);
    }
  });
  return out;
}

/** 各声部各自累计的起拍（divisions）。倚音不占时值。 */
function onsets(m: Measure): Map<Chord, number> {
  const pos = new Map<number, number>();
  const out = new Map<Chord, number>();
  for (const el of m.elements) {
    if (el.kind !== "chord") continue;
    const p = pos.get(el.voice) ?? 0;
    out.set(el, p);
    if (!el.grace) pos.set(el.voice, p + el.duration.divisions);
  }
  return out;
}

/** 小节时值 = 文档序最后一个（任意声部的）和弦的终点——`loadPart` 在 `removeUnused` 之前取 `Measure.duration`。 */
function measureEnd(m: Measure, div: number): Fraction {
  const at = onsets(m);
  for (let i = m.elements.length - 1; i >= 0; i--) {
    const el = m.elements[i]!;
    if (el.kind !== "chord" || el.grace) continue;
    return new Fraction(at.get(el)! + el.duration.divisions).divInt(div);
  }
  return new Fraction(0);
}

function measureOf(
  m: Measure, position: Fraction, div: number,
  slurStarts: ReadonlySet<ElementId>, slurEnds: ReadonlyMap<ElementId, number>,
  idOf: Map<PhraseChord, ElementId>,
  time: { beats: number; beatType: number },
): MeasureOut {
  const out: MeasureOut = {
    entries: [],
    barline: null,
    repeatBackward: false,
    repeatForward: false,
    keyChange: m.attrs?.key !== undefined,
    endingLeft: false,
    endingNum: null,
    endingRight: null,
    sectionMark: null,
    time,
    position,
    get duration(): Fraction {
      const last = this.entries[this.entries.length - 1];
      if (!last) throw new Error("measure has no chord");
      return last.position.plus(last.duration);
    },
  };
  for (const b of m.barlines ?? []) {
    if (b.style !== undefined && b.location !== "left") out.barline = b.style as BarStyle;
    if (b.repeat === "backward") out.repeatBackward = true;
    else if (b.repeat === "forward") out.repeatForward = true;
    if (b.ending) {
      if (b.location === "left") {
        // 同 `parseBarline`：房号文本里的数字才是遍数，文本没有数字才用 `number` 属性
        out.endingLeft = true;
        const digits = b.ending.text?.match(/\d+/g);
        out.endingNum = new Set(digits ? digits.map((d) => parseInt(d, 10)) : b.ending.numbers);
      } else out.endingRight = b.ending.type as StartStopDiscontinue;
    }
  }
  for (const d of m.directions ?? []) {
    const t = (d.text ?? "").trim();
    if (!t) continue;
    if (d.type === "rehearsal" || (d.type === "words" && SECTION_WORD_RE.test(t))) out.sectionMark = t;
  }

  const at = onsets(m);
  for (const el of m.elements) {
    if (el.kind !== "chord" || el.grace || el.voice > 1) continue;
    const ch = chordOf(el, at.get(el)!, div, slurStarts, slurEnds);
    out.entries.push(ch);
    idOf.set(ch, el.id);
  }
  return out;
}

function chordOf(
  el: Chord, onset: number, div: number,
  slurStarts: ReadonlySet<ElementId>, slurEnds: ReadonlyMap<ElementId, number>,
): ChordOut {
  const rest = el.rest !== undefined;
  const dot = el.duration.dots > 0 ? 1 : 0;
  let beats = 0;
  let beams = 0;
  const type = el.duration.type;
  if (type === undefined) {
    if (rest) beats = 4;
  } else {
    const bb = TYPE_BEATS[type];
    if (!bb) throw new Error("bad note type " + type);
    [beats, beams] = bb;
    if (dot === 1 && beats > 1) beats = (beats * 3) / 2;
  }
  const top = rest ? undefined : topNote(el);
  const lyrics: LyricOut[] = (el.lyrics ?? [])
    .filter((l) => l.text.length > 0)
    .map((l) => ({ text: l.text, number: l.number, refrain: l.refrain ?? false }));
  const note: NoteOut = {
    number: top?.degree ? String(top.degree.number) : "0",
    jpOctave: top?.degree?.octaveShift ?? 0,
    pitch: top?.pitch ? midiPitch(top.pitch) : 0,
    tieStart: top?.tie?.start ?? false,
    tieEnd: top?.tie?.stop ?? false,
    lyrics,
  };
  return {
    notes: [note],
    rest,
    beats,
    beams,
    dot,
    duration: new Fraction(el.duration.divisions).divInt(div),
    position: new Fraction(onset).divInt(div),
    fermata: el.notations?.fermata ?? false,
    slurStart: slurStarts.has(el.id),
    slurEnds: slurEnds.get(el.id) ?? 0,
    id: el.id,
  };
}

/** 同 `musicxml.ts::findRefrain`：尾部只剩一行歌词的那一段（房内除外）记成副歌。 */
function findRefrain(measures: readonly MeasureOut[]): void {
  const countInf = new Map<string, { pos: Fraction; n: number }>();
  let inEnding = false;
  for (const m of measures) {
    if (m.endingLeft) inEnding = true;
    for (const ch of m.entries) {
      if (inEnding) continue;
      let cnt = 0;
      for (const n of ch.notes) for (const l of n.lyrics) if (l.text.length > 0) cnt++;
      if (cnt === 0) continue;
      const pos = m.position.plus(ch.position);
      const key = pos.toString();
      const prev = countInf.get(key);
      countInf.set(key, { pos, n: (prev?.n ?? 0) + cnt });
    }
    if (m.endingRight !== null) inEnding = false;
  }
  const entries = [...countInf.values()].sort((a, b) => a.pos.compareTo(b.pos));
  let refrainPos: Fraction | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.n === 1) refrainPos = entries[i]!.pos;
    else if (entries[i]!.n > 1) break;
  }
  if (!refrainPos) return;
  for (const m of measures) {
    const last = m.entries[m.entries.length - 1];
    if (!last) continue;
    const end = m.position.plus(last.position.plus(last.duration));
    if (end.compareTo(refrainPos) <= 0) continue;
    for (const ch of m.entries) {
      const pos = m.position.plus(ch.position);
      if (pos.compareTo(refrainPos) < 0) continue;
      for (const n of ch.notes) for (const l of n.lyrics) l.refrain = true;
    }
  }
}
