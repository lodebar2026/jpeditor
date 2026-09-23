// 123 格式的字段表、中文别名与 `I:` 指令解析。
//
// 规范见 `docs/格式/123格式.md` §2（中文支持）、§3（头部字段）、§6.2（`I:playorder`）、
// §9（`I:linebreak`）、§10（`I:style`）。
//
// **字段名一律归一成 ASCII 规范形**再往下走——中文别名只是入口，不进模型。
// 这与 `pu/dialect.ts` 的取向一致：差异收在一张表里，不在下游写 if。

import type { Diagnostic, Key, PlayPass, SourceSpan, Time } from "../model/doc";

/** ASCII 规范形的字段名。 */
export type FieldName =
  | "X" | "T" | "C" | "M" | "L" | "Q" | "K" | "P" | "V"
  | "N" | "Z" | "O" | "S" | "R" | "B" | "D" | "F" | "G" | "H"
  | "I" | "U" | "W" | "w";

/** 中文别名 → ASCII 规范形。语料里没有中文字段名的先例，这是本格式新增的入口形式。
 *  `段：` 与 `歌词：` 都归到 `w`，**两者等价、都不带段号**（段号由 `w:` 的出现顺序定，规范 §5.1）。 */
export const CJK_FIELD_ALIAS: Readonly<Record<string, FieldName>> = {
  曲号: "X",
  标题: "T",
  副标题: "T",
  词曲: "C",
  作者: "C",
  调: "K",
  拍: "M",
  速度: "Q",
  声部: "V",
  歌词: "w",
  段: "w",
  顺序: "P",
  注: "N",
  文字: "W",
};

/** 中文别名 → `I:` 子指令（`样式：x` 等价 `I:style x`）。 */
export const CJK_INSTRUCTION_ALIAS: Readonly<Record<string, string>> = {
  样式: "style",
  演唱: "playorder",
  断行: "linebreak",
  每页行数: "linesperpage",
};

/** 一行头部字段的解析结果。 */
export interface FieldLine {
  name: FieldName;
  /** `V:1` 的声部号 */
  voice?: number;
  /** `+:` 续行：接着写上一条同名字段（ABC §3.1.18）。`name` 由调用方按上一条字段填 */
  cont?: true;
  /** 旧写法里 `w` 后面的段号（`w1:` `w1-2:` `段2：`）。**123 的歌词行不带段号**，
   *  留着只为能报一条像样的诊断——不然这一行会掉进音乐体、炸出一串词法错 */
  legacyVerse?: string;
  value: string;
  source: SourceSpan;
  /** `value` 首字符的全文偏移（点选定位要落到字上） */
  valueOffset?: number;
}

/** 字段行前缀。
 *  ASCII：`X:` `T:` `w:` `V:1` ——字段名单字母（`w` 区分大小写，其余不分）。
 *  中文：`标题：` `歌词：` ——先查别名表。
 *  冒号 ASCII `:` 与全角 `：` 等价（语料里真有用全角的）。
 *  数字组只为 `V1:` 与旧 `w1:` 留着（后者报诊断用，见 `FieldLine.legacyVerse`）。 */
const ASCII_PREFIX = /^([A-Za-z])(\d+)?(?:-(\d+))?\s*[:：]/;
const CJK_PREFIX = /^([一-鿿]{1,4})(\d+)?(?:-(\d+))?\s*[:：]/;
/** `+:` 续行（ABC §3.1.18）：不是字段名，接着上一条字段往下写 */
const CONT_PREFIX = /^\+\s*[:：]/;

