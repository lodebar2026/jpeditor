// 123 音乐体的词法扫描：一行音乐代码 → token 流。
//
// 规范见 `docs/格式/123格式.md` §4。**与 ABC 的两处硬冲突**（必须记住）：
//   `-` 在 ABC 是 tie，在 123 是**增时线**（加一拍）
//   `_` 在 ABC 是降号，在 123 是**减时线**（时值减半）
// 所以 123 的音乐体不是合法 ABC 音乐体——这是方言的代价，也是唯一的代价。
//
// 符杠分组**由空白决定**（沿用 ABC §4.7：「To group notes together under one beam they must be
// grouped together without spaces」），不设 `~`/`^` 这类控制符。反引号 `` ` `` 在组内只为可读性，
// 扫描时直接丢掉。
//
// 这里只做词法（切 token、记位置），语义（时值累计、符杠分组号、Mark 配对）归 `parse.ts`。

import type { Accidental, SourceSpan } from "../model/doc";

export type TokenKind =
  | "note"        // 1-7 / 0（休止）
  | "spacer"      // y（无时值占位）/ x（不可见休止）
  | "rhythm"      // X（节奏音符：有声无音高）
  | "sustain"     // - 增时线
  | "barline"     // | || |] [| |: :| :: |:: ::| .| [|]
  | "ending"      // [1 / [1,3 / [1-3 / |1 / :|2
  | "slurStart"   // (
  | "slurEnd"     // )
  | "tuplet"      // (3
  | "grace"       // {6,}
  | "deco"        // !fermata! / !mf! / !D.S.!
  | "chord"       // "Am7"
  | "annotation"  // "^rit." / "_text"
  | "inlineField" // [K:G] / [M:3/4] / [I:style …]
  | "break"       // $ 换行 / $$ 换页
  | "space"       // 空白（符杠分组的依据，**不能丢**）
  | "unknown";

export interface Token {
  kind: TokenKind;
  /** 原文 */
  text: string;
  source: SourceSpan;
  // ── note 专用 ──
  /** 唱名 0..7 */
  degree?: number;
  /** 八度点：正高负低 */
  octave?: number;
  accidental?: Accidental;
  /** 减时线条数（`_` 个数） */
  beams?: number;
  /** 附点个数 */
  dots?: number;
  // ── 其它专用 ──
  /** barline：归一后的样式名；ending：房号列表；tuplet：几连音 */
  value?: string;
  numbers?: number[];
  /** 反复次数（`|::` = 3 遍） */
  repeatTimes?: number;
  /** grace：倚音的音符 token */
  notes?: Token[];
}

/** 小节线写法 → 归一名。**按从长到短匹配**，否则 `||` 永远匹配不到。
 *  `[|]` 是不可见小节线——与 `.jpwabc` 和 ABC 都同形同义（语料 3.2%）。 */
const BARLINES: ReadonlyArray<readonly [string, string]> = [
  ["[|]", "none"],
  ["|::", "heavy-light:3"],
  ["::|", "light-heavy:3"],
  [":|:", "repeat-both"],
  ["::", "repeat-both"],
  ["|:", "repeat-start"],
  [":|", "repeat-end"],
  ["|]", "final"],
  ["[|", "reverse-final"],
  ["||", "double"],
  [".|", "dotted"],
  ["|", "normal"],
];

const ACCIDENTALS: Readonly<Record<string, Accidental>> = {
  "#": "sharp",
  b: "flat",
  n: "natural",
  "##": "double-sharp",
  bb: "double-flat",
};

export interface LexResult {
  tokens: Token[];
  errors: { message: string; source: SourceSpan }[];
}

/**
 * 扫一行音乐体。
 * @param line 行文本（不含字段前缀）
 * @param lineNo 0 基行号
 * @param lineOffset 该行在全文里的 0 基偏移
 * @param columnBase 行内起始列（字段前缀的长度）
 */
