// Ported from mp/score/score.kt.
// MusicXML import methods (Score.load / Part.load / Measure.load / Note.load /
// parse*) are intentionally omitted — that path moves to the Rust backend
// (Phase 5) which emits .jpwabc. This module is the model + the jpw/layout/
// repeat logic that has no MusicXML (JAXB) dependency.

import { Fraction } from "../common/fraction";
import { BarStyle, StartStopDiscontinue } from "./enums";
import { keyAlter } from "./jppitch";

export { BarStyle, StartStopDiscontinue };

export class Credit {
  type: string | null = null;
  text = "";
  page = 0;
}

export class Time {
  beats = 4;
  beatType = 4;
  constructor(bts?: number, bt?: number) {
    if (bts !== undefined && bt !== undefined) {
      this.beats = bts;
      this.beatType = bt;
      if (![2, 4, 8, 16].includes(bt)) throw new Error("bad beatType");
    }
  }
}

export class Clef {
  sign = "";
}

export class Key {
  fifths = 0;
  get name(): string {
    const wr = "CDEFGAB";
    const b = (4 * this.fifths + 28) % 7;
    let res = "";
    if (this.fifths < -1) res += "b";
    else if (this.fifths === 7) res += "#";
    res += wr[b];
    return res;
  }
}

export class Lyric {
  text = "";
  number = 0;
  refrain = false;
}

export function doPairTuplet(tupletNotes: Note[]): void {
  for (let i = 0; i < Math.floor(tupletNotes.length / 2); i++) {
    const a = tupletNotes[2 * i];
    const b = tupletNotes[2 * i + 1];
    const tup = new Tuplet(a, b);
    a.tuplet = tup;
    b.tuplet = tup;
  }
}

export class ParserTemp {
  slurStart: Chord | null = null;
  tieNotes: Note[] = [];
  tupletNotes: Note[] = [];
  /** 还没落到主音符上的倚音（`<grace>` 排在它修饰的音符**之前**）。 */
  graceNotes: Note[] = [];
  constructor(public playData: PlayData) {}

