// 标准 ABC 方言的写出端（ABC 2.1）。只回答基类问的那几个问题，其余全在 `emit.ts`。
//
// **默认音长固定写 `L:1/8`**：写出端要幂等，就不能让默认音长随内容浮动——
// 同一份 `ScoreDoc` 第二次写出必须逐字相同。读入端照样认任意 `L:`。

import type { Chord, Element, Key, Note } from "../model/doc";
import { AbcFamilyEmitter } from "./emit";
import { DIVISIONS } from "./parsedialect";
import { keySpelling } from "../model/jianpu";

/** 写出端固定的默认音长：八分音符。 */
const UNIT = DIVISIONS / 2;

/** 前置变音记号。 */
const ACC_TEXT: Readonly<Record<string, string>> = {
  sharp: "^",
  flat: "_",
  natural: "=",
  "double-sharp": "^^",
  "double-flat": "__",
};

/** 最大公约数——时值分数要约分，否则 `4/8` 与 `1/2` 会在往返里来回变形。 */
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** divisions → 相对 `L:1/8` 的时值后缀：`""`(=1) / `2` / `/2` / `3/2`。 */
function lengthSuffix(divisions: number): string {
  if (divisions <= 0) return "";
  let num = divisions;
  let den = UNIT;
  const g = gcd(num, den) || 1;
  num /= g;
  den /= g;
  if (num === 1 && den === 1) return "";
  if (num === 1 && den === 2) return "/";
  if (den === 1) return String(num);
  return `${num}/${den}`;
}

export class EmitterAbc extends AbcFamilyEmitter {
  protected readonly versionLine = "%abc-2.1";

  /** 音名 + 八度：第 4 八度大写、第 5 八度小写，再往外用 `'` 与 `,`（ABC §4.1）。 */
  protected noteText(n: Note): string {
    const p = n.pitch;
    if (!p) {
      // 只有简谱度数、没有绝对音高——写不出 ABC 音名，留给调用方报降级
      return n.degree ? "C" : "";
    }
    let s = n.accidental ? ACC_TEXT[n.accidental] ?? "" : "";
    const oct = p.octave;
    s += oct >= 5 ? p.step.toLowerCase() : p.step;
    if (oct > 5) s += "'".repeat(oct - 5);
    else if (oct < 4) s += ",".repeat(4 - oct);
    return s;
  }

  /** `z` 带时值；不可见休止用 ABC 的 `x`（invisible rest）。 */
  protected restText(ch: Chord): string {
    return ch.printObject === false ? "x" : "z";
  }

  protected durationText(el: Element): string {
    const dur = el.kind === "chord" ? el.duration : el.duration;
    return dur ? lengthSuffix(dur.divisions) : "";
  }

  /** tie 的 start 端写 `-`（ABC §4.11）。 */
  protected override tieText(ch: Chord): string {
    return ch.notes.some((n) => n.tie?.start) ? "-" : "";
  }

  /** ABC 没有「节奏音符」，退化成一个不发音高的 `x`——比丢掉强，且时值对得上。 */
  protected override rhythmText(): string {
    return "x";
  }

  protected override headerExtra(): string[] {
    return ["L:1/8"];
  }

  /** 同时发声的几个音包进 `[]`（ABC §4.17）。单音不包——包了读回来也对，但不幂等。 */
  protected override chordGroupText(inner: string, noteCount: number): string {
    return noteCount > 1 ? `[${inner}]` : inner;
  }

  /** ABC 的多连音不要冒号（音符是字母，`(3` 无歧义）。 */
  protected override tupletText(actual: number, normal: number): string {
    return normal === 2 ? `(${actual}` : `(${actual}:${normal}:${actual}`;
  }

  /** 拉丁词必须空格分开，否则读回来粘成一个音节。 */
  protected override readonly lyricSeparator = " ";

  /** ABC §5.1 的跳音符。 */
  protected override readonly lyricSkip = "*";

  /** ABC 默认「代码换行即谱面换行」（§6.1），所以写真换行而不是 123 的 `$`。
   *  换页 ABC 没有对应记号，退化成换行。 */
  protected override breakText(): string {
    return "\n";
  }

  protected override readonly trailingBreak = false;

  /** `{/g}` 短倚音（acciaccatura，ABC §4.12）。 */
  protected override graceSlashText(ch: Chord): string {
    return ch.grace?.slash ? "/" : "";
  }

  /** 音名调号。带 mode 的（`Em`）照 ABC 写法还原。 */
  protected keyValue(k: Key): string {
    if (k.spelling === "none") return "none";
    // 123 那侧的拼写是前置形（`bB`/`#F`），ABC 是后置形（`Bb`/`F#`）
    const sp = keySpelling(k, "mode").replace(/^([#b])([A-G])$/, "$2$1");
    const mode = k.mode && k.mode !== "major" && k.mode !== "ionian" ? k.mode.slice(0, 3) : "";
    return sp + (mode === "min" ? "m" : mode);
  }
}

export const EMITTER_ABC = new EmitterAbc();
