// 断句的输入形状。
//
// `phrase.ts` / `applybreaks.ts` 只经这组接口读谱。实现由 `ScoreDoc` 拼：MusicXML 形状 `model/phrasedoc.ts`、
// 简谱形状 `pu/phrasesong.ts`；断点集合与 `FitMetric.spans` 以拼出的对象为键，`idOf` 把它们换回元素 id
// （写回简谱引擎输入、回原文都按 id）。字段名与简谱引擎输入（`layout/input.ts`）同一套。

import type { Fraction } from "../common/fraction";
import type { BarStyle, StartStopDiscontinue } from "./enums";

export interface PhraseLyric {
  readonly text: string;
  readonly number: number;
  readonly refrain: boolean;
}

export interface PhraseNote {
  /** 唱名 "0"–"7" */
  readonly number: string;
  readonly jpOctave: number;
  readonly tieStart: boolean;
  readonly tieEnd: boolean;
  readonly lyrics: readonly PhraseLyric[];
}

export interface PhraseChord {
  /** 区分小节里的和弦与其它条目（小节线、换行）。和弦有、别的条目没有。 */
  readonly notes: readonly PhraseNote[];
  readonly rest: boolean;
  /** 增时线格数（含本音，1 起） */
  readonly beats: number;
  /** 减时线条数 */
  readonly beams: number;
  readonly dot: number;
  readonly duration?: Fraction;
  /** 小节内位置（四分音符为 1） */
  readonly position: Fraction;
  readonly fermata: boolean;
  readonly slurStart: boolean;
  readonly slurEnds: number;
}

export interface PhraseMeasure {
  /** 和弦与其它条目混排；断句只取 `isPhraseChord` 为真的那些。 */
  readonly entries: readonly object[];
  readonly barline: BarStyle | null;
  readonly repeatBackward: boolean;
  readonly repeatForward: boolean;
  readonly keyChange: boolean;
  readonly endingLeft: boolean;
  readonly endingRight: StartStopDiscontinue | null;
  readonly sectionMark: string | null;
}

export interface PhrasePart {
  readonly measures: readonly PhraseMeasure[];
}

export function isPhraseChord(e: object): e is PhraseChord {
  return "notes" in e && "slurEnds" in e;
}

export function chordsOf(m: PhraseMeasure): PhraseChord[] {
  return m.entries.filter(isPhraseChord);
}

// 段落词（流行/敬拜谱常见的段落方框标记）。`<words>` 也用于表情记号(rit./dolce)，故只认这些词，
// 免把普通文字当段落；`<rehearsal>` 本就是排练/段落记号，一律收下。
export const SECTION_WORD_RE =
  /^(intro|verse|chorus|pre-?chorus|bridge|coda|outro|ending|interlude|solo|refrain|tag|前奏|主歌|副歌|间奏|尾奏|尾声|桥段|插曲)\s*\d*$/i;
