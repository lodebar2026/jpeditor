// `ScoreDoc` → 简谱排版引擎的输入（`layout/input.ts`）。**只此一份投影**，按形状分支：
//
//   `jianpuInputOfXml(song)`        MusicXML 形状（成书重排、ABC 回落）
//   `jianpuInputOfDoc(doc, opts)`   简谱形状：文本谱 / 123 / ABC / `.musicxml` 的简谱档（经排版行视图 `pu/slots.ts::docView`）
//   `jianpuInputOfJpw(doc)`         `.jpwabc`（按原文小节，行内 `$` 换行照原位）
//
// 判据是**谱面**：三个分支各照原先那条路的口径（从 mp/score 移植、多年验过的口径），
// 分歧都写成分支里明写的一条，不悄悄统一——统一观感只动绘制层，不在输入这一层抹平。
// 每个和弦带元素 id：点选、试听高亮、断句量宽都按它认。

import { getMeta } from "./metakeys";
import { Fraction } from "../common/fraction";
import { BARLINE_MARKS, DYNAMICS, TERMS } from "../pu/glyph";
import { GlyphCodes } from "../smufl/smufl";
import { harmonyToText } from "../score/harmonyparse";
import { SECTION_WORD_RE } from "../score/phraseinput";
import { BarStyle, StartStopDiscontinue } from "../score/enums";
import { MusicCommon } from "../score/jppitch";
import { PlayData } from "../score/playorder";
import type {
  JBreak, JChord, JCredit, JDirection, JKey, JLyric, JMeasure, JNote, JScore, JTime,
} from "../layout/input";
import { measureDuration } from "../layout/input";
import { AccidentalCarry, continuesMeasure, degreeFromPitch, quarterTempos } from "./jianpu";
import type {
  Barline, Chord as DocChord, Direction, DirectionPart, ElementId, Harmony, Measure as DocMeasure, MeasureAttrs,
  Mark as DocMark, Note as DocNote, Part as DocPart, Pitch, ScoreDoc, Song,
} from "./doc";
import { playDataOfDoc, tempoOfDoc } from "./playdoc";
import { docView, type SlotRef } from "../pu/slots";
import { distinctVerses, jpAlterOf } from "../pu/phrasesong";
import { playDataOfSong } from "./playsong";
import { linesOfVoice, marksAt, nextSyllables, takesLyric, voiceNumbers } from "../pu/ast";
import type { LyricLine, Mark, NoteElement, PuSong, ScoreLine } from "../pu/ast";
import { decoKey } from "./deconames";
import { xmlAlign, xmlFont } from "./xmlsurface";

// ───────────────────────── 构造 ─────────────────────────

function newMeasure(index: number, key: JKey = { fifths: 0 }, time: JTime = { beats: 4, beatType: 4 }): JMeasure {
  return {
    index, position: new Fraction(0), entries: [], key, time, keyChange: false, timeChange: false,
    leftBarline: null, barline: null, repeatForward: false, repeatBackward: false,
    endingLeft: false, endingNum: null, endingText: null, endingRight: null,
  };
}

function newChord(measure: JMeasure, id: ElementId | null): JChord {
  return {
    kind: "chord", id, measure, position: new Fraction(0), notes: [], dot: 0, beams: 0, beats: 0, rest: false,
    slurStart: false, slurEnds: 0, slurEndChord: null, fermata: false, harmony: null, sectionWord: null,
    directions: [], articulations: [], graceNotes: [],
  };
}

function newNote(chord: JChord): JNote {
  return {
    chord, number: "0", jpOctave: 0, jpAlter: " ", lyrics: [], tieStart: false, tieEnd: false,
    tieNext: null, tiePrev: null, tupletBegin: false, tupletEnd: false, tuplet: null,
  };
}

function lyric(text: string, number: number, refrain = false): JLyric {
  return { text, number, refrain };
}

/** 小节末换行：位置落在**小节末**（引擎按拍位稳定排序，默认的 0 会挤到第一个和弦之后——
 *  001《圣哉，圣哉，圣哉》行尾的「宰！」就这么被甩到下一行）。 */
export function breakAtMeasureEnd(m: JMeasure, newPage: boolean): JBreak {
  const position = m.entries.reduce((p, e) => {
    const end = e.kind === "chord" && e.duration ? e.position.plus(e.duration) : e.position;
    return end.compareTo(p) > 0 ? end : p;
  }, new Fraction(0));
  const br: JBreak = { kind: "break", position, newPage, pass: null };
  m.entries.push(br);
  return br;
}

/** 和弦之后换行（行内断点）。 */
export function breakAfterChord(m: JMeasure, c: JChord, newPage: boolean): JBreak {
  const i = m.entries.indexOf(c);
  const br: JBreak = { kind: "break", position: c.duration ? c.position.plus(c.duration) : c.position, newPage, pass: null };
  m.entries.splice(i < 0 ? m.entries.length : i + 1, 0, br);
  return br;
}

/** 连音首尾两两配对（起、止、起、止…）。 */
function pairTuplets(notes: readonly JNote[]): void {
  for (let i = 0; i + 1 < notes.length; i += 2) {
    const a = notes[i]!;
    const b = notes[i + 1]!;
    if (a.tupletEnd || b.tupletBegin) throw new Error("");
    const t = { first: a, last: b };
    a.tuplet = t;
    b.tuplet = t;
  }
}

/** "1,2" → {1,2} */
function endingNums(s: string): Set<number> {
  const res = new Set<number>();
  for (const it of s.split(",")) {
    const t = it.trim();
    if (t.length) res.add(parseInt(t, 10));
  }
  return res;
}

function chords(m: JMeasure): JChord[] {
  return m.entries.filter((e): e is JChord => e.kind === "chord");
}