/** 试着把一行读成头部字段。不是字段行则返回 null（交给音乐体）。 */
export function parseFieldLine(
  line: string,
  lineNo: number,
  offset: number,
): FieldLine | null {
  const c = CONT_PREFIX.exec(line);
  if (c) {
    return {
      // `name` 是占位：调用方按上一条字段名改写（认不出上一条就报诊断、丢掉这一行）
      name: "w",
      cont: true,
      value: line.slice(c[0].length).trim(),
      source: { line: lineNo, column: 0, offset, length: line.length },
      valueOffset: offset + c[0].length + (/^\s*/.exec(line.slice(c[0].length))?.[0].length ?? 0),
    };
  }
  let m = ASCII_PREFIX.exec(line);
  let name: FieldName | undefined;
  if (m) {
    const raw = m[1]!;
    // `w` 与 `W` 是两个字段（对齐歌词 / 曲末歌词），其余大小写不敏感
    name = (raw === "w" || raw === "W" ? raw : raw.toUpperCase()) as FieldName;
  } else {
    m = CJK_PREFIX.exec(line);
    if (!m) return null;
    name = CJK_FIELD_ALIAS[m[1]!];
    if (name === undefined) return null;
    // `副标题：` 仍归 T:，顺序决定它是副标题（规范 §3）
  }
  const f: FieldLine = {
    name,
    value: line.slice(m[0].length).trim(),
    source: { line: lineNo, column: 0, offset, length: line.length },
    valueOffset: offset + m[0].length + (/^\s*/.exec(line.slice(m[0].length))?.[0].length ?? 0),
  };
  if (m[2]) {
    if (name === "V") f.voice = Number(m[2]);
    // 歌词行的段号已废（规范 §5.1：段号由 `w:` 的出现顺序定），原样留给上层报诊断
    else f.legacyVerse = m[3] ? `${m[2]}-${m[3]}` : m[2];
  }
  // `V:` 的声部号写在**冒号之后**（`V:1`、`V:2 name="Bass"`，ABC §3.1.20 与规范 §7 都是这样）。
  // 只认前缀数字会让 `V:1`/`V:2` 全归声部 1、几个声部拼成一串。
  if (name === "V" && f.voice === undefined) {
    const v = /^(\d+)/.exec(f.value);
    if (v) f.voice = Number(v[1]);
  }
  return f;
}

// ───────────────────────── K: 调号 ─────────────────────────

/** 调号拼写 → fifths。升降号可前置（`bB`，简谱惯例）或后置（`Bb`，ABC 惯例），两种都认。 */
const FIFTHS: Readonly<Record<string, number>> = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "#F": 6, "#C": 7,
  F: -1, bB: -2, bE: -3, bA: -4, bD: -5, bG: -6, bC: -7,
};

/** mode → 相对大调的 fifths 偏移。`K:Em` 的调号与 G 大调相同。 */
const MODE_OFFSET: Readonly<Record<string, number>> = {
  major: 0, ionian: 0,
  minor: -3, aeolian: -3, m: -3,
  mixolydian: -1, dorian: -2, phrygian: -4, lydian: 1, locrian: -5,
};

/** 主音唱名：大调主音是 `1`，小调主音是 `6`（语料里 `6=X` 确有，占 0.01%）。 */
const MODE_TONIC_DEGREE: Readonly<Record<string, string>> = {
  minor: "6", aeolian: "6", m: "6",
  dorian: "2", phrygian: "3", lydian: "4", mixolydian: "5", locrian: "7",
};

/** 把调号拼写归一成**前置 ASCII** 形（`Bb` → `bB`、`F#` → `#F`、`♭A` → `bA`）。
 *
 *  归一是幂等的前提：语料里大量使用音乐符号 `♭`(U+266D) / `♯`(U+266F)，
 *  不归一就会出现「第一轮写 `K:1=♭A`、第二轮写 `K:1=bA`」的往返漂移。 */
