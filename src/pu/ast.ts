// 文本谱（番茄简谱 / 诗歌本文本谱）的抽象语法树。
//
// 每个节点都带 `source` 源码区间——语法高亮、谱面点选定位、诊断报错全靠它。
//
// 时值用 `duration` 表示**分母**（4=四分音符，8=八分，16=十六分……），与番茄脚本里
// 「一条减时线 = 时值减半」直接对应；`dots` 是附点个数。转 MusicXML 时再换算成
// divisions（见 toxml.ts）。

import type { Dialect } from "./dialect";

export interface SourceSpan {
  /** 0 基行号 */
  line: number;
  /** 行内 0 基列 */
  column: number;
  /** 全文 0 基字符偏移 */
  offset: number;
  length: number;
}

export type DiagnosticSeverity = "warning" | "error";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** 机器可读的短代码，如 "unknown-command" */
  code: string;
  message: string;
  source: SourceSpan;
}

export interface Meter {
  numerator: number;
  denominator: number;
  /** 辅助拍号写在括号里：`P: 4/4 ( 2/4 )` */
  parenthesized: boolean;
}

/** 数字为每分钟拍数；字符串为文字速度术语（「欢快的」）。两者可并存。 */
export type Tempo = number | string;

export interface Metadata {
  /** 番茄 `V:` */
  version?: string;
  /** 番茄 `B:` / 有谱 `T:`；第一条为主标题，其余为副标题 */
  titles: string[];
  /** 番茄/有谱 `Z:` */
  authors: string[];
  /** 调号，如 `C` `bE` `#F` */
  mode?: string;
  /** 主音唱名：`1=D` 省略；`6=c` 记 "6"（小调写法） */
  tonic?: string;
  /** 无前缀的自由文字行（注记、勘误等） */
  remarks: string[];
  meters: Meter[];
  tempos: Tempo[];
  /** 有谱 `XL:` `XR:` 序号 */
  indexLeft?: string;
  indexRight?: string;
  /** 有谱 `TL:` `TR:`：与标题同高的左/右文字 */
  topLeft: string[];
  topRight: string[];
  /** 有谱 `BL:` `BC:` `BR:`：页脚左/中/右 */
  bottomLeft: string[];
  bottomCenter: string[];
  bottomRight: string[];
  /** 有谱 `FontSize:` / `Margin:` 原文，交给 metrics 解释 */
  fontSizes: string[];
  margins: string[];
  /** 其余版面指令原文，如 `Space: qu=10`、`Off: hx;` */
  options: Array<{ key: string; value: string }>;
}

export type Accidental = "sharp" | "flat" | "natural" | "double-sharp" | "double-flat";

/** `&xx` 记号。`level` 是紧跟的 `+` 个数（番茄用它抬高记号位置 / 区分波音颤音变体）。 */
export interface Ornament {
  name: string;
  level: number;
  source: SourceSpan;
}

export interface NoteElement {
  kind: "note";
  /** 0=休止，1–7=唱名，9=节奏音符（仅番茄；有谱的节奏音符是字母 X） */
  pitch: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 9;
  sound: "note" | "rest" | "rhythm";
  /** 隐藏音符：占位不显形。番茄 `8`；有谱 `8`（跟词）/ `9`（不跟词） */
  hidden: boolean;
  /** 隐藏音符是否仍参与歌词对位。有谱 `9` 为 false，其余隐藏音符为 true。 */
  lyricAnchor: boolean;
  /** 正数为高八度点个数，负数为低八度点 */
  octave: number;
  /** 时值分母：4=四分，8=八分…… */
  duration: number;
  dots: number;
  accidental?: Accidental;
  ornaments: Ornament[];
  graceBefore: NoteElement[];
  graceAfter: NoteElement[];
  /** 音符上方的双引号注释；`hx:` 开头的和弦另存 `chord` */
  annotation?: string;
  chord?: string;
  code: string;
  source: SourceSpan;
}

/** 增时线 `-`：延长前一个音符一拍。 */
export interface SustainElement {
  kind: "sustain";
  duration: 4;
  /** 增时线默认不跟歌词；写成 `-@` 时置 true（有谱的「特殊情况要跟歌词的，后面加 @」）。 */
  lyricAnchor: boolean;
  ornaments: Ornament[];
  annotation?: string;
  code: string;
  source: SourceSpan;
}

export type BarlineType =
  | "normal" // |
  | "end" // 番茄 || （左细右粗）/ 有谱 |||
  | "double" // 番茄 ||/ （两边细）/ 有谱 ||
  | "repeat-start" // |:
  | "repeat-end" // :|
  | "repeat-both" // :|:
  | "hidden" // |/ 不显形也不占宽
  | "invisible"; // |* 不显形但占宽

export interface BarlineElement {
  kind: "barline";
  type: BarlineType;
  /** 小节线上的 `&fine` `&dc` `&ds` `&ty` `&hs` `&sbf` */
  ornaments: Ornament[];
  /** 小节线注释里的 `p:x/x` 临时拍号 */
  temporaryMeter?: Meter;
  annotation?: string;
  code: string;
  source: SourceSpan;
}