  pairTuplet(): void {
    this.tupletNotes.sort((a, b) => a.absoluteTick.compareTo(b.absoluteTick));
    doPairTuplet(this.tupletNotes);
    this.tupletNotes = [];
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

export class BeamGroup {
  chords: Chord[] = [];
  add(chord: Chord): void {
    chord.beamGroup = this;
    this.chords.push(chord);
  }
}

export class Tuplet {
  constructor(
    public first: Note,
    public last: Note,
  ) {
    if (first.tupletEnd) throw new Error("");
    if (last.tupletBegin) throw new Error("");
  }
}

export class MusicCommon {
  static readonly fifthCircle = [4, 1, 5, 2, 6, 3, 7];
  static readonly steps = "CDEFGAB";
  static readonly keys = [
    "bC", "bG", "bD", "bA", "bE", "bB", "F",
    "C", "G", "D", "A", "E", "B", "#F", "#C",
  ];

  static readonly _stepToPitch: Record<string, number> = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
    "1": 0, "2": 2, "3": 4, "4": 5, "5": 7, "6": 9, "7": 11,
  };

  static stepToPitch(st: string): number {
    if (!(st in MusicCommon._stepToPitch)) throw new Error("");
    return MusicCommon._stepToPitch[st];
  }

  /**
   * 简谱数字 → 音名字母。字母取自调号的**拼写**（fifths → keys[]），不是 basePitch：
   * 同音高的升/降两种拼写字母不同（#C 的 1 是 C、bD 的 1 是 D；#F 对 bG 同理），
   * 只看 basePitch 分不开。原 Kotlin 按 basePitch 查表，bD/#C/bG/#F 四个调根本没有
   * 表项、直接抛错——`1=#C` 的谱因此整首排不出来（代码区有文本、排版是空的）。
   */
  static jpToStep(num: string, fifths: number): string {
    const tonic = MusicCommon.keys[fifths + 7];
    if (!tonic) throw new Error("");
    const letter = tonic[tonic.length - 1]; // 去掉 b/# 前缀
    const idx = MusicCommon.steps.indexOf(letter) + (num.charCodeAt(0) - "1".charCodeAt(0));
    return MusicCommon.steps[idx % 7];
  }

  /** 音名字母在该调号下的固定升降。实现只在 jppitch.ts::keyAlter 一处
   *  （原来这里另有一份用 fifthCircle 的等价实现，两份漂移就会出错音）。 */
  static getAlter(st: string, fifths: number): number {
    return keyAlter(MusicCommon.steps.indexOf(st), fifths);
  }

  static getBasePitchOfKey(key: Key): number {
    return MusicCommon.getBasePitch(MusicCommon.keys[key.fifths + 7]);
  }

  static keyNameToFifth(n: string): number {
    let nn = n;
    if (nn.length === 2) {
      if (n[1] === "b" || n[1] === "#") nn = `${n[1]}${n[0]}`;
    }
    return MusicCommon.keys.indexOf(nn) - 7;
  }

  static getBasePitch(key: string): number {
    let res = 0;
    let step = key;
    if (step.includes("b")) {
      res = -1;
      step = step.replace(/b/g, "");
    }
    if (step.includes("#")) {
      res = 1;
      step = step.replace(/#/g, "");
    }
    res += MusicCommon.stepToPitch(step[0]);
    res += "AB".includes(step[0]) ? 48 : 60;
    return res;
  }
}

export class AccidentalStat {
  alter: Record<string, number> = {};
  constructor(public fifths: number) {}

  update(step: string, alt: number): string | null {
    const def = MusicCommon.getAlter(step, this.fifths);
    const expect = step in this.alter ? this.alter[step] : def;
    if (expect === alt) return null;
    let res: string | null = null;
    if (step in this.alter) {
      if (def === alt) res = "n";
      else throw new Error("");
    } else {
      res = expect > alt ? "b" : "#";
    }
    if (def === alt) delete this.alter[step];
    else this.alter[step] = alt;
    return res;
  }

  reset(k: number): void {
    this.alter = {};
    this.fifths = k;
  }
}

export abstract class Entry {
  duration?: Fraction;
  position = new Fraction(0);
  constructor(public measure: Measure) {}
  get inited(): boolean {
    return this.duration !== undefined;
  }
}

export class LineBreak extends Entry {
  newPage = false;
  pass: number | null = null;
  constructor(mea: Measure) {
    super(mea);
    this.duration = new Fraction(0);
  }
}

export class BarlineEntry extends Entry {
  style: BarStyle | null = null;
  /** 原始记号是不是反复线。`.jpwabc` 的 `:|` 与终止线 `|]` 都映射成 LIGHT_HEAVY、光看
   *  style 分不开，故另记一笔（MusicXML 导出要据此写 `<repeat>`；见 musicxmlout.ts）。
   *  `forward`（`|:`）出现在小节开头，但解析时被 push 到**前一小节**末尾，语义上属于下一小节左端。 */
  repeat: "forward" | "backward" | null = null;
  constructor(mea: Measure) {
    super(mea);
    this.duration = new Fraction(0);
  }
}

/** 印在音符上方的表情/跳转记号（`Chord.directions`）。 */
export interface ChordDirection {
  /** 要排的字：文字记号是原文（`rit.`），力度记号是 Bravura 字形串。 */
  text: string;
  /** 走乐谱字体（力度记号）还是文本字体（`rit.` / `Fine` / `D.S.`）。 */
  music: boolean;
  /** 原文标的斜体（底本里 `rit.` 是 `font-style="italic"`）。 */
  italic: boolean;
  /** 记号写在小节**最后一个音符之后**（`Fine` / `D.S.` 就是这么标的，底本还带
   *  `justify="right"`）。这类要贴着小节线右对齐排，不居中在音符上方。 */
  atBarEnd?: boolean;
}

export class Chord extends Entry {
  notes: Note[] = [];
  dot = 0;
  beams = 0; // 减时线
  beats = 0; // 增时线
  voice = 0;
  stemUp = true;
  rest = false;
  beamGroup: BeamGroup | null = null;
  slurStart = false;
  slurEnd = false;
  slurEndChord: Chord | null = null;
  fermata = false;
  /** 印在这个音符上方的和弦符号（"Am7" / "G/B"）。来自 musicxml 的 `<harmony>`，
   *  与 OMR 的 `JpNum.chord`、文本谱的 `"hx:…"` 是同一层表示。
   *  `.jpwabc` 装不下它（既定，不扩语法），所以走 jpscore 那条路会丢。 */
  harmony: string | null = null;
  /** 印在这个音符上方的**段落词**（「（副歌）」「（间奏）」…）。原书印在和弦那一带，
   *  与和弦同一条基线、左右并排。成书重排从 `校对.db::section_word` 按音符序号注进来。 */
  sectionWord: string | null = null;
  /** 印在这个音符上方的**表情/跳转记号**：`rit.`、`Fine`、`D.S.`、`mf`…
   *  来自 musicxml 的 `<direction>`（`<words>` 与 `<dynamics>`）。`music` 为真时
   *  `text` 是 Bravura 的力度字形串（`mf` = mezzo + forte，见 pu/glyph.ts::DYNAMICS）。
   *  `.jpwabc` 同样装不下（与 `harmony` 一个道理），走 jpscore 那条路会丢。 */
  directions: ChordDirection[] = [];
  /** 奏法记号（目前只有 `<accent>`）。画在音符上方，与 fermata 同一带。 */
  articulations: string[] = [];
  /** **倚音**：印在主音符左上角的小号数字（原书 260/264 两首共 7 颗）。
   *  MusicXML 里是 duration 为 0 的独立 `<note><grace/>`，模型上挂在它修饰的那个和弦上。 */
  graceNotes: Note[] = [];

  hasLrc(num: number): boolean {
    for (const nt of this.notes) {
      for (const lrc of nt.lyrics) {
        if (lrc.number !== num) continue;
        if (lrc.text.length > 0) return true;
      }
    }
    return false;
  }

  add(nt: Note): void {
    this.notes.push(nt);
    nt.chord = this;
  }
}

export class Note {
  lyrics: Lyric[] = [];
  pitch = 0;
  step = " ";
  alter = 0;
  octave = 0;
  rest = false;
  tieStart = false;
  tieEnd = false;
  tupletBegin = false;
  tupletEnd = false;
  jpOctave = 0;
  jpAlter = " "; // b,n,#
  number = "0";
  tieNext: Note | null = null;
  tiePrev: Note | null = null;
  tuplet: Tuplet | null = null;

  constructor(public chord: Chord) {}

  static readonly pitchMap: Record<string, number> = {
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
  };

  getLyric(v: number): Lyric | null {
    for (const it of this.lyrics) {
      if (it.number === v || it.refrain) return it;
    }
    return null;
  }

  get absoluteTick(): Fraction {
    const ch = this.chord;
    const res = ch.position;
    const mea = ch.measure;
    return res.plus(mea.position);
  }

  /** Derives jp number/octave/alter from MusicXML-derived step/octave/alter.
   *  Used by the MusicXML import path; the .jpwabc path sets these directly. */
  init(fifths: number, stat: AccidentalStat): void {
    const str = "CDEFGAB";
    const idx = str.indexOf(this.step);
    const wr = idx + this.octave * 7;
    let p = this.octave * 7 + idx;
    const b = (4 * fifths + 28) % 7;
    p -= b;
    this.number = "0";
    if (!this.rest) {
      this.number = String.fromCharCode("1".charCodeAt(0) + (p % 7));
    }
    this.jpAlter = stat.update(this.step, this.alter) ?? " ";
    this.jpOctave = Math.floor((wr - b) / 7) - 4;
    if (fifths === 3 || fifths === 5 || fifths === -2) this.jpOctave += 1;
  }
}

export class Measure {
  entries: Entry[] = [];
  key = new Key();
  time = new Time();
  keyChange = false;
  timeChange = false;
  newSystem = false;
  newPage = false;
  position = new Fraction(0);
  leftBarline: BarStyle | null = null;
  barline: BarStyle | null = null;
  repeatBackward = false;
  repeatForward = false;
  endingLeft = false;
  endingNum: Set<number> | null = null;
  endingRight: StartStopDiscontinue | null = null;
  /** 段落标记（Intro/Verse/Chorus/Coda…，来自 MusicXML `<rehearsal>`/段落词 `<words>`）。
   *  乐句排版据此在段首硬换行、并按段分别排行长（见 phrase.ts）。原 Kotlin 无此字段。 */
  sectionMark: string | null = null;

  constructor(public index: number) {}

  get duration(): Fraction {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e instanceof Chord) return e.position.plus(e.duration!);
    }
    throw new Error("measure has no chord");
  }

