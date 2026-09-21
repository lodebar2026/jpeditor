// 组装期的方言钩子：`parse.ts` 的**组装逻辑两种方言完全共用**（小节切分、
// Mark 配对、歌词对位、`I:playorder` 回填），只有这几处必须按方言分：
//
//   - 一个 token 的**时值**怎么算（123 是减时线/附点相对，ABC 是分数 × `L:`）
//   - 一个 note token 变成什么样的 `Note`（123 给 `degree`，ABC 给 `pitch`）
//   - `K:` 怎么读（123 首调 `1=F`，ABC 音名 `F` / `Em` / `D bass`）
//   - `-` 是增时线还是 tie
//   - 空白算不算符杠分组（ABC 算，123 不算、按拍自动）
//
// `ScoreDoc.Note` 本来就是 `degree` 与 `pitch` 并存、可互推（`model/helpers.ts`），
// 所以两套 token 汇进同一个模型，不需要第二个模型。

import { SIMPLE_DIVISIONS, type Chord, type Key, type Note, type NoteType, type Pitch } from "../model/doc";
import { parseKey as parseKey123 } from "../j123/fields";
import { LEXER_123 } from "./dialect123";
import { LEXER_ABC } from "./dialectabc";
import type { LexResult, Token } from "./types";

const TYPE_BY_BEAMS = ["quarter", "eighth", "16th", "32nd", "64th", "128th", "256th"] as const;

/** 默认音长（ABC 的 `L:`）。123 用不到，给个占位。 */
export interface DefaultLen {
  num: number;
  den: number;
}

export interface ParseDialect {
  id: "123" | "abc";
  lex(line: string, lineNo: number, lineOffset: number, columnBase?: number): LexResult;
  /** token → 时值。`sustains` 只有 123 用（增时线各加一拍）。 */
  duration(t: Token, len: DefaultLen, sustains?: number): Chord["duration"];
  /** 重算宿主音符的时值（123 的增时线挂上去之后）。 */
  reduration(host: Chord, len: DefaultLen): Chord["duration"];
  /** note token → `Note`。 */
  note(t: Token): Note;
  /** 这个 token 是不是休止。 */
  isRest(t: Token): boolean;
  parseKey(value: string): { key: Key; error?: string };
  /** `-` 的语义。 */
  hyphen: "sustain" | "tie";
  /** 出厂默认音长。ABC 规范 §3.1.7：没写 `L:` 时按 `M:` 推（≥0.75 用 1/8，否则 1/16）。 */
  defaultLen(timeNum: number, timeDen: number): DefaultLen;
  /** **代码里的换行是不是谱面换行**。ABC §6.1 默认是（`I:linebreak <EOL>`）；
   *  123 不是——它用显式的 `$`，因为简谱一行往往写得很长、不该被源码折行绑死。 */
  lineEndIsBreak: boolean;
  /** **空白是不是符杠分组**。ABC §4.7 是（连写同杠、空格断开）；
   *  123 不是——符杠按拍自动算（排版 `beamGroupsOf`），空格只为好读、手写不必操心分组。 */
  spaceBeams: boolean;
  /** 歌词里「跳过一个音符」的记号。123 用 `/`（同文本谱诗歌本，免 Shift）；ABC §5.1 是 `*`。 */
  lyricSkip: "/" | "*";
  /** **`$` 是不是同时结束一批歌词**。123 是（同 `.jpwabc`：一行曲一批 `w:`，同一代码行里 `$` 之后的音符另起一批，
   *  不与前一行共用）；ABC 不是——§5.1 的 `w:` 对的是它前面那条**代码行**，行内的 `$` 只是谱面换行。 */
  breakEndsLyricBlock: boolean;
}

// ───────────────────────── 123 ─────────────────────────

export function duration123(beams: number, dots: number, sustains: number): Chord["duration"] {
  const base = SIMPLE_DIVISIONS >> Math.min(beams, 6);
  let total = base;
  // 附点：每个附点加上前一档的一半
  let add = base;
  for (let k = 0; k < dots; k++) {
    add = Math.floor(add / 2);
    total += add;
  }
  // 增时线：每条加一个四分音符（简谱语义：`-` 延长一拍）
  total += sustains * SIMPLE_DIVISIONS;
  const type = TYPE_BY_BEAMS[Math.min(beams, TYPE_BY_BEAMS.length - 1)]!;
  return { divisions: total, type, dots };
}

export const DIALECT_123: ParseDialect = {
  id: "123",
  lex: (line, lineNo, lineOffset, columnBase = 0) =>
    LEXER_123.lexLine(line, lineNo, lineOffset, columnBase),
  duration: (t, _len, sustains = 0) => duration123(t.beams ?? 0, t.dots ?? 0, sustains),
  reduration: (host) =>
    duration123(host.beams?.length ?? 0, host.duration.dots, host.sustains?.length ?? 0),
  note: (t) => {
    const n: Note = { degree: { number: t.degree!, octaveShift: t.octave ?? 0 } };
    if (t.accidental) {
      n.degree!.accidental = t.accidental;
      n.accidental = t.accidental;
    }
    return n;
  },
  isRest: (t) => t.degree === 0,
  parseKey: parseKey123,
  hyphen: "sustain",
  defaultLen: () => ({ num: 1, den: 4 }),
  lineEndIsBreak: false,
  spaceBeams: false,
  lyricSkip: "/",
  breakEndsLyricBlock: true,
};