// ───────────────────────── MusicXML 形状 ─────────────────────────
//
// 口径（一路照搬，不修）：
//   - 只读第一声部；时值/拍位按**首小节**的 divisions 折算；`<forward>` 不认（游标取 `Chord.onset`）
//   - 倚音一个 `<note>` 一个音，挂到它**后面第一个**非倚音和弦上（可跨小节）
//   - `<harmony>` / `<direction>` 印在它后面那个音符上；落在倚音前时落到**前一个**和弦上
//   - 小节末尾的记号挂到最后一个和弦上、记 `atBarEnd`
//   - 歌词段号只看原文最后一个字符（`chorus` 记副歌）；和弦文字升降号印 `♯♭`
//   - 小节线条目的位置是**没折算**的 divisions（原样照搬）

/** 读谱期带着音高的音（唱名由音高推，和弦取最高音也按它） */
interface XNote extends JNote {
  pitch: number;
  step: string;
  alter: number;
  octave: number;
  rest: boolean;
}

interface XChord extends JChord {
  voice: number;
}

const PITCH_MAP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 语义层记号 → 单字符记号位 */
const JP_ALTER: Readonly<Record<string, string>> = {
  sharp: "#", "double-sharp": "#", flat: "b", "double-flat": "b", natural: "n",
};

/** MusicXML 形状的一首 → 引擎输入。 */
export function jianpuInputOfXml(song: Song): JScore {
  const credit: JCredit[] = [];
  const title = xmlTitleOf(song);
  for (const c of song.credits ?? []) {
    const cw = (c.words ?? c.text.split("\n")).map((s) => s.trim()).filter((s) => s.length > 0).join("\n");
    credit.push({ type: c.type ?? null, text: cw, page: (c.page || 1) - 1 });
  }
  for (const it of credit) if (it.type === null && it.text === title) it.type = "title";
  // 题下经文：MusicXML 里是 `<miscellaneous-field name="scripture">`（或已经是一条 credit，那就不再加）
  if (!credit.some((c) => c.type === "scripture")) {
    for (const t of [...getMeta(song, "scripture"), ...getMeta(song, "scripture-ref")]) {
      if (t.trim()) credit.push({ type: "scripture", text: t.trim(), page: 0 });
    }
  }

  const src = song.parts[0];
  if (!src) throw new Error("no part");
  const measures = loadXmlPart(src, song);
  let carry = new AccidentalCarry();
  for (const m of measures) {
    if (!continuesMeasure(src.measures[m.index - 1], src.measures[m.index]!)) carry = new AccidentalCarry();
    initXmlMeasure(m, carry);
  }
  findRefrain(measures);
  const playData = playDataOfDoc(song);
  playData.tempo = tempoOfDoc(song);
  return { parts: [{ measures }], title, credit, playData };
}

function xmlTitleOf(song: Song): string {
  for (const c of song.credits ?? []) {
    if (c.type?.trim() !== "title") continue;
    const t = (c.words?.[0] ?? c.text.split("\n")[0]!).trim();
    if (t) return t;
  }
  const wt = song.work.title !== song.work.movementTitle ? song.work.title?.trim() : undefined;
  return wt || song.work.movementTitle?.trim() || "";
}

interface NoteMarks {
  slurStart: boolean;
  slurStops: number;
  tupletBegin: boolean;
  tupletEnd: boolean;
}

/** 读谱期的配对池（弧、延音、连音、还没落到主音上的倚音）。 */
interface XmlPool {
  slurChords: JChord[];
  tieNotes: XNote[];
  tupletNotes: XNote[];
  graceNotes: XNote[];
}

const absTick = (nt: JNote): Fraction => nt.chord.position.plus(nt.chord.measure.position);

function loadXmlPart(src: DocPart, song: Song): JMeasure[] {
  const div = src.measures[0]?.attrs?.divisions ?? 1;
  let pos = new Fraction(0);
  const pool: XmlPool = { slurChords: [], tieNotes: [], tupletNotes: [], graceNotes: [] };
  const marksAt = marksByNote(song);
  const out: JMeasure[] = [];
  let prev: JMeasure | null = null;
  src.measures.forEach((dm, mid) => {
    const mea = newMeasure(mid);
    mea.position = pos;
    loadXmlMeasure(mea, dm, prev, div, pool, marksAt);
    out.push(mea);
    pool.tupletNotes.sort((a, b) => absTick(a).compareTo(absTick(b)));
    pairTuplets(pool.tupletNotes);
    pool.tupletNotes = [];
    pos = pos.plus(measureDuration(mea));
    prev = mea;
  });
  // 圆滑线：栈式（后开先闭），嵌套的两条弧各自连对端点
  const stack: JChord[] = [];
  for (const c of pool.slurChords) {
    for (let k = 0; k < c.slurEnds; k++) {
      const s = stack.pop();
      if (s) s.slurEndChord = c;
    }
    if (c.slurStart) stack.push(c);
  }
  // 延音线：起止各按拍位排序后逐个配
  const starts = pool.tieNotes.filter((n) => n.tieStart).sort((a, b) => absTick(a).compareTo(absTick(b)));
  const ends = pool.tieNotes.filter((n) => n.tieEnd).sort((a, b) => absTick(a).compareTo(absTick(b)));
  for (let i = 0; i < starts.length && i < ends.length; i++) {
    starts[i]!.tieNext = ends[i]!;
    ends[i]!.tiePrev = starts[i]!;
  }
  return out;
}

