// ABC 家族音乐体的词法扫描**基类**：一行音乐代码 → token 流。
//
// 123 是 ABC 的方言，两者**只有音乐体的音符写法不同**（见 `docs/格式/123格式.md` §0）。
// 这个基类装的就是那些同源的部分：空白与反引号、行内注释、小节线族、房号、行内字段、
// 圆滑线、多连音、装饰记号、和弦与注记、倚音、占位符。方言只需回答四个问题：
//
//   1. 一个音符长什么样（`scanNote`）——123 是度数 `1-7`，ABC 是音名 `A-G`/`a-g`
//   2. 休止长什么样（`scanRest`）——123 是 `0`，ABC 是 `z`/`Z`
//   3. `-` 是什么（`hyphen`）——**123 是增时线、ABC 是 tie，这是两者的硬冲突之一**
//   4. 多连音要不要冒号（`tupletNeedsColon`）——123 必需（音符是数字，`(3` 有歧义），ABC 可省；
//      怎么收尾是组装期的事（`ParseDialect.tupletClose`：123 由 `)` 收，ABC 按个数）
//   5. 认不认不带引号的和弦（`scanBareChord`）——123 认（A–G 在它的音乐体里没被占用），ABC 不认
//
// 这里只做词法（切 token、记位置），语义（时值累计、符杠分组号、Mark 配对）归 `parse.ts`。

import type { SourceSpan } from "../model/doc";
import type { DurationScan, LexError, LexResult, NoteScan, Token } from "./types";

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
  // 落单的 `]`：规范里没有，但野外的 ABC 常用它收尾（`… z2]`）。`[|]`/`|]` 都已在前面匹配掉，
  // 和弦 `[CEG]`、行内字段 `[K:G]` 的 `]` 也早被各自的扫描吃掉了，所以走到这里的一定是收尾线。
  // **只在 ABC 那一档认**（`strayBracketIsFinal`）：这是给野外文件的容错，123 不背这个包袱。
  ["]", "final"],
];

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

function matchBarline(line: string, i: number, strayBracket: boolean): { text: string; value: string } | null {
  for (const [text, value] of BARLINES) {
    if (text === "]" && !strayBracket) continue;
    if (line.startsWith(text, i)) return { text, value };
  }
  return null;
}

export abstract class AbcFamilyLexer {
  /** 方言名（诊断与报表用）。 */
  abstract readonly id: "123" | "abc";

  // ────────── 方言钩子 ──────────

  /** 一个音符（含变音、八度、时值）。认不出返回 null。 */
  protected abstract scanNote(line: string, i: number): NoteScan | null;

  /** 一个休止。123 的 `0` 走 `scanNote`（degree 0），所以那一档返回 null。 */
  protected abstract scanRest(line: string, i: number): DurationScan | null;

  /** 时值修饰（给 `x` 这类占位符复用）。 */
  protected abstract scanDuration(line: string, i: number): DurationScan | null;

  /** `-` 的语义。**两种方言在这里硬冲突**。 */
  protected abstract readonly hyphen: "sustain" | "tie";

  /** 多连音是否要求冒号。 */
  protected abstract readonly tupletNeedsColon: boolean;

  /** 音乐体里的 `&` 是不是小节内临时多声部分隔（ABC §7.4 voice overlay）。123 没有这个记号。 */
  protected readonly voiceOverlay: boolean = false;

  /** 落单的 `]` 算不算收尾线（野外 ABC 的容错）。123 不认。 */
  protected readonly strayBracketIsFinal: boolean = false;

  /** 方言特有的单字符装饰（ABC 的 `.` `~` `H`–`W`）。不认返回 null。 */
  protected shorthandDecoration(line: string, i: number): { len: number; name: string } | null {
    void line;
    void i;
    return null;
  }

  /** 同时发声的和弦（ABC 的 `[CEG]`）。123 靠多声部表达，这一档没有。 */
  protected scanChordGroup(
    line: string,
    i: number,
  ): { text: string; notes: NoteScan[]; dur: DurationScan | null } | null {
    void line;
    void i;
    return null;
  }

  /** 不带引号的和弦（123 扩展：`Am7 1`）。ABC 里 A–G 是音名，这一档没有。
   *  返回和弦文本的长度与可选的诊断；**有诊断也照样当和弦**（半截文本也要给出大部分结果）。 */
  protected scanBareChord(line: string, i: number): { len: number; error?: string } | null {
    void line;
    void i;
    return null;
  }

  /** 破碎节奏（ABC 的 `>` / `<`）。123 用附点与减时线直接写，这一档没有。 */
  protected scanBroken(line: string, i: number): { len: number; dir: number } | null {
    void line;
    void i;
    return null;
  }

  // ────────── 共用扫描 ──────────

