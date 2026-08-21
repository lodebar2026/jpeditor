// 文本谱 AST → Score（本项目的乐谱模型）。
//
// `.jpwabc` 导出、MIDI、试听都以 Score 为输入，所以这条路是必需的。
// 换算规则与 `.jpwabc` 的导入端同构（音高换算共用 score/jppitch.ts::applyJpPitch），
// 两条路得出同一套 pitch/duration，MusicXML 与 MIDI 才对得上。
//
// **有损**：Score 装不下和弦符号、力度、多声部并排等文本谱特有的信息。
// 需要完整保留时走 toxml.ts 的直出路径。

import { Fraction } from "../common/fraction";
import { applyJpPitch, type JpKeyState } from "../score/jppitch";
import { linesOfVoice, marksAt, nextSyllables, takesLyric, voiceNumbers } from "./ast";
import {
  BarStyle,
  BarlineEntry,
  Chord,
  Credit,
  doPairTuplet,
  Key,
  Lyric,
  Measure,
  MusicCommon,
  Note,
  Part,
  PlayItem,
  Score,
  Time,
} from "../score/score";
import type {
  Mark,
  NoteElement,
  PuDoc,
  ScoreLine,
} from "./ast";

/** 音符编号（0–7）；节奏音符 X/9 当作休止处理（Score 没有节奏音符的概念）。 */
function digitOf(el: NoteElement): string {
  if (el.sound === "rhythm") return "0";
  return String(el.pitch);
}