export function normalizeSpelling(s: string): string {
  const t = s.trim().replace(/♯/g, "#").replace(/♭/g, "b");
  const m = /^([#b]?)([A-Ga-g])([#b]?)$/.exec(t);
  if (!m) return t;
  const acc = m[1] || m[3] || "";
  return acc + m[2]!.toUpperCase();
}

/**
 * 解析 `K:` 的值。三种写法：
 *   `K:1=F`     简谱首调形（主音唱名 = 音名）
 *   `K:F`       ABC 标准形
 *   `K:Em`      ABC 带 mode——**这正好表达「调号同 G 大调、主音是 6」**，
 *               不必自造语法（规范 §3）
 *   `K:none`    无调号
 */
export function parseKey(value: string): { key: Key; error?: string } {
  const v = value.trim();
  if (v === "" || /^none$/i.test(v)) return { key: { fifths: 0, spelling: "none" } };

  // `1=F` / `6=c` 形：等号左边是主音唱名
  const jp = /^([1-7])\s*=\s*([#b♯♭]?[A-Ga-g][#b♯♭]?)\s*(.*)$/.exec(v);
  let tonicDegree: string | undefined;
  let body: string;
  if (jp) {
    tonicDegree = jp[1];
    body = jp[2]! + (jp[3] ? " " + jp[3] : "");
  } else {
    body = v;
  }

  // 音名 + 可选 mode：`bB`、`Bb`、`Em`、`F# mixolydian`
  const m = /^([#b♯♭]?)([A-Ga-g])([#b♯♭]?)\s*([A-Za-z]*)$/.exec(body.trim());
  if (!m) return { key: { fifths: 0 }, error: `看不懂的调号：${value}` };
  const letter = m[2]!.toUpperCase();
  const acc = (m[1] || m[3] || "").replace("♯", "#").replace("♭", "b");
  const spelling = normalizeSpelling(acc + letter);
  const base = FIFTHS[spelling];
  if (base === undefined) {
    // 认不出的调（语料里有 `1=bF` 这种非标准写法，bF 其实等于 E）——
    // **保留原文拼写**，不要退成 C：退了就把信息丢了，而且往返不幂等
    const key: Key = { fifths: 0, spelling };
    if (tonicDegree !== undefined && tonicDegree !== "1") key.tonicDegree = tonicDegree;
    return { key, error: `没有这个调：${spelling}（已保留原文）` };
  }

  // mode 只取前三字母（ABC §3.1.14：「only the first three letters of each mode are parsed」），
  // `m` 是 minor 的简写
  const modeRaw = (m[4] ?? "").toLowerCase();
  let modeKey = "";
  if (modeRaw === "m") modeKey = "m";
  else if (modeRaw) {
    modeKey = Object.keys(MODE_OFFSET).find((k) => k.length > 1 && k.startsWith(modeRaw.slice(0, 3))) ?? "";
  }
  const offset = modeKey ? (MODE_OFFSET[modeKey] ?? 0) : 0;

  const key: Key = { fifths: base + offset, spelling };
  if (modeKey) key.mode = modeKey === "m" ? "minor" : modeKey;
  // 主音唱名：源里写了就用源里的；没写而有 mode，按 mode 推（小调 = 6）
  const degree = tonicDegree ?? (modeKey ? MODE_TONIC_DEGREE[modeKey] : undefined);
  if (degree !== undefined && degree !== "1") key.tonicDegree = degree;
  return { key };
}

// ───────────────────────── M: 拍号 ─────────────────────────

export function parseTime(value: string): { time?: Time; error?: string } {
  const v = value.trim();
  if (/^C\|$/i.test(v)) return { time: { beats: 2, beatType: 2, symbol: "cut" } };
  if (/^C$/i.test(v)) return { time: { beats: 4, beatType: 4, symbol: "common" } };
  if (/^none$/i.test(v)) return {};
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(v);
  if (!m) return { error: `看不懂的拍号：${value}` };
  return { time: { beats: Number(m[1]), beatType: Number(m[2]) } };
}

/** 头部的 `M:`：并排几个拍号（混合拍，规范 §3）＋可跟一段说明文字（`M:3/4 4/4 混合拍`）。
 *  辅助拍号可包在括号里（`M:4/4 (2/4 1/4)`，同文本谱 `P: 4/4 ( 2/4 1/4 )`）。
 *  单个拍号与 `C`/`C|`/`none` 仍走 `parseTime`；曲中的行内 `[M:]` 只认单个，也走它。 */
export function parseTimes(value: string): { times: Time[]; note?: string; error?: string } {
  const v = value.trim();
  const times: Time[] = [];
  let inParen = false;
  let rest = v;
  for (;;) {
    const m = /^\s*(\()?\s*(\d+)\s*\/\s*(\d+)\s*(\))?/.exec(rest);
    if (!m) break;
    if (m[1]) inParen = true;
    times.push({ beats: Number(m[2]), beatType: Number(m[3]), ...(inParen ? { parenthesized: true } : {}) });
    if (m[4]) inParen = false;
    rest = rest.slice(m[0].length);
  }
  const note = rest.trim();
  // 说明文字只收**短的中文**（"混合拍"，谱面上就这一路）。剩下的是别的东西（`C`、`3/4x`）
  // 一律当没认出来、退回 parseTime 去报错，免得把看不懂的拍号默默咽下。
  const noteOk = !note || /^[一-鿿]{1,8}$/.test(note);
  if (!times.length || !noteOk || (times.length === 1 && !note)) {
    // 一个都没凑出来（`C`、`none`、看不懂的）或只有一个拍号且没说明 → 老路，报错口径一并沿用
    const one = parseTime(v);
    return { times: one.time ? [one.time] : [], error: one.error };
  }
  return { times, note: note || undefined };
}

// ───────────────────────── Q: 速度 ─────────────────────────

/** `Q:1/4=76` / `Q:76` / `Q:"欢快地"` / `Q:1/4=76 "欢快地"` */
export function parseTempo(value: string): (number | string)[] {
  const out: (number | string)[] = [];
  const v = value.trim();
  for (const m of v.matchAll(/"([^"]*)"/g)) out.push(m[1]!);
  const bare = v.replace(/"[^"]*"/g, "");
  const bpm = /(?:\d+\s*\/\s*\d+\s*=\s*)?(\d+)/.exec(bare);
  if (bpm) out.unshift(Number(bpm[1]));
  return out;
}

// ───────────────────────── I: 指令 ─────────────────────────

export interface Instruction {
  name: string;
  value: string;
}

/** `I:style book.ss` → `{name:"style", value:"book.ss"}`。
 *  中文 `样式：x` 由调用方先经 `CJK_INSTRUCTION_ALIAS` 归一。 */
export function parseInstruction(value: string): Instruction {
  const m = /^(\S+)\s*(.*)$/.exec(value.trim());
  if (!m) return { name: "", value: "" };
  return { name: m[1]!.toLowerCase(), value: m[2] ?? "" };
}

/** `I:linebreak` 的取值。ABC §6.1.1：`$` 是默认与推荐值，`<EOL>` 等价 `$`，`<none>` 等价 `!`。
 *  123 只用 `$` 与 `<none>` 两档——正好对应「原始排版」与「按乐句重排」。 */
export function parseLinebreak(value: string): "explicit" | "auto" {
  const v = value.trim().toLowerCase();
  if (v === "<none>" || v === "!" ) return "auto";
  return "explicit";
}

/**
 * `I:playorder` —— `.jpwabc` 的 `.Repeat` 段的等价物（规范 §6.2）。
 *
 *     I:playorder 1-4 v1 | 1-4 v2 page | 11.2-20 v4 | 11-20.1 v5
 *
 * 一遍一项，`|` 分隔。每项：`<起>[.<音符>]-<止>[.<音符>] [v<段号>] [page]`
 *
 * `fromElement`/`toElement`（skip/limit 的音符级端点）此处只记下**第几个音符**，
 * 解析完音乐体后才能换成元素 id——由 `parse.ts` 回填。
 */
export interface RawPlayPass extends Omit<PlayPass, "fromElement" | "toElement"> {
  /** 起点在该小节里的第几个音符（1 基）；无则从小节头 */
  fromNoteIndex?: number;
  /** 终点在该小节里的第几个音符（1 基）；无则到小节尾 */
  toNoteIndex?: number;
}

export function parsePlayOrder(
  value: string,
  source: SourceSpan,
  diagnostics: Diagnostic[],
): RawPlayPass[] {
  const out: RawPlayPass[] = [];
  for (const seg of value.split("|")) {
    const s = seg.trim();
    if (!s) continue;
    const m = /^(\d+)(?:\.(\d+))?\s*-\s*(\d+)(?:\.(\d+))?(.*)$/.exec(s);
    if (!m) {
      diagnostics.push({
        severity: "warning",
        code: "bad-playorder",
        message: `看不懂的演唱顺序项：${s}`,
        source,
      });
      continue;
    }
    const pass: RawPlayPass = { fromMeasure: Number(m[1]), toMeasure: Number(m[3]) };
    if (m[2]) pass.fromNoteIndex = Number(m[2]);
    if (m[4]) pass.toNoteIndex = Number(m[4]);
    const rest = (m[5] ?? "").trim();
    const verse = /\bv(\d+)\b/i.exec(rest);
    if (verse) pass.verse = Number(verse[1]);
    if (/\bpage\b/i.test(rest)) pass.pageBreakAfter = true;
    out.push(pass);
  }
  return out;
}
