// 标准 ABC 方言的音乐体（ABC 2.1 §4）。与 123 的差别只在这个文件里：
//
// | | 123 | ABC |
// |---|---|---|
// | 音符 | 调内度数 `1`–`7` | 绝对音名 `A`–`G` / `a`–`g`（大写低八度、小写高八度） |
// | 变音 | 前置 `#` `b` `n` | 前置 `^` `_` `=`（可叠两个） |
// | 时值 | `_` 减时线、`.` 附点（相对） | `2` `/2` `3/2` 分数（相对 `L:`） |
// | `-` | 增时线（加一拍） | **tie**（延音线） |
// | 休止 | `0` | `z`（带时值）/ `Z`（整小节数） |
// | 多连音 | `(3: … )` 冒号与 `)` 都必需 | `(3` 按个数收尾（§4.13） |
// | 休止跟词 | 可见休止不占对位格，`x` 占 | 休止、`x` 都不占（§5.1） |
// | 同时发声 | 另起声部 | `[CEG]` 方括号和弦 |
//
// 单字符装饰（`.` 断音、`~` 回音、`H`–`W` 那一串）也是 ABC 独有：**大写 H–W 是装饰不是音符**，
// 所以 `scanNote` 只认 `A`–`G` / `a`–`g`。

import type { Accidental } from "../model/doc";
import { AbcFamilyLexer } from "./lex";
import type { DurationScan, NoteScan, Token } from "./types";

/** 前置变音记号（ABC §4.2）。**按从长到短**匹配。 */
const ACCIDENTALS: ReadonlyArray<readonly [string, Accidental, number]> = [
  ["^^", "double-sharp", 2],
  ["__", "double-flat", -2],
  ["^", "sharp", 1],
  ["_", "flat", -1],
  ["=", "natural", 0],
];

/** 单字符装饰（ABC §4.14 的 shorthand）。`.`=staccato、`~`=roll、`u`/`v`=弓法，
 *  再加 `H`–`W` 这一串保留字母。**不含 `X`/`Y`/`Z`**：`Z` 是整小节休止。 */
const SHORTHAND: Readonly<Record<string, string>> = {
  ".": "staccato",
  "~": "roll",
  u: "upbow",
  v: "downbow",
  H: "fermata",
  I: "I",
  J: "slide",
  K: "K",
  L: "accent",
  M: "lowermordent",
  N: "N",
  O: "coda",
  P: "uppermordent",
  Q: "Q",
  R: "roll",
  S: "segno",
  T: "trill",
  U: "U",
  V: "V",
  W: "W",
};

export class LexerAbc extends AbcFamilyLexer {
  readonly id = "abc" as const;
  /** `-` 是 tie。 */
  protected readonly hyphen = "tie" as const;
  /** ABC 的音符是字母，`(3` 无歧义，冒号可省。 */
  protected readonly tupletNeedsColon = false;
  /** `&` 是临时多声部分隔（§7.4）。 */
  protected override readonly voiceOverlay = true;
  protected override readonly strayBracketIsFinal = true;

  /** `z` 带时值、`Z` 按小节数（ABC §4.5/§4.6）。 */
  protected scanRest(line: string, i: number): DurationScan | null {
    const ch = line[i];
    if (ch !== "z" && ch !== "Z") return null;
    const dur = this.scanDuration(line, i + 1);
    return {
      beams: 0,
      dots: 0,
      num: dur?.num ?? 1,
      den: dur?.den ?? 1,
      next: dur?.next ?? i + 1,
    };
  }

  /** 时值：`2`（×2）、`/`（÷2）、`/4`（÷4）、`3/2`（×1.5）。相对 `L:` 的默认音长。 */
  protected scanDuration(line: string, i: number): DurationScan | null {
    const m = /^(\d*)(\/+)?(\d*)/.exec(line.slice(i));
    if (!m || m[0].length === 0) return null;
    const num = m[1] ? Number(m[1]) : 1;
    let den = 1;
    if (m[2]) {
      // `/` = ÷2，`//` = ÷4，依此类推；`/n` = ÷n
      den = m[3] ? Number(m[3]) : 1 << m[2].length;
    }
    if (den === 0) den = 1;
    return { beams: 0, dots: 0, num, den, next: i + m[0].length };
  }

  /** 音符：`[^_=]*字母['`,]*[时值]`。大写 = 低八度（C4 起），小写 = 高八度（c5 起）。 */
  protected scanNote(line: string, i: number): NoteScan | null {
    let j = i;
    let accidental: Accidental | undefined;
    let alter: number | undefined;
    for (const [text, acc, semi] of ACCIDENTALS) {
      if (line.startsWith(text, j)) {
        accidental = acc;
        alter = semi;
        j += text.length;
        break;
      }
    }
    const ch = line[j];
    if (ch === undefined || !/[A-Ga-g]/.test(ch)) return null;
    // 大写在第 4 八度、小写在第 5 八度（ABC §4.1）
    let octave = /[a-g]/.test(ch) ? 1 : 0;
    const step = ch.toUpperCase();
    j++;
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
      step,
      octave,
      beams: 0,
      dots: 0,
      num: dur?.num ?? 1,
      den: dur?.den ?? 1,
      next: dur?.next ?? j,
    };
    if (accidental) res.accidental = accidental;
    if (alter !== undefined) res.alter = alter;
    return res;
  }

  protected override shorthandDecoration(
    line: string,
    i: number,
  ): { len: number; name: string } | null {
    const ch = line[i]!;
    const name = SHORTHAND[ch];
    return name ? { len: 1, name } : null;
  }

  /** `[CEG]` 同时发声的和弦（ABC §4.17）。基类已先判掉 `[K:…]`、`[1`、`[|`，剩下的才轮到这里。 */
  protected override scanChordGroup(
    line: string,
    i: number,
  ): { text: string; notes: NoteScan[]; dur: DurationScan | null } | null {
    if (line[i] !== "[") return null;
    const close = line.indexOf("]", i);
    if (close < 0) return null;
    const body = line.slice(i + 1, close);
    if (body.length === 0) return null;
    const notes: NoteScan[] = [];
    let k = 0;
    while (k < body.length) {
      const n = this.scanNote(body, k);
      if (!n) return null; // 里面有不是音符的东西，就不是和弦
      notes.push(n);
      k = n.next;
    }
    if (notes.length === 0) return null;
    return { text: line.slice(i, close + 1), notes, dur: this.scanDuration(line, close + 1) };
  }

  /** 破碎节奏 `>` / `<`（ABC §4.4）：`a>b` = 前音附点、后音减半。 */
  protected override scanBroken(line: string, i: number): { len: number; dir: number } | null {
    const m = /^(>+|<+)/.exec(line.slice(i));
    if (!m) return null;
    return { len: m[0].length, dir: m[0][0] === ">" ? m[0].length : -m[0].length };
  }
}

/** 单例——词法器无状态。 */
export const LEXER_ABC = new LexerAbc();

/** 倚音 token 里的音符（ABC 的 `{ab}`）。 */
export type GraceNotes = Token[];