  add(chord: Chord): void {
    this.entries.push(chord);
    chord.measure = this;
  }

  autoBeamGroup(): BeamGroup[] {
    let groupLen = new Fraction(1);
    if (this.time.beatType === 8) {
      groupLen = groupLen.divInt(2);
      groupLen = groupLen.timesInt(3);
    }
    return this.autoBeamGroupLen(groupLen);
  }

  private autoBeamGroupLen(len: Fraction): BeamGroup[] {
    const res: BeamGroup[] = [new BeamGroup()];
    this.entries.sort((a, b) => a.position.compareTo(b.position));
    let curGroup: Fraction | null = null;
    for (const ent of this.entries) {
      if (!(ent instanceof Chord)) continue;
      const chord = ent;
      if (!chord.inited) throw new Error("");
      if (chord.beams === 0) continue;
      if (chord.duration!.compareTo(len) > 0) continue;
      const start = len.timesInt(chord.position.div(len).toInt());
      if (curGroup !== null) {
        if (!curGroup.equals(start)) curGroup = null;
      }
      if (curGroup === null) {
        res.push(new BeamGroup());
      }
      res[res.length - 1].add(chord);
      curGroup = start;
    }
    return res;
  }

  jp(): string {
    let res = "";
    for (const ent of this.entries) {
      if (!(ent instanceof Chord)) continue;
      const ch = ent;
      const nt = ch.notes[0];
      res += nt.number;
      for (let i = 1; i < ch.beats; i++) res += "-";
      for (let i = 1; i < ch.beams; i++) res += "/";
      res += " ";
    }
    res += "|";
    return res;
  }

