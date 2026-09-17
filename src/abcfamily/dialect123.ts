// 123 方言的音乐体：**唯一偏离 ABC 之处**（规范 §4）。
//
// 与 ABC 的两处硬冲突（必须记住）：
//   `-` 在 ABC 是 tie，在 123 是**增时线**（加一拍）
//   `_` 在 ABC 是降号，在 123 是**减时线**（时值减半）
// 所以 123 的音乐体不是合法 ABC 音乐体——这是方言的代价，也是唯一的代价。
//
// 符杠**按拍自动算**，空白不表示分组（偏离 ABC §4.7，见 `ParseDialect.spaceBeams`）。

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

/** 不带引号的和弦名（规范 §8.1）：根音 + 性质/延伸 + 可选低音。
 *  写出端拿它决定能不能省引号（`emit123.ts`），所以**不能放进空白、引号、`%`**——读回时按「到空白为止」切。 */
export const BARE_CHORD_RE = /^[A-G][#b]?[A-Za-z0-9#+\-°ø()]*(?:\/[A-G][#b]?)?$/;

export class Lexer123 extends AbcFamilyLexer {
  readonly id = "123" as const;
  /** `-` 是增时线，加一拍。 */
  protected readonly hyphen = "sustain" as const;
  /** 音符是数字，裸 `(3` 与「圆滑线 + 音符 3」冲突，所以冒号必需。 */
  protected readonly tupletNeedsColon = true;

  /** 不带引号的和弦：**大写 A–G 开头、读到空白为止、后面必须跟空格**。
   *  123 音乐体里 A–G 没有别的用处（音符是数字、节奏音符是 `X`、行内字段以 `[` 起头），不会撞。
   *  到空白为止是为了切得开：`G71`、`Bb3` 这种粘连读不出是 `G7`+`1` 还是 `B`+`b3`。 */
  protected override scanBareChord(line: string, i: number): { len: number; error?: string } | null {
    if (!/[A-G]/.test(line[i] ?? "")) return null;
    let j = i + 1;
    while (j < line.length && line[j] !== " " && line[j] !== "\t") j++;
    const body = line.slice(i, j);
    const res: { len: number; error?: string } = { len: j - i };
    if (j >= line.length) res.error = `和弦 \`${body}\` 后面必须跟空格和它所属的音符`;
    else if (!BARE_CHORD_RE.test(body)) res.error = `看不懂的和弦名 \`${body}\`（不合规的名字请加引号）`;
    return res;
  }

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