/** `~` 强制把前后音符连在一拍内；`^` 强制切开。只影响减时线的连断。 */
export interface BeatBoundaryElement {
  kind: "beat-boundary";
  behavior: "join" | "split";
  code: "~" | "^";
  source: SourceSpan;
}

/** `{bz…}` 临时伴奏 / `{dsb…}` 临时多声部：画在主旋律上方的小字号行。 */
export interface InlineLayerElement {
  kind: "inline-layer";
  role: "accompaniment" | "voice";
  elements: MusicElement[];
  marks: Mark[];
  code: string;
  source: SourceSpan;
}

export type MusicElement =
  | NoteElement
  | SustainElement
  | BarlineElement
  | BeatBoundaryElement
  | InlineLayerElement;

export type MarkType = "slur" | "tuplet" | "crescendo" | "decrescendo" | "volta";

/**
 * 跨若干元素的记号。`start`/`end` 是行内元素下标（闭区间）。
 * `level` 为嵌套层数（弧线可嵌套）或 `+` 抬高级别（渐强渐弱、跳房子）。
 */
export interface Mark {
  type: MarkType;
  start: number;
  end: number;
  level: number;
  /** 跳房子的房号文字 */
  caption?: string;
  /** 跳房子 `]/`（有谱）/ `[…/`（番茄）：右侧不封口 */
  openEnd?: boolean;
  /** 弧线跨行：本行只有收尾 / 只有起头 */
  continuationFromPrevious?: boolean;
  continuationToNext?: boolean;
  source: SourceSpan;
}

export interface LyricSyllable {
  /** 空串表示「跳过一个音符」（`@` 或有谱的 `/`） */
  text: string;
  /** 跟在字后的标点，排版时不占音符位 */
  trailingPunctuation?: string;
  source: SourceSpan;
}

export interface LyricLine {
  /** 段号区间起点：`C1:` → 1；`C1-2:` → 1；裸 `C:` 依出现顺序编号 */
  verseFrom: number;
  /** 段号区间终点：`C1-2:` → 2；单段时与 verseFrom 相同 */
  verseTo: number;
  /** 歌词前的说明文字（番茄 `"…"`；有谱 `<狼:1.%40>`） */
  annotation?: string;
  /** 说明文字与歌词之间的间隙，单位为字宽百分比（有谱 `%50`），默认 20 */
  annotationGap: number;
  syllables: LyricSyllable[];
  /** 行末的 `}`：把相邻几段歌词括在一起的联合括号（尚未绘制） */
  joinBrace?: boolean;
  source: SourceSpan;
}

/** 一行曲（`Q:` / `Q1:`），连同挂在它下面的歌词行。 */
export interface ScoreLine {
  /** 声部号：裸 `Q:` 为 1 */
  voice: number;
  /** `Q!:` / `Q-:` 这类变体的后缀原文（语义未见于手册，保留以便日后处置） */
  variant?: "!" | "-" | "+";
  /** 声部名：番茄 `Q1"女高"` / 有谱 `Q1<女高>` */
  caption?: string;
  elements: MusicElement[];
  marks: Mark[];
  lyrics: LyricLine[];
  raw: string;
  source: SourceSpan;
}

/** 说明性文字行（有谱 `W:`），排在其后那组曲行的上方。 */
export interface TextLine {
  text: string;
  source: SourceSpan;
}

/** 一组同时发声的声部（`Q1`/`Q2`/`Q3` 相邻成组），排版时上下堆叠并横向对齐。 */
export interface VoiceGroup {
  index: number;
  /** 本组之前的 `W:` 文字行 */
  texts: TextLine[];
  voices: ScoreLine[];
}

export interface ScorePage {
  index: number;
  groups: VoiceGroup[];
}

/** 一首曲子：自带头部与页面。有谱用整行 `-----` 分隔同一文件里的多个唱法。 */
export interface PuSong {
  index: number;
  metadata: Metadata;
  pages: ScorePage[];
}

export interface PuDoc {
  dialect: Dialect;
  source: string;
  songs: PuSong[];
  diagnostics: Diagnostic[];
}

/** 便捷：第一首的头部（绝大多数文件只有一首）。 */
export function primaryMetadata(doc: PuDoc): Metadata {
  return doc.songs[0]?.metadata ?? emptyMetadata();
}

export function emptyMetadata(): Metadata {
  return {
    titles: [],
    authors: [],
    meters: [],
    tempos: [],
    topLeft: [],
    topRight: [],
    bottomLeft: [],
    bottomCenter: [],
    bottomRight: [],
    fontSizes: [],
    margins: [],
    options: [],
    remarks: [],
  };
}

/** 遍历文档里所有音符（按行序），供对位、转换、验证使用。 */
export function* eachNote(doc: PuDoc): Generator<NoteElement> {
  for (const song of doc.songs) {
  for (const page of song.pages) {
    for (const group of page.groups) {
      for (const voice of group.voices) {
        yield* eachNoteInElements(voice.elements);
      }
    }
  }
  }
}

export function* eachNoteInElements(elements: readonly MusicElement[]): Generator<NoteElement> {
  for (const el of elements) {
    if (el.kind === "note") yield el;
    else if (el.kind === "inline-layer") yield* eachNoteInElements(el.elements);
  }
}