  /**
   * 扫一行音乐体。
   * @param line 行文本（不含字段前缀）
   * @param lineNo 0 基行号
   * @param lineOffset 该行在全文里的 0 基偏移
   * @param columnBase 行内起始列（字段前缀的长度）
   */
  lexLine(line: string, lineNo: number, lineOffset: number, columnBase = 0): LexResult {
    const tokens: Token[] = [];
    const errors: LexError[] = [];
    let i = 0;

    const span = (col: number, len: number): SourceSpan => ({
      line: lineNo,
      column: columnBase + col,
      offset: lineOffset + columnBase + col,
      length: len,
    });
    const push = (
      t: Omit<Token, "source"> & { source?: SourceSpan },
      col: number,
      len: number,
    ): void => {
      tokens.push({ ...t, source: t.source ?? span(col, len) } as Token);
    };

    while (i < line.length) {
      const ch = line[i]!;
      const start = i;

      // 行内注释：`%` 到行尾（ABC 的注释符）
      if (ch === "%") break;

      // 空白——**是 ABC 符杠分组的依据，必须成 token**（123 不用它分组，见 `ParseDialect.spaceBeams`）
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

      // 临时多声部分隔 `&`（ABC §7.4）：把音乐时间退回本小节起点，后面是与前一分支并行的声部。
      // **只认单个 `&`**：`&&`、`(& … &)` 这些 2.2 的跨行扩展还没实现，整体报不支持，
      // 不能按单个 `&` 误读成合法的一次分支切换。
      if (ch === "&" && this.voiceOverlay) {
        const run = /^&+/.exec(line.slice(i))![0];
        if (run.length > 1) {
          i += run.length;
          errors.push({ message: `尚未支持的多声部写法 \`${run}\``, source: span(start, run.length) });
          push({ kind: "unknown", text: run }, start, run.length);
          continue;
        }
        i++;
        push({ kind: "overlay", text: "&" }, start, 1);
        continue;
      }

      // `-`：123 的增时线 / ABC 的 tie
      if (ch === "-") {
        i++;
        push({ kind: this.hyphen, text: "-" }, start, 1);
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
        const bl = matchBarline(line, i, this.strayBracketIsFinal);
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
            push(
              { kind: "ending", text: after[0], numbers: expandEndingNumbers(after[1]!) },
              s2,
              after[0].length,
            );
          }
          continue;
        }
      }