/** 和弦 id → 第几个音 → 这个音上的 slur / tuplet 起止 */
function marksByNote(song: Song): Map<number, Map<number, NoteMarks>> {
  const out = new Map<number, Map<number, NoteMarks>>();
  const at = (id: number, k: number): NoteMarks => {
    let byNote = out.get(id);
    if (!byNote) out.set(id, (byNote = new Map()));
    let m = byNote.get(k);
    if (!m) byNote.set(k, (m = { slurStart: false, slurStops: 0, tupletBegin: false, tupletEnd: false }));
    return m;
  };
  for (const mk of song.marks) {
    if (mk.type === "slur") {
      at(mk.start, mk.startNote ?? 0).slurStart = true;
      at(mk.end, mk.endNote ?? 0).slurStops += 1;
    } else if (mk.type === "tuplet") {
      at(mk.start, mk.startNote ?? 0).tupletBegin = true;
      at(mk.end, mk.endNote ?? 0).tupletEnd = true;
    }
  }
  return out;
}

function loadXmlMeasure(
  m: JMeasure,
  dm: DocMeasure,
  prev: JMeasure | null,
  div: number,
  pool: XmlPool,
  marksAt: Map<number, Map<number, NoteMarks>>,
): void {
  if (prev) {
    m.key = { fifths: prev.key.fifths };
    m.time = { beats: prev.time.beats, beatType: prev.time.beatType };
  }
  if (dm.attrs) xmlAttributes(m, dm.attrs);

  /** 最后一个非倚音和弦的终点（没折算的 divisions） */
  let noteEnd = new Fraction(0);
  let prevEnd = 0;
  let pendingHarmony: string | null = null;
  let pendingDirections: JDirection[] = [];
  const count = dm.elements.length;
  const barlinesAt = (i: number, where: "left" | "middle" | "right"): void => {
    for (const b of dm.barlines ?? []) {
      if (b.location !== where) continue;
      if (where === "middle" && b.afterElements !== i) continue;
      xmlBarline(m, b, noteEnd);
    }
  };
  const directionsAt = (i: number): void => {
    for (const d of dm.directions ?? []) {
      if (d.type === "sound" || Math.min(d.afterElements ?? 0, count) !== i) continue;
      pendingDirections.push(...directionMarks(d));
    }
    for (const la of dm.laterAttrs ?? []) if (Math.min(la.afterElements, count) === i) xmlAttributes(m, la.attrs);
  };
  /** 读完一个 `<note>` 之后：攒着的和弦符号与记号落到最后一个条目上 */
  const flushPending = (): void => {
    const last = m.entries[m.entries.length - 1];
    if (pendingHarmony && last?.kind === "chord" && !last.harmony) {
      last.harmony = pendingHarmony;
      pendingHarmony = null;
    }
    if (pendingDirections.length && last?.kind === "chord") {
      last.directions.push(...pendingDirections);
      pendingDirections = [];
    }
  };

  barlinesAt(0, "left");
  dm.elements.forEach((el, i) => {
    barlinesAt(i, "middle");
    directionsAt(i);
    if (el.kind !== "chord") {
      if (el.harmony) pendingHarmony = xmlHarmonyText(el.harmony) ?? pendingHarmony;
      return;
    }
    for (const h of [el.harmony, ...(el.laterHarmonies ?? [])]) if (h) pendingHarmony = xmlHarmonyText(h) ?? pendingHarmony;
    const onset = el.onset ?? prevEnd;
    prevEnd = onset + el.duration.divisions;
    const notes: (DocNote | null)[] = el.notes.length ? el.notes : [null];
    if (el.grace) {
      notes.forEach((dn, k) => {
        const g = xmlNote(null, el, dn, k, marksAt);
        pool.graceNotes.push(g);
        flushPending();
      });
      return;
    }
    notes.forEach((dn, k) => {
      const newCh = m.entries.length === 0 || k === 0;
      if (newCh) m.entries.push(newChord(m, el.id));
      const last = m.entries[m.entries.length - 1] as XChord;
      if (pool.graceNotes.length && newCh) {
        for (const g of pool.graceNotes) g.chord = last;
        last.graceNotes.push(...pool.graceNotes);
        pool.graceNotes = [];
      }
      const nt = xmlNote(last, el, dn, k, marksAt);
      if (newCh) pool.slurChords.push(last);
      if (nt.tieStart || nt.tieEnd) pool.tieNotes.push(nt);
      if (nt.tupletBegin || nt.tupletEnd) pool.tupletNotes.push(nt);
      last.notes.push(nt);
      if (newCh) {
        xmlDuration(last, el);
        last.position = new Fraction(onset).divInt(div);
        last.duration = new Fraction(el.duration.divisions).divInt(div);
        last.voice = el.voice;
        last.rest = nt.rest;
        noteEnd = new Fraction(onset + el.duration.divisions);
      }
      flushPending();
    });
  });
  directionsAt(count);
  barlinesAt(count, "middle");
  barlinesAt(count, "right");
  // 记号写在小节最后一个音符**之后**：挂到本小节最后一个和弦上、贴着小节线右对齐
  if (pendingDirections.length) {
    const cs = chords(m);
    const last = cs[cs.length - 1];
    if (last) {
      for (const d of pendingDirections) d.atBarEnd = true;
      last.directions.push(...pendingDirections);
    }
  }
}

function xmlHarmonyText(h: Harmony): string | null {
  return h.root.step ? harmonyToText(h, "unicode") : null;
}

