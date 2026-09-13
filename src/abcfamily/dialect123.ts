// 123 方言的音乐体：**唯一偏离 ABC 之处**（规范 §4）。
//
// 与 ABC 的两处硬冲突（必须记住）：
//   `-` 在 ABC 是 tie，在 123 是**增时线**（加一拍）
//   `_` 在 ABC 是降号，在 123 是**减时线**（时值减半）
// 所以 123 的音乐体不是合法 ABC 音乐体——这是方言的代价，也是唯一的代价。
//
// 符杠分组**由空白决定**（沿用 ABC §4.7），不设 `~`/`^` 这类控制符——那在基类里。

import type { Accidental } from "../model/doc";
import { AbcFamilyLexer } from "./lex";
import type { DurationScan, NoteScan } from "./types";

const ACCIDENTALS: Readonly<Record<string, Accidental>> = {
  "#": "sharp",
  b: "flat",
  n: "natural",
  "##": "double-sharp",
  bb: "double-flat",
};

export class Lexer123 extends AbcFamilyLexer {
  readonly id = "123" as const;
  /** `-` 是增时线，加一拍。 */
  protected readonly hyphen = "sustain" as const;
  /** 音符是数字，裸 `(3` 与「圆滑线 + 音符 3」冲突，所以冒号必需。 */
  protected readonly tupletNeedsColon = true;

  /** 123 的休止是 `0`，当成 degree 0 的音符走 `scanNote`，这里不单独认。 */
  protected scanRest(): DurationScan | null {
    return null;
  }

  /** 时值修饰：`_` 减时线（可多条）与 `.` 附点（可多个），两者可交替出现。 */
  protected scanDuration(line: string, i: number): DurationScan | null {
    let beams = 0;
    let dots = 0;
    let j = i;
    while (j < line.length) {
      if (line[j] === "_") {
        beams++;
        j++;
      } else if (line[j] === ".") {
        dots++;
        j++;
      } else break;
    }
    if (j === i) return null;
    return { beams, dots, next: j };
  }

  /** 音符：`[#b n]数字['`,]*[_.]*`。变音记号**前置**（简谱惯例，与 ABC 的 `^_=` 不同）。 */
  protected scanNote(line: string, i: number): NoteScan | null {
    let j = i;
    let accidental: Accidental | undefined;
    // 双升降先试（`##4` / `bb7`）
    const two = line.slice(j, j + 2);
    if (ACCIDENTALS[two] && /[0-7]/.test(line[j + 2] ?? "")) {
      accidental = ACCIDENTALS[two];
      j += 2;
    } else {
      const one = line[j]!;
      if (ACCIDENTALS[one] && /[0-7]/.test(line[j + 1] ?? "")) {
        accidental = ACCIDENTALS[one];
        j += 1;
      }
    }
    const d = line[j];
    if (d === undefined || !/[0-7]/.test(d)) return null;
    const degree = Number(d);
    j++;
    // 八度点
    let octave = 0;
    while (j < line.length) {
      if (line[j] === "'") {
        octave++;
        j++;
      } else if (line[j] === ",") {
        octave--;
        j++;
      } else break;
    }
    const dur = this.scanDuration(line, j);
    const res: NoteScan = {
      degree,
      octave,
      beams: dur?.beams ?? 0,
      dots: dur?.dots ?? 0,
      next: dur?.next ?? j,
    };
    if (accidental) res.accidental = accidental;
    return res;
  }
}

/** 单例——词法器无状态。 */
export const LEXER_123 = new Lexer123();