  init(): void {
    this.removeUnused();
    const stat = new AccidentalStat(this.key.fifths);
    for (const ent of this.entries) {
      if (!(ent instanceof Chord)) continue;
      // 倚音先于主音（临时记号是按左右顺序生效的，`AccidentalStat` 认这个次序）
      for (const nt of ent.graceNotes) nt.init(this.key.fifths, stat);
      if (ent.rest) continue;
      for (const nt of ent.notes) nt.init(this.key.fifths, stat);
    }
  }

  private removeUnused(): void {
    const rem: Chord[] = [];
    for (const ent of this.entries) {
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
    this.entries = this.entries.filter((e) => !(e instanceof Chord && rem.includes(e)));
  }

  parseEndingNum(s: string | null): Set<number> | null {
    if (s === null) return null;
    const res = new Set<number>();
    for (const it of s.split(",")) {
      const t = it.trim();
      if (t.length === 0) continue;
      res.add(parseInt(t, 10));
    }
    return res;
  }

  lrc(num: number): string {
    let res = "";
    for (const ent of this.entries) {
      if (!(ent instanceof Chord)) continue;
      for (const nt of ent.notes) {
        for (const lrc of nt.lyrics) {
          if (lrc.number !== num) continue;
          res += lrc.text;
        }
      }
    }
    return res;
  }

  lineBreak(pg: boolean): void {
    const lb = new LineBreak(this);
    lb.newPage = pg;
    // 位置要落在**小节末**：autoBeamGroup 会按 position 把整节 entries 重排一遍，
    // 默认的 0 会让它挤到第一个和弦之后（同为 0、稳定排序），于是行尾丢掉小节后半——
    // 句末的长音与标点被甩到下一行行首（001《圣哉，圣哉，圣哉》的「宰！」就是这么跑的）。
    lb.position = this.entries.reduce((p, e) => {
      const end = e.duration ? e.position.plus(e.duration) : e.position;
      return end.compareTo(p) > 0 ? end : p;
    }, new Fraction(0));
    this.entries.push(lb);
  }
}

export class Part {
  measures: Measure[] = [];

  jp(): string {
    let res = "";
    for (const m of this.measures) res += m.jp();
    return res;
  }

  getVerseCount(beg: number, end: number): number {
    const num = new Set<number>();
    this.measures.forEach((m, idx) => {
      if (idx < beg || idx >= end) return;
      for (const ent of m.entries) {
        if (!(ent instanceof Chord)) continue;
        for (const n of ent.notes) for (const l of n.lyrics) num.add(l.number);
      }
    });
    return num.size;
  }
}

export enum PlaySpecKind {
  Dacapo,
  DalSegno,
  ToCoda,
  Fine,
}

export class JumpSpec {
  value: unknown = null;
  constructor(public kind: PlaySpecKind) {}
}

export class PlayData {
  coda = new Map<string, TimePosition>();
  segno = new Map<string, TimePosition>();
  jumpTo = new Map<TimePosition, JumpSpec>();
  measures: PlayItem[] = [];
  hasRepeat = false;
  isSimpple = false; // no repeat, only multiple verse
  /** 谱面速度（♩= 每分钟拍数）。0 = 未标注，试听/导出用 timeline.ts 的默认值。
   *  来源：MusicXML `<sound tempo>` / OMR 页眉的 `♩=76` / .jpwabc `.Title` 的 `Tempo`。 */
  tempo = 0;

  get noRepeat(): boolean {
    if (this.hasRepeat) return false;
    if (this.coda.size > 0 || this.segno.size > 0) return false;
    if (this.jumpTo.size > 0) return false;
    return true;
  }
}

export class TimePosition {
  mid = 0;
  pass = 0;
  offset = new Fraction(0);
  constructor(m?: number, t?: Fraction) {
    if (m !== undefined && t !== undefined) {
      if (m < 0) throw new Error("");
      this.mid = m;
      this.offset = t;
    }
  }
  compareTo(a: TimePosition): number {
    const diff = this.mid - a.mid;
    if (diff !== 0) return diff;
    return this.offset.minus(a.offset).compareTo(new Fraction(0));
  }
}

export class PlayItem extends TimePosition {
  end = 0;
  endOfPass = false;
  /** 首小节要跳过的和弦个数（弱起式接入，`.Repeat` 里写作 `11.2-20V4`）。 */
  skip = 0;
  /** 末小节只取前这么多个和弦（-1 = 整节，`.Repeat` 里写作 `11.1-11.1V1`）。 */
  limit = -1;
  clone(): PlayItem {
    const p = new PlayItem();
    p.mid = this.mid;
    p.pass = this.pass;
    p.offset = this.offset;
    p.end = this.end;
    p.endOfPass = this.endOfPass;
    p.skip = this.skip;
    p.limit = this.limit;
    return p;
  }
}

export enum EndingType {
  None,
  Start,
  Discontinue,
}

export class Score {
  parts: Part[] = [];
  composer = "";
  lyricist = "";
  creator = new Map<string, string>();
  credit: Credit[] = [];
  title = "";
  playData = new PlayData();