// ───────────────────────── 标准 ABC ─────────────────────────

const TYPES_BY_POWER: NoteType[] = [
  "whole", "half", "quarter", "eighth", "16th", "32nd", "64th", "128th", "256th",
];

/** divisions → `{type, dots}`。找不超过它的 2 的幂，再看余数是不是恰好一个/两个附点。
 *
 *  **破碎节奏（`a>b`）改完 divisions 必须回头调它**：只改 divisions 不改 type，
 *  写出来是 `B/`、读回来却是「八分音符 12 divisions」，往返一轮就变形。 */
export function typeAndDots(divisions: number): { type: NoteType; dots: number } {
  let unit = SIMPLE_DIVISIONS * 4; // 全音符
  let power = 0;
  while (unit > divisions && power < 8) {
    unit = unit / 2;
    power += 1;
  }
  const type = TYPES_BY_POWER[Math.min(power, TYPES_BY_POWER.length - 1)]!;
  let dots = 0;
  let acc = unit;
  let add = unit;
  while (dots < 2 && acc < divisions) {
    add = add / 2;
    if (Math.abs(acc + add - divisions) <= Math.abs(acc - divisions)) {
      acc += add;
      dots += 1;
    } else break;
  }
  return { type, dots };
}

/** 分数时值 → `{divisions, type, dots}`。`L:`×num/den 得到以全音符为 1 的长度。 */
function durationAbc(num: number, den: number, len: DefaultLen): Chord["duration"] {
  // 以四分音符为 1 的拍数 = (num/den) × (len.num/len.den) × 4
  const beats = (num * len.num * 4) / (den * len.den);
  const divisions = Math.max(1, Math.round(beats * SIMPLE_DIVISIONS));
  return { divisions, ...typeAndDots(divisions) };
}

/** ABC 调号：`C` `F` `Bb` `Eb` `Em` `Ador` `D bass` `HP`。 */
const FIFTHS_MAJOR: Readonly<Record<string, number>> = {
  Cb: -7, Gb: -6, Db: -5, Ab: -4, Eb: -3, Bb: -2, F: -1,
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7,
};
/** 调式相对大调的五度圈偏移（ABC §3.1.14）。 */
const MODE_SHIFT: Readonly<Record<string, number>> = {
  maj: 0, ion: 0, min: -3, aeo: -3, m: -3,
  mix: -1, dor: -2, phr: -4, lyd: 1, loc: -5,
};

export function parseKeyAbc(value: string): { key: Key; error?: string } {
  const raw = value.trim();
  if (raw === "" || /^none$/i.test(raw)) return { key: { fifths: 0 } };
  // 主音 + 可选调式 + 后面的一串修饰（clef=、bass、exp …），修饰这里先不读
  const m = /^([A-G])([#b]?)\s*([A-Za-z]*)/.exec(raw);
  if (!m) return { key: { fifths: 0 }, error: `看不懂的调号：${raw}` };
  const tonic = m[1]! + (m[2] ?? "");
  const modeWord = (m[3] ?? "").toLowerCase().slice(0, 3);
  const base = FIFTHS_MAJOR[tonic];
  if (base === undefined) return { key: { fifths: 0 }, error: `看不懂的调号：${raw}` };
  const shift = modeWord === "" ? 0 : MODE_SHIFT[modeWord];
  if (shift === undefined) {
    // `K:D bass` 这类：后面那个词是 clef/修饰，不是调式
    return { key: { fifths: base, spelling: tonic } };
  }
  const key: Key = { fifths: base + shift, spelling: tonic };
  if (modeWord !== "") key.mode = modeWord === "m" ? "minor" : modeWord;
  return { key };
}

export const DIALECT_ABC: ParseDialect = {
  id: "abc",
  lex: (line, lineNo, lineOffset, columnBase = 0) =>
    LEXER_ABC.lexLine(line, lineNo, lineOffset, columnBase),
  duration: (t, len) => durationAbc(t.num ?? 1, t.den ?? 1, len),
  reduration: (host) => host.duration,
  note: (t) => {
    const n: Note = {
      pitch: {
        step: (t.step ?? "C") as Pitch["step"],
        alter: t.alter ?? 0,
        // ABC 的大写字母在第 4 八度、小写在第 5（`octave` 已按此归一）
        octave: 4 + (t.octave ?? 0),
      },
    };
    if (t.accidental) n.accidental = t.accidental;
    return n;
  },
  isRest: (t) => t.kind === "rest",
  parseKey: parseKeyAbc,
  hyphen: "tie",
  // ABC §3.1.7：`M:` 的值 ≥ 0.75 用 1/8，否则 1/16
  defaultLen: (num, den) => (den > 0 && num / den >= 0.75 ? { num: 1, den: 8 } : { num: 1, den: 16 }),
  lineEndIsBreak: true,
  spaceBeams: true,
  lyricSkip: "*",
  breakEndsLyricBlock: false,
};