export function lexMusicLine(
  line: string,
  lineNo: number,
  lineOffset: number,
  columnBase = 0,
): LexResult {
  const tokens: Token[] = [];
  const errors: LexResult["errors"] = [];
  let i = 0;

  const span = (col: number, len: number): SourceSpan => ({
    line: lineNo,
    column: columnBase + col,
    offset: lineOffset + columnBase + col,
    length: len,
  });
  const push = (t: Omit<Token, "source"> & { source?: SourceSpan }, col: number, len: number): void => {
    tokens.push({ ...t, source: t.source ?? span(col, len) } as Token);
  };

  while (i < line.length) {
    const ch = line[i]!;
    const start = i;

    // 行内注释：`%` 到行尾（ABC 的注释符）
    if (ch === "%") break;

    // 空白——**是符杠分组的依据，必须成 token**
    if (ch === " " || ch === "\t") {
      while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
      push({ kind: "space", text: line.slice(start, i) }, start, i - start);
      continue;
    }
    // 反引号只为可读性，扫描时丢掉（ABC §4.7：「They are ignored by computer programs」）
    if (ch === "`") {
      i++;
      continue;
    }

    // 换行 / 换页
    if (ch === "$") {
      if (line[i + 1] === "$") {
        i += 2;
        push({ kind: "break", text: "$$", value: "page" }, start, 2);
      } else {
        i++;
        push({ kind: "break", text: "$", value: "line" }, start, 1);
      }
      continue;
    }

    // 增时线
    if (ch === "-") {
      i++;
      push({ kind: "sustain", text: "-" }, start, 1);
      continue;
    }

    // inline 字段 `[K:G]` / `[M:3/4]` / `[I:…]`（ABC §7.3；曲中转调转拍号原生支持）
    if (ch === "[" && /^\[[A-Za-z]\s*[:：]/.test(line.slice(i))) {
      const close = line.indexOf("]", i);
      if (close < 0) {
        errors.push({ message: "inline 字段缺 `]`", source: span(start, line.length - start) });
        i = line.length;
        continue;
      }
      const body = line.slice(i + 1, close);
      i = close + 1;
      push({ kind: "inlineField", text: line.slice(start, i), value: body }, start, i - start);
      continue;
    }

    // 房号 `[1` `[1,3` `[1-3` `[1,3,5-7`（ABC §4.9/§4.10）。**必须排在小节线之前**判，
    // 否则 `[|` 会先吃掉 `[`；反过来 `[|]`/`[|` 已在上面的 inline 判断后、这里之前轮到。
    if (ch === "[" && /^\[\d/.test(line.slice(i))) {
      const m = /^\[([\d,\-]+)/.exec(line.slice(i))!;
      const nums = expandEndingNumbers(m[1]!);
      i += m[0].length;
      push({ kind: "ending", text: m[0], numbers: nums }, start, m[0].length);
      continue;
    }
    // 紧贴小节线的简写房号 `|1` `:|2`（ABC §4.9：「When adjacent to bar lines, these can be
    // shortened to |1 and :|2」）——先出小节线 token，再出房号
    {
      const bl = matchBarline(line, i);
      if (bl) {
        i += bl.text.length;
        const [style, times] = splitBarlineValue(bl.value);
        const t: Omit<Token, "source"> = { kind: "barline", text: bl.text, value: style };
        if (times) t.repeatTimes = times;
        push(t, start, bl.text.length);
        const after = /^(\d[\d,\-]*)/.exec(line.slice(i));
        if (after) {
          const s2 = i;
          i += after[0].length;
          push({ kind: "ending", text: after[0], numbers: expandEndingNumbers(after[1]!) }, s2, after[0].length);
        }
        continue;
      }
    }

    // 多连音 `(3:`（ABC §4.13 的完整形 `(n:p:q` 的前缀）——必须排在圆滑线 `(` 之前。
    //
    // **冒号是必需的，这是 123 与 ABC 的一处刻意分歧**：ABC 允许简写 `(3`，因为它的音符是
    // 字母、`(3` 不会有歧义；而简谱音符是**数字**，`(1 2)` 既像「圆滑线 + 音符 1」又像
    // 「1 连音」。两个既有格式都回避了这个歧义（`.jpwabc` 写 `{(3}`、文本谱写 `(y3`），
    // 123 的办法是要求冒号：`(3:` 是三连音，`(3` 是圆滑线后接音符 3。
    if (ch === "(" && /^\(\d+:/.test(line.slice(i))) {
      // 完整形**必须两个冒号**（`(3:2:3`）。只支持 `(N:` 与 `(N:p:q` 两种，不支持 `(N:p`——
      // 否则 `(3:1 2 3` 里的 `:1` 会被当成 normal=1 而不是第一个音符。
      const m = /^\((\d+):(?:(\d+):(\d+))?/.exec(line.slice(i))!;
      i += m[0].length;
      const t: Omit<Token, "source"> = { kind: "tuplet", text: m[0], value: m[1] };
      if (m[2] && m[3]) t.numbers = [Number(m[1]), Number(m[2]), Number(m[3])];
      push(t, start, m[0].length);
      continue;
    }
    if (ch === "(") {
      i++;
      push({ kind: "slurStart", text: "(" }, start, 1);
      continue;
    }
    if (ch === ")") {
      i++;
      push({ kind: "slurEnd", text: ")" }, start, 1);
      continue;
    }

    // 装饰与记号 `!fermata!` `!mf!` `!D.S.!`（ABC §4.14）
    if (ch === "!") {
      const close = line.indexOf("!", i + 1);
      if (close < 0) {
        errors.push({ message: "装饰记号缺右 `!`", source: span(start, line.length - start) });
        i = line.length;
        continue;
      }
      const body = line.slice(i + 1, close);
      i = close + 1;
      push({ kind: "deco", text: line.slice(start, i), value: body }, start, i - start);
      continue;
    }

    // 和弦 `"Am7"` 与注记 `"^rit."` / `"_text"`（ABC §4.18/§4.19）
    if (ch === '"') {
      const close = line.indexOf('"', i + 1);
      if (close < 0) {
        errors.push({ message: "和弦/注记缺右引号", source: span(start, line.length - start) });
        i = line.length;
        continue;
      }
      const body = line.slice(i + 1, close);
      i = close + 1;
      const isAnno = /^[\^_<>@]/.test(body);
      push(
        { kind: isAnno ? "annotation" : "chord", text: line.slice(start, i), value: body },
        start,
        i - start,
      );
      continue;
    }

    // 倚音 `{6,}` `{57}`（ABC §4.12 的花括号倚音，内容换成简谱数字）
    if (ch === "{") {
      const close = line.indexOf("}", i);
      if (close < 0) {
        errors.push({ message: "倚音缺 `}`", source: span(start, line.length - start) });
        i = line.length;
        continue;
      }
      const body = line.slice(i + 1, close);
      const inner = lexMusicLine(body, lineNo, lineOffset, columnBase + i + 1);
      i = close + 1;
      push(
        { kind: "grace", text: line.slice(start, i), notes: inner.tokens.filter((t) => t.kind === "note") },
        start,
        i - start,
      );
      continue;
    }

    // 节奏音符 `X`（**大写**，有声无音高，同文本谱的 `X`）——小写 `x` 是不可见休止，两者有别
    if (ch === "X") {
      i++;
      const t: Omit<Token, "source"> = { kind: "rhythm", text: "X" };
      const mod = scanDuration(line, i);
      if (mod) { i = mod.next; t.beams = mod.beams; t.dots = mod.dots; }
      push(t, start, i - start);
      continue;
    }

    // 无时值占位 `y` / 不可见休止 `x`（沿用 ABC 的 spacer 与 invisible rest）
    if (ch === "y" || ch === "x") {
      i++;
      const t: Omit<Token, "source"> = { kind: "spacer", text: ch, value: ch };
      // `x` 占时值，可带时值修饰
      const mod = ch === "x" ? scanDuration(line, i) : null;
      if (mod) {
        i = mod.next;
        t.beams = mod.beams;
        t.dots = mod.dots;
      }
      push(t, start, i - start);
      continue;
    }

    // 音符：[变音]数字[八度点][时值]
    const note = scanNote(line, i);
    if (note) {
      i = note.next;
      push(
        {
          kind: "note",
          text: line.slice(start, i),
          degree: note.degree,
          octave: note.octave,
          ...(note.accidental ? { accidental: note.accidental } : {}),
          beams: note.beams,
          dots: note.dots,
        },
        start,
        i - start,
      );
      continue;
    }

    // 认不出来的字符——报一条、往前走一格，**不要停**（半截文本也要能给出大部分结果）
    i++;
    errors.push({ message: `认不出的记号 \`${ch}\``, source: span(start, 1) });
    push({ kind: "unknown", text: ch }, start, 1);
  }

  return { tokens, errors };
}

/** 房号列表展开：`1,3` → [1,3]；`1-3` → [1,2,3]；`1,3,5-7` → [1,3,5,6,7]。 */
export function expandEndingNumbers(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(",")) {
    const r = /^(\d+)-(\d+)$/.exec(part);
    if (r) {
      const a = Number(r[1]);
      const b = Number(r[2]);
      for (let k = Math.min(a, b); k <= Math.max(a, b); k++) out.push(k);
    } else if (/^\d+$/.test(part)) {
      out.push(Number(part));
    }
  }
  return out;
}

/** `heavy-light:3` → ["heavy-light", 3]；普通样式 → [style, undefined]。 */
function splitBarlineValue(v: string): [string, number | undefined] {
  const m = /^(.*):(\d+)$/.exec(v);
  if (!m) return [v, undefined];
  return [m[1]!, Number(m[2])];
}

function matchBarline(line: string, i: number): { text: string; value: string } | null {
  for (const [text, value] of BARLINES) {
    if (line.startsWith(text, i)) return { text, value };
  }
  return null;
}

interface DurationScan {
  beams: number;
  dots: number;
  next: number;
}

/** 时值修饰：`_` 减时线（可多条）与 `.` 附点（可多个），两者可交替出现。 */
function scanDuration(line: string, i: number): DurationScan | null {
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

interface NoteScan extends DurationScan {
  degree: number;
  octave: number;
  accidental?: Accidental;
}

/** 音符：`[#b n]数字['`,]*[_.]*`。变音记号**前置**（简谱惯例，与 ABC 的 `^_=` 不同）。 */
function scanNote(line: string, i: number): NoteScan | null {
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
  const dur = scanDuration(line, j);
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
