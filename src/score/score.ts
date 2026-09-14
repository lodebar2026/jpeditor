// 简谱排版引擎（`layout/`）的**输入树**。**不是模型**——语义模型只有 `ScoreDoc`（`model/doc.ts`）。
//
// 由三个建树器产出，各管一种形状，都不再直接读格式文本：
//   `model/xmlscore.ts::scoreOfXmlSong`   ScoreDoc（MusicXML 形状）→ 成书重排、ABC 回落
//   `pu/toscore.ts::scoreDocToScore`       ScoreDoc（简谱形状：文本谱 / 123 / ABC）→ 展开档
//   `score/jpwimport.ts::fromJpw`          `.jpwabc` 源文小节（与 `jpwToScoreDoc` 共用读原文那一步）→ `.jpwabc` 谱面
// 引擎会在它上面写东西（断句落下的 `LineBreak`、`clearSystemBreak`、演唱顺序 `playData`），所以每次排版给一棵新的。
// 类与字段从 mp/score/score.kt 移植而来（R2 阶段 9 起读格式、推唱名的那部分挪到了各建树器）。

import { Fraction } from "../common/fraction";
import { BarStyle, StartStopDiscontinue } from "./enums";
import { keyAlter } from "./jppitch";
import { PlayData } from "./playorder";

export { BarStyle, StartStopDiscontinue };
// 演唱顺序的类原在这里，阶段 4 搬到 playorder.ts；照旧从这里导出，调用方不用改。
export { JumpSpec, PlayData, PlayItem, PlaySpecKind, RepeatSpec, RepeatSpecItem, TimePosition } from "./playorder";

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
    // 无点 1 落在 B3..A4 一个八度里，只有字母 B 的调降八度（《简谱通用规范》23-24 页的
    // 各调音域对照表；判据与 jppitch.ts::jpTonicOctaveShift 同源，那边按 fifths 判）。
    res += step[0] === "B" ? 48 : 60;
    return res;
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
   *  style 分不开，故另记一笔（导出 MusicXML 要据此写 `<repeat>`；原 model/fromscore.ts，阶段 8 已删）。
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
  /** 本和弦收几条弧。嵌套双弧（外弧罩三音、内弧只罩后两音）在末音上同时收两条，故是计数。
   *  起弧仍是布尔：一条弧的另一端记在起点的 `slurEndChord` 上，同一个和弦起两条弧装不下
   *  （谱面上也罕见），识别侧遇到时只留外面那条。 */
  slurEnds = 0;
  slurEndChord: Chord | null = null;
  fermata = false;
  /** 印在这个音符上方的和弦符号（"Am7" / "G/B"）。来自 musicxml 的 `<harmony>`，
   *  与 OMR 的 `JpNum.chord`、文本谱的 `"hx:…"` 是同一层表示。
   *  `.jpwabc` 装不下它（既定，不扩语法），所以转 `.jpwabc` 会丢。 */
  harmony: string | null = null;
  /** 印在这个音符上方的**段落词**（「（副歌）」「（间奏）」…）。原书印在和弦那一带，
   *  与和弦同一条基线、左右并排。成书重排从 `校对.db::section_word` 按音符序号注进来。 */
  sectionWord: string | null = null;
  /** 印在这个音符上方的**表情/跳转记号**：`rit.`、`Fine`、`D.S.`、`mf`…
   *  来自 musicxml 的 `<direction>`（`<words>` 与 `<dynamics>`）。`music` 为真时
   *  `text` 是 Bravura 的力度字形串（`mf` = mezzo + forte，见 pu/glyph.ts::DYNAMICS）。
   *  `.jpwabc` 同样装不下（与 `harmony` 一个道理），转 `.jpwabc` 会丢。 */
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
  /** 房号原文（`<ending>` 的元素文本，如 "1.2.3."）。排版照原文画，保住 "1.-3." / "1., 2."
   *  这类写法；为空时按 endingNum 拼。 */
  endingText: string | null = null;
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
}