function xmlNote(
  chord: JChord | null,
  el: DocChord,
  dn: DocNote | null,
  k: number,
  marksAt: Map<number, Map<number, NoteMarks>>,
): XNote {
  const nt: XNote = { ...newNote(chord as JChord), pitch: 0, step: " ", alter: 0, octave: 0, rest: false };
  const p = dn?.pitch;
  if (p) {
    nt.octave = p.octave;
    nt.step = p.step[0] ?? " ";
    nt.alter = Math.trunc(p.alter);
    nt.pitch = (nt.octave + 1) * 12 + (PITCH_MAP[nt.step] ?? 0) + nt.alter;
  }
  if (el.rest) nt.rest = true;
  if (k === 0) {
    for (const l of el.lyrics ?? []) {
      if (l.text.length === 0) continue;
      const number = l.numberText ?? String(l.number);
      if (number === "chorus") nt.lyrics.push(lyric(l.text, 1, true));
      else nt.lyrics.push(lyric(l.text, number.charCodeAt(number.length - 1) - "0".charCodeAt(0)));
    }
  }
  if (dn?.tie?.start) nt.tieStart = true;
  if (dn?.tie?.stop) nt.tieEnd = true;
  const mk = marksAt.get(el.id)?.get(k);
  if (mk?.tupletBegin) nt.tupletBegin = true;
  if (mk?.tupletEnd) nt.tupletEnd = true;
  if (chord) {
    if (k === 0 && el.notations?.fermata) chord.fermata = true;
    if (k === 0) for (const a of el.notations?.articulations ?? []) if (decoKey(a) === "zy") chord.articulations.push("accent");
    if (mk?.slurStart) chord.slurStart = true;
    if (mk && mk.slurStops > chord.slurEnds) chord.slurEnds = mk.slurStops;
  }
  return nt;
}

function xmlDuration(ch: JChord, el: DocChord): void {
  if (el.duration.dots > 0) ch.dot = 1;
  switch (el.duration.type) {
    case "whole": ch.beats = 4; ch.beams = 0; break;
    case "half": ch.beats = 2; ch.beams = 0; break;
    case "quarter": ch.beats = 1; ch.beams = 0; break;
    case "eighth": ch.beats = 1; ch.beams = 1; break;
    case "16th": ch.beats = 1; ch.beams = 2; break;
    case "32nd": ch.beats = 1; ch.beams = 3; break;
    case "64th": ch.beats = 1; ch.beams = 4; break;
    case undefined:
      if (el.rest) { ch.beats = 4; ch.beams = 0; return; }
      break;
    default: throw new Error("bad note type " + el.duration.type);
  }
  if (ch.dot === 1 && ch.beats > 1) ch.beats = (ch.beats * 3) / 2;
}

function xmlAttributes(m: JMeasure, a: MeasureAttrs): void {
  if (a.key) {
    m.key = { fifths: a.key.fifths };
    m.keyChange = true;
  }
  if (a.time) {
    m.time = { beats: a.time.beats, beatType: a.time.beatType };
    m.timeChange = true;
  }
}

function xmlBarline(m: JMeasure, b: Barline, noteEnd: Fraction): void {
  if (b.style) {
    const style = b.style as BarStyle;
    if (b.location === "left") m.leftBarline = style;
    else m.barline = style;
    m.entries.push({ kind: "bar", position: noteEnd });
  }
  if (b.repeat) {
    if (b.repeat === "backward") m.repeatBackward = true;
    else m.repeatForward = true;
  }
  const ending = b.ending;
  if (ending) {
    if (b.location === "left") {
      const text = ending.text ?? "";
      m.endingText = text || null;
      const digits = text.match(/\d+/g);
      m.endingNum = endingNums(digits ? digits.join(",") : ending.numbers.join(","));
      m.endingLeft = true;
    } else {
      m.endingRight = ending.type as StartStopDiscontinue;
    }
  }
}

/** `<direction>` 的各子元素（首个 + `more`） */
const partsOf = (d: Direction): DirectionPart[] => [d, ...(d.more ?? [])];

/** 表情/跳转记号（`rit.` / `Fine` / `D.S.` / 𝄋 / `mf`）；段落词不算（断句另读）。 */
function directionMarks(d: Direction): JDirection[] {
  const res: JDirection[] = [];
  for (const it of partsOf(d)) {
    if (it.type === "words") {
      const t = (it.text ?? "").trim();
      const bare = t.replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "");
      if (!t || SECTION_WORD_RE.test(t) || SECTION_WORD_RE.test(bare)) continue;
      if (!/[\p{L}\p{N}]/u.test(t)) continue;
      res.push({
        text: t,
        music: false,
        italic: xmlFont(it)?.style === "italic",
        ...(xmlAlign(it).justify === "right" ? { atBarEnd: true } : {}),
      });
    } else if (it.type === "segno" || it.type === "coda") {
      res.push({ text: it.type === "segno" ? GlyphCodes.segno : GlyphCodes.coda, music: true, italic: false });
    } else if (it.type === "dynamics") {
      const g = it.text ? DYNAMICS[it.text] : undefined;
      if (g) res.push({ text: g, music: true, italic: false });
    }
  }
  return res;
}

/** 读完一小节：只留 voice ≤ 1、和弦取最高音（歌词并到它上面），再按调号推唱名与记号（倚音先于主音）。
 *  **经简谱语义层**：唱名与八度点 `degreeFromPitch`、小节内延续的记号 `AccidentalCarry.mark`；双升/双降印成 `#`/`b`。 */