  clearSystemBreak(): void {
    for (const p of this.parts) {
      for (const m of p.measures) {
        m.newPage = false;
        m.newSystem = false;
        m.entries = m.entries.filter((e) => !(e instanceof LineBreak));
      }
    }
  }

  doRepeat(repeat: RepeatSpec): void {
    for (const it of repeat.items) {
      const pit = new PlayItem();
      pit.mid = it.first;
      pit.end = it.last + 1;
      pit.pass = it.verse;
      pit.skip = it.skip;
      pit.limit = it.limit;
      pit.endOfPass = it.page;
      // 跳过起头几个音时，试听/MIDI 侧用 offset 裁掉同样的部分（buildTimeline 只认 offset）。
      const mea = this.parts[0]?.measures[it.first];
      if (it.skip > 0 && mea) pit.offset = skipOffset(mea, it.skip);
      this.playData.measures.push(pit);
    }
  }

  parseRepeatInf(): void {
    const rep = new RepeatProcessor(this);
    const pos = new TimePosition();
    pos.pass = 1;
    const measures = this.parts[0].measures;
    while (pos.mid < measures.length) {
      const end = rep.process(pos);
      if (end) break;
      if (pos.pass > 10) break;
      if (rep.result.length > 20) break;
    }
    let repeatByVerse = true;
    for (const m of rep.result) {
      const mea = measures[m.end - 1];
      let repStart = m.mid;
      for (let mid = m.mid; mid < m.end; mid++) {
        if (measures[mid].repeatForward) repStart = mid;
      }
      if (!mea.repeatBackward) continue;
      const verseCnt = rep.getPassCountByLrc(repStart, m.end);
      if (verseCnt > 1) repeatByVerse = false;
    }
    // 谱面写明了 2 号以上的房（1.2.3.5./4./6.）时，演唱遍数由房号显式给定、RepeatProcessor
    // 已按房展开；不能再按歌词段数把整份结果整体乘一遍（沧海一声笑会被乘成 6 倍）。
    let hasVolta = false;
    for (const m of measures) {
      if (m.endingNum && [...m.endingNum].some((n) => n > 1)) hasVolta = true;
    }
    // D.C./D.S. 同理：跳转记号本身就把曲子展开成了多遍（本曲 `D.C. al Fine`＝全曲唱一遍、
    // 回头唱到 Fine 为止，两遍正好配两段词），再按歌词段数整体乘一遍就成了四遍。
    const hasJump = this.playData.jumpTo.size > 0;
    this.playData.isSimpple = rep.result.length === 1;
    if (repeatByVerse && !hasVolta && !hasJump) rep.repeatByLyric();
    this.playData.measures = [];
    this.playData.measures.push(...rep.result);
    this.expandVoltaByVerse();
    for (const m of measures) {
      if (m.repeatBackward) this.playData.hasRepeat = true;
    }
  }

