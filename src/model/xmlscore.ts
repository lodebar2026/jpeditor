// `ScoreDoc`（MusicXML 形状）→ 简谱引擎的输入树 `Score`。**口径逐条照原 `score/musicxml.ts::loadMusicXml`**
// （R2 阶段 9：成书重排与 ABC 回落不再另读一遍 DOM。删 `loadMusicXml` 前两路整棵树深度序列化双跑，500 首 568 份逐项一致；
//  其余语料的差异是旧读法游标本身错——`<backup>` 从上一个和弦的起点往回退、`<forward>` 不认，首声部带多声部的谱拍位随之错）。
//
// 那条路的口径（都照搬，不修）：
//   - 只读第一声部；时值/拍位按**首小节**的 divisions 折算；`<forward>` 不认（游标取 `Chord.onset`，语料里 0 例有 `<forward>`）
//   - 倚音一个 `<note>` 一个 `Note`，挂到它**后面第一个**非倚音和弦上（可跨小节）
//   - `<harmony>` / `<direction>` 印在它后面那个音符上；落在倚音前时落到**前一个**和弦上（DOM 那条路读倚音不建和弦）
//   - 小节末尾的记号挂到最后一个和弦上、记 `atBarEnd`
//   - 歌词段号只看原文最后一个字符（`chorus` 记副歌）；和弦文字升降号印 `♯♭`
//   - 小节线条目的位置是**没折算**的 divisions（原样照搬）
//   - 演唱顺序与速度由 `playdoc.ts` 从同一份模型推（阶段 4 起成书就是这么用的）

import { Fraction } from "../common/fraction";
import { DYNAMICS } from "../pu/glyph";
import { GlyphCodes } from "../smufl/smufl";
import { harmonyToText } from "../score/harmonyparse";
import { SECTION_WORD_RE } from "../score/phraseinput";
import {
  BarlineEntry,
  Chord,
  Credit,
  Lyric,
  Measure,
  Note,
  Part,
  Score,
  type BarStyle,
  type ChordDirection,
  doPairTuplet,
  type StartStopDiscontinue,
} from "../score/score";
import { AccidentalCarry, degreeFromPitch } from "./jianpu";
import type { Barline, Chord as DocChord, Direction, DirectionPart, Harmony, Measure as DocMeasure, Note as DocNote, Pitch, Song } from "./doc";
import { playDataOfDoc, tempoOfDoc } from "./playdoc";

const PITCH_MAP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 语义层记号 → `Note.jpAlter` 的单字符 */
const JP_ALTER: Readonly<Record<string, string>> = {
  sharp: "#", "double-sharp": "#", flat: "b", "double-flat": "b", natural: "n",
};

/** MusicXML 形状的一首 → 引擎输入。 */
export function scoreOfXmlSong(song: Song): Score {
  const score = new Score();
  score.title = titleOf(song);
  for (const c of song.identification?.creators ?? []) score.creator.set(c.type, c.text);
  for (const c of song.credits ?? []) {
    const cred = new Credit();
    if (c.type) cred.type = c.type;
    const cw = (c.words ?? c.text.split("\n")).map((s) => s.trim()).filter((s) => s.length > 0).join("\n");
    if (cw) cred.text = cw;
    cred.page = (c.page || 1) - 1;
    score.credit.push(cred);
  }
  for (const it of score.credit) {
    if (it.type === null && it.text === score.title) it.type = "title";
  }

  const part = new Part();
  const src = song.parts[0];
  if (!src) throw new Error("no part");
  loadPart(part, src, song);
  score.parts.push(part);
  for (const m of part.measures) initMeasure(m);
  findRefrain(score);
  score.playData = playDataOfDoc(song);
  score.playData.tempo = tempoOfDoc(song);
  return score;
}

function titleOf(song: Song): string {
  for (const c of song.credits ?? []) {
    if (c.type?.trim() !== "title") continue;
    const t = (c.words?.[0] ?? c.text.split("\n")[0]!).trim();
    if (t) return t;
  }
  const wt = song.work.title !== song.work.movementTitle ? song.work.title?.trim() : undefined;
  return wt || song.work.movementTitle?.trim() || "";
}

function loadPart(part: Part, src: import("./doc").Part, song: Song): void {
  const div = src.measures[0]?.attrs?.divisions ?? 1;
  let pos = new Fraction(0);
  const tmp = new ParserTemp();
  // 标记：每个和弦上的 slur 起止、tuplet 起止落在第几个音
  const marksAt = marksByNote(song);
  let prev: Measure | null = null;
  src.measures.forEach((dm, mid) => {
    const mea = new Measure(mid);
    mea.position = pos;
    loadMeasure(mea, dm, prev, div, tmp, marksAt);
    part.measures.push(mea);
    tmp.pairTuplet();
    pos = pos.plus(mea.duration);
    prev = mea;
  });
  tmp.pairSlur();
  tmp.pairTie();
}