function initXmlMeasure(m: JMeasure, carry: AccidentalCarry): void {
  m.entries = m.entries.filter((e) => e.kind !== "chord" || (e as XChord).voice <= 1);
  for (const ch of chords(m)) {
    if (ch.notes.length <= 1) continue;
    let cur = -1;
    let maxPit = 0;
    const lrc: JLyric[] = [];
    (ch.notes as XNote[]).forEach((nt, i) => {
      if (nt.pitch > maxPit) {
        cur = i;
        maxPit = nt.pitch;
      }
      lrc.push(...nt.lyrics);
    });
    const v = ch.notes[cur]!;
    v.lyrics = lrc;
    ch.notes = [v];
  }
  const init = (nt: XNote): void => {
    const pitch = { step: nt.step as Pitch["step"], alter: nt.alter, octave: nt.octave };
    const key = { fifths: m.key.fifths };
    const d = degreeFromPitch(pitch, key);
    nt.number = nt.rest ? "0" : String(d.number);
    nt.jpAlter = JP_ALTER[carry.mark(pitch, key) ?? ""] ?? " ";
    nt.jpOctave = d.octaveShift;
  };
  for (const ch of chords(m)) {
    for (const g of ch.graceNotes) init(g as XNote);
    if (ch.rest) continue;
    for (const nt of ch.notes) init(nt as XNote);
  }
}