  /** 「一房只有第 1 段 + 歌词段数多于房数」的赞美诗谱（如《我心等候祢》）补救展开。
   *
   *  这类谱：A 段有 V 行歌词，一房只写第 1 行（第 1 段唱完回头、不进副歌），
   *  二房起的行整体上移一行（行 k ↔ 第 k+1 段，谱面常在行首标「2./3./4.」），
   *  末尾多出来的行则是收尾再唱一遍的副歌。RepeatProcessor 只按房数推 2 遍，
   *  第 3、4 段会整个丢掉；这里按歌词行数重排 playData.measures。
   *
   *  条件不满足时原样返回（普通两房两段谱不受影响）。 */
  private expandVoltaByVerse(): void {
    const part = this.parts[0];
    const measures = part.measures;
    const items = this.playData.measures;
    if (items.length === 0) return;

    // 唯一一个 backward 反复，且带房号；其后须紧跟二房（endingLeft）。
    let backIdx = -1;
    for (let i = 0; i < measures.length; i++) {
      if (!measures[i].repeatBackward) continue;
      if (backIdx >= 0) return; // 多处反复，不处理
      backIdx = i;
    }
    if (backIdx < 0) return;
    const volta1End = backIdx + 1; // 一房尾后一格
    if (measures[backIdx].endingRight === null) return;
    let volta1Beg = -1;
    for (let i = backIdx; i >= 0; i--) {
      if (measures[i].endingLeft) { volta1Beg = i; break; }
    }
    if (volta1Beg < 0) return;
    const tailBeg = volta1End;
    if (tailBeg >= measures.length || !measures[tailBeg].endingLeft) return;

    // 反复起点（无 forward 记号则从头）。
    let repStart = 0;
    for (let i = 0; i < volta1Beg; i++) if (measures[i].repeatForward) repStart = i;
    if (repStart >= volta1Beg) return;

    const verses = part.getVerseCount(0, measures.length);
    let maxPass = 0;
    for (const it of items) if (it.pass > maxPass) maxPass = it.pass;
    if (verses <= maxPass) return; // 段数没有多出来，交给原逻辑
    if (part.getVerseCount(volta1Beg, volta1End) !== 1) return; // 一房不止第 1 段，形态不符

    const tailVerses = part.getVerseCount(tailBeg, measures.length);
    const out: PlayItem[] = [];
    const push = (mid: number, end: number, pass: number): PlayItem => {
      const p = new PlayItem();
      p.mid = mid;
      p.end = end;
      p.pass = pass;
      out.push(p);
      return p;
    };
    // 二房开头那几个音是这一段的结束音（与一房同位），断句上归主歌、不归副歌，
    // 这样「…惟靠祢恩典我站立。」不会被拆到副歌那页去。
    const lead = voltaLead(measures, volta1Beg, volta1End, tailBeg);
    const tailStart = (p: PlayItem): void => {
      p.skip = lead;
      if (lead > 0) p.offset = skipOffset(measures[tailBeg], lead);
    };
    // 第 1 遍：A 段 + 一房（连续，合成一项），唱完回头、不进副歌。
    push(repStart, volta1End, 1).endOfPass = true;
    // 第 2..V 遍：A 段用第 k 行，二房+副歌用第 k-1 行（整体上移一行）。
    for (let k = 2; k <= verses; k++) {
      push(repStart, volta1Beg, k);
      const tv = k - 1;
      if (tv <= tailVerses && lead > 0) push(tailBeg, tailBeg + 1, tv).limit = lead; // 结束音，仍归主歌那页
      out[out.length - 1].endOfPass = true; // 主歌段末
      if (tv <= tailVerses) {
        const p = push(tailBeg, measures.length, tv);
        tailStart(p);
        p.endOfPass = true; // 副歌段末
      }
    }
    // 二房+副歌里没用掉的行 = 收尾再唱的副歌，每行追加一遍（同样从副歌起拍接入）。
    for (let v = verses; v <= tailVerses; v++) {
      const p = push(tailBeg, measures.length, v);
      tailStart(p);
      p.endOfPass = true;
    }
    out[out.length - 1].endOfPass = false; // 末遍不额外换页
    this.playData.measures = out;
  }

  jp(): string {
    return this.parts[0].jp();
  }

  lrc(num: number): string {
    let res = "";
    for (const p of this.parts) for (const m of p.measures) res += m.lrc(num);
    return res;
  }
}

export class RepeatProcessor {
  inEnding = false;
  endingActive = false;
  loopStart = 0;
  passCount = -1;
  inJump = false;
  /** 本小节的 D.C./D.S. 被当作「房内回头记号」处理过（见 play()）：外层据此跳过收房/反复判定。 */
  loopedBack = false;
  result: PlayItem[] = [];

  constructor(public score: Score) {}

  private doJump(m: TimePosition, t: TimePosition): void {
    this.inJump = true;
    m.mid = t.mid;
    const cur = new PlayItem();
    cur.pass = m.pass;
    cur.mid = t.mid;
    cur.end = t.mid + 1;
    cur.offset = t.offset;
    this.result.push(cur);
  }

  play(m: TimePosition): boolean {
    const p0 = this.score.parts[0];
    const mid = m.mid;
    const mea = p0.measures[mid];
    const tbeg = new TimePosition(mid, new Fraction(0));
    const tend = new TimePosition(mid, mea.duration);
    let res = false;
    let seg: string | null = null;
    let tocoda: string | null = null;
    let dacapo = false;
    for (const [t, v] of this.score.playData.jumpTo) {
      if (t.compareTo(tbeg) < 0) continue;
      if (t.compareTo(tend) > 0) continue;
      if (!this.inJump && v.kind === PlaySpecKind.DalSegno) seg = v.value as string;
      if (v.kind === PlaySpecKind.Dacapo) dacapo = true;
      if (this.inJump && v.kind === PlaySpecKind.ToCoda) tocoda = v.value as string;
      if (this.inJump && v.kind === PlaySpecKind.Fine) res = true;
    }
    let newItem = false;
    if (this.result.length === 0) {
      newItem = true;
    } else {
      const last = this.result[this.result.length - 1];
      if (mid !== last.end || m.pass !== last.pass) newItem = true;
      else last.end += 1;
    }
    if (newItem) {
      const cur = new PlayItem();
      cur.pass = m.pass;
      cur.mid = mid;
      cur.end = mid + 1;
      this.result.push(cur);
    }
    const pd = this.score.playData;
    if (seg !== null) {
      let t = pd.segno.get(seg);
      if (t === undefined) t = new TimePosition(parseInt(seg, 10) - 1, new Fraction(0));
      this.doJump(m, t);
    }
    if (tocoda !== null) {
      let t = pd.coda.get(tocoda);
      if (t === undefined) t = new TimePosition(parseInt(tocoda, 10) - 1, new Fraction(0));
      this.doJump(m, t);
      this.inJump = false;
    }
    if (dacapo) {
      // 房内的 D.C.（沧海一声笑的「4.」房：1.2.3.5 房带 :||、4 房改用 D.C.、6 房收尾）：
      // 房号已经把遍数列全了，这里的 D.C. 只是这一遍的回头记号，与 :|| 等价——回到曲首后
      // **后续反复照常生效**，故不进 inJump 抑制模式。房外的 D.C. 仍按老规矩（跳回后不再反复）。
      const insideVolta = this.inEnding && m.pass < this.passCount;
      m.pass++;
      m.mid = -1;
      if (insideVolta) {
        this.loopedBack = true;
        this.inEnding = false;
        this.endingActive = false;
      } else {
        this.inJump = true;
      }
    }
    return res;
  }