      // 多连音——必须排在圆滑线 `(` 之前。
      //
      // **冒号在 123 里是必需的，这是与 ABC 的一处刻意分歧**：ABC 允许简写 `(3`，因为它的音符是
      // 字母、`(3` 不会有歧义；而简谱音符是**数字**，`(1 2)` 既像「圆滑线 + 音符 1」又像
      // 「1 连音」。两个既有格式都回避了这个歧义（`.jpwabc` 写 `{(3}`、文本谱写 `(y3`），
      // 123 的办法是要求冒号：`(3:` 是三连音，`(3` 是圆滑线后接音符 3。
      const tup = this.matchTuplet(line, i);
      if (tup) {
        i += tup.text.length;
        const t: Omit<Token, "source"> = { kind: "tuplet", text: tup.text, value: String(tup.n) };
        // `[n, p, q]`，0 表示没写（取默认）：ABC 的 `(3::2` 只给了 q
        if (tup.p !== undefined || tup.q !== undefined) t.numbers = [tup.n, tup.p ?? 0, tup.q ?? 0];
        push(t, start, tup.text.length);
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

      // 不带引号的和弦 `Am7 1`（123 扩展，规范 §8.1）：与 `"Am7"` 出同一种 token
      const bare = this.scanBareChord(line, i);
      if (bare) {
        const body = line.slice(i, i + bare.len);
        if (bare.error) errors.push({ message: bare.error, source: span(start, bare.len) });
        i += bare.len;
        push({ kind: "chord", text: body, value: body }, start, bare.len);
        continue;
      }

      // 倚音 `{6,}` `{57}`（ABC §4.12 的花括号倚音）
      if (ch === "{") {
        const close = line.indexOf("}", i);
        if (close < 0) {
          errors.push({ message: "倚音缺 `}`", source: span(start, line.length - start) });
          i = line.length;
          continue;
        }
        let body = line.slice(i + 1, close);
        let bodyAt = i + 1;
        // `{/g}` 是短倚音（acciaccatura，ABC §4.12）
        const acciaccatura = body.startsWith("/");
        if (acciaccatura) {
          body = body.slice(1);
          bodyAt += 1;
        }
        const inner = this.lexLine(body, lineNo, lineOffset, columnBase + bodyAt);
        i = close + 1;
        const t: Omit<Token, "source"> = {
          kind: "grace",
          text: line.slice(start, i),
          notes: inner.tokens.filter((x) => x.kind === "note"),
        };
        if (acciaccatura) t.acciaccatura = true;
        push(t, start, i - start);
        continue;
      }

      // 节奏音符 `X`（**大写**，有声无音高，同文本谱的 `X`）——小写 `x` 是不可见休止，两者有别。
      // ABC 里大写 X 是音名，故只在 123 那一档认；靠 `scanNote` 先手来区分。
      if (ch === "X" && this.id === "123") {
        i++;
        const t: Omit<Token, "source"> = { kind: "rhythm", text: "X" };
        const mod = this.scanDuration(line, i);
        if (mod) {
          i = mod.next;
          t.beams = mod.beams;
          t.dots = mod.dots;
        }
        push(t, start, i - start);
        continue;
      }

      // 无时值占位 `y` / 不可见休止 `x`（沿用 ABC 的 spacer 与 invisible rest）
      if (ch === "y" || ch === "x") {
        i++;
        const t: Omit<Token, "source"> = { kind: "spacer", text: ch, value: ch };
        // `x` 占时值，可带时值修饰
        const mod = ch === "x" ? this.scanDuration(line, i) : null;
        if (mod) {
          i = mod.next;
          t.beams = mod.beams;
          t.dots = mod.dots;
          if (mod.num !== undefined) t.num = mod.num;
          if (mod.den !== undefined) t.den = mod.den;
        }
        push(t, start, i - start);
        continue;
      }

      // 同时发声的和弦 `[CEG]`——基类已先判掉 `[K:…]`、`[1`、`[|`，剩下的才轮到它
      const cg = this.scanChordGroup(line, i);
      if (cg) {
        const inner = this.lexLine(
          cg.text.slice(1, -1),
          lineNo,
          lineOffset,
          columnBase + i + 1,
        );
        // `cg.dur.next` 是行内绝对下标（scanChordGroup 从 `]` 之后接着扫的）
        i = cg.dur ? cg.dur.next : i + cg.text.length;
        const t: Omit<Token, "source"> = {
          kind: "chordGroup",
          text: line.slice(start, i),
          notes: inner.tokens.filter((x) => x.kind === "note"),
        };
        if (cg.dur) {
          t.num = cg.dur.num;
          t.den = cg.dur.den;
        }
        push(t, start, i - start);
        continue;
      }

      // 破碎节奏 `>` / `<`（ABC §4.4）
      const brk = this.scanBroken(line, i);
      if (brk) {
        i += brk.len;
        push({ kind: "broken", text: line.slice(start, i), broken: brk.dir }, start, brk.len);
        continue;
      }

      // 休止（ABC 的 `z`/`Z`；123 的 `0` 走下面的 scanNote）
      const rest = this.scanRest(line, i);
      if (rest) {
        i = rest.next;
        const t: Omit<Token, "source"> = { kind: "rest", text: line.slice(start, i) };
        t.beams = rest.beams;
        t.dots = rest.dots;
        if (rest.num !== undefined) t.num = rest.num;
        if (rest.den !== undefined) t.den = rest.den;
        push(t, start, i - start);
        continue;
      }

      // 音符
      const note = this.scanNote(line, i);
      if (note) {
        i = note.next;
        const t: Omit<Token, "source"> = {
          kind: "note",
          text: line.slice(start, i),
          octave: note.octave,
          beams: note.beams,
          dots: note.dots,
        };
        if (note.degree !== undefined) t.degree = note.degree;
        if (note.step !== undefined) t.step = note.step;
        if (note.alter !== undefined) t.alter = note.alter;
        if (note.accidental) t.accidental = note.accidental;
        if (note.num !== undefined) t.num = note.num;
        if (note.den !== undefined) t.den = note.den;
        push(t, start, i - start);
        continue;
      }

      // 方言特有的单字符装饰（ABC 的 `.` `~` `H`–`W`）
      const deco = this.shorthandDecoration(line, i);
      if (deco) {
        i += deco.len;
        push({ kind: "deco", text: line.slice(start, i), value: deco.name }, start, deco.len);
        continue;
      }

      // 认不出来的字符——报一条、往前走一格，**不要停**（半截文本也要能给出大部分结果）
      i++;
      errors.push({ message: `认不出的记号 \`${ch}\``, source: span(start, 1) });
      push({ kind: "unknown", text: ch }, start, 1);
    }

    return { tokens, errors };
  }

  /** 多连音起头。123 是 `(n:` / `(n:p:`（以冒号收尾，组由 `)` 收）；ABC 允许 `(3` / `(3:2:3` / `(3:2` / `(3::2`。 */
  private matchTuplet(
    line: string,
    i: number,
  ): { text: string; n: number; p?: number; q?: number } | null {
    if (line[i] !== "(") return null;
    const rest = line.slice(i);
    if (this.tupletNeedsColon) {
      // 123：`(n:` 或 `(n:p:`，**起头以冒号收尾**——`(3:2 1` 里的 `2` 是第一个音符而不是 p。
      // 组的范围由必需的 `)` 定，ABC 的第三个数（作用几个音）用不着
      const m = /^\((\d+)(?::(\d+))?:/.exec(rest);
      if (!m) return null;
      const out: { text: string; n: number; p?: number; q?: number } = {
        text: m[0],
        n: Number(m[1]),
      };
      if (m[2]) out.p = Number(m[2]);
      return out;
    }
    const m = /^\((\d+)(?::(\d*)(?::(\d*))?)?/.exec(rest);
    if (!m) return null;
    const out: { text: string; n: number; p?: number; q?: number } = {
      text: m[0],
      n: Number(m[1]),
    };
    if (m[2]) out.p = Number(m[2]);
    if (m[3]) out.q = Number(m[3]);
    return out;
  }
}