function alterOf(el: NoteElement): string {
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

/** 一行曲里，某个元素下标是某类记号的起点/终点。 */
function marksEdgeAt(marks: readonly Mark[], index: number, type: Mark["type"]): {
  starts: boolean;
  ends: boolean;
} {
  const hit = marksAt(marks, index, type);
  return {
    starts: hit.some((m) => m.start === index),
    ends: hit.some((m) => m.end === index),
  };
}


interface Builder {
  part: Part;
  measure: Measure | null;
  mid: number;
  stat: JpKeyState;
  tupletNotes: Note[];
  slurOpen: Chord | null;
  /** 这些状态要**跨行**存活：小节和弧线都可以跨行延续 */
  newMeasureNeeded: boolean;
  lastChord: Chord | null;
  pendingRepeatForward: boolean;
}

function newMeasure(b: Builder, time: Time, key: Key): Measure {
  const mea = new Measure(b.mid);
  b.mid += 1;
  mea.time = time;
  mea.key = key;
  b.part.measures.push(mea);
  b.measure = mea;
  return mea;
}

/**
 * 把一个声部的所有曲行（跨 system）接成一个 Part。
 * `lines` 已按出现顺序排好；行与行之间插入 LineBreak，保留原始换行。
 */
function buildPart(
  lines: readonly ScoreLine[],
  time: Time,
  key: Key,
  fifths: number,
  noteMap?: Map<Chord, NoteElement>,
): Part {
  const b: Builder = {
    part: new Part(),
    measure: null,
    mid: 0,
    stat: { basePitch: MusicCommon.getBasePitchOfKey(key), fifths, alter: {} },
    tupletNotes: [],
    slurOpen: null,
    newMeasureNeeded: true,
    lastChord: null,
    pendingRepeatForward: false,
  };

  lines.forEach((line, lineIdx) => {
    // 每行的歌词：按「跟词」符号顺序逐个发放
    const cursors = line.lyrics.map(() => 0);

    line.elements.forEach((el, index) => {
      if (el.kind === "beat-boundary" || el.kind === "inline-layer") return;

      if (el.kind === "sustain") {
        // 增时线并进前一个音符的时值
        if (b.lastChord) {
          b.lastChord.beats += 1;
          b.lastChord.duration = chordDuration(b.lastChord);
        }
        if (el.lyricAnchor && b.lastChord) attachLyrics(line, cursors, b.lastChord);
        return;
      }

      if (el.kind === "barline") {
        const mea = b.measure ?? newMeasure(b, time, key);
        const ent = new BarlineEntry(mea);
        // 反复：`|:` 在 .jpwabc 里是挂到**下一小节**的 repeatForward 上的
        //（Measure.barline 写 HEAVY_LIGHT 会让 jpscore 的 makeBarline 直接抛错）。
        switch (el.type) {
          case "normal":
            ent.style = BarStyle.REGULAR;
            mea.barline = ent.style;
            break;
          case "double":
            ent.style = BarStyle.LIGHT_LIGHT;
            mea.barline = ent.style;
            break;
          case "end":
            ent.style = BarStyle.LIGHT_HEAVY;
            mea.barline = ent.style;
            break;
          case "repeat-start":
            ent.style = BarStyle.HEAVY_LIGHT;
            ent.repeat = "forward";
            b.pendingRepeatForward = true;
            break;
          case "repeat-end":
            ent.style = BarStyle.LIGHT_HEAVY;
            ent.repeat = "backward";
            mea.repeatBackward = true;
            mea.barline = BarStyle.LIGHT_HEAVY;
            break;
          case "repeat-both":
            ent.style = BarStyle.LIGHT_HEAVY;
            ent.repeat = "backward";
            mea.repeatBackward = true;
            mea.barline = BarStyle.LIGHT_HEAVY;
            b.pendingRepeatForward = true;
            break;
          default:
            ent.style = BarStyle.NONE;
            mea.barline = ent.style;
        }
        mea.entries.push(ent);
        b.newMeasureNeeded = true;
        b.stat.alter = {}; // 临时记号到小节线为止
        return;
      }

      // 音符
      const mea = b.newMeasureNeeded || b.measure === null ? newMeasure(b, time, key) : b.measure;
      b.newMeasureNeeded = false;
      if (b.pendingRepeatForward) {
        mea.repeatForward = true;
        b.pendingRepeatForward = false;
      }

      const ch = new Chord(mea);
      const nt = new Note(ch);
      ch.add(nt);
      nt.number = digitOf(el);
      nt.jpOctave = el.octave;
      nt.jpAlter = alterOf(el);
      ch.beats = 1;
      ch.beams = Math.max(0, Math.round(Math.log2(el.duration / 4)));
      ch.dot = el.dots;
      if (el.hidden || el.sound === "rest" || el.sound === "rhythm") {
        ch.rest = true;
        nt.rest = true;
      }
      applyJpPitch(b.stat, nt);

      const tup = marksEdgeAt(line.marks, index, "tuplet");
      if (tup.starts) nt.tupletBegin = true;
      if (tup.ends) nt.tupletEnd = true;
      if (nt.tupletBegin || nt.tupletEnd) b.tupletNotes.push(nt);

      const slur = marksEdgeAt(line.marks, index, "slur");
      if (slur.starts) {
        ch.slurStart = true;
        b.slurOpen = ch;
      }
      if (slur.ends) {
        ch.slurEnd = true;
        if (b.slurOpen) b.slurOpen.slurEndChord = ch;
        b.slurOpen = null;
      }
      for (const orn of el.ornaments) {
        if (orn.name === "yc" || orn.name === "ycy") ch.fermata = true;
      }

      ch.duration = chordDuration(ch);
      noteMap?.set(ch, el);
      mea.entries.push(ch);
      b.lastChord = ch;
      if (takesLyric(el)) attachLyrics(line, cursors, ch);
    });

    // 行末换行（末行不加）
    if (lineIdx < lines.length - 1 && b.measure) b.measure.lineBreak(false);
  });

  doPairTuplet(b.tupletNotes);
  applyTupletDurations(b.part);
  return b.part;
}

/** 时值：beats × (附点) ÷ 2^减时线。多连音的 2/3 在 applyTupletDurations 里再乘。 */
function chordDuration(ch: Chord): Fraction {
  let dur = new Fraction(ch.beats);
  if (ch.dot > 0) dur = dur.timesInt(3).divInt(2);
  return dur.divInt(1 << ch.beams);
}

function applyTupletDurations(part: Part): void {
  for (const m of part.measures) {
    let pos = new Fraction(0);
    for (const ent of m.entries) {
      if (!(ent instanceof Chord)) {
        ent.duration = new Fraction(0);
        ent.position = pos;
        continue;
      }
      let dur = chordDuration(ent);
      if (ent.notes[0]?.tuplet) dur = dur.timesInt(2).divInt(3);
      ent.duration = dur;
      ent.position = pos;
      pos = pos.plus(dur);
    }
  }
  let acc = new Fraction(0);
  for (const m of part.measures) {
    m.position = acc;
    let inner = new Fraction(0);
    for (const ent of m.entries) inner = inner.plus(ent.duration ?? new Fraction(0));
    acc = acc.plus(inner);
  }
}

function attachLyrics(
  line: ScoreLine,
  cursors: number[],
  ch: Chord,
): void {
  for (const { verse, text } of nextSyllables(line.lyrics, cursors)) {
    const lrc = new Lyric();
    lrc.number = verse;
    lrc.text = text;
    ch.notes[0]!.lyrics.push(lrc);
  }
}


export interface ToScoreOptions {
  /** 取第几首（`-----` 分出的多唱法）。默认第一首。 */
  song?: number;
  /** 传入一个空 Map，转换时会填上 Chord → AST 音符的对应关系。
   *  播放高亮要用：播放器给的是 Chord，而「原版」谱面认的是 AST 节点。 */
  noteMap?: Map<Chord, NoteElement>;
}

/**
 * 文本谱 → Score。多声部会变成多个 Part（Part[0] 为主旋律）。
 * 返回 null 表示这份文档没有可用的曲行。
 */
export function puToScore(doc: PuDoc, options: ToScoreOptions = {}): Score | null {
  const song = doc.songs[options.song ?? 0];
  if (!song) return null;
  const meta = song.metadata;

  const score = new Score();
  score.title = meta.titles[0] ?? "";
  // 副标题与词曲作者都进 credit（与 MusicXML 导入端的口径一致：page 为 0 基）
  const pushCredit = (text: string, type: string | null): void => {
    if (!text) return;
    const c = new Credit();
    c.text = text;
    c.type = type;
    c.page = 0;
    score.credit.push(c);
  };
  meta.titles.forEach((t, i) => pushCredit(t, i === 0 ? "title" : "subtitle"));
  for (const a of meta.authors) pushCredit(a, "composer");
  for (const t of meta.topRight) pushCredit(t, "composer");
  for (const t of meta.topLeft) pushCredit(t, "lyricist");

  const time = new Time();
  const meter = meta.meters[0];
  if (meter) {
    time.beats = meter.numerator;
    time.beatType = meter.denominator;
  }
  const key = new Key();
  key.fifths = MusicCommon.keyNameToFifth(meta.mode ?? "C");

  for (const tempo of meta.tempos) {
    if (typeof tempo === "number" && tempo >= 20 && tempo <= 400) {
      score.playData.tempo = tempo;
      break;
    }
  }

  const voices = voiceNumbers(song);
  for (const v of voices) {
    const lines = linesOfVoice(song, v);
    if (lines.length === 0) continue;
    score.parts.push(buildPart(lines, time, key, key.fifths, options.noteMap));
  }
  if (score.parts.length === 0) return null;

  // 段数 = 歌词最多的那一行的段号上限；据此生成播放遍数
  let passes = 0;
  for (const line of linesOfVoice(song, voices[0]!)) {
    for (const l of line.lyrics) passes = Math.max(passes, l.verseTo);
  }
  const main = score.parts[0]!;
  for (let p = 0; p < Math.max(1, passes); p += 1) {
    const item = new PlayItem();
    item.pass = p + 1;
    item.mid = 0;
    item.end = main.measures.length;
    score.playData.measures.push(item);
  }
  score.playData.isSimpple = true;
  return score;
}