  private getPassCountByEnding(mid: number): number {
    let res = 0;
    const meas = this.score.parts[0].measures;
    let idx = mid;
    while (idx < meas.length) {
      const mif = meas[idx++];
      const nums = mif.endingNum;
      if (!nums) continue;
      for (const n of nums) if (n > res) res = n;
      if (mif.endingRight === StartStopDiscontinue.DISCONTINUE) break;
    }
    return res;
  }

  private onStartEnding(mif: Measure, pass: number): void {
    if (this.inJump) return;
    this.inEnding = true;
    this.endingActive = mif.endingNum?.has(pass) === true;
  }

  private onRightEnding(m: TimePosition, resetPass: boolean): void {
    if (this.inJump) return;
    this.endingActive = false;
    this.inEnding = false;
    if (resetPass) {
      m.pass = 1;
      this.passCount = -1;
    }
  }

  onForward(mid: number, pass: number): void {
    if (this.inJump) return;
    if (pass > 1) return;
    this.loopStart = mid;
  }

  onBackward(m: TimePosition, mif: Measure): void {
    if (this.inJump) return;
    if (m.pass < this.passCount) {
      m.mid = this.loopStart;
      m.pass++;
    } else {
      m.mid++;
      if (mif.endingRight === null) m.pass = 1;
    }
  }

  update(m: TimePosition): boolean {
    let active = true;
    if (this.inEnding) active = this.endingActive;
    if (active) return this.play(m);
    return false;
  }

  private getPassCountByLrcAll(): number {
    const meas = this.score.parts[0].measures;
    return this.getPassCountByLrc(0, meas.length);
  }

  getPassCountByLrc(beg: number, end: number): number {
    return this.score.parts[0].getVerseCount(beg, end);
  }

  process(m: TimePosition): boolean {
    const p0 = this.score.parts[0];
    if (m.mid < 0) throw new Error("");
    const mif = p0.measures[m.mid];
    if (mif.endingLeft) {
      if (this.passCount < 0) this.passCount = this.getPassCountByEnding(m.mid);
      this.onStartEnding(mif, m.pass);
    }
    if (mif.repeatForward) this.onForward(m.mid, m.pass);
    // 本遍不唱这一房（房号不含当前 pass）。它右边界上的 :|| 属于这一房、不该照唱——三房以上的谱
    // （1.2.3.5. / 4. / 6.）里，第 4 遍要跳过一房落到「4.」房，若照跳 :|| 就永远到不了后面的房。
    // 两房谱不受影响：那里 pass 已到 passCount，onBackward 本就走 m.mid++ 落到二房。
    const skippedEnding = this.inEnding && !this.endingActive;
    const fine = this.update(m);
    if (fine) return true;
    if (this.loopedBack) {
      // 房内 D.C. 已把 mid 拨回曲首、pass 进位，收房/反复判定一概跳过。
      this.loopedBack = false;
      m.mid++;
      return m.mid === p0.measures.length;
    }
    if (mif.endingRight !== null) {
      // 第一房通常在右边界同时带 backward repeat，必须保留当前 pass 让 onBackward 进入下一遍；
      // 最后一房右边界没有 backward repeat，它结束了这一组独立反复，此处要把 pass/passCount 重置，
      // 否则紧随其后的下一组 ||: 会因 pass>1 被 onForward 忽略、错误跳回上一组反复起点。
      // 「最后一房」须按房号判：多房谱中间的房（如「4.」）右边界同样没有 backward，按「无 backward
      // 即收组」会在半途把 pass 归 1，剩下的房永远唱不到、并陷入死循环。
      const lastVolta = !mif.endingNum || Math.max(...mif.endingNum) >= this.passCount;
      const closesRepeatGroup = !mif.repeatBackward && lastVolta;
      this.onRightEnding(m, mif.endingRight === StartStopDiscontinue.DISCONTINUE || closesRepeatGroup);
    }
    if (!this.inJump && mif.repeatBackward && !skippedEnding) {
      if (this.passCount < 0) {
        const beg = this.result[this.result.length - 1].mid;
        this.passCount = this.getPassCountByLrc(beg, m.mid + 1);
        if (this.passCount <= 1) this.passCount = 2;
      }
      this.onBackward(m, mif);
    } else {
      m.mid++;
    }
    if (m.mid < 0) {
      console.error("BAD Repeat Info");
      return true;
    }
    return m.mid === p0.measures.length;
  }

