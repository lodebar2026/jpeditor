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
  JumpSpec,
  Part,
  PlayItem,
  PlaySpecKind,
  Score,
  Time,
  TimePosition,
} from "../score/score";
import { StartStopDiscontinue } from "../score/enums";
import type {
  LyricLine,
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


/** 跳转记号（`&dc` / `&ds` / `&fine` / `&ty` / `&hs`）先记下挂在哪一小节，时值定稿后再换算成位置。 */
interface PendingJump {
  name: string;
  measure: Measure;
  onBarline: boolean;
}

const JUMP_NAMES = new Set(["dc", "ds", "fine", "ty", "hs"]);

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
  /** 跳房子起点已过、等下一个音符开出（或落进）的那一小节来挂房号 */
  pendingEnding: Mark | null;
  jumps: PendingJump[];
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
/** 房号原文 → 适用于第几遍（同 MusicXML 导入端：文本里的数字才是遍数，"1,2,3,5" / "1.2.3." 通吃）。 */
function applyEndingStart(mea: Measure, mark: Mark): void {
  const text = (mark.caption ?? "").trim();
  mea.endingLeft = true;
  mea.endingText = text || null;
  const digits = text.match(/\d+/g);
  mea.endingNum = digits ? mea.parseEndingNum(digits.join(",")) : null;
}

/**
 * 同一条曲行下**段号重复**的歌词行，依次顺延到下一个空闲段号（展开档用，见 `ToScoreOptions.forExpanded`）。
 * 《同一首歌》同一段曲下写了两行 `C1:`，内容其实是第 1、2 段：展开档一遍只挂一行词，
 * 两行同号就会画在同一位置相压，顺延之后各成一遍。段号不重复的行原样返回。
 */
function distinctVerses(lyrics: readonly LyricLine[]): readonly LyricLine[] {
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

function buildPart(
  lines: readonly ScoreLine[],
  time: Time,
  key: Key,
  fifths: number,
  noteMap?: Map<Chord, NoteElement>,
  renumberVerses = false,
): { part: Part; jumps: PendingJump[] } {
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
    pendingEnding: null,
    jumps: [],
  };

  lines.forEach((line, lineIdx) => {
    // 每行的歌词：按「跟词」符号顺序逐个发放
    const lyrics = renumberVerses ? distinctVerses(line.lyrics) : line.lyrics;
    const cursors = lyrics.map(() => 0);
    // 跳房子（房号）：跨行的只在真正的起点/终点那一行落值
    const voltas = line.marks.filter((mk) => mk.type === "volta");

    line.elements.forEach((el, index) => {
      for (const mk of voltas) {
        if (mk.start === index && !mk.continuationFromPrevious) b.pendingEnding = mk;
      }
      const endsVolta = voltas.filter((mk) => mk.end === index && !mk.continuationToNext);
      const closeVolta = (mea: Measure | null): void => {
        if (!mea) return;
        for (const mk of endsVolta) {
          mea.endingRight = mk.openEnd ? StartStopDiscontinue.DISCONTINUE : StartStopDiscontinue.STOP;
        }
      };
      const noteJumps = (mea: Measure, onBarline: boolean): void => {
        if (!("ornaments" in el)) return;
        for (const orn of el.ornaments) {
          if (JUMP_NAMES.has(orn.name)) b.jumps.push({ name: orn.name, measure: mea, onBarline });
        }
      };

      if (el.kind === "beat-boundary" || el.kind === "inline-layer") return;

      if (el.kind === "sustain") {
        closeVolta(b.measure);
        if (b.measure) noteJumps(b.measure, false);
        // 增时线并进前一个音符的时值
        if (b.lastChord) {
          b.lastChord.beats += 1;
          b.lastChord.duration = chordDuration(b.lastChord);
        }
        if (el.lyricAnchor && b.lastChord) attachLyrics(lyrics, cursors, b.lastChord);
        return;
      }

      if (el.kind === "barline") {
        const mea = b.measure ?? newMeasure(b, time, key);
        closeVolta(mea);
        noteJumps(mea, true);
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
      if (b.pendingEnding) {
        applyEndingStart(mea, b.pendingEnding);
        b.pendingEnding = null;
      }
      closeVolta(mea);
      noteJumps(mea, false);

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
        ch.slurEnds++;
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
      if (takesLyric(el)) attachLyrics(lyrics, cursors, ch);
    });

    // 行末换行（末行不加）
    if (lineIdx < lines.length - 1 && b.measure) b.measure.lineBreak(false);
  });

  doPairTuplet(b.tupletNotes);
  applyTupletDurations(b.part);
  return { part: b.part, jumps: b.jumps };
}

/**
 * 跳转记号换算成播放位置（口径同 MusicXML 导入端 `parseSound`，由 RepeatProcessor 消费）：
 * - 「从这里跳走」的（`&dc` / `&ds` / `&fine` / 第一处 `&ty` 即 To Coda）记在**本小节末**；
 * - 「跳到这里」的（`&hs` 花 S = D.S. 的目标、第二处 `&ty` = 尾声起点）：挂在小节线上就是
 *   **下一小节开头**（`doJump` 从目标小节整节重放），挂在音符上就是本小节开头。
 * 谱面写了 `&ds` 却没有 `&hs`（世上所有的民族）时，RepeatProcessor 找不到记号就回曲首，等同 D.C.。
 */
function applyJumps(score: Score, jumps: readonly PendingJump[]): void {
  const pd = score.playData;
  const count = score.parts[0]?.measures.length ?? 0;
  const end = (mea: Measure): TimePosition => new TimePosition(mea.index, mea.duration);
  const target = (j: PendingJump): TimePosition =>
    j.onBarline && j.measure.index + 1 < count
      ? new TimePosition(j.measure.index + 1, new Fraction(0))
      : new TimePosition(j.measure.index, new Fraction(0));
  const codas = jumps.filter((j) => j.name === "ty");
  for (const j of jumps) {
    switch (j.name) {
      case "dc":
        pd.jumpTo.set(end(j.measure), new JumpSpec(PlaySpecKind.Dacapo));
        break;
      case "fine":
        pd.jumpTo.set(end(j.measure), new JumpSpec(PlaySpecKind.Fine));
        break;
      case "ds": {
        const s = new JumpSpec(PlaySpecKind.DalSegno);
        s.value = "1";
        pd.jumpTo.set(end(j.measure), s);
        break;
      }
      case "hs":
        pd.segno.set("1", target(j));
        break;
      case "ty":
        // 两处尾声记号：前一处是 To Coda，后一处是尾声的起点；只有一处就只当起点
        if (codas.length >= 2 && j === codas[0]) {
          const s = new JumpSpec(PlaySpecKind.ToCoda);
          s.value = "1";
          pd.jumpTo.set(end(j.measure), s);
        } else {
          pd.coda.set("1", target(j));
        }
        break;
    }
  }
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
  lyrics: readonly LyricLine[],
  cursors: number[],
  ch: Chord,
): void {
  for (const { verse, text } of nextSyllables(lyrics, cursors)) {
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
  /** 给展开档排版用（`jianpu/expanded.ts`：一遍一行词、只排 `parts[0]` 一条旋律）。两处调整：
   *  - 带歌词的声部排到 `parts[0]`（没有带歌词的就保持原序）——合唱谱的词常挂在 Q2 上（圣哉三一歌）；
   *    反复/跳转推理照旧读 `parts[0]`；
   *  - 同一条曲行下段号重复的歌词行顺延成下一段（见 `distinctVerses`）。
   *  导出 MusicXML / `.jpwabc` 不传——声部顺序与段号照原文。 */
  forExpanded?: boolean;
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

  let voices = voiceNumbers(song);
  if (options.forExpanded) {
    const lead = voices.find((v) => linesOfVoice(song, v).some((l) => l.lyrics.length > 0));
    if (lead !== undefined) voices = [lead, ...voices.filter((v) => v !== lead)];
  }
  let jumps: PendingJump[] = [];
  for (const v of voices) {
    const lines = linesOfVoice(song, v);
    if (lines.length === 0) continue;
    const built = buildPart(lines, time, key, key.fifths, options.noteMap, options.forExpanded);
    // 反复与跳转只看主旋律（parseRepeatInf 读的是 parts[0]）
    if (score.parts.length === 0) jumps = built.jumps;
    score.parts.push(built.part);
  }
  if (score.parts.length === 0) return null;
  applyJumps(score, jumps);

  // 播放 / 展开序列：与 MusicXML 导入同一套推理（反复、房号、D.C./D.S.、多段歌词逐段一遍，
  // 见 Score.parseRepeatInf）。推不出来（结构太怪）才退回下面「整曲按段数逐遍」的老办法。
  try {
    score.parseRepeatInf();
    if (score.playData.measures.length > 0) return score;
  } catch (e) {
    console.warn("文本谱反复推理失败，按段数逐遍", e);
  }
  score.playData.measures = [];
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