/** 副歌判定：曲尾那一段各位置都只剩一行歌词 → 各段共用（房内的单行歌词只属于该房次，不算）。 */
function findRefrain(measures: readonly JMeasure[]): void {
  const countInf = new Map<string, { pos: Fraction; n: number }>();
  let inEnding = false;
  for (const m of measures) {
    if (m.endingLeft) inEnding = true;
    for (const ent of chords(m)) {
      if (inEnding) continue;
      let cnt = 0;
      for (const n of ent.notes) for (const l of n.lyrics) if (l.text.length > 0) cnt++;
      if (cnt === 0) continue;
      const pos = m.position.plus(ent.position);
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
    const end = m.position.plus(measureDuration(m));
    if (end.compareTo(refrainPos) <= 0) continue;
    for (const ent of chords(m)) {
      if (m.position.plus(ent.position).compareTo(refrainPos) < 0) continue;
      for (const n of ent.notes) for (const l of n.lyrics) l.refrain = true;
    }
  }
}

// ───────────────────────── 简谱形状（经排版行视图） ─────────────────────────
//
// 口径：
//   - 每个有曲行的声部一份 part；小节按行里的小节线切，行与行之间插换行（`[fenye]` 换页）
//   - 调号拍号取头部；曲中转调/转拍号按模型小节的 `attrs` 标出（值变了才算）；和弦符号、力度、段落词、倚音不进
//   - 节奏音符 X/9 当休止；多连音起止之间的音都乘 2/3

export interface JianpuInputOptions {
  /** 取第几首（`-----` 分出的多唱法）。默认第一首。 */
  song?: number;
  /** 给展开档排版用（一遍一行词、只排 `parts[0]` 一条旋律）：
   *  带歌词的声部排到 `parts[0]`；同一条曲行下段号重复的歌词行顺延成下一段（见 `distinctVerses`）。 */
  forExpanded?: boolean;
}

/** 文本谱/123/ABC 的 `ScoreDoc` → 引擎输入。这首没有曲行时返回 null。 */
export function jianpuInputOfDoc(doc: ScoreDoc, options: JianpuInputOptions = {}): JScore | null {
  const view = docView(doc);
  const song = view.songs[options.song ?? 0];
  if (!song) return null;
  const score = songInput(song, (el) => view.idOf.get(el) ?? null, !!options.forExpanded);
  if (!score) return null;
  // 演唱顺序（反复、房号、D.C./D.S.、多段歌词逐段一遍、文档自带的 playOrder）由 ScoreDoc 推，见 `playsong.ts`
  const pd = playDataOfSong(doc, options.song ?? 0, options.forExpanded ? { forExpanded: true } : {});
  if (pd) {
    pd.tempo = score.playData.tempo;
    score.playData = pd;
  }
  return score;
}

/** 一行曲里，某个元素下标是某类记号的起点/终点。**跨行的续接端不是真端点**（弧被换行切成两个 Mark）。 */
function marksEdgeAt(marks: readonly Mark[], index: number, type: Mark["type"]): { starts: boolean; ends: boolean } {
  const hit = marksAt(marks, index, type);
  return {
    starts: hit.some((m) => m.start === index && !m.continuationFromPrevious),
    ends: hit.some((m) => m.end === index && !m.continuationToNext),
  };
}

function songInput(song: PuSong, idOf: (el: NoteElement) => ElementId | null, forExpanded: boolean): JScore | null {
  const meta = song.metadata;
  const credit: JCredit[] = [];
  const pushCredit = (text: string, type: string | null): void => {
    if (text) credit.push({ text, type, page: 0 });
  };
  meta.titles.forEach((t, i) => pushCredit(t, i === 0 ? "title" : "subtitle"));
  for (const t of meta.scripture ?? []) pushCredit(t, "scripture");
  for (const a of meta.authors) pushCredit(a, "composer");
  for (const t of meta.topRight) pushCredit(t, "composer");
  for (const t of meta.topLeft) pushCredit(t, "lyricist");

  const meter = meta.meters[0];
  const time: JTime = meter ? { beats: meter.numerator, beatType: meter.denominator } : { beats: 4, beatType: 4 };
  const key: JKey = { fifths: MusicCommon.keyNameToFifth(meta.mode ?? "C") };
  const playData = new PlayData();
  for (const tempo of meta.tempos) {
    if (typeof tempo === "number" && tempo >= 20 && tempo <= 400) {
      playData.tempo = tempo;
      break;
    }
  }

  let voices = voiceNumbers(song);
  if (forExpanded) {
    const lead = voices.find((v) => linesOfVoice(song, v).some((l) => l.lyrics.length > 0));
    if (lead !== undefined) voices = [lead, ...voices.filter((v) => v !== lead)];
  }
  const parts: { measures: JMeasure[] }[] = [];
  for (const v of voices) {
    const lines = linesOfVoice(song, v);
    if (lines.length === 0) continue;
    parts.push({ measures: rowsPart(lines, time, key, idOf, forExpanded, forExpanded ? pageEnds(song, v) : undefined, !forExpanded) });
  }
  if (parts.length === 0) return null;
  return { parts, title: meta.titles[0] ?? "", credit, playData };
}

/** 源里 `[fenye]` 分出的页边界：每一页里该声部的最后一条曲行（末页不算）。 */
function pageEnds(song: PuSong, voice: number): Set<ScoreLine> {
  const out = new Set<ScoreLine>();
  song.pages.forEach((pg, i) => {
    if (i === song.pages.length - 1) return;
    let last: ScoreLine | null = null;
    for (const g of pg.groups) for (const v of g.voices) if (v.voice === voice) last = v;
    if (last) out.add(last);
  });
  return out;
}

/** 房号原文 → 适用于第几遍（文本里的数字才是遍数）。 */
function applyEndingStart(mea: JMeasure, mark: Mark): void {
  const text = (mark.caption ?? "").trim();
  mea.endingLeft = true;
  mea.endingText = text || null;
  const digits = text.match(/\d+/g);
  mea.endingNum = digits ? endingNums(digits.join(",")) : null;
}

/** 时值：beats × (附点) ÷ 2^减时线。多连音的 2/3 另乘。 */
function nominal(ch: JChord): Fraction {
  let dur = new Fraction(ch.beats);
  if (ch.dot > 0) dur = dur.timesInt(3).divInt(2);
  return dur.divInt(1 << ch.beams);
}

/** 一个声部的所有曲行（跨 system）接成一串小节，行与行之间插换行。 */
function rowsPart(
  lines: readonly ScoreLine[],
  time: JTime,
  key: JKey,
  idOf: (el: NoteElement) => ElementId | null,
  renumberVerses: boolean,
  pageEndSet?: ReadonlySet<ScoreLine>,
  decorate = false,
): JMeasure[] {
  const measures: JMeasure[] = [];
  let measure: JMeasure | null = null;
  const tupletNotes: JNote[] = [];
  /** 开着的弧的起点，后开先收（嵌套弧）；跨行的弧靠它连到下一行的收尾处 */
  const slurOpen: JChord[] = [];
  let newMeasureNeeded = true;
  let lastChord: JChord | null = null;
  let pendingRepeatForward = false;
  let pendingEnding: Mark | null = null;
  // 曲中转调/转拍号：按行里符号的来源小节（`SlotRef.measure`）取模型小节的 `attrs`，与当前的不同才算变
  let curKey = key;
  let curTime = time;
  const seen = new Set<DocMeasure>();
  const open = (src: DocMeasure | undefined): JMeasure => {
    const m = newMeasure(measures.length, curKey, curTime);
    if (src && !seen.has(src)) {
      seen.add(src);
      const k = src.attrs?.key;
      const t = src.attrs?.time;
      if (measures.length > 0 && k && k.fifths !== curKey.fifths) {
        m.key = curKey = { fifths: k.fifths };
        m.keyChange = true;
      }
      if (measures.length > 0 && t && (t.beats !== curTime.beats || t.beatType !== curTime.beatType)) {
        m.time = curTime = { beats: t.beats, beatType: t.beatType };
        m.timeChange = true;
      }
    }
    measure = m;
    measures.push(m);
    return m;
  };

  lines.forEach((line, lineIdx) => {
    const refs = (line as ScoreLine & { refs?: readonly SlotRef[] }).refs;
    const lyrics = renumberVerses ? distinctVerses(line.lyrics) : line.lyrics;
    const cursors = lyrics.map(() => 0);
    const voltas = line.marks.filter((mk) => mk.type === "volta");

    line.elements.forEach((el, index) => {
      for (const mk of voltas) if (mk.start === index && !mk.continuationFromPrevious) pendingEnding = mk;
      const endsVolta = voltas.filter((mk) => mk.end === index && !mk.continuationToNext);
      const closeVolta = (mea: JMeasure | null): void => {
        if (!mea) return;
        for (const mk of endsVolta) mea.endingRight = mk.openEnd ? StartStopDiscontinue.DISCONTINUE : StartStopDiscontinue.STOP;
      };

      if (el.kind === "beat-boundary" || el.kind === "inline-layer") return;

      if (el.kind === "sustain") {
        closeVolta(measure);
        // 增时线并进前一个音符的时值
        if (lastChord) {
          lastChord.beats += 1;
          lastChord.duration = nominal(lastChord);
        }
        if (el.lyricAnchor && lastChord) attachLyrics(lyrics, cursors, lastChord);
        return;
      }

      if (el.kind === "barline") {
        const mea = measure ?? open(refs?.[index]?.measure);
        closeVolta(mea);
        // 反复起点 `|:` 挂到**下一小节**的 repeatForward 上
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
        mea.entries.push({ kind: "bar", position: new Fraction(0) });
        // 小节线上的跳转记号（`&fine` `&dc` `&ds` `&ty` `&hs`）贴着这条小节线、挂在它前面那个音上
        if (decorate && lastChord) {
          for (const orn of el.ornaments) {
            const bm = BARLINE_MARKS[orn.name];
            if (bm?.text) lastChord.directions.push({ text: bm.text, music: false, italic: false, atBarEnd: true });
            else if (bm?.glyph) lastChord.directions.push({ text: bm.glyph, music: true, italic: false, atBarEnd: true });
          }
        }
        newMeasureNeeded = true;
        return;
      }

      // 音符
      const mea: JMeasure = newMeasureNeeded || measure === null ? open(refs?.[index]?.measure) : measure;
      newMeasureNeeded = false;
      if (pendingRepeatForward) {
        mea.repeatForward = true;
        pendingRepeatForward = false;
      }
      if (pendingEnding) {
        applyEndingStart(mea, pendingEnding);
        pendingEnding = null;
      }
      closeVolta(mea);

      const ch = newChord(mea, idOf(el));
      const nt = newNote(ch);
      ch.notes.push(nt);
      nt.number = el.sound === "rhythm" ? "0" : String(el.pitch);
      nt.jpOctave = el.octave;
      nt.jpAlter = jpAlterOf(el);
      ch.beats = 1;
      ch.beams = Math.max(0, Math.round(Math.log2(el.duration / 4)));
      ch.dot = el.dots;
      if (el.hidden || el.sound === "rest" || el.sound === "rhythm" || nt.number === "0") ch.rest = true;

      const tup = marksEdgeAt(line.marks, index, "tuplet");
      if (tup.starts) nt.tupletBegin = true;
      if (tup.ends) nt.tupletEnd = true;
      if (nt.tupletBegin || nt.tupletEnd) tupletNotes.push(nt);

      // **先收后起**：同一个音既收前一条弧又起下一条（123 的 `(3_ | (3:(3_) 3_)`、ABC 的连续 tie）时，
      // 先起的话 `slurOpen` 被这个音顶掉，前一条弧就收到自己身上、整条丢了（secret base 跨小节那条）。
      // 同一个音可以同时收几条弧（外弧与内弧同终点：1921《天上的阿爸盼望你回家》`(3. (4__ (3__) 2-))`），
      // 以前只记一个开着的起点，内弧一起就把外弧的起点顶掉，外弧整条不画。
      const slurHits = marksAt(line.marks, index, "slur");
      const slurEnds = slurHits.filter((m) => m.end === index && !m.continuationToNext).length;
      for (let k = 0; k < slurEnds; k++) {
        ch.slurEnds++;
        const from = slurOpen.pop();
        if (from) from.slurEndChord = ch;
      }
      if (slurHits.some((m) => m.start === index && !m.continuationFromPrevious)) {
        ch.slurStart = true;
        slurOpen.push(ch);
      }
      for (const orn of el.ornaments) if (orn.name === "yc" || orn.name === "ycy") ch.fermata = true;
      if (decorate) decorateChord(ch, el);

      ch.duration = nominal(ch);
      mea.entries.push(ch);
      lastChord = ch;
      if (takesLyric(el)) attachLyrics(lyrics, cursors, ch);
    });

    // 行末换行（末行不加）。`[fenye]` 落在这一行末尾时写成换页
    if (lineIdx < lines.length - 1 && measure) breakAtMeasureEnd(measure, pageEndSet?.has(line) ?? false);
  });

  pairTuplets(tupletNotes);
  layoutTimes(measures, true);
  return measures;
}

/**
 * 原样档（`decorate`）才要的那几样：和弦、段落词、重音、力度/术语、倚音。展开档不画它们（投影片只要旋律与词）。
 * 只收引擎画得出的：奏法记号引擎只有重音（`entry.ts::addNotations`），其余 `&xx` 暂不出现。
 */
function decorateChord(ch: JChord, el: NoteElement): void {
  if (el.chord) ch.harmony = el.chord;
  if (el.annotation) ch.sectionWord = el.annotation;
  for (const orn of el.ornaments) {
    if (orn.name === "zy") ch.articulations.push("accent");
    else if (DYNAMICS[orn.name]) ch.directions.push({ text: DYNAMICS[orn.name]!, music: true, italic: false });
    else if (TERMS[orn.name]) ch.directions.push({ text: TERMS[orn.name]!, music: false, italic: true });
  }
  ch.graceNotes = el.graceBefore.map((g) => ({ number: String(g.pitch), jpOctave: g.octave, jpAlter: jpAlterOf(g), duration: g.duration }));
}

/** 按时值排出各条目的拍位与小节起点。`scaleInner`：多连音起止之间的音也乘 2/3（`.jpwabc` 旧口径只乘首尾两个）。 */
function layoutTimes(measures: readonly JMeasure[], scaleInner: boolean): void {
  let inTuplet = false;
  for (const m of measures) {
    let pos = new Fraction(0);
    for (const ent of m.entries) {
      ent.position = pos;
      if (ent.kind !== "chord") continue;
      let dur = nominal(ent);
      const nt = ent.notes[0];
      if (nt?.tuplet && nt.tupletBegin) inTuplet = true;
      if ((scaleInner && inTuplet) || nt?.tuplet) dur = dur.timesInt(2).divInt(3);
      if (nt?.tuplet && nt.tupletEnd) inTuplet = false;
      ent.duration = dur;
      pos = pos.plus(dur);
    }
  }
  let acc = new Fraction(0);
  for (const m of measures) {
    m.position = acc;
    for (const ent of m.entries) if (ent.kind === "chord") acc = acc.plus(ent.duration!);
  }
}

function attachLyrics(lyrics: readonly LyricLine[], cursors: number[], ch: JChord): void {
  for (const { verse, text } of nextSyllables(lyrics, cursors)) ch.notes[0]!.lyrics.push(lyric(text, verse));
}


// ───────────────────────── `.jpwabc` ─────────────────────────
//
// 直接按模型小节建（`model/fromjpw.ts::jpwToScoreDoc` 已按原文小节切好）。口径：
//   - 小节线一律不带样式（谱面画细线，曲末由 `final` 补粗）；反复、房号不画——展开档按演唱顺序逐遍铺开
//   - 换行照原文位置：小节之间的记在下一小节的 `print` 上，小节中间的记在前一个和弦的 `lineBreakAfter` 上
//   - 倚音挂到它后面那个音符上；没有和弦符号、力度、段落词
//   - 曲首 `|:|` 连写不开空小节（`jpwToScoreDoc` 并进下一小节左线）
//   - 连音起止之间的音也乘 2/3（只乘首尾两个的话中间的音拍位偏后，符杠分组跟着错）

const DEGREE_ALTER: Readonly<Record<string, string>> = { sharp: "#", flat: "b", natural: "n" };
/** 倚音的符号时值 → `JGrace.duration`（减时线条数由它定；四分及未记的按八分画一条） */
const GRACE_DURATION: Readonly<Record<string, number>> = { eighth: 8, "16th": 16, "32nd": 32 };

/** `.jpwabc` 的 `ScoreDoc` → 引擎输入。没有声部时返回 null。 */
export function jianpuInputOfJpw(doc: ScoreDoc): JScore | null {
  const song = doc.songs[0];
  const part = song?.parts[0];
  if (!song || !part) return null;
  const credit: JCredit[] = (song.credits ?? []).map((c) => ({ type: null, text: c.text, page: 0 }));
  let key: JKey = { fifths: song.key?.fifths ?? 0 };
  let time: JTime = { beats: song.time?.beats ?? 4, beatType: song.time?.beatType ?? 4 };

  const byId = new Map<ElementId, JChord>();
  const slurEnds: { from: JChord; to: ElementId }[] = [];
  const marksFrom = new Map<ElementId, DocMark[]>();
  const marksTo = new Map<ElementId, DocMark[]>();
  const push = (map: Map<ElementId, DocMark[]>, id: ElementId, mk: DocMark): void => {
    const list = map.get(id);
    if (list) list.push(mk);
    else map.set(id, [mk]);
  };
  for (const mk of song.marks) {
    if (mk.type !== "slur" && mk.type !== "tuplet") continue;
    push(marksFrom, mk.start, mk);
    push(marksTo, mk.end, mk);
  }
  /** 带小节中间换行的和弦 */
  const inlineBreak = new Set<ElementId>();
  const tupletNotes: JNote[] = [];
  const measures: JMeasure[] = [];
  let graces: JChord["graceNotes"] = [];

  part.measures.forEach((dm, i) => {
    if (dm.attrs?.key && i > 0) key = { fifths: dm.attrs.key.fifths };
    if (dm.attrs?.time && i > 0) time = { beats: dm.attrs.time.beats, beatType: dm.attrs.time.beatType };
    const m = newMeasure(i, key, time);
    m.keyChange = i > 0 && !!dm.attrs?.key;
    m.timeChange = i > 0 && !!dm.attrs?.time;
    const prev = measures[i - 1];
    // 小节之间的换行落在上一小节末（小节线之后）；上一小节里已有小节中间换行时，那就是同一处 `$`
    const brk = dm.print?.newPage ? "page" : dm.print?.newSystem ? "system" : null;
    if (prev && brk && !chords(prev).some((c) => c.id !== null && inlineBreak.has(c.id))) breakAtMeasureEnd(prev, brk === "page");
    measures.push(m);

    for (const el of dm.elements) {
      if (el.kind !== "chord") continue;
      const n0 = el.notes[0];
      if (el.grace) {
        const d = n0?.degree;
        const dur = GRACE_DURATION[el.duration.type ?? ""];
        graces.push({ number: String(d?.number ?? 1), jpOctave: d?.octaveShift ?? 0, jpAlter: DEGREE_ALTER[d?.accidental ?? ""] ?? " ",
          ...(dur ? { duration: dur } : {}) });
        continue;
      }
      const ch = newChord(m, el.id);
      byId.set(el.id, ch);
      const nt = newNote(ch);
      ch.notes.push(nt);
      const d = n0?.degree;
      ch.rest = !d || !!el.rest;
      nt.number = d && !el.rest ? String(d.number) : "0";
      nt.jpOctave = d?.octaveShift ?? 0;
      nt.jpAlter = DEGREE_ALTER[d?.accidental ?? ""] ?? " ";
      ch.beams = el.beams?.length ?? 0;
      ch.beats = (el.sustains?.length ?? 0) + 1;
      ch.dot = el.duration.dots;
      ch.fermata = !!el.notations?.fermata;
      for (const l of el.lyrics ?? []) nt.lyrics.push(lyric(l.text, l.number));
      ch.graceNotes = graces;
      graces = [];
      for (const mk of marksTo.get(el.id) ?? []) {
        if (mk.type === "slur") ch.slurEnds++;
        else nt.tupletEnd = true;
      }
      for (const mk of marksFrom.get(el.id) ?? []) {
        if (mk.type === "slur") {
          ch.slurStart = true;
          slurEnds.push({ from: ch, to: mk.end });
        } else {
          nt.tupletBegin = true;
        }
      }
      if (nt.tupletBegin) tupletNotes.push(nt);
      if (nt.tupletEnd) tupletNotes.push(nt);
      m.entries.push(ch);
      if (el.lineBreakAfter) {
        inlineBreak.add(el.id);
        breakAfterChord(m, ch, el.lineBreakAfter === "page");
      }
    }
    if ((dm.barlines ?? []).some((b) => b.location === "right")) m.entries.push({ kind: "bar", position: new Fraction(0) });
  });
  const last = measures[measures.length - 1];
  if (last && part.endBreak) breakAtMeasureEnd(last, part.endBreak === "page");
  for (const { from, to } of slurEnds) from.slurEndChord = byId.get(to) ?? null;
  pairTuplets(tupletNotes);
  layoutTimes(measures, true);

  const playData = playDataOfSong(doc, 0) ?? new PlayData();
  const tempo = quarterTempos(song)[0];
  playData.tempo = typeof tempo === "number" ? tempo : 0;
  return { parts: [{ measures }], title: song.work.title ?? "", credit, playData };
}