  repeatByLyric(): boolean {
    const pass = this.getPassCountByLrcAll();
    if (pass <= 1) return false;
    const itemCnt = this.result.length;
    let cur = 1;
    for (let i = 1; i < pass; i++) {
      cur++;
      for (let idx = 0; idx < itemCnt; idx++) {
        const it = this.result[idx].clone();
        it.pass = cur;
        this.result.push(it);
      }
      this.result[this.result.length - 1].endOfPass = true;
    }
    return true;
  }
}

/** 跳过 `skip` 个和弦后的小节内时值位置（PlayItem.offset 用，试听/MIDI 侧靠它裁剪）。 */
function skipOffset(m: Measure, skip: number): Fraction {
  let n = 0;
  for (const ent of m.entries) {
    if (!(ent instanceof Chord)) continue;
    if (n === skip) return ent.position;
    n++;
  }
  return new Fraction(0);
}

function chordsOf(m: Measure): Chord[] {
  return m.entries.filter((e): e is Chord => e instanceof Chord);
}

/** 二房开头「与一房同位的结束音」个数：按一房的和弦数算，封顶到二房首节留一个音给副歌起拍。
 *  这几个音属于本段主歌（一房/二房各写一次的段末音），断句、分页都跟主歌走。
 *  跨连线/延音时返回 0（不把带连线的音切开）。 */
function voltaLead(measures: Measure[], volta1Beg: number, volta1End: number, tailBeg: number): number {
  let n = 0;
  for (let i = volta1Beg; i < volta1End; i++) n += chordsOf(measures[i]).length;
  const tail = chordsOf(measures[tailBeg]);
  n = Math.min(n, tail.length - 1);
  if (n <= 0) return 0;
  for (let i = 0; i < n; i++) {
    const c = tail[i];
    if (c.slurStart || c.slurEnd) return 0;
    if (c.notes.some((nt) => nt.tieStart || nt.tieEnd)) return 0;
  }
  return n;
}

export class RepeatSpecItem {
  constructor(
    public first: number,
    public last: number,
    public verse: number,
    /** 首小节跳过的和弦个数（`11.2-20V4` → skip=1）。 */
    public skip = 0,
    /** 段末换页：这一段（主歌/副歌）唱完起新页，写作 `1-10V1P`。 */
    public page = false,
    /** 末小节只取前 n 个和弦（-1 = 整节），写作 `11.1-11.1V1`。 */
    public limit = -1,
  ) {}
  toString(): string {
    const head = this.skip > 0 ? `${this.first}.${this.skip + 1}` : `${this.first}`;
    const tail = this.limit >= 0 ? `${this.last}.${this.limit}` : `${this.last}`;
    return `${head}-${tail}V${this.verse}${this.page ? "P" : ""}`;
  }
}

export class RepeatSpec {
  items: RepeatSpecItem[] = [];
  constructor(s: string) {
    for (const it of s.split("\n")) {
      const arr = it.split("V");
      // 段号后可带 `P`：这一段唱完换页（乐句排版把主歌/副歌分页用）。
      const page = /p\s*$/i.test(arr[1] ?? "");
      const v = parseInt(arr[1], 10);
      const rng = arr[0].split("-");
      // 首端可写作 `小节.音符序号`（1 基），表示这一遍从该小节的第 n 个音符起接入。
      // 逗号在 .Repeat 里是条目分隔符（见 RepeatSection.parse），故用点号；
      // 旧解析器 parseInt("11.2") 仍得 11，退化成整小节接入而不是报错。
      const fst = rng[0].split(".");
      const first = parseInt(fst[0], 10) - 1;
      const skip = fst.length > 1 ? Math.max(0, parseInt(fst[1], 10) - 1) : 0;
      // 末端同样可写 `小节.音符个数`：这一段只唱到该小节的第 n 个音符为止。
      const lst = rng[rng.length - 1].split(".");
      const last = parseInt(lst[0], 10) - 1;
      const limit = lst.length > 1 ? Math.max(0, parseInt(lst[1], 10)) : -1;
      this.items.push(new RepeatSpecItem(first, last, v, skip, page, limit));
    }
  }
}
