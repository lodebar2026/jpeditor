// 简谱排版引擎（`layout/`）的**输入接口**：引擎实际读到的字段，一个不多。
//
// 引擎只读不写（断句落下的换行由排版之前的那一步插进 `entries`，见 `score/applybreaks.ts`）。
// 输入由 `ScoreDoc` 投影出来（`model/jianpuinput.ts`）；字段名沿用从 mp/score/score.kt 移植来的那一套。

import type { Fraction } from "../common/fraction";
import type { BarStyle, StartStopDiscontinue } from "../score/enums";
import { PlayData } from "../score/playorder";
import type { ElementId } from "../model/doc";

export interface JKey {
  fifths: number;
}

export interface JTime {
  beats: number;
  beatType: number;
}

export interface JLyric {
  text: string;
  number: number;
  /** 副歌共用：任何一段都取它 */
  refrain: boolean;
}

/** 印在音符上方的表情/跳转记号。 */
export interface JDirection {
  /** 要排的字：文字记号是原文（`rit.`），力度记号是 Bravura 字形串。 */
  text: string;
  /** 走乐谱字体（力度记号）还是文本字体（`rit.` / `Fine` / `D.S.`）。 */
  music: boolean;
  /** 原文标的斜体。 */
  italic: boolean;
  /** 记号写在小节**最后一个音符之后**（`Fine` / `D.S.`），贴着小节线右对齐排。 */
  atBarEnd?: boolean;
}

export interface JNote {
  chord: JChord;
  number: string;
  jpOctave: number;
  /** `b` / `n` / `#`，空格 = 无记号 */
  jpAlter: string;
  lyrics: JLyric[];
  tieStart: boolean;
  tieEnd: boolean;
  tieNext: JNote | null;
  tiePrev: JNote | null;
  tupletBegin: boolean;
  tupletEnd: boolean;
  tuplet: { first: JNote; last: JNote } | null;
}

/** 倚音：只画数字、八度点与记号。 */
export interface JGrace {
  number: string;
  jpOctave: number;
  jpAlter: string;
}

export interface JChord {
  readonly kind: "chord";
  /** 谱面元素 id：点选、试听高亮、断句量宽都按它认。 */
  id: ElementId | null;
  measure: JMeasure;
  position: Fraction;
  duration?: Fraction;
  notes: JNote[];
  dot: number;
  /** 减时线条数 */
  beams: number;
  /** 增时线：占几拍（1 = 无增时线） */
  beats: number;
  rest: boolean;
  slurStart: boolean;
  /** 本和弦收几条弧（嵌套双弧在末音同时收两条） */
  slurEnds: number;
  slurEndChord: JChord | null;
  fermata: boolean;
  harmony: string | null;
  sectionWord: string | null;
  directions: JDirection[];
  articulations: string[];
  graceNotes: JGrace[];
}

export interface JBreak {
  readonly kind: "break";
  position: Fraction;
  newPage: boolean;
  /** 只在第几遍生效（`null` = 每遍） */
  pass: number | null;
}

export interface JBarline {
  readonly kind: "bar";
  position: Fraction;
}

export type JEntry = JChord | JBreak | JBarline;

export interface JMeasure {
  index: number;
  position: Fraction;
  entries: JEntry[];
  key: JKey;
  time: JTime;
  keyChange: boolean;
  timeChange: boolean;
  leftBarline: BarStyle | null;
  barline: BarStyle | null;
  repeatForward: boolean;
  repeatBackward: boolean;
  endingLeft: boolean;
  endingNum: Set<number> | null;
  endingText: string | null;
  endingRight: StartStopDiscontinue | null;
}

export interface JCredit {
  type: string | null;
  text: string;
  page: number;
}

export interface JScore {
  parts: { measures: JMeasure[] }[];
  title: string;
  credit: JCredit[];
  playData: PlayData;
}

/** 小节时长：最后一个和弦的止点。 */
export function measureDuration(m: JMeasure): Fraction {
  for (let i = m.entries.length - 1; i >= 0; i--) {
    const e = m.entries[i];
    if (e.kind === "chord") return e.position.plus(e.duration!);
  }
  throw new Error("measure has no chord");
}

/** 空谱：排版器还没装谱时的占位。 */
export function emptyScore(): JScore {
  return { parts: [], title: "", credit: [], playData: new PlayData() };
}

/** 去掉原谱的全部换行（量「自然排下来有多宽」、量一行放得下几格时用）。改的是调用方手里那份输入。 */
export function clearBreaks(score: JScore): void {
  for (const p of score.parts) for (const m of p.measures) m.entries = m.entries.filter((e) => e.kind !== "break");
}