interface NoteMarks {
  slurStart: boolean;
  slurStops: number;
  tupletBegin: boolean;
  tupletEnd: boolean;
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

function loadMeasure(
  m: Measure,
  dm: DocMeasure,
  prev: Measure | null,
  div: number,
  tmp: ParserTemp,
  marksAt: Map<number, Map<number, NoteMarks>>,
): void {
  if (prev) {
    m.key.fifths = prev.key.fifths;
    m.time.beats = prev.time.beats;
    m.time.beatType = prev.time.beatType;
  }
  if (dm.print?.newSystem) m.newSystem = true;
  if (dm.print?.newPage) {
    m.newSystem = true;
    m.newPage = true;
  }
  if (dm.attrs) parseAttribute(m, dm.attrs);

  /** DOM 那条路的 `st.noteEnd`：最后一个非倚音和弦的终点（没折算的 divisions） */
  let noteEnd = new Fraction(0);
  let prevEnd = 0;
  let pendingHarmony: string | null = null;
  let pendingDirections: ChordDirection[] = [];
  const count = dm.elements.length;
  const barlinesAt = (i: number, where: "left" | "middle" | "right"): void => {
    for (const b of dm.barlines ?? []) {
      if (b.location !== where) continue;
      if (where === "middle" && b.afterElements !== i) continue;
      parseBarline(m, b, noteEnd);
    }
  };
  const directionsAt = (i: number): void => {
    for (const d of dm.directions ?? []) {
      if (d.type === "sound" || Math.min(d.afterElements ?? 0, count) !== i) continue;
      parseSectionMark(m, d);
      pendingDirections.push(...parseDirectionMarks(d));
    }
    for (const la of dm.laterAttrs ?? []) if (Math.min(la.afterElements, count) === i) parseAttribute(m, la.attrs);
  };
  /** 读完一个 `<note>` 之后：攒着的和弦符号与记号落到最后一个条目上 */
  const flushPending = (): void => {
    const last = m.entries[m.entries.length - 1];
    if (pendingHarmony && last instanceof Chord && !last.harmony) {
      last.harmony = pendingHarmony;
      pendingHarmony = null;
    }
    if (pendingDirections.length && last instanceof Chord) {
      last.directions.push(...pendingDirections);
      pendingDirections = [];
    }
  };

  barlinesAt(0, "left");
  dm.elements.forEach((el, i) => {
    barlinesAt(i, "middle");
    directionsAt(i);
    if (el.kind !== "chord") {
      if (el.harmony) pendingHarmony = harmonyText(el.harmony) ?? pendingHarmony;
      return;
    }
    for (const h of [el.harmony, ...(el.laterHarmonies ?? [])]) if (h) pendingHarmony = harmonyText(h) ?? pendingHarmony;
    const onset = el.onset ?? prevEnd;
    prevEnd = onset + el.duration.divisions;
    const notes: (DocNote | null)[] = el.notes.length ? el.notes : [null];
    if (el.grace) {
      notes.forEach((dn, k) => {
        const g = new Note(null as unknown as Chord);
        loadNote(g, el, dn, k, marksAt);
        tmp.graceNotes.push(g);
        flushPending();
      });
      return;
    }
    notes.forEach((dn, k) => {
      const newChord = m.entries.length === 0 || k === 0;
      if (newChord) m.add(new Chord(m));
      const last = m.entries[m.entries.length - 1] as Chord;
      if (tmp.graceNotes.length && newChord) {
        for (const g of tmp.graceNotes) g.chord = last;
        last.graceNotes.push(...tmp.graceNotes);
        tmp.graceNotes = [];
      }
      const nt = new Note(last);
      loadNote(nt, el, dn, k, marksAt);
      if (newChord) tmp.slurChords.push(last);
      if (nt.tieStart || nt.tieEnd) tmp.tieNotes.push(nt);
      if (nt.tupletBegin || nt.tupletEnd) tmp.tupletNotes.push(nt);
      last.add(nt);
      if (newChord) {
        parseDuration(last, el);
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
    for (let i = m.entries.length - 1; i >= 0; i--) {
      const e = m.entries[i];
      if (e instanceof Chord) {
        for (const d of pendingDirections) d.atBarEnd = true;
        e.directions.push(...pendingDirections);
        break;
      }
    }
  }
}

function harmonyText(h: Harmony): string | null {
  return h.root.step ? harmonyToText(h, "unicode") : null;
}

function loadNote(
  nt: Note,
  el: DocChord,
  dn: DocNote | null,
  k: number,
  marksAt: Map<number, Map<number, NoteMarks>>,
): void {
  const p = dn?.pitch;
  if (p) {
    nt.octave = p.octave;
    nt.step = p.step[0] ?? " ";
    nt.alter = Math.trunc(p.alter);
    nt.pitch = (nt.octave + 1) * 12 + (PITCH_MAP[nt.step] ?? 0) + nt.alter;
  } else {
    nt.pitch = 0;
  }
  if (el.rest) nt.rest = true;
  if (k === 0) {
    for (const l of el.lyrics ?? []) {
      if (l.text.length === 0) continue;
      const lrc = new Lyric();
      lrc.text = l.text;
      const number = l.numberText ?? String(l.number);
      if (number === "chorus") {
        lrc.refrain = true;
        lrc.number = 1;
      } else {
        lrc.number = number.charCodeAt(number.length - 1) - "0".charCodeAt(0);
      }
      nt.lyrics.push(lrc);
    }
  }
  if (dn?.tie?.start) nt.tieStart = true;
  if (dn?.tie?.stop) nt.tieEnd = true;
  const mk = marksAt.get(el.id)?.get(k);
  if (mk?.tupletBegin) nt.tupletBegin = true;
  if (mk?.tupletEnd) nt.tupletEnd = true;
  if (nt.chord) {
    if (k === 0 && el.notations?.fermata) nt.chord.fermata = true;
    if (k === 0) for (const a of el.notations?.articulations ?? []) if (a === "accent") nt.chord.articulations.push("accent");
    if (mk?.slurStart) nt.chord.slurStart = true;
    if (mk && mk.slurStops > nt.chord.slurEnds) nt.chord.slurEnds = mk.slurStops;
  }
}

function parseDuration(ch: Chord, el: DocChord): void {
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

function parseAttribute(m: Measure, a: import("./doc").MeasureAttrs): void {
  if (a.key) {
    m.key.fifths = a.key.fifths;
    m.keyChange = true;
  }
  if (a.time) {
    m.time.beats = a.time.beats;
    m.time.beatType = a.time.beatType;
    m.timeChange = true;
  }
}

function parseBarline(m: Measure, b: Barline, noteEnd: Fraction): void {
  if (b.style) {
    const style = b.style as BarStyle;
    if (b.location === "left") m.leftBarline = style;
    else m.barline = style;
    const be = new BarlineEntry(m);
    be.style = style;
    be.position = noteEnd;
    m.entries.push(be);
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
      m.endingNum = m.parseEndingNum(digits ? digits.join(",") : ending.numbers.join(","));
      m.endingLeft = true;
    } else {
      m.endingRight = ending.type as StartStopDiscontinue;
    }
  }
}

/** `<direction>` 的各子元素（首个 + `more`） */
const partsOf = (d: Direction): DirectionPart[] => [d, ...(d.more ?? [])];

/** 段落标记 → `Measure.sectionMark`（供乐句排版按段落硬换行）。 */
function parseSectionMark(m: Measure, d: Direction): void {
  for (const it of partsOf(d)) {
    const txt = it.type === "words" || it.type === "rehearsal" ? (it.text ?? "").trim() : "";
    if (!txt) continue;
    if (it.type === "rehearsal" || SECTION_WORD_RE.test(txt)) {
      m.sectionMark = txt;
      return;
    }
  }
}

/** 表情/跳转记号（`rit.` / `Fine` / `D.S.` / 𝄋 / `mf`）。判据见原 `musicxml.ts::parseDirectionMarks` 的注释。 */
function parseDirectionMarks(d: Direction): ChordDirection[] {
  const res: ChordDirection[] = [];
  for (const it of partsOf(d)) {
    if (it.type === "words") {
      const t = (it.text ?? "").trim();
      const bare = t.replace(/^[（(]\s*/, "").replace(/\s*[）)]$/, "");
      if (!t || SECTION_WORD_RE.test(t) || SECTION_WORD_RE.test(bare)) continue;
      if (!/[\p{L}\p{N}]/u.test(t)) continue;
      res.push({
        text: t,
        music: false,
        italic: it.font?.style === "italic",
        ...(it.justify === "right" ? { atBarEnd: true } : {}),
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

/** 读谱期的配对池（弧、延音、连音、还没落到主音上的倚音）。 */
class ParserTemp {
  /** 按文档序收集的和弦，收齐了在 `pairSlur` 里栈式配对（后开先闭）。 */
  slurChords: Chord[] = [];
  tieNotes: Note[] = [];
  tupletNotes: Note[] = [];
  /** 还没落到主音符上的倚音（`<grace>` 排在它修饰的音符**之前**）。 */
  graceNotes: Note[] = [];

  pairTuplet(): void {
    this.tupletNotes.sort((a, b) => a.absoluteTick.compareTo(b.absoluteTick));
    doPairTuplet(this.tupletNotes);
    this.tupletNotes = [];
  }

  /** 圆滑线配对：栈式（后开先闭），这样嵌套的两条弧各自连对端点。 */
  pairSlur(): void {
    const stack: Chord[] = [];
    for (const c of this.slurChords) {
      for (let k = 0; k < c.slurEnds; k++) {
        const s = stack.pop();
        if (s) s.slurEndChord = c;
      }
      if (c.slurStart) stack.push(c);
    }
    this.slurChords = [];
  }

  pairTie(): void {
    const starts: Note[] = [];
    const ends: Note[] = [];
    for (const nt of this.tieNotes) {
      if (nt.tieStart) starts.push(nt);
      if (nt.tieEnd) ends.push(nt);
    }
    starts.sort((a, b) => a.absoluteTick.compareTo(b.absoluteTick));
    ends.sort((a, b) => a.absoluteTick.compareTo(b.absoluteTick));
    for (let i = 0; i < starts.length; i++) {
      const a = starts[i];
      if (i >= ends.length) break;
      const b = ends[i];
      a.tieNext = b;
      b.tiePrev = a;
    }
  }
}

/** 由 MusicXML 来的 step/octave/alter 推简谱的数字/八度点/记号（MusicXML 那一路；`.jpwabc` 与文本谱直接给度数）。
 *  **经简谱语义层**（`model/jianpu.ts`）：唱名与八度点 `degreeFromPitch`、小节内延续的记号 `AccidentalCarry.mark`。
 *  `Score` 只有单字符记号位，双升/双降印成 `#`/`b`（语料 0 例）。 */
function initNote(nt: Note, fifths: number, carry: AccidentalCarry): void {
  const pitch = { step: nt.step as Pitch["step"], alter: nt.alter, octave: nt.octave };
  const key = { fifths };
  const d = degreeFromPitch(pitch, key);
  nt.number = nt.rest ? "0" : String(d.number);
  nt.jpAlter = JP_ALTER[carry.mark(pitch, key) ?? ""] ?? " ";
  nt.jpOctave = d.octaveShift;
}

/** 读完一小节：只留 voice ≤ 1、和弦取最高音（歌词并到它上面），再按调号推唱名与记号（倚音先于主音）。 */
function initMeasure(m: Measure): void {
  removeUnused(m);
  const stat = new AccidentalCarry();
  for (const ent of m.entries) {
    if (!(ent instanceof Chord)) continue;
    // 倚音先于主音（临时记号是按左右顺序生效的，延续状态认这个次序）
    for (const nt of ent.graceNotes) initNote(nt, m.key.fifths, stat);
    if (ent.rest) continue;
    for (const nt of ent.notes) initNote(nt, m.key.fifths, stat);
  }
}

function removeUnused(m: Measure): void {
  const rem: Chord[] = [];
  for (const ent of m.entries) {
    if (!(ent instanceof Chord)) continue;
    const ch = ent;
    if (ch.voice > 1) {
      rem.push(ch);
      continue;
    }
    if (ch.notes.length <= 1) continue;
    let cur = -1;
    let maxPit = 0;
    const lrc: Lyric[] = [];
    ch.notes.forEach((nt, i) => {
      const p = nt.pitch;
      if (p > maxPit) {
        cur = i;
        maxPit = p;
      }
      lrc.push(...nt.lyrics);
    });
    const v = ch.notes[cur];
    v.lyrics = [];
    v.lyrics.push(...lrc);
    ch.notes = [v];
  }
  m.entries = m.entries.filter((e) => !(e instanceof Chord && rem.includes(e)));
}

// ---------------- 副歌判定（同原 musicxml.ts::findRefrain，phrasedoc.ts 有一份按断句输入的） ----------------

function findRefrain(score: Score): void {
  const countInf = new Map<string, { pos: Fraction; n: number }>();
  let inEnding = false;
  for (const m of score.parts[0]!.measures) {
    if (m.endingLeft) inEnding = true;
    for (const ent of m.entries) {
      if (!(ent instanceof Chord)) continue;
      // 房内的单行歌词只属于该房次，不能按「尾部只剩一行 = 各段共用副歌」折成 refrain。
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
  for (const m of score.parts[0]!.measures) {
    const end = m.position.plus(m.duration);
    if (end.compareTo(refrainPos) <= 0) continue;
    for (const ent of m.entries) {
      if (!(ent instanceof Chord)) continue;
      const pos = m.position.plus(ent.position);
      if (pos.compareTo(refrainPos) < 0) continue;
      for (const n of ent.notes) for (const l of n.lyrics) l.refrain = true;
    }
  }
}
